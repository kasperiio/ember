// Downloads the third-party binaries Ember ships inside the installer (Windows x64):
//   - cloudflared (Apache-2.0)  -> resources/bin/cloudflared.exe
//   - Codex CLI   (Apache-2.0)  -> resources/bin/codex.exe
// Claude Code and Antigravity CLI are NOT redistributable; Ember runs their official installers at first use.
import { mkdirSync, existsSync, writeFileSync, statSync, rmSync, renameSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'resources', 'bin')
const licenses = join(bin, 'licenses')
mkdirSync(licenses, { recursive: true })

const force = process.argv.includes('--force')
const headers = { 'User-Agent': 'ember-build', Accept: 'application/vnd.github+json' }

async function download(url, dest) {
  if (existsSync(dest) && !force) {
    console.log('exists ', dest)
    return
  }
  console.log('fetch  ', url)
  const res = await fetch(url, { headers: { 'User-Agent': 'ember-build' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  console.log('saved  ', dest, (statSync(dest).size / 1e6).toFixed(1), 'MB')
}

async function latestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
  if (!res.ok) throw new Error(`${repo} releases: HTTP ${res.status}`)
  return res.json()
}

// --- cloudflared ---
await download('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', join(bin, 'cloudflared.exe'))
await download('https://raw.githubusercontent.com/cloudflare/cloudflared/master/LICENSE', join(licenses, 'cloudflared-LICENSE.txt'))

// --- Codex CLI (native Windows build from the GitHub release) ---
const codexExe = join(bin, 'codex.exe')
if (!existsSync(codexExe) || force) {
  const rel = await latestRelease('openai/codex')
  // Exact name: the release also ships codex-app-server-*, codex-command-runner-* etc. with the same suffix.
  const asset = rel.assets.find((a) => /^codex-x86_64-pc-windows-msvc\.exe\.zip$/.test(a.name))
  if (!asset) throw new Error('No Windows x64 Codex asset in release ' + rel.tag_name + ': ' + rel.assets.map((a) => a.name).join(', '))
  const zip = join(bin, asset.name)
  await download(asset.browser_download_url, zip)
  const tmp = join(bin, 'codex-tmp')
  rmSync(tmp, { recursive: true, force: true })
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${tmp}" -Force`], { stdio: 'inherit' })
  // The archive also contains helper executables; take the CLI by name, else the largest file.
  const exes = readdirSync(tmp).filter((f) => f.endsWith('.exe'))
  const exe = exes.find((f) => /^codex(-x86_64-pc-windows-msvc)?\.exe$/i.test(f)) ?? exes.sort((a, b) => statSync(join(tmp, b)).size - statSync(join(tmp, a)).size)[0]
  if (!exe) throw new Error('No exe inside ' + asset.name)
  console.log('archive exes:', exes.join(', '), '-> using', exe)
  renameSync(join(tmp, exe), codexExe)
  // Keep the helper executables (sandbox setup, command runner, code-mode host) next to the CLI.
  for (const f of exes) if (f !== exe) renameSync(join(tmp, f), join(bin, f))
  rmSync(tmp, { recursive: true, force: true })
  rmSync(zip, { force: true })
  writeFileSync(join(bin, 'codex.version'), rel.tag_name)
  console.log('codex  ', rel.tag_name)
}
await download('https://raw.githubusercontent.com/openai/codex/main/LICENSE', join(licenses, 'codex-LICENSE.txt'))

console.log('done')
