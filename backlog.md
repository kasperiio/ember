# Ember backlog

Ideas and fixes, added as they come up. A dedicated session works through unchecked items **one at a time, top to bottom**, ticks each one when it is done and verified, and appends a one-line note of what changed. Keep items small and concrete.

Conventions for the worker session:
- Do one item per pass: implement, run `npm run typecheck`, verify in the running app (dev server with `npm run dev`, or the automation hook described in README.md), then tick the box and write the note.
- Do not commit; the owner commits.
- Don't touch packaging files (`electron-builder.yml`, `scripts/`, `src/main/paths.ts`, `src/main/cli.ts`, `src/main/sharing.ts`) unless an item is explicitly about them; another session owns packaging right now.
- If an item is unclear, write a question under it instead of guessing, and move on to the next.

## Open

- [ ] For a few seconds after launch the model picker labels the current provider "(not signed in)" because `cli:status` hasn't returned yet (`cli` is empty in the store). Track a `cliLoaded` flag in `lib/store.ts`; until it is true show "(checking…)" and don't hide providers from the list.

## Done

- [x] Remove all emojis from the UI (except the title-bar flame). — New `components/Icon.tsx` (inline stroke SVGs using `currentColor`) replaces every emoji in Sidebar, ChatView header/approval cards, Composer, Message, FileTree (per-type file icons), ShareDialogs, StatusBar (CSS dot for Ollama status), Workspace tabs and the welcome screen (SVG flame in accent colour); `.icon`/`.dot` styles in styles.css. Verified in the app: no emoji in the DOM besides the title-bar flame.
- [x] Session dropdown in the chat header (Rename / Archive / Delete). — `archived?: boolean` on `Session`/`SessionSummary` (main `summary()` passes it through); new `components/SessionMenu.tsx` used by both the header chevron and the sidebar right-click menu (which adds "Invite friends…"); `patchSession`/`renameSession`/`deleteSession` (with confirm) in `lib/store.ts`; sidebar hides archived sessions, shows a "Show archived (n)" toggle at the bottom of the list, archived items are dimmed and the header shows an "Archived" badge; search still finds archived sessions. Verified archive → hidden → show → unarchive → delete in the app.
- [x] No dollar figures for subscription Claude replies; plan on the Accounts badge. — `agents/claude.ts` gains `claudeAuth()` (cached `claude auth status`) and `claudePlanLabel()`; the adapter drops `costUsd` unless `authMethod` is `console`; `cli:status` in `index.ts` adds `plan` to the Claude status (new `CliStatus.plan`), so `cli.ts` stayed untouched; `Message.tsx` shows "subscription" for CLI-provider replies and hides stored Claude dollar amounts unless the plan is "API credits". Verified: the old $0.002 Haiku reply now reads "subscription"; badge shows "signed in · Max plan · <email>".
- [x] (Reported by the owner) Odd scrollbar on Discover. — Chromium's default scrollbar (grey track, arrow buttons) is replaced app-wide by a thin themed one (`::-webkit-scrollbar` in styles.css). `.page` scroll containers are now full width, with content centred by padding, so the bar sits at the window edge instead of floating mid-window. Verified on Discover.
