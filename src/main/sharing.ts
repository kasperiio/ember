// Shared sessions ("friends"): the host serves a session over WebSocket (through a Cloudflare quick
// tunnel when available); guests mirror the transcript, chat with their own AI, and their AI's file
// edits and commands are executed on the host only after the host approves them.
import http from 'http'
import os from 'os'
import { randomBytes, randomUUID } from 'crypto'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join as pathJoin } from 'path'
import { promisify } from 'util'
import { WebSocketServer, WebSocket } from 'ws'
import type { BrowserWindow } from 'electron'
import type { ChatMessage, Participant, Session } from '../shared/types'
import { getSettings, loadSession, saveSession } from './store'
import * as permissions from './permissions'
import { localBackend } from './tools'
import { bundledBin, managedBin } from './paths'

const run = promisify(execFile)

// ---------- wire protocol ----------
type HostToGuest =
  | { type: 'hello'; participantId: string; hostName: string; session: Session; participants: Participant[] }
  | { type: 'session'; session: Session }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'rpc-result'; id: string; result: string }
  | { type: 'error'; message: string }
  | { type: 'closed' }
type GuestToHost =
  | { type: 'join'; name: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'assistant'; message: ChatMessage; final: boolean }
  | { type: 'rpc'; id: string; method: string; params: Record<string, unknown> }

let win: BrowserWindow | null = null
export function bindWindow(w: BrowserWindow): void {
  win = w
}
const notify = (channel: string, payload: unknown) => win?.webContents.send(channel, payload)

/** Strip host-only data before sending a session to guests. */
function publicSession(s: Session): Session {
  return { ...s, providerSessions: {}, sharing: s.sharing ? { ...s.sharing, key: undefined } : undefined }
}

// =====================================================================================
// HOST
// =====================================================================================
interface Host {
  sessionId: string
  key: string
  server: http.Server
  wss: WebSocketServer
  port: number
  tunnel?: ChildProcess
  url?: string
  lanUrl: string
  guests: Map<WebSocket, Participant>
  hostParticipant: Participant
}
const hosts = new Map<string, Host>()

export function hostFor(sessionId: string): Host | undefined {
  return hosts.get(sessionId)
}

function participants(h: Host): Participant[] {
  return [h.hostParticipant, ...h.guests.values()]
}

function lanIp(): string {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address
  return '127.0.0.1'
}

export async function startSharing(sessionId: string): Promise<{ url: string; lanUrl: string; key: string; tunnel: boolean }> {
  const existing = hosts.get(sessionId)
  if (existing) return { url: existing.url ?? existing.lanUrl, lanUrl: existing.lanUrl, key: existing.key, tunnel: !!existing.url }
  const session = await loadSession(sessionId)
  if (!session) throw new Error('Session not found')

  const key = randomBytes(9).toString('base64url')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Ember shared session. Join from Ember with the invite key.')
  })
  const wss = new WebSocketServer({ noServer: true })
  const h: Host = {
    sessionId,
    key,
    server,
    wss,
    port: 0,
    lanUrl: '',
    guests: new Map(),
    hostParticipant: { id: 'host', name: getSettings().displayName, role: 'host', connected: true }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== '/ws' || url.searchParams.get('key') !== key) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws) => {
    let me: Participant | null = null
    ws.on('message', async (raw) => {
      let msg: GuestToHost
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      try {
        if (msg.type === 'join') {
          me = { id: randomUUID().slice(0, 8), name: String(msg.name || 'Guest').slice(0, 40), role: 'guest', connected: true }
          h.guests.set(ws, me)
          const s = await loadSession(sessionId)
          send(ws, { type: 'hello', participantId: me.id, hostName: h.hostParticipant.name, session: publicSession(s!), participants: participants(h) })
          await appendSystem(sessionId, `${me.name} joined the session.`)
          broadcastParticipants(h)
          return
        }
        if (!me) return send(ws, { type: 'error', message: 'join first' })
        if (msg.type === 'message') {
          const m: ChatMessage = { ...msg.message, role: 'user', author: me.name, participantId: me.id, checkpoint: undefined, createdAt: Date.now() }
          await appendMessage(sessionId, m)
        } else if (msg.type === 'assistant') {
          const m: ChatMessage = { ...msg.message, role: 'assistant', author: me.name, participantId: me.id }
          await upsertMessage(sessionId, m)
        } else if (msg.type === 'rpc') {
          const result = await handleRpc(h, me, msg.method, msg.params)
          send(ws, { type: 'rpc-result', id: msg.id, result })
        }
      } catch (e: any) {
        send(ws, { type: 'error', message: String(e?.message ?? e) })
      }
    })
    ws.on('close', async () => {
      if (me) {
        h.guests.delete(ws)
        await appendSystem(sessionId, `${me.name} left the session.`)
        broadcastParticipants(h)
      }
    })
  })

  await new Promise<void>((res) => server.listen(0, '0.0.0.0', () => res()))
  h.port = (server.address() as any).port
  h.lanUrl = `http://${lanIp()}:${h.port}`
  hosts.set(sessionId, h)

  // Public URL through a Cloudflare quick tunnel; fall back to LAN if cloudflared is missing.
  try {
    const t = await openTunnel(h.port)
    h.tunnel = t.proc
    h.url = t.url
  } catch (e: any) {
    await appendSystem(sessionId, `Sharing on the local network only (${e.message}).`)
  }

  session.sharing = { role: 'host', url: h.url ?? h.lanUrl, lanUrl: h.lanUrl, key, active: true }
  await saveSession(session)
  notify('session:updated', session)
  notify('share:participants', { sessionId, participants: participants(h) })
  return { url: h.url ?? h.lanUrl, lanUrl: h.lanUrl, key, tunnel: !!h.url }
}

export async function stopSharing(sessionId: string): Promise<void> {
  const h = hosts.get(sessionId)
  if (!h) return
  for (const ws of h.guests.keys()) {
    send(ws, { type: 'closed' })
    ws.close()
  }
  h.wss.close()
  h.server.close()
  h.tunnel?.kill()
  hosts.delete(sessionId)
  const s = await loadSession(sessionId)
  if (s) {
    s.sharing = s.sharing ? { ...s.sharing, active: false } : undefined
    await saveSession(s)
    notify('session:updated', s)
  }
  notify('share:participants', { sessionId, participants: [] })
}

export function stopAll(): void {
  for (const id of [...hosts.keys()]) stopSharing(id)
  for (const id of [...guests.keys()]) leave(id)
}

export function participantsOf(sessionId: string): Participant[] {
  const h = hosts.get(sessionId)
  if (h) return participants(h)
  const g = guests.get(sessionId)
  return g?.participants ?? []
}

function send(ws: WebSocket, msg: HostToGuest): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcastParticipants(h: Host): void {
  const list = participants(h)
  for (const ws of h.guests.keys()) send(ws, { type: 'participants', participants: list })
  notify('share:participants', { sessionId: h.sessionId, participants: list })
}

/** Called by the runner whenever the host's copy of a shared session changes (including streaming). */
export function broadcastSession(session: Session): void {
  const h = hosts.get(session.id)
  if (!h) return
  const pub = publicSession(session)
  for (const ws of h.guests.keys()) send(ws, { type: 'session', session: pub })
}

async function appendSystem(sessionId: string, text: string): Promise<void> {
  await appendMessage(sessionId, { id: randomUUID(), role: 'system', content: text, createdAt: Date.now() })
}

async function appendMessage(sessionId: string, m: ChatMessage): Promise<void> {
  const s = await loadSession(sessionId)
  if (!s) return
  s.messages.push(m)
  await saveSession(s)
  notify('session:updated', s)
  broadcastSession(s)
}

async function upsertMessage(sessionId: string, m: ChatMessage): Promise<void> {
  const s = await loadSession(sessionId)
  if (!s) return
  const i = s.messages.findIndex((x) => x.id === m.id)
  if (i >= 0) s.messages[i] = m
  else s.messages.push(m)
  await saveSession(s)
  notify('session:updated', s)
  broadcastSession(s)
}

/** Guest AI tool calls run on the host. Reads are allowed; edits and commands always ask the host. */
async function handleRpc(h: Host, guest: Participant, method: string, p: Record<string, any>): Promise<string> {
  const s = await loadSession(h.sessionId)
  if (!s?.workspace) return 'Error: this shared session has no workspace.'
  const backend = localBackend(
    s.workspace,
    async (kind, title, detail, diff) => {
      const ok = await permissions.ask({ sessionId: h.sessionId, kind, title: `Guest ${guest.name}: ${title}`, detail, diff })
      return ok ? null : `Denied: the host (${h.hostParticipant.name}) did not approve this ${kind}.`
    },
    () => undefined
  )
  switch (method) {
    case 'read_file':
      return backend.readFile(String(p.path), p.start_line, p.end_line)
    case 'list_dir':
      return backend.listDir(String(p.path ?? '.'))
    case 'search_files':
      return backend.search(String(p.pattern), Number(p.max_results ?? 50))
    case 'write_file':
      return backend.writeFile(String(p.path), String(p.content ?? ''))
    case 'edit_file':
      return backend.editFile(String(p.path), String(p.old_text ?? ''), String(p.new_text ?? ''))
    case 'run_command':
      return backend.runCommand(String(p.command), Number(p.timeout_seconds ?? 120))
    default:
      return `Error: unknown method ${method}`
  }
}

// ---------- cloudflared ----------
async function findCloudflared(): Promise<string | null> {
  const candidates = [
    pathJoin(managedBin(), 'cloudflared.exe'),
    pathJoin(bundledBin(), 'cloudflared.exe'),
    pathJoin(process.env['ProgramFiles(x86)'] ?? '', 'cloudflared', 'cloudflared.exe'),
    pathJoin(process.env.ProgramFiles ?? '', 'cloudflared', 'cloudflared.exe'),
    pathJoin(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { timeout: 5000 })
    const first = stdout.split(/\r?\n/).find((l) => l.trim())
    if (first) return first.trim()
  } catch {
    // not found
  }
  return null
}

export async function cloudflaredAvailable(): Promise<boolean> {
  return !!(await findCloudflared())
}

export function installCloudflared(onLog: (s: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('winget', ['install', '-e', '--id', 'Cloudflare.cloudflared', '--accept-source-agreements', '--accept-package-agreements'], { windowsHide: true })
    p.stdout.on('data', (d) => onLog(String(d)))
    p.stderr.on('data', (d) => onLog(String(d)))
    p.on('exit', (c) => resolve(c === 0))
    p.on('error', (e) => {
      onLog(String(e))
      resolve(false)
    })
  })
}

function openTunnel(port: number): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise(async (resolve, reject) => {
    const exe = await findCloudflared()
    if (!exe) return reject(new Error('cloudflared is not installed'))
    const proc = spawn(exe, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { windowsHide: true })
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        proc.kill()
        reject(new Error('cloudflared did not report a URL in time'))
      }
    }, 30000)
    const onData = (d: Buffer) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(d.toString())
      if (m && !done) {
        done = true
        clearTimeout(timer)
        resolve({ proc, url: m[0] })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', () => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(new Error('cloudflared exited'))
      }
    })
  })
}

// =====================================================================================
// GUEST
// =====================================================================================
interface Guest {
  sessionId: string
  ws: WebSocket
  participantId: string
  participants: Participant[]
  pending: Map<string, (r: string) => void>
}
const guests = new Map<string, Guest>()

export function guestFor(sessionId: string): Guest | undefined {
  return guests.get(sessionId)
}

/** Parse an invite: either a code (base64url JSON) or "url key". */
export function parseInvite(input: string): { url: string; key: string } | null {
  const t = input.trim()
  try {
    const j = JSON.parse(Buffer.from(t, 'base64url').toString('utf8'))
    if (j.url && j.key) return { url: String(j.url), key: String(j.key) }
  } catch {
    // not a code
  }
  const m = /(https?:\/\/\S+)\s+(?:key:?\s*)?(\S+)/i.exec(t)
  if (m) return { url: m[1], key: m[2] }
  return null
}

export function inviteCode(url: string, key: string): string {
  return Buffer.from(JSON.stringify({ url, key })).toString('base64url')
}

/** Join a shared session; creates (or reuses) a local guest session and resolves once the transcript arrived. */
export async function join(url: string, key: string, name: string, existingSessionId?: string): Promise<Session> {
  const wsUrl = url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?key=' + encodeURIComponent(key)
  const ws = new WebSocket(wsUrl)
  return new Promise<Session>((resolve, reject) => {
    let settled = false
    const g: Guest = { sessionId: existingSessionId ?? randomUUID(), ws, participantId: '', participants: [], pending: new Map() }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('The host did not answer in time.'))
      }
    }, 20000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name } satisfies GuestToHost)))
    ws.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(/401/.test(e.message) ? 'Wrong invite key.' : e.message))
      }
    })
    ws.on('message', async (raw) => {
      let msg: HostToGuest
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'hello') {
        g.participantId = msg.participantId
        g.participants = msg.participants
        guests.set(g.sessionId, g)
        const st = getSettings()
        const local = (await loadSession(g.sessionId)) ?? ({} as Partial<Session>)
        const s: Session = {
          ...msg.session,
          id: g.sessionId,
          workspace: undefined,
          model: local.model ?? st.defaultModel,
          effort: local.effort ?? st.defaultEffort,
          mode: local.mode ?? st.defaultMode,
          moduleId: local.moduleId,
          providerSessions: local.providerSessions ?? {},
          notes: undefined,
          sharing: { role: 'guest', url, key, hostName: msg.hostName, active: true },
          title: `${msg.session.title} (shared by ${msg.hostName})`
        }
        ;(s as any).hostWorkspace = msg.session.workspace
        await saveSession(s)
        notify('session:updated', s)
        notify('share:participants', { sessionId: s.id, participants: g.participants })
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(s)
        }
      } else if (msg.type === 'session') {
        const local = await loadSession(g.sessionId)
        if (!local) return
        const merged: Session = { ...local, messages: msg.session.messages, kind: msg.session.kind, title: `${msg.session.title} (shared by ${local.sharing?.hostName ?? 'host'})` }
        ;(merged as any).hostWorkspace = msg.session.workspace
        await saveSession(merged)
        notify('session:updated', merged)
      } else if (msg.type === 'participants') {
        g.participants = msg.participants
        notify('share:participants', { sessionId: g.sessionId, participants: msg.participants })
      } else if (msg.type === 'rpc-result') {
        g.pending.get(msg.id)?.(msg.result)
        g.pending.delete(msg.id)
      } else if (msg.type === 'closed') {
        await markLeft(g.sessionId, 'The host stopped sharing.')
      } else if (msg.type === 'error') {
        notify('share:error', { sessionId: g.sessionId, message: msg.message })
      }
    })
    ws.on('close', () => {
      for (const r of g.pending.values()) r('Error: disconnected from the host.')
      g.pending.clear()
      if (guests.get(g.sessionId) === g) {
        guests.delete(g.sessionId)
        markLeft(g.sessionId, 'Disconnected from the host.')
      }
    })
  })
}

async function markLeft(sessionId: string, why: string): Promise<void> {
  const s = await loadSession(sessionId)
  if (!s) return
  if (s.sharing) s.sharing = { ...s.sharing, active: false }
  s.messages.push({ id: randomUUID(), role: 'system', content: why, createdAt: Date.now() })
  await saveSession(s)
  notify('session:updated', s)
  notify('share:participants', { sessionId, participants: [] })
}

export function leave(sessionId: string): void {
  const g = guests.get(sessionId)
  if (!g) return
  guests.delete(g.sessionId)
  g.ws.close()
  markLeft(sessionId, 'You left the shared session.')
}

export function guestSend(sessionId: string, msg: GuestToHost): void {
  const g = guests.get(sessionId)
  if (g && g.ws.readyState === WebSocket.OPEN) g.ws.send(JSON.stringify(msg))
}

export function guestRpc(sessionId: string, method: string, params: Record<string, unknown>): Promise<string> {
  const g = guests.get(sessionId)
  if (!g || g.ws.readyState !== WebSocket.OPEN) return Promise.resolve('Error: not connected to the host.')
  const id = randomUUID()
  return new Promise((resolve) => {
    g.pending.set(id, resolve)
    g.ws.send(JSON.stringify({ type: 'rpc', id, method, params } satisfies GuestToHost))
    setTimeout(() => {
      if (g.pending.has(id)) {
        g.pending.delete(id)
        resolve('Error: the host did not answer in time.')
      }
    }, 10 * 60 * 1000)
  })
}
