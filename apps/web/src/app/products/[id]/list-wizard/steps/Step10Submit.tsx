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
}

interface SubmitResponse {
  wizard: { id: string; status: string; completedAt: string | null }
  submissions: SubmissionEntry[]
  validation?: { allReady: boolean; blockingChannels: string[] }
}

const POLL_INTERVAL_MS = 3000

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
  const pollTimer = useRef<number | null>(null)
  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/poll`,
        { method: 'POST' },
      )
      const json = (await res.json()) as SubmitResponse & { error?: string }
      if (!res.ok) {
        // Don't break the UI — log the error and keep showing the
        // last-known state.
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
      if (!inFlight) stopPolling()
    } catch {
      /* swallow — next tick retries */
    }
  }, [wizardId, stopPolling])

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
        pollTimer.current = window.setInterval(poll, POLL_INTERVAL_MS)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [wizardId, poll, stopPolling])

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
          <h2 className="text-[18px] font-semibold text-slate-900">
            Ready to submit
          </h2>
          <p className="mt-2 text-[13px] text-slate-600">
            <span className="font-mono text-slate-800">{product.sku}</span>{' '}
            will be submitted to{' '}
            <span className="font-semibold">{channels.length}</span>{' '}
            channel{channels.length === 1 ? '' : 's'} in parallel.
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-1">
            {channels.map((c) => (
              <span
                key={`${c.platform}:${c.marketplace}`}
                className="text-[10px] font-mono font-medium bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded"
              >
                {c.platform}:{c.marketplace}
              </span>
            ))}
          </div>

          {error && (
            <div className="mt-4 border border-rose-200 bg-rose-50 rounded px-3 py-2 text-[12px] text-rose-700 inline-flex items-start gap-2 text-left">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || channels.length === 0}
            className={cn(
              'mt-6 inline-flex items-center gap-2 h-10 px-5 rounded-md text-[14px] font-medium',
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
        <p className="mt-1 text-[13px] text-slate-600">
          Per-channel publish status. Failed channels can be retried
          individually without re-pushing the successful ones.
        </p>
      </div>

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
        <div className="text-[13px]">
          <div className="font-medium text-slate-900">
            Wizard status:{' '}
            <span className="font-mono">{overallStatus ?? '—'}</span>
          </div>
          <div className="text-[11px] text-slate-600 mt-0.5">
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
            className="inline-flex items-center gap-1 h-8 px-3 rounded-md text-[12px] font-medium border border-rose-200 text-rose-700 hover:bg-rose-100 disabled:opacity-40"
          >
            <RotateCw className="w-3 h-3" />
            Retry all failed
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-700 inline-flex items-start gap-2">
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
        <span className="text-[12px] text-slate-500">
          {inFlight ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Polling every {POLL_INTERVAL_MS / 1000}s for status updates…
            </span>
          ) : (
            'No channels in flight.'
          )}
        </span>
        <button
          type="button"
          onClick={goToProduct}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-[13px] font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
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
            <div className="font-mono text-[13px] text-slate-900 font-medium truncate">
              {entry.channelKey}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
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
              className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
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
              className="inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
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
        <div className="mt-2 text-[11px] text-rose-700 inline-flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          {entry.error}
        </div>
      )}
      {entry.notImplementedReason && (
        <div className="mt-2 text-[11px] text-slate-600 italic">
          {entry.notImplementedReason}
        </div>
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
