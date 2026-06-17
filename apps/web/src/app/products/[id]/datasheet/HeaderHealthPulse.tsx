/**
 * ATM.2 — Header health pulse.
 *
 * Read-only signal row that sits above the tab nav and tells the
 * operator at a glance whether this SKU's data across all channels
 * and markets is trustworthy. Five signals, left → right:
 *
 *   1. Markets active  — count of ChannelListings with
 *                        isPublished=true AND listingStatus='ACTIVE'
 *   2. Sync status     — per-listing latest SyncAttempt, bucketed:
 *                        success (green), stale >24h (amber),
 *                        failed/timeout (red), never (grey)
 *   3. Drift events    — open ChannelStockEvent (CS-series) count;
 *                        operator-actionable mismatches
 *   4. Pending pushes  — OutboundSyncQueue rows in PENDING/IN_PROGRESS
 *   5. Last modified   — Product.updatedAt, relative format
 *
 * No quick-action buttons yet — actions land in ATM.6 (validate)
 * and ATM.13 (bulk push/resync). Shipping the read signals first
 * keeps the trust surface honest.
 *
 * The component is a server component fetching in parallel via
 * Promise.all so the page's TTFB stays under 200ms on a warm DB.
 * Each query is wrapped in .catch(() => fallback) so a missing
 * downstream table (e.g. ChannelStockEvent on a stale env) renders
 * a "—" chip rather than crashing the hub.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Globe,
  Upload,
  XCircle,
} from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

const STALE_MS = 24 * 60 * 60 * 1000 // 24 hours

interface HeaderHealthPulseProps {
  productId: string
  productUpdatedAt: Date
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default async function HeaderHealthPulse({
  productId,
  productUpdatedAt,
  locale,
  t,
}: HeaderHealthPulseProps) {
  const [activeListings, driftCount, pendingPushCount] = await Promise.all([
    prisma.channelListing
      .findMany({
        where: {
          productId,
          isPublished: true,
          listingStatus: 'ACTIVE',
        },
        select: {
          id: true,
          channel: true,
          marketplace: true,
          syncAttempts: {
            orderBy: { attemptedAt: 'desc' },
            take: 1,
            select: { attemptedAt: true, status: true },
          },
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.2] activeListings query failed', e)
        return [] as Array<{
          id: string
          channel: string
          marketplace: string
          syncAttempts: Array<{ attemptedAt: Date; status: string }>
        }>
      }),
    prisma.channelStockEvent
      .count({
        where: { productId, status: 'PENDING' },
      })
      .catch((e: unknown) => {
        console.error('[atm.2] driftCount query failed', e)
        return -1 // sentinel rendered as "—"
      }),
    prisma.outboundSyncQueue
      .count({
        where: {
          productId,
          syncStatus: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.2] pendingPushCount query failed', e)
        return -1
      }),
  ])

  // Bucket each listing by its latest SyncAttempt status. We treat
  // "never synced" and "last sync >24h ago" as distinct buckets —
  // both are amber-grade but the operator's mental model is
  // different ("we never reached the channel" vs "we did but it
  // hasn't refreshed").
  const now = Date.now()
  let synced = 0
  let stale = 0
  let failed = 0
  let never = 0
  for (const l of activeListings) {
    const last = l.syncAttempts[0]
    if (!last) {
      never++
      continue
    }
    if (last.status === 'FAILED' || last.status === 'TIMEOUT') {
      failed++
      continue
    }
    if (last.status === 'SUCCESS') {
      const age = now - last.attemptedAt.getTime()
      if (age > STALE_MS) stale++
      else synced++
      continue
    }
    // PENDING / IN_PROGRESS / NOT_IMPLEMENTED treat as stale
    stale++
  }

  const marketsCount = activeListings.length

  // Relative-time formatting via Intl.RelativeTimeFormat — locale-
  // aware, no hand-rolled "2h ago" string. Pick the largest unit
  // that gives a value >= 1.
  const rtf = new Intl.RelativeTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
    numeric: 'auto',
  })
  const updatedAgo = (() => {
    const diffSec = Math.round((productUpdatedAt.getTime() - now) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), 'day')
    if (abs < 86400 * 365)
      return rtf.format(Math.round(diffSec / (86400 * 30)), 'month')
    return rtf.format(Math.round(diffSec / (86400 * 365)), 'year')
  })()

  // Overall trust color: green only when nothing's wrong. Failed
  // listings dominate (red); stale or never dominates yellow.
  const overall: 'green' | 'amber' | 'red' | 'grey' =
    marketsCount === 0
      ? 'grey'
      : failed > 0
        ? 'red'
        : stale > 0 || never > 0 || (driftCount ?? 0) > 0
          ? 'amber'
          : 'green'

  return (
    <div
      className={
        'flex items-center gap-3 flex-wrap rounded border px-3 py-2 text-xs ' +
        (overall === 'green'
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950'
          : overall === 'amber'
            ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
            : overall === 'red'
              ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
              : 'border-default bg-slate-50 dark:border-slate-800 dark:bg-slate-900')
      }
      role="status"
      aria-live="polite"
      aria-label={t('products.datasheetHub.pulse.aria')}
    >
      {/* Markets active */}
      <SignalChip
        icon={Globe}
        label={t(
          marketsCount === 1
            ? 'products.datasheetHub.pulse.markets.one'
            : 'products.datasheetHub.pulse.markets.other',
          { count: marketsCount },
        )}
        tone={marketsCount === 0 ? 'grey' : 'neutral'}
      />

      <Sep />

      {/* Sync status breakdown */}
      {synced > 0 && (
        <SignalChip
          icon={CheckCircle2}
          label={t('products.datasheetHub.pulse.sync.synced', {
            count: synced,
          })}
          tone="green"
        />
      )}
      {stale > 0 && (
        <SignalChip
          icon={Clock}
          label={t('products.datasheetHub.pulse.sync.stale', { count: stale })}
          tone="amber"
        />
      )}
      {failed > 0 && (
        <SignalChip
          icon={XCircle}
          label={t('products.datasheetHub.pulse.sync.failed', {
            count: failed,
          })}
          tone="red"
        />
      )}
      {never > 0 && (
        <SignalChip
          icon={AlertTriangle}
          label={t('products.datasheetHub.pulse.sync.never', { count: never })}
          tone="grey"
        />
      )}
      {marketsCount > 0 &&
        synced === marketsCount &&
        stale === 0 &&
        failed === 0 &&
        never === 0 && (
          <SignalChip
            icon={CheckCircle2}
            label={t('products.datasheetHub.pulse.sync.allGood')}
            tone="green"
          />
        )}

      <Sep />

      {/* Drift count */}
      {driftCount === -1 ? (
        <SignalChip
          icon={Activity}
          label={t('products.datasheetHub.pulse.drift.unavailable')}
          tone="grey"
        />
      ) : driftCount === 0 ? (
        <SignalChip
          icon={CheckCircle2}
          label={t('products.datasheetHub.pulse.drift.none')}
          tone="green"
        />
      ) : (
        <Link
          href={`/fulfillment/stock/channel-drift?productId=${productId}`}
          className="hover:underline"
        >
          <SignalChip
            icon={AlertTriangle}
            label={t(
              driftCount === 1
                ? 'products.datasheetHub.pulse.drift.one'
                : 'products.datasheetHub.pulse.drift.other',
              { count: driftCount },
            )}
            tone="amber"
          />
        </Link>
      )}

      <Sep />

      {/* Pending pushes */}
      {pendingPushCount === -1 ? (
        <SignalChip
          icon={Upload}
          label={t('products.datasheetHub.pulse.push.unavailable')}
          tone="grey"
        />
      ) : pendingPushCount === 0 ? (
        <SignalChip
          icon={Upload}
          label={t('products.datasheetHub.pulse.push.none')}
          tone="grey"
        />
      ) : (
        <SignalChip
          icon={Upload}
          label={t(
            pendingPushCount === 1
              ? 'products.datasheetHub.pulse.push.one'
              : 'products.datasheetHub.pulse.push.other',
            { count: pendingPushCount },
          )}
          tone="amber"
        />
      )}

      {/* Last modified — pushed to the right */}
      <div className="ml-auto flex items-center gap-2 text-slate-500 dark:text-slate-400">
        <Clock className="w-3 h-3" />
        <span>
          {t('products.datasheetHub.pulse.updated', { ago: updatedAgo })}
        </span>
        <Link
          href={`/sync-logs/live?productId=${productId}`}
          className="text-slate-600 dark:text-slate-300 hover:underline"
        >
          {t('products.datasheetHub.pulse.viewLogs')}
        </Link>
      </div>
    </div>
  )
}

interface SignalChipProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  tone: 'green' | 'amber' | 'red' | 'grey' | 'neutral'
}

function SignalChip({ icon: Icon, label, tone }: SignalChipProps) {
  const toneClass =
    tone === 'green'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'red'
          ? 'text-red-700 dark:text-red-300'
          : tone === 'grey'
            ? 'text-slate-500 dark:text-slate-400'
            : 'text-slate-700 dark:text-slate-200'
  return (
    <span className={`inline-flex items-center gap-1.5 ${toneClass}`}>
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </span>
  )
}

function Sep() {
  return (
    <span
      aria-hidden
      className="h-3 w-px bg-slate-300 dark:bg-slate-700 flex-shrink-0"
    />
  )
}
