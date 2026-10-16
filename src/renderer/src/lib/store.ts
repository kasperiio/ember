// Tiny global store (useSyncExternalStore) for app-wide state.
import { useSyncExternalStore } from 'react'
import type { AiModule, ApprovalRequest, OllamaModel, OllamaRunning, Participant, ProviderUsage, Session, SessionSummary, Settings, CliStatus } from '../../../shared/types'
import { api } from './api'

export type Page = 'session' | 'discover' | 'accounts' | 'modules' | 'settings'

export interface State {
  settings: Settings | null
  sessions: SessionSummary[]
  current: Session | null
  page: Page
  modules: AiModule[]
  models: OllamaModel[]
  running: OllamaRunning[]
  cli: CliStatus[]
  /** False until the first cli:status answer arrives (sign-in state unknown). */
  cliLoaded: boolean
  cliModels: Record<string, { id: string; label: string }[]>
  approvals: ApprovalRequest[]
  busy: Record<string, boolean>
  status: Record<string, string>
  ollamaOk: boolean
  terminalRequests: { id: string; cwd: string; cmd: string; title: string }[]
  participants: Record<string, Participant[]>
  usage: ProviderUsage[]
  dialog: { kind: 'share'; sessionId: string } | { kind: 'join' } | null
}

let state: State = {
  settings: null,
  sessions: [],
  current: null,
  page: 'session',
  modules: [],
  models: [],
  running: [],
  cli: [],
  cliLoaded: false,
  cliModels: {},
  approvals: [],
  busy: {},
  status: {},
  ollamaOk: false,
  terminalRequests: [],
  participants: {},
  usage: [],
  dialog: null
}
const listeners = new Set<() => void>()

export function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  listeners.forEach((l) => l())
}
export function get(): State {
  return state
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => sel(state)
  )
}

export async function refreshSessions(): Promise<void> {
  set({ sessions: await api.sessions.list() })
}
export async function refreshModels(): Promise<void> {
  const st = await api.ollama.status()
  set({ ollamaOk: st.ok })
  if (st.ok) set({ models: await api.ollama.models(), running: await api.ollama.running() })
  else set({ models: [], running: [] })
}
export async function refreshCli(): Promise<void> {
  const cli = await api.cli.status()
  set({ cli, cliLoaded: true })
  const cliModels: State['cliModels'] = {}
  await Promise.all(cli.filter((c) => c.installed).map(async (c) => (cliModels[c.id] = await api.cli.models(c.id).catch(() => []))))
  set({ cliModels })
}
export async function refreshModules(): Promise<void> {
  set({ modules: await api.modules.list() })
}

export async function openSession(id: string): Promise<void> {
  const s = await api.sessions.get(id)
  if (s) set({ current: s, page: 'session', busy: { ...state.busy, [id]: await api.sessions.running(id) } })
}

export async function newSession(kind: 'chat' | 'code', workspace?: string): Promise<Session> {
  const s = await api.sessions.create({ kind, workspace })
  await refreshSessions()
  set({ current: s, page: 'session' })
  return s
}

export async function saveCurrent(patch: Partial<Session>): Promise<void> {
  if (!state.current) return
  const next = { ...state.current, ...patch }
  set({ current: next })
  await api.sessions.save(next)
  refreshSessions()
}

/** Patch any session (current or not) on disk and keep the open copy in sync. */
export async function patchSession(id: string, patch: Partial<Session>): Promise<void> {
  if (state.current?.id === id) return saveCurrent(patch)
  const full = await api.sessions.get(id)
  if (!full) return
  await api.sessions.save({ ...full, ...patch })
  refreshSessions()
}

export async function renameSession(id: string, title: string): Promise<void> {
  const t = prompt('Session title', title)
  if (t?.trim()) await patchSession(id, { title: t.trim() })
}

export async function deleteSession(id: string, title: string): Promise<void> {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return
  await api.share.stop(id).catch(() => undefined)
  await api.sessions.delete(id)
  if (state.current?.id === id) set({ current: null })
  refreshSessions()
}

export function requestTerminal(cwd: string, cmd: string, title: string): void {
  set({ terminalRequests: [...state.terminalRequests, { id: 't-' + Math.random().toString(36).slice(2, 8), cwd, cmd, title }] })
}

export function modelLabel(m: { provider: string; model: string }): string {
  const names: Record<string, string> = { ollama: 'Local', claude: 'Claude', codex: 'ChatGPT', gemini: 'Antigravity' }
  return m.model ? `${names[m.provider] ?? m.provider} · ${m.model}` : `${names[m.provider] ?? m.provider}${m.provider === 'ollama' ? ' (no model)' : ' (default)'}`
}
