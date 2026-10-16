// File/command backends used by the local-model agent: a direct one for the host's own workspace
// and a remote one that forwards every call to the host of a shared session (who approves edits and commands).
import { promises as fs } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import * as ws from './workspace'
import { runCommand } from './checks'

export interface ToolBackend {
  /** Human-readable root shown to the model. */
  root: string
  readFile(path: string, startLine?: number, endLine?: number): Promise<string>
  listDir(path: string): Promise<string>
  search(pattern: string, max: number): Promise<string>
  /** Resolves to a result string; "Denied..." or "Error..." strings signal failure. */
  writeFile(path: string, content: string): Promise<string>
  editFile(path: string, oldText: string, newText: string): Promise<string>
  runCommand(command: string, timeoutSeconds: number): Promise<string>
}

export type Gate = (kind: 'edit' | 'command', title: string, detail: string, diff?: string) => Promise<string | null>

export function localBackend(root: string, gate: Gate, onFileChanged: (abs: string) => void): ToolBackend {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p))
  const inside = (p: string) => {
    const rel = relative(root, abs(p))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  return {
    root,
    async readFile(path, startLine, endLine) {
      try {
        const text = await fs.readFile(abs(path), 'utf8')
        const lines = text.split('\n')
        const s = Math.max(0, (startLine ?? 1) - 1)
        const e = Math.min(lines.length, endLine ?? lines.length)
        return lines
          .slice(s, e)
          .map((l, i) => `${s + i + 1}| ${l}`)
          .join('\n')
          .slice(0, 60000)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
    async listDir(path) {
      try {
        const entries = await ws.listDir(root, abs(path))
        return entries.map((e) => (e.isDir ? e.name + '/' : e.name)).join('\n') || '(empty)'
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
    async search(pattern, max) {
      const hits = await ws.search(root, pattern, { regex: true, limit: max })
      return hits.map((h) => `${relative(root, h.path)}:${h.line}: ${h.text}`).join('\n') || 'No matches.'
    },
    async writeFile(path, content) {
      if (!inside(path)) return 'Error: path is outside the workspace.'
      const file = abs(path)
      let old = ''
      try {
        old = await fs.readFile(file, 'utf8')
      } catch {
        // new file
      }
      const denied = await gate('edit', `Write ${relative(root, file)}`, `${content.length} chars`, old ? `--- old\n${old.slice(0, 3000)}\n+++ new\n${content.slice(0, 3000)}` : `+++ new\n${content.slice(0, 4000)}`)
      if (denied) return denied
      await ws.writeFile(file, content)
      onFileChanged(file)
      return `Wrote ${relative(root, file)} (${content.split('\n').length} lines).`
    },
    async editFile(path, oldText, newText) {
      if (!inside(path)) return 'Error: path is outside the workspace.'
      const file = abs(path)
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch (e: any) {
        return `Error: ${e.message}`
      }
      const count = text.split(oldText).length - 1
      if (count === 0) return 'Error: old_text not found. Read the file again and copy the text exactly.'
      if (count > 1) return `Error: old_text appears ${count} times; include more context so it is unique.`
      const denied = await gate('edit', `Edit ${relative(root, file)}`, '', `--- old\n${oldText}\n+++ new\n${newText}`)
      if (denied) return denied
      await ws.writeFile(file, text.replace(oldText, () => newText))
      onFileChanged(file)
      return `Edited ${relative(root, file)}.`
    },
    async runCommand(command, timeoutSeconds) {
      const denied = await gate('command', command, 'Run in ' + root)
      if (denied) return denied
      const r = await runCommand(root, command, { timeoutMs: timeoutSeconds * 1000 })
      return `exit ${r.code}\n${r.output.slice(-15000)}`
    }
  }
}

/** Backend for a guest: every call is an RPC to the host. */
export function remoteBackend(root: string, rpc: (method: string, params: Record<string, unknown>) => Promise<string>): ToolBackend {
  return {
    root,
    readFile: (path, start_line, end_line) => rpc('read_file', { path, start_line, end_line }),
    listDir: (path) => rpc('list_dir', { path }),
    search: (pattern, max_results) => rpc('search_files', { pattern, max_results }),
    writeFile: (path, content) => rpc('write_file', { path, content }),
    editFile: (path, old_text, new_text) => rpc('edit_file', { path, old_text, new_text }),
    runCommand: (command, timeout_seconds) => rpc('run_command', { command, timeout_seconds })
  }
}
