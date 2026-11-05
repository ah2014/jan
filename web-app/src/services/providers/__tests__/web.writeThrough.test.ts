/**
 * WebProvidersService write-through tests.
 *
 * The web UI must persist provider/model edits into the backend's shared
 * `providers.json` (via /api/invoke) rather than leaving them in this
 * browser's localStorage only. These tests cover:
 *
 *   - `syncProviderToBackend`: targeted `setProviderModels` for
 *     backend-registered providers, full `registerProviderConfig` for
 *     unknown ones, dedupe of no-op calls, and skip for local engines.
 *   - `updateSettings`: API-key chains typed in the browser are registered
 *     server-side (with base_url / models / api_type) since the browser never
 *     keeps keys.
 *   - `deleteProviderKeys`: clearing keys pushes an empty chain.
 *   - `getProviders`: refreshes the sync baseline from the backend.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { WebProvidersService } from '../web'
import { useModelProvider } from '@/hooks/useModelProvider'

const api = {
  listProviderConfigs: vi.fn(),
  setProviderModels: vi.fn(),
  setProviderModelCapabilities: vi.fn(),
  registerProviderConfig: vi.fn(),
}

// jsdom in this repo doesn't expose a working localStorage (known baseline
// issue) — polyfill it: seeding the store triggers zustand persist writes
// through backendStorage's web fallback.
beforeAll(() => {
  if (typeof window.localStorage === 'undefined' || !window.localStorage) {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size
        },
      },
    })
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listProviderConfigs.mockResolvedValue([])
  api.setProviderModels.mockResolvedValue({})
  api.registerProviderConfig.mockResolvedValue({})
  ;(window as unknown as { core: unknown }).core = {
    api: {
      ...api,
      // The store's set() triggers a persist write through backendStorage —
      // stub the few entries the shim routes may touch.
    },
  }
})

const provider = (overrides: Partial<ModelProvider>): ModelProvider =>
  ({
    provider: 'my-lab',
    active: true,
    persist: true,
    base_url: 'https://my-lab.example.com/v1',
    api_key: 'sk-primary',
    api_key_fallbacks: ['sk-backup'],
    custom_header: [{ header: 'x-extra', value: '1' }],
    settings: [],
    api_type: 'anthropic',
    ...overrides,
  }) as ModelProvider

function seedStore(p: ModelProvider) {
  useModelProvider.setState({
    providers: [p],
    selectedProvider: p.provider,
    selectedModel: null,
    deletedModels: [],
  })
}

describe('WebProvidersService.syncProviderToBackend', () => {
  it('skips local engine providers', async () => {
    const svc = new WebProvidersService()
    await svc.syncProviderToBackend(provider({ provider: 'llamacpp' }))
    expect(api.setProviderModels).not.toHaveBeenCalled()
    expect(api.registerProviderConfig).not.toHaveBeenCalled()
  })

  it('uses targeted setProviderModels for backend-registered providers', async () => {
    api.listProviderConfigs.mockResolvedValue([
      {
        provider: 'my-lab',
        api_key: null,
        api_keys: [],
        base_url: 'https://my-lab.example.com/v1',
        custom_headers: [],
        models: ['lab-70b'],
        model_capabilities: {},
      },
    ])
    const svc = new WebProvidersService()
    // getProviders seeds the registry + sync baseline from the backend.
    await svc.getProviders()

    await svc.syncProviderToBackend(
      provider({
        models: [
          { id: 'lab-70b' } as Model,
          { id: 'lab-8b' } as Model,
        ],
      })
    )

    expect(api.setProviderModels).toHaveBeenCalledWith({
      provider: 'my-lab',
      models: ['lab-70b', 'lab-8b'],
    })
    expect(api.registerProviderConfig).not.toHaveBeenCalled()
  })

  it('is a no-op when the model list matches the baseline', async () => {
    api.listProviderConfigs.mockResolvedValue([
      {
        provider: 'my-lab',
        api_key: null,
        api_keys: [],
        models: ['lab-70b'],
        custom_headers: [],
      },
    ])
    const svc = new WebProvidersService()
    await svc.getProviders()

    await svc.syncProviderToBackend(
      provider({ models: [{ id: 'lab-70b' } as Model] })
    )

    expect(api.setProviderModels).not.toHaveBeenCalled()
  })

  it('fully registers providers the backend does not know yet', async () => {
    api.listProviderConfigs.mockResolvedValue([])
    const svc = new WebProvidersService()
    await svc.getProviders() // baseline: template providers, not `my-lab`

    await svc.syncProviderToBackend(
      provider({
        models: [{ id: 'lab-8b' } as Model],
        api_key: 'sk-primary',
        api_key_fallbacks: ['sk-backup'],
      })
    )

    expect(api.registerProviderConfig).toHaveBeenCalledWith({
      provider: 'my-lab',
      api_key: 'sk-primary',
      api_keys: ['sk-backup'],
      base_url: 'https://my-lab.example.com/v1',
      custom_headers: [{ header: 'x-extra', value: '1' }],
      models: ['lab-8b'],
      api_type: 'anthropic',
    })
    expect(api.setProviderModels).not.toHaveBeenCalled()
  })

  it('retries on the next call when a sync fails', async () => {
    api.listProviderConfigs.mockResolvedValue([
      { provider: 'my-lab', api_key: null, api_keys: [], models: ['a'], custom_headers: [] },
    ])
    const svc = new WebProvidersService()
    await svc.getProviders()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.setProviderModels.mockRejectedValueOnce(new Error('offline'))
    await svc.syncProviderToBackend(provider({ models: [{ id: 'a' }, { id: 'b' }] as Model[] }))

    await svc.syncProviderToBackend(provider({ models: [{ id: 'a' }, { id: 'b' }] as Model[] }))
    warn.mockRestore()

    // First call failed, second retried with the same payload.
    expect(api.setProviderModels).toHaveBeenCalledTimes(2)
    expect(api.setProviderModels).toHaveBeenLastCalledWith({
      provider: 'my-lab',
      models: ['a', 'b'],
    })
  })
})

describe('WebProvidersService.updateSettings (web key persistence)', () => {
  it('registers the typed API-key chain server-side with operational fields', async () => {
    seedStore(
      provider({ models: [{ id: 'lab-8b' } as Model] })
    )
    const svc = new WebProvidersService()

    await svc.updateSettings('my-lab', [
      {
        key: 'api-key',
        title: 'API Key',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'sk-typed' },
      },
      {
        key: 'api-key-fallbacks',
        title: 'API Key Fallbacks',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'sk-fb1\nsk-fb2' },
      },
    ])

    expect(api.registerProviderConfig).toHaveBeenCalledWith({
      provider: 'my-lab',
      api_key: 'sk-typed',
      api_keys: ['sk-fb1', 'sk-fb2'],
      base_url: 'https://my-lab.example.com/v1',
      custom_headers: [{ header: 'x-extra', value: '1' }],
      models: ['lab-8b'],
      api_type: 'anthropic',
    })
  })

  it('does not touch local engine providers', async () => {
    seedStore(provider({ provider: 'llamacpp', api_type: undefined }))
    const svc = new WebProvidersService()
    await svc.updateSettings('llamacpp', [])
    expect(api.registerProviderConfig).not.toHaveBeenCalled()
  })
})

describe('WebProvidersService.deleteProviderKeys', () => {
  it('pushes an empty key chain for registered providers', async () => {
    api.listProviderConfigs.mockResolvedValue([
      { provider: 'my-lab', api_key: 'x', api_keys: ['x'], models: ['lab-8b'], custom_headers: [] },
    ])
    const svc = new WebProvidersService()
    await svc.getProviders()
    seedStore(provider({ models: [{ id: 'lab-8b' } as Model] }))

    await svc.deleteProviderKeys('my-lab')

    expect(api.registerProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'my-lab',
        api_key: null,
        api_keys: [],
        models: ['lab-8b'],
      })
    )
  })

  it('is a no-op for providers not in the shared store', async () => {
    api.listProviderConfigs.mockResolvedValue([])
    const svc = new WebProvidersService()
    await svc.getProviders()
    seedStore(provider({}))

    await svc.deleteProviderKeys('my-lab')

    expect(api.registerProviderConfig).not.toHaveBeenCalled()
  })
})
