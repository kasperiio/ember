// Claude Code headless adapter: stream-json in/out, permission prompts answered by Ember.
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { locate, spawnCli } from '../cli'
import { Collector, ndjson, toolKind, fileFromToolInput, type Agent } from './types'

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

const MODE: Record<string, string> = {
  auto: 'auto',
  manual: 'manual',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions'
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
  if (resumeId) args.push('--resume', resumeId)
  if (input.model.model) args.push('--model', input.model.model)
  if (input.effort) args.push('--effort', input.effort)
  if (input.system) args.push('--append-system-prompt', input.system)
  if (session.kind === 'chat') args.push('--tools', 'WebSearch,WebFetch,Read')

  const proc = spawnCli(exe, args, { cwd: input.cwd, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  let sessionId = resumeId
  let stats: any = undefined
  let stderr = ''
  let finished = false
  const pendingTools = new Map<string, { name: string; input: any }>()

  const send = (obj: unknown) => {
    if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(obj) + '\n')
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
  send({ type: 'user', message: { role: 'user', content } })

  const onAbort = () => {
    proc.kill()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const handle = ndjson(async (obj) => {
    if (!obj) return
    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init' && obj.session_id) sessionId = obj.session_id
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
      case 'result': {
        finished = true
        if (obj.session_id) sessionId = obj.session_id
        stats = {
          inputTokens: obj.usage?.input_tokens,
          outputTokens: obj.usage?.output_tokens,
          durationMs: obj.duration_ms,
          costUsd: obj.total_cost_usd
        }
        if (obj.is_error || obj.subtype !== 'success') {
          const msg = obj.result || obj.error || obj.subtype
          if (!c.text) c.textDelta(String(msg ?? 'Claude Code returned an error.'))
        }
        proc.stdin.end()
        break
      }
      default:
        break
    }
  })

  proc.stdout.on('data', handle)
  proc.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })
  signal.removeEventListener('abort', onAbort)

  if (!finished && !signal.aborted) {
    const msg = stderr.trim() || 'Claude Code exited without a result.'
    if (/not logged in|authentication|login|unauthori/i.test(msg)) throw new Error('Claude Code is not signed in. Open Accounts and sign in with your Claude subscription.')
    throw new Error(msg.slice(-2000))
  }
  // total_cost_usd is only an API-equivalent estimate; on a subscription nothing is billed per turn.
  if (stats && (await auth).authMethod !== 'console') delete stats.costUsd
  return c.result({ providerSessionId: sessionId, stats })
}
