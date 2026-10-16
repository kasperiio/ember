// "Ember awareness": a short briefing added to every session's system instructions, so the AI knows the app it runs in,
// can propose AI Modules, local models and MCP servers. Proposals are fenced blocks the chat renders as action cards;
// nothing changes until the user clicks.
import type { Hardware } from '../shared/types'
import { listMcpServers, listModules } from './store'
import { recommend, scanHardware } from './hardware'
import * as ollama from './ollama'
import * as cli from './cli'

let hwCache: { at: number; hw: Hardware } | null = null

async function hardware(): Promise<Hardware | null> {
  if (hwCache && Date.now() - hwCache.at < 10 * 60_000) return hwCache.hw
  try {
    hwCache = { at: Date.now(), hw: await scanHardware() }
    return hwCache.hw
  } catch {
    return null
  }
}

export async function emberContext(): Promise<string> {
  const [hw, installed, claudeModels, codexModels] = await Promise.all([
    hardware(),
    ollama.listModels().catch(() => null),
    cli.models('claude'),
    cli.models('codex')
  ])
  const modules = listModules()

  const hwLine = hw
    ? `${hw.cpu} (${hw.cores} threads), ${hw.ramGb} GB RAM, ` +
      (hw.gpus.length ? hw.gpus.map((g) => `${g.name} ${g.vramGb} GB VRAM`).join(', ') : 'no dedicated GPU detected')
    : 'unknown'
  const localLine = installed == null ? 'Ollama is not running or not installed.' : installed.length ? installed.map((m) => m.name).join(', ') : 'none yet'
  const recs = hw
    ? recommend(hw, installed ?? [])
        .filter((r) => r.fits !== 'no')
        .map((r) => `- ${r.tag} (${r.name}, ~${r.sizeGb} GB, ${r.fits === 'gpu' ? 'runs on GPU' : 'CPU only, slow'}${r.tools ? ', tools' : ''}${r.vision ? ', vision' : ''}${r.thinking ? ', thinking' : ''})`)
        .join('\n')
    : ''
  const moduleLines = modules.length
    ? modules.map((m) => `- ${m.name}${m.model ? ` [${m.model.provider}${m.model.model ? ' ' + m.model.model : ''}]` : ''}: ${m.instructions.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    : '- none yet'
  const servers = listMcpServers()
  const mcpLines = servers.length
    ? servers.map((s) => `- ${s.name} (${s.enabled ? 'enabled' : 'disabled'}): ${s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ')}`).join('\n')
    : '- none yet'

  return `# About Ember (the app you are running in)

Ember is a desktop AI chat and coding app. The user talks to you through it; it drives Claude Code, Codex and Antigravity with the user's own subscription (no API keys) and runs free local models through Ollama.
Pages: chat/coding sessions, Discover (local models for this PC), Accounts (sign in to the CLIs), AI Modules, Settings.
AI Modules are named assistants with their own instructions and optionally their own model, effort and permission mode; the user switches between them inside a conversation and they share its history.

Only when the user asks for a module or for a local model (or it clearly helps), propose one with a fenced block. Ember shows it as a card with a button; you cannot create or install anything yourself, so do not claim you did. Put each proposal in its own block with valid JSON.

\`\`\`ember-module
{"name": "Reviewer", "instructions": "You review code and only critique...", "model": {"provider": "claude", "model": "claude-opus-5-5"}, "effort": "high", "mode": "plan"}
\`\`\`
Fields: name and instructions are required (write instructions as a full system prompt in second person). model, effort ("low" | "medium" | "high") and mode ("auto" | "manual" | "acceptEdits" | "plan" (read-only) | "bypass") are optional; leave them out to use the session's. Providers: "ollama" (model = an installed tag), "claude" (${claudeModels.map((m) => m.id).join(', ')}), "codex" (${codexModels.map((m) => m.id).join(', ')}), "gemini" (model "" = Antigravity default). Using a module's name again updates that module.

\`\`\`ember-model
{"tag": "qwen3:8b", "reason": "Fast general model that fits your GPU"}
\`\`\`
tag is any Ollama library tag. Prefer models that fit in VRAM; CPU-only ones work but are slow. Tool use is needed for coding sessions with local models.

MCP servers (MCP servers page) give every provider extra tools. Propose one with the server's official config; never invent package names, and use placeholders like "<your token>" for secrets the user must fill in:
\`\`\`ember-mcp
{"name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "<your token>"}}
\`\`\`
Remote servers use {"name": ..., "url": "https://...", "headers": {...}} instead of command/args/env. New servers apply from the next message.

## This PC
Hardware: ${hwLine}
Installed local models: ${localLine}
${recs ? `Catalogue models that fit (biggest first; newer Ollama models may also suit):\n${recs}` : ''}

## The user's AI Modules
${moduleLines}

## The user's MCP servers
${mcpLines}`
}
