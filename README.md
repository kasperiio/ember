# Ember

[![CI](https://github.com/kasperiio/ember/actions/workflows/ci.yml/badge.svg)](https://github.com/kasperiio/ember/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kasperiio/ember?display_name=tag)](https://github.com/kasperiio/ember/releases/latest)

Chat and code with AI on your own PC. Run free local models on your graphics card through Ollama, or use the Claude, ChatGPT or Google plans you already pay for. No API keys, no pay-per-use, no Ember account.

Ember is a Windows desktop app (Electron + React + TypeScript).

## How "bring your own AI" works

Ember never asks for an API key and never calls pay-per-use API models. For cloud providers it drives each vendor's **official** command-line tool, which handles sign-in in your browser and keeps the token on your PC. Usage counts against your plan's limits, not against credits, and Ember shows how much of each plan's window you have used.

| Provider | Tool Ember drives | Sign-in |
|---|---|---|
| Local models | Ollama | none |
| Claude | Claude Code (`claude`) | `claude auth login` (Claude Pro / Max) |
| ChatGPT / Codex | Codex CLI (`codex`) | `codex login` (ChatGPT Plus / Pro / Team) |
| Google | Antigravity CLI (`agy`) | Google account (Gemini CLI is being retired by Google in June 2026) |

The Accounts page installs the tools and opens the sign-in flow in an embedded terminal.

## Features

- **Chat**: streaming replies, collapsible reasoning for thinking models, effort control, file and image attachments, link reading (web pages, PDFs, YouTube transcripts) for local models, searchable history, slash commands (`/model`, `/mode`, `/effort`, `/module`, `/compact`, `/new`, `/check`, `/commit`).
- **Internet research** for local models: the model asks, Ember searches DuckDuckGo. Only scrubbed search terms leave the PC (paths, URLs, emails and keys are removed). Models without tool support get host-assisted search.
- **Code workspace**: open any folder or start a scratch project. File explorer with git status, Monaco editor with tabs, project search, embedded PowerShell terminals (node-pty), live view of files the AI writes, preview browser that picks up `localhost` URLs from the terminal. Reads `EMBER.md`, `AGENTS.md` or `CLAUDE.md` for project instructions.
- **Permission modes**: Auto, Manual, Accept edits, Plan (read-only), Bypass. All three providers ask for approval through Ember: Claude Code over its stdio permission protocol, Codex through `codex app-server` approval requests, and Antigravity CLI through a PreToolUse hook (`ember-approvals` in `~/.gemini/config/hooks.json`, a no-op outside Ember).
- **Self-checking debug loop**: after the AI edits files, Ember detects the project type (npm/TypeScript, Python, Cargo, Go, .NET, CMake, Maven, Gradle) and runs compile / test commands. Failures go back to the AI, which retries up to the configured limit.
- **Rewind**: every coding message takes a snapshot of the workspace with a shadow git repository (your own `.git` is untouched). Restore files, conversation, or both. The Changes panel shows a side-by-side diff per file with one-click revert.
- **AI Modules**: named assistants with their own instructions, model, effort and permissions, all sharing one conversation.
- **Discover**: scans CPU, RAM and GPU and recommends local models that fit, with one-click install and progress. Can install Ollama with winget.
- **Plan usage and context**: the status bar and model picker show how much of each plan's window is used (for example Claude's 5-hour and weekly limits, as reported by Claude Code) with reset times. When a provider refuses a turn because the plan is exhausted, an inline card offers to continue on another signed-in provider or a local model, handing it the conversation so far. The composer shows how full the model's context window is; local models get a 32k context instead of Ollama's 4k default and are condensed automatically near the limit.
- **GPU memory**: loaded models with an unload button in the status bar; memory is freed on exit.
- **Long sessions**: older local-model messages are condensed into notes instead of dropped. System tray keeps work running after the window closes. Dark, light or system theme.

## Install (release)

Download `Ember-Setup-<version>.exe` and run it. It installs per user (no admin rights), creates a Start-menu shortcut and launches Ember. Everything Ember needs is inside the installer or fetched on demand:

| Component | How it ships |
|---|---|
| Ember itself, Electron, node-pty, Monaco, xterm | inside the installer |
| cloudflared (Apache-2.0) | inside the installer (`resources/bin`) |
| Codex CLI (Apache-2.0) | inside the installer; "Update tool" fetches the latest GitHub release |
| Claude Code, Antigravity CLI | not redistributable; one click runs the vendor's official native installer into your user profile |
| Ollama and local models | installed from Discover with winget / pulled on demand |

No Node.js, npm or Python is required on the user's PC.

## Development

```bash
npm install
npm run dev
```

`npm run typecheck` checks both processes. `npm run dist` downloads the bundled binaries (`scripts/fetch-binaries.mjs`), builds, and produces `dist/Ember-Setup-<version>.exe` with electron-builder.

### Releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `chore:` …). On every push to `master`, [Release Please](https://github.com/googleapis/release-please) maintains a release pull request with the next version and changelog. Merging that PR creates the tag and GitHub release, and the workflow then builds the installer on Windows and attaches `Ember-Setup-<version>.exe` to it. CI (typecheck + build) runs on every push and pull request.

Development aids (ignored in packaged builds): `EMBER_SCREENSHOT=<file.png>` captures the window after start; `EMBER_AUTOMATION_PORT=<port>` exposes `POST /` (run JavaScript in the renderer) and `GET /shot` on 127.0.0.1 for UI testing.

## Layout

- `src/main` - Electron main process: session store, Ollama client, hardware scan, CLI locator, workspace file ops, shadow-git checkpoints, self-check runner, terminals, IPC.
- `src/main/agents` - one adapter per provider (`local.ts` Ollama via the AI SDK with Ember's tools; `claude.ts`, `codex.ts`, `gemini.ts` drive the official CLIs) normalised to one event stream; `web.ts` search and page reading.
- `src/renderer` - React UI.
- `src/shared/types.ts` - types shared by both sides.

## Shared sessions ("friends")

Right-click a chat or coding session → **Invite friends…** → **Start sharing**. Ember starts a WebSocket server for that session and, when `cloudflared` is installed (the dialog offers a one-click winget install), exposes it through a Cloudflare quick tunnel; otherwise sharing is limited to your local network. The invite is a short code (or URL + key) that a friend pastes into **Join a shared session**.

- Each participant uses their **own** AI and plan. A guest's messages are answered by the guest's model on the guest's PC; nobody consumes anyone else's usage.
- Everyone sees everything: the host's transcript is the source of truth and is streamed to all guests; guests' AI replies stream back to the host.
- Every message is labelled with its author, and every AI sees the labelled conversation. Providers that keep their own context (Claude Code, Codex, Antigravity) are handed what other participants said since their last reply.
- In a coding session a guest's AI gets the same tools, but they run on the **host's** machine: reads are allowed, while file edits and commands always ask the host for approval, whatever the host's own permission mode. Guests never get raw file access.
- A wrong key is rejected at the WebSocket handshake. "Stop sharing" closes the tunnel and disconnects guests; guests can leave or reconnect from the chat header.

## Not yet included

- MCP server/client, GitHub publishing, auto-update, local benchmark tuning.
