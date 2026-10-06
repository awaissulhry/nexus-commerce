import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * AX.4 — Amazon Ads CREATE service (campaigns / ad groups / keywords /
 * product ads). Local-first: writes the local Prisma row immediately
 * (so the cockpit reflects it), and — when the write gate allows — calls
 * the v3 SP POST create and stores the returned external id. Sandbox
 * short-circuits inside ads-api-client (returns a generated sb- id), so
 * the full flow exercises end-to-end without touching the live account.
 * Every create writes an AdvertisingActionLog audit row.
 *
 * Creates intentionally skip the 5-min grace window (unlike updates) — a
 * created entity has no "previous value" to revert to; the local row is
 * the source of truth and a follow-up pause/archive handles unwind.
 */

import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { CHANNEL_SKU_LISTING_SELECT } from '../listings/channel-sku.js'
import { liveChannelSku } from '../listings/channel-sku.pure.js'
import { listingAccounts, productForChannelSkuOnAccounts } from '../listings/listing-sku-holders.js'
import { sbAdTypeNotice, sbCreativeProblems } from '../ads-core/sb-ad-types.js'
import {
  createCampaign, createAdGroup, createKeyword, createProductAd,
  createTarget, createSdTarget, createSbAd, updateCampaign,
  listNegativeKeywords, listAdGroupsV3, listCampaignsServing, listCampaignsV3,
  createSdCampaign, createSbCampaign, createSdAdGroup, createSdProductAd, createSbAdGroup, listSbAds, createSbKeyword,
  listKeywords, listSbKeywords, adsMode, CREATE_NO_ID, sbAdCreateRequest, v3ErrorText, listTargets, updateTarget, ALL_STATES,
  type AdsRegion,
} from './ads-api-client.js'
import { CAMPAIGN_NOT_ON_AMAZON } from './launch-outcome.js'
import { AUTO_CLAUSE_LABEL, autoClauseFromSpelling, autoClauseOf, type AutoClause } from '../ads-core/ads-blueprint.js'
import { mergeOntoAmazonPlacements } from './ads-placement-math.js'
import { sdExpressionValue, sdTargetExpression } from './sd-target-expression.js'
import { patchDynamicBidding } from './dynamic-bidding-write.js'
import { checkAdsWriteGate, type GateContext, type GateDecision } from './ads-write-gate.js'
import { createIdentity, withCreateClaim } from './ads-create-claim.js'
import { adsAccountTimeZone } from './ads-market-time.js'
import { packEvidence, type AdWriteEvidence } from './ads-evidence.js'
import { marketCurrency } from '../pim/market-currency.js'
import { readScheduleMembers, releaseScheduleMembers, type ReleaseReport } from './rank-release.service.js'
import { isPersonCreate, isPersonEdit } from './ads-mutation.service.js'
import { AD_PRODUCT_UNSUPPORTED, SPONSORED_PRODUCTS, adProductOf, adProductRefusal } from '@nexus/shared/ads-ad-product'
import { campaignNameKey } from '@nexus/shared/ads-campaign-name'
// 5b — every negative this file writes goes through the one negative write service.
import { mirrorNegativeKeyword, pushLocalNegative, writeNegativeKeyword, writeNegativeProductTarget, type NegativeWriteResult } from './ads-negative-kw.service.js'

/**
 * The currency a new campaign's budget is in: its market's (`Marketplace.currency`) — Amazon reads the number it is
 * sent in the marketplace's own currency, so a UK budget is pounds. Every create used to leave the schema default (EUR)
 * on every market. A market with no currency configured keeps that default, as before (nothing else changes for it).
 */
async function newCampaignCurrency(marketplace: string): Promise<string | null> {
  try {
    return await marketCurrency('AMAZON', marketplace)
  } catch {
    return null
  }
}

/**
 * CM-8 — what a person's add from a screen did (`requireAmazon: true`, the create routes). Before this an add said
 * "added" when nothing reached Amazon: a refused or failed create still wrote its row, and the row then answered every
 * re-add as "already there". Now `ok` means Amazon holds it (its id is on the row). A refused or failed add leaves
 * nothing in Nexus and says why, in the gate's or Amazon's words. A campaign or ad group that is not on Amazon yet
 * keeps the row as a draft (`local`), for the launch repair to send, as a negative does (5b). A row Nexus holds without
 * an Amazon id is not "already there": the add sends it. Every other caller (launches, harvest, rules, the bulk sheet)
 * passes nothing and keeps its behaviour; the fields below are extra for them.
 */
export type PersonAddOutcome = 'created' | 'already_existed' | 'local' | 'refused' | 'failed'
export interface PersonAddResult { ok?: boolean; outcome?: PersonAddOutcome; reason?: string | null }
/** W2-A — why a create did not reach Amazon: the gate / connection refused it, or Amazon (or the call) failed it. */
export interface NotSent { outcome: 'refused' | 'failed'; reason: string }
export const NOT_ON_AMAZON_YET = 'The campaign or ad group is not on Amazon yet, so this was saved in Nexus only. It is sent when the campaign structure is pushed to Amazon.'
const gateReason = (gate: GateDecision): string => (gate as Extract<GateDecision, { allowed: false }>).reason ?? 'the write gate refused it'
const personAdd = (outcome: PersonAddOutcome, reason: string | null = null): PersonAddResult => ({
  ok: outcome === 'created' || outcome === 'already_existed', outcome, reason,
})

/**
 * CM-29 / CC-30 — the profile a create goes to is the write gate's own answer (`adsProfileFor` via
 * `adsClientContextFor`). It used to be `AmazonAdsConnection.findFirst({ marketplace, isActive })` while the gate
 * approved the profile from `ConnectionScope`: if the two ever disagreed, a create went to a profile the gate had not
 * approved. One resolver, one order, one answer.
 */
async function resolveCtx(marketplace: string): Promise<{ profileId: string; region: AdsRegion } | null> {
  const { adsClientContextFor } = await import('./ads-profile-resolver.js')
  return adsClientContextFor(marketplace)
}

/**
 * CM-20 — what an add tells the write gate besides the market: the same campaign rules an edit of the same thing obeys.
 *
 * Adds used to ask the gate with the market alone, so the campaign's live-write allowlist, its pins and bid bounds and
 * Amazon's bid range were never checked when a keyword, target, product ad or ad group was ADDED to an existing campaign
 * — though the same keyword's next bid edit was. Now an add names its campaign, the field and the value, exactly as the
 * edit does. A person's own add (`manual`, isPersonCreate) passes the halt (wave 1e) and — Owner decided A, 2026-10-06 —
 * the allowlist and pins, which stop engines, rules and sweeps only; Amazon's range and the bounds still bind him.
 *
 * `creationFlow` — the campaign was created a moment ago in this same launch (the builders, AI Goal, Replicate): it is
 * not named, as for the launch's negatives (5b), so a launch is never refused by the allowlist or by a bid policy (his
 * policies are warnings on the review step, CC-14). Amazon's own bid range still binds: the field and value go along.
 *
 * Sponsored Brands and Display adds keep the market-only ask: they go to their own endpoints, and the gate's 6a check
 * (which refuses SB/SD *updates*, sent to Sponsored Products endpoints) must not refuse them.
 */
function addGateScope(
  campaign: { id: string; adProduct?: string | null; type?: string | null },
  input: { creationFlow?: boolean },
  bid: { field: 'bid' | 'defaultBid'; cents: number } | null,
): Pick<GateContext, 'campaignId' | 'field' | 'intendedValueCents'> {
  const product = adProductOf(campaign)
  if (product != null && product !== SPONSORED_PRODUCTS) return {}
  return {
    ...(input.creationFlow ? {} : { campaignId: campaign.id }),
    ...(bid ? { field: bid.field, intendedValueCents: bid.cents } : {}),
  }
}

/** CM-33 — the answer when the same add was still running elsewhere after the claim's wait. */
const SAME_ADD_RUNNING = 'The same item is being added right now from another tab or process. Wait a moment, then check the list: it was not sent twice.'

/**
 * HX.1 — the audit row for a local ads operation.
 *
 * `status` used to be hardcoded 'SUCCESS'. That was wrong for any caller that pushes to Amazon
 * inline and can observe the push failing — most visibly updatePlacementBidding, which computes
 * `lastSyncStatus: 'FAILED'` and then logged the same write as a success. Every audit row is read
 * downstream as evidence that a change landed, so a hardcoded SUCCESS is worse than no row at all.
 *
 * Callers that only touch local state keep the default; callers that attempt a live push pass what
 * actually happened.
 */
async function audit(actionType: string, entityType: string, entityId: string, payloadAfter: object, userId?: string, payloadBefore: object = {}, status: 'SUCCESS' | 'FAILED' | 'PENDING' = 'SUCCESS', evidence?: AdWriteEvidence | null, changeSetId?: string | null) {
  await prisma.advertisingActionLog.create({
    // ADX A2 — `evidence` carries WHY. packEvidence() returns null rather than {} so an
    // empty object never masquerades as captured reasoning.
    // MCP full control A6 — `changeSetId` (optional, AdvertisingActionLog.executionId) joins the row to a change set,
    // so an approved request's placement write is found by its approval; absent for every other caller.
    data: { userId: userId ?? null, actionType, entityType, entityId, payloadBefore, payloadAfter, amazonResponseStatus: status, evidence: (packEvidence(evidence) ?? undefined) as never, ...(changeSetId ? { executionId: changeSetId } : {}) },
  }).catch(() => {})
}

export interface NewCampaign {
  name: string; type: 'SP' | 'SB' | 'SD'; marketplace: string
  targetingType?: 'MANUAL' | 'AUTO'; dailyBudgetEur: number
  biddingStrategy?: 'legacyForSales' | 'autoForSales' | 'manual'; portfolioId?: string; userId?: string
  /** SD only. T00020 = contextual product/category, T00030 = audiences. */
  sdTactic?: 'T00020' | 'T00030'
  /** SB only. Brand Registry binding; resolved from an existing SB campaign when omitted. */
  brandEntityId?: string
  /**
   * ACR Stage 5 — start the campaign live.
   *
   * **Defaults per ad product, deliberately asymmetric.** SP keeps its existing behaviour
   * (born ENABLED): the five SP flows are wizards whose entire purpose is launching a
   * structure the operator just reviewed budget-by-budget, and GALE's 11 live campaigns
   * were launched that way. Silently flipping SP to PAUSED would break every one of them.
   *
   * SB and SD default to PAUSED. They are new paths with no reviewed-launch ritual behind
   * them yet, and the 19 existing SB/SD campaigns carry €1,040/day of standing budgets —
   * an accidental enable there is an accidental four-figure daily spend. The operator opts
   * in explicitly, per the standing rule that a creation flow goes live only when budgets
   * have been set deliberately.
   */
  startEnabled?: boolean
  /** Return the exact payload without calling Amazon. Nothing local is written either. */
  dryRun?: boolean
}

/**
 * ACR Stage 5 — the campaign create, routed to the ad product's OWN endpoint family.
 *
 * This function has accepted `type: 'SP' | 'SB' | 'SD'` since AX.4 and has always mapped it
 * onto the correct local `adProduct` column — while unconditionally calling `createCampaign`,
 * which is `/sp/campaigns`. An SB or SD create would therefore have produced a Sponsored
 * Products campaign on Amazon carrying an SB/SD name, and a local row confidently labelled
 * with an ad product that did not match the thing that was created. It was never hit only
 * because no UI offered SB or SD — precisely the gap Stage 5 exists to close.
 *
 * Same class of defect as the `/sp/*` verification trap in AX-VT.4: assuming one endpoint
 * family speaks for all three.
 */
/** W2-A (CC-3) — `reason`: why the campaign is not on Amazon (Amazon's words, the gate's, or no connection); null when it is. */
type CampaignCreateResult = { id: string; externalCampaignId: string | null; mode: string; dryRun?: unknown; reason?: string | null }
export async function createCampaignLocal(input: NewCampaign): Promise<CampaignCreateResult> {
  if (input.dryRun) return createCampaignOnce(input)
  // CC-24 / CM-33 — one campaign per name and market. Amazon refuses a second campaign with a name already in use, so
  // a double click, a second tab or a retry used to leave a local row with no Amazon id beside the real one. The claim
  // makes "is the name free?" and the create one step: the second create waits for the first and is then refused here.
  const market = normalizeMarketplaceCode(input.marketplace, '') || input.marketplace
  return withCreateClaim(createIdentity('campaign', market, input.name), async () => {
    const taken = await campaignNamedInMarket(input.marketplace, input.name)
    if (taken) throw new Error(`${market} already has a campaign named "${taken.name}", so nothing was created: give the new campaign another name.`)
    return createCampaignOnce(input)
  }, () => { throw new Error(`A campaign named "${input.name}" is being created in ${market} right now, so it was not created again.`) })
}

/** CC-13 / CM-33 — the campaign that already holds this name in the market (archived ones free their name, as on Amazon). */
export async function campaignNamedInMarket(marketplace: string, name: string): Promise<{ id: string; name: string } | null> {
  const wanted = name.trim()
  if (!wanted) return null
  const rows = await prisma.campaign.findMany({
    where: { marketplace, status: { not: 'ARCHIVED' }, name: { equals: wanted, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 5,
  })
  return rows.find((r) => campaignNameKey(r.name) === campaignNameKey(wanted)) ?? null
}

async function createCampaignOnce(input: NewCampaign): Promise<CampaignCreateResult> {
  const ctx = await resolveCtx(input.marketplace)
  // SP preserves its long-standing born-ENABLED behaviour; SB/SD are born PAUSED. See the
  // `startEnabled` docblock — this asymmetry is the point, not an oversight.
  const startEnabled = input.startEnabled ?? (input.type === 'SP')
  const state: 'enabled' | 'paused' = startEnabled ? 'enabled' : 'paused'
  let externalId: string | null = null, mode = 'local'
  let dryRunPayload: unknown
  // W2-A (CC-3) — why nothing reached Amazon. It used to be thrown away: a refused create was stored ENABLED, PENDING and
  // logged SUCCESS, and looked like a live campaign that nothing could push.
  let notSent: string | null = ctx ? null : `No active Amazon Ads connection for ${input.marketplace}, so nothing was sent to Amazon.`

  // SB cannot be created without a Brand Registry binding. Rather than fail late inside
  // Amazon's error array, resolve it from an existing SB campaign and fail here if absent.
  // Scoped to the SAME marketplace on purpose: a brand entity is a per-marketplace Brand
  // Registry binding, so borrowing DE's entity for an IT campaign is not a fallback, it is a
  // wrong answer. Caught by the Stage 5 dry run, which resolved a DE entity for an IT create.
  let brandEntityId = input.brandEntityId
  if (input.type === 'SB' && !brandEntityId) {
    const sibling = await prisma.campaign.findFirst({
      where: { adProduct: 'SPONSORED_BRANDS', marketplace: input.marketplace, brandEntityId: { not: null } },
      select: { brandEntityId: true },
    })
    brandEntityId = sibling?.brandEntityId ?? undefined
    if (!brandEntityId) throw new Error(`SB campaigns need a brandEntityId and none could be resolved from an existing SB campaign in ${input.marketplace} — check Brand Registry for that marketplace`)
  }

  if (ctx) {
    // CC-14 — a Sponsored Products budget is judged against Amazon's range in the market, as a budget edit is.
    const budgetCents = Math.round(input.dailyBudgetEur * 100)
    const gate = await checkAdsWriteGate({ marketplace: input.marketplace, payloadValueCents: budgetCents, ...(input.type === 'SP' ? { field: 'dailyBudget', intendedValueCents: budgetCents } : {}) })
    if (gate.allowed || input.dryRun) {
      const common = { name: input.name, dailyBudget: input.dailyBudgetEur, state, portfolioId: input.portfolioId, dryRun: input.dryRun }
      // CC-26 — SB and SD send a start date: the day in the account's own time zone, not the UTC day.
      const timeZone = input.type === 'SP' ? null : await startDateTimeZone(ctx.profileId, input.marketplace)
      const r = input.type === 'SD'
        ? await createSdCampaign(ctx, { ...common, tactic: input.sdTactic ?? 'T00020', timeZone })
        : input.type === 'SB'
          ? await createSbCampaign(ctx, { ...common, brandEntityId: brandEntityId!, timeZone })
          // AX-VT.1 — portfolioId travels with the create. It used to be collected by
          // every builder, stored on the local row below, and dropped right here.
          : await createCampaign(ctx, { ...common, targetingType: input.targetingType ?? 'MANUAL', biddingStrategy: input.biddingStrategy })
      if (r.mode === 'dry-run') dryRunPayload = r.rawResponse
      else {
        externalId = r.externalId; mode = r.mode
        if (!externalId) notSent = campaignRefusalText(r)
      }
    } else notSent = `Not sent to Amazon: ${gateReason(gate)}`
  }

  // A dry run must not leave a local row behind — that is the whole point of asking first.
  if (input.dryRun) {
    return { id: '', externalCampaignId: null, mode: 'dry-run', dryRun: dryRunPayload ?? { note: 'no active ads connection for this marketplace; nothing would be sent' } }
  }

  const adProduct = { SP: 'SPONSORED_PRODUCTS', SB: 'SPONSORED_BRANDS', SD: 'SPONSORED_DISPLAY' }[input.type]
  const currency = await newCampaignCurrency(input.marketplace)
  const campaign = await prisma.campaign.create({
    data: {
      name: input.name, type: input.type, adProduct,
      ...(currency ? { dailyBudgetCurrency: currency } : {}),
      status: startEnabled ? 'ENABLED' : 'PAUSED',
      marketplace: input.marketplace,
      externalCampaignId: externalId, dailyBudget: input.dailyBudgetEur, biddingStrategy: (input.biddingStrategy === 'autoForSales' ? 'AUTO_FOR_SALES' : input.biddingStrategy === 'manual' ? 'MANUAL' : 'LEGACY_FOR_SALES'),
      portfolioId: input.portfolioId || null,
      ...(brandEntityId ? { brandEntityId } : {}),
      // CC-12 — an SD campaign keeps its tactic, so its ad group is created with the same one (see createAdGroupLocal).
      ...(input.type === 'SD' ? { tactic: input.sdTactic ?? 'T00020' } : {}),
      // CC-27 — the Sponsored Products targeting type this create asked Amazon for (the same value `createCampaign`
      // sends). The list, the export and the receipt showed it blank until the settings sync read it back.
      ...(input.type === 'SP' ? { targetingType: input.targetingType ?? 'MANUAL' } : {}),
      // W2-A (CC-3) — a campaign Amazon does not hold is marked FAILED with the reason (the delivery column shows it), not
      // PENDING as if a push were on its way: no path pushes a campaign that has no Amazon id.
      startDate: new Date(),
      ...(externalId
        ? { lastSyncStatus: 'SUCCESS' as const }
        : { lastSyncStatus: 'FAILED' as const, lastSyncedAt: new Date(), lastSyncError: notSent ?? CAMPAIGN_NOT_ON_AMAZON }),
    },
  })
  await audit('create_campaign', 'CAMPAIGN', campaign.id, { name: input.name, type: input.type, externalId, mode, state, reachedAmazon: externalId != null, ...(externalId ? {} : { error: notSent ?? CAMPAIGN_NOT_ON_AMAZON }) }, input.userId, {}, externalId ? 'SUCCESS' : 'FAILED')
  logger.info('[AX.4] createCampaignLocal', { id: campaign.id, type: input.type, externalId, mode, state, ...(externalId ? {} : { notSent }) })
  return { id: campaign.id, externalCampaignId: externalId, mode, reason: externalId ? null : (notSent ?? CAMPAIGN_NOT_ON_AMAZON) }
}

/** CC-26 — the zone a Sponsored Brands / Display start date is computed in (see ads-market-time.ts); UTC when unknown, said in the log. */
async function startDateTimeZone(profileId: string, marketplace: string): Promise<string | null> {
  const found = await adsAccountTimeZone(profileId, marketplace)
  if (!found) logger.warn('[CC-26] no time zone known for this ads account — start date sent as the UTC day', { profileId, marketplace })
  return found?.timeZone ?? null
}

/**
 * W2-A (CC-3) — Amazon's words when a campaign create came back without an id: SP v3 / SB v4 carry a per-item error
 * (`{ campaigns: { error: [...] } }`), SD answers a bare array whose item carries `code` + `description`.
 */
function campaignRefusalText(r: { rawResponse?: unknown; error?: string | null }): string {
  if (r.error) return r.error
  const v3 = v3ErrorText(r.rawResponse)
  if (v3) return `Amazon refused it: ${v3}`
  const first = Array.isArray(r.rawResponse) ? (r.rawResponse[0] as { code?: string; description?: string } | undefined) : undefined
  if (first && first.code && first.code !== 'SUCCESS') return `Amazon refused it: ${first.description || first.code}`
  return CAMPAIGN_NOT_ON_AMAZON
}

export interface NewAdGroup {
  campaignId: string; name: string; defaultBidEur: number; userId?: string; startEnabled?: boolean
  /** 1e — a person's own add from a screen or an upload (isPersonCreate): passes the halt and autonomy OFF. Set only by the routes. */
  manual?: boolean
  /** CM-8 — a person's add: no row unless Amazon took it (see PersonAddResult). */
  requireAmazon?: boolean
  /** CM-20 — part of the launch that created the campaign a moment ago (see addGateScope). */
  creationFlow?: boolean
}
export async function createAdGroupLocal(input: NewAdGroup): Promise<{ id: string | null; externalAdGroupId: string | null; /** W2-A — why it did not reach Amazon (every caller; a launch lists it). */ notSent?: NotSent | null } & PersonAddResult> {
  const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId }, select: { externalCampaignId: true, marketplace: true, adProduct: true, type: true, tactic: true } })
  if (!campaign) throw new Error('campaign not found')
  let externalId: string | null = null
  // ACR Stage 5 — same endpoint-family split as the campaign create above. An SD ad group
  // carries `tactic` and `creativeType` and must agree with its campaign's tactic; posting it
  // to `/sp/adGroups` would attach it to nothing.
  const isSd = campaign.adProduct === 'SPONSORED_DISPLAY'
  const isSb = campaign.adProduct === 'SPONSORED_BRANDS'
  /**
   * **Pause at the CAMPAIGN level only.** Amazon's entity states are hierarchical: a paused
   * campaign delivers nothing whatever its children say. So born-paused ad groups buy no extra
   * safety — they only create the trap where an operator enables the campaign and still sees
   * zero delivery, which reads as a broken feature rather than a second switch they never set.
   * Children are born ENABLED; the campaign is the gate.
   */
  const state: 'enabled' | 'paused' = (input.startEnabled ?? true) ? 'enabled' : 'paused'
  // CM-8 — why nothing reached Amazon, for a person's add (W2-A: and for a launch).
  let notSent: NotSent | null = null
  if (campaign.externalCampaignId && campaign.marketplace) {
    const ctx = await resolveCtx(campaign.marketplace)
    if (ctx) {
      const bidCents = Math.round(input.defaultBidEur * 100)
      const gate = await checkAdsWriteGate({ marketplace: campaign.marketplace, payloadValueCents: bidCents, manual: isPersonCreate(input.manual, input.userId), ...addGateScope({ id: input.campaignId, ...campaign }, input, { field: 'defaultBid', cents: bidCents }) })
      if (gate.allowed) {
        try {
          const r = isSd
            // CC-12 — the campaign's own tactic: an audiences (T00030) campaign's ad group used to go out as T00020.
            ? await createSdAdGroup(ctx, { externalCampaignId: campaign.externalCampaignId, name: input.name, defaultBid: input.defaultBidEur, state, tactic: campaign.tactic === 'T00030' ? 'T00030' : 'T00020' })
            // SB ad groups take no bid at all — see CreateSbAdGroupInput.
            : isSb
              ? await createSbAdGroup(ctx, { externalCampaignId: campaign.externalCampaignId, name: input.name, state })
              : await createAdGroup(ctx, { externalCampaignId: campaign.externalCampaignId, name: input.name, defaultBid: input.defaultBidEur, state })
          externalId = r.externalId
          if (!externalId) notSent = { outcome: 'failed', reason: (r as { error?: string | null }).error ?? CREATE_NO_ID }
        } catch (e) {
          if (!input.requireAmazon) throw e
          notSent = { outcome: 'failed', reason: (e as Error).message }
        }
      } else notSent = { outcome: 'refused', reason: gateReason(gate) }
    } else notSent = { outcome: 'refused', reason: `No active Amazon Ads connection for ${campaign.marketplace}.` }
  }
  if (input.requireAmazon && notSent) {
    logger.warn('[CM-8] ad group not created — nothing written', { campaignId: input.campaignId, outcome: notSent.outcome, reason: notSent.reason })
    return { id: null, externalAdGroupId: null, ...personAdd(notSent.outcome, notSent.reason) }
  }
  const ag = await prisma.adGroup.create({ data: { campaignId: input.campaignId, name: input.name, defaultBidCents: Math.round(input.defaultBidEur * 100), status: 'ENABLED', externalAdGroupId: externalId } })
  await audit('create_ad_group', 'AD_GROUP', ag.id, { name: input.name, externalId }, input.userId)
  return {
    id: ag.id, externalAdGroupId: externalId, notSent,
    ...(input.requireAmazon ? personAdd(externalId ? 'created' : 'local', externalId ? null : NOT_ON_AMAZON_YET) : {}),
  }
}

export interface NewKeyword {
  adGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bidEur: number; userId?: string
  /** 1e — a person's own add from a screen or an upload (isPersonCreate): passes the halt and autonomy OFF. Set only by the routes. */
  manual?: boolean
  /**
   * HV.4 (C9) — WHY this keyword was created. `audit()` has always accepted evidence and this
   * caller has always passed none, so every one of the 218 keywords the harvest engine wrote
   * carries a row with no reasoning. A harvest write has perfect evidence and now supplies it.
   * Optional, so every existing caller is unchanged.
   */
  evidence?: AdWriteEvidence | null
  /** CM-8 — a person's add: no row unless Amazon took it, and a row Amazon never took is sent (see PersonAddResult). */
  requireAmazon?: boolean
  /** CM-20 — part of the launch that created the campaign a moment ago (see addGateScope). */
  creationFlow?: boolean
}
/**
 * HP1 — the return says WHY a keyword did not reach Amazon, not just that it didn't.
 * `existed` = the idempotence branch fired (the row predates this call); `denied` = the write
 * gate refused (its own words); `pushError` = the Amazon call threw. All additive — every
 * pre-HP1 caller reads only `id`/`externalTargetId` and is unchanged. `promote_to_exact` reads
 * them to report a local-only create as the failure it is (the 209-of-218 mechanism).
 */
type KeywordCreateResult = { id: string | null; externalTargetId: string | null; existed?: boolean; denied?: { deniedAt: string; reason: string }; pushError?: string } & PersonAddResult
export async function createKeywordLocal(input: NewKeyword): Promise<KeywordCreateResult> {
  // CM-33 — the dedupe below and the create are one step: a second add of the same keyword waits for the first, then
  // finds its row ("already there") instead of sending it to Amazon twice.
  return withCreateClaim(createIdentity('keyword', input.adGroupId, input.matchType, input.keywordText), () => createKeywordOnce(input), () => ({
    id: null, externalTargetId: null, denied: { deniedAt: 'same_add_running', reason: SAME_ADD_RUNNING },
    ...(input.requireAmazon ? personAdd('refused', SAME_ADD_RUNNING) : {}),
  }))
}
async function createKeywordOnce(input: NewKeyword): Promise<KeywordCreateResult> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaignId: true, campaign: { select: { externalCampaignId: true, marketplace: true, adProduct: true, type: true } } } })
  if (!ag) throw new Error('ad group not found')
  /**
   * ACR Stage 5 — the FIFTH place `/sp/*` was hardcoded.
   *
   * SB is keyword-targeted (this account's SB ad groups are literally "Broad Only" / "Phrase
   * Only" / "Exact Only", carrying 95 keywords), so pushing an SB keyword to `/sp/keywords`
   * would attach it to nothing and answer 200 — the same silent no-op as the other four.
   *
   * SB keywords are on the LEGACY v3 API (`/sb/keywords`, `application/vnd.sbkeyword.v3+json`),
   * not `/sb/v4/*` — see `createSbKeyword`.
   */
  const isSbKeyword = ag.campaign?.adProduct === 'SPONSORED_BRANDS'
  // H.1 — idempotent. A positive keyword is uniquely identified by (ad group, match type, text).
  // Harvest rules run on a schedule and re-surface the same converting term every tick; return the
  // existing target instead of piling up duplicate rows (Amazon rejects the dup keyword too). Text
  // match is case-insensitive because Amazon keyword matching is.
  const sameKeyword = { adGroupId: input.adGroupId, kind: 'KEYWORD', isNegative: false, expressionType: input.matchType, expressionValue: { equals: input.keywordText, mode: 'insensitive' as const } }
  // CM-8 — for a person's add, a row Amazon holds is the one that answers "already there".
  const existing = (input.requireAmazon
    ? await prisma.adTarget.findFirst({ where: { ...sameKeyword, externalTargetId: { not: null } }, select: { id: true, externalTargetId: true } })
    : null) ?? await prisma.adTarget.findFirst({ where: sameKeyword, select: { id: true, externalTargetId: true } })
  if (existing && !input.requireAmazon) return { id: existing.id, externalTargetId: existing.externalTargetId, existed: true }
  if (existing) {
    if (existing.externalTargetId) return { id: existing.id, externalTargetId: existing.externalTargetId, existed: true, ...personAdd('already_existed') }
    if (!ag.externalAdGroupId || !ag.campaign?.externalCampaignId) return { id: existing.id, externalTargetId: null, existed: true, ...personAdd('local', NOT_ON_AMAZON_YET) }
    // CM-8 — Nexus holds it but Amazon never took it: send that row now (with the bid asked for), never "added".
    await prisma.adTarget.update({ where: { id: existing.id }, data: { bidCents: Math.round(input.bidEur * 100), status: 'ENABLED' } })
    const pushed = await pushExistingKeyword({ adTargetId: existing.id, userId: input.userId, evidence: input.evidence, manual: input.manual, creationFlow: input.creationFlow })
    return {
      id: existing.id, externalTargetId: pushed.externalTargetId, existed: true,
      ...(pushed.ok ? personAdd('created') : personAdd(pushed.outcome === 'refused' ? 'refused' : 'failed', pushed.refusal?.reason ?? pushed.error ?? null)),
    }
  }
  let externalId: string | null = null
  let denied: { deniedAt: string; reason: string } | undefined
  let pushError: string | undefined
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const bidCents = Math.round(input.bidEur * 100)
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: bidCents, manual: isPersonCreate(input.manual, input.userId), ...addGateScope({ id: ag.campaignId, ...ag.campaign }, input, { field: 'bid', cents: bidCents }) })
      if (gate.allowed) {
        const args = { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, keywordText: input.keywordText, matchType: input.matchType, bid: input.bidEur, state: 'enabled' as const }
        // HP1 — a throw used to abort the whole call with the local row unwritten and the reason
        // lost; the mirror is still written below and the caller gets the error to report.
        try {
          const r = isSbKeyword ? await createSbKeyword(ctx, args) : await createKeyword(ctx, args)
          externalId = r.externalId
          // CM-8 — no id is no keyword: Amazon's own reason (a 207 per-item error), else that no id came back.
          if (!externalId) pushError = (r as { error?: string | null }).error ?? CREATE_NO_ID
        } catch (e) { pushError = (e as Error).message }
      } else {
        const g = gate as { deniedAt?: string; reason?: string }
        denied = { deniedAt: g.deniedAt ?? 'gate', reason: g.reason ?? 'write gate refused' }
      }
    } else {
      denied = { deniedAt: 'connection', reason: `no ads connection context for ${ag.campaign.marketplace}` }
    }
  } else {
    denied = { deniedAt: 'ids', reason: 'the ad group or campaign has no Amazon ids to create under' }
  }
  // CM-8 — a person's add that did not reach Amazon leaves nothing behind (a draft campaign keeps its row).
  if (input.requireAmazon && !externalId && denied?.deniedAt !== 'ids') {
    logger.warn('[CM-8] keyword not created — nothing written', { adGroupId: input.adGroupId, deniedAt: denied?.deniedAt ?? null, reason: denied?.reason ?? pushError })
    return { id: null, externalTargetId: null, denied, pushError, ...personAdd(denied ? 'refused' : 'failed', denied?.reason ?? pushError ?? CREATE_NO_ID) }
  }
  const t = await prisma.adTarget.create({ data: { adGroupId: input.adGroupId, kind: 'KEYWORD', expressionType: input.matchType, expressionValue: input.keywordText, bidCents: Math.round(input.bidEur * 100), status: 'ENABLED', externalTargetId: externalId } })
  // 🔴 `reachedAmazon` is `externalId != null`, and the payload says so explicitly rather than
  // leaving a reader to infer it from a null. 209 of the engine's 218 graduations reported success
  // and do not exist at Amazon; an audit row that does not distinguish the two is how that stayed
  // invisible for three months.
  await audit('create_keyword', 'AD_TARGET', t.id,
    // 🔴 HV.5 — `bidCents` was missing here, which is a gap in HV.4's own work: the opening bid
    // survived only in `AdTarget.bidCents`, so the moment a bid rule moved it the number this
    // keyword was harvested AT was recoverable only from AD_BID_UPDATE's payloadBefore. HV.5's
    // cohort needs the opening bid to answer "did it pay", and it must not be reconstructed from
    // whatever `ad-rank-defend` last moved it to.
    { keywordText: input.keywordText, matchType: input.matchType, externalId, reachedAmazon: externalId != null, bidCents: Math.round(input.bidEur * 100) },
    input.userId, {}, 'SUCCESS', input.evidence ?? null)
  return {
    id: t.id, externalTargetId: externalId, denied, pushError,
    ...(input.requireAmazon ? personAdd(externalId ? 'created' : 'local', externalId ? null : NOT_ON_AMAZON_YET) : {}),
  }
}

/**
 * HV.5 — push a keyword that exists HERE but never reached Amazon.
 *
 * 🔴 Why this cannot reuse `createKeywordLocal`, and why HV.4's write path does not fit the backlog:
 * that function's H.1 idempotence check (`:206`) finds the existing row and **returns it without
 * pushing**. A local-only keyword is a different object from a graduation — it already exists
 * locally and needs a PUSH, not a create. Calling the harvest path on one silently no-ops.
 *
 * Measured 2026-08-12: 210 positive keywords carry no Amazon id, 209 of them written by
 * `automation:auto-harvest`, and the write gate is `allowed: true, mode: live` in all four markets
 * — so **156 of them are pushable today**. The other 54 are ASIN-shaped text stored as keywords
 * (pre-H.5 legacy) and are refused here rather than left to Amazon to reject.
 *
 * Everything else is reused: the same `resolveCtx`, the same write gate, the same `createKeyword`
 * client, the same audit path.
 */
export async function pushExistingKeyword(input: { adTargetId: string; userId?: string; evidence?: AdWriteEvidence | null; /** 1e — a person's own add (isPersonCreate). */ manual?: boolean; /** CM-20 — see addGateScope. */ creationFlow?: boolean }): Promise<{
  ok: boolean; externalTargetId: string | null; outcome: 'acted' | 'refused' | 'failed'
  refusal?: { deniedAt: string; reason: string }; error?: string
}> {
  const t = await prisma.adTarget.findUnique({
    where: { id: input.adTargetId },
    select: {
      id: true, kind: true, isNegative: true, expressionType: true, expressionValue: true, bidCents: true, externalTargetId: true,
      adGroup: { select: { externalAdGroupId: true, campaignId: true, campaign: { select: { externalCampaignId: true, marketplace: true, adProduct: true, type: true } } } },
    },
  })
  if (!t) return { ok: false, externalTargetId: null, outcome: 'failed', error: 'that keyword does not exist' }
  if (t.isNegative || t.kind !== 'KEYWORD') return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: 'not_a_positive_keyword', reason: 'This is not a positive keyword.' } }
  if (t.externalTargetId) return { ok: true, externalTargetId: t.externalTargetId, outcome: 'refused', refusal: { deniedAt: 'already_at_amazon', reason: 'This keyword already exists at Amazon.' } }
  // 🔴 The 54. An ASIN is a product target, never a keyword; pushing one would be rejected by
  // Amazon and it is a deletion, not a retry.
  if (/^b0[a-z0-9]{8}$/i.test(t.expressionValue.trim())) {
    return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: 'asin_as_keyword', reason: 'This is an ASIN stored as keyword text (pre-H.5 legacy). It is a product target, not a keyword, and must be deleted rather than pushed.' } }
  }
  /**
   * 🔴 HV.9b — THE BACKLOG CONTAINS DUPLICATES, AND PUSHING THEM CORRUPTED OUR OWN RECORD.
   *
   * Measured 2026-08-13: 54 pushes produced 6 distinct Amazon keywords. One id ended up attributed
   * to 26 local rows and another to 24, because the 209-row backlog holds the same
   * (ad group, text, matchType) many times over — the very population HV.9c is scoped to clean up.
   * The first push creates the keyword; Amazon refuses each later duplicate and returns NO ID; the
   * read-back below then found the sibling's keyword and stamped it on.
   *
   * Amazon was never wrong — it refused every duplicate correctly. Only our record was. So a row
   * whose keyword a sibling already holds is REFUSED here, before any call is made.
   */
  const twin = await prisma.adTarget.findFirst({
    where: {
      id: { not: t.id }, adGroupId: (await prisma.adTarget.findUnique({ where: { id: t.id }, select: { adGroupId: true } }))?.adGroupId,
      isNegative: false, expressionValue: t.expressionValue, expressionType: t.expressionType,
      externalTargetId: { not: null },
    },
    select: { id: true, externalTargetId: true },
  })
  if (twin) {
    return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: 'duplicate_of_existing_row', reason: `Another row in this ad group already holds this keyword at Amazon (${twin.externalTargetId}). Pushing this one would create nothing and would attribute one Amazon keyword to two of our rows.` } }
  }

  const ag = t.adGroup
  if (!ag?.externalAdGroupId || !ag.campaign?.externalCampaignId || !ag.campaign.marketplace) {
    return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: 'connection', reason: 'The ad group or campaign has no Amazon id, so there is nowhere to push it to.' } }
  }
  const ctx = await resolveCtx(ag.campaign.marketplace)
  if (!ctx) return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: 'connection', reason: `No active Amazon Ads connection for ${ag.campaign.marketplace}.` } }
  const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: t.bidCents, manual: isPersonCreate(input.manual, input.userId), ...addGateScope({ id: ag.campaignId, ...ag.campaign }, input, { field: 'bid', cents: t.bidCents }) })
  if (!gate.allowed) {
    // 🔴 `apps/api`'s tsconfig is NOT strict, so `if (!gate.allowed)` does not narrow the
    // discriminated union the way it would in `apps/web`. `Extract` names the exact variant
    // instead of a bare `as any`, so a future refusal shape without a `reason` still fails here
    // rather than rendering the string "undefined" to an operator.
    const denied = gate as Extract<GateDecision, { allowed: false }>
    return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: String(denied.deniedAt), reason: denied.reason } }
  }

  try {
    const args = { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, keywordText: t.expressionValue, matchType: t.expressionType as 'EXACT' | 'PHRASE' | 'BROAD', bid: t.bidCents / 100, state: 'enabled' as const }
    const r = ag.campaign.adProduct === 'SPONSORED_BRANDS' ? await createSbKeyword(ctx, args) : await createKeyword(ctx, args)
    /**
     * 🔴 HV.9a/HV.9b — AMAZON CAN CREATE THE KEYWORD AND RETURN NO ID.
     *
     * This used to return `failed` here and leave `externalTargetId` NULL. Measured on the
     * 2026-08-13 proof write, on the negative half of the same service: `createNegative` logged
     * `success … externalId: null` and the negative is ENABLED at Amazon as id 48498817150724.
     * The same shape reaches this line.
     *
     * Reporting `failed` over a create that succeeded is worse than it sounds on a backlog: an
     * operator retries the 155, and every retry of a silently-succeeded push is a DUPLICATE
     * keyword at Amazon. So ask Amazon before concluding, and only report failure when the
     * read-back agrees the keyword is not there.
     */
    let externalId = r.externalId
    if (!externalId) {
      try {
        const live = ag.campaign.adProduct === 'SPONSORED_BRANDS'
          ? await listSbKeywords(ctx, { externalCampaignIds: [ag.campaign.externalCampaignId] })
          : await listKeywords(ctx, { campaignIds: [ag.campaign.externalCampaignId] })
        const key = t.expressionValue.trim().toLowerCase()
        const found = (live as Array<{ keywordId?: string; keywordText?: string; adGroupId?: string; matchType?: string }>)
          .find((k) => String(k.keywordText ?? '').trim().toLowerCase() === key
            && String(k.matchType ?? '').toUpperCase() === String(t.expressionType).toUpperCase()
            && (!k.adGroupId || String(k.adGroupId) === ag.externalAdGroupId))
        if (found?.keywordId) {
          // 🔴 Only claim a keyword no other row already claims. If a sibling holds this id, THIS
          // push created nothing — Amazon refused it as a duplicate and the read-back found the
          // sibling's keyword. Stamping it here is how 54 pushes came to share 6 ids.
          const owner = await prisma.adTarget.findFirst({ where: { externalTargetId: String(found.keywordId), id: { not: t.id } }, select: { id: true } })
          if (owner) {
            return { ok: false, externalTargetId: null, outcome: 'refused', refusal: { deniedAt: 'duplicate_of_existing_row', reason: `Amazon returned no id and the keyword found by read-back (${found.keywordId}) already belongs to another of our rows. Nothing was created.` } }
          }
          externalId = String(found.keywordId)
        }
      } catch { /* leave it null — the row then reports honestly as unproven rather than as created */ }
      if (!externalId) {
        return { ok: false, externalTargetId: null, outcome: 'failed', error: 'Amazon accepted the call but returned no id, and a read-back did not find the keyword. Nothing was created; retrying is safe.' }
      }
    }
    const r2 = { externalId }
    await prisma.adTarget.update({ where: { id: t.id }, data: { externalTargetId: r2.externalId, lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } })
    await audit('push_keyword', 'AD_TARGET', t.id, { keywordText: t.expressionValue, matchType: t.expressionType, externalId: r2.externalId, reachedAmazon: true, bidCents: t.bidCents, recoveredByReadBack: !r.externalId }, input.userId, {}, 'SUCCESS', input.evidence ?? null)
    return { ok: true, externalTargetId: r2.externalId, outcome: 'acted' }
  } catch (e) {
    return { ok: false, externalTargetId: null, outcome: 'failed', error: (e as Error).message }
  }
}

export interface NewProductAd {
  adGroupId: string; sku?: string; asin?: string; productId?: string; userId?: string
  /** 1e — a person's own add from a screen or an upload (isPersonCreate): passes the halt and autonomy OFF. Set only by the routes. */
  manual?: boolean
  /** CM-8 — a person's add: no row unless Amazon took it, and a row Amazon never took is sent (see PersonAddResult). */
  requireAmazon?: boolean
  /**
   * W2-A (CC-2) — a launch's ad: one Amazon (or the gate, or a missing SKU) refused keeps its row without Amazon's id and
   * returns `notSent`, instead of throwing with nothing written — so the launch receipt and the read-back can see a
   * campaign whose ads did not land, and the launch repair can send them later.
   */
  launch?: boolean
  /** CM-20 — part of the launch that created the campaign a moment ago (see addGateScope). */
  creationFlow?: boolean
}

/**
 * Find the seller SKU an SP product ad actually needs.
 *
 * **A Sponsored Products ad is created from a merchant SKU, not an ASIN.** Send
 * only an ASIN and Amazon answers 200 with an empty `success` array — no id, no
 * error, nothing thrown. Every caller that trusted that call therefore stored a
 * local row with a null external id and reported it as created. That is how a
 * replication reported 200 product ads while ZERO of them existed on Amazon, and
 * the ten campaigns it created could not serve a single impression.
 *
 * The identifier can arrive as either kind, because the campaign builders put
 * `asin || sku` into one flat list — so a product with no ASIN carries its SKU
 * in the ASIN field. Both are resolved here rather than at each call site.
 */
export async function resolveSellerSku(
  input: {
    sku?: string | null; asin?: string | null
    /** S8 — the product the ad is for, when the caller knows it. */
    productId?: string | null
    /** S8 — the campaign's market: the ad SKU is the SKU Amazon holds for this product THERE. */
    marketplace?: string | null
  },
): Promise<{ sku: string; asin: string | null } | null> {
  type AdProduct = { id: string; sku: string; amazonAsin: string | null }
  const select = { id: true, sku: true, amazonAsin: true } as const
  let product: AdProduct | null = null
  let answer: { sku: string; asin: string | null } | null = null
  if (input.sku) {
    answer = { sku: input.sku, asin: input.asin ?? null }
  } else {
    const value = input.asin
    if (!value) return null
    // Prefer FBA when one ASIN has several offers — that is the offer these
    // campaigns advertise.
    const byAsin = await prisma.product.findFirst({
      where: { amazonAsin: value, fulfillmentMethod: 'FBA' }, select, orderBy: { sku: 'asc' },
    }) ?? await prisma.product.findFirst({
      where: { amazonAsin: value }, select, orderBy: { sku: 'asc' },
    })
    // Else the value is already a seller SKU (a product with no ASIN of its own).
    product = byAsin ?? await prisma.product.findFirst({ where: { sku: value }, select })
    if (product) answer = { sku: product.sku, asin: product.amazonAsin ?? (byAsin ? value : null) }
  }

  /*
   * S8 — a listing may carry its own channel SKU, per channel AND market. The product SKU is not necessarily what Amazon
   * holds in the campaign's market, and an ad on a SKU Amazon does not hold advertises nothing. So: which product the
   * ad is for (named; else the SKU matched back through the resolver on this business's Amazon accounts there; else
   * the product whose own SKU it is), then the SKU its Amazon listing in that market holds.
   */
  const market = input.marketplace ? normalizeMarketplaceCode(input.marketplace, '') : ''
  if (!market) return answer
  const skuGiven = input.sku ?? (product ? null : input.asin) ?? null
  if (input.productId) product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null }, select })
  else if (!product && skuGiven) product = await productForAdSku(skuGiven, market)
  if (!product) return answer
  const live = await amazonSkuInMarket(product, market)
  if (live.problem) throw new AdSkuConflictError(live.problem)
  // No live Amazon listing there, or it holds the SKU we already had: as before.
  if (!live.sku || live.sku === answer?.sku) return answer
  return { sku: live.sku, asin: answer?.asin ?? product.amazonAsin ?? null }
}

/** S8 — the ad SKU cannot be named without a guess (two SKUs, or two products): one plain sentence, nothing sent. */
export class AdSkuConflictError extends Error {
  readonly code = 'AD_SKU_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'AdSkuConflictError'
  }
}

/** S8 — the product a seller SKU names on this business's Amazon accounts in one market: the resolver, then `Product.sku`. */
async function productForAdSku(sku: string, market: string): Promise<{ id: string; sku: string; amazonAsin: string | null } | null> {
  const select = { id: true, sku: true, amazonAsin: true } as const
  const connectionIds = await listingAccounts(prisma, { channel: 'AMAZON', marketplace: market })
  const match = await productForChannelSkuOnAccounts(prisma, { channel: 'AMAZON', sku, marketplace: market, connectionIds })
  if (!match) return prisma.product.findFirst({ where: { sku, deletedAt: null }, select })
  if ('productIds' in match) {
    throw new AdSkuConflictError(`${sku} names more than one product on Amazon ${market}. Nothing was sent: give each listing its own SKU first.`)
  }
  return prisma.product.findFirst({ where: { id: match.productId, deletedAt: null }, select })
}

/**
 * S8 — the seller SKU Amazon holds for a product in one market (`liveChannelSku`, listings/channel-sku.pure.ts): its
 * primary Amazon listing there (else its extra listings) — the confirmed `liveChannelSku`, else the old stores (active
 * offers, mirror keys, flat-file snapshot), else the product SKU. When the listing has more than one SKU on record (two
 * active offers), the one named like the product SKU — what an ad was created from before S8; when none is, the ad is
 * refused: an ad on a guessed SKU would not work. Still-draft listings are not on Amazon and count for nothing.
 * `sku: null` = no live listing there.
 */
async function amazonSkuInMarket(product: { id: string; sku: string }, market: string): Promise<{ sku: string | null; problem?: string }> {
  const rows = await prisma.channelListing.findMany({
    where: { productId: product.id, channel: 'AMAZON', marketplace: market },
    select: CHANNEL_SKU_LISTING_SELECT,
    orderBy: { id: 'asc' },
  })
  const primary = rows.filter(row => !row.aliasKey)
  const skus = new Set<string>()
  for (const row of primary.length ? primary : rows) {
    const live = liveChannelSku(row, product.sku)
    if (!live) continue
    if (live.sku) { skus.add(live.sku); continue }
    if (live.conflict.candidates.some(c => c.sku === product.sku)) { skus.add(product.sku); continue }
    const onRecord = live.conflict.candidates.map(c => c.sku)
    return {
      sku: null,
      problem: onRecord.length
        ? `${product.sku} has more than one seller SKU on Amazon ${market} (${onRecord.join(', ')}) and none of them is ${product.sku}. `
          + 'Nothing was sent to Amazon Ads: an ad on a guessed SKU would not work. Choose the offer to advertise first.'
        : `${live.conflict.sentence} Nothing was sent to Amazon Ads (${market}).`,
    }
  }
  if (skus.size > 1) {
    return { sku: null, problem: `${product.sku} has more than one Amazon SKU in ${market} (${[...skus].join(', ')}). Nothing was sent: choose the listing to advertise first.` }
  }
  return { sku: [...skus][0] ?? null }
}

type ProductAdCreateResult = { id: string | null; externalAdId: string | null; /** W2-A — why it did not reach Amazon. */ notSent?: NotSent | null } & PersonAddResult
export async function createProductAdLocal(input: NewProductAd): Promise<ProductAdCreateResult> {
  // CM-33 — one create per product and ad group at a time (see createKeywordLocal).
  return withCreateClaim(createIdentity('product-ad', input.adGroupId, input.asin || input.sku || input.productId), () => createProductAdOnce(input), () => {
    if (input.requireAmazon) return { id: null, externalAdId: null, ...personAdd('refused', SAME_ADD_RUNNING) }
    throw new Error(SAME_ADD_RUNNING)
  })
}
async function createProductAdOnce(input: NewProductAd): Promise<ProductAdCreateResult> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaignId: true, campaign: { select: { externalCampaignId: true, marketplace: true, adProduct: true, type: true } } } })
  if (!ag) throw new Error('ad group not found')
  // S8 — the SKU Amazon holds in the campaign's market. A conflict is held back and refuses only an SP push below.
  let skuConflict: AdSkuConflictError | null = null
  const resolved = await resolveSellerSku({ ...input, marketplace: ag.campaign?.marketplace ?? null }).catch((error: unknown) => {
    if (error instanceof AdSkuConflictError) { skuConflict = error; return null }
    throw error
  })
  let externalId: string | null = null
  // ACR Stage 5 — third instance of the endpoint-family split. `/sp/productAds` returns nothing
  // useful for an SD ad group, so an SD ad pushed there attaches to nothing and reports success.
  const isSd = ag.campaign?.adProduct === 'SPONSORED_DISPLAY'
  /**
   * SB has no "product ad" at all. Its unit is a CREATIVE — headline, brand logo asset, landing
   * page and up to three ASINs — created at `/sb/v4/ads` by `createSbAdLocal` (AX2.9). Falling
   * through to `/sp/productAds` here would be the same silent no-op as the other three families,
   * so this fails loudly and names the function that does the job.
   */
  if (ag.campaign?.adProduct === 'SPONSORED_BRANDS') {
    throw new Error('Sponsored Brands has no product ad — use createSbAdLocal() to create an SB creative')
  }
  const person = input.requireAmazon === true
  const asinKey = resolved?.asin ?? input.asin ?? null
  const skuKey = resolved?.sku ?? input.sku ?? null
  // CM-8 — for a person's add: an ad Amazon holds answers "already there"; one Nexus holds without Amazon's id is sent
  // and given the id (one row per ad group and ASIN, AdProductAd_adGroupId_asin_key, so a second row cannot be made).
  let held: { id: string; externalAdId: string | null } | null = null
  if (person) {
    const same = asinKey ? { adGroupId: input.adGroupId, asin: asinKey } : { adGroupId: input.adGroupId, sku: skuKey }
    held = await prisma.adProductAd.findFirst({ where: { ...same, externalAdId: { not: null } }, select: { id: true, externalAdId: true } })
      ?? await prisma.adProductAd.findFirst({ where: same, select: { id: true, externalAdId: true } })
    if (held?.externalAdId) return { id: held.id, externalAdId: held.externalAdId, ...personAdd('already_existed') }
  }
  let notSent: NotSent | null = null
  // W2-A — a launch keeps a refused ad's row (see NewProductAd.launch); a person's add keeps nothing; others throw.
  const keepRefused = person || input.launch === true
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: 0, manual: isPersonCreate(input.manual, input.userId), ...addGateScope({ id: ag.campaignId, ...ag.campaign }, input, null) })
      if (gate.allowed) {
        // SD takes either identifier; SP genuinely needs the seller SKU, so only SP hard-fails.
        if (!resolved && !isSd) {
          const noSku = skuConflict ?? new Error(`no seller SKU for "${input.asin ?? input.sku ?? '?'}" — a Sponsored Products ad needs one`)
          if (!keepRefused) throw noSku
          notSent = { outcome: 'refused', reason: noSku.message }
        } else try {
          const r = isSd
            // ENABLED like the SP path: the campaign is the delivery gate, not the ad. See the
            // `state` docblock in createAdGroupLocal.
            ? await createSdProductAd(ctx, {
                externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId,
                sku: resolved?.sku ?? input.sku, asin: resolved?.asin ?? input.asin, state: 'enabled',
              })
            : await createProductAd(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, sku: resolved!.sku, state: 'enabled' })
          externalId = r.externalId
          // Amazon answers 200 with an empty success list when it rejects an ad.
          // Silence here is what made 200 phantom product ads look like a clean run.
          // CM-8 — and with a per-item error when it refuses one: that is the reason given.
          if (!externalId) {
            const why = (r as { error?: string | null }).error ?? JSON.stringify(r.rawResponse).slice(0, 200)
            if (!keepRefused) throw new Error(`Amazon did not create the ad for "${resolved?.sku ?? input.asin ?? '?'}": ${why}`)
            notSent = { outcome: 'failed', reason: why }
          }
        } catch (e) {
          if (!input.launch) throw e
          notSent = { outcome: 'failed', reason: (e as Error).message }
        }
      } else notSent = { outcome: 'refused', reason: gateReason(gate) }
    } else notSent = { outcome: 'refused', reason: `No active Amazon Ads connection for ${ag.campaign.marketplace}.` }
  }
  if (person && notSent) {
    logger.warn('[CM-8] product ad not created — nothing written', { adGroupId: input.adGroupId, outcome: notSent.outcome, reason: notSent.reason })
    return { id: held?.id ?? null, externalAdId: null, ...personAdd(notSent.outcome, notSent.reason) }
  }
  if (held && !externalId) return { id: held.id, externalAdId: null, ...personAdd('local', NOT_ON_AMAZON_YET) }
  const ad = held
    ? await prisma.adProductAd.update({ where: { id: held.id }, data: { externalAdId: externalId, status: 'ENABLED', ...(resolved ? { sku: resolved.sku, asin: resolved.asin ?? asinKey } : {}) } })
    : await prisma.adProductAd.create({ data: { adGroupId: input.adGroupId, asin: resolved?.asin ?? input.asin ?? null, sku: resolved?.sku ?? input.sku ?? null, productId: input.productId ?? null, status: 'ENABLED', externalAdId: externalId } })
  await audit(held ? 'push_product_ad' : 'create_product_ad', 'PRODUCT_AD', ad.id, { sku: resolved?.sku ?? input.sku, asin: input.asin, externalId, ...(notSent ? { reachedAmazon: false, error: notSent.reason } : {}) }, input.userId, {}, notSent ? 'FAILED' : 'SUCCESS')
  return {
    id: ad.id, externalAdId: externalId, notSent,
    ...(person ? personAdd(externalId ? 'created' : 'local', externalId ? null : NOT_ON_AMAZON_YET) : {}),
  }
}

// LAUNCH-REPAIR — push a campaign's EXISTING local structure (ad group → keywords/auto targets →
// product ads) to Amazon. Fixes campaigns whose sub-entities were saved locally but never pushed
// (e.g. the campaign wasn't allowlisted at launch, so the write-gate skipped them → empty on
// Amazon = "not eligible, no keyword and no ad"). Idempotent: only pushes rows with a null
// external id and reuses the existing local rows — never duplicates. Campaign must be allowlisted.
export async function pushCampaignStructure(campaignId: string): Promise<{ ok: boolean; adGroups: number; keywords: number; targets: number; productAds: number; negKeywords: number; errors: string[] }> {
  const out = { ok: true, adGroups: 0, keywords: 0, targets: 0, productAds: 0, negKeywords: 0, errors: [] as string[] }
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { externalCampaignId: true, marketplace: true, adProduct: true, tactic: true } })
  if (!campaign?.externalCampaignId || !campaign.marketplace) { out.ok = false; out.errors.push('campaign missing externalCampaignId/marketplace'); return out }
  const ctx = await resolveCtx(campaign.marketplace)
  if (!ctx) { out.ok = false; out.errors.push('no connection for ' + campaign.marketplace); return out }
  const gate = await checkAdsWriteGate({ marketplace: campaign.marketplace, payloadValueCents: 0, campaignId })
  if (!gate.allowed) { out.ok = false; out.errors.push('write-gate closed — allowlist the campaign first'); return out }
  const extC = campaign.externalCampaignId
  const isSd = campaign.adProduct === 'SPONSORED_DISPLAY'
  const isSb = campaign.adProduct === 'SPONSORED_BRANDS'
  const adGroups = await prisma.adGroup.findMany({ where: { campaignId } })
  for (const ag of adGroups) {
    let extAg = ag.externalAdGroupId
    // Amazon rejects the `·` middle-dot (U+00B7) in ad group names (same constraint as portfolio
    // names) — it silently drops the item into the error array so no adGroupId comes back. Sanitize.
    const safeName = ag.name.replace(/\s*·\s*/g, ' - ')
    if (!extAg) {
      try {
        // A missing SD / SB ad group is re-created on its own family's endpoint, as createAdGroupLocal does: the SP
        // create attached it to nothing (an SD/SB campaign id is unknown to /sp/adGroups).
        const bid = (ag.defaultBidCents ?? 75) / 100
        const r = isSd
          ? await createSdAdGroup(ctx, { externalCampaignId: extC, name: safeName, defaultBid: bid, state: 'enabled', tactic: campaign.tactic === 'T00030' ? 'T00030' : 'T00020' })
          : campaign.adProduct === 'SPONSORED_BRANDS'
            ? await createSbAdGroup(ctx, { externalCampaignId: extC, name: safeName, state: 'enabled' })
            : await createAdGroup(ctx, { externalCampaignId: extC, name: safeName, defaultBid: bid, state: 'enabled' })
        extAg = r.externalId
        await prisma.adGroup.update({ where: { id: ag.id }, data: { externalAdGroupId: extAg, name: safeName, lastSyncStatus: extAg ? 'SUCCESS' : 'FAILED' } })
        if (extAg) out.adGroups++
        else out.errors.push('adGroup "' + safeName + '": no external id — ' + JSON.stringify(r.rawResponse).slice(0, 300))
      } catch (e) { out.errors.push('adGroup "' + safeName + '": ' + ((e as Error)?.message || '')); continue }
    }
    if (!extAg) continue
    const targets = await prisma.adTarget.findMany({ where: { adGroupId: ag.id, isNegative: false, externalTargetId: null } })
    for (const t of targets) {
      // Amazon auto-generates the 4 auto-targeting clauses when an ad group is created in an AUTO
      // campaign — POST /sp/targets rejects expressionType AUTO. Skip (they already exist on Amazon).
      if (t.kind === 'AUTO') continue
      const bid = (t.bidCents ?? 75) / 100
      try {
        let extId: string | null = null
        if (t.kind === 'KEYWORD') {
          const r = await createKeyword(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, keywordText: t.expressionValue ?? '', matchType: (t.expressionType as 'EXACT' | 'PHRASE' | 'BROAD') || 'BROAD', bid, state: 'enabled' })
          extId = r.externalId; if (extId) out.keywords++
          else out.errors.push('keyword "' + (t.expressionValue || '') + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
        } else if (isSb) {
          // CC-31 — not to /sp/targets: Nexus has no Sponsored Brands targets path (see SB_TARGET_REFUSED).
          out.errors.push('target "' + (t.expressionValue || '') + '": ' + SB_TARGET_REFUSED)
          continue
        } else {
          const expression = [{ type: 'ASIN_SAME_AS', value: t.expressionValue ?? '' }]
          // CC-12 — an SD row is sent in SD's own dialect, rebuilt from what Nexus stored (kind, audience type, value).
          const r = isSd
            ? await createSdTarget(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, expression: sdTargetExpression({ kind: t.kind, value: t.expressionValue ?? '', audienceType: t.kind === 'AUDIENCE' ? t.expressionType : null }), bid, state: 'enabled' })
            : await createTarget(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, expression, expressionType: 'MANUAL', bid, state: 'enabled' })
          extId = r.externalId; if (extId) out.targets++
          else out.errors.push('target "' + (t.expressionValue || '') + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
        }
        if (extId) await prisma.adTarget.update({ where: { id: t.id }, data: { externalTargetId: extId } })
      } catch (e) { out.errors.push('target "' + (t.expressionValue || '') + '": ' + ((e as Error)?.message || '')) }
    }
    const productAds = await prisma.adProductAd.findMany({ where: { adGroupId: ag.id, externalAdId: null } })
    for (const pa of productAds) {
      try {
        // Sponsored Products ads require a seller SKU (merchantSku), not just an ASIN. Shared with
        // the launch path so a repair can fix exactly what a launch should have created — including
        // rows whose "asin" is really a SKU, which the builders' flat `asin || sku` list produces.
        const resolved = await resolveSellerSku({ ...pa, marketplace: campaign.marketplace })
        if (!resolved) { out.errors.push('productAd "' + (pa.asin || pa.sku || '') + '": no seller SKU in the catalog for this product'); continue }
        const sku = resolved.sku
        const r = await createProductAd(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, sku, state: 'enabled' })
        // Write the real ASIN back too: rows created from the builders' flat list
        // carry a SKU in `asin`, and leaving that lie in place breaks every later
        // join that trusts the column's name.
        if (r.externalId) { await prisma.adProductAd.update({ where: { id: pa.id }, data: { externalAdId: r.externalId, sku, asin: resolved.asin } }); out.productAds++ }
        else out.errors.push('productAd "' + (pa.asin || sku) + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
      } catch (e) { out.errors.push('productAd "' + (pa.asin || pa.sku || '') + '": ' + ((e as Error)?.message || '')) }
    }
    // Negative keywords (funnel isolation) that exist locally but were never pushed. 5b — through the negative write
    // service: protected terms, text limits and the gate bind them, a NEGATIVE_PHRASE row goes as a phrase (it went as
    // exact), a campaign-level row goes to the campaign (it went to this ad group), and an archived one is not pushed.
    const negKws = await prisma.adTarget.findMany({ where: { adGroupId: ag.id, kind: 'KEYWORD', isNegative: true, externalTargetId: null, status: { not: 'ARCHIVED' } }, select: { id: true, expressionType: true, expressionValue: true } })
    for (const nk of negKws) {
      const r = await pushLocalNegative(nk.id)
      if (r.externalTargetId) out.negKeywords++
      else out.errors.push('negKw "' + (nk.expressionValue || '') + '" ' + nk.expressionType + ': ' + (r.refusal ? `refused at ${r.refusal.deniedAt}: ${r.refusal.reason}` : r.error ?? `not pushed (mode=${r.mode})`))
    }
  }
  logger.info('[LAUNCH-REPAIR] pushCampaignStructure', { campaignId, ...out })
  return out
}

// LAUNCH-REPAIR — Amazon→DB reconcile for a set of campaigns. Read-mostly: (1) lists negative
// keywords from Amazon and back-fills local rows' externalTargetId (matched by ad group + match
// type + text), reporting Amazon total / dupes / local-unmatched; (2) reads real serving status
// (delivery) for each campaign + its ad group; (3) reads Amazon's authoritative portfolio membership
// per campaign. The only write is back-filling externalTargetId on already-existing local rows.
export async function reconcileNegativesAndDelivery(campaignIds: string[]): Promise<Record<string, unknown>> {
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, marketplace: true, externalCampaignId: true, portfolioId: true } })
  const mkt = campaigns.find((c) => c.marketplace)?.marketplace
  if (!mkt) return { ok: false, error: 'no marketplace on campaigns' }
  const ctx = await resolveCtx(mkt)
  if (!ctx) return { ok: false, error: 'no connection for ' + mkt }
  const extIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)

  const adGroups = await prisma.adGroup.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true, campaignId: true, externalAdGroupId: true } })
  const extAgToLocal = new Map(adGroups.filter((a) => a.externalAdGroupId).map((a) => [a.externalAdGroupId as string, a.id]))
  const localNegs = await prisma.adTarget.findMany({ where: { adGroupId: { in: adGroups.map((a) => a.id) }, kind: 'KEYWORD', isNegative: true }, select: { id: true, adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true } })

  // (1) negatives — index Amazon negs by localAdGroup|MATCH|text, back-fill ids
  const amzNegs = await listNegativeKeywords(ctx, { campaignIds: extIds })
  const amzIndex = new Map<string, Array<{ id: string | null }>>()
  for (const n of amzNegs) {
    const localAg = n.adGroupId ? extAgToLocal.get(n.adGroupId) : undefined
    const mt = (n.matchType || '').replace('NEGATIVE_', '')
    const key = `${localAg}|${mt}|${(n.keywordText || '').toLowerCase()}`
    const arr = amzIndex.get(key) ?? []; arr.push({ id: n.negativeKeywordId ?? n.keywordId ?? null }); amzIndex.set(key, arr)
  }
  let backfilled = 0, alreadyLinked = 0, unmatchedLocal = 0
  for (const ln of localNegs) {
    // Both spellings: a mirror row says NEGATIVE_EXACT, the index above is keyed on EXACT.
    const key = `${ln.adGroupId}|${ln.expressionType.replace('NEGATIVE_', '')}|${(ln.expressionValue || '').toLowerCase()}`
    const id = amzIndex.get(key)?.[0]?.id ?? null
    if (id) {
      if (ln.externalTargetId === id) alreadyLinked++
      else { await prisma.adTarget.update({ where: { id: ln.id }, data: { externalTargetId: id } }); backfilled++ }
    } else unmatchedLocal++
  }
  const duplicates = [...amzIndex.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, count: v.length }))

  // (2)+(3) serving status + portfolio membership
  const amzCamps = await listCampaignsServing(ctx, { campaignIds: extIds })
  const campByExt = new Map(amzCamps.map((c) => [c.campaignId, c]))
  const amzAgs = await listAdGroupsV3(ctx, { campaignIds: extIds })
  const agByExt = new Map(amzAgs.map((a) => [a.adGroupId, a]))
  const delivery = campaigns.map((c) => {
    const ac = c.externalCampaignId ? campByExt.get(c.externalCampaignId) : undefined
    const ag = adGroups.find((a) => a.campaignId === c.id)
    const aag = ag?.externalAdGroupId ? agByExt.get(ag.externalAdGroupId) : undefined
    return {
      name: c.name,
      campaignState: ac?.state ?? null,
      campaignServing: ac?.extendedData?.servingStatus ?? null,
      adGroupServing: aag?.extendedData?.servingStatus ?? null,
      amazonPortfolioId: ac?.portfolioId ?? null,
      localPortfolioId: c.portfolioId ?? null,
    }
  })

  const out = {
    ok: true,
    negatives: { amazonTotal: amzNegs.length, localTotal: localNegs.length, backfilled, alreadyLinked, unmatchedLocal, duplicates: duplicates.length, duplicateKeys: duplicates.slice(0, 10) },
    delivery,
  }
  logger.info('[LAUNCH-REPAIR] reconcileNegativesAndDelivery', { campaignIds, negatives: out.negatives })
  return out
}

// LAUNCH-REPAIR — force-push a campaign's portfolio membership to Amazon. The normal PATCH path
// diffs against LOCAL state, so when local already has the portfolioId (but Amazon has null — the
// launch never applied it) it no-ops. This bypasses the diff and pushes updateCampaign directly.
export async function assignPortfolioDirect(campaignId: string, portfolioId: string): Promise<{ ok: boolean; error?: string; rawResponse?: unknown }> {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { externalCampaignId: true, marketplace: true } })
  if (!c?.externalCampaignId || !c.marketplace) return { ok: false, error: 'campaign missing externalCampaignId/marketplace' }
  const gate = await checkAdsWriteGate({ marketplace: c.marketplace, payloadValueCents: 0, campaignId })
  if (!gate.allowed) return { ok: false, error: 'write-gate closed: ' + ('reason' in gate ? gate.reason : 'denied') }
  const ctx = await resolveCtx(c.marketplace)
  if (!ctx) return { ok: false, error: 'no connection for ' + c.marketplace }
  const r = await updateCampaign(ctx, c.externalCampaignId, { portfolioId })
  if (r.ok) await prisma.campaign.update({ where: { id: campaignId }, data: { portfolioId } })
  logger.info('[LAUNCH-REPAIR] assignPortfolioDirect', { campaignId, portfolioId, ok: r.ok, error: r.error })
  return { ok: r.ok, error: r.error ?? undefined, rawResponse: r.rawResponse }
}

/**
 * AX-VT.1 — verify (and optionally repair) campaign→portfolio membership against Amazon.
 *
 * This is the read-back that should always have existed. `createCampaignLocal` now sends
 * portfolioId with the create, but Amazon's SP v3 create schema does not publicly document
 * whether it honours the field, and the create response echoes only campaignId — so a create
 * alone can never prove membership landed. One list call per marketplace settles it for a
 * whole launch, and the same function repairs the 62 campaigns the original defect stranded.
 *
 * The important subtlety is WHICH disagreements are ours to overwrite:
 *
 *   Amazon null, we hold a value   → MISSING_ON_AMAZON. Our write never landed. Repairable:
 *                                    the operator asked for this in Nexus and we failed to
 *                                    deliver it, so pushing is restoring their intent.
 *   Amazon holds a DIFFERENT id    → CONFLICT. Somebody moved the campaign in Seller Central.
 *                                    Reported, NEVER auto-pushed — "repairing" that would
 *                                    silently undo a human's deliberate decision, which is a
 *                                    worse bug than the one we are fixing.
 *
 * That distinction is why this cannot be a blind `assignPortfolioDirect` loop over everything
 * with a local portfolioId. Read first, then push only what we broke.
 */
export type PortfolioVerdict = 'AGREED' | 'MISSING_ON_AMAZON' | 'CONFLICT' | 'NOT_ON_AMAZON'

export interface PortfolioVerifyRow {
  campaignId: string
  name: string
  marketplace: string | null
  externalCampaignId: string | null
  intended: string | null
  amazon: string | null
  verdict: PortfolioVerdict
  repaired?: boolean
  error?: string
}

export interface PortfolioVerifyResult {
  ok: boolean
  dryRun: boolean
  checked: number
  agreed: number
  missingOnAmazon: number
  conflicts: number
  notOnAmazon: number
  repaired: number
  repairFailed: number
  rows: PortfolioVerifyRow[]
  errors: string[]
}

export async function verifyCampaignPortfolios(opts: {
  campaignIds?: string[]
  marketplace?: string
  dryRun?: boolean
} = {}): Promise<PortfolioVerifyResult> {
  const dryRun = opts.dryRun !== false // default SAFE: report unless explicitly told to write
  const out: PortfolioVerifyResult = {
    ok: true, dryRun, checked: 0, agreed: 0, missingOnAmazon: 0, conflicts: 0,
    notOnAmazon: 0, repaired: 0, repairFailed: 0, rows: [], errors: [],
  }

  const campaigns = await prisma.campaign.findMany({
    where: {
      portfolioId: { not: null },
      status: { not: 'ARCHIVED' },
      ...(opts.campaignIds?.length ? { id: { in: opts.campaignIds } } : {}),
      ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
    },
    select: { id: true, name: true, marketplace: true, externalCampaignId: true, portfolioId: true },
  })
  out.checked = campaigns.length
  if (!campaigns.length) return out

  // Group by marketplace — each one is a different Amazon profile, so a different read.
  const byMarket = new Map<string, typeof campaigns>()
  for (const c of campaigns) {
    if (!c.marketplace || !c.externalCampaignId) {
      out.notOnAmazon++
      out.rows.push({
        campaignId: c.id, name: c.name, marketplace: c.marketplace,
        externalCampaignId: c.externalCampaignId, intended: c.portfolioId, amazon: null,
        verdict: 'NOT_ON_AMAZON',
      })
      continue
    }
    const arr = byMarket.get(c.marketplace) ?? []
    arr.push(c)
    byMarket.set(c.marketplace, arr)
  }

  for (const [marketplace, rows] of byMarket) {
    const ctx = await resolveCtx(marketplace)
    if (!ctx) { out.ok = false; out.errors.push(`no connection for ${marketplace}`); continue }

    // Chunked so a large account cannot blow the filter size limit.
    const amzById = new Map<string, string | null>()
    try {
      for (let i = 0; i < rows.length; i += 100) {
        const ids = rows.slice(i, i + 100).map((r) => r.externalCampaignId as string)
        for (const a of await listCampaignsV3(ctx, { campaignIds: ids })) {
          amzById.set(a.campaignId, a.portfolioId ?? null)
        }
      }
    } catch (e) {
      out.ok = false
      out.errors.push(`read ${marketplace}: ${(e as Error).message.slice(0, 160)}`)
      continue
    }

    for (const c of rows) {
      const ext = c.externalCampaignId as string
      const intended = c.portfolioId as string
      if (!amzById.has(ext)) {
        out.notOnAmazon++
        out.rows.push({ campaignId: c.id, name: c.name, marketplace, externalCampaignId: ext, intended, amazon: null, verdict: 'NOT_ON_AMAZON' })
        continue
      }
      const amazon = amzById.get(ext) ?? null
      if (amazon === intended) { out.agreed++; continue }

      if (amazon !== null) {
        // Somebody moved it on Amazon. Surface it; do not touch it.
        out.conflicts++
        out.rows.push({ campaignId: c.id, name: c.name, marketplace, externalCampaignId: ext, intended, amazon, verdict: 'CONFLICT' })
        continue
      }

      out.missingOnAmazon++
      const row: PortfolioVerifyRow = {
        campaignId: c.id, name: c.name, marketplace, externalCampaignId: ext,
        intended, amazon: null, verdict: 'MISSING_ON_AMAZON',
      }
      if (!dryRun) {
        const gate = await checkAdsWriteGate({ marketplace, payloadValueCents: 0, campaignId: c.id })
        if (!gate.allowed) {
          row.repaired = false
          row.error = 'write-gate closed: ' + ('reason' in gate ? String(gate.reason) : 'denied')
          out.repairFailed++
        } else {
          const r = await updateCampaign(ctx, ext, { portfolioId: intended })
          row.repaired = r.ok
          if (r.ok) out.repaired++
          else { out.repairFailed++; row.error = r.error ?? 'patch failed' }
        }
      }
      out.rows.push(row)
    }
  }

  logger.info('[AX-VT.1] verifyCampaignPortfolios', {
    dryRun, checked: out.checked, agreed: out.agreed, missingOnAmazon: out.missingOnAmazon,
    conflicts: out.conflicts, notOnAmazon: out.notOnAmazon, repaired: out.repaired, repairFailed: out.repairFailed,
  })
  return out
}

/**
 * AX-VT.1 — settle portfolio membership at the end of a launch.
 *
 * Amazon's SP v3 create response echoes only `campaignId`, and the public docs do not say
 * whether the create honours `portfolioId` at all. So a launch that merely SENDS the field
 * cannot claim the campaigns joined the portfolio — which is the precise gap that produced
 * the original bug, where every layer reported success and 11 campaigns sat outside it.
 *
 * Rather than depend on an undocumented behaviour, every launch now reads back and repairs.
 * One list call per marketplace for the whole batch. If Amazon does honour portfolioId on
 * create this is a cheap confirmation that reports `repaired: 0`; if it does not, the launch
 * fixes itself before returning. Either way the operator gets a claim that was checked.
 *
 * Best-effort by construction: a launch that created campaigns must never be reported as
 * failed because the confirmation step could not run.
 */
export async function settleLaunchPortfolios(campaignIds: string[]): Promise<PortfolioVerifyResult | null> {
  if (!campaignIds.length) return null
  try {
    const r = await verifyCampaignPortfolios({ campaignIds, dryRun: false })
    if (r.checked === 0) return null // no portfolio was requested for this launch
    if (r.missingOnAmazon > 0) {
      // Worth a loud line: it means the create did NOT carry portfolioId through, and the
      // read-back is the only reason these campaigns ended up where the operator asked.
      logger.warn('[AX-VT.1] launch needed portfolio repair — create did not apply portfolioId', {
        campaigns: r.missingOnAmazon, repaired: r.repaired, failed: r.repairFailed,
      })
    }
    return r
  } catch (e) {
    logger.warn('[AX-VT.1] settleLaunchPortfolios failed', { error: (e as Error).message.slice(0, 160) })
    return null
  }
}

// ── AX2.1 — Product / category / auto targeting ─────────────────────────
// Amazon SP product-targeting expressions. AUTO targets are the four
// auto-campaign clauses (close-match / loose-match / substitutes /
// complements). PRODUCT = a specific ASIN; CATEGORY = a browse-node category
// (optionally refined by brand/price/rating — kept simple here: the node id).
const AUTO_EXPRESSION: Record<string, string> = {
  CLOSE_MATCH: 'queryHighRelMatches', LOOSE_MATCH: 'queryBroadRelMatches',
  SUBSTITUTES: 'asinSubstituteRelated', COMPLEMENTS: 'asinAccessoryRelated',
}
// SD targets (product, category and audience — views / purchases remarketing with a lookback, or an Amazon audience by
// id) are built in Sponsored Display's own dialect by `sdTargetExpression` (sd-target-expression.ts, CC-12).
export interface NewTarget {
  adGroupId: string
  kind: 'PRODUCT' | 'CATEGORY' | 'AUTO' | 'AUDIENCE'
  // PRODUCT → an ASIN; CATEGORY → a browse-node id; AUTO → one of AUTO_EXPRESSION keys;
  // AUDIENCE → with audienceType set: VIEWS/PURCHASES_REMARKETING → the scope (`exactProduct` = the advertised products,
  // `similarProduct`, `relatedProduct`, or a category id); AUDIENCE → an Amazon audience id. See sdTargetExpression.
  value: string
  audienceType?: 'VIEWS_REMARKETING' | 'PURCHASES_REMARKETING' | 'AUDIENCE'
  /** CC-12 — an SD remarketing audience's window in days (Amazon requires one); 30 when omitted. */
  lookbackDays?: number
  bidEur: number; state?: 'enabled' | 'paused'; userId?: string
  /** 1e — a person's own add from a screen or an upload (isPersonCreate): passes the halt and autonomy OFF. Set only by the routes. */
  manual?: boolean
  /**
   * Write the local row but do NOT create it on Amazon.
   *
   * For the four SP auto-targeting clauses, which Amazon generates itself when
   * an ad group joins an AUTO campaign — POST /sp/targets rejects them. The row
   * still has to exist locally for bids and reporting to hang off.
   */
  skipAmazon?: boolean
  /** CM-8 — a person's add: no row unless Amazon took it, and a row Amazon never took is sent (see PersonAddResult). */
  requireAmazon?: boolean
  /** CM-20 — part of the launch that created the campaign a moment ago (see addGateScope). */
  creationFlow?: boolean
}
type TargetCreateResult = { id: string | null; externalTargetId: string | null; mode: string; /** W2-A — why it did not reach Amazon. */ notSent?: NotSent | null } & PersonAddResult
/** CC-31 — why a product, category or audience target is not added to a Sponsored Brands campaign. */
export const SB_TARGET_REFUSED = 'Nexus cannot add product, category or audience targets to a Sponsored Brands campaign yet: Amazon takes them on its Sponsored Brands targets endpoint, which Nexus does not send to. Nothing was created. Add them in the Amazon Ads console, or add keywords instead.'
export async function createTargetLocal(input: NewTarget): Promise<TargetCreateResult> {
  // CM-33 — the dedupe below and the create are one step (see createKeywordLocal).
  return withCreateClaim(createIdentity('target', input.adGroupId, input.kind, input.value), () => createTargetOnce(input), () => {
    if (input.requireAmazon && !input.skipAmazon) return { id: null, externalTargetId: null, mode: 'local', ...personAdd('refused', SAME_ADD_RUNNING) }
    throw new Error(SAME_ADD_RUNNING)
  })
}
async function createTargetOnce(input: NewTarget): Promise<TargetCreateResult> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaignId: true, campaign: { select: { externalCampaignId: true, marketplace: true, adProduct: true, type: true } } } })
  if (!ag) throw new Error('ad group not found')
  // CC-31 — a Sponsored Brands campaign's product / category / audience targets go to Amazon's Sponsored Brands targets
  // endpoint, which Nexus has no path to. This sent them to the Sponsored Products one (`/sp/targets`), which knows
  // nothing of an SB campaign. Refused before anything is written or sent, with the reason (a launch lists it, a
  // person's add answers 403 with it).
  if (adProductOf(ag.campaign) === 'SPONSORED_BRANDS') {
    logger.warn('[CC-31] Sponsored Brands target refused — Nexus has no SB targets path', { adGroupId: input.adGroupId, kind: input.kind })
    return {
      id: null, externalTargetId: null, mode: 'local', notSent: { outcome: 'refused', reason: SB_TARGET_REFUSED },
      ...(input.requireAmazon && !input.skipAmazon ? personAdd('refused', SB_TARGET_REFUSED) : {}),
    }
  }
  // CC-12 — a Sponsored Display target is built in SD's own dialect, first: one Amazon would refuse is refused before
  // anything is written, and a nested audience is stored (and matched below) by the text it names.
  const sdExpression = input.kind === 'AUDIENCE' || ag.campaign?.adProduct === 'SPONSORED_DISPLAY'
    ? sdTargetExpression({ kind: input.kind, value: input.value, audienceType: input.audienceType, lookbackDays: input.lookbackDays })
    : null
  const value = sdExpression ? (sdExpressionValue(sdExpression) ?? input.value) : input.value
  // H.5 — idempotent (mirror H.1): a positive target is identified by ad group + kind + value, so a
  // scheduled product/auto harvest re-run returns the existing target instead of duplicating it.
  const sameTarget = { adGroupId: input.adGroupId, kind: input.kind, isNegative: false, expressionValue: value }
  const person = input.requireAmazon === true && !input.skipAmazon
  // CM-8 — for a person's add, a row Amazon holds is the one that answers "already there"; a row Amazon never took is
  // sent below and given Amazon's id, instead of being answered as added.
  const dupe = (person
    ? await prisma.adTarget.findFirst({ where: { ...sameTarget, externalTargetId: { not: null } }, select: { id: true, externalTargetId: true } })
    : null) ?? await prisma.adTarget.findFirst({ where: sameTarget, select: { id: true, externalTargetId: true } })
  if (dupe && (!person || dupe.externalTargetId)) {
    return { id: dupe.id, externalTargetId: dupe.externalTargetId, mode: 'local', ...(person ? personAdd('already_existed') : {}) }
  }
  const isAudience = input.kind === 'AUDIENCE'
  const audType = input.audienceType ?? 'AUDIENCE'
  const expression = input.kind === 'PRODUCT'
    ? [{ type: 'ASIN_SAME_AS', value: input.value }]
    : input.kind === 'CATEGORY'
      ? [{ type: 'ASIN_CATEGORY_SAME_AS', value: input.value }]
      : [{ type: AUTO_EXPRESSION[input.value] ?? input.value }]
  const expressionType = input.kind === 'PRODUCT' ? 'ASIN' : input.kind === 'CATEGORY' ? 'CATEGORY' : isAudience ? audType : 'AUTO'
  let externalId: string | null = null, mode = 'local'
  // CM-8 — why nothing reached Amazon, for a person's add (W2-A: and for a launch).
  let notSent: NotSent | null = null
  if (!input.skipAmazon && ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const bidCents = Math.round(input.bidEur * 100)
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: bidCents, manual: isPersonCreate(input.manual, input.userId), ...addGateScope({ id: ag.campaignId, ...ag.campaign }, input, { field: 'bid', cents: bidCents }) })
      if (gate.allowed) {
        try {
          const r = sdExpression
            ? await createSdTarget(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, expression: sdExpression, bid: input.bidEur, state: input.state ?? 'enabled' })
            : await createTarget(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, expression, expressionType: input.kind === 'AUTO' ? 'AUTO' : 'MANUAL', bid: input.bidEur, state: input.state ?? 'enabled' })
          externalId = r.externalId; mode = r.mode
          if (!externalId) notSent = { outcome: 'failed', reason: (r as { error?: string | null }).error ?? CREATE_NO_ID }
        } catch (e) {
          if (!person) throw e
          notSent = { outcome: 'failed', reason: (e as Error).message }
        }
      } else notSent = { outcome: 'refused', reason: gateReason(gate) }
    } else notSent = { outcome: 'refused', reason: `No active Amazon Ads connection for ${ag.campaign.marketplace}.` }
  }
  if (person && notSent) {
    logger.warn('[CM-8] target not created — nothing written', { adGroupId: input.adGroupId, kind: input.kind, outcome: notSent.outcome, reason: notSent.reason })
    return { id: dupe?.id ?? null, externalTargetId: null, mode, ...personAdd(notSent.outcome, notSent.reason) }
  }
  if (dupe && !externalId) return { id: dupe.id, externalTargetId: null, mode, ...personAdd('local', NOT_ON_AMAZON_YET) }
  const bidCents = Math.round(input.bidEur * 100)
  const status = input.state === 'paused' ? 'PAUSED' : 'ENABLED'
  // CM-8 — the row Nexus already held, now on Amazon: it takes Amazon's id (and the bid and state asked for).
  const t = dupe
    ? await prisma.adTarget.update({ where: { id: dupe.id }, data: { externalTargetId: externalId, bidCents, status, ...(externalId ? { lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } : {}) } })
    : await prisma.adTarget.create({ data: { adGroupId: input.adGroupId, kind: input.kind, expressionType, expressionValue: value, bidCents, status, externalTargetId: externalId } })
  await audit(dupe ? 'push_target' : 'create_target', 'AD_TARGET', t.id, { kind: input.kind, value, externalId, mode, reachedAmazon: externalId != null }, input.userId)
  logger.info('[AX2.1] createTargetLocal', { id: t.id, kind: input.kind, externalId, mode })
  return {
    id: t.id, externalTargetId: externalId, mode, notSent,
    ...(person ? personAdd(externalId ? 'created' : 'local', externalId ? null : NOT_ON_AMAZON_YET) : {}),
  }
}

// ── W2-A (CC-1) — Amazon's own four auto groups ──────────────────────────
//
// When an ad group is added to an AUTO campaign Amazon creates the four auto groups itself (Close match, Loose match,
// Substitutes, Complements), ENABLED at the ad group's default bid. POST /sp/targets refuses them (Replicate learned
// this: ads-blueprint-apply.service.ts `skipAmazon`), so the builders' create of each group never reached Amazon: the
// screen said "Loose match paused, €0.49" while Amazon served it at the default bid, and the rows had no Amazon id for
// any later edit to reach. Every builder now calls this once the ad group exists: read the ad group's groups through
// the gateway (/sp/targets/list, ad-group filter), link each Nexus row to Amazon's group by its expression type, and
// send the state and bid only where the person chose something other than what Amazon made.

/** One auto group as a builder asks for it: the key (CLOSE_MATCH… or any spelling `autoClauseFromSpelling` reads). */
export interface AutoGroupWish { key: string; enabled?: boolean; bidEur?: number }

export interface AutoGroupLink {
  key: string
  clause: AutoClause | null
  label: string
  adTargetId: string | null
  externalTargetId: string | null
  /** What Nexus now holds for it — what Amazon has after this call (a refused change is not shown as made). */
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED' | null
  bidCents: number | null
  /** The change sent to Amazon (only what differed from Amazon's group); null when nothing needed sending. */
  sent: { state?: 'enabled' | 'paused'; bid?: number } | null
  ok: boolean
  reason: string | null
}

export interface AutoGroupsResult { ok: boolean; links: AutoGroupLink[] }

/** Amazon's documented default for a group Nexus could not read: it makes each one ENABLED at the ad group's default bid. */
const AUTO_NOT_LINKED = (label: string, why: string) =>
  `${label} was not linked to Amazon's group (${why}), so your setting for it was not sent. Amazon creates it enabled at the ad group's default bid.`

export async function linkAutoTargeting(input: {
  adGroupId: string; groups: AutoGroupWish[]; userId?: string
  /** 1e — a person's own launch (isPersonCreate). */
  manual?: boolean
  /** CM-20 — part of the launch that created the campaign a moment ago (see addGateScope): every builder passes it. */
  creationFlow?: boolean
  /** Amazon can take a moment to list the groups of a new ad group: one more read after this wait (default 2 s). */
  retryDelayMs?: number
}): Promise<AutoGroupsResult> {
  const ag = await prisma.adGroup.findUnique({
    where: { id: input.adGroupId },
    select: { id: true, externalAdGroupId: true, defaultBidCents: true, campaign: { select: { id: true, externalCampaignId: true, marketplace: true, adProduct: true, type: true } } },
  })
  if (!ag) throw new Error('ad group not found')
  const links: AutoGroupLink[] = []
  const wishes = new Map<AutoClause, AutoGroupWish>()
  for (const g of input.groups) {
    const clause = autoClauseFromSpelling(g?.key)
    if (!clause) {
      links.push({ key: String(g?.key ?? ''), clause: null, label: String(g?.key ?? '?'), adTargetId: null, externalTargetId: null, status: null, bidCents: null, sent: null, ok: false, reason: `"${g?.key ?? ''}" is not one of Amazon's four auto groups (Close match, Loose match, Substitutes, Complements).` })
      continue
    }
    if (!wishes.has(clause)) wishes.set(clause, g)
  }
  const wantStatus = (g: AutoGroupWish): 'ENABLED' | 'PAUSED' => (g.enabled === false ? 'PAUSED' : 'ENABLED')
  const wantBidCents = (g: AutoGroupWish): number => (Number(g.bidEur) > 0 ? Math.round(Number(g.bidEur) * 100) : ag.defaultBidCents)

  // The rows Nexus already holds for this ad group's auto groups (any spelling), one per group.
  const held = await prisma.adTarget.findMany({ where: { adGroupId: ag.id, kind: 'AUTO', isNegative: false }, select: { id: true, kind: true, expressionType: true, expressionValue: true } })
  const rowOf = new Map<AutoClause, string>()
  for (const r of held) { const c = autoClauseOf(r); if (c && !rowOf.has(c)) rowOf.set(c, r.id) }
  const save = async (clause: AutoClause, data: { externalTargetId: string | null; status: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; bidCents: number; error?: string | null; read: boolean }): Promise<string> => {
    const fields = {
      externalTargetId: data.externalTargetId, status: data.status, bidCents: data.bidCents,
      ...(data.read ? { lastSyncedAt: new Date(), lastSyncStatus: (data.error ? 'FAILED' : 'SUCCESS') as 'FAILED' | 'SUCCESS', lastSyncError: data.error ?? null } : {}),
    }
    const id = rowOf.get(clause)
    const row = id
      ? await prisma.adTarget.update({ where: { id }, data: fields, select: { id: true } })
      : await prisma.adTarget.create({ data: { adGroupId: ag.id, kind: 'AUTO', expressionType: 'AUTO', expressionValue: clause, ...fields }, select: { id: true } })
    rowOf.set(clause, row.id)
    return row.id
  }
  const link = (clause: AutoClause, wish: AutoGroupWish, rest: Omit<AutoGroupLink, 'key' | 'clause' | 'label'>): AutoGroupLink => {
    const l = { key: wish.key, clause, label: AUTO_CLAUSE_LABEL[clause], ...rest }
    links.push(l)
    return l
  }

  // Not on Amazon (the campaign or ad group create did not land): nothing exists there to link. The rows keep what was
  // asked for, without an id, like every other child of a campaign Amazon does not hold.
  const ctx = ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace ? await resolveCtx(ag.campaign.marketplace) : null
  if (!ctx || !ag.externalAdGroupId) {
    const why = !ag.externalAdGroupId || !ag.campaign?.externalCampaignId
      ? 'The ad group is not on Amazon, so its auto groups do not exist there yet.'
      : `No active Amazon Ads connection for ${ag.campaign.marketplace}.`
    for (const [clause, wish] of wishes) {
      const id = await save(clause, { externalTargetId: null, status: wantStatus(wish), bidCents: wantBidCents(wish), read: false })
      link(clause, wish, { adTargetId: id, externalTargetId: null, status: wantStatus(wish), bidCents: wantBidCents(wish), sent: null, ok: false, reason: why })
    }
    return { ok: false, links }
  }
  const extAg = ag.externalAdGroupId

  // Sandbox has no Amazon to read: the groups are given sandbox ids with what was asked, like every sandbox create.
  if (adsMode() === 'sandbox') {
    for (const [clause, wish] of wishes) {
      const ext = `sb-auto-${randomUUID().slice(0, 8)}`
      const id = await save(clause, { externalTargetId: ext, status: wantStatus(wish), bidCents: wantBidCents(wish), read: false })
      link(clause, wish, { adTargetId: id, externalTargetId: ext, status: wantStatus(wish), bidCents: wantBidCents(wish), sent: null, ok: true, reason: null })
    }
    return { ok: links.every((l) => l.ok), links }
  }

  type Clause = { targetId?: string; adGroupId?: string; expressionType?: string; state?: string; bid?: number; expression?: Array<{ type?: string }> }
  const readGroups = async (): Promise<Map<AutoClause, Clause>> => {
    const out = new Map<AutoClause, Clause>()
    for (const t of await listTargets(ctx, { adGroupIds: [extAg], states: ALL_STATES }) as Clause[]) {
      if (String(t.expressionType ?? '').toUpperCase() !== 'AUTO' || !t.targetId) continue
      if (t.adGroupId != null && String(t.adGroupId) !== extAg) continue
      const clause = autoClauseFromSpelling(t.expression?.[0]?.type)
      if (clause && !out.has(clause)) out.set(clause, t)
    }
    return out
  }
  let found = new Map<AutoClause, Clause>()
  let readError: string | null = null
  try {
    found = await readGroups()
    if ([...wishes.keys()].some((c) => !found.has(c))) {
      await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs ?? 2000))
      found = await readGroups()
    }
  } catch (e) { readError = (e as Error).message.slice(0, 200) }

  const manual = isPersonCreate(input.manual, input.userId)
  for (const clause of new Set<AutoClause>([...wishes.keys(), ...found.keys()])) {
    const wish = wishes.get(clause)
    const amazon = found.get(clause)
    if (!amazon) {
      if (!wish) continue
      // Not linked: the row says what Amazon makes by itself (enabled at the default bid), never the setting it did not get.
      const why = readError ? `Amazon's auto groups could not be read: ${readError}` : 'Amazon did not list it for this ad group'
      const reason = AUTO_NOT_LINKED(AUTO_CLAUSE_LABEL[clause], why)
      const id = await save(clause, { externalTargetId: null, status: 'ENABLED', bidCents: ag.defaultBidCents, error: reason, read: true })
      link(clause, wish, { adTargetId: id, externalTargetId: null, status: 'ENABLED', bidCents: ag.defaultBidCents, sent: null, ok: false, reason })
      continue
    }
    const ext = String(amazon.targetId)
    const amazonStatus = (['ENABLED', 'PAUSED', 'ARCHIVED'].includes(String(amazon.state ?? '').toUpperCase()) ? String(amazon.state).toUpperCase() : 'ENABLED') as 'ENABLED' | 'PAUSED' | 'ARCHIVED'
    const amazonBid = Number(amazon.bid) > 0 ? Math.round(Number(amazon.bid) * 100) : ag.defaultBidCents
    // A group the builder did not mention is still Amazon's and serving: Nexus holds it as Amazon has it.
    if (!wish) { await save(clause, { externalTargetId: ext, status: amazonStatus, bidCents: amazonBid, read: true }); continue }
    const status = wantStatus(wish)
    const bidCents = wantBidCents(wish)
    const sent: { state?: 'enabled' | 'paused'; bid?: number } = {}
    if (amazonStatus !== 'ARCHIVED' && status !== amazonStatus) sent.state = status === 'PAUSED' ? 'paused' : 'enabled'
    if (bidCents !== amazonBid) sent.bid = bidCents / 100
    if (!Object.keys(sent).length) {
      const id = await save(clause, { externalTargetId: ext, status: amazonStatus, bidCents: amazonBid, read: true })
      link(clause, wish, { adTargetId: id, externalTargetId: ext, status: amazonStatus, bidCents: amazonBid, sent: null, ok: true, reason: null })
      continue
    }
    let error: string | null = null
    // CM-20 — the same campaign rules a bid edit obeys (addGateScope); a launch's own groups pass the allowlist.
    const gate = await checkAdsWriteGate({ marketplace: ag.campaign!.marketplace, payloadValueCents: bidCents, manual, ...addGateScope(ag.campaign!, input, { field: 'bid', cents: bidCents }) })
    if (!gate.allowed) error = `Not sent to Amazon: ${gateReason(gate)}`
    else {
      try {
        const r = await updateTarget(ctx, ext, sent, 'AUTO')
        if (!r.ok) error = r.error ?? 'Amazon did not accept the change.'
      } catch (e) { error = (e as Error).message.slice(0, 300) }
    }
    // A refused change is put back: Nexus shows what Amazon kept (CM-17), and the receipt says what was not set and why.
    const kept = error ? { status: amazonStatus, bidCents: amazonBid } : { status, bidCents }
    const id = await save(clause, { externalTargetId: ext, ...kept, error, read: true })
    await audit('link_auto_target', 'AD_TARGET', id, { clause, externalId: ext, sent, reachedAmazon: !error, ...(error ? { error } : {}) }, input.userId, { status: amazonStatus, bidCents: amazonBid }, error ? 'FAILED' : 'SUCCESS')
    link(clause, wish, { adTargetId: id, externalTargetId: ext, ...kept, sent, ok: !error, reason: error ? `${AUTO_CLAUSE_LABEL[clause]} stays ${amazonStatus.toLowerCase()} at ${(amazonBid / 100).toFixed(2)} on Amazon. ${error}` : null })
  }
  logger.info('[W2-A] linkAutoTargeting', { adGroupId: ag.id, asked: wishes.size, linked: links.filter((l) => l.externalTargetId).length, failed: links.filter((l) => !l.ok).length })
  return { ok: links.every((l) => l.ok), links }
}

// ── AX2.9 — Sponsored Brands creative (brand headline + logo + ASINs +
// landing). Stored in AdProductAd.creativeJson (adType BRAND_AD); the full
// envelope is sent to SB v4 /sb/ads behind the write gate. ───────────────
export interface NewSbAd {
  /** The ad group the creative belongs to. Not needed for a dry run (a check before anything exists on Amazon). */
  adGroupId?: string
  /**
   * ACR Stage 5 — brand name / logo / landing page are now OPTIONAL.
   *
   * They are still required by Amazon, but they no longer have to come from the caller: when
   * omitted they are read off an existing SB campaign in the same marketplace by
   * `resolveSbTemplate`. That is what makes SB launchable without first building an
   * asset-upload flow, and it is why this stayed one function instead of becoming a second
   * template-aware creator beside it.
   */
  brandName?: string; headline: string; logoAssetId?: string
  // P4.5f — manualCollection joins the list: it is Amazon's own replacement for the deprecated
  // productCollection, and it is a real endpoint (POST /sb/v4/ads/manualCollection).
  creativeType?: 'productCollection' | 'manualCollection' | 'storeSpotlight' | 'video'
  landingType?: 'store' | 'productList' | 'url'; landingUrl?: string
  asins: string[]; userId?: string
  /** 1e — a person's own add from the builder (isPersonCreate): passes the halt and autonomy OFF. Set only by the route. */
  manual?: boolean
  /**
   * CC-11 — check the creative and return what would be sent, without calling Amazon or writing anything. The SB
   * builder asks this before it creates the campaign, so a creative Amazon would refuse stops the launch while nothing
   * exists on Amazon yet. Needs `marketplace` (there is no ad group yet).
   */
  dryRun?: boolean
  marketplace?: string
}

/** CC-11 — a creative Amazon would refuse (or that cannot reach Amazon): nothing was sent and nothing was stored. */
export class SbCreativeRefused extends Error {}

export async function createSbAdLocal(input: NewSbAd): Promise<{ id: string; externalAdId: string | null; mode: string; ok?: boolean; problems?: string[]; wouldSend?: unknown }> {
  const ag = input.adGroupId
    ? await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
    : null
  if (input.adGroupId && !ag) throw new Error('ad group not found')
  if (!input.adGroupId && !input.dryRun) throw new SbCreativeRefused('An SB creative needs its ad group.')
  const marketplace = ag?.campaign?.marketplace ?? input.marketplace ?? null
  // CC-11 — every ASIN the operator chose is checked, never cut silently: Amazon's limit differs per creative type
  // (3 for a product collection, 3–10 for a manual collection), and a creative outside it is refused below.
  const asins = input.asins.map((a) => a.trim()).filter(Boolean)
  // ACR Stage 5 — fill anything the caller left out from this account's own brand assets.
  const tpl = (input.brandName && input.logoAssetId) || !marketplace
    ? null
    : await resolveSbTemplate(marketplace)
  const brandName = input.brandName ?? tpl?.brandName
  const logoAssetId = input.logoAssetId ?? tpl?.logoAssetId
  const landingType = input.landingType ?? tpl?.landingType ?? 'productList'
  const landingUrl = input.landingUrl ?? tpl?.landingUrl
  /**
   * P4.5f — there is no default creative type. It used to default to `'productCollection'`, the entity Amazon
   * **deprecated on 2026-07-06** in favour of Manual / Auto Collection, so an operator who did not mention a type got
   * the deprecated one with nothing said. `services/ads-core/sb-ad-types.ts` holds the vocabulary.
   *
   * CC-11 — the SB builder now sends the type the operator chose, and `sbCreativeProblems` (the one check the builder's
   * preview and pre-launch check use too) refuses an unnamed type and anything else Amazon's document would refuse.
   */
  const problems = sbCreativeProblems({ creativeType: input.creativeType, headline: input.headline, asins, brandName })
  // Where a missing brand name would have come from, so the reason says what to fix.
  if (!brandName) problems.push(`No Sponsored Brands campaign in ${marketplace ?? '?'} has a brand name Nexus could reuse.`)
  const creativeType = input.creativeType
  if (input.dryRun) {
    const wouldSend = problems.length === 0 && creativeType
      ? sbAdCreateRequest({ externalCampaignId: ag?.campaign?.externalCampaignId ?? '', externalAdGroupId: ag?.externalAdGroupId ?? '(the new ad group)', brandName: brandName!, headline: input.headline, logoAssetId, creativeType, landingType, landingUrl, asins, state: 'enabled' })
      : null
    return { id: '', externalAdId: null, mode: 'dry-run', ok: problems.length === 0, problems, wouldSend }
  }
  if (problems.length > 0 || !creativeType || !brandName) throw new SbCreativeRefused(problems.join(' '))
  // Sending it is still correct — Amazon deprecated the entity, it did not remove it —
  // but it is never silent again.
  const deprecation = sbAdTypeNotice(creativeType)
  if (deprecation) logger.warn('[AX2.9] creating a DEPRECATED Sponsored Brands creative', { creativeType, notice: deprecation })
  // CC-11 — a creative that cannot reach Amazon is not stored as if it were made: nothing reads a local-only creative,
  // so it would only make the builder say "Creative ✓" for an ad that does not exist.
  if (!ag?.externalAdGroupId || !ag.campaign?.externalCampaignId || !marketplace) throw new SbCreativeRefused('The ad group is not on Amazon, so the creative was not sent.')
  const ctx = await resolveCtx(marketplace)
  if (!ctx) throw new SbCreativeRefused(`No active Amazon Ads connection for ${marketplace}.`)
  const gate = await checkAdsWriteGate({ marketplace, payloadValueCents: 0, manual: isPersonCreate(input.manual, input.userId) })
  if (!gate.allowed) throw new SbCreativeRefused(`The creative was not sent: ${gateReason(gate)}`)
  const r = await createSbAd(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, brandName, headline: input.headline, logoAssetId, creativeType, landingType, landingUrl, asins, state: 'enabled' })
  const externalId = r.externalId, mode = r.mode
  // Same silence-is-failure rule the SP product-ad path learned the hard way: Amazon
  // answers 200 with an empty success list when it REJECTS a creative (unusable logo,
  // ineligible ASIN, bad headline). Without this, a rejected creative stored a local row
  // with externalAdId null and looked like a clean launch.
  if (!externalId) throw new Error(`Amazon did not create the SB creative: ${JSON.stringify(r.rawResponse).slice(0, 300)}`)
  const creativeJson = { brandName, headline: input.headline, logoAssetId: logoAssetId ?? null, creativeType, landingType, landingUrl: landingUrl ?? null, asins }
  const ad = await prisma.adProductAd.create({ data: { adGroupId: input.adGroupId!, asin: asins[0], status: 'ENABLED', externalAdId: externalId, adType: 'BRAND_AD', creativeJson: creativeJson as never } })
  await audit('create_sb_ad', 'PRODUCT_AD', ad.id, { ...creativeJson, externalId, mode }, input.userId)
  logger.info('[AX2.9] createSbAdLocal', { id: ad.id, externalId, mode, asins: asins.length })
  return { id: ad.id, externalAdId: externalId, mode }
}

// ── AX2.2 — placement bid adjustments (top-of-search / product-pages /
// rest-of-search), stored in Campaign.dynamicBidding JSON + pushed to
// Amazon's dynamicBidding.placementBidding behind the write gate. ───────
export interface PlacementBiddingInput {
  campaignId: string
  adjustments: Array<{ placement: string; percentage: number }>
  biddingStrategy?: 'legacyForSales' | 'autoForSales' | 'manual'
  userId?: string
  // HX.1 — who caused this. Distinct from `userId` (a human id) because most placement writes come
  // from automation: `automation:rank-defend-<AdSchedule.id>` / `automation:rank-plan-<id>`. The
  // console resolves that prefix back to the schedule's name, so a change reads
  // "IT AIREON raised Top-of-Search bias" rather than showing an unattributed row.
  actor?: string
  reason?: string
  // ADX A2 — the RankTarget key this write was serving ('own-top', 'defend-top', …),
  // recorded as structured evidence so a placement move can be traced back to the
  // intent that caused it rather than only to the schedule that ran.
  targetKey?: string
  /** MCP full control A6 — tag the audit row with a change set (an approved request's id). Optional; additive. */
  changeSetId?: string | null
  /**
   * G.4 — re-sending a write Amazon did not take (the failed-write sweep). The local copy then holds the
   * undelivered values, so every placement in `adjustments` counts as set by this write, none as carried.
   */
  resend?: boolean
  /** 1e (CM-10) — a person's own edit from a screen (isPersonEdit, with a `user:` actor): passes the halt and autonomy OFF. Set only by the routes. */
  manual?: boolean
  /**
   * CM-18 — `adjustments` lists only the lanes a person changed. Every listed lane is set (0 clears it); a lane left out
   * is not touched: it keeps Amazon's current value on a live push, the stored value otherwise. Without it, a lane left
   * out while stored above 0 is removed — the full-array contract the engines and undo send.
   */
  partial?: boolean
}
/**
 * PLC.3 — the refused shape, so a refusal can be RENDERED rather than only logged.
 *
 * `reason` and `deniedAt` are optional and only ever set when `mode === 'blocked'`, so every
 * existing caller compiles and behaves identically. Before this, the gate's sentence — which
 * `pinDenial` writes in full, in the operator's own words — was computed, logged, written into the
 * audit row's `note`, and then **dropped at the return**. The one surface a human uses could not
 * say why their write was refused, which is exactly what substrate spec §5.5 forbids.
 */
export interface PlacementBiddingResult {
  ok: boolean
  adjustments: Array<{ placement: string; percentage: number }>
  mode: string
  /** the gate's own sentence, verbatim — never paraphrased. Set only when blocked. */
  reason?: string
  /** which gate refused: authority_pin · campaign_allowlist · automation_halted · … */
  deniedAt?: string
  /** 4e (review 5.9) — Amazon's error when the live push failed (not a refusal: the local copy and history are written). */
  error?: string
}
export async function updatePlacementBidding(input: PlacementBiddingInput): Promise<PlacementBiddingResult> {
  const c = await prisma.campaign.findUnique({ where: { id: input.campaignId }, select: { externalCampaignId: true, marketplace: true, dynamicBidding: true, name: true, adProduct: true, type: true } })
  if (!c) throw new Error('campaign not found')
  // G.4 — `let`: on a live push this becomes the array merged onto Amazon's current one, i.e. what was sent.
  let adjustments = input.adjustments
    .filter((a) => a.placement)
    .map((a) => ({ placement: a.placement, percentage: Math.max(0, Math.min(900, Math.round(a.percentage))) }))
  // D1 — snapshot the prior placement bias so a mis-firing change can be rolled back.
  // G.4 — the local copy until Amazon's current array is read before a live push; then that array.
  let priorAdjustments = ((c.dynamicBidding as { placementBidding?: Array<{ placement: string; percentage: number }> })?.placementBidding) ?? []
  // CM-18 — a partial write: the lanes it leaves out keep the stored value, until a live push merges onto Amazon's instead.
  const requested = adjustments
  if (input.partial) adjustments = mergeOntoAmazonPlacements(requested, priorAdjustments, priorAdjustments, { partial: true }).adjustments
  let drift: Array<{ placement: string; local: number; amazon: number }> = []
  let mode = 'local'
  // AR — placement writes go inline (not via the queued+stamped worker path), so a
  // failed push to Amazon was previously invisible AND unrecoverable. Stamp the
  // campaign with the push outcome so a failure is observable on lastSyncStatus and
  // the auto-reconcile sweep can re-push it. Only stamp on a real live attempt.
  let syncStamp: { lastSyncedAt: Date; lastSyncStatus: 'SUCCESS' | 'FAILED'; lastSyncError: string | null } | null = null
  /**
   * ACR.0.7b — a gate denial must not leave local state claiming a change Amazon never got.
   *
   * Previously a gated write skipped the push but still ran the campaign.update below, so
   * `dynamicBidding.placementBidding` moved locally while Amazon kept the old value — and
   * because `syncStamp` stays null when gated, `lastSyncStatus` was never set to FAILED, so
   * the auto-reconcile sweep (which only re-pushes FAILED entities) could never repair it.
   * Silent, permanent local≠Amazon divergence, recorded as SUCCESS.
   *
   * Measured 2026-08-05: with the account halted, one rank-defend tick produced 21 such rows
   * in 40 seconds. It was survivable before only because the gate almost never denied.
   *
   * NOT the same as sandbox: sandbox SHOULD write locally — that is what sandbox is for.
   * Only a genuine refusal suppresses the local mutation.
   */
  // 6a — placement bias is a Sponsored Products setting, PUT to /sp/campaigns. A Sponsored Brands or Display campaign is
  // refused down the same path as a gate denial: nothing changes here or on Amazon, and the sentence is returned.
  let gateDenial: string | null = adProductRefusal(c, { unknown: 'allow' })
  // PLC.3 — which gate refused, kept beside the sentence so the UI can link to the control that
  // clears it (`authority_pin` → this page's pin toggle; `campaign_allowlist` → Apply Rules).
  let gateDeniedAt: string | null = gateDenial ? AD_PRODUCT_UNSUPPORTED : null
  if (!gateDenial && c.externalCampaignId && c.marketplace) {
    const ctx = await resolveCtx(c.marketplace)
    if (ctx) {
      // C1 — pass campaignId so placement writes honour the SAME per-campaign live-write allowlist
      // as every bid write (previously omitted → placement bias bypassed the allowlist entirely).
      // ACR.1.2b — this path pushes multipliers inline rather than through the queue, so it
      // has no fieldChanges for the gate to derive a dimension from. It names its own.
      // Without this the placement pin would be the one pin that never bound anything —
      // and placement bias is the rank engine's primary actuator, running to +900%.
      const gate = await checkAdsWriteGate({ marketplace: c.marketplace, campaignId: input.campaignId, payloadValueCents: 0, dimension: 'placement', manual: isPersonEdit(input.manual, input.actor) })
      if (!gate.allowed) {
        gateDenial = (gate as { reason?: string }).reason ?? 'write gate denied'
        gateDeniedAt = (gate as { deniedAt?: string }).deniedAt ?? null
        logger.warn('[AX2.2] placement write gated', { campaignId: input.campaignId, reason: gateDenial, deniedAt: gateDeniedAt })
      } else {
        /**
         * G.4 — read Amazon's current array (through the gateway, like the PUT) and merge onto it.
         *
         * The PUT replaces the whole array, and callers build theirs from the local copy, which the
         * settings sync refreshes every 20 minutes — so a lane this write does not set used to go out
         * at a stale value, overwriting a change made in Amazon's console in those minutes.
         * `mergeOntoAmazonPlacements` keeps Amazon's value for every lane this write does not set.
         *
         * No read, no write: a failed read is refused exactly like a gate denial below (nothing changes
         * here or on Amazon; safe to retry). Sandbox has no Amazon to read (the list answers a fixture),
         * so it sends the array as given, as before.
         */
        let readError: string | null = null
        if (adsMode() === 'live') {
          try {
            const cur = (await listCampaignsV3(ctx, { campaignIds: [c.externalCampaignId] }))
              .find((x) => String(x.campaignId) === c.externalCampaignId)
            // SP v3 always reports `dynamicBidding` (it carries the strategy); without it the lanes
            // are unknown, not empty. `placementBidding` itself is left out when no lane is set.
            if (cur?.dynamicBidding) {
              const amazonNow = cur.dynamicBidding.placementBidding ?? []
              const merged = mergeOntoAmazonPlacements(requested, priorAdjustments, amazonNow, { resend: input.resend, partial: input.partial })
              drift = merged.drift
              if (drift.length) logger.warn('[AX2.2] placement drift: Amazon differs from the local copy', { campaignId: input.campaignId, drift })
              adjustments = merged.adjustments
              priorAdjustments = amazonNow
            } else {
              readError = cur ? 'Amazon returned the campaign without its placement settings' : 'Amazon did not return the campaign'
            }
          } catch (e) {
            readError = (e as Error).message
          }
        }
        if (readError) {
          gateDenial = 'Amazon\'s current placement settings for this campaign could not be read, so nothing was sent: sending without them could overwrite a change made in Amazon\'s console. Nothing changed; it is safe to try again.'
          gateDeniedAt = 'placement_read'
          logger.warn('[AX2.2] placement write refused: current placements unreadable', { campaignId: input.campaignId, error: readError.slice(0, 300) })
        } else {
          const r = await updateCampaign(ctx, c.externalCampaignId, { placementBidding: adjustments, biddingStrategy: input.biddingStrategy })
          mode = r.mode
          if (r.mode !== 'sandbox') {
            syncStamp = { lastSyncedAt: new Date(), lastSyncStatus: r.ok ? 'SUCCESS' : 'FAILED', lastSyncError: r.ok ? null : (r.error ?? 'placement push failed') }
          }
        }
      }
    }
  }
  // ACR.0.7b — refused writes change nothing locally. Returning before the audit block too:
  // a denial is not a placement change, so it must not appear in CampaignBidHistory as
  // "PLACEMENT_TOP 100 → 115" beside changes that actually happened. G.4 — an unreadable
  // current array (deniedAt 'placement_read') is refused the same way.
  if (gateDenial) {
    await audit(
      'update_placement_bidding', 'CAMPAIGN', input.campaignId,
      { adjustments, mode: 'blocked', error: gateDenial },
      input.actor ?? input.userId ?? 'system',
      { adjustments: priorAdjustments },
      'FAILED',
      { targetKey: input.targetKey, metric: 'placementBidding', note: `blocked: ${gateDenial}` },
      input.changeSetId ?? null,
    ).catch(() => { /* an audit row must never fail the write it describes */ })
    // PLC.3 — carry the sentence out. The audit row above, the history rows, the log line and the
    // allowed path below are all unchanged; this return gains two optional fields.
    return { ok: false, adjustments: priorAdjustments, mode: 'blocked', reason: gateDenial, ...(gateDeniedAt ? { deniedAt: gateDeniedAt } : {}) }
  }

  // G.4 — the local copy becomes what was actually sent (merged onto Amazon's current array on a live push).
  // CM-6 — and ONLY that key is written, into the row as it is now. The copy read at the top is seconds old here (the
  // gate, Amazon's read and the PUT ran in between); writing it back whole put back a Target ACoS, bid automation,
  // algorithm, guardrail or CPC ceiling saved meanwhile (`patchDynamicBidding`).
  await patchDynamicBidding(input.campaignId, { set: { placementBidding: adjustments } }, { ...(syncStamp ?? {}), ...(input.biddingStrategy ? { biddingStrategy: input.biddingStrategy === 'autoForSales' ? 'AUTO_FOR_SALES' : input.biddingStrategy === 'manual' ? 'MANUAL' : 'LEGACY_FOR_SALES' } : {}) })

  /**
   * HX.2 — placement writes join the audit spine.
   *
   * This is the single most-executed ads write we make: rank-defend holds a rank by moving the
   * placement bias, every 15 minutes, across every enabled schedule. Until now it wrote ONLY an
   * AdvertisingActionLog row — no CampaignBidHistory, and (because the push is inline rather than
   * queued) no AdMutation. Every history surface in the console reads those two tables, so the
   * dominant action of the whole rank system was invisible in all of them: the schedule activity
   * drawer rendered "No changes recorded yet" for a schedule doing its job correctly.
   *
   * ONE ROW PER CHANGED PLACEMENT, not one row for the set — that matches how CampaignBidHistory
   * is designed (a single field's old → new) and makes the diff read as
   * "PLACEMENT_TOP 100 → 115" instead of an opaque blob. Unchanged placements write nothing, so a
   * tick that moves only Top-of-Search doesn't manufacture three rows of noise.
   *
   * G.4 — after a live read `priorAdjustments` is Amazon's array, so each row is a change Amazon got;
   * a console change folded into the local copy writes none (it is in the drift log line instead).
   */
  const priorPct = new Map(priorAdjustments.map((a) => [a.placement, a.percentage]))
  const changed = adjustments.filter((a) => priorPct.get(a.placement) !== a.percentage)
  if (changed.length) {
    await prisma.campaignBidHistory.createMany({
      data: changed.map((a) => ({
        entityType: 'CAMPAIGN',
        entityId: input.campaignId,
        campaignId: input.campaignId,
        field: a.placement,
        oldValue: priorPct.has(a.placement) ? String(priorPct.get(a.placement)) : null,
        newValue: String(a.percentage),
        // HX.1 — without an actor these rows can't be attributed to the schedule, plan or person
        // that caused them, which is the whole point of the history. 'system' only when a caller
        // genuinely has no actor to give.
        changedBy: input.actor ?? input.userId ?? 'system',
        reason: input.reason ?? null,
      })),
    }).catch(() => { /* best-effort — an audit row must never fail the write it describes */ })
  }

  // HX.1 — the real outcome. `syncStamp` is null when nothing was pushed live (sandbox, gated, or
  // no external id), in which case the row is a truthful local-only SUCCESS.
  const auditStatus = syncStamp ? (syncStamp.lastSyncStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILED') : 'SUCCESS'
  // ADX A2 — the same `?? 'system'` fallback as the CampaignBidHistory rows twenty lines up.
  // Without it the two records of ONE write disagreed: history said 'system', the audit log said
  // nothing at all. Measured on prod 2026-08-04: 10,120 update_placement_bidding audit rows with a
  // null actor — a third of the entire advertising audit log — of which 2,524 landed in the last
  // seven days, so this was ongoing rather than legacy. Placement bias is the rank engine's primary
  // actuator and runs to +900%, which makes it the worst thing in the account to be unable to
  // attribute. A caller that supplies no actor should still produce a row that says so.
  await audit(
    'update_placement_bidding', 'CAMPAIGN', input.campaignId,
    { adjustments, mode, ...(syncStamp?.lastSyncError ? { error: syncStamp.lastSyncError } : {}), ...(drift.length ? { drift } : {}) },
    input.actor ?? input.userId ?? 'system',
    { adjustments: priorAdjustments },
    auditStatus,
    // ADX A2 — what this write was chasing. The caller's `reason` is already a readable
    // sentence ("rank — Min bid placement 150→300%"); structuring the numbers beside it
    // is what makes "show me every placement move above 300%" answerable.
    {
      targetKey: input.targetKey,
      metric: 'placementBidding',
      observed: priorAdjustments.find((a) => a.placement === adjustments[0]?.placement)?.percentage ?? null,
      threshold: adjustments[0]?.percentage ?? null,
      note: input.reason ?? undefined,
    },
    input.changeSetId ?? null,
  )
  logger.info('[AX2.2] updatePlacementBidding', { campaignId: input.campaignId, adjustments, mode, status: auditStatus })
  return { ok: auditStatus !== 'FAILED', adjustments, mode, ...(syncStamp?.lastSyncError ? { error: syncStamp.lastSyncError } : {}) }
}

/**
 * ACR Stage 5 — create an SB creative by borrowing this account's own brand assets.
 *
 * SB is the one family that cannot be launched from structured fields alone: an ad needs a brand
 * logo living in Amazon's asset library, a brand name registered to the Brand Registry entity,
 * and a landing page. Building an asset-upload flow is a project of its own — but the account
 * already HAS all three, on the 4 existing SB campaigns. Stage 5.1 planned for exactly this
 * ("the 4 paused SB campaigns as templates"), and reading them back is what makes SB reachable
 * now rather than after a creative-management build.
 *
 * Template is resolved per MARKETPLACE, for the same reason `brandEntityId` is: a brand logo
 * asset and an Amazon store URL belong to one marketplace's Brand Registry.
 *
 * Returns the template it used, so the caller can show the operator whose creative was cloned
 * rather than silently inheriting someone else's headline.
 */
export interface SbTemplate {
  brandName: string
  logoAssetId?: string
  landingType: 'store' | 'productList' | 'url'
  landingUrl?: string
  sourceCampaign: string
}

export async function resolveSbTemplate(marketplace: string): Promise<SbTemplate | null> {
  const ctx = await resolveCtx(marketplace)
  if (!ctx) return null
  const sb = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_BRANDS', marketplace, externalCampaignId: { not: null } },
    select: { externalCampaignId: true, name: true },
  })
  const ids = sb.map((c) => c.externalCampaignId!).filter(Boolean)
  if (!ids.length) return null
  const ads = await listSbAds(ctx, { externalCampaignIds: ids })
  // Prefer a PUBLISHED creative — a rejected or draft one is not a template worth cloning.
  const best = ads.find((a) => a.creative?.creativeStatus === 'PUBLISHED' && a.creative?.brandLogoAssetID) ?? ads[0]
  if (!best?.creative) return null
  const src = sb.find((c) => c.externalCampaignId === String(best.campaignId))
  return {
    brandName: best.creative.brandName ?? '',
    logoAssetId: best.creative.brandLogoAssetID,
    landingType: best.landingPage?.url ? 'url' : 'productList',
    landingUrl: best.landingPage?.url,
    sourceCampaign: src?.name ?? String(best.campaignId ?? '?'),
  }
}

// 5b — the negative helpers below keep their names and shapes for their callers (launches, blueprints, AI goals, the
// bulk routes, the rule handlers) and delegate to the one negative write service (ads-negative-kw.service.ts). What
// changed for them: protected terms and Amazon's text limits bind, the live-write allowlist binds (a launch passes
// `creationFlow`), a retired negative can be added again, and a refused negative writes NO local row (`id: null`).
type LocalNegative = { id: string | null; externalTargetId: string | null; mode: string; refusal?: { deniedAt: string; reason: string }; error?: string }
const asLocal = (r: NegativeWriteResult): LocalNegative => ({
  id: r.adTargetId, externalTargetId: r.externalTargetId, mode: r.outcome === 'refused' || r.outcome === 'failed' ? r.outcome : r.mode,
  ...(r.refusal ? { refusal: r.refusal } : {}), ...(r.error ? { error: r.error } : {}),
})

export interface NewNegativeProductTarget { adGroupId: string; asin: string; userId?: string; creationFlow?: boolean; /** 1e — see NewKeyword.manual. */ manual?: boolean }
export async function createNegativeProductTargetLocal(input: NewNegativeProductTarget): Promise<LocalNegative> {
  return asLocal(await writeNegativeProductTarget({ adGroupId: input.adGroupId, asin: input.asin, userId: input.userId, creationFlow: input.creationFlow, manual: input.manual }))
}

// NT.4 — ad-group-level negative keyword (the funnel + Auto-isolation writes), match-typed.
export interface NewNegativeKeyword { adGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE'; userId?: string; creationFlow?: boolean; /** 1e — see NewKeyword.manual. */ manual?: boolean }
/**
 * 🔴 HV.9a — mirror an AD_GROUP negative that has ALREADY been created at Amazon.
 *
 * Distinct from `createNegativeKeywordLocal` below, which calls Amazon itself: re-using it after a push would create
 * the negative twice. Measured 2026-08-13, both proof writes: `motorradjacke 4xl` (id 53955160123085) and
 * `veste moto homme homologué` (id 48498817150724) were ENABLED at Amazon with no local row — our record and Amazon's
 * disagreeing, with neither side visible from the other. Heals a row the sync mirrored without an id.
 */
export async function mirrorNegativeKeywordLocal(input: {
  adGroupId: string; keywordText: string; matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
  externalTargetId: string | null; userId?: string
}): Promise<{ id: string; created: boolean }> {
  return mirrorNegativeKeyword({ scope: 'AD_GROUP', ...input })
}

export async function createNegativeKeywordLocal(input: NewNegativeKeyword): Promise<LocalNegative> {
  return asLocal(await writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: input.adGroupId, keywordText: input.keywordText, matchType: input.matchType, userId: input.userId, creationFlow: input.creationFlow, manual: input.manual }))
}

// LAUNCH-REPAIR — bulk ad-group negative keywords (funnel isolation). Idempotent: skips a negative
// that already exists for (adGroup, matchType, text). Used to back-fill the funnel de-dup negatives
// on campaigns launched via the API (which bypasses the wizard UI's applyAutoNegatives).
export async function bulkNegativeKeywords(items: Array<{ adGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE' }>, userId?: string): Promise<{ created: number; pushed: number; skipped: number; failed: number; errors: string[] }> {
  const out = { created: 0, pushed: 0, skipped: 0, failed: 0, errors: [] as string[] }
  for (const it of items) {
    const text = (it.keywordText || '').trim()
    if (!text || (it.matchType !== 'EXACT' && it.matchType !== 'PHRASE')) { out.failed++; out.errors.push('bad item ' + JSON.stringify(it)); continue }
    try {
      const r = await writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: it.adGroupId, keywordText: text, matchType: it.matchType, userId })
      if (r.outcome === 'already_existed') { out.skipped++; continue }
      if (r.outcome === 'refused' || r.outcome === 'failed') { out.failed++; out.errors.push('"' + text + '" ' + it.matchType + ': ' + (r.refusal ? `refused at ${r.refusal.deniedAt}: ${r.refusal.reason}` : r.error)); continue }
      out.created++
      if (r.externalTargetId) out.pushed++
      else out.errors.push('not pushed (' + r.mode + '): ' + it.matchType + ' "' + text + '"')
    } catch (e) { out.failed++; out.errors.push('"' + text + '" ' + it.matchType + ': ' + ((e as Error)?.message || '')) }
  }
  logger.info('[LAUNCH-REPAIR] bulkNegativeKeywords', out)
  return out
}

// H.7 — persist a CAMPAIGN-scope negative keyword that has ALREADY been created at Amazon as a local mirror row,
// matching how the sync stores campaign negatives: AdTarget with negativeLevel='CAMPAIGN' + expressionType=
// 'NEGATIVE_<mt>', attached to a representative ad group of the campaign (the schema's legacy structure). 5b — a new
// campaign negative goes through writeNegativeKeyword({ scope: 'CAMPAIGN' }), which pushes AND records it.
export async function createNegativeKeywordCampaignLocal(input: { externalCampaignId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE'; externalTargetId?: string | null; userId?: string }): Promise<{ id: string; created: boolean } | null> {
  const camp = await prisma.campaign.findFirst({ where: { externalCampaignId: input.externalCampaignId }, select: { id: true, adGroups: { select: { id: true }, take: 1 } } })
  if (!camp || camp.adGroups.length === 0) return null // no ad group to attach the campaign-level negative to
  return mirrorNegativeKeyword({
    scope: 'CAMPAIGN', adGroupId: camp.adGroups[0].id, campaignId: camp.id, keywordText: input.keywordText,
    matchType: `NEGATIVE_${input.matchType}`, externalTargetId: input.externalTargetId ?? null, userId: input.userId,
  })
}

// ── Phase 3 — named rank-schedule groups (one named schedule spanning many campaigns) ──────────
// A group is the authoring layer; saving it MATERIALIZES one AdSchedule row per member campaign
// (which the rank-defend cron already runs — engine untouched). Rebinds any existing per-campaign
// schedule to this group so a campaign is never double-scheduled (one campaign → one schedule row).
export interface RankScheduleGroupInput {
  id?: string; name: string; marketplace?: string | null; timezone?: string
  windows: unknown[]; defaultTargetKey?: string | null
  targetOverrides?: Record<string, unknown> // per-campaign map: { [campaignId]: { targetKey: {...} } }
  enabled?: boolean; campaignIds: string[]; portfolioId?: string | null; userId?: string
}
// A portfolio-scoped group covers the whole portfolio: its current, non-archived campaigns. Resolved
// by Campaign.portfolioId (the Amazon external id the /portfolios list also keys on).
export async function resolvePortfolioCampaignIds(portfolioId: string): Promise<string[]> {
  if (!portfolioId) return []
  const rows = await prisma.campaign.findMany({ where: { portfolioId, status: { not: 'ARCHIVED' } }, select: { id: true } })
  return rows.map((r) => r.id)
}

// 2a — `release`: what a save gave back (campaigns removed from the group, or every member of a group saved switched off).
export async function saveRankScheduleGroup(input: RankScheduleGroupInput): Promise<{ id: string; members: number; moved: number; release?: ReleaseReport }> {
  const name = (input.name || '').trim()
  if (!name) throw new Error('name is required')
  let campaignIds = [...new Set((input.campaignIds || []).filter(Boolean))]
  // Portfolio scope: auto-include the portfolio's current campaigns so a portfolio schedule always
  // covers the whole portfolio (and picks up any campaigns added to it since the last save). Members
  // still inherit `enabled` below, so a Manual group stays cron-safe even as it auto-grows.
  if (input.portfolioId) {
    const pcamps = await resolvePortfolioCampaignIds(String(input.portfolioId))
    campaignIds = [...new Set([...campaignIds, ...pcamps])]
  }
  const windows = Array.isArray(input.windows) ? input.windows : []
  const overrides = (input.targetOverrides ?? {}) as Record<string, unknown>
  const enabled = input.enabled !== false
  const tz = input.timezone || 'Europe/Rome'
  // RDX/B1 — derive the group's market from its members when the caller doesn't state one.
  // The rank builder has never sent `marketplace`, so this column was null on every live row and
  // the console's market switch had nothing to filter on. Derived only when the members agree:
  // a group spanning IT + DE has no single market, and guessing one would be worse than null.
  let marketplace = (input.marketplace as string | null | undefined) ?? null
  if (!marketplace && campaignIds.length) {
    try {
      const mc = await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { marketplace: true } })
      const distinct = [...new Set(mc.map((c) => c.marketplace).filter(Boolean) as string[])]
      if (distinct.length === 1) marketplace = distinct[0]
    } catch { /* best-effort — a failed derive must not block the save */ }
  }
  const gdata = { name, marketplace, timezone: tz, windows: windows as never, defaultTargetKey: input.defaultTargetKey ?? null, targetOverrides: overrides as never, enabled, portfolioId: input.portfolioId ?? null }
  // DPS.1 — belt-and-braces against duplicate groups. The client now sends the id it minted on the
  // first save, but a stale bundle (or a double-submit) can still arrive with no id. Since the block
  // below REBINDS each campaign's schedule to whichever group saved last, a blind create would strand
  // the previous group at zero members — which is exactly how the live account accumulated 8 empty
  // groups ("IT AIRMESH" ×4 in 82 seconds). Same name + same portfolio scope = the same schedule, so
  // adopt the existing row instead of minting a rival.
  let targetId = input.id ?? null
  if (!targetId) {
    const twin = await prisma.rankScheduleGroup.findFirst({
      where: { name, portfolioId: input.portfolioId ?? null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (twin) {
      targetId = twin.id
      logger.info('[DPS.1] adopted existing rank schedule group instead of creating a duplicate', { id: twin.id, name })
    }
  }
  const group = targetId
    ? await prisma.rankScheduleGroup.update({ where: { id: targetId }, data: gdata })
    : await prisma.rankScheduleGroup.create({ data: { ...gdata, createdBy: input.userId ?? null } })

  const camps = campaignIds.length ? await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(camps.map((c) => [c.id, c.name]))

  // Materialize: one AdSchedule per member campaign, bound to the group. Reuse any existing schedule
  // for the campaign (rebind to this group) so we never create a duplicate → one campaign, one row.
  let moved = 0
  for (const cid of campaignIds) {
    const perCamp = overrides[cid]
    const memberName = nameById.get(cid) ? `${nameById.get(cid)} — ${name}` : name
    const data = { name: memberName, windows: windows as never, timezone: tz, defaultTargetKey: input.defaultTargetKey ?? null, targetOverrides: (perCamp ?? {}) as never, enabled }
    // C2b — now that campaignId is UNIQUE this is a real upsert rather than a read-then-branch.
    // The old shape had a race: two concurrent saves both saw no existing row and both created one,
    // which is how a campaign ended up with two schedules in the first place. The constraint makes
    // that impossible and the upsert makes it correct instead of an error.
    const existing = await prisma.adSchedule.findFirst({ where: { campaignId: cid }, select: { groupId: true } })
    if (existing?.groupId && existing.groupId !== group.id) moved++
    await prisma.adSchedule.upsert({
      where: { workspace_campaignId: workspaceKey({ campaignId: cid }) },
      update: { ...data, groupId: group.id },
      create: { ...data, campaignId: cid, groupId: group.id },
    })
  }
  // Campaigns removed from the group → drop their (now-orphaned) execution rows.
  // 2a (review 3.2) — and give back what the schedule floored on them, once the rows are gone (a tick starting meanwhile
  // then cannot floor them again). A group saved switched off (Manual) holds none of its members: same give-back.
  const removed = await readScheduleMembers({ groupId: group.id, campaignIdNotIn: campaignIds })
  await prisma.adSchedule.deleteMany({ where: { groupId: group.id, campaignId: { notIn: campaignIds.length ? campaignIds : ['__none__'] } } })
  const released = [...removed, ...(enabled ? [] : await readScheduleMembers({ groupId: group.id }))]
  const release = released.length ? await releaseScheduleMembers(released, enabled ? 'campaign removed from its rank schedule' : 'its rank schedule was saved switched off') : undefined
  /**
   * HX.8 — snapshot the plan as it now stands.
   *
   * `saveRankScheduleGroup` overwrites `windows` in place, so before this there was no way to answer
   * "what did we change, and when did this schedule start behaving differently" — the first question
   * worth asking when a schedule stops performing.
   *
   * Written only when something MEANINGFUL differs from the latest snapshot. The builder saves on
   * every "Save Changes" click and the coverage panel re-saves a group just to append a campaign; a
   * naive append would bury the real edits under identical rows. Campaign count is part of the
   * comparison because "went from 11 campaigns to 1" is a plan change even when the windows didn't move.
   */
  try {
    const last = await prisma.rankScheduleVersion.findFirst({ where: { groupId: group.id }, orderBy: { createdAt: 'desc' }, select: { name: true, windows: true, defaultTargetKey: true, campaignCount: true, enabled: true } })
    const changed = !last
      || last.name !== name
      || (last.defaultTargetKey ?? null) !== (input.defaultTargetKey ?? null)
      || last.campaignCount !== campaignIds.length
      || last.enabled !== enabled
      || JSON.stringify(last.windows) !== JSON.stringify(windows)
    if (changed) {
      await prisma.rankScheduleVersion.create({
        data: { groupId: group.id, name, windows: windows as never, defaultTargetKey: input.defaultTargetKey ?? null, campaignCount: campaignIds.length, enabled, changedBy: input.userId ?? null },
      })
    }
  } catch (e) { logger.warn('[HX.8] version snapshot failed', { id: group.id, error: (e as Error).message }) }

  logger.info('[Phase3] saveRankScheduleGroup', { id: group.id, name, members: campaignIds.length, moved })
  return { id: group.id, members: campaignIds.length, moved, ...(release ? { release } : {}) }
}

// 2a (review 3.2) — deleting a group gives back what its schedules floored on every member, after the rows are gone.
export async function deleteRankScheduleGroup(id: string): Promise<{ ok: boolean; removedSchedules: number; release: ReleaseReport }> {
  const members = await readScheduleMembers({ groupId: id })
  const del = await prisma.adSchedule.deleteMany({ where: { groupId: id } })
  await prisma.rankScheduleGroup.delete({ where: { id } }).catch(() => {})
  const release = await releaseScheduleMembers(members, 'its rank schedule was deleted')
  logger.info('[Phase3] deleteRankScheduleGroup', { id, removedSchedules: del.count, restored: release.restored, deferred: release.deferred })
  return { ok: true, removedSchedules: del.count, release }
}
