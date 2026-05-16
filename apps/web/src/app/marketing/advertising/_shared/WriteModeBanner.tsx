'use client'

/**
 * AD.4 — Trading Desk write-mode banner.
 *
 * Renders a colored strip at the top of every advertising page:
 *   - Sandbox (NEXUS_AMAZON_ADS_MODE != live): orange
 *   - Live (env=live AND ≥1 connection.writesEnabledAt): green
 *   - Live env but no enabled connection: yellow + "Enable writes" CTA
 *
 * Polls /api/advertising/connections every 60s so flipping a connection
 * surfaces here without a page refresh.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ShieldAlert, type LucideIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { EnableWritesButton } from './EnableWritesButton'

interface ConnectionRow {
  id: string
  profileId: string
  marketplace: string
  mode: string
  writesEnabledAt: string | null
  lastWriteAt: string | null
}

interface ConnectionsResponse {
  items: ConnectionRow[]
  adsMode: 'sandbox' | 'live'
}

export function WriteModeBanner() {
  const [data, setData] = useState<ConnectionsResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    function fetchOnce() {
      fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((json: ConnectionsResponse | null) => {
          if (!cancelled) setData(json)
        })
        .catch(() => {})
    }
    fetchOnce()
    const interval = setInterval(fetchOnce, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (!data) return null

  const liveEnv = data.adsMode === 'live'
  const enabledConnections = data.items.filter(
    (c) => c.mode === 'production' && c.writesEnabledAt != null,
  )
  const productionConns = data.items.filter((c) => c.mode === 'production')

  if (!liveEnv) {
    return (
      <Banner tone="amber" icon={ShieldAlert}>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-medium">Sandbox mode active</span>
          <span className="text-xs">
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">
              NEXUS_AMAZON_ADS_MODE=sandbox
            </code>{' '}
            — no real Amazon Ads API calls. Writes update the DB + audit log but stay local.
          </span>
        </div>
      </Banner>
    )
  }

  if (enabledConnections.length === 0) {
    return (
      <Banner tone="rose" icon={AlertTriangle}>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-medium">Live env but no connection enabled</span>
          <span className="text-xs">
            <code className="px-1 py-0.5 rounded bg-rose-100 dark:bg-rose-900/50">
              NEXUS_AMAZON_ADS_MODE=live
            </code>{' '}
            but no AmazonAdsConnection has <code>writesEnabledAt</code> set. Writes will be
            blocked by the ads-write-gate until enabled.
          </span>
          {productionConns.length > 0 && (
            <EnableWritesButton
              profileId={productionConns[0].profileId}
              marketplace={productionConns[0].marketplace}
              onSuccess={() => window.location.reload()}
            />
          )}
        </div>
      </Banner>
    )
  }

  return (
    <Banner tone="emerald" icon={CheckCircle2}>
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="font-medium">Live mode</span>
        <span className="text-xs">
          {enabledConnections.length} connection(s) enabled
          {' '}
          ({enabledConnections.map((c) => c.marketplace).join(', ')}). Writes go through
          ads-write-gate + 5-min holdUntil window. Rollback available within 24h per execution.
        </span>
      </div>
    </Banner>
  )
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'amber' | 'rose' | 'emerald'
  icon: LucideIcon
  children: React.ReactNode
}) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-100'
      : tone === 'rose'
        ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900 text-rose-900 dark:text-rose-100'
        : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-900 dark:text-emerald-100'
  return (
    <div className={`mb-3 border rounded-md px-3 py-2 flex items-center gap-2 ${cls}`}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden={true} />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
