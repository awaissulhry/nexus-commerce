/**
 * ADS AUTONOMY W1-2 — the reads behind the strategy resolver, in batches: a market's strategy rows (and which of their
 * scopes still exist), the catalog facts of a set of products (parent, the root's categories, each category's
 * ancestry), the products of ad groups and campaigns, and the older settings that also bind (campaign columns, bid
 * policies, budget plans). Every query goes through the business-scoped client: row-level security keeps each read
 * inside the business the call runs in.
 */
import prisma from '../../../db.js'
import { STRATEGY_FIELDS, type StrategyColumn } from './fields.js'
import { indexStrategy, type Catalog, type CatalogProduct, type Orphan, type StrategyIndex, type StrategyRow } from './resolve.js'

const SETTING_COLUMNS = [...new Set(STRATEGY_FIELDS.filter((f) => !f.derivedFrom).flatMap((f) => f.columns))] as StrategyColumn[]

export const STRATEGY_ROW_SELECT = {
  id: true, channel: true, market: true, level: true, scopeId: true, label: true, version: true, updatedAt: true, updatedBy: true,
  ...Object.fromEntries(SETTING_COLUMNS.map((c) => [c, true])),
} as const

/** Every strategy row of one market and channel, market row first, then categories, then products. */
export async function loadStrategyRows(market: string, channel = 'AMAZON'): Promise<StrategyRow[]> {
  const rows = await prisma.adsStrategy.findMany({ where: { channel, market }, select: STRATEGY_ROW_SELECT, orderBy: [{ level: 'asc' }, { label: 'asc' }] })
  return rows as unknown as StrategyRow[]
}

/** The markets that hold at least one strategy row, for a channel. */
export async function strategyMarkets(channel = 'AMAZON'): Promise<string[]> {
  const rows = await prisma.adsStrategy.findMany({ where: { channel }, distinct: ['market'], select: { market: true } })
  return rows.map((r) => r.market).sort()
}

/** The markets the business advertises in on Amazon (its campaigns' markets). */
export async function campaignMarkets(): Promise<string[]> {
  const rows = await prisma.campaign.findMany({ where: { marketplace: { not: null } }, distinct: ['marketplace'], select: { marketplace: true } })
  return rows.map((r) => r.marketplace!).filter(Boolean).sort()
}

/** Which of the rows' categories and products still exist here (a soft-deleted product does not). */
async function liveScopes(rows: readonly StrategyRow[]): Promise<{ categories: Set<string>; products: Set<string> }> {
  const categoryIds = rows.filter((r) => r.level === 'CATEGORY').map((r) => r.scopeId)
  const productIds = rows.filter((r) => r.level === 'PRODUCT').map((r) => r.scopeId)
  const [categories, products] = await Promise.all([
    categoryIds.length ? prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true } }) : Promise.resolve([]),
    productIds.length ? prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } }) : Promise.resolve([]),
  ])
  return { categories: new Set(categories.map((c) => c.id)), products: new Set(products.map((p) => p.id)) }
}

/** One market's strategy, indexed, with the rows whose category or product is gone set apart. */
export async function loadIndex(market: string, channel = 'AMAZON'): Promise<{ index: StrategyIndex; orphans: Orphan[]; rows: StrategyRow[] }> {
  const rows = await loadStrategyRows(market, channel)
  const live = rows.some((r) => r.level !== 'MARKET') ? await liveScopes(rows) : { categories: new Set<string>(), products: new Set<string>() }
  return { ...indexStrategy(market, rows, live, channel), rows }
}

/** A category's name: stored per language ({ en: { name }, it: … }); the English one, else the first given, else its slug. */
export function categoryName(name: unknown, slug: string): string {
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      for (const key of ['label', 'name', 'value', 'text']) {
        const inner = (value as Record<string, unknown>)[key]
        if (typeof inner === 'string' && inner.trim()) return inner.trim()
      }
    }
    return null
  }
  if (typeof name === 'string') return pick(name) ?? slug
  if (name && typeof name === 'object') {
    const byLanguage = name as Record<string, unknown>
    for (const language of ['en', 'it', ...Object.keys(byLanguage)]) {
      const found = pick(byLanguage[language])
      if (found) return found
    }
  }
  return slug
}

/** Each category and its ancestors, deepest first, and every name on the way. */
export async function loadAncestry(categoryIds: readonly string[]): Promise<{ ancestry: Map<string, string[]>; names: Map<string, string> }> {
  const ancestry = new Map<string, string[]>()
  const names = new Map<string, string>()
  if (!categoryIds.length) return { ancestry, names }
  const closure = await prisma.categoryClosure.findMany({
    where: { descendantId: { in: [...new Set(categoryIds)] } },
    orderBy: [{ descendantId: 'asc' }, { depth: 'asc' }],
    select: { descendantId: true, ancestorId: true, ancestor: { select: { name: true, slug: true } } },
  })
  for (const link of closure) {
    ancestry.set(link.descendantId, [...(ancestry.get(link.descendantId) ?? []), link.ancestorId])
    names.set(link.ancestorId, categoryName(link.ancestor.name, link.ancestor.slug))
  }
  // A category without closure rows (none should exist) is still its own chain.
  for (const id of categoryIds) if (!ancestry.has(id)) ancestry.set(id, [id])
  return { ancestry, names }
}

/**
 * The catalog facts for a set of products: each product (deleted ones too: an ad may still name one) and its parent,
 * the ROOT products' categories (primary flags), and each category's ancestry. `missing`: ids not found here.
 */
export async function loadCatalog(productIds: readonly string[]): Promise<{ catalog: Catalog; missing: string[] }> {
  const ids = [...new Set(productIds)]
  const rows = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, parentId: true } }) : []
  const products = new Map<string, CatalogProduct>(rows.map((r) => [r.id, r]))
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((id): id is string => !!id && !products.has(id)))]
  if (parentIds.length) {
    for (const parent of await prisma.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, sku: true, parentId: true } })) products.set(parent.id, parent)
  }
  const roots = [...new Set(rows.map((r) => r.parentId ?? r.id))]
  const links = roots.length ? await prisma.productCategory.findMany({ where: { productId: { in: roots } }, select: { productId: true, categoryId: true, isPrimary: true } }) : []
  const memberships = new Map<string, { primary: string[]; all: string[] }>()
  for (const link of links.sort((a, b) => (a.categoryId < b.categoryId ? -1 : 1))) {
    const member = memberships.get(link.productId) ?? { primary: [], all: [] }
    member.all.push(link.categoryId)
    if (link.isPrimary) member.primary.push(link.categoryId)
    memberships.set(link.productId, member)
  }
  const { ancestry, names } = await loadAncestry(links.map((l) => l.categoryId))
  return { catalog: { products, memberships, ancestry, categoryNames: names }, missing: ids.filter((id) => !products.has(id)) }
}

export interface AdGroupFacts {
  id: string
  name: string
  campaignId: string
  /** The products its ads advertise (known to Nexus), once each. */
  productIds: string[]
  /** Ads whose product Nexus does not know. */
  unknownAds: number
}

/** The named ad groups with their products. */
export async function loadAdGroups(adGroupIds: readonly string[]): Promise<Map<string, AdGroupFacts>> {
  const ids = [...new Set(adGroupIds)]
  const rows = ids.length
    ? await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, campaignId: true, productAds: { select: { productId: true } } } })
    : []
  return new Map(rows.map((g) => [g.id, {
    id: g.id,
    name: g.name,
    campaignId: g.campaignId,
    productIds: [...new Set(g.productAds.map((a) => a.productId).filter((id): id is string => !!id))].sort(),
    unknownAds: g.productAds.filter((a) => !a.productId).length,
  }]))
}

export interface CampaignFacts {
  id: string
  name: string
  marketplace: string | null
  status: string
  portfolioId: string | null
  minBidCents: number | null
  maxBidCents: number | null
  dynamicBidding: unknown
  adGroups: AdGroupFacts[]
}

/** The named campaigns with their bid columns, guards and ad groups (each with its products). */
export async function loadCampaigns(campaignIds: readonly string[]): Promise<Map<string, CampaignFacts>> {
  const ids = [...new Set(campaignIds)]
  if (!ids.length) return new Map()
  const rows = await prisma.campaign.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, name: true, marketplace: true, status: true, portfolioId: true, minBidCents: true, maxBidCents: true, dynamicBidding: true,
      adGroups: { select: { id: true }, orderBy: { id: 'asc' } },
    },
  })
  const groups = await loadAdGroups(rows.flatMap((c) => c.adGroups.map((g) => g.id)))
  return new Map(rows.map((c) => [c.id, {
    id: c.id, name: c.name, marketplace: c.marketplace, status: String(c.status), portfolioId: c.portfolioId,
    minBidCents: c.minBidCents, maxBidCents: c.maxBidCents, dynamicBidding: c.dynamicBidding,
    adGroups: c.adGroups.map((g) => groups.get(g.id)!).filter(Boolean),
  }]))
}

/** A product by its Nexus id or its SKU, if it exists here and is not deleted. */
export async function findLiveProduct(ref: { productId?: string; sku?: string }): Promise<{ id: string; sku: string; parentId: string | null } | null> {
  const where = ref.productId ? { id: ref.productId, deletedAt: null } : { sku: ref.sku, deletedAt: null }
  return prisma.product.findFirst({ where, select: { id: true, sku: true, parentId: true } })
}

export async function findCategory(categoryId: string): Promise<{ id: string; name: string } | null> {
  const row = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true, name: true, slug: true } })
  return row ? { id: row.id, name: categoryName(row.name, row.slug) } : null
}

/** The products a category covers: those filed under it or under any category below it, with their variations. */
export async function productsUnderCategory(categoryId: string): Promise<string[]> {
  const below = await prisma.categoryClosure.findMany({ where: { ancestorId: categoryId }, select: { descendantId: true } })
  const roots = await prisma.productCategory.findMany({ where: { categoryId: { in: below.map((b) => b.descendantId) } }, select: { productId: true } })
  const rootIds = [...new Set(roots.map((r) => r.productId))]
  if (!rootIds.length) return []
  const variations = await prisma.product.findMany({ where: { parentId: { in: rootIds } }, select: { id: true } })
  return [...new Set([...rootIds, ...variations.map((v) => v.id)])]
}

/** A product and its variations (a parent's strategy covers them). */
export async function productFamily(productId: string): Promise<string[]> {
  const variations = await prisma.product.findMany({ where: { parentId: productId }, select: { id: true } })
  return [productId, ...variations.map((v) => v.id)]
}

/**
 * The market's campaigns (archived left out) that advertise any of these products — every campaign of the market
 * when `productIds` is absent — with their own target ACoS as stored (`dynamicBidding.targetAcos`, a fraction).
 */
export async function marketCampaignTargets(market: string, productIds?: readonly string[]): Promise<Array<{ id: string; name: string; targetAcos: unknown }>> {
  if (productIds && !productIds.length) return []
  const rows = await prisma.campaign.findMany({
    where: {
      marketplace: market,
      status: { not: 'ARCHIVED' },
      ...(productIds ? { adGroups: { some: { productAds: { some: { productId: { in: [...productIds] } } } } } } : {}),
    },
    select: { id: true, name: true, dynamicBidding: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return rows.map((c) => ({ id: c.id, name: c.name, targetAcos: (c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos }))
}

/** Enabled bid policies at the market grain and at the given lines (a line is a parent product). */
export async function bidPolicies(market: string, lineIds: readonly string[]) {
  return prisma.adBidPolicy.findMany({
    where: { enabled: true, OR: [{ grain: 'MARKET', scopeId: market }, ...(lineIds.length ? [{ grain: 'LINE', scopeId: { in: [...lineIds] } }] : [])] },
    select: { grain: true, scopeId: true, label: true, minBidCents: true, maxBidCents: true },
    orderBy: [{ grain: 'asc' }, { scopeId: 'asc' }],
  })
}

/** The harvest policies at the market grain and at the given lines (graduation thresholds). */
export async function harvestPolicies(market: string, lineIds: readonly string[]) {
  return prisma.adsHarvestPolicy.findMany({
    where: { kind: 'graduate', OR: [{ scopeGrain: 'market', scopeId: market }, ...(lineIds.length ? [{ scopeGrain: 'line', scopeId: { in: [...lineIds] } }] : [])] },
    select: { scopeGrain: true, scopeId: true, minOrders: true, minClicks: true, maxAcosPct: true, windowDays: true, updatedBy: true },
    orderBy: [{ scopeGrain: 'asc' }, { scopeId: 'asc' }],
  })
}

/** This month's market-level budget plan ("YYYY-MM", no sub-tag), if one is set. */
export async function marketBudgetPlan(market: string, month: string) {
  return prisma.adBudgetPlan.findFirst({
    where: { marketplace: market, month, tag: null },
    select: { month: true, monthlyBudgetCents: true, stopOverSpend: true, autoPacing: true },
  })
}

/** Strategy versions of a market, newest first (one scope's, when `scope` is given). */
export async function strategyVersions(market: string, channel: string, scope: { level: string; scopeId: string } | null, limit: number) {
  return prisma.adsStrategyVersion.findMany({
    where: { channel, market, ...(scope ? { level: scope.level, scopeId: scope.scopeId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
    take: limit,
    select: {
      id: true, strategyId: true, level: true, scopeId: true, version: true, op: true, values: true, changes: true, direction: true,
      via: true, approvalId: true, actor: true, actorUserId: true, stepUpAt: true, reason: true, createdAt: true,
    },
  })
}
