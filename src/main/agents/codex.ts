// Codex adapter over `codex app-server` (JSON-RPC on stdio), the protocol the official IDE
// extensions use. Unlike `codex exec`, it lets Ember answer Codex's approval requests, so Manual,
// Auto and Accept-edits modes behave the same as with Claude.
import { locate, spawnCli } from '../cli'
import { needsApproval } from '../permissions'
import { codexMcpConfig } from '../mcp'
import { reportUsage, ProviderLimitError, looksLikeLimit } from '../usage'
import type { UsageWindow } from '../../shared/types'
import { Collector, ndjson, type Agent } from './types'

/** Label a Codex rate-limit window by its length (5-hour, weekly, monthly...). */
function windowLabel(mins?: number): string {
  if (!mins) return 'usage'
  if (mins === 300) return '5-hour'
  if (mins === 10080) return 'weekly'
  if (mins === 43200) return 'monthly'
  return mins % 1440 === 0 ? `${mins / 1440}-day` : `${Math.round(mins / 60)}-hour`
}

/** Map `account/rateLimits/read` / `account/rateLimits/updated` payloads into Ember's usage store. Returns the reset time when limited. */
export function recordCodexRateLimits(rl: any): number | undefined {
  if (!rl) return undefined
  const windows: UsageWindow[] = []
  let resetsAtLimited: number | undefined
  for (const [key, w] of [['primary', rl.primary], ['secondary', rl.secondary]] as const) {
    if (!w) continue
    const used = typeof w.usedPercent === 'number' ? Math.round(w.usedPercent) : undefined
    const resetsAt = typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined
    const limited = rl.rateLimitReachedType != null && (rl.rateLimitReachedType === key || (used ?? 0) >= 100)
    if (limited) resetsAtLimited = resetsAt
    windows.push({ label: windowLabel(w.windowDurationMins), utilization: used, resetsAt, status: limited || (used ?? 0) >= 100 ? 'limited' : (used ?? 0) >= 85 ? 'warning' : 'ok' })
  }
  const plan = rl.planType ? String(rl.planType).charAt(0).toUpperCase() + String(rl.planType).slice(1) + ' plan' : undefined
  reportUsage('codex', { windows, plan, status: rl.rateLimitReachedType != null ? 'limited' : undefined })
  return rl.rateLimitReachedType != null ? resetsAtLimited ?? 0 : undefined
}

export const codexAgent: Agent = async (input) => {
  const exe = await locate('codex')
  if (!exe) throw new Error('Codex CLI is not installed. Open Accounts to install and sign in.')
  const { session, emit, signal, mode } = input
  const c = new Collector(emit)

  // Plan mode and plain chats never write. Otherwise Codex asks for anything outside its trusted set
  // ("untrusted") and Ember decides per request whether the user needs to see it.
  const readOnly = mode === 'plan' || session.kind === 'chat'
  const sandbox = readOnly ? 'read-only' : mode === 'bypass' ? 'danger-full-access' : 'workspace-write'
  const approvalPolicy = readOnly || mode === 'bypass' ? 'never' : 'untrusted'

  const proc = spawnCli(exe, ['app-server'], { cwd: input.cwd })
  let stderr = ''
  let nextId = 1
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const write = (obj: unknown) => {
    if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(obj) + '\n')
  }
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      write({ method, id, params })
    })

  let threadId = session.providerSessions.codex
  let turnId: string | undefined
  let stats: any
  let failure = ''
  let limitedUntil: number | undefined // set when Codex reports the plan limit is reached
  let finishTurn!: () => void
  const turnDone = new Promise<void>((r) => (finishTurn = r))
  const deltaItems = new Set<string>() // agent messages already streamed as deltas
  const changes = new Map<string, any[]>() // fileChange item id -> changes (for approval diffs)

  const toolStart = (item: any) => {
    if (c.toolCalls.find((t) => t.id === item.id)) return
    if (item.type === 'commandExecution') c.toolStart(item.id, 'shell', { command: item.command })
    else if (item.type === 'fileChange') c.toolStart(item.id, 'apply_patch', { files: (item.changes ?? []).map((ch: any) => ch.path) })
    else if (item.type === 'mcpToolCall') c.toolStart(item.id, item.tool ?? 'mcp', item.arguments)
    else if (item.type === 'webSearch') c.toolStart(item.id, 'web_search', { query: item.query })
  }

  const onItemCompleted = (item: any) => {
    switch (item.type) {
      case 'agentMessage':
        if (!deltaItems.has(item.id) && item.text) c.textDelta((c.text ? '\n\n' : '') + item.text)
        break
      case 'reasoning':
        if (!c.reasoning && (item.summary?.length || item.content?.length)) c.reasoningDelta([...(item.summary ?? []), ...(item.content ?? [])].join('\n\n'))
        break
      case 'commandExecution':
        toolStart(item)
        c.toolEnd(item.id, `exit ${item.exitCode ?? '?'}\n${(item.aggregatedOutput ?? '').slice(0, 20000)}`, item.status === 'declined' ? 'denied' : item.status === 'completed' && (item.exitCode ?? 0) === 0 ? 'done' : 'error')
        break
      case 'fileChange': {
        toolStart(item)
        const files = (item.changes ?? []).map((ch: any) => ch.path).filter(Boolean)
        const ok = item.status === 'completed'
        c.toolEnd(item.id, files.map((f: string) => `${ok ? 'changed' : item.status} ${f}`).join('\n'), ok ? 'done' : item.status === 'declined' ? 'denied' : 'error', ok ? files : undefined)
        break
      }
      case 'mcpToolCall':
        toolStart(item)
        c.toolEnd(item.id, JSON.stringify(item.result ?? item.error ?? '').slice(0, 10000), item.error ? 'error' : 'done')
        break
      case 'webSearch':
        toolStart(item)
        c.toolEnd(item.id, 'searched', 'done')
        break
    }
  }

  const ask = async (kind: 'edit' | 'command' | 'other', title: string, detail: string, diff?: string) =>
    !needsApproval(mode, kind) || (await input.approve(kind, title, detail, diff))

  // Requests Codex sends to us; each must get exactly one response.
  const onServerRequest = async (msg: any): Promise<unknown> => {
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'item/commandExecution/requestApproval': {
        const ok = await ask('command', p.command ?? 'command', [p.reason, p.cwd ? `in ${p.cwd}` : ''].filter(Boolean).join('\n'))
        return { decision: ok ? 'accept' : 'decline' }
      }
      case 'item/fileChange/requestApproval': {
        const ch = changes.get(p.itemId) ?? []
        const title = ch.map((x) => x.path).join(', ') || p.grantRoot || 'file changes'
        const ok = await ask('edit', title, p.reason ?? '', ch.map((x) => `--- ${x.path}\n${x.diff ?? ''}`).join('\n').slice(0, 20000) || undefined)
        return { decision: ok ? 'accept' : 'decline' }
      }
      case 'item/permissions/requestApproval': {
        const ok = await ask('other', 'Extra permissions for Codex', [p.reason, JSON.stringify(p.permissions, null, 2)].filter(Boolean).join('\n'))
        const granted: any = {}
        if (ok && p.permissions?.network) granted.network = p.permissions.network
        if (ok && p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem
        return { permissions: granted, scope: 'turn' }
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const isCmd = msg.method === 'execCommandApproval'
        const ok = await ask(isCmd ? 'command' : 'edit', isCmd ? ([] as string[]).concat(p.command ?? []).join(' ') : Object.keys(p.fileChanges ?? {}).join(', '), p.reason ?? '')
        return { decision: ok ? 'approved' : { denied: { rejection: 'The user declined this in Ember.' } } }
      }
      case 'item/tool/requestUserInput':
        return { answers: {} }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      default:
        throw Object.assign(new Error(`Ember does not support ${msg.method}`), { code: -32601 })
    }
  }

  const onNotification = (method: string, p: any) => {
    switch (method) {
      case 'item/started':
        if (p.item?.type === 'fileChange') changes.set(p.item.id, p.item.changes ?? [])
        if (p.item?.type === 'agentMessage' && c.text) c.textDelta('\n\n')
        toolStart(p.item ?? {})
        break
      case 'item/fileChange/patchUpdated':
        if (p.itemId && Array.isArray(p.changes)) changes.set(p.itemId, p.changes)
        break
      case 'item/agentMessage/delta':
        deltaItems.add(p.itemId)
        c.textDelta(p.delta ?? '')
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        c.reasoningDelta(p.delta ?? '')
        break
      case 'item/completed':
        onItemCompleted(p.item ?? {})
        break
      case 'account/rateLimits/updated': {
        const reset = recordCodexRateLimits(p.rateLimits ?? p)
        if (reset !== undefined) limitedUntil = reset
        break
      }
      case 'thread/tokenUsage/updated': {
        // `last` is the most recent model request; its input (cached tokens included) is the context in use.
        const u = p.tokenUsage?.last
        if (u) stats = { ...stats, inputTokens: u.inputTokens, outputTokens: u.outputTokens, contextTokens: u.inputTokens || undefined, contextLimit: p.tokenUsage?.modelContextWindow ?? 400_000 }
        break
      }
      case 'error':
        if (!p.willRetry) failure = p.error?.message ?? 'Codex reported an error.'
        break
      case 'turn/completed': {
        const t = p.turn ?? {}
        if (t.durationMs != null) stats = { ...stats, durationMs: t.durationMs }
        if (t.status === 'failed') failure = t.error?.message || failure || 'The Codex turn failed.'
        finishTurn()
        break
      }
    }
  }

  proc.stdout.on(
    'data',
    ndjson((msg) => {
      if (!msg) return
      if (msg.id != null && msg.method) {
        onServerRequest(msg).then(
          (result) => write({ id: msg.id, result }),
          (e) => write({ id: msg.id, error: { code: e.code ?? -32603, message: String(e.message ?? e) } })
        )
      } else if (msg.id != null) {
        const w = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.error) w?.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else w?.resolve(msg.result)
      } else if (msg.method) onNotification(msg.method, msg.params ?? {})
    })
  )
  proc.stderr.on('data', (d) => (stderr += d.toString()))
  const exited = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', (e) => {
      stderr += String(e)
      resolve()
    })
  })
  // If the server dies, fail anything still waiting instead of hanging.
  exited.then(() => {
    for (const w of waiting.values()) w.reject(new Error(stderr.trim().slice(-2000) || 'Codex exited unexpectedly.'))
    waiting.clear()
    finishTurn()
  })

  const onAbort = () => {
    if (threadId && turnId) request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
    setTimeout(() => proc.kill(), 1500)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await request('initialize', { clientInfo: { name: 'ember', title: 'Ember', version: '0.1.0' }, capabilities: null })
    write({ method: 'initialized' })
    // Plan usage for the status bar; Codex also pushes account/rateLimits/updated during the turn.
    request('account/rateLimits/read', {})
      .then((r) => {
        const reset = recordCodexRateLimits(r?.rateLimits)
        if (reset !== undefined) limitedUntil = reset
      })
      .catch(() => undefined)
    const threadParams = {
      cwd: input.cwd,
      model: input.model.model || null,
      approvalPolicy,
      sandbox,
      developerInstructions: input.system || null,
      config: codexMcpConfig()
    }
    let started: any = null
    if (threadId) started = await request('thread/resume', { threadId, ...threadParams }).catch(() => null)
    if (!started) started = await request('thread/start', threadParams)
    threadId = started.thread?.id ?? threadId

    const notes = input.attachments.filter((a) => !a.mime.startsWith('image/')).map((a) => `Attached file: ${a.path}`)
    const items: any[] = [{ type: 'text', text: [input.prompt, ...notes].join('\n\n'), text_elements: [] }]
    for (const a of input.attachments) if (a.mime.startsWith('image/')) items.push({ type: 'localImage', path: a.path })
    const turn = await request('turn/start', { threadId, input: items, effort: input.effort, summary: 'auto' })
    turnId = turn?.turn?.id
    await turnDone
  } catch (e: any) {
    failure = e.message
  } finally {
    signal.removeEventListener('abort', onAbort)
    proc.stdin.end()
    setTimeout(() => proc.kill(), 3000)
  }

  if (failure && !signal.aborted) {
    if (/not logged in|log ?in|unauthori|401|auth/i.test(failure + stderr) && !c.text) throw new Error('Codex is not signed in. Open Accounts and sign in with your ChatGPT account.')
    if (!c.text && (limitedUntil !== undefined || looksLikeLimit(failure))) {
      reportUsage('codex', { status: 'limited' })
      throw new ProviderLimitError('codex', failure.slice(-500), limitedUntil || undefined)
    }
    if (!c.text) throw new Error(failure.slice(-2000))
    c.textDelta('\n\n' + failure)
  }
  return c.result({ providerSessionId: threadId, stats })
}
