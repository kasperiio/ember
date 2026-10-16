import { useState } from 'react'
import { api } from '../lib/api'
import { Icon } from './Icon'
import { SessionMenu } from './SessionMenu'
import { useStore, set, openSession, newSession, type Page } from '../lib/store'
import type { SessionSummary } from '../../../shared/types'

export function Sidebar() {
  const sessions = useStore((s) => s.sessions)
  const current = useStore((s) => s.current)
  const page = useStore((s) => s.page)
  const busy = useStore((s) => s.busy)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SessionSummary[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionSummary } | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const nav = (p: Page, label: string, icon: string) => (
    <button className={page === p ? 'active' : ''} onClick={() => set({ page: p })}>
      <Icon name={icon} /> {label}
    </button>
  )

  const search = async (v: string) => {
    setQ(v)
    setResults(v.trim() ? await api.sessions.search(v.trim()) : null)
  }

  const openFolder = async () => {
    const folder = await api.ws.pickFolder()
    if (folder) newSession('code', folder)
  }

  // Search covers archived sessions too; the plain list hides them unless toggled on.
  const list = results ?? (showArchived ? sessions : sessions.filter((s) => !s.archived))
  const archivedCount = sessions.filter((s) => s.archived).length
  const chats = list.filter((s) => s.kind === 'chat')
  const codes = list.filter((s) => s.kind === 'code')

  return (
    <div className="sidebar">
      <div className="nav">
        <div className="row" style={{ padding: '2px 2px 6px' }}>
          <button className="primary grow" onClick={() => newSession('chat')}>+ New chat</button>
          <button className="grow" onClick={openFolder} title="Open a folder as a coding session">Open folder</button>
        </div>
        <button onClick={() => newSession('code')}><Icon name="flask" /> New scratch project</button>
        <button onClick={() => set({ dialog: { kind: 'join' } })} title="Join a session a friend shared with you"><Icon name="users" /> Join a shared session</button>
        <input placeholder="Search history…" value={q} onChange={(e) => search(e.target.value)} style={{ margin: '4px 2px' }} />
      </div>
      <div className="scroll grow">
        {codes.length > 0 && <div className="section">Coding sessions</div>}
        {codes.map((s) => (
          <SessionItem key={s.id} s={s} active={current?.id === s.id && page === 'session'} busy={!!busy[s.id]} onMenu={(x, y) => setMenu({ x, y, s })} />
        ))}
        {chats.length > 0 && <div className="section">Chats</div>}
        {chats.map((s) => (
          <SessionItem key={s.id} s={s} active={current?.id === s.id && page === 'session'} busy={!!busy[s.id]} onMenu={(x, y) => setMenu({ x, y, s })} />
        ))}
        {list.length === 0 && <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>{results ? 'No matches.' : archivedCount ? 'No active sessions.' : 'No sessions yet. Start a chat or open a folder.'}</div>}
        {!results && archivedCount > 0 && (
          <button className="ghost small archived-toggle" onClick={() => setShowArchived((v) => !v)}>
            <Icon name="archive" size={12} /> {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
          </button>
        )}
      </div>
      <div className="nav" style={{ borderTop: '1px solid var(--border)' }}>
        {nav('discover', 'Discover local models', 'search')}
        {nav('accounts', 'Accounts', 'user')}
        {nav('modules', 'AI Modules', 'puzzle')}
        {nav('settings', 'Settings', 'gear')}
      </div>
      {menu && <SessionMenu s={menu.s} x={menu.x} y={menu.y} invite onClose={() => setMenu(null)} />}
    </div>
  )
}

function SessionItem({ s, active, busy, onMenu }: { s: SessionSummary; active: boolean; busy: boolean; onMenu: (x: number, y: number) => void }) {
  return (
    <div
      className={'item' + (active ? ' active' : '') + (s.archived ? ' archived' : '')}
      onClick={() => openSession(s.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      title={s.workspace ?? s.title}
    >
      <Icon name={busy ? 'spinner' : s.kind === 'code' ? 'folder' : 'chat'} spin={busy} className="ico-muted" />
      <span className="t">{s.title}</span>
    </div>
  )
}
