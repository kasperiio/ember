// Local-model agent: Ollama through the AI SDK with Ember's own tools and permission checks.
import { streamText, stepCountIs, tool, type ModelMessage } from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import { z } from 'zod'
import { promises as fs } from 'fs'
import { getSettings } from '../store'
import { showModel } from '../ollama'
import { webSearch, fetchUrlText } from './web'
import { localBackend, remoteBackend, type ToolBackend } from '../tools'
import { Collector, type Agent, type AgentInput } from './types'
import { localTools } from '../mcp'

function makeTools(input: AgentInput, c: Collector) {
  const readOnly = input.mode === 'plan'
  const isGuest = input.session.sharing?.role === 'guest' && input.session.sharing.active
  const hostWorkspace: string | undefined = (input.session as any).hostWorkspace

  let backend: ToolBackend | null = null
  if (isGuest && input.session.kind === 'code') {
    // Guest of a shared coding session: tools run on the host, who approves edits and commands.
    const { guestRpc } = require('../sharing') as typeof import('../sharing')
    backend = remoteBackend(hostWorkspace ?? '(host workspace)', (method, params) => guestRpc(input.session.id, method, params))
  } else if (input.session.kind === 'code') {
    backend = localBackend(
      input.cwd,
      async (kind, title, detail, diff) => {
        if (readOnly) return 'Denied: this session is in Plan mode (read-only). Describe the change instead.'
        const { needsApproval } = await import('../permissions')
        if (!needsApproval(input.mode, kind)) return null
        const ok = await input.approve(kind, title, detail, diff)
        return ok ? null : 'Denied by the user.'
      },
      (file) => c.filesChanged.add(file)
    )
  }

  const tools: Record<string, any> = {
    web_search: tool({
      description: 'Search the internet. Returns titles, URLs and snippets. Use fetch_url to read a result.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        if (!getSettings().webSearch) return 'Web search is disabled in Settings.'
        const r = await webSearch(query)
        return r.length ? r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n') : 'No results.'
      }
    }),
    fetch_url: tool({
      description: 'Read a web page, PDF or YouTube transcript as text.',
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => fetchUrlText(url).catch((e) => `Failed: ${e.message}`)
    })
  }
  if (!backend) {
    tools.read_file = tool({
      description: 'Read a text file by absolute path (for example an attachment).',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => fs.readFile(path, 'utf8').then((t) => t.slice(0, 60000)).catch((e) => `Error: ${e.message}`)
    })
    return tools
  }
  const b = backend
  const where = isGuest ? " on the host's machine (the host must approve edits and commands)" : ''
  Object.assign(tools, {
    read_file: tool({
      description: `Read a text file${where}. Paths are relative to the workspace unless absolute.`,
      inputSchema: z.object({ path: z.string(), start_line: z.number().optional(), end_line: z.number().optional() }),
      execute: ({ path, start_line, end_line }) => b.readFile(path, start_line, end_line)
    }),
    list_dir: tool({
      description: `List files and folders in a directory${where} (relative to the workspace). Use "." for the root.`,
      inputSchema: z.object({ path: z.string().default('.') }),
      execute: ({ path }) => b.listDir(path)
    }),
    search_files: tool({
      description: `Search file contents in the workspace${where} with a regular expression. Returns path:line: text.`,
      inputSchema: z.object({ pattern: z.string(), max_results: z.number().default(50) }),
      execute: ({ pattern, max_results }) => b.search(pattern, max_results)
    }),
    write_file: tool({
      description: `Create or overwrite a file with the given content${where}.`,
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => b.writeFile(path, content)
    }),
    edit_file: tool({
      description: `Replace an exact text fragment in a file${where}. old_text must appear exactly once.`,
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      execute: ({ path, old_text, new_text }) => b.editFile(path, old_text, new_text)
    }),
    run_command: tool({
      description: `Run a PowerShell command in the workspace${where} and return its output. Use for builds, tests, git, installs.`,
      inputSchema: z.object({ command: z.string(), timeout_seconds: z.number().default(120) }),
      execute: ({ command, timeout_seconds }) => b.runCommand(command, timeout_seconds)
    })
  })
  return tools
}

/** The user's MCP servers' tools, approved like any other non-edit, non-command tool. Plan mode allows read-only ones. */
function mcpTools(input: AgentInput, c: Collector) {
  return localTools(
    async (title, detail, readOnly) => {
      if (input.mode === 'plan') return readOnly ? null : 'Denied: this session is in Plan mode (read-only).'
      const { needsApproval } = await import('../permissions')
      if (!needsApproval(input.mode, 'other')) return null
      return (await input.approve('other', title, detail)) ? null : 'Denied by the user.'
    },
    (s) => c.status(s)
  )
}

/** Transcript line for a message, labelled by author when the session is shared. */
export function labelled(m: { author?: string; content: string }, fallback: string): string {
  return m.author ? `[${m.author}]: ${m.content}` : fallback === 'none' ? m.content : `[${fallback}]: ${m.content}`
}

export const localAgent: Agent = async (input) => {
  const { session, emit, signal } = input
  const c = new Collector(emit)
  const settings = getSettings()
  const ollama = createOllama({ baseURL: settings.ollamaHost.replace(/\/$/, '') + '/api' })
  const modelName = input.model.model
  if (!modelName) throw new Error('No local model selected. Open Discover to install one, or pick a model with /model.')

  const caps = await showModel(modelName).catch(() => ({ capabilities: [] as string[] }))
  const supportsTools = caps.capabilities.includes('tools')
  const supportsVision = caps.capabilities.includes('vision')
  const supportsThinking = caps.capabilities.includes('thinking')
  // Ollama defaults to a 4k context, far too small for coding. Ask for the model's own window, capped to keep
  // GPU memory in check; this cap is also the window the context meter measures against.
  const numCtx = Math.min((caps as any).contextLength ?? 8192, 32768)
  let lastStepInput = 0
  const shared = !!session.sharing?.active
  const me = settings.displayName

  const systemParts = [
    `You are Ember, a helpful assistant running ${session.kind === 'code' ? 'inside a coding workspace at ' + ((session as any).hostWorkspace ?? input.cwd) : "on the user's PC"}. Today is ${new Date().toDateString()}.`,
    session.kind === 'code' ? 'Make changes with the tools. Read before you edit. Keep edits minimal. After editing, say what you changed.' : '',
    shared ? `This is a shared session with several people. Messages are labelled [name]. You are ${me}'s assistant: answer ${me}'s latest message, taking the whole conversation into account.` : '',
    supportsTools ? '' : 'You do not have tools in this session. If you need current information, say what to search for in the form SEARCH: <terms> on its own line and the host will fetch results for you.',
    input.system
  ].filter(Boolean)

  // Conversation history (uses condensed notes for anything that was compacted).
  const messages: ModelMessage[] = []
  if (session.notes) messages.push({ role: 'system', content: 'Notes from earlier in this conversation:\n' + session.notes })
  for (const m of session.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: shared ? labelled(m, me) : m.content })
    else if (m.role === 'assistant' && m.content) messages.push({ role: 'assistant', content: shared ? labelled(m, me + "'s assistant") : m.content })
  }
  const userContent: any[] = [{ type: 'text', text: shared ? `[${me}]: ${input.prompt}` : input.prompt }]
  for (const a of input.attachments) {
    if (a.mime.startsWith('image/') && supportsVision) userContent.push({ type: 'image', image: await fs.readFile(a.path), mediaType: a.mime })
    else {
      const text = await fs.readFile(a.path, 'utf8').catch(() => '(binary file)')
      userContent.push({ type: 'text', text: `\n\n<attachment name="${a.name}">\n${text.slice(0, 40000)}\n</attachment>` })
    }
  }
  messages.push({ role: 'user', content: userContent })

  const tools = supportsTools ? { ...makeTools(input, c), ...(await mcpTools(input, c)) } : undefined
  const started = Date.now()
  let usage: any
  let outTokens = 0

  // Models without tool support get host-assisted search: the model asks "SEARCH: ...", Ember answers.
  for (let round = 0; round < 3; round++) {
    const result = streamText({
      model: ollama(modelName),
      system: systemParts.join('\n\n'),
      messages,
      tools,
      stopWhen: stepCountIs(40),
      abortSignal: signal,
      // Thinking models reason far better with thinking on; turning it off makes small models 'think' in plain text instead.
      providerOptions: { ollama: { ...(supportsThinking ? { think: true } : {}), options: { num_ctx: numCtx } } }
    })
    let roundText = ''
    for await (const part of result.fullStream as AsyncIterable<any>) {
      switch (part.type) {
        case 'text-delta': {
          const d = part.text ?? part.delta ?? ''
          roundText += d
          c.textDelta(d)
          break
        }
        case 'reasoning-delta':
          c.reasoningDelta(part.text ?? part.delta ?? '')
          break
        case 'tool-call':
          c.toolStart(part.toolCallId, part.toolName, part.input)
          break
        case 'tool-result': {
          const out = typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
          const files = [...c.filesChanged].filter((f) => !c.toolCalls.some((t) => t.files?.includes(f)))
          c.toolEnd(part.toolCallId, out.slice(0, 20000), /^(Denied|Error)/.test(out) ? (out.startsWith('Denied') ? 'denied' : 'error') : 'done', files.length ? files : undefined)
          break
        }
        case 'tool-error':
          c.toolEnd(part.toolCallId, String(part.error?.message ?? part.error), 'error')
          break
        case 'finish-step':
          // prompt size of the latest model call = how full the context is right now
          if (part.usage?.inputTokens) lastStepInput = part.usage.inputTokens
          break
        case 'finish':
          usage = part.totalUsage ?? part.usage
          outTokens = usage?.outputTokens ?? outTokens
          break
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error?.message ?? part.error))
      }
    }
    // Host-assisted search for tool-less models
    const m = !supportsTools && getSettings().webSearch ? /^SEARCH:\s*(.+)$/m.exec(roundText) : null
    if (!m) break
    c.status('Searching the web for the model...')
    const hits = await webSearch(m[1]).catch(() => [])
    const pages = await Promise.all(hits.slice(0, 2).map((h) => fetchUrlText(h.url, 6000).catch(() => '')))
    const block = hits.map((h, i) => `## ${h.title}\n${h.url}\n${h.snippet}\n${pages[i] ?? ''}`).join('\n\n')
    messages.push({ role: 'assistant', content: roundText })
    messages.push({ role: 'user', content: `Search results for "${m[1]}":\n\n${block || 'No results.'}\n\nNow answer the original question using these results. Do not emit another SEARCH line.` })
    c.textDelta('\n\n')
  }

  const durationMs = Date.now() - started
  return c.result({
    stats: {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      durationMs,
      tokensPerSec: outTokens ? +((outTokens / durationMs) * 1000).toFixed(1) : undefined,
      contextTokens: (lastStepInput || usage?.inputTokens) ? (lastStepInput || usage?.inputTokens) + (usage?.outputTokens ?? 0) : undefined,
      contextLimit: numCtx
    }
  })
}

/** Condense older messages into notes (used by /compact and automatic long-session handling). */
export async function summarise(modelName: string, transcript: string): Promise<string> {
  const settings = getSettings()
  const ollama = createOllama({ baseURL: settings.ollamaHost.replace(/\/$/, '') + '/api' })
  const { generateText } = await import('ai')
  const r = await generateText({
    model: ollama(modelName),
    system: 'Condense the conversation into concise notes: goals, decisions, facts, open questions, files touched. Keep names and numbers exact. Use bullet points.',
    prompt: transcript.slice(-60000)
  })
  return r.text
}
