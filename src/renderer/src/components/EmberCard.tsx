// Action cards for the AI's `ember-module` / `ember-model` / `ember-mcp` proposals (see src/main/ember.ts).
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { get, patchSession, refreshModels, set, useStore } from '../lib/store'
import { describe, parseMcpJson } from '../lib/mcp'
import type { AiModule, Effort, McpServer, PermissionMode, ProviderId } from '../../../shared/types'
import { Icon } from './Icon'

const COLORS = ['#e8611a', '#2a9d4b', '#2b7de9', '#9b59b6', '#d58b00', '#e0458a']
const PROVIDERS: ProviderId[] = ['ollama', 'claude', 'codex', 'gemini']
const EFFORTS: Effort[] = ['low', 'medium', 'high']
const MODES: PermissionMode[] = ['auto', 'manual', 'acceptEdits', 'plan', 'bypass']

export function EmberCard({ lang, code, streaming }: { lang: string; code: string; streaming: boolean }) {
  let data: any = null
  try {
    data = JSON.parse(code)
  } catch {
    // incomplete while streaming, or malformed
  }
  if (!data || typeof data !== 'object')
    return <div className="ember-card muted">{streaming ? 'Preparing a proposal…' : <><Icon name="warn" /> The AI's {lang === 'ember-module' ? 'module' : 'model'} proposal could not be read.</>}</div>
  return lang === 'ember-module' ? <ModuleCard p={data} /> : lang === 'ember-mcp' ? <McpCard p={data} /> : <ModelCard p={data} />
}

function McpCard({ p }: { p: any }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  useEffect(() => {
    api.mcp.list().then(setServers)
  }, [])
  const parsed = (() => {
    try {
      return parseMcpJson(JSON.stringify(p))[0]
    } catch {
      return undefined
    }
  })()
  if (!parsed) return <div className="ember-card muted"><Icon name="warn" /> The MCP server proposal needs a name and a command or URL.</div>
  // Secrets the user still has to fill in ("<your token>"): add it disabled and open the page.
  const placeholders = Object.values({ ...parsed.env, ...parsed.headers }).some((v) => /<[^>]+>/.test(v))
  const existing = servers?.find((s) => s.name.toLowerCase() === parsed.name.toLowerCase())
  const added = existing && describe(existing) === describe(parsed)

  const add = async () => {
    const s = { ...parsed, id: existing?.id ?? parsed.id, enabled: !placeholders }
    const list = existing ? servers!.map((x) => (x.id === existing.id ? s : x)) : [...(servers ?? []), s]
    await api.mcp.save(list)
    setServers(list)
    if (placeholders) set({ page: 'mcp' })
  }

  return (
    <div className="ember-card">
      <div className="row">
        <Icon name="plug" />
        <strong className="grow">{added ? '' : existing ? 'Update ' : 'Add '}MCP server: {parsed.name}</strong>
        {added ? (
          <><span className="badge ok"><Icon name="check" size={11} /> added</span><button className="small" onClick={() => set({ page: 'mcp' })}>Open MCP servers</button></>
        ) : (
          <button className="small primary" disabled={!servers} onClick={add}>{placeholders ? 'Add and fill in…' : existing ? 'Update server' : 'Add server'}</button>
        )}
      </div>
      <div className="mono muted" style={{ fontSize: 12 }}>{describe(parsed)}</div>
      {placeholders && !added && <div className="muted" style={{ fontSize: 12 }}>Needs your own values for: {Object.entries({ ...parsed.env, ...parsed.headers }).filter(([, v]) => /<[^>]+>/.test(v)).map(([k]) => k).join(', ')}</div>}
    </div>
  )
}

function ModuleCard({ p }: { p: any }) {
  const modules = useStore((s) => s.modules)
  const name = String(p.name ?? '').trim()
  const instructions = String(p.instructions ?? '').trim()
  const model = p.model && PROVIDERS.includes(p.model.provider) ? { provider: p.model.provider as ProviderId, model: String(p.model.model ?? '') } : undefined
  const effort = EFFORTS.includes(p.effort) ? (p.effort as Effort) : undefined
  const mode = MODES.includes(p.mode) ? (p.mode as PermissionMode) : undefined
  if (!name || !instructions) return <div className="ember-card muted"><Icon name="warn" /> The module proposal needs a name and instructions.</div>

  const existing = modules.find((m) => m.name.trim().toLowerCase() === name.toLowerCase())
  const saved = existing && existing.instructions === instructions && JSON.stringify(existing.model) === JSON.stringify(model) && existing.effort === effort && existing.mode === mode

  const save = async () => {
    const mod: AiModule = { id: existing?.id ?? Math.random().toString(36).slice(2, 10), color: existing?.color ?? COLORS[modules.length % COLORS.length], name, instructions, model, effort, mode }
    const list = existing ? modules.map((m) => (m.id === existing.id ? mod : m)) : [...modules, mod]
    await api.modules.save(list)
    set({ modules: list })
  }

  return (
    <div className="ember-card" style={{ borderLeftColor: existing?.color ?? 'var(--accent)' }}>
      <div className="row">
        <Icon name="puzzle" />
        <strong className="grow">{saved ? '' : existing ? 'Update ' : 'New '}AI Module: {name}</strong>
        {saved ? (
          <><span className="badge ok"><Icon name="check" size={11} /> saved</span><button className="small" onClick={() => set({ page: 'modules' })}>Open Modules</button></>
        ) : (
          <button className="small primary" onClick={save}>{existing ? 'Update module' : 'Create module'}</button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{model ? `${model.provider}${model.model ? ' ' + model.model : ''}` : 'session model'} · {effort ?? 'session effort'} · {mode ?? 'session mode'}</div>
      <details>
        <summary className="muted" style={{ fontSize: 12 }}>Instructions</summary>
        <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{instructions}</div>
      </details>
    </div>
  )
}

type Pull = { status: string; completed?: number; total?: number; done?: boolean; error?: string }

function ModelCard({ p }: { p: any }) {
  const tag = String(p.tag ?? '').trim()
  const models = useStore((s) => s.models)
  const ollamaOk = useStore((s) => s.ollamaOk)
  const current = useStore((s) => s.current)
  const [pull, setPull] = useState<Pull | null>(null)

  useEffect(
    () =>
      api.on('ollama:pull-progress', (ev: Pull & { name: string }) => {
        if (ev.name !== tag) return
        setPull(ev)
        if (ev.done) refreshModels()
      }),
    [tag]
  )
  if (!tag) return <div className="ember-card muted"><Icon name="warn" /> The model proposal has no tag.</div>

  const full = tag.includes(':') ? tag : tag + ':latest'
  const installed = models.some((m) => m.name === full)
  const inUse = current?.model.provider === 'ollama' && current.model.model === full
  const pulling = pull && !pull.done
  const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null

  const download = () => {
    setPull({ status: 'starting' })
    api.ollama.pull(tag)
  }

  return (
    <div className="ember-card">
      <div className="row">
        <Icon name="bot" />
        <strong className="grow mono">{tag}</strong>
        {installed ? (
          <>
            <span className="badge ok"><Icon name="check" size={11} /> installed</span>
            {current && !inUse && <button className="small" onClick={() => patchSession(get().current!.id, { model: { provider: 'ollama', model: full } })}>Use in this chat</button>}
          </>
        ) : pulling ? (
          <><span className="muted" style={{ fontSize: 12 }}>{pull.status}{pct != null ? ` ${pct}%` : ''}</span><button className="small" onClick={() => api.ollama.cancelPull(tag)}>Cancel</button></>
        ) : !ollamaOk ? (
          <button className="small" onClick={() => set({ page: 'discover' })}>Set up Ollama</button>
        ) : (
          <button className="small primary" onClick={download}>Download</button>
        )}
      </div>
      {p.reason && <div className="muted" style={{ fontSize: 12 }}>{String(p.reason)}</div>}
      {pull?.error && <div className="err" style={{ fontSize: 12 }}><Icon name="warn" /> {pull.error}</div>}
    </div>
  )
}
