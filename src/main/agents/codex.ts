// Codex CLI headless adapter: `codex exec --json`.
import { locate, spawnCli } from '../cli'
import { Collector, ndjson, type Agent } from './types'

export const codexAgent: Agent = async (input) => {
  const exe = await locate('codex')
  if (!exe) throw new Error('Codex CLI is not installed. Open Accounts to install and sign in.')
  const { session, emit, signal } = input
  const c = new Collector(emit)

  const resumeId = session.providerSessions.codex
  const args = ['exec']
  if (resumeId) args.push('resume', resumeId)
  args.push('--json', '--skip-git-repo-check', '--color', 'never', '-C', input.cwd)
  if (input.model.model) args.push('-m', input.model.model)
  args.push('-c', `model_reasoning_effort="${input.effort}"`)
  switch (input.mode) {
    case 'plan':
      args.push('-s', 'read-only')
      break
    case 'bypass':
      args.push('--dangerously-bypass-approvals-and-sandbox')
      break
    default:
      args.push('-s', session.kind === 'chat' ? 'read-only' : 'workspace-write')
  }
  for (const a of input.attachments) if (a.mime.startsWith('image/')) args.push('-i', a.path)
  if (input.mode === 'manual' || input.mode === 'auto') c.status('Codex runs in a sandbox (workspace-write); headless Codex cannot ask for approvals.')
  args.push('-') // prompt from stdin

  const proc = spawnCli(exe, args, { cwd: input.cwd })
  const notes = input.attachments.filter((a) => !a.mime.startsWith('image/')).map((a) => `Attached file: ${a.path}`)
  const prompt = [input.system ? `<instructions>\n${input.system}\n</instructions>` : '', input.prompt, ...notes].filter(Boolean).join('\n\n')
  proc.stdin.end(prompt)

  let threadId = resumeId
  let stats: any
  let stderr = ''
  let completed = false
  const onAbort = () => proc.kill()
  signal.addEventListener('abort', onAbort, { once: true })

  const handle = ndjson((obj) => {
    if (!obj) return
    switch (obj.type) {
      case 'thread.started':
        threadId = obj.thread_id ?? threadId
        break
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = obj.item ?? {}
        const id = it.id ?? String(Math.random())
        if (it.type === 'agent_message' && obj.type === 'item.completed') {
          c.textDelta((c.text ? '\n\n' : '') + (it.text ?? ''))
        } else if (it.type === 'reasoning' && obj.type === 'item.completed') {
          c.reasoningDelta((c.reasoning ? '\n\n' : '') + (it.text ?? ''))
        } else if (it.type === 'command_execution') {
          if (obj.type === 'item.started') c.toolStart(id, 'shell', { command: it.command })
          else if (obj.type === 'item.completed') {
            if (!c.toolCalls.find((t) => t.id === id)) c.toolStart(id, 'shell', { command: it.command })
            c.toolEnd(id, `exit ${it.exit_code ?? it.exit_status ?? '?'}\n${(it.aggregated_output ?? '').slice(0, 20000)}`, it.exit_code === 0 || it.status === 'completed' ? 'done' : 'error')
          }
        } else if (it.type === 'file_change' && obj.type === 'item.completed') {
          const files = (it.changes ?? []).map((ch: any) => ch.path).filter(Boolean)
          c.toolStart(id, 'apply_patch', { changes: it.changes })
          c.toolEnd(id, files.map((f: string) => `changed ${f}`).join('\n'), 'done', files)
        } else if (it.type === 'mcp_tool_call' && obj.type === 'item.completed') {
          c.toolStart(id, it.tool ?? 'mcp', it.arguments)
          c.toolEnd(id, JSON.stringify(it.result ?? it.error ?? '').slice(0, 10000), it.error ? 'error' : 'done')
        } else if (it.type === 'web_search' && obj.type === 'item.completed') {
          c.toolStart(id, 'web_search', { query: it.query })
          c.toolEnd(id, 'searched', 'done')
        }
        break
      }
      case 'turn.completed':
        completed = true
        stats = { inputTokens: obj.usage?.input_tokens, outputTokens: obj.usage?.output_tokens }
        break
      case 'turn.failed':
      case 'error':
        c.textDelta('\n\n' + (obj.error?.message ?? obj.message ?? 'Codex reported an error.'))
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
  if (!completed && !signal.aborted && !c.text) {
    const msg = stderr.trim() || 'Codex exited without a result.'
    if (/not logged in|login|unauthori|401/i.test(msg)) throw new Error('Codex is not signed in. Open Accounts and sign in with your ChatGPT account.')
    throw new Error(msg.slice(-2000))
  }
  return c.result({ providerSessionId: threadId, stats })
}
