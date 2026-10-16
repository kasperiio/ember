import { useEffect } from 'react'
import { api } from './lib/api'
import { useStore, set, get, refreshSessions, refreshModels, refreshCli, refreshModules } from './lib/store'
import { Sidebar } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { Discover } from './components/Discover'
import { Accounts } from './components/Accounts'
import { Modules } from './components/Modules'
import { SettingsPage } from './components/SettingsPage'
import { StatusBar } from './components/StatusBar'
import { ShareDialog, JoinDialog } from './components/ShareDialogs'
import type { Session, AgentEvent, ApprovalRequest, Participant, ProviderUsage } from '../../shared/types'

function applyTheme(theme: string): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

export function App() {
  const page = useStore((s) => s.page)
  const settings = useStore((s) => s.settings)
  const dialog = useStore((s) => s.dialog)

  useEffect(() => {
    ;(async () => {
      const st = await api.settings.get()
      set({ settings: st })
      applyTheme(st.theme)
      await Promise.all([refreshSessions(), refreshModules(), refreshModels()])
      refreshCli()
      const list = get().sessions
      if (list[0]) {
        const s = await api.sessions.get(list[0].id)
        if (s) set({ current: s })
      }
    })()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMq = () => applyTheme(get().settings?.theme ?? 'system')
    mq.addEventListener('change', onMq)

    const offs = [
      api.on('session:updated', (s: Session) => {
        const cur = get().current
        if (cur && cur.id === s.id) {
          // keep streaming text if a message is mid-stream: merge by id
          const streaming = new Map(cur.messages.map((m) => [m.id, m]))
          const merged = s.messages.map((m) => {
            const old = streaming.get(m.id)
            return old && !m.content && old.content ? { ...m, content: old.content, reasoning: old.reasoning, toolCalls: old.toolCalls } : m
          })
          set({ current: { ...s, messages: merged } })
        }
        refreshSessions()
      }),
      api.on('agent:event', ({ sessionId, messageId, ev }: { sessionId: string; messageId: string; ev: AgentEvent }) => {
        const cur = get().current
        if (ev.type === 'done' || ev.type === 'error') set((s) => ({ busy: { ...s.busy, [sessionId]: false }, status: { ...s.status, [sessionId]: '' } }))
        if (ev.type === 'status') set((s) => ({ status: { ...s.status, [sessionId]: ev.text } }))
        if (!cur || cur.id !== sessionId) return
        const msgs = cur.messages.map((m) => {
          if (m.id !== messageId) return m
          switch (ev.type) {
            case 'text':
              return { ...m, content: m.content + ev.delta }
            case 'reasoning':
              return { ...m, reasoning: (m.reasoning ?? '') + ev.delta }
            case 'tool-start':
              return { ...m, toolCalls: [...(m.toolCalls ?? []), { id: ev.id, name: ev.name, input: ev.input, status: 'running' as const }] }
            case 'tool-end':
              return { ...m, toolCalls: (m.toolCalls ?? []).map((t) => (t.id === ev.id ? { ...t, output: ev.output, status: ev.status, files: ev.files } : t)) }
            case 'self-check':
              return { ...m, selfCheck: { attempt: ev.attempt, ok: ev.ok, output: ev.output } }
            case 'error':
              return { ...m, error: ev.message }
            case 'limit':
              return { ...m, limit: { provider: ev.provider, resetsAt: ev.resetsAt } }
            case 'done':
              return { ...m, stats: ev.stats ?? m.stats }
            default:
              return m
          }
        })
        set({ current: { ...cur, messages: msgs } })
      }),
      api.on('approval:request', (req: ApprovalRequest) => set((s) => ({ approvals: [...s.approvals, req] }))),
      api.on('share:participants', ({ sessionId, participants }: { sessionId: string; participants: Participant[] }) => set((s) => ({ participants: { ...s.participants, [sessionId]: participants } }))),
      api.on('share:error', ({ message }: { message: string }) => set((s) => ({ status: { ...s.status, [s.current?.id ?? '']: 'Sharing: ' + message } }))),
      api.on('usage:updated', (u: ProviderUsage[]) => set({ usage: u })),
      api.on('ollama:pull-progress', () => undefined)
    ]
    api.usage.get().then((u) => set({ usage: u }))
    // Antigravity only reports quota on request; ask once at startup (Claude and Codex report during turns).
    api.usage.refresh().then((u) => set({ usage: u })).catch(() => undefined)
    const t = setInterval(() => refreshModels(), 15000)
    return () => {
      offs.forEach((f) => f())
      mq.removeEventListener('change', onMq)
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (settings) applyTheme(settings.theme)
  }, [settings?.theme])

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">🔥 Ember</span>
      </div>
      <Sidebar />
      <div className="main">
        {page === 'session' && <SessionView />}
        {page === 'discover' && <Discover />}
        {page === 'accounts' && <Accounts />}
        {page === 'modules' && <Modules />}
        {page === 'settings' && <SettingsPage />}
      </div>
      <StatusBar />
      {dialog?.kind === 'share' && <ShareDialog sessionId={dialog.sessionId} />}
      {dialog?.kind === 'join' && <JoinDialog />}
    </div>
  )
}
