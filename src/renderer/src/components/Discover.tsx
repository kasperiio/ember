import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore, refreshModels, set } from '../lib/store'
import type { Hardware, ModelRecommendation } from '../../../shared/types'

type Pull = { status: string; completed?: number; total?: number; done?: boolean; error?: string }

export function Discover() {
  const models = useStore((s) => s.models)
  const running = useStore((s) => s.running)
  const ollamaOk = useStore((s) => s.ollamaOk)
  const settings = useStore((s) => s.settings)
  const [hw, setHw] = useState<Hardware | null>(null)
  const [recs, setRecs] = useState<ModelRecommendation[]>([])
  const [pulls, setPulls] = useState<Record<string, Pull>>({})
  const [custom, setCustom] = useState('')
  const [installLog, setInstallLog] = useState('')

  useEffect(() => {
    api.hardware.recommend().then((r) => {
      setHw(r.hardware)
      setRecs(r.recommendations)
    })
    const off = api.on('ollama:pull-progress', (p: Pull & { name: string }) => {
      setPulls((s) => ({ ...s, [p.name]: p }))
      if (p.done) {
        refreshModels()
        if (!p.error) {
          api.settings.get().then((st) => {
            if (!st.defaultModel.model) api.settings.set({ defaultModel: { provider: 'ollama', model: p.name } }).then((s) => set({ settings: s }))
          })
        }
      }
    })
    const offLog = api.on('log', ({ source, text }: { source: string; text: string }) => source === 'ollama-install' && setInstallLog((l) => l + text))
    return () => {
      off()
      offLog()
    }
  }, [])

  const pull = (tag: string) => {
    setPulls((s) => ({ ...s, [tag]: { status: 'starting' } }))
    api.ollama.pull(tag)
  }

  const installOllama = async () => {
    setInstallLog('Starting…\n')
    const ok = await api.ollama.install()
    setInstallLog((l) => l + (ok ? '\nInstalled. Start Ollama from the Start menu if it is not running yet.' : '\nInstall failed.'))
    setTimeout(refreshModels, 3000)
  }

  const fitsLabel = { gpu: 'Fits your GPU', ram: 'CPU only (slow)', no: 'Too big' }

  return (
    <div className="page scroll">
      <h1>Discover local models</h1>
      <p className="muted">Free models that run on your own hardware through Ollama. Nothing leaves your PC.</p>

      <div className="card">
        <div className="row">
          <strong>Your PC</strong>
          <span className="grow" />
          <span className={'badge ' + (ollamaOk ? 'ok' : 'err')}>{ollamaOk ? 'Ollama running' : 'Ollama not detected'}</span>
        </div>
        {hw ? (
          <div className="muted" style={{ marginTop: 6 }}>
            {hw.cpu} · {hw.cores} threads · {hw.ramGb} GB RAM
            {hw.gpus.map((g) => <span key={g.name}> · {g.name} ({g.vramGb} GB{g.vendor !== 'nvidia' ? ', ' + g.vendor : ''})</span>)}
            {hw.gpus.length === 0 && ' · no discrete GPU detected'}
          </div>
        ) : <div className="muted">Scanning hardware…</div>}
        {!ollamaOk && (
          <div style={{ marginTop: 10 }}>
            <p>Ember needs Ollama to run local models. One click installs it with winget.</p>
            <div className="row">
              <button className="primary" onClick={installOllama}>Install Ollama</button>
              <button onClick={() => api.openExternal('https://ollama.com/download')}>Download manually</button>
              <button onClick={refreshModels}>Re-check</button>
              <span className="muted">Host: {settings?.ollamaHost}</span>
            </div>
            {installLog && <pre className="log" style={{ marginTop: 8 }}>{installLog}</pre>}
          </div>
        )}
      </div>

      {models.length > 0 && (
        <>
          <h2>Installed</h2>
          <div className="grid">
            {models.map((m) => {
              const r = running.find((x) => x.name === m.name)
              return (
                <div key={m.name} className="card">
                  <div className="row">
                    <strong className="grow">{m.name}</strong>
                    {r && <span className="badge accent">loaded</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{(m.size / 1024 ** 3).toFixed(1)} GB · {m.parameterSize ?? ''} {m.quantization ?? ''} {m.family ? '· ' + m.family : ''}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="small" onClick={() => api.settings.set({ defaultModel: { provider: 'ollama', model: m.name } }).then((s) => set({ settings: s }))} disabled={settings?.defaultModel.model === m.name}>
                      {settings?.defaultModel.model === m.name ? 'Default' : 'Make default'}
                    </button>
                    {r && <button className="small" onClick={() => api.ollama.unload(m.name).then(refreshModels)}>Unload</button>}
                    <button className="small danger" onClick={() => confirm(`Delete ${m.name}?`) && api.ollama.delete(m.name).then(refreshModels)}>Delete</button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <h2>Recommended for this PC</h2>
      <div className="grid">
        {recs.map((r) => {
          const p = pulls[r.tag]
          const installed = models.some((m) => m.name === r.tag || m.name === r.tag + ':latest')
          const pct = p?.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : 0
          return (
            <div key={r.tag} className="card" style={{ opacity: r.fits === 'no' ? 0.6 : 1 }}>
              <div className="row">
                <strong className="grow">{r.name.replace(' (installed)', '')}</strong>
                <span className={'badge ' + (r.fits === 'gpu' ? 'ok' : r.fits === 'ram' ? 'warn' : 'err')}>{fitsLabel[r.fits]}</span>
              </div>
              <div className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
                {r.sizeGb} GB download · {[r.tools && 'tools', r.vision && 'vision', r.thinking && 'thinking'].filter(Boolean).join(' · ') || 'chat'}
              </div>
              <div style={{ fontSize: 12.5 }}>{r.why}</div>
              <div style={{ marginTop: 8 }}>
                {installed ? (
                  <span className="badge ok">Installed</span>
                ) : p && !p.done ? (
                  <div className="col" style={{ gap: 4 }}>
                    <div className="progress"><i style={{ width: pct + '%' }} /></div>
                    <div className="row muted" style={{ fontSize: 11.5 }}>
                      <span className="grow">{p.status} {p.total ? `${pct}%` : ''}</span>
                      <button className="ghost small" onClick={() => api.ollama.cancelPull(r.tag)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    <button className="small primary" onClick={() => pull(r.tag)} disabled={!ollamaOk}>Install</button>
                    {p?.error && <span className="muted" style={{ fontSize: 11.5, color: 'var(--danger)' }}>{p.error}</span>}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <h2>Any other model</h2>
      <div className="row">
        <input className="grow" placeholder="e.g. qwen2.5-coder:7b  (any tag from ollama.com/library)" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && custom && pull(custom)} />
        <button onClick={() => custom && pull(custom)} disabled={!ollamaOk}>Install</button>
        <button onClick={() => api.openExternal('https://ollama.com/library')}>Browse library</button>
      </div>
      {Object.entries(pulls).filter(([tag]) => !recs.some((r) => r.tag === tag)).map(([tag, p]) => (
        <div key={tag} className="card" style={{ marginTop: 8 }}>
          <div className="row"><strong className="grow">{tag}</strong><span className="muted">{p.status} {p.error ?? ''}</span></div>
          {!p.done && <div className="progress" style={{ marginTop: 6 }}><i style={{ width: (p.total ? ((p.completed ?? 0) / p.total) * 100 : 0) + '%' }} /></div>}
        </div>
      ))}
    </div>
  )
}
