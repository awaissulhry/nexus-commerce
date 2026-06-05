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
 * Pick the contender that should OWN a contested keyword. Efficiency first: among
 * those that actually convert, lowest ACOS wins; then most orders; then — if no
 * one has sold yet — the most-established (impressions) or, with no traffic at
 * all, the strongest intent (highest bid). Pure + deterministic for tests.
 */
export function pickChampion(contenders: Contender[]): { championId: string; reason: string } {
  if (contenders.length === 0) return { championId: '', reason: '' }

  const withSales = contenders.filter((c) => c.orders > 0)
  if (withSales.length > 0) {
    // Trust ACOS only where there's enough click signal; otherwise fall back to it
    // anyway (an order is an order) but prefer the click-backed ones.
    const trusted = withSales.filter((c) => c.clicks >= MIN_CLICKS)
    const pool = trusted.length > 0 ? trusted : withSales
    const best = [...pool].sort((a, b) => {
      const aa = a.acos ?? Infinity
      const ba = b.acos ?? Infinity
      if (aa !== ba) return aa - ba
      if (b.orders !== a.orders) return b.orders - a.orders
      return a.bidCents - b.bidCents
    })[0]!
    const pct = best.acos != null ? `${Math.round(best.acos * 100)}%` : '—'
    return { championId: best.campaignId, reason: `best ACOS ${pct}` }
  }

  const withClicks = contenders.filter((c) => c.clicks > 0)
  if (withClicks.length > 0) {
    // Nobody has sold; keep the most-established (impressions) and step the rest
    // down so we stop paying twice for an unproven keyword.
    const best = [...withClicks].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)[0]!
    return { championId: best.campaignId, reason: 'most traffic, no sales yet' }
  }

  const best = [...contenders].sort((a, b) => b.bidCents - a.bidCents)[0]!
  return { championId: best.campaignId, reason: 'highest bid' }
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
