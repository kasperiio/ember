// Orchestrates one conversation turn: checkpoint, run the agent, self-check loop, persist, share.
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import type { AgentEvent, Attachment, ChatMessage, Session } from '../shared/types'
import { getSettings, listModules, loadSession, saveSession } from './store'
import { projectInstructions } from './workspace'
import { detectChecks, runChecks } from './checks'
import * as checkpoints from './checkpoints'
import * as permissions from './permissions'
import * as sharing from './sharing'
import { ProviderLimitError } from './usage'
import { claudeAgent } from './agents/claude'
import { codexAgent } from './agents/codex'
import { geminiAgent } from './agents/gemini'
import { localAgent, summarise } from './agents/local'
import type { Agent } from './agents/types'

const agents: Record<string, Agent> = { ollama: localAgent, claude: claudeAgent, codex: codexAgent, gemini: geminiAgent }
const running = new Map<string, AbortController>()
let win: BrowserWindow | null = null

export function bindWindow(w: BrowserWindow): void {
  win = w
}

function emit(sessionId: string, ev: AgentEvent, messageId: string): void {
  win?.webContents.send('agent:event', { sessionId, messageId, ev })
}

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId)
}

export function stop(sessionId: string): void {
  running.get(sessionId)?.abort()
  permissions.cancelAllFor(sessionId)
}

export function scratchCwd(session: Session): string {
  if (session.workspace) return session.workspace
  const d = join(app.getPath('userData'), 'scratch', session.id)
  mkdirSync(d, { recursive: true })
  return d
}

/** Apply streamed events to the message object so snapshots (reloads, guests) see partial output. */
function applyEvent(m: ChatMessage, ev: AgentEvent): void {
  switch (ev.type) {
    case 'text':
      m.content += ev.delta
      break
    case 'reasoning':
      m.reasoning = (m.reasoning ?? '') + ev.delta
      break
    case 'tool-start':
      m.toolCalls = [...(m.toolCalls ?? []), { id: ev.id, name: ev.name, input: ev.input, status: 'running' }]
      break
    case 'tool-end':
      m.toolCalls = (m.toolCalls ?? []).map((t) => (t.id === ev.id ? { ...t, output: ev.output, status: ev.status, files: ev.files } : t))
      break
  }
}

/** Messages other participants added since this participant's last assistant reply (for CLI providers that keep their own context). */
function othersSinceLastReply(session: Session, me: string): ChatMessage[] {
  const msgs = session.messages
  let i = msgs.length - 1
  for (; i >= 0; i--) if (msgs[i].role === 'assistant' && (msgs[i].author ?? me) === me + "'s assistant") break
  return msgs.slice(i + 1).filter((m) => m.role !== 'system' && m.author && m.author !== me && m.author !== me + "'s assistant")
}

export async function runTurn(sessionId: string, prompt: string, attachments: Attachment[]): Promise<void> {
  const session = await loadSession(sessionId)
  if (!session) throw new Error('Session not found')
  if (running.has(sessionId)) throw new Error('A turn is already running')
  const ac = new AbortController()
  running.set(sessionId, ac)
  const settings = getSettings()
  const cwd = scratchCwd(session)
  const shared = !!session.sharing?.active
  const isGuest = shared && session.sharing!.role === 'guest'
  const me = settings.displayName

  // Persist + notify + (host) broadcast, throttled for streaming.
  let lastBroadcast = 0
  let pendingBroadcast: NodeJS.Timeout | null = null
  const publish = async (force = false) => {
    await saveSession(session)
    win?.webContents.send('session:updated', session)
    if (!shared || isGuest) return
    const now = Date.now()
    if (force || now - lastBroadcast > 400) {
      lastBroadcast = now
      sharing.broadcastSession(session)
    } else if (!pendingBroadcast) {
      pendingBroadcast = setTimeout(() => {
        pendingBroadcast = null
        lastBroadcast = Date.now()
        sharing.broadcastSession(session)
      }, 400)
    }
  }
  // Guests send their in-progress assistant message to the host, throttled.
  let lastGuestPush = 0
  const pushGuestAssistant = (m: ChatMessage, final: boolean) => {
    const now = Date.now()
    if (!final && now - lastGuestPush < 500) return
    lastGuestPush = now
    sharing.guestSend(sessionId, { type: 'assistant', message: m, final })
  }

  try {
    // 1. checkpoint + user message
    let checkpoint: string | undefined
    if (session.kind === 'code' && session.workspace) {
      try {
        checkpoint = await checkpoints.snapshot(session.workspace)
      } catch (e: any) {
        emit(sessionId, { type: 'status', text: 'Checkpoint failed: ' + e.message }, '')
      }
    }
    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', content: prompt, attachments, checkpoint, createdAt: Date.now(), moduleId: session.moduleId, author: shared ? me : undefined }
    session.messages.push(userMsg)
    if (session.messages.filter((m) => m.role === 'user').length === 1 && !isGuest) session.title = prompt.replace(/\s+/g, ' ').slice(0, 60) || session.title
    await publish(true)
    if (isGuest) sharing.guestSend(sessionId, { type: 'message', message: { ...userMsg, attachments: [] } })

    // 2. system instructions
    const mod = listModules().find((m) => m.id === session.moduleId)
    const model = mod?.model ?? session.model
    const effort = mod?.effort ?? session.effort
    const mode = mod?.mode ?? session.mode
    const sys = [session.workspace ? projectInstructions(session.workspace) : '', mod ? `# ${mod.name}\n${mod.instructions}` : ''].filter(Boolean).join('\n\n')

    // CLI providers keep their own conversation; hand them what other participants said meanwhile.
    let turnPrompt = prompt
    if (shared && model.provider !== 'ollama') {
      const others = othersSinceLastReply(session, me).filter((m) => m.id !== userMsg.id)
      const ctx = others.map((m) => `[${m.author}]: ${m.content}`).join('\n\n')
      turnPrompt = `${ctx ? `Messages from other participants in this shared session since your last reply:\n\n${ctx}\n\n` : ''}[${me}]: ${prompt}`
    }

    // Switching to a CLI provider mid-conversation: it has no context yet, so hand it the conversation so far.
    if (model.provider !== 'ollama' && !(session.providerSessions as any)[model.provider]) {
      const prior = session.messages.filter((m) => m.id !== userMsg.id && (m.role === 'user' || m.role === 'assistant') && m.content)
      if (prior.length) {
        const transcript = prior
          .slice(-40)
          .map((m) => `${m.role === 'user' ? (m.author ?? 'User') : (m.author ?? 'Assistant')}: ${m.content.slice(0, 4000)}`)
          .join('\n\n')
        turnPrompt = `<conversation_so_far>
This conversation started with another assistant; here is what was said before you joined.

${transcript.slice(-60000)}
</conversation_so_far>

${turnPrompt}`
      }
    }

    // 3. run, with self-check retries
    let turnAttachments = attachments
    const maxAttempts = session.kind === 'code' && session.workspace && settings.selfCheck ? settings.selfCheckRetries + 1 : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const asst: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', model, moduleId: mod?.id, createdAt: Date.now(), author: shared ? me + "'s assistant" : undefined, participantId: isGuest ? sharing.guestFor(sessionId)?.participantId : undefined }
      session.messages.push(asst)
      await publish(true)
      const historySession: Session = { ...session, messages: session.messages.filter((m) => m.id !== asst.id && m.id !== userMsg.id) }

      const agent = agents[model.provider]
      try {
        const out = await agent({
          session: historySession,
          prompt: turnPrompt,
          attachments: turnAttachments,
          system: sys,
          cwd,
          mode,
          effort,
          model,
          signal: ac.signal,
          emit: (ev) => {
            applyEvent(asst, ev)
            emit(sessionId, ev, asst.id)
            if (shared && !isGuest && (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool-start' || ev.type === 'tool-end')) void publish()
            if (isGuest && (ev.type === 'text' || ev.type === 'tool-start' || ev.type === 'tool-end')) pushGuestAssistant(asst, false)
          },
          approve: async (kind, title, detail, diff) => {
            if (mode === 'bypass') return true
            if (mode === 'plan') return false
            return permissions.ask({ sessionId, kind, title, detail, diff })
          }
        })
        asst.content = out.text
        asst.reasoning = out.reasoning || undefined
        asst.toolCalls = out.toolCalls
        asst.stats = out.stats
        if (out.providerSessionId && model.provider !== 'ollama') (session.providerSessions as any)[model.provider] = out.providerSessionId
        await publish(true)
        if (isGuest) pushGuestAssistant(asst, true)

        // self-check (host only; guests have no local workspace)
        const touched = out.filesChanged.length > 0 || out.toolCalls.some((t) => t.files?.length)
        if (session.kind === 'code' && session.workspace && settings.selfCheck && touched && !ac.signal.aborted) {
          const checks = detectChecks(session.workspace)
          if (checks.length) {
            emit(sessionId, { type: 'status', text: `Self-check (${checks.map((c) => c.label).join(', ')})...` }, asst.id)
            const r = await runChecks(session.workspace, checks)
            asst.selfCheck = { attempt, ok: r.ok, output: r.output.slice(-6000) }
            emit(sessionId, { type: 'self-check', attempt, ok: r.ok, output: asst.selfCheck.output }, asst.id)
            await publish(true)
            if (!r.ok && attempt < maxAttempts) {
              turnPrompt = `The project checks failed after your changes. Fix the errors below, then stop.\n\n${r.output.slice(-8000)}`
              turnAttachments = []
              session.messages.push({ id: randomUUID(), role: 'system', content: `Self-check failed (attempt ${attempt}/${maxAttempts - 1}); asking the AI to fix it.`, createdAt: Date.now() })
              continue
            }
          }
        }
        emit(sessionId, { type: 'done', stats: out.stats }, asst.id)
      } catch (e: any) {
        asst.error = ac.signal.aborted ? 'Stopped.' : String(e?.message ?? e)
        if (e instanceof ProviderLimitError) {
          asst.limit = { provider: e.provider, resetsAt: e.resetsAt }
          emit(sessionId, { type: 'limit', provider: e.provider, resetsAt: e.resetsAt, message: asst.error }, asst.id)
        }
        emit(sessionId, { type: 'error', message: asst.error }, asst.id)
        await publish(true)
        if (isGuest) pushGuestAssistant(asst, true)
      }
      break
    }

    // 4. long sessions (local provider, which gets the full history from Ember): when the context window is
    // getting full, condense the older half of the conversation into notes instead of dropping it.
    // The CLI providers manage their own context and compact themselves.
    const lastStats = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.stats?.contextTokens)?.stats
    const contextFill = lastStats?.contextTokens && lastStats.contextLimit ? lastStats.contextTokens / lastStats.contextLimit : 0
    if (model.provider === 'ollama' && !shared && (contextFill >= 0.8 || session.messages.length > 60)) {
      try {
        emit(sessionId, { type: 'status', text: `Context ${Math.round(contextFill * 100)}% full; condensing older messages...` }, '')
        const keep = Math.max(4, Math.floor(session.messages.length / 2))
        const old = session.messages.slice(0, session.messages.length - keep)
        const transcript = old.map((m) => `${m.author ?? m.role}: ${m.content}`).join('\n\n')
        session.notes = ((session.notes ?? '') + '\n' + (await summarise(model.model, transcript))).trim()
        session.messages = [
          { id: randomUUID(), role: 'system', content: `Condensed ${old.length} older messages into notes to free up context.`, createdAt: Date.now() },
          ...session.messages.slice(-keep)
        ]
        await saveSession(session)
      } catch {
        // keep going without compaction
      }
    }
    await publish(true)
  } finally {
    if (pendingBroadcast) clearTimeout(pendingBroadcast)
    running.delete(sessionId)
  }
}

/** /compact for local sessions. */
export async function compact(sessionId: string): Promise<Session | null> {
  const session = await loadSession(sessionId)
  if (!session) return null
  if (session.model.provider !== 'ollama') {
    // CLIs manage their own context; starting a fresh provider session is the equivalent.
    session.providerSessions = {}
    session.messages.push({ id: randomUUID(), role: 'system', content: 'Context reset for the provider. The next message starts a fresh provider session.', createdAt: Date.now() })
  } else {
    const transcript = session.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n')
    session.notes = await summarise(session.model.model, transcript)
    session.messages = [{ id: randomUUID(), role: 'system', content: 'Conversation condensed into notes.', createdAt: Date.now() }]
  }
  await saveSession(session)
  return session
}

/** Rewind: restore files and/or conversation to the checkpoint taken before a user message. */
export async function rewind(sessionId: string, messageId: string, what: 'files' | 'conversation' | 'both'): Promise<Session | null> {
  const session = await loadSession(sessionId)
  if (!session) return null
  const idx = session.messages.findIndex((m) => m.id === messageId)
  if (idx < 0) return session
  const msg = session.messages[idx]
  if (what !== 'conversation' && msg.checkpoint && session.workspace) {
    // keep an "undo" snapshot so the rewind itself can be reverted
    const undo = await checkpoints.snapshot(session.workspace)
    await checkpoints.restore(session.workspace, msg.checkpoint)
    session.messages.push({ id: randomUUID(), role: 'system', content: `Files rewound to before "${msg.content.slice(0, 40)}".`, checkpoint: undo, createdAt: Date.now() })
  }
  if (what !== 'files') {
    session.messages = session.messages.slice(0, idx)
    session.providerSessions = {} // provider conversations cannot be truncated; start fresh
  }
  await saveSession(session)
  sharing.broadcastSession(session)
  return session
}
