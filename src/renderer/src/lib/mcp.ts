import type { McpServer } from '../../../shared/types'

const newId = () => Math.random().toString(36).slice(2, 10)

function entry(name: string, e: any): McpServer | null {
  if (!e || typeof e !== 'object') return null
  const url = e.url ?? e.serverUrl ?? e.httpUrl
  const strMap = (m: any) => (m && typeof m === 'object' ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v)])) : undefined)
  if (typeof url === 'string') return { id: newId(), name, enabled: e.disabled !== true, transport: 'http', url, headers: strMap(e.headers) }
  if (typeof e.command === 'string') {
    // Some configs put the whole command line in "command".
    const [command, ...rest] = Array.isArray(e.args) ? [e.command] : e.command.trim().split(/\s+/)
    return { id: newId(), name, enabled: e.disabled !== true, transport: 'stdio', command, args: Array.isArray(e.args) ? e.args.map(String) : rest, env: strMap(e.env) }
  }
  return null
}

/**
 * Servers from pasted JSON: `{"mcpServers": {...}}` (Claude Desktop, Cursor, Antigravity), `{"servers": {...}}` (VS Code),
 * a bare `{name: {...}}` map, or one server object with a "name".
 */
export function parseMcpJson(text: string): McpServer[] {
  const j = JSON.parse(text)
  const map = j.mcpServers ?? j.servers ?? j.mcp_servers
  if (map && typeof map === 'object') return Object.entries(map).map(([n, e]) => entry(n, e)).filter((s): s is McpServer => !!s)
  if (typeof j.name === 'string') return [entry(j.name, j)].filter((s): s is McpServer => !!s)
  return Object.entries(j).map(([n, e]) => entry(n, e)).filter((s): s is McpServer => !!s)
}

export function describe(s: McpServer): string {
  return s.transport === 'http' ? (s.url ?? '') : [s.command, ...(s.args ?? [])].join(' ')
}
