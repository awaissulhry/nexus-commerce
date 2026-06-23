'use client'

// ALA Phase 8 — Review-and-Confirm modal (the publish gate).
//
// Opens on "Review & Publish". Fetches GET /preflight?live=1 (authoritative
// VALIDATION_PREVIEW) so the operator sees exactly what's wrong + what's
// changing BEFORE committing. Publish is BLOCKED while any error exists;
// warnings require an explicit acknowledgement. On confirm it POSTs the same
// /publish-amazon the cockpit already uses. Cockpit-native styling.

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import {
  AlertOctagon,
  CheckCircle2,
  Loader2,
  Rocket,
  X,
} from 'lucide-react'
import { PreflightIssues, PreflightDiff } from './PreflightBody'
import type { PreflightReport, PreflightListingReport } from './types'

interface Props {
  productId: string
  marketplace: string
  onClose: () => void
  /** Demo/testing seam — when provided, skips the live fetch. */
  initialReport?: PreflightReport
}

export default function ReviewConfirmModal({
  productId,
  marketplace,
  onClose,
  initialReport,
}: Props) {
  const [report, setReport] = useState<PreflightReport | null>(initialReport ?? null)
  const [loading, setLoading] = useState(!initialReport)
  const [error, setError] = useState<string | null>(null)
  const [ack, setAck] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (initialReport) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const url = `${getBackendUrl()}/api/products/${productId}/preflight?marketplace=${encodeURIComponent(marketplace)}&live=1`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = (await res.json()) as PreflightReport
        if (!cancelled) setReport(j)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [productId, marketplace, initialReport])

  // Esc closes (unless mid-publish).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !publishing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, publishing])

  const listing: PreflightListingReport | null =
    report?.listings.find((l) => l.marketplace === marketplace) ?? report?.listings[0] ?? null
  const errorCount = listing?.counts.errors ?? 0
  const warnCount = listing?.counts.warnings ?? 0
  const blocked = errorCount > 0
  const needsAck = !blocked && warnCount > 0 && !ack

  const handlePublish = useCallback(async () => {
    setPublishing(true)
    setResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/publish-amazon`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketplaces: [marketplace] }),
        },
      )
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const sub = body?.submissions?.[0]
      setResult(
        sub?.ok
          ? { ok: true, message: `Submitted to Amazon (feed ${sub.feedId ?? 'queued'}).` }
          : { ok: false, message: sub?.error ?? 'Publish failed.' },
      )
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setPublishing(false)
    }
  }, [productId, marketplace])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !publishing) onClose()
      }}
    >
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-subtle dark:border-slate-800">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Review &amp; Publish
            </div>
            <div className="text-[11px] text-tertiary">
              {marketplace}
              {listing ? ` · ${listing.sku}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={publishing}
            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 overflow-y-auto space-y-3">
          {loading ? (
            <div className="text-[12px] text-tertiary inline-flex items-center gap-2 py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Running Amazon validation…
            </div>
          ) : error ? (
            <div className="text-[12px] text-rose-700 dark:text-rose-400">{error}</div>
          ) : listing ? (
            <>
              <PreflightIssues report={listing} />
              <PreflightDiff report={listing} />
            </>
          ) : (
            <div className="text-[12px] text-tertiary">Nothing to review.</div>
          )}

          {result && (
            <div
              className={cn(
                'rounded border p-2 text-[12px] inline-flex items-start gap-1.5',
                result.ok
                  ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300',
              )}
            >
              {result.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              ) : (
                <AlertOctagon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              )}
              <span>{result.message}</span>
            </div>
          )}

          {!loading && !error && needsAck && (
            <label className="flex items-center gap-2 text-[11.5px] text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              I&apos;ve reviewed the {warnCount} warning{warnCount === 1 ? '' : 's'} and want to publish anyway.
            </label>
          )}
          {!loading && !error && blocked && (
            <div className="text-[11.5px] text-rose-700 dark:text-rose-400 inline-flex items-center gap-1.5">
              <AlertOctagon className="w-3.5 h-3.5" />
              Fix {errorCount} error{errorCount === 1 ? '' : 's'} before publishing.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-subtle dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            disabled={publishing}
            className="inline-flex items-center h-7 px-3 rounded text-[12px] border border-default dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          {!result?.ok && (
            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={loading || publishing || blocked || needsAck || !listing}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {publishing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Rocket className="w-3.5 h-3.5" />
              )}
              Publish to {marketplace}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
