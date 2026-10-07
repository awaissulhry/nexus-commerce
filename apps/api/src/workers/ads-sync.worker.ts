/**
 * AD.2 — BullMQ consumer for the ads-sync queue.
 *
 * Reads an OutboundSyncQueue row by id (from job.data.queueId), parses
 * its payload, and dispatches to ads-api-client's update* methods. In
 * sandbox mode these short-circuit; in live mode (AD.4) they call
 * Amazon Ads API after passing through ads-write-gate.
 *
 * Grace-period semantics: the mutation service enqueues jobs with a
 * 5-min delay. The worker re-checks syncStatus on entry; if the row
 * was CANCELLED during the grace window, we skip without calling the
 * API.
 *
 * Idempotency: jobId is "ads-sync-<queueRowId>" so a duplicate enqueue
 * for the same row collapses to one job (BullMQ deduplicates on jobId).
 */

import { type Job } from 'bullmq'
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import prisma from '../db.js'
import { claimEntityWrite, dispatchPayloadFromMutations, isLetGoWrite, isPersonEdit, isSuppressionWrite, putBackRefusedWrite, settleAdMutations, supersedeOlderWrites } from '../services/advertising/ads-mutation.service.js'
import { isRetryableSyncError } from '../services/advertising/ads-write-reconcile.service.js'
import { AD_SYNC_TYPES, ADS_STALE_INTENT_MS, classifyCrashedWrite } from '../services/ads-core/ad-mutation-state.js'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { isEntityGoneError, orphanReasonFrom } from '../services/ads-core/amazon-entity-gone.js'
import {
  updateCampaign,
  updateAdGroup,
  updateTarget,
  updateProductAd,
  updatePortfolio,
  archiveSpEntity,
  listCampaignsV3,
  adsMode,
  type CampaignPatch,
  type ClientContext,
  type SpArchiveEntity,
  type AdsRegion,
} from '../services/advertising/ads-api-client.js'
import {
  checkAdsWriteGate,
  logGateDeny,
  recordSuccessfulWrite,
  recordCampaignLiveWrite,
} from '../services/advertising/ads-write-gate.js'

interface AdsJobData {
  queueId: string
  syncType: string
}

interface AdMutationPayload {
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD' | 'PORTFOLIO'
  entityId: string
  externalId: string | null
  marketplace: string | null
  fieldChanges: Array<{ field: string; oldValue: string | null; newValue: string | null }>
  actor: string
  reason: string | null
}

/**
 * The money fields a payload can carry. 1a (CM-3) — only these are a spend value: a portfolio id is a long number
 * (Amazon's ids are numeric), so counting every numeric value made each portfolio move "worth" billions of cents and the
 * value cap refused it.
 */
const VALUE_FIELDS = new Set(['bid', 'defaultBid', 'dailyBudget', 'budgetAmount'])

/**
 * Estimate the spend impact of a payload for the write-gate value cap.
 * Conservative — picks the largest numeric newValue across the money fields.
 * Bid changes are cents per click (small); budget changes are EUR units
 * (need ×100). The worker uses this to gate value-cap denials.
 */
function estimatePayloadValueCents(payload: AdMutationPayload): number {
  let maxCents = 0
  for (const c of payload.fieldChanges) {
    if (c.newValue == null || !VALUE_FIELDS.has(c.field)) continue
    const n = Number(c.newValue)
    if (!Number.isFinite(n)) continue
    if (c.field === 'dailyBudget') {
      // Stored as EUR (Campaign.dailyBudget is Decimal(10,2) EUR units)
      maxCents = Math.max(maxCents, Math.round(n * 100))
    } else {
      // Bids stored as cents already.
      maxCents = Math.max(maxCents, Math.round(n))
    }
  }
  return maxCents
}

/**
 * Apex A.2a — resolve the owning campaign id for a queued mutation so the
 * write-gate can enforce the per-campaign live-write allowlist. Returns null
 * when the entity (or its parent chain) can't be found — the gate treats null
 * as a deny in live mode, so an unattributable write is never allowed through.
 */
/**
 * The campaign a write belongs to, and (W1-5) the ad group a bid lands in — the ad group itself for its default bid —
 * from the same read, so the gate holds the bid to the ads strategy of that ad group's products.
 */
async function resolveWriteScope(payload: AdMutationPayload): Promise<{ campaignId: string | null; adGroupId: string | null }> {
  const none = { campaignId: null, adGroupId: null }
  try {
    switch (payload.entityType) {
      case 'CAMPAIGN': {
        const c = await prisma.campaign.findUnique({ where: { id: payload.entityId }, select: { id: true } })
        return { campaignId: c?.id ?? null, adGroupId: null }
      }
      case 'AD_GROUP': {
        const g = await prisma.adGroup.findUnique({ where: { id: payload.entityId }, select: { campaignId: true } })
        return { campaignId: g?.campaignId ?? null, adGroupId: g ? payload.entityId : null }
      }
      case 'AD_TARGET': {
        const t = await prisma.adTarget.findUnique({
          where: { id: payload.entityId },
          select: { adGroupId: true, adGroup: { select: { campaignId: true } } },
        })
        return { campaignId: t?.adGroup?.campaignId ?? null, adGroupId: t?.adGroupId ?? null }
      }
      case 'PRODUCT_AD': {
        const a = await prisma.adProductAd.findUnique({
          where: { id: payload.entityId },
          select: { adGroupId: true, adGroup: { select: { campaignId: true } } },
        })
        return { campaignId: a?.adGroup?.campaignId ?? null, adGroupId: a?.adGroupId ?? null }
      }
      default:
        return none
    }
  } catch {
    return none
  }
}

/** True when a payload changes a bid — used to scope the daily-write counter. */
function isBidChange(payload: AdMutationPayload): boolean {
  return payload.fieldChanges.some((c) => c.field === 'bid')
}

function regionFor(marketplace: string | null): AdsRegion {
  // EU is overwhelmingly the right answer for Xavia. NA/FE only when
  // an AmazonAdsConnection explicitly carries that region.
  if (!marketplace) return 'EU'
  if (['US', 'CA', 'MX', 'BR'].includes(marketplace)) return 'NA'
  if (['JP', 'AU', 'SG', 'IN'].includes(marketplace)) return 'FE'
  return 'EU'
}

async function resolveProfileId(marketplace: string | null): Promise<string | null> {
  // In sandbox we use synthetic profile ids; in live we look up the
  // active AmazonAdsConnection for the marketplace.
  if (adsMode() === 'sandbox') {
    if (marketplace === 'DE') return 'SANDBOX-PROFILE-DE-002'
    return 'SANDBOX-PROFILE-IT-001'
  }
  if (!marketplace) return null
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace, isActive: true, mode: 'production' },
    select: { profileId: true },
  })
  return conn?.profileId ?? null
}

/** 1a (CM-1) — `Campaign.biddingStrategy` (the database enum) in the client's words; updateCampaign maps those to v3. */
const STRATEGY_FOR_CLIENT: Record<string, NonNullable<CampaignPatch['biddingStrategy']>> = {
  LEGACY_FOR_SALES: 'legacyForSales',
  AUTO_FOR_SALES: 'autoForSales',
  MANUAL: 'manual',
}

/** 1a (CM-2) — SP v3 takes a campaign end date as YYYY-MM-DD; Nexus queues the ISO instant of that day (UTC midnight). */
function amazonDate(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10)
}

function patchFromChanges(payload: AdMutationPayload): {
  state?: 'enabled' | 'paused' | 'archived'
  name?: string
  portfolioId?: string | null
  dailyBudget?: number
  defaultBid?: number
  bid?: number
  biddingStrategy?: CampaignPatch['biddingStrategy']
  endDate?: string | null
} {
  const out: Record<string, unknown> = {}
  for (const c of payload.fieldChanges) {
    // 1a (CM-2, CM-3) — a cleared end date ("never expire") and a cleared portfolio ("no portfolio") are changes too.
    // They were dropped here, so an empty PUT went out and was marked a success. Every other field needs a value.
    if (c.newValue == null || c.newValue === '') {
      if (c.field === 'endDate') out.endDate = null
      else if (c.field === 'portfolioId') out.portfolioId = null
      continue
    }
    if (c.field === 'status') {
      out.state = c.newValue.toLowerCase()
    } else if (c.field === 'name') {
      out.name = c.newValue
    } else if (c.field === 'portfolioId') {
      out.portfolioId = c.newValue
    } else if (c.field === 'dailyBudget') {
      out.dailyBudget = Number(c.newValue)
    } else if (c.field === 'defaultBid') {
      // Stored as cents in OutboundSyncQueue; Amazon expects EUR units.
      out.defaultBid = Number(c.newValue) / 100
    } else if (c.field === 'bid') {
      out.bid = Number(c.newValue) / 100
    } else if (c.field === 'biddingStrategy') {
      // 1a (CM-1) — never mapped, so a strategy change went out as an empty PUT, marked a success.
      const strategy = STRATEGY_FOR_CLIENT[String(c.newValue)]
      if (strategy) out.biddingStrategy = strategy
    } else if (c.field === 'endDate') {
      // 1a (CM-2) — never mapped either.
      const date = amazonDate(String(c.newValue))
      if (date) out.endDate = date
    }
  }
  return out
}

/**
 * 1a (CM-1) — the placement lanes Amazon holds for a campaign now, read through the gateway, or why they could not be.
 *
 * SP v3 keeps the bidding strategy and the placement percentages in ONE object, `dynamicBidding`, and the placement PUT
 * replaces the whole array. Whether a PUT carrying the strategy alone also resets the lanes is not written down, so the
 * strategy goes out with the lanes Amazon holds (as updatePlacementBidding reads them, G.4), never with Nexus's copy,
 * which can be up to 20 minutes old. No read, no write: the write fails (retried) and nothing changes on Amazon.
 */
async function currentPlacementLanes(
  ctx: ClientContext,
  externalCampaignId: string,
): Promise<Array<{ placement: string; percentage: number }> | { error: string }> {
  const notSent = 'bidding strategy not sent: Amazon\'s current placement percentages for this campaign could not be read, and sending the strategy without them could reset them'
  try {
    const current = (await listCampaignsV3(ctx, { campaignIds: [externalCampaignId] }))
      .find((x) => String(x.campaignId) === externalCampaignId)
    // SP v3 always reports `dynamicBidding` (it carries the strategy); `placementBidding` is left out when no lane is set.
    if (!current?.dynamicBidding) return { error: notSent }
    return (current.dynamicBidding.placementBidding ?? []).map((p) => ({ placement: p.placement, percentage: p.percentage }))
  } catch (err) {
    return { error: `${notSent} (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** AA-W2-13 — which SP v3 delete operation archives this entity; null for a negative (updateTarget routes its own). */
async function archiveEntityOf(payload: AdMutationPayload): Promise<SpArchiveEntity | null> {
  if (payload.entityType === 'CAMPAIGN') return 'campaign'
  if (payload.entityType === 'AD_GROUP') return 'adGroup'
  if (payload.entityType === 'PRODUCT_AD') return 'productAd'
  if (payload.entityType !== 'AD_TARGET') return null
  const t = await prisma.adTarget.findUnique({ where: { id: payload.entityId }, select: { kind: true, isNegative: true } })
  if (!t || t.isNegative) return null
  // DL.1 — product and auto targets live under /sp/targets, keywords under /sp/keywords.
  return t.kind === 'PRODUCT' || t.kind === 'AUTO' ? 'target' : 'keyword'
}

async function dispatchToAmazon(
  payload: AdMutationPayload,
  ctx: ClientContext,
  /**
   * AA-W2-13 — the queue row is a deliberate stop (its JSON carries `letsGo`: pause-ads, archive-ads), or a person's own
   * edit (isPersonEdit off its JSON, as the gate is handed it).
   */
  opts: { letsGo?: boolean; manual?: boolean } = {},
): Promise<{ ok: boolean; rawResponse: unknown; error: string | null }> {
  const patch = patchFromChanges(payload)
  if (!payload.externalId) {
    // Local-only entity (locally drafted, not yet pushed to Amazon).
    // For AD.2 we treat this as a no-op success — AD.4 wires the
    // create-campaign-from-draft flow.
    return { ok: true, rawResponse: { skipped: 'no_external_id' }, error: null }
  }
  try {
    // AA-W2-13 — an archive is Amazon's delete operation: no PUT archives a campaign, an ad group, a keyword, a target or
    // a product ad (ads-api-client.ts SP_V3_ARCHIVE). Sent so for a deliberate archive (archive-ads) and a person's own
    // (the Archive actions on the campaign screens, which went out as a PUT Amazon does not accept). A negative keeps
    // updateTarget's own delete route (5f). Every other write, and an engine's archive, goes out as before.
    if ((opts.letsGo || opts.manual) && patch.state === 'archived') {
      const entity = await archiveEntityOf(payload)
      if (entity) {
        const res = await archiveSpEntity(ctx, entity, payload.externalId)
        return { ok: res.ok, rawResponse: res.rawResponse, error: res.error ?? null }
      }
    }
    if (payload.entityType === 'CAMPAIGN') {
      let campaignPatch: CampaignPatch = patch
      // 1a (CM-1) — see currentPlacementLanes. Sandbox has no Amazon to read and sends nothing.
      if (patch.biddingStrategy && adsMode() === 'live') {
        const lanes = await currentPlacementLanes(ctx, payload.externalId)
        if ('error' in lanes) return { ok: false, rawResponse: null, error: lanes.error }
        if (lanes.length) campaignPatch = { ...patch, placementBidding: lanes }
      }
      const res = await updateCampaign(ctx, payload.externalId, campaignPatch)
      return { ok: res.ok, rawResponse: res.rawResponse, error: res.error ?? null }
    }
    if (payload.entityType === 'AD_GROUP') {
      const res = await updateAdGroup(ctx, payload.externalId, patch)
      return { ok: res.ok, rawResponse: res.rawResponse, error: res.error ?? null }
    }
    if (payload.entityType === 'AD_TARGET') {
      // DL.1 — the kind decides the endpoint: keyword ids live under /sp/keywords, product and
      // auto target ids under /sp/targets. One indexed read, negligible beside the HTTP call it
      // precedes, and it is what stops product/auto bid writes being rejected forever.
      // NEG.3 — `kind` alone is not enough. A NEGATIVE keyword is also kind=KEYWORD and its id
      // lives under /sp/negativeKeywords, not /sp/keywords. Selecting the two extra columns is
      // free on a read this query already makes.
      const t = await prisma.adTarget.findUnique({
        where: { id: payload.entityId },
        select: { kind: true, isNegative: true, negativeLevel: true },
      })
      const res = await updateTarget(ctx, payload.externalId, patch, {
        kind: t?.kind ?? null, isNegative: t?.isNegative ?? false, negativeLevel: t?.negativeLevel ?? null,
      })
      return { ok: res.ok, rawResponse: res.rawResponse, error: res.error ?? null }
    }
    if (payload.entityType === 'PRODUCT_AD') {
      const res = await updateProductAd(ctx, payload.externalId, { state: patch.state })
      return { ok: res.ok, rawResponse: res.rawResponse, error: res.error ?? null }
    }
    if (payload.entityType === 'PORTFOLIO') {
      // AX-IE.2 — budget fields travel as one object on the v3 portfolio API,
      // so they are rebuilt here from the flat field changes rather than passed
      // through patchFromChanges (which only knows campaign-shaped keys).
      const get = (f: string): string | undefined =>
        payload.fieldChanges.find((c) => c.field === f)?.newValue ?? undefined
      const amount = get('budgetAmount')
      const budget = amount !== undefined || get('budgetPolicy') || get('startDate') || get('endDate')
        ? {
            amount: amount !== undefined ? Number(amount) : undefined,
            currencyCode: get('budgetCurrencyCode'),
            policy: get('budgetPolicy'),
            startDate: get('startDate'),
            endDate: get('endDate'),
          }
        : undefined
      const res = await updatePortfolio(ctx, {
        portfolioId: payload.externalId,
        name: get('name'),
        budget: budget as Parameters<typeof updatePortfolio>[1]['budget'],
      })
      // 1a (CM-23) — Amazon's own answer (portfolios.error[]), not "ok" for every write.
      return {
        ok: res.ok,
        rawResponse: res.rawResponse ?? null,
        error: res.ok ? null : (res.error ?? 'Amazon refused the portfolio change'),
      }
    }
    return { ok: false, rawResponse: null, error: `unknown_entity_type:${payload.entityType}` }
  } catch (err) {
    return {
      ok: false,
      rawResponse: null,
      // 5b — a negative refused at the wire (5a: re-enabling a protected term, or one Nexus holds no copy of) gets the
      // same answer on every retry; "forbidden" makes isRetryableSyncError treat it as permanent, not retry it 3 times.
      error: err instanceof Error ? ((err as { code?: unknown }).code === 'negative_refused' ? `forbidden by Nexus: ${err.message}` : err.message) : String(err),
    }
  }
}

// A2 — stamp the LOCAL entity with the outcome of its live push, so an operator can see per
// keyword / ad-group / campaign whether the last write actually reached Amazon. Previously the
// worker only updated the OutboundSyncQueue row + counter, never the entity, so lastSyncedAt
// reflected only inbound READS — delivery was invisible (the bug that made "did it restore?"
// unanswerable). Best-effort: a stamp failure must never break the worker.
async function stampEntitySync(
  payload: AdMutationPayload,
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED',
  error: string | null,
): Promise<void> {
  const data = { lastSyncedAt: new Date(), lastSyncStatus: status, lastSyncError: error }

  // AX2.0 — record "Amazon says this is gone" so we stop regenerating the same
  // dead write forever, and clear the mark the moment a write succeeds again
  // (a re-created keyword self-heals without operator action).
  // DL.3 — a target's kind decides which endpoint legitimately owns it, so a "not found" from the
  // other endpoint must not be read as deletion. Only AD_TARGET has a kind; everything else keeps
  // the previous behaviour.
  // NEG.3 — the orphan decision needs the same third axis the routing does: a positive-shaped
  // miss against a NEGATIVE row is our routing fault, not Amazon's inventory.
  const targetRow = payload.entityType === 'AD_TARGET'
    ? await prisma.adTarget.findUnique({ where: { id: payload.entityId }, select: { kind: true, isNegative: true } })
    : null
  const gone = status === 'FAILED' && isEntityGoneError(error, { kind: targetRow?.kind ?? null, isNegative: targetRow?.isNegative ?? false })
  const orphanPatch = gone
    ? { orphanedAt: new Date(), orphanReason: orphanReasonFrom(error) }
    : status === 'SUCCESS'
      ? { orphanedAt: null, orphanReason: null }
      : {}

  try {
    switch (payload.entityType) {
      case 'CAMPAIGN': await prisma.campaign.update({ where: { id: payload.entityId }, data }); break
      case 'AD_GROUP': await prisma.adGroup.update({ where: { id: payload.entityId }, data: { ...data, ...orphanPatch } }); break
      case 'AD_TARGET': await prisma.adTarget.update({ where: { id: payload.entityId }, data: { ...data, ...orphanPatch } }); break
      case 'PRODUCT_AD': await prisma.adProductAd.update({ where: { id: payload.entityId }, data: { lastSyncedAt: data.lastSyncedAt } }); break
    }
    if (gone) {
      logger.warn('[ads-sync.worker] entity ORPHANED — Amazon no longer has it; further writes suppressed', {
        entityType: payload.entityType, entityId: payload.entityId, externalId: payload.externalId,
      })
    }
  } catch (e) { logger.warn('[ads-sync.worker] entity sync-stamp failed', { entityType: payload.entityType, entityId: payload.entityId, error: (e as Error).message }) }
}

async function processAdsSyncJob(job: Job<AdsJobData>): Promise<{ status: string; queueId: string }> {
  const { queueId } = job.data
  logger.debug('[ads-sync.worker] processing', { jobId: job.id, queueId })

  const row = await prisma.outboundSyncQueue.findUnique({
    where: { id: queueId },
  })
  if (!row) {
    logger.warn('[ads-sync.worker] queue row not found', { queueId })
    return { status: 'NOT_FOUND', queueId }
  }
  // Grace-period skip.
  if ((row.syncStatus as string) === 'CANCELLED') {
    logger.info('[ads-sync.worker] skipping cancelled', { queueId })
    return { status: 'CANCELLED', queueId }
  }
  if (row.syncStatus !== 'PENDING') {
    return { status: 'SKIPPED', queueId }
  }

  // AX-ZD.1e — serialise writes per entity. Amazon answers two concurrent writes
  // to one entity with HTTP 423 ConcurrentModificationException, and this worker
  // runs at concurrency 2. Defer rather than fail: the row stays PENDING with a
  // short hold and the drain picks it up, so nothing is lost and the operator's
  // change still lands. claimEntityWrite is a real atomic claim (transaction-
  // scoped advisory lock), not the check-then-act mitigation it replaced.
  const payloadForLock = row.payload as unknown as AdMutationPayload
  const claimed = !payloadForLock?.entityType || !payloadForLock?.entityId
    ? true // malformed payload: let the normal dispatch path reject it
    : await claimEntityWrite(payloadForLock.entityType, payloadForLock.entityId, queueId)
  if (!claimed) {
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: { holdUntil: new Date(Date.now() + SERIALISE_DEFER_MS) },
    })
    logger.info('[ads-sync.worker] deferred — another write is in flight on this entity', {
      queueId, entityType: payloadForLock.entityType, entityId: payloadForLock.entityId,
    })
    return { status: 'DEFERRED', queueId }
  }

  // 1a (CM-5) — a field that a newer write to the same entity replaced is not sent (supersedeOlderWrites). When
  // nothing is left, the row ends here: never sent, and visibly so. Best-effort: if the check fails, the row goes out
  // as it did before.
  const superseded = await supersedeOlderWrites(queueId).catch((err) => {
    logger.warn('[ads-sync.worker] supersede check failed; dispatching as queued', {
      queueId, error: err instanceof Error ? err.message : String(err),
    })
    return null
  })
  if (superseded?.typed && superseded.remaining === 0 && superseded.superseded.length) {
    const reason = `superseded: a newer write to ${superseded.superseded.join(', ')} replaced it before it was sent`
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: { syncStatus: 'CANCELLED', errorCode: 'ADS_SUPERSEDED', errorMessage: reason },
    })
    await prisma.advertisingActionLog
      .updateMany({ where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SUPERSEDED' } })
      .catch(() => { /* audit-update failure must not break the worker */ })
    logger.info('[ads-sync.worker] superseded — not sent', { queueId, fields: superseded.superseded })
    return { status: 'SUPERSEDED', queueId }
  }

  // The claim above already moved the typed rows to IN_FLIGHT — that IS the
  // exclusion token, so settling again here would be a redundant write.
  // W3-2 — the row itself is taken with a compare-and-set: a cancel (the staged tray, cancel-queued-ad-write) that
  // landed after the read above moved it to CANCELLED and put Nexus's copy back; an unconditional update here sent it
  // anyway. cancelPendingMutation cancels with the same compare-and-set, so exactly one of the two wins.
  const taken = await prisma.outboundSyncQueue.updateMany({
    where: { id: queueId, syncStatus: 'PENDING' },
    data: { syncStatus: 'IN_PROGRESS' },
  })
  if (taken.count === 0) {
    const now = await prisma.outboundSyncQueue.findUnique({ where: { id: queueId }, select: { syncStatus: true } })
    logger.info('[ads-sync.worker] not sent — the row changed before it was taken', { queueId, status: now?.syncStatus ?? null })
    return { status: now?.syncStatus === 'CANCELLED' ? 'CANCELLED' : 'SKIPPED', queueId }
  }

  // AX-ZD.1f — dispatch from the typed rows, which are now authoritative. The
  // JSON blob remains the fallback for rows enqueued before ZD.1, which have no
  // typed rows; dispatching nothing for those would silently drop a change.
  const typed = await dispatchPayloadFromMutations(queueId).catch(() => null)
  const payload = (typed ?? row.payload) as unknown as AdMutationPayload
  if (!typed) {
    logger.info('[ads-sync.worker] dispatching from the legacy JSON payload (pre-ZD.1 row)', { queueId })
  }
  const marketplace = payload?.marketplace ?? null

  // AD.4 — Two-key live-write gate. In sandbox mode the gate passes
  // through; in live mode it enforces env flag + per-connection
  // writesEnabledAt + value-cap.
  const payloadValueCents = estimatePayloadValueCents(payload)
  const { campaignId, adGroupId } = await resolveWriteScope(payload)
  // ADX A1 — hand the gate the field and intended value so Campaign.minBidCents /
  // maxBidCents can bind this write. A payload carries one field in the common case;
  // when it carries several we surface the bid field, which is the bounded one.
  const bidChange = payload.fieldChanges.find((c) => c.field === 'bid' || c.field === 'defaultBid')
  const intendedBidCents = bidChange?.newValue != null ? Number(bidChange.newValue) : null
  // AUTO.A7 — a budget change carries its intended value too, so the per-scope spend ceilings
  // can bind it. `dailyBudget` fieldChanges are EUR (Campaign.dailyBudget is Decimal EUR) — the
  // one ads money field that is not cents; the gate wants cents.
  const budgetChange = !bidChange ? payload.fieldChanges.find((c) => c.field === 'dailyBudget') : undefined
  const intendedBudgetCents = budgetChange?.newValue != null && Number.isFinite(Number(budgetChange.newValue))
    ? Math.round(Number(budgetChange.newValue) * 100)
    : null
  // 6.1 — and the budget it replaces: Nexus already wrote its own copy (N1), so the campaign row holds the new value.
  const previousBudgetCents = budgetChange?.oldValue != null && Number.isFinite(Number(budgetChange.oldValue))
    ? Math.round(Number(budgetChange.oldValue) * 100)
    : null
  const gate = await checkAdsWriteGate({
    marketplace,
    payloadValueCents,
    // 1a (CM-23) — a portfolio is not a campaign: resolveWriteScope answers null for it, and the gate refuses null as
    // "unattributable", so every queued portfolio write was refused in live mode. Left out (undefined), the portfolio
    // write is gated like the Portfolios screen's own push (updatePortfolioById): mode, connection and value cap.
    campaignId: payload.entityType === 'PORTFOLIO' ? undefined : campaignId,
    // W1-5 — the ads strategy's bid band is the one of this ad group's products.
    adGroupId,
    field: bidChange?.field ?? budgetChange?.field ?? payload.fieldChanges[0]?.field ?? null,
    // ACR.1.2b — the authority pins need EVERY field, not the one representative field the
    // A1 bounds want. A payload carrying both a bid and a budget change would otherwise be
    // judged against whichever one `field` happened to surface, so a budget pin would hold
    // on single-field payloads and silently miss the combined one.
    fields: payload.fieldChanges.map((c) => c.field),
    intendedValueCents: Number.isFinite(intendedBidCents ?? NaN) ? intendedBidCents : intendedBudgetCents,
    // ADX G1 — suppression drives bids to ~2¢ under the no-pause rule; a halt, a min bound
    // or a bids pin must not block it. 2.2 — `force` is read off the queue row's JSON, its
    // only record (the typed `payload` above has no such field, so this was always false),
    // and counts only when every value in the write goes down: restores and base-bid deltas
    // are forced too, and those can raise bids.
    // AA-W2-12 — and a deliberate pause lets go of spend the same way: the halt never holds it (isLetGoWrite). Read off
    // the same JSON; an enable, or a pause without the mark (a rule's, an engine's), is judged as before.
    isSuppression: isSuppressionWrite((row.payload as { force?: unknown } | null)?.force === true, payload.fieldChanges)
      || isLetGoWrite((row.payload as { letsGo?: unknown } | null)?.letsGo === true, payload.fieldChanges),
    // 1e (CM-10) — a person's own edit passes the account halt and autonomy OFF (nothing else). Read off the queue
    // row's JSON like `force` (its only record), and only with a `user:` actor.
    manual: isPersonEdit((row.payload as { manual?: unknown } | null)?.manual, payload.actor),
    // 3A — the person's "Send anyway" past his own limits, from the same JSON; the gate honours it only with `manual`.
    confirmOwnLimits: (row.payload as { confirmOwnLimits?: unknown } | null)?.confirmOwnLimits === true,
    // 6.1 — a budget schedule's give-back is recognised from the action log: who writes, the value it
    // replaces, and which queue row is this write's own (its log row is not part of its history).
    actor: payload.actor ?? null,
    previousValueCents: previousBudgetCents,
    queueId,
  })
  if (gate.allowed === false) {
    logGateDeny(
      { queueId, marketplace, payloadValueCents, campaignId, entityType: payload.entityType ?? null, entityId: payload.entityId ?? null },
      gate.reason,
      gate.deniedAt,
    )
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'SKIPPED',
        errorMessage: `[ADS-WRITE-GATE-DENY] ${gate.deniedAt}: ${gate.reason}`,
        errorCode: 'WRITE_GATE_DENIED',
        syncedAt: new Date(),
      },
    })
    // W4-12 — its action log says it was refused, as a superseded write's does: left PENDING, the change feed read it as
    // APPLIED (and undoable) although nothing reached Amazon.
    await prisma.advertisingActionLog
      .updateMany({ where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SKIPPED' } })
      .catch(() => { /* audit-update failure must not break the worker */ })
    // 4k — a refused write leaves no local change. Nexus wrote its own copy when the write was queued, so each refused
    // field still holding the refused value goes back to the value it replaced (putBackRefusedWrite); a newer change
    // stays. Inside the entity claim, before settling. Never fails the worker.
    await putBackRefusedWrite(payload).then(
      (r) => {
        if (r.restored.length || r.kept.length) {
          logger.info('[ads-sync.worker] refused write put back in Nexus', {
            queueId, entityType: payload.entityType, entityId: payload.entityId, restored: r.restored, kept: r.kept,
          })
        }
      },
      (err) => logger.warn('[ads-sync.worker] could not put back a refused write', {
        queueId, entityType: payload.entityType, entityId: payload.entityId, error: err instanceof Error ? err.message : String(err),
      }),
    )
    await settleAdMutations(queueId, 'SKIPPED', { error: `${gate.deniedAt}: ${gate.reason}` })
    await stampEntitySync(payload, 'SKIPPED', `${gate.deniedAt}: ${gate.reason}`)
    return { status: 'SKIPPED', queueId }
  }

  const profileId =
    gate.mode === 'live'
      ? gate.profileId
      : await resolveProfileId(marketplace)
  if (!profileId) {
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'FAILED',
        errorMessage: 'no_active_ads_connection_for_marketplace',
        errorCode: 'NO_CONNECTION',
        retryCount: { increment: 1 },
      },
    })
    await settleAdMutations(queueId, 'FAILED', { isDead: true, error: 'no_active_ads_connection_for_marketplace' })
    // W4-12 — and its action log says it was not sent, as a gate refusal's does.
    await prisma.advertisingActionLog
      .updateMany({ where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SKIPPED' } })
      .catch(() => { /* audit-update failure must not break the worker */ })
    // CM-17 — nothing reached Amazon: the value it replaced comes back, as below.
    await putBackRefusedWrite(payload).catch(() => { /* best-effort, as every put-back */ })
    return { status: 'FAILED', queueId }
  }

  const ctx: ClientContext = { profileId, region: regionFor(marketplace) }
  const result = await dispatchToAmazon(payload, ctx, {
    letsGo: (row.payload as { letsGo?: unknown } | null)?.letsGo === true,
    manual: isPersonEdit((row.payload as { manual?: unknown } | null)?.manual, payload.actor),
  })
  if (result.ok) {
    const localOnly = (result.rawResponse as { skipped?: string } | null)?.skipped // e.g. 'no_external_id' — NOTHING reached Amazon
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'SUCCESS',
        syncedAt: new Date(),
        errorMessage: null,
      },
    })
    // AX-ZD.1 — settle the typed rows. A local-only result pushed NOTHING to
    // Amazon, so the intent was abandoned, not applied; SKIPPED maps to
    // CANCELLED and keeps "APPLIED" meaning "Amazon accepted this".
    await settleAdMutations(queueId, localOnly ? 'SKIPPED' : 'SUCCESS', {
      error: localOnly ? `local-only: ${localOnly}` : null,
    })
    // AD.4 — mark the linked AdvertisingActionLog row as SUCCESS.
    await prisma.advertisingActionLog
      .updateMany({
        where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' },
        data: {
          amazonResponseStatus: 'SUCCESS',
          amazonResponseId:
            typeof (result.rawResponse as { documentId?: unknown })?.documentId === 'string'
              ? ((result.rawResponse as { documentId: string }).documentId)
              : null,
        },
      })
      .catch(() => {
        /* audit-update failure must not break the worker */
      })
    // A2/A3 — stamp the entity with the real outcome. A no_external_id result pushed NOTHING to
    // Amazon, so mark it SKIPPED and do NOT count it as a live write (the counter must mean
    // "reached Amazon", not merely "processed").
    await stampEntitySync(payload, localOnly ? 'SKIPPED' : 'SUCCESS', localOnly ? `local-only: ${localOnly}` : null)
    if (gate.mode === 'live' && !localOnly) {
      await recordSuccessfulWrite(marketplace)
      // Apex A.2a — count this against the campaign's daily live-write cap.
      if (isBidChange(payload)) await recordCampaignLiveWrite(campaignId)
    }
    return { status: localOnly ? 'SKIPPED' : 'SUCCESS', queueId }
  }
  // Failure path: bump retryCount; if at max, mark dead.
  const nextRetry = row.retryCount + 1
  /**
   * DL.2 — a write Amazon will never accept is dead on the FIRST failure.
   *
   * Retrying is only meaningful for transient conditions (429, 5xx, timeout). A 4xx logic
   * error — entity gone, malformed, unauthorised — returns the same answer every time, so
   * re-sending it just burns the remaining attempts and buries the real signal.
   *
   * This is what turned one routing bug into 198 failures in a week: every product/auto bid
   * write was rejected with entityNotFoundError, and each one still spent 3 attempts, every
   * 15 minutes, for six days. `isRetryableSyncError` already encoded the right rule — the
   * reconcile SWEEP used it to decide what to re-push, while the primary dispatch path that
   * creates the failures did not.
   *
   * The classifier gives unknown/empty errors the benefit of the doubt, so an unrecognised
   * failure keeps today's retry behaviour and this cannot make a transient fault terminal.
   */
  const permanent = !isRetryableSyncError(result.error)
  const terminal = permanent || nextRetry >= row.maxRetries
  if (permanent) {
    logger.warn('[ads-sync] permanent write rejection — not retrying', {
      queueId, entityType: payload.entityType, entityId: payload.entityId, attempt: nextRetry, error: result.error?.slice(0, 200),
    })
  }
  await prisma.outboundSyncQueue.update({
    where: { id: queueId },
    data: {
      syncStatus: terminal ? 'FAILED' : 'PENDING',
      isDead: terminal,
      diedAt: terminal ? new Date() : null,
      errorMessage: result.error,
      // A permanent rejection is a different diagnosis from a transient API error, and the
      // console filters on this code — keep them distinguishable.
      errorCode: permanent ? 'AMAZON_PERMANENT_REJECTION' : 'AMAZON_API_ERROR',
      retryCount: nextRetry,
      nextRetryAt: terminal ? null : new Date(Date.now() + Math.pow(2, nextRetry) * 60 * 1000),
    },
  })
  // AX-ZD.1 — a retryable transient is still in flight, so the typed rows stay
  // PENDING and keep suppressing drift on their fields; only a dead row is
  // terminal. Same split as the audit log below, for the same reason.
  await settleAdMutations(queueId, terminal ? 'FAILED' : 'PENDING', {
    isDead: terminal, error: result.error,
  })
  // AD.4 — mark the linked AdvertisingActionLog as FAILED only on
  // terminal failure (so retryable transients don't pollute the audit).
  if (terminal) {
    await prisma.advertisingActionLog
      .updateMany({
        where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' },
        data: { amazonResponseStatus: 'FAILED' },
      })
      .catch(() => {
        /* swallow */
      })
    await stampEntitySync(payload, 'FAILED', result.error) // A2 — surface the failure on the entity itself
    // CM-17 — Amazon rejected it for good, so Nexus shows the value it replaced again (as for a gate refusal above): field
    // by field, only where Nexus still holds the rejected value. An ad group's default bid has no sync to correct it. A
    // transient failure that ran out of retries keeps the value: the failed-write reconcile sweep sends it again.
    if (permanent) {
      await putBackRefusedWrite(payload).catch((err) => logger.warn('[ads-sync.worker] could not put back a rejected write', {
        queueId, entityType: payload.entityType, entityId: payload.entityId, error: err instanceof Error ? err.message : String(err),
      }))
    }
    /**
     * BID.S9 — a write that terminally failed must not wait to be discovered on page-load: the
     * 2026-07 phantom cuts sat undetected for 32 days because nothing said "Amazon refused this".
     * `warn`, so the 6h body-keyed dedupe applies — the body carries entityType+field+error but
     * NOT the entity id, so a routing bug rejecting 200 writes with one error is one notice, while
     * distinct errors still notify separately. Best-effort, never fails the settle.
     */
    const fields = [...new Set((payload.fieldChanges ?? []).map((c) => c.field))].join(', ') || 'unknown field'
    void import('../services/advertising/ads-automation-notify.service.js')
      .then(({ notifyAutomation }) => notifyAutomation({
        type: 'ads_write_failed',
        severity: 'warn',
        title: 'An Amazon write failed — the change did not land',
        body: `${payload.entityType} · ${fields} · ${(result.error ?? 'no error text').slice(0, 140)}`,
        href: fields.includes('bid')
          ? '/marketing/ads/rules-automation/bid#bid-activity'
          : '/marketing/ads/rules-automation/automations?view=ledger',
        meta: { queueId, entityType: payload.entityType, entityId: payload.entityId },
      }))
      .catch(() => { /* a notification failure never breaks settlement */ })
  }
  return { status: 'FAILED', queueId }
}

/** How long a deferred row waits before the drain retries it. Short: the
 *  blocking write is a single Amazon call, normally done in seconds. */
const SERIALISE_DEFER_MS = Number(process.env.NEXUS_ADS_SERIALISE_DEFER_MS ?? 20_000)

let worker: Worker | null = null

export function initializeAdsSyncWorker(): Worker {
  if (worker) {
    logger.warn('[ads-sync.worker] already initialized')
    return worker
  }
  logger.info('[ads-sync.worker] initializing')
  worker = new Worker('ads-sync', processAdsSyncJob, {
    connection: redis.connection,
    // Lower than outbound-sync's 5 — Amazon Ads API has stricter
    // per-account rate limits than SP-API.
    concurrency: 2,
  })
  worker.on('failed', (job, err) => {
    logger.warn('[ads-sync.worker] job failed', {
      jobId: job?.id,
      queueId: job?.data?.queueId,
      error: err.message,
    })
  })
  worker.on('error', (err) => {
    logger.error('[ads-sync.worker] worker error', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  return worker
}

export function stopAdsSyncWorker(): void {
  if (worker) {
    void worker.close()
    worker = null
  }
}

// Exposed for tests + the manual /api/advertising/cron/drain-ads-sync
// endpoint (mounts under cron triggers).
// AX-IE.2 — every ads row type dispatches on these rails: Redis is down on prod, so the drain IS the dispatch path.
// 1a (CM-4) — the shared list (ad-mutation-state.ts); this copy lacked rename and portfolio moves, so those were
// never sent, retried after a failure, picked up after a defer or reclaimed after a crash.
const AD_SYNC_TYPE_LIST: string[] = [...AD_SYNC_TYPES]

/**
 * AX-ZD.1 — reclaim ad writes orphaned by a crashed dispatch.
 *
 * The OutboundSyncQueue janitor sweeps exactly this class of row but skips
 * AD_* types, on the stated grounds that ads rows are "owned by the dedicated
 * ads-sync drain and have their own lifecycle". They were not: this drain only
 * ever selected `syncStatus: 'PENDING'`, so an ad row that died in IN_PROGRESS
 * had no owner at all. Measured on prod 2026-07-28: two stuck rows, the oldest
 * IN_PROGRESS for 26 days with no error and no retry — an operator's bid change
 * that silently never landed and surfaced nowhere, because isDead=false keeps it
 * out of the Dead Letters tab too. This makes the janitor's assumption true.
 *
 * A stale intent is DEAD-LETTERED, not retried. That is the deliberate
 * difference from the janitor's generic reclaim: re-dispatching a 26-day-old bid
 * would push a number the operator chose last month onto a live campaign
 * spending money today. The janitor applies the same reasoning to stale PENDING
 * rows ("intent has long been superseded"), and it matters more here, not less.
 * Dead-lettering makes it visible instead of silently applying or silently
 * dropping it.
 */
export async function reclaimCrashedAdWrites(
  now: Date = new Date(),
): Promise<{ reclaimed: number; deadLettered: number }> {
  // RECLAIM window is shared with the janitor — "has this dispatch crashed" is
  // the same question everywhere. STALENESS is not: see ADS_STALE_INTENT_MS.
  const { RECLAIM_IN_PROGRESS_AFTER_MS } = await import('../jobs/outbound-queue-janitor.job.js')

  // The stuck set is inherently tiny, so classify per row rather than encoding
  // the decision in query filters where it cannot be tested.
  const stuck = await prisma.outboundSyncQueue.findMany({
    where: { syncType: { in: AD_SYNC_TYPE_LIST }, syncStatus: 'IN_PROGRESS' },
    select: { id: true, createdAt: true, updatedAt: true },
    take: 500,
  })
  const thresholds = {
    reclaimAfterMs: RECLAIM_IN_PROGRESS_AFTER_MS,
    staleAfterMs: ADS_STALE_INTENT_MS,
  }
  const stale = stuck.filter((r) => classifyCrashedWrite(r, thresholds, now) === 'DEAD_LETTER')
  const fresh = stuck.filter((r) => classifyCrashedWrite(r, thresholds, now) === 'RECLAIM')

  if (stale.length) {
    const reason = 'ads-drain: crashed mid-dispatch and the intent is now stale — not re-applied'
    await prisma.outboundSyncQueue.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: {
        syncStatus: 'FAILED', isDead: true, diedAt: now,
        errorCode: 'ADS_STALE_IN_PROGRESS', errorMessage: reason,
      },
    })
    for (const r of stale) await settleAdMutations(r.id, 'FAILED', { isDead: true, error: reason })
    logger.warn('[ads-sync.worker] dead-lettered stale IN_PROGRESS ad writes', { count: stale.length })
    // BID.S9 — one summarised notice per sweep, not one per row: the count is the story here.
    void import('../services/advertising/ads-automation-notify.service.js')
      .then(({ notifyAutomation }) => notifyAutomation({
        type: 'ads_write_failed',
        severity: 'warn',
        title: 'Staged ad writes expired unsent',
        body: `${stale.length} write${stale.length === 1 ? '' : 's'} crashed mid-dispatch and went stale — dead-lettered, not re-applied.`,
        href: '/marketing/ads/rules-automation/automations?view=ledger',
        meta: { count: stale.length },
      }))
      .catch(() => { /* best-effort */ })
  }

  if (fresh.length) {
    await prisma.outboundSyncQueue.updateMany({
      where: { id: { in: fresh.map((r) => r.id) } },
      data: {
        syncStatus: 'PENDING',
        errorCode: 'ADS_RECLAIMED',
        errorMessage: 'ads-drain: reclaimed stale IN_PROGRESS (dispatch crashed or timed out)',
      },
    })
    // Back to PENDING means back in flight, so the typed rows must follow or
    // the drift check would treat a live write as finished.
    for (const r of fresh) await settleAdMutations(r.id, 'PENDING')
    logger.info('[ads-sync.worker] reclaimed crashed ad writes', { count: fresh.length })
  }
  return { reclaimed: fresh.length, deadLettered: stale.length }
}

/**
 * 1a (CM-4) — a PENDING ad write older than ADS_STALE_INTENT_MS is dead-lettered, never sent.
 *
 * The rule reclaimCrashedAdWrites applies to a crashed write, for the same reason: a write pushes the value decided
 * when it was queued, and a day later that is not a decision anybody is making. A healthy write is sent within
 * minutes (5-minute grace, retries after 2 and 4 minutes), so only a stuck row is this old. It matters now because
 * rename and portfolio-move rows join the drain: nothing sent them before, so any still PENDING would otherwise apply
 * an old rename or portfolio move today, over whatever was changed since. Dead-lettered rows stay visible.
 */
export async function expireStalePendingAdWrites(now: Date = new Date()): Promise<number> {
  const stale = await prisma.outboundSyncQueue.findMany({
    where: {
      syncType: { in: AD_SYNC_TYPE_LIST },
      syncStatus: 'PENDING',
      createdAt: { lt: new Date(now.getTime() - ADS_STALE_INTENT_MS) },
    },
    select: { id: true },
    take: 500,
  })
  if (!stale.length) return 0
  const ids = stale.map((r) => r.id)
  const reason = 'ads-drain: queued more than a day ago and never sent — the intent is stale, not applied'
  await prisma.outboundSyncQueue.updateMany({
    where: { id: { in: ids }, syncStatus: 'PENDING' },
    data: { syncStatus: 'FAILED', isDead: true, diedAt: now, errorCode: 'ADS_STALE_PENDING', errorMessage: reason },
  })
  for (const id of ids) await settleAdMutations(id, 'FAILED', { isDead: true, error: reason })
  await prisma.advertisingActionLog
    .updateMany({ where: { outboundQueueId: { in: ids }, amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'FAILED' } })
    .catch(() => { /* audit-update failure must not stop the drain */ })
  logger.warn('[ads-sync.worker] dead-lettered stale PENDING ad writes', { count: ids.length })
  void import('../services/advertising/ads-automation-notify.service.js')
    .then(({ notifyAutomation }) => notifyAutomation({
      type: 'ads_write_failed',
      severity: 'warn',
      title: 'Queued ad writes expired unsent',
      body: `${ids.length} write${ids.length === 1 ? '' : 's'} waited more than a day without being sent — dead-lettered, not applied.`,
      href: '/marketing/ads/rules-automation/automations?view=ledger',
      meta: { count: ids.length },
    }))
    .catch(() => { /* best-effort */ })
  return ids.length
}

export async function drainAdsSyncOnce(limit = 50): Promise<{
  processed: number
  reclaimed: number
  deadLettered: number
  results: Array<{ status: string; queueId: string }>
}> {
  const swept = await reclaimCrashedAdWrites().catch((err) => {
    // Reclaim is maintenance; a failure here must not stop the drain from
    // dispatching the writes that are ready.
    logger.warn('[ads-sync.worker] reclaim failed; draining anyway', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { reclaimed: 0, deadLettered: 0 }
  })
  const expired = await expireStalePendingAdWrites().catch((err) => {
    logger.warn('[ads-sync.worker] stale-pending sweep failed; draining anyway', {
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  })
  const now = new Date()
  const candidates = await prisma.outboundSyncQueue.findMany({
    where: {
      syncType: { in: AD_SYNC_TYPE_LIST },
      syncStatus: 'PENDING',
      AND: [
        { OR: [{ holdUntil: null }, { holdUntil: { lte: now } }] },
        // 1a (CM-5) — a write that failed with a retryable error waits for its backoff (2^n minutes). The drain read
        // only holdUntil, so it was resent the next minute, and could land after a newer write to the same field.
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
      ],
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
    select: { id: true, syncType: true },
  })
  const results: Array<{ status: string; queueId: string }> = []
  for (const c of candidates) {
    const fakeJob = { id: `manual-${c.id}`, data: { queueId: c.id, syncType: c.syncType } } as unknown as Job<AdsJobData>
    results.push(await processAdsSyncJob(fakeJob))
  }
  return { processed: results.length, reclaimed: swept.reclaimed, deadLettered: swept.deadLettered + expired, results }
}
