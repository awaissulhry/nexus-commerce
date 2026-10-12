/**
 * Bid page (KAPI-S, 2026-10-10) — what became of each bid's newest change, and the page's live cursor.
 *
 *   BidRow.delivery            the newest bid write to the target, whatever became of it (bid-rows.service.ts)
 *   GET /advertising/bids/cursor  { latestChangeAt, waiting, sent } for the scope of GET /advertising/bids
 *
 * The words mean what the page's own helper says (apps/web/…/rules-automation/bid/_shared/delivery.ts changeStateOf):
 *   waiting    queued, not sent yet           AdMutation PENDING · action log PENDING
 *   sent       on its way to Amazon            AdMutation IN_FLIGHT
 *   live       Amazon has it                   AdMutation APPLIED · action log SUCCESS
 *   failed     Amazon or the gate refused it   AdMutation FAILED · action log FAILED / REFUSED
 *   cancelled  stopped before it was sent      AdMutation CANCELLED · action log CANCELLED / SKIPPED
 *   replaced   a newer change took its place   AdMutation SUPERSEDED · action log SUPERSEDED
 *   undone     put back since                  the action log row's rolledBackAt
 * The newest change is the newer of the target's newest bid AdMutation (a queued write: its state moves Waiting → Sent →
 * Live) and its newest bid action-log row (every writer logs one; an inline write has no AdMutation). When both are the
 * same change (one outbound queue row, or a few seconds apart) the AdMutation says the state and the log says undone. It
 * can be newer than BidRow.lastChange, which counts only writes that reached Amazon or may still: a failed newest write
 * reads Failed here while lastChange keeps the one before. An action-log row alone left PENDING for over a day with no
 * write behind it reads null (no record), not Waiting: a queued write is sent within minutes and dead-letters after a day,
 * and an eternal Waiting would keep the page polling every 5 s.
 *
 * The cursor: the newest moment any bid change in scope moved (an AdMutation's updatedAt — each state change bumps it —
 * an action-log row written, a change undone), and how many bids in scope have their newest change Waiting or Sent — the
 * same per-bid reading as the rows, so the page's "poll every 5 s while any row is Waiting / Sent" agrees with the rows it
 * shows. Scope = GET /advertising/bids's (market, portfolio, product, campaign, ad group — each a list too —, status;
 * another business's id is a 404: bidScopeWhere, the one where of both reads);
 * `owner` does not narrow it (the owner is worked out per row, which the cursor does not do), so it covers every bid of
 * the scope and moves whenever a row the page shows can. Reads: the scope's target ids, then two indexed reads
 * (AdMutation by entityType+entityId; AdvertisingActionLog by entityType+entityId+createdAt) over 30 days.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { mergeIds, type ScopeIdLists } from './ads-scope-lists.js'
import { expandProductScope, unknownScopeId } from './ads-scope-reach.js'

export const BID_DELIVERY_STATES = ['waiting', 'sent', 'live', 'failed', 'cancelled', 'replaced', 'undone'] as const
export type BidDelivery = (typeof BID_DELIVERY_STATES)[number]

/** The action-log types of a target's bid change (bid-rows.service.ts BID_CHANGE_TYPES, brain/read-map.ts 'bids'). */
const BID_CHANGE_TYPES = ['AD_BID_UPDATE', 'bid_set_by_engine', 'bid_down', 'bid_up']
const DAY = 86_400_000
/** How far back a change counts (bid-rows.service.ts CHANGES_DAYS: the last change is read over the same 30 days). */
const DELIVERY_DAYS = 30
/** An AdMutation and an action-log row this close in time, with no queue row to pair them, are one change. */
const SAME_CHANGE_MS = 5_000
/** An action-log row alone, PENDING for longer than this, is no record (see the header). */
const STALE_LOG_PENDING_MS = DAY
/** GET /advertising/bids reads at most this many bids (bid-rows.service.ts HARD_CAP); the cursor the same ones. */
const HARD_CAP = 5000

export interface MutationFact { state: string; createdAt: Date; updatedAt: Date; outboundQueueId: string | null }
export interface LogFact { status: string | null; rolledBackAt: Date | null; createdAt: Date; outboundQueueId: string | null }

/** An AdMutation state as the page's word (delivery.ts: an unknown state reads Waiting, as there). */
export function mutationDelivery(state: string | null | undefined): BidDelivery | null {
  const s = state?.trim().toUpperCase()
  if (!s) return null
  if (s === 'APPLIED') return 'live'
  if (s === 'IN_FLIGHT') return 'sent'
  if (s === 'PENDING') return 'waiting'
  if (s === 'FAILED') return 'failed'
  if (s === 'SUPERSEDED') return 'replaced'
  if (s === 'CANCELLED') return 'cancelled'
  return 'waiting'
}

/** An action log's amazonResponseStatus as the page's word (ads-changes.service.ts opDeliveryState, then delivery.ts). */
export function logDelivery(status: string | null | undefined): BidDelivery | null {
  const s = status?.trim().toUpperCase()
  if (!s) return null
  if (s === 'SUCCESS' || s === 'APPLIED') return 'live'
  if (s === 'IN_FLIGHT') return 'sent'
  if (s === 'PENDING') return 'waiting'
  if (s === 'FAILED' || s === 'REFUSED') return 'failed'
  if (s === 'SUPERSEDED') return 'replaced'
  if (s === 'CANCELLED' || s === 'SKIPPED') return 'cancelled'
  return 'waiting'
}

/** What became of a bid's newest change, from its newest bid AdMutation and its newest bid action-log row (header). */
export function deliveryOf(m: MutationFact | null, l: LogFact | null, now: Date = new Date()): BidDelivery | null {
  if (!m && !l) return null
  const same = !!(m && l && (
    (m.outboundQueueId && m.outboundQueueId === l.outboundQueueId)
    || (!m.outboundQueueId || !l.outboundQueueId ? Math.abs(m.createdAt.getTime() - l.createdAt.getTime()) <= SAME_CHANGE_MS : false)
  ))
  const logIsNewest = !!l && (!m || same || l.createdAt.getTime() > m.createdAt.getTime())
  if (logIsNewest && l!.rolledBackAt) return 'undone'
  if (m && (same || !l || m.createdAt.getTime() >= l.createdAt.getTime())) return mutationDelivery(m.state)
  const word = logDelivery(l!.status)
  if (word === 'waiting' && now.getTime() - l!.createdAt.getTime() > STALE_LOG_PENDING_MS) return null
  return word
}

export interface BidDeliveries {
  /** Each bid's newest change, as the page's word; a bid with no change in 30 days is missing. */
  byTarget: Map<string, BidDelivery>
  /** The newest moment any of these bids' changes moved; null with none in 30 days. */
  latestChangeAt: Date | null
}

/** The newest bid AdMutation and action-log row of each bid over 30 days (two indexed reads), and what became of each. */
export async function readBidDeliveries(targetIds: readonly string[], now: Date = new Date()): Promise<BidDeliveries> {
  const byTarget = new Map<string, BidDelivery>()
  if (!targetIds.length) return { byTarget, latestChangeAt: null }
  const ids = [...targetIds]
  const since = new Date(now.getTime() - DELIVERY_DAYS * DAY)
  // DISTINCT ON keeps each bid's newest row; the window max runs before it, over every row read.
  const [mutations, logs] = await Promise.all([
    prisma.$queryRaw<Array<{ targetId: string; state: string; createdAt: Date; updatedAt: Date; outboundQueueId: string | null; maxAt: Date | null }>>(Prisma.sql`
      SELECT DISTINCT ON (m."entityId") m."entityId" AS "targetId", m.state, m."createdAt", m."updatedAt", m."outboundQueueId",
             max(m."updatedAt") OVER () AS "maxAt"
        FROM "AdMutation" m
       WHERE m."entityType" = 'AD_TARGET' AND m."entityId" = ANY(${ids}::text[]) AND m.field = 'bid' AND m."createdAt" >= ${since}
       ORDER BY m."entityId", m."createdAt" DESC, m.id DESC`),
    prisma.$queryRaw<Array<{ targetId: string; status: string | null; rolledBackAt: Date | null; createdAt: Date; outboundQueueId: string | null; maxAt: Date | null }>>(Prisma.sql`
      SELECT DISTINCT ON (l."entityId") l."entityId" AS "targetId", l."amazonResponseStatus" AS status, l."rolledBackAt", l."createdAt",
             l."outboundQueueId", max(GREATEST(l."createdAt", COALESCE(l."rolledBackAt", l."createdAt"))) OVER () AS "maxAt"
        FROM "AdvertisingActionLog" l
       WHERE l."entityType" = 'AD_TARGET' AND l."entityId" = ANY(${ids}::text[]) AND l."actionType" = ANY(${BID_CHANGE_TYPES}::text[])
         AND l."createdAt" >= ${since}
       ORDER BY l."entityId", l."createdAt" DESC, l.id DESC`),
  ])
  const mutationOf = new Map(mutations.map((m) => [m.targetId, m]))
  const logOf = new Map(logs.map((l) => [l.targetId, l]))
  for (const id of new Set([...mutationOf.keys(), ...logOf.keys()])) {
    const word = deliveryOf(mutationOf.get(id) ?? null, logOf.get(id) ?? null, now)
    if (word) byTarget.set(id, word)
  }
  const times = [mutations[0]?.maxAt, logs[0]?.maxAt].filter((t): t is Date => t instanceof Date)
  return { byTarget, latestChangeAt: times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null }
}

// ── The scope ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The scope of GET /advertising/bids and of its cursor. Scope filter (2026-10-12): each singular param is a list of one,
 * merged with its plural (ads-scope-lists.ts); OR inside one list, AND across lists. A portfolio is the campaign's
 * (Campaign.portfolioId, Amazon's id); a product is its line (the product and its children: expandProductScope).
 */
export interface BidScopeQuery extends ScopeIdLists {
  market?: string | null
  portfolioId?: string | null
  productId?: string | null
  campaignId?: string | null
  adGroupId?: string | null
  status?: 'live' | 'all'
}

/**
 * The bids of a scope as one where, for both reads: `status=live` (default) the target, its ad group and its campaign
 * ENABLED; `all` everything not archived. Another business's campaign, ad group, portfolio or product — or an ad group
 * outside every campaign named — is not found (ads-scope-reach.ts unknownScopeId), word for word for both reads.
 */
export async function bidScopeWhere(q: BidScopeQuery): Promise<{ ok: true; where: Prisma.AdTargetWhereInput } | { ok: false; status: 404; error: string }> {
  const campaignIds = mergeIds(q.campaignId, q.campaignIds)
  const adGroupIds = mergeIds(q.adGroupId, q.adGroupIds)
  const portfolioIds = mergeIds(q.portfolioId, q.portfolioIds)
  const products = mergeIds(q.productId, q.productIds)
  const unknown = await unknownScopeId({ campaignIds, adGroupIds, portfolioIds, productIds: products })
  if (unknown) return { ok: false, status: 404, error: unknown }
  const productIds = products ? [...new Set((await Promise.all(products.map((id) => expandProductScope(id)))).flat())] : null
  const market = q.market?.trim().toUpperCase() || null
  const state = q.status !== 'all' ? ('ENABLED' as const) : { not: 'ARCHIVED' as const }
  return {
    ok: true,
    where: {
      isNegative: false,
      status: state,
      adGroup: {
        ...(adGroupIds ? { id: { in: adGroupIds } } : {}),
        status: state,
        ...(productIds ? { productAds: { some: { productId: { in: productIds } } } } : {}),
        campaign: {
          status: state,
          ...(market ? { marketplace: market } : {}),
          ...(campaignIds ? { id: { in: campaignIds } } : {}),
          ...(portfolioIds ? { portfolioId: { in: portfolioIds } } : {}),
        },
      },
    },
  }
}

// ── The cursor ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BidCursorQuery extends BidScopeQuery {
  /** Taken for the same query string as GET /advertising/bids, and not used: the cursor covers every owner (header). */
  owner?: string | null
}

export interface BidCursor {
  /** ISO time of the newest move of any bid change in scope; null with none in 30 days. */
  latestChangeAt: string | null
  /** Bids in scope whose newest change is Waiting. */
  waiting: number
  /** Bids in scope whose newest change is Sent. */
  sent: number
}

export type BidCursorAnswer = { ok: true; cursor: BidCursor } | { ok: false; status: 404; error: string }

/** GET /advertising/bids/cursor — the scope's bids as readBidRows reads them (bid-rows.service.ts), then their deliveries. */
export async function readBidCursor(q: BidCursorQuery, now: Date = new Date()): Promise<BidCursorAnswer> {
  // Scope: another business's ids read as not found, word for word as readBidRows says it (bidScopeWhere).
  const scope = await bidScopeWhere(q)
  if ('error' in scope) return scope
  const targets = await prisma.adTarget.findMany({
    where: scope.where,
    select: { id: true },
    orderBy: [{ bidCents: 'desc' }, { id: 'asc' }],
    take: HARD_CAP,
  })
  const { byTarget, latestChangeAt } = await readBidDeliveries(targets.map((t) => t.id), now)
  let waiting = 0
  let sent = 0
  for (const word of byTarget.values()) {
    if (word === 'waiting') waiting++
    else if (word === 'sent') sent++
  }
  return { ok: true, cursor: { latestChangeAt: latestChangeAt?.toISOString() ?? null, waiting, sent } }
}
