import type { RemoteFilesService, RemoteFileEntry, RemoteFileBytes } from './types'

/**
 * Default (and currently only) implementation of {@link RemoteFilesService}.
 *
 * Both desktop and web go through the same `window.core.api.<route>` shim (set
 * up in `lib/service.ts`): on Tauri it dispatches via
 * `core().invoke('snake_case_route', args)`, on web it POSTs to `/api/invoke`
 * with the camelCase route name. The Rust side maps those to the same
 * `list_allowed_attach_paths` / `walk_allowed_attach_paths` /
 * `read_attach_file_base64` command implementations, so behaviour is identical
 * on both surfaces.
 *
 * If a future platform needs a different transport, swap this class out the
 * same way e.g. `dialog/tauri.ts` overrides the default dialog service.
 */
export class DefaultRemoteFilesService implements RemoteFilesService {
  async listAllowedPaths(): Promise<string[]> {
    const result = await window.core.api.listAllowedAttachPaths()
    return (result ?? []) as string[]
  }

  async walk(): Promise<RemoteFileEntry[]> {
    const result = await window.core.api.walkAllowedAttachPaths()
    return (result ?? []) as RemoteFileEntry[]
  }

  async readBytes(path: string): Promise<RemoteFileBytes> {
    const result = await window.core.api.readAttachFileBase64({ path })
    return result as RemoteFileBytes
  }
}
