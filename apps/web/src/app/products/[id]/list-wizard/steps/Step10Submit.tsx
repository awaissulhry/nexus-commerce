'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCw,
  Rocket,
  XCircle,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

type SubmissionStatus =
  | 'PENDING'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'LIVE'
  | 'FAILED'
  | 'NOT_IMPLEMENTED'

interface SubmissionEntry {
  channelKey: string
  platform: string
  marketplace: string
  status: SubmissionStatus
  submissionId?: string
  error?: string
  submittedAt: string
  updatedAt: string
  listingUrl?: string
  notImplementedReason?: string
  /** Audit-fix #7 — Amazon parent ASIN, populated by the publish/poll path
   *  once SP-API assigns it. Persisted to ChannelListing.externalParentId. */
  parentAsin?: string
  /** Audit-fix #7 — Per-child ASIN map: master SKU → child ASIN. Persisted
   *  to VariantChannelListing.channelProductId scoped to (channel, marketplace). */
  childAsinsByMasterSku?: Record<string, string>
  /** SP-API non-blocking issues — surfaced even on successful publishes
   *  (image dimension hints, attribute shape suggestions, etc.). Each
   *  entry carries severity + the SKU that triggered it (parent vs
   *  specific child) so the UI can group them sensibly. */
  warnings?: Array<{
    code: string
    message: string
    severity: 'WARNING' | 'INFO'
    sku?: string
    attributeNames?: string[]
  }>
}

interface SubmitResponse {
  wizard: { id: string; status: string; completedAt: string | null }
  submissions: SubmissionEntry[]
  validation?: { allReady: boolean; blockingChannels: string[] }
}

// NN.10 — exponential backoff schedule. Starts tight (3s) for the
// first minute when most adapters resolve, eases off after, hard
// caps at 15 minutes total elapsed so a stuck publish can't run
// the polling loop forever and burn the user's battery.
const POLL_BACKOFF_MS = [
  3000, 3000, 3000, 3000, // 0-12s: 4 quick checks
  5000, 5000, 5000, 5000, // 12-32s: ease in
  8000, 8000, 8000, 8000, // 32-64s: 8s slots
  15000, 15000, 15000, 15000, // 64-124s
  30000, 30000, 30000, 30000, // 124-244s: 4-min mark
  60000, 60000, 60000, 60000, 60000, 60000, // 244-604s: 1-min slots to 10-min mark
  120000, 120000, 120000, // 604-964s: 2-min slots to 16-min cap
] as const
const POLL_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

export default function Step10Submit({
  wizardId,
  channels,
  product,
}: StepProps) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [submissions, setSubmissions] = useState<SubmissionEntry[] | null>(null)
  const [overallStatus, setOverallStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  // Poll while any entry is in-flight (PENDING/SUBMITTING/SUBMITTED).
  // NOT_IMPLEMENTED entries are terminal v1 and don't drive polling.
  // NN.10 — exponential backoff via setTimeout chain instead of
  // setInterval, so we can vary the gap and stop cleanly. timedOut
  // surfaces a "stuck for 15 minutes — refresh manually" banner
  // rather than running a forever loop.
  const pollTimer = useRef<number | null>(null)
  const pollStartedAt = useRef<number | null>(null)
  const pollTickRef = useRef<number>(0)
  const [timedOut, setTimedOut] = useState(false)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
    pollStartedAt.current = null
    pollTickRef.current = 0
  }, [])

  const scheduleNextPoll = useCallback(
    (pollFn: () => void) => {
      const start = pollStartedAt.current ?? Date.now()
      const elapsed = Date.now() - start
      if (elapsed >= POLL_TIMEOUT_MS) {
        setTimedOut(true)
        stopPolling()
        return
      }
      const tick = pollTickRef.current
      const delay =
        POLL_BACKOFF_MS[Math.min(tick, POLL_BACKOFF_MS.length - 1)] ??
        120000
      pollTickRef.current = tick + 1
      pollTimer.current = window.setTimeout(pollFn, delay)
    },
    [stopPolling],
  )

  const poll = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/poll`,
        { method: 'POST' },
      )
      const json = (await res.json()) as SubmitResponse & { error?: string }
      if (!res.ok) {
        // Don't break the UI — log the error and keep showing the
        // last-known state. Schedule another tick so a transient
        // backend error doesn't strand the polling loop.
        scheduleNextPoll(poll)
        return
      }
      setSubmissions(json.submissions)
      setOverallStatus(json.wizard?.status ?? null)
      const inFlight = json.submissions.some(
        (s) =>
          s.status === 'PENDING' ||
          s.status === 'SUBMITTING' ||
          s.status === 'SUBMITTED',
      )
      if (!inFlight) {
        stopPolling()
        return
      }
      scheduleNextPoll(poll)
    } catch {
      // Network error — schedule the next tick instead of dying.
      scheduleNextPoll(poll)
    }
  }, [wizardId, stopPolling, scheduleNextPoll])

  // NN.10 — manual refresh fallback once polling has timed out.
  const manualRefresh = useCallback(() => {
    setTimedOut(false)
    pollStartedAt.current = Date.now()
    pollTickRef.current = 0
    void poll()
  }, [poll])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const onSubmit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      )
      const json = (await res.json()) as SubmitResponse & { error?: string }
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      setSubmissions(json.submissions)
      setOverallStatus(json.wizard?.status ?? null)
      const inFlight = json.submissions.some(
        (s) =>
          s.status === 'PENDING' ||
          s.status === 'SUBMITTING' ||
          s.status === 'SUBMITTED',
      )
      if (inFlight) {
        stopPolling()
        // NN.10 — kick off the backoff chain instead of setInterval.
        // First poll fires immediately so the UI reflects post-submit
        // state without waiting for the first interval.
        pollStartedAt.current = Date.now()
        pollTickRef.current = 0
        scheduleNextPoll(poll)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [wizardId, poll, stopPolling, scheduleNextPoll])

  const onRetry = useCallback(
    async (channelKey: string) => {
      setRetrying((prev) => {
        const next = new Set(prev)
        next.add(channelKey)
        return next
      })
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-wizard/${wizardId}/retry`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelKeys: [channelKey] }),
          },
        )
        const json = (await res.json()) as SubmitResponse & { error?: string }
        if (!res.ok) {
          setError(json?.error ?? `HTTP ${res.status}`)
          return
        }
        setSubmissions(json.submissions)
        setOverallStatus(json.wizard?.status ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setRetrying((prev) => {
          const next = new Set(prev)
          next.delete(channelKey)
          return next
        })
      }
    },
    [wizardId],
  )

  const onRetryAllFailed = useCallback(async () => {
    if (!submissions) return
    const failedKeys = submissions
      .filter((s) => s.status === 'FAILED')
      .map((s) => s.channelKey)
    if (failedKeys.length === 0) return
    setRetrying((prev) => {
      const next = new Set(prev)
      for (const k of failedKeys) next.add(k)
      return next
    })
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelKeys: failedKeys }),
        },
      )
      const json = (await res.json()) as SubmitResponse & { error?: string }
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      setSubmissions(json.submissions)
      setOverallStatus(json.wizard?.status ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetrying(new Set())
    }
  }, [submissions, wizardId])

  const goToProduct = useCallback(() => {
    router.push(`/products/${product.id}/edit`)
  }, [product.id, router])

  // ── Pre-submit ──────────────────────────────────────────────
  if (!submissions) {
    return (
      <div className="max-w-xl mx-auto py-12 px-6">
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 text-blue-600 mb-4">
            <Rocket className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-semibold text-slate-900">
            Ready to submit
          </h2>
          <p className="mt-2 text-md text-slate-600">
            <span className="font-mono text-slate-800">{product.sku}</span>{' '}
            will be submitted to{' '}
            <span className="font-semibold">{channels.length}</span>{' '}
            channel{channels.length === 1 ? '' : 's'} in parallel.
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-1">
            {channels.map((c) => (
              <span
                key={`${c.platform}:${c.marketplace}`}
                className="text-xs font-mono font-medium bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded"
              >
                {c.platform}:{c.marketplace}
              </span>
            ))}
          </div>

          {error && (
            <div className="mt-4 border border-rose-200 bg-rose-50 rounded px-3 py-2 text-base text-rose-700 inline-flex items-start gap-2 text-left">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || channels.length === 0}
            className={cn(
              'mt-6 inline-flex items-center gap-2 h-10 px-5 rounded-md text-lg font-medium',
              submitting || channels.length === 0
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700',
            )}
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Rocket className="w-4 h-4" />
            )}
            Submit listings
          </button>
        </div>
      </div>
    )
  }

  // ── Post-submit / progress ──────────────────────────────────
  const inFlight = submissions.some(
    (s) =>
      s.status === 'PENDING' ||
      s.status === 'SUBMITTING' ||
      s.status === 'SUBMITTED',
  )
  const failedCount = submissions.filter((s) => s.status === 'FAILED').length
  const liveCount = submissions.filter((s) => s.status === 'LIVE').length
  const notImplCount = submissions.filter(
    (s) => s.status === 'NOT_IMPLEMENTED',
  ).length

  return (
    <div className="max-w-2xl mx-auto py-10 px-6">
      <div className="mb-5">
        <h2 className="text-[20px] font-semibold text-slate-900">
          Submission
        </h2>
        <p className="mt-1 text-md text-slate-600">
          Per-channel publish status. Failed channels can be retried
          individually without re-pushing the successful ones.
        </p>
      </div>

      {/* NN.10 — polling timed out. Surface a manual-refresh CTA so
          the user isn't stuck staring at a spinner that's no longer
          updating. The poll loop is hard-capped at 15 minutes so a
          stuck channel doesn't run polling forever. */}
      {timedOut && (
        <div className="mb-4 border border-amber-200 bg-amber-50 rounded-lg px-4 py-3 flex items-center justify-between">
          <div className="text-base text-amber-900">
            <div className="font-semibold">
              Still waiting after 15 minutes.
            </div>
            <div className="text-sm text-amber-800 mt-0.5">
              Polling paused — click Refresh to resume.
            </div>
          </div>
          <button
            type="button"
            onClick={manualRefresh}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-md text-base font-medium border border-amber-300 text-amber-900 hover:bg-amber-100"
          >
            <RotateCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      )}

      {/* Overall status banner */}
      <div
        className={cn(
          'mb-4 border rounded-lg px-4 py-3 flex items-center justify-between',
          overallStatus === 'LIVE'
            ? 'border-emerald-200 bg-emerald-50'
            : overallStatus === 'FAILED'
            ? 'border-rose-200 bg-rose-50'
            : 'border-slate-200 bg-white',
        )}
      >
        <div className="text-md">
          <div className="font-medium text-slate-900">
            Wizard status:{' '}
            <span className="font-mono">{overallStatus ?? '—'}</span>
          </div>
          <div className="text-sm text-slate-600 mt-0.5">
            {liveCount} live · {failedCount} failed ·{' '}
            {notImplCount} adapter-not-wired ·{' '}
            {submissions.length - liveCount - failedCount - notImplCount}{' '}
            in flight
          </div>
        </div>
        {failedCount > 0 && (
          <button
            type="button"
            onClick={onRetryAllFailed}
            disabled={retrying.size > 0}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-md text-base font-medium border border-rose-200 text-rose-700 hover:bg-rose-100 disabled:opacity-40"
          >
            <RotateCw className="w-3 h-3" />
            Retry all failed
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-700 inline-flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Per-channel rows */}
      <div className="space-y-2">
        {submissions.map((s) => (
          <SubmissionRow
            key={s.channelKey}
            entry={s}
            retrying={retrying.has(s.channelKey)}
            onRetry={() => onRetry(s.channelKey)}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <span className="text-base text-slate-500">
          {inFlight ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Polling for status updates (3s → 5s → 8s, capped at 15min)…
            </span>
          ) : (
            'No channels in flight.'
          )}
        </span>
        <button
          type="button"
          onClick={goToProduct}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-md font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
        >
          Back to product
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

function SubmissionRow({
  entry,
  retrying,
  onRetry,
}: {
  entry: SubmissionEntry
  retrying: boolean
  onRetry: () => void
}) {
  const tone =
    entry.status === 'LIVE'
      ? 'border-emerald-200 bg-emerald-50/50'
      : entry.status === 'FAILED'
      ? 'border-rose-200 bg-rose-50/50'
      : entry.status === 'NOT_IMPLEMENTED'
      ? 'border-slate-200 bg-slate-50/50'
      : 'border-slate-200 bg-white'

  return (
    <div className={cn('border rounded-lg px-4 py-3', tone)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <StatusIcon status={entry.status} retrying={retrying} />
          <div className="min-w-0">
            <div className="font-mono text-md text-slate-900 font-medium truncate">
              {entry.channelKey}
            </div>
            <div className="text-sm text-slate-500 truncate">
              {humanStatus(entry.status, retrying)}
              {entry.submissionId && (
                <span className="ml-1 font-mono text-slate-400">
                  · id: {entry.submissionId}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {entry.listingUrl && (
            <a
              href={entry.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
            >
              View listing
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {(entry.status === 'FAILED' ||
            entry.status === 'NOT_IMPLEMENTED') && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying || entry.status === 'NOT_IMPLEMENTED'}
              title={
                entry.status === 'NOT_IMPLEMENTED'
                  ? 'Retry will stay NOT_IMPLEMENTED until the adapter is wired.'
                  : 'Retry this channel'
              }
              className="inline-flex items-center gap-1 h-7 px-2 rounded text-sm font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {retrying ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCw className="w-3 h-3" />
              )}
              Retry
            </button>
          )}
        </div>
      </div>
      {entry.error && (
        <div className="mt-2 text-sm text-rose-700 inline-flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          {entry.error}
        </div>
      )}
      {/* Audit-fix #7 — Amazon ASINs once they land. Parent ASIN inline,
          per-child counts surfaced to confirm catalog assignment without
          requiring the user to dive into the DB. */}
      {entry.parentAsin && (
        <div className="mt-2 text-sm text-slate-700 inline-flex items-center gap-2 flex-wrap">
          <span className="text-slate-500">Parent ASIN:</span>
          <span className="font-mono font-medium text-slate-900">
            {entry.parentAsin}
          </span>
          {entry.childAsinsByMasterSku &&
            Object.keys(entry.childAsinsByMasterSku).length > 0 && (
              <span className="text-slate-500">
                ·{' '}
                <span className="font-medium text-slate-700">
                  {Object.keys(entry.childAsinsByMasterSku).length}
                </span>{' '}
                child ASIN
                {Object.keys(entry.childAsinsByMasterSku).length === 1
                  ? ''
                  : 's'}{' '}
                assigned
              </span>
            )}
        </div>
      )}
      {entry.notImplementedReason && (
        <div className="mt-2 text-sm text-slate-600 italic">
          {entry.notImplementedReason}
        </div>
      )}
      {entry.warnings && entry.warnings.length > 0 && (
        <SubmissionWarnings warnings={entry.warnings} />
      )}
    </div>
  )
}

/**
 * SP-API issues panel for a successful (or partially successful)
 * publish. Amazon returns recommendations like "image should be at
 * least 1000×1000 px" or "main_product_image_locator format" as
 * WARNING severity — they don't block the listing going live but
 * they do affect Amazon's catalog rendering / ranking. Tiered
 * visually so the operator can triage WARNING-level fixes without
 * mistaking them for errors.
 *
 * Collapses past 3 entries by default — listings can return 10+
 * recommendations and we don't want the row to dominate the page.
 */
function SubmissionWarnings({
  warnings,
}: {
  warnings: NonNullable<SubmissionEntry['warnings']>
}) {
  const [expanded, setExpanded] = useState(false)
  const VISIBLE_COLLAPSED = 3
  const grouped = warnings.reduce(
    (acc, w) => {
      acc[w.severity] = (acc[w.severity] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  const visible = expanded ? warnings : warnings.slice(0, VISIBLE_COLLAPSED)
  const hidden = warnings.length - visible.length

  return (
    <div className="mt-2 border border-amber-200 bg-amber-50/60 rounded-md px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <AlertCircle className="w-3 h-3 text-amber-600 flex-shrink-0" />
        <span className="text-sm font-medium text-amber-900">
          {(grouped.WARNING ?? 0) > 0 && (
            <>
              {grouped.WARNING} warning{grouped.WARNING === 1 ? '' : 's'}
            </>
          )}
          {grouped.WARNING && grouped.INFO ? ' · ' : ''}
          {(grouped.INFO ?? 0) > 0 && (
            <>
              {grouped.INFO} hint{grouped.INFO === 1 ? '' : 's'}
            </>
          )}
        </span>
        <span className="text-xs text-amber-700">
          (publish succeeded; review for catalog quality)
        </span>
      </div>
      <ul className="space-y-1">
        {visible.map((w, i) => (
          <li
            key={i}
            className="text-sm text-slate-800 leading-snug flex items-start gap-1.5"
          >
            <span
              className={cn(
                'mt-0.5 inline-block w-1.5 h-1.5 rounded-full flex-shrink-0',
                w.severity === 'WARNING' ? 'bg-amber-500' : 'bg-sky-500',
              )}
            />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-slate-900">{w.code}</span>
              {w.sku && (
                <span className="ml-1 font-mono text-xs text-slate-500">
                  · {w.sku}
                </span>
              )}
              {w.attributeNames && w.attributeNames.length > 0 && (
                <span className="ml-1 font-mono text-xs text-amber-700">
                  · {w.attributeNames.join(', ')}
                </span>
              )}
              <div className="text-slate-700">{w.message}</div>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-amber-700 hover:text-amber-900 hover:underline"
        >
          Show {hidden} more
        </button>
      )}
      {expanded && warnings.length > VISIBLE_COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-xs text-amber-700 hover:text-amber-900 hover:underline"
        >
          Show fewer
        </button>
      )}
    </div>
  )
}

function StatusIcon({
  status,
  retrying,
}: {
  status: SubmissionStatus
  retrying: boolean
}) {
  if (retrying) {
    return <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
  }
  switch (status) {
    case 'LIVE':
      return <CheckCircle2 className="w-4 h-4 text-emerald-600" />
    case 'FAILED':
      return <XCircle className="w-4 h-4 text-rose-600" />
    case 'NOT_IMPLEMENTED':
      return <AlertCircle className="w-4 h-4 text-slate-400" />
    case 'SUBMITTED':
    case 'SUBMITTING':
    case 'PENDING':
    default:
      return <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
  }
}

function humanStatus(status: SubmissionStatus, retrying: boolean): string {
  if (retrying) return 'Retrying…'
  switch (status) {
    case 'PENDING':
      return 'Pending'
    case 'SUBMITTING':
      return 'Submitting…'
    case 'SUBMITTED':
      return 'Submitted — awaiting confirmation'
    case 'LIVE':
      return 'Live'
    case 'FAILED':
      return 'Failed'
    case 'NOT_IMPLEMENTED':
      return 'Adapter not wired'
    default:
      return status
  }
}
