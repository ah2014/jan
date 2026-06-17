/**
 * Web Core Service - Web UI build implementation
 *
 * Mirrors MobileCoreService: instead of reading extensions from the
 * filesystem (which doesn't exist in a browser), it returns pre-bundled
 * extension instances. The extension classes themselves are unchanged — they
 * call `window.core.api.*`, which on the web build routes to the Jan web
 * server's `/api/invoke` endpoint (see `services/index.ts` + `lib/service.ts`).
 *
 * Assistant + conversational extensions are bundled here so the web UI can
 * list/edit assistants and threads/messages backed by the same Jan data
 * folder the desktop app uses.
 */

import type { ExtensionManifest } from '@/lib/extension'
import type { CoreService, InvokeArgs } from './types'
import JanConversationalExtension from '@janhq/conversational-extension'
import JanAssistantExtension from '@janhq/assistant-extension'

export class WebCoreService implements CoreService {
  async invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
    // Not used on web — the `APIs` shim in `lib/service.ts` handles routing.
    console.warn('WebCoreService.invoke called (use APIs instead):', command, args)
    return undefined as unknown as T
  }

  convertFileSrc(filePath: string): string {
    return filePath
  }

  /**
   * Return pre-bundled extension instances (no filesystem, no dynamic import).
   */
  async getActiveExtensions(): Promise<ExtensionManifest[]> {
    const conversationalExt = new JanConversationalExtension(
      'built-in',
      '@janhq/conversational-extension',
      'Conversational Extension',
      true,
      'Manages conversation threads and messages',
      '1.0.0'
    )

    const assistantExt = new JanAssistantExtension(
      'built-in',
      '@janhq/assistant-extension',
      'Assistant Extension',
      true,
      'Manages assistants',
      '1.0.0'
    )

    return [
      {
        name: '@janhq/conversational-extension',
        productName: 'Conversational Extension',
        url: 'built-in',
        active: true,
        description: 'Manages conversation threads and messages',
        version: '1.0.0',
        extensionInstance: conversationalExt,
      },
      {
        name: '@janhq/assistant-extension',
        productName: 'Assistant Extension',
        url: 'built-in',
        active: true,
        description: 'Manages assistants',
        version: '1.0.0',
        extensionInstance: assistantExt,
      },
    ]
  }

  async installExtensions(): Promise<void> {
    // No-op on web — extensions are bundled.
  }

  async installExtension(): Promise<ExtensionManifest[]> {
    return this.getActiveExtensions()
  }

  async uninstallExtension(): Promise<boolean> {
    return false
  }

  async getAppToken(): Promise<string | null> {
    return null
  }
}
