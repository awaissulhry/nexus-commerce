'use client'

// IR.9.4 — Unified publish history for Amazon + eBay + Shopify.
//
// Reads from /api/products/:id/image-publish-jobs which merges
// AmazonImageFeedJob + ChannelImagePublishJob into one UnifiedJob[].
// Per-channel filter narrows it; passing no channel shows all three.
//
// Each row gets a status badge (color-coded), elapsed time,
// truncated error message, and a Retry button when the job is in a
// retry-eligible state (anything except DONE / CANCELLED).
//
// Retry hits POST /api/image-publish-jobs/:jobId/retry which marks
// the original CANCELLED and kicks off a fresh attempt — the next
// refresh pulls the new row in.

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from './api'

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

interface UnifiedJob {
  id: string
  channel: Channel
  marketplace: string | null
  status: string
  errorMessage: string | null
  vendorEntityId: string | null
  submittedAt: string
  completedAt: string | null
}

interface Props {
  productId: string
  /** Filter to a single channel. Omit to show all three. */
  channel?: Channel
}

const CHANNEL_LABEL: Record<Channel, string> = {
  AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify',
}

const CHANNEL_COLOR: Record<Channel, string> = {
  AMAZON:  'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  EBAY:    'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  SHOPIFY: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
}

function statusTone(status: string): { bg: string; text: string; icon: typeof CheckCircle2 } {
  if (status === 'DONE') return {
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    text: 'text-emerald-700 dark:text-emerald-300',
    icon: CheckCircle2,
  }
  if (status === 'FATAL' || status === 'ERROR') return {
    bg: 'bg-rose-50 dark:bg-rose-950/30',
    text: 'text-rose-700 dark:text-rose-300',
    icon: AlertCircle,
  }
  if (status === 'CANCELLED') return {
    bg: 'bg-slate-50 dark:bg-slate-800/50',
    text: 'text-slate-500 dark:text-slate-400',
    icon: AlertCircle,
  }
  // SUBMITTING / IN_QUEUE / IN_PROGRESS / PENDING
  return {
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    text: 'text-blue-700 dark:text-blue-300',
    icon: Clock,
  }
}

function elapsedTime(from: string): string {
  const m = Math.floor((Date.now() - new Date(from).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / (24 * 60))}d ago`
}

function successRate(jobs: UnifiedJob[]): { ok: number; total: number; pct: number } {
  const settled = jobs.filter((j) => j.status === 'DONE' || j.status === 'FATAL' || j.status === 'ERROR')
  const ok = settled.filter((j) => j.status === 'DONE').length
  return {
    ok,
    total: settled.length,
    pct: settled.length === 0 ? 0 : Math.round((ok / settled.length) * 100),
  }
}

export default function ImagePublishHistory({ productId, channel }: Props) {
  const [jobs, setJobs] = useState<UnifiedJob[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)

  const fetchJobs = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/image-publish-jobs?limit=50`)
      if (!res.ok) throw new Error(`History fetch failed: ${res.status}`)
      const body: { jobs: UnifiedJob[] } = await res.json()
      setJobs(body.jobs ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'History fetch failed')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => { void fetchJobs() }, [fetchJobs])

  async function retry(jobId: string) {
    setRetryingId(jobId)
    setRetryError(null)
    try {
      const res = await beFetch(`/api/image-publish-jobs/${jobId}/retry`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Retry failed: ${res.status}`)
      }
      // Refresh after a beat so the new job has a chance to land.
      await new Promise((r) => setTimeout(r, 500))
      void fetchJobs()
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetryingId(null)
    }
  }

  const filtered = channel ? jobs.filter((j) => j.channel === channel) : jobs
  const channels: Channel[] = channel ? [channel] : ['AMAZON', 'EBAY', 'SHOPIFY']

  return (
    <div className="space-y-3">
      {/* Success-rate stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {channels.map((ch) => {
          const rate = successRate(jobs.filter((j) => j.channel === ch))
          return (
            <div key={ch} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <span className={cn('text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded', CHANNEL_COLOR[ch])}>
                  {CHANNEL_LABEL[ch]}
                </span>
                <span className={cn(
                  'text-sm font-medium tabular-nums',
                  rate.total === 0
                    ? 'text-slate-400'
                    : rate.pct >= 90
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : rate.pct >= 70
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-rose-600 dark:text-rose-400',
                )}>
                  {rate.total === 0 ? '—' : `${rate.pct}%`}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {rate.total === 0 ? 'No completed jobs yet' : `${rate.ok} ok / ${rate.total} settled`}
              </p>
            </div>
          )
        })}
      </div>

      {/* Header row */}
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          Recent jobs ({filtered.length})
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => fetchJobs()}
          disabled={loading}
          className="ml-auto gap-1 text-[11px] h-6 px-2"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </Button>
      </div>

      {loadError && <p className="text-[11px] text-red-600 dark:text-red-400">{loadError}</p>}
      {retryError && <p className="text-[11px] text-red-600 dark:text-red-400">Retry: {retryError}</p>}

      {/* Jobs list */}
      {filtered.length === 0 && !loading ? (
        <p className="text-xs text-slate-400 dark:text-slate-500 italic py-3">
          No publish attempts {channel ? `to ${CHANNEL_LABEL[channel]}` : 'yet'}.
        </p>
      ) : (
        <ul className="space-y-1">
          {filtered.map((j) => {
            const tone = statusTone(j.status)
            const canRetry = j.status !== 'DONE' && j.status !== 'CANCELLED'
            const Icon = tone.icon
            return (
              <li
                key={j.id}
                className={cn('flex items-center gap-2 px-3 py-1.5 rounded border border-slate-100 dark:border-slate-800 text-xs', tone.bg)}
              >
                <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', tone.text)} />
                <span className={cn('font-mono text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0', CHANNEL_COLOR[j.channel])}>
                  {CHANNEL_LABEL[j.channel]}{j.marketplace ? ` · ${j.marketplace}` : ''}
                </span>
                <span className={cn('font-medium flex-shrink-0', tone.text)}>{j.status}</span>
                {j.errorMessage && (
                  <span className="text-slate-500 dark:text-slate-400 truncate min-w-0" title={j.errorMessage}>
                    — {j.errorMessage}
                  </span>
                )}
                <span className="text-slate-400 ml-auto flex-shrink-0 tabular-nums">{elapsedTime(j.submittedAt)}</span>
                {canRetry && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => retry(j.id)}
                    disabled={retryingId !== null}
                    className="text-[10px] h-6 px-2 gap-1 flex-shrink-0"
                  >
                    {retryingId === j.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <RotateCw className="w-3 h-3" />}
                    Retry
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
