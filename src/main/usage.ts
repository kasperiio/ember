// Per-provider subscription usage, as reported by the official CLIs while they run.
// Adapters call reportUsage(); the renderer receives 'usage:updated' and reads getUsage().
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import type { ProviderId, ProviderUsage, UsageWindow } from '../shared/types'

let win: BrowserWindow | null = null
const usage = new Map<ProviderId, ProviderUsage>()
let loaded = false

const file = () => join(app.getPath('userData'), 'data', 'usage.json')

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(file())) for (const u of JSON.parse(readFileSync(file(), 'utf8')) as ProviderUsage[]) usage.set(u.provider, u)
  } catch {
    // ignore corrupt cache
  }
}

export function bindWindow(w: BrowserWindow): void {
  win = w
}

export function getUsage(): ProviderUsage[] {
  load()
  const now = Date.now()
  // Windows that have reset since the last report are shown as fresh.
  return [...usage.values()].map((u) => ({
    ...u,
    windows: u.windows.map((w) => (w.resetsAt && w.resetsAt < now ? { ...w, utilization: 0, status: 'ok' as const } : w)),
    status: u.windows.every((w) => w.resetsAt && w.resetsAt < now) && u.windows.length ? 'ok' : u.status
  }))
}

/**
 * Record what a provider reported. `windows` replace any previous window with the same label; other
 * windows are kept. Call with status 'limited' when the CLI refused a turn because the plan is exhausted.
 *
 * Example (Claude Code rate_limit_event):
 *   reportUsage('claude', { status: 'warning', windows: [{ label: '5-hour', utilization: 85, resetsAt: 1760000000000, status: 'warning' }] })
 */
export function reportUsage(provider: ProviderId, patch: { status?: ProviderUsage['status']; windows?: UsageWindow[]; plan?: string; note?: string }): ProviderUsage {
  load()
  const prev = usage.get(provider) ?? { provider, status: 'ok' as const, windows: [], updatedAt: 0 }
  const windows = [...prev.windows]
  for (const w of patch.windows ?? []) {
    const i = windows.findIndex((x) => x.label === w.label)
    if (i >= 0) windows[i] = w
    else windows.push(w)
  }
  const worst = (list: Array<'ok' | 'warning' | 'limited'>) => (list.includes('limited') ? 'limited' : list.includes('warning') ? 'warning' : 'ok')
  const next: ProviderUsage = {
    provider,
    windows,
    status: patch.status ?? worst(windows.map((w) => w.status)),
    plan: patch.plan ?? prev.plan,
    note: patch.note ?? prev.note,
    updatedAt: Date.now()
  }
  usage.set(provider, next)
  try {
    mkdirSync(join(app.getPath('userData'), 'data'), { recursive: true })
    writeFileSync(file(), JSON.stringify([...usage.values()], null, 2))
  } catch {
    // best effort
  }
  win?.webContents.send('usage:updated', getUsage())
  return next
}

/** Thrown by adapters when the provider refused the turn because the plan limit is reached. */
export class ProviderLimitError extends Error {
  constructor(
    public provider: ProviderId,
    message: string,
    public resetsAt?: number
  ) {
    super(message)
    this.name = 'ProviderLimitError'
  }
}

/** Heuristic for CLI error text that means "plan limit reached". */
export function looksLikeLimit(text: string): boolean {
  return /rate.?limit|usage limit|limit (has been |was )?reached|out of (usage|credits|quota)|quota exceeded|too many requests|\b429\b|try again (at|in|after)|resets? (at|in)/i.test(text)
}
