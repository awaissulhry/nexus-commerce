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
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

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

export default function Step9Review({
  wizardId,
  updateWizardState,
}: StepProps) {
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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/review`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          return
        }
        setData(json as ReviewResponse)
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

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            Review &amp; Verify
          </h2>
          <p className="text-md text-slate-600 mt-1">
            Per-channel pre-submit checklist. Expand any card to see its
            full step-by-step status or the prepared channel payload.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="text-base text-blue-600 hover:underline disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-md text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading review…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-md text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Top summary */}
          <div className="mb-4 border border-slate-200 rounded-lg bg-white px-4 py-3 flex items-center justify-between">
            <div className="text-md text-slate-700">
              <span className="font-semibold">
                {data.validation.channels.length}
              </span>{' '}
              channel{data.validation.channels.length === 1 ? '' : 's'} ·{' '}
              <span
                className={cn(
                  'font-semibold',
                  data.validation.blockingChannels.length === 0
                    ? 'text-emerald-700'
                    : 'text-amber-700',
                )}
              >
                {data.validation.blockingChannels.length === 0
                  ? 'All ready'
                  : `${data.validation.blockingChannels.length} blocking`}
              </span>
            </div>
            <ReadyBadge allReady={data.validation.allReady} />
          </div>

          {/* Per-channel cards */}
          <div className="space-y-3">
            {data.validation.channels.map((report) => {
              const payload = data.payloads.find(
                (p) => p.channelKey === report.channelKey,
              )
              return (
                <ChannelCard
                  key={report.channelKey}
                  report={report}
                  payload={payload}
                  checklistExpanded={expandedChecklists.has(report.channelKey)}
                  payloadExpanded={expandedPayloads.has(report.channelKey)}
                  onToggleChecklist={() => toggleChecklist(report.channelKey)}
                  onTogglePayload={() => togglePayload(report.channelKey)}
                />
              )
            })}
          </div>

          {/* Continue */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <span className="text-base text-slate-600">
              {data.validation.allReady
                ? 'All channels complete — proceed to submit.'
                : `${data.validation.blockingChannels.length} channel${
                    data.validation.blockingChannels.length === 1 ? '' : 's'
                  } blocking`}
            </span>
            <button
              type="button"
              onClick={onContinue}
              disabled={!data.validation.allReady}
              className={cn(
                'h-8 px-4 rounded-md text-md font-medium',
                !data.validation.allReady
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              Continue
            </button>
          </div>
        </>
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
}: {
  report: ChannelValidationReport
  payload: ChannelPayloadEntry | undefined
  checklistExpanded: boolean
  payloadExpanded: boolean
  onToggleChecklist: () => void
  onTogglePayload: () => void
}) {
  const tone = report.ready
    ? 'border-slate-200'
    : 'border-amber-200 bg-amber-50/30'
  const incomplete = report.items.filter((i) => i.status === 'incomplete')
  return (
    <div className={cn('border rounded-lg bg-white', tone)}>
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-0">
          {report.ready ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-mono text-md text-slate-900 font-medium truncate">
              {report.channelKey}
            </div>
            <div className="text-sm text-slate-500 truncate">
              {report.platform} · {report.marketplace}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {report.ready ? (
            <span className="text-xs uppercase tracking-wide font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
              Ready
            </span>
          ) : (
            <span className="text-xs uppercase tracking-wide font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              {report.blockingCount} blocking
            </span>
          )}
          {payload?.unsupported && (
            <span
              className="text-xs uppercase tracking-wide font-medium text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded"
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
        <div className="px-4 py-2 border-b border-slate-100 bg-amber-50/40">
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

      {/* Always-visible blocking items + warnings */}
      {(incomplete.length > 0 || report.warnings.length > 0) && (
        <div className="px-4 py-2 space-y-1 border-b border-slate-100">
          {incomplete.map((it, i) => (
            <div
              key={`i-${i}`}
              className="text-base text-amber-700 inline-flex items-start gap-1.5"
            >
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                Step {it.step} ({it.title}){it.message ? ` — ${it.message}` : ''}
              </span>
            </div>
          ))}
          {report.warnings.map((w, i) => (
            <div
              key={`w-${i}`}
              className="text-base text-slate-600 inline-flex items-start gap-1.5"
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
        className="w-full flex items-center justify-between gap-2 px-4 py-2 text-base text-slate-700 hover:bg-slate-50"
      >
        <span className="inline-flex items-center gap-1.5">
          {checklistExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          {checklistExpanded ? 'Hide' : 'Show'} full step checklist
        </span>
        <span className="text-xs text-slate-400 font-mono">
          {report.items.filter((i) => i.status === 'complete').length}/
          {report.items.length}
        </span>
      </button>
      {checklistExpanded && (
        <div className="px-4 py-2 border-t border-slate-100 space-y-1">
          {report.items.map((it) => (
            <div
              key={it.step}
              className="flex items-center gap-2 text-base"
            >
              <StatusIcon status={it.status} />
              <span className="font-mono text-slate-500 w-12 text-sm">
                Step {it.step}
              </span>
              <span className="text-slate-700">{it.title}</span>
              {it.message && (
                <span className="text-slate-500 text-sm truncate">
                  · {it.message}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Toggle: prepared payload */}
      {payload && !payload.unsupported && (
        <>
          <button
            type="button"
            onClick={onTogglePayload}
            className="w-full flex items-center justify-between gap-2 px-4 py-2 text-base text-slate-700 border-t border-slate-100 hover:bg-slate-50"
          >
            <span className="inline-flex items-center gap-1.5">
              {payloadExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              {payloadExpanded ? 'Hide' : 'Show'} prepared payload
            </span>
            <span className="text-xs text-slate-400 font-mono">
              {payload.platform}
            </span>
          </button>
          {payloadExpanded && (
            <pre className="px-4 py-3 text-sm font-mono text-slate-700 bg-slate-50 max-h-[360px] overflow-auto border-t border-slate-100">
              {JSON.stringify(payload.payload, null, 2)}
            </pre>
          )}
        </>
      )}
      {payload?.unsupported && (
        <div className="px-4 py-2 border-t border-slate-100 text-base text-slate-500">
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
    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/40">
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
        <div className="text-sm text-slate-600 mb-2">
          <span className="text-slate-500">Variations: </span>
          {children.length > 0 ? (
            <>
              <span className="font-semibold text-slate-800">
                {children.length}
              </span>{' '}
              child{children.length === 1 ? '' : 'ren'}
              {variationTheme && (
                <>
                  {' · theme '}
                  <span className="font-mono text-slate-700">{variationTheme}</span>
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
        <div className="mt-2 text-sm text-slate-500 italic">
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
      <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div
        className={cn(
          'truncate text-slate-800',
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
      <div className="text-sm text-slate-500">
        Child SKUs: shared across marketplaces ·{' '}
        <span className="text-slate-400">no ASINs assigned yet</span>
      </div>
    )
  }
  return (
    <div className="border border-slate-200 rounded bg-white overflow-hidden">
      <div className="grid grid-cols-3 gap-2 px-2 py-1 text-xs uppercase tracking-wide text-slate-500 font-medium border-b border-slate-100 bg-slate-50">
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
            <div className="truncate text-slate-700" title={c.masterSku}>
              {c.masterSku}
            </div>
            <div
              className={cn(
                'truncate',
                c.channelSku === c.masterSku ? 'text-slate-400' : 'text-slate-700',
              )}
              title={c.channelSku}
            >
              {c.channelSku === c.masterSku ? '—' : c.channelSku}
            </div>
            <div
              className={cn(
                'truncate',
                c.channelProductId ? 'text-slate-700' : 'text-slate-400',
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
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
  if (status === 'incomplete')
    return <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
  if (status === 'skipped')
    return <MinusCircle className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
  return <Circle className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />
}

function ReadyBadge({ allReady }: { allReady: boolean }) {
  if (allReady) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
        <CheckCircle2 className="w-3 h-3" /> Ready to submit
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
      <AlertCircle className="w-3 h-3" /> Not ready
    </span>
  )
}
