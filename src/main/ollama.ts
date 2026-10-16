import { getSettings } from './store'
import type { OllamaModel, OllamaRunning } from '../shared/types'

const host = () => getSettings().ollamaHost.replace(/\/$/, '')

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(host() + path, init)
  if (!res.ok) throw new Error(`Ollama ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}

export async function ollamaAvailable(): Promise<{ ok: boolean; version?: string }> {
  try {
    const r = await api<{ version: string }>('/api/version')
    return { ok: true, version: r.version }
  } catch {
    return { ok: false }
  }
}

export async function listModels(): Promise<OllamaModel[]> {
  const r = await api<{ models: any[] }>('/api/tags')
  return (r.models ?? []).map((m) => ({
    name: m.name,
    size: m.size,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    family: m.details?.family,
    modifiedAt: m.modified_at
  }))
}

export async function showModel(name: string): Promise<{ capabilities: string[]; contextLength?: number }> {
  const r = await api<any>('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) })
  const info = r.model_info ?? {}
  const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'))
  return { capabilities: r.capabilities ?? [], contextLength: ctxKey ? info[ctxKey] : undefined }
}

export async function running(): Promise<OllamaRunning[]> {
  const r = await api<{ models: any[] }>('/api/ps')
  return (r.models ?? []).map((m) => ({ name: m.name, sizeVram: m.size_vram, size: m.size, expiresAt: m.expires_at }))
}

export async function unload(name: string): Promise<void> {
  await api('/api/generate', { method: 'POST', body: JSON.stringify({ model: name, keep_alive: 0 }) })
}

export async function unloadAll(): Promise<void> {
  try {
    for (const m of await running()) await unload(m.name)
  } catch {
    // ollama not running
  }
}

export async function deleteModel(name: string): Promise<void> {
  await api('/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) })
}

export type PullProgress = { status: string; completed?: number; total?: number; done?: boolean; error?: string }

const activePulls = new Map<string, AbortController>()

export async function pull(name: string, onProgress: (p: PullProgress) => void): Promise<void> {
  const ac = new AbortController()
  activePulls.set(name, ac)
  try {
    const res = await fetch(host() + '/api/pull', {
      method: 'POST',
      body: JSON.stringify({ model: name, stream: true }),
      signal: ac.signal
    })
    if (!res.ok || !res.body) throw new Error(`pull failed: ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (j.error) onProgress({ status: 'error', error: j.error, done: true })
          else onProgress({ status: j.status, completed: j.completed, total: j.total })
        } catch {
          // ignore partial line
        }
      }
    }
    onProgress({ status: 'success', done: true })
  } catch (e: any) {
    onProgress({ status: 'error', error: ac.signal.aborted ? 'cancelled' : String(e?.message ?? e), done: true })
  } finally {
    activePulls.delete(name)
  }
}

export function cancelPull(name: string): void {
  activePulls.get(name)?.abort()
}
