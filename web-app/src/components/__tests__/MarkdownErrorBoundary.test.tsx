import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MarkdownErrorBoundary } from '../MarkdownErrorBoundary'

const Thrower = ({ message }: { message: string }) => {
  throw new Error(message)
}

describe('MarkdownErrorBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders children when no error is thrown', () => {
    render(
      <MarkdownErrorBoundary content="hello">
        <p>all good</p>
      </MarkdownErrorBoundary>
    )
    expect(screen.getByText('all good')).toBeTruthy()
  })

  it('contains a render-phase throw and shows the raw content instead', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MarkdownErrorBoundary content={'a bad **chart** here'}>
        <Thrower message="Cannot read properties of undefined (reading 'metadata')" />
      </MarkdownErrorBoundary>
    )
    // The error must not propagate (which would fail the test); the raw content
    // is shown so the message stays readable.
    expect(screen.getByText('a bad **chart** here')).toBeTruthy()
    expect(screen.getByText(/Rendering failed/)).toBeTruthy()
    expect(spy).toHaveBeenCalled()
  })
})
