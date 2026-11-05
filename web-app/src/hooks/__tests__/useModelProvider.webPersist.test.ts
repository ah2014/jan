/**
 * Web refresh-cycle regression tests for `useModelProvider`.
 *
 * The web UI (browser build served by the desktop's web server) persists the
 * store to localStorage via `backendStorage`'s web fallback and re-merges the
 * backend/template list at boot via `setProviders`. These tests simulate a
 * full page reload (store state discarded, storage kept) and assert that
 * user edits made in the browser survive:
 *
 *   1. added models + capability overrides on a template provider, and
 *   2. added models on a `persist: true` provider (a custom provider that
 *      exists in the shared `providers.json` but has no predefined template)
 *      — previously these were silently dropped by the merge.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { useModelProvider } from '@/hooks/useModelProvider'
import { localStorageKey } from '@/constants/localStorage'

// jsdom in this repo doesn't expose a working localStorage (known baseline
// issue) — polyfill it so the real web storage path can be exercised.
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

const INITIAL_STATE = {
  providers: [] as ModelProvider[],
  selectedProvider: 'llamacpp',
  selectedModel: null,
  deletedModels: [] as string[],
}

function resetStore() {
  useModelProvider.setState({ ...INITIAL_STATE })
}

/** Simulate a browser reload: discard in-memory state, keep localStorage. */
async function reloadStore() {
  const blob = window.localStorage.getItem(localStorageKey.modelProvider)
  resetStore()
  if (blob != null) window.localStorage.setItem(localStorageKey.modelProvider, blob)
  await useModelProvider.persist.rehydrate()
}

// What WebProvidersService.getProviders() returns for the `openai` template
// merged with a registered backend config (providers.json entry).
function fetchedTemplateProviders(): ModelProvider[] {
  return [
    {
      active: true,
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: undefined,
      api_key_fallbacks: [],
      custom_header: [],
      settings: [],
      models: [
        { id: 'gpt-4o', model: 'gpt-4o', name: 'gpt-4o', provider: 'openai' },
      ],
    } as unknown as ModelProvider,
  ]
}

// What WebProvidersService.getProviders() returns for a custom provider that
// exists in providers.json (registered from the desktop) but has no
// predefined template: base = { active: false, persist: true, models: [] }
// merged with the backend config's model ids.
function fetchedCustomProviders(): ModelProvider[] {
  return [
    {
      active: false,
      persist: true,
      provider: 'my-lab',
      base_url: 'https://my-lab.example.com/v1',
      api_key: undefined,
      api_key_fallbacks: [],
      settings: [],
      models: [
        { id: 'lab-70b', model: 'lab-70b', name: 'lab-70b' } as Model,
      ],
    } as unknown as ModelProvider,
  ]
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('web refresh cycle persistence (useModelProvider)', () => {
  it('keeps browser-added models and capability edits on a template provider across a reload', async () => {
    window.localStorage.clear()

    // ---- Boot #1 ----
    await reloadStore()
    useModelProvider.getState().setProviders(fetchedTemplateProviders())

    // User adds a model (AddModel dialog → updateProvider)
    const openai = useModelProvider.getState().getProviderByName('openai')!
    useModelProvider.getState().updateProvider('openai', {
      ...openai,
      models: [
        ...openai.models,
        {
          id: 'gpt-4o-mini-2024-07-18',
          model: 'gpt-4o-mini-2024-07-18',
          name: 'gpt-4o-mini-2024-07-18',
        } as Model,
      ],
    })

    // User edits capabilities (EditModel dialog → updateProvider)
    const withAdded = useModelProvider.getState().getProviderByName('openai')!
    useModelProvider.getState().updateProvider('openai', {
      ...withAdded,
      models: withAdded.models.map((m) =>
        m.id === 'gpt-4o'
          ? {
              ...m,
              capabilities: ['tools', 'vision'],
              _userConfiguredCapabilities: true,
            }
          : m
      ) as Model[],
    })
    await tick()
    await tick()

    // ---- Boot #2 (reload) ----
    await reloadStore()
    useModelProvider.getState().setProviders(fetchedTemplateProviders())

    const after = useModelProvider.getState().getProviderByName('openai')
    expect(after?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-4o', 'gpt-4o-mini-2024-07-18'])
    )
    const gpt4o = after?.models.find((m) => m.id === 'gpt-4o')
    expect(gpt4o?.capabilities).toEqual(['tools', 'vision'])
  })

  it('keeps browser-added models on a persist:true (backend-registered, non-template) provider across a reload', async () => {
    window.localStorage.clear()

    // ---- Boot #1 ----
    await reloadStore()
    useModelProvider.getState().setProviders(fetchedCustomProviders())

    const lab = useModelProvider.getState().getProviderByName('my-lab')!
    useModelProvider.getState().updateProvider('my-lab', {
      ...lab,
      models: [
        ...lab.models,
        { id: 'lab-8b', model: 'lab-8b', name: 'lab-8b' } as Model,
      ],
    })
    await tick()
    await tick()

    // ---- Boot #2 (reload) ----
    await reloadStore()
    useModelProvider.getState().setProviders(fetchedCustomProviders())

    const after = useModelProvider.getState().getProviderByName('my-lab')
    expect(after?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['lab-70b', 'lab-8b'])
    )
  })

  it('still drops tombstoned models on a persist:true provider after a reload', async () => {
    window.localStorage.clear()

    await reloadStore()
    useModelProvider.getState().setProviders(fetchedCustomProviders())

    // User deletes a model (tombstone + filtered list)
    useModelProvider.getState().deleteModel('lab-70b')
    await tick()
    await tick()

    await reloadStore()
    useModelProvider.getState().setProviders(fetchedCustomProviders())

    const after = useModelProvider.getState().getProviderByName('my-lab')
    expect(after?.models.some((m) => m.id === 'lab-70b')).toBe(false)
  })
})
