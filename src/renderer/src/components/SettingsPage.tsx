import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore, set, refreshModels } from '../lib/store'
import type { Settings, ProviderId } from '../../../shared/types'

export function SettingsPage() {
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const [info, setInfo] = useState<{ version: string; userData: string } | null>(null)
  useEffect(() => {
    api.app.info().then(setInfo)
  }, [])
  if (!settings) return null

  const upd = async (p: Partial<Settings>) => {
    const s = await api.settings.set(p)
    set({ settings: s })
    if (p.ollamaHost !== undefined) refreshModels()
  }

  return (
    <div className="page scroll">
      <h1>Settings</h1>
      <h2>You</h2>
      <div className="field inline"><label>Display name (shown to friends in shared sessions)</label><input value={settings.displayName} onChange={(e) => upd({ displayName: e.target.value })} style={{ width: 220 }} /></div>
      <h2>Appearance</h2>
      <div className="field inline"><label>Theme</label>
        <select value={settings.theme} onChange={(e) => upd({ theme: e.target.value as Settings['theme'] })}>
          <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
        </select>
      </div>
      <h2>Defaults for new sessions</h2>
      <div className="field inline"><label>Model</label>
        <select value={settings.defaultModel.provider + '|' + settings.defaultModel.model} onChange={(e) => { const [p, m] = e.target.value.split('|'); upd({ defaultModel: { provider: p as ProviderId, model: m } }) }}>
          <option value="ollama|">Local (pick later)</option>
          {models.map((m) => <option key={m.name} value={'ollama|' + m.name}>Local · {m.name}</option>)}
          <option value="claude|">Claude</option><option value="codex|">ChatGPT / Codex</option><option value="gemini|">Google Antigravity</option>
        </select>
      </div>
      <div className="field inline"><label>Permission mode</label>
        <select value={settings.defaultMode} onChange={(e) => upd({ defaultMode: e.target.value as Settings['defaultMode'] })}>
          <option value="auto">Auto</option><option value="manual">Manual</option><option value="acceptEdits">Accept edits</option><option value="plan">Plan</option><option value="bypass">Bypass</option>
        </select>
      </div>
      <div className="field inline"><label>Effort</label>
        <select value={settings.defaultEffort} onChange={(e) => upd({ defaultEffort: e.target.value as Settings['defaultEffort'] })}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
      </div>
      <h2>Coding</h2>
      <div className="field inline"><label>Self-check after the AI edits files (compile / test, feed errors back)</label><input type="checkbox" checked={settings.selfCheck} onChange={(e) => upd({ selfCheck: e.target.checked })} /></div>
      <div className="field inline"><label>Self-check retries</label><input type="number" min={1} max={10} value={settings.selfCheckRetries} onChange={(e) => upd({ selfCheckRetries: Math.max(1, Math.min(10, +e.target.value)) })} style={{ width: 70 }} /></div>
      <div className="field inline"><label>Scratch projects folder</label>
        <div className="row"><span className="mono muted" style={{ fontSize: 12 }}>{settings.scratchRoot}</span><button className="small" onClick={async () => { const f = await api.ws.pickFolder(); if (f) upd({ scratchRoot: f }) }}>Change</button></div>
      </div>
      <h2>Internet research</h2>
      <div className="field inline"><label>Let local models search the web (only scrubbed search terms leave the PC)</label><input type="checkbox" checked={settings.webSearch} onChange={(e) => upd({ webSearch: e.target.checked })} /></div>
      <h2>Local models</h2>
      <div className="field inline"><label>Ollama host (local or remote server)</label><input value={settings.ollamaHost} onChange={(e) => upd({ ollamaHost: e.target.value })} style={{ width: 260 }} /></div>
      <div className="field inline"><label>Free GPU memory when Ember closes</label><input type="checkbox" checked={settings.unloadOnClose} onChange={(e) => upd({ unloadOnClose: e.target.checked })} /></div>
      <h2>Window</h2>
      <div className="field inline"><label>Keep running in the system tray when the window closes</label><input type="checkbox" checked={settings.keepInTray} onChange={(e) => upd({ keepInTray: e.target.checked })} /></div>
      <h2>About</h2>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Ember {info?.version} · data in <span className="mono">{info?.userData}</span>
        <div style={{ marginTop: 8 }}><button className="small danger" onClick={() => api.app.quit()}>Quit Ember</button></div>
      </div>
    </div>
  )
}
