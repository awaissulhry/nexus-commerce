/**
 * ATM.5 — Channel readiness scorecard.
 *
 * One card per active ChannelListing on this product. Each card
 * surfaces the four trust signals the operator needs before they
 * trust a channel to sell:
 *
 *   1. Listing status        ACTIVE / DRAFT / INACTIVE / ERROR /
 *                            ENDED chip
 *   2. Validation status     ChannelListing.validationStatus +
 *                            validationErrors[] count
 *   3. Quality score         latest ListingQualitySnapshot
 *                            overallScore + per-dimension breakdown
 *                            (title / bullets / keywords / images /
 *                            pricing). Null when no snapshot yet.
 *   4. Reviews               aggregate rating + count from Review
 *                            rows scoped to (channel, marketplace).
 *
 * Plus operational data: last-sync relative timestamp, "open live
 * listing" link, sync-from-master / sync-locked flags.
 *
 * Field-level "required filled %" lands with ATM.6 (validation
 * engine). Today the validation chip just surfaces what the
 * ChannelListing row already carries — the validation engine will
 * write structured per-field results that the card displays.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Star,
  XCircle,
} from 'lucide-react'
import {
  amazonTld,
  prettyChannelMarketplace,
} from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'
import {
  validateListing,
  type ListingForValidation,
  type MasterForValidation,
  type ValidationIssue,
} from './validationRules'

interface ChannelsTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default async function ChannelsTab({
  productId,
  locale,
  t,
}: ChannelsTabProps) {
  const [master, listings, snapshots, reviewStats] = await Promise.all([
    // ATM.6 — master fields the validation engine needs.
    prisma.product
      .findUnique({
        where: { id: productId },
        select: {
          name: true,
          description: true,
          bulletPoints: true,
          basePrice: true,
          totalStock: true,
          gtin: true,
          upc: true,
          ean: true,
          _count: { select: { images: true } },
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.6] master fetch for validation failed', e)
        return null
      }),
    prisma.channelListing
      .findMany({
        where: { productId },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        select: {
          id: true,
          channel: true,
          marketplace: true,
          externalListingId: true,
          listingStatus: true,
          isPublished: true,
          offerActive: true,
          syncFromMaster: true,
          syncLocked: true,
          validationStatus: true,
          validationErrors: true,
          lastSyncedAt: true,
          lastSyncStatus: true,
          lastSyncError: true,
          // ATM.6 — effective-value resolution inputs.
          title: true,
          titleOverride: true,
          followMasterTitle: true,
          description: true,
          descriptionOverride: true,
          followMasterDescription: true,
          price: true,
          priceOverride: true,
          followMasterPrice: true,
          quantity: true,
          quantityOverride: true,
          followMasterQuantity: true,
          bulletPointsOverride: true,
          followMasterBulletPoints: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.5] channelListings fetch failed', e)
        // Type-only fallback — never mutated, just satisfies the
        // tuple inference for the downstream Promise.all destruct.
        return [] as never[]
      }),
    prisma.listingQualitySnapshot
      .findMany({
        where: { productId },
        orderBy: { createdAt: 'desc' },
        select: {
          channel: true,
          marketplace: true,
          overallScore: true,
          dimensions: true,
          createdAt: true,
        },
        take: 200, // bounded; we collapse to latest-per-(channel,marketplace)
      })
      .catch((e: unknown) => {
        console.error('[atm.5] qualitySnapshots fetch failed', e)
        return [] as Array<{
          channel: string
          marketplace: string | null
          overallScore: number
          dimensions: unknown
          createdAt: Date
        }>
      }),
    prisma.review
      .groupBy({
        by: ['channel', 'marketplace'],
        where: { productId, rating: { not: null } },
        _avg: { rating: true },
        _count: { _all: true },
      })
      .catch((e: unknown) => {
        console.error('[atm.5] review aggregate failed', e)
        return [] as Array<{
          channel: string
          marketplace: string | null
          _avg: { rating: number | null }
          _count: { _all: number }
        }>
      }),
  ])

  if (listings.length === 0) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
        <div className="font-medium text-slate-700 dark:text-slate-300">
          {t('products.datasheetHub.channels.empty.title')}
        </div>
        <p className="text-xs mt-1">
          {t('products.datasheetHub.channels.empty.body')}
        </p>
      </div>
    )
  }

  // Reduce to latest snapshot per (channel, marketplace) — input is
  // ordered DESC so the first encounter is the latest.
  const latestSnapByKey = new Map<
    string,
    {
      overallScore: number
      dimensions: Record<string, number>
      createdAt: Date
    }
  >()
  for (const s of snapshots) {
    const k = `${s.channel}|${s.marketplace ?? ''}`
    if (!latestSnapByKey.has(k)) {
      const dims = (s.dimensions ?? {}) as Record<string, unknown>
      const normalised: Record<string, number> = {}
      for (const [key, val] of Object.entries(dims)) {
        if (typeof val === 'number') normalised[key] = val
      }
      latestSnapByKey.set(k, {
        overallScore: s.overallScore,
        dimensions: normalised,
        createdAt: s.createdAt,
      })
    }
  }

  // Reviews by (channel, marketplace).
  const reviewsByKey = new Map<
    string,
    { avg: number | null; count: number }
  >()
  for (const r of reviewStats) {
    const k = `${r.channel}|${r.marketplace ?? ''}`
    reviewsByKey.set(k, {
      avg: r._avg.rating,
      count: r._count._all,
    })
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relSync = (d: Date | null) => {
    if (!d) return null
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), 'day')
    return rtf.format(Math.round(diffSec / (86400 * 30)), 'month')
  }
  const fmtRating = (v: number | null) =>
    v == null
      ? null
      : new Intl.NumberFormat(numLocale, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(v)

  // ATM.6 — Compute per-listing validation issues once. The master
  // shape adapts the Product query result into the pure rule
  // module's MasterForValidation. Cached in a Map by listing id so
  // both the summary tally and per-card render hit the same data.
  const masterForVal: MasterForValidation | null = master
    ? {
        name: master.name,
        description: master.description,
        bulletPoints: master.bulletPoints as string[] | null,
        basePrice:
          master.basePrice == null ? null : Number(master.basePrice),
        totalStock: master.totalStock,
        gtin: master.gtin,
        upc: master.upc,
        ean: master.ean,
        hasAnyImage: master._count.images > 0,
      }
    : null
  const issuesByListing = new Map<string, ValidationIssue[]>()
  if (masterForVal != null) {
    for (const l of listings) {
      const listingShape: ListingForValidation = {
        channel: l.channel,
        marketplace: l.marketplace,
        title: l.title,
        titleOverride: l.titleOverride,
        followMasterTitle: l.followMasterTitle,
        description: l.description,
        descriptionOverride: l.descriptionOverride,
        followMasterDescription: l.followMasterDescription,
        price: l.price == null ? null : Number(l.price),
        priceOverride:
          l.priceOverride == null ? null : Number(l.priceOverride),
        followMasterPrice: l.followMasterPrice,
        quantity: l.quantity,
        quantityOverride: l.quantityOverride,
        followMasterQuantity: l.followMasterQuantity,
        bulletPointsOverride: l.bulletPointsOverride,
        followMasterBulletPoints: l.followMasterBulletPoints,
      }
      issuesByListing.set(l.id, validateListing(masterForVal, listingShape))
    }
  }

  // Roll-up summary line: live count, avg quality, warnings,
  // errors. Operator scans this first.
  let liveCount = 0
  let validationWarn = 0
  let validationError = 0
  let qualitySum = 0
  let qualityN = 0
  for (const l of listings) {
    if (l.isPublished && l.listingStatus === 'ACTIVE') liveCount++
    // ATM.6 — Prefer the live ruleset count over the persisted
    // ChannelListing.validationStatus, since the rules are the
    // source of truth. The stored status updates lazily (on next
    // publish attempt) so it can lag.
    const computed = issuesByListing.get(l.id) ?? []
    const errs = computed.filter((i) => i.severity === 'error').length
    const warns = computed.filter((i) => i.severity === 'warn').length
    if (errs > 0) validationError++
    else if (warns > 0) validationWarn++
    const snap = latestSnapByKey.get(`${l.channel}|${l.marketplace}`)
    if (snap) {
      qualitySum += snap.overallScore
      qualityN++
    }
  }
  const qualityAvg = qualityN > 0 ? Math.round(qualitySum / qualityN) : null

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap text-xs text-slate-500 dark:text-slate-400">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.channels.title', {
            count: listings.length,
          })}
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            {t('products.datasheetHub.channels.summary.live', {
              count: liveCount,
            })}
          </span>
          {qualityAvg != null && (
            <span>
              {t('products.datasheetHub.channels.summary.quality', {
                avg: qualityAvg,
              })}
            </span>
          )}
          {validationWarn > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.channels.summary.warn', {
                count: validationWarn,
              })}
            </span>
          )}
          {validationError > 0 && (
            <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
              <XCircle className="w-3 h-3" />
              {t('products.datasheetHub.channels.summary.error', {
                count: validationError,
              })}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {listings.map((l) => {
          const label = prettyChannelMarketplace(l.channel, l.marketplace)
          const snap = latestSnapByKey.get(`${l.channel}|${l.marketplace}`)
          const reviews = reviewsByKey.get(`${l.channel}|${l.marketplace}`)
          const liveUrl =
            l.externalListingId && l.channel === 'AMAZON'
              ? `https://www.amazon.${amazonTld(l.marketplace)}/dp/${l.externalListingId}`
              : l.externalListingId && l.channel === 'EBAY'
                ? `https://www.ebay.com/itm/${l.externalListingId}`
                : null
          return (
            <ChannelCard
              key={l.id}
              label={label}
              listing={l}
              liveUrl={liveUrl}
              snapshot={snap}
              reviews={reviews}
              issues={issuesByListing.get(l.id) ?? []}
              relSync={relSync}
              fmtRating={fmtRating}
              t={t}
            />
          )
        })}
      </div>
    </div>
  )
}

interface ChannelCardProps {
  label: string
  listing: {
    id: string
    channel: string
    marketplace: string
    externalListingId: string | null
    listingStatus: string
    isPublished: boolean
    offerActive: boolean
    syncFromMaster: boolean
    syncLocked: boolean
    validationStatus: string
    validationErrors: string[]
    lastSyncedAt: Date | null
    lastSyncStatus: string | null
    lastSyncError: string | null
  }
  liveUrl: string | null
  snapshot:
    | {
        overallScore: number
        dimensions: Record<string, number>
        createdAt: Date
      }
    | undefined
  reviews: { avg: number | null; count: number } | undefined
  /** ATM.6 — Live-computed issues from the validation engine.
   *  Replaces the persisted ChannelListing.validationStatus for
   *  the per-card UI (the engine is the source of truth). */
  issues: ValidationIssue[]
  relSync: (d: Date | null) => string | null
  fmtRating: (v: number | null) => string | null
  t: Awaited<ReturnType<typeof getServerT>>
}

function ChannelCard({
  label,
  listing,
  liveUrl,
  snapshot,
  reviews,
  issues,
  relSync,
  fmtRating,
  t,
}: ChannelCardProps) {
  const isLive = listing.isPublished && listing.listingStatus === 'ACTIVE'
  const statusTone = isLive
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
    : listing.listingStatus === 'ERROR' || !listing.isPublished
      ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
      : 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'

  // ATM.6 — Derive validation tone from the live-computed issues
  // rather than the persisted ChannelListing.validationStatus.
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warnCount = issues.filter((i) => i.severity === 'warn').length
  const validationLevel: 'error' | 'warn' | 'valid' =
    errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'valid'
  const validationTone =
    validationLevel === 'error'
      ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
      : validationLevel === 'warn'
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'

  // Quality score band — green ≥ 80, amber ≥ 50, red below.
  const qScore = snapshot?.overallScore
  const qTone =
    qScore == null
      ? 'text-slate-400'
      : qScore >= 80
        ? 'text-emerald-700 dark:text-emerald-400'
        : qScore >= 50
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-red-700 dark:text-red-400'

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 p-3 space-y-2">
      {/* Header — channel label + status + live link */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
            {label}
          </div>
          {listing.externalListingId && (
            <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate">
              {listing.externalListingId}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${statusTone}`}
          >
            {isLive ? 'LIVE' : listing.listingStatus}
          </span>
          {liveUrl && (
            <Link
              href={liveUrl}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              title={t('products.datasheetHub.expansion.openLive')}
              aria-label={t('products.datasheetHub.expansion.openLive')}
            >
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </div>
      </div>

      {/* Quality score + reviews row */}
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 dark:text-slate-400">
            {t('products.datasheetHub.channels.quality')}
          </span>
          {qScore != null ? (
            <span className={`font-mono tabular-nums font-semibold ${qTone}`}>
              {qScore}
            </span>
          ) : (
            <span
              className="text-slate-400 italic"
              title={t('products.datasheetHub.channels.qualityNoSnapshot')}
            >
              {t('products.datasheetHub.channels.qualityNone')}
            </span>
          )}
        </div>
        {reviews && reviews.count > 0 && reviews.avg != null && (
          <div className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-200">
            <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
            <span className="font-medium tabular-nums">
              {fmtRating(reviews.avg)}
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              ({reviews.count})
            </span>
          </div>
        )}
      </div>

      {/* Quality dimensions sparkline */}
      {snapshot && Object.keys(snapshot.dimensions).length > 0 && (
        <div className="flex flex-wrap gap-1 text-[10px]">
          {Object.entries(snapshot.dimensions).map(([dim, score]) => {
            const t1 =
              score >= 80
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : score >= 50
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
            return (
              <span
                key={dim}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${t1}`}
                title={t('products.datasheetHub.channels.dimensionScore', {
                  dim,
                  score,
                })}
              >
                <span className="capitalize">{dim}</span>
                <span className="font-mono tabular-nums">{score}</span>
              </span>
            )
          })}
        </div>
      )}

      {/* Validation + sync flags */}
      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold ${validationTone}`}
        >
          {validationLevel === 'error' && <XCircle className="w-3 h-3" />}
          {validationLevel === 'warn' && (
            <AlertTriangle className="w-3 h-3" />
          )}
          {validationLevel === 'valid' && (
            <CheckCircle2 className="w-3 h-3" />
          )}
          <span>
            {validationLevel === 'valid'
              ? t('products.datasheetHub.channels.validation.valid')
              : validationLevel === 'warn'
                ? t('products.datasheetHub.channels.validation.warn', {
                    count: warnCount,
                  })
                : t('products.datasheetHub.channels.validation.error', {
                    count: errorCount,
                  })}
          </span>
        </span>
        {!listing.offerActive && (
          <span
            className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
            title={t('products.datasheetHub.channels.offerInactiveTip')}
          >
            {t('products.datasheetHub.channels.offerInactive')}
          </span>
        )}
        {listing.syncLocked && (
          <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            {t('products.datasheetHub.channels.syncLocked')}
          </span>
        )}
        {!listing.syncFromMaster && (
          <span
            className="inline-block px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            title={t('products.datasheetHub.channels.overridesTip')}
          >
            {t('products.datasheetHub.channels.overrides')}
          </span>
        )}
      </div>

      {/* ATM.6 — Inline issue list. Collapsed by default to keep
          the card compact; expanded via native <details> so no
          client runtime is needed. Errors render before warnings. */}
      {issues.length > 0 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 select-none">
            {t('products.datasheetHub.channels.issues.toggle', {
              count: issues.length,
            })}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {issues.map((iss) => (
              <li
                key={iss.ruleId}
                className={
                  iss.severity === 'error'
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-amber-700 dark:text-amber-400'
                }
              >
                <span
                  className="inline-block w-3 text-center"
                  aria-hidden
                >
                  {iss.severity === 'error' ? '✗' : '⚠'}
                </span>{' '}
                <span>{t(iss.messageKey)}</span>
                {iss.detail && (
                  <span className="text-slate-500 dark:text-slate-400 ml-1">
                    ({iss.detail})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Last-sync footer */}
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-1.5">
        <Clock className="w-3 h-3" />
        <span>
          {listing.lastSyncedAt
            ? t('products.datasheetHub.channels.lastSync', {
                ago: relSync(listing.lastSyncedAt) ?? '—',
              })
            : t('products.datasheetHub.channels.neverSynced')}
        </span>
        {listing.lastSyncStatus === 'FAILED' && (
          <span
            className="text-red-600 dark:text-red-400 truncate"
            title={listing.lastSyncError ?? undefined}
          >
            · {listing.lastSyncError ?? t('products.datasheetHub.channels.syncFailed')}
          </span>
        )}
      </div>
    </div>
  )
}
