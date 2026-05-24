'use client'

// AC.10 — Suppression & Listing Quality card.
//
// Pulls the per-product suppression set from the new
//   GET /api/products/:id/suppressions?marketplace=<MP>
// endpoint (HB.11 ingest populates AmazonSuppression from SP-API
// defect reports). Renders:
//
//   1. Header pill: clean / warning / blocked with active count.
//   2. Active suppression list — reason text + severity + suppressed-
//      at + per-reason "Fix in <card>" jump link, derived by regex
//      against the reason text (image quality → images, GTIN /
//      brand → identifiers, title / description / bullet → essentials,
//      price → pricing, GPSR / hazmat → compliance).
//   3. "Mark resolved" button — calls PATCH
//      /api/listings/amazon/suppressions/:id { resolved: true }.
//   4. Recent resolved history (collapsed by default).
//   5. Listing quality score — derived from the AC.4 health report
//      passed in as prop; the operator sees ONE quality number for
//      this market instead of two.
//   6. Seller Central deep-link for the always-on escape hatch.

import { useEffect, useState } from 'react'
import {
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { JumpTarget } from '../health/computeHealthScore'
import type { HealthReport } from '../health/computeHealthScore'
import { announce } from '../../../_shared/announce/useAnnounce'
import { postCockpitEvent } from '../../../_shared/telemetry/cockpit-telemetry'

interface SuppressionRow {
  id: string
  suppressedAt: string
  resolvedAt: string | null
  reasonCode: string | null
  reasonText: string
  severity: 'ERROR' | 'WARNING' | 'INFO' | string
  source: string
  channelListing: {
    id: string
    marketplace: string
    listingStatus?: string
    externalListingId?: string | null
  }
}

interface Response {
  productId: string
  marketplace: string | null
  active: SuppressionRow[]
  resolved: SuppressionRow[]
}

interface Props {
  productId: string
  marketplace: string
  /** Active listing's ASIN, when known. Powers the Seller Central
   *  deep-link so the operator can jump straight to the listing's
   *  defect page even when SP-API hasn't ingested the latest report
   *  yet. */
  asin?: string | null
  /** AC.4 health report. The card surfaces its score as the "Listing
   *  Quality" line so the operator sees ONE quality number per
   *  market. */
  healthReport?: HealthReport
  onJumpTo?: (target: JumpTarget) => void
}

const SEVERITY_TONE: Record<
  string,
  { dot: string; label: string }
> = {
  ERROR: { dot: 'bg-rose-500', label: 'BLOCKER' },
  WARNING: { dot: 'bg-amber-400', label: 'WARN' },
  INFO: { dot: 'bg-blue-400', label: 'INFO' },
}

/** Map a reason text to the cockpit card that best fixes it. The
 *  matcher is a small regex list; unknown reasons fall through to
 *  'classic' (the AG-series field editor) so the operator can always
 *  find every attribute. */
function jumpTargetForReason(text: string): JumpTarget {
  const t = text.toLowerCase()
  if (/image|photo|swatch|pixel|dimension/.test(t)) return 'images'
  if (/gtin|upc|ean|isbn|brand|identifier|exempt/.test(t)) return 'identifiers'
  if (/category|browse|node|product type|productType/.test(t)) return 'category'
  if (/title|bullet|description|copy|character/.test(t)) return 'essentials'
  if (/price|sale|fee|margin/.test(t)) return 'pricing'
  if (/variation|theme|parent|child/.test(t)) return 'variations'
  if (/hazmat|gpsr|battery|country of origin|regulator|complian/.test(t))
    return 'compliance'
  if (/fulfillment|fba|fbm|inventory|stock/.test(t)) return 'fulfillment'
  return 'classic'
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const MARKET_TLD: Record<string, string> = {
  IT: 'sellercentral.amazon.it',
  DE: 'sellercentral.amazon.de',
  FR: 'sellercentral.amazon.fr',
  ES: 'sellercentral.amazon.es',
  UK: 'sellercentral.amazon.co.uk',
  US: 'sellercentral.amazon.com',
}

export default function SuppressionCard({
  productId,
  marketplace,
  asin,
  healthReport,
  onJumpTo,
}: Props) {
  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resolvedOpen, setResolvedOpen] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const url = `${getBackendUrl()}/api/products/${productId}/suppressions?marketplace=${encodeURIComponent(marketplace)}`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = (await res.json()) as Response
        if (!cancelled) setData(j)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [productId, marketplace, tick])

  async function handleResolve(id: string) {
    setResolvingId(id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/amazon/suppressions/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ resolved: true }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTick((t) => t + 1)
      announce('Suppression marked resolved')
      postCockpitEvent({
        type: 'suppression_resolved',
        productId,
        marketplace,
        payload: { suppressionId: id },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setResolvingId(null)
    }
  }

  const activeCount = data?.active.length ?? 0
  const hasError = (data?.active ?? []).some((s) => s.severity === 'ERROR')

  const headerTone =
    activeCount === 0
      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20'
      : hasError
      ? 'border-rose-200 dark:border-rose-800 bg-rose-50/40 dark:bg-rose-950/20'
      : 'border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20'

  const headerLabel =
    activeCount === 0
      ? 'Clean'
      : hasError
      ? `${activeCount} blocker${activeCount === 1 ? '' : 's'}`
      : `${activeCount} warning${activeCount === 1 ? '' : 's'}`
  const headerToneText =
    activeCount === 0
      ? 'text-emerald-700 dark:text-emerald-400'
      : hasError
      ? 'text-rose-700 dark:text-rose-400'
      : 'text-amber-700 dark:text-amber-400'

  const sellerCentralHref = asin
    ? `https://${MARKET_TLD[marketplace] ?? 'sellercentral.amazon.com'}/inventory?searchField=asin&searchTerm=${encodeURIComponent(asin)}`
    : `https://${MARKET_TLD[marketplace] ?? 'sellercentral.amazon.com'}/listing/manage`

  return (
    <div
      data-jump-target="suppression"
      className={cn(
        'rounded-lg border bg-white dark:bg-slate-900 p-3 space-y-3',
        headerTone,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 min-w-0">
          <AlertOctagon className={cn('w-4 h-4', headerToneText)} />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Suppression & Listing Quality
          </span>
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wide',
              activeCount === 0
                ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                : hasError
                ? 'bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
                : 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
            )}
          >
            {headerLabel}
          </span>
          {loading && (
            <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTick((t) => t + 1)}
            className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Re-fetch suppression state"
            disabled={loading}
          >
            <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
            Refresh
          </button>
          <a
            href={sellerCentralHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Open this listing in Seller Central"
          >
            Seller Central <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-rose-700 dark:text-rose-400">
          {error}
        </div>
      )}

      {/* Quality score line (from AC.4 health report) */}
      {healthReport && (
        <div className="rounded border border-slate-100 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 p-2 flex items-center gap-2">
          <CheckCircle2
            className={cn(
              'w-3.5 h-3.5',
              healthReport.score >= 70
                ? 'text-emerald-500'
                : healthReport.score >= 50
                ? 'text-amber-500'
                : 'text-rose-500',
            )}
          />
          <span className="text-[11.5px] text-slate-700 dark:text-slate-300">
            Listing quality:{' '}
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {healthReport.score}/100
            </span>{' '}
            ·{' '}
            <span className="font-medium">
              {healthReport.summary.required.pass}/
              {healthReport.summary.required.total} required
            </span>{' '}
            ·{' '}
            <span className="font-medium">
              {healthReport.summary.recommended.pass}/
              {healthReport.summary.recommended.total} recommended
            </span>
          </span>
        </div>
      )}

      {/* Active suppressions */}
      {activeCount === 0 ? (
        !loading && (
          <div className="text-[11.5px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            No active suppressions for this listing on {marketplace}.
          </div>
        )
      ) : (
        <ul className="space-y-1.5">
          {data!.active.map((s) => {
            const tone = SEVERITY_TONE[s.severity] ?? SEVERITY_TONE.ERROR
            const target = jumpTargetForReason(s.reasonText)
            return (
              <li
                key={s.id}
                className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2"
              >
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0',
                      tone.dot,
                    )}
                  />
                  <div className="min-w-0 flex-1 leading-snug">
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <span className="text-[12px] font-medium text-slate-900 dark:text-slate-100 line-clamp-2">
                        {s.reasonText}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {tone.label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400 flex items-center gap-2 flex-wrap">
                      <span>{formatRelative(s.suppressedAt)}</span>
                      {s.reasonCode && (
                        <>
                          <span>·</span>
                          <span className="font-mono">{s.reasonCode}</span>
                        </>
                      )}
                      {s.source && s.source !== 'manual' && (
                        <>
                          <span>·</span>
                          <span className="text-[9.5px] uppercase tracking-wide">
                            via {s.source}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <button
                        type="button"
                        onClick={() => onJumpTo?.(target)}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/50"
                      >
                        Fix in {target}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleResolve(s.id)}
                        disabled={resolvingId === s.id}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        title="Mark this defect resolved manually (e.g. after the next report ingest)"
                      >
                        {resolvingId === s.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-3 h-3" />
                        )}{' '}
                        Mark resolved
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Resolved history (collapsed by default) */}
      {data && data.resolved.length > 0 && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setResolvedOpen((o) => !o)}
            className="w-full flex items-center justify-between text-left py-1"
          >
            <div className="flex items-center gap-1.5">
              {resolvedOpen ? (
                <ChevronDown className="w-3 h-3 text-slate-400" />
              ) : (
                <ChevronRight className="w-3 h-3 text-slate-400" />
              )}
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Recently resolved
              </span>
              <span className="text-[10.5px] text-slate-400">
                ({data.resolved.length})
              </span>
            </div>
          </button>
          {resolvedOpen && (
            <ul className="space-y-0.5">
              {data.resolved.map((s) => (
                <li
                  key={s.id}
                  className="text-[10.5px] text-slate-500 dark:text-slate-400 px-1.5 py-0.5 flex items-center justify-between gap-2"
                >
                  <span className="line-through truncate flex-1 min-w-0">
                    {s.reasonText}
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400">
                    resolved {formatRelative(s.resolvedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="text-[10.5px] text-slate-400 italic">
        Live data via HB.11 SP-API defect ingest. AC.10.2 will wire
        the in-cockpit AI diagnose flow (POST /listings/:id/diagnose-suppression).
      </div>
    </div>
  )
}
