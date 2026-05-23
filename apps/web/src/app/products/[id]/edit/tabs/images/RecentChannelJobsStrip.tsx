'use client'

// PB.3c — Compact recent-jobs strip for eBay + Shopify panels.
//
// Mirrors the AmazonPublishBar recent-jobs strip but for the
// channelImagePublishJob log (synchronous eBay/Shopify publishes).
// Shows the last 3 jobs as one row each: status icon · channel
// label · status · elapsed · short error message when failed.
//
// Mounted above the per-channel Publish row. Auto-fetches on mount
// and re-fetches when refreshKey changes — the panel bumps that
// counter after onPublish completes so the strip surfaces the
// freshly recorded job without a manual reload.
//
// Per-SKU drill-down + retry actions live in the expandable
// ImagePublishHistory accordion that's already mounted below.

import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { beFetch } from './api'

type Channel = 'EBAY' | 'SHOPIFY'

interface UnifiedJob {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplace: string | null
  status: string
  errorMessage: string | null
  vendorEntityId: string | null
  submittedAt: string
  completedAt: string | null
}

interface Props {
  productId: string
  channel: Channel
  /** Increment to force a refetch (panel bumps after publish). */
  refreshKey?: number
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Queued',
  SUBMITTING: 'Submitting…',
  IN_QUEUE: 'Queued',
  IN_PROGRESS: 'Processing…',
  DONE: 'Done',
  FATAL: 'Failed',
  ERROR: 'Failed',
  CANCELLED: 'Cancelled',
}

function elapsed(from: string): string {
  const m = Math.floor((Date.now() - new Date(from).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function statusIcon(status: string) {
  if (status === 'DONE') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
  if (status === 'FATAL' || status === 'ERROR' || status === 'CANCELLED') {
    return <AlertCircle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" />
  }
  return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
}

export default function RecentChannelJobsStrip({ productId, channel, refreshKey = 0 }: Props) {
  const [jobs, setJobs] = useState<UnifiedJob[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    beFetch(`/api/products/${productId}/image-publish-jobs?limit=20`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`History fetch failed: ${res.status}`)
        return res.json() as Promise<{ jobs: UnifiedJob[] }>
      })
      .then((body) => {
        if (cancelled) return
        const filtered = (body.jobs ?? [])
          .filter((j) => j.channel === channel)
          .slice(0, 3)
        setJobs(filtered)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'History fetch failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [productId, channel, refreshKey])

  if (jobs.length === 0 && !loading && !error) return null

  return (
    <div className="px-5 py-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
      <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
        <span>Recent jobs</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
      </div>
      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400">{error}</div>
      )}
      {jobs.map((job) => (
        <div key={job.id} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          {statusIcon(job.status)}
          <span className="font-mono text-slate-700 dark:text-slate-300">
            {channel === 'EBAY' ? 'eBay' : 'Shopify'}
          </span>
          <span className="text-slate-400">—</span>
          <span className={cn(
            'font-medium',
            job.status === 'DONE' && 'text-emerald-700 dark:text-emerald-300',
            (job.status === 'FATAL' || job.status === 'ERROR' || job.status === 'CANCELLED')
              && 'text-rose-700 dark:text-rose-300',
          )}>
            {STATUS_LABEL[job.status] ?? job.status}
          </span>
          {job.errorMessage && (
            <span className="text-rose-600 dark:text-rose-400 truncate text-[11px]" title={job.errorMessage}>
              · {job.errorMessage}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 text-slate-400 dark:text-slate-500 flex-shrink-0">
            <Clock className="w-3 h-3" />
            {elapsed(job.submittedAt)}
          </span>
        </div>
      ))}
    </div>
  )
}
