/**
 * Web Providers Service - Web UI build implementation
 *
 * Providers and models are shared with the desktop app: they live in the
 * backend's persisted `providers.json` and are read here via the
 * `listProviderConfigs` command (dispatched through `/api/invoke`). API keys
 * are redacted server-side and never reach the browser — inference is proxied
 * through the backend (`POST /api/proxy`), which looks the keys up itself.
 *
 * There are no local runtime engines on web (no llama.cpp/MLX inside the
 * browser), so unlike TauriProvidersService we don't merge EngineManager
 * entries.
 */

import { predefinedProviders } from '@/constants/providers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isLocalProvider } from '@/lib/utils'
import {
  API_KEY_FALLBACKS_SETTING_KEY,
  parseApiKeyFallbacks,
  providerRemoteApiKeyChain,
} from '@/lib/provider-api-keys'
import { DefaultProvidersService } from './default'

/**
 * Local inference engines never belong in the shared remote-provider store:
 * their model lists come from the local disk / engine, and on web there are no
 * engines at all, so `isLocalProvider` (which probes the live engine manager)
 * is supplemented with the well-known engine provider names.
 */
const isLocalEngineProvider = (name: string): boolean =>
  name === 'llamacpp' || name === 'mlx' || !!isLocalProvider(name)

/**
 * Redacted provider config as returned by the backend's `listProviderConfigs`.
 * `api_key`/`api_keys` are always stripped on the web path.
 */
type BackendProviderConfig = {
  provider: string
  api_key: string | null
  api_keys: string[]
  base_url?: string | null
  custom_headers?: { header: string; value: string }[]
  models: string[]
  /** Per-model capability overrides (vision/audio/…), keyed by model id. */
  model_capabilities?: Record<string, string[]>
}

/** Provider names present in the backend's `providers.json` at the last fetch. */
const backendRegistry = new Set<string>()

/** Last model-id list known to be in the backend, per provider. Lets
 * `syncProviderToBackend` skip no-op writes (it fires on every store change). */
const lastSyncedModelIds = new Map<string, string[]>()

/** Serialize syncs per provider so rapid edits can't write out of order. */
const syncChains = new Map<string, Promise<void>>()

function modelIdsOf(provider: ModelProvider): string[] {
  const ids = (provider.models ?? [])
    .map((m) => (typeof m.id === 'string' && m.id ? m.id : m.model))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return Array.from(new Set(ids))
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Full registration payload for a provider the backend doesn't know yet. */
async function registerProviderFromState(
  provider: ModelProvider,
  models: string[]
): Promise<void> {
  const chain = providerRemoteApiKeyChain(provider)
  await window.core.api.registerProviderConfig({
    provider: provider.provider,
    api_key: chain[0] ?? null,
    api_keys: chain.slice(1),
    base_url: provider.base_url ?? null,
    custom_headers: (provider.custom_header ?? []).map((h) => ({
      header: h.header,
      value: h.value,
    })),
    models,
    ...(provider.api_type ? { api_type: provider.api_type } : {}),
  })
  backendRegistry.add(provider.provider)
}

export class WebProvidersService extends DefaultProvidersService {
  fetch(): typeof fetch {
    return fetch
  }

  async getProviders(): Promise<ModelProvider[]> {
    // Templates carry the UI metadata (setting descriptors, default model
    // lists). Backend configs carry the operational, shared fields
    // (base_url, custom_headers, model ids). Merge by provider name, letting
    // the backend override the operational bits.
    const templates = predefinedProviders as unknown as ModelProvider[]
    const merged = new Map<string, ModelProvider>(
      templates.map((t) => [t.provider, structuredClone(t)])
    )

    let configs: BackendProviderConfig[] = []
    try {
      configs = await window.core.api.listProviderConfigs()
    } catch (e) {
      console.warn(
        '[web] Failed to load provider configs from backend; showing templates only.',
        e
      )
    }

    // Refresh the write-through bookkeeping from the authoritative store.
    backendRegistry.clear()
    for (const c of configs) {
      backendRegistry.add(c.provider)
      lastSyncedModelIds.set(c.provider, [...(c.models ?? [])])
    }

    for (const c of configs) {
      const tmpl = merged.get(c.provider)
      const base: ModelProvider = tmpl ?? {
        active: false,
        persist: true,
        provider: c.provider,
        settings: [],
        models: [],
      }
      // Per-model capability overrides from the shared backend (the web has no
      // engine to detect vision/audio, so these are the authoritative values).
      const capsFor = (id: string) => c.model_capabilities?.[id]
      merged.set(c.provider, {
        ...base,
        provider: c.provider,
        // Operational fields come from the shared backend config.
        base_url: c.base_url ?? base.base_url,
        custom_header: (c.custom_headers ?? []).map((h) => ({
          header: h.header,
          value: h.value,
        })),
        // Keys are never present on web; inference is server-side.
        api_key: undefined,
        api_key_fallbacks: [],
        models:
          c.models && c.models.length > 0
            ? c.models.map((id) => {
                const tmplModel = base.models.find((m) => m.id === id)
                const caps = capsFor(id)
                return {
                  ...(tmplModel ?? {}),
                  id,
                  model: id,
                  name: id,
                  provider: c.provider,
                  // Backend overrides win; fall back to template/predefined caps.
                  ...(caps ? { capabilities: caps } : {}),
                }
              })
            : base.models,
      })
    }

    // Providers not in the backend start their sync baseline from the list we
    // just handed the store, so only real user edits trigger a write.
    for (const p of merged.values()) {
      if (!lastSyncedModelIds.has(p.provider)) {
        lastSyncedModelIds.set(p.provider, modelIdsOf(p))
      }
    }

    return Array.from(merged.values())
  }

  /**
   * Write-through for the browser: push the provider's model list into the
   * shared `providers.json`. Registered providers get a targeted
   * `setProviderModels` (their API key / base_url are preserved server-side);
   * unknown providers are registered in full — the browser still holds the
   * base_url (and, right after creation, the typed API key).
   */
  async syncProviderToBackend(provider: ModelProvider): Promise<void> {
    if (isLocalEngineProvider(provider.provider)) return
    const name = provider.provider
    const ids = modelIdsOf(provider)
    const prev = lastSyncedModelIds.get(name)
    if (prev && sameIds(prev, ids)) return

    const run = (syncChains.get(name) ?? Promise.resolve())
      .then(async () => {
        if (backendRegistry.has(name)) {
          await window.core.api.setProviderModels({
            provider: name,
            models: ids,
          })
        } else {
          await registerProviderFromState(provider, ids)
        }
        lastSyncedModelIds.set(name, ids)
      })
      .catch((e) => {
        // Leave the baseline untouched so the next store change retries.
        console.warn(`[web] Failed to sync models for '${name}' to backend:`, e)
      })
    // Keep the chain alive even when a link fails.
    syncChains.set(
      name,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    await run
  }

  async fetchModelsFromProvider(provider: ModelProvider): Promise<string[]> {
    if (!provider.base_url) {
      throw new Error('Provider must have base_url configured')
    }

    // Route through the backend so the (possibly non-CORS, possibly key-less)
    // upstream is reached server-side. The backend applies the provider's
    // stored key chain + custom headers.
    const response = await fetch('/api/proxy', {
      method: 'GET',
      headers: {
        'X-Jan-Provider': provider.provider,
        'X-Jan-Target-Url': `${provider.base_url}/models`,
      },
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          `Authentication failed: API key is required or invalid for ${provider.provider}`
        )
      }
      if (response.status === 403) {
        throw new Error(
          `Access forbidden: Check your API key permissions for ${provider.provider}`
        )
      }
      if (response.status === 404) {
        throw new Error(
          `Models endpoint not found for ${provider.provider}. Check the base URL configuration.`
        )
      }
      let detail = ''
      try {
        detail = await response.text()
      } catch {
        /* ignore */
      }
      throw new Error(
        `Failed to fetch models from ${provider.provider}: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
      )
    }

    const data = await response.json()
    if (data.data && Array.isArray(data.data)) {
      return data.data.map((model: { id: string }) => model.id).filter(Boolean)
    }
    if (Array.isArray(data)) {
      return data
        .filter(Boolean)
        .map((model) =>
          typeof model === 'object' && 'id' in model ? model.id : model
        )
    }
    if (data.models && Array.isArray(data.models)) {
      return data.models
        .map((model: string | { id: string }) =>
          typeof model === 'string' ? model : model.id
        )
        .filter(Boolean)
    }
    return []
  }

  async updateSettings(
    providerName: string,
    settings: ProviderSetting[]
  ): Promise<void> {
    // The web has no runtime engines; the only provider settings that matter
    // here are the API-key chain entries. Persist them into the shared backend
    // store: the browser never keeps keys (redacted on read, stripped from
    // localStorage), and /api/proxy reads them server-side, so the backend is
    // the only place a web-entered key can survive a refresh.
    const provider = useModelProvider.getState().getProviderByName(providerName)
    if (!provider || isLocalEngineProvider(providerName)) return
    const valueOf = (key: string) =>
      settings.find((s) => s.key === key)?.controller_props?.value
    const primary =
      typeof valueOf('api-key') === 'string'
        ? (valueOf('api-key') as string).trim()
        : ''
    const fallbacks = parseApiKeyFallbacks(
      valueOf(API_KEY_FALLBACKS_SETTING_KEY)
    )
    const chain = [...(primary ? [primary] : []), ...fallbacks]
    try {
      await window.core.api.registerProviderConfig({
        provider: providerName,
        api_key: chain[0] ?? null,
        api_keys: chain.slice(1),
        base_url: provider.base_url ?? null,
        custom_headers: (provider.custom_header ?? []).map((h) => ({
          header: h.header,
          value: h.value,
        })),
        models: modelIdsOf(provider),
        ...(provider.api_type ? { api_type: provider.api_type } : {}),
      })
      backendRegistry.add(providerName)
    } catch (e) {
      console.warn(
        `[web] Failed to persist settings for '${providerName}' to backend:`,
        e
      )
    }
  }

  async deleteProviderKeys(providerName: string): Promise<void> {
    // Clearing the key is an explicit user action: push an empty key chain to
    // the shared store so the server-side proxy stops using the old key.
    const provider = useModelProvider.getState().getProviderByName(providerName)
    if (!provider || !backendRegistry.has(providerName)) return
    try {
      await window.core.api.registerProviderConfig({
        provider: providerName,
        api_key: null,
        api_keys: [],
        base_url: provider.base_url ?? null,
        custom_headers: (provider.custom_header ?? []).map((h) => ({
          header: h.header,
          value: h.value,
        })),
        models: modelIdsOf(provider),
        ...(provider.api_type ? { api_type: provider.api_type } : {}),
      })
    } catch (e) {
      console.warn(
        `[web] Failed to clear stored keys for '${providerName}':`,
        e
      )
    }
  }
}
