import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore, set, saveCurrent, refreshSessions } from '../lib/store'
import type { Attachment, Effort, PermissionMode, ProviderId } from '../../../shared/types'
import { Icon } from './Icon'

const COMMANDS = [
  { cmd: '/model', help: 'Pick the model for this session' },
  { cmd: '/mode', help: 'Permission mode: auto, manual, acceptEdits, plan, bypass' },
  { cmd: '/effort', help: 'Effort: low, medium, high' },
  { cmd: '/module', help: 'Use an AI Module (named assistant)' },
  { cmd: '/compact', help: 'Condense the conversation to save context' },
  { cmd: '/new', help: 'Start a new chat' },
  { cmd: '/check', help: 'Run the project checks now' },
  { cmd: '/commit', help: 'Commit all changes with git' }
]

const PROVIDER_LABEL: Record<string, string> = { ollama: 'Local', claude: 'Claude', codex: 'ChatGPT', gemini: 'Google Antigravity' }

const MODES: { v: PermissionMode; l: string; t: string }[] = [
  { v: 'auto', l: 'Auto', t: 'Edits happen, commands ask' },
  { v: 'manual', l: 'Manual', t: 'Ask for every edit and command' },
  { v: 'acceptEdits', l: 'Accept edits', t: 'Edits and reads are free; commands ask' },
  { v: 'plan', l: 'Plan', t: 'Read-only' },
  { v: 'bypass', l: 'Bypass', t: 'Never ask (careful)' }
]

export function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string, a: Attachment[]) => void; onStop: () => void }) {
  const current = useStore((s) => s.current)!
  const models = useStore((s) => s.models)
  const cli = useStore((s) => s.cli)
  const cliModels = useStore((s) => s.cliModels)
  const modules = useStore((s) => s.modules)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [slashSel, setSlashSel] = useState(0)
  const [modelOpen, setModelOpen] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ta.current?.focus()
  }, [current.id])

  const showSlash = text.startsWith('/') && !text.includes(' ') && !text.includes('\n')
  const matches = COMMANDS.filter((c) => c.cmd.startsWith(text.toLowerCase()))

  const runCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (cmd) {
      case '/model':
        if (!arg) setModelOpen(true)
        else {
          const [prov, ...m] = arg.split(/[:\s]/)
          const provider = (['ollama', 'claude', 'codex', 'gemini'].includes(prov) ? prov : 'ollama') as ProviderId
          const model = provider === prov ? m.join(':') : arg
          await saveCurrent({ model: { provider, model } })
        }
        return true
      case '/mode':
        if (MODES.some((m) => m.v === arg)) await saveCurrent({ mode: arg as PermissionMode })
        return true
      case '/effort':
        if (['low', 'medium', 'high'].includes(arg)) await saveCurrent({ effort: arg as Effort })
        return true
      case '/module': {
        const mod = modules.find((m) => m.name.toLowerCase() === arg.toLowerCase())
        await saveCurrent({ moduleId: mod?.id })
        return true
      }
      case '/compact': {
        const s = await api.sessions.compact(current.id)
        if (s) set({ current: s })
        return true
      }
      case '/new': {
        const s = await api.sessions.create({ kind: 'chat' })
        set({ current: s })
        refreshSessions()
        return true
      }
      case '/check':
        if (current.workspace) {
          const r = await api.ws.runChecks(current.workspace)
          onSend(r.ok ? 'Checks passed:\n' + r.output.slice(-2000) : 'The project checks failed. Please fix:\n\n' + r.output.slice(-6000), [])
        }
        return true
      case '/commit':
        if (current.workspace) alert(await api.ws.gitCommit(current.workspace, arg || 'Changes made with Ember'))
        return true
    }
    return false
  }

  const submit = async () => {
    const t = text.trim()
    if (!t && !attachments.length) return
    if (t.startsWith('/') && (await runCommand(t))) {
      setText('')
      return
    }
    if (busy) return
    onSend(t, attachments)
    setText('')
    setAttachments([])
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (showSlash && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((s) => (s + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((s) => (s - 1 + matches.length) % matches.length); return }
      if (e.key === 'Tab') { e.preventDefault(); setText(matches[slashSel].cmd + ' '); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
    if (paths.length) {
      const added = await api.attachments.import(paths)
      setAttachments((a) => [...a, ...added])
    }
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (files.length) {
      e.preventDefault()
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean)
      if (paths.length) {
        const added = await api.attachments.import(paths)
        setAttachments((a) => [...a, ...added])
      }
    }
  }

  const modelName = current.model.model
  const cliOk = (id: string) => cli.find((c) => c.id === id)?.loggedIn === true
  const signedIn = (['claude', 'codex', 'gemini'] as const).filter(cliOk)

  return (
    <div className="composer" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="box" style={{ position: 'relative' }}>
        {showSlash && matches.length > 0 && (
          <div className="slash">
            {matches.map((c, i) => (
              <div key={c.cmd} className={i === slashSel ? 'sel' : ''} onMouseDown={() => setText(c.cmd + ' ')}>
                <span className="mono">{c.cmd}</span><small>{c.help}</small>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {attachments.map((a) => (
              <span key={a.path} className="attach">
                {a.mime.startsWith('image/') ? <img src={'file:///' + a.path.replace(/\\/g, '/')} alt="" /> : <><Icon name="paperclip" /> {a.name}</>}
                <button className="ghost small" onClick={() => setAttachments((l) => l.filter((x) => x !== a))}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={2}
          placeholder={current.kind === 'code' ? 'Describe the change you want… (Enter to send, Shift+Enter for newline, drop files to attach)' : 'Message Ember… (drop files or images to attach)'}
          value={text}
          onChange={(e) => { setText(e.target.value); setSlashSel(0) }}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div className="bar">
          <button className="ghost small" title="Attach files" onClick={async () => { const added = await api.attachments.pick(); setAttachments((a) => [...a, ...added]) }}><Icon name="paperclip" /></button>
          <select
            value={current.model.provider + '|' + current.model.model}
            onChange={(e) => {
              const [provider, model] = e.target.value.split('|')
              saveCurrent({ model: { provider: provider as ProviderId, model } })
            }}
            title="Model"
          >
            <optgroup label="Local (Ollama)">
              {models.length === 0 && <option value="ollama|">No local models - open Discover</option>}
              {models.map((m) => <option key={m.name} value={'ollama|' + m.name}>{m.name}</option>)}
              {current.model.provider === 'ollama' && modelName && !models.some((m) => m.name === modelName) && <option value={'ollama|' + modelName}>{modelName} (missing)</option>}
            </optgroup>
            {/* Only providers that are signed in are listed; the Accounts page adds more. */}
            {signedIn.map((p) => (
              <optgroup key={p} label={PROVIDER_LABEL[p]}>
                <option value={p + '|'}>{PROVIDER_LABEL[p]} · default</option>
                {(cliModels[p] ?? []).map((m) => <option key={p + '|' + m.id} value={p + '|' + m.id}>{PROVIDER_LABEL[p]} · {m.label}</option>)}
              </optgroup>
            ))}
            {signedIn.length === 0 && <optgroup label="Your accounts"><option value="ollama|" disabled>Sign in on the Accounts page to use Claude, ChatGPT or Google</option></optgroup>}
            {current.model.provider !== 'ollama' && (!signedIn.includes(current.model.provider) || (current.model.model && !(cliModels[current.model.provider] ?? []).some((m) => m.id === current.model.model))) && (
              <optgroup label="Current">
                <option value={current.model.provider + '|' + current.model.model}>{PROVIDER_LABEL[current.model.provider]} · {current.model.model || 'default'}{signedIn.includes(current.model.provider) ? '' : ' (not signed in)'}</option>
              </optgroup>
            )}
          </select>
          <select value={current.effort} onChange={(e) => saveCurrent({ effort: e.target.value as Effort })} title="Effort / thinking">
            <option value="low">Effort: low</option>
            <option value="medium">Effort: medium</option>
            <option value="high">Effort: high</option>
          </select>
          {current.kind === 'code' && (
            <select value={current.mode} onChange={(e) => saveCurrent({ mode: e.target.value as PermissionMode })} title="Permission mode">
              {MODES.map((m) => <option key={m.v} value={m.v} title={m.t}>{m.l}</option>)}
            </select>
          )}
          {modules.length > 0 && (
            <select value={current.moduleId ?? ''} onChange={(e) => saveCurrent({ moduleId: e.target.value || undefined })} title="AI Module">
              <option value="">No module</option>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <span className="grow" />
          {busy ? <button onClick={onStop}><Icon name="stop" size={12} /> Stop</button> : <button className="primary" onClick={submit} disabled={!text.trim() && !attachments.length}>Send ↵</button>}
        </div>
      </div>
      {modelOpen && (
        <div className="modal-bg" onClick={() => setModelOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Choose a model</h2>
            <div className="col">
              {models.map((m) => (
                <button key={m.name} onClick={() => { saveCurrent({ model: { provider: 'ollama', model: m.name } }); setModelOpen(false) }}>
                  {m.name} <span className="muted">· {(m.size / 1024 ** 3).toFixed(1)} GB {m.parameterSize ?? ''}</span>
                </button>
              ))}
              {signedIn.flatMap((p) => [
                <button key={p} onClick={() => { saveCurrent({ model: { provider: p, model: '' } }); setModelOpen(false) }}>{PROVIDER_LABEL[p]} · default</button>,
                ...(cliModels[p] ?? []).map((m) => (
                  <button key={p + m.id} onClick={() => { saveCurrent({ model: { provider: p, model: m.id } }); setModelOpen(false) }}>{PROVIDER_LABEL[p]} · {m.label}</button>
                ))
              ])}
              {signedIn.length < 3 && <div className="muted" style={{ fontSize: 12 }}>Sign in to more providers on the Accounts page.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
