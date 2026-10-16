import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore, set, refreshSessions } from '../lib/store'
import type { Session, Participant } from '../../../shared/types'
import { Icon } from './Icon'

// Selectors passed to useStore must return existing references; a fresh [] per read would re-render forever.
const NONE: Participant[] = []

export function ShareDialog({ sessionId }: { sessionId: string }) {
  const participantMap = useStore((s) => s.participants)
  const participants = participantMap[sessionId] ?? NONE
  const [session, setSession] = useState<Session | null>(null)
  const [info, setInfo] = useState<{ url: string; lanUrl: string; key: string; tunnel: boolean } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cloudflared, setCloudflared] = useState<boolean | null>(null)
  const [log, setLog] = useState('')

  useEffect(() => {
    api.sessions.get(sessionId).then((s) => {
      setSession(s)
      if (s?.sharing?.active && s.sharing.role === 'host' && s.sharing.url && s.sharing.key) {
        const i = { url: s.sharing.url, lanUrl: s.sharing.lanUrl ?? s.sharing.url, key: s.sharing.key, tunnel: !s.sharing.url.startsWith('http://') }
        setInfo(i)
        api.share.inviteCode(i.url, i.key).then(setCode)
        api.share.participants(sessionId).then((p) => set((st) => ({ participants: { ...st.participants, [sessionId]: p } })))
      }
    })
    api.share.cloudflared().then(setCloudflared)
    const off = api.on('log', ({ source, text }: { source: string; text: string }) => source === 'cloudflared-install' && setLog((l) => l + text))
    return off
  }, [sessionId])

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const i = await api.share.start(sessionId)
      setInfo(i)
      setCode(await api.share.inviteCode(i.url, i.key))
      refreshSessions()
    } catch (e: any) {
      setError(e.message)
    }
    setBusy(false)
  }
  const stop = async () => {
    await api.share.stop(sessionId)
    setInfo(null)
    refreshSessions()
  }
  const installCf = async () => {
    setLog('Installing cloudflared with winget…\n')
    const ok = await api.share.installCloudflared()
    setCloudflared(ok)
    setLog((l) => l + (ok ? '\nInstalled.' : '\nInstall failed.'))
  }
  const close = () => set({ dialog: null })

  const invite = info ? `Join my Ember session "${session?.title ?? ''}":\n${info.url}\nKey: ${info.key}\n\nIn Ember: sidebar → Join a shared session → paste this code:\n${code}` : ''

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Invite friends</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Friends join this {session?.kind === 'code' ? 'coding session' : 'chat'} with their own AI and their own plan. Everyone sees everything.
          {session?.kind === 'code' ? ' Edits and commands from a guest’s AI run on your PC only after you approve them.' : ''}
        </p>
        {!info ? (
          <div className="col">
            {cloudflared === false && (
              <div className="card" style={{ borderColor: 'var(--warn)' }}>
                <strong>Internet sharing needs cloudflared.</strong> Without it, friends can only join from your local network.
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="small" onClick={installCf}>Install cloudflared</button>
                  <span className="muted" style={{ fontSize: 12 }}>winget · Cloudflare.cloudflared</span>
                </div>
                {log && <pre className="log" style={{ marginTop: 6 }}>{log}</pre>}
              </div>
            )}
            <div className="row">
              <button className="primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start sharing'}</button>
              <button onClick={close}>Cancel</button>
            </div>
            {error && <div className="err"><Icon name="warn" /> {error}</div>}
          </div>
        ) : (
          <div className="col">
            <div className="row">
              <span className={'badge ' + (info.tunnel ? 'ok' : 'warn')}>{info.tunnel ? 'Shared over the internet' : 'Local network only'}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>{info.url}</span>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{invite}</pre>
            <div className="row">
              <button className="primary" onClick={() => api.clipboard(invite)}>Copy invite</button>
              <button onClick={() => api.clipboard(code)}>Copy code only</button>
              <span className="grow" />
              <button className="danger" onClick={stop}>Stop sharing</button>
              <button onClick={close}>Close</button>
            </div>
            <h3>Participants</h3>
            <div className="col" style={{ gap: 4 }}>
              {participants.map((p) => (
                <div key={p.id} className="row" style={{ fontSize: 13 }}>
                  <Icon name={p.role === 'host' ? 'crown' : 'user'} className="ico-muted" />
                  <span>{p.name}</span>
                  <span className="muted">{p.role}</span>
                </div>
              ))}
              {participants.filter((p) => p.role === 'guest').length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No friends have joined yet.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function JoinDialog() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => set({ dialog: null })

  const join = async () => {
    setBusy(true)
    setError('')
    try {
      const parsed = await api.share.parseInvite(text)
      if (!parsed) throw new Error('Paste the invite code, or the URL followed by the key.')
      const s = await api.share.join(parsed.url, parsed.key)
      await refreshSessions()
      set({ current: s, page: 'session', dialog: null })
    } catch (e: any) {
      setError(e.message)
    }
    setBusy(false)
  }

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Join a shared session</h2>
        <p className="muted" style={{ fontSize: 13 }}>Paste the invite your friend sent. You chat with your own AI; the host sees your messages and approves any code changes.</p>
        <textarea rows={4} style={{ width: '100%' }} placeholder="Invite code, or: https://… key" value={text} onChange={(e) => setText(e.target.value)} />
        {error && <div className="err" style={{ marginTop: 6 }}><Icon name="warn" /> {error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={join} disabled={busy || !text.trim()}>{busy ? 'Joining…' : 'Join'}</button>
        </div>
      </div>
    </div>
  )
}
