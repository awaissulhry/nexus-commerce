/**
 * RX.1 — Per-channel ingest-health strip.
 *
 * Shows, per channel, how many reviews we hold, how many are *real*
 * (imported / live API) vs sandbox fixtures, and when each channel last
 * received data. Makes it obvious at a glance whether live data is
 * actually flowing — and links straight to the import workflow.
 */

import Link from 'next/link'
import { Upload, CheckCircle2, CircleDashed, Database } from 'lucide-react'

export interface IngestChannel {
  channel: string
  total: number
  realCount: number
  fixtureCount: number
  bySource: Record<string, number>
  lastIngestedAt: string | null
  lastReviewAt: string | null
  hasRealData: boolean
  isCanonical: boolean
}

export interface IngestHealthPayload {
  channels: IngestChannel[]
  lastIngestCron: {
    startedAt: string
    finishedAt: string | null
    status: string
    outputSummary: string | null
  } | null
  generatedAt: string
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

export function IngestHealthStrip({ health }: { health: IngestHealthPayload }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-slate-500 dark:text-slate-400" />
          <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Ingestion health
          </div>
          {health.lastIngestCron && (
            <span className="text-[10px] text-slate-400 dark:text-slate-500">
              · last cron {relativeTime(health.lastIngestCron.startedAt)} ({health.lastIngestCron.status})
            </span>
          )}
        </div>
        <Link
          href="/marketing/reviews/import"
          className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded ring-1 ring-inset bg-blue-50 text-blue-700 ring-blue-200 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900"
        >
          <Upload className="h-3.5 w-3.5" />
          Import reviews
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {health.channels
          .filter((c) => c.isCanonical || c.total > 0)
          .map((c) => {
            const live = c.hasRealData
            return (
              <div
                key={c.channel}
                className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-800 px-2.5 py-1.5"
              >
                {live ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-slate-400 dark:text-slate-500 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {CHANNEL_LABEL[c.channel] ?? c.channel}
                    </span>
                    <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {c.total}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                    {c.realCount > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {c.realCount} real
                      </span>
                    ) : (
                      <span>no real data yet</span>
                    )}
                    {c.fixtureCount > 0 && <span> · {c.fixtureCount} fixture</span>}
                    {c.lastReviewAt && <span> · latest {relativeTime(c.lastReviewAt)}</span>}
                  </div>
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}
