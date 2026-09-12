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
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { Tabs, Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import { useAccounts, useAdsConnections, useCatalogue, channelName, type CatalogueChannel } from './channels-data'
import { useConnectPopup, type StartOptions } from './useConnectPopup'
import { ConnectAccountDialog } from './ConnectAccountDialog'
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
  const { profiles, activeProfile } = useProfileScope()
  const [connectionProfile, setConnectionProfile] = useState<{ id: string; name: string } | null>(null)
  const [pending, setPending] = useState<{ channel: CatalogueChannel; options: StartOptions; accountLabel?: string } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'danger'; title: string; text?: string; workspaceId?: string } | null>(null)

  const accounts = useAccounts(reload, WORKSPACES_ENABLED)
  const catalogue = useCatalogue()
  const ads = useAdsConnections(reload)

  const popup = useConnectPopup(
    (m) => {
      const destination = connectionProfile?.id === m.workspaceId ? connectionProfile : profiles.find(profile => profile.id === m.workspaceId)
      if (!WORKSPACES_ENABLED || m.workspaceId === activeProfile?.id) bump()
      const drift = m.scopeDrift?.length ?? 0
      const displayName = catalogue.data?.find((entry) => entry.channelType === m.channel)?.displayName
        ?? (m.channel === 'EBAY' ? 'eBay' : m.channel)
      setNotice({
        tone: drift ? 'info' : 'success',
        title: `${displayName} account ${m.placement === 'verified' ? 'verified' : m.placement === 'reconsent' ? 'reconnected' : 'connected'}${m.sellerName ? `: ${m.sellerName}` : ''}.`,
        text: [destination ? `Connected to ${destination.name}.` : '', drift ? `${drift} permission${drift === 1 ? ' was' : 's were'} not granted — use Reconnect to grant ${drift === 1 ? 'it' : 'them'}.` : ''].filter(Boolean).join(' ') || undefined,
        workspaceId: WORKSPACES_ENABLED && destination && destination.id !== activeProfile?.id ? destination.id : undefined,
      })
    },
    // A legacy popup (Amazon Ads) closes without a message; refetch so whatever it
    // wrote shows, and say only what we know.
    (attempt) => {
      bump()
      if (attempt.channelKey !== 'AMAZON_ADS') {
        setNotice({ tone: 'info', title: 'Sign-in was not completed.', text: 'No account access was changed. You can start again when you are ready.' })
      }
    },
  )

  const requestConnection = (key: string, options: StartOptions) => {
    if (popup.connecting) return
    popup.clearError()
    const channel = catalogue.data?.find(item => item.key === key && item.available)
    if (!channel) return
    // Shopify and Etsy check server setup before sign-in, including single-profile mode.
    // Shopify also collects the permanent domain used to choose its provider host.
    if (!WORKSPACES_ENABLED && channel.key !== 'SHOPIFY' && channel.key !== 'ETSY') { void popup.start(key, options); return }
    const account = accounts.data?.accounts.find(item => item.id === options.targetConnectionId)
    setPending({ channel, options: { ...options, workspaceId: activeProfile?.id, region: options.region ?? account?.region }, accountLabel: account?.label })
  }

  const tabs = [
    { id: 'accounts', label: 'Accounts', count: accounts.data ? accounts.data.accounts.length : null },
    { id: 'connect', label: 'Connect', count: catalogue.data ? catalogue.data.filter((c) => c.available).length : null },
    { id: 'diagnostics', label: 'Diagnostics' },
  ]

  return (
    <div className="nds-channels">
      {/* No PageHeader: the settings shell already renders the title and the
          nav's description above every settings page — a second copy was the
          same two lines twice on screen (measured on prod 2026-08-29). */}
      <Tabs ariaLabel="Channels sections" tabs={tabs} active={tab} onChange={setTab} />

      {((popup.error && !pending) || accounts.error) && (
        <Banner tone="danger" title={popup.error && !pending ? 'Connection failed' : 'Accounts could not be loaded'} onDismiss={popup.error && !pending ? popup.clearError : undefined}>
          {(!pending && popup.error) || accounts.error}
        </Banner>
      )}
      {notice && (
        <Banner tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)}
          action={notice.workspaceId ? <Button asChild><a href={`/w/${notice.workspaceId}/settings/channels`}>View connected account</a></Button> : undefined}>
          {notice.text}
        </Banner>
      )}

      <section className="nds-channels-panel" role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label as string}>
        {tab === 'accounts' && (
          <AccountsTab catalogue={catalogue.data} reloadSignal={reload} onStart={requestConnection} onChanged={bump} />
        )}
        {tab === 'connect' && (
          <ConnectTab
            catalogue={catalogue.data}
            catalogueError={catalogue.error}
            accounts={accounts.data?.accounts.filter(account => account.isActive !== false) ?? []}
            ads={ads.data}
            connecting={popup.connecting}
            onStart={requestConnection}
          />
        )}
        {tab === 'diagnostics' && (
          <DiagnosticsTab accounts={accounts.data?.accounts.filter(account => account.isActive !== false) ?? []} loading={accounts.loading} onChanged={bump} />
        )}
      </section>
      {pending && <ConnectAccountDialog channel={pending.channel} options={pending.options} accountLabel={pending.accountLabel}
        busy={!!popup.connecting} error={popup.error} onStart={(options, profile) => { setConnectionProfile(profile ?? null); return popup.start(pending.channel.key, options) }} onClose={() => setPending(null)} />}
    </div>
  )
}
