import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore, set, get, renameSession, modelLabel, refreshSessions, saveCurrent } from '../lib/store'
import { Message } from './Message'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { SessionMenu } from './SessionMenu'
import { resetLabel } from './StatusBar'
import type { Attachment, ApprovalRequest, ChatMessage, Participant, ProviderId } from '../../../shared/types'

// Selectors passed to useStore must return existing references; a fresh [] per read would re-render forever.
const NONE: Participant[] = []
const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Google Antigravity', ollama: 'a local model' }

/** Shown under a reply the provider refused because the plan limit is reached. */
function LimitCard({ limit, onContinue }: { limit: NonNullable<ChatMessage['limit']>; onContinue: (provider: ProviderId, model: string) => void }) {
  const cli = useStore((s) => s.cli)
  const models = useStore((s) => s.models)
  const cliModels = useStore((s) => s.cliModels)
  const usage = useStore((s) => s.usage)
  const others = (['claude', 'codex', 'gemini'] as const).filter((p) => p !== limit.provider && cli.find((c) => c.id === p)?.loggedIn === true && usage.find((u) => u.provider === p)?.status !== 'limited')
  const [choice, setChoice] = useState<string>(others[0] ? others[0] + '|' : models[0] ? 'ollama|' + models[0].name : '')
  return (
    <div className="approval">
      <div className="row">
        <strong className="row" style={{ gap: 6 }}><Icon name="warn" />{PROVIDER_NAME[limit.provider]} has reached your plan's limit</strong>
        <span className="muted">{limit.resetsAt ? resetLabel(limit.resetsAt) : 'try again later'}</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Continue this conversation with</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {others.map((p) => (
            <optgroup key={p} label={PROVIDER_NAME[p]}>
              <option value={p + '|'}>{PROVIDER_NAME[p]} · default</option>
              {(cliModels[p] ?? []).map((m) => <option key={m.id} value={p + '|' + m.id}>{PROVIDER_NAME[p]} · {m.label}</option>)}
            </optgroup>
          ))}
          {models.length > 0 && (
            <optgroup label="Local (Ollama)">
              {models.map((m) => <option key={m.name} value={'ollama|' + m.name}>{m.name}</option>)}
            </optgroup>
          )}
        </select>
        <button className="primary" disabled={!choice} onClick={() => { const [p, m] = choice.split('|'); onContinue(p as ProviderId, m) }}>Continue</button>
        <span className="muted" style={{ fontSize: 12 }}>or wait for the reset and send again</span>
      </div>
    </div>
  )
}

export function ChatView() {
  const current = useStore((s) => s.current)!
  const busy = useStore((s) => !!s.busy[s.current?.id ?? ''])
  const allApprovals = useStore((s) => s.approvals)
  const approvals = allApprovals.filter((a) => a.sessionId === current.id)
  const modules = useStore((s) => s.modules)
  const settings = useStore((s) => s.settings)
  const participantMap = useStore((s) => s.participants)
  const participants = participantMap[current.id] ?? NONE
  const listRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    if (stick && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [current.messages, stick, approvals.length])

  const onScroll = () => {
    const el = listRef.current!
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  const send = async (text: string, attachments: Attachment[]) => {
    const id = current.id
    set((s) => ({ busy: { ...s.busy, [id]: true } }))
    setStick(true)
    try {
      await api.sessions.send(id, text, attachments)
    } catch (e: any) {
      alert(e.message)
      set((s) => ({ busy: { ...s.busy, [id]: false } }))
    }
  }

  const answer = async (req: ApprovalRequest, ok: boolean) => {
    await api.approval.answer(req.id, ok)
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== req.id) }))
  }

  const rewind = async (msgId: string, what: 'files' | 'conversation' | 'both') => {
    const s = await api.sessions.rewind(current.id, msgId, what)
    if (s) set({ current: s })
    refreshSessions()
  }

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const mod = modules.find((m) => m.id === current.moduleId)

  // The last assistant message hit a plan limit: offer to continue the same request on another provider.
  const lastMsg = current.messages[current.messages.length - 1]
  const lastLimit = lastMsg?.role === 'assistant' && lastMsg.limit ? lastMsg.limit : null
  const continueElsewhere = async (provider: ProviderId, model: string) => {
    const lastUser = [...current.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    await saveCurrent({ model: { provider, model } })
    send(lastUser.content, lastUser.attachments ?? [])
  }

  return (
    <div className="chat">
      <div className="head">
        <span className="title-wrap">
          <span className="title" onDoubleClick={() => renameSession(current.id, current.title)} title="Double-click to rename">{current.title}</span>
          <button
            className="ghost small"
            title="Session actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu(menu ? null : { x: r.left, y: r.bottom + 4 })
            }}
          >
            <Icon name="chevron" size={12} />
          </button>
          {current.archived && <span className="badge">Archived</span>}
        </span>
        {menu && <SessionMenu s={current} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
        {mod && <span className="badge accent" style={{ borderColor: mod.color, color: mod.color }}>{mod.name}</span>}
        <span className="badge">{modelLabel(mod?.model ?? current.model)}</span>
        {current.sharing?.active && current.sharing.role === 'host' && (
          <button className="small" title="Invite friends / manage sharing" onClick={() => set({ dialog: { kind: 'share', sessionId: current.id } })}>
            <Icon name="users" /> Shared ·{Math.max(0, participants.filter((p) => p.role === 'guest').length)} guest{participants.filter((p) => p.role === 'guest').length === 1 ? '' : 's'}
          </button>
        )}
        {current.sharing?.role === 'guest' && (
          <>
            <span className={'badge ' + (current.sharing.active ? 'accent' : '')}>{current.sharing.active ? `Guest of ${current.sharing.hostName}` : 'Disconnected'}</span>
            {current.sharing.active ? (
              <button className="small" onClick={() => api.share.leave(current.id)}>Leave</button>
            ) : (
              <button className="small" onClick={() => api.share.join(current.sharing!.url!, current.sharing!.key!, current.id).then((s) => set({ current: s })).catch((e) => alert(e.message))}>Reconnect</button>
            )}
          </>
        )}
        {current.workspace && (
          <>
            <button className="ghost small" title="Open in VS Code" onClick={() => api.ws.openInVSCode(current.workspace!)}>VS Code</button>
            <button className="ghost small" title="Open in Windows Terminal" onClick={() => api.ws.openInTerminal(current.workspace!)}>Terminal</button>
            <button className="ghost small" title="Show folder" onClick={() => api.ws.openExternal(current.workspace!)}><Icon name="folder-open" /></button>
          </>
        )}
      </div>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        <div className="inner">
          {current.messages.length === 0 && (
            <div className="empty" style={{ height: 'auto', padding: 40 }}>
              <div>
                <p>
                  {current.kind === 'code' ? 'Ask for a change to this project.' : 'Ask anything.'} Type <span className="kbd">/</span> for commands.
                </p>
                {current.model.provider === 'ollama' && !current.model.model && (
                  <p className="muted">No local model selected yet. Use <span className="kbd">/model</span> or open Discover to install one.</p>
                )}
              </div>
            </div>
          )}
          {current.messages.map((m, i) => (
            <Message
              key={m.id}
              msg={m}
              streaming={busy && i === current.messages.length - 1 && m.role === 'assistant'}
              workspace={current.workspace}
              onRewind={m.role === 'user' && current.sharing?.role !== 'guest' ? (what) => rewind(m.id, what) : undefined}
              me={settings?.displayName}
            />
          ))}
          {lastLimit && !busy && <LimitCard limit={lastLimit} onContinue={continueElsewhere} />}
          {approvals.map((a) => (
            <div key={a.id} className="approval">
              <div className="row">
                <strong className="row" style={{ gap: 6 }}><Icon name={a.kind === 'edit' ? 'pencil' : a.kind === 'command' ? 'bolt' : 'wrench'} />{a.kind === 'edit' ? 'Edit' : a.kind === 'command' ? 'Run command' : 'Allow'}</strong>
                <span className="mono grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</span>
              </div>
              {a.diff ? <pre>{a.diff}</pre> : a.detail ? <pre>{a.detail}</pre> : null}
              <div className="row">
                <button className="primary" onClick={() => answer(a, true)}>Allow</button>
                <button onClick={() => answer(a, false)}>Deny</button>
                <span className="muted" style={{ fontSize: 12 }}>Change the mode to "Accept edits" or "Bypass" to stop asking.</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Composer busy={busy} onSend={send} onStop={() => api.sessions.stop(get().current!.id)} />
    </div>
  )
}
