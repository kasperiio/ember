// Google provider through Antigravity CLI (`agy`): headless stream-json in/out, Google-account sign-in.
// Replaces the Gemini CLI, which Google is retiring for personal and AI Pro/Ultra accounts on 2026-06-18.
import { readFile } from 'fs/promises'
import { locate, spawnCli } from '../cli'
import { Collector, ndjson, toolKind, fileFromToolInput, type Agent } from './types'

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
  switch (input.mode) {
    case 'plan':
      args.push('--mode', 'plan')
      break
    case 'acceptEdits':
      args.push('--mode', 'accept-edits')
      break
    case 'bypass':
      args.push('--dangerously-skip-permissions')
      break
    case 'auto':
      args.push('--mode', 'auto')
      break
    default:
      // manual: headless agy cannot prompt; actions without a standing allow-rule are soft-denied by the CLI
      c.status('Headless Antigravity CLI cannot ask for approvals; actions that need one are skipped (use Accept edits or Bypass).')
  }
  if (session.kind === 'chat') args.push('--mode', 'plan')

  const proc = spawnCli(exe, args, { cwd: input.cwd, env: { NO_COLOR: '1' } })
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
          if (su.state === 'DONE') {
            const file = fileFromToolInput(info.parameters)
            const ok = !info.error
            const out = info.error ? `${info.error.type ?? 'error'}: ${info.error.message ?? ''}` : typeof info.output === 'string' ? info.output : JSON.stringify(info.output ?? '')
            c.toolEnd(id, out.slice(0, 20000), ok ? 'done' : 'error', ok && toolKind(name) === 'edit' && file ? [file] : undefined)
          }
        }
        if (su.usage) stats = { inputTokens: su.usage.input_tokens ?? su.usage.prompt_tokens, outputTokens: su.usage.output_tokens ?? su.usage.candidates_tokens }
        break
      }
      case 'result': {
        const r = obj.result ?? {}
        done = true
        conversationId = r.conversation_id ?? conversationId
        if (r.usage) stats = { ...stats, inputTokens: r.usage.input_tokens ?? stats?.inputTokens, outputTokens: r.usage.output_tokens ?? stats?.outputTokens, durationMs: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : undefined }
        if (!c.text && r.response) c.textDelta(r.response)
        if (r.status && r.status !== 'SUCCESS') c.textDelta(`\n\n(${r.status}${r.error ? ': ' + (r.error.message ?? JSON.stringify(r.error)) : ''})`)
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
  if (!done && !signal.aborted && !c.text) {
    const msg = stderr.trim() || 'Antigravity CLI exited without a result.'
    if (/authentication required|not signed in|sign in|login/i.test(msg)) throw new Error('Antigravity CLI is not signed in. Open Accounts and sign in with your Google account.')
    throw new Error(msg.slice(-2000))
  }
  return c.result({ providerSessionId: conversationId, stats })
}
