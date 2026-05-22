'use client'

/**
 * RT.1 — Push health chip + expand modal.
 *
 * Single source of truth for "is the push pipeline alive?" across
 * /orders + /insights/live. Replaces the Amazon-only LiveSyncBadge
 * (LS.3) with a unified view that covers Amazon SP-API notifications,
 * eBay platform notifications, and Shopify REST webhooks.
 *
 * Chip states (overallStatus from /api/admin/push-health):
 *   ● Live   (emerald)  — newest event across sources < 5min
 *   ◐ Quiet  (amber)    — newest event 5min-1h
 *   ◌ Silent (rose)     — newest event > 1h on at least one active source
 *   ▣ —      (slate)    — no source has ever delivered (fresh install)
 *
 * Counter line beside the status shows "47 / 0" — processed24h /
 * failed24h across all sources, plus DLQ depth when populated by RT.2.
 *
 * Clicking the chip opens a modal with per-source detail: status dot,
 * last event time + type, 24h counts, and the top event types seen
 * in the last 24h. SQS queue depth shows under the Amazon row when
 * AWS_ACCESS_KEY_ID is configured.
 *
 * Polls /api/admin/push-health every 30s; re-ticks the "Xs ago"
 * labels every 5s without re-fetching to keep them honest.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { X } from 'lucide-react'

type SourceStatus = 'live' | 'quiet' | 'silent' | 'never'
type OverallStatus = 'live' | 'quiet' | 'silent' | 'unknown'

interface PushHealth {
  overallStatus: OverallStatus
  summary: {
    processed24h: number
    failed24h: number
    dlqDepth: number | null
    lastEventAt: string | null
  }
  sources: Array<{
    source: 'AMAZON' | 'EBAY' | 'SHOPIFY'
    status: SourceStatus
    lastEventAt: string | null
    lastEventType: string | null
    count24h: number
    failed24h: number
    eventTypes24h: Array<{ type: string; count: number }>
  }>
  sqs: { queueDepth: number | null; region: string | null }
  checkedAt: string
}

function relativeAgo(iso: string | null): string {
  if (!iso) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const STATUS_STYLES: Record<
  OverallStatus,
  { dot: string; chip: string; label: (h: PushHealth) => string }
> = {
  live: {
    dot: '●',
    chip:
      'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
    label: (h) => `Live · ${relativeAgo(h.summary.lastEventAt)}`,
  },
  quiet: {
    dot: '◐',
    chip:
      'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
    label: (h) => `Quiet · ${relativeAgo(h.summary.lastEventAt)}`,
  },
  silent: {
    dot: '◌',
    chip:
      'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
    label: (h) => `Silent · ${relativeAgo(h.summary.lastEventAt)}`,
  },
  unknown: {
    dot: '▣',
    chip:
      'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
    label: () => 'No push events',
  },
}

const SOURCE_DOT_COLOR: Record<SourceStatus, string> = {
  live: 'bg-emerald-500',
  quiet: 'bg-amber-500',
  silent: 'bg-rose-500',
  never: 'bg-slate-400',
}

const SOURCE_LABEL: Record<PushHealth['sources'][number]['source'], string> = {
  AMAZON: 'Amazon SP-API',
  EBAY: 'eBay Platform Notifications',
  SHOPIFY: 'Shopify Webhooks',
}

export function PushHealthChip() {
  const [health, setHealth] = useState<PushHealth | null>(null)
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)

  const load = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/admin/push-health`, {
        cache: 'no-store',
        credentials: 'include',
      })
      if (res.ok) setHealth(await res.json())
    } catch {
      // swallow — chip keeps last known good state
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  // Re-tick "Xs ago" labels without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [])

  if (!health) return null

  const style = STATUS_STYLES[health.overallStatus]
  const counterText =
    health.summary.dlqDepth && health.summary.dlqDepth > 0
      ? `${health.summary.processed24h} / ${health.summary.failed24h} · DLQ ${health.summary.dlqDepth}`
      : `${health.summary.processed24h} / ${health.summary.failed24h}`

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-2 h-7 px-2.5 text-xs font-medium border rounded transition hover:brightness-95 ${style.chip}`}
        title="Push pipeline health — click for per-source detail"
        aria-label={`Push health: ${style.label(health)}`}
      >
        <span aria-hidden="true">{style.dot}</span>
        <span>{style.label(health)}</span>
        <span className="opacity-70 tabular-nums text-[10px] border-l border-current/30 pl-2 ml-0.5">
          {counterText}
        </span>
      </button>

      {open && (
        <PushHealthModal
          health={health}
          onClose={() => setOpen(false)}
          onRefresh={load}
        />
      )}
    </>
  )
}

function PushHealthModal({
  health,
  onClose,
  onRefresh,
}: {
  health: PushHealth
  onClose: () => void
  onRefresh: () => void
}) {
  // Close on Escape — modal pattern matches the rest of the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Push pipeline health detail"
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-slate-900/40 dark:bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Push pipeline health
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Last checked {relativeAgo(health.checkedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              className="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="p-4 grid grid-cols-3 gap-3 border-b border-slate-200 dark:border-slate-800">
          <Stat label="Last event" value={relativeAgo(health.summary.lastEventAt)} />
          <Stat label="24h processed" value={String(health.summary.processed24h)} />
          <Stat
            label="24h failed"
            value={String(health.summary.failed24h)}
            tone={health.summary.failed24h > 0 ? 'rose' : 'slate'}
          />
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {health.sources.map((s) => (
            <div key={s.source} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${SOURCE_DOT_COLOR[s.status]}`}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {SOURCE_LABEL[s.source]}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    {s.status}
                  </span>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {s.count24h} / {s.failed24h} in 24h
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="text-slate-500 dark:text-slate-400">
                  Last event:{' '}
                  <span className="text-slate-900 dark:text-slate-100 font-medium">
                    {relativeAgo(s.lastEventAt)}
                  </span>
                  {s.lastEventType && (
                    <span className="text-slate-400 dark:text-slate-500"> · {s.lastEventType}</span>
                  )}
                </div>
                {s.source === 'AMAZON' && health.sqs.queueDepth !== null && (
                  <div className="text-slate-500 dark:text-slate-400 text-right">
                    SQS depth:{' '}
                    <span className="text-slate-900 dark:text-slate-100 font-medium tabular-nums">
                      {health.sqs.queueDepth}
                    </span>
                    {health.sqs.region && (
                      <span className="text-slate-400 dark:text-slate-500"> · {health.sqs.region}</span>
                    )}
                  </div>
                )}
              </div>

              {s.eventTypes24h.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.eventTypes24h.map((t) => (
                    <span
                      key={t.type}
                      className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                    >
                      <span className="text-slate-500 dark:text-slate-400">{t.type}</span>
                      <span className="tabular-nums">{t.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <footer className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-[10px] text-slate-500 dark:text-slate-400">
          Status thresholds: live &lt; 5min · quiet 5min-1h · silent &gt; 1h. Sources with no
          events ever (status: never) don&apos;t count toward the overall — they may not be wired up.
        </footer>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: string
  tone?: 'slate' | 'rose'
}) {
  const valueClass =
    tone === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="rounded border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}
