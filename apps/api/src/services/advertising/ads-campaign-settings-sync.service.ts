/**
 * B — live campaign-settings sync from Amazon (v3).
 *
 * The v1 unified export refreshes budget/strategy/state every 6h and carries NO
 * placement bids at all — so "Adjust bids by placement" shows null/0 and edits made
 * on Amazon take up to 6h to appear. This pulls each campaign's CURRENT settings
 * straight from the v3 campaigns API (dynamicBidding = strategy + placementBidding %,
 * budget, state) and writes them through NON-DESTRUCTIVELY: a field is updated only
 * when Amazon actually returned it, so a partial response can never zero a good value.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { listCampaignsV3, type AdsRegion, type V3CampaignSettings } from './ads-api-client.js'
import { pendingWriteFields } from './ads-mutation.service.js'
import { holdBackPendingFields } from '../ads-core/drift.js'

const STATE_MAP: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = { enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED' }

// AX-IE.0 (E4) — Amazon's real targeting type. Strict: only the two values Amazon
// documents are accepted, anything else (including absent) yields null so the
// bulksheet exporter emits a blank cell. This is the ONLY source we have — the v1
// unified export record carries no targeting type, and AdGroup.targetingType is
// written solely by our own campaign builders so every synced ad group sits at its
// default. Guessing here is what produced the "Autumn Boots exports as auto" bug.
function mapTargetingType(raw?: string): 'AUTO' | 'MANUAL' | null {
  if (!raw) return null
  const s = raw.trim().toUpperCase()
  return s === 'AUTO' || s === 'MANUAL' ? s : null
}

function mapStrategy(raw?: string): 'AUTO_FOR_SALES' | 'LEGACY_FOR_SALES' | 'MANUAL' | null {
  if (!raw) return null
  const s = raw.toUpperCase()
  if (s.includes('AUTO')) return 'AUTO_FOR_SALES'
  if (s.includes('MANUAL')) return 'MANUAL'
  if (s.includes('LEGACY')) return 'LEGACY_FOR_SALES'
  return null
}

// H.12 — campaign deletion reconciliation. A local ACTIVE campaign (ENABLED/PAUSED, with an external
// id) owned by this connection's marketplace that Amazon's current ENABLED+PAUSED list no longer
// returns is no longer active on Amazon (archived or deleted) → archive locally. Tight campaign-scale
// guard (floor 2, ≤20% — NOT the floor-20 used for the many-per-ad-group targets) so a partial/empty
// fetch can't wipe the account; soft-archive is reversible; gated-local campaigns (no external id) are
// exempt. Must only be called on a SUCCESSFUL fetch. Exported so the scoping/guard can be tested.
export async function reconcileCampaignDeletions(opts: { connMarketplace: string; seenExternalCampaignIds: Set<string>; fetchOk: boolean }): Promise<number> {
  if (!opts.fetchOk) return 0
  const { normalizeMarketplaceCode } = await import('../../utils/marketplace-code.js')
  const locals = await prisma.campaign.findMany({
    where: { externalCampaignId: { not: null }, status: { in: ['ENABLED', 'PAUSED'] } },
    select: { id: true, externalCampaignId: true, marketplace: true },
  })
  const owned = locals.filter((c) => (normalizeMarketplaceCode(c.marketplace) ?? c.marketplace) === opts.connMarketplace || c.marketplace === opts.connMarketplace)
  const toArchive = owned.filter((c) => c.externalCampaignId && !opts.seenExternalCampaignIds.has(c.externalCampaignId)).map((c) => c.id)
  const cap = Math.max(2, Math.ceil(owned.length * 0.2))
  if (toArchive.length === 0 || toArchive.length > cap) {
    if (toArchive.length) logger.warn('[settings-sync] campaign-deletion guard tripped — skipping', { wouldArchive: toArchive.length, owned: owned.length, cap, marketplace: opts.connMarketplace })
    return 0
  }
  const r = await prisma.campaign.updateMany({ where: { id: { in: toArchive } }, data: { status: 'ARCHIVED', lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } })
  logger.warn('[settings-sync] archived campaigns no longer active on Amazon', { count: r.count, marketplace: opts.connMarketplace })
  return r.count
}

/** Campaign fields worth comparing. Deliberately small — these are the ones an
 *  operator changes in Seller Central, and the ones our own writes touch. */
const CAMPAIGN_DRIFT_FIELDS = ['status', 'dailyBudget', 'biddingStrategy', 'portfolioId', 'targetingType'] as const

/**
 * AX-ZD.4 — record where Amazon disagrees with us, from the read we already did.
 *
 * `incoming` contains ONLY the fields Amazon actually reported, so a partial
 * response cannot masquerade as somebody clearing a value.
 *
 * A drift row is keyed per (entity, field) and re-opened rather than duplicated,
 * so a campaign that has been wrong for three days is one row with a high
 * occurrence count and an honest firstDetectedAt — not 216 rows.
 */
async function recordCampaignDrift(
  existing: {
    id: string; name: string; marketplace: string | null
    status: string | null; dailyBudget: unknown; biddingStrategy: string | null
    portfolioId: string | null; lastSyncedAt: Date | null; lastSyncStatus: string | null
  },
  incoming: Record<string, unknown>,
  amazon: V3CampaignSettings,
  pending: Set<string>,
): Promise<number> {
  const { diffFields, classifyDrift } = await import('../ads-core/drift.js')
  const ours: Record<string, unknown> = {
    status: existing.status,
    dailyBudget: existing.dailyBudget == null ? null : Number(existing.dailyBudget),
    biddingStrategy: existing.biddingStrategy,
    portfolioId: existing.portfolioId,
  }
  const diffs = diffFields(ours, incoming, CAMPAIGN_DRIFT_FIELDS)

  // Anything we hold that Amazon now agrees with is no longer drifting. Closing
  // resolved rows is what stops the drift list becoming a graveyard nobody reads.
  const stillDrifting = new Set(diffs.map((d) => d.field))
  await prisma.adDrift.updateMany({
    where: {
      entityType: 'CAMPAIGN', entityId: existing.id, resolvedAt: null,
      field: { notIn: [...stillDrifting] },
    },
    data: { resolvedAt: new Date() },
  })
  if (!diffs.length) return 0

  // `pending` is computed by the caller, which also uses it to hold those
  // fields back from the overwrite (AX-ZD.3) — one query, one answer, so the
  // classification and the write decision can never disagree.
  //
  // AX-ZD.1 — this used to be a campaign-wide JSON-path scan on
  // OutboundSyncQueue (`payload.entityId == id`), counted once and then applied
  // to EVERY field diff. OutboundSyncQueue has no field column, so it could not
  // have been written any other way — and the result was that one queued budget
  // change classified a name edit made in Seller Central as WRITE_PENDING and
  // hid it. AdMutation carries one row per (entity, field), so the question is
  // now asked per field.
  const now = new Date()
  for (const d of diffs) {
    const classification = classifyDrift({
      ours: d.ours, theirs: d.theirs,
      lastWriteAt: existing.lastSyncedAt,
      lastWriteStatus: existing.lastSyncStatus,
      hasPendingWrite: pending.has(d.field),
      now,
    })
    await prisma.adDrift.upsert({
      where: { entityType_entityId_field: { entityType: 'CAMPAIGN', entityId: existing.id, field: d.field } },
      create: {
        entityType: 'CAMPAIGN', entityId: existing.id, externalId: amazon.campaignId,
        marketplace: existing.marketplace, entityName: existing.name,
        field: d.field, ourValue: d.ours, amazonValue: d.theirs, classification,
      },
      update: {
        ourValue: d.ours, amazonValue: d.theirs, classification,
        lastDetectedAt: now, occurrences: { increment: 1 },
        // Re-open rather than leaving a stale resolution behind.
        resolvedAt: null,
      },
    })
  }
  return diffs.length
}

export async function syncCampaignSettingsFromAmazon(
  opts?: { profileId?: string },
): Promise<{ profiles: number; campaigns: number; updated: number; placementsFilled: number; archived: number; driftFound: number; sampleShape?: unknown; errors: string[] }> {
  const conns = await prisma.amazonAdsConnection.findMany({
    where: opts?.profileId ? { profileId: opts.profileId } : {},
    select: { profileId: true, region: true, marketplace: true },
  })
  let campaigns = 0, updated = 0, placementsFilled = 0, archived = 0, driftFound = 0
  let sampleShape: unknown
  const errors: string[] = []

  for (const conn of conns) {
    const region: AdsRegion = conn.region === 'NA' || conn.region === 'FE' ? (conn.region as AdsRegion) : 'EU'
    let list: Awaited<ReturnType<typeof listCampaignsV3>> = []
    try {
      // H.12 — explicit ENABLED+PAUSED snapshot: bounded (no archived bloat → no truncation) and lets
      // us treat any local active campaign absent from it as "no longer active on Amazon".
      list = await listCampaignsV3({ profileId: conn.profileId, region }, { states: ['ENABLED', 'PAUSED'] })
    } catch (e) {
      errors.push(`${conn.profileId}: ${(e as Error).message.slice(0, 160)}`)
      continue
    }
    if (!sampleShape && list[0]) sampleShape = list[0]

    const seen = new Set<string>()
    for (const c of list) {
      if (!c.campaignId) continue
      seen.add(c.campaignId)
      campaigns++
      const existing = await prisma.campaign.findFirst({
        where: { externalCampaignId: c.campaignId },
        // AX-ZD.4 — the comparison fields come along so drift can be detected
        // from the read we are already doing, at no extra API cost.
        select: {
          id: true, dynamicBidding: true, name: true, marketplace: true,
          status: true, dailyBudget: true, biddingStrategy: true, portfolioId: true,
          lastSyncedAt: true, lastSyncStatus: true,
        },
      })
      if (!existing) continue

      const data: Record<string, unknown> = {}
      const prevDynamic = (existing.dynamicBidding ?? {}) as Record<string, unknown>
      // dynamicBidding (strategy + placement bids) — merge so we don't drop keys
      // (e.g. our own maxBidChangePct guard) Amazon doesn't echo back.
      if (c.dynamicBidding && (c.dynamicBidding.strategy || c.dynamicBidding.placementBidding)) {
        data.dynamicBidding = { ...prevDynamic, ...c.dynamicBidding }
        if ((c.dynamicBidding.placementBidding?.length ?? 0) > 0) placementsFilled++
      }
      if (typeof c.budget?.budget === 'number') data.dailyBudget = c.budget.budget
      const st = c.state ? STATE_MAP[c.state.toLowerCase()] : undefined
      if (st) data.status = st
      const strat = mapStrategy(c.dynamicBidding?.strategy)
      if (strat) data.biddingStrategy = strat
      const tt = mapTargetingType(c.targetingType)
      if (tt) data.targetingType = tt

      // AX2.2 — stamp read-freshness for EVERY campaign Amazon returned, not
      // only the ones whose fields changed. Previously an unchanged campaign
      // was never touched, so "last synced" in the console actually meant
      // "last written" (observed: ES 5m, DE/FR ~2h, one IT campaign 34 DAYS)
      // and a perfectly-verified campaign looked stale.
      //
      // Deliberately does NOT touch lastSyncStatus: that is delivery truth, and
      // a successful read must never mask a failed bid write.
      // AX-ZD.3 — intended vs observed. This sync is a READ, and it overwrites
      // the local row with Amazon's values. That is right for a field nobody is
      // changing, and wrong for one with a write still in flight: the operator
      // sets a budget, this poll lands inside the 5-minute grace window, and
      // their change visibly reverts — then the write delivers and the next poll
      // flips it back. A read must never clobber an intent that has not been
      // delivered yet, so pending fields are dropped from the overwrite.
      //
      // The drift row is still recorded for them, classified WRITE_PENDING, so
      // the disagreement stays visible rather than being silently skipped.
      const pending = await pendingWriteFields('CAMPAIGN', existing.id, CAMPAIGN_DRIFT_FIELDS)

      // AX-ZD.4 — record what Amazon disagrees with BEFORE we overwrite it.
      // `data` holds only the fields Amazon actually reported, so a partial
      // response can never look like somebody blanking a value.
      try {
        driftFound += await recordCampaignDrift(existing, data, c, pending)
      } catch (e) {
        // Drift bookkeeping must never break the sync it rides on.
        logger.warn('[settings-sync] drift record failed', { campaignId: c.campaignId, error: (e as Error).message.slice(0, 120) })
      }

      const held = holdBackPendingFields(data, pending, prevDynamic)
      for (const k of Object.keys(data)) delete data[k]
      Object.assign(data, held)
      if (pending.size) {
        logger.info('[settings-sync] held back fields with an undelivered write', {
          campaignId: c.campaignId, fields: [...pending],
        })
      }

      const changed = Object.keys(data).length > 0
      data.settingsSyncedAt = new Date()
      try {
        await prisma.campaign.update({ where: { id: existing.id }, data })
        if (changed) updated++
      } catch (e) { errors.push(`update ${c.campaignId}: ${(e as Error).message.slice(0, 120)}`) }
    }
    // H.12 — archive local active campaigns this profile's list no longer returns (archived/deleted on Amazon).
    try { archived += await reconcileCampaignDeletions({ connMarketplace: conn.marketplace, seenExternalCampaignIds: seen, fetchOk: true }) }
    catch (e) { errors.push(`camp-del ${conn.profileId}: ${(e as Error).message.slice(0, 120)}`) }
  }

  logger.info('[settings-sync] done', { profiles: conns.length, campaigns, updated, placementsFilled, archived, driftFound, errors: errors.length })
  return { profiles: conns.length, campaigns, updated, placementsFilled, archived, driftFound, sampleShape, errors }
}

// Map one v3 record onto a non-destructive update patch (only present fields).
function patchFromV3(c: V3CampaignSettings, prevDynamic: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (c.dynamicBidding && (c.dynamicBidding.strategy || c.dynamicBidding.placementBidding)) {
    data.dynamicBidding = { ...((prevDynamic ?? {}) as Record<string, unknown>), ...c.dynamicBidding }
  }
  if (typeof c.budget?.budget === 'number') data.dailyBudget = c.budget.budget
  const st = c.state ? STATE_MAP[c.state.toLowerCase()] : undefined
  if (st) data.status = st
  const strat = mapStrategy(c.dynamicBidding?.strategy)
  if (strat) data.biddingStrategy = strat
  const tt = mapTargetingType(c.targetingType)
  if (tt) data.targetingType = tt
  return data
}

/** B (on-open) — refresh ONE campaign's settings live from Amazon. Resolves the
 *  campaign's account by marketplace, fetches just that campaign via the v3
 *  campaignIdFilter, and writes it through non-destructively. */
export async function syncOneCampaignSettings(campaignId: string): Promise<{ ok: boolean; placementBids?: number; error?: string }> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, externalCampaignId: true, marketplace: true, dynamicBidding: true } })
  if (!camp?.externalCampaignId) return { ok: false, error: 'no_external_id' }
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: camp.marketplace }, select: { profileId: true, region: true } })
  if (!conn) return { ok: false, error: 'no_connection_for_marketplace' }
  const region: AdsRegion = conn.region === 'NA' || conn.region === 'FE' ? (conn.region as AdsRegion) : 'EU'
  let list: V3CampaignSettings[] = []
  try { list = await listCampaignsV3({ profileId: conn.profileId, region }, { campaignIds: [camp.externalCampaignId] }) } catch (e) { return { ok: false, error: (e as Error).message.slice(0, 160) } }
  const c = list.find((x) => x.campaignId === camp.externalCampaignId) ?? list[0]
  if (!c) return { ok: false, error: 'not_found_on_amazon' }
  const data = patchFromV3(c, camp.dynamicBidding)
  if (Object.keys(data).length > 0) await prisma.campaign.update({ where: { id: camp.id }, data })
  return { ok: true, placementBids: c.dynamicBidding?.placementBidding?.length ?? 0 }
}
