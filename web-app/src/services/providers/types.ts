/**
 * Providers Service Types
 */

export interface ProvidersService {
  getProviders(): Promise<ModelProvider[]>
  fetchModelsFromProvider(provider: ModelProvider): Promise<string[]>
  updateSettings(providerName: string, settings: ProviderSetting[]): Promise<void>
  /**
   * Push a provider's model list (registering the provider when the backend
   * doesn't know it yet) into the shared backend store (`providers.json`).
   * Implemented by the web service so edits made in the browser apply to the
   * desktop app and other devices, not just this browser's localStorage.
   * No-op where a richer write-through already exists (desktop).
   */
  syncProviderToBackend(provider: ModelProvider): Promise<void>
  /**
   * Permanently delete a provider's stored API key chain from the OS keyring.
   * Explicit, user-initiated only (provider removal / key clear) — never called
   * during boot reconciliation, which must not destroy stored secrets.
   */
  deleteProviderKeys(providerName: string): Promise<void>
  fetch(): typeof fetch
}
