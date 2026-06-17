import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { IconLoader2 } from '@tabler/icons-react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.web_server as any)({
  component: WebServerContent,
})

type WebServerConfig = {
  enabled: boolean
  host: string
  port: number
  password_configured: boolean
  autostart: boolean
  ui_path?: string | null
}

function WebServerContent() {
  const serviceHub = useServiceHub()
  const [config, setConfig] = useState<WebServerConfig | null>(null)
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState(8181)
  const [password, setPassword] = useState('')
  const [autostart, setAutostart] = useState(false)
  const [running, setRunning] = useState(false)
  const [pending, setPending] = useState(false)

  const refresh = async () => {
    try {
      const cfg = await serviceHub
        .core()
        .invoke<WebServerConfig>('get_web_server_config')
      setConfig(cfg)
      setHost(cfg.host)
      setPort(cfg.port)
      setAutostart(cfg.autostart)
      const status = await serviceHub.core().invoke<boolean>('get_web_server_status')
      setRunning(status)
    } catch (e) {
      console.error('Failed to load web server config', e)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const toggle = async () => {
    setPending(true)
    try {
      if (!running) {
        await serviceHub.core().invoke('start_web_server', {
          config: { host, port, password: password || undefined },
        })
        toast.success('Web server started', {
          description: `http://${host}:${port}`,
        })
        setPassword('')
      } else {
        await serviceHub.core().invoke('stop_web_server')
        toast.success('Web server stopped')
      }
      await refresh()
    } catch (e) {
      toast.error('Failed to toggle web server', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setPending(false)
    }
  }

  const savePassword = async () => {
    if (!password) return
    setPending(true)
    try {
      await serviceHub.core().invoke('set_web_password', { password })
      toast.success('Password updated')
      setPassword('')
      await refresh()
    } catch (e) {
      toast.error('Failed to set password', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setPending(false)
    }
  }

  const toggleAutostart = async (checked: boolean) => {
    setAutostart(checked)
    try {
      await serviceHub.core().invoke('set_web_server_autostart', {
        autostart: checked,
      })
    } catch (e) {
      setAutostart(!checked)
      toast.error('Failed to update autostart', {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const needsPassword = !config?.password_configured && !password

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <span className="font-medium text-base font-studio pr-3">
          Web Server
        </span>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="flex-1 flex flex-col min-h-0 pl-0">
          <div className="flex-1 overflow-y-auto p-4 pt-0">
            <div className="flex flex-col gap-4 w-full">
              <Card
                header={
                  <div className="mb-3 flex w-full items-center justify-between border-b pb-2">
                    <div className="space-y-2">
                      <h1 className="text-base font-medium text-foreground font-studio">
                        Web Server
                      </h1>
                      <p className="text-muted-foreground">
                        Serve the Jan web UI over your LAN so you can use it
                        from a phone or other device. Shares the same data
                        folder as the desktop app.
                      </p>
                    </div>
                    <Button
                      onClick={toggle}
                      variant={running ? 'destructive' : 'default'}
                      size="sm"
                      disabled={pending || (needsPassword && !running)}
                    >
                      {pending && <IconLoader2 size={14} className="animate-spin mr-1" />}
                      {running ? 'Stop' : 'Start'}
                    </Button>
                  </div>
                }
              >
                <CardItem
                  title="Host"
                  description="0.0.0.0 makes the server reachable from other devices on your LAN. 127.0.0.1 restricts it to this machine."
                  actions={
                    <select
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      disabled={running}
                      className="rounded-md border bg-transparent px-2 py-1 text-sm"
                    >
                      <option value="127.0.0.1">127.0.0.1</option>
                      <option value="0.0.0.0">0.0.0.0</option>
                    </select>
                  }
                />
                <CardItem
                  title="Port"
                  description="TCP port the web server listens on."
                  actions={
                    <Input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(Number(e.target.value))}
                      disabled={running}
                      className="w-28"
                    />
                  }
                />
                <CardItem
                  title="Start automatically"
                  description="Start the web server when the desktop app launches."
                  actions={
                    <Switch checked={autostart} onCheckedChange={toggleAutostart} />
                  }
                />
              </Card>

              <Card>
                <CardItem
                  title="Status"
                  description={
                    running ? (
                      <span>
                        Running at{' '}
                        <code className="text-xs">
                          http://{host}:{port}
                        </code>{' '}
                        — open this URL in your phone browser.
                      </span>
                    ) : (
                      'Stopped.'
                    )
                  }
                />
                <CardItem
                  title="Password"
                  description={
                    config?.password_configured
                      ? 'A password is set. Enter a new one to change it.'
                      : 'No password set yet — required before starting.'
                  }
                  actions={
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-44"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={savePassword}
                        disabled={!password || pending}
                      >
                        {config?.password_configured ? 'Update' : 'Set'}
                      </Button>
                    </div>
                  }
                />
              </Card>

              <Card>
                <CardItem
                  title="How to connect"
                  description={
                    <div className="space-y-1">
                      <div>
                        1. Set a password above and pick host{' '}
                        <code>0.0.0.0</code>.
                      </div>
                      <div>
                        2. Start the server. Build the web UI first with{' '}
                        <code className="text-xs">yarn build:webui</code> (or set{' '}
                        <code>JAN_WEB_UI_PATH</code>).
                      </div>
                      <div>
                        3. From your phone, open{' '}
                        <code className="text-xs">
                          http://&lt;this-computer-LAN-IP&gt;:{port}
                        </code>{' '}
                        and sign in.
                      </div>
                    </div>
                  }
                />
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
