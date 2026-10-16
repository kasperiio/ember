// Approval requests that the renderer must answer (Manual / Auto modes).
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { ApprovalRequest, PermissionMode } from '../shared/types'

type Pending = { req: ApprovalRequest; resolve: (ok: boolean) => void }
const pending = new Map<string, Pending>()
let win: BrowserWindow | null = null

export function bindWindow(w: BrowserWindow): void {
  win = w
}

export function ask(req: Omit<ApprovalRequest, 'id'>): Promise<boolean> {
  const full: ApprovalRequest = { id: randomUUID(), ...req }
  return new Promise((resolve) => {
    pending.set(full.id, { req: full, resolve })
    win?.webContents.send('approval:request', full)
  })
}

export function answer(id: string, ok: boolean): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  p.resolve(ok)
}

export function cancelAllFor(sessionId: string): void {
  for (const [id, p] of pending) {
    if (p.req.sessionId === sessionId) {
      pending.delete(id)
      p.resolve(false)
    }
  }
}

/** Does this action need a human in the loop under the given mode? */
export function needsApproval(mode: PermissionMode, kind: ApprovalRequest['kind']): boolean {
  switch (mode) {
    case 'bypass':
      return false
    case 'plan':
      return true // plan mode never writes; callers deny before asking
    case 'acceptEdits':
      return kind !== 'edit'
    case 'auto':
      return kind === 'command' || kind === 'other'
    case 'manual':
      return true
  }
}
