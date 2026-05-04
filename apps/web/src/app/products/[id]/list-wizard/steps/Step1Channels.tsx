'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  ShoppingBag,
  Store,
  XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface MarketplaceOption {
  code: string
  label: string
}

type Platform = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'

interface PlatformStatus {
  platform: Platform
  connected: boolean
  reason?: 'not_implemented' | 'no_credentials' | 'inactive' | 'error'
  marketplaces: MarketplaceOption[]
}

interface ConnectionStatus {
  platforms: PlatformStatus[]
}

interface ChannelTuple {
  platform: string
  marketplace: string
}

const PLATFORM_LABEL: Record<Platform, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
}

const PLATFORM_ICON: Record<Platform, React.ComponentType<{ className?: string }>> = {
  AMAZON: ShoppingBag,
  EBAY: Store,
  SHOPIFY: Globe,
  WOOCOMMERCE: Globe,
}

export default function Step1Channels({
  channels: initialChannels,
  updateWizardChannels,
}: StepProps) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Local channels selection — keyed by "PLATFORM:MARKET". Seeded from
  // the wizard's existing channels[] so back-nav preserves the picks.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const set = new Set<string>()
    for (const c of initialChannels ?? []) {
      set.add(`${c.platform}:${c.marketplace}`)
    }
    return set
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/connection-status`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status: code, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${code}`)
          return
        }
        setStatus(json as ConnectionStatus)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback((platform: string, market: string) => {
    setSelected((prev) => {
      const key = `${platform}:${market}`
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const channelTuples = useMemo<ChannelTuple[]>(() => {
    return Array.from(selected).map((key) => {
      const [platform, marketplace] = key.split(':')
      return { platform: platform!, marketplace: marketplace! }
    })
  }, [selected])

  // Detect if the user picked any disconnected channel — warn but
  // don't block. They might still want to set up the wizard now and
  // come back to wire the connection.
  const disconnectedSelected = useMemo(() => {
    if (!status) return [] as ChannelTuple[]
    const disconnectedPlatforms = new Set(
      status.platforms.filter((p) => !p.connected).map((p) => p.platform),
    )
    return channelTuples.filter((c) => disconnectedPlatforms.has(c.platform as Platform))
  }, [status, channelTuples])

  const onContinue = useCallback(async () => {
    if (channelTuples.length === 0) return
    await updateWizardChannels(channelTuples, { advance: true })
  }, [channelTuples, updateWizardChannels])

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6 text-center">
        <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
        <p className="mt-2 text-[12px] text-slate-500">
          Loading channel connections…
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6">
        <div className="border border-rose-200 bg-rose-50 rounded-lg px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      </div>
    )
  }

  if (!status) return null

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">
          Channels &amp; Markets
        </h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Pick every (platform, marketplace) tuple this listing should
          publish to. Every downstream step adapts to the set you pick
          here — categories per channel, attribute unions, content tabs,
          per-marketplace pricing.
        </p>
      </div>

      <div className="space-y-3">
        {status.platforms.map((p) => (
          <PlatformCard
            key={p.platform}
            status={p}
            selected={selected}
            onToggle={toggle}
          />
        ))}
      </div>

      <div className="mt-6">
        {disconnectedSelected.length > 0 && (
          <div className="mb-3 border border-amber-200 bg-amber-50 rounded-md px-3 py-2 text-[12px] text-amber-800 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              {disconnectedSelected.length} selected channel
              {disconnectedSelected.length === 1 ? '' : 's'} not connected
              yet — wizard state will save fine, but submit will fail
              until you wire the connection in Settings.
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-slate-600">
            {channelTuples.length === 0 ? (
              <span className="text-slate-400">
                Pick at least one (platform, marketplace) to continue
              </span>
            ) : (
              <>
                <span className="font-semibold">{channelTuples.length}</span>{' '}
                channel{channelTuples.length === 1 ? '' : 's'} selected
              </>
            )}
          </span>
          <button
            type="button"
            onClick={onContinue}
            disabled={channelTuples.length === 0}
            className={cn(
              'h-8 px-4 rounded-md text-[13px] font-medium',
              channelTuples.length === 0
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700',
            )}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

function PlatformCard({
  status,
  selected,
  onToggle,
}: {
  status: PlatformStatus
  selected: Set<string>
  onToggle: (platform: string, market: string) => void
}) {
  const Icon = PLATFORM_ICON[status.platform]
  const label = PLATFORM_LABEL[status.platform]
  const reasonLabel = (() => {
    switch (status.reason) {
      case 'not_implemented':
        return 'Publishing adapter not yet wired'
      case 'no_credentials':
        return 'No API credentials configured'
      case 'inactive':
        return 'No active connection'
      case 'error':
        return 'Connection error'
      default:
        return null
    }
  })()

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900 truncate">
              {label}
            </div>
            {reasonLabel && (
              <div className="text-[11px] text-slate-500 truncate">
                {reasonLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* EE.3 — Connect CTA when not connected. /settings/channels
              is the canonical location for OAuth + credential setup. */}
          {!status.connected && (
            <Link
              href="/settings/channels"
              target="_blank"
              className="inline-flex items-center gap-1 h-6 px-2 text-[11px] font-medium text-blue-700 border border-blue-200 rounded-md hover:bg-blue-50"
            >
              Connect {label}
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
          <ConnectionBadge connected={status.connected} />
        </div>
      </div>
      <div className="px-4 py-3 flex flex-wrap gap-1.5">
        {status.marketplaces.map((m) => {
          const key = `${status.platform}:${m.code}`
          const isSelected = selected.has(key)
          return (
            <button
              key={m.code}
              type="button"
              onClick={() => onToggle(status.platform, m.code)}
              title={m.label}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2 text-[12px] rounded-md border transition-colors',
                isSelected
                  ? 'bg-blue-50 border-blue-300 text-blue-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
              )}
            >
              <span className="font-mono text-[11px] font-medium">
                {m.code}
              </span>
              <span className="text-slate-500 text-[11px]">{m.label}</span>
              {isSelected && (
                <CheckCircle2 className="w-3 h-3 text-blue-600 flex-shrink-0" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
        <CheckCircle2 className="w-3 h-3" /> Connected
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-500 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">
      <XCircle className="w-3 h-3" /> Not connected
    </span>
  )
}
