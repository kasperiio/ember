import { useEffect } from 'react'
import { set, patchSession, renameSession, deleteSession } from '../lib/store'
import { Icon } from './Icon'

/** Rename / Archive / Delete actions for one session, shared by the chat header dropdown and the sidebar context menu. */
export function SessionMenu({
  s,
  x,
  y,
  onClose,
  invite
}: {
  s: { id: string; title: string; archived?: boolean }
  x: number
  y: number
  onClose: () => void
  invite?: boolean
}) {
  useEffect(() => {
    const close = () => onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // Defer so the click that opened the menu doesn't close it.
    const t = setTimeout(() => window.addEventListener('click', close))
    window.addEventListener('keydown', key)
    return () => {
      clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <div className="ctx" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {invite && (
        <div onClick={act(() => set({ dialog: { kind: 'share', sessionId: s.id } }))}>
          <Icon name="users" /> Invite friends…
        </div>
      )}
      <div onClick={act(() => renameSession(s.id, s.title))}>
        <Icon name="pencil" /> Rename
      </div>
      <div onClick={act(() => patchSession(s.id, { archived: !s.archived }))}>
        <Icon name="archive" /> {s.archived ? 'Unarchive' : 'Archive'}
      </div>
      <div className="danger" onClick={act(() => deleteSession(s.id, s.title))}>
        <Icon name="trash" /> Delete
      </div>
    </div>
  )
}
