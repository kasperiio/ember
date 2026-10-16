// Self-checking: detect what kind of project this is and how to compile / test it.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import type { CheckCommand } from '../shared/types'

export function detectChecks(root: string): CheckCommand[] {
  const checks: CheckCommand[] = []
  const has = (f: string) => existsSync(join(root, f))

  if (has('package.json')) {
    let pkg: any = {}
    try {
      pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    } catch {
      // ignore
    }
    const scripts = pkg.scripts ?? {}
    if (has('tsconfig.json')) checks.push({ label: 'TypeScript', cmd: 'npx tsc --noEmit -p tsconfig.json' })
    if (scripts.lint) checks.push({ label: 'Lint', cmd: 'npm run lint --silent' })
    if (scripts.build) checks.push({ label: 'Build', cmd: 'npm run build --silent' })
    if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ label: 'Tests', cmd: 'npm test --silent' })
    if (checks.length === 0) checks.push({ label: 'Syntax', cmd: 'node --check $(git ls-files "*.js" | head -50)' })
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    checks.push({ label: 'Python compile', cmd: 'python -m compileall -q .' })
    if (has('tests') || has('test') || has('pytest.ini') || has('conftest.py')) checks.push({ label: 'Pytest', cmd: 'python -m pytest -q -x' })
  }
  if (has('Cargo.toml')) {
    checks.push({ label: 'Cargo check', cmd: 'cargo check -q' })
    checks.push({ label: 'Cargo test', cmd: 'cargo test -q' })
  }
  if (has('go.mod')) {
    checks.push({ label: 'Go build', cmd: 'go build ./...' })
    checks.push({ label: 'Go test', cmd: 'go test ./...' })
  }
  const csproj = safeList(root).find((f) => /\.(csproj|sln|fsproj)$/i.test(f))
  if (csproj) checks.push({ label: '.NET build', cmd: 'dotnet build --nologo -v q' })
  if (has('CMakeLists.txt') && has('build')) checks.push({ label: 'CMake build', cmd: 'cmake --build build' })
  if (has('pom.xml')) checks.push({ label: 'Maven', cmd: 'mvn -q compile' })
  if (has('build.gradle') || has('build.gradle.kts')) checks.push({ label: 'Gradle', cmd: 'gradle build -q' })
  return checks
}

function safeList(root: string): string[] {
  try {
    return require('fs').readdirSync(root) as string[]
  } catch {
    return []
  }
}

export interface CheckResult {
  ok: boolean
  output: string
}

export function runCommand(root: string, cmd: string, opts: { timeoutMs?: number; onData?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<CheckResult & { code: number | null }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    // -ExecutionPolicy Bypass applies to this process only; without it npm/npx .ps1 shims are blocked on default Windows installs.
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd] : ['-c', cmd]
    const p = spawn(shell, args, { cwd: root, env: { ...process.env, ...opts.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true })
    let out = ''
    const push = (d: Buffer) => {
      const s = d.toString()
      out += s
      if (out.length > 200_000) out = out.slice(-200_000)
      opts.onData?.(s)
    }
    p.stdout.on('data', push)
    p.stderr.on('data', push)
    const timer = setTimeout(() => {
      out += '\n[timed out]'
      p.kill()
    }, opts.timeoutMs ?? 300_000)
    p.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: out, code })
    })
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, output: out + '\n' + e.message, code: null })
    })
  })
}

/** Run all checks; stop at the first failure. */
export async function runChecks(root: string, checks: CheckCommand[], onLog?: (s: string) => void): Promise<CheckResult> {
  for (const c of checks) {
    onLog?.(`\n$ ${c.label}: ${c.cmd}\n`)
    const r = await runCommand(root, c.cmd, { onData: onLog })
    if (!r.ok) return { ok: false, output: `${c.label} failed (${c.cmd}):\n${r.output.trim().slice(-8000)}` }
  }
  return { ok: true, output: checks.length ? 'All checks passed.' : 'No checks detected.' }
}

/** Does the PC have the runtimes a project needs? */
export async function missingRuntimes(root: string): Promise<{ name: string; wingetId: string }[]> {
  const missing: { name: string; wingetId: string }[] = []
  const probe = (cmd: string) => runCommand(root, `${cmd} --version`, { timeoutMs: 10000 }).then((r) => r.ok)
  if (existsSync(join(root, 'package.json')) && !(await probe('node'))) missing.push({ name: 'Node.js', wingetId: 'OpenJS.NodeJS.LTS' })
  if ((existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) && !(await probe('python'))) missing.push({ name: 'Python', wingetId: 'Python.Python.3.13' })
  return missing
}
