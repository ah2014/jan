import { Component, ReactNode } from 'react'

interface MarkdownErrorBoundaryProps {
  content: string
  children: ReactNode
}

interface MarkdownErrorBoundaryState {
  error: Error | null
}

/**
 * Contains failures thrown synchronously while rendering markdown (notably
 * mermaid diagrams — mermaid's bundled Langium diagnostics can throw during
 * React's render phase, e.g. "Cannot read properties of undefined (reading
 * 'metadata')"). Streamdown already guards the async `mermaid.render()` path,
 * but a throw from a `useMemo` would otherwise propagate to the root error
 * boundary and blank the whole app. This boundary degrades to a readable
 * plain-text view of the message instead.
 */
export class MarkdownErrorBoundary extends Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): MarkdownErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Markdown rendering failed, falling back to plain text:', error)
  }

  componentDidUpdate(prevProps: MarkdownErrorBoundaryProps) {
    // Retry once new content arrives (e.g. the next streamed token or an edit),
    // so a transient parse error doesn't permanently blank the message.
    if (this.state.error && prevProps.content !== this.props.content) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="text-sm text-muted-foreground">
          <p className="mb-1 text-xs italic opacity-70">
            Rendering failed; showing raw content.
          </p>
          <p className="whitespace-pre-wrap break-words">{this.props.content}</p>
        </div>
      )
    }
    return this.props.children
  }
}
