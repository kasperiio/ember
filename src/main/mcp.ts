// MCP servers: the user adds them once in Ember and every provider gets them.
// Claude Code gets an --mcp-config file, Codex a per-thread config override, Antigravity Ember-owned "ember-*"
// entries in its own mcp_config.json, and local models use Ember itself as the MCP client.
import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { tool, jsonSchema } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServer, McpTestResult } from '../shared/types'
import { listMcpServers } from './store'
import { extraPath } from './cli'

/** Provider-facing server name: lowercase letters, digits, '-' and '_'. */
export function slug(s: McpServer): string {
  return s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server'
}

function enabled(): McpServer[] {
  const seen = new Set<string>()
  return listMcpServers().filter((s) => s.enabled && (s.transport === 'http' ? s.url : s.command) && !seen.has(slug(s)) && seen.add(slug(s)))
}

// ---------- CLI providers ----------

/** Path of a Claude Code --mcp-config file for this session, or null when there are no servers. */
export function claudeMcpConfig(sessionId: string): string | null {
  const list = enabled()
  if (!list.length) return null
  const mcpServers = Object.fromEntries(
    list.map((s) => [slug(s), s.transport === 'http' ? { type: 'http', url: s.url, headers: s.headers ?? {} } : { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} }])
  )
  const file = join(os.tmpdir(), `ember-mcp-${sessionId}.json`)
  writeFileSync(file, JSON.stringify({ mcpServers }, null, 2))
  return file
}

/** Codex thread `config` override adding the servers (merged over ~/.codex/config.toml). */
export function codexMcpConfig(): Record<string, unknown> | null {
  const list = enabled()
  if (!list.length) return null
  return {
    mcp_servers: Object.fromEntries(
      list.map((s) => [slug(s), s.transport === 'http' ? { url: s.url, http_headers: s.headers ?? {} } : { command: s.command, args: s.args ?? [], env: s.env ?? {} }])
    )
  }
}

/**
 * Antigravity has no per-run MCP flag, so Ember keeps "ember-<name>" entries in ~/.gemini/config/mcp_config.json
 * (the file `agy mcp add` writes) and leaves every other entry alone.
 */
export function syncAntigravity(): void {
  const dir = join(os.homedir(), '.gemini', 'config')
  const file = join(dir, 'mcp_config.json')
  let cfg: any = {}
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // missing or unreadable: start fresh
  }
  const servers: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg.mcpServers ?? {})) if (!k.startsWith('ember-')) servers[k] = v
  for (const s of enabled())
    servers['ember-' + slug(s)] =
      s.transport === 'http' ? { serverUrl: s.url, headers: s.headers ?? {}, disabled: false } : { command: s.command, args: s.args ?? [], env: s.env ?? {}, disabled: false }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ ...cfg, mcpServers: servers }, null, 2))
  } catch {
    // Antigravity not set up on this PC; nothing to sync
  }
}

// ---------- Ember as the MCP client (local models, Test button) ----------

type Conn = { key: string; client: Client; tools: { name: string; description?: string; inputSchema: any; annotations?: any }[] }
const conns = new Map<string, Promise<Conn>>()

async function connect(s: McpServer): Promise<Client> {
  const client = new Client({ name: 'ember', version: '0.1.0' })
  if (s.transport === 'http') {
    const url = new URL(s.url!)
    const requestInit = { headers: s.headers ?? {} }
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
    } catch {
      // older servers only speak HTTP+SSE
      await client.connect(new SSEClientTransport(url, { requestInit }))
    }
  } else {
    const env = { ...(process.env as Record<string, string>), PATH: `${process.env.PATH};${extraPath()}`, ...(s.env ?? {}) }
    await client.connect(new StdioClientTransport({ command: s.command!, args: s.args ?? [], env, stderr: 'ignore' }))
  }
  return client
}

/** Connection to a server, reused across turns (onServersChanged drops it when its settings change). */
function conn(s: McpServer): Promise<Conn> {
  const cached = conns.get(s.id)
  if (cached) return cached
  const p = (async () => {
    const client = await connect(s)
    const tools = (await client.listTools()).tools
    return { key: JSON.stringify(s), client, tools }
  })()
  conns.set(s.id, p)
  p.catch(() => conns.delete(s.id))
  return p
}

function close(id: string): void {
  const p = conns.get(id)
  conns.delete(id)
  p?.then((c) => c.client.close()).catch(() => undefined)
}

export function closeAll(): void {
  for (const id of [...conns.keys()]) close(id)
}

/** Drop connections to servers that were removed or changed. */
export function onServersChanged(): void {
  const live = new Map(listMcpServers().map((s) => [s.id, JSON.stringify(s)]))
  for (const [id, p] of conns) p.then((c) => live.get(id) !== c.key && close(id)).catch(() => undefined)
  syncAntigravity()
}

export async function test(s: McpServer): Promise<McpTestResult> {
  const client = await connect(s).catch((e: any) => e as Error)
  if (client instanceof Error) return { ok: false, tools: [], error: client.message }
  try {
    const { tools } = await client.listTools()
    return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) }
  } catch (e: any) {
    return { ok: false, tools: [], error: e.message }
  } finally {
    client.close().catch(() => undefined)
  }
}

function resultText(r: any): string {
  const parts = (r.content ?? []).map((p: any) => (p.type === 'text' ? p.text : p.type === 'resource' ? (p.resource?.text ?? `[resource ${p.resource?.uri}]`) : `[${p.type}]`))
  if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent))
  const text = parts.join('\n').slice(0, 20000) || '(no output)'
  return r.isError ? 'Error: ' + text : text
}

/**
 * AI SDK tools for every enabled server's tools, named <server>__<tool>.
 * `gate` returns null to run the call, or a "Denied..." message.
 */
export async function localTools(gate: (title: string, detail: string, readOnly: boolean) => Promise<string | null>, onStatus: (s: string) => void): Promise<Record<string, any>> {
  const out: Record<string, any> = {}
  await Promise.all(
    enabled().map(async (s) => {
      let c: Conn
      try {
        c = await conn(s)
      } catch (e: any) {
        onStatus(`MCP server "${s.name}" did not start: ${e.message}`)
        return
      }
      for (const t of c.tools) {
        const name = `${slug(s)}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
        out[name] = tool({
          description: `[${s.name}] ${t.description ?? t.name}`.slice(0, 1024),
          inputSchema: jsonSchema(t.inputSchema ?? { type: 'object', properties: {} }),
          execute: async (args: any) => {
            const denied = await gate(`${s.name}: ${t.name}`, JSON.stringify(args, null, 2).slice(0, 4000), !!t.annotations?.readOnlyHint)
            if (denied) return denied
            try {
              return resultText(await c.client.callTool({ name: t.name, arguments: args ?? {} }))
            } catch (e: any) {
              close(s.id) // reconnect next time
              return `Error: ${e.message}`
            }
          }
        })
      }
    })
  )
  return out
}
