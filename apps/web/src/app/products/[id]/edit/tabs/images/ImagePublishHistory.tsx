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
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, RefreshCw, RotateCw, Activity, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { beFetch } from './api'

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

interface PerSkuRow {
  sku: string
  asin: string | null
  accepted: boolean
  errors: Array<{ code: string; message: string }>
}

interface UnifiedJob {
  id: string
  channel: Channel
  marketplace: string | null
  status: string
  errorMessage: string | null
  vendorEntityId: string | null
  submittedAt: string
  completedAt: string | null
  // IA.3 — per-SKU receipt for Amazon jobs in DONE state. Surfaced
  // as an expandable drill-down so the operator sees exactly which
  // ASINs were accepted vs rejected, with Amazon's verbatim message
  // for each rejection.
  perSku?: PerSkuRow[]
}

interface Props {
  productId: string
  /** Filter to a single channel. Omit to show all three. */
  channel?: Channel
  /** Bump/change to force a refetch (e.g. after a publish completes). Optional —
   *  callers that don't pass it keep the fetch-on-mount + manual-refresh behavior. */
  refreshKey?: string | number
}

// IR.15 — pending statuses Amazon SP-API actually progresses through.
// These rows get a "Refresh from Amazon" action so the operator can
// pull fresh status on demand instead of waiting for the 30 s poll.
const AMAZON_REFRESHABLE_STATUSES = new Set(['PENDING', 'SUBMITTING', 'IN_QUEUE', 'IN_PROGRESS'])

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

export default function ImagePublishHistory({ productId, channel, refreshKey }: Props) {
  const { t } = useTranslations()
  const [jobs, setJobs] = useState<UnifiedJob[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  // IR.15 — manual "pull fresh status from Amazon" state.
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  // IA.3 — Track which jobs are expanded to show their per-SKU
  // receipts. Multiple jobs can be open simultaneously.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  // Refetch on mount, and whenever refreshKey changes (e.g. a publish landed).
  useEffect(() => { void fetchJobs() }, [fetchJobs, refreshKey])

  async function refreshFromAmazon(jobId: string) {
    setRefreshingId(jobId)
    try {
      // The existing endpoint polls SP-API and updates the job row.
      // We just trigger it, then refresh the list to surface the
      // new status. Errors are non-fatal — the operator can retry.
      await beFetch(`/api/products/${productId}/amazon-images/feed-status/${jobId}`)
      await fetchJobs()
    } catch {
      // Surface via fetchJobs's loadError path on next render
    } finally {
      setRefreshingId(null)
    }
  }

  async function retry(jobId: string, rejectedOnly = false) {
    setRetryingId(jobId)
    setRetryError(null)
    try {
      const res = await beFetch(`/api/image-publish-jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectedOnly }),
      })
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
            <div key={ch} className="px-3 py-2 rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <span className={cn('text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded', CHANNEL_COLOR[ch])}>
                  {CHANNEL_LABEL[ch]}
                </span>
                <span className={cn(
                  'text-sm font-medium tabular-nums',
                  rate.total === 0
                    ? 'text-tertiary'
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
                {rate.total === 0
                  ? t('products.edit.images.history.noCompletedJobs')
                  : t('products.edit.images.history.settledRatio', { ok: rate.ok, total: rate.total })}
              </p>
            </div>
          )
        })}
      </div>

      {/* Header row */}
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          {t('products.edit.images.history.recentJobs', { count: filtered.length })}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => fetchJobs()}
          disabled={loading}
          className="ml-auto gap-1 text-[11px] h-6 px-2"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {t('products.edit.images.history.refresh')}
        </Button>
      </div>

      {loadError && <p className="text-[11px] text-red-600 dark:text-red-400">{loadError}</p>}
      {retryError && <p className="text-[11px] text-red-600 dark:text-red-400">{t('products.edit.images.history.retry')}: {retryError}</p>}

      {/* Jobs list */}
      {filtered.length === 0 && !loading ? (
        <p className="text-xs text-tertiary dark:text-slate-500 italic py-3">
          {channel
            ? t('products.edit.images.history.noJobsChannel', { channel: CHANNEL_LABEL[channel] })
            : t('products.edit.images.history.noJobsAll')}
        </p>
      ) : (
        <ul className="space-y-1">
          {filtered.map((j) => {
            const tone = statusTone(j.status)
            const canRetry = j.status !== 'DONE' && j.status !== 'CANCELLED'
            const Icon = tone.icon
            // IA.3 — Job has a drill-down when Amazon returned a
            // per-SKU receipt. Show the expand chevron only then;
            // jobs without receipts (pending, fatal pre-parse,
            // eBay/Shopify) stay collapsed-by-default with no toggle.
            const hasReceipt = !!j.perSku && j.perSku.length > 0
            const isExpanded = expandedIds.has(j.id)
            const acceptedCount = hasReceipt ? j.perSku!.filter((r) => r.accepted).length : 0
            const rejectedCount = hasReceipt ? j.perSku!.length - acceptedCount : 0
            return (
              <li
                key={j.id}
                className={cn('rounded border border-subtle dark:border-slate-800 text-xs', tone.bg)}
              >
                <div className="flex items-center gap-2 px-3 py-1.5">
                  {hasReceipt ? (
                    <button
                      type="button"
                      onClick={() => toggleExpand(j.id)}
                      aria-label={isExpanded ? 'Collapse receipt' : 'Expand receipt'}
                      className="text-tertiary hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0"
                    >
                      {(() => {
                        // Next 16 / Turbopack TS plugin sometimes misses
                        // inline-conditional component-class JSX as a "use"
                        // of the imported icon — assigning to a local makes
                        // the usage explicit so the noUnusedLocals lint clears.
                        const ChevronIcon = isExpanded ? ChevronDown : ChevronRight
                        return <ChevronIcon className="w-3 h-3" />
                      })()}
                    </button>
                  ) : <span className="w-3" />}
                  <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', tone.text)} />
                <span className={cn('font-mono text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0', CHANNEL_COLOR[j.channel])}>
                  {CHANNEL_LABEL[j.channel]}{j.marketplace ? ` · ${j.marketplace}` : ''}
                </span>
                <span className={cn('font-medium flex-shrink-0', tone.text)}>{j.status}</span>
                {hasReceipt && (
                  <span className="text-[10px] flex-shrink-0">
                    <span className="text-emerald-600 dark:text-emerald-400">{acceptedCount} ok</span>
                    {rejectedCount > 0 && (
                      <span className="text-rose-600 dark:text-rose-400 ml-1">· {rejectedCount} rejected</span>
                    )}
                  </span>
                )}
                {j.errorMessage && (
                  <span className="text-slate-500 dark:text-slate-400 truncate min-w-0" title={j.errorMessage}>
                    — {j.errorMessage}
                  </span>
                )}
                <span className="text-tertiary ml-auto flex-shrink-0 tabular-nums">{elapsedTime(j.submittedAt)}</span>
                {/* IR.15 — manual "Refresh from Amazon" for in-progress
                    feed jobs. Replaces 30 s passive polling with
                    operator-driven status pull. */}
                {j.channel === 'AMAZON' && AMAZON_REFRESHABLE_STATUSES.has(j.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => refreshFromAmazon(j.id)}
                    disabled={refreshingId !== null}
                    className="text-[10px] h-6 px-2 gap-1 flex-shrink-0"
                    title={t('products.edit.images.history.refreshFromAmazon')}
                  >
                    {refreshingId === j.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Activity className="w-3 h-3" />}
                    {t('products.edit.images.history.refreshFromAmazonShort')}
                  </Button>
                )}
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
                    {t('products.edit.images.history.retry')}
                  </Button>
                )}
                </div>

                {/* IA.3 — Per-SKU receipt drill-down. Hidden by default;
                    operator clicks the chevron to expand. Shows
                    Amazon's per-row outcome with the verbatim error
                    code + message so the operator can debug. */}
                {hasReceipt && isExpanded && (
                  <div className="px-3 pb-2 pt-1 border-t border-subtle dark:border-slate-800">
                    {/* IA.6 — Retry-rejected-only. Targets the same
                        publisher path with variantIds filter so
                        accepted ASINs don't get re-hammered. Shown
                        only when at least one row was rejected. */}
                    {rejectedCount > 0 && j.channel === 'AMAZON' && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          {rejectedCount} SKU{rejectedCount === 1 ? '' : 's'} need fixing before re-submit.
                        </span>
                        <Button
                          size="sm"
                          onClick={() => retry(j.id, true)}
                          disabled={retryingId !== null}
                          className="text-[11px] h-6 px-2 gap-1"
                          title="Re-submit just the rejected SKUs. Accepted ASINs stay as-is."
                        >
                          {retryingId === j.id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <RotateCw className="w-3 h-3" />}
                          Retry {rejectedCount} rejected
                        </Button>
                      </div>
                    )}
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-left text-slate-500 dark:text-slate-400">
                          <th className="px-1.5 py-1 font-medium">SKU</th>
                          <th className="px-1.5 py-1 font-medium">ASIN</th>
                          <th className="px-1.5 py-1 font-medium text-center">Status</th>
                          <th className="px-1.5 py-1 font-medium">Amazon error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {j.perSku!.map((row) => (
                          <tr key={row.sku} className="border-t border-subtle dark:border-slate-800">
                            <td className="px-1.5 py-1 font-mono text-slate-700 dark:text-slate-200">{row.sku}</td>
                            <td className="px-1.5 py-1 font-mono text-slate-500 dark:text-slate-400">{row.asin ?? '—'}</td>
                            <td className="px-1.5 py-1 text-center">
                              {row.accepted ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                                  <CheckCircle2 className="w-3 h-3" /> OK
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                                  <XCircle className="w-3 h-3" /> Rejected
                                </span>
                              )}
                            </td>
                            <td className="px-1.5 py-1 text-slate-600 dark:text-slate-300">
                              {row.errors.length === 0 ? (
                                <span className="text-tertiary">—</span>
                              ) : (
                                <ul className="space-y-0.5">
                                  {row.errors.map((e, i) => (
                                    <li key={i}>
                                      <span className="font-mono text-[10px] text-rose-700 dark:text-rose-300">{e.code}</span>
                                      <span className="text-slate-600 dark:text-slate-300 ml-1">{e.message}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
