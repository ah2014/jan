import { CoreRoutes, APIRoutes } from '@janhq/core'
import type { DownloadProgress, DownloadProgressHandler, Unsubscribe } from '@janhq/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform'
import type { InvokeArgs } from '@/services/core/types'
import { openExternalUrl } from '@/lib/externalLink'

export const AppRoutes = [
  'getTools',
  'callTool',
  'cancelToolCall',
  'listThreads',
  'createThread',
  'modifyThread',
  'deleteThread',
  'listMessages',
  'createMessage',
  'modifyMessage',
  'deleteMessage',
  'getThreadAssistant',
  'createThreadAssistant',
  'modifyThreadAssistant',
  'saveMcpConfigs',
  'getMcpConfigs',
  'restartMcpServers',
  'getConnectedServers',
  'readLogs',
  'changeAppDataFolder',
  // Provider configs. Handled by Tauri command on desktop and by the web
  // server's `/api/invoke` dispatcher on web. The web path returns redacted
  // configs (no API keys) — inference is proxied server-side via `/api/proxy`.
  'listProviderConfigs',
  'getProviderConfig',
  'registerProviderConfig',
  'unregisterProviderConfig',
  // Targeted per-model capability override (vision/audio/…). Preserves the
  // provider's key/base_url, so the web UI (which never holds the key) can
  // persist model settings into the shared `providers.json`.
  'setProviderModelCapabilities',
  // Targeted model-list update (add/remove models from a provider). Like the
  // capability override it preserves the provider's key/base_url; the web UI
  // uses it to write model edits made in the browser into `providers.json`.
  'setProviderModels',
  // Remote-attach picker (`~` in the composer): browse/attach files living on
  // the backend host without uploading. Allow-list of root folders lives in
  // <jan_data_folder>/allowed_attach_paths.json (hand-edited; no UI).
  // Handled by Tauri command on desktop and by /api/invoke on web.
  'listAllowedAttachPaths',
  'walkAllowedAttachPaths',
  'readAttachFileBase64',
]
// Define API routes based on different route types
export const Routes = [...CoreRoutes, ...APIRoutes, ...AppRoutes].map((r) => ({
  path: `app`,
  route: r,
}))

// Re-exported: extensions reach it as `window.core.api.openExternalUrl`.
export { openExternalUrl }

// Events are not request/response, so this cannot be a mapped route: the host
// emits progress for a task on its own `download-<taskId>` channel.
export async function onDownloadProgress(
  taskId: string,
  handler: DownloadProgressHandler
): Promise<Unsubscribe> {
  return getServiceHub()
    .events()
    .listen<DownloadProgress>(`download-${taskId}`, (event) => handler(event.payload))
}

/**
 * Web-only invoke: POST `{ route, args }` to the Jan web server's `/api/invoke`
 * endpoint, which dispatches to the same command implementations the desktop
 * app uses via Tauri. Returns the parsed JSON result or throws on error.
 */
async function webInvoke<T>(route: string, args?: InvokeArgs): Promise<T> {
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route, args: args ?? {} }),
  })
  if (!res.ok) {
    let message = `Request failed: ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      /* ignore JSON parse errors */
    }
    throw new Error(message)
  }
  return (await res.json()) as Promise<T>
}

export const APIs = {
  ...Object.values(Routes).reduce((acc, proxy) => {
    return {
      ...acc,
      [proxy.route]: (args?: InvokeArgs) => {
        if (isPlatformTauri()) {
          // For Tauri platform, use the service hub to invoke commands
          const command = proxy.route.replace(/([A-Z])/g, '_$1').toLowerCase()

          // Backward-compatible shim for start_server: wrap args into { config }
          if (command === 'start_server') {
            // If already using new shape, pass through
            if (args && 'config' in args) {
              return getServiceHub().core().invoke(command, args)
            }

            const raw: Record<string, unknown> = (args || {}) as Record<string, unknown>

            const pickString = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
              for (const key of keys) {
                const value = obj[key]
                if (typeof value === 'string') return value
              }
              return undefined
            }

            const pickNumber = (obj: Record<string, unknown>, keys: string[]): number | undefined => {
              for (const key of keys) {
                const value = obj[key]
                if (typeof value === 'number') return value
              }
              return undefined
            }

            const pickStringArray = (obj: Record<string, unknown>, keys: string[]): string[] | undefined => {
              for (const key of keys) {
                const value = obj[key]
                if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
                  return value as string[]
                }
              }
              return undefined
            }

            const pickBoolean = (
              obj: Record<string, unknown>,
              keys: string[]
            ): boolean | undefined => {
              for (const key of keys) {
                const value = obj[key]
                if (typeof value === 'boolean') return value
              }
              return undefined
            }

            const config = {
              host: pickString(raw, ['host']),
              port: pickNumber(raw, ['port']),
              prefix: pickString(raw, ['prefix']),
              api_key: pickString(raw, ['api_key', 'apiKey']),
              trusted_hosts: pickStringArray(raw, ['trusted_hosts', 'trustedHosts']),
              proxy_timeout: pickNumber(raw, ['proxy_timeout', 'proxyTimeout']),
              enable_server_tool_execution: pickBoolean(raw, [
                'enable_server_tool_execution',
                'enableServerToolExecution',
              ]),
              cors_enabled: pickBoolean(raw, [
                'cors_enabled',
                'isCorsEnabled',
                'corsEnabled',
              ]),
            }
            return getServiceHub().core().invoke(command, { config })
          }

          return getServiceHub().core().invoke(command, args)
        } else {
          // Web platform: route to the Jan web server's /api/invoke endpoint.
          return webInvoke(proxy.route, args)
        }
      },
    }
  }, {}),
  openExternalUrl,
  onDownloadProgress,
}
