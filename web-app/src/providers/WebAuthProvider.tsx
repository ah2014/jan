/**
 * WebAuthProvider — single-password login gate for the web UI build.
 *
 * On non-web platforms this is a pass-through. On the web build it checks
 * `/api/auth/check` before rendering children (which load extensions and start
 * hitting `/api/*`). When not authenticated it shows a minimal login form that
 * POSTs to `/api/auth/login`; the server sets the signed session cookie.
 */

import { PropsWithChildren, useEffect, useState } from 'react'
import { isPlatformTauri } from '@/lib/platform/utils'

// Activate the web auth gate whenever we're NOT running inside Tauri — whether
// that's the standalone web UI build (IS_WEB_APP=true) or the desktop bundle
// served in a browser by the web server (no __TAURI__ bridge). This MUST match
// the API shim's routing decision (`service.ts` → /api/invoke), which also uses
// runtime detection; gating only on the build-time IS_WEB_APP flag lets the two
// disagree when the desktop build is served over the web, so the client skips
// the login page while the server still 401s every /api/invoke.
const IS_WEB = !isPlatformTauri()

type Status = 'checking' | 'authed' | 'unauthed'

async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/check')
    if (!res.ok) return false
    const body = (await res.json()) as { authenticated?: boolean }
    return body.authenticated === true
  } catch {
    return false
  }
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        onSuccess()
        return
      }
      if (res.status === 401) setError('Incorrect password')
      else if (res.status === 403) setError('No password configured. Set one in the desktop app first.')
      else setError(`Login failed (${res.status})`)
    } catch {
      setError('Could not reach the Jan server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-svh w-full items-center justify-center bg-neutral-50 dark:bg-background">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm dark:bg-zinc-900"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">Jan</h1>
          <p className="text-sm text-muted-foreground">Enter your password to continue.</p>
        </div>
        <input
          type="password"
          id="jan-web-password"
          name="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
          disabled={busy}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

export function WebAuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<Status>('checking')

  useEffect(() => {
    if (!IS_WEB) {
      setStatus('authed')
      return
    }
    checkAuth().then((ok) => setStatus(ok ? 'authed' : 'unauthed'))
  }, [])

  // The HTML boot loader (#initial-loader, "Booting up Jan…") is owned by
  // ExtensionProvider, which only mounts AFTER auth. While we're showing our
  // own UI (Loading / Login) we must clear that overlay or it sits on top and
  // hides the login form. Once authed, ExtensionProvider takes over.
  useEffect(() => {
    if (!IS_WEB) return
    if (status !== 'authed') {
      document.getElementById('initial-loader')?.remove()
    }
  }, [status])

  if (!IS_WEB) return <>{children}</>
  if (status === 'checking') {
    return (
      <div className="flex h-svh w-full items-center justify-center bg-neutral-50 dark:bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }
  if (status === 'unauthed') {
    return (
      <LoginScreen
        onSuccess={async () => {
          // Re-check then render the app.
          const ok = await checkAuth()
          setStatus(ok ? 'authed' : 'unauthed')
        }}
      />
    )
  }
  return <>{children}</>
}
