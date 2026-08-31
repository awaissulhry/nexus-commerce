// PH.5 — the bidding-engine bridge, as a service.
//
// This is the primary app's half of the ONE extracted-microservice contract
// that exists: services/bidding-engine reads bid contexts and reports applied
// results over internal REST, and never touches the database.
//
// It used to live inside two Fastify handlers in advertising.routes.ts. That
// is the exact shape that makes extraction impossible — when advertising
// becomes its own service, logic sitting in an HTTP handler has to be
// rewritten rather than moved. Here it is a function the handler calls, so the
// move is a file move.
//
// The route handlers are now thin: authenticate, parse, delegate. That mirrors
// the neighbouring /advertising/momentum and /advertising/budget-manager
// handlers in the same file, which were already written this way — this is the
// house pattern, not a new one.
//
// Behaviour is deliberately UNCHANGED. The engine's contract is a deployed
// interface; this is a move, not a redesign.

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { adsMode } from './ads-api-client.js'

/** The wire shape services/bidding-engine consumes. Do not reshape casually. */
export interface BidContext {
  bridgeId: string
  externalId: string
  /** The Amazon advertising profile id. Named accountRef on the wire, not profileId. */
  accountRef: string
  currentBidMinor: number
  aovMinor: number
  cr7d: number
  cr30d: number
  acosTargetBps: number
  acos1hBps: number | null
  daysOfSupply: number | null
  bidMinMinor: number
  bidMaxMinor: number
}

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const DEFAULT_TARGET_ACOS = 0.3
const FLOOR_BID_MINOR = 5
const DEFAULT_AOV_MINOR = 5000

/**
 * The per-cycle bid band. PURE, and exported because it is real money logic:
 * it decides how far the engine may move a live bid in one step.
 *
 * Apex A.2a — when the campaign sets `maxBidChangePct`, the band is that
 * guardrail around the current bid, so the engine respects the same cap as the
 * audited worker path. Without it the original [5, max(bid×3, 300)] band
 * applies.
 */
export function computeBidBand(
  bidCents: number,
  maxBidChangePct: unknown,
): { bidMinMinor: number; bidMaxMinor: number } {
  const pct = Number(maxBidChangePct)
  const bounded = Number.isFinite(pct) && pct > 0
  return {
    bidMinMinor: bounded ? Math.max(FLOOR_BID_MINOR, Math.round(bidCents * (1 - pct / 100))) : FLOOR_BID_MINOR,
    bidMaxMinor: bounded ? Math.round(bidCents * (1 + pct / 100)) : Math.max(bidCents * 3, 300),
  }
}

/** The selected row shape, so the pure builder can be tested without a database. */
export interface BidTargetRow {
  id: string
  externalTargetId: string | null
  bidCents: number
  clicks: number
  spendCents: number
  salesCents: number
  ordersCount: number | null
  adGroup: { campaign: { marketplace: string | null; dynamicBidding: unknown } | null } | null
}

/** PURE: one target row + its resolved profile → one context. */
export function buildBidContext(target: BidTargetRow, accountRef: string): BidContext {
  const orders = target.ordersCount ?? 0
  const cr = target.clicks > 0 ? orders / target.clicks : 0
  const dynamic = (target.adGroup?.campaign?.dynamicBidding ?? {}) as {
    targetAcos?: number
    maxBidChangePct?: number
  }
  return {
    bridgeId: target.id,
    externalId: target.externalTargetId as string,
    accountRef,
    currentBidMinor: target.bidCents,
    aovMinor: orders > 0 ? Math.round(target.salesCents / orders) : DEFAULT_AOV_MINOR,
    // Both windows carry the same figure today — the row holds one lifetime
    // conversion rate, not a 7/30-day split. Kept as two fields because the
    // engine's contract has them; reporting one as the other would be a lie
    // the engine cannot see through.
    cr7d: cr,
    cr30d: cr,
    acosTargetBps: Math.round((dynamic.targetAcos ?? DEFAULT_TARGET_ACOS) * 10000),
    acos1hBps: null,
    daysOfSupply: null,
    ...computeBidBand(target.bidCents, dynamic.maxBidChangePct),
  }
}

/**
 * Targets eligible for re-bidding, with the joins the engine must not do
 * itself (it has no database).
 *
 * Apex A.2a — in live mode only campaigns on the live-write allowlist are
 * visible, so the engine path is contained exactly like the audited worker
 * path. Sandbox returns all.
 */
export async function getBidContexts(
  opts: { marketplace?: string | null; limit?: number | null } = {},
): Promise<BidContext[]> {
  const limit = Math.min(opts.limit ? Number(opts.limit) : DEFAULT_LIMIT, MAX_LIMIT)
  const enforceAllowlist = adsMode() === 'live'
  const campaignWhere = {
    ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
    ...(enforceAllowlist ? { liveBidWritesEnabled: true } : {}),
  }

  const targets = await prisma.adTarget.findMany({
    where: {
      kind: 'KEYWORD',
      status: 'ENABLED',
      isNegative: false,
      externalTargetId: { not: null },
      clicks: { gt: 0 },
      ...(Object.keys(campaignWhere).length ? { adGroup: { campaign: campaignWhere } } : {}),
    },
    take: limit,
    select: {
      id: true, externalTargetId: true, bidCents: true, clicks: true, spendCents: true,
      salesCents: true, ordersCount: true,
      adGroup: { select: { campaign: { select: { marketplace: true, dynamicBidding: true } } } },
    },
  })

  // Resolve the advertising profile per marketplace once, not per target.
  const connections = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { marketplace: true, profileId: true },
  })
  const profileByMarketplace = new Map(connections.map((c) => [c.marketplace, c.profileId]))

  return (targets as BidTargetRow[]).flatMap((target) => {
    const marketplace = target.adGroup?.campaign?.marketplace ?? null
    const accountRef = marketplace ? profileByMarketplace.get(marketplace) : undefined
    // No profile or no external id means the engine could not act on it anyway.
    if (!accountRef || !target.externalTargetId) return []
    return [buildBidContext(target, accountRef)]
  })
}

export interface AppliedBid {
  bridgeId: string
  externalId?: string
  bidMinor: number
  prevBidMinor?: number
  status?: string
}

function responseStatus(status: string | undefined): string {
  if (status === 'applied') return 'SUCCESS'
  if (status === 'failed') return 'FAILED'
  return 'PENDING'
}

/**
 * Record what the engine did: update the local bid when it actually landed,
 * and always write the audit row.
 *
 * Both writes stay best-effort, as they were — the engine has already written
 * to Amazon by the time it reports, so failing its call would make it retry a
 * write that already happened. What changed: a failure is now LOGGED instead
 * of vanishing into `.catch(() => {})`. The response contract is untouched.
 */
export async function recordAppliedBid(input: AppliedBid): Promise<void> {
  if (input.status === 'applied') {
    await prisma.adTarget
      .update({ where: { id: input.bridgeId }, data: { bidCents: input.bidMinor } })
      .catch((error: unknown) => {
        logger.warn('bidding bridge: local bid update failed (engine already wrote to Amazon)', {
          bridgeId: input.bridgeId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  await prisma.advertisingActionLog
    .create({
      data: {
        actionType: 'bid_set_by_engine',
        entityType: 'AD_TARGET',
        entityId: input.bridgeId,
        payloadBefore: { bidCents: input.prevBidMinor ?? null },
        payloadAfter: { bidCents: input.bidMinor, source: 'bidding-engine' } as object,
        amazonResponseStatus: responseStatus(input.status),
      },
    })
    .catch((error: unknown) => {
      logger.warn('bidding bridge: action-log write failed', {
        bridgeId: input.bridgeId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}
