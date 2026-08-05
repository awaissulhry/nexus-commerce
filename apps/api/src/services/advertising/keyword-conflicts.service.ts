/**
 * RC3.2 — Cross-product keyword-rank collision detection.
 *
 * Different products of the same brand bidding on the SAME keyword fight for the
 * same Top-of-search slot and bid each other up (only the higher bid serves, and
 * the loser's spend is wasted defending a rank it won't get). This is distinct
 * from the ASIN-based self-competition check (same product, many campaigns) — here
 * the contenders advertise DIFFERENT ASINs but collide on a shared keyword.
 *
 * The detector returns, per contested keyword, every contender (mine + the rival
 * products), each side's bid + efficiency + Top-of-search intent, and a
 * recommended "champion" (the best performer that should own the keyword). The
 * console then offers one-click resolutions (step the others down / take 2nd /
 * move to rest of search) — all gated, nothing live until the write-gate flips.
 */

export type Contender = {
  campaignId: string
  campaignName: string
  status: string
  asins: string[]
  isMine: boolean
  targetIds: string[] // the AdTarget rows for this keyword in this campaign (bid writes)
  bidCents: number
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  acos: number | null // spend / sales, as a fraction (0.25 = 25%)
  cvr: number | null // orders / clicks
  tosBias: number // Top-of-search placement adjustment %, 0 if none
}

const MIN_CLICKS = 3 // enough signal to trust an ACOS comparison

export function normKeyword(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function acosOf(spendCents: number, salesCents: number): number | null {
  return salesCents > 0 ? spendCents / salesCents : null
}
export function cvrOf(orders: number, clicks: number): number | null {
  return clicks > 0 ? orders / clicks : null
}

/** Top-of-search placement bias % from a Campaign.dynamicBidding JSON blob. */
export function tosBiasOf(dynamicBidding: unknown): number {
  const db = (dynamicBidding ?? {}) as { placementBidding?: Array<{ placement?: string; percentage?: number }> }
  const top = (db.placementBidding ?? []).find((p) => p.placement === 'PLACEMENT_TOP')
  return Number(top?.percentage ?? 0) || 0
}

/**
 * Pick the contender that should OWN a contested keyword.
 *
 * ── ACR.4: aligned to the engine, 2026-08-05 ────────────────────────────────────────────────
 * This function ADVISES an operator to retire a campaign's claim on a keyword. `RD.6`
 * `detectSelfCompetition` DECIDES the same contest every 15 minutes and acts on it. They used
 * different ladders, and measured on prod they named different winners on **83 of 183 contested
 * keywords (45%)** — so an operator retiring the "loser" shown here could be retiring the
 * campaign the engine was actively promoting.
 *
 * The fix is not to swap this for the engine's rule wholesale: the engine ranks on
 * `[acos ?? +∞, −spend]` alone, which leaves every unproven keyword tied and gives an operator
 * nothing to read. Instead the engine's ordering is PRIMARY and this function's extra signals
 * only break what the engine leaves tied. The result cannot contradict the engine — wherever
 * the engine has an opinion it wins — while still discriminating where the engine shrugs.
 *
 * Ladder, in order:
 *   1. lowest ACOS   (engine primary; unknown ACOS ranks worst)
 *   2. higher spend  (engine tie-break; more proven)
 *   3. more impressions, then more clicks   ← only reached when the engine is tied
 *   4. higher bid                            ← only when there is no traffic at all
 *
 * Pure + deterministic for tests.
 */
export function pickChampion(contenders: Contender[]): { championId: string; reason: string } {
  if (contenders.length === 0) return { championId: '', reason: '' }

  const sorted = [...contenders].sort((a, b) => {
    // 1-2: exactly rank-self-competition.ts's rankKey. Do not reorder these two.
    const aa = a.acos ?? Number.POSITIVE_INFINITY
    const ba = b.acos ?? Number.POSITIVE_INFINITY
    if (aa !== ba) return aa - ba
    if (a.spendCents !== b.spendCents) return b.spendCents - a.spendCents
    // 3-4: the engine is indifferent from here, so this is free to be more useful.
    if (a.impressions !== b.impressions) return b.impressions - a.impressions
    if (a.clicks !== b.clicks) return b.clicks - a.clicks
    return b.bidCents - a.bidCents
  })
  const best = sorted[0]!

  // The reason describes what actually decided it, so an operator can see how thin the
  // evidence is. MIN_CLICKS still governs whether an ACOS is worth quoting as a reason.
  if (best.acos != null && best.orders > 0) {
    const pct = `${Math.round(best.acos * 100)}%`
    return {
      championId: best.campaignId,
      reason: best.clicks >= MIN_CLICKS ? `best ACOS ${pct}` : `best ACOS ${pct} (thin: ${best.clicks} clicks)`,
    }
  }
  if (contenders.some((c) => c.spendCents > 0)) return { championId: best.campaignId, reason: 'most spend, no sales yet' }
  if (contenders.some((c) => c.impressions > 0)) return { championId: best.campaignId, reason: 'most traffic, no sales yet' }
  return { championId: best.campaignId, reason: 'highest bid, no traffic yet' }
}

// ── Prisma-backed detection ────────────────────────────────────────────────

type RawTarget = {
  id: string
  expressionValue: string
  expressionType: string
  bidCents: number
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  ordersCount: number
}
type Agg = { ids: string[]; raw: string; matchType: string; bidCents: number; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number }

function foldTarget(into: Map<string, Agg>, t: RawTarget) {
  const key = normKeyword(t.expressionValue)
  if (!key) return
  const g = into.get(key)
  if (!g) {
    into.set(key, { ids: [t.id], raw: t.expressionValue, matchType: t.expressionType, bidCents: t.bidCents, impressions: t.impressions, clicks: t.clicks, spendCents: t.spendCents, salesCents: t.salesCents, orders: t.ordersCount })
  } else {
    g.ids.push(t.id)
    g.bidCents = Math.max(g.bidCents, t.bidCents)
    g.impressions += t.impressions; g.clicks += t.clicks; g.spendCents += t.spendCents; g.salesCents += t.salesCents; g.orders += t.ordersCount
  }
}

export type KeywordConflict = {
  keyword: string
  keyNorm: string
  matchType: string
  contenders: Contender[]
  championId: string
  championReason: string
  bothTop: boolean
}

// Minimal Prisma surface we depend on — keeps this unit-testable with a stub.
interface PrismaLike {
  campaign: { findUnique(args: unknown): Promise<{ marketplace: string | null } | null> }
  adTarget: { findMany(args: unknown): Promise<unknown[]> }
  adProductAd: { findMany(args: unknown): Promise<unknown[]> }
}

export async function detectKeywordConflicts(prisma: PrismaLike, campaignId: string, marketplaceArg?: string) {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { marketplace: true } })
  if (!camp) return null
  const marketplace = marketplaceArg || camp.marketplace || ''

  // 1. My positive keywords, aggregated across ad groups.
  const mine = (await prisma.adTarget.findMany({
    where: { adGroup: { campaignId }, kind: 'KEYWORD', isNegative: false },
    select: { id: true, expressionValue: true, expressionType: true, bidCents: true, impressions: true, clicks: true, spendCents: true, salesCents: true, ordersCount: true },
  })) as RawTarget[]
  const myKeys = new Map<string, Agg>()
  for (const t of mine) foldTarget(myKeys, t)
  if (myKeys.size === 0) return { marketplace, campaignId, conflicts: [], summary: { contestedKeywords: 0, rivalProducts: 0, rivalCampaigns: 0 } }

  // 2. Every enabled positive keyword in the market, with its campaign. Bounded.
  const market = (await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED', adGroup: { campaign: { marketplace, status: 'ENABLED' } } },
    select: { id: true, expressionValue: true, expressionType: true, bidCents: true, impressions: true, clicks: true, spendCents: true, salesCents: true, ordersCount: true, adGroup: { select: { campaignId: true, campaign: { select: { id: true, name: true, status: true, dynamicBidding: true } } } } },
    take: 8000,
  })) as Array<RawTarget & { adGroup: { campaignId: string; campaign: { id: string; name: string; status: string; dynamicBidding: unknown } } }>

  // 3. Per-keyword, per-campaign aggregation (only keywords I also target).
  const perKw = new Map<string, Map<string, Agg & { camp: { id: string; name: string; status: string; dynamicBidding: unknown } }>>()
  const involved = new Set<string>([campaignId])
  for (const t of market) {
    const key = normKeyword(t.expressionValue)
    if (!myKeys.has(key)) continue
    const c = t.adGroup?.campaign
    if (!c) continue
    involved.add(c.id)
    let byCamp = perKw.get(key)
    if (!byCamp) { byCamp = new Map(); perKw.set(key, byCamp) }
    const g = byCamp.get(c.id)
    if (!g) byCamp.set(c.id, { ids: [t.id], raw: t.expressionValue, matchType: t.expressionType, bidCents: t.bidCents, impressions: t.impressions, clicks: t.clicks, spendCents: t.spendCents, salesCents: t.salesCents, orders: t.ordersCount, camp: c })
    else { g.ids.push(t.id); g.bidCents = Math.max(g.bidCents, t.bidCents); g.impressions += t.impressions; g.clicks += t.clicks; g.spendCents += t.spendCents; g.salesCents += t.salesCents; g.orders += t.ordersCount }
  }

  // 4. ASINs per involved campaign — to tell cross-product rivals from same-product.
  const prodAds = (await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId: { in: [...involved] } }, asin: { not: null } },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })) as Array<{ asin: string | null; adGroup: { campaignId: string } | null }>
  const asinByCamp = new Map<string, Set<string>>()
  for (const a of prodAds) {
    const cid = a.adGroup?.campaignId
    if (!cid || !a.asin) continue
    let s = asinByCamp.get(cid)
    if (!s) { s = new Set(); asinByCamp.set(cid, s) }
    s.add(a.asin)
  }
  const myAsins = asinByCamp.get(campaignId) ?? new Set<string>()
  const disjoint = (a: Set<string>, b: Set<string>) => { for (const x of a) if (b.has(x)) return false; return true }

  // 5. Build conflicts: my keyword + ≥1 cross-product rival on the same keyword.
  const conflicts: KeywordConflict[] = []
  const rivalCampaigns = new Set<string>()
  const rivalProducts = new Set<string>()
  for (const [key, mineAgg] of myKeys) {
    const byCamp = perKw.get(key)
    if (!byCamp) continue
    const rivals: Contender[] = []
    for (const [cid, g] of byCamp) {
      if (cid === campaignId) continue
      const rAsins = asinByCamp.get(cid) ?? new Set<string>()
      if (!disjoint(rAsins, myAsins)) continue // same-product overlap → not this check
      rivals.push({
        campaignId: cid, campaignName: g.camp.name, status: g.camp.status, asins: [...rAsins], isMine: false, targetIds: g.ids,
        bidCents: g.bidCents, impressions: g.impressions, clicks: g.clicks, spendCents: g.spendCents, salesCents: g.salesCents, orders: g.orders,
        acos: acosOf(g.spendCents, g.salesCents), cvr: cvrOf(g.orders, g.clicks), tosBias: tosBiasOf(g.camp.dynamicBidding),
      })
    }
    if (rivals.length === 0) continue
    const mineContender: Contender = {
      campaignId, campaignName: 'This campaign', status: 'ENABLED', asins: [...myAsins], isMine: true, targetIds: mineAgg.ids,
      bidCents: mineAgg.bidCents, impressions: mineAgg.impressions, clicks: mineAgg.clicks, spendCents: mineAgg.spendCents, salesCents: mineAgg.salesCents, orders: mineAgg.orders,
      acos: acosOf(mineAgg.spendCents, mineAgg.salesCents), cvr: cvrOf(mineAgg.orders, mineAgg.clicks),
      tosBias: byCamp.get(campaignId) ? tosBiasOf(byCamp.get(campaignId)!.camp.dynamicBidding) : 0,
    }
    const contenders = [mineContender, ...rivals]
    const champ = pickChampion(contenders)
    const bothTop = contenders.filter((c) => c.tosBias > 0).length >= 2
    for (const r of rivals) { rivalCampaigns.add(r.campaignId); for (const a of r.asins) rivalProducts.add(a) }
    conflicts.push({ keyword: mineAgg.raw, keyNorm: key, matchType: mineAgg.matchType, contenders, championId: champ.championId, championReason: champ.reason, bothTop })
  }

  // 6. Worst first: real top-of-search collisions, then by contested spend.
  conflicts.sort((a, b) => {
    if (a.bothTop !== b.bothTop) return a.bothTop ? -1 : 1
    const sp = (x: KeywordConflict) => x.contenders.reduce((s, c) => s + c.spendCents, 0)
    return sp(b) - sp(a)
  })

  return { marketplace, campaignId, conflicts, summary: { contestedKeywords: conflicts.length, rivalProducts: rivalProducts.size, rivalCampaigns: rivalCampaigns.size } }
}
