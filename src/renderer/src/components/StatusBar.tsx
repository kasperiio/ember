import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore, refreshModels } from '../lib/store'
import type { Hardware } from '../../../shared/types'
import { Icon } from './Icon'

export function StatusBar() {
  const running = useStore((s) => s.running)
  const ollamaOk = useStore((s) => s.ollamaOk)
  const current = useStore((s) => s.current)
  const status = useStore((s) => s.status)
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
      <span className="grow" />
      {current && status[current.id] && <span>{status[current.id]}</span>}
    </div>
  )
}
