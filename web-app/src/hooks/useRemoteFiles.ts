import { useCallback, useEffect, useRef, useState } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { RemoteFileEntry } from '@/services/remote-files/types'

/**
 * Module-level cache of the recursive walk over the configured
 * `allowed_attach_paths.json` roots.
 *
 * The walk is expensive (bounded to 50k entries server-side) and the result is
 * needed by every `~` picker open, but rarely changes during a session, so we
 * cache it across mounts and across navigations. A user-initiated `refresh()`
 * invalidates the cache and re-fetches.
 *
 * The cache lives at module scope (not inside React state) so multiple mounted
 * pickers share one walk in flight and one cached result. React state is just
 * a mirror used to trigger re-renders.
 */
type CachedWalk = {
  entries: RemoteFileEntry[]
  /** Epoch ms of the last successful walk — surfaced in the UI for the user. */
  fetchedAt: number
}

let cache: CachedWalk | null = null
let inflight: Promise<RemoteFileEntry[]> | null = null
/**
 * Monotonic counter incremented every time a new walk is initiated. A walk
 * captures the value at start; before writing cache/state it checks it still
 * equals the latest, so a slower stale walk cannot clobber a fresher one.
 *
 * This fixes the race where a cold walk and a forced `refresh()` walk are both
 * in flight: if the forced walk resolves first (warm OS page cache) and the
 * cold walk resolves second, the cold walk would otherwise overwrite the fresh
 * cache/state with now-stale entries.
 */
let walkSeq = 0

type State = {
  entries: RemoteFileEntry[]
  loading: boolean
  error: string | null
  fetchedAt: number | null
  /**
   * True until the first successful walk returns a non-empty allow-list.
   * Distinct from `loading` because the UI wants to tell the user "edit
   * allowed_attach_paths.json" specifically when the allow-list is empty,
   * not while it's still fetching.
   */
  allowListEmpty: boolean
}

const INITIAL_STATE: State = {
  entries: [],
  loading: false,
  error: null,
  fetchedAt: null,
  allowListEmpty: false,
}

/**
 * React hook over the cached remote-files walk. Calling `refresh()` forces a
 * fresh walk (re-reads `allowed_attach_paths.json` on the backend and re-walks
 * every root). The first mount triggers a walk if the cache is cold.
 */
export function useRemoteFiles() {
  const [state, setState] = useState<State>(
    cache
      ? {
          ...INITIAL_STATE,
          entries: cache.entries,
          fetchedAt: cache.fetchedAt,
        }
      : INITIAL_STATE
  )
  // Guards against a mount → unmount → remount race re-issuing the walk.
  const mountedRef = useRef(true)

  const performWalk = useCallback(
    async (opts: { force?: boolean } = {}): Promise<void> => {
      if (inflight && !opts.force) {
        // Another picker already kicked off the cold walk — ride along.
        // Capture the seq owned by that in-flight walk so we only commit its
        // result if no newer walk has superseded it.
        const mySeq = walkSeq
        try {
          const entries = await inflight
          if (!mountedRef.current) return
          if (mySeq !== walkSeq) return // superseded by a newer walk
          setState({
            entries,
            loading: false,
            error: null,
            fetchedAt: cache?.fetchedAt ?? null,
            allowListEmpty: entries.length === 0,
          })
        } catch (e) {
          if (!mountedRef.current) return
          if (mySeq !== walkSeq) return
          setState((s) => ({
            ...s,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          }))
        }
        return
      }

      // This call initiates a fresh walk — claim the next sequence number so
      // any earlier in-flight walks know they've been superseded.
      const mySeq = ++walkSeq
      setState((s) => ({ ...s, loading: true, error: null }))
      inflight = (async () => {
        const hub = getServiceHub()
        // If the user hasn't configured any roots, short-circuit so the UI can
        // show the "edit allowed_attach_paths.json" empty state immediately,
        // without paying for a no-op walk.
        const roots = await hub.remoteFiles().listAllowedPaths()
        if (roots.length === 0) {
          cache = { entries: [], fetchedAt: Date.now() }
          return []
        }
        return await hub.remoteFiles().walk()
      })()

      try {
        const entries = await inflight
        if (mySeq !== walkSeq) return // superseded; don't clobber fresh cache
        cache = { entries, fetchedAt: Date.now() }
        if (!mountedRef.current) return
        setState({
          entries,
          loading: false,
          error: null,
          fetchedAt: cache.fetchedAt,
          allowListEmpty: entries.length === 0,
        })
      } catch (e) {
        if (!mountedRef.current) return
        if (mySeq !== walkSeq) return
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }))
      } finally {
        // Only clear inflight if we're still the latest walk; a newer forced
        // walk owns the slot now and must not have its promise nulled.
        if (mySeq === walkSeq) inflight = null
      }
    },
    []
  )

  // Cold-start the cache on first mount; subsequent mounts reuse it.
  useEffect(() => {
    mountedRef.current = true
    if (!cache && !inflight) {
      void performWalk()
    } else if (cache) {
      // Cache already warm from another mount — just sync local state.
      setState((s) => ({
        ...s,
        entries: cache!.entries,
        fetchedAt: cache!.fetchedAt,
        allowListEmpty: cache!.entries.length === 0,
      }))
    }
    return () => {
      mountedRef.current = false
    }
  }, [performWalk])

  const refresh = useCallback(async () => {
    await performWalk({ force: true })
  }, [performWalk])

  return {
    entries: state.entries,
    loading: state.loading,
    error: state.error,
    fetchedAt: state.fetchedAt,
    allowListEmpty: state.allowListEmpty,
    refresh,
  }
}

/**
 * Test-only helper: reset the module-level cache between vitest cases so
 * assertions don't leak across tests. Not part of the public API.
 */
export function __resetRemoteFilesCacheForTests(): void {
  cache = null
  inflight = null
  walkSeq = 0
}
