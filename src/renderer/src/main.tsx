import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error)
      return (
        <div style={{ padding: 30, fontFamily: 'sans-serif' }}>
          <h2>Ember hit an error in the interface</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error.stack ?? this.state.error)}</pre>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      )
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
