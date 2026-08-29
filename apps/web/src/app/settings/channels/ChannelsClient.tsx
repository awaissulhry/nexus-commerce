'use client'

/**
 * CX.2 — /settings/channels on the design system.
 *
 * One route, three tabs (URL-synced `?tab=`): Accounts (the honest rows),
 * Connect (catalogue-driven), Diagnostics (live checks + ledger). The popup
 * bridge is one hook shared by Accounts' Reconnect and Connect's buttons.
 * Spec: docs/2026-08-29-cx2-channels-ui.md.
 */

import { useCallback, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Tabs, Banner } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { useAccounts, useAdsConnections, useCatalogue } from './channels-data'
import { useConnectPopup } from './useConnectPopup'
import { AccountsTab } from './AccountsTab'
import { ConnectTab } from './ConnectTab'
import { DiagnosticsTab } from './DiagnosticsTab'
import './channels.css'

type Tab = 'accounts' | 'connect' | 'diagnostics'
const TAB_IDS: Tab[] = ['accounts', 'connect', 'diagnostics']

export function ChannelsClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: Tab = TAB_IDS.includes(tabParam as Tab) ? (tabParam as Tab) : 'accounts'
  const setTab = useCallback(
    (t: string) => {
      const next = new URLSearchParams(searchParams.toString())
      if (t === 'accounts') next.delete('tab')
      else next.set('tab', t)
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const [reload, setReload] = useState(0)
  const bump = useCallback(() => setReload((n) => n + 1), [])
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'danger'; title: string; text?: string } | null>(null)

  const accounts = useAccounts(reload)
  const catalogue = useCatalogue()
  const ads = useAdsConnections(reload)

  const popup = useConnectPopup(
    (m) => {
      bump()
      const drift = m.scopeDrift?.length ?? 0
      setNotice({
        tone: drift ? 'info' : 'success',
        title: `${m.channel === 'EBAY' ? 'eBay' : m.channel} account ${m.placement === 'reconsent' ? 'reconnected' : m.placement === 'adopt' ? 'adopted' : 'connected'}${m.sellerName ? `: ${m.sellerName}` : ''}.`,
        text: drift ? `${drift} permission${drift === 1 ? ' was' : 's were'} not granted — use Reconnect to grant ${drift === 1 ? 'it' : 'them'}.` : undefined,
      })
    },
    // A legacy popup (Amazon Ads) closes without a message; refetch so whatever it
    // wrote shows, and say only what we know.
    () => {
      bump()
    },
  )

  const tabs = [
    { id: 'accounts', label: 'Accounts', count: accounts.data ? accounts.data.accounts.length : null },
    { id: 'connect', label: 'Connect', count: catalogue.data ? catalogue.data.filter((c) => c.available).length : null },
    { id: 'diagnostics', label: 'Diagnostics' },
  ]

  return (
    <div className="nds-channels">
      <PageHeader
        title="Channels"
        subtitle="Marketplace and store accounts — sign-in, permissions, health."
      />
      <Tabs ariaLabel="Channels sections" tabs={tabs} active={tab} onChange={setTab} />

      {(popup.error || accounts.error) && (
        <Banner tone="danger" title={popup.error ? 'Connection failed' : 'Accounts could not be loaded'} onDismiss={popup.error ? popup.clearError : undefined}>
          {popup.error ?? accounts.error}
        </Banner>
      )}
      {notice && (
        <Banner tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <section className="nds-channels-panel" role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label as string}>
        {tab === 'accounts' && (
          <AccountsTab catalogue={catalogue.data} reloadSignal={reload} onStart={(key, opts) => void popup.start(key, opts)} />
        )}
        {tab === 'connect' && (
          <ConnectTab
            catalogue={catalogue.data}
            catalogueError={catalogue.error}
            accounts={accounts.data?.accounts ?? []}
            ads={ads.data}
            connecting={popup.connecting}
            onStart={(key, opts) => void popup.start(key, opts)}
          />
        )}
        {tab === 'diagnostics' && (
          <DiagnosticsTab accounts={accounts.data?.accounts ?? []} loading={accounts.loading} onChanged={bump} />
        )}
      </section>
    </div>
  )
}
