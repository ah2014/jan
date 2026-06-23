import { useEffect, useMemo, useRef, useState, memo } from 'react'
import {
  IconFile,
  IconFolder,
  IconRefresh,
  IconSearch,
  IconAlertTriangle,
  IconX,
} from '@tabler/icons-react'
import { formatBytes } from '@/lib/utils'
import {
  filterAndSortEntries,
  classifyRemoteFile,
} from '@/lib/remoteAttach'
import type { RemoteFileEntry } from '@/services/remote-files/types'
import { useRemoteFiles } from '@/hooks/useRemoteFiles'

/**
 * Inline file picker shown by the composer when the user types `~`. Lets the
 * user search the cached recursive walk of the configured
 * `allowed_attach_paths.json` roots and attach a chosen file as if it had been
 * uploaded.
 *
 * The picker is a self-contained absolutely-positioned panel (not a Radix
 * Popover) because it has no trigger button — it's invoked by keystroke — and
 * we need fine-grained control of keyboard navigation. Sorting/filtering is
 * delegated to {@link filterAndSortEntries}; the heavy cache lives in
 * {@link useRemoteFiles}.
 *
 * Keyboard:
 *   ↑ / ↓   move selection
 *   Enter   attach the selected file (no-op on directories)
 *   Esc     dismiss without attaching
 */
type RemoteFilePickerProps = {
  /** Called when the user picks a file (never with a directory). */
  onSelect: (entry: RemoteFileEntry) => void
  /** Called on Escape / click-outside / close button. */
  onClose: () => void
  className?: string
}

const MAX_RESULTS = 200

export const RemoteFilePicker = memo(function RemoteFilePicker({
  onSelect,
  onClose,
  className,
}: RemoteFilePickerProps) {
  const { entries, loading, error, fetchedAt, allowListEmpty, refresh } =
    useRemoteFiles()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Autofocus the search box on open so the user can keep typing immediately.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(
    () => filterAndSortEntries(entries, query.trim(), MAX_RESULTS),
    [entries, query]
  )

  // Reset selection to the first attachable file whenever the result set
  // changes, so Enter always targets something actionable.
  useEffect(() => {
    const firstAttachable = filtered.findIndex((e) => !e.isDir)
    setActiveIndex(firstAttachable >= 0 ? firstAttachable : 0)
  }, [filtered])

  // Keep the active row scrolled into view during keyboard nav.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const row = list.children[activeIndex] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const choose = (entry: RemoteFileEntry | undefined) => {
    if (!entry || entry.isDir) return
    onSelect(entry)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(filtered[activeIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className={cnPicker(className)}
      role="dialog"
      aria-label="Attach a file from the server"
      // Click-outside to close: stopPropagation so clicks inside don't bubble
      // to the document-level handler the parent registers.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <IconSearch
          size={16}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search files on the server…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="remote-file-picker-search"
          aria-label="Search files"
        />
        <button
          type="button"
          onClick={() => void refresh()}
          title={
            fetchedAt
              ? `Refresh — last updated ${new Date(fetchedAt).toLocaleTimeString()}`
              : 'Refresh'
          }
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          disabled={loading}
          data-testid="remote-file-picker-refresh"
          aria-label="Refresh file list"
        >
          <IconRefresh
            size={16}
            className={loading ? 'animate-spin' : ''}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Close (Esc)"
          aria-label="Close"
        >
          <IconX size={16} aria-hidden />
        </button>
      </div>

      <div
        ref={listRef}
        className="max-h-72 overflow-y-auto py-1"
        data-testid="remote-file-picker-list"
      >
        {error ? (
          <PickerMessage tone="error">
            <IconAlertTriangle size={16} className="shrink-0" aria-hidden />
            <span>Failed to list files: {error}</span>
          </PickerMessage>
        ) : allowListEmpty ? (
          <PickerMessage tone="info">
            <span>
              No attach folders configured. Add absolute paths to{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                allowed_attach_paths.json
              </code>{' '}
              in your Jan data folder, then hit refresh.
            </span>
          </PickerMessage>
        ) : loading && entries.length === 0 ? (
          <PickerMessage tone="info">
            <IconRefresh size={16} className="animate-spin" aria-hidden />
            <span>Walking allowed folders…</span>
          </PickerMessage>
        ) : filtered.length === 0 ? (
          <PickerMessage tone="info">
            <span>{query ? `No files match “${query}”.` : 'No files found.'}</span>
          </PickerMessage>
        ) : (
          filtered.map((entry, i) => (
            <PickerRow
              key={entry.path}
              entry={entry}
              active={i === activeIndex}
              onClick={() => choose(entry)}
              onMouseEnter={() => setActiveIndex(i)}
            />
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {filtered.length > 0 &&
            `${Math.min(filtered.length, MAX_RESULTS)} of ${entries.length} entries`}
        </span>
        <span className="hidden sm:inline">
          <kbd className="rounded border bg-muted px-1">↑</kbd>{' '}
          <kbd className="rounded border bg-muted px-1">↓</kbd> navigate ·{' '}
          <kbd className="rounded border bg-muted px-1">Enter</kbd> attach ·{' '}
          <kbd className="rounded border bg-muted px-1">Esc</kbd> close
        </span>
      </div>
    </div>
  )
})

type PickerRowProps = {
  entry: RemoteFileEntry
  active: boolean
  onClick: () => void
  onMouseEnter: () => void
}

const PickerRow = memo(function PickerRow({
  entry,
  active,
  onClick,
  onMouseEnter,
}: PickerRowProps) {
  const isDir = entry.isDir
  const Icon = isDir ? IconFolder : IconFile
  const kind = classifyRemoteFile(entry.name)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
        active ? 'bg-accent text-accent-foreground' : ''
      } ${isDir ? 'cursor-default opacity-80' : 'cursor-pointer'}`}
      data-testid="remote-file-picker-row"
      data-path={entry.path}
      data-kind={kind}
      disabled={isDir}
      title={entry.path}
    >
      <Icon
        size={16}
        className={
          isDir
            ? 'shrink-0 text-muted-foreground'
            : kind === 'image'
              ? 'shrink-0 text-emerald-500'
              : kind === 'audio'
                ? 'shrink-0 text-violet-500'
                : 'shrink-0 text-muted-foreground'
        }
        aria-hidden
      />
      <span className="flex-1 truncate">{entry.name}</span>
      {!isDir && typeof entry.size === 'number' && entry.size > 0 && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatBytes(entry.size)}
        </span>
      )}
    </button>
  )
})

type PickerMessageProps = {
  tone: 'info' | 'error'
  children: React.ReactNode
}
function PickerMessage({ tone, children }: PickerMessageProps) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-4 text-xs ${
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      {children}
    </div>
  )
}

function cnPicker(className?: string): string {
  // Inline class merge — avoid pulling `cn` into every row render.
  const base =
    'absolute z-30 left-2 right-2 bottom-full mb-2 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden flex flex-col'
  return className ? `${base} ${className}` : base
}
