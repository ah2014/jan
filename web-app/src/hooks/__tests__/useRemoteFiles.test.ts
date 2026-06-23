import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { RemoteFileEntry } from '@/services/remote-files/types'

// The hook pulls the service hub via `getServiceHub()` (non-React accessor).
// Mock it before importing the hook so the module-level cache resets cleanly.
const mockRemoteFiles = {
  listAllowedPaths: vi.fn(),
  walk: vi.fn(),
  readBytes: vi.fn(),
}

vi.mock('@/hooks/useServiceHub', () => ({
  // The hook module imports `getServiceHub`; the component-facing
  // `useServiceHub` is unused by this hook but kept for parity.
  getServiceHub: () => ({ remoteFiles: () => mockRemoteFiles }),
  useServiceHub: () => ({ remoteFiles: () => mockRemoteFiles }),
}))

import {
  useRemoteFiles,
  __resetRemoteFilesCacheForTests,
} from '../useRemoteFiles'

beforeEach(() => {
  mockRemoteFiles.listAllowedPaths.mockReset()
  mockRemoteFiles.walk.mockReset()
  mockRemoteFiles.readBytes.mockReset()
  __resetRemoteFilesCacheForTests()
})

describe('useRemoteFiles', () => {
  it('cold-starts a walk on first mount and surfaces the entries', async () => {
    mockRemoteFiles.listAllowedPaths.mockResolvedValueOnce(['/root'])
    mockRemoteFiles.walk.mockResolvedValueOnce([
      { name: 'a.txt', path: '/root/a.txt', isDir: false, size: 1 },
    ])
    const { result } = renderHook(() => useRemoteFiles())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.error).toBeNull()
    expect(result.current.allowListEmpty).toBe(false)
    expect(result.current.fetchedAt).not.toBeNull()
    expect(mockRemoteFiles.walk).toHaveBeenCalledOnce()
  })

  it('short-circuits to an empty allow-list state without walking', async () => {
    mockRemoteFiles.listAllowedPaths.mockResolvedValueOnce([])
    const { result } = renderHook(() => useRemoteFiles())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.allowListEmpty).toBe(true)
    expect(result.current.entries).toEqual([])
    // The walk should never run when no roots are configured.
    expect(mockRemoteFiles.walk).not.toHaveBeenCalled()
  })

  it('reuses the cached walk on second mount (no extra call)', async () => {
    mockRemoteFiles.listAllowedPaths.mockResolvedValueOnce(['/root'])
    mockRemoteFiles.walk.mockResolvedValueOnce([
      { name: 'a.txt', path: '/root/a.txt', isDir: false, size: 1 },
    ])
    const first = renderHook(() => useRemoteFiles())
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    first.unmount()

    // Second mount should NOT issue another walk.
    const second = renderHook(() => useRemoteFiles())
    await waitFor(() =>
      expect(second.result.current.entries).toHaveLength(1)
    )
    expect(mockRemoteFiles.walk).toHaveBeenCalledOnce()
  })

  it('refresh() forces a fresh walk even when the cache is warm', async () => {
    mockRemoteFiles.listAllowedPaths
      .mockResolvedValueOnce(['/root'])
      .mockResolvedValueOnce(['/root'])
    mockRemoteFiles.walk
      .mockResolvedValueOnce([
        { name: 'a.txt', path: '/root/a.txt', isDir: false, size: 1 },
      ])
      .mockResolvedValueOnce([
        { name: 'a.txt', path: '/root/a.txt', isDir: false, size: 1 },
        { name: 'b.txt', path: '/root/b.txt', isDir: false, size: 2 },
      ])

    const { result } = renderHook(() => useRemoteFiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toHaveLength(1)

    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.entries).toHaveLength(2))
    expect(mockRemoteFiles.walk).toHaveBeenCalledTimes(2)
  })

  it('surfaces backend errors', async () => {
    mockRemoteFiles.listAllowedPaths.mockResolvedValueOnce(['/root'])
    mockRemoteFiles.walk.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useRemoteFiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('boom')
    expect(result.current.entries).toEqual([])
  })

  it('a stale cold walk does not clobber a fresher forced walk', async () => {
    // Regression: both a cold walk and a forced refresh() walk are in flight.
    // If the forced walk resolves first (warm OS page cache) and the cold walk
    // resolves second, the cold walk must NOT overwrite the fresh cache/state.
    type Done = (entries: RemoteFileEntry[]) => void
    const defer = (): { promise: Promise<RemoteFileEntry[]>; resolve: Done } => {
      let resolve!: Done
      const promise = new Promise<RemoteFileEntry[]>((r) => {
        resolve = r
      })
      return { promise, resolve }
    }

    // Cold walk: 1 entry, resolves slowly.
    const cold = defer()
    // Forced walk: 2 entries, resolves first.
    const forced = defer()

    mockRemoteFiles.listAllowedPaths.mockResolvedValue(['/root'])
    mockRemoteFiles.walk.mockReturnValue(cold.promise)

    const { result } = renderHook(() => useRemoteFiles())
    // Let the cold walk's listAllowedPaths resolve + walk() be captured.
    await waitFor(() => expect(mockRemoteFiles.walk).toHaveBeenCalledOnce())

    // Force a refresh; it must supersede the cold walk.
    mockRemoteFiles.walk.mockReturnValue(forced.promise)
    let refreshPromise!: Promise<void>
    act(() => {
      refreshPromise = result.current.refresh()
    })

    // Forced walk resolves first with fresh data.
    await act(async () => {
      forced.resolve([
        { name: 'a.txt', path: '/root/a.txt', isDir: false, size: 1 },
        { name: 'b.txt', path: '/root/b.txt', isDir: false, size: 2 },
      ])
      await refreshPromise
    })
    await waitFor(() => expect(result.current.entries).toHaveLength(2))

    // Now the stale cold walk resolves. It must be ignored.
    await act(async () => {
      cold.resolve([
        {
          name: 'stale.txt',
          path: '/root/stale.txt',
          isDir: false,
          size: 1,
        },
      ])
      // Flush any pending microtasks so the stale walk's commit (if any) runs.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.entries).toHaveLength(2)
    expect(
      result.current.entries.some((e) => e.name === 'stale.txt')
    ).toBe(false)
  })
})
