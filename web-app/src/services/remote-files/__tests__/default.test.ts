import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DefaultRemoteFilesService } from '../default'

type ApiFn = (args?: unknown) => Promise<unknown>

const mockApi = {
  listAllowedAttachPaths: vi.fn<ApiFn>(),
  walkAllowedAttachPaths: vi.fn<ApiFn>(),
  readAttachFileBase64: vi.fn<ApiFn>(),
}

beforeEach(() => {
  mockApi.listAllowedAttachPaths.mockReset()
  mockApi.walkAllowedAttachPaths.mockReset()
  mockApi.readAttachFileBase64.mockReset()
  ;(globalThis as any).window = (globalThis as any).window || {}
  ;(window as any).core = { api: mockApi }
})

describe('DefaultRemoteFilesService.listAllowedPaths', () => {
  it('delegates to window.core.api.listAllowedAttachPaths', async () => {
    mockApi.listAllowedAttachPaths.mockResolvedValueOnce([
      '/home/me/docs',
      '/home/me/projects',
    ])
    const svc = new DefaultRemoteFilesService()
    const out = await svc.listAllowedPaths()
    expect(mockApi.listAllowedAttachPaths).toHaveBeenCalledOnce()
    expect(out).toEqual(['/home/me/docs', '/home/me/projects'])
  })

  it('returns [] when backend returns null', async () => {
    mockApi.listAllowedAttachPaths.mockResolvedValueOnce(null)
    const svc = new DefaultRemoteFilesService()
    expect(await svc.listAllowedPaths()).toEqual([])
  })
})

describe('DefaultRemoteFilesService.walk', () => {
  it('delegates to window.core.api.walkAllowedAttachPaths', async () => {
    const entries = [
      { name: 'a.txt', path: '/x/a.txt', isDir: false, size: 10 },
      { name: 'sub', path: '/x/sub', isDir: true, size: 0 },
    ]
    mockApi.walkAllowedAttachPaths.mockResolvedValueOnce(entries)
    const svc = new DefaultRemoteFilesService()
    expect(await svc.walk()).toEqual(entries)
    expect(mockApi.walkAllowedAttachPaths).toHaveBeenCalledOnce()
  })

  it('returns [] on null result', async () => {
    mockApi.walkAllowedAttachPaths.mockResolvedValueOnce(null)
    expect(await new DefaultRemoteFilesService().walk()).toEqual([])
  })
})

describe('DefaultRemoteFilesService.readBytes', () => {
  it('passes { path } to window.core.api.readAttachFileBase64', async () => {
    mockApi.readAttachFileBase64.mockResolvedValueOnce({
      base64: 'AAAA',
      size: 3,
    })
    const svc = new DefaultRemoteFilesService()
    const out = await svc.readBytes('/x/a.bin')
    expect(mockApi.readAttachFileBase64).toHaveBeenCalledWith({
      path: '/x/a.bin',
    })
    expect(out).toEqual({ base64: 'AAAA', size: 3 })
  })
})
