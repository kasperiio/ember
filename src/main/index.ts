import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, nativeImage, clipboard } from 'electron'
import { join, basename, extname } from 'path'
import { copyFileSync, mkdirSync, statSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import * as store from './store'
import * as ollama from './ollama'
import * as hw from './hardware'
import * as cli from './cli'
import * as ws from './workspace'
import * as checkpoints from './checkpoints'
import * as permissions from './permissions'
import * as runner from './runner'
import * as terminal from './terminal'
import * as sharing from './sharing'
import * as usage from './usage'
import * as mcp from './mcp'
import { claudeAuth, claudePlanLabel } from './agents/claude'
import { detectChecks, runChecks, missingRuntimes, runCommand } from './checks'
import type { AiModule, McpServer, Session, Settings } from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv'
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#fafafa',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ddd' : '#333', height: 36 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, webviewTag: true }
  })
  permissions.bindWindow(win)
  runner.bindWindow(win)
  terminal.bindWindow(win)
  sharing.bindWindow(win)
  usage.bindWindow(win)
  if (!app.isPackaged) win.webContents.on('console-message', (ev) => console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`))
  win.on('ready-to-show', () => {
    win?.show()
    // Development aid: EMBER_SCREENSHOT=<file> captures the window a few seconds after start.
    if (process.env.EMBER_SCREENSHOT) {
      const shot = async (n: number) => {
        const img = await win!.webContents.capturePage()
        require('fs').writeFileSync(process.env.EMBER_SCREENSHOT!.replace('.png', `-${n}.png`), img.toPNG())
      }
      setTimeout(() => shot(1), 4000)
      setTimeout(() => shot(2), 12000)
    }
    // Development aid: EMBER_AUTOMATION_PORT=<port> accepts POST /eval (JS run in the renderer) and GET /shot (PNG).
    if (process.env.EMBER_AUTOMATION_PORT && !app.isPackaged) {
      const http = require('http') as typeof import('http')
      http
        .createServer(async (req, res) => {
          try {
            if (req.method === 'GET' && req.url === '/shot') {
              const img = await win!.webContents.capturePage()
              res.writeHead(200, { 'Content-Type': 'image/png' })
              return res.end(img.toPNG())
            }
            let body = ''
            for await (const c of req) body += c
            const result = await win!.webContents.executeJavaScript(body, true)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result ?? null))
          } catch (e: any) {
            res.writeHead(500)
            res.end(String(e?.message ?? e))
          }
        })
        .on('error', () => undefined)
        .listen(Number(process.env.EMBER_AUTOMATION_PORT), '127.0.0.1')
    }
  })
  win.on('close', (e) => {
    if (!quitting && store.getSettings().keepInTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
  win?.setTitleBarOverlay?.({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ddd' : '#333', height: 36 })
}

function createTray(): void {
  const iconPath = join(process.resourcesPath ?? '', 'resources', 'icon.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL(ICON_DATA)
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Ember')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Ember', click: () => win?.show() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => win?.show())
}

// A simple 16x16 flame-ish dot as fallback tray icon.
const ICON_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAbElEQVQ4T2NkoBAwUqifgWoG/P//n4GRkZEBXQNcAKYRxCbkB7wGwDTCDMBnEEnhADMA3RCCBiC7Dt0gDAPQnYvNBXgNwOYNrIGIzQBkV6AbiNMAZGcju4QkA5CdixwuJHkB3YkkuwAWqOhBixEqAAAw2ikRAfb3kQAAAABJRU5ErkJggg=='

app.whenReady().then(() => {
  applyTheme(store.getSettings().theme)
  createWindow()
  createTray()
  mcp.syncAntigravity()
  app.on('activate', () => (BrowserWindow.getAllWindows().length === 0 ? createWindow() : win?.show()))
})

app.on('before-quit', () => {
  quitting = true
  terminal.killAll()
  import('./agents/claude').then((m) => m.dropAllWarmClaude()).catch(() => undefined)
  sharing.stopAll()
  mcp.closeAll()
  if (store.getSettings().unloadOnClose) ollama.unloadAll()
})
app.on('window-all-closed', () => {
  if (!store.getSettings().keepInTray) app.quit()
})

// ---------------- IPC ----------------
const h = ipcMain.handle.bind(ipcMain)

// settings
h('settings:get', () => store.getSettings())
h('settings:set', (_e, patch: Partial<Settings>) => {
  const s = store.saveSettings(patch)
  if (patch.theme) applyTheme(patch.theme)
  return s
})
h('app:info', () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData') }))
h('app:quit', () => {
  quitting = true
  app.quit()
})

// sessions
h('sessions:list', () => store.listSessions())
h('sessions:search', (_e, q: string) => store.searchSessions(q))
h('sessions:get', (_e, id: string) => store.loadSession(id))
h('sessions:create', async (_e, init: Partial<Session> & Pick<Session, 'kind'>) => {
  const s = store.newSession(init)
  if (s.kind === 'code' && !s.workspace) {
    const root = store.getSettings().scratchRoot
    const name = 'project-' + new Date().toISOString().slice(0, 10) + '-' + randomUUID().slice(0, 4)
    s.workspace = join(root, name)
    mkdirSync(s.workspace, { recursive: true })
    s.title = name
  }
  await store.saveSession(s)
  return s
})
h('sessions:save', async (_e, s: Session) => {
  await store.saveSession(s)
  return s
})
h('sessions:delete', (_e, id: string) => store.deleteSession(id))
h('sessions:send', (_e, id: string, prompt: string, attachments) => runner.runTurn(id, prompt, attachments))
h('sessions:stop', (_e, id: string) => runner.stop(id))
h('sessions:running', (_e, id: string) => runner.isRunning(id))
h('sessions:compact', (_e, id: string) => runner.compact(id))
h('sessions:rewind', (_e, id: string, msgId: string, what: 'files' | 'conversation' | 'both') => runner.rewind(id, msgId, what))
h('approval:answer', (_e, id: string, ok: boolean) => permissions.answer(id, ok))

// attachments
h('attachments:pick', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
  if (r.canceled) return []
  return r.filePaths.map(importAttachment)
})
h('attachments:import', (_e, paths: string[]) => paths.map(importAttachment))
function importAttachment(p: string) {
  const dir = store.attachmentsDir()
  const name = basename(p)
  const dest = join(dir, randomUUID().slice(0, 8) + '-' + name)
  copyFileSync(p, dest)
  return { name, path: dest, mime: MIME[extname(p).toLowerCase()] ?? 'application/octet-stream', size: statSync(dest).size }
}

// modules
h('modules:list', () => store.listModules())
h('modules:save', (_e, mods: AiModule[]) => store.saveModules(mods))
h('mcp:list', () => store.listMcpServers())
h('mcp:save', (_e, list: McpServer[]) => {
  store.saveMcpServers(list)
  mcp.onServersChanged()
})
h('mcp:test', (_e, server: McpServer) => mcp.test(server))

// ollama
h('ollama:status', () => ollama.ollamaAvailable())
h('ollama:models', () => ollama.listModels().catch(() => []))
h('ollama:show', (_e, name: string) => ollama.showModel(name))
h('ollama:running', () => ollama.running().catch(() => []))
h('ollama:unload', (_e, name: string) => ollama.unload(name))
h('ollama:delete', (_e, name: string) => ollama.deleteModel(name))
h('ollama:pull', (_e, name: string) => {
  ollama.pull(name, (p) => win?.webContents.send('ollama:pull-progress', { name, ...p }))
})
h('ollama:cancelPull', (_e, name: string) => ollama.cancelPull(name))
h('ollama:install', () => hw.installOllama((s) => win?.webContents.send('log', { source: 'ollama-install', text: s })))

// hardware / discover
h('hardware:scan', () => hw.scanHardware())
h('hardware:recommend', async () => {
  const [hardware, models] = await Promise.all([hw.scanHardware(), ollama.listModels().catch(() => [])])
  return { hardware, recommendations: hw.recommend(hardware, models) }
})

// provider CLIs
h('cli:status', async () => {
  const all = await cli.allStatus()
  const c = all.find((s) => s.id === 'claude')
  if (c?.loggedIn === true) c.plan = claudePlanLabel(await claudeAuth(true))
  return all
})
h('cli:install', (_e, id: cli.CliId) => cli.install(id, (s) => win?.webContents.send('log', { source: 'cli-install', text: s })))
h('cli:loginCommand', (_e, id: cli.CliId) => cli.loginCommand(id))
h('cli:logout', (_e, id: cli.CliId) => cli.logout(id))
h('cli:models', (_e, id: cli.CliId) => cli.models(id))

// workspace
h('ws:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
h('ws:listDir', (_e, root: string, dir: string) => ws.listDir(root, dir))
h('ws:read', (_e, p: string) => ws.readFile(p))
h('ws:write', (_e, p: string, content: string) => ws.writeFile(p, content))
h('ws:search', (_e, root: string, q: string, regex: boolean) => ws.search(root, q, { regex }))
h('ws:files', (_e, root: string) => ws.listAllFiles(root))
h('ws:gitStatus', async (_e, root: string) => Object.fromEntries(await ws.gitStatus(root)))
h('ws:gitDiff', (_e, root: string, file?: string) => ws.gitDiff(root, file))
h('ws:gitCommit', (_e, root: string, msg: string) => ws.gitCommitAll(root, msg))
h('ws:watch', (_e, root: string) => ws.watchWorkspace(root, (paths) => win?.webContents.send('ws:changed', { root, paths })))
h('ws:unwatch', (_e, root: string) => ws.unwatch(root))
h('ws:openExternal', (_e, target: string) => shell.openPath(target))
h('ws:openInVSCode', (_e, root: string) => runCommand(root, `code "${root}"`, { timeoutMs: 10000 }))
h('ws:openInTerminal', (_e, root: string) => runCommand(root, `wt -d "${root}"`, { timeoutMs: 10000 }).then((r) => (r.ok ? r : runCommand(root, `Start-Process powershell -WorkingDirectory "${root}"`))))
h('ws:checks', (_e, root: string) => detectChecks(root))
h('ws:runChecks', (_e, root: string) => runChecks(root, detectChecks(root), (s) => win?.webContents.send('log', { source: 'checks', text: s })))
h('ws:missingRuntimes', (_e, root: string) => missingRuntimes(root))
h('ws:installRuntime', (_e, wingetId: string) => runCommand(process.cwd(), `winget install -e --id ${wingetId} --accept-source-agreements --accept-package-agreements`, { timeoutMs: 600000, onData: (s) => win?.webContents.send('log', { source: 'runtime-install', text: s }) }))
h('ws:changedSince', (_e, root: string, tree: string) => checkpoints.changedSince(root, tree))
h('ws:fileAt', (_e, root: string, tree: string, rel: string) => checkpoints.fileAt(root, tree, rel))
h('ws:diffSince', (_e, root: string, tree: string, rel?: string) => checkpoints.diffSince(root, tree, rel))
h('clipboard:write', (_e, text: string) => clipboard.writeText(text))
h('shell:openExternal', (_e, url: string) => shell.openExternal(url))

// usage
h('usage:get', () => usage.getUsage())
h('usage:refresh', async () => {
  const { refreshAgyUsage } = await import('./agents/gemini')
  await refreshAgyUsage().catch(() => undefined)
  return usage.getUsage()
})

// shared sessions
h('share:start', (_e, id: string) => sharing.startSharing(id))
h('share:stop', (_e, id: string) => sharing.stopSharing(id))
h('share:participants', (_e, id: string) => sharing.participantsOf(id))
h('share:inviteCode', (_e, url: string, key: string) => sharing.inviteCode(url, key))
h('share:parseInvite', (_e, text: string) => sharing.parseInvite(text))
h('share:join', (_e, url: string, key: string, existingId?: string) => sharing.join(url, key, store.getSettings().displayName, existingId))
h('share:leave', (_e, id: string) => sharing.leave(id))
h('share:cloudflared', () => sharing.cloudflaredAvailable())
h('share:installCloudflared', () => sharing.installCloudflared((t) => win?.webContents.send('log', { source: 'cloudflared-install', text: t })))

// terminal
h('terminal:create', (_e, id: string, cwd: string, cols: number, rows: number, cmd?: string) => terminal.create(id, cwd, cols, rows, cmd))
h('terminal:write', (_e, id: string, data: string) => terminal.write(id, data))
h('terminal:resize', (_e, id: string, cols: number, rows: number) => terminal.resize(id, cols, rows))
h('terminal:kill', (_e, id: string) => terminal.kill(id))
