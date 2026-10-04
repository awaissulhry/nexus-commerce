/**
 * MCP full control A11 (docs/mcp-full-control/sections/01-ads.md §4) — the Single Campaign builder launch, moved out
 * of `POST /advertising/campaign-builder/single/launch` (advertising.routes.ts) WITHOUT a behaviour change, so the
 * builder's route and Claude's create-ad-campaign tool share one code path. The route answers exactly what this
 * returns (status and body); the comments below travelled with the code.
 *
 * A11 adds one optional argument, used only by create-ad-campaign: `opts.bornSuppressed` creates every bid at the
 * no-pause floor and remembers the bid asked for, exactly as `suppressCampaignBids` would have left it, and flags the
 * campaign as suppressed by the person who asked — so it serves at the floor (never paused) until a person approves
 * `restore-campaign`. Without it the launch is the route's, unchanged (ads-single-launch.vitest.test.ts).
 *
 * SB.7 — Single Campaign builder launch. Creates ONE SP campaign with PER-KEYWORD match types + bids (richer than the
 * SP Super Wizard's uniform model), the placement multiplier, an optional Target-ACoS / strategy bid rule, and an
 * optional inline Negative-Targeting rule. Same gated local-first create path (no Amazon push unless the write gate is
 * open).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { AdsActor } from './ads-mutation.service.js'
import { normaliseFloorCents } from './ads-bid-suppression.service.js'

export type PRef = { asin?: string; sku?: string; productId?: string }

export interface SingleLaunchBody {
  market?: string; name?: string; adGroupName?: string; portfolioId?: string
  biddingStrategy?: 'down' | 'updown' | 'fixed'; sites?: 'amazon' | 'business'
  placementBids?: { tos?: string; pdp?: string; ros?: string }
  bidBoosts?: { video?: boolean; amazonBusiness?: boolean; amazonBusinessPct?: string; audience?: boolean }
  products?: PRef[]; sponsoredVideoAsins?: string[]; budgetEur?: number; defaultBidEur?: number
  bidConfig?: { strategy?: string; targetAcos?: string; minBid?: string; maxBid?: string }
  targetMode?: 'keyword' | 'product'
  keywords?: Array<{ text?: string; matchType?: 'BROAD' | 'PHRASE' | 'EXACT'; bidEur?: number }>
  negKeywords?: Array<{ text?: string; matchType?: 'EXACT' | 'PHRASE' }>
  productTargets?: PRef[]; negProducts?: PRef[]
  addNegativeRule?: boolean; attachRuleIds?: string[]; autoBidAdjust?: boolean; dryRun?: boolean
}

/** A11 — create-ad-campaign's launch. Absent: the builder route's launch, unchanged. */
export interface SingleLaunchOptions {
  /**
   * Born suppressed: every bid (the ad group default, each keyword and product target) is created at `floorCents`
   * when it asks for more, with the bid it asked for kept in `suppressedFromBidCents`; the campaign carries
   * `bidsSuppressedAt` / `bidsSuppressedFloorCents` / `bidsSuppressedBy = by` from the moment it exists. The campaign
   * itself is created ENABLED, as every SP launch is (never paused): the floor is what keeps it from spending.
   */
  bornSuppressed?: { floorCents: number; by: AdsActor }
  /** The campaign's own currency (`Campaign.dailyBudgetCurrency`); the route leaves the schema default. */
  currency?: string
}

export interface SingleLaunchResult {
  status: 200 | 400 | 500
  body: Record<string, unknown>
}

/** The launch, as the route ran it: `userId` is the actor the route takes from its header. */
export async function singleLaunch(b: SingleLaunchBody, userId: AdsActor, opts: SingleLaunchOptions = {}): Promise<SingleLaunchResult> {
  const market = b.market || 'IT'
  const name = (b.name || '').trim()
  if (!name) return { status: 400, body: { ok: false, error: 'campaign name required' } }
  const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
  const defaultBidEur = Number(b.defaultBidEur) || 0.75
  const budgetEur = Number(b.budgetEur) || 10
  if (b.dryRun) return { status: 200, body: { ok: true, dryRun: true, plan: { market, name, products: products.length, keywords: (b.keywords ?? []).length } } }

  const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal, createTargetLocal, createNegativeProductTargetLocal, createNegativeKeywordLocal, updatePlacementBidding } = await import('./ads-create.service.js')
  const biddingStrategy: 'legacyForSales' | 'autoForSales' | 'manual' = b.biddingStrategy === 'updown' ? 'autoForSales' : b.biddingStrategy === 'fixed' ? 'manual' : 'legacyForSales'
  const rulesCreated: Array<{ id: string; name: string }> = []
  // A11 — born suppressed (opts.bornSuppressed): a bid above the floor starts AT the floor and is remembered. With no
  // option every helper is the identity, so the route's launch is unchanged.
  const floor = opts.bornSuppressed ? normaliseFloorCents(opts.bornSuppressed.floorCents) : null
  const cents = (eur: number) => Math.round(eur * 100)
  const floored = (eur: number) => floor != null && cents(eur) > floor
  const startEur = (eur: number) => (floored(eur) ? (floor as number) / 100 : eur)
  const remember = (adTargetId: string, eur: number) => prisma.adTarget.update({ where: { id: adTargetId }, data: { suppressedFromBidCents: cents(eur) } })
  try {
    const camp = await createCampaignLocal({ name, type: 'SP', marketplace: market, targetingType: 'MANUAL', dailyBudgetEur: budgetEur, biddingStrategy, portfolioId: b.portfolioId, userId })
    if (floor != null || opts.currency) {
      await prisma.campaign.update({ where: { id: camp.id }, data: {
        ...(opts.currency ? { dailyBudgetCurrency: opts.currency } : {}),
        ...(floor != null ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.bornSuppressed!.by } : {}),
      } })
    }
    const ag = await createAdGroupLocal({ campaignId: camp.id, name: (b.adGroupName || '').trim() || `${name} Ad Group`, defaultBidEur: startEur(defaultBidEur), userId })
    if (floored(defaultBidEur)) await prisma.adGroup.update({ where: { id: ag.id }, data: { suppressedFromBidCents: cents(defaultBidEur) } })
    for (const p of products) { try { await createProductAdLocal({ adGroupId: ag.id, asin: p.asin, sku: p.sku, productId: p.productId, userId }) } catch (e) { logger.warn('[single-launch] product ad failed', { error: (e as Error).message }) } }
    if ((b.targetMode ?? 'keyword') === 'product') {
      for (const pt of b.productTargets ?? []) { const asin = pt.asin || pt.sku; if (!asin) continue; try { const t = await createTargetLocal({ adGroupId: ag.id, kind: 'PRODUCT', value: asin, bidEur: startEur(defaultBidEur), userId }); if (floored(defaultBidEur)) await remember(t.id, defaultBidEur) } catch (e) { logger.warn('[single-launch] product target failed', { error: (e as Error).message }) } }
    } else {
      for (const kw of b.keywords ?? []) { const text = (kw?.text || '').trim(); if (!text) continue; const mt: 'BROAD' | 'PHRASE' | 'EXACT' = kw.matchType === 'PHRASE' ? 'PHRASE' : kw.matchType === 'EXACT' ? 'EXACT' : 'BROAD'; try { const bid = Number(kw.bidEur) || defaultBidEur; const k = await createKeywordLocal({ adGroupId: ag.id, keywordText: text, matchType: mt, bidEur: startEur(bid), userId }); if (floored(bid) && !k.existed) await remember(k.id, bid) } catch (e) { logger.warn('[single-launch] keyword failed', { error: (e as Error).message }) } }
    }
    // 5b — the campaign was created above and is born off the allowlist: its negatives are part of the launch, as its
    // keywords and product ads are, so they pass `creationFlow` (the allowlist binds every other negative).
    for (const nk of b.negKeywords ?? []) { const text = (nk?.text || '').trim(); if (!text) continue; const mt: 'EXACT' | 'PHRASE' = nk.matchType === 'PHRASE' ? 'PHRASE' : 'EXACT'; try { await createNegativeKeywordLocal({ adGroupId: ag.id, keywordText: text, matchType: mt, userId, creationFlow: true }) } catch (e) { logger.warn('[single-launch] neg keyword failed', { error: (e as Error).message }) } }
    for (const np of b.negProducts ?? []) { const asin = np.asin || np.sku; if (!asin) continue; try { await createNegativeProductTargetLocal({ adGroupId: ag.id, asin, userId, creationFlow: true }) } catch (e) { logger.warn('[single-launch] neg product failed', { error: (e as Error).message }) } }
    const pb = b.placementBids ?? {}
    const adjustments = ([['PLACEMENT_TOP', pb.tos], ['PLACEMENT_PRODUCT_PAGE', pb.pdp], ['PLACEMENT_REST_OF_SEARCH', pb.ros]] as Array<[string, string | undefined]>)
      .flatMap(([placement, v]) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? [{ placement, percentage: n }] : [] })
    if (adjustments.length) { try { await updatePlacementBidding({ campaignId: camp.id, adjustments, userId }) } catch (e) { logger.warn('[single-launch] placement failed', { error: (e as Error).message }) } }

    // #1/#3/#4 — persist Sponsored-Video opt-ins, Sites reach, and the video/AB/audience bid
    // boosts onto the campaign's dynamicBidding config (preserves the placementBidding just
    // written). Forward-looking: applied to Amazon when the v3 boost write-path opens (same gate).
    const svAsins = (b.sponsoredVideoAsins ?? []).filter(Boolean)
    const boosts = b.bidBoosts ?? {}
    const wantBoost = !!(boosts.video || boosts.amazonBusiness || boosts.audience)
    if (svAsins.length || b.sites === 'business' || wantBoost) {
      try {
        const cur = await prisma.campaign.findUnique({ where: { id: camp.id }, select: { dynamicBidding: true } })
        const dyn = (cur?.dynamicBidding && typeof cur.dynamicBidding === 'object' ? cur.dynamicBidding : {}) as Record<string, unknown>
        await prisma.campaign.update({ where: { id: camp.id }, data: { dynamicBidding: {
          ...dyn,
          ...(b.sites ? { sites: b.sites } : {}),
          ...(svAsins.length ? { sponsoredVideoAsins: svAsins } : {}),
          ...(wantBoost ? { bidBoosts: { video: !!boosts.video, amazonBusiness: !!boosts.amazonBusiness, amazonBusinessPct: Number(boosts.amazonBusinessPct) || undefined, audience: !!boosts.audience } } : {}),
        } as never } })
      } catch (e) { logger.warn('[single-launch] config merge failed', { error: (e as Error).message }) }
    }

    // #2 — attach this campaign to existing rules: append its id to each rule action's
    // campaignIds / sources so the Rules engine evaluates it too (read+extend, never rebuild).
    let attachedCount = 0
    for (const ruleId of (b.attachRuleIds ?? [])) {
      try {
        const rule = await prisma.automationRule.findUnique({ where: { id: ruleId }, select: { id: true, actions: true, domain: true } })
        if (!rule || rule.domain !== 'advertising') continue
        const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
        let touched = false
        for (const a of actions) {
          if (Array.isArray(a.campaignIds) && !(a.campaignIds as string[]).includes(camp.id)) { (a.campaignIds as string[]).push(camp.id); touched = true }
          if (Array.isArray(a.sources) && !(a.sources as Array<{ campaignId?: string }>).some((s) => s?.campaignId === camp.id)) { (a.sources as unknown[]).push({ adGroupId: ag.id, campaignId: camp.id, harvestFrom: true, graduate: [], negate: [] }); touched = true }
        }
        if (touched) { await prisma.automationRule.update({ where: { id: ruleId }, data: { actions: actions as never } }); attachedCount++ }
      } catch (e) { logger.warn('[single-launch] attach rule failed', { ruleId, error: (e as Error).message }) }
    }

    if (b.bidConfig?.strategy && b.bidConfig.strategy !== 'none') {
      try {
        const bc = b.bidConfig
        const minBidEur = Number(bc.minBid) || undefined
        const maxBidEur = Number(bc.maxBid) || undefined
        const action = bc.strategy === 'targetAcos'
          ? { type: 'bid_to_target_acos', targetAcos: Number(bc.targetAcos) || 30, minBidEur, maxBidEur, campaignIds: [camp.id] }
          : { type: 'set_bid_strategy', strategy: bc.strategy, minBidEur, maxBidEur, campaignIds: [camp.id] }
        const label = bc.strategy === 'targetAcos' ? 'Target ACoS' : bc.strategy === 'maxImpressions' ? 'Max Impressions' : bc.strategy === 'maxOrders' ? 'Max Orders' : 'Custom'
        const rule = await prisma.automationRule.create({ data: { name: `${name} — ${label} bidding`.slice(0, 120), description: 'Bid strategy from Single Campaign builder', domain: 'advertising', trigger: 'SCHEDULE', conditions: [] as never, actions: [action] as never, enabled: !!b.autoBidAdjust, dryRun: true, maxExecutionsPerDay: 4, createdBy: userId ?? null } })
        rulesCreated.push({ id: rule.id, name: rule.name })
      } catch (e) { logger.error('[single-launch] bid rule failed', { error: (e as Error).message }) }
    }
    if (b.addNegativeRule) {
      try {
        const rule = await prisma.automationRule.create({ data: { name: `${name} — Negative Targeting`.slice(0, 120), description: 'Negative rule from Single Campaign builder', domain: 'advertising', trigger: 'SCHEDULE', conditions: [] as never, actions: [{ type: 'harvest_and_negate', control: 'manual', mode: 'negative', windowDays: 60, minSpendCents: 1000, minOrders: 0, sources: [{ adGroupId: ag.id, campaignId: camp.id, harvestFrom: true, graduate: [], negate: ['EXACT'] }], destinations: {} }] as never, enabled: true, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? null } })
        rulesCreated.push({ id: rule.id, name: rule.name })
      } catch (e) { logger.error('[single-launch] negative rule failed', { error: (e as Error).message }) }
    }
    logger.warn('[single-launch] created campaign', { market, name, campaignId: camp.id, rules: rulesCreated.length, attached: attachedCount, actor: userId })
    // AX-VT.1 — read back and repair portfolio membership before claiming success.
    const { settleLaunchPortfolios } = await import('./ads-create.service.js')
    const portfolioCheck = await settleLaunchPortfolios([camp.id])
    // AX-VT.4 — full intended-vs-observed receipt for the campaign and everything under it.
    const { verifyLaunch } = await import('./ads-launch-verify.service.js')
    const verification = await verifyLaunch([camp.id]).catch(() => null)
    return { status: 200, body: { ok: true, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, rules: rulesCreated, attached: attachedCount, portfolioCheck, verification } }
  } catch (e) {
    logger.error('[single-launch] failed', { name, market, error: (e as Error).message })
    return { status: 500, body: { ok: false, error: (e as Error).message } }
  }
}
