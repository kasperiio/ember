import type {
  AiModule, ApprovalRequest, Attachment, CheckCommand, CliStatus, FileEntry, Hardware, ModelRecommendation,
  OllamaModel, OllamaRunning, Participant, SearchHit, Session, SessionSummary, Settings
} from '../../../shared/types'

const inv = <T>(ch: string, ...args: unknown[]) => window.ember.invoke(ch, ...args) as Promise<T>

export const api = {
  on: window.ember.on,
  pathForFile: window.ember.pathForFile,
  settings: { get: () => inv<Settings>('settings:get'), set: (p: Partial<Settings>) => inv<Settings>('settings:set', p) },
  app: { info: () => inv<{ version: string; platform: string; userData: string }>('app:info'), quit: () => inv('app:quit') },
  sessions: {
    list: () => inv<SessionSummary[]>('sessions:list'),
    search: (q: string) => inv<SessionSummary[]>('sessions:search', q),
    get: (id: string) => inv<Session | null>('sessions:get', id),
    create: (init: Partial<Session> & Pick<Session, 'kind'>) => inv<Session>('sessions:create', init),
    save: (s: Session) => inv<Session>('sessions:save', s),
    delete: (id: string) => inv<void>('sessions:delete', id),
    send: (id: string, prompt: string, attachments: Attachment[]) => inv<void>('sessions:send', id, prompt, attachments),
    stop: (id: string) => inv<void>('sessions:stop', id),
    running: (id: string) => inv<boolean>('sessions:running', id),
    compact: (id: string) => inv<Session | null>('sessions:compact', id),
    rewind: (id: string, msgId: string, what: 'files' | 'conversation' | 'both') => inv<Session | null>('sessions:rewind', id, msgId, what)
  },
  approval: { answer: (id: string, ok: boolean) => inv<void>('approval:answer', id, ok) },
  attachments: { pick: () => inv<Attachment[]>('attachments:pick'), import: (paths: string[]) => inv<Attachment[]>('attachments:import', paths) },
  modules: { list: () => inv<AiModule[]>('modules:list'), save: (m: AiModule[]) => inv<void>('modules:save', m) },
  ollama: {
    status: () => inv<{ ok: boolean; version?: string }>('ollama:status'),
    models: () => inv<OllamaModel[]>('ollama:models'),
    show: (n: string) => inv<{ capabilities: string[]; contextLength?: number }>('ollama:show', n),
    running: () => inv<OllamaRunning[]>('ollama:running'),
    unload: (n: string) => inv<void>('ollama:unload', n),
    delete: (n: string) => inv<void>('ollama:delete', n),
    pull: (n: string) => inv<void>('ollama:pull', n),
    cancelPull: (n: string) => inv<void>('ollama:cancelPull', n),
    install: () => inv<boolean>('ollama:install')
  },
  hardware: {
    scan: () => inv<Hardware>('hardware:scan'),
    recommend: () => inv<{ hardware: Hardware; recommendations: ModelRecommendation[] }>('hardware:recommend')
  },
  cli: {
    status: () => inv<CliStatus[]>('cli:status'),
    install: (id: string) => inv<boolean>('cli:install', id),
    loginCommand: (id: string) => inv<string | null>('cli:loginCommand', id),
    logout: (id: string) => inv<void>('cli:logout', id),
    models: (id: string) => inv<{ id: string; label: string }[]>('cli:models', id)
  },
  ws: {
    pickFolder: () => inv<string | null>('ws:pickFolder'),
    listDir: (root: string, dir: string) => inv<FileEntry[]>('ws:listDir', root, dir),
    read: (p: string) => inv<string>('ws:read', p),
    write: (p: string, c: string) => inv<void>('ws:write', p, c),
    search: (root: string, q: string, regex: boolean) => inv<SearchHit[]>('ws:search', root, q, regex),
    files: (root: string) => inv<string[]>('ws:files', root),
    gitStatus: (root: string) => inv<Record<string, string>>('ws:gitStatus', root),
    gitDiff: (root: string, file?: string) => inv<string>('ws:gitDiff', root, file),
    gitCommit: (root: string, msg: string) => inv<string>('ws:gitCommit', root, msg),
    watch: (root: string) => inv<void>('ws:watch', root),
    unwatch: (root: string) => inv<void>('ws:unwatch', root),
    openExternal: (p: string) => inv<void>('ws:openExternal', p),
    openInVSCode: (root: string) => inv<void>('ws:openInVSCode', root),
    openInTerminal: (root: string) => inv<void>('ws:openInTerminal', root),
    checks: (root: string) => inv<CheckCommand[]>('ws:checks', root),
    runChecks: (root: string) => inv<{ ok: boolean; output: string }>('ws:runChecks', root),
    missingRuntimes: (root: string) => inv<{ name: string; wingetId: string }[]>('ws:missingRuntimes', root),
    installRuntime: (id: string) => inv<{ ok: boolean; output: string }>('ws:installRuntime', id),
    changedSince: (root: string, tree: string) => inv<{ path: string; status: string }[]>('ws:changedSince', root, tree),
    fileAt: (root: string, tree: string, rel: string) => inv<string | null>('ws:fileAt', root, tree, rel),
    diffSince: (root: string, tree: string, rel?: string) => inv<string>('ws:diffSince', root, tree, rel)
  },
  share: {
    start: (id: string) => inv<{ url: string; lanUrl: string; key: string; tunnel: boolean }>('share:start', id),
    stop: (id: string) => inv<void>('share:stop', id),
    participants: (id: string) => inv<Participant[]>('share:participants', id),
    inviteCode: (url: string, key: string) => inv<string>('share:inviteCode', url, key),
    parseInvite: (text: string) => inv<{ url: string; key: string } | null>('share:parseInvite', text),
    join: (url: string, key: string, existingId?: string) => inv<Session>('share:join', url, key, existingId),
    leave: (id: string) => inv<void>('share:leave', id),
    cloudflared: () => inv<boolean>('share:cloudflared'),
    installCloudflared: () => inv<boolean>('share:installCloudflared')
  },
  clipboard: (t: string) => inv<void>('clipboard:write', t),
  openExternal: (u: string) => inv<void>('shell:openExternal', u),
  terminal: {
    create: (id: string, cwd: string, cols: number, rows: number, cmd?: string) => inv<{ pty: boolean }>('terminal:create', id, cwd, cols, rows, cmd),
    write: (id: string, d: string) => inv<void>('terminal:write', id, d),
    resize: (id: string, c: number, r: number) => inv<void>('terminal:resize', id, c, r),
    kill: (id: string) => inv<void>('terminal:kill', id)
  }
}

export type { ApprovalRequest }
