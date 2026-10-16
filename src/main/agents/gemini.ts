// Google provider through Antigravity CLI (`agy`): headless stream-json in/out, Google-account sign-in.
// Replaces the Gemini CLI, which Google is retiring for personal and AI Pro/Ultra accounts on 2026-06-18.
import { readFile } from 'fs/promises'
import { locate, spawnCli } from '../cli'
import { Collector, ndjson, toolKind, fileFromToolInput, type Agent, type AgentInput } from './types'
import { openAgyHook, type HookDecision } from './agyHook'
import { needsApproval } from '../permissions'
import { reportUsage, ProviderLimitError, looksLikeLimit } from '../usage'
import type { UsageWindow } from '../../shared/types'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'

/**
 * Antigravity only reports quota on request: `agy -p /usage --output-format json` returns groups
 * (Gemini models; Claude and GPT models) with a weekly and a 5-hour bucket each. Map them into Ember's usage store.
 */
export async function refreshAgyUsage(): Promise<void> {
  const exe = await locate('gemini')
  if (!exe) return
  const { stdout } = await promisify(execFile)(exe, ['-p', '/usage', '--output-format', 'json'], { cwd: tmpdir(), timeout: 60000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } })
  const j = JSON.parse(stdout.slice(stdout.indexOf('{')))
  const groups: any[] = j?.command?.data?.groups ?? []
  const windows: UsageWindow[] = []
  for (const g of groups) {
    const group = /gemini/i.test(g.name) ? 'Gemini' : /claude|gpt/i.test(g.name) ? 'Claude/GPT' : String(g.name ?? '')
    for (const b of g.buckets ?? []) {
      const remaining = typeof b.remaining_fraction === 'number' ? b.remaining_fraction : undefined
      const utilization = remaining == null ? undefined : Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)))
      const resetsAt = b.reset_time ? Date.parse(b.reset_time) : undefined
      windows.push({
        label: `${group} ${b.window === '5h' ? '5-hour' : b.window ?? 'limit'}`,
        utilization,
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
        status: (utilization ?? 0) >= 100 ? 'limited' : (utilization ?? 0) >= 85 ? 'warning' : 'ok'
      })
    }
  }
  if (windows.length) reportUsage('gemini', { windows, plan: 'Google account' })
}

// agy tools that only read, or that orchestrate work whose own tool calls are gated separately.
const FREE_TOOLS = new Set([
  'view_file', 'list_dir', 'grep_search', 'find_by_name', 'search_web', 'command_status', 'wait', 'wait_5_seconds',
  'ask_question', 'ask_permission', 'ask_custom_permission', 'list_permissions', 'finish', 'list_resources', 'read_resource',
  'list_browser_pages', 'read_browser_page', 'browser_get_dom', 'browser_get_network_request', 'browser_list_network_requests',
  'capture_browser_console_logs', 'capture_browser_screenshot', 'list_plugin_accounts', 'search_marketplace',
  'invoke_subagent', 'define_subagent', 'manage_subagents', 'browser_subagent', 'send_message', 'manage_inbox', 'manage_task', 'run_workflow'
])
const GEMINI_CONTEXT = 1_048_576 // Gemini 3.x context window
const EDIT_TOOLS =new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit'])
const COMMAND_TOOLS = new Set(['run_command', 'send_command_input', 'notebook_execution', 'execute_browser_javascript'])

/** Rough diff of an agy edit tool call, for the approval card. */
function editPreview(p: Record<string, any>): string {
  const lines = (s: unknown, sign: string) => String(s ?? '').split('\n').map((l) => sign + l).join('\n')
  if (typeof p.CodeContent === 'string') return lines(p.CodeContent, '+')
  const chunks: any[] = Array.isArray(p.ReplacementChunks) ? p.ReplacementChunks : p.TargetContent != null ? [p] : []
  if (chunks.length) return chunks.map((ch) => lines(ch.TargetContent, '-') + '\n' + lines(ch.ReplacementContent, '+')).join('\n@@\n')
  return JSON.stringify(p, null, 2)
}

async function decide(input: AgentInput, name: string, p: Record<string, any>): Promise<HookDecision> {
  if (FREE_TOOLS.has(name)) return { decision: 'allow' }
  const kind = EDIT_TOOLS.has(name) ? 'edit' : COMMAND_TOOLS.has(name) ? 'command' : 'other'
  if (!needsApproval(input.mode, kind)) return { decision: 'allow' }
  const ok =
    kind === 'edit'
      ? await input.approve('edit', String(p.TargetFile ?? fileFromToolInput(p) ?? name), '', editPreview(p).slice(0, 20000))
      : kind === 'command'
        ? await input.approve('command', String(p.CommandLine ?? p.Input ?? name), p.Cwd ? `in ${p.Cwd}` : '')
        : await input.approve('other', name, JSON.stringify(p, null, 2).slice(0, 4000))
  return ok ? { decision: 'allow' } : { decision: 'deny', reason: 'The user declined this action in Ember.' }
}

export const geminiAgent: Agent = async (input) => {
  const exe = await locate('gemini')
  if (!exe) throw new Error('Antigravity CLI (agy) is not installed. Open Accounts to install it and sign in with Google.')
  const { session, emit, signal } = input
  const c = new Collector(emit)

  const resumeId = session.providerSessions.gemini
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']
  if (resumeId) args.push('--conversation', resumeId)
  if (input.model.model) args.push('--model', input.model.model)
  // agy model slugs such as gemini-3.8-flash-low carry their own effort and reject --effort.
  if (!/-(low|medium|high|xhigh|max)$/.test(input.model.model)) args.push('--effort', input.effort)
  // Headless agy cannot prompt, so for Manual / Auto / Accept edits Ember lets agy run everything and
  // gates each tool call itself through a PreToolUse hook (see agyHook.ts).
  let hook: { env: Record<string, string>; dispose: () => void } | null = null
  if (session.kind === 'chat' || input.mode === 'plan') args.push('--mode', 'plan')
  else {
    args.push('--dangerously-skip-permissions')
    if (input.mode !== 'bypass') hook = await openAgyHook((name, params) => decide(input, name, params))
  }

  const proc = spawnCli(exe, args, { cwd: input.cwd, env: { NO_COLOR: '1', ...hook?.env } })
  const notes: string[] = []
  for (const a of input.attachments) {
    if (a.mime.startsWith('image/')) notes.push(`Attached image (read it with your tools): ${a.path}`)
    else {
      const text = await readFile(a.path, 'utf8').catch(() => '')
      notes.push(text ? `<attachment name="${a.name}">\n${text.slice(0, 40000)}\n</attachment>` : `Attached file: ${a.path}`)
    }
  }
  const prompt = [input.system ? `<instructions>\n${input.system}\n</instructions>` : '', input.prompt, ...notes].filter(Boolean).join('\n\n')
  proc.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n')

  let conversationId = resumeId
  let stderr = ''
  let done = false
  let stats: any
  let resultError = ''
  const toolSteps = new Map<number, string>() // step_index -> tool call id
  const onAbort = () => proc.kill()
  signal.addEventListener('abort', onAbort, { once: true })

  const handle = ndjson((obj, raw) => {
    if (!obj) {
      if (/error|denied/i.test(raw)) stderr += raw + '\n'
      return
    }
    switch (obj.event) {
      case 'init':
        conversationId = obj.conversation_id ?? conversationId
        break
      case 'step_update': {
        const su = obj.step_update ?? {}
        if (su.step_type === 'agent_response') {
          if (su.text_delta) c.textDelta(su.text_delta)
        } else if (su.step_type === 'thinking' || su.step_type === 'reasoning') {
          if (su.text_delta) c.reasoningDelta(su.text_delta)
        } else if (su.step_type === 'tool') {
          const info = su.tool_info ?? {}
          const name = su.tool_name ?? info.name ?? 'tool'
          let id = toolSteps.get(su.step_index)
          if (!id) {
            id = `agy-${su.step_index}`
            toolSteps.set(su.step_index, id)
            c.toolStart(id, name, info.parameters ?? {})
          }
          if (su.state === 'DONE' || su.state === 'ERROR') {
            const file = info.parameters?.TargetFile ?? fileFromToolInput(info.parameters)
            const ok = !info.error && su.state === 'DONE'
            const out = info.error ? `${info.error.type ?? 'error'}: ${info.error.message ?? ''}` : typeof info.output === 'string' ? info.output : JSON.stringify(info.output ?? '')
            const denied = /denied by pre-tool hook|denied permission/i.test(info.error?.message ?? '')
            c.toolEnd(id, out.slice(0, 20000), ok ? 'done' : denied ? 'denied' : 'error', ok && (toolKind(name) === 'edit' || EDIT_TOOLS.has(name)) && file ? [file] : undefined)
          }
        }
        if (su.usage) {
          // Each model request reports its own usage; the latest prompt (plus cache reads) is the context in use.
          const ctx = (su.usage.input_tokens ?? su.usage.prompt_tokens ?? 0) + (su.usage.cache_read_tokens ?? 0)
          stats = { ...stats, inputTokens: su.usage.input_tokens ?? su.usage.prompt_tokens, outputTokens: su.usage.output_tokens ?? su.usage.candidates_tokens, contextTokens: ctx || undefined, contextLimit: GEMINI_CONTEXT }
        }
        break
      }
      case 'result': {
        const r = obj.result ?? {}
        done = true
        conversationId = r.conversation_id ?? conversationId
        if (r.usage) stats = { ...stats, inputTokens: r.usage.input_tokens ?? stats?.inputTokens, outputTokens: r.usage.output_tokens ?? stats?.outputTokens, durationMs: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : undefined }
        if (!c.text && r.response) c.textDelta(r.response)
        if (r.status && r.status !== 'SUCCESS') {
          resultError = `${r.status}${r.error ? ': ' + (r.error.message ?? JSON.stringify(r.error)) : ''}`
          c.textDelta(`\n\n(${resultError})`)
        }
        if (Array.isArray(r.denied_actions) && r.denied_actions.length) c.status(`${r.denied_actions.length} action(s) were denied by permission rules.`)
        proc.stdin.end()
        break
      }
      case 'error':
        stderr += (obj.message ?? obj.error?.message ?? JSON.stringify(obj)) + '\n'
        break
    }
  })
  proc.stdout.on('data', handle)
  proc.stderr.on('data', (d) => (stderr += d.toString()))
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })
  signal.removeEventListener('abort', onAbort)
  hook?.dispose()
  // Refresh the quota picture after every turn (cheap: /usage is answered locally by agy without a model call).
  if (!signal.aborted) refreshAgyUsage().catch(() => undefined)
  if (!done && !signal.aborted && !c.text) {
    const msg = stderr.trim() || 'Antigravity CLI exited without a result.'
    if (/authentication required|not signed in|sign in|login/i.test(msg)) throw new Error('Antigravity CLI is not signed in. Open Accounts and sign in with your Google account.')
    if (looksLikeLimit(msg)) {
      reportUsage('gemini', { status: 'limited' })
      throw new ProviderLimitError('gemini', msg.slice(-500))
    }
    throw new Error(msg.slice(-2000))
  }
  if (resultError && looksLikeLimit(resultError) && !c.text.replace(/\n\n\(ERROR.*$/s, '').trim()) {
    reportUsage('gemini', { status: 'limited' })
    throw new ProviderLimitError('gemini', resultError.slice(-500))
  }
  return c.result({ providerSessionId: conversationId, stats })
}
