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
import { DefaultProvidersService } from './default'

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

    return Array.from(merged.values())
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
    _providerName: string,
    _settings: ProviderSetting[]
  ): Promise<void> {
    // Web has no runtime engines; engine settings are desktop-only.
    void _providerName
    void _settings
  }
}
