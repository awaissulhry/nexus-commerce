/**
 * AD.4 — Single chokepoint for Amazon Ads API write authorization.
 *
 * Live writes require ALL of:
 *   1. NEXUS_AMAZON_ADS_MODE=live (deploy-wide env flag)
 *   2. AmazonAdsConnection.mode === 'production' AND writesEnabledAt != null
 *   3. payload value ≤ NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS (default 50000 = €500)
 *
 * Failure flips the mutation to dry-run mode (worker logs the deny +
 * marks the OutboundSyncQueue row SKIPPED with a `[ADS-WRITE-GATE-DENY]`
 * tag in errorMessage). Defense-in-depth alongside:
 *   - rule.dryRun (rule-level)
 *   - rule.maxValueCentsEur (per-execution)
 *   - rule.maxDailyAdSpendCentsEur (per-day SUM)
 *
 * Called by ads-sync.worker.ts before every live API call.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { adsMode } from './ads-api-client.js'

export type GateDeniedAt =
  | 'env'
  | 'connection'
  | 'connection_writes'
  | 'value_cap'
  | 'campaign_allowlist'
  | 'daily_cap'

export type GateDecision =
  | { allowed: true; mode: 'sandbox' }
  | { allowed: true; mode: 'live'; profileId: string }
  | { allowed: false; reason: string; deniedAt: GateDeniedAt }

export interface GateContext {
  marketplace: string | null
  payloadValueCents: number
  // Apex A.2a — when provided, the gate enforces the per-campaign live-write
  // allowlist (default-deny) + the maxWritesPerDay guardrail. The worker
  // resolves this from the mutated entity; campaign *creation* flows omit it
  // (there's no campaign to allowlist yet). `null` means the worker tried to
  // resolve a campaign for an existing-entity mutation and failed → deny in
  // live mode, so an unattributable write can never slip through.
  campaignId?: string | null
}

function maxWriteValueCents(): number {
  const v = Number(process.env.NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS)
  if (Number.isFinite(v) && v > 0) return v
  return 50_000 // €500 default
}

/** UTC calendar day as 'YYYY-MM-DD' — the bucket key for the daily-write cap. */
export function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Resolve whether a queued mutation may hit Amazon's live API.
 *
 * Sandbox short-circuits with `allowed: true, mode: 'sandbox'` — the
 * worker still calls ads-api-client which itself short-circuits, so
 * the DB-side writes complete but no external HTTP fires.
 */
export async function checkAdsWriteGate(ctx: GateContext): Promise<GateDecision> {
  // Sandbox path — env says we're not in live mode at all.
  if (adsMode() === 'sandbox') {
    return { allowed: true, mode: 'sandbox' }
  }

  // Env says live, but operator must also enable per-connection writes.
  if (!ctx.marketplace) {
    return {
      allowed: false,
      reason: 'no marketplace on payload — cannot resolve AmazonAdsConnection',
      deniedAt: 'connection',
    }
  }
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace: ctx.marketplace, isActive: true },
    select: { profileId: true, mode: true, writesEnabledAt: true },
  })
  if (!conn) {
    return {
      allowed: false,
      reason: `no active AmazonAdsConnection for marketplace=${ctx.marketplace}`,
      deniedAt: 'connection',
    }
  }
  if (conn.mode !== 'production') {
    return {
      allowed: false,
      reason: `AmazonAdsConnection.mode=${conn.mode} (needs production)`,
      deniedAt: 'connection',
    }
  }
  if (conn.writesEnabledAt == null) {
    return {
      allowed: false,
      reason: 'AmazonAdsConnection.writesEnabledAt is null — operator must explicitly enable writes',
      deniedAt: 'connection_writes',
    }
  }

  // Apex A.2a — per-campaign allowlist (default-deny). When the worker passes a
  // campaignId (every existing-entity bid/state mutation), the campaign must be
  // explicitly on the allowlist. `undefined` = a creation flow with no campaign
  // to gate → skip this check. `null` = resolution failed → deny.
  if (ctx.campaignId !== undefined) {
    if (!ctx.campaignId) {
      return {
        allowed: false,
        reason: 'could not resolve a campaign for this live mutation — refusing unattributable write',
        deniedAt: 'campaign_allowlist',
      }
    }
    const campaign = await prisma.campaign.findUnique({
      where: { id: ctx.campaignId },
      select: { liveBidWritesEnabled: true, dynamicBidding: true, liveBidWritesToday: true, liveBidWritesDay: true },
    })
    if (!campaign?.liveBidWritesEnabled) {
      return {
        allowed: false,
        reason: `campaign ${ctx.campaignId} is not on the live-write allowlist (Campaign.liveBidWritesEnabled=false)`,
        deniedAt: 'campaign_allowlist',
      }
    }
    // WC — the maxWritesPerDay DAILY cap is intentionally DISABLED (operator decision:
    // unlimited bid writes). It counted +1 per ENTITY, so a per-hour rank schedule
    // (~12 entities × ~12–24 flips/day) blew through a small cap by mid-morning and then
    // silently dropped the rest of the day's pushes to Amazon (local ≠ Amazon split-brain).
    // Frequency is no longer capped. Per-WRITE safety still applies (the value + change
    // clamps below, plus cpcCeiling) so no single write can set a wild bid, and the Ads
    // client's 429 backoff (ads-api-client.ts) paces bursts against Amazon's rate limits.
    // liveBidWritesToday is still recorded (see recordWrite) for observability only.
  }

  // Value cap: blast-radius limit per write. Composite actions are
  // chunked into individual OutboundSyncQueue rows so each pass
  // through the gate sees only its slice.
  const cap = maxWriteValueCents()
  if (ctx.payloadValueCents > cap) {
    return {
      allowed: false,
      reason: `payload value ${ctx.payloadValueCents}¢ exceeds cap ${cap}¢ (NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS)`,
      deniedAt: 'value_cap',
    }
  }

  return { allowed: true, mode: 'live', profileId: conn.profileId }
}

/**
 * Convenience: log a deny decision in the structured format that
 * grep `[ADS-WRITE-GATE-DENY]` will pick up.
 */
export function logGateDeny(
  context: { queueId: string; marketplace: string | null; payloadValueCents: number },
  reason: string,
  deniedAt: GateDeniedAt,
): void {
  logger.warn('[ADS-WRITE-GATE-DENY]', {
    queueId: context.queueId,
    marketplace: context.marketplace,
    payloadValueCents: context.payloadValueCents,
    reason,
    deniedAt,
  })
}

/**
 * Bump AmazonAdsConnection.lastWriteAt when a write completes
 * successfully. Lets operators see "this connection is actively used"
 * in the AD.4 UI.
 */
export async function recordSuccessfulWrite(marketplace: string | null): Promise<void> {
  if (!marketplace) return
  await prisma.amazonAdsConnection
    .updateMany({
      where: { marketplace, isActive: true },
      data: { lastWriteAt: new Date() },
    })
    .catch((err) => {
      logger.warn('[ads-write-gate] failed to update lastWriteAt', {
        marketplace,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/**
 * Apex A.2a — bump a campaign's rolling daily live-write counter after a
 * successful live bid write. Resets the count when the stored day rolls over.
 * Only called on the live path so sandbox/dry-run never consumes the cap.
 */
export async function recordCampaignLiveWrite(campaignId: string | null): Promise<void> {
  if (!campaignId) return
  const today = utcDayKey()
  try {
    const c = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { liveBidWritesDay: true },
    })
    if (c?.liveBidWritesDay === today) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { liveBidWritesToday: { increment: 1 } },
      })
    } else {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { liveBidWritesToday: 1, liveBidWritesDay: today },
      })
    }
  } catch (err) {
    logger.warn('[ads-write-gate] failed to bump campaign live-write counter', {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
