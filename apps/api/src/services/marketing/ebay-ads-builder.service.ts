/**
 * ER2 — builder service: the template registry (former GOAL_DEFS) + the
 * composable plan builders the wizard steps call individually (SPEC §6.1):
 * listing plans (economics + conflicts + trailing sales), keyword-seed
 * mining, and the local budget suggestion. Extracted from the prefill route
 * so /builder/listings, /builder/seeds and /builder/budget-suggest share ONE
 * implementation with the legacy /builder/prefill.
 */
import prisma from '../../db.js'
import { getLiveEbayItemIds } from './ebay-listing-index.service.js'

export interface BuilderTemplate {
  key: string; label: string; strategy: 'CPS' | 'CPC'
  goalFactor: number; fallbackRatePct: number; endDays: number | null; rulePacks: string[]
}

export const BUILDER_TEMPLATES: Record<string, BuilderTemplate> = {
  catch_all: { key: 'catch_all', label: 'Protect margin — promote everything', strategy: 'CPS', goalFactor: 0.7, fallbackRatePct: 5, endDays: null, rulePacks: ['Fee % creep-down (CPS)', 'Click bleeder — remove ad (CPS)', 'Rate above break-even — repair (CPS)', 'Restock re-promote (CPS)'] },
  hero: { key: 'hero', label: 'Push hero products', strategy: 'CPC', goalFactor: 1.0, fallbackRatePct: 0, endDays: null, rulePacks: ['Keyword bleeder — pause (CPC)', 'Keyword bid-down on thin CTR (CPC)'] },
  clearance: { key: 'clearance', label: 'Clear stock', strategy: 'CPS', goalFactor: 1.0, fallbackRatePct: 12, endDays: 30, rulePacks: ['Click bleeder — remove ad (CPS)'] },
  defend: { key: 'defend', label: 'Defend visibility', strategy: 'CPC', goalFactor: 1.0, fallbackRatePct: 0, endDays: null, rulePacks: ['Keyword bleeder — pause (CPC)'] },
}

const SHORT_BY_MKT: Record<string, string> = { EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES', EBAY_GB: 'UK' }
export const shortMkt = (m: string): string => SHORT_BY_MKT[m] ?? 'IT'

export interface PlanListing {
  itemId: string; title: string | null; priceCents: number | null; quantity: number | null
  // EV2 — picker thumbnails + family grouping (eBay gallery image, catalog MAIN fallback)
  imageUrl: string | null; productId: string | null; productName: string | null
  breakEvenPct: number | null; economicsStatus: string | null
  computedRatePct: number | null; rateSource: string
  trailingSales30dCents: number; forecastMonthlyFeeCents: number | null
  conflict: { campaignId: string; campaignName: string; currentRatePct: number | null } | null
}

/** The per-listing plan rows every CPS wizard step consumes: break-even ×
 *  factor rates, one-listing-one-General conflicts, trailing-30d sales. */
export async function buildListingPlan(opts: {
  marketplace: string
  listingIds?: string[]
  productIds?: string[]
  strategy: 'CPS' | 'CPC'
  goalFactor?: number
  fallbackRatePct?: number
}): Promise<{ listings: PlanListing[]; totals: { listings: number; conflicts: number; missingCost: number; forecastMonthlyFeeCents: number; trailingSales30dCents: number }; activeCampaigns: number }> {
  const short = shortMkt(opts.marketplace)
  const goalFactor = opts.goalFactor ?? 0.7
  const fallbackRatePct = opts.fallbackRatePct ?? 5
  const ids = new Set<string>(opts.listingIds ?? [])
  for (const pid of opts.productIds ?? []) {
    for (const hit of await getLiveEbayItemIds(pid, short)) ids.add(hit.itemId)
  }
  const live = await prisma.ebayListingIndex.findMany({
    where: { marketplace: short, endedAt: null, ...(ids.size ? { itemId: { in: [...ids] } } : {}) },
    select: { itemId: true, title: true, price: true, quantity: true, imageUrl: true, productIds: true },
  })
  const itemIds = live.map((l) => l.itemId)
  const [eco, conflicts, facts30] = await Promise.all([
    prisma.ebayListingEconomics.findMany({ where: { marketplace: short, itemId: { in: itemIds.length ? itemIds : ['−'] } }, select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }),
    prisma.ebayAd.findMany({
      where: { listingId: { in: itemIds.length ? itemIds : ['−'] }, status: { notIn: ['STALE'] }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: ['RUNNING', 'PAUSED'] } } },
      select: { listingId: true, bidPercentage: true, campaign: { select: { id: true, name: true } } },
    }),
    prisma.ebayAdsDailyPerformance.groupBy({
      by: ['entityId'],
      where: { entityType: 'LISTING', entityId: { in: itemIds.length ? itemIds : ['−'] }, date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _sum: { salesCents: true, adFeesCents: true },
    }),
  ])
  const ecoBy = new Map(eco.map((e) => [e.itemId, e]))
  const conflictBy = new Map(conflicts.map((c) => [c.listingId!, c]))
  const salesBy = new Map(facts30.map((f) => [f.entityId, f._sum.salesCents ?? 0]))
  // EV2 — catalog fallback images + product names for family grouping
  const pids = [...new Set(live.flatMap((l) => l.productIds))]
  const [prods, mains] = pids.length
    ? await Promise.all([
        prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, sku: true } }),
        prisma.productImage.findMany({ where: { productId: { in: pids }, type: 'MAIN' }, orderBy: { sortOrder: 'asc' }, select: { productId: true, url: true } }),
      ])
    : [[], []]
  const prodBy = new Map(prods.map((x) => [x.id, x]))
  const mainBy = new Map<string, string>()
  for (const m of mains) if (!mainBy.has(m.productId)) mainBy.set(m.productId, m.url)

  const listings: PlanListing[] = live.map((l) => {
    const e = ecoBy.get(l.itemId)
    const be = e?.breakEvenAdRatePct != null ? Number(e.breakEvenAdRatePct.toString()) : null
    const computedRatePct = opts.strategy === 'CPS'
      ? be != null ? Math.min(100, Math.max(2, Math.round(be * goalFactor * 10) / 10)) : fallbackRatePct
      : null
    const trailingSales = salesBy.get(l.itemId) ?? 0
    const conflict = conflictBy.get(l.itemId)
    const pid = l.productIds[0] ?? null
    return {
      itemId: l.itemId,
      title: l.title,
      priceCents: l.price != null ? Math.round(Number(l.price.toString()) * 100) : null,
      quantity: l.quantity,
      imageUrl: l.imageUrl ?? (pid ? mainBy.get(pid) ?? null : null),
      productId: pid,
      productName: pid ? prodBy.get(pid)?.name ?? prodBy.get(pid)?.sku ?? null : null,
      breakEvenPct: be,
      economicsStatus: e?.dataStatus ?? null,
      computedRatePct,
      rateSource: be != null ? `break-even ${be}% × ${goalFactor}` : 'default (no cost data)',
      trailingSales30dCents: trailingSales,
      forecastMonthlyFeeCents: opts.strategy === 'CPS' && computedRatePct != null ? Math.round(trailingSales * (computedRatePct / 100)) : null,
      conflict: conflict ? { campaignId: conflict.campaign.id, campaignName: conflict.campaign.name, currentRatePct: conflict.bidPercentage != null ? Number(conflict.bidPercentage.toString()) : null } : null,
    }
  })
  return {
    listings,
    totals: {
      listings: listings.length,
      conflicts: listings.filter((l) => l.conflict).length,
      missingCost: listings.filter((l) => l.breakEvenPct == null).length,
      forecastMonthlyFeeCents: listings.reduce((a, l) => a + (l.forecastMonthlyFeeCents ?? 0), 0),
      trailingSales30dCents: listings.reduce((a, l) => a + l.trailingSales30dCents, 0),
    },
    activeCampaigns: await prisma.ebayCampaign.count({ where: { marketplace: opts.marketplace, status: 'RUNNING', NOT: { externalCampaignId: { startsWith: 'sandbox-' } } } }),
  }
}

const SEED_STOP = new Set(['con', 'per', 'the', 'and', 'del', 'della', 'di', 'da', 'in', 'su', 'e', 'a', 'il', 'la', 'le', 'un', 'una', 'protezione', 'livello'])

/** Keyword seeds mined from OUR data — title bigrams + Marca×Tipo aspects
 *  (eBay suggestKeywords needs an ad group, which doesn't exist pre-launch). */
export async function mineKeywordSeeds(marketplace: string, itemIds: string[]): Promise<Array<{ text: string; source: string; matchType: string; bidCents: number }>> {
  const short = shortMkt(marketplace)
  const idx = await prisma.ebayListingIndex.findMany({
    where: { marketplace: short, ...(itemIds.length ? { itemId: { in: itemIds } } : { endedAt: null }) },
    select: { title: true, aspects: true },
  })
  const counts = new Map<string, number>()
  for (const l of idx) {
    const words = (l.title ?? '').toLowerCase().replace(/[^a-zà-ù0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !SEED_STOP.has(w))
    for (let i = 0; i < words.length - 1; i++) {
      const bi = `${words[i]} ${words[i + 1]}`
      counts.set(bi, (counts.get(bi) ?? 0) + 1)
    }
    const a = (l.aspects ?? {}) as Record<string, string[]>
    const brand = (a['Marca'] ?? a['Brand'] ?? [])[0]
    const tipo = (a['Tipo'] ?? a['Type'] ?? [])[0]
    if (brand && tipo) counts.set(`${brand} ${tipo}`.toLowerCase(), (counts.get(`${brand} ${tipo}`.toLowerCase()) ?? 0) + 3)
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 20)
    .map(([text, n]) => ({ text, source: n >= 3 ? 'ASPECT/FREQUENT' : 'TITLE', matchType: 'PHRASE', bidCents: 30 }))
}

/** Our budget suggestion (trailing-sales formula, provenance stated). */
export async function suggestBudgetLocal(marketplace: string, itemIds: string[]): Promise<{ suggestedCents: number; formula: string }> {
  const short = shortMkt(marketplace)
  const facts = await prisma.ebayAdsDailyPerformance.groupBy({
    by: ['marketplace'],
    where: { entityType: 'LISTING', marketplace, date: { gte: new Date(Date.now() - 30 * 86_400_000) }, ...(itemIds.length ? { entityId: { in: itemIds } } : {}) },
    _sum: { salesCents: true },
  }).catch(() => [] as Array<{ _sum: { salesCents: number | null } }>)
  void short
  let trailingSales = 0
  for (const f of facts as Array<{ _sum: { salesCents: number | null } }>) trailingSales += f._sum.salesCents ?? 0
  const suggested = Math.max(500, Math.round((trailingSales * 0.05) / 30))
  return { suggestedCents: suggested, formula: `max(€5, trailing-30d sales ${(trailingSales / 100).toFixed(0)}€ × 5% ÷ 30 days) — efficiency rules unlock at ≥30 attributed conversions` }
}

/** Name grammar assist (never forced — the input stays free). */
export async function suggestName(template: string | null, strategy: 'CPS' | 'CPC', marketplace: string, scoped: boolean): Promise<string> {
  const seq = (await prisma.ebayCampaign.count({ where: { marketplace } })) + 1
  return `${template ?? (strategy === 'CPS' ? 'general' : 'priority')}-${strategy.toLowerCase()}-${scoped ? 'selected' : 'all'}-${shortMkt(marketplace)}-${String(seq).padStart(3, '0')}`
}
