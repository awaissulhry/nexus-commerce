/**
 * AR — Auto-reconcile failed Amazon *writes* (distinct from ads-reconcile's
 * metric/drift reconciliation, which is about READ accuracy).
 *
 * A bid/placement write can ultimately give up: the queued path dead-letters
 * after `maxRetries` (ads-sync.worker.ts) and the inline placement path drops
 * after the client's 429/5xx backoff. When that happens the LOCAL value is what
 * we intend, but Amazon stays stale — and nothing re-pushes it, because the rank
 * engine only writes on a *change* and local already equals the target. The only
 * recoveries were a manual /resync-bids or the next genuine bid change.
 *
 * This sweep closes that gap. Every entity whose LAST live write failed carries
 * `lastSyncStatus='FAILED'` (the A2/AR stamping). That stamp is self-superseding —
 * it always reflects the most recent write — so re-pushing the entity's CURRENT
 * local value (with `forceResync`) can never clobber a newer success. We skip
 * permanent/logic errors (400/404/…); those will never land, so re-pushing them
 * is pointless and would loop forever — we leave them FAILED for the operator.
 *
 * Bounded (a per-sweep cap) and gated (every push still hits checkAdsWriteGate —
 * env live + production connection + per-campaign allowlist), so it is sandbox-safe
 * and respects the same guardrails as every other write. Ridden by the rank cron.
 */
import { logger } from '../../utils/logger.js'
import type { AdsActor } from './ads-mutation.service.js'

const ACTOR: AdsActor = 'automation:reconcile'

export interface WriteReconcileResult {
  attempted: number
  adGroups: number
  adTargets: number
  campaigns: number
  skippedPermanent: number
  dryRun: boolean
  sample: Array<{ entity: 'AD_GROUP' | 'AD_TARGET' | 'CAMPAIGN'; id: string; value: string }>
}

/**
 * Only retry transient failures. A 4xx logic error (bad arg, entity gone) will
 * never succeed on re-push, so it must NOT be swept (else it re-fires forever).
 * Unknown/empty errors get the benefit of the doubt (treated as transient).
 */
export function isRetryableSyncError(err: string | null | undefined): boolean {
  if (!err) return true
  const e = err.toLowerCase()
  if (
    /\b(400|401|403|404|409|410|422)\b/.test(e) ||
    /not.?found|does not exist|invalid|unauthor|forbidden|duplicate|malformed|bad request|no_external_id/.test(e)
  ) {
    return false
  }
  return true // 429 / 5xx / throttle / timeout / network → worth retrying
}

export async function reconcileFailedAmazonWrites(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<WriteReconcileResult> {
  const dryRun = opts.dryRun ?? false
  const limit = opts.limit ?? 50
  // Heavy deps loaded lazily so the module top-level stays dependency-free (the
  // pure isRetryableSyncError stays unit-testable without a DB connection).
  const prisma = (await import('../../db.js')).default
  const { updateAdGroupWithSync, updateAdTargetWithSync } = await import('./ads-mutation.service.js')
  // Only revisit recent failures — an ancient FAILED stamp is cruft, not live drift.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  const sample: WriteReconcileResult['sample'] = []
  let attempted = 0,
    adGroups = 0,
    adTargets = 0,
    campaigns = 0,
    skippedPermanent = 0

  const pushSample = (entity: WriteReconcileResult['sample'][number]['entity'], id: string, value: string) => {
    if (sample.length < 15) sample.push({ entity, id, value })
  }

  // 1) Ad-group default bids — queued, reliably FAILED-stamped, forceResync-capable.
  const groups = await prisma.adGroup.findMany({
    where: {
      lastSyncStatus: 'FAILED',
      externalAdGroupId: { not: null },
      defaultBidCents: { not: null },
      lastSyncedAt: { gte: since },
    },
    select: { id: true, defaultBidCents: true, lastSyncError: true },
    take: limit,
    orderBy: { lastSyncedAt: 'asc' },
  })
  for (const g of groups) {
    if (!isRetryableSyncError(g.lastSyncError)) {
      skippedPermanent++
      continue
    }
    attempted++
    pushSample('AD_GROUP', g.id, `${g.defaultBidCents}c`)
    if (dryRun) continue
    try {
      const r = await updateAdGroupWithSync({
        adGroupId: g.id,
        patch: { defaultBidCents: g.defaultBidCents! },
        actor: ACTOR,
        reason: 'auto-reconcile: re-push last failed bid so Amazon matches local',
        applyImmediately: true,
        forceResync: true,
      })
      if (r.ok) adGroups++
    } catch (e) {
      logger.warn('[ads-write-reconcile] ad-group re-push failed', { adGroupId: g.id, error: (e as Error).message })
    }
  }

  // 2) Keyword / product target bids — same queued+stamped path.
  const targets = await prisma.adTarget.findMany({
    where: {
      lastSyncStatus: 'FAILED',
      externalTargetId: { not: null },
      isNegative: false,
      bidCents: { not: null, gte: 0 },
      lastSyncedAt: { gte: since },
    },
    select: { id: true, bidCents: true, lastSyncError: true },
    take: limit,
    orderBy: { lastSyncedAt: 'asc' },
  })
  for (const t of targets) {
    if (!isRetryableSyncError(t.lastSyncError)) {
      skippedPermanent++
      continue
    }
    attempted++
    pushSample('AD_TARGET', t.id, `${t.bidCents}c`)
    if (dryRun) continue
    try {
      const r = await updateAdTargetWithSync({
        adTargetId: t.id,
        patch: { bidCents: t.bidCents! },
        actor: ACTOR,
        reason: 'auto-reconcile: re-push last failed bid so Amazon matches local',
        applyImmediately: true,
        forceResync: true,
      })
      if (r.ok) adTargets++
    } catch (e) {
      logger.warn('[ads-write-reconcile] target re-push failed', { targetId: t.id, error: (e as Error).message })
    }
  }

  // 3) Campaign placement bias — the inline path, now FAILED-stamped by
  //    updatePlacementBidding. Re-push the CURRENT placement adjustments (always
  //    pushes; no skip). A campaign with no placement bias is left alone (its
  //    FAILED came from a non-placement write, healed by its own path).
  const camps = await prisma.campaign.findMany({
    where: {
      lastSyncStatus: 'FAILED',
      externalCampaignId: { not: null },
      lastSyncedAt: { gte: since },
    },
    select: { id: true, dynamicBidding: true, lastSyncError: true },
    take: limit,
    orderBy: { lastSyncedAt: 'asc' },
  })
  if (camps.length) {
    const { updatePlacementBidding } = await import('./ads-create.service.js')
    for (const c of camps) {
      if (!isRetryableSyncError(c.lastSyncError)) {
        skippedPermanent++
        continue
      }
      const adjustments =
        (c.dynamicBidding as { placementBidding?: Array<{ placement: string; percentage: number }> } | null)
          ?.placementBidding ?? []
      if (!adjustments.length) continue
      attempted++
      pushSample('CAMPAIGN', c.id, adjustments.map((a) => `${a.placement}:${a.percentage}`).join(','))
      if (dryRun) continue
      try {
        const r = await updatePlacementBidding({ campaignId: c.id, adjustments })
        if (r.ok) campaigns++
      } catch (e) {
        logger.warn('[ads-write-reconcile] placement re-push failed', { campaignId: c.id, error: (e as Error).message })
      }
    }
  }

  if (attempted || skippedPermanent) {
    logger.info('[ads-write-reconcile] swept failed Amazon writes', {
      attempted,
      adGroups,
      adTargets,
      campaigns,
      skippedPermanent,
      dryRun,
    })
  }
  return { attempted, adGroups, adTargets, campaigns, skippedPermanent, dryRun, sample }
}
