import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Icon } from './Icon'
import type { FileEntry } from '../../../shared/types'

export function FileTree({ root, selected, onOpen }: { root: string; selected: string | null; onOpen: (p: string) => void }) {
  return (
    <div className="tree">
      <Dir root={root} dir={root} depth={0} selected={selected} onOpen={onOpen} openByDefault />
    </div>
  )
}

function Dir({ root, dir, depth, selected, onOpen, openByDefault }: { root: string; dir: string; depth: number; selected: string | null; onOpen: (p: string) => void; openByDefault?: boolean }) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  useEffect(() => {
    api.ws.listDir(root, dir).then(setEntries).catch(() => setEntries([]))
  }, [root, dir])
  if (!entries) return <div className="muted" style={{ paddingLeft: 10 + depth * 14 }}>…</div>
  if (entries.length === 0 && depth === 0) return <div className="muted" style={{ padding: 8 }}>Empty folder. Ask the AI to create something.</div>
  return (
    <>
      {entries.map((e) => (
        <Node key={e.path} e={e} root={root} depth={depth} selected={selected} onOpen={onOpen} open={openByDefault && depth === 0 ? undefined : undefined} />
      ))}
    </>
  )
}

function Node({ e, root, depth, selected, onOpen }: { e: FileEntry; root: string; depth: number; selected: string | null; onOpen: (p: string) => void; open?: boolean }) {
  const [open, setOpen] = useState(false)
  const pad = 8 + depth * 14
  if (e.isDir)
    return (
      <>
        <div className="node" style={{ paddingLeft: pad }} onClick={() => setOpen((o) => !o)}>
          <span style={{ width: 12, display: 'inline-block' }}>{open ? '▾' : '▸'}</span>
          <Icon name="folder" className="ico-muted" />
          <span>{e.name}</span>
          {e.gitStatus && <span className={'gs ' + e.gitStatus}>{e.gitStatus === '?' ? '•' : e.gitStatus}</span>}
        </div>
        {open && <Dir root={root} dir={e.path} depth={depth + 1} selected={selected} onOpen={onOpen} />}
      </>
    )
  return (
    <div className={'node' + (selected === e.path ? ' sel' : '')} style={{ paddingLeft: pad + 14 }} onClick={() => onOpen(e.path)} title={e.path}>
      <Icon name={icon(e.name)} className="ico-muted" />
      <span>{e.name}</span>
      {e.gitStatus && <span className={'gs ' + e.gitStatus}>{e.gitStatus}</span>}
    </div>
  )
}

function icon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return 'file-image'
  if (['md', 'txt', 'json', 'yml', 'yaml', 'toml', 'ini', 'csv', 'lock'].includes(ext)) return 'file-text'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'cs', 'java', 'c', 'cpp', 'h', 'html', 'css', 'scss', 'sh', 'ps1'].includes(ext)) return 'file-code'
  return 'file'
}
