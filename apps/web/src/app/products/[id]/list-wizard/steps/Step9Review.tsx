'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
  Sparkles,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { useTranslations } from '@/lib/i18n/use-translations'

// C.2 (list-wizard) — per-channel compliance status returned by
// /:id/compliance-status. Mirrors the backend shape so the response
// can flow directly into the UI without remapping.
interface ComplianceIssue {
  code: string
  message: string
  severity: 'block' | 'warn'
}
interface ChannelCompliance {
  channelKey: string
  platform: string
  marketplace: string
  ready: boolean
  blockingCount: number
  warningCount: number
  issues: ComplianceIssue[]
}
interface ComplianceCertificate {
  id: string
  certType: string
  certNumber: string | null
  expiresAt: string | null
  isExpired: boolean
}
interface ComplianceStatusResponse {
  product: {
    sku: string
    name: string
    hsCode: string | null
    countryOfOrigin: string | null
    ppeCategory: string | null
    hazmatClass: string | null
    hazmatUnNumber: string | null
    certificateCount: number
    certificates: ComplianceCertificate[]
  }
  perChannel: ChannelCompliance[]
  summary: {
    allReady: boolean
    blockingChannels: string[]
    channelCount: number
    readyCount: number
  }
}

// AI-6.4 — per-channel quality score returned by /score-quality.
interface AiQualityDimension {
  name: string
  score: number
  hint: string
}
interface AiChannelQuality {
  platform: string
  marketplace: string
  overallScore: number
  dimensions: AiQualityDimension[]
}
interface AiQualityResponse {
  perChannel: AiChannelQuality[]
  overallScore: number
  topImprovements: string[]
}

// AI-6.4 — extract a trimmed snapshot from the prepared per-channel
// payload. Each platform has a different shape; this helper walks
// the known shapes (Amazon SP-API, eBay Inventory, Shopify Admin
// REST) and returns the title / description / bullets / keywords /
// images / price subset /score-quality wants. Unknown shapes return
// the channel key with empty fields — the AI will score whatever it
// can see and note "data missing" for the rest.
function extractQualitySnapshot(entry: ChannelPayloadEntry): {
  platform: string
  marketplace: string
  title?: string
  description?: string
  bullets?: string[]
  keywords?: string
  imageCount?: number
  price?: number
  currency?: string
} {
  const base = { platform: entry.platform, marketplace: entry.marketplace }
  if (!entry.payload || entry.unsupported) return base
  const platform = entry.platform.toUpperCase()
  const p = entry.payload as Record<string, unknown>

  if (platform === 'AMAZON') {
    const attrs = (p.attributes ?? {}) as Record<string, unknown>
    const itemName = pluckString(attrs.item_name)
    const bullets = pluckStringArray(attrs.bullet_point)
    const description = pluckString(attrs.product_description)
    const keywords = pluckString(attrs.generic_keyword)
    const images = Array.isArray(p.imageUrls) ? p.imageUrls.length : 0
    return {
      ...base,
      title: itemName,
      description,
      bullets,
      keywords,
      imageCount: images,
    }
  }

  if (platform === 'EBAY') {
    const product = (p.product ?? {}) as Record<string, unknown>
    const title = typeof product.title === 'string' ? product.title : undefined
    const description =
      typeof product.description === 'string' ? product.description : undefined
    const imageUrls = Array.isArray(product.imageUrls) ? product.imageUrls : []
    const price = (p.price ?? {}) as Record<string, unknown>
    const priceVal =
      typeof price.value === 'number' ? price.value : undefined
    const currency =
      typeof price.currency === 'string' ? price.currency : undefined
    return {
      ...base,
      title,
      description,
      imageCount: imageUrls.length,
      price: priceVal,
      currency,
    }
  }

  if (platform === 'SHOPIFY') {
    const product = (p.product ?? {}) as Record<string, unknown>
    const title = typeof product.title === 'string' ? product.title : undefined
    const description =
      typeof product.body_html === 'string' ? product.body_html : undefined
    const tags = Array.isArray(product.tags) ? product.tags : []
    const keywords = tags.filter((t) => typeof t === 'string').join(' ')
    const images = Array.isArray(product.images) ? product.images.length : 0
    const variants = Array.isArray(product.variants) ? product.variants : []
    const firstVariant = variants[0] as Record<string, unknown> | undefined
    const priceStr =
      typeof firstVariant?.price === 'string' ? firstVariant.price : undefined
    const priceVal =
      priceStr !== undefined && Number.isFinite(Number(priceStr))
        ? Number(priceStr)
        : undefined
    return {
      ...base,
      title,
      description,
      keywords,
      imageCount: images,
      price: priceVal,
    }
  }

  return base
}

function pluckString(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  // SP-API attributes are arrays of {value, language_tag, ...}
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as Record<string, unknown>
    if (typeof first?.value === 'string') return first.value
  }
  return undefined
}
function pluckStringArray(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const item of raw) {
      const s = pluckString(item)
      if (s) out.push(s)
    }
    return out.length > 0 ? out : undefined
  }
  return undefined
}

type SliceStatus = 'complete' | 'incomplete' | 'skipped' | 'unknown'

interface ValidationItem {
  step: number
  title: string
  status: SliceStatus
  message?: string
}

interface ChannelValidationReport {
  channelKey: string
  platform: string
  marketplace: string
  ready: boolean
  blockingCount: number
  items: ValidationItem[]
  warnings: string[]
}

interface MultiChannelValidation {
  channels: ChannelValidationReport[]
  allReady: boolean
  blockingChannels: string[]
}

interface ChannelPayloadEntry {
  channelKey: string
  platform: string
  marketplace: string
  payload?: any
  unsupported?: boolean
  reason?: string
  /** Audit-fix #6 — Picked child SKUs that no longer exist. Surfaced as a
   *  warning row in the channel card. */
  missingChildSkus?: string[]
}

interface ReviewResponse {
  wizard: {
    id: string
    channels: any
    status: string
    currentStep: number
  }
  validation: MultiChannelValidation
  payloads: ChannelPayloadEntry[]
}

// C.1 / A.4 — Amazon region grouping. SP-API surfaces each marketplace
// as a separate (channel, marketplace) tuple; the operator's mental
// model is "Amazon EU" / "Amazon NA". Grouping the Step 9 cards
// matches that mental model + collapses noise when a seller targets
// every EU marketplace.
type AmazonRegion = 'EU' | 'NA' | 'FE' | 'OTHER'

const AMAZON_EU = new Set([
  'IT', 'DE', 'FR', 'ES', 'GB', 'UK', 'NL', 'PL', 'SE', 'BE', 'IE',
])
const AMAZON_NA = new Set(['US', 'CA', 'MX'])
const AMAZON_FE = new Set(['JP', 'AU', 'SG', 'IN', 'AE', 'SA', 'TR'])

function amazonRegion(marketplace: string): AmazonRegion {
  const m = marketplace.toUpperCase()
  if (AMAZON_EU.has(m)) return 'EU'
  if (AMAZON_NA.has(m)) return 'NA'
  if (AMAZON_FE.has(m)) return 'FE'
  return 'OTHER'
}

interface ChannelGroup {
  /** Stable id, used as React key. */
  id: string
  /** Display label: "Amazon EU", "eBay", "Shopify". */
  label: string
  members: Array<{
    report: ChannelValidationReport
    payload: ChannelPayloadEntry | undefined
  }>
}

function groupChannels(
  reports: ChannelValidationReport[],
  payloads: ChannelPayloadEntry[],
): Array<{ kind: 'group'; group: ChannelGroup } | { kind: 'single'; report: ChannelValidationReport; payload: ChannelPayloadEntry | undefined }> {
  // Build (platform → region|null → members) buckets.
  const buckets = new Map<
    string, // group id
    ChannelGroup
  >()
  const labelFor = (platform: string, region?: AmazonRegion) => {
    if (platform === 'AMAZON') {
      if (region === 'EU') return 'Amazon EU'
      if (region === 'NA') return 'Amazon NA'
      if (region === 'FE') return 'Amazon Asia / Pacific'
      return 'Amazon'
    }
    if (platform === 'EBAY') return 'eBay'
    if (platform === 'SHOPIFY') return 'Shopify'
    if (platform === 'WOOCOMMERCE') return 'WooCommerce'
    return platform
  }
  for (const report of reports) {
    const platform = report.platform.toUpperCase()
    const region =
      platform === 'AMAZON' ? amazonRegion(report.marketplace) : undefined
    const id = region ? `${platform}:${region}` : platform
    const payload = payloads.find((p) => p.channelKey === report.channelKey)
    const existing = buckets.get(id)
    if (existing) {
      existing.members.push({ report, payload })
    } else {
      buckets.set(id, {
        id,
        label: labelFor(platform, region),
        members: [{ report, payload }],
      })
    }
  }
  // Singletons render as plain cards; multi-member groups render as
  // collapsible group cards.
  return Array.from(buckets.values()).map((g) => {
    if (g.members.length === 1) {
      return {
        kind: 'single' as const,
        report: g.members[0]!.report,
        payload: g.members[0]!.payload,
      }
    }
    return { kind: 'group' as const, group: g }
  })
}

export default function Step9Review({
  wizardId,
  updateWizardState,
  onJumpToStep,
  reportValidity,
  setJumpToBlocker,
}: StepProps) {
  const { t } = useTranslations()
  const [data, setData] = useState<ReviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [expandedPayloads, setExpandedPayloads] = useState<Set<string>>(
    new Set(),
  )
  const [expandedChecklists, setExpandedChecklists] = useState<Set<string>>(
    new Set(),
  )

  // AI-6.4 — quality scorer state. Click "AI: score this listing" →
  // POST /score-quality with per-channel snapshots extracted from
  // data.payloads. Backend returns 0-100 scores + dimension
  // breakdown + topImprovements list.
  const [aiQualityBusy, setAiQualityBusy] = useState(false)
  const [aiQualityError, setAiQualityError] = useState<string | null>(null)
  const [aiQuality, setAiQuality] = useState<AiQualityResponse | null>(null)

  // C.2 — compliance status. Fetched alongside the review payload;
  // null when the endpoint failed (rare — read-only DB query). The
  // card hides cleanly in that case so a compliance-fetch outage
  // doesn't block the operator from reviewing the rest.
  const [compliance, setCompliance] = useState<ComplianceStatusResponse | null>(
    null,
  )

  const askAiToScore = useCallback(async () => {
    if (!data) return
    const channels = data.payloads
      .map((p) => extractQualitySnapshot(p))
      // Drop channels with literally nothing for AI to score (e.g.
      // unsupported entries with no payload at all).
      .filter(
        (c) =>
          (c.title && c.title.length > 0) ||
          (c.description && c.description.length > 0) ||
          (c.bullets && c.bullets.length > 0),
      )
    if (channels.length === 0) {
      setAiQualityError(
        'No content yet to score — fill in attributes / content for at least one channel first.',
      )
      setAiQuality(null)
      return
    }
    setAiQualityBusy(true)
    setAiQualityError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/score-quality`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels }),
        },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      setAiQuality({
        perChannel: Array.isArray(json?.perChannel) ? json.perChannel : [],
        overallScore: typeof json?.overallScore === 'number' ? json.overallScore : 0,
        topImprovements: Array.isArray(json?.topImprovements)
          ? json.topImprovements
          : [],
      })
    } catch (err) {
      setAiQualityError(err instanceof Error ? err.message : String(err))
      setAiQuality(null)
    } finally {
      setAiQualityBusy(false)
    }
  }, [data, wizardId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // C.2 — fetch compliance-status alongside review so the card
    // renders without a second round-trip. Compliance never blocks
    // first-paint (its 503 / cert-fetch failures fall through to a
    // null state that hides the card cleanly).
    Promise.all([
      fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/review`)
        .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() })),
      fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/compliance-status`)
        .then(async (r) => ({ ok: r.ok, json: r.ok ? await r.json() : null }))
        .catch(() => ({ ok: false, json: null })),
    ])
      .then(([reviewResult, complianceResult]) => {
        if (cancelled) return
        if (!reviewResult.ok) {
          setError(reviewResult.json?.error ?? `HTTP ${reviewResult.status}`)
          return
        }
        setData(reviewResult.json as ReviewResponse)
        if (complianceResult.ok) {
          setCompliance(complianceResult.json as ComplianceStatusResponse)
        }
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
  }, [wizardId, reloadKey])

  const togglePayload = useCallback((channelKey: string) => {
    setExpandedPayloads((prev) => {
      const next = new Set(prev)
      if (next.has(channelKey)) next.delete(channelKey)
      else next.add(channelKey)
      return next
    })
  }, [])
  const toggleChecklist = useCallback((channelKey: string) => {
    setExpandedChecklists((prev) => {
      const next = new Set(prev)
      if (next.has(channelKey)) next.delete(channelKey)
      else next.add(channelKey)
      return next
    })
  }, [])

  const onContinue = useCallback(async () => {
    if (!data?.validation.allReady) return
    await updateWizardState({}, { advance: true })
  }, [data?.validation.allReady, updateWizardState])

  // C.0 / A1 — register jump-to-blocker. Scrolls to the first
  // not-ready channel card and expands its checklist so the user
  // sees what's missing.
  useEffect(() => {
    setJumpToBlocker(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-blocker-row="true"]',
      )
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // Auto-expand the checklist on the blocked channel.
        if (data?.validation.blockingChannels[0]) {
          setExpandedChecklists((prev) => {
            const next = new Set(prev)
            next.add(data.validation.blockingChannels[0]!)
            return next
          })
        }
        return
      }
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
    return () => setJumpToBlocker(null)
  }, [setJumpToBlocker, data])

  // C.0 — report validity from the existing allReady + blockingChannels.
  // Each blocked channel may carry multiple checklist items; the
  // visible blocker count is the sum across blocked channels so the
  // pill matches the per-card breakdown.
  useEffect(() => {
    if (loading) {
      reportValidity({
        valid: false,
        blockers: 1,
        reasons: ['Loading review…'],
      })
      return
    }
    if (error) {
      reportValidity({ valid: false, blockers: 1, reasons: [error] })
      return
    }
    if (!data) {
      reportValidity({ valid: false, blockers: 1, reasons: ['No review data'] })
      return
    }
    if (data.validation.allReady) {
      reportValidity({ valid: true, blockers: 0 })
      return
    }
    let totalBlockers = 0
    for (const ch of data.validation.channels) {
      if (!ch.ready) totalBlockers += ch.blockingCount
    }
    const reasons = data.validation.blockingChannels
      .slice(0, 3)
      .map((ch) => `${ch} not ready`)
    reportValidity({
      valid: false,
      blockers: Math.max(totalBlockers, data.validation.blockingChannels.length),
      reasons,
    })
  }, [loading, error, data, reportValidity])

  return (
    <div className="max-w-3xl mx-auto py-4 md:py-10 px-3 md:px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Review &amp; Verify
          </h2>
          <p className="text-md text-slate-600 dark:text-slate-400 mt-1">
            Per-channel pre-submit checklist. Expand any card to see its
            full step-by-step status or the prepared channel payload.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* AI-6.4 — listing quality scorer trigger. Disabled until
              data has loaded (no payloads to score) or while a call
              is in flight. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={askAiToScore}
            disabled={!data || aiQualityBusy}
            className="inline-flex items-center gap-1.5"
          >
            {aiQualityBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
            )}
            {t('listWizard.aiScoreQuality.button')}
          </Button>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            className="text-base text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* AI-6.4 — quality score panel. Renders below the header when
          the operator has clicked the button. Shows overall score,
          topImprovements, and a per-channel sub-score table. Purely
          informational — operator goes back to the relevant step to
          fix anything the scorer flagged. */}

      {/* C.2 — compliance status. Reads master Product compliance
          fields (W7.1 schema: ppeCategory / hsCode / hazmatClass /
          countryOfOrigin) + ProductCertificate rows and surfaces
          per-channel readiness. Doesn't block submit at the chrome
          level; the operator sees what's missing per channel and
          can deep-link to /products/[id]/edit#compliance to fix
          master data, or proceed knowing which channels won't
          publish cleanly. */}
      {compliance && compliance.perChannel.length > 0 && (
        <ComplianceCard compliance={compliance} />
      )}

      {(aiQuality || aiQualityError || aiQualityBusy) && (
        <div className="mb-5 border border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-950/20 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-purple-100 dark:border-purple-900 bg-purple-50 dark:bg-purple-950/40 flex items-center justify-between gap-3">
            <div className="text-md font-semibold text-purple-900 dark:text-purple-100 inline-flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              {t('listWizard.aiScoreQuality.title')}
            </div>
            {aiQuality && (
              <div
                className={cn(
                  'text-2xl font-semibold tabular-nums px-2 py-0.5 rounded',
                  aiQuality.overallScore >= 80
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : aiQuality.overallScore >= 60
                      ? 'text-amber-700 dark:text-amber-300'
                      : 'text-rose-700 dark:text-rose-300',
                )}
                title={t('listWizard.aiScoreQuality.overallTooltip')}
              >
                {aiQuality.overallScore}
                <span className="text-base font-normal opacity-70">/100</span>
              </div>
            )}
          </div>
          <div className="px-4 py-3 space-y-3">
            {aiQualityBusy && (
              <div className="flex items-center gap-2 text-base text-purple-700 dark:text-purple-300">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('listWizard.aiScoreQuality.busy')}
              </div>
            )}
            {aiQualityError && !aiQualityBusy && (
              <div className="flex items-start gap-2 text-base text-rose-700 dark:text-rose-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">
                    {t('listWizard.aiScoreQuality.error')}
                  </div>
                  <div className="text-sm opacity-90 mt-0.5">{aiQualityError}</div>
                </div>
              </div>
            )}
            {aiQuality && aiQuality.topImprovements.length > 0 && (
              <div>
                <div className="text-sm font-medium text-purple-900 dark:text-purple-100 uppercase tracking-wide">
                  {t('listWizard.aiScoreQuality.topImprovementsLabel')}
                </div>
                <ul className="mt-1 space-y-1">
                  {aiQuality.topImprovements.map((tip, i) => (
                    <li
                      key={i}
                      className="text-sm text-slate-700 dark:text-slate-300 flex items-start gap-2"
                    >
                      <span className="mt-1 inline-block w-1 h-1 rounded-full bg-purple-500 flex-shrink-0" />
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {aiQuality && aiQuality.perChannel.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {aiQuality.perChannel.map((ch) => {
                  const tone =
                    ch.overallScore >= 80
                      ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20'
                      : ch.overallScore >= 60
                        ? 'border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20'
                        : 'border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20'
                  return (
                    <div
                      key={`${ch.platform}:${ch.marketplace}`}
                      className={cn('border rounded p-2', tone)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                          {ch.platform}:{ch.marketplace}
                        </span>
                        <span className="text-md font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {ch.overallScore}
                          <span className="text-xs font-normal opacity-60">
                            /100
                          </span>
                        </span>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
                        {ch.dimensions.map((d) => (
                          <div
                            key={d.name}
                            className="flex items-center justify-between"
                            title={d.hint || undefined}
                          >
                            <span className="text-slate-600 dark:text-slate-400 truncate">
                              {d.name}
                            </span>
                            <span
                              className={cn(
                                'tabular-nums font-medium',
                                d.score >= 80
                                  ? 'text-emerald-700 dark:text-emerald-300'
                                  : d.score >= 60
                                    ? 'text-amber-700 dark:text-amber-300'
                                    : 'text-rose-700 dark:text-rose-300',
                              )}
                            >
                              {d.score}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div
          className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-6 py-6 space-y-3"
          aria-busy="true"
          aria-label="Loading review"
        >
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="block" height={64} />
          <Skeleton variant="block" height={64} />
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 dark:border-rose-900 rounded-lg bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-md text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Top summary */}
          <div className="mb-4 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-4 py-3 flex items-center justify-between">
            <div className="text-md text-slate-700 dark:text-slate-300">
              <span className="font-semibold">
                {data.validation.channels.length}
              </span>{' '}
              channel{data.validation.channels.length === 1 ? '' : 's'} ·{' '}
              <span
                className={cn(
                  'font-semibold',
                  data.validation.blockingChannels.length === 0
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-amber-700 dark:text-amber-300',
                )}
              >
                {data.validation.blockingChannels.length === 0
                  ? 'All ready'
                  : `${data.validation.blockingChannels.length} blocking`}
              </span>
            </div>
            <ReadyBadge allReady={data.validation.allReady} />
          </div>

          {/* Per-channel cards (C.1 / A.4 grouped: "Amazon EU (5)") */}
          <div className="space-y-3">
            {groupChannels(
              data.validation.channels,
              data.payloads,
            ).map((entry) => {
              if (entry.kind === 'single') {
                const isFirstBlocked =
                  data.validation.blockingChannels.length > 0 &&
                  entry.report.channelKey ===
                    data.validation.blockingChannels[0]
                return (
                  <div
                    key={entry.report.channelKey}
                    data-blocker-row={
                      isFirstBlocked ? 'true' : undefined
                    }
                    className="scroll-mt-24"
                  >
                    <ChannelCard
                      report={entry.report}
                      payload={entry.payload}
                      checklistExpanded={expandedChecklists.has(
                        entry.report.channelKey,
                      )}
                      payloadExpanded={expandedPayloads.has(
                        entry.report.channelKey,
                      )}
                      onToggleChecklist={() =>
                        toggleChecklist(entry.report.channelKey)
                      }
                      onTogglePayload={() =>
                        togglePayload(entry.report.channelKey)
                      }
                      onJumpToStep={onJumpToStep}
                    />
                  </div>
                )
              }
              // Multi-member group card.
              const groupHasFirstBlocker = entry.group.members.some(
                (m) =>
                  data.validation.blockingChannels[0] ===
                  m.report.channelKey,
              )
              return (
                <div
                  key={entry.group.id}
                  data-blocker-row={
                    groupHasFirstBlocker ? 'true' : undefined
                  }
                  className="scroll-mt-24"
                >
                  <ChannelGroupCard
                    group={entry.group}
                    expandedChecklists={expandedChecklists}
                    expandedPayloads={expandedPayloads}
                    onToggleChecklist={toggleChecklist}
                    onTogglePayload={togglePayload}
                    onJumpToStep={onJumpToStep}
                    blockingChannelsHeadKey={
                      data.validation.blockingChannels[0]
                    }
                  />
                </div>
              )
            })}
          </div>

          {/* Continue */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <span className="text-base text-slate-600 dark:text-slate-400">
              {data.validation.allReady
                ? 'All channels complete — proceed to submit.'
                : `${data.validation.blockingChannels.length} channel${
                    data.validation.blockingChannels.length === 1 ? '' : 's'
                  } blocking`}
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={onContinue}
              disabled={!data.validation.allReady}
            >
              Continue
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// C.1 / A.4 — collapsible group wrapper for multi-marketplace
// platforms (e.g. Amazon EU spanning IT/DE/FR/ES/UK). Default-expand
// when any member is blocking so the operator sees what needs fixing
// without an extra click; default-collapse when everything is ready
// to keep the review surface scannable.
function ChannelGroupCard({
  group,
  expandedChecklists,
  expandedPayloads,
  onToggleChecklist,
  onTogglePayload,
  onJumpToStep,
  blockingChannelsHeadKey,
}: {
  group: ChannelGroup
  expandedChecklists: Set<string>
  expandedPayloads: Set<string>
  onToggleChecklist: (channelKey: string) => void
  onTogglePayload: (channelKey: string) => void
  onJumpToStep: (stepId: number) => void
  blockingChannelsHeadKey: string | undefined
}) {
  const totalCount = group.members.length
  const readyCount = group.members.filter((m) => m.report.ready).length
  const blockingCount = totalCount - readyCount
  const allReady = blockingCount === 0
  // Default expand when any member is blocking.
  const [expanded, setExpanded] = useState(!allReady)

  return (
    <div
      className={cn(
        'border rounded-lg bg-white dark:bg-slate-900',
        allReady ? 'border-slate-200 dark:border-slate-700' : 'border-amber-200 dark:border-amber-900 bg-amber-50/30',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`group-${group.id}`}
        className={cn(
          'w-full px-4 py-3 flex items-center justify-between gap-3 text-left',
          'border-b border-slate-100 dark:border-slate-800',
          'hover:bg-slate-50/60',
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown
              className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0"
              aria-hidden="true"
            />
          )}
          {allReady ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-md text-slate-900 dark:text-slate-100 font-semibold truncate">
              {group.label}{' '}
              <span className="text-slate-500 dark:text-slate-400 font-normal tabular-nums">
                ({totalCount} marketplace{totalCount === 1 ? '' : 's'})
              </span>
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
              {group.members
                .map((m) => m.report.marketplace)
                .join(' · ')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {allReady ? (
            <span className="text-xs uppercase tracking-wide font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-1.5 py-0.5 rounded">
              All ready
            </span>
          ) : (
            <span className="text-xs uppercase tracking-wide font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-1.5 py-0.5 rounded tabular-nums">
              {readyCount}/{totalCount} ready
            </span>
          )}
        </div>
      </button>
      {expanded && (
        <div id={`group-${group.id}`} className="p-3 space-y-3">
          {group.members.map((m) => {
            const isFirstBlocked =
              blockingChannelsHeadKey === m.report.channelKey
            return (
              <div
                key={m.report.channelKey}
                data-blocker-row={isFirstBlocked ? 'true' : undefined}
                className="scroll-mt-24"
              >
                <ChannelCard
                  report={m.report}
                  payload={m.payload}
                  checklistExpanded={expandedChecklists.has(
                    m.report.channelKey,
                  )}
                  payloadExpanded={expandedPayloads.has(
                    m.report.channelKey,
                  )}
                  onToggleChecklist={() =>
                    onToggleChecklist(m.report.channelKey)
                  }
                  onTogglePayload={() =>
                    onTogglePayload(m.report.channelKey)
                  }
                  onJumpToStep={onJumpToStep}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChannelCard({
  report,
  payload,
  checklistExpanded,
  payloadExpanded,
  onToggleChecklist,
  onTogglePayload,
  onJumpToStep,
}: {
  report: ChannelValidationReport
  payload: ChannelPayloadEntry | undefined
  checklistExpanded: boolean
  payloadExpanded: boolean
  onToggleChecklist: () => void
  onTogglePayload: () => void
  onJumpToStep: (stepId: number) => void
}) {
  const tone = report.ready
    ? 'border-slate-200 dark:border-slate-700'
    : 'border-amber-200 dark:border-amber-900 bg-amber-50/30'
  const incomplete = report.items.filter((i) => i.status === 'incomplete')
  return (
    <div className={cn('border rounded-lg bg-white dark:bg-slate-900', tone)}>
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          {report.ready ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-mono text-md text-slate-900 dark:text-slate-100 font-medium truncate">
              {report.channelKey}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
              {report.platform} · {report.marketplace}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {report.ready ? (
            <span className="text-xs uppercase tracking-wide font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-1.5 py-0.5 rounded">
              Ready
            </span>
          ) : (
            <span className="text-xs uppercase tracking-wide font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-1.5 py-0.5 rounded">
              {report.blockingCount} blocking
            </span>
          )}
          {payload?.unsupported && (
            <span
              className="text-xs uppercase tracking-wide font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded"
              title={payload.reason}
            >
              Adapter not wired
            </span>
          )}
        </div>
      </div>

      {/* E.6 — Per-marketplace listing summary. Reads from the composed
          payload so the user can see exactly what'll be sent to THIS
          marketplace before submitting: resolved parent SKU, child SKU
          map (with channel-scoped overrides), currency, language,
          variation theme, and the expected ASIN behaviour Amazon will
          apply on its end. */}
      {payload && !payload.unsupported && (
        <ListingSummary
          platform={report.platform}
          marketplace={report.marketplace}
          payload={payload.payload}
        />
      )}

      {/* Audit-fix #6 — picked-but-missing child SKUs warning. Surfaces
          the gap between Step 5 selection and what actually resolved at
          composition time so the user knows specific picks were dropped. */}
      {payload?.missingChildSkus && payload.missingChildSkus.length > 0 && (
        <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 bg-amber-50/40">
          <div className="text-base text-amber-800 inline-flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              <span className="font-semibold">
                {payload.missingChildSkus.length}
              </span>{' '}
              picked child SKU
              {payload.missingChildSkus.length === 1 ? '' : 's'} no longer
              exist and will be skipped:{' '}
              <span className="font-mono text-sm">
                {payload.missingChildSkus.slice(0, 5).join(', ')}
                {payload.missingChildSkus.length > 5
                  ? ` +${payload.missingChildSkus.length - 5} more`
                  : ''}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Always-visible blocking items + warnings.
          U.4 — incomplete rows are clickable: clicking jumps the user
          back to the originating step so they can fix the blocker
          inline rather than memorising "Step 4" and clicking the
          stepper. The "Fix" button on the right is the explicit
          affordance; the row body is clickable for ergonomic targets. */}
      {(incomplete.length > 0 || report.warnings.length > 0) && (
        <div className="px-4 py-2 space-y-1 border-b border-slate-100 dark:border-slate-800">
          {incomplete.map((it, i) => (
            <div
              key={`i-${i}`}
              className="flex items-center justify-between gap-2"
            >
              <button
                type="button"
                onClick={() => onJumpToStep(it.step)}
                className="text-base text-amber-700 dark:text-amber-300 inline-flex items-start gap-1.5 text-left flex-1 min-w-0 hover:text-amber-900 hover:underline rounded"
                title={`Jump to Step ${it.step} to fix this`}
              >
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span className="min-w-0">
                  Step {it.step} ({it.title}){it.message ? ` — ${it.message}` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onJumpToStep(it.step)}
                className="flex-shrink-0 inline-flex items-center gap-1 h-6 px-2 text-sm font-medium border border-amber-300 text-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60"
              >
                Fix →
              </button>
            </div>
          ))}
          {report.warnings.map((w, i) => (
            <div
              key={`w-${i}`}
              className="text-base text-slate-600 dark:text-slate-400 inline-flex items-start gap-1.5"
            >
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Toggle: full checklist */}
      <button
        type="button"
        onClick={onToggleChecklist}
        className="w-full flex items-center justify-between gap-2 px-4 py-2 text-base text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        <span className="inline-flex items-center gap-1.5">
          {checklistExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          {checklistExpanded ? 'Hide' : 'Show'} full step checklist
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
          {report.items.filter((i) => i.status === 'complete').length}/
          {report.items.length}
        </span>
      </button>
      {checklistExpanded && (
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
          {report.items.map((it) => {
            const clickable = it.status === 'incomplete' || it.status === 'complete'
            const Wrapper: any = clickable ? 'button' : 'div'
            return (
              <Wrapper
                key={it.step}
                {...(clickable
                  ? {
                      type: 'button',
                      onClick: () => onJumpToStep(it.step),
                      title: `Jump to Step ${it.step}`,
                    }
                  : {})}
                className={cn(
                  'w-full flex items-center gap-2 text-base text-left rounded px-1 -mx-1',
                  clickable && 'hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer',
                )}
              >
                <StatusIcon status={it.status} />
                <span className="font-mono text-slate-500 dark:text-slate-400 w-12 text-sm">
                  Step {it.step}
                </span>
                <span className="text-slate-700 dark:text-slate-300">{it.title}</span>
                {it.message && (
                  <span className="text-slate-500 dark:text-slate-400 text-sm truncate">
                    · {it.message}
                  </span>
                )}
              </Wrapper>
            )
          })}
        </div>
      )}

      {/* Toggle: prepared payload */}
      {payload && !payload.unsupported && (
        <>
          <button
            type="button"
            onClick={onTogglePayload}
            className="w-full flex items-center justify-between gap-2 px-4 py-2 text-base text-slate-700 dark:text-slate-300 border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <span className="inline-flex items-center gap-1.5">
              {payloadExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              {payloadExpanded ? 'Hide' : 'Show'} prepared payload
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
              {payload.platform}
            </span>
          </button>
          {payloadExpanded && (
            <pre className="px-4 py-3 text-sm font-mono text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 max-h-[360px] overflow-auto border-t border-slate-100 dark:border-slate-800">
              {JSON.stringify(payload.payload, null, 2)}
            </pre>
          )}
        </>
      )}
      {payload?.unsupported && (
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-base text-slate-500 dark:text-slate-400">
          {payload.reason}
        </div>
      )}
    </div>
  )
}

// E.6 — Per-marketplace listing summary card. Renders a compact view
// of what's about to publish on each (channel, marketplace) tuple so
// the user can sanity-check the resolved parent SKU + child SKU map
// + currency + ASIN behaviour without expanding the raw JSON payload.
const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
  IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', NL: 'EUR', SE: 'SEK', PL: 'PLN',
  UK: 'GBP', GB: 'GBP', US: 'USD', CA: 'CAD', MX: 'MXN', AU: 'AUD', JP: 'JPY',
  GLOBAL: 'EUR',
}
const MARKETPLACE_TO_LANGUAGE: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', NL: 'nl', SE: 'sv', PL: 'pl',
  UK: 'en', GB: 'en', US: 'en', CA: 'en', MX: 'es', AU: 'en', JP: 'ja',
  GLOBAL: 'en',
}

function ListingSummary({
  platform,
  marketplace,
  payload,
}: {
  platform: string
  marketplace: string
  payload: any
}) {
  const mp = marketplace.toUpperCase()
  const isAmazon = platform.toUpperCase() === 'AMAZON'
  const isEbay = platform.toUpperCase() === 'EBAY'

  if (!payload) return null

  const currency = MARKETPLACE_TO_CURRENCY[mp] ?? '—'
  const language = MARKETPLACE_TO_LANGUAGE[mp] ?? '—'

  // Amazon shape (from submission.service.ts AmazonListingPayload):
  //   parentSku, children[{masterSku, channelSku, channelProductId,...}],
  //   marketplaceId (SP-API id), variationTheme, productType
  const parentSku = isAmazon ? payload.parentSku : payload.sku
  const variationTheme = isAmazon ? payload.variationTheme : null
  const children: Array<{
    masterSku: string
    channelSku: string
    channelProductId: string | null
  }> = isAmazon && Array.isArray(payload.children) ? payload.children : []
  const marketplaceId = isAmazon ? payload.marketplaceId : payload.marketplaceId

  // Expected ASIN behaviour copy — calibrated to Amazon's actual catalog
  // clustering: NA marketplaces typically share child ASINs, EU marketplaces
  // often do too within a category, JP/AU are independent.
  const asinExpectation = (() => {
    if (!isAmazon) return null
    const hasAssigned = children.some((c) => c.channelProductId)
    if (hasAssigned) {
      return 'Existing child ASINs detected — Amazon will reuse where attributes match.'
    }
    if (['IT', 'DE', 'FR', 'ES', 'NL', 'SE', 'PL'].includes(mp)) {
      return 'Amazon will assign a new parent ASIN. Child ASINs typically cluster across EU marketplaces when attributes match.'
    }
    if (['US', 'CA', 'MX'].includes(mp)) {
      return 'Amazon will assign a new parent ASIN. Child ASINs typically cluster across NA marketplaces when attributes match.'
    }
    if (mp === 'UK' || mp === 'GB') {
      return 'Amazon will assign a new parent ASIN. UK/EU child ASIN clustering ended after Brexit — UK ASINs are now independent.'
    }
    return 'Amazon will assign a new parent ASIN. Child ASINs are marketplace-specific.'
  })()

  return (
    <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/40">
      {/* Top metadata row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-2">
        <SummaryField
          label="Parent SKU"
          value={parentSku ?? '—'}
          mono
        />
        {isAmazon && (
          <SummaryField
            label="SP-API ID"
            value={marketplaceId ?? '—'}
            mono
          />
        )}
        {isEbay && (
          <SummaryField
            label="eBay site"
            value={marketplaceId ?? '—'}
            mono
          />
        )}
        <SummaryField label="Currency" value={currency} />
        <SummaryField label="Language" value={language} />
      </div>

      {/* Variation summary */}
      {isAmazon && (variationTheme || children.length > 0) && (
        <div className="text-sm text-slate-600 dark:text-slate-400 mb-2">
          <span className="text-slate-500 dark:text-slate-400">Variations: </span>
          {children.length > 0 ? (
            <>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {children.length}
              </span>{' '}
              child{children.length === 1 ? '' : 'ren'}
              {variationTheme && (
                <>
                  {' · theme '}
                  <span className="font-mono text-slate-700 dark:text-slate-300">{variationTheme}</span>
                </>
              )}
            </>
          ) : (
            'single product (no variations selected)'
          )}
        </div>
      )}

      {/* Child SKU map — only show divergent/assigned rows so common case
          (every channelSku === masterSku) doesn't add visual noise. */}
      {isAmazon && children.length > 0 && (
        <ChildSkuMap children={children} />
      )}

      {/* Expected ASIN behaviour */}
      {asinExpectation && (
        <div className="mt-2 text-sm text-slate-500 dark:text-slate-400 italic">
          {asinExpectation}
        </div>
      )}
    </div>
  )
}

function SummaryField({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
        {label}
      </div>
      <div
        className={cn(
          'truncate text-slate-800 dark:text-slate-200',
          mono ? 'font-mono text-sm' : 'text-base',
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

function ChildSkuMap({
  children,
}: {
  children: Array<{
    masterSku: string
    channelSku: string
    channelProductId: string | null
  }>
}) {
  // Default case — every channelSku equals masterSku and no ASINs assigned.
  // Surface a one-line "no overrides" tag rather than rendering a map of
  // identical rows. Power users (per-marketplace SKU strategy) and post-
  // publish state (ASINs landed) get the full table.
  const hasOverrides = children.some(
    (c) => c.channelSku !== c.masterSku || c.channelProductId,
  )
  if (!hasOverrides) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400">
        Child SKUs: shared across marketplaces ·{' '}
        <span className="text-slate-400 dark:text-slate-500">no ASINs assigned yet</span>
      </div>
    )
  }
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 overflow-hidden">
      <div className="grid grid-cols-3 gap-2 px-2 py-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
        <div>Master SKU</div>
        <div>Marketplace SKU</div>
        <div>Child ASIN</div>
      </div>
      <div className="max-h-[140px] overflow-auto">
        {children.map((c) => (
          <div
            key={c.masterSku}
            className="grid grid-cols-3 gap-2 px-2 py-1 text-sm font-mono border-b border-slate-50 last:border-b-0"
          >
            <div className="truncate text-slate-700 dark:text-slate-300" title={c.masterSku}>
              {c.masterSku}
            </div>
            <div
              className={cn(
                'truncate',
                c.channelSku === c.masterSku ? 'text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-300',
              )}
              title={c.channelSku}
            >
              {c.channelSku === c.masterSku ? '—' : c.channelSku}
            </div>
            <div
              className={cn(
                'truncate',
                c.channelProductId ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500',
              )}
              title={c.channelProductId ?? 'not yet assigned'}
            >
              {c.channelProductId ?? '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: SliceStatus }) {
  if (status === 'complete')
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
  if (status === 'incomplete')
    return <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
  if (status === 'skipped')
    return <MinusCircle className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
  return <Circle className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0" />
}

function ReadyBadge({ allReady }: { allReady: boolean }) {
  if (allReady) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-2 py-0.5 rounded">
        <CheckCircle2 className="w-3 h-3" /> Ready to submit
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-2 py-0.5 rounded">
      <AlertCircle className="w-3 h-3" /> Not ready
    </span>
  )
}

// C.2 — per-channel compliance card. Surfaces what's blocking each
// channel based on master product compliance + cert state. Operators
// see the issue codes + plain-language messages; deep-link to
// /products/[id]/edit#compliance to fix master data without leaving
// the wizard's flow.
function ComplianceCard({
  compliance,
}: {
  compliance: ComplianceStatusResponse
}) {
  const summary = compliance.summary
  const expiredCount = compliance.product.certificates.filter(
    (c) => c.isExpired,
  ).length
  return (
    <div
      className={cn(
        'mb-5 border rounded-lg overflow-hidden',
        summary.allReady
          ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20'
          : 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/20',
      )}
    >
      <div
        className={cn(
          'px-4 py-2.5 border-b flex items-center justify-between gap-3',
          summary.allReady
            ? 'border-emerald-100 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40'
            : 'border-amber-100 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40',
        )}
      >
        <div className="flex items-center gap-2">
          {summary.allReady ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          )}
          <div className="text-md font-semibold text-slate-900 dark:text-slate-100">
            Compliance{' '}
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400 tabular-nums">
              · {summary.readyCount}/{summary.channelCount} channels ready
              {expiredCount > 0 && ` · ${expiredCount} cert${expiredCount === 1 ? '' : 's'} expired`}
            </span>
          </div>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {compliance.product.ppeCategory && (
          <div className="text-sm text-slate-600 dark:text-slate-400">
            PPE Category{' '}
            <span className="font-mono text-slate-900 dark:text-slate-100">
              {compliance.product.ppeCategory}
            </span>
            {compliance.product.hsCode && (
              <>
                {' '}· HS{' '}
                <span className="font-mono text-slate-900 dark:text-slate-100">
                  {compliance.product.hsCode}
                </span>
              </>
            )}
            {compliance.product.countryOfOrigin && (
              <>
                {' '}· Origin{' '}
                <span className="font-mono text-slate-900 dark:text-slate-100">
                  {compliance.product.countryOfOrigin}
                </span>
              </>
            )}
            {(compliance.product.hazmatClass ||
              compliance.product.hazmatUnNumber) && (
              <>
                {' '}·{' '}
                <span className="text-amber-700 dark:text-amber-300">
                  Hazmat {compliance.product.hazmatClass ?? ''}{' '}
                  {compliance.product.hazmatUnNumber ?? ''}
                </span>
              </>
            )}
          </div>
        )}

        {compliance.perChannel.map((c) => (
          <div
            key={c.channelKey}
            className={cn(
              'border rounded-md px-3 py-2',
              c.ready
                ? 'border-emerald-200 dark:border-emerald-900 bg-white dark:bg-slate-900'
                : c.blockingCount > 0
                  ? 'border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/20'
                  : 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/20',
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                {c.channelKey}
              </span>
              <span className="flex items-center gap-1.5 text-xs">
                {c.ready ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="w-3 h-3" />
                    Ready
                  </span>
                ) : (
                  <>
                    {c.blockingCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                        <AlertCircle className="w-3 h-3" />
                        {c.blockingCount} blocker{c.blockingCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {c.warningCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                        <AlertCircle className="w-3 h-3" />
                        {c.warningCount} warning{c.warningCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
            {c.issues.length > 0 && (
              <ul className="space-y-0.5">
                {c.issues.map((issue) => (
                  <li
                    key={issue.code}
                    className={cn(
                      'text-sm leading-snug flex items-start gap-1.5',
                      issue.severity === 'block'
                        ? 'text-rose-800 dark:text-rose-200'
                        : 'text-amber-800 dark:text-amber-200',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1 inline-block w-1 h-1 rounded-full flex-shrink-0',
                        issue.severity === 'block'
                          ? 'bg-rose-500'
                          : 'bg-amber-500',
                      )}
                    />
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {!summary.allReady && (
          <div className="text-sm text-slate-500 dark:text-slate-400 italic">
            Fix master compliance data on the product edit page;
            issues here re-evaluate on the next wizard load.
          </div>
        )}
      </div>
    </div>
  )
}
