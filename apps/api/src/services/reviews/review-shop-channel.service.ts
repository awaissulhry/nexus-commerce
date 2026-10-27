/**
 * Reviews › Etsy and Shopify pages (2026-10-27, build spec §3.5 / B21, PR I) —
 * GET /api/reviews/area/shop-channel?channel=ETSY|SHOPIFY (routes/review-shop-channels.routes.ts), in sections that
 * fail ALONE (`{ ok: true, data } | { ok: false, error }`, the Overview's envelope).
 *
 *   ETSY     source (is Etsy read, in words) · tiles (average, new, with a photo, not replied yet, window closing,
 *            window closed) · reviews (the Inbox's Etsy rows + the photo, the buyer's last edit and the reply window)
 *   SHOPIFY  app (the review apps' states: Judge.me connects, the others later) · tiles (average, new, with photo or
 *            video, needs a reply) · reviews (the Inbox's Shopify rows + photos, video and the app they came from)
 *
 * The lists are the Inbox's own rows (`listInbox`), so a row opens the same review pop-up. Every Review read goes
 * through `visibleReviewWhere` (fixtures never count); the arithmetic is pure, in review-shop-channel-math.ts.
 */
import { reviewAppOf } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { listInbox, type InboxRow } from './review-inbox.service.js'
import { isImportedSource, visibleReviewWhere } from './review-visibility.js'
import { listReviewApps, type ReviewAppView } from './review-app-connection.service.js'
import {
  etsyTiles, etsyWindow, shopifyTiles, storedMediaOf,
  type EtsySource, type EtsyTiles, type ShopifyTiles, type TileFacts, type WindowView,
} from './review-shop-channel-math.js'

export class ShopChannelInputError extends Error {}

export type Section<T> = { ok: true; data: T } | { ok: false; error: string }

export interface EtsyRow extends InboxRow {
  photoUrl: string | null
  /** The buyer's last edit (ISO): the reply window counts from it. */
  editedAt: string | null
  window: WindowView | null
}

export interface ShopifyRow extends InboxRow {
  /** The review's photos (its stored media) with their thumbnails; the Inbox row's `photos` is their count. */
  photoItems: Array<{ url: string; thumb: string }>
  hasVideo: boolean
  /** The review app it was read from (JUDGEME), or null for a file import. */
  app: string | null
}

export interface ReviewList<R> { rows: R[]; total: number; owners: string[] }

export interface EtsySections {
  source: Section<EtsySource>
  tiles: Section<EtsyTiles>
  reviews: Section<ReviewList<EtsyRow>>
}

export interface ShopifyApps {
  apps: ReviewAppView[]
  readOn: boolean
  /** The newest file import of Shopify reviews, and how many reviews came from files. */
  lastImportAt: string | null
  imported: number
}

export interface ShopifySections {
  app: Section<ShopifyApps>
  tiles: Section<ShopifyTiles>
  reviews: Section<ReviewList<ShopifyRow>>
}

export interface ShopChannelPage {
  channel: 'ETSY' | 'SHOPIFY'
  label: string
  generatedAt: string
  sections: EtsySections | ShopifySections
}

const SECTION_ERROR: Record<string, string> = {
  source: 'Nexus could not check whether Etsy is read.',
  app: 'The review app’s state could not be read.',
  tiles: 'The numbers at the top could not be read.',
  reviews: 'The reviews could not be read.',
}

async function section<T>(name: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() }
  } catch (err) {
    logger.warn('[reviews-shop-channel] section failed', { section: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: `${SECTION_ERROR[name] ?? 'This part could not be read.'} Try again in a moment.` }
  }
}

/** The facts behind the tiles for one channel's visible reviews. */
async function tileFacts(channel: 'ETSY' | 'SHOPIFY'): Promise<TileFacts[]> {
  const rows = await prisma.review.findMany({
    where: visibleReviewWhere({ channel }),
    select: {
      id: true, rating: true, postedAt: true, channelEditedAt: true, triageStatus: true, rawPayload: true, ingestSource: true,
      _count: { select: { media: true } },
    },
    take: 50_000,
  })
  const sent = rows.length
    ? await prisma.reviewResponse.groupBy({ by: ['reviewId'], where: { reviewId: { in: rows.map((r) => r.id) }, status: 'SENT' }, _count: { _all: true } })
    : []
  const sentBy = new Map(sent.map((g) => [g.reviewId, g._count._all]))
  return rows.map((r) => ({
    rating: r.rating,
    postedAt: r.postedAt,
    editedAt: r.channelEditedAt,
    status: r.triageStatus,
    sentReplies: sentBy.get(r.id) ?? 0,
    // The photos are the review's stored media (ReviewMedia); a Judge.me video is a mark in rawPayload.
    hasPhoto: r._count.media > 0,
    hasVideo: channel === 'SHOPIFY' && storedMediaOf([], r.rawPayload).hasVideo,
    imported: isImportedSource(r.ingestSource),
  }))
}

/** The Inbox's rows for the channel (newest 200) with what this page adds from the stored review. */
async function listOf(channel: 'ETSY' | 'SHOPIFY', now: Date) {
  const page = await listInbox({ channel, page: 1, pageSize: 200 }, now)
  const extra = page.rows.length
    ? await prisma.review.findMany({
        where: { id: { in: page.rows.map((r) => r.id) } },
        select: {
          id: true, channelEditedAt: true, rawPayload: true, ingestSource: true,
          media: { select: { url: true, type: true, position: true }, orderBy: { position: 'asc' } },
        },
      })
    : []
  return { page, extra: new Map(extra.map((e) => [e.id, e])) }
}

async function etsySections(now: Date): Promise<EtsySections> {
  const [source, tiles, reviews] = await Promise.all([
    section('source', async () => {
      const { readEtsySource } = await import('./review-settings-health.js')
      return readEtsySource()
    }),
    section('tiles', async () => etsyTiles(await tileFacts('ETSY'), now)),
    section('reviews', async (): Promise<ReviewList<EtsyRow>> => {
      const { page, extra } = await listOf('ETSY', now)
      return {
        total: page.total,
        owners: page.facets.owners,
        rows: page.rows.map((row) => {
          const more = extra.get(row.id)
          const editedAt = more?.channelEditedAt ?? null
          const photoUrl = storedMediaOf(more?.media, null).photos[0]?.url ?? null
          return { ...row, photoUrl, editedAt: editedAt?.toISOString() ?? null, window: etsyWindow({ postedAt: row.postedAt, editedAt }, now) }
        }),
      }
    }),
  ])
  return { source, tiles, reviews }
}

async function shopifySections(now: Date): Promise<ShopifySections> {
  const [app, tiles, reviews] = await Promise.all([
    section('app', async (): Promise<ShopifyApps> => {
      const [apps, imports] = await Promise.all([
        listReviewApps(now),
        prisma.review.aggregate({ where: visibleReviewWhere({ channel: 'SHOPIFY', ingestSource: { startsWith: 'IMPORT' } }), _count: { _all: true }, _max: { ingestedAt: true } }),
      ])
      return { ...apps, imported: imports._count._all, lastImportAt: imports._max.ingestedAt?.toISOString() ?? null }
    }),
    section('tiles', async () => shopifyTiles(await tileFacts('SHOPIFY'), now)),
    section('reviews', async (): Promise<ReviewList<ShopifyRow>> => {
      const { page, extra } = await listOf('SHOPIFY', now)
      return {
        total: page.total,
        owners: page.facets.owners,
        rows: page.rows.map((row) => {
          const more = extra.get(row.id)
          const media = storedMediaOf(more?.media, more?.rawPayload)
          return { ...row, photoItems: media.photos, hasVideo: media.hasVideo, app: reviewAppOf(more?.ingestSource) }
        }),
      }
    }),
  ])
  return { app, tiles, reviews }
}

/** GET /api/reviews/area/shop-channel. */
export async function reviewsShopChannel(input: { channel?: unknown; now?: Date }): Promise<ShopChannelPage> {
  const channel = typeof input.channel === 'string' ? input.channel.trim().toUpperCase() : ''
  if (channel !== 'ETSY' && channel !== 'SHOPIFY') throw new ShopChannelInputError('This page is for Etsy or Shopify.')
  const now = input.now ?? new Date()
  return {
    channel,
    label: channel === 'ETSY' ? 'Etsy' : 'Shopify',
    generatedAt: now.toISOString(),
    sections: channel === 'ETSY' ? await etsySections(now) : await shopifySections(now),
  }
}
