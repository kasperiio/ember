// File system operations for the code workspace: tree, read/write, search, git status, watching.
import { promises as fs, existsSync, readFileSync, watch as fsWatch, FSWatcher } from 'fs'
import { join, relative, dirname, sep } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import ignore from 'ignore'
import type { FileEntry, SearchHit } from '../shared/types'

const run = promisify(execFile)

const ALWAYS_IGNORE = ['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.idea', '.vs']

function loadIgnore(root: string) {
  const ig = ignore()
  ig.add(ALWAYS_IGNORE.map((d) => d + '/'))
  const gi = join(root, '.gitignore')
  if (existsSync(gi)) {
    try {
      ig.add(readFileSync(gi, 'utf8'))
    } catch {
      // ignore
    }
  }
  return ig
}

export async function listDir(root: string, dir: string): Promise<FileEntry[]> {
  const ig = loadIgnore(root)
  const status = await gitStatus(root).catch(() => new Map<string, string>())
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    const rel = relative(root, full).split(sep).join('/')
    if (rel && ig.ignores(e.isDirectory() ? rel + '/' : rel)) continue
    let gs = status.get(rel)
    if (e.isDirectory() && !gs) {
      for (const [p, s] of status) if (p.startsWith(rel + '/')) { gs = s === '?' ? '?' : 'M'; break }
    }
    out.push({ name: e.name, path: full, isDir: e.isDirectory(), gitStatus: gs })
  }
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function readFile(path: string): Promise<string> {
  return fs.readFile(path, 'utf8')
}

export async function writeFile(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

export async function gitStatus(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!existsSync(join(root, '.git'))) return map
  try {
    const { stdout } = await run('git', ['status', '--porcelain', '-uall'], { cwd: root, timeout: 10000, maxBuffer: 10 * 1024 * 1024 })
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const code = line.slice(0, 2)
      const file = line.slice(3).trim().replace(/^"|"$/g, '')
      const s = code === '??' ? '?' : code.includes('D') ? 'D' : code.includes('A') ? 'A' : 'M'
      map.set(file, s)
    }
  } catch {
    // not a repo
  }
  return map
}

export async function* walk(root: string, dir = root, ig = loadIgnore(root)): AsyncGenerator<string> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    const rel = relative(root, full).split(sep).join('/')
    if (ig.ignores(e.isDirectory() ? rel + '/' : rel)) continue
    if (e.isDirectory()) yield* walk(root, full, ig)
    else yield full
  }
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|7z|rar|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|bin|pyc|class|jar|lock)$/i

export async function search(root: string, query: string, opts: { regex?: boolean; limit?: number } = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 500
  let re: RegExp
  try {
    re = opts.regex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  } catch {
    return []
  }
  const hits: SearchHit[] = []
  for await (const file of walk(root)) {
    if (BINARY_EXT.test(file)) continue
    let text: string
    try {
      const st = await fs.stat(file)
      if (st.size > 2 * 1024 * 1024) continue
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ path: file, line: i + 1, text: lines[i].slice(0, 300) })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}

export async function listAllFiles(root: string, limit = 5000): Promise<string[]> {
  const out: string[] = []
  for await (const f of walk(root)) {
    out.push(relative(root, f).split(sep).join('/'))
    if (out.length >= limit) break
  }
  return out
}

/** Project instruction files, in priority order. */
export function projectInstructions(root: string): string {
  for (const name of ['EMBER.md', 'KILN.md', 'AGENTS.md', 'CLAUDE.md']) {
    const p = join(root, name)
    if (existsSync(p)) {
      try {
        return `# Project instructions (${name})\n\n` + readFileSync(p, 'utf8')
      } catch {
        // ignore
      }
    }
  }
  return ''
}

// ---- watching ----
const watchers = new Map<string, FSWatcher>()

export function watchWorkspace(root: string, onChange: (paths: string[]) => void): void {
  unwatch(root)
  try {
    const ig = loadIgnore(root)
    let pending = new Set<string>()
    let timer: NodeJS.Timeout | null = null
    const w = fsWatch(root, { recursive: true }, (_ev, filename) => {
      if (!filename) return
      const rel = String(filename).split(sep).join('/')
      if (ig.ignores(rel) || ig.ignores(rel + '/')) return
      pending.add(join(root, String(filename)))
      if (!timer)
        timer = setTimeout(() => {
          const list = [...pending]
          pending = new Set()
          timer = null
          onChange(list)
        }, 300)
    })
    w.on('error', () => undefined)
    watchers.set(root, w)
  } catch {
    // recursive watch unsupported
  }
}

export function unwatch(root: string): void {
  watchers.get(root)?.close()
  watchers.delete(root)
}

export async function gitInit(root: string): Promise<void> {
  if (!existsSync(join(root, '.git'))) await run('git', ['init', '-q'], { cwd: root })
}

export async function gitCommitAll(root: string, message: string): Promise<string> {
  await gitInit(root)
  await run('git', ['add', '-A'], { cwd: root })
  try {
    const { stdout } = await run('git', ['commit', '-q', '-m', message], { cwd: root })
    return stdout || 'Committed.'
  } catch (e: any) {
    return e.stdout || e.message
  }
}

export async function gitDiff(root: string, file?: string): Promise<string> {
  const args = ['diff', 'HEAD', '--']
  if (file) args.push(file)
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}
