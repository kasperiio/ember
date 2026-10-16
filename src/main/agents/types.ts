import type { AgentEvent, Attachment, ChatMessage, Effort, ModelRef, PermissionMode, Session, ToolCall } from '../../shared/types'

export interface AgentInput {
  session: Session
  prompt: string
  attachments: Attachment[]
  /** Extra system instructions (project files, module instructions). */
  system: string
  cwd: string
  mode: PermissionMode
  effort: Effort
  model: ModelRef
  signal: AbortSignal
  emit: (ev: AgentEvent) => void
  /** Ask the user; resolves true when allowed. */
  approve: (kind: 'edit' | 'command' | 'other', title: string, detail: string, diff?: string) => Promise<boolean>
}

export interface AgentOutput {
  providerSessionId?: string
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  stats?: ChatMessage['stats']
  filesChanged: string[]
}

export type Agent = (input: AgentInput) => Promise<AgentOutput>

/** Accumulates streamed events into an AgentOutput while forwarding them. */
export class Collector {
  text = ''
  reasoning = ''
  toolCalls: ToolCall[] = []
  filesChanged = new Set<string>()
  constructor(private emit: (ev: AgentEvent) => void) {}

  textDelta(d: string) {
    if (!d) return
    this.text += d
    this.emit({ type: 'text', delta: d })
  }
  reasoningDelta(d: string) {
    if (!d) return
    this.reasoning += d
    this.emit({ type: 'reasoning', delta: d })
  }
  toolStart(id: string, name: string, input: unknown) {
    this.toolCalls.push({ id, name, input, status: 'running' })
    this.emit({ type: 'tool-start', id, name, input })
  }
  toolEnd(id: string, output: string, status: 'done' | 'error' | 'denied' = 'done', files?: string[]) {
    const tc = this.toolCalls.find((t) => t.id === id)
    if (tc) {
      tc.output = output
      tc.status = status
      tc.files = files
    }
    files?.forEach((f) => this.filesChanged.add(f))
    this.emit({ type: 'tool-end', id, output, status, files })
  }
  status(text: string) {
    this.emit({ type: 'status', text })
  }
  result(extra: Partial<AgentOutput> = {}): AgentOutput {
    return { text: this.text, reasoning: this.reasoning, toolCalls: this.toolCalls, filesChanged: [...this.filesChanged], ...extra }
  }
}

/** Parse newline-delimited JSON from a stream, tolerating partial lines and junk. */
export function ndjson(onLine: (obj: any, raw: string) => void): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      if (line.startsWith('{')) {
        try {
          onLine(JSON.parse(line), line)
          continue
        } catch {
          // fallthrough
        }
      }
      onLine(null, line)
    }
  }
}

export function toolKind(name: string): 'edit' | 'command' | 'other' {
  if (/^(edit|write|multiedit|notebookedit|write_file|edit_file|replace|write_to_file|apply_patch|create_file)$/i.test(name)) return 'edit'
  if (/^(bash|run_command|run_shell_command|shell|powershell|execute|exec_command)$/i.test(name)) return 'command'
  return 'other'
}

export function fileFromToolInput(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  return input.file_path ?? input.path ?? input.filePath ?? input.notebook_path ?? input.absolute_path ?? undefined
}
