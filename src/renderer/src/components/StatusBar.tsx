import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore, refreshModels } from '../lib/store'
import type { Hardware, ProviderUsage } from '../../../shared/types'
import { Icon } from './Icon'

const PROVIDER_SHORT: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Antigravity', ollama: 'Local' }

export function resetLabel(ms?: number): string {
  if (!ms) return ''
  const diff = ms - Date.now()
  if (diff <= 0) return 'reset'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h >= 48) return `resets in ${Math.round(h / 24)} d`
  return h > 0 ? `resets in ${h} h ${m} m` : `resets in ${m} m`
}

/** Compact "Claude 65% · wk 63%" chip with a tooltip listing every window and its reset time. */
function UsageChip({ u }: { u: ProviderUsage }) {
  const parts = u.windows.filter((w) => w.utilization != null)
  if (!parts.length && u.status === 'ok') return null
  // The chip shows the fullest window (the one that will bite first); the tooltip lists them all.
  const top = [...parts].sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0]
  const text = top ? `${top.label} ${top.utilization}%${parts.length > 1 ? ` (+${parts.length - 1})` : ''}` : ''
  const title = [`${PROVIDER_SHORT[u.provider] ?? u.provider}${u.plan ? ' · ' + u.plan : ''}`, ...u.windows.map((w) => `${w.label}: ${w.utilization != null ? w.utilization + '% used' : w.status}${w.resetsAt ? ', ' + resetLabel(w.resetsAt) : ''}`)].join('\n')
  const cls = u.status === 'limited' ? 'ico-err' : u.status === 'warning' ? 'ico-warn' : ''
  return (
    <span className={'usage ' + cls} title={title}>
      {PROVIDER_SHORT[u.provider] ?? u.provider} {u.status === 'limited' ? 'limit reached' : text}
      {top && <span className="meter"><i style={{ width: `${Math.min(100, top.utilization ?? 0)}%`, background: u.status === 'ok' ? undefined : 'var(--warn)' }} /></span>}
    </span>
  )
}

export function StatusBar() {
  const running = useStore((s) => s.running)
  const ollamaOk = useStore((s) => s.ollamaOk)
  const current = useStore((s) => s.current)
  const status = useStore((s) => s.status)
  const usage = useStore((s) => s.usage)
  const [hw, setHw] = useState<Hardware | null>(null)

  useEffect(() => {
    const tick = () => api.hardware.scan().then(setHw).catch(() => undefined)
    tick()
    const t = setInterval(tick, 10000)
    return () => clearInterval(t)
  }, [])

  const gpu = hw?.gpus[0]
  const loadedGb = running.reduce((a, m) => a + m.sizeVram, 0) / 1024 ** 3
  return (
    <div className="statusbar">
      <span><i className={'dot' + (ollamaOk ? '' : ' off')} />{ollamaOk ? 'Ollama' : 'Ollama offline'}</span>
      {gpu && (
        <span title={`${gpu.name}: ${gpu.usedGb} / ${gpu.vramGb} GB used`}>
          GPU <span className="meter"><i style={{ width: `${Math.min(100, (gpu.usedGb / Math.max(1, gpu.vramGb)) * 100)}%` }} /></span> {gpu.usedGb}/{gpu.vramGb} GB
        </span>
      )}
      {running.map((m) => (
        <span key={m.name} className="row" style={{ gap: 4 }}>
          {m.name} ({(m.sizeVram / 1024 ** 3).toFixed(1)} GB)
          <button className="ghost small" title="Unload from GPU memory" onClick={() => api.ollama.unload(m.name).then(refreshModels)}><Icon name="eject" size={12} /></button>
        </span>
      ))}
      {running.length > 1 && <span className="muted">{loadedGb.toFixed(1)} GB loaded</span>}
      {usage.map((u) => (
        <UsageChip key={u.provider} u={u} />
      ))}
      <span className="grow" />
      {current && status[current.id] && <span>{status[current.id]}</span>}
    </div>
  )
}
