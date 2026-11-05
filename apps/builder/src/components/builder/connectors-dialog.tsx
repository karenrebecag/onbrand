import { useCallback, useEffect, useRef, useState } from 'react'
import { PlugIcon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { Input } from '@/components/arc/input/input'
import { NotConnectedError, type ConnectorAccount, type ConnectorApp } from '@/lib/run-client'
import type { Connectors } from '@/lib/use-builder'
import { openConnectTab } from '@/lib/connect-tab'
import styles from './builder.module.css'

interface ConnectorsDialogProps {
  open: boolean
  connectors: Connectors
  onOpenChange: (open: boolean) => void
  /** Cuentas vigentes tras cada lectura, para que el chat sepa qué apps mandar a la corrida. */
  onAccounts: (accounts: ConnectorAccount[]) => void
}

export function ConnectorsDialog({ open, connectors, onOpenChange, onAccounts }: ConnectorsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <ConnectorsBody connectors={connectors} onAccounts={onAccounts} />}
    </Dialog>
  )
}

function ConnectorsBody({ connectors, onAccounts }: Pick<ConnectorsDialogProps, 'connectors' | 'onAccounts'>) {
  const [query, setQuery] = useState('')
  const [apps, setApps] = useState<ConnectorApp[]>([])
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const endRef = useRef<HTMLLIElement>(null)

  const fail = (e: unknown) => setError(e instanceof NotConnectedError || e instanceof Error ? e.message : String(e))

  const refreshAccounts = useCallback(() => {
    connectors.accounts().then((list) => { setAccounts(list); onAccounts(list) }).catch(fail)
  }, [connectors, onAccounts])

  useEffect(refreshAccounts, [refreshAccounts])
  // Connect se completa en otra pestaña de Pipedream: al volver a esta se releen las cuentas.
  useEffect(() => {
    window.addEventListener('focus', refreshAccounts)
    return () => window.removeEventListener('focus', refreshAccounts)
  }, [refreshAccounts])

  useEffect(() => {
    const t = window.setTimeout(() => connectors.apps(query).then((page) => { setApps(page.apps); setNext(page.next) }).catch(fail), 250)
    return () => window.clearTimeout(t)
  }, [connectors, query])

  // El catálogo trae 20 por página: al asomar el final de la lista se pide la siguiente.
  useEffect(() => {
    const end = endRef.current
    if (!end || !next || loadingMore) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      setLoadingMore(true)
      connectors.apps(query, next)
        .then((page) => { setApps((prev) => [...prev, ...page.apps.filter((a) => !prev.some((p) => p.slug === a.slug))]); setNext(page.next) })
        .catch(fail)
        .finally(() => setLoadingMore(false))
    }, { root: listRef.current })
    observer.observe(end)
    return () => observer.disconnect()
  }, [connectors, query, next, loadingMore])

  const connect = (app: string) => {
    setPending(app)
    openConnectTab(() => connectors.connect(app))
      .then(refreshAccounts)
      .catch(fail)
      .finally(() => setPending(null))
  }
  const disconnect = (account: ConnectorAccount) => {
    setPending(account.app)
    connectors.disconnect(account.id).then(refreshAccounts).catch(fail).finally(() => setPending(null))
  }

  return (
    <DialogContent title="Connectors" description="Connect your apps so the agent can read their content while it builds the page.">
      <div className={styles.connectors}>
        <Input label="Search apps" placeholder="Notion, Google Docs, Airtable…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {error ? <p className={styles.connectorsEmpty} role="status">{error}</p> : (
          <ul ref={listRef} className={styles.connectorList} aria-label="Apps" aria-busy={loadingMore}>
            {apps.map((app) => {
              const account = accounts.find((a) => a.app === app.slug)
              return (
                <li key={app.slug} className={styles.connectorRow}>
                  {app.icon ? <img className={styles.connectorIcon} src={app.icon} alt="" /> : <span className={styles.connectorIcon}><PlugIcon size={16} aria-hidden="true" /></span>}
                  <span className={styles.connectorText}>
                    <span className={styles.connectorName}>{app.name}</span>
                    <span className={styles.connectorMeta}>
                      {account?.state === 'connected' ? `Connected${account.name ? ` · ${account.name}` : ''}` : account?.state === 'reconnect' ? 'Needs to reconnect' : app.description}
                    </span>
                  </span>
                  {account?.state === 'connected'
                    ? <Button size="sm" variant="ghost" loading={pending === app.slug} onClick={() => disconnect(account)}>Disconnect</Button>
                    : <Button size="sm" variant="secondary" loading={pending === app.slug} onClick={() => connect(app.slug)}>{account ? 'Reconnect' : 'Connect'}</Button>}
                </li>
              )
            })}
            {!apps.length && <li className={styles.connectorsEmpty}>No apps match “{query}”.</li>}
            {next && <li ref={endRef} className={styles.connectorsEmpty}>{loadingMore ? 'Loading more apps…' : ''}</li>}
          </ul>
        )}
      </div>
    </DialogContent>
  )
}
