
import { Components } from 'react-markdown'
import { memo, useMemo } from 'react'
import { cn, disableIndentedCodeBlockPlugin } from '@/lib/utils'
// import 'katex/dist/katex.min.css'
import { defaultRehypePlugins, Streamdown } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'

import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { MermaidError } from '@/components/MermaidError'
import { CitationLink } from '@/components/CitationLink'
import { MarkdownTable } from '@/components/MarkdownTable'

interface MarkdownProps {
  content: string
  className?: string
  components?: Components
  isUser?: boolean
  isStreaming?: boolean
  messageId?: string
  isAnimating?: boolean
}

// Cache for normalized LaTeX content
const latexCache = new Map<string, string>()

/**
 * Apply the math-delimiter transforms directly to a string:
 *  - escape `$<number>` so "$5" isn't parsed as inline math
 *  - convert `\[...\]` (display) and `\(...\)` (inline) to `$$...$$` / `$...$`
 * No code-block / HTML protection here — callers must guard those themselves
 * (the full `normalizeLatex` does so via its split).
 */
const normalizeMathDelimiters = (s: string): string => {
  // --- Escape suspicious $<number> to prevent Markdown from treating it as LaTeX
  // Example: "$1" → "\$1"
  s = s.replace(/\$(\d+)(?![^\n]*\$([^\d]|$))/g, (_, num) => '\\$' + num)

  // --- Display math: \[...\] surrounded by newlines
  if (s.includes('\\['))
    s = s.replace(
      /(^|\n)\\\[\s*\n([\s\S]*?)\n\s*\\\](?=\n|$)/g,
      (_, pre, inner) => `${pre}$$\n${inner.trim()}\n$$`
    )

  // --- Inline math: \( ... \)
  if (s.includes('\\('))
    s = s.replace(
      /(^|[^$\\])\\\((.+?)\\\)(?=[^$\\]|$)/g,
      (_, pre, inner) => `${pre}$${inner.trim()}$`
    )

  return s
}

/**
 * Optimized preprocessor: normalize LaTeX fragments into $ / $$.
 * Uses caching to avoid reprocessing the same content.
 */
const normalizeLatex = (input: string): string => {
  // Check cache first
  if (latexCache.has(input)) {
    return latexCache.get(input)!
  }

  const segments = input.split(/(```[\s\S]*?```|`[^`]*`|<[a-zA-Z/_!][^>]*>)/g)

  let result = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;

    // Captured code blocks, inline code, html tags — leave untouched
    if (i % 2 === 1) {
      result += segment;
      continue;
    }

    result += normalizeMathDelimiters(segment);
  }

  // Cache the result (with size limit to prevent memory leaks)
  if (latexCache.size > 100) {
    const firstKey = latexCache.keys().next().value || ''
    latexCache.delete(firstKey)
  }
  latexCache.set(input, result)

  return result
}

function RenderMarkdownComponent({
  content,
  className,
  isUser,
  components,
  messageId,
  isAnimating,
  isStreaming,
}: MarkdownProps) {

  // Full `normalizeLatex` runs a string split + per-segment passes and caches
  // by the whole string. During streaming the content changes on every throttled
  // batch, so the cache never hits and that full pass is a major cause of UI
  // freezes on long answers. Instead run only the cheap delimiter transforms
  // (no split, no caching): it fixes the streaming regressions where `\(...\)`
  // renders as literal text and `$5` gets parsed as math, while keeping each
  // batch O(n) with a small constant. The final (non-streaming) render re-runs
  // the full protective normalizeLatex, which also restores code-block safety.
  const normalizedContent = useMemo(
    () =>
      isStreaming ? normalizeMathDelimiters(content) : normalizeLatex(content),
    [content, isStreaming]
  )

  const mergedComponents = useMemo<Components>(() => {
    const Anchor = (
      props: React.AnchorHTMLAttributes<HTMLAnchorElement>
    ) => {
      const { href, children, className: aClass } = props
      if (typeof href === 'string' && href.startsWith('#cite-')) {
        return (
          <CitationLink href={href} className={aClass}>
            {children}
          </CitationLink>
        )
      }
      return <a {...props}>{children}</a>
    }
    return { a: Anchor, table: MarkdownTable, ...(components ?? {}) } as Components
  }, [components])

  // Render the markdown content
  return (
    <div
      dir="auto"
      className={cn(
        'markdown wrap-break-word select-text',
        isUser && 'is-user',
        className
      )}
    >
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={isStreaming ?? false}
        animate={isAnimating ?? true}
        animationDuration={500}
        linkSafety={{
          enabled: false,
        }}
        className={cn(
          'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          className
        )}
        remarkPlugins={[remarkGfm, remarkMath, disableIndentedCodeBlockPlugin]}
        rehypePlugins={[
          rehypeKatex,
          defaultRehypePlugins.harden,
        ]}
        components={mergedComponents}
        plugins={{
          code: code,
          mermaid: mermaid,
          cjk: cjk,
        }}
        controls={{
          mermaid: {
            fullscreen: false,
          },
        }}
        mermaid={
          messageId
            ? {
                errorComponent: (props) => (
                  <MermaidError messageId={messageId} {...props} />
                ),
              }
            : {}
        }
      >
        {normalizedContent}
      </Streamdown>
    </div>
  )
}
export const RenderMarkdown = memo(
  RenderMarkdownComponent,
  (prevProps, nextProps) =>
    prevProps.content === nextProps.content &&
    prevProps.isStreaming === nextProps.isStreaming
)
