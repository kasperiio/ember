import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import type { ChatMessage, ToolCall } from '../../../shared/types'
import { Icon } from './Icon'

function fmt(n?: number): string {
  return n == null ? '' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

export const Message = memo(function Message({ msg, streaming, workspace, onRewind, me }: { msg: ChatMessage; streaming: boolean; workspace?: string; onRewind?: (what: 'files' | 'conversation' | 'both') => void; me?: string }) {
  const [rewindOpen, setRewindOpen] = useState(false)
  // Claude reports an API-equivalent cost even on a Pro/Max plan; only show dollars when it is billed per use.
  const claudeBilled = useStore((s) => s.cli.find((c) => c.id === 'claude')?.plan === 'API credits')
  if (msg.role === 'system') return <div className="msg system"><span className="sys">{msg.content}</span></div>
  // In shared sessions, messages from other participants (and their AIs) are labelled.
  const mine = !msg.author || msg.author === me || msg.author === (me ?? '') + "'s assistant"
  const authorTag = msg.author && !mine ? <div className="author"><Icon name={msg.role === 'user' ? 'user' : 'bot'} /> <b>{msg.author}</b></div> : null

  if (msg.role === 'user')
    return (
      <div className={'msg user' + (mine ? '' : ' other')}>
        {authorTag}
        {msg.attachments?.length ? (
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {msg.attachments.map((a) => (
              <span key={a.path} className="attach">{a.mime.startsWith('image/') ? <img src={'file:///' + a.path.replace(/\\/g, '/')} alt={a.name} /> : <><Icon name="paperclip" /> {a.name}</>}</span>
            ))}
          </div>
        ) : null}
        <div className="bubble">{msg.content}</div>
        {onRewind && (
          <div className="meta">
            {msg.checkpoint && <span title="Files were snapshotted before this message"><Icon name="clock" size={12} /> checkpoint</span>}
            <button className="ghost small" onClick={() => setRewindOpen((v) => !v)}>Rewind…</button>
            {rewindOpen && (
              <span className="row">
                {msg.checkpoint && workspace && <button className="small" onClick={() => { setRewindOpen(false); onRewind('files') }}>Files only</button>}
                <button className="small" onClick={() => { setRewindOpen(false); onRewind('conversation') }}>Conversation only</button>
                {msg.checkpoint && workspace && <button className="small" onClick={() => { setRewindOpen(false); onRewind('both') }}>Both</button>}
              </span>
            )}
          </div>
        )}
      </div>
    )

  const st = msg.stats
  return (
    <div className="msg assistant">
      {authorTag}
      {msg.reasoning && (
        <details className="reasoning" open={streaming && !msg.content}>
          <summary><Icon name="thought" /> Reasoning {streaming && !msg.content ? '…' : ''}</summary>
          <div>{msg.reasoning}</div>
        </details>
      )}
      {msg.toolCalls?.map((t) => <Tool key={t.id} t={t} />)}
      {msg.content ? (
        <div className={'body' + (streaming ? ' cursor' : '')}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href) api.openExternal(href) }}>{children}</a> }}>
            {msg.content}
          </ReactMarkdown>
        </div>
      ) : streaming && !msg.toolCalls?.length && !msg.reasoning ? (
        <div className="muted cursor">Thinking</div>
      ) : null}
      {msg.selfCheck && (
        <details className="selfcheck" open={!msg.selfCheck.ok}>
          <summary>{msg.selfCheck.ok ? <><Icon name="check" className="ico-ok" /> Self-check passed</> : <><Icon name="x" className="ico-err" /> Self-check failed (attempt {msg.selfCheck.attempt})</>}</summary>
          <div className="mono">{msg.selfCheck.output}</div>
        </details>
      )}
      {msg.error && <div className="err"><Icon name="warn" /> {msg.error}</div>}
      {(st || msg.content) && !streaming && (
        <div className="meta">
          {st?.tokensPerSec && <span>{st.tokensPerSec} tok/s</span>}
          {st?.outputTokens != null && <span>{fmt(st.inputTokens)} in / {fmt(st.outputTokens)} out</span>}
          {st?.durationMs != null && <span>{(st.durationMs / 1000).toFixed(1)}s</span>}
          {st?.costUsd != null && st.costUsd > 0 && (msg.model?.provider !== 'claude' || claudeBilled) ? (
            <span>${st.costUsd.toFixed(3)}</span>
          ) : msg.model && msg.model.provider !== 'ollama' && msg.role === 'assistant' ? (
            <span title="Billed to your plan, not per message">subscription</span>
          ) : null}
          {msg.model && <span>{msg.model.model || msg.model.provider}</span>}
          <button className="ghost small" onClick={() => api.clipboard(msg.content)}>Copy</button>
        </div>
      )}
    </div>
  )
})

function Tool({ t }: { t: ToolCall }) {
  const input: any = t.input ?? {}
  const label =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? (input.changes ? input.changes.map((c: any) => c.path).join(', ') : '') ?? ''
  return (
    <details className="tool">
      <summary>
        <span className={'dot ' + t.status} />
        <span>{t.name}</span>
        <span className="mono muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(label).slice(0, 120)}</span>
        {t.status === 'denied' && <span className="badge err">denied</span>}
      </summary>
      <div className="mono">
        <div className="in">{typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}</div>
        {t.output != null && <><hr />{t.output}</>}
      </div>
    </details>
  )
}
