import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { loader, Editor as MonacoEditor, DiffEditor } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

;(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}
loader.config({ monaco })

const isDark = () => document.documentElement.dataset.theme === 'dark'

function langFor(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', cs: 'csharp',
    html: 'html', css: 'css', scss: 'scss', yml: 'yaml', yaml: 'yaml', toml: 'ini', sh: 'shell', ps1: 'powershell', sql: 'sql', xml: 'xml', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', php: 'php', rb: 'ruby', swift: 'swift', dart: 'dart', lua: 'lua', vue: 'html', svelte: 'html'
  }
  return map[ext]
}

export function CodeEditor({ path, value, onChange, onSave }: { path: string; value: string; onChange: () => void; onSave: (text: string) => void }) {
  const ref = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  useEffect(() => {
    const onGoto = (e: Event) => {
      const { path: p, line } = (e as CustomEvent).detail
      if (p === path && ref.current) {
        ref.current.revealLineInCenter(line)
        ref.current.setPosition({ lineNumber: line, column: 1 })
        ref.current.focus()
      }
    }
    window.addEventListener('ember:goto', onGoto)
    return () => window.removeEventListener('ember:goto', onGoto)
  }, [path])

  return (
    <MonacoEditor
      path={path}
      defaultLanguage={langFor(path)}
      value={value}
      theme={isDark() ? 'vs-dark' : 'light'}
      options={{ fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, renderWhitespace: 'selection' }}
      onChange={() => onChange()}
      onMount={(ed) => {
        ref.current = ed
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current(ed.getValue()))
      }}
    />
  )
}

export function DiffView({ original, modified, path }: { original: string; modified: string; path: string }) {
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={langFor(path)}
      theme={isDark() ? 'vs-dark' : 'light'}
      options={{ readOnly: true, renderSideBySide: true, fontSize: 13, automaticLayout: true, minimap: { enabled: false } }}
    />
  )
}
