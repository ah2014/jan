/**
 * Helpers for the remote-attach (`~`) picker.
 *
 * Extracted into a plain module so the classification + filtering logic is
 * unit-testable without rendering React. The picker component in
 * `containers/RemoteFilePicker.tsx` is a thin shell over these.
 */
import type { RemoteFileEntry } from '@/services/remote-files/types'

export type RemoteAttachKind = 'image' | 'audio' | 'document'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png'])
const AUDIO_EXTS = new Set(['wav', 'mp3'])

/** Lowercased extension (no leading dot) of the given filename, or `''`. */
export function getExtension(name: string): string {
  const i = name.lastIndexOf('.')
  if (i < 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

/**
 * Classify a remote file into the same three buckets the manual uploaders use
 * (see `processImageFiles` / `processAudioFiles` in ChatInput.tsx), so a
 * remote-picked image flows through the image pipeline, audio through audio,
 * and everything else through the path-based document pipeline.
 */
export function classifyRemoteFile(name: string): RemoteAttachKind {
  const ext = getExtension(name)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'document'
}

/**
 * MIME type for image/audio files (used to rebuild a `File` from base64). For
 * documents we return `''` — document attachments are path-based and never
 * need a MIME type.
 */
export function mimeTypeFor(name: string): string {
  const ext = getExtension(name)
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    default:
      return ''
  }
}

export type ScoredEntry = {
  entry: RemoteFileEntry
  /** Lower is better. See {@link rankEntry}. */
  score: number
}

/**
 * Rank an entry against a query. Returns `null` if the entry doesn't match at
 * all. Ranking buckets (lower = better):
 *
 *   0 — exact basename match            (query === name)
 *   1 — basename starts with query
 *   2 — basename contains query
 *   3 — full path contains query
 *
 * Within the same bucket, files rank ahead of directories (so a file the user
 * can actually attach isn't buried under a folder), and shorter basenames rank
 * ahead of longer ones (a tighter match wins).
 */
export function rankEntry(entry: RemoteFileEntry, query: string): number | null {
  if (!query) return entry.isDir ? 100 : 90
  const q = query.toLowerCase()
  const name = entry.name.toLowerCase()
  const path = entry.path.toLowerCase()

  let bucket: number
  if (name === q) bucket = 0
  else if (name.startsWith(q)) bucket = 1
  else if (name.includes(q)) bucket = 2
  else if (path.includes(q)) bucket = 3
  else return null

  // Tertiary: directories after files at the same bucket (penalty +1), then
  // shorter names first. Kept inside the integer so the final `sort` is stable
  // and well-defined. We multiply name length by a small fraction so it only
  // breaks ties within a bucket and never overrides the bucket itself.
  const dirPenalty = entry.isDir ? 1 : 0
  return bucket * 1000 + dirPenalty * 500 + Math.min(name.length, 999)
}

/**
 * Filter + sort the cached walk by a search query. Caps the result count so
 * the picker stays responsive even with the 50k-entry worst-case walk.
 */
export function filterAndSortEntries(
  entries: RemoteFileEntry[],
  query: string,
  limit = 200
): RemoteFileEntry[] {
  if (!query) {
    // No query yet: show files first (most actionable), then dirs, both
    // alphabetical. Cap to keep the dropdown snappy.
    const files = entries.filter((e) => !e.isDir).slice(0, limit)
    const dirs = entries.filter((e) => e.isDir).slice(0, limit - files.length)
    return [...files, ...dirs]
  }
  const scored: ScoredEntry[] = []
  for (const entry of entries) {
    const score = rankEntry(entry, query)
    if (score !== null) scored.push({ entry, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    // Stable fallback: alphabetical by path.
    return a.entry.path.localeCompare(b.entry.path)
  })
  return scored.slice(0, limit).map((s) => s.entry)
}

/**
 * Decide whether a prompt change should summon the remote-attach picker.
 *
 * The rule: the picker opens when the user *just appended* a trailing `~`
 * (i.e. the new value ends with `~`) AND the picker isn't already open. The
 * `~` is then stripped from the prompt by the caller. We guard on
 * `pickerIsOpen` so that typing `~` while the picker is already up is a
 * no-op (the keystroke goes to the picker's search field instead), and so
 * backspacing past a `~` doesn't keep re-summoning it.
 *
 * Extracted from ChatInput's `onChange` so the trigger rule is unit-testable
 * in isolation — ChatInput is too heavyweight to mount for a 3-line rule.
 */
export function shouldTriggerRemotePicker(
  nextPrompt: string,
  pickerIsOpen: boolean
): boolean {
  return !pickerIsOpen && nextPrompt.endsWith('~')
}

/**
 * Strip the trailing `~` that triggered the picker. Returns the input
 * unchanged if it doesn't end with `~`.
 */
export function stripTrailingTilde(prompt: string): string {
  return prompt.endsWith('~') ? prompt.slice(0, -1) : prompt
}
