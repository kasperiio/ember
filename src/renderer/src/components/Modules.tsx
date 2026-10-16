import { useState } from 'react'
import { api } from '../lib/api'
import { useStore, set } from '../lib/store'
import type { AiModule, Effort, PermissionMode, ProviderId } from '../../../shared/types'

const COLORS = ['#e8611a', '#2a9d4b', '#2b7de9', '#9b59b6', '#d58b00', '#e0458a']

export function Modules() {
  const modules = useStore((s) => s.modules)
  const models = useStore((s) => s.models)
  const [edit, setEdit] = useState<AiModule | null>(null)

  const save = async (list: AiModule[]) => {
    await api.modules.save(list)
    set({ modules: list })
  }

  const blank = (): AiModule => ({ id: Math.random().toString(36).slice(2, 10), name: '', instructions: '', color: COLORS[modules.length % COLORS.length] })

  return (
    <div className="page scroll">
      <h1>AI Modules</h1>
      <p className="muted">Named assistants with their own instructions, model, effort and permissions. Switch between them inside one conversation; they all see the same history.</p>
      <button className="primary" onClick={() => setEdit(blank())}>+ New module</button>
      <div className="grid" style={{ marginTop: 14 }}>
        {modules.map((m) => (
          <div key={m.id} className="card" style={{ borderLeft: `4px solid ${m.color}` }}>
            <div className="row"><strong className="grow">{m.name}</strong>
              <button className="ghost small" onClick={() => setEdit(m)}>Edit</button>
              <button className="ghost small danger" onClick={() => confirm('Delete module?') && save(modules.filter((x) => x.id !== m.id))}>Delete</button>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{m.model ? `${m.model.provider} ${m.model.model}` : 'session model'} · {m.effort ?? 'session effort'} · {m.mode ?? 'session mode'}</div>
            <div style={{ fontSize: 12.5, marginTop: 6, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden' }}>{m.instructions}</div>
          </div>
        ))}
        {modules.length === 0 && <div className="muted">Examples: "Reviewer" that only critiques, "Docs writer" with a small fast model, "Architect" on Claude Opus with high effort.</div>}
      </div>
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{modules.some((m) => m.id === edit.id) ? 'Edit module' : 'New module'}</h2>
            <div className="field"><label>Name</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>Instructions</label><textarea rows={6} value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} /></div>
            <div className="field"><label>Model</label>
              <select value={edit.model ? edit.model.provider + '|' + edit.model.model : ''} onChange={(e) => { const [p, m] = e.target.value.split('|'); setEdit({ ...edit, model: e.target.value ? { provider: p as ProviderId, model: m } : undefined }) }}>
                <option value="">Use the session's model</option>
                {models.map((m) => <option key={m.name} value={'ollama|' + m.name}>Local · {m.name}</option>)}
                <option value="claude|">Claude</option><option value="claude|opus">Claude · Opus</option><option value="claude|sonnet">Claude · Sonnet</option>
                <option value="codex|">ChatGPT / Codex</option><option value="gemini|">Google Antigravity</option>
              </select>
            </div>
            <div className="row">
              <div className="field grow"><label>Effort</label>
                <select value={edit.effort ?? ''} onChange={(e) => setEdit({ ...edit, effort: (e.target.value || undefined) as Effort | undefined })}>
                  <option value="">Session</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
              </div>
              <div className="field grow"><label>Permissions</label>
                <select value={edit.mode ?? ''} onChange={(e) => setEdit({ ...edit, mode: (e.target.value || undefined) as PermissionMode | undefined })}>
                  <option value="">Session</option><option value="auto">Auto</option><option value="manual">Manual</option><option value="acceptEdits">Accept edits</option><option value="plan">Plan (read-only)</option><option value="bypass">Bypass</option>
                </select>
              </div>
              <div className="field"><label>Colour</label>
                <div className="row">{COLORS.map((c) => <span key={c} onClick={() => setEdit({ ...edit, color: c })} style={{ width: 18, height: 18, borderRadius: 9, background: c, cursor: 'pointer', outline: edit.color === c ? '2px solid var(--text)' : 'none' }} />)}</div>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary" disabled={!edit.name.trim()} onClick={() => { save(modules.some((m) => m.id === edit.id) ? modules.map((m) => (m.id === edit.id ? edit : m)) : [...modules, edit]); setEdit(null) }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
