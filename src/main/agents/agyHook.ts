// Approval bridge for Antigravity CLI. Headless `agy` cannot prompt, so Ember runs it with
// --dangerously-skip-permissions and gates every tool call with a PreToolUse hook instead:
// the hook (a tiny script run by Ember's own executable in Node mode) posts the tool call to a
// localhost endpoint here and prints the user's decision back to agy.
// The hook lives in the shared ~/.gemini/config/hooks.json and is a no-op (`echo {}`) unless the
// agy process was started by Ember with EMBER_AGY_HOOK set, so plain `agy` use is unaffected.
import { createServer, type Server } from 'http'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { app } from 'electron'

export interface HookDecision {
  decision: 'allow' | 'deny'
  reason?: string
}
export type HookHandler = (toolName: string, args: Record<string, any>) => Promise<HookDecision>

const HOOK_NAME = 'ember-approvals'
const HOOKS_FILE = join(os.homedir(), '.gemini', 'config', 'hooks.json')
// No quotes here: agy escapes them when it hands the command to `cmd /c`. The quoted
// invocation lives in the environment variable, which cmd expands before parsing.
const HOOK_COMMAND = 'if defined EMBER_AGY_HOOK (%EMBER_AGY_HOOK%) else (echo {})'

const SCRIPT = `// Written by Ember: forwards an Antigravity PreToolUse hook call to Ember and prints the decision.
const http = require('http')
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0) }
  const url = process.env.EMBER_AGY_URL
  if (!url) return out({})
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let body = ''
    res.on('data', (d) => (body += d))
    res.on('end', () => { try { out(JSON.parse(body)) } catch { out({ decision: 'deny', reason: 'Ember returned an invalid answer.' }) } })
  })
  req.on('error', () => out({ decision: 'deny', reason: 'Ember is not reachable, so the action was not approved.' }))
  req.end(input)
})
`

const handlers = new Map<string, HookHandler>()
let server: Server | null = null
let port = 0

async function ensureServer(): Promise<number> {
  if (server) return port
  server = createServer((req, res) => {
    const token = (req.url ?? '').slice(1)
    const handler = handlers.get(token)
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      let answer: HookDecision = { decision: 'deny', reason: 'This Ember run has ended.' }
      if (handler) {
        try {
          const payload = JSON.parse(body || '{}')
          answer = await handler(String(payload.toolCall?.name ?? ''), payload.toolCall?.args ?? {})
        } catch (e: any) {
          answer = { decision: 'deny', reason: 'Ember could not evaluate the action: ' + (e?.message ?? e) }
        }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as any).port
  return port
}

function ensureScript(): string {
  const dir = join(app.getPath('userData'), 'hooks')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'agy-pretool.js')
  if (!existsSync(file) || readFileSync(file, 'utf8') !== SCRIPT) writeFileSync(file, SCRIPT)
  return file
}

/** Add (or repair) Ember's named hook in the shared hooks.json, leaving everything else untouched. */
function ensureHooksFile(): void {
  let cfg: Record<string, any> = {}
  if (existsSync(HOOKS_FILE)) {
    try {
      cfg = JSON.parse(readFileSync(HOOKS_FILE, 'utf8').replace(/^﻿/, ''))
    } catch {
      throw new Error(`Could not read ${HOOKS_FILE}; fix or remove it so Ember can add its approval hook.`)
    }
  }
  const want = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 86400 }] }] }
  if (JSON.stringify(cfg[HOOK_NAME]) === JSON.stringify(want)) return
  cfg[HOOK_NAME] = want
  mkdirSync(join(os.homedir(), '.gemini', 'config'), { recursive: true })
  writeFileSync(HOOKS_FILE, JSON.stringify(cfg, null, 2) + '\n')
}

/** Register a handler for one agy run; returns the env vars to start agy with and a dispose function. */
export async function openAgyHook(handler: HookHandler): Promise<{ env: Record<string, string>; dispose: () => void }> {
  ensureHooksFile()
  const script = ensureScript()
  const p = await ensureServer()
  const token = randomUUID()
  handlers.set(token, handler)
  return {
    env: {
      EMBER_AGY_HOOK: `set ELECTRON_RUN_AS_NODE=1&& "${process.execPath}" "${script}"`,
      EMBER_AGY_URL: `http://127.0.0.1:${p}/${token}`
    },
    dispose: () => handlers.delete(token)
  }
}
