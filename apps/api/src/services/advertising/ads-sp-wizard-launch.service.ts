/**
 * PB-5a (ads playbook) — the SP Super Wizard launch, moved out of `POST /advertising/campaign-builder/sp-super-wizard/launch`
 * (advertising.routes.ts) WITHOUT a behaviour change, as A11 moved the Single launch (ads-single-launch.service.ts), so
 * the wizard's screens (SP Super Wizard, Quick, Guided) and the ads playbook's build share one campaign builder (Owner
 * rule 1: build only with Nexus's own builders). The route answers exactly what this returns (status and body); the
 * comments below travelled with the code.
 *
 * ── SPW.7: SP Super Wizard launch ───────────────────────────────────────
 * Creates the wizard's generated campaigns + ad groups + product ads +
 * keyword/product targeting + negatives + placement bid multiplier, all via
 * the local-first create service — nothing hits Amazon unless a per-campaign
 * live-write gate is open (gated create, no live push). The UI redirects to
 * the Ad Manager grid on success. dryRun returns the plan without writing.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { AdsActor } from './ads-mutation.service.js'

export type PRef = { asin?: string; sku?: string; productId?: string }
export type SpwRule = { ruleName?: string; automate?: boolean; perf?: { conditions?: Array<{ metric?: string; op?: string; value?: string }>; lookback?: string; exclude?: string }; rows?: Record<string, { st?: boolean; tB?: boolean; tP?: boolean; tE?: boolean; tBox?: boolean; nP?: boolean; nE?: boolean; nBox?: boolean }> }

/** The launch's body, as the wizard's screens send it. */
export interface SpwLaunchBody {
  market?: string; productGroupName?: string
  products?: PRef[]
  campaigns?: Array<{ id?: string; name: string; adGroupName?: string; kind: 'auto' | 'keyword' | 'pat'; adProduct?: 'SP' | 'SB' | 'SD'; matchType?: string; bidEur?: number; budgetEur?: number; keywords?: Array<string | { text: string; matchType?: 'BROAD' | 'PHRASE' | 'EXACT'; bidEur?: number }>; productTargets?: PRef[]; negKeywords?: Array<string | { text?: string; matchType?: 'EXACT' | 'PHRASE' }>; negProducts?: PRef[]; autoGroups?: Array<{ key: string; enabled?: boolean; bidEur?: number }>; creative?: Record<string, unknown> }>
  placementBids?: { tos?: string; pdp?: string; ros?: string }
  rules?: { harvest?: SpwRule; negative?: SpwRule }
  automationMode?: 'rule' | 'ai'
  bidConfig?: { strategy?: string; targetAcos?: string; minBid?: string; maxBid?: string }
  portfolioId?: string
  dryRun?: boolean
}

export interface SpwLaunchResult {
  status: 200 | 400
  body: Record<string, unknown>
}

/** The launch, as the route ran it: `userId` is the actor the route takes from the signed-in person (CC-28). */
export async function spWizardLaunch(b: SpwLaunchBody, userId: AdsActor): Promise<SpwLaunchResult> {
  // CC-29 / CC-5 — one market per launch, never guessed (it used to become IT), and never a portfolio Amazon does not know.
  const { launchMarketRefusal, localPortfolioRefusal, bidStrategyRules } = await import('./ads-launch-guards.js')
  const refused = launchMarketRefusal(b.market) ?? localPortfolioRefusal(b.portfolioId)
  if (refused) return { status: 400, body: { ok: false, error: refused } }
  const market = String(b.market).trim()
  const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
  const campaigns = (b.campaigns ?? []).filter((c) => c && c.name)
  if (!campaigns.length) return { status: 400, body: { error: 'no campaigns to create' } }
  // CC-10 — this launch cannot send a Sponsored Brands creative or Sponsored Display targets, so an SB/SD campaign made
  // here would be created on Amazon and could never serve. Refused before anything is created.
  if (campaigns.some((c) => c.adProduct === 'SB' || c.adProduct === 'SD')) {
    return { status: 400, body: { error: 'Sponsored Brands and Sponsored Display campaigns are not created here: this launch cannot send their creative or targets, so Amazon could not serve them. Use the Sponsored Brands / Display builder.' } }
  }
  // CC-13 / CC-14 / CC-21 — the checks the review step shows (dryRun), run again before anything is sent: a refusal
  // (no products, a name Amazon refuses or this market already uses, a bid or budget outside Amazon's range) sends
  // nothing; warnings (his bid policies and spend ceilings) never stop the launch.
  const { spwLaunchPlan, launchChecks } = await import('./ads-launch-checks.service.js')
  const checks = await launchChecks(spwLaunchPlan(b))
  if (b.dryRun) return { status: 200, body: { ok: true, dryRun: true, plan: { market, totalCampaigns: campaigns.length, totalProductAds: products.length * campaigns.length }, checks } }
  if (checks.refusals.length) return { status: 400, body: { ok: false, error: checks.refusals.join(' '), refusals: checks.refusals, warnings: checks.warnings } }

  const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal, createTargetLocal, createNegativeProductTargetLocal, createNegativeKeywordLocal, updatePlacementBidding, linkAutoTargeting } = await import('./ads-create.service.js')
  const matchTypesFor = (m?: string): Array<'BROAD' | 'PHRASE' | 'EXACT'> => {
    const u = (m || '').toLowerCase()
    if (u.includes('&')) return ['BROAD', 'PHRASE', 'EXACT']
    if (u.includes('phrase')) return ['PHRASE']
    if (u.includes('exact')) return ['EXACT']
    return ['BROAD']
  }
  const pb = b.placementBids ?? {}
  const adjustments = ([['PLACEMENT_TOP', pb.tos], ['PLACEMENT_PRODUCT_PAGE', pb.pdp], ['PLACEMENT_REST_OF_SEARCH', pb.ros]] as Array<[string, string | undefined]>)
    .flatMap(([placement, v]) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? [{ placement, percentage: n }] : [] })

  const created: Array<{ name: string; campaignId: string; externalCampaignId: string | null; mode: string }> = []
  const idMap: Record<string, { campaignId: string; adGroupId: string }> = {} // wizard campaign id → created ids (for the harvest rule)
  // W2-A (CC-2) — every campaign asked for is answered: live, partly made (what failed and why) or not made (why).
  // Each step is caught on its own, so a failure no longer drops the campaign (and what it already made on Amazon)
  // from the answer, the rules and the read-back.
  const { CampaignLaunch, summariseLaunch, describeLaunch } = await import('./launch-outcome.js')
  const outcomes: import('./launch-outcome.js').LaunchCampaignResult[] = []
  for (const c of campaigns) {
    const rec = new CampaignLaunch(c.name)
    const bidEur = Number(c.bidEur) || 0.75
    const budgetEur = Number(c.budgetEur) || 10
    let camp: Awaited<ReturnType<typeof createCampaignLocal>>
    try {
      camp = await createCampaignLocal({ name: c.name, type: c.adProduct ?? 'SP', marketplace: market, targetingType: c.kind === 'auto' ? 'AUTO' : 'MANUAL', dailyBudgetEur: budgetEur, biddingStrategy: 'legacyForSales', portfolioId: b.portfolioId, userId })
      rec.campaign(camp)
    } catch (e) {
      rec.campaignThrew(e)
      outcomes.push(rec.result())
      logger.error('[SPW-launch] campaign create failed', { name: c.name, market, error: (e as Error).message })
      continue
    }
    created.push({ name: c.name, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, mode: camp.mode })
    // W2-A (CC-3) — Amazon (or the gate) did not take the campaign: it stays in Nexus as a FAILED record with the reason,
    // and nothing is built under it (its parts could not reach Amazon either). The answer lists it as not made.
    if (!camp.externalCampaignId) { outcomes.push(rec.result()); continue }
    // LAUNCH-REPAIR: allowlist the campaign the instant it exists, BEFORE its sub-entities are
    // created — otherwise the per-campaign write-gate check skips every ad group/keyword/product-ad
    // and the campaign lands empty on Amazon ("not eligible, no keyword and no ad").
    try { await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } }) } catch (e) { logger.warn('[SPW-launch] allowlist failed', { error: (e as Error).message }) }
    // SB creative (brand · ad type · landing page · ASINs · headline · logo/custom image) → Campaign.creativeAssetJson (gated; pushed to Amazon when the SB write gate opens).
    if (c.creative && c.adProduct === 'SB') { try { await prisma.campaign.update({ where: { id: camp.id }, data: { creativeAssetJson: c.creative as never } }) } catch (e) { logger.warn('[SPW-launch] SB creative store failed', { error: (e as Error).message }) } }
    const adGroupName = c.adGroupName || `${c.name} Ad Group`
    let ag: Awaited<ReturnType<typeof createAdGroupLocal>>
    // CM-20 — `creationFlow`: everything below belongs to the campaign this launch just created.
    try { ag = await createAdGroupLocal({ campaignId: camp.id, name: adGroupName, defaultBidEur: bidEur, userId, creationFlow: true }) } catch (e) {
      rec.adGroup(adGroupName, null, e)
      outcomes.push(rec.result())
      logger.error('[SPW-launch] ad group create failed', { name: c.name, market, error: (e as Error).message })
      continue
    }
    rec.adGroup(adGroupName, ag)
    const agId = ag.id as string
    if (c.id) idMap[c.id] = { campaignId: camp.id, adGroupId: agId }
    // W2-A (CC-17) — negatives FIRST, as Replicate does: a launch that fails part-way is then narrower, never wider.
    for (const nk of c.negKeywords ?? []) { const text = (typeof nk === 'string' ? nk : nk?.text ?? '').trim(); if (!text) continue; const mt: 'EXACT' | 'PHRASE' = (typeof nk === 'object' && nk?.matchType === 'PHRASE') ? 'PHRASE' : 'EXACT'; try { rec.negative('negative_keyword', `${text} (${mt.toLowerCase()})`, await createNegativeKeywordLocal({ adGroupId: agId, keywordText: text, matchType: mt, userId })) } catch (e) { rec.threw('negative_keyword', text, e) } }
    for (const np of c.negProducts ?? []) { const asin = np.asin || np.sku; if (!asin) continue; try { rec.negative('negative_product', asin, await createNegativeProductTargetLocal({ adGroupId: agId, asin, userId })) } catch (e) { rec.threw('negative_product', asin, e) } }
    for (const p of products) { const item = p.sku || p.asin || p.productId || '?'; try { rec.productAd(item, await createProductAdLocal({ adGroupId: agId, asin: p.asin, sku: p.sku, productId: p.productId, userId, launch: true, creationFlow: true })) } catch (e) { rec.threw('product_ad', item, e) } }
    if (c.kind === 'keyword') {
      // Per-keyword match type + bid when provided (Guided's Add-Keywords step); else fall back to
      // the campaign's match type(s) + default bid (SPW / Quick send plain strings — unchanged).
      for (const kwRaw of c.keywords ?? []) {
        const text = (typeof kwRaw === 'string' ? kwRaw : kwRaw?.text ?? '').trim()
        if (!text) continue
        const kwBid = typeof kwRaw === 'object' && Number.isFinite(Number(kwRaw?.bidEur)) && Number(kwRaw?.bidEur) > 0 ? Number(kwRaw.bidEur) : bidEur
        const mts = typeof kwRaw === 'object' && kwRaw?.matchType ? [kwRaw.matchType] : matchTypesFor(c.matchType)
        for (const mt of mts) { try { rec.keyword(`${text} (${mt.toLowerCase()})`, await createKeywordLocal({ adGroupId: agId, keywordText: text, matchType: mt, bidEur: kwBid, userId, creationFlow: true })) } catch (e) { rec.threw('keyword', text, e) } }
      }
    } else if (c.kind === 'pat') {
      for (const pt of c.productTargets ?? []) { const asin = pt.asin || pt.sku; if (!asin) continue; try { rec.productTarget(asin, await createTargetLocal({ adGroupId: agId, kind: 'PRODUCT', value: asin, bidEur, userId, creationFlow: true })) } catch (e) { rec.threw('product_target', asin, e) } }
    } else if (c.kind === 'auto') {
      // W2-A (CC-1) — Amazon makes the four auto groups itself: link them and set each one's on/off and bid as chosen
      // (AT.1). Posting them as new targets is refused by Amazon, which left these choices in Nexus only.
      const groups = (c.autoGroups ?? []).filter((g) => g?.key).map((g) => ({ key: g.key, enabled: g.enabled !== false, bidEur: Number(g.bidEur) || bidEur }))
      if (groups.length) { try { rec.autoGroups(await linkAutoTargeting({ adGroupId: agId, groups, userId, creationFlow: true })) } catch (e) { rec.threw('auto_targeting', 'Auto groups', e) } }
    }
    if (adjustments.length) { try { rec.placement(await updatePlacementBidding({ campaignId: camp.id, adjustments, userId })) } catch (e) { rec.threw('placement', 'Placement bid adjustments', e) } }
    outcomes.push(rec.result())
  }
  const launch = summariseLaunch(outcomes)
  // AT.4a — persist the Step-3 harvesting rule as an AutomationRule (domain advertising)
  // so it survives launch instead of being thrown away. The matrix (which ad groups to
  // harvest from + which match types to graduate/negate, incl. the Auto campaign's groups)
  // is encoded in the action's `sources`; the harvest engine honours scoping in AT.4b.
  // Gated: dryRun stays true (the rule proposes via the engine) until the live gate opens.
  // S3.4 — two separate rules: Keyword Harvesting + Negative Targeting.
  const rulesCreated: Array<{ id: string; name: string }> = []
  // H.2 — destination map for keyword graduation: matchType → the ad group of the keyword campaign
  // that hosts that match type (e.g. EXACT → the Exact campaign). A harvested winner promotes there
  // instead of back into its source ad group. Scoped PER ad-product (multi-format) so a winner only
  // ever graduates into a campaign of its OWN format — SP→SP exact/PAT, SB→SB — never across formats.
  // SP-only builds (Quick / SPW / AI Goal) collapse to one product → identical to the old behaviour.
  const widProduct: Record<string, 'SP' | 'SB' | 'SD'> = {}
  const destinationsByProduct: Record<string, Record<string, string>> = {}
  for (const c of campaigns) {
    if (!c.id) continue
    const ref = idMap[c.id]
    if (!ref) continue
    const p = c.adProduct ?? 'SP'
    widProduct[c.id] = p
    const dest = (destinationsByProduct[p] ??= {})
    if (c.kind === 'keyword') { for (const mt of matchTypesFor(c.matchType)) dest[mt] = ref.adGroupId }
    else if (c.kind === 'pat') dest.PRODUCT = ref.adGroupId // H.5 — converting ASINs graduate into the PAT campaign
  }
  type RuleSrc = { product: 'SP' | 'SB' | 'SD'; adGroupId: string; campaignId: string; harvestFrom: boolean; graduate: string[]; negate: string[]; graduateProduct: boolean; negateProduct: boolean }
  const buildRule = async (rcfg: SpwRule | undefined, kind: 'harvest' | 'negative') => {
    if (!rcfg) return
    const allSources: RuleSrc[] = Object.entries(rcfg.rows ?? {})
      .map(([wid, r]) => {
        const ref = idMap[wid]
        if (!ref || !r) return null
        const graduate: string[] = []
        if (r.tB) graduate.push('BROAD'); if (r.tP) graduate.push('PHRASE'); if (r.tE) graduate.push('EXACT')
        const negate: string[] = []
        if (r.nP) negate.push('PHRASE'); if (r.nE) negate.push('EXACT')
        const any = r.st || graduate.length || negate.length || r.tBox || r.nBox
        return any ? { product: widProduct[wid] ?? 'SP', adGroupId: ref.adGroupId, campaignId: ref.campaignId, harvestFrom: !!r.st, graduate, negate, graduateProduct: !!r.tBox, negateProduct: !!r.nBox } : null
      })
      .filter((s): s is RuleSrc => s != null)
    if (!allSources.length) return
    // One correctly-scoped rule per ad-product present in the sources (so destinations never leak
    // across formats). Single-product builds → exactly one rule (unchanged).
    const byProduct = new Map<string, RuleSrc[]>()
    for (const s of allSources) { const a = byProduct.get(s.product) ?? []; a.push(s); byProduct.set(s.product, a) }
    const multi = byProduct.size > 1
    const perf = rcfg.perf ?? {}
    const conds = perf.conditions ?? []
    const ordersC = conds.find((c) => c?.metric === 'PPC Orders' || c?.metric === 'Orders')
    const spendC = conds.find((c) => c?.metric === 'Spend')
    const minOrders = ordersC && Number.isFinite(Number(ordersC.value)) ? Number(ordersC.value) : 2
    const minSpendCents = spendC && Number.isFinite(Number(spendC.value)) ? Math.round(Number(spendC.value) * 100) : 1000
    for (const [product, srcs] of byProduct) {
      try {
        const destinations = destinationsByProduct[product] ?? {}
        const sources = srcs.map(({ product: _p, ...rest }) => rest)
        const tag = multi ? `${product} ` : ''
        const base = (rcfg.ruleName ?? '').trim()
        const name = (base ? `${base}${multi ? ` (${product})` : ''}` : `${(b.productGroupName || 'Campaign').trim()} — ${tag}${kind === 'negative' ? 'Negative Targeting' : 'Harvest & Negate'}`).slice(0, 120)
        // H.4 — propose-first. control:'manual' makes the engine force dry-run and record each run as
        // an AdsRuleSuggestion the operator approves on /marketing/ads/suggestions (approving re-runs
        // it live, write-gated). Flip to hands-off later by dropping control:'manual' + dryRun:false.
        const actions = [
          { type: 'harvest_and_negate', control: 'manual', windowDays: 60, minSpendCents, minOrders, graduationBidEur: 0.5, sources, destinations, perfCriteria: perf, mode: kind },
        ]
        const rule = await prisma.automationRule.create({
          data: {
            name, description: 'Created by SP Super Wizard', domain: 'advertising', trigger: 'SCHEDULE',
            conditions: [] as never, actions: actions as never,
            enabled: !!rcfg.automate, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? null,
          },
        })
        rulesCreated.push({ id: rule.id, name: rule.name })
        logger.warn('[SPW-launch] created rule', { ruleId: rule.id, kind, product, sources: sources.length, enabled: !!rcfg.automate })
      } catch (e) { logger.error('[SPW-launch] rule create failed', { kind, product, error: (e as Error).message }) }
    }
  }
  if (created.length && b.rules) { await buildRule(b.rules.harvest, 'harvest'); await buildRule(b.rules.negative, 'negative') }

  // S3.5 · CC-4 — the chosen bid strategy as rules the engine runs: Target ACoS → one bid_to_target_acos rule per new
  // campaign (a fraction, one campaignId). Strategies with no engine create no rule ("not running yet"). Gated
  // dryRun. Skipped under AI Control / strategy None.
  if (created.length && b.automationMode === 'rule' && b.bidConfig?.strategy && b.bidConfig.strategy !== 'none') {
    const plan = bidStrategyRules({ bidConfig: b.bidConfig, campaigns: created.map((c) => ({ id: c.campaignId, name: c.name })), market, enabled: true, createdBy: userId ?? null, source: 'SP Super Wizard' })
    if (plan.note) logger.warn('[SPW-launch] no bid-strategy rule', { strategy: b.bidConfig.strategy, note: plan.note })
    for (const data of plan.rules) {
      try {
        const rule = await prisma.automationRule.create({ data: data as never })
        rulesCreated.push({ id: rule.id, name: rule.name })
        logger.warn('[SPW-launch] created bid-strategy rule', { ruleId: rule.id, strategy: b.bidConfig.strategy })
      } catch (e) { logger.error('[SPW-launch] bid rule create failed', { error: (e as Error).message }) }
    }
  }

  logger.warn('[SPW-launch] SP Super Wizard created campaigns', { market, grp: (b.productGroupName || '').trim(), count: created.length, rules: rulesCreated.length, actor: userId })
  // AX-VT.1 — confirm the campaigns actually joined the requested portfolio on Amazon,
  // and repair them if the create didn't carry it. Reported so the launch's claim is
  // checked rather than assumed.
  const { settleLaunchPortfolios } = await import('./ads-create.service.js')
  const createdIds = created.map((c) => c.campaignId)
  const portfolioCheck = await settleLaunchPortfolios(createdIds)
  // AX-VT.4 — then read the whole launch back and report intended vs observed. Runs AFTER the
  // portfolio repair so the receipt reflects the state the operator is actually left with.
  // W2-A — the campaigns on Amazon; one that is not is already answered in `launch` with its reason.
  const { verifyLaunch } = await import('./ads-launch-verify.service.js')
  const onAmazonIds = created.filter((c) => c.externalCampaignId).map((c) => c.campaignId)
  const verification = onAmazonIds.length ? await verifyLaunch(onAmazonIds).catch(() => null) : null
  // W2-A (CC-2) — `ok` only when every campaign asked for is live on Amazon; `launch` says, per campaign, what is.
  if (!launch.ok) logger.warn('[SPW-launch] launch did not fully reach Amazon', { market, summary: describeLaunch(launch) })
  return { status: 200, body: { ok: launch.ok, created, totalCampaigns: created.length, rules: rulesCreated, portfolioCheck, verification, launch, ...(launch.ok ? {} : { error: describeLaunch(launch) }) } }
}
