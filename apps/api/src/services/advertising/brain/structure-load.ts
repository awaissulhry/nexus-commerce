/**
 * ONE BRAIN AB-16 — the structure lever's facts for one product in one market (design 2026-10-08-ads-one-brain/DESIGN.md
 * §2.9, §2.6 N2, §5). Reads only. brain/structure.ts decides from them; brain/structure-run.ts stores and asks.
 *
 *   due        an enrolled product, not excluded, whose structure lever (product level) is OBSERVE, PROPOSE or LOCKED (a
 *              locked lever's proposals are stored as recommendations).
 *   campaigns  brain/ownership.ts: its own campaigns (advertising it alone) and the shared ones (several products: a split).
 *   terms      the search terms of its own campaigns over the 30 settled days (ads-settled-window.ts), summed per normalised
 *              term — the same source for the term's orders and the product's (the share's two sides); each term's exact
 *              home (the exact keyword where it ran most), a campaign that runs it alone already, the market arbiter's lead
 *              (AdsBrainTermLead), and the hour-curve test on the Marketing Stream's ad-group hours (BB-16) where the term
 *              carries most of its ad group's clicks.
 *   playbook   the product's playbook row in the market, whether the product is enrolled in it, its portfolio link, and the
 *              winners view (ads-playbook/winners.ts) for the terms' state and next step.
 *   shared     per shared campaign: each product's SKUs there, enrollment, structure lever, share of the campaign's spend
 *              (the product-ad report), first-budget cap, and the keywords its own campaigns already buy (by its ASINs, as the
 *              replicate gate reads conflicts); the unresolved ads; the Owner's exclusion; its keywords and counts.
 *   portfolios its own campaigns' portfolios, each with how many other campaigns it holds.
 *   caps       this week's new campaigns of the harvest AND the structure (shared caps), the standing single-keyword
 *              campaigns, the first budget (brain/structure.ts firstBudgetCap).
 *   ceiling    NEXUS_ADS_BRAIN_STRUCTURE_MODE=live (and the brain's own NEXUS_BID_BRAIN_MODE=live) lets PROPOSE ask; anything
 *              else and every level only logs (production as AB-16 ships).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { settledBounds } from '../ads-settled-window.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { MARKET_TIME_ZONE } from '../ads-market-time.js'
import { isAsin } from '../ads-negation-policy.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { leverKillWhy } from './kill-switch.js'
import { productCampaigns } from './ownership.js'
import { resolveBrainSettings, type BrainSettings, type OverrideRow } from './settings.js'
import { termKey, type LeverEffective } from './terms.js'
import { localDayHour, researchDays, type HourCell } from './hours-research.js'
import {
  firstBudgetCap, hourCurveDistance, isStructureStatus, splitKey, HOUR_CURVE_MIN_DAYS, HOUR_CURVE_MIN_ORDERS, HOUR_CURVE_TERM_SHARE, HOUR_CURVE_WEEKS,
  SKC_WINDOW_DAYS, STANDING_STATUSES,
  type HourTest, type PortfolioFact, type SharedCampaignFact, type SkcTermFact, type SplitProductFact, type StructureProductFacts, type StructureStatus,
} from './structure.js'

const ACTS: readonly string[] = ['OBSERVE', 'PROPOSE', 'LOCKED']
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
const DAY_MS = 86_400_000
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100)
const isExact = (t: string | null | undefined) => /^_?EXACT$/i.test(String(t ?? '').trim())

/** The env ceiling of the structure's requests (both switches live). */
export function structureCeiling(env: NodeJS.ProcessEnv = process.env): { live: boolean; why: string } {
  if (!brainLiveCeiling(env.NEXUS_BID_BRAIN_MODE)) return { live: false, why: 'the brain\'s env ceiling NEXUS_BID_BRAIN_MODE is not live' }
  if ((env.NEXUS_ADS_BRAIN_STRUCTURE_MODE ?? '').trim().toLowerCase() !== 'live') return { live: false, why: 'the structure\'s env ceiling NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow' }
  return { live: true, why: 'the structure\'s env ceiling is live' }
}

export interface StructureDueProduct { productId: string; market: string; settings: BrainSettings }
export interface StructureDue { due: boolean; why: string; products: StructureDueProduct[] }

/** The enrolled products whose structure lever (product level) is OBSERVE, PROPOSE or LOCKED. Nothing enrolled: one read. */
export async function structureDue(filter: { productId?: string; market?: string } = {}): Promise<StructureDue> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({
    where: { ...(filter.productId ? { productId: filter.productId } : {}), ...(filter.market ? { marketplace: strategyMarket(filter.market) ?? filter.market } : {}) },
    select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }],
  })
  if (!enrollments.length) return { due: false, why: 'no product is enrolled in the brain: no structure to decide', products: [] }
  const overrides = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, scope: 'PRODUCT', productId: { in: [...new Set(enrollments.map((e) => e.productId))] } }, select: OVERRIDE_SELECT,
  }) as OverrideRow[]
  const products = enrollments.flatMap((e) => {
    const settings = resolveBrainSettings({ productId: e.productId, market: e.marketplace, campaignId: null, enrolled: true, overrides })
    return ACTS.includes(settings.levers.structure.effective) ? [{ productId: e.productId, market: e.marketplace, settings }] : []
  })
  return products.length
    ? { due: true, why: `${products.length} product${products.length === 1 ? '' : 's'} with the structure lever at OBSERVE, PROPOSE or locked`, products }
    : { due: false, why: `${enrollments.length} product${enrollments.length === 1 ? ' is' : 's are'} enrolled, none with the structure lever at OBSERVE or higher: no structure to decide`, products: [] }
}

/** Records that took a slot of the week's new campaigns (asked, built, live, declined; a shadow or held one did not). */
const TOOK_STRUCTURE: readonly StructureStatus[] = ['PROPOSED', 'BUILT', 'LIVE_PROPOSED', 'LIVE', 'DONE', 'DECLINED']
/** The harvest's records that took a new campaign of the week, and those whose campaign stands (brain/harvest-load.ts). */
const HARVEST_TOOK = ['PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED', 'DECLINED', 'UNDONE']
const HARVEST_STANDING = ['CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED']

/** How many new campaigns a structure record takes from the caps (an SKC one, a split one per product). */
export const campaignsOf = (r: { kind: string; plan: unknown }): number => {
  if (r.kind === 'SKC') return 1
  if (r.kind !== 'SPLIT') return 0
  const n = (r.plan as { campaigns?: unknown } | null)?.campaigns
  return typeof n === 'number' && n > 0 ? n : 1
}

/**
 * This week's new campaigns the STRUCTURE proposals took (per product and in the market) and each product's standing
 * single-keyword campaigns: what the harvest adds to its own counts, so the caps of §2.9 / §5 are one cap for both.
 */
export async function structureCampaignsUsed(market: string, productIds: readonly string[], weekAgo: Date): Promise<{ market: number; byProduct: Map<string, { week: number; skcs: number }> }> {
  const rows = await prisma.adsBrainStructure.findMany({
    where: { marketplace: market, kind: { in: ['SKC', 'SPLIT'] }, OR: [{ decidedAt: { gte: weekAgo }, status: { in: [...TOOK_STRUCTURE] } }, ...(productIds.length ? [{ productId: { in: [...productIds] }, kind: 'SKC', status: { in: [...STANDING_STATUSES] } }] : [])] },
    select: { productId: true, kind: true, status: true, decidedAt: true, plan: true },
  })
  const byProduct = new Map<string, { week: number; skcs: number }>(productIds.map((p) => [p, { week: 0, skcs: 0 }]))
  let inMarket = 0
  for (const r of rows) {
    const thisWeek = r.decidedAt >= weekAgo && (TOOK_STRUCTURE as readonly string[]).includes(r.status)
    if (thisWeek) inMarket += campaignsOf(r)
    const p = byProduct.get(r.productId)
    if (!p) continue
    if (thisWeek) p.week += 1
    if (r.kind === 'SKC' && (STANDING_STATUSES as readonly string[]).includes(r.status)) p.skcs += 1
  }
  return { market: inMarket, byProduct }
}

type CellRow = { campaignId: string; adGroupId: string; date: Date; hour: number; impressions: bigint; clicks: bigint; costMicros: bigint; orders: bigint; sales: bigint }

/**
 * The Marketing Stream's hours of these campaigns at ad-group grain (BB-16), per Amazon ad group × local day × hour over
 * the research days (1-day conversions, summed over placements; a transient negative sum read as 0), and how many local
 * days each campaign has data on.
 */
export async function adGroupHours(externalCampaignIds: readonly string[], market: string, now: Date): Promise<{ cells: Map<string, HourCell[]>; campaignOf: Map<string, string>; daysOf: Map<string, number>; days: string[] }> {
  const timeZone = MARKET_TIME_ZONE[market] ?? 'Europe/Rome'
  const days = researchDays(now, timeZone, HOUR_CURVE_WEEKS)
  const out = { cells: new Map<string, HourCell[]>(), campaignOf: new Map<string, string>(), daysOf: new Map<string, number>(), days }
  if (!externalCampaignIds.length) return out
  const first = new Date(Date.parse(`${days[0]}T00:00:00Z`) - DAY_MS)
  const last = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + DAY_MS)
  const rows = await prisma.$queryRaw<CellRow[]>(Prisma.sql`
    SELECT "campaignId", "adGroupId", "date", "hour",
           sum("impressions")::bigint AS impressions, sum("clicks")::bigint AS clicks, sum("costMicros")::bigint AS "costMicros",
           sum("orders1d")::bigint AS orders, sum("sales1dCents")::bigint AS sales
      FROM "AmazonAdsHourlyPlacement"
     WHERE "campaignId" IN (${Prisma.join([...externalCampaignIds])}) AND "date" >= ${first}::date AND "date" <= ${last}::date
     GROUP BY "campaignId", "adGroupId", "date", "hour"`)
  const inWindow = new Set(days)
  const byKey = new Map<string, HourCell>()
  const daysSeen = new Map<string, Set<string>>()
  for (const r of rows) {
    const { day, hour } = localDayHour(new Date(r.date.getTime() + Number(r.hour) * 3_600_000), timeZone)
    if (!inWindow.has(day)) continue
    out.campaignOf.set(r.adGroupId, r.campaignId)
    daysSeen.set(r.campaignId, (daysSeen.get(r.campaignId) ?? new Set()).add(day))
    const k = `${r.adGroupId}|${day}|${hour}`
    const c = byKey.get(k) ?? { day, hour, impressions: 0, clicks: 0, spendCents: 0, orders: 0, salesCents: 0 }
    c.impressions += Math.max(0, Number(r.impressions)); c.clicks += Math.max(0, Number(r.clicks)); c.spendCents += Math.max(0, Number(r.costMicros) / 10_000)
    c.orders += Math.max(0, Number(r.orders)); c.salesCents += Math.max(0, Number(r.sales))
    byKey.set(k, c)
  }
  for (const [k, c] of byKey) {
    const adGroupId = k.split('|')[0]
    out.cells.set(adGroupId, [...(out.cells.get(adGroupId) ?? []), c])
  }
  for (const [campaignId, seen] of daysSeen) out.daysOf.set(campaignId, seen.size)
  return out
}

/** The family root of each live product row (a variation → its parent). */
const rootOf = (p: { id: string; parentId: string | null }) => p.parentId ?? p.id

/**
 * One product's structure facts in one market; `skipped` when there is nothing to decide (no family root). A fixed number of
 * reads per product, plus a few per shared campaign (a product holds few). `products` (optional) carries its due settings.
 */
export async function loadStructureFacts(d: StructureDueProduct, now: Date): Promise<StructureProductFacts | { skipped: string }> {
  const market = d.market
  const found = await productCampaigns(d.productId, market)
  if (!found) return { skipped: 'the product has no family root in this market (deleted, or an ASIN two families carry): nothing to decide' }
  const root = found.root
  const ownIds = found.owned.map((c) => c.campaignId)
  const sharedIds = found.shared.map((c) => c.campaignId)
  const allIds = [...ownIds, ...sharedIds]
  const window = settledBounds(SKC_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now })
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS)

  const [campaigns, positives, overrides, records, used, harvestWeek, harvestMarket, harvestStanding, budget, names, rootRow, ownAds, playbookRow] = await Promise.all([
    allIds.length ? prisma.campaign.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true, status: true, portfolioId: true, externalCampaignId: true, dailyBudget: true } }) : Promise.resolve([]),
    ownIds.length ? prisma.adTarget.findMany({
      where: { adGroup: { campaignId: { in: ownIds }, status: { not: 'ARCHIVED' } }, isNegative: false, status: { not: 'ARCHIVED' }, retiredAt: null, kind: { in: ['KEYWORD', 'PRODUCT', 'AUTO'] } },
      select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, adGroup: { select: { campaignId: true, externalAdGroupId: true } } },
    }) : Promise.resolve([]),
    prisma.adsBrainOverride.findMany({
      where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: root, marketplace: market }, ...(allIds.length ? [{ scope: 'CAMPAIGN', campaignId: { in: allIds } }] : [])] }, select: OVERRIDE_SELECT,
    }) as Promise<OverrideRow[]>,
    prisma.adsBrainStructure.findMany({ where: { marketplace: market, OR: [{ productId: root }, ...(sharedIds.length ? [{ key: { in: sharedIds.map(splitKey) } }] : [])] }, select: { key: true, status: true, changedAt: true } }),
    structureCampaignsUsed(market, [root], weekAgo),
    prisma.adsBrainHarvest.count({ where: { marketplace: market, productId: root, destinationKind: 'NEW_CAMPAIGN', decidedAt: { gte: weekAgo }, status: { in: HARVEST_TOOK } } }),
    prisma.adsBrainHarvest.count({ where: { marketplace: market, destinationKind: 'NEW_CAMPAIGN', decidedAt: { gte: weekAgo }, status: { in: HARVEST_TOOK } } }),
    prisma.adsBrainHarvest.findMany({ where: { marketplace: market, productId: root, destinationKind: 'NEW_CAMPAIGN', status: { in: HARVEST_STANDING } }, select: { term: true } }),
    prisma.adsBrainBudgetDecision.findFirst({ where: { marketplace: market, productId: root, envelopeCents: { not: null } }, orderBy: { createdAt: 'desc' }, select: { envelopeCents: true, month: true } }),
    prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } }, select: { name: true, marketplace: true } }),
    prisma.product.findFirst({ where: { id: root }, select: { id: true, sku: true, name: true } }),
    ownIds.length ? prisma.adProductAd.findMany({ where: { status: { not: 'ARCHIVED' }, adGroup: { campaignId: { in: ownIds }, status: { not: 'ARCHIVED' } } }, select: { sku: true, productId: true } }) : Promise.resolve([]),
    prisma.adsPlaybook.findFirst({ where: { channel: 'AMAZON', market, level: 'PRODUCT', scopeId: root }, select: { id: true } }),
  ])
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const settingsOf = (campaignId: string | null) => resolveBrainSettings({ productId: root, market, campaignId, enrolled: true, overrides })
  const product = settingsOf(null)
  const label = rootRow?.name?.trim() || rootRow?.sku || root
  const num = (k: keyof BrainSettings['values']) => Number(product.values[k].value)

  // ── terms: the search terms of the product's own campaigns over the settled window ──
  const own = found.owned.filter((c) => byId.has(c.campaignId))
  const externalOf = new Map(own.map((c) => [byId.get(c.campaignId)!.externalCampaignId, c.campaignId]).filter((e): e is [string, string] => !!e[0]))
  const groupOfExternal = new Map<string, { adGroupId: string; campaignId: string }>()
  for (const t of positives) if (t.adGroup.externalAdGroupId) groupOfExternal.set(t.adGroup.externalAdGroupId, { adGroupId: t.adGroupId, campaignId: t.adGroup.campaignId })
  const stRows = externalOf.size ? await prisma.amazonAdsSearchTerm.groupBy({
    by: ['campaignId', 'adGroupId', 'query'],
    where: { adProduct: 'SPONSORED_PRODUCTS', campaignId: { in: [...externalOf.keys()] }, date: { gte: window.since, lte: window.until } },
    _sum: { clicks: true, orders7d: true, costMicros: true, sales7dCents: true },
  }) : []
  type Acc = { orders: number; clicks: number; spendCents: number; salesCents: number; byGroup: Map<string, number> }
  const terms = new Map<string, Acc>()
  const groupClicks = new Map<string, number>()
  let productOrders = 0
  for (const r of stRows) {
    const key = termKey(r.query)
    if (!key) continue
    const a = terms.get(key) ?? { orders: 0, clicks: 0, spendCents: 0, salesCents: 0, byGroup: new Map() }
    const clicks = r._sum.clicks ?? 0
    const orders = r._sum.orders7d ?? 0
    a.orders += orders; a.clicks += clicks; a.salesCents += r._sum.sales7dCents ?? 0; a.spendCents += Math.round(Number(r._sum.costMicros ?? 0n) / 10_000)
    if (r.adGroupId) { a.byGroup.set(r.adGroupId, (a.byGroup.get(r.adGroupId) ?? 0) + clicks); groupClicks.set(r.adGroupId, (groupClicks.get(r.adGroupId) ?? 0) + clicks) }
    terms.set(key, a)
    productOrders += orders
  }
  // Each term's exact homes in the product's own campaigns, and the campaigns that run one keyword alone.
  const positivesOf = new Map<string, number>()
  for (const t of positives) positivesOf.set(t.adGroup.campaignId, (positivesOf.get(t.adGroup.campaignId) ?? 0) + 1)
  const exactHomes = new Map<string, typeof positives>()
  for (const t of positives) {
    if (t.kind !== 'KEYWORD' || !isExact(t.expressionType)) continue
    const k = termKey(t.expressionValue)
    exactHomes.set(k, [...(exactHomes.get(k) ?? []), t])
  }
  const heroLinks = playbookRow ? await prisma.adsPlaybookLink.findMany({ where: { playbookId: playbookRow.id }, select: { kind: true, key: true, refId: true } }) : []
  const harvestOwn = new Set(harvestStanding.map((h) => h.term))
  const candidateTerms = [...terms.keys()]
  const leads = candidateTerms.length ? await prisma.adsBrainTermLead.findMany({ where: { marketplace: market, term: { in: candidateTerms }, leadProductId: { not: root } }, select: { term: true, leadProductId: true } }) : []
  const leadOf = new Map(leads.map((l) => [l.term, l.leadProductId]))
  const leadNames = leads.length ? new Map((await prisma.product.findMany({ where: { id: { in: [...new Set(leads.map((l) => l.leadProductId))] } }, select: { id: true, name: true, sku: true } })).map((p) => [p.id, p.name?.trim() || p.sku])) : new Map<string, string>()

  // ── the playbook: enrolled or not, its portfolio, the winners view ──
  let playbook: StructureProductFacts['playbook'] = null
  const winners = new Map<string, NonNullable<SkcTermFact['winner']>>()
  if (playbookRow) {
    const { loadProductPlaybook } = await import('../ads-playbook/build-preview.js')
    const { isEnrolled } = await import('../ads-playbook/resolve.js')
    const loaded = await loadProductPlaybook({ market, productId: root })
    const enrolled = !('error' in loaded) && !!loaded.row && isEnrolled(loaded.resolved)
    playbook = { id: playbookRow.id, enrolled, portfolioId: heroLinks.find((l) => l.kind === 'portfolio')?.refId ?? null }
    if (enrolled) {
      const { winnerReview } = await import('../ads-playbook/winners.js')
      const review = await winnerReview({ market, productId: root })
      if ('data' in review) {
        for (const e of review.data.entries) {
          const k = termKey(e.term)
          const was = winners.get(k)
          // A term winning anywhere it runs stays a winner (rule 2); else the entry whose next step is its own campaign.
          if (!was || e.state === 'winning' || (was.state !== 'winning' && e.nextStep === 'ownCampaign')) winners.set(k, { state: e.state, nextStep: e.nextStep, why: e.nextWhy })
        }
      }
    }
  }

  // ── the hour-curve test, only for terms that carry most of an ad group's clicks ──
  const hourCandidates = [...terms].flatMap(([term, a]) => {
    const homes = exactHomes.get(term) ?? []
    const home = homes.find((h) => h.adGroup.externalAdGroupId && (a.byGroup.get(h.adGroup.externalAdGroupId) ?? 0) > 0) ?? homes[0]
    const ext = home?.adGroup.externalAdGroupId
    const total = ext ? groupClicks.get(ext) ?? 0 : 0
    return ext && total > 0 && (a.byGroup.get(ext) ?? 0) / total >= HOUR_CURVE_TERM_SHARE ? [[term, ext] as const] : []
  })
  const hours = hourCandidates.length ? await adGroupHours([...externalOf.keys()], market, now) : null
  const hourTest = (term: string): HourTest => {
    const homes = exactHomes.get(term) ?? []
    if (!homes.length) return { measured: false, why: 'no exact keyword of its own yet' }
    const pick = hourCandidates.find(([t]) => t === term)
    if (!pick) return { measured: false, why: `the Marketing Stream has no keyword grain: its hours show only where it carries ${Math.round(HOUR_CURVE_TERM_SHARE * 100)} % of its ad group's clicks` }
    const ext = pick[1]
    const local = groupOfExternal.get(ext)?.campaignId
    const campaignExt = hours?.campaignOf.get(ext) ?? (local ? byId.get(local)?.externalCampaignId ?? undefined : undefined)
    const days = campaignExt ? hours?.daysOf.get(campaignExt) ?? 0 : 0
    if (days < HOUR_CURVE_MIN_DAYS) return { measured: false, why: `${days} of the last ${HOUR_CURVE_WEEKS * 7} days carry ad-group hours for its campaign (at least ${HOUR_CURVE_MIN_DAYS} needed)` }
    const mine = hours?.cells.get(ext) ?? []
    const rest = [...(hours?.cells ?? new Map<string, HourCell[]>())].filter(([g]) => g !== ext && hours?.campaignOf.get(g) === campaignExt).flatMap(([, c]) => c)
    if (!rest.length) return { measured: false, why: 'its ad group is its campaign\'s only one with traffic: the campaign\'s hours are its own already' }
    const r = hourCurveDistance(mine, rest)
    if (r.termOrders < HOUR_CURVE_MIN_ORDERS) return { measured: false, why: `${r.termOrders} orders in its hours (at least ${HOUR_CURVE_MIN_ORDERS} needed for a curve of its own)` }
    return { measured: true, distancePct: r.distancePct, part: r.part, termOrders: r.termOrders, restOrders: r.restOrders, days }
  }

  const termFacts: SkcTermFact[] = [...terms].map(([term, a]) => {
    const homes = exactHomes.get(term) ?? []
    const home = [...homes].sort((x, y) => (a.byGroup.get(y.adGroup.externalAdGroupId ?? '') ?? 0) - (a.byGroup.get(x.adGroup.externalAdGroupId ?? '') ?? 0) || x.id.localeCompare(y.id))[0]
    const alone = homes.find((h) => positivesOf.get(h.adGroup.campaignId) === 1)
    const hero = heroLinks.find((l) => l.kind === 'slot' && l.key === `hero:${term}`)
    const ownCampaign = alone ? byId.get(alone.adGroup.campaignId)?.name ?? alone.adGroup.campaignId
      : hero ? byId.get(hero.refId)?.name ?? `its playbook hero (${hero.refId})`
        : harvestOwn.has(term) ? 'the harvest\'s own campaign for it (AB-11)' : null
    const lead = leadOf.get(term)
    return {
      term, isAsin: isAsin(term), orders: a.orders, clicks: a.clicks, spendCents: a.spendCents, salesCents: a.salesCents,
      home: home ? { campaignId: home.adGroup.campaignId, campaignName: byId.get(home.adGroup.campaignId)?.name ?? home.adGroup.campaignId, adGroupId: home.adGroupId, targetId: home.id, bidCents: home.bidCents ?? null, campaignPositives: positivesOf.get(home.adGroup.campaignId) ?? 0 } : null,
      ownCampaign, ledBy: lead ? leadNames.get(lead) ?? lead : null,
      hours: ownCampaign || isAsin(term) ? { measured: false, why: ownCampaign ? 'it runs in a campaign of its own already' : 'an ASIN' } : hourTest(term),
      winner: winners.get(term) ?? null,
    }
  })

  // ── shared campaigns: one split each ──
  const shared = await sharedFacts(found.shared.filter((c) => byId.has(c.campaignId)).map((c) => ({ ...c, row: byId.get(c.campaignId)! })), market, window, overrides)

  // ── own campaigns and their portfolios ──
  const ownRows = own.map((c) => byId.get(c.campaignId)!).filter((c) => String(c.status) !== 'ARCHIVED')
  const leftOf = (campaignId: string): string | null => {
    const s = settingsOf(campaignId)
    if (s.excluded.value) return 'the Owner excluded it from the brain'
    const e = s.levers.structure.effective
    return e === 'OFF' || e === 'LOCKED' ? `its structure lever is ${e} (${s.levers.structure.why})` : null
  }
  const portfolioIds = [...new Set([...ownRows.map((c) => c.portfolioId), playbook?.portfolioId ?? null].filter((p): p is string => !!p))]
  const [inPortfolios, portfolioRows] = portfolioIds.length ? await Promise.all([
    prisma.campaign.findMany({ where: { portfolioId: { in: portfolioIds }, status: { not: 'ARCHIVED' } }, select: { id: true, portfolioId: true } }),
    prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: portfolioIds } }, select: { externalPortfolioId: true, name: true } }),
  ]) : [[], []]
  const ownSet = new Set(ownRows.map((c) => c.id))
  const portfolios: PortfolioFact[] = portfolioIds.map((pid) => ({
    portfolioId: pid, name: portfolioRows.find((p) => p.externalPortfolioId === pid)?.name ?? null,
    own: ownRows.filter((c) => c.portfolioId === pid).map((c) => c.id),
    others: inPortfolios.filter((c) => c.portfolioId === pid && !ownSet.has(c.id)).length,
  }))

  // ── what a single-keyword campaign through create-ad-campaign is built from ──
  const skuIds = [...new Set(ownAds.map((a) => a.productId).filter((p): p is string => !!p))]
  const skuRows = skuIds.length ? await prisma.product.findMany({ where: { id: { in: skuIds } }, select: { id: true, sku: true } }) : []
  const skus = [...new Set(ownAds.map((a) => a.sku ?? skuRows.find((p) => p.id === a.productId)?.sku ?? null).filter((s): s is string => !!s))].sort().slice(0, 250)
  const cap = firstBudgetCap(budget?.envelopeCents ?? null, budget?.month ?? null, num('firstBudgetPctOfEnvelope'))
  const killed = await leverKillWhy('structure', root, market)
  const lock = product.levers.portfolioCap.effective === 'LOCKED' ? product.levers.portfolioCap.why : null
  const mine = used.byProduct.get(root) ?? { week: 0, skcs: 0 }

  return {
    productId: root, market, label,
    level: product.levers.structure.effective as LeverEffective, levelWhy: product.levers.structure.why,
    ceiling: structureCeiling(), killed,
    settings: {
      newCampaignsPerWeek: num('newCampaignsPerWeek'), skcMax: num('skcMax'), skcOrderSharePct: num('skcOrderSharePct'), skcHourCurvePct: num('skcHourCurvePct'),
      ownPortfolio: product.values.ownPortfolio.value === true,
    },
    windowDays: SKC_WINDOW_DAYS, productOrders, terms: termFacts, shared,
    own: ownRows.map((c) => ({ campaignId: c.id, name: c.name, portfolioId: c.portfolioId ?? null, left: leftOf(c.id) })),
    portfolios, playbook,
    newCampaign: skus.length ? { skus, dailyBudgetCents: cap.cents, budgetWhy: cap.why, takenNames: new Set(names.filter((c) => strategyMarket(c.marketplace) === market).map((c) => c.name.toLowerCase())) } : null,
    newCampaignRefusal: skus.length ? null : 'its own campaigns advertise no SKU Nexus knows',
    portfolioLock: lock,
    used: { campaignsThisWeek: harvestWeek + mine.week, marketCampaignsThisWeek: harvestMarket + used.market, skcs: harvestStanding.length + mine.skcs },
    records: new Map(records.filter((r) => isStructureStatus(r.status)).map((r) => [r.key, { status: r.status as StructureStatus, changedAt: r.changedAt }])),
  }
}

/** The facts of each shared campaign of a product (a few reads per campaign; a product shares few). */
async function sharedFacts(list: ReadonlyArray<{ campaignId: string; name: string; productIds: string[]; unresolved: string[]; row: { status: unknown; dailyBudget: unknown } }>, market: string, window: { since: Date; until: Date }, overrides: readonly OverrideRow[]): Promise<SharedCampaignFact[]> {
  if (!list.length) return []
  const ids = list.map((c) => c.campaignId)
  const families = [...new Set(list.flatMap((c) => c.productIds))]
  const [ads, targets, members, enrollments, familyOverrides, budgets] = await Promise.all([
    prisma.adProductAd.findMany({ where: { status: { not: 'ARCHIVED' }, adGroup: { campaignId: { in: ids }, status: { not: 'ARCHIVED' } } }, select: { id: true, productId: true, sku: true, asin: true, adGroup: { select: { campaignId: true } } } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: ids }, status: { not: 'ARCHIVED' } }, status: { not: 'ARCHIVED' }, retiredAt: null }, select: { kind: true, isNegative: true, expressionValue: true, adGroup: { select: { campaignId: true } } } }),
    prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: families } }, { parentId: { in: families } }] }, select: { id: true, parentId: true, sku: true, name: true, amazonAsin: true } }),
    prisma.adsBrainEnrollment.findMany({ where: { marketplace: market, productId: { in: families } }, select: { productId: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', marketplace: market, productId: { in: families } }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
    prisma.adsBrainBudgetDecision.findMany({ where: { marketplace: market, productId: { in: families }, envelopeCents: { not: null } }, orderBy: { createdAt: 'desc' }, select: { productId: true, envelopeCents: true, month: true }, take: 100 }),
  ])
  // Each product's spend in the shared campaign: the product-ad report rows of its ads over the window.
  const perf = ads.length ? await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'], where: { entityType: 'PRODUCT_AD', adProduct: 'SPONSORED_PRODUCTS', date: { gte: window.since, lte: window.until }, localEntityId: { in: ads.map((a) => a.id) } }, _sum: { costMicros: true },
  }) : []
  const enrolled = new Set(enrollments.map((e) => e.productId))
  const memberById = new Map(members.map((m) => [m.id, m]))
  const memberBySku = new Map(members.map((m) => [m.sku, m]))
  const memberByAsin = new Map(members.filter((m) => m.amazonAsin).map((m) => [m.amazonAsin!.trim().toUpperCase(), m]))
  const spendOfAd = new Map((perf as Array<{ localEntityId: string | null; _sum: { costMicros: bigint | null } }>).map((r) => [r.localEntityId ?? '', Number(r._sum.costMicros ?? 0n) / 10_000]))
  const familyOfAd = (a: { productId: string | null; sku: string | null; asin: string | null }): string | null => {
    const m = (a.productId ? memberById.get(a.productId) : undefined) ?? (a.sku ? memberBySku.get(a.sku.trim()) : undefined) ?? (a.asin ? memberByAsin.get(a.asin.trim().toUpperCase()) : undefined)
    return m ? rootOf(m) : null
  }
  // The keywords each family's own campaigns already buy, by its ASINs (as the replicate gate reads conflicts).
  const asinsOf = (root: string) => members.filter((m) => rootOf(m) === root && m.amazonAsin?.trim()).map((m) => m.amazonAsin!.trim())
  const bought = new Map<string, Set<string>>()
  for (const root of families) {
    const asins = asinsOf(root)
    if (!asins.length) { bought.set(root, new Set()); continue }
    const rows = await prisma.adTarget.findMany({
      where: { isNegative: false, kind: 'KEYWORD', status: { not: 'ARCHIVED' }, retiredAt: null, adGroup: { campaignId: { notIn: ids }, status: { not: 'ARCHIVED' }, campaign: { status: { not: 'ARCHIVED' } }, productAds: { some: { status: { not: 'ARCHIVED' }, asin: { in: [...new Set([...asins, ...asins.map((a) => a.toLowerCase())])] } } } } },
      select: { expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
    })
    bought.set(root, new Set(rows.filter((r) => strategyMarket(r.adGroup.campaign.marketplace) === market).map((r) => termKey(r.expressionValue)).filter(Boolean)))
  }
  return list.map((c) => {
    const mineAds = ads.filter((a) => a.adGroup.campaignId === c.campaignId)
    const mineTargets = targets.filter((t) => t.adGroup.campaignId === c.campaignId)
    const keywords = [...new Set(mineTargets.filter((t) => !t.isNegative && t.kind === 'KEYWORD').map((t) => termKey(t.expressionValue)).filter(Boolean))].sort()
    const spend = new Map<string, number>()
    for (const a of mineAds) { const f = familyOfAd(a); if (f) spend.set(f, (spend.get(f) ?? 0) + (spendOfAd.get(a.id) ?? 0)) }
    const total = [...spend.values()].reduce((n, v) => n + v, 0)
    const exclusion = overrides.find((o) => !o.endedAt && o.scope === 'CAMPAIGN' && o.campaignId === c.campaignId && o.kind === 'EXCLUDE')
    const products: SplitProductFact[] = c.productIds.map((root) => {
      const rootRow = memberById.get(root)
      const s = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: enrolled.has(root), overrides: familyOverrides })
      const env = budgets.find((b) => b.productId === root)
      const capCents = enrolled.has(root) ? firstBudgetCap(env?.envelopeCents ?? null, env?.month ?? null, Number(s.values.firstBudgetPctOfEnvelope.value)).cents : null
      const skus = [...new Set(mineAds.filter((a) => familyOfAd(a) === root).map((a) => a.sku?.trim() || (a.productId ? memberById.get(a.productId)?.sku : null) || null).filter((x): x is string => !!x))].sort()
      return {
        productId: root, label: rootRow?.name?.trim() || rootRow?.sku || root, skus, enrolled: enrolled.has(root),
        structure: s.levers.structure.effective as LeverEffective, structureWhy: s.levers.structure.why,
        spendShare: total > 0 ? (spend.get(root) ?? 0) / total : null, firstBudgetCapCents: capCents,
        ownBought: keywords.filter((k) => bought.get(root)?.has(k)),
      }
    })
    return {
      campaignId: c.campaignId, name: c.name, status: String(c.row.status), dailyBudgetCents: cents(c.row.dailyBudget), products, unresolved: c.unresolved,
      excluded: exclusion ? `by ${exclusion.by}${exclusion.reason ? `: "${exclusion.reason}"` : ''}` : null,
      keywords,
      counts: {
        keywords: mineTargets.filter((t) => !t.isNegative && t.kind === 'KEYWORD').length, productTargets: mineTargets.filter((t) => !t.isNegative && t.kind === 'PRODUCT').length,
        autoGroups: mineTargets.filter((t) => !t.isNegative && t.kind === 'AUTO').length, negatives: mineTargets.filter((t) => t.isNegative).length,
      },
    }
  })
}
