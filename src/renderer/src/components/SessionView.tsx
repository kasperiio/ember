import { useStore, newSession } from '../lib/store'
import { ChatView } from './ChatView'
import { Workspace } from './Workspace'
import { Icon } from './Icon'

export function SessionView() {
  const current = useStore((s) => s.current)
  if (!current)
    return (
      <div className="empty">
        <div className="col" style={{ alignItems: 'center' }}>
          <Icon name="flame" size={44} className="brand-flame" />
          <h1>Ember</h1>
          <p className="muted">Chat with local models or your Claude, ChatGPT and Gemini accounts. Open a folder to code.</p>
          <div className="row">
            <button className="primary" onClick={() => newSession('chat')}>New chat</button>
            <button onClick={() => newSession('code')}>New scratch project</button>
          </div>
        </div>
      </div>
    )
  if (current.kind === 'code' && current.workspace)
    return (
      <div className="split">
        <ChatView key={'chat-' + current.id} />
        <Workspace key={'ws-' + current.id} root={current.workspace} />
      </div>
    )
  return <ChatView key={'chat-' + current.id} />
}
