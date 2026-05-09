'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  ShoppingBag,
  Sparkles,
  Store,
  XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'

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

// AI-6.1 — recommendation shape returned by /suggest-channels.
interface AiChannelRecommendation {
  platform: string
  marketplace: string
  fit: 'high' | 'medium' | 'low'
  rank: number
  reason: string
}

export default function Step1Channels({
  channels: initialChannels,
  wizardState,
  updateWizardState,
  updateWizardChannels,
  reportValidity,
  wizardId,
}: StepProps) {
  const confirm = useConfirm()
  const { toast } = useToast()
  const { t } = useTranslations()
  // Refs so the async toggle reads CURRENT wizardState/selected at
  // click time, without forcing the callback identity to thrash on
  // every state change.
  const wizardStateRef = useRef(wizardState)
  wizardStateRef.current = wizardState
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
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // E.3 — SKU strategy. Defaults to "shared parent, shared children,
  // same FBA/FBM SKU" — the model that fits ~95% of multi-marketplace
  // catalogs and is what Amazon's catalog-clustering logic optimizes
  // for. Power users can opt into per-marketplace divergence.
  const [skuStrategy, setSkuStrategy] = useState<SkuStrategy>(() =>
    readSkuStrategy(wizardState),
  )
  const [strategyExpanded, setStrategyExpanded] = useState(false)

  // AI-6.1 — channel suggester state. Click "AI: suggest channels"
  // → POST /suggest-channels with the connected platforms' available
  // marketplaces flattened. Backend returns ranked recommendations
  // (high / medium / low fit + reason). Operator clicks Apply per row
  // to add the platform:marketplace into selected; "Apply high-fit
  // picks" applies every high-fit pick at once.
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiRecs, setAiRecs] = useState<AiChannelRecommendation[]>([])
  const [aiPanelOpen, setAiPanelOpen] = useState(false)

  // C.0 — gate the chrome's Continue on at least one channel picked.
  // Mirrors the in-step "Continue" affordance which already requires
  // a non-empty selection; bridging it here makes Cmd+Enter and the
  // chrome Continue behave consistently with the step's own button.
  useEffect(() => {
    reportValidity(
      selected.size > 0
        ? { valid: true, blockers: 0 }
        : {
            valid: false,
            blockers: 1,
            reasons: ['Pick at least one channel + marketplace'],
          },
    )
  }, [selected, reportValidity])

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

  // C.1 / A.6 — when toggling OFF a channel with populated state
  // (category / attributes / pricing in channelStates), confirm
  // before discarding. ON-toggles are unconditional. Cancellation
  // preserves selection. The actual channelStates slice for the
  // removed channel stays in the wizard row until the next PATCH —
  // server-side cleanup is acceptable since later steps no longer
  // reference the deselected channel.
  const toggle = useCallback(
    async (platform: string, market: string) => {
      const key = `${platform}:${market}`
      const isRemoving = selectedRef.current.has(key)
      if (isRemoving) {
        const channelStates = (wizardStateRef.current.channelStates ??
          {}) as Record<string, Record<string, unknown>>
        const slice = channelStates[key]
        const hasData = !!slice && Object.keys(slice).length > 0
        if (hasData) {
          const ok = await confirm({
            title: `Remove ${key}?`,
            description: `You have category, attributes, or pricing filled in for ${key}. Removing this channel will discard that work — the other channels stay intact.`,
            confirmLabel: 'Remove channel',
            tone: 'danger',
          })
          if (!ok) return
        }
      }
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    },
    [confirm],
  )

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

  // AI-6.1 — fire the channel suggester. Builds the availableChannels
  // payload from status.platforms (skips not-implemented/unconnected
  // platforms — operators shouldn't get suggestions they can't act
  // on). Errors classified into a single sticky banner; budget gate
  // refusals come back as 402 with structured reason.
  const askAiToSuggest = useCallback(async () => {
    if (!status) return
    const available: Array<{ platform: string; marketplace: string }> = []
    for (const p of status.platforms) {
      if (p.reason === 'not_implemented') continue
      for (const m of p.marketplaces) {
        available.push({ platform: p.platform, marketplace: m.code })
      }
    }
    if (available.length === 0) return
    setAiBusy(true)
    setAiError(null)
    setAiPanelOpen(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/suggest-channels`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ availableChannels: available }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      const recs: AiChannelRecommendation[] = Array.isArray(json?.recommendations)
        ? json.recommendations
        : []
      setAiRecs(recs)
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err))
      setAiRecs([])
    } finally {
      setAiBusy(false)
    }
  }, [status, wizardId])

  // AI-6.1 — apply a single recommendation: add platform:marketplace
  // to selected. Idempotent — re-applying a row already selected is
  // a no-op so the operator can click confidently.
  const applyAiPick = useCallback(
    (rec: AiChannelRecommendation) => {
      const key = `${rec.platform}:${rec.marketplace}`
      setSelected((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev)
        next.add(key)
        return next
      })
      toast({
        tone: 'success',
        title: t('listWizard.aiSuggestChannels.toastApplied', {
          n: 1,
          plural: '',
        }),
        durationMs: 2400,
      })
    },
    [toast, t],
  )

  // AI-6.1 — apply every high-fit recommendation in one click. Caps
  // at the channels currently in the connected list (the AI prompt
  // already filters but defense in depth — never add a channel the
  // operator's account can't publish to).
  const applyAllHighFit = useCallback(() => {
    const highFit = aiRecs.filter((r) => r.fit === 'high')
    if (highFit.length === 0) return
    let added = 0
    setSelected((prev) => {
      const next = new Set(prev)
      for (const r of highFit) {
        const key = `${r.platform}:${r.marketplace}`
        if (!next.has(key)) {
          next.add(key)
          added += 1
        }
      }
      return next
    })
    toast({
      tone: 'success',
      title: t('listWizard.aiSuggestChannels.toastApplied', {
        n: added,
        plural: added === 1 ? '' : 's',
      }),
      durationMs: 2400,
    })
  }, [aiRecs, toast, t])

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
        <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400 dark:text-slate-500" />
        <p className="mt-2 text-base text-slate-500 dark:text-slate-400">
          Loading channel connections…
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6">
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-lg px-4 py-3 text-md text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      </div>
    )
  }

  if (!status) return null

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Channels &amp; Markets
          </h2>
          <p className="text-md text-slate-600 dark:text-slate-400 mt-1">
            Pick every (platform, marketplace) tuple this listing should
            publish to. Every downstream step adapts to the set you pick
            here — categories per channel, attribute unions, content tabs,
            per-marketplace pricing.
          </p>
        </div>
        {/* AI-6.1 — Step 1 channel suggester trigger. Fires
            /suggest-channels and opens the recommendations panel
            below. Disabled while the AI call is in flight. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={askAiToSuggest}
          disabled={aiBusy}
          className="flex-shrink-0 inline-flex items-center gap-1.5"
        >
          {aiBusy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
          )}
          {aiBusy
            ? t('listWizard.aiSuggestChannels.busy')
            : t('listWizard.aiSuggestChannels.button')}
        </Button>
      </div>

      {aiPanelOpen && (
        <AiSuggestionsPanel
          busy={aiBusy}
          error={aiError}
          recommendations={aiRecs}
          selectedKeys={selected}
          onApplyOne={applyAiPick}
          onApplyAllHighFit={applyAllHighFit}
          onClose={() => setAiPanelOpen(false)}
          t={t}
        />
      )}

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
      <div className="mt-6 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
        <button
          type="button"
          onClick={() => setStrategyExpanded((v) => !v)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <div className="min-w-0">
            <div className="text-md font-semibold text-slate-900 dark:text-slate-100">
              SKU strategy
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {summarizeSkuStrategy(skuStrategy)}
            </div>
          </div>
          <span className="text-sm text-slate-500 dark:text-slate-400 flex-shrink-0">
            {strategyExpanded ? 'Hide' : 'Edit'}
          </span>
        </button>
        {strategyExpanded && (
          <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 space-y-4">
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
          <div className="mb-3 border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded-md px-3 py-2 text-base text-amber-800 flex items-start gap-2">
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
          <span className="text-base text-slate-600 dark:text-slate-400">
            {channelTuples.length === 0 ? (
              <span className="text-slate-400 dark:text-slate-500">
                Pick at least one (platform, marketplace) to continue
              </span>
            ) : (
              <>
                <span className="font-semibold">{channelTuples.length}</span>{' '}
                channel{channelTuples.length === 1 ? '' : 's'} selected
              </>
            )}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={onContinue}
            disabled={channelTuples.length === 0}
          >
            Continue
          </Button>
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
        'border rounded-lg bg-white dark:bg-slate-900',
        isComingSoon ? 'border-slate-200 dark:border-slate-700 opacity-75' : 'border-slate-200 dark:border-slate-700',
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-md font-semibold text-slate-900 dark:text-slate-100 truncate">
                {label}
              </div>
              {isComingSoon && (
                <Tooltip content="Available in next release" placement="top">
                  <span className="inline-flex items-center h-5 px-1.5 rounded text-xs uppercase tracking-wide font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-800 border border-amber-200 dark:border-amber-900">
                    Coming soon
                  </span>
                </Tooltip>
              )}
            </div>
            {reasonLabel && (
              <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
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
              className="inline-flex items-center gap-1 h-6 px-2 text-sm font-medium text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 rounded-md hover:bg-blue-50 dark:hover:bg-blue-950/40"
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
                'inline-flex items-center gap-1.5 h-7 px-2 text-base rounded-md border transition-colors',
                isComingSoon
                  ? 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                  : isSelected
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 text-blue-800'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              <span className="font-mono text-sm font-medium">
                {m.code}
              </span>
              <span className={cn('text-sm', isComingSoon ? 'text-slate-400 dark:text-slate-500' : 'text-slate-500 dark:text-slate-400')}>
                {m.label}
              </span>
              {isSelected && !isComingSoon && (
                <CheckCircle2 className="w-3 h-3 text-blue-600 dark:text-blue-400 flex-shrink-0" />
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
        <div className="text-base font-semibold text-slate-800 dark:text-slate-200">{label}</div>
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">{hint}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = value === o.value
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md border transition-colors',
                active
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 text-blue-800'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              {o.label}
              {o.recommended && (
                <span
                  className={cn(
                    'text-xs uppercase tracking-wide font-semibold',
                    active ? 'text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400',
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
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-1.5 py-0.5 rounded">
        <CheckCircle2 className="w-3 h-3" /> Connected
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded">
      <XCircle className="w-3 h-3" /> Not connected
    </span>
  )
}

// AI-6.1 — recommendations panel. Renders below the title row when
// the operator clicks "AI: suggest channels". Shows ranked rows
// with fit pill + reason + Apply CTA, plus a header "Apply high-fit
// picks" CTA when ≥1 high-fit recommendation exists.
function AiSuggestionsPanel({
  busy,
  error,
  recommendations,
  selectedKeys,
  onApplyOne,
  onApplyAllHighFit,
  onClose,
  t,
}: {
  busy: boolean
  error: string | null
  recommendations: AiChannelRecommendation[]
  selectedKeys: Set<string>
  onApplyOne: (rec: AiChannelRecommendation) => void
  onApplyAllHighFit: () => void
  onClose: () => void
  t: ReturnType<typeof useTranslations>['t']
}) {
  const highFitCount = recommendations.filter((r) => r.fit === 'high').length
  return (
    <div className="mb-5 border border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-950/20 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-purple-100 dark:border-purple-900 flex items-center justify-between gap-2 bg-purple-50 dark:bg-purple-950/40">
        <div className="min-w-0">
          <div className="text-md font-semibold text-purple-900 dark:text-purple-100 inline-flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            {t('listWizard.aiSuggestChannels.title')}
          </div>
          <div className="text-sm text-purple-700 dark:text-purple-300 mt-0.5">
            {t('listWizard.aiSuggestChannels.subtitle')}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {highFitCount > 0 && !busy && !error && (
            <Button
              variant="primary"
              size="sm"
              onClick={onApplyAllHighFit}
              className="inline-flex items-center gap-1"
            >
              <Sparkles className="w-3 h-3" />
              {t('listWizard.aiSuggestChannels.applyAll')} ({highFitCount})
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-purple-600 hover:text-purple-900 dark:text-purple-400 dark:hover:text-purple-100"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        {busy && (
          <div className="flex items-center gap-2 text-base text-purple-700 dark:text-purple-300">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('listWizard.aiSuggestChannels.busy')}
          </div>
        )}
        {error && !busy && (
          <div className="flex items-start gap-2 text-base text-rose-700 dark:text-rose-300">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">
                {t('listWizard.aiSuggestChannels.error')}
              </div>
              <div className="text-sm opacity-90 mt-0.5">{error}</div>
            </div>
          </div>
        )}
        {!busy && !error && recommendations.length === 0 && (
          <div className="text-base text-slate-500 dark:text-slate-400 italic">
            (no recommendations)
          </div>
        )}
        {!busy && !error && recommendations.length > 0 && (
          <ul className="space-y-1.5">
            {recommendations.map((rec) => {
              const key = `${rec.platform}:${rec.marketplace}`
              const alreadyPicked = selectedKeys.has(key)
              const fitTone =
                rec.fit === 'high'
                  ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                  : rec.fit === 'medium'
                    ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
                    : 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
              const fitLabel =
                rec.fit === 'high'
                  ? t('listWizard.aiSuggestChannels.fitHigh')
                  : rec.fit === 'medium'
                    ? t('listWizard.aiSuggestChannels.fitMedium')
                    : t('listWizard.aiSuggestChannels.fitLow')
              return (
                <li
                  key={key}
                  className="flex items-start justify-between gap-3 py-1.5 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                        {rec.platform}:{rec.marketplace}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border',
                          fitTone,
                        )}
                      >
                        {fitLabel}
                      </span>
                      {alreadyPicked && (
                        <span className="inline-flex items-center gap-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" />
                          picked
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 leading-snug">
                      {rec.reason}
                    </p>
                  </div>
                  <div className="flex-shrink-0">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onApplyOne(rec)}
                      disabled={alreadyPicked}
                    >
                      {t('listWizard.aiSuggestChannels.applyButton')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
