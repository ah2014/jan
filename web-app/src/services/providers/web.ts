/**
 * Web Providers Service - Web UI build implementation
 *
 * Returns the predefined provider templates (OpenAI, Anthropic, etc.) so the
 * user can configure an OpenAI-compatible provider pointing at their own
 * inference server (e.g. a LAN llama.cpp instance). User-entered settings
 * (api_key, base_url) persist via the `useModelProvider` zustand store
 * (localStorage), so configuration done on the phone sticks for that browser.
 *
 * There are no local runtime engines on web (no llama.cpp/MLX inside the
 * browser), so unlike TauriProvidersService we don't merge EngineManager
 * entries. Inference calls the provider's `base_url` directly via fetch.
 */

import { predefinedProviders } from '@/constants/providers'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { DefaultProvidersService } from './default'

export class WebProvidersService extends DefaultProvidersService {
  fetch(): typeof fetch {
    return fetch
  }

  async getProviders(): Promise<ModelProvider[]> {
    // Predefined templates only; runtime (local) engines don't exist on web.
    return predefinedProviders as unknown as ModelProvider[]
  }

  async fetchModelsFromProvider(provider: ModelProvider): Promise<string[]> {
    if (!provider.base_url) {
      throw new Error('Provider must have base_url configured')
    }

    const keyChain = providerRemoteApiKeyChain(provider)
    const keyAttempts: (string | undefined)[] =
      keyChain.length > 0 ? keyChain : [undefined]

    let lastStatus = 0
    let lastStatusText = ''

    for (let ki = 0; ki < keyAttempts.length; ki++) {
      const key = keyAttempts[ki]
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (key) {
        headers['x-api-key'] = key
        headers['Authorization'] = `Bearer ${key}`
      }
      if (provider.custom_header) {
        provider.custom_header.forEach((header) => {
          headers[header.header] = header.value
        })
      }

      const response = await fetch(`${provider.base_url}/models`, {
        method: 'GET',
        headers,
      })

      lastStatus = response.status
      lastStatusText = response.statusText

      if ([401, 403, 429].includes(response.status) && ki < keyAttempts.length - 1) {
        continue
      }

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models from ${provider.provider}: ${response.status} ${response.statusText}`
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

    throw new Error(
      `Failed to fetch models from ${provider.provider}: ${lastStatus} ${lastStatusText}`
    )
  }

  async updateSettings(_providerName: string, _settings: ProviderSetting[]): Promise<void> {
    // Persisted via the zustand store; nothing to do server-side on web.
  }
}
