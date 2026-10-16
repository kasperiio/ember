import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore, refreshCli, requestTerminal, set, get, newSession } from '../lib/store'
import type { CliStatus } from '../../../shared/types'
import { resetLabel } from './StatusBar'

const INFO: Record<CliStatus['id'], { title: string; who: string; plan: string; pkg: string; site: string }> = {
  claude: { title: 'Claude', who: 'Anthropic', plan: 'Claude Pro or Max subscription', pkg: 'Claude Code (official installer)', site: 'https://claude.ai' },
  codex: { title: 'ChatGPT / Codex', who: 'OpenAI', plan: 'ChatGPT Plus, Pro, Team or Enterprise', pkg: 'Codex CLI (ships with Ember)', site: 'https://chatgpt.com' },
  gemini: { title: 'Gemini (Antigravity)', who: 'Google', plan: 'Google account (free tier or Google AI Pro / Ultra)', pkg: 'Antigravity CLI (agy)', site: 'https://antigravity.google' }
}

export function Accounts() {
  const cli = useStore((s) => s.cli)
  const usage = useStore((s) => s.usage)
  const [log, setLog] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    refreshCli()
    const off = api.on('log', ({ source, text }: { source: string; text: string }) => {
      if (source === 'cli-install' && busy) setLog((l) => ({ ...l, [busy]: (l[busy] ?? '') + text }))
    })
    // Each status check spawns the three CLIs (a few seconds of CPU); poll gently.
    const t = setInterval(refreshCli, 30000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [busy])

  const install = async (id: CliStatus['id']) => {
    setBusy(id)
    setLog((l) => ({ ...l, [id]: 'Installing ' + INFO[id].pkg + ' with npm…\n' }))
    const ok = await api.cli.install(id)
    setLog((l) => ({ ...l, [id]: (l[id] ?? '') + (ok ? '\nInstalled.' : '\nInstall failed.') }))
    setBusy(null)
    refreshCli()
  }

  const signIn = async (id: CliStatus['id']) => {
    const cmd = await api.cli.loginCommand(id)
    if (!cmd) return
    // Sign-in is interactive (browser + terminal), so it runs in an embedded terminal of a coding session.
    let cur = get().current
    if (!cur || cur.kind !== 'code' || !cur.workspace) cur = await newSession('code')
    set({ page: 'session' })
    requestTerminal(cur.workspace!, cmd, 'Sign in: ' + INFO[id].title)
  }

  return (
    <div className="page scroll">
      <h1>Accounts</h1>
      <p className="muted">
        Use the AI plans you already pay for. Ember never asks for API keys: each provider's <em>official</em> command-line tool handles sign-in in your browser and
        keeps the token on this PC. Ember then talks to that tool, so usage counts against your plan.
      </p>
      <div className="col" style={{ gap: 12, marginTop: 12 }}>
        {(['claude', 'codex', 'gemini'] as const).map((id) => {
          const st = cli.find((c) => c.id === id)
          const info = INFO[id]
          return (
            <div key={id} className="card">
              <div className="row">
                <div className="grow">
                  <strong>{info.title}</strong> <span className="muted">by {info.who} · {info.plan}</span>
                </div>
                {!st ? <span className="badge">checking…</span> : !st.installed ? <span className="badge warn">tool not installed</span> : st.loggedIn === true ? <span className="badge ok">signed in{st.plan ? ' · ' + st.plan : ''}{st.account ? ' · ' + st.account : ''}</span> : st.loggedIn === false ? <span className="badge err">not signed in</span> : <span className="badge">installed</span>}
              </div>
              <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                {st?.installed ? `${st.version ?? ''} · ${st.path}` : `Installs ${info.pkg}; no admin rights needed.`}
              </div>
              {(() => {
                const u = usage.find((x) => x.provider === id)
                if (!u || !u.windows.length) return st?.loggedIn === true ? <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Usage appears here after the first message; it is reported by the tool itself, nothing is billed per message.</div> : null
                return (
                  <div className="col" style={{ gap: 4, marginBottom: 8 }}>
                    {u.windows.map((w) => (
                      <div key={w.label} className="row" style={{ fontSize: 12.5 }}>
                        <span style={{ width: 110 }}>{w.label}</span>
                        <span className="progress" style={{ width: 160 }}><i style={{ width: `${w.utilization ?? 0}%`, background: w.status === 'ok' ? undefined : 'var(--warn)' }} /></span>
                        <span className="muted">{w.utilization != null ? `${w.utilization}% used` : w.status}{w.resetsAt ? ` · ${resetLabel(w.resetsAt)}` : ''}</span>
                      </div>
                    ))}
                    {u.status === 'limited' && <div className="err" style={{ fontSize: 12.5 }}>Plan limit reached. Switch to another provider or wait for the reset.</div>}
                  </div>
                )
              })()}
              <div className="row">
                {!st?.installed ? (
                  <button className="primary" onClick={() => install(id)} disabled={busy === id}>{busy === id ? 'Installing…' : 'Install tool'}</button>
                ) : (
                  <>
                    <button className="primary" onClick={() => signIn(id)}>{st.loggedIn === true ? 'Sign in again' : 'Sign in'}</button>
                    {st.loggedIn === true && <button onClick={() => api.cli.logout(id).then(refreshCli)}>Sign out</button>}
                    <button onClick={() => install(id)} disabled={busy === id}>Update tool</button>
                  </>
                )}
                <button className="ghost" onClick={() => api.openExternal(info.site)}>Manage plan ↗</button>
              </div>
              {id === 'gemini' && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Google is replacing Gemini CLI with Antigravity CLI (Gemini CLI stops serving personal accounts on 18 June 2026), so Ember uses Antigravity CLI.
                </div>
              )}
              {log[id] && <pre className="log" style={{ marginTop: 8 }}>{log[id]}</pre>}
            </div>
          )
        })}
      </div>
      <h2>How it works</h2>
      <ul className="muted" style={{ fontSize: 13 }}>
        <li>Sign-in opens the provider's own login page in your browser, exactly like running the tool yourself.</li>
        <li>Tokens are stored by the provider tool, never by Ember.</li>
        <li>Codex CLI and cloudflared ship inside Ember (Apache-2.0). Claude Code and Antigravity CLI are installed by their vendors' official installers into your user profile.</li>
        <li>All three providers use Ember's approval prompts in every permission mode: Claude and Codex ask Ember directly, and Antigravity asks through a small approval hook Ember adds to its hooks.json (it does nothing when you run agy yourself).</li>
      </ul>
    </div>
  )
}
