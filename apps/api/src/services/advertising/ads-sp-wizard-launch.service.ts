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
 *
 * PB-5a adds `SpwLaunchOptions`, used only by the ads playbook's build (ads-playbook/build.ts): born off the live-write
 * allowlist, born at the no-pause floor with every planned bid remembered, the approval's change set on every log row,
 * progress, and placements left for START. Without options the launch is the screens', unchanged — except that its
 * negatives now pass `creationFlow` (as the Single launch's do): on a screen launch the campaign is already on the
 * allowlist there, so nothing changes for them. The answer also gains `slots` (wizard campaign id → the campaign and
 * ad group made).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { AdsActor } from './ads-mutation.service.js'
import { normaliseFloorCents } from './ads-bid-suppression.service.js'

export type PRef = { asin?: string; sku?: string; productId?: string }
export type SpwRule = { ruleName?: string; automate?: boolean; perf?: { conditions?: Array<{ metric?: string; op?: string; value?: string }>; lookback?: string; exclude?: string }; rows?: Record<string, { st?: boolean; tB?: boolean; tP?: boolean; tE?: boolean; tBox?: boolean; nP?: boolean; nE?: boolean; nBox?: boolean }> }

/** The launch's body, as the wizard's screens send it. */
export interface SpwLaunchBody {
  market?: string; productGroupName?: string
  products?: PRef[]
  campaigns?: Array<{ id?: string; name: string; adGroupName?: string; kind: 'auto' | 'keyword' | 'pat'; adProduct?: 'SP' | 'SB' | 'SD'; matchType?: string; theme?: string; bidEur?: number; budgetEur?: number; keywords?: Array<string | { text: string; matchType?: 'BROAD' | 'PHRASE' | 'EXACT'; bidEur?: number }>; productTargets?: PRef[]; negKeywords?: Array<string | { text?: string; matchType?: 'EXACT' | 'PHRASE' }>; negProducts?: PRef[]; autoGroups?: Array<{ key: string; enabled?: boolean; bidEur?: number }>; creative?: Record<string, unknown>
    /** PB-5a — Amazon's bidding strategy for this campaign (the playbook slot's). Absent: legacyForSales, as the screens. */
    biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL' }>
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

/**
 * Where a launch is: campaigns started so far, of how many, the one being made (null at the end), campaigns made, and
 * the Nexus ids of the campaigns made so far (a caller records them as they come).
 */
export interface SpwProgress { done: number; total: number; campaign: string | null; created: number; campaignIds: string[] }

/** PB-5a — the ads playbook's build. Absent: the screens' launch, unchanged. */
export interface SpwLaunchOptions {
  /**
   * CC-7 — default TRUE (every screen): the campaign goes on the live-write allowlist the moment it exists. false = born
   * off it (the playbook build): its parts still reach Amazon (every create of the launch passes `creationFlow`), but no
   * engine, rule or later edit writes to it until a person puts it on the list (the playbook's START).
   */
  allowlistAtBirth?: boolean
  /**
   * The A11 pattern (ads-single-launch.service.ts): a bid above `floorCents` is created AT it, with the planned bid kept
   * in `suppressedFromBidCents` (the ad group default, each keyword, product target and Auto group); the campaign is
   * flagged `bidsSuppressedAt` / `bidsSuppressedFloorCents` / `bidsSuppressedBy = by` right after it is created. Born
   * ENABLED, never paused: the floor is what keeps it from spending; `restoreCampaignBids` puts the planned bids back.
   */
  bornSuppressed?: { floorCents: number; by: AdsActor }
  /** The approval it runs for: every AdvertisingActionLog row it writes carries it (executionId). */
  changeSetId?: string | null
  /** Before each campaign and once at the end; best-effort (a failed progress write never stops a launch). */
  onProgress?: (p: SpwProgress) => Promise<void>
  /** Write no placements (a campaign off the allowlist is refused them): they are returned as `deferredPlacements`. */
  deferPlacements?: boolean
}

/** The launch, as the route ran it: `userId` is the actor the route takes from the signed-in person (CC-28). */
export async function spWizardLaunch(b: SpwLaunchBody, userId: AdsActor, opts: SpwLaunchOptions = {}): Promise<SpwLaunchResult> {
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

  // PB-5a — the options. Absent, every helper below is the identity and the launch is the screens'.
  const allowlistAtBirth = opts.allowlistAtBirth !== false
  const changeSetId = opts.changeSetId ?? null
  const cs = changeSetId ? { changeSetId } : {}
  const floor = opts.bornSuppressed ? normaliseFloorCents(opts.bornSuppressed.floorCents) : null
  const cents = (eur: number) => Math.round(eur * 100)
  const floored = (eur: number) => floor != null && cents(eur) > floor
  const startEur = (eur: number) => (floored(eur) ? (floor as number) / 100 : eur)
  const remember = (adTargetId: string, eur: number) => prisma.adTarget.update({ where: { id: adTargetId }, data: { suppressedFromBidCents: cents(eur) } })
  const deferredPlacements: Array<{ campaignId: string; adjustments: typeof adjustments }> = []
  const progress = async (p: SpwProgress) => { if (opts.onProgress) { try { await opts.onProgress(p) } catch { /* progress is not the work */ } } }

  const created: Array<{ name: string; campaignId: string; externalCampaignId: string | null; mode: string }> = []
  const idMap: Record<string, { campaignId: string; adGroupId: string }> = {} // wizard campaign id → created ids (for the harvest rule)
  // W2-A (CC-2) — every campaign asked for is answered: live, partly made (what failed and why) or not made (why).
  // Each step is caught on its own, so a failure no longer drops the campaign (and what it already made on Amazon)
  // from the answer, the rules and the read-back.
  const { CampaignLaunch, summariseLaunch, describeLaunch } = await import('./launch-outcome.js')
  const outcomes: import('./launch-outcome.js').LaunchCampaignResult[] = []
  for (const [i, c] of campaigns.entries()) {
    await progress({ done: i, total: campaigns.length, campaign: c.name, created: created.length, campaignIds: created.map((x) => x.campaignId) })
    const rec = new CampaignLaunch(c.name)
    const bidEur = Number(c.bidEur) || 0.75
    const budgetEur = Number(c.budgetEur) || 10
    const biddingStrategy = c.biddingStrategy === 'AUTO_FOR_SALES' ? 'autoForSales' : c.biddingStrategy === 'MANUAL' ? 'manual' : 'legacyForSales'
    let camp: Awaited<ReturnType<typeof createCampaignLocal>>
    try {
      camp = await createCampaignLocal({ name: c.name, type: c.adProduct ?? 'SP', marketplace: market, targetingType: c.kind === 'auto' ? 'AUTO' : 'MANUAL', dailyBudgetEur: budgetEur, biddingStrategy, portfolioId: b.portfolioId, userId, ...cs })
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
    // PB-5a — off it for the playbook's build (`allowlistAtBirth: false`).
    if (allowlistAtBirth) { try { await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } }) } catch (e) { logger.warn('[SPW-launch] allowlist failed', { error: (e as Error).message }) } }
    // PB-5a — born at the floor: flagged as suppressed by the person who asked, from the moment it exists.
    if (floor != null) {
      try { await prisma.campaign.update({ where: { id: camp.id }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.bornSuppressed!.by } }) }
      catch (e) { rec.threw('campaign', 'Born at the floor', e); logger.error('[SPW-launch] floor flag failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    // SB creative (brand · ad type · landing page · ASINs · headline · logo/custom image) → Campaign.creativeAssetJson (gated; pushed to Amazon when the SB write gate opens).
    if (c.creative && c.adProduct === 'SB') { try { await prisma.campaign.update({ where: { id: camp.id }, data: { creativeAssetJson: c.creative as never } }) } catch (e) { logger.warn('[SPW-launch] SB creative store failed', { error: (e as Error).message }) } }
    const adGroupName = c.adGroupName || `${c.name} Ad Group`
    let ag: Awaited<ReturnType<typeof createAdGroupLocal>>
    // CM-20 — `creationFlow`: everything below belongs to the campaign this launch just created.
    try { ag = await createAdGroupLocal({ campaignId: camp.id, name: adGroupName, defaultBidEur: startEur(bidEur), userId, creationFlow: true, ...cs }) } catch (e) {
      rec.adGroup(adGroupName, null, e)
      outcomes.push(rec.result())
      logger.error('[SPW-launch] ad group create failed', { name: c.name, market, error: (e as Error).message })
      continue
    }
    rec.adGroup(adGroupName, ag)
    const agId = ag.id as string
    if (c.id) idMap[c.id] = { campaignId: camp.id, adGroupId: agId }
    if (floored(bidEur)) { try { await prisma.adGroup.update({ where: { id: agId }, data: { suppressedFromBidCents: cents(bidEur) } }) } catch (e) { rec.threw('ad_group', 'Remember the planned default bid', e) } }
    // W2-A (CC-17) — negatives FIRST, as Replicate does: a launch that fails part-way is then narrower, never wider.
    // PB-5a — they are part of the launch, as its keywords and product ads are, so they pass `creationFlow` (as the
    // Single launch's, 5b): a campaign born off the allowlist (the playbook build) is otherwise refused them.
    for (const nk of c.negKeywords ?? []) { const text = (typeof nk === 'string' ? nk : nk?.text ?? '').trim(); if (!text) continue; const mt: 'EXACT' | 'PHRASE' = (typeof nk === 'object' && nk?.matchType === 'PHRASE') ? 'PHRASE' : 'EXACT'; try { rec.negative('negative_keyword', `${text} (${mt.toLowerCase()})`, await createNegativeKeywordLocal({ adGroupId: agId, keywordText: text, matchType: mt, userId, creationFlow: true, ...cs })) } catch (e) { rec.threw('negative_keyword', text, e) } }
    for (const np of c.negProducts ?? []) { const asin = np.asin || np.sku; if (!asin) continue; try { rec.negative('negative_product', asin, await createNegativeProductTargetLocal({ adGroupId: agId, asin, userId, creationFlow: true, ...cs })) } catch (e) { rec.threw('negative_product', asin, e) } }
    for (const p of products) { const item = p.sku || p.asin || p.productId || '?'; try { rec.productAd(item, await createProductAdLocal({ adGroupId: agId, asin: p.asin, sku: p.sku, productId: p.productId, userId, launch: true, creationFlow: true, ...cs })) } catch (e) { rec.threw('product_ad', item, e) } }
    if (c.kind === 'keyword') {
      // Per-keyword match type + bid when provided (Guided's Add-Keywords step); else fall back to
      // the campaign's match type(s) + default bid (SPW / Quick send plain strings — unchanged).
      for (const kwRaw of c.keywords ?? []) {
        const text = (typeof kwRaw === 'string' ? kwRaw : kwRaw?.text ?? '').trim()
        if (!text) continue
        const kwBid = typeof kwRaw === 'object' && Number.isFinite(Number(kwRaw?.bidEur)) && Number(kwRaw?.bidEur) > 0 ? Number(kwRaw.bidEur) : bidEur
        const mts = typeof kwRaw === 'object' && kwRaw?.matchType ? [kwRaw.matchType] : matchTypesFor(c.matchType)
        for (const mt of mts) { try { const k = await createKeywordLocal({ adGroupId: agId, keywordText: text, matchType: mt, bidEur: startEur(kwBid), userId, creationFlow: true, ...cs }); rec.keyword(`${text} (${mt.toLowerCase()})`, k); if (floored(kwBid) && !k.existed && k.id) await remember(k.id, kwBid) } catch (e) { rec.threw('keyword', text, e) } }
      }
    } else if (c.kind === 'pat') {
      for (const pt of c.productTargets ?? []) { const asin = pt.asin || pt.sku; if (!asin) continue; try { const t = await createTargetLocal({ adGroupId: agId, kind: 'PRODUCT', value: asin, bidEur: startEur(bidEur), userId, creationFlow: true, ...cs }); rec.productTarget(asin, t); if (floored(bidEur) && t.id) await remember(t.id, bidEur) } catch (e) { rec.threw('product_target', asin, e) } }
    } else if (c.kind === 'auto') {
      // W2-A (CC-1) — Amazon makes the four auto groups itself: link them and set each one's on/off and bid as chosen
      // (AT.1). Posting them as new targets is refused by Amazon, which left these choices in Nexus only.
      const groups = (c.autoGroups ?? []).filter((g) => g?.key).map((g) => ({ key: g.key, enabled: g.enabled !== false, bidEur: Number(g.bidEur) || bidEur }))
      if (groups.length) {
        try {
          const linked = await linkAutoTargeting({ adGroupId: agId, groups: groups.map((g) => ({ ...g, bidEur: startEur(g.bidEur) })), userId, creationFlow: true, ...cs })
          rec.autoGroups(linked)
          // PB-5a — each linked group remembers the bid planned for it (the wish it was linked from).
          if (floor != null) {
            const planned = new Map(groups.map((g) => [g.key, g.bidEur]))
            for (const l of linked.links) { const eur = planned.get(l.key); if (l.adTargetId && eur != null && floored(eur)) await remember(l.adTargetId, eur) }
          }
        } catch (e) { rec.threw('auto_targeting', 'Auto groups', e) }
      }
    }
    if (adjustments.length && opts.deferPlacements) deferredPlacements.push({ campaignId: camp.id, adjustments })
    else if (adjustments.length) { try { rec.placement(await updatePlacementBidding({ campaignId: camp.id, adjustments, userId, ...cs })) } catch (e) { rec.threw('placement', 'Placement bid adjustments', e) } }
    outcomes.push(rec.result())
  }
  const launch = summariseLaunch(outcomes)
  await progress({ done: campaigns.length, total: campaigns.length, campaign: null, created: created.length, campaignIds: created.map((x) => x.campaignId) })
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
  // PB-6a (C1) — a keyword match type ONE campaign hosts is a rule-level destination. One that several host (Advanced:
  // Exact | Brand, Competitor, Category) lands, per source, in the host of the source's own theme: `theme` when the
  // payload names it, else the one slot token of the campaign's name that is a theme (its words after the product
  // group's name, split at "-", so a group named "Brand …" does not count). A source with no theme (Auto) takes the
  // Category host: the conservative default (spec §2.4). Where none fits, nowhere (refused by name at graduation). It
  // used to be the last one written, so every brand winner went to Exact | Category.
  const THEMES = ['brand', 'competitor', 'category']
  const groupName = (b.productGroupName || '').trim().toLowerCase()
  const themeOf = (c: { name: string; theme?: string }): string | null => {
    const named = typeof c.theme === 'string' ? c.theme.trim().toLowerCase() : ''
    if (THEMES.includes(named)) return named
    const name = c.name.trim().toLowerCase()
    const slots = (groupName && name.startsWith(groupName) ? name.slice(groupName.length) : name).split('-').map((t) => t.trim())
    const found = THEMES.filter((t) => slots.includes(t))
    return found.length === 1 ? found[0] : null
  }
  const widProduct: Record<string, 'SP' | 'SB' | 'SD'> = {}
  const widTheme: Record<string, string | null> = {}
  const destinationsByProduct: Record<string, Record<string, string>> = {}
  const hostsByProduct: Record<string, Record<string, Array<{ adGroupId: string; theme: string | null }>>> = {}
  for (const c of campaigns) {
    if (!c.id) continue
    const ref = idMap[c.id]
    if (!ref) continue
    const p = c.adProduct ?? 'SP'
    widProduct[c.id] = p
    widTheme[c.id] = themeOf(c)
    const dest = (destinationsByProduct[p] ??= {})
    if (c.kind === 'keyword') { for (const mt of matchTypesFor(c.matchType)) ((hostsByProduct[p] ??= {})[mt] ??= []).push({ adGroupId: ref.adGroupId, theme: widTheme[c.id] }) }
    else if (c.kind === 'pat') dest.PRODUCT = ref.adGroupId // H.5 — converting ASINs graduate into the PAT campaign
  }
  for (const [p, byMatch] of Object.entries(hostsByProduct)) for (const [mt, hosts] of Object.entries(byMatch)) if (hosts.length === 1) destinationsByProduct[p][mt] = hosts[0].adGroupId
  const ownDestinations = (wid: string, p: string): Record<string, string | null> | null => {
    const out: Record<string, string | null> = {}
    for (const [mt, hosts] of Object.entries(hostsByProduct[p] ?? {})) {
      if (hosts.length < 2) continue
      const mine = hosts.filter((h) => h.theme === (widTheme[wid] ?? 'category'))
      out[mt] = mine.length === 1 ? mine[0].adGroupId : null
    }
    return Object.keys(out).length ? out : null
  }
  type RuleSrc = { product: 'SP' | 'SB' | 'SD'; adGroupId: string; campaignId: string; harvestFrom: boolean; graduate: string[]; negate: string[]; graduateProduct: boolean; negateProduct: boolean; destinations?: Record<string, string | null> }
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
        const own = ownDestinations(wid, widProduct[wid] ?? 'SP')
        return any ? { product: widProduct[wid] ?? 'SP', adGroupId: ref.adGroupId, campaignId: ref.campaignId, harvestFrom: !!r.st, graduate, negate, graduateProduct: !!r.tBox, negateProduct: !!r.nBox, ...(own ? { destinations: own } : {}) } : null
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
        // PB-6a — v2: each row's ticks are literal ([] = none); no constant bid (a winner starts at its CPC, inside the band).
        const actions = [
          { type: 'harvest_and_negate', v: 2, control: 'manual', windowDays: 60, minSpendCents, minOrders, sources, destinations, perfCriteria: perf, mode: kind },
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
  return { status: 200, body: { ok: launch.ok, created, totalCampaigns: created.length, rules: rulesCreated, portfolioCheck, verification, launch, slots: idMap, ...(opts.deferPlacements ? { deferredPlacements } : {}), ...(launch.ok ? {} : { error: describeLaunch(launch) }) } }
}
