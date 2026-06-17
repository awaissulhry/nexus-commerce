/**
 * ATM.12 — Audit timeline (Option B: existing tables).
 *
 * The "what did Xavia push, pull, and observe on this SKU, when,
 * and how did it land?" view. Sources the timeline from the four
 * tables that already track product-scoped activity:
 *
 *   ChannelPublishAttempt   — every publish (live, sandbox, dry-run,
 *                              gated, rate-limited, circuit-open).
 *                              Captures channel + marketplace + mode
 *                              + outcome + submissionId + payloadDigest
 *                              for drift detection.
 *   SyncAttempt             — every reverse-sync from channel into
 *                              Nexus. Captures status + source
 *                              (manual / bulk / cron / webhook) +
 *                              duration.
 *   ChannelStockEvent       — every drift observation from CS-series.
 *                              Captures channel-reported vs local qty
 *                              + status (PENDING / APPLIED / IGNORED).
 *   OutboundSyncQueue       — every PENDING / FAILED outbound queue
 *                              row. Captures targetChannel + status
 *                              + retryCount + nextRetryAt.
 *
 * Per-field "what value did this field have at timestamp X" requires
 * a ProductChangeLog table that doesn't exist yet (Option A). This
 * tab ships the available data first so operators get a real audit
 * surface today; the per-field layer plugs in when ChangeLog lands.
 *
 * Rendered as a single chronologically-merged timeline with one
 * row per event. Each row carries: timestamp, event type chip,
 * channel/market label when applicable, outcome chip, primary
 * detail (submissionId / drift qty / sync source).
 *
 * Filter chips at the top let operators narrow by event type. Hard
 * cap at 200 most recent events across all sources — anything
 * deeper is sync-logs / outbound-queue territory.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Clock,
  Upload,
  XCircle,
} from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

interface HistoryTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

type EventKind = 'publish' | 'sync' | 'drift' | 'queue'

interface TimelineEvent {
  id: string
  kind: EventKind
  at: Date
  channel: string | null
  marketplace: string | null
  outcomeOk: boolean | null // true=ok, false=fail, null=neutral
  primary: string
  secondary?: string
}

export default async function HistoryTab({
  productId,
  locale,
  t,
}: HistoryTabProps) {
  const [publishes, syncs, drifts, queue] = await Promise.all([
    prisma.channelPublishAttempt
      .findMany({
        where: { productId },
        orderBy: { attemptedAt: 'desc' },
        take: 75,
        select: {
          id: true,
          channel: true,
          marketplace: true,
          mode: true,
          outcome: true,
          errorMessage: true,
          submissionId: true,
          attemptedAt: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.12] publish attempts fetch failed', e)
        return [] as never[]
      }),
    prisma.syncAttempt
      .findMany({
        where: { channelListing: { productId } },
        orderBy: { attemptedAt: 'desc' },
        take: 75,
        select: {
          id: true,
          status: true,
          source: true,
          error: true,
          attemptedAt: true,
          channelListing: {
            select: { channel: true, marketplace: true },
          },
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.12] sync attempts fetch failed', e)
        return [] as never[]
      }),
    prisma.channelStockEvent
      .findMany({
        where: { productId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          channel: true,
          channelReportedQty: true,
          localQtyAtObservation: true,
          drift: true,
          status: true,
          createdAt: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.12] stock events fetch failed', e)
        return [] as never[]
      }),
    prisma.outboundSyncQueue
      .findMany({
        where: { productId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          id: true,
          targetChannel: true,
          targetRegion: true,
          syncStatus: true,
          retryCount: true,
          createdAt: true,
          syncedAt: true,
          errorMessage: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.12] outbound queue fetch failed', e)
        return [] as never[]
      }),
  ])

  const events: TimelineEvent[] = []

  for (const p of publishes) {
    const ok =
      p.outcome === 'success'
        ? true
        : p.outcome === 'failed' || p.outcome === 'timeout'
          ? false
          : null
    events.push({
      id: `pub-${p.id}`,
      kind: 'publish',
      at: p.attemptedAt,
      channel: p.channel,
      marketplace: p.marketplace,
      outcomeOk: ok,
      primary: `${p.mode} · ${p.outcome}`,
      secondary: p.submissionId ?? p.errorMessage ?? undefined,
    })
  }

  for (const s of syncs) {
    const ok =
      s.status === 'SUCCESS'
        ? true
        : s.status === 'FAILED' || s.status === 'TIMEOUT'
          ? false
          : null
    events.push({
      id: `sync-${s.id}`,
      kind: 'sync',
      at: s.attemptedAt,
      channel: s.channelListing?.channel ?? null,
      marketplace: s.channelListing?.marketplace ?? null,
      outcomeOk: ok,
      primary: `${s.source} · ${s.status}`,
      secondary: s.error ?? undefined,
    })
  }

  for (const d of drifts) {
    events.push({
      id: `drift-${d.id}`,
      kind: 'drift',
      at: d.createdAt,
      channel: d.channel,
      marketplace: null,
      outcomeOk: d.status === 'APPLIED' || d.status === 'IGNORED' ? null : false,
      primary: t('products.datasheetHub.history.driftPrimary', {
        channelQty: d.channelReportedQty,
        localQty: d.localQtyAtObservation,
        drift: d.drift,
      }),
      secondary: d.status,
    })
  }

  for (const q of queue) {
    const ok =
      q.syncStatus === 'SUCCESS'
        ? true
        : q.syncStatus === 'FAILED'
          ? false
          : null
    events.push({
      id: `queue-${q.id}`,
      kind: 'queue',
      at: q.syncedAt ?? q.createdAt,
      channel: q.targetChannel,
      marketplace: q.targetRegion ?? null,
      outcomeOk: ok,
      primary: q.syncStatus,
      secondary:
        q.errorMessage ??
        (q.retryCount > 0
          ? t('products.datasheetHub.history.queueRetries', {
              count: q.retryCount,
            })
          : undefined),
    })
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime())
  const top = events.slice(0, 200)

  if (top.length === 0) {
    return (
      <div className="border border-default dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
        <Clock className="w-6 h-6 mx-auto mb-2 text-slate-300" />
        <div className="font-medium text-slate-700 dark:text-slate-300">
          {t('products.datasheetHub.history.empty.title')}
        </div>
        <p className="text-xs mt-1">
          {t('products.datasheetHub.history.empty.body')}
        </p>
      </div>
    )
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relAge = (d: Date) => {
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), 'day')
    return rtf.format(Math.round(diffSec / (86400 * 30)), 'month')
  }
  const absoluteFmt = new Intl.DateTimeFormat(numLocale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  // Per-kind tally for the summary row.
  const tally = top.reduce(
    (acc, e) => {
      acc[e.kind]++
      return acc
    },
    { publish: 0, sync: 0, drift: 0, queue: 0 },
  )

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.history.title', { count: top.length })}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <ArrowUpFromLine className="w-3 h-3" />
            {tally.publish}
          </span>
          <span className="inline-flex items-center gap-1">
            <ArrowDownToLine className="w-3 h-3" />
            {tally.sync}
          </span>
          {tally.drift > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {tally.drift}
            </span>
          )}
          {tally.queue > 0 && (
            <span className="inline-flex items-center gap-1">
              <Upload className="w-3 h-3" />
              {tally.queue}
            </span>
          )}
        </div>
      </div>

      <div className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-hidden">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {top.map((e) => (
            <li
              key={e.id}
              className="px-3 py-2 flex items-start gap-3 text-xs"
            >
              {/* Kind icon */}
              <div className="flex-shrink-0 mt-0.5">
                {e.kind === 'publish' && (
                  <ArrowUpFromLine
                    className={
                      e.outcomeOk === true
                        ? 'w-3.5 h-3.5 text-emerald-500'
                        : e.outcomeOk === false
                          ? 'w-3.5 h-3.5 text-red-500'
                          : 'w-3.5 h-3.5 text-tertiary'
                    }
                  />
                )}
                {e.kind === 'sync' && (
                  <ArrowDownToLine
                    className={
                      e.outcomeOk === true
                        ? 'w-3.5 h-3.5 text-emerald-500'
                        : e.outcomeOk === false
                          ? 'w-3.5 h-3.5 text-red-500'
                          : 'w-3.5 h-3.5 text-tertiary'
                    }
                  />
                )}
                {e.kind === 'drift' && (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                )}
                {e.kind === 'queue' && (
                  <Upload
                    className={
                      e.outcomeOk === true
                        ? 'w-3.5 h-3.5 text-emerald-500'
                        : e.outcomeOk === false
                          ? 'w-3.5 h-3.5 text-red-500'
                          : 'w-3.5 h-3.5 text-blue-500'
                    }
                  />
                )}
              </div>

              {/* Main detail */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={
                      'inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ' +
                      kindClass(e.kind)
                    }
                  >
                    {t(`products.datasheetHub.history.kind.${e.kind}`)}
                  </span>
                  {e.channel && (
                    <span className="text-slate-700 dark:text-slate-200">
                      {prettyChannelMarketplace(e.channel, e.marketplace ?? '')}
                    </span>
                  )}
                  <span className="text-slate-600 dark:text-slate-300 font-mono text-[10px] uppercase">
                    {e.primary}
                  </span>
                  {e.outcomeOk === true && (
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                  )}
                  {e.outcomeOk === false && (
                    <XCircle className="w-3 h-3 text-red-500" />
                  )}
                </div>
                {e.secondary && (
                  <div
                    className={
                      e.outcomeOk === false
                        ? 'text-red-600 dark:text-red-400 text-[10px] mt-0.5 break-words'
                        : 'text-slate-500 dark:text-slate-400 text-[10px] mt-0.5 break-words'
                    }
                  >
                    {e.secondary}
                  </div>
                )}
              </div>

              {/* Time */}
              <div
                className="flex-shrink-0 text-right text-[10px] text-slate-500 dark:text-slate-400 tabular-nums"
                title={absoluteFmt.format(e.at)}
              >
                {relAge(e.at)}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <div className="italic">
          {t('products.datasheetHub.history.scopeNote')}
        </div>
        <Link
          href={`/sync-logs/live?productId=${productId}`}
          className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:underline"
        >
          {t('products.datasheetHub.history.openSyncLogs')}
        </Link>
      </div>
    </div>
  )
}

function kindClass(kind: EventKind): string {
  if (kind === 'publish')
    return 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
  if (kind === 'sync')
    return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  if (kind === 'drift')
    return 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
  return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
}
