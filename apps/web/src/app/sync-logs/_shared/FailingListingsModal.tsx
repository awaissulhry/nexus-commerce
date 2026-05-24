'use client'

/**
 * PIM E.3 — Failing listings drill-down modal.
 *
 * Opens when an operator clicks a red (or amber/gray) cell in the
 * ListingHealthGrid. Lists the affected ChannelListings inline with
 * lastSyncError text and a one-click "Edit" link that lands on the
 * specific product's edit page, with the correct channel tab pre-
 * selected so the operator sees the failing field immediately.
 *
 * Bucket filter inside the modal lets the operator widen to amber /
 * gray without leaving the dialog.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  X,
  Loader2,
  AlertCircle,
  ExternalLink,
  Clock,
  AlertTriangle,
  Minus,
  RotateCw,
  Skull,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Bucket = 'red' | 'amber' | 'gray' | 'dlq'

interface FailingRow {
  channelListingId: string
  listingStatus: string
  syncStatus: string | null
  syncRetryCount: number | null
  isDlq: boolean
  lastSyncedAt: string | null
  lastSyncError: string | null
  externalListingId: string | null
  titleOverride: string | null
  productId: string
  productSku: string
  productName: string | null
  parentProductId: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  channel: string
  marketplace: string
  /** Initial bucket filter; modal lets the operator widen. Default red. */
  initialBuckets?: Bucket[]
}

export default function FailingListingsModal({
  open,
  onClose,
  channel,
  marketplace,
  initialBuckets = ['red'],
}: Props) {
  const { toast } = useToast()
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets)
  const [rows, setRows] = useState<FailingRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  // Reset to initial buckets each time the modal opens for a new cell.
  useEffect(() => {
    if (open) setBuckets(initialBuckets)
  }, [open, initialBuckets, channel, marketplace])

  const fetchRows = useCallback(async () => {
    if (!open) return
    setLoading(true)
    setError(null)
    try {
      const url = new URL(`${getBackendUrl()}/api/sync-logs/failing-listings`)
      url.searchParams.set('channel', channel)
      url.searchParams.set('marketplace', marketplace)
      url.searchParams.set('buckets', buckets.join(','))
      url.searchParams.set('limit', '50')
      const r = await fetch(url.toString(), { cache: 'no-store' })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${r.status}`)
      }
      const data = (await r.json()) as { rows: FailingRow[]; hasMore: boolean }
      setRows(data.rows)
      setHasMore(data.hasMore)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [open, channel, marketplace, buckets])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  // E.5 — Retry every currently-listed failing listing. Reuses the
  // same filter so what you see is what gets retried.
  const handleRetryAll = useCallback(async () => {
    setRetrying(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/sync-logs/failing-listings/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, marketplace, buckets }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `HTTP ${r.status}`)
      }
      const result = await r.json()
      const enq = result?.enqueued ?? 0
      const skp = result?.skipped ?? 0
      const total = result?.total ?? 0
      toast.success(
        `Retried ${enq} of ${total}`,
        { description: skp > 0 ? `${skp} skipped (channel not in retry scope)` : undefined },
      )
      await fetchRows()
    } catch (e: any) {
      toast.error('Retry failed', { description: e?.message })
    } finally {
      setRetrying(false)
    }
  }, [channel, marketplace, buckets, fetchRows, toast])

  if (!open) return null

  const toggleBucket = (b: Bucket) => {
    setBuckets((prev) =>
      prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b].sort(),
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {channel} · {marketplace}
            </h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {loading ? 'Loading…' : `${rows.length}${hasMore ? '+' : ''} listings need attention`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <BucketFilter buckets={buckets} onToggle={toggleBucket} />
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => void handleRetryAll()}
                disabled={retrying}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Re-enqueue every listing currently shown for a new sync attempt"
              >
                {retrying ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCw className="w-3 h-3" />
                )}
                Retry all
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 p-3 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading failing listings…
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <div className="text-center py-10 text-zinc-500 text-sm italic">
              No listings match the current bucket filter.
            </div>
          )}
          {!loading && !error && rows.length > 0 && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <FailingRowItem
                  key={r.channelListingId}
                  row={r}
                  channel={channel}
                  marketplace={marketplace}
                />
              ))}
            </ul>
          )}
          {hasMore && (
            <div className="px-4 py-2 text-center text-[11px] text-zinc-500 italic">
              Showing first 50 — narrow your bucket filter or open a focused query in /sync-logs/errors.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BucketFilter({
  buckets,
  onToggle,
}: {
  buckets: Bucket[]
  onToggle: (b: Bucket) => void
}) {
  const items: Array<{ b: Bucket; label: string; Icon: typeof AlertCircle }> = [
    { b: 'red', label: 'Failed', Icon: AlertCircle },
    { b: 'amber', label: 'Pending', Icon: Clock },
    { b: 'gray', label: 'Inactive', Icon: Minus },
    { b: 'dlq', label: 'DLQ', Icon: Skull },
  ]
  return (
    <div className="flex items-center gap-1">
      {items.map(({ b, label, Icon }) => {
        const active = buckets.includes(b)
        return (
          <button
            key={b}
            type="button"
            onClick={() => onToggle(b)}
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border transition-colors',
              active
                ? b === 'red'
                  ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300'
                  : b === 'amber'
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                  : b === 'dlq'
                  ? 'border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
                  : 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                : 'border-zinc-200 text-zinc-400 hover:text-zinc-700 dark:border-zinc-800 dark:hover:text-zinc-300',
            )}
          >
            <Icon className="w-2.5 h-2.5" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

function FailingRowItem({
  row,
  channel,
  marketplace,
}: {
  row: FailingRow
  channel: string
  marketplace: string
}) {
  // Deep-link: edit page opens with the channel tab pre-selected.
  // The product edit page reads the `tab` query param; we pass the
  // channel tab key ('AMAZON', 'EBAY', etc.) so the operator lands
  // on the failing channel's panel and the InheritancePanel (B.2)
  // surfaces the override state immediately.
  // For variant children, link to the parent so the edit page can
  // expand into the right variant context.
  const editTargetId = row.parentProductId ?? row.productId
  const href = `/products/${editTargetId}/edit?tab=${encodeURIComponent(channel)}&marketplace=${encodeURIComponent(marketplace)}&variant=${encodeURIComponent(row.productId)}`

  return (
    <li className="px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-mono text-xs text-zinc-500">{row.productSku}</span>
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {row.titleOverride ?? row.productName ?? <em>unnamed</em>}
            </span>
            <StatusBadge status={row.listingStatus} />
            {row.isDlq && (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] font-medium px-1 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                title={`Exceeded retry back-off (count: ${row.syncRetryCount ?? '?'})`}
              >
                <Skull className="w-2 h-2" />
                DLQ
              </span>
            )}
            {!row.isDlq && (row.syncRetryCount ?? 0) > 0 && (
              <span
                className="text-[9px] text-zinc-500"
                title={`Retried ${row.syncRetryCount} times`}
              >
                retry {row.syncRetryCount}
              </span>
            )}
          </div>
          {row.lastSyncError && (
            <div className="flex items-start gap-1 text-[11px] text-red-700 dark:text-red-300 mt-1 break-words">
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
              <span>{row.lastSyncError}</span>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
            {row.externalListingId && (
              <span className="font-mono">ext: {row.externalListingId}</span>
            )}
            {row.lastSyncedAt && (
              <span>
                last sync {new Date(row.lastSyncedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <Link
          href={href}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex-shrink-0"
        >
          <ExternalLink className="w-3 h-3" />
          Edit
        </Link>
      </div>
    </li>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    ['ERROR', 'FAILED', 'ENDED'].includes(status)
      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
      : ['DRAFT', 'PENDING', 'IN_SYNC', 'IDLE'].includes(status)
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
  return (
    <span className={cn('text-[9px] font-medium px-1 py-0.5 rounded', tone)}>
      {status}
    </span>
  )
}
