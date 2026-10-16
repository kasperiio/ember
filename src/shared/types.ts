// Shared types between main and renderer.

export type ProviderId = 'ollama' | 'claude' | 'codex' | 'gemini'

export type PermissionMode = 'auto' | 'manual' | 'acceptEdits' | 'plan' | 'bypass'

export type Effort = 'low' | 'medium' | 'high'

export type Theme = 'dark' | 'light' | 'system'

export interface ModelRef {
  provider: ProviderId
  model: string // ollama model tag, or CLI model name ('' = CLI default)
}

export interface Attachment {
  name: string
  path: string // absolute path to a copy inside userData/attachments
  mime: string
  size: number
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
  output?: string
  status: 'running' | 'done' | 'error' | 'denied'
  files?: string[] // files touched
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Display name of the participant who wrote this (or whose AI wrote it) in a shared session. */
  author?: string
  participantId?: string
  reasoning?: string
  toolCalls?: ToolCall[]
  attachments?: Attachment[]
  model?: ModelRef
  moduleId?: string
  checkpoint?: string // git tree id taken before this (user) message
  createdAt: number
  stats?: {
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    costUsd?: number
    tokensPerSec?: number
    /** Tokens in the model's context at the last request (prompt incl. cached), and the model's window. */
    contextTokens?: number
    contextLimit?: number
  }
  selfCheck?: { attempt: number; ok: boolean; output: string }
  error?: string
  /** Set when the provider refused this turn because the plan limit is reached. */
  limit?: { provider: ProviderId; resetsAt?: number }
}

export interface ProviderSessionIds {
  claude?: string
  codex?: string
  gemini?: string
}

export interface Session {
  id: string
  kind: 'chat' | 'code'
  title: string
  workspace?: string // absolute folder for code sessions
  model: ModelRef
  effort: Effort
  mode: PermissionMode
  moduleId?: string
  messages: ChatMessage[]
  providerSessions: ProviderSessionIds
  notes?: string // condensed memory of older messages (local provider)
  sharing?: Sharing
  archived?: boolean // hidden from the sidebar unless "Show archived" is on
  createdAt: number
  updatedAt: number
}

/** Shared-session state stored with a session. */
export interface Sharing {
  role: 'host' | 'guest'
  /** Host: public (tunnel) URL guests connect to. Guest: the URL joined. */
  url?: string
  lanUrl?: string
  key?: string
  hostName?: string
  active: boolean
}

export interface Participant {
  id: string
  name: string
  role: 'host' | 'guest'
  connected: boolean
}

/** One file edit a guest's AI wants the host to apply. */
export interface EditProposal {
  path: string
  content: string
}

export interface SessionSummary {
  id: string
  kind: 'chat' | 'code'
  title: string
  workspace?: string
  archived?: boolean
  updatedAt: number
}

export interface AiModule {
  id: string
  name: string
  instructions: string
  model?: ModelRef
  effort?: Effort
  mode?: PermissionMode
  color: string
}

/** An MCP server the user added; Ember hands it to every provider (and is the MCP client for local models). */
export interface McpServer {
  id: string
  /** Display name; its slug names the server for the providers (tools appear as e.g. mcp__<slug>__<tool>). */
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpTestResult {
  ok: boolean
  tools: { name: string; description?: string }[]
  error?: string
}

export interface Settings {
  theme: Theme
  displayName: string
  ollamaHost: string
  defaultModel: ModelRef
  defaultMode: PermissionMode
  defaultEffort: Effort
  /** Effort for new chats; low keeps replies snappy, since thinking cannot be disabled on current Claude models. */
  defaultChatEffort: Effort
  selfCheck: boolean
  selfCheckRetries: number
  webSearch: boolean
  /** Tell the AI about Ember (modules, this PC, local models) so it can propose modules and models. */
  emberAware: boolean
  scratchRoot: string
  keepInTray: boolean
  unloadOnClose: boolean
}

export interface OllamaModel {
  name: string
  size: number
  parameterSize?: string
  quantization?: string
  family?: string
  modifiedAt: string
}

export interface OllamaRunning {
  name: string
  sizeVram: number
  size: number
  expiresAt: string
}

export interface Hardware {
  cpu: string
  cores: number
  ramGb: number
  gpus: { name: string; vramGb: number; usedGb: number; vendor: 'nvidia' | 'amd' | 'intel' | 'unknown' }[]
}

export interface ModelRecommendation {
  name: string
  tag: string
  sizeGb: number
  why: string
  fits: 'gpu' | 'ram' | 'no'
  tools: boolean
  vision: boolean
  thinking: boolean
}

/** Subscription usage / rate-limit state of a provider, as reported by its official CLI. */
export interface ProviderUsage {
  provider: ProviderId
  /** 'ok' = below the warning threshold, 'warning' = near the limit, 'limited' = requests are being refused. */
  status: 'ok' | 'warning' | 'limited'
  windows: UsageWindow[]
  /** Plan name, e.g. "Max plan". */
  plan?: string
  updatedAt: number
  note?: string
}

export interface UsageWindow {
  /** e.g. "5-hour", "weekly", "weekly (Opus)". */
  label: string
  /** 0-100, when known. */
  utilization?: number
  /** Epoch ms when the window resets, when known. */
  resetsAt?: number
  status: 'ok' | 'warning' | 'limited'
}

export interface CliStatus {
  id: Exclude<ProviderId, 'ollama'>
  installed: boolean
  path?: string
  version?: string
  loggedIn: boolean | 'unknown'
  account?: string
  plan?: string // e.g. "Max plan" (Claude only for now)
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  gitStatus?: string // 'M' | 'A' | 'D' | '?' | ...
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  kind: 'edit' | 'command' | 'other'
  title: string
  detail: string
  diff?: string
}

// Streaming events from an agent run (main -> renderer)
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; output: string; status: 'done' | 'error' | 'denied'; files?: string[] }
  | { type: 'status'; text: string }
  | { type: 'self-check'; attempt: number; ok: boolean; output: string }
  | { type: 'done'; stats?: ChatMessage['stats'] }
  | { type: 'error'; message: string }
  /** The provider refused the turn because the plan's limit is reached; the UI offers to continue elsewhere. */
  | { type: 'limit'; provider: ProviderId; resetsAt?: number; message: string }

export interface CheckCommand {
  label: string
  cmd: string
}
