import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '../lib/api'

export function TerminalView({ id, cwd, visible, initialCommand }: { id: string; cwd: string; visible: boolean; initialCommand?: string }) {
  const el = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const dark = document.documentElement.dataset.theme === 'dark'
    const t = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      theme: dark ? { background: '#121215', foreground: '#e8e8ec' } : { background: '#f3f3f6', foreground: '#1c1c20', cursor: '#1c1c20' },
      allowProposedApi: true
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(el.current!)
    f.fit()
    term.current = t
    fit.current = f
    api.terminal.create(id, cwd, t.cols, t.rows, initialCommand).then((r) => {
      if (!r.pty) t.writeln('\x1b[33m(node-pty unavailable: running in basic mode, no colours or interactive prompts)\x1b[0m')
    })
    const offData = api.on('terminal:data', ({ id: tid, data }: { id: string; data: string }) => tid === id && t.write(data))
    const offExit = api.on('terminal:exit', ({ id: tid, code }: { id: string; code: number }) => tid === id && t.writeln(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m`))
    const sub = t.onData((d) => api.terminal.write(id, d))
    const ro = new ResizeObserver(() => {
      try {
        f.fit()
        api.terminal.resize(id, t.cols, t.rows)
      } catch {
        // hidden
      }
    })
    ro.observe(el.current!)
    return () => {
      offData()
      offExit()
      sub.dispose()
      ro.disconnect()
      api.terminal.kill(id)
      t.dispose()
    }
  }, [id, cwd])

  useEffect(() => {
    if (visible) setTimeout(() => {
      fit.current?.fit()
      if (term.current) api.terminal.resize(id, term.current.cols, term.current.rows)
    }, 50)
  }, [visible, id])

  return <div className="term" ref={el} />
}
