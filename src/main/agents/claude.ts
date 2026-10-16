// Claude Code headless adapter: stream-json in/out, permission prompts answered by Ember.
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { locate, spawnCli } from '../cli'
import { Collector, ndjson, toolKind, fileFromToolInput, type Agent } from './types'
import { reportUsage, ProviderLimitError, looksLikeLimit } from '../usage'
import { claudeMcpConfig } from '../mcp'
import type { UsageWindow } from '../../shared/types'

/** How Claude Code is signed in: "claude.ai" (Pro/Max subscription) or "console" (API credits). */
export interface ClaudeAuth {
  authMethod?: string
  subscriptionType?: string
}

let authCache: { at: number; v: ClaudeAuth } | null = null

export async function claudeAuth(fresh = false): Promise<ClaudeAuth> {
  if (!fresh && authCache && Date.now() - authCache.at < 5 * 60_000) return authCache.v
  const exe = await locate('claude')
  if (!exe) return {}
  let out = ''
  try {
    out = (await promisify(execFile)(exe, ['auth', 'status'], { shell: /\.cmd$/i.test(exe), timeout: 20000, windowsHide: true })).stdout
  } catch (e: any) {
    out = String(e?.stdout ?? '') // exits non-zero when signed out
  }
  let v: ClaudeAuth = {}
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')))
    v = { authMethod: j.authMethod, subscriptionType: j.subscriptionType }
  } catch {
    // unparseable; leave unknown
  }
  authCache = { at: Date.now(), v }
  return v
}

/** Short plan label for the Accounts badge, e.g. "Max plan" or "API credits". */
export function claudePlanLabel(a: ClaudeAuth): string | undefined {
  if (a.authMethod === 'console') return 'API credits'
  if (a.subscriptionType) return a.subscriptionType.charAt(0).toUpperCase() + a.subscriptionType.slice(1) + ' plan'
  return a.authMethod === 'claude.ai' ? 'subscription' : undefined
}

/**
 * Claude Code names windows like five_hour, seven_day, seven_day_opus, seven_day_fable or
 * seven_day_overage_included; the set varies by plan and by the model used. Label them all.
 */
function windowLabel(key: string): string {
  const m = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key)
  if (!m) return key.replace(/_/g, ' ')
  const base = m[1] === 'five_hour' ? '5-hour' : 'weekly'
  if (!m[2]) return base
  const qualifier = m[2].replace(/_/g, ' ').replace(/\b(opus|sonnet|haiku|fable)\b/g, (s) => s.charAt(0).toUpperCase() + s.slice(1))
  return `${base} (${qualifier})`
}

/** Translate Claude Code's rate_limit_event into Ember's usage model. Returns the reset time if requests are rejected. */
function recordRateLimit(info: any, plan?: string): number | undefined {
  if (!info) return undefined
  const windows: UsageWindow[] = []
  const limitedType: string | undefined = info.status === 'rejected' ? info.rateLimitType : undefined
  for (const [key, w] of Object.entries<any>(info.unifiedWindows ?? {})) {
    const utilization = typeof w?.utilization === 'number' ? Math.round(w.utilization * 100) : undefined
    const resetsAt = typeof w?.resetsAt === 'number' ? w.resetsAt * 1000 : undefined
    const status: UsageWindow['status'] = key === limitedType || (utilization ?? 0) >= 100 ? 'limited' : (utilization ?? 0) >= 85 ? 'warning' : 'ok'
    windows.push({ label: windowLabel(key), utilization, resetsAt, status })
  }
  if (!windows.length && info.rateLimitType) {
    windows.push({ label: windowLabel(info.rateLimitType), resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined, status: info.status === 'rejected' ? 'limited' : info.status === 'allowed_warning' ? 'warning' : 'ok' })
  }
  const status = info.status === 'rejected' ? 'limited' : info.status === 'allowed_warning' ? 'warning' : undefined
  reportUsage('claude', { windows, status, plan })
  return info.status === 'rejected' ? (info.resetsAt ? info.resetsAt * 1000 : undefined) : undefined
}

const fmtK = (n?: number) => (n == null ? '?' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))

/**
 * Ask Claude Code to compact a resumed session (`/compact` over stream-json). Resolves with the
 * token counts before and after, or null if nothing happened. The session id stays the same.
 */
export async function compactClaude(sessionId: string, cwd: string): Promise<{ pre: number; post: number } | null> {
  const exe = await locate('claude')
  if (!exe) throw new Error('Claude Code is not installed.')
  // No tool restriction flag: an empty `--tools ""` argument is dropped by spawn and Claude Code then errors.
  const proc = spawnCli(exe, ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--resume', sessionId, '--permission-mode', 'plan'], { cwd })
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } }) + '\n')
  let out: { pre: number; post: number } | null = null
  let stderr = ''
  proc.stdout.on(
    'data',
    ndjson((obj) => {
      if (!obj) return
      if (obj.type === 'system' && obj.subtype === 'compact_boundary') out = { pre: obj.compact_metadata?.pre_tokens ?? 0, post: obj.compact_metadata?.post_tokens ?? 0 }
      if (obj.type === 'result') proc.stdin.end()
    })
  )
  proc.stderr.on('data', (d) => (stderr += d.toString()))
  const timer = setTimeout(() => proc.kill(), 180_000)
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })
  clearTimeout(timer)
  if (!out && /error|not found|no conversation/i.test(stderr)) throw new Error(stderr.trim().slice(-500))
  return out
}

const MODE: Record<string, string> = {
  auto: 'auto',
  manual: 'manual',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions'
}

// ---- warm processes -------------------------------------------------------------------------
// Starting Claude Code costs ~1.7 s before the first request (loading, MCP servers, resuming the
// transcript). stream-json input mode accepts many user messages on one process, so Ember keeps one
// process per session alive between turns and only respawns when its arguments change.
interface WarmProc {
  proc: ChildProcess
  fingerprint: string
  sink: ((obj: any) => void) | null
  stderr: string
  exited: boolean
  idle?: NodeJS.Timeout
  onExit: Set<() => void>
}
const warm = new Map<string, WarmProc>()
const WARM_IDLE_MS = 10 * 60_000

/** Kill the kept process of an Ember session (after compaction, rewind, or when the user stops a turn). */
export function dropWarmClaude(emberSessionId: string): void {
  const w = warm.get(emberSessionId)
  if (!w) return
  warm.delete(emberSessionId)
  if (w.idle) clearTimeout(w.idle)
  if (!w.exited) {
    try {
      w.proc.stdin?.end()
    } catch {
      // ignore
    }
    setTimeout(() => w.proc.kill(), 1500)
  }
}

export function dropAllWarmClaude(): void {
  for (const id of [...warm.keys()]) dropWarmClaude(id)
}

function acquireWarm(emberSessionId: string, fingerprint: string, spawnFn: () => ChildProcess): WarmProc {
  const existing = warm.get(emberSessionId)
  if (existing && !existing.exited && existing.fingerprint === fingerprint) {
    if (existing.idle) clearTimeout(existing.idle)
    existing.idle = undefined
    return existing
  }
  if (existing) dropWarmClaude(emberSessionId)
  const proc = spawnFn()
  const w: WarmProc = { proc, fingerprint, sink: null, stderr: '', exited: false, onExit: new Set() }
  proc.stdout?.on('data', ndjson((obj) => obj && w.sink?.(obj)))
  proc.stderr?.on('data', (d) => (w.stderr = (w.stderr + d.toString()).slice(-20000)))
  const done = () => {
    w.exited = true
    if (warm.get(emberSessionId) === w) warm.delete(emberSessionId)
    for (const f of w.onExit) f()
  }
  proc.on('exit', done)
  proc.on('error', done)
  warm.set(emberSessionId, w)
  return w
}

export const claudeAgent: Agent = async (input) => {
  const exe = await locate('claude')
  if (!exe) throw new Error('Claude Code is not installed. Open Accounts to install and sign in.')
  const { session, emit, signal } = input
  const c = new Collector(emit)
  const auth = claudeAuth().catch((): ClaudeAuth => ({}))

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompts',
    'host',
    // Route permission prompts over the stdio control protocol (what the Agent SDK does), so Ember can answer them.
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    MODE[input.mode] ?? 'manual'
  ]
  const resumeId = session.providerSessions.claude
  if (input.model.model) args.push('--model', input.model.model)
  // Effort is the only thinking control on current models (thinking cannot be switched off on Haiku/Sonnet/Opus 5.5
  // and Fable). "medium" is left to Claude Code's own per-model default; low is noticeably faster for chat.
  if (input.effort && input.effort !== 'medium') args.push('--effort', input.effort)
  // Via a file: an npm-installed claude.cmd goes through cmd.exe, which cuts a multi-line argument (and every flag after it) at the first newline.
  if (input.system) {
    const file = join(tmpdir(), `ember-system-${session.id}.md`)
    await writeFile(file, input.system)
    args.push('--append-system-prompt-file', file)
  }
  const mcpConfig = claudeMcpConfig(session.id)
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  if (session.kind === 'chat') args.push('--tools', 'WebSearch,WebFetch,Read')

  // Reuse the kept process when nothing about the invocation changed (model, mode, effort, system prompt, cwd).
  const fingerprint = JSON.stringify([args, input.cwd, createHash('sha1').update(input.system ?? '').digest('hex')])
  const w = acquireWarm(session.id, fingerprint, () => {
    const spawnArgs = resumeId ? [...args, '--resume', resumeId] : args
    return spawnCli(exe, spawnArgs, { cwd: input.cwd, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  })
  const proc = w.proc
  let sessionId = resumeId
  let stats: any = undefined
  let finished = false
  let finishTurn!: () => void
  const turnDone = new Promise<void>((r) => (finishTurn = r))
  w.onExit.add(finishTurn)
  let limitedUntil: number | undefined
  let limitReason = ''
  let lastCallUsage: any
  const pendingTools = new Map<string, { name: string; input: any }>()

  const send = (obj: unknown) => {
    if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  // Build the user message with attachments as content blocks.
  const content: any[] = []
  for (const a of input.attachments) {
    if (a.mime.startsWith('image/')) {
      const data = (await readFile(a.path)).toString('base64')
      content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data } })
    }
  }
  const fileNotes = input.attachments.filter((a) => !a.mime.startsWith('image/')).map((a) => `Attached file: ${a.path}`)
  content.push({ type: 'text', text: [input.prompt, ...fileNotes].join('\n\n') })
  const onAbort = () => dropWarmClaude(session.id)
  signal.addEventListener('abort', onAbort, { once: true })

  const onObj = async (obj: any) => {
    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init' && obj.session_id) sessionId = obj.session_id
        if (obj.subtype === 'status' && obj.status === 'compacting') c.status('Claude is compacting its context...')
        // Thinking content is redacted in headless mode, but the token counter shows that work is happening.
        if (obj.subtype === 'thinking_tokens' && typeof obj.estimated_tokens === 'number')
          c.status(`Claude is thinking… ~${fmtK(obj.estimated_tokens)} tokens${input.effort !== 'low' ? ' (Effort: low answers faster)' : ''}`)
        if (obj.subtype === 'compact_boundary') {
          const m = obj.compact_metadata ?? {}
          c.status(`Claude compacted its context: ${fmtK(m.pre_tokens)} → ${fmtK(m.post_tokens)} tokens`)
          lastCallUsage = { input_tokens: m.post_tokens ?? 0 }
        }
        break
      case 'stream_event': {
        const ev = obj.event
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') c.textDelta(ev.delta.text)
          else if (ev.delta?.type === 'thinking_delta') c.reasoningDelta(ev.delta.thinking)
        }
        break
      }
      case 'assistant': {
        // Each assistant message carries the usage of its own model call; the latest one is the context in use.
        if (obj.message?.usage) lastCallUsage = obj.message.usage
        for (const block of obj.message?.content ?? []) {
          if (block.type === 'tool_use') {
            pendingTools.set(block.id, { name: block.name, input: block.input })
            c.toolStart(block.id, block.name, block.input)
          }
        }
        break
      }
      case 'user': {
        for (const block of obj.message?.content ?? []) {
          if (block.type === 'tool_result') {
            const t = pendingTools.get(block.tool_use_id)
            const out = typeof block.content === 'string' ? block.content : (block.content ?? []).map((p: any) => p.text ?? '').join('\n')
            const file = t ? fileFromToolInput(t.input) : undefined
            const edited = t && toolKind(t.name) === 'edit' && !block.is_error && file ? [file] : undefined
            c.toolEnd(block.tool_use_id, out.slice(0, 20000), block.is_error ? 'error' : 'done', edited)
          }
        }
        break
      }
      case 'control_request': {
        const req = obj.request ?? {}
        if (req.subtype === 'can_use_tool') {
          const kind = toolKind(req.tool_name)
          const title = `${req.tool_name}${kind === 'command' ? ': ' + (req.input?.command ?? '') : fileFromToolInput(req.input) ? ': ' + fileFromToolInput(req.input) : ''}`
          const detail = req.description ?? JSON.stringify(req.input, null, 2).slice(0, 4000)
          const diff = kind === 'edit' && req.input?.old_string != null ? `--- old\n${req.input.old_string}\n+++ new\n${req.input.new_string}` : undefined
          const ok = await input.approve(kind, title, detail, diff)
          send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: obj.request_id,
              response: ok ? { behavior: 'allow', updatedInput: req.input } : { behavior: 'deny', message: 'The user denied this action in Ember.' }
            }
          })
        } else {
          send({ type: 'control_response', response: { subtype: 'error', request_id: obj.request_id, error: 'unsupported' } })
        }
        break
      }
      case 'rate_limit_event': {
        const reset = recordRateLimit(obj.rate_limit_info, claudePlanLabel(await auth))
        if (obj.rate_limit_info?.status === 'rejected') {
          limitedUntil = reset ?? limitedUntil ?? 0
          limitReason = 'Claude plan limit reached'
        }
        break
      }
      case 'result': {
        finished = true
        if (obj.session_id) sessionId = obj.session_id
        if (obj.api_error_status === 429 || (obj.is_error && looksLikeLimit(String(obj.result ?? obj.error ?? '')))) {
          limitedUntil = limitedUntil ?? 0
          limitReason = String(obj.result ?? obj.error ?? 'Claude refused the request because the plan limit is reached')
        }
        {
          const u = obj.usage ?? {}
          // result.usage is summed over every model call of the turn, so for the context in use take the
          // LAST call only: everything it sent = fresh input + cache reads + cache writes.
          const iterations: any[] = Array.isArray(u.iterations) ? u.iterations.filter((it: any) => it?.type === 'message') : []
          const last = lastCallUsage ?? iterations[iterations.length - 1] ?? u
          const contextTokens = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0)
          const mu = Object.values<any>(obj.modelUsage ?? {})[0]
          stats = {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            durationMs: obj.duration_ms,
            costUsd: obj.total_cost_usd,
            contextTokens: contextTokens || undefined,
            contextLimit: mu?.contextWindow ?? 200_000
          }
        }
        if (obj.is_error || obj.subtype !== 'success') {
          const msg = obj.result || obj.error || obj.subtype
          if (!c.text) c.textDelta(String(msg ?? 'Claude Code returned an error.'))
        }
        finishTurn()
        break
      }
      default:
        break
    }
  }

  // Attach this turn to the process, then send the message (init events of a fresh process arrive after this).
  w.sink = (obj) => void onObj(obj)
  send({ type: 'user', message: { role: 'user', content } })
  await turnDone
  w.sink = null
  w.onExit.delete(finishTurn)
  signal.removeEventListener('abort', onAbort)
  // Keep the process for the next turn; let it go after a while so idle sessions don't pile up.
  if (!w.exited && warm.get(session.id) === w) w.idle = setTimeout(() => dropWarmClaude(session.id), WARM_IDLE_MS)

  if (!finished && !signal.aborted) {
    const msg = w.stderr.trim() || 'Claude Code exited without a result.'
    if (/not logged in|authentication|login|unauthori/i.test(msg)) throw new Error('Claude Code is not signed in. Open Accounts and sign in with your Claude subscription.')
    throw new Error(msg.slice(-2000))
  }
  if (limitedUntil !== undefined) {
    reportUsage('claude', { status: 'limited' })
    throw new ProviderLimitError('claude', limitReason, limitedUntil || undefined)
  }
  // total_cost_usd is only an API-equivalent estimate; on a subscription nothing is billed per turn.
  if (stats && (await auth).authMethod !== 'console') delete stats.costUsd
  return c.result({ providerSessionId: sessionId, stats })
}
