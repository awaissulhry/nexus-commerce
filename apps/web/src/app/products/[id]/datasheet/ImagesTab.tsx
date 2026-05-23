/**
 * ATM.11 — Images × channel × variant matrix.
 *
 * The IM-series ships a full per-channel image editor at
 * /products/[id]/edit?tab=images — that's the WRITE surface. ATM.11
 * is the READ-side audit complement: where the operator sees, in
 * one screen, what's published on each channel, where drift exists,
 * and what's still in draft.
 *
 * Two sections:
 *
 *   1. Master gallery summary  master ProductImage[] count + first
 *                              hero thumb; the SSOT row.
 *
 *   2. Per-channel scorecard   one card per active (channel,
 *                              marketplace) showing image counts
 *                              broken down by publishStatus:
 *                                PUBLISHED  green  live on channel
 *                                DRAFT      slate  staged, not pushed
 *                                OUTDATED   amber  master changed since
 *                                ERROR      red    publish failed
 *                              Plus a hero strip — first 4 ListingImage
 *                              rows by position, with the publish-
 *                              status pip overlaid (matches the VR.8
 *                              cell-pip pattern).
 *
 * Drift count rolls up to a top summary line; an amber chip beside
 * the channel name flags channels with any OUTDATED images.
 *
 * Edit affordances live on /products/[id]/edit?tab=images — footer
 * links there. Inline image upload / re-publish is out of scope for
 * the hub view.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Edit3,
  ImageOff,
  XCircle,
} from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

interface ImagesTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

interface ChannelImageSummary {
  key: string
  channel: string
  marketplace: string
  label: string
  total: number
  byStatus: {
    PUBLISHED: number
    DRAFT: number
    OUTDATED: number
    ERROR: number
  }
  heroes: Array<{
    url: string
    publishStatus: string
    amazonSlot: string | null
  }>
  lastPublishedAt: Date | null
}

export default async function ImagesTab({
  productId,
  locale,
  t,
}: ImagesTabProps) {
  const [masterImages, listingImages, listings] = await Promise.all([
    // Master gallery — first 8 by sortOrder for the hero preview.
    prisma.productImage
      .findMany({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 8,
        select: {
          id: true,
          url: true,
          alt: true,
          type: true,
          sortOrder: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.11] master images fetch failed', e)
        return [] as never[]
      }),
    // All channel-side ListingImage rows for the product.
    prisma.listingImage
      .findMany({
        where: { productId },
        orderBy: [
          { platform: 'asc' },
          { marketplace: 'asc' },
          { position: 'asc' },
        ],
        select: {
          id: true,
          platform: true,
          marketplace: true,
          url: true,
          position: true,
          publishStatus: true,
          publishedAt: true,
          amazonSlot: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.11] listing images fetch failed', e)
        return [] as never[]
      }),
    // Active channel listings drive the card list; we render a card
    // even when there are zero ListingImage rows yet, so the operator
    // sees the gap.
    prisma.channelListing
      .findMany({
        where: { productId, isPublished: true, listingStatus: 'ACTIVE' },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        select: {
          channel: true,
          marketplace: true,
        },
        distinct: ['channel', 'marketplace'],
      })
      .catch((e: unknown) => {
        console.error('[atm.11] channel listings fetch failed', e)
        return [] as never[]
      }),
  ])

  // Aggregate ListingImage rows by (platform, marketplace).
  const byKey = new Map<string, ChannelImageSummary>()
  const ensure = (
    platform: string,
    marketplace: string | null,
  ): ChannelImageSummary => {
    const key = `${platform}|${marketplace ?? ''}`
    let s = byKey.get(key)
    if (!s) {
      s = {
        key,
        channel: platform,
        marketplace: marketplace ?? '',
        label: prettyChannelMarketplace(platform, marketplace ?? ''),
        total: 0,
        byStatus: { PUBLISHED: 0, DRAFT: 0, OUTDATED: 0, ERROR: 0 },
        heroes: [],
        lastPublishedAt: null,
      }
      byKey.set(key, s)
    }
    return s
  }

  for (const img of listingImages) {
    const s = ensure(img.platform ?? 'UNKNOWN', img.marketplace)
    s.total++
    const status = img.publishStatus as
      | 'PUBLISHED'
      | 'DRAFT'
      | 'OUTDATED'
      | 'ERROR'
    if (status in s.byStatus) {
      s.byStatus[status]++
    }
    if (s.heroes.length < 4) {
      s.heroes.push({
        url: img.url,
        publishStatus: img.publishStatus,
        amazonSlot: img.amazonSlot,
      })
    }
    if (img.publishedAt) {
      if (
        s.lastPublishedAt == null ||
        img.publishedAt.getTime() > s.lastPublishedAt.getTime()
      ) {
        s.lastPublishedAt = img.publishedAt
      }
    }
  }

  // Add empty summaries for active channel-marketplaces with no
  // ListingImage rows yet — surface the gap explicitly.
  for (const l of listings) {
    ensure(l.channel, l.marketplace)
  }

  const summaries = [...byKey.values()].sort((a, b) =>
    a.label.localeCompare(b.label),
  )

  // Roll-up summary line.
  let totalPublished = 0
  let totalDraft = 0
  let totalDrifted = 0
  let totalErrored = 0
  for (const s of summaries) {
    totalPublished += s.byStatus.PUBLISHED
    totalDraft += s.byStatus.DRAFT
    totalDrifted += s.byStatus.OUTDATED
    totalErrored += s.byStatus.ERROR
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relAge = (d: Date | null) => {
    if (!d) return null
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    return rtf.format(Math.round(diffSec / 86400), 'day')
  }

  return (
    <div className="space-y-4">
      {/* Summary line + edit link */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap text-xs text-slate-500 dark:text-slate-400">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.images.title', {
            count: summaries.length,
          })}
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            {t('products.datasheetHub.images.summary.published', {
              count: totalPublished,
            })}
          </span>
          {totalDraft > 0 && (
            <span className="text-slate-600 dark:text-slate-300">
              {t('products.datasheetHub.images.summary.draft', {
                count: totalDraft,
              })}
            </span>
          )}
          {totalDrifted > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.images.summary.drifted', {
                count: totalDrifted,
              })}
            </span>
          )}
          {totalErrored > 0 && (
            <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
              <XCircle className="w-3 h-3" />
              {t('products.datasheetHub.images.summary.error', {
                count: totalErrored,
              })}
            </span>
          )}
        </div>
      </div>

      {/* Master gallery row */}
      <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {t('products.datasheetHub.images.master.title')}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {t('products.datasheetHub.images.master.count', {
              count: masterImages.length,
            })}
          </div>
        </div>
        {masterImages.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto">
            {masterImages.map((img, i) => (
              <div
                key={img.id}
                className={
                  'flex-shrink-0 w-14 h-14 rounded border overflow-hidden bg-slate-50 dark:bg-slate-800 ' +
                  (i === 0
                    ? 'border-blue-300 dark:border-blue-700'
                    : 'border-slate-200 dark:border-slate-700')
                }
                title={`${img.type} · ${img.alt ?? ''}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.alt ?? ''}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-400 italic flex items-center gap-1.5">
            <ImageOff className="w-3 h-3" />
            {t('products.datasheetHub.images.master.empty')}
          </div>
        )}
      </div>

      {/* Per-channel cards */}
      {summaries.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
          {t('products.datasheetHub.images.noChannels')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {summaries.map((s) => {
            const masterCount = masterImages.length
            const drifted = s.byStatus.OUTDATED
            const errored = s.byStatus.ERROR
            const overallTone =
              errored > 0
                ? 'border-red-200 dark:border-red-900'
                : drifted > 0
                  ? 'border-amber-200 dark:border-amber-900'
                  : 'border-slate-200 dark:border-slate-800'
            return (
              <div
                key={s.key}
                className={`border rounded bg-white dark:bg-slate-900 p-3 space-y-2 ${overallTone}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                    {s.label}
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    {s.total} / {masterCount}
                  </div>
                </div>

                {s.total === 0 ? (
                  <div className="text-xs text-amber-700 dark:text-amber-400 italic">
                    {t('products.datasheetHub.images.card.notPushed')}
                  </div>
                ) : (
                  <>
                    {/* Status breakdown chips */}
                    <div className="flex flex-wrap gap-1 text-[10px]">
                      {s.byStatus.PUBLISHED > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="w-3 h-3" />
                          {s.byStatus.PUBLISHED}
                        </span>
                      )}
                      {s.byStatus.DRAFT > 0 && (
                        <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          DRAFT {s.byStatus.DRAFT}
                        </span>
                      )}
                      {s.byStatus.OUTDATED > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="w-3 h-3" />
                          {s.byStatus.OUTDATED}
                        </span>
                      )}
                      {s.byStatus.ERROR > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300">
                          <XCircle className="w-3 h-3" />
                          {s.byStatus.ERROR}
                        </span>
                      )}
                    </div>

                    {/* Hero strip */}
                    <div className="flex gap-1">
                      {s.heroes.map((h, i) => (
                        <div
                          key={i}
                          className="relative flex-shrink-0 w-10 h-10 rounded border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800"
                          title={`${h.amazonSlot ?? ''} · ${h.publishStatus}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={h.url}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                          <span
                            className={
                              'absolute bottom-0 right-0 w-2 h-2 rounded-full ring-1 ring-white dark:ring-slate-900 ' +
                              (h.publishStatus === 'PUBLISHED'
                                ? 'bg-emerald-500'
                                : h.publishStatus === 'OUTDATED'
                                  ? 'bg-amber-500'
                                  : h.publishStatus === 'ERROR'
                                    ? 'bg-red-500'
                                    : 'bg-slate-400')
                            }
                            aria-hidden
                          />
                          {h.amazonSlot && (
                            <span className="absolute top-0 left-0 text-[8px] font-mono bg-black/40 text-white px-0.5 leading-none rounded-br">
                              {h.amazonSlot}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Last published footer */}
                    {s.lastPublishedAt && (
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-1.5">
                        {t('products.datasheetHub.images.card.lastPublish', {
                          ago: relAge(s.lastPublishedAt) ?? '—',
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <div className="italic">
          {t('products.datasheetHub.images.editNote')}
        </div>
        <Link
          href={`/products/${productId}/edit?tab=images`}
          className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:underline"
        >
          <Edit3 className="w-3 h-3" />
          {t('products.datasheetHub.images.openEditor')}
        </Link>
      </div>
    </div>
  )
}
