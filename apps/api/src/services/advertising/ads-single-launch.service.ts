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
  /**
   * CC-7 — the screen's launch: the new campaign goes on the live-write allowlist the moment it exists, as every other
   * builder's does (SP Super Wizard, Quick, Guided, AI Goal, Replicate). Without it the placement multipliers the
   * builder sends were refused (`campaign_allowlist`) and dropped in silence, and so was every later bid edit.
   * create-ad-campaign leaves it out: Claude's campaign is born off the list until a person approves
   * set-campaign-live-writes.
   */
  allowlistAtBirth?: boolean
}

export interface SingleLaunchResult {
  status: 200 | 400 | 500
  body: Record<string, unknown>
}

/** The launch, as the route ran it: `userId` is the actor the route takes from its header. */
export async function singleLaunch(b: SingleLaunchBody, userId: AdsActor, opts: SingleLaunchOptions = {}): Promise<SingleLaunchResult> {
  const name = (b.name || '').trim()
  // CC-29 / CC-5 — the market is never guessed (it used to become IT) and a Nexus-only portfolio never reaches Amazon.
  // Before the dry run too: the review step's checks are about one market, never a guessed one.
  const { launchMarketRefusal, localPortfolioRefusal, bidStrategyRules } = await import('./ads-launch-guards.js')
  const refused = launchMarketRefusal(b.market) ?? localPortfolioRefusal(b.portfolioId)
  if (refused) return { status: 400, body: { ok: false, error: refused } }
  const market = String(b.market).trim()
  const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
  const defaultBidEur = Number(b.defaultBidEur) || 0.75
  const budgetEur = Number(b.budgetEur) || 10
  // CC-13 / CC-14 / CC-21 — the checks the review step shows (dryRun), run again before anything is sent: no products,
  // no keywords (or product targets), a name Amazon refuses or this market already uses, a bid or budget outside
  // Amazon's range are refused here; his bid policies and spend ceilings are warnings only.
  const { singleLaunchPlan, launchChecks } = await import('./ads-launch-checks.service.js')
  const checks = await launchChecks(singleLaunchPlan(b))
  if (b.dryRun) return { status: 200, body: { ok: true, dryRun: true, plan: { market, name, products: products.length, keywords: (b.keywords ?? []).length }, checks } }
  if (!name) return { status: 400, body: { ok: false, error: 'campaign name required' } }
  if (checks.refusals.length) return { status: 400, body: { ok: false, error: checks.refusals.join(' '), refusals: checks.refusals, warnings: checks.warnings } }

  const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal, createTargetLocal, createNegativeProductTargetLocal, createNegativeKeywordLocal, updatePlacementBidding } = await import('./ads-create.service.js')
  const biddingStrategy: 'legacyForSales' | 'autoForSales' | 'manual' = b.biddingStrategy === 'updown' ? 'autoForSales' : b.biddingStrategy === 'fixed' ? 'manual' : 'legacyForSales'
  const rulesCreated: Array<{ id: string; name: string }> = []
  // W2-A (CC-2) — what reached Amazon, part by part (launch-outcome.ts); each step is caught on its own.
  const { CampaignLaunch, summariseLaunch, describeLaunch } = await import('./launch-outcome.js')
  const rec = new CampaignLaunch(name)
  // A11 — born suppressed (opts.bornSuppressed): a bid above the floor starts AT the floor and is remembered. With no
  // option every helper is the identity, so the route's launch is unchanged.
  const floor = opts.bornSuppressed ? normaliseFloorCents(opts.bornSuppressed.floorCents) : null
  const cents = (eur: number) => Math.round(eur * 100)
  const floored = (eur: number) => floor != null && cents(eur) > floor
  const startEur = (eur: number) => (floored(eur) ? (floor as number) / 100 : eur)
  const remember = (adTargetId: string, eur: number) => prisma.adTarget.update({ where: { id: adTargetId }, data: { suppressedFromBidCents: cents(eur) } })
  let camp: Awaited<ReturnType<typeof createCampaignLocal>>
  try {
    camp = await createCampaignLocal({ name, type: 'SP', marketplace: market, targetingType: 'MANUAL', dailyBudgetEur: budgetEur, biddingStrategy, portfolioId: b.portfolioId, userId })
    rec.campaign(camp)
  } catch (e) {
    // W2-A (CC-2) — nothing was written: the answer says so, with the reason, instead of a bare 500.
    rec.campaignThrew(e)
    const launch = summariseLaunch([rec.result()])
    logger.error('[single-launch] campaign create failed', { name, market, error: (e as Error).message })
    return { status: 200, body: { ok: false, error: (e as Error).message, launch } }
  }
  // W2-A (CC-3) — Amazon (or the gate) did not take the campaign: it stays in Nexus as a FAILED record with the reason,
  // and nothing is built under it (its parts could not reach Amazon either).
  if (!camp.externalCampaignId) {
    const launch = summariseLaunch([rec.result()])
    logger.warn('[single-launch] campaign not on Amazon', { market, name, campaignId: camp.id, reason: camp.reason })
    return { status: 200, body: { ok: false, error: describeLaunch(launch), campaignId: camp.id, externalCampaignId: null, launch } }
  }
  try {
    if (floor != null || opts.currency || opts.allowlistAtBirth) {
      await prisma.campaign.update({ where: { id: camp.id }, data: {
        // CC-7 — on the allowlist before the placement write below, which the allowlist binds.
        ...(opts.allowlistAtBirth ? { liveBidWritesEnabled: true } : {}),
        ...(opts.currency ? { dailyBudgetCurrency: opts.currency } : {}),
        ...(floor != null ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.bornSuppressed!.by } : {}),
      } })
    }
    const adGroupName = (b.adGroupName || '').trim() || `${name} Ad Group`
    // CM-20 — `creationFlow`: everything below belongs to the campaign created a moment ago.
    const ag = await createAdGroupLocal({ campaignId: camp.id, name: adGroupName, defaultBidEur: startEur(defaultBidEur), userId, creationFlow: true })
      .catch((e: unknown) => { rec.adGroup(adGroupName, null, e); throw e })
    rec.adGroup(adGroupName, ag)
    const agId = ag.id as string
    if (floored(defaultBidEur)) await prisma.adGroup.update({ where: { id: agId }, data: { suppressedFromBidCents: cents(defaultBidEur) } })
    // W2-A (CC-17) — negatives FIRST, as Replicate does: a launch that fails part-way is then narrower, never wider.
    // 5b — the campaign was created above and is born off the allowlist: its negatives are part of the launch, as its
    // keywords and product ads are, so they pass `creationFlow` (the allowlist binds every other negative).
    for (const nk of b.negKeywords ?? []) { const text = (nk?.text || '').trim(); if (!text) continue; const mt: 'EXACT' | 'PHRASE' = nk.matchType === 'PHRASE' ? 'PHRASE' : 'EXACT'; try { rec.negative('negative_keyword', `${text} (${mt.toLowerCase()})`, await createNegativeKeywordLocal({ adGroupId: agId, keywordText: text, matchType: mt, userId, creationFlow: true })) } catch (e) { rec.threw('negative_keyword', text, e) } }
    for (const np of b.negProducts ?? []) { const asin = np.asin || np.sku; if (!asin) continue; try { rec.negative('negative_product', asin, await createNegativeProductTargetLocal({ adGroupId: agId, asin, userId, creationFlow: true })) } catch (e) { rec.threw('negative_product', asin, e) } }
    for (const p of products) { const item = p.sku || p.asin || p.productId || '?'; try { rec.productAd(item, await createProductAdLocal({ adGroupId: agId, asin: p.asin, sku: p.sku, productId: p.productId, userId, launch: true, creationFlow: true })) } catch (e) { rec.threw('product_ad', item, e) } }
    if ((b.targetMode ?? 'keyword') === 'product') {
      for (const pt of b.productTargets ?? []) { const asin = pt.asin || pt.sku; if (!asin) continue; try { const t = await createTargetLocal({ adGroupId: agId, kind: 'PRODUCT', value: asin, bidEur: startEur(defaultBidEur), userId, creationFlow: true }); rec.productTarget(asin, t); if (floored(defaultBidEur) && t.id) await remember(t.id, defaultBidEur) } catch (e) { rec.threw('product_target', asin, e) } }
    } else {
      for (const kw of b.keywords ?? []) { const text = (kw?.text || '').trim(); if (!text) continue; const mt: 'BROAD' | 'PHRASE' | 'EXACT' = kw.matchType === 'PHRASE' ? 'PHRASE' : kw.matchType === 'EXACT' ? 'EXACT' : 'BROAD'; try { const bid = Number(kw.bidEur) || defaultBidEur; const k = await createKeywordLocal({ adGroupId: agId, keywordText: text, matchType: mt, bidEur: startEur(bid), userId, creationFlow: true }); rec.keyword(`${text} (${mt.toLowerCase()})`, k); if (floored(bid) && !k.existed && k.id) await remember(k.id, bid) } catch (e) { rec.threw('keyword', text, e) } }
    }
    const pb = b.placementBids ?? {}
    const adjustments = ([['PLACEMENT_TOP', pb.tos], ['PLACEMENT_PRODUCT_PAGE', pb.pdp], ['PLACEMENT_REST_OF_SEARCH', pb.ros]] as Array<[string, string | undefined]>)
      .flatMap(([placement, v]) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? [{ placement, percentage: n }] : [] })
    // CC-7 — what became of the placement multipliers is part of the answer, not only of the log.
    // `mode`: live = Amazon took it; sandbox / local = saved in Nexus (no live account, or the campaign is not on Amazon).
    // W2-A — and the launch answer lists a refused placement with its reason.
    let placement: { mode: string; sent: boolean; reason?: string } | null = null
    if (adjustments.length) {
      try {
        const r = await updatePlacementBidding({ campaignId: camp.id, adjustments, userId })
        rec.placement(r)
        placement = r.ok ? { mode: r.mode, sent: r.mode === 'live' } : { mode: r.mode, sent: false, reason: r.reason ?? r.error ?? 'not sent' }
      } catch (e) {
        rec.threw('placement', 'Placement bid adjustments', e)
        placement = { mode: 'failed', sent: false, reason: (e as Error).message }; logger.warn('[single-launch] placement failed', { error: (e as Error).message })
      }
    }

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

    // CC-4 — Target ACoS becomes a rule the engine runs (a fraction, this campaign's id); a strategy with no engine
    // creates no rule ("not running yet") instead of an inert `set_bid_strategy` row.
    if (b.bidConfig?.strategy && b.bidConfig.strategy !== 'none') {
      const plan = bidStrategyRules({ bidConfig: b.bidConfig, campaigns: [{ id: camp.id, name }], market, enabled: !!b.autoBidAdjust, createdBy: userId ?? null, source: 'Single Campaign builder' })
      if (plan.note) logger.warn('[single-launch] no bid-strategy rule', { strategy: b.bidConfig.strategy, note: plan.note })
      for (const data of plan.rules) {
        try {
          const rule = await prisma.automationRule.create({ data: data as never })
          rulesCreated.push({ id: rule.id, name: rule.name })
        } catch (e) { logger.error('[single-launch] bid rule failed', { error: (e as Error).message }) }
      }
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
    // W2-A (CC-2) — `ok` only when the campaign and every part asked for reached Amazon; `launch` says what did.
    const launch = summariseLaunch([rec.result()])
    if (!launch.ok) logger.warn('[single-launch] launch did not fully reach Amazon', { market, summary: describeLaunch(launch) })
    return { status: 200, body: { ok: launch.ok, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, rules: rulesCreated, attached: attachedCount, portfolioCheck, verification, liveWrites: !!opts.allowlistAtBirth, placement, launch, ...(launch.ok ? {} : { error: describeLaunch(launch) }) } }
  } catch (e) {
    // The campaign exists (a later step threw): the answer still names it and what reached Amazon.
    logger.error('[single-launch] failed', { name, market, error: (e as Error).message })
    return { status: 500, body: { ok: false, error: (e as Error).message, campaignId: camp.id, launch: summariseLaunch([rec.result()]) } }
  }
}
