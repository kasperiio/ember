// Embedded terminals (node-pty). Falls back to a plain child process when the native module fails to load.
import { spawn as cpSpawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import { extraPath } from './cli'

type Term = { write: (d: string) => void; resize: (c: number, r: number) => void; kill: () => void }
const terms = new Map<string, Term>()
let win: BrowserWindow | null = null
let pty: typeof import('node-pty') | null = null
try {
  pty = require('node-pty')
} catch {
  pty = null
}

export function bindWindow(w: BrowserWindow): void {
  win = w
}

export function create(id: string, cwd: string, cols = 120, rows = 30, initialCommand?: string): { pty: boolean } {
  kill(id)
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
  const env = { ...process.env, PATH: `${process.env.PATH};${extraPath()}`, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  const send = (data: string) => {
    win?.webContents.send('terminal:data', { id, data })
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'<>]*/.exec(data)
    if (m) win?.webContents.send('preview:url', { id, url: m[0].replace('0.0.0.0', 'localhost') })
  }
  if (pty) {
    const p = pty.spawn(shell, process.platform === 'win32' ? ['-NoLogo'] : [], { name: 'xterm-256color', cols, rows, cwd, env })
    p.onData(send)
    p.onExit(({ exitCode }) => {
      win?.webContents.send('terminal:exit', { id, code: exitCode })
      terms.delete(id)
    })
    terms.set(id, { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), kill: () => p.kill() })
    if (initialCommand) p.write(initialCommand + '\r')
    return { pty: true }
  }
  const p: ChildProcess = cpSpawn(shell, process.platform === 'win32' ? ['-NoLogo'] : [], { cwd, env, windowsHide: true })
  p.stdout?.on('data', (d) => send(d.toString()))
  p.stderr?.on('data', (d) => send(d.toString()))
  p.on('exit', (code) => {
    win?.webContents.send('terminal:exit', { id, code })
    terms.delete(id)
  })
  terms.set(id, { write: (d) => p.stdin?.write(d.replace(/\r/g, '\n')), resize: () => undefined, kill: () => p.kill() })
  if (initialCommand) p.stdin?.write(initialCommand + '\n')
  return { pty: false }
}

export function write(id: string, data: string): void {
  terms.get(id)?.write(data)
}
export function resize(id: string, cols: number, rows: number): void {
  terms.get(id)?.resize(cols, rows)
}
export function kill(id: string): void {
  terms.get(id)?.kill()
  terms.delete(id)
}
export function killAll(): void {
  for (const id of [...terms.keys()]) kill(id)
}
