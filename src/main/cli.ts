// Locate, install and query the official provider CLIs (Claude Code, Codex, Antigravity CLI).
// Ember is self-contained: Codex ships inside the installer; Claude Code and Antigravity CLI are fetched
// with their vendors' official native installers (no Node.js, no npm, no admin rights).
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, copyFileSync, writeFileSync, rmSync, renameSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import os from 'os'
import type { CliStatus } from '../shared/types'
import { bundledBin, managedBin } from './paths'

const run = promisify(execFile)

export type CliId = CliStatus['id']

export const CLI_INFO: Record<CliId, { bin: string; label: string }> = {
  claude: { bin: 'claude', label: 'Claude Code' },
  codex: { bin: 'codex', label: 'Codex CLI' },
  gemini: { bin: 'agy', label: 'Antigravity CLI' }
}

const AGY_DIR = join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin')
const CLAUDE_NATIVE_DIR = join(os.homedir(), '.local', 'bin')

/** Directories added to PATH for terminals and child processes. */
export function extraPath(): string {
  return [managedBin(), bundledBin(), CLAUDE_NATIVE_DIR, AGY_DIR, join(process.env.APPDATA ?? '', 'npm'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude')]
    .filter(Boolean)
    .join(';')
}

/** Resolve a CLI to an executable path. Ember-managed and bundled copies win over anything on PATH. */
export async function locate(id: CliId): Promise<string | undefined> {
  const bin = CLI_INFO[id].bin
  const candidates: string[] = [join(managedBin(), bin + '.exe'), join(bundledBin(), bin + '.exe')]
  if (id === 'claude') candidates.push(join(CLAUDE_NATIVE_DIR, 'claude.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe'))
  if (id === 'gemini') candidates.push(join(AGY_DIR, 'agy.exe'))
  for (const c of candidates) if (existsSync(c)) return c
  // Fall back to whatever the user already has (npm shims included).
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 5000, env: { ...process.env, PATH: `${process.env.PATH};${extraPath()}` } })
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && (process.platform !== 'win32' || /\.(cmd|exe)$/i.test(s)))
    if (first) return first
  } catch {
    // not found
  }
  return undefined
}

export function spawnCli(exe: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const isCmd = /\.cmd$/i.test(exe)
  const env = { ...process.env, ...opts.env, PATH: `${process.env.PATH};${extraPath()}` }
  // .cmd shims must go through the shell on Windows; quote args for cmd.exe.
  if (isCmd) {
    const q = (a: string) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)
    return spawn(`"${exe}" ${args.map(q).join(' ')}`, { cwd: opts.cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  return spawn(exe, args, { cwd: opts.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

const shellFor = (exe: string) => /\.cmd$/i.test(exe)

async function version(exe: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(exe, ['--version'], { shell: shellFor(exe), timeout: 20000, windowsHide: true })
    return stdout.trim().split('\n')[0]
  } catch {
    return undefined
  }
}

export async function status(id: CliId): Promise<CliStatus> {
  const path = await locate(id)
  if (!path) return { id, installed: false, loggedIn: false }
  const st: CliStatus = { id, installed: true, path, version: await version(path), loggedIn: 'unknown' }
  const authPattern = /authentication required|sign in|not signed in|login/i
  try {
    if (id === 'claude') {
      const { stdout } = await run(path, ['auth', 'status'], { shell: shellFor(path), timeout: 20000, windowsHide: true })
      const j = JSON.parse(stdout.slice(stdout.indexOf('{')))
      st.loggedIn = !!j.loggedIn
      st.account = j.email ?? j.account ?? (j.authMethod && j.authMethod !== 'none' ? j.authMethod : undefined)
    } else if (id === 'codex') {
      const { stdout } = await run(path, ['login', 'status'], { shell: shellFor(path), timeout: 20000, windowsHide: true })
      st.loggedIn = !/not logged in/i.test(stdout)
      st.account = stdout.trim().split('\n')[0]
    } else if (id === 'gemini') {
      // `agy models` succeeds only with a valid Google session; without one it reports "authentication required".
      const { stdout, stderr } = await run(path, ['models'], { timeout: 30000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } })
      st.loggedIn = !authPattern.test(stdout + stderr)
      try {
        const acc = JSON.parse(readFileSync(join(os.homedir(), '.gemini', 'google_accounts.json'), 'utf8'))
        st.account = acc.active ?? undefined
      } catch {
        // no account file
      }
    }
  } catch (e: any) {
    // The CLIs exit non-zero when signed out; the answer is still in their output.
    const out = String(e?.stdout ?? '') + String(e?.stderr ?? '') + String(e?.message ?? '')
    if (id === 'codex' && /not logged in/i.test(out)) st.loggedIn = false
    if (id === 'gemini') st.loggedIn = authPattern.test(out) ? false : 'unknown'
    if (id === 'claude') {
      const m = /\{[\s\S]*\}/.exec(out)
      if (m) {
        try {
          st.loggedIn = !!JSON.parse(m[0]).loggedIn
        } catch {
          // leave unknown
        }
      } else if (/not logged in|not authenticated/i.test(out)) st.loggedIn = false
    }
  }
  return st
}

export async function allStatus(): Promise<CliStatus[]> {
  return Promise.all((['claude', 'codex', 'gemini'] as CliId[]).map(status))
}

function runLogged(cmd: string, args: string[], onLog: (s: string) => void, opts: { shell?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: opts.shell, windowsHide: true, env: { ...process.env, PATH: `${process.env.PATH};${extraPath()}` } })
    p.stdout.on('data', (d) => onLog(String(d)))
    p.stderr.on('data', (d) => onLog(String(d)))
    p.on('exit', (c) => resolve(c === 0))
    p.on('error', (e) => {
      onLog(String(e))
      resolve(false)
    })
  })
}

/** Install or update a CLI without Node.js or admin rights. */
export async function install(id: CliId, onLog: (s: string) => void): Promise<boolean> {
  if (id === 'claude') {
    // Anthropic's native installer: puts claude.exe in %USERPROFILE%\.local\bin and keeps it updated.
    onLog('Running the official Claude Code installer...\n')
    return runLogged('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], onLog)
  }
  if (id === 'gemini') {
    onLog('Running the official Antigravity CLI installer...\n')
    return runLogged('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'], onLog)
  }
  // Codex: a copy ships with Ember; "install/update" fetches the latest GitHub release into the managed dir.
  try {
    onLog('Looking up the latest Codex CLI release...\n')
    const res = await fetch('https://api.github.com/repos/openai/codex/releases/latest', { headers: { 'User-Agent': 'ember', Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error('GitHub: HTTP ' + res.status)
    const rel: any = await res.json()
    // Exact name: the release also ships codex-app-server-* and other helper binaries with the same suffix.
    const asset = rel.assets.find((a: any) => /^codex-x86_64-pc-windows-msvc\.exe\.zip$/.test(a.name))
    if (!asset) throw new Error('no Windows build in release ' + rel.tag_name)
    onLog(`Downloading ${asset.name} (${(asset.size / 1e6).toFixed(0)} MB)...\n`)
    const zipRes = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'ember' }, redirect: 'follow' })
    if (!zipRes.ok) throw new Error('download failed: HTTP ' + zipRes.status)
    const dir = managedBin()
    const zip = join(dir, 'codex-download.zip')
    writeFileSync(zip, Buffer.from(await zipRes.arrayBuffer()))
    const tmp = join(dir, 'codex-tmp')
    rmSync(tmp, { recursive: true, force: true })
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${tmp}" -Force`], { timeout: 120000 })
    // The archive also contains helper executables; take the CLI by name, else the largest file.
    const exes = readdirSync(tmp).filter((f) => f.endsWith('.exe'))
    const exe = exes.find((f) => /^codex(-x86_64-pc-windows-msvc)?\.exe$/i.test(f)) ?? exes.sort((a, b) => statSync(join(tmp, b)).size - statSync(join(tmp, a)).size)[0]
    if (!exe) throw new Error('no exe in archive')
    const dest = join(dir, 'codex.exe')
    rmSync(dest, { force: true })
    renameSync(join(tmp, exe), dest)
    // Keep the helper executables (sandbox setup, command runner, code-mode host) next to the CLI.
    for (const f of exes) {
      if (f === exe) continue
      rmSync(join(dir, f), { force: true })
      renameSync(join(tmp, f), join(dir, f))
    }
    rmSync(tmp, { recursive: true, force: true })
    rmSync(zip, { force: true })
    onLog(`Installed Codex CLI ${rel.tag_name}.\n`)
    return true
  } catch (e: any) {
    onLog('Update failed: ' + e.message + '\n')
    const bundled = join(bundledBin(), 'codex.exe')
    if (existsSync(bundled)) {
      copyFileSync(bundled, join(managedBin(), 'codex.exe'))
      onLog('Using the Codex CLI that shipped with Ember.\n')
      return true
    }
    return false
  }
}

/** Command line to run inside the embedded terminal to sign in (interactive). */
export async function loginCommand(id: CliId): Promise<string | null> {
  const path = await locate(id)
  if (!path) return null
  if (id === 'gemini') return '& "' + path + '" -p "Reply with one word: ready" ; Write-Host ""; Write-Host "If a browser opened, finish signing in with Google there. Then close this tab."'
  if (id === 'codex') return '& "' + path + '" login'
  return '& "' + path + '" auth login'
}

export async function logout(id: CliId): Promise<void> {
  const path = await locate(id)
  if (!path) return
  const args = id === 'claude' ? ['auth', 'logout'] : id === 'codex' ? ['logout'] : ['-p', '/logout']
  await run(path, args, { shell: shellFor(path), timeout: 20000, windowsHide: true }).catch(() => undefined)
}

/** Models a provider CLI offers (Antigravity lists them; the others use well-known ids). */
export async function models(id: CliId): Promise<{ id: string; label: string }[]> {
  if (id === 'claude')
    // Same list as the Claude desktop app's model menu; full ids are passed to `claude --model`.
    return [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }
    ]
  if (id === 'codex') return [{ id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }, { id: 'gpt-5.5', label: 'GPT-5.5' }]
  const path = await locate(id)
  if (!path) return []
  try {
    const { stdout } = await run(path, ['models'], { timeout: 30000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } })
    return stdout
      .split(/\r?\n/)
      .map((l) => l.split('\t'))
      .filter((p) => p.length >= 2 && /^[\w.-]+$/.test(p[0]))
      .map((p) => ({ id: p[0].trim(), label: p.slice(1).join(' ').trim() }))
  } catch {
    return []
  }
}
