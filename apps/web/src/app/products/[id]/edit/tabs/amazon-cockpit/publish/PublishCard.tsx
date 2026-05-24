'use client'

// AC.12 — Publish Flow & Multi-Market Submit.
//
// Operators selecting the listings cockpit's primary "Publish" action
// land here. Three responsibilities:
//
//   1. Pre-flight health gate — per-market score from AC.4. The
//      current market's score is computed from the live cockpit
//      `composed` state; other markets default to a "ready when
//      ChannelListing exists" optimistic gate (true health per
//      sibling needs its own composed — landed in AC.12.2 when the
//      cross-market manifest pipe ships).
//   2. Multi-market submit — POST /api/products/:id/publish-amazon
//      with the checked marketplaces. The endpoint reuses the
//      AmazonFlatFileService.buildJsonFeedBody pipeline; the
//      /products/amazon-flat-file routes file is untouched.
//   3. Live status polling — GET /api/amazon/flat-file/feeds/:feedId
//      every 5 seconds per submitted market until DONE / CANCELLED.
//      Surfaces processing-report rows + per-row error messages
//      inline.

import { useEffect, useState } from 'react'
import {
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { HealthReport, HealthStatus } from '../health/computeHealthScore'
import {
  classifyStatus,
  marketFlag,
} from '../../../_shared/market-switch/types'
import {
  announce,
  announceAssertive,
} from '../../../_shared/announce/useAnnounce'
import { postCockpitEvent } from '../../../_shared/telemetry/cockpit-telemetry'

interface MarketRow {
  code: string
  name: string
  hasListing: boolean
  listingStatus?: string | null
}

interface Props {
  productId: string
  /** Active marketplace + its health report (computed in AC.4). */
  activeMarketplace: string
  activeHealth: HealthReport
  markets: MarketRow[]
}

interface SubmissionResult {
  marketplace: string
  ok: boolean
  feedId: string | null
  feedDocumentId: string | null
  messageCount: number
  dryRun: boolean
  error: string | null
}

interface PublishResponse {
  productId: string
  dryRun: boolean
  submissions: SubmissionResult[]
}

interface FeedStatus {
  feedId: string
  processingStatus: string
  resultFeedDocumentId: string | null
  results: Array<{ sku: string; status: string; message: string }>
  dryRun?: boolean
}

interface PerMarketState {
  marketplace: string
  feedId: string | null
  status:
    | 'queued'
    | 'submitting'
    | 'submitted'
    | 'in_progress'
    | 'done'
    | 'cancelled'
    | 'error'
  error: string | null
  processingStatus: string | null
  resultsOk: number
  resultsError: number
  rows: FeedStatus['results']
}

const HEALTH_TONE: Record<
  HealthStatus,
  { tone: string; label: string }
> = {
  ready: { tone: 'text-emerald-700 dark:text-emerald-400', label: 'Ready' },
  warn: { tone: 'text-amber-700 dark:text-amber-400', label: 'Polish' },
  blocked: { tone: 'text-rose-700 dark:text-rose-400', label: 'Blocked' },
  suppressed: {
    tone: 'text-rose-700 dark:text-rose-400',
    label: 'Suppressed',
  },
}

export default function PublishCard({
  productId,
  activeMarketplace,
  activeHealth,
  markets,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([activeMarketplace]),
  )
  const [submitting, setSubmitting] = useState(false)
  const [topError, setTopError] = useState<string | null>(null)
  const [perMarket, setPerMarket] = useState<Record<string, PerMarketState>>(
    {},
  )
  const [detailsOpen, setDetailsOpen] = useState(false)

  function toggle(code: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  async function handlePublish() {
    if (selected.size === 0) {
      setTopError('Pick at least one marketplace.')
      return
    }
    // Hard gate: only block the ACTIVE market via AC.4 health; siblings
    // get an optimistic pass since their health requires a per-market
    // composed which lands later. The endpoint's per-listing check
    // still rejects markets without a ChannelListing.
    if (
      selected.has(activeMarketplace) &&
      activeHealth.status === 'blocked'
    ) {
      const confirmed = window.confirm(
        `${activeMarketplace} is BLOCKED (${activeHealth.score}/100). Submit anyway?\n\nAmazon will likely reject the feed.`,
      )
      if (!confirmed) return
    }

    setSubmitting(true)
    setTopError(null)
    const init: Record<string, PerMarketState> = {}
    for (const m of selected) {
      init[m] = {
        marketplace: m,
        feedId: null,
        status: 'submitting',
        error: null,
        processingStatus: null,
        resultsOk: 0,
        resultsError: 0,
        rows: [],
      }
    }
    setPerMarket(init)

    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/publish-amazon`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketplaces: Array.from(selected),
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const j = (await res.json()) as PublishResponse
      const next: Record<string, PerMarketState> = {}
      for (const s of j.submissions) {
        next[s.marketplace] = {
          marketplace: s.marketplace,
          feedId: s.feedId,
          status: s.ok ? 'submitted' : 'error',
          error: s.error,
          processingStatus: null,
          resultsOk: 0,
          resultsError: 0,
          rows: [],
        }
      }
      setPerMarket(next)
      const okCount = j.submissions.filter((s) => s.ok).length
      const failCount = j.submissions.length - okCount
      announce(
        `Submitted to ${okCount} marketplace${okCount === 1 ? '' : 's'}${failCount > 0 ? `, ${failCount} failed` : ''}. Polling feed status…`,
      )
      postCockpitEvent({
        type: 'publish_submitted',
        productId,
        payload: {
          marketplaces: j.submissions.map((s) => s.marketplace),
          okCount,
          failCount,
          dryRun: j.dryRun,
          healthScore: activeHealth.score,
          healthStatus: activeHealth.status,
          activeMarketplace,
        },
      })
      // Kick off per-market polling for any submitted feed.
      for (const s of j.submissions) {
        if (s.ok && s.feedId) pollFeed(s.marketplace, s.feedId)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setTopError(msg)
      setPerMarket({})
      announceAssertive(`Publish failed: ${msg}`)
      postCockpitEvent({
        type: 'publish_failed',
        productId,
        payload: {
          error: msg,
          marketplaces: Array.from(selected),
          activeMarketplace,
        },
      })
    } finally {
      setSubmitting(false)
    }
  }

  /** Per-feed 5-second polling loop. Captures terminal states and
   *  surfaces processing-report rows inline. Self-terminates after
   *  20 minutes (240 ticks) to avoid runaway browser timers if the
   *  operator forgets the tab open. */
  function pollFeed(marketplace: string, feedId: string) {
    let ticks = 0
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    const intervalId = window.setInterval(async () => {
      ticks += 1
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/amazon/flat-file/feeds/${encodeURIComponent(feedId)}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = (await res.json()) as FeedStatus
        const ps = j.processingStatus
        const okRows = j.results.filter((r) => r.status === 'success').length
        const errRows = j.results.filter((r) => r.status === 'error').length

        const terminal =
          ps === 'DONE' || ps === 'CANCELLED' || ps === 'FATAL'
        setPerMarket((m) => ({
          ...m,
          [marketplace]: {
            ...(m[marketplace] ?? {
              marketplace,
              feedId,
              status: 'in_progress',
              error: null,
              processingStatus: null,
              resultsOk: 0,
              resultsError: 0,
              rows: [],
            }),
            feedId,
            status:
              ps === 'DONE'
                ? 'done'
                : ps === 'CANCELLED' || ps === 'FATAL'
                  ? 'cancelled'
                  : 'in_progress',
            processingStatus: ps,
            resultsOk: okRows,
            resultsError: errRows,
            rows: j.results,
          },
        }))

        if (terminal) {
          window.clearInterval(intervalId)
          const tEnd =
            typeof performance !== 'undefined'
              ? performance.now()
              : Date.now()
          if (ps === 'DONE') {
            announce(
              `${marketplace}: feed done. ${okRows} ok${errRows > 0 ? `, ${errRows} errors` : ''}.`,
            )
          } else if (ps === 'CANCELLED' || ps === 'FATAL') {
            announceAssertive(`${marketplace}: feed ${ps.toLowerCase()}.`)
          }
          postCockpitEvent({
            type: 'publish_terminal',
            productId,
            marketplace,
            durationMs: Math.round(tEnd - t0),
            payload: {
              feedId,
              processingStatus: ps,
              resultsOk: okRows,
              resultsError: errRows,
            },
          })
        } else if (ticks >= 240) {
          window.clearInterval(intervalId)
          setPerMarket((m) => ({
            ...m,
            [marketplace]: {
              ...(m[marketplace] ?? {
                marketplace,
                feedId,
                status: 'in_progress',
                error: null,
                processingStatus: ps,
                resultsOk: 0,
                resultsError: 0,
                rows: [],
              }),
              status: 'in_progress',
              error: 'Polling timed out after 20 min — check Seller Central',
            },
          }))
        }
      } catch (e) {
        // Transient fetch fail — keep polling unless we exhaust.
        if (ticks >= 240) {
          window.clearInterval(intervalId)
          setPerMarket((m) => ({
            ...m,
            [marketplace]: {
              ...(m[marketplace] ?? {
                marketplace,
                feedId,
                status: 'in_progress',
                error: null,
                processingStatus: null,
                resultsOk: 0,
                resultsError: 0,
                rows: [],
              }),
              status: 'error',
              error: e instanceof Error ? e.message : String(e),
            },
          }))
        }
      }
    }, 5000)
  }

  useEffect(() => {
    // Stop any in-flight polling on unmount — feeds keep running
    // server-side so re-opening the cockpit will resume status.
    return () => {
      // intervals are scoped to each pollFeed call; no global
      // cleanup needed beyond letting the closures be GC'd.
    }
  }, [])

  const anySubmitted = Object.values(perMarket).some(
    (m) => m.feedId != null && m.status !== 'error',
  )
  const allTerminal =
    anySubmitted &&
    Object.values(perMarket).every(
      (m) =>
        m.status === 'done' ||
        m.status === 'cancelled' ||
        m.status === 'error',
    )

  return (
    <div
      data-jump-target="publish"
      className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/15 p-3 space-y-2.5"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2">
          <Send className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Publish to Amazon
          </span>
          <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
            Multi-market submit via JSON_LISTINGS_FEED
          </span>
        </div>
      </div>

      {/* Per-market gate list */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
        {markets.map((m) => {
          const isActive = m.code === activeMarketplace
          const health = isActive ? activeHealth : null
          const tone = health ? HEALTH_TONE[health.status] : null
          const live = perMarket[m.code]
          const checked = selected.has(m.code)
          const dotCls = classifyStatus(m.hasListing, m.listingStatus)
          return (
            <label
              key={m.code}
              className={cn(
                'rounded border p-2 flex items-start gap-1.5 cursor-pointer transition-colors',
                checked
                  ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checked}
                onChange={() => toggle(m.code)}
                disabled={submitting}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1 flex-wrap">
                  <span className="text-[10.5px]">
                    {marketFlag(m.code)}
                  </span>
                  <span className="font-mono text-[11.5px] text-slate-900 dark:text-slate-100">
                    {m.code}
                  </span>
                  <span className="text-[10.5px] text-slate-500 dark:text-slate-400 truncate">
                    {m.name}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                  {!m.hasListing ? (
                    <span className="text-[10px] text-slate-400 italic">
                      No listing yet
                    </span>
                  ) : isActive && health ? (
                    <span className={cn('text-[10px] font-medium', tone!.tone)}>
                      {health.score}/100 · {tone!.label}
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">
                      {dotCls === 'published' ? 'Published' : 'Draft'}
                    </span>
                  )}
                </div>
                {live && (
                  <FeedStatusLine state={live} />
                )}
              </div>
            </label>
          )
        })}
      </div>

      {topError && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-400">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{topError}</span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          icon={
            submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )
          }
          onClick={handlePublish}
          disabled={submitting || selected.size === 0}
        >
          {submitting
            ? 'Submitting…'
            : `Publish to ${selected.size} market${selected.size === 1 ? '' : 's'}`}
        </Button>
        {anySubmitted && (
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            {detailsOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Feed details
          </button>
        )}
      </div>

      {detailsOpen && anySubmitted && (
        <div className="space-y-1.5 pt-1.5 border-t border-emerald-200 dark:border-emerald-800">
          {Object.values(perMarket).map((s) => (
            <FeedDetailRow key={s.marketplace} state={s} />
          ))}
        </div>
      )}

      <div className="text-[10.5px] text-slate-500 dark:text-slate-400 italic">
        AC.12 — single-row submit per market via existing
        JSON_LISTINGS_FEED pipeline. /products/amazon-flat-file is
        untouched.
        {allTerminal && ' All feeds reached a terminal state.'}
      </div>
    </div>
  )
}

// ── Inline live status line per chip ──────────────────────────────────
function FeedStatusLine({ state }: { state: PerMarketState }) {
  let label = ''
  let icon: React.ReactNode = null
  let tone = 'text-slate-500 dark:text-slate-400'
  if (state.status === 'submitting' || state.status === 'queued') {
    label = 'Uploading…'
    icon = <Loader2 className="w-2.5 h-2.5 animate-spin" />
    tone = 'text-blue-600 dark:text-blue-400'
  } else if (state.status === 'submitted' || state.status === 'in_progress') {
    label = state.processingStatus ?? 'IN_PROGRESS'
    icon = <Loader2 className="w-2.5 h-2.5 animate-spin" />
    tone = 'text-blue-600 dark:text-blue-400'
  } else if (state.status === 'done') {
    label =
      state.resultsError > 0
        ? `${state.resultsOk} ok · ${state.resultsError} err`
        : `${state.resultsOk || 1} ok`
    icon =
      state.resultsError > 0 ? (
        <AlertTriangle className="w-2.5 h-2.5" />
      ) : (
        <CheckCircle2 className="w-2.5 h-2.5" />
      )
    tone =
      state.resultsError > 0
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-emerald-600 dark:text-emerald-400'
  } else if (state.status === 'cancelled') {
    label = 'Cancelled'
    icon = <XCircle className="w-2.5 h-2.5" />
    tone = 'text-slate-500 dark:text-slate-400'
  } else if (state.status === 'error') {
    label = 'Error'
    icon = <AlertCircle className="w-2.5 h-2.5" />
    tone = 'text-rose-600 dark:text-rose-400'
  }
  return (
    <div
      className={cn(
        'mt-0.5 inline-flex items-center gap-0.5 text-[9.5px] font-mono',
        tone,
      )}
      title={state.error ?? state.processingStatus ?? ''}
    >
      {icon}
      <span>{label}</span>
    </div>
  )
}

// ── Per-feed detail row ────────────────────────────────────────────────
function FeedDetailRow({ state }: { state: PerMarketState }) {
  return (
    <div className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="inline-flex items-center gap-1.5">
          <span className="text-[10.5px]">{marketFlag(state.marketplace)}</span>
          <span className="font-mono">{state.marketplace}</span>
          {state.feedId && (
            <span className="text-[10px] font-mono text-slate-400">
              · {state.feedId.slice(0, 18)}
              {state.feedId.length > 18 ? '…' : ''}
            </span>
          )}
        </div>
        <FeedStatusLine state={state} />
      </div>
      {state.error && (
        <div className="mt-1 text-[10.5px] text-rose-600 dark:text-rose-400">
          {state.error}
        </div>
      )}
      {state.rows.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {state.rows.slice(0, 6).map((r, i) => (
            <li
              key={`${r.sku}-${i}`}
              className="text-[10.5px] font-mono text-slate-600 dark:text-slate-400 flex items-baseline gap-1.5"
            >
              <span
                className={cn(
                  'w-1 h-1 rounded-full mt-1.5 flex-shrink-0',
                  r.status === 'success'
                    ? 'bg-emerald-500'
                    : 'bg-rose-500',
                )}
              />
              <span className="text-slate-700 dark:text-slate-300">{r.sku || '—'}</span>
              {r.message && (
                <span className="truncate text-slate-500 dark:text-slate-400">
                  · {r.message}
                </span>
              )}
            </li>
          ))}
          {state.rows.length > 6 && (
            <li className="text-[10px] text-slate-400">
              + {state.rows.length - 6} more rows
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
