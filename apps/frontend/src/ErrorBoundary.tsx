import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, background: '#0b0e11',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', color: '#ef5350', fontFamily: 'monospace',
          padding: '40px', gap: '16px'
        }}>
          <div style={{ fontSize: '18px', fontWeight: 'bold' }}>⚠ Runtime Error</div>
          <div style={{
            background: '#161b22', border: '1px solid #ef5350',
            borderRadius: '8px', padding: '20px', maxWidth: '800px',
            width: '100%', fontSize: '13px', whiteSpace: 'pre-wrap',
            color: '#f85149', overflowY: 'auto', maxHeight: '400px'
          }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: '8px 20px', background: '#21262d',
              border: '1px solid #30363d', borderRadius: '6px',
              color: '#e6edf3', cursor: 'pointer', fontSize: '13px'
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
