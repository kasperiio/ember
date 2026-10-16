import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { describe, parseMcpJson } from '../lib/mcp'
import type { McpServer, McpTestResult } from '../../../shared/types'
import { Icon } from './Icon'

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
const pairs = (s: string, sep: string) =>
  Object.fromEntries(lines(s).filter((l) => l.includes(sep)).map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + sep.length).trim()]))
const unpairs = (m: Record<string, string> | undefined, sep: string) => Object.entries(m ?? {}).map(([k, v]) => k + sep + v).join('\n')

type Draft = McpServer & { argsText: string; envText: string; headersText: string }
const toDraft = (s: McpServer): Draft => ({ ...s, argsText: (s.args ?? []).join('\n'), envText: unpairs(s.env, '='), headersText: unpairs(s.headers, ': ') })
const fromDraft = ({ argsText, envText, headersText, ...s }: Draft): McpServer =>
  s.transport === 'http'
    ? { id: s.id, name: s.name.trim(), enabled: s.enabled, transport: 'http', url: s.url?.trim(), headers: pairs(headersText, ':') }
    : { id: s.id, name: s.name.trim(), enabled: s.enabled, transport: 'stdio', command: s.command?.trim(), args: lines(argsText), env: pairs(envText, '=') }

export function McpServers() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [edit, setEdit] = useState<Draft | null>(null)
  const [importText, setImportText] = useState<string | null>(null)
  const [importError, setImportError] = useState('')
  const [tests, setTests] = useState<Record<string, McpTestResult | 'running'>>({})

  useEffect(() => {
    api.mcp.list().then(setServers)
  }, [])

  const save = async (list: McpServer[]) => {
    await api.mcp.save(list)
    setServers(list)
  }
  const test = async (s: McpServer) => {
    setTests((t) => ({ ...t, [s.id]: 'running' }))
    const r = await api.mcp.test(s)
    setTests((t) => ({ ...t, [s.id]: r }))
  }
  const blank = (): Draft => toDraft({ id: Math.random().toString(36).slice(2, 10), name: '', enabled: true, transport: 'stdio', command: '' })
  const doImport = () => {
    try {
      const found = parseMcpJson(importText ?? '')
      if (!found.length) return setImportError('No servers found in that JSON.')
      // same name replaces the existing server
      const names = new Set(found.map((s) => s.name.toLowerCase()))
      save([...servers.filter((s) => !names.has(s.name.toLowerCase())), ...found])
      setImportText(null)
    } catch (e: any) {
      setImportError(e.message)
    }
  }
  const draftOk = edit && edit.name.trim() && (edit.transport === 'http' ? edit.url?.trim() : edit.command?.trim())

  return (
    <div className="page scroll">
      <h1>MCP servers</h1>
      <p className="muted">
        Give the AI extra tools (GitHub, databases, browsers, your own scripts) through the Model Context Protocol. Add a server once and every provider gets it: Claude, ChatGPT / Codex,
        Antigravity and local models. Tool calls ask for approval like any other action unless the session is in Bypass mode.
      </p>
      <div className="row">
        <button className="primary" onClick={() => setEdit(blank())}>+ Add server</button>
        <button onClick={() => { setImportError(''); setImportText('') }}>Import JSON…</button>
      </div>
      <div className="col" style={{ marginTop: 14 }}>
        {servers.map((s) => {
          const t = tests[s.id]
          return (
            <div key={s.id} className="card">
              <div className="row">
                <input type="checkbox" checked={s.enabled} title={s.enabled ? 'Enabled' : 'Disabled'} onChange={(e) => save(servers.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))} />
                <strong>{s.name}</strong>
                <span className="badge">{s.transport === 'http' ? 'HTTP' : 'local'}</span>
                <span className="mono muted grow" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describe(s)}</span>
                <button className="ghost small" onClick={() => test(s)} disabled={t === 'running'}>{t === 'running' ? 'Testing…' : 'Test'}</button>
                <button className="ghost small" onClick={() => setEdit(toDraft(s))}>Edit</button>
                <button className="ghost small danger" onClick={() => confirm(`Remove ${s.name}?`) && save(servers.filter((x) => x.id !== s.id))}>Delete</button>
              </div>
              {t && t !== 'running' && (
                t.ok ? (
                  <div style={{ fontSize: 12.5, marginTop: 6 }}>
                    <span className="badge ok"><Icon name="check" size={11} /> connected</span> {t.tools.length} tool{t.tools.length === 1 ? '' : 's'}:{' '}
                    <span className="mono muted">{t.tools.map((x) => x.name).join(', ') || 'none'}</span>
                  </div>
                ) : (
                  <div className="err" style={{ fontSize: 12.5, marginTop: 6 }}><Icon name="warn" /> {t.error}</div>
                )
              )}
            </div>
          )
        })}
        {servers.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            No servers yet. Paste a config from a server's README with Import JSON, or ask the AI in a chat to set one up. Servers started with <span className="mono">npx</span> or <span className="mono">uvx</span> need Node.js or uv installed.
          </div>
        )}
      </div>

      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{servers.some((s) => s.id === edit.id) ? 'Edit server' : 'Add server'}</h2>
            <div className="row">
              <div className="field grow"><label>Name</label><input value={edit.name} placeholder="github" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div className="field"><label>Type</label>
                <select value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as McpServer['transport'] })}>
                  <option value="stdio">Local command</option><option value="http">Remote URL</option>
                </select>
              </div>
            </div>
            {edit.transport === 'stdio' ? (
              <>
                <div className="field"><label>Command</label><input className="mono" value={edit.command ?? ''} placeholder="npx" onChange={(e) => setEdit({ ...edit, command: e.target.value })} /></div>
                <div className="field"><label>Arguments (one per line)</label><textarea className="mono" rows={3} value={edit.argsText} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents'} onChange={(e) => setEdit({ ...edit, argsText: e.target.value })} /></div>
                <div className="field"><label>Environment (KEY=value per line)</label><textarea className="mono" rows={2} value={edit.envText} onChange={(e) => setEdit({ ...edit, envText: e.target.value })} /></div>
              </>
            ) : (
              <>
                <div className="field"><label>URL</label><input className="mono" value={edit.url ?? ''} placeholder="https://example.com/mcp" onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></div>
                <div className="field"><label>Headers (Key: value per line)</label><textarea className="mono" rows={2} value={edit.headersText} placeholder="Authorization: Bearer …" onChange={(e) => setEdit({ ...edit, headersText: e.target.value })} /></div>
              </>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary" disabled={!draftOk} onClick={() => { const s = fromDraft(edit); save(servers.some((x) => x.id === s.id) ? servers.map((x) => (x.id === s.id ? s : x)) : [...servers, s]); setEdit(null); test(s) }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {importText != null && (
        <div className="modal-bg" onClick={() => setImportText(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Import MCP servers</h2>
            <p className="muted" style={{ fontSize: 12.5 }}>Paste an <span className="mono">"mcpServers"</span> block as found in server READMEs (Claude Desktop, Cursor and VS Code formats work).</p>
            <textarea className="mono" rows={10} style={{ width: '100%' }} value={importText} placeholder={'{\n  "mcpServers": {\n    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }\n  }\n}'} onChange={(e) => setImportText(e.target.value)} />
            {importError && <div className="err" style={{ fontSize: 12.5 }}><Icon name="warn" /> {importError}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <button onClick={() => setImportText(null)}>Cancel</button>
              <button className="primary" disabled={!importText.trim()} onClick={doImport}>Import</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
