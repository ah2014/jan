/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import SetupScreen from '@/containers/SetupScreen'
import { route } from '@/constants/routes'
import { predefinedProviders } from '@/constants/providers'
import { isPlatformTauri } from '@/lib/platform/utils'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}
import { useEffect } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DropdownModelProvider from '@/containers/DropdownModelProvider'

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const { setCurrentThreadId } = useThreads()
  useTools()

  // Conditional to check if there are any valid providers
  // required min 1 api_key or 1 model in llama.cpp or jan provider
  // Custom providers (not in predefinedProviders) don't require api_key but need models
  const hasValidProviders = providers.some((provider) => {
    const isPredefinedProvider = predefinedProviders.some(
      (p) => p.provider === provider.provider
    )

    // Custom providers don't need API key validation but must have models
    if (!isPredefinedProvider) {
      return provider.models.length > 0
    }

    // Predefined providers need either API key or models (for llamacpp/jan)
    return (
      providerHasRemoteApiKeys(provider) ||
      (provider.provider === 'llamacpp' && provider.models.length) ||
      (provider.provider === 'jan' && provider.models.length)
    )
  })

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (!hasValidProviders) {
    // On the web build there is no local model engine, so the desktop
    // "download a model" setup screen is meaningless (and would hang trying
    // to pull the Jan model). Instead, prompt the user to configure a
    // provider — e.g. an OpenAI-compatible endpoint pointing at their own
    // LAN llama.cpp server. Use runtime detection so the desktop bundle
    // served over the web (web server) also takes this branch.
    if (!isPlatformTauri()) {
      return (
        <div className="flex h-full flex-col justify-center">
          <HeaderPage>
            <span className="font-medium text-base font-studio pr-3">
              {t('chat:description')}
            </span>
          </HeaderPage>
          <div className="h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3">
            <div className="mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20">
              <div className="text-center mb-4">
                <h1 className="text-2xl mt-2 font-studio font-medium">
                  Connect a model provider
                </h1>
                <p className="text-muted-foreground mt-2 max-w-md mx-auto">
                  Add an OpenAI-compatible provider pointing at your inference
                  server (for example a LAN llama.cpp instance), then return
                  here to start chatting.
                </p>
              </div>
              <div className="flex justify-center">
                <Link to={route.settings.model_providers}>
                  <Button>Configure providers</Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      )
    }
    return <SetupScreen />
  }

  return (
    <div className="flex h-full flex-col justify-center">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <DropdownModelProvider model={threadModel} />
        </div>
      </HeaderPage>
      <div
        className={cn(
          'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
        )}
      >
        <div
          className={cn(
            'mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20',
          )}
        >
          <div className={cn('text-center mb-4')}>
            <h1
              className={cn(
                'text-2xl mt-2 font-studio font-medium',
              )}
            >
              {t('chat:description')}
            </h1>
          </div>
          <div className="flex-1 shrink-0">
            <ChatInput
              showSpeedToken={false}
              model={threadModel}
              initialMessage={true}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
