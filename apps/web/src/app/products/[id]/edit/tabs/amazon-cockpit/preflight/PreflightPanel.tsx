'use client'

// ALA Phase 8 — in-cockpit Pre-Flight health panel.
//
// Always-on card that fetches GET /api/products/:id/preflight?marketplace=<MP>
// (local detectors + mirrored issues + diff vs live; no extra SP-API call) and
// shows what's wrong + what's changing for this listing. "Run Amazon validation"
// re-fetches with live=1 (authoritative VALIDATION_PREVIEW). "Review & Publish"
// opens the confirm modal. Styling mirrors SuppressionCard for cockpit
// consistency. Mounts immediately before PublishCard.

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import {
  ClipboardCheck,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { PreflightIssues, PreflightDiff } from './PreflightBody'
import ReviewConfirmModal from './ReviewConfirmModal'
import type { PreflightReport, PreflightListingReport } from './types'

interface Props {
  productId: string
  marketplace: string
  /** Demo/testing seam — when provided, skips the network fetch. */
  initialReport?: PreflightReport
}

function listingFor(
  report: PreflightReport | null,
  marketplace: string,
): PreflightListingReport | null {
  if (!report) return null
  return (
    report.listings.find((l) => l.marketplace === marketplace) ??
    report.listings[0] ??
    null
  )
}

export default function PreflightPanel({
  productId,
  marketplace,
  initialReport,
}: Props) {
  const [report, setReport] = useState<PreflightReport | null>(initialReport ?? null)
  const [loading, setLoading] = useState(!initialReport)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const load = useCallback(
    async (withLive: boolean) => {
      if (initialReport) return
      setLoading(true)
      setLive(withLive)
      setError(null)
      try {
        const url = `${getBackendUrl()}/api/products/${productId}/preflight?marketplace=${encodeURIComponent(marketplace)}${withLive ? '&live=1' : ''}`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setReport((await res.json()) as PreflightReport)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [productId, marketplace, initialReport],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const listing = listingFor(report, marketplace)
  const errorCount = listing?.counts.errors ?? 0
  const warnCount = listing?.counts.warnings ?? 0

  const tone =
    !listing
      ? 'border-subtle dark:border-slate-800'
      : errorCount > 0
        ? 'border-rose-200 dark:border-rose-800 bg-rose-50/40 dark:bg-rose-950/20'
        : warnCount > 0
          ? 'border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20'
          : 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20'

  const chip =
    errorCount > 0
      ? {
          cls: 'bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300',
          label: `${errorCount} error${errorCount === 1 ? '' : 's'}`,
        }
      : warnCount > 0
        ? {
            cls: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
            label: `${warnCount} warning${warnCount === 1 ? '' : 's'}`,
          }
        : {
            cls: 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
            label: 'Ready',
          }

  return (
    <div
      data-jump-target="preflight"
      className={cn('rounded-lg border bg-white dark:bg-slate-900 p-3 space-y-3', tone)}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 min-w-0">
          <ClipboardCheck className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Pre-Flight Check
          </span>
          {listing && (
            <span
              className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wide',
                chip.cls,
              )}
            >
              {chip.label}
            </span>
          )}
          {loading && <Loader2 className="w-3 h-3 animate-spin text-tertiary" />}
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          disabled={loading}
          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-default dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Re-run the pre-flight checks"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Re-check
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-rose-700 dark:text-rose-400">{error}</div>
      )}

      {/* Body */}
      {listing ? (
        <>
          <PreflightIssues report={listing} />
          <PreflightDiff report={listing} />
          {listing.validationPreview === 'ran' && (
            <div className="text-[10px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Validated against Amazon
            </div>
          )}
        </>
      ) : (
        !loading &&
        !error && (
          <div className="text-[11.5px] text-tertiary">
            No Amazon listing for {marketplace} yet.
          </div>
        )
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-wrap pt-1">
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || !listing}
          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/50 disabled:opacity-50"
          title="Run Amazon's authoritative VALIDATION_PREVIEW"
        >
          {loading && live ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ShieldCheck className="w-3 h-3" />
          )}
          Run Amazon validation
        </button>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={!listing}
          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          Review &amp; Publish
        </button>
      </div>

      <div className="text-[10.5px] text-tertiary italic">
        Local checks + mirrored Amazon issues. “Run Amazon validation” adds the
        live VALIDATION_PREVIEW verdict.
      </div>

      {modalOpen && (
        <ReviewConfirmModal
          productId={productId}
          marketplace={marketplace}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}
