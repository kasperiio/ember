import { app } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AiModule, McpServer, Session, SessionSummary, Settings } from '../shared/types'

const dataDir = () => join(app.getPath('userData'), 'data')
const sessionsDir = () => join(dataDir(), 'sessions')

function ensure(): void {
  mkdirSync(sessionsDir(), { recursive: true })
}

export const defaultSettings = (): Settings => ({
  theme: 'system',
  displayName: (() => {
    try {
      return require('os').userInfo().username as string
    } catch {
      return 'Me'
    }
  })(),
  ollamaHost: 'http://127.0.0.1:11434',
  defaultModel: { provider: 'ollama', model: '' },
  defaultMode: 'auto',
  defaultEffort: 'medium',
  defaultChatEffort: 'low',
  selfCheck: true,
  selfCheckRetries: 3,
  webSearch: true,
  emberAware: true,
  scratchRoot: join(app.getPath('documents'), 'Ember Projects'),
  keepInTray: true,
  unloadOnClose: true
})

let settingsCache: Settings | null = null

export function getSettings(): Settings {
  if (settingsCache) return settingsCache
  ensure()
  const file = join(dataDir(), 'settings.json')
  let saved: Partial<Settings> = {}
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // ignore corrupt settings
    }
  }
  settingsCache = { ...defaultSettings(), ...saved }
  return settingsCache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  settingsCache = next
  writeFileSync(join(dataDir(), 'settings.json'), JSON.stringify(next, null, 2))
  return next
}

// ---------- sessions ----------

const sessionFile = (id: string) => join(sessionsDir(), `${id}.json`)

function summary(s: Session): SessionSummary {
  return { id: s.id, kind: s.kind, title: s.title, workspace: s.workspace, archived: s.archived, updatedAt: s.updatedAt }
}

export async function listSessions(): Promise<SessionSummary[]> {
  ensure()
  const files = await fs.readdir(sessionsDir())
  const out: SessionSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(summary(JSON.parse(await fs.readFile(join(sessionsDir(), f), 'utf8')) as Session))
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    return JSON.parse(await fs.readFile(sessionFile(id), 'utf8')) as Session
  } catch {
    return null
  }
}

export async function saveSession(s: Session): Promise<void> {
  ensure()
  s.updatedAt = Date.now()
  await fs.writeFile(sessionFile(s.id), JSON.stringify(s, null, 2))
}

export async function deleteSession(id: string): Promise<void> {
  await fs.rm(sessionFile(id), { force: true })
}

export function newSession(init: Partial<Session> & Pick<Session, 'kind'>): Session {
  const st = getSettings()
  return {
    id: randomUUID(),
    title: init.kind === 'code' ? 'New coding session' : 'New chat',
    model: st.defaultModel,
    effort: init.kind === 'chat' ? st.defaultChatEffort : st.defaultEffort,
    mode: st.defaultMode,
    messages: [],
    providerSessions: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...init
  }
}

export async function searchSessions(query: string): Promise<SessionSummary[]> {
  const q = query.toLowerCase()
  const files = await fs.readdir(sessionsDir())
  const out: SessionSummary[] = []
  for (const f of files) {
    try {
      const s = JSON.parse(await fs.readFile(join(sessionsDir(), f), 'utf8')) as Session
      const hay = (s.title + '\n' + s.messages.map((m) => m.content).join('\n')).toLowerCase()
      if (hay.includes(q)) out.push(summary(s))
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ---------- modules ----------

export function listModules(): AiModule[] {
  ensure()
  const file = join(dataDir(), 'modules.json')
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function saveModules(mods: AiModule[]): void {
  ensure()
  writeFileSync(join(dataDir(), 'modules.json'), JSON.stringify(mods, null, 2))
}

// ---------- MCP servers ----------

export function listMcpServers(): McpServer[] {
  ensure()
  const file = join(dataDir(), 'mcp.json')
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function saveMcpServers(list: McpServer[]): void {
  ensure()
  writeFileSync(join(dataDir(), 'mcp.json'), JSON.stringify(list, null, 2))
}

export function attachmentsDir(): string {
  const d = join(dataDir(), 'attachments')
  mkdirSync(d, { recursive: true })
  return d
}

export function checkpointsRoot(): string {
  const d = join(dataDir(), 'checkpoints')
  mkdirSync(d, { recursive: true })
  return d
}
