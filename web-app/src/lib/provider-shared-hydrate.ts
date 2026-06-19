/**
 * One-way hydration (desktop only): pulls the shared provider configs from the
 * backend's `providers.json` into the local `useModelProvider` store, so the
 * desktop UI shows the same providers/models as the web UI.
 *
 * This is **read-only with respect to the backend**: it never writes back to
 * `providers.json`, so it cannot clobber the shared store (the bug that bit us
 * with the old write-through). Operational fields (base_url, API keys, custom
 * headers) from the backend override local values; models are unioned so
 * backend-only model ids appear while existing template/model richness is kept.
 *
 * Runs once at desktop startup. The web build doesn't use this —
 * `WebProvidersService.getProviders()` already reads the backend directly.
 */

import { useModelProvider } from '@/hooks/useModelProvider'
import { isPlatformTauri } from '@/lib/platform'

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

export async function hydrateProvidersFromBackend(): Promise<void> {
  if (!isPlatformTauri()) return

  let configs: BackendProviderConfig[]
  try {
    configs = await window.core.api.listProviderConfigs()
  } catch (e) {
    console.warn('[provider-hydrate] failed to load shared configs', e)
    return
  }
  if (!Array.isArray(configs) || configs.length === 0) return

  for (const c of configs) {
    const keyChain =
      c.api_keys && c.api_keys.length > 0
        ? c.api_keys
        : c.api_key
          ? [c.api_key]
          : []
    const customHeader = (c.custom_headers ?? []).map((h) => ({
      header: h.header,
      value: h.value,
    }))
    const backendModelIds = (c.models ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    )

    const existing = useModelProvider.getState().getProviderByName(c.provider)

    // Operational fields are authoritative from the shared store.
    const operational: Partial<ModelProvider> = {
      base_url: c.base_url ?? existing?.base_url,
      api_key: keyChain[0] ?? existing?.api_key,
      api_key_fallbacks:
        keyChain.length > 1 ? keyChain.slice(1) : existing?.api_key_fallbacks,
      custom_header:
        customHeader.length > 0 ? customHeader : existing?.custom_header,
    }

    if (existing) {
      // Union models: keep existing rich model objects, append backend-only ids.
      const existingIds = new Set(
        (existing.models ?? [])
          .map((m) => m.id ?? m.model)
          .filter((id): id is string => typeof id === 'string')
      )
      const extraModels = backendModelIds
        .filter((id) => !existingIds.has(id))
        .map((id) => ({ id, model: id, name: id, provider: c.provider }))
      const models =
        extraModels.length > 0
          ? [...(existing.models ?? []), ...extraModels]
          : (existing.models ?? [])

      // Apply per-model capability overrides from the shared backend.
      const modelsWithCaps = models.map((m) => {
        const id = m.id ?? m.model
        const caps = id ? c.model_capabilities?.[id] : undefined
        return caps ? { ...m, capabilities: caps } : m
      })

      useModelProvider.getState().updateProvider(c.provider, {
        ...operational,
        models: modelsWithCaps,
      })
    } else {
      useModelProvider.getState().addProvider({
        active: false,
        persist: true,
        provider: c.provider,
        settings: [],
        models: backendModelIds.map((id) => {
          const caps = c.model_capabilities?.[id]
          return {
            id,
            model: id,
            name: id,
            provider: c.provider,
            ...(caps ? { capabilities: caps } : {}),
          }
        }),
        ...operational,
      } as ModelProvider)
    }
  }
}
