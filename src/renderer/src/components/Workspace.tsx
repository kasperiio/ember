import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore, set } from '../lib/store'
import { FileTree } from './FileTree'
import { CodeEditor, DiffView } from './Editor'
import { TerminalView } from './TerminalView'
import type { SearchHit } from '../../../shared/types'
import { Icon } from './Icon'

type Tab = { path: string; title: string; dirty?: boolean; diff?: { original: string; tree: string } }

export function Workspace({ root }: { root: string }) {
  const current = useStore((s) => s.current)!
  const terminalRequests = useStore((s) => s.terminalRequests)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [contents, setContents] = useState<Record<string, string>>({})
  const [side, setSide] = useState<'files' | 'search' | 'changes'>('files')
  const [bottom, setBottom] = useState<'terminal' | 'preview' | 'checks'>('terminal')
  const [terms, setTerms] = useState<{ id: string; title: string; cmd?: string }[]>([{ id: 'main', title: 'Terminal' }])
  const [activeTerm, setActiveTerm] = useState('main')
  const [previewUrl, setPreviewUrl] = useState('')
  const [checksLog, setChecksLog] = useState('')
  const [treeKey, setTreeKey] = useState(0)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [changes, setChanges] = useState<{ path: string; status: string }[]>([])
  const contentsRef = useRef(contents)
  contentsRef.current = contents

  const open = useCallback(async (path: string, line?: number) => {
    const title = path.split(/[\\/]/).pop() ?? path
    if (!contentsRef.current[path]) {
      const text = await api.ws.read(path).catch(() => '(binary or unreadable file)')
      setContents((c) => ({ ...c, [path]: text }))
    }
    setTabs((t) => (t.some((x) => x.path === path) ? t : [...t, { path, title }]))
    setActive(path)
    if (line) setTimeout(() => window.dispatchEvent(new CustomEvent('ember:goto', { detail: { path, line } })), 100)
  }, [])

  // watch the workspace for changes made by the AI or externally
  useEffect(() => {
    api.ws.watch(root)
    const off = api.on('ws:changed', async ({ root: r, paths }: { root: string; paths: string[] }) => {
      if (r !== root) return
      setTreeKey((k) => k + 1)
      for (const p of paths) {
        if (contentsRef.current[p] !== undefined) {
          const text = await api.ws.read(p).catch(() => null)
          if (text != null) setContents((c) => ({ ...c, [p]: text }))
        }
      }
    })
    const offUrl = api.on('preview:url', ({ url }: { url: string }) => {
      setPreviewUrl((u) => u || url)
    })
    const offLog = api.on('log', ({ source, text }: { source: string; text: string }) => {
      if (source === 'checks') setChecksLog((l) => (l + text).slice(-20000))
    })
    return () => {
      api.ws.unwatch(root)
      off()
      offUrl()
      offLog()
    }
  }, [root])

  // live file-writing view: open files the AI touches
  useEffect(() => {
    const last = current.messages[current.messages.length - 1]
    const files = last?.toolCalls?.flatMap((t) => t.files ?? []) ?? []
    const f = files[files.length - 1]
    if (f) open(f.includes(':') || f.startsWith('/') ? f : root + '\\' + f)
  }, [current.messages, open, root])

  // terminal requests from the Accounts page (sign-in flows)
  useEffect(() => {
    if (!terminalRequests.length) return
    const reqs = terminalRequests
    set({ terminalRequests: [] })
    setTerms((t) => [...t, ...reqs.map((r) => ({ id: r.id, title: r.title, cmd: r.cmd }))])
    setActiveTerm(reqs[reqs.length - 1].id)
    setBottom('terminal')
  }, [terminalRequests])

  const close = (path: string) => {
    setTabs((t) => t.filter((x) => x.path !== path))
    if (active === path) setActive(tabs.find((x) => x.path !== path)?.path ?? null)
  }

  const save = async (path: string, text: string) => {
    await api.ws.write(path, text)
    setContents((c) => ({ ...c, [path]: text }))
    setTabs((t) => t.map((x) => (x.path === path ? { ...x, dirty: false } : x)))
  }

  const doSearch = async () => {
    if (query.trim()) setHits(await api.ws.search(root, query, false))
  }

  const loadChanges = async () => {
    setSide('changes')
    const cp = [...current.messages].reverse().find((m) => m.checkpoint)?.checkpoint
    const firstCp = current.messages.find((m) => m.checkpoint)?.checkpoint
    const tree = firstCp ?? cp
    if (!tree) return setChanges([])
    setChanges(await api.ws.changedSince(root, tree))
  }

  const openDiff = async (rel: string) => {
    const tree = current.messages.find((m) => m.checkpoint)?.checkpoint
    if (!tree) return
    const original = (await api.ws.fileAt(root, tree, rel)) ?? ''
    const path = root + '\\' + rel.replace(/\//g, '\\')
    const text = await api.ws.read(path).catch(() => '')
    setContents((c) => ({ ...c, [path]: text }))
    setTabs((t) => (t.some((x) => x.path === path) ? t.map((x) => (x.path === path ? { ...x, diff: { original, tree } } : x)) : [...t, { path, title: rel.split('/').pop() ?? rel, diff: { original, tree } }]))
    setActive(path)
  }

  const revertFile = async (rel: string) => {
    const tree = current.messages.find((m) => m.checkpoint)?.checkpoint
    if (!tree) return
    const original = await api.ws.fileAt(root, tree, rel)
    const path = root + '\\' + rel.replace(/\//g, '\\')
    if (original == null) return alert('This file did not exist at the first checkpoint; delete it manually if needed.')
    await save(path, original)
    loadChanges()
  }

  const runChecks = async () => {
    setBottom('checks')
    setChecksLog('')
    const r = await api.ws.runChecks(root)
    setChecksLog((l) => l + '\n' + (r.ok ? 'Checks passed\n' : 'Checks failed\n') + r.output.slice(-4000))
  }

  const activeTab = tabs.find((t) => t.path === active)

  return (
    <div className="workspace">
      <div className="files">
        <div className="tools">
          <button className={side === 'files' ? 'active' : ''} onClick={() => setSide('files')}>Files</button>
          <button className={side === 'search' ? 'active' : ''} onClick={() => setSide('search')}>Search</button>
          <button className={side === 'changes' ? 'active' : ''} onClick={loadChanges}>Changes</button>
        </div>
        {side === 'files' && <FileTree key={treeKey} root={root} selected={active} onOpen={(p) => open(p)} />}
        {side === 'search' && (
          <div className="search-pane">
            <input placeholder="Search in project (Enter)" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
            <div className="hits">
              {hits.map((h, i) => (
                <div key={i} className="hit" title={h.text} onClick={() => open(h.path, h.line)}>
                  <span className="muted">{h.path.slice(root.length + 1)}:{h.line}</span> {h.text.trim()}
                </div>
              ))}
              {query && hits.length === 0 && <div className="muted" style={{ padding: 6 }}>No results.</div>}
            </div>
          </div>
        )}
        {side === 'changes' && (
          <div className="changes scroll">
            <div className="muted" style={{ padding: '6px 8px' }}>Since the first checkpoint of this session</div>
            {changes.map((c) => (
              <div key={c.path} className="f" onClick={() => openDiff(c.path)}>
                <span className={'gs ' + c.status}>{c.status}</span>
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.path}</span>
                <button className="ghost small" title="Revert this file" onClick={(e) => { e.stopPropagation(); revertFile(c.path) }}><Icon name="undo" size={12} /></button>
              </div>
            ))}
            {changes.length === 0 && <div className="muted" style={{ padding: 8 }}>No changes yet.</div>}
            {changes.length > 0 && (
              <div style={{ padding: 8 }}>
                <button className="small" onClick={async () => alert(await api.ws.gitCommit(root, prompt('Commit message', 'Changes made with Ember') || 'Changes made with Ember'))}>Commit all with git</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="editor-area">
        <div className="tabs">
          {tabs.map((t) => (
            <div key={t.path} className={'tab' + (t.path === active ? ' active' : '')} onClick={() => setActive(t.path)} title={t.path}>
              {t.diff ? <Icon name="diff" size={12} /> : null}{t.title}{t.dirty ? ' •' : ''}
              <span className="x" onClick={(e) => { e.stopPropagation(); close(t.path) }}>×</span>
            </div>
          ))}
        </div>
        <div className="pane">
          {activeTab ? (
            activeTab.diff ? (
              <DiffView original={activeTab.diff.original} modified={contents[activeTab.path] ?? ''} path={activeTab.path} />
            ) : (
              <CodeEditor
                path={activeTab.path}
                value={contents[activeTab.path] ?? ''}
                onChange={() => setTabs((t) => t.map((x) => (x.path === activeTab.path ? { ...x, dirty: true } : x)))}
                onSave={(text) => save(activeTab.path, text)}
              />
            )
          ) : (
            <div className="empty">Open a file from the tree, or ask the AI to make a change.</div>
          )}
        </div>
      </div>
      <div className="bottom">
        <div className="tabs">
          {terms.map((t) => (
            <div key={t.id} className={'tab' + (bottom === 'terminal' && activeTerm === t.id ? ' active' : '')} onClick={() => { setBottom('terminal'); setActiveTerm(t.id) }}>
              <Icon name="play" size={11} /> {t.title}
              {t.id !== 'main' && <span className="x" onClick={(e) => { e.stopPropagation(); api.terminal.kill(t.id); setTerms((l) => l.filter((x) => x.id !== t.id)); setActiveTerm('main') }}>×</span>}
            </div>
          ))}
          <div className="tab" onClick={() => { const id = 't' + Date.now(); setTerms((t) => [...t, { id, title: 'Terminal ' + (t.length + 1) }]); setActiveTerm(id); setBottom('terminal') }}>+</div>
          <div className={'tab' + (bottom === 'preview' ? ' active' : '')} onClick={() => setBottom('preview')}><Icon name="globe" size={12} /> Preview</div>
          <div className={'tab' + (bottom === 'checks' ? ' active' : '')} onClick={runChecks}><Icon name="check" size={12} /> Checks</div>
        </div>
        <div className="pane">
          {terms.map((t) => (
            <div key={t.id} style={{ display: bottom === 'terminal' && activeTerm === t.id ? 'block' : 'none', height: '100%' }}>
              <TerminalView id={current.id + ':' + t.id} cwd={root} visible={bottom === 'terminal' && activeTerm === t.id} initialCommand={t.cmd} />
            </div>
          ))}
          {bottom === 'preview' && (
            <div className="preview">
              <div className="url">
                <input className="grow" placeholder="http://localhost:3000 (detected automatically from the terminal)" value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)} />
                <button className="small" onClick={() => setPreviewUrl((u) => u + '')}>Reload</button>
                <button className="small" onClick={() => api.openExternal(previewUrl)}>Open in browser</button>
              </div>
              {previewUrl ? <webview src={previewUrl} style={{ flex: 1 }} /> : <div className="empty">Start a dev server in the terminal; its URL appears here.</div>}
            </div>
          )}
          {bottom === 'checks' && <pre className="log" style={{ height: '100%', maxHeight: 'none', margin: 0, borderRadius: 0 }}>{checksLog || 'Running checks…'}</pre>}
        </div>
      </div>
    </div>
  )
}
