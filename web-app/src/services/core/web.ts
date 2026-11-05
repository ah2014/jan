/**
 * Web Core Service - Web UI build implementation
 *
 * Kept for the standalone web UI build served by the LAN web server: the
 * browser client has no Tauri filesystem, so core invokes are routed by the
 * `APIs` shim in `lib/service.ts` to the Jan web server's `/api/invoke`
 * endpoint instead of this service. Built-in extensions are handled by the
 * extension host (see `lib/extensions/builtins.ts`; the browser-safe subset
 * is compiled in via the IS_WEB_APP gate).
 */

import type { CoreService, InvokeArgs } from './types'

export class WebCoreService implements CoreService {
  async invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
    // Not used on web — the `APIs` shim in `lib/service.ts` handles routing.
    console.warn('WebCoreService.invoke called (use APIs instead):', command, args)
    return undefined as unknown as T
  }

  convertFileSrc(filePath: string): string {
    return filePath
  }

  async getAppToken(): Promise<string | null> {
    return null
  }
}
