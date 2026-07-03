/**
 * E4 (eBay Ads) — THE audited write layer. Every mutation flows through
 * executeOp(): validate → guardrails → gate (checkMarketingWriteGate) →
 * live eBay call OR sandbox → local mirror → CampaignAction audit.
 *
 * Gate semantics (P9/marketing-write-gate): with NEXUS_MARKETING_WRITES_EBAY
 * unset, mode='sandbox' — the DB mirror + audit happen, NO external call
 * fires. Flip the env after E4 acceptance and the same code drives eBay.
 * Sandbox-created campaigns get externalCampaignId 'sandbox-…' and are
 * SKIPPED by the entity sync (they don't exist on eBay); sandbox-created
 * ads carry status 'SANDBOX' and are exempt from the stale pass.
 *
 * Margin guardrail (§4.2): a rate above the listing's break-even is BLOCKED
 * unless the operator passes an explicit named override (audited). Listings
 * with no economics (MISSING_COGS) are allowed for MANUAL ops with a warning
 * — the manual-only restriction binds automations (E5), not operators.
 *
 * Deviation from the Amazon queue+grace pattern, on purpose: volumes here
 * are tiny (11 campaigns) and the console wants immediate per-item results,
 * so writes are synchronous. E5 automation applies through this same
 * service; queueing can layer later without changing callers.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { checkMarketingWriteGate } from './marketing-write-gate.js'
import { normalizeCampaignStatus, canTransitionCampaignStatus, EBAY_CAMPAIGN_STATUS_MAP, type NormalizedCampaignStatus } from '../ads-core/campaign-status.js'
import {
  getActiveEbayAdsAuth,
  createCampaignApi, campaignLifecycleApi, cloneCampaignApi,
  updateAdRateStrategyApi, updateCampaignBudgetApi, updateCampaignIdentificationApi,
  bulkCreateAdsByListingIdApi, bulkUpdateAdsBidApi, bulkDeleteAdsApi,
  createAdGroupApi, bulkCreateKeywordApi, bulkUpdateKeywordApi, bulkCreateNegativeKeywordApi,
  type BulkItemResult, type CreateCampaignPayload,
} from './ebay-ads-api.service.js'

export type WriteMode = 'sandbox' | 'live'
export interface OpContext { actorUserId: string | null }
export interface ItemOutcome { key: string; ok: boolean; mode: WriteMode; id?: string | null; error?: string | null; warning?: string | null; blocked?: string | null }

const CHUNK = 500 // verified bulk cap

export class GuardrailBlockedError extends Error {
  constructor(msg: string, public readonly items: ItemOutcome[] = []) { super(msg) }
}

// ── shared helpers ───────────────────────────────────────────────────────────
function chunk<T>(arr: T[], n = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export function validateRatePct(rate: number): string | null {
  if (!Number.isFinite(rate)) return 'rate is not a number'
  if (rate < 2 || rate > 100) return 'ad rate must be between 2% and 100% (eBay bounds)'
  return null
}

/** Margin guardrail decision for one listing (pure; unit-tested). */
export function rateGuardrail(
  ratePct: number,
  breakEvenPct: number | null,
  economicsStatus: string | null,
  override?: { reason: string },
): { blocked: string | null; warning: string | null } {
  if (breakEvenPct != null && ratePct > breakEvenPct) {
    if (override?.reason?.trim()) {
      return { blocked: null, warning: `rate ${ratePct}% exceeds break-even ${breakEvenPct}% — override: ${override.reason.trim()}` }
    }
    return { blocked: `rate ${ratePct}% exceeds break-even ${breakEvenPct}% (pass an explicit override with a reason to force)`, warning: null }
  }
  if (breakEvenPct == null) {
    const why = economicsStatus === 'MISSING_COGS' ? 'no product cost on file' : economicsStatus === 'MISSING_PRICE' ? 'no price on file' : 'no economics'
    return { blocked: null, warning: `break-even unknown (${why}) — margin not verified` }
  }
  return { blocked: null, warning: null }
}

async function loadBreakEvens(marketplaceShort: string, listingIds: string[]): Promise<Map<string, { be: number | null; status: string | null }>> {
  if (!listingIds.length) return new Map()
  const rows = await prisma.ebayListingEconomics.findMany({
    where: { marketplace: marketplaceShort, itemId: { in: listingIds } },
    select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true },
  })
  return new Map(rows.map((r) => [r.itemId, { be: r.breakEvenAdRatePct != null ? Number(r.breakEvenAdRatePct.toString()) : null, status: r.dataStatus }]))
}

async function killSwitchCheck(marketplace: string): Promise<void> {
  const ceiling = await prisma.marketingSpendCeiling.findFirst({ where: { channel: 'EBAY', marketplace, killSwitch: true } })
  if (ceiling) throw new Error(`kill switch is ON for EBAY/${marketplace} — all ad writes are halted`)
  const state = await prisma.marketingAutomationState.findUnique({ where: { channel: 'EBAY' } })
  if (state?.halted) throw new Error(`eBay ads automation state is HALTED (${state.haltReason ?? 'no reason recorded'}) — writes blocked`)
}

async function audit(params: {
  ctx: OpContext; actionType: string; entityType: string; entityId: string
  before: unknown; after: unknown; mode: WriteMode; status: 'SUCCESS' | 'FAILED' | 'PARTIAL'
  responseId?: string | null
}): Promise<void> {
  await prisma.campaignAction.create({
    data: {
      userId: params.ctx.actorUserId,
      channel: 'EBAY',
      actionType: params.actionType,
      entityType: params.entityType,
      entityId: params.entityId,
      payloadBefore: (params.before ?? {}) as object,
      payloadAfter: ({ ...(params.after as object ?? {}), _mode: params.mode }) as object,
      channelResponseId: params.responseId ?? null,
      channelResponseStatus: params.status,
    },
  }).catch((e) => logger.error(`[E4][ebay-ads] audit write failed: ${(e as Error).message}`))
}

const SHORT: Record<string, string> = { EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES', EBAY_GB: 'UK' }
const gate = (marketplace: string, valueCents = 0) =>
  checkMarketingWriteGate({ channel: 'EBAY', marketplace, payloadValueCents: valueCents })

// ═════════════════════════════════════════════════════════════════════════════
// Campaign lifecycle
// ═════════════════════════════════════════════════════════════════════════════
export async function campaignLifecycle(ctx: OpContext, campaignId: string, action: 'pause' | 'resume' | 'end') {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  const from = normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, c.status) as NormalizedCampaignStatus
  const to: NormalizedCampaignStatus = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'ACTIVE' : 'ENDED'
  if (!canTransitionCampaignStatus(from, to)) {
    throw new Error(`cannot ${action} a ${c.status} campaign (${from} → ${to} is not a legal transition)`)
  }
  const decision = gate(c.marketplace)
  const isSandboxCampaign = c.externalCampaignId.startsWith('sandbox-')
  if (decision.mode === 'live' && !isSandboxCampaign) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    await campaignLifecycleApi(auth.token, c.externalCampaignId, action)
  }
  const newStatus = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'RUNNING' : 'ENDED'
  await prisma.ebayCampaign.update({ where: { id: c.id }, data: { status: newStatus, ...(action === 'end' ? { endDate: new Date() } : {}) } })
  await audit({ ctx, actionType: `${action}_campaign`, entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { status: c.status }, after: { status: newStatus }, mode: decision.mode, status: 'SUCCESS' })
  return { ok: true, mode: decision.mode, status: newStatus }
}

export async function cloneCampaign(ctx: OpContext, campaignId: string, name: string) {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  const decision = gate(c.marketplace)
  let newExternalId = `sandbox-clone-${Date.now()}`
  if (decision.mode === 'live' && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    newExternalId = await cloneCampaignApi(auth.token, c.externalCampaignId, { campaignName: name, startDate: new Date().toISOString() })
  }
  const row = await prisma.ebayCampaign.create({
    data: {
      channelConnectionId: c.channelConnectionId,
      externalCampaignId: newExternalId,
      marketplace: c.marketplace,
      name,
      fundingStrategy: c.fundingStrategy,
      fundingModel: c.fundingModel,
      campaignTargetingType: c.campaignTargetingType,
      channels: c.channels,
      adRateStrategy: c.adRateStrategy,
      dynamicAdRatePrefs: c.dynamicAdRatePrefs ?? undefined,
      campaignCriterion: c.campaignCriterion ?? undefined,
      isRulesBased: c.isRulesBased,
      nexusManaged: true,
      bidPercentage: c.bidPercentage,
      dailyBudget: c.dailyBudget,
      budgetCurrency: c.budgetCurrency,
      status: decision.mode === 'live' ? 'RUNNING' : 'DRAFT',
      startDate: new Date(),
    },
  })
  // E7 #16 — clone-by-rematerialization (eBay's cloneCampaign only serves
  // ENDED rules-based CPS). Structure always copies; MEMBERS copy when legal:
  // CPS ads only if the source is ENDED (a live source still owns its
  // listings — one-listing-one-General); CPC groups/keywords/negatives can
  // always duplicate across campaigns.
  const counts = { ads: 0, adGroups: 0, keywords: 0, negatives: 0, rules: 0, skippedAds: 0 }
  const isCps = (c.fundingModel ?? 'COST_PER_SALE') === 'COST_PER_SALE'
  const sourceEnded = normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, c.status) === 'ENDED'
  if (isCps && !c.isRulesBased) {
    const ads = await prisma.ebayAd.findMany({ where: { campaignId: c.id, listingId: { not: null } } })
    if (sourceEnded && ads.length) {
      const r = await promoteListings(ctx, {
        campaignId: row.id,
        items: ads.map((a) => ({ listingId: a.listingId!, ratePct: a.bidPercentage != null ? Number(a.bidPercentage.toString()) : undefined })),
        override: { reason: `clone of ended campaign ${c.externalCampaignId}` },
      })
      counts.ads = r.results.filter((x) => x.ok).length
    } else {
      counts.skippedAds = ads.length // live source keeps its listings; move via the builder
    }
  } else if (!isCps) {
    const groups = await prisma.ebayAdGroup.findMany({ where: { campaignId: c.id }, include: { keywords: true } })
    const negs = await prisma.ebayNegativeKeyword.findMany({ where: { campaignId: c.id } })
    for (const g of groups) {
      const ng = await createAdGroup(ctx, row.id, g.name, g.defaultBidCents ?? undefined)
      counts.adGroups++
      if (g.keywords.length) {
        const kr = await addKeywords(ctx, row.id, ng.adGroupId, g.keywords.map((k) => ({ text: k.text, matchType: k.matchType, bidCents: k.bidCents ?? undefined })))
        counts.keywords += kr.results.filter((x) => x.ok).length
      }
      const groupNegs = negs.filter((n) => n.adGroupId === g.id)
      if (groupNegs.length) {
        const nr = await addNegatives(ctx, row.id, ng.adGroupId, groupNegs.map((n) => ({ text: n.text, matchType: n.matchType as 'EXACT' | 'PHRASE' })))
        counts.negatives += nr.results.filter((x) => x.ok).length
      }
    }
  }
  // scoped rule bindings referencing the source clone over to the new campaign
  const scopedRules = await prisma.ebayAdsRule.findMany({ where: { scope: { path: ['campaignIds'], array_contains: c.id } } }).catch(() => [] as Array<{ name: string; mode: string; marketplace: string | null; trigger: unknown; action: unknown; guardrails: unknown; cooldownHours: number }>)
  for (const sr of scopedRules) {
    await prisma.ebayAdsRule.create({
      data: { name: sr.name.replace(c.name, name), enabled: true, mode: sr.mode, marketplace: sr.marketplace, scope: { campaignIds: [row.id] } as object, trigger: sr.trigger as object, action: sr.action as object, guardrails: (sr.guardrails ?? {}) as object, cooldownHours: sr.cooldownHours },
    })
    counts.rules++
  }

  await audit({ ctx, actionType: 'clone_campaign', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { source: c.externalCampaignId }, after: { newExternalId, name, counts }, mode: decision.mode, status: 'SUCCESS', responseId: newExternalId })
  return { ok: true, mode: decision.mode, campaignId: row.id, externalCampaignId: newExternalId, counts }
}

// ═════════════════════════════════════════════════════════════════════════════
// Campaign create (builder) — CPS fixed/dynamic/rules + CPC manual/smart
// ═════════════════════════════════════════════════════════════════════════════
export interface CreateCampaignInput {
  name: string
  marketplace: string
  fundingModel: 'COST_PER_SALE' | 'COST_PER_CLICK'
  targetingType?: 'MANUAL' | 'SMART'
  channels?: string[]
  ratePct?: number
  adRateStrategy?: 'FIXED' | 'DYNAMIC'
  dynamicCapPct?: number
  dynamicAdjustmentPct?: number
  dailyBudgetCents?: number
  maxCpcCents?: number
  selectionRules?: unknown[]
  autoSelectFutureInventory?: boolean
}

export async function createCampaign(ctx: OpContext, input: CreateCampaignInput) {
  await killSwitchCheck(input.marketplace)
  if (input.marketplace === 'EBAY_ES' && input.fundingModel === 'COST_PER_CLICK') {
    throw new Error('Priority campaigns are not available on eBay Spain (verified marketplace limitation)')
  }
  const isCps = input.fundingModel === 'COST_PER_SALE'
  if (isCps && input.adRateStrategy !== 'DYNAMIC') {
    const err = input.ratePct == null ? 'ratePct is required for a fixed-rate General campaign' : validateRatePct(input.ratePct)
    if (err) throw new Error(err)
  }
  if (isCps && input.adRateStrategy === 'DYNAMIC' && (input.dynamicCapPct == null || input.dynamicCapPct < 2)) {
    throw new Error('a dynamic-rate campaign requires a hard cap (adRateCapPercent ≥ 2%) — the margin guardrail depends on it')
  }
  if (!isCps && (input.dailyBudgetCents == null || input.dailyBudgetCents < 100)) {
    throw new Error('a Priority campaign requires a daily budget (≥ €1.00)')
  }
  if (!isCps && input.targetingType === 'SMART' && (input.maxCpcCents == null || input.maxCpcCents < 2)) {
    throw new Error('a Smart Priority campaign requires maxCpc (≥ €0.02)')
  }

  const decision = gate(input.marketplace, input.dailyBudgetCents ?? 0)
  const conn = await prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })

  let externalCampaignId = `sandbox-${Date.now()}`
  if (decision.mode === 'live') {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    const payload: CreateCampaignPayload = {
      campaignName: input.name,
      marketplaceId: input.marketplace,
      startDate: new Date().toISOString(),
      channels: input.channels?.length ? input.channels : ['ON_SITE'],
      fundingStrategy: isCps
        ? {
            fundingModel: 'COST_PER_SALE',
            adRateStrategy: input.adRateStrategy ?? 'FIXED',
            ...(input.adRateStrategy === 'DYNAMIC'
              ? { dynamicAdRatePreferences: [{ adRateAdjustmentPercent: String(input.dynamicAdjustmentPct ?? 0), adRateCapPercent: String(input.dynamicCapPct) }] }
              : { bidPercentage: String(input.ratePct) }),
          }
        : {
            fundingModel: 'COST_PER_CLICK',
            ...(input.targetingType === 'SMART'
              ? { bidPreferences: [{ maxCpc: { amount: { currency: 'EUR', value: (input.maxCpcCents! / 100).toFixed(2) } } }] }
              : { biddingStrategy: 'FIXED' }),
          },
      ...(isCps ? {} : { campaignTargetingType: input.targetingType ?? 'MANUAL' }),
      ...(!isCps ? { budget: { daily: { amount: { currency: 'EUR', value: (input.dailyBudgetCents! / 100).toFixed(2) } } } } : {}),
      ...(input.selectionRules?.length
        ? { campaignCriterion: { autoSelectFutureInventory: input.autoSelectFutureInventory ?? false, selectionRules: input.selectionRules } }
        : {}),
    }
    externalCampaignId = await createCampaignApi(auth.token, payload)
  }

  const row = await prisma.ebayCampaign.create({
    data: {
      channelConnectionId: conn.id,
      externalCampaignId,
      marketplace: input.marketplace,
      name: input.name,
      fundingStrategy: isCps ? 'STANDARD' : 'ADVANCED',
      fundingModel: input.fundingModel,
      campaignTargetingType: isCps ? null : input.targetingType ?? 'MANUAL',
      channels: input.channels?.length ? input.channels : ['ON_SITE'],
      adRateStrategy: isCps ? input.adRateStrategy ?? 'FIXED' : null,
      dynamicAdRatePrefs: input.adRateStrategy === 'DYNAMIC' ? [{ adRateAdjustmentPercent: String(input.dynamicAdjustmentPct ?? 0), adRateCapPercent: String(input.dynamicCapPct) }] : undefined,
      campaignCriterion: input.selectionRules?.length ? ({ autoSelectFutureInventory: input.autoSelectFutureInventory ?? false, selectionRules: input.selectionRules } as object) : undefined,
      isRulesBased: !!input.selectionRules?.length,
      nexusManaged: true,
      bidPercentage: isCps && input.adRateStrategy !== 'DYNAMIC' ? String(input.ratePct) : null,
      dailyBudget: !isCps ? (input.dailyBudgetCents! / 100).toFixed(2) : null,
      budgetCurrency: 'EUR',
      status: decision.mode === 'live' ? 'RUNNING' : 'DRAFT',
      startDate: new Date(),
    },
  })
  await audit({ ctx, actionType: 'create_campaign', entityType: 'CAMPAIGN', entityId: externalCampaignId, before: {}, after: input as unknown as object, mode: decision.mode, status: 'SUCCESS', responseId: externalCampaignId })
  return { ok: true, mode: decision.mode, campaignId: row.id, externalCampaignId }
}

// ═════════════════════════════════════════════════════════════════════════════
// Promote (bulk create ads) / set rates / remove ads
// ═════════════════════════════════════════════════════════════════════════════
export interface PromoteInput {
  campaignId: string
  items: Array<{ listingId: string; ratePct?: number }>
  defaultRatePct?: number
  override?: { reason: string }
}

export async function promoteListings(ctx: OpContext, input: PromoteInput): Promise<{ mode: WriteMode; results: ItemOutcome[] }> {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: input.campaignId } })
  await killSwitchCheck(c.marketplace)
  if ((c.fundingModel ?? 'COST_PER_SALE') !== 'COST_PER_SALE') throw new Error('promote-by-listing targets General (CPS) campaigns; Priority attaches listings via its own builder')
  if (c.isRulesBased) throw new Error('this campaign is rules-based — eBay selects its listings automatically (adjust the rules, or use a key-based campaign)')

  const existing = new Set((await prisma.ebayAd.findMany({ where: { campaignId: c.id, listingId: { not: null } }, select: { listingId: true } })).map((a) => a.listingId!))
  const short = SHORT[c.marketplace] ?? 'IT'
  const be = await loadBreakEvens(short, input.items.map((i) => i.listingId))
  const decision = gate(c.marketplace)
  const results: ItemOutcome[] = []
  const toCreate: Array<{ listingId: string; ratePct: number }> = []
  const warnings = new Map<string, string>()

  for (const item of input.items) {
    const ratePct = item.ratePct ?? input.defaultRatePct ?? (c.bidPercentage != null ? Number(c.bidPercentage.toString()) : NaN)
    const invalid = validateRatePct(ratePct)
    if (invalid) { results.push({ key: item.listingId, ok: false, mode: decision.mode, error: invalid }); continue }
    if (existing.has(item.listingId)) { results.push({ key: item.listingId, ok: true, mode: decision.mode, warning: 'already in this campaign — skipped' }); continue }
    const eco = be.get(item.listingId)
    const guard = rateGuardrail(ratePct, eco?.be ?? null, eco?.status ?? null, input.override)
    if (guard.blocked) { results.push({ key: item.listingId, ok: false, mode: decision.mode, blocked: guard.blocked }); continue }
    toCreate.push({ listingId: item.listingId, ratePct })
    if (guard.warning) warnings.set(item.listingId, guard.warning)
  }

  let live: BulkItemResult[] = []
  if (decision.mode === 'live' && toCreate.length && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    for (const batch of chunk(toCreate)) {
      live.push(...await bulkCreateAdsByListingIdApi(auth.token, c.externalCampaignId, batch.map((b) => ({ listingId: b.listingId, bidPercentage: b.ratePct.toFixed(1) }))))
    }
  }
  const liveByKey = new Map(live.map((l) => [l.key, l]))

  for (const item of toCreate) {
    const lr = liveByKey.get(item.listingId)
    const ok = decision.mode === 'sandbox' ? true : lr?.ok ?? false
    if (!ok && decision.mode === 'live') {
      logger.warn(`[E4][ebay-ads] bulkCreate item failed listing=${item.listingId}: ${lr?.error ?? 'no per-item response matched'}`)
    }
    if (ok) {
      await prisma.ebayAd.upsert({
        where: { campaignId_listingId: { campaignId: c.id, listingId: item.listingId } },
        create: {
          campaignId: c.id, marketplace: c.marketplace, listingId: item.listingId,
          externalAdId: lr?.id ?? null, bidPercentage: item.ratePct.toFixed(1),
          status: decision.mode === 'live' ? 'ACTIVE' : 'SANDBOX', createdVia: 'CONSOLE',
        },
        update: { bidPercentage: item.ratePct.toFixed(1), externalAdId: lr?.id ?? undefined },
      })
    }
    results.push({ key: item.listingId, ok, mode: decision.mode, id: lr?.id ?? null, error: lr?.error ?? null, warning: warnings.get(item.listingId) ?? null })
  }

  const okCount = results.filter((r) => r.ok).length
  await audit({
    ctx, actionType: 'bulk_create_ads', entityType: 'CAMPAIGN', entityId: c.externalCampaignId,
    before: { existingAds: existing.size },
    // rates map = the reconciliation baseline (E7 #25 drift detection)
    after: { requested: input.items.length, created: toCreate.length, rates: Object.fromEntries(toCreate.map((i) => [i.listingId, i.ratePct])), results: results.slice(0, 100) },
    mode: decision.mode, status: okCount === results.length ? 'SUCCESS' : okCount > 0 ? 'PARTIAL' : 'FAILED',
  })
  return { mode: decision.mode, results }
}

export async function setAdRates(ctx: OpContext, campaignId: string, items: Array<{ listingId: string; ratePct: number }>, override?: { reason: string }): Promise<{ mode: WriteMode; results: ItemOutcome[] }> {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  const short = SHORT[c.marketplace] ?? 'IT'
  const be = await loadBreakEvens(short, items.map((i) => i.listingId))
  const decision = gate(c.marketplace)
  const ads = await prisma.ebayAd.findMany({ where: { campaignId: c.id, listingId: { in: items.map((i) => i.listingId) } } })
  const adByListing = new Map(ads.map((a) => [a.listingId!, a]))
  const results: ItemOutcome[] = []
  const toPush: Array<{ listingId: string; ratePct: number }> = []

  for (const item of items) {
    const invalid = validateRatePct(item.ratePct)
    if (invalid) { results.push({ key: item.listingId, ok: false, mode: decision.mode, error: invalid }); continue }
    if (!adByListing.has(item.listingId)) { results.push({ key: item.listingId, ok: false, mode: decision.mode, error: 'no ad for this listing in this campaign' }); continue }
    const eco = be.get(item.listingId)
    const guard = rateGuardrail(item.ratePct, eco?.be ?? null, eco?.status ?? null, override)
    if (guard.blocked) { results.push({ key: item.listingId, ok: false, mode: decision.mode, blocked: guard.blocked }); continue }
    toPush.push(item)
    results.push({ key: item.listingId, ok: true, mode: decision.mode, warning: guard.warning ?? null })
  }

  let live: BulkItemResult[] = []
  if (decision.mode === 'live' && toPush.length && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    for (const batch of chunk(toPush)) {
      live.push(...await bulkUpdateAdsBidApi(auth.token, c.externalCampaignId, batch.map((b) => ({ listingId: b.listingId, bidPercentage: b.ratePct.toFixed(1) }))))
    }
    for (const l of live.filter((x) => !x.ok)) {
      const r = results.find((x) => x.key === l.key)
      if (r) { r.ok = false; r.error = l.error }
    }
  }
  for (const item of toPush) {
    const r = results.find((x) => x.key === item.listingId)
    if (!r?.ok) continue
    const ad = adByListing.get(item.listingId)!
    await prisma.ebayAd.update({ where: { id: ad.id }, data: { bidPercentage: item.ratePct.toFixed(1) } })
  }

  await audit({
    ctx, actionType: 'bulk_update_ad_rates', entityType: 'CAMPAIGN', entityId: c.externalCampaignId,
    before: { rates: Object.fromEntries(ads.map((a) => [a.listingId, a.bidPercentage?.toString() ?? null])) },
    after: { rates: Object.fromEntries(items.map((i) => [i.listingId, i.ratePct])), results: results.slice(0, 100) },
    mode: decision.mode, status: results.every((r) => r.ok) ? 'SUCCESS' : results.some((r) => r.ok) ? 'PARTIAL' : 'FAILED',
  })
  return { mode: decision.mode, results }
}

export async function removeAds(ctx: OpContext, campaignId: string, listingIds: string[]): Promise<{ mode: WriteMode; results: ItemOutcome[] }> {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  const decision = gate(c.marketplace)
  let live: BulkItemResult[] = []
  if (decision.mode === 'live' && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    for (const batch of chunk(listingIds)) live.push(...await bulkDeleteAdsApi(auth.token, c.externalCampaignId, batch))
  }
  const liveByKey = new Map(live.map((l) => [l.key, l]))
  const results: ItemOutcome[] = []
  for (const listingId of listingIds) {
    const lr = liveByKey.get(listingId)
    const ok = decision.mode === 'sandbox' ? true : lr?.ok ?? false
    if (ok) await prisma.ebayAd.deleteMany({ where: { campaignId: c.id, listingId } })
    results.push({ key: listingId, ok, mode: decision.mode, error: lr?.error ?? null })
  }
  await audit({ ctx, actionType: 'bulk_delete_ads', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { listingIds }, after: { results: results.slice(0, 100) }, mode: decision.mode, status: results.every((r) => r.ok) ? 'SUCCESS' : 'PARTIAL' })
  return { mode: decision.mode, results }
}

// ═════════════════════════════════════════════════════════════════════════════
// Rate strategy / budget (quota-guarded)
// ═════════════════════════════════════════════════════════════════════════════
export async function updateRateStrategy(ctx: OpContext, campaignId: string, input: { adRateStrategy: 'FIXED' | 'DYNAMIC'; ratePct?: number; capPct?: number; adjustmentPct?: number }) {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  if ((c.fundingModel ?? 'COST_PER_SALE') !== 'COST_PER_SALE') throw new Error('rate strategy applies to General (CPS) campaigns')
  if (input.adRateStrategy === 'DYNAMIC' && (input.capPct == null || input.capPct < 2)) throw new Error('DYNAMIC requires a hard cap (≥2%) — the margin guardrail depends on it')
  if (input.adRateStrategy === 'FIXED') {
    const err = input.ratePct == null ? 'ratePct required for FIXED' : validateRatePct(input.ratePct)
    if (err) throw new Error(err)
  }
  const decision = gate(c.marketplace)
  const prefs = input.adRateStrategy === 'DYNAMIC' ? [{ adRateAdjustmentPercent: String(input.adjustmentPct ?? 0), adRateCapPercent: String(input.capPct) }] : undefined
  if (decision.mode === 'live' && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    await updateAdRateStrategyApi(auth.token, c.externalCampaignId, {
      adRateStrategy: input.adRateStrategy,
      ...(input.adRateStrategy === 'FIXED' ? { bidPercentage: String(input.ratePct) } : { dynamicAdRatePreferences: prefs }),
    })
  }
  await prisma.ebayCampaign.update({
    where: { id: c.id },
    data: {
      adRateStrategy: input.adRateStrategy,
      bidPercentage: input.adRateStrategy === 'FIXED' ? String(input.ratePct) : null,
      dynamicAdRatePrefs: prefs ?? undefined,
    },
  })
  await audit({ ctx, actionType: 'update_ad_rate_strategy', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { adRateStrategy: c.adRateStrategy, bidPercentage: c.bidPercentage?.toString() ?? null, dynamicAdRatePrefs: c.dynamicAdRatePrefs }, after: input as unknown as object, mode: decision.mode, status: 'SUCCESS' })
  return { ok: true, mode: decision.mode }
}

export async function updateBudget(ctx: OpContext, campaignId: string, dailyBudgetCents: number) {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  if ((c.fundingModel ?? '') !== 'COST_PER_CLICK') throw new Error('daily budget applies to Priority/Offsite (CPC) campaigns')
  if (dailyBudgetCents < 100) throw new Error('daily budget must be ≥ €1.00')

  // 15/day/campaign hard quota (verified) — enforced OUR side before eBay's.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const sameDay = c.budgetUpdatesDay != null && c.budgetUpdatesDay.getTime() === today.getTime()
  const used = sameDay ? c.budgetUpdatesToday : 0
  if (used >= 15) throw new Error(`budget-update quota exhausted for today (15/15 used) — eBay enforces 15 updates per campaign per day`)

  const decision = gate(c.marketplace, dailyBudgetCents)
  if (!decision.allowed) throw new Error(`write gate blocked: ${'reason' in decision ? decision.reason : 'unknown'}`)
  if (decision.mode === 'live' && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    await updateCampaignBudgetApi(auth.token, c.externalCampaignId, { budget: { daily: { amount: { currency: c.budgetCurrency ?? 'EUR', value: (dailyBudgetCents / 100).toFixed(2) } } } })
  }
  await prisma.ebayCampaign.update({
    where: { id: c.id },
    data: { dailyBudget: (dailyBudgetCents / 100).toFixed(2), budgetUpdatesToday: used + 1, budgetUpdatesDay: today },
  })
  await audit({ ctx, actionType: 'set_campaign_budget', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { dailyBudget: c.dailyBudget?.toString() ?? null, budgetUpdatesToday: used }, after: { dailyBudgetCents, budgetUpdatesToday: used + 1 }, mode: decision.mode, status: 'SUCCESS' })
  return { ok: true, mode: decision.mode, budgetUpdatesToday: used + 1 }
}

// ER1 — rename + end-date edits via eBay updateCampaignIdentification
// (Details tab v2). Start date is immutable once a campaign has launched.
export async function updateCampaignIdentification(ctx: OpContext, campaignId: string, input: { name?: string; endDate?: string | null }) {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  const name = input.name?.trim()
  if (name != null && (name.length === 0 || name.length > 80)) throw new Error('campaign name must be 1–80 characters')
  if (name == null && input.endDate === undefined) throw new Error('nothing to update')
  if (input.endDate != null && Number.isNaN(Date.parse(input.endDate))) throw new Error('invalid end date')
  const status = normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, c.status)
  if (status === 'ENDED') throw new Error('campaign has ended — clone to relaunch')

  const decision = gate(c.marketplace)
  if (!decision.allowed) throw new Error(`write gate blocked: ${'reason' in decision ? decision.reason : 'unknown'}`)
  if (decision.mode === 'live' && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    await updateCampaignIdentificationApi(auth.token, c.externalCampaignId, {
      campaignName: name ?? c.name,
      ...(input.endDate !== undefined ? { endDate: input.endDate === null ? null : new Date(input.endDate).toISOString() } : {}),
    })
  }
  await prisma.ebayCampaign.update({
    where: { id: c.id },
    data: {
      ...(name != null ? { name } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate === null ? null : new Date(input.endDate) } : {}),
    },
  })
  await audit({
    ctx, actionType: 'update_campaign_identification', entityType: 'CAMPAIGN', entityId: c.externalCampaignId,
    before: { name: c.name, endDate: c.endDate?.toISOString() ?? null },
    after: { ...(name != null ? { name } : {}), ...(input.endDate !== undefined ? { endDate: input.endDate } : {}) },
    mode: decision.mode, status: 'SUCCESS',
  })
  return { ok: true, mode: decision.mode }
}

// ═════════════════════════════════════════════════════════════════════════════
// CPC structure: ad groups / keywords / negatives
// ═════════════════════════════════════════════════════════════════════════════
export async function createAdGroup(ctx: OpContext, campaignId: string, name: string, defaultBidCents?: number) {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  if ((c.fundingModel ?? '') !== 'COST_PER_CLICK' || c.campaignTargetingType === 'SMART') throw new Error('ad groups exist on MANUAL Priority campaigns only')
  const decision = gate(c.marketplace)
  let externalAdGroupId = `sandbox-ag-${Date.now()}`
  if (decision.mode === 'live' && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    externalAdGroupId = await createAdGroupApi(auth.token, c.externalCampaignId, { name, ...(defaultBidCents != null ? { defaultBid: { currency: 'EUR', value: (defaultBidCents / 100).toFixed(2) } } : {}) })
  }
  const row = await prisma.ebayAdGroup.create({ data: { campaignId: c.id, externalAdGroupId, name, status: 'ACTIVE', defaultBidCents: defaultBidCents ?? null } })
  await audit({ ctx, actionType: 'create_ad_group', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: {}, after: { name, defaultBidCents }, mode: decision.mode, status: 'SUCCESS', responseId: externalAdGroupId })
  return { ok: true, mode: decision.mode, adGroupId: row.id, externalAdGroupId }
}

export async function addKeywords(ctx: OpContext, campaignId: string, adGroupId: string, keywords: Array<{ text: string; matchType: string; bidCents?: number }>): Promise<{ mode: WriteMode; results: ItemOutcome[] }> {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  const g = await prisma.ebayAdGroup.findUniqueOrThrow({ where: { id: adGroupId } })
  await killSwitchCheck(c.marketplace)
  const dynamicBidding = false // manual campaigns default FIXED; DYNAMIC lock enforced by eBay — surfaced in UI
  const decision = gate(c.marketplace)
  const valid = keywords.filter((k) => k.text.trim().length > 0 && k.text.length <= 100 && k.text.trim().split(/\s+/).length <= 10)
  const invalid = keywords.filter((k) => !valid.includes(k))

  let live: BulkItemResult[] = []
  if (decision.mode === 'live' && valid.length && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    for (const batch of chunk(valid)) {
      live.push(...await bulkCreateKeywordApi(auth.token, c.externalCampaignId, batch.map((k) => ({
        adGroupId: g.externalAdGroupId,
        keywordText: k.text.trim(),
        matchType: k.matchType,
        ...(!dynamicBidding && k.bidCents != null ? { bid: { currency: 'EUR', value: (k.bidCents / 100).toFixed(2) } } : {}),
      }))))
    }
  }
  const liveByKey = new Map(live.map((l) => [l.key, l]))
  const results: ItemOutcome[] = invalid.map((k) => ({ key: k.text, ok: false, mode: decision.mode, error: 'invalid keyword (1–100 chars, ≤10 words)' }))
  for (const k of valid) {
    const lr = liveByKey.get(k.text.trim())
    const ok = decision.mode === 'sandbox' ? true : lr?.ok ?? false
    if (ok) {
      await prisma.ebayKeyword.upsert({
        where: { adGroupId_externalKeywordId: { adGroupId: g.id, externalKeywordId: lr?.id ?? `sandbox-kw-${k.text.trim().toLowerCase().replace(/\s+/g, '-')}` } },
        create: { campaignId: c.id, adGroupId: g.id, externalKeywordId: lr?.id ?? `sandbox-kw-${k.text.trim().toLowerCase().replace(/\s+/g, '-')}`, text: k.text.trim(), matchType: k.matchType, bidCents: k.bidCents ?? null, status: decision.mode === 'live' ? 'ACTIVE' : 'SANDBOX' },
        update: { bidCents: k.bidCents ?? null },
      })
    }
    results.push({ key: k.text, ok, mode: decision.mode, id: lr?.id ?? null, error: lr?.error ?? null })
  }
  await audit({ ctx, actionType: 'bulk_create_keywords', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { adGroup: g.externalAdGroupId }, after: { keywords: keywords.slice(0, 100), results: results.slice(0, 100) }, mode: decision.mode, status: results.every((r) => r.ok) ? 'SUCCESS' : results.some((r) => r.ok) ? 'PARTIAL' : 'FAILED' })
  return { mode: decision.mode, results }
}

export async function updateKeywords(ctx: OpContext, campaignId: string, updates: Array<{ keywordId: string; bidCents?: number; status?: 'ACTIVE' | 'PAUSED' }>): Promise<{ mode: WriteMode; results: ItemOutcome[] }> {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  await killSwitchCheck(c.marketplace)
  const rows = await prisma.ebayKeyword.findMany({ where: { id: { in: updates.map((u) => u.keywordId) }, campaignId: c.id } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const decision = gate(c.marketplace)
  let live: BulkItemResult[] = []
  const pushable = updates.filter((u) => byId.has(u.keywordId) && !byId.get(u.keywordId)!.externalKeywordId.startsWith('sandbox-'))
  if (decision.mode === 'live' && pushable.length && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    for (const batch of chunk(pushable)) {
      live.push(...await bulkUpdateKeywordApi(auth.token, c.externalCampaignId, batch.map((u) => ({
        keywordId: byId.get(u.keywordId)!.externalKeywordId,
        ...(u.bidCents != null ? { bid: { currency: 'EUR', value: (u.bidCents / 100).toFixed(2) } } : {}),
        ...(u.status ? { keywordStatus: u.status } : {}),
      }))))
    }
  }
  const liveByExt = new Map(live.map((l) => [l.key, l]))
  const results: ItemOutcome[] = []
  for (const u of updates) {
    const row = byId.get(u.keywordId)
    if (!row) { results.push({ key: u.keywordId, ok: false, mode: decision.mode, error: 'keyword not found in this campaign' }); continue }
    const lr = liveByExt.get(row.externalKeywordId)
    const ok = decision.mode === 'sandbox' ? true : lr?.ok ?? true
    if (ok) await prisma.ebayKeyword.update({ where: { id: row.id }, data: { ...(u.bidCents != null ? { bidCents: u.bidCents } : {}), ...(u.status ? { status: u.status } : {}) } })
    results.push({ key: row.text, ok, mode: decision.mode, error: lr?.error ?? null })
  }
  await audit({ ctx, actionType: 'bulk_update_keywords', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { keywords: rows.map((r) => ({ id: r.externalKeywordId, bidCents: r.bidCents, status: r.status })) }, after: { updates, results: results.slice(0, 100) }, mode: decision.mode, status: results.every((r) => r.ok) ? 'SUCCESS' : 'PARTIAL' })
  return { mode: decision.mode, results }
}

export async function addNegatives(ctx: OpContext, campaignId: string, adGroupId: string, negatives: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }>): Promise<{ mode: WriteMode; results: ItemOutcome[] }> {
  const c = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: campaignId } })
  const g = await prisma.ebayAdGroup.findUniqueOrThrow({ where: { id: adGroupId } })
  await killSwitchCheck(c.marketplace)
  const decision = gate(c.marketplace)
  let live: BulkItemResult[] = []
  if (decision.mode === 'live' && negatives.length && !c.externalCampaignId.startsWith('sandbox-')) {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) throw new Error('no active eBay connection')
    live = await bulkCreateNegativeKeywordApi(auth.token, negatives.map((n) => ({
      campaignId: c.externalCampaignId, adGroupId: g.externalAdGroupId,
      negativeKeywordText: n.text.trim(), negativeKeywordMatchType: n.matchType,
    })))
  }
  const liveByKey = new Map(live.map((l) => [l.key, l]))
  const results: ItemOutcome[] = []
  for (const n of negatives) {
    const lr = liveByKey.get(n.text.trim())
    const ok = decision.mode === 'sandbox' ? true : lr?.ok ?? false
    if (ok) {
      await prisma.ebayNegativeKeyword.upsert({
        where: { campaignId_externalId: { campaignId: c.id, externalId: lr?.id ?? `sandbox-neg-${n.text.trim().toLowerCase().replace(/\s+/g, '-')}` } },
        create: { campaignId: c.id, adGroupId: g.id, externalId: lr?.id ?? `sandbox-neg-${n.text.trim().toLowerCase().replace(/\s+/g, '-')}`, text: n.text.trim(), matchType: n.matchType, status: decision.mode === 'live' ? 'ACTIVE' : 'SANDBOX' },
        update: {},
      })
    }
    results.push({ key: n.text, ok, mode: decision.mode, id: lr?.id ?? null, error: lr?.error ?? null })
  }
  await audit({ ctx, actionType: 'bulk_create_negative_keywords', entityType: 'CAMPAIGN', entityId: c.externalCampaignId, before: { adGroup: g.externalAdGroupId }, after: { negatives, results: results.slice(0, 100) }, mode: decision.mode, status: results.every((r) => r.ok) ? 'SUCCESS' : 'PARTIAL' })
  return { mode: decision.mode, results }
}

/** What mode would a write run in right now? (Powers the UI banner.) */
export function currentWriteMode(marketplace = 'EBAY_IT'): WriteMode {
  return gate(marketplace).mode
}
