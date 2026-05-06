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

type ParentSkuStrategy = 'shared' | 'per-marketplace'
type ChildSkuStrategy = 'shared' | 'per-marketplace'
type FulfillmentSkuStrategy = 'same' | 'suffixed'

interface SkuStrategy {
  parentSku: ParentSkuStrategy
  childSku: ChildSkuStrategy
  fbaFbm: FulfillmentSkuStrategy
}

function readSkuStrategy(state: Record<string, unknown>): SkuStrategy {
  const raw = (state?.skuStrategy ?? {}) as Partial<SkuStrategy>
  return {
    parentSku: raw.parentSku === 'per-marketplace' ? 'per-marketplace' : 'shared',
    childSku: raw.childSku === 'per-marketplace' ? 'per-marketplace' : 'shared',
    fbaFbm: raw.fbaFbm === 'suffixed' ? 'suffixed' : 'same',
  }
}

// Audit-fix #8 — concrete summary line for the collapsed strategy panel.
// Lists exactly which axes the user has customized so the user doesn't need
// to expand the panel just to see what they previously set.
function summarizeSkuStrategy(s: SkuStrategy): string {
  const customs: string[] = []
  if (s.parentSku === 'per-marketplace') {
    customs.push('per-marketplace parent SKU')
  }
  if (s.childSku === 'per-marketplace') {
    customs.push('per-marketplace child SKUs')
  }
  if (s.fbaFbm === 'suffixed') {
    customs.push('-FBA/-FBM suffix')
  }
  if (customs.length === 0) {
    return 'Default — shared parent + child SKUs across marketplaces, single FBA/FBM SKU'
  }
  return `Custom — ${customs.join(', ')}`
}

export default function Step1Channels({
  channels: initialChannels,
  wizardState,
  updateWizardState,
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

  // E.3 — SKU strategy. Defaults to "shared parent, shared children,
  // same FBA/FBM SKU" — the model that fits ~95% of multi-marketplace
  // catalogs and is what Amazon's catalog-clustering logic optimizes
  // for. Power users can opt into per-marketplace divergence.
  const [skuStrategy, setSkuStrategy] = useState<SkuStrategy>(() =>
    readSkuStrategy(wizardState),
  )
  const [strategyExpanded, setStrategyExpanded] = useState(false)

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

  // Phase 7 — once the connection-status payload lands, drop any
  // previously-selected entries for platforms whose adapter isn't wired.
  // Users could have stored a Shopify/WooCommerce selection from before
  // we surfaced the "Coming soon" gating, and we don't want them to
  // sail past Step 1 only to hit a NOT_IMPLEMENTED at submit time.
  useEffect(() => {
    if (!status) return
    const blocked = new Set(
      status.platforms
        .filter((p) => p.reason === 'not_implemented')
        .map((p) => p.platform),
    )
    if (blocked.size === 0) return
    setSelected((prev) => {
      let mutated = false
      const next = new Set<string>()
      for (const key of prev) {
        const [platform] = key.split(':')
        if (platform && blocked.has(platform as Platform)) {
          mutated = true
          continue
        }
        next.add(key)
      }
      return mutated ? next : prev
    })
  }, [status])

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
    // E.3 — Persist SKU strategy alongside the channel selection. The
    // composition layer reads state.skuStrategy when resolving per-child
    // channelSku (default "shared" returns master SKU, "per-marketplace"
    // would derive a suffixed value at variation step).
    await updateWizardState({ skuStrategy }, { advance: false })
    await updateWizardChannels(channelTuples, { advance: true })
  }, [channelTuples, skuStrategy, updateWizardChannels, updateWizardState])

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

      {/* E.3 — SKU strategy. Collapsed by default; the standard "shared
          parent + shared children + same FBA/FBM SKU" answer is what
          almost everyone wants and matches Amazon's catalog clustering
          assumptions. Power users open this for per-marketplace SKU
          divergence (e.g., XAV-RJK-AETHER-PARENT-IT vs -DE). */}
      <div className="mt-6 border border-slate-200 rounded-lg bg-white">
        <button
          type="button"
          onClick={() => setStrategyExpanded((v) => !v)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
        >
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900">
              SKU strategy
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
              {summarizeSkuStrategy(skuStrategy)}
            </div>
          </div>
          <span className="text-[11px] text-slate-500 flex-shrink-0">
            {strategyExpanded ? 'Hide' : 'Edit'}
          </span>
        </button>
        {strategyExpanded && (
          <div className="px-4 py-3 border-t border-slate-100 space-y-4">
            <SkuStrategyRow
              label="Parent SKU"
              hint="The master SKU on every marketplace listing's parent. Amazon assigns a different parent ASIN per marketplace regardless of this choice."
              value={skuStrategy.parentSku}
              options={[
                {
                  value: 'shared',
                  label: 'Same across all marketplaces',
                  recommended: true,
                },
                {
                  value: 'per-marketplace',
                  label: 'Suffix per marketplace (-IT, -DE, …)',
                },
              ]}
              onChange={(v) =>
                setSkuStrategy((s) => ({ ...s, parentSku: v as ParentSkuStrategy }))
              }
            />
            <SkuStrategyRow
              label="Child SKUs"
              hint="One SKU per child variation. Amazon usually clusters children to the same child ASIN across EU marketplaces; per-marketplace child SKUs force separate ASINs."
              value={skuStrategy.childSku}
              options={[
                {
                  value: 'shared',
                  label: 'Same across all marketplaces',
                  recommended: true,
                },
                {
                  value: 'per-marketplace',
                  label: 'Suffix per marketplace',
                },
              ]}
              onChange={(v) =>
                setSkuStrategy((s) => ({ ...s, childSku: v as ChildSkuStrategy }))
              }
            />
            <SkuStrategyRow
              label="FBA / FBM SKU"
              hint="Amazon supports separate offer SKUs per fulfillment method. Most sellers run a single SKU and let inventory split logically."
              value={skuStrategy.fbaFbm}
              options={[
                {
                  value: 'same',
                  label: 'Single SKU for both fulfillment methods',
                  recommended: true,
                },
                {
                  value: 'suffixed',
                  label: 'Append -FBA / -FBM to distinguish offers',
                },
              ]}
              onChange={(v) =>
                setSkuStrategy((s) => ({
                  ...s,
                  fbaFbm: v as FulfillmentSkuStrategy,
                }))
              }
            />
          </div>
        )}
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
  // Phase 7 — adapter doesn't exist yet (Shopify, WooCommerce). Block
  // selection and own the messaging here so users can't reach Step 10
  // and hit a NOT_IMPLEMENTED submit failure. When the adapter lands,
  // the connection-status payload will stop returning 'not_implemented'
  // and the UI flips to normal automatically.
  const isComingSoon = status.reason === 'not_implemented'
  const reasonLabel = (() => {
    switch (status.reason) {
      case 'not_implemented':
        // Replaced by the "Coming soon" badge in the header — no
        // duplicate subtitle.
        return null
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
    <div
      className={cn(
        'border rounded-lg bg-white',
        isComingSoon ? 'border-slate-200 opacity-75' : 'border-slate-200',
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-[13px] font-semibold text-slate-900 truncate">
                {label}
              </div>
              {isComingSoon && (
                <span
                  className="inline-flex items-center h-5 px-1.5 rounded text-[10px] uppercase tracking-wide font-semibold bg-amber-50 text-amber-800 border border-amber-200"
                  title="Available in next release"
                >
                  Coming soon
                </span>
              )}
            </div>
            {reasonLabel && (
              <div className="text-[11px] text-slate-500 truncate">
                {reasonLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* EE.3 — Connect CTA only when the adapter exists but the
              user hasn't completed setup. For "Coming soon" platforms
              there's nothing to connect yet, so skip the CTA entirely. */}
          {!status.connected && !isComingSoon && (
            <Link
              href="/settings/channels"
              target="_blank"
              className="inline-flex items-center gap-1 h-6 px-2 text-[11px] font-medium text-blue-700 border border-blue-200 rounded-md hover:bg-blue-50"
            >
              Connect {label}
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
          {!isComingSoon && <ConnectionBadge connected={status.connected} />}
        </div>
      </div>
      <div className="px-4 py-3 flex flex-wrap gap-1.5">
        {status.marketplaces.map((m) => {
          const key = `${status.platform}:${m.code}`
          const isSelected = selected.has(key)
          const buttonTitle = isComingSoon
            ? `${m.label} — available in next release`
            : m.label
          return (
            <button
              key={m.code}
              type="button"
              onClick={() => {
                if (isComingSoon) return
                onToggle(status.platform, m.code)
              }}
              disabled={isComingSoon}
              aria-disabled={isComingSoon}
              title={buttonTitle}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2 text-[12px] rounded-md border transition-colors',
                isComingSoon
                  ? 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed'
                  : isSelected
                  ? 'bg-blue-50 border-blue-300 text-blue-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
              )}
            >
              <span className="font-mono text-[11px] font-medium">
                {m.code}
              </span>
              <span className={cn('text-[11px]', isComingSoon ? 'text-slate-400' : 'text-slate-500')}>
                {m.label}
              </span>
              {isSelected && !isComingSoon && (
                <CheckCircle2 className="w-3 h-3 text-blue-600 flex-shrink-0" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SkuStrategyRow({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string
  hint: string
  value: string
  options: Array<{ value: string; label: string; recommended?: boolean }>
  onChange: (v: string) => void
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <div className="text-[12px] font-semibold text-slate-800">{label}</div>
      </div>
      <div className="text-[11px] text-slate-500 mb-2 leading-relaxed">{hint}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = value === o.value
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 text-[11px] rounded-md border transition-colors',
                active
                  ? 'bg-blue-50 border-blue-300 text-blue-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
              )}
            >
              {o.label}
              {o.recommended && (
                <span
                  className={cn(
                    'text-[9px] uppercase tracking-wide font-semibold',
                    active ? 'text-blue-600' : 'text-emerald-600',
                  )}
                >
                  Recommended
                </span>
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
