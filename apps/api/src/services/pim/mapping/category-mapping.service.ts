import { categorySchemaMarkets } from '../../categories/category-schema-coordinate.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * PES.6.4 — category mapping: our taxonomy ↔ the channel's.
 *
 * The hole this closes. Before PES.6 the rule-set axis was `Product.productType` — a free-text
 * string typed onto each product — read straight into `getResolvedRules(channel, code,
 * product.productType)`. So "which channel category is this product in, and therefore which
 * field rules apply?" was answered per product, by hand, with no taxonomy behind it and nothing
 * to review. Rithum answers it once per category per channel × market and lets every product in
 * that category inherit.
 *
 * Resolution order for one product (highest → lowest):
 *   0. Amazon only — the product type the product's own Amazon listings carry in the OTHER markets of this
 *      market's region, when they all agree (`source: 'listingOtherMarket'`; see `amazonRegionSiblings`). A listing
 *      in THIS market beats all of it, in `categoryForListing`.
 *   1. its PRIMARY category's mapping for (channel, exact market)
 *   2. its primary category's mapping for (channel, '*') — never for eBay (`categoryMappingMarkets`)
 *   3. the nearest MAPPED ancestor of that category, same two steps — a mapping on
 *      `Clothing > Outerwear` covers `Clothing > Outerwear > Coats` without re-declaring it,
 *      which is the whole reason we keep a closure table
 *   4. any other category the product belongs to, by the same rules
 *   5. `Product.productType` for Amazon only — the legacy answer, kept so nothing that works today stops
 *      working, and REPORTED as `source: 'productType'` so the UI never implies a mapping
 *      exists when one does not. A variation with none of its own takes its parent's (`fromParent`), as
 *      steps 0–4 already do: Amazon keeps one product type per family
 *
 * Ancestor inheritance uses `CategoryClosure` (already maintained), so step 3 is one indexed
 * query, not a recursive walk.
 */

import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { getMappingForMarketplace } from '../schema-mapping.service.js'
import { MARKET_CATALOGUE } from '../market-catalogue.js'

/**
 * The marketplaces whose category mappings apply to one market: the market itself and the all-market `'*'` row —
 * except on eBay. eBay keeps one category tree per site, so a leaf id names a different category (or none) on
 * another site: 177104 is motorcycle jackets in IT, FR and ES and does not exist in DE or UK, where 177117 is, while
 * FR's 177117 is motocross. An eBay mapping always names its site.
 */
export function categoryMappingMarkets(channel: string, marketplace: string): string[] {
  return channel.toUpperCase() === 'EBAY' ? [marketplace] : [marketplace, '*']
}

/** An all-market `'*'` mapping cannot exist on eBay (see `categoryMappingMarkets`). */
export function assertCategoryMappingMarket(channel: string, marketplace: string): void {
  if (channel.toUpperCase() === 'EBAY' && (!marketplace || marketplace === '*')) {
    throw new Error('An eBay category is chosen per eBay site. Choose the site (for example IT or DE), not all markets.')
  }
}

export type CategoryResolutionSource =
  | 'categoryExact'    // mapped on this category, this market
  | 'categoryWildcard' // mapped on this category, marketplace '*'
  | 'ancestorExact'
  | 'ancestorWildcard'
  | 'productType'      // legacy Product.productType
  | 'listing'          // the category/product type assigned to this channel listing
  | 'listingOtherMarket' // Amazon: the product's own listings in the other markets of this region, all agreeing
  | 'none'

export interface ResolvedCategory {
  /** The channel's category id — for Amazon this IS the productType that selects the
   *  `byProductType` overlay, which is what makes this the bridge to the existing rules. */
  channelCategoryId: string | null
  channelCategoryPath: string | null
  browseNodeId: string | null
  source: CategoryResolutionSource
  /** Our category the mapping was found on (null when it came from productType). */
  categoryId: string | null
  categoryName: string | null
  /** True when a human has confirmed the mapping; false for an unreviewed AI/import guess. */
  reviewed: boolean
  /** Equal-priority shared category memberships need an explicit primary/category override. */
  conflicts?: string[]
  /** `listingOtherMarket` only: the markets whose listings carry the type, e.g. `['DE', 'IT']`. */
  fromMarkets?: string[]
  /**
   * The product's Amazon listings in the region's other markets DISAGREE (`['DE → OUTERWEAR', 'IT → COAT']`), so
   * that tier chose nothing and the result below it stands. Not `conflicts`: that one blocks every cell
   * (`resolve-batch`), while this is a fact to show beside a category that still resolved.
   */
  otherMarketConflicts?: string[]
  /** `productType` only: the variation has no product type of its own, so this is its parent's. */
  fromParent?: boolean
}

const EMPTY: ResolvedCategory = {
  channelCategoryId: null,
  channelCategoryPath: null,
  browseNodeId: null,
  source: 'none',
  categoryId: null,
  categoryName: null,
  reviewed: false,
}

/**
 * The ONE map from a channel to the field that holds its category — on a listing (`platformAttributes`), in the
 * channel spec, and on the sheet. The resolver (`resolve-batch.service.ts`) and the studio sheet (category fill and
 * missing-schema issue) read it too (found by the variation-theme lane, 2026-09-26: before, they knew only Amazon and
 * eBay, so Etsy's and Shopify's mapped category resolved empty, and Shopify's category landed in its free-text
 * "Product type").
 */
export const CHANNEL_CATEGORY_FIELD: Readonly<Record<string, string>> = { AMAZON: 'productType', EBAY: 'categoryId', SHOPIFY: 'category', ETSY: 'taxonomy_id' }
export function channelCategoryField(channel: string | null | undefined): string | null {
  return channel ? CHANNEL_CATEGORY_FIELD[channel.toUpperCase()] ?? null : null
}

/**
 * The mapped category as the value of the channel's category field. A category id is held as text; a NUMBER field
 * (Etsy's `taxonomy_id`, an integer in Etsy's schema) gets it as a number when it is all digits. Anything else is
 * returned unchanged, so validation still names a bad id.
 */
export function categoryFieldValue(kind: string | null | undefined, categoryId: string | null | undefined): string | number | null | undefined {
  return kind === 'number' && typeof categoryId === 'string' && /^\d+$/.test(categoryId) ? Number(categoryId) : categoryId
}

/** Existing listings can pin their own category. Amazon product types are never eBay category ids. */
export function categoryForListing(
  category: ResolvedCategory | undefined,
  channel: string,
  platformAttributes: unknown,
): ResolvedCategory {
  const ch = channel.toUpperCase()
  const attrs = platformAttributes && typeof platformAttributes === 'object'
    ? platformAttributes as Record<string, unknown> : {}
  const field = channelCategoryField(ch)
  const raw = field ? attrs[field] : null
  // Store drafts support an explicit empty category, distinct from removing the override.
  if (raw === null && (ch === 'SHOPIFY' || ch === 'ETSY')) return { ...EMPTY }
  const id = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
  if (id) return { ...EMPTY, channelCategoryId: ch === 'AMAZON' ? id.toUpperCase() : id, source: 'listing' }
  if (ch !== 'AMAZON' && category?.source === 'productType') return { ...EMPTY }
  return category ?? { ...EMPTY }
}

/**
 * Where a resolved category came from, in the operator's words. The sheet shows it beside the product type, so a type
 * taken from another market's listing, or the product's own legacy value, never reads as a mapping.
 */
export function categorySourceLabel(category: ResolvedCategory): string {
  const on = category.categoryName ?? 'its category'
  const markets = category.fromMarkets ?? []
  const base = ((): string => {
    switch (category.source) {
      case 'listing': return 'From this listing'
      case 'listingOtherMarket': return `From this product's Amazon ${markets.length > 1 ? 'listings' : 'listing'} in ${markets.join(', ')}`
      case 'categoryExact': return `Mapped on ${on} for this market`
      case 'categoryWildcard': return `Mapped on ${on} for every market`
      case 'ancestorExact': return `Inherited from the mapping on ${on} for this market`
      case 'ancestorWildcard': return `Inherited from the mapping on ${on} for every market`
      case 'productType': return category.fromParent
        ? "The parent product's product type (this variation has none of its own; no mapping for this market)"
        : "The product's own product type (no mapping for this market)"
      case 'none': return category.conflicts?.length ? 'Conflicting shared categories. Choose a primary category.' : 'No category'
      // A new source fails the type check here until it has words of its own.
      default: { const unlabelled: never = category.source; return String(unlabelled) }
    }
  })()
  return category.otherMarketConflicts?.length
    ? `${base}. Its Amazon listings in other markets disagree: ${category.otherMarketConflicts.join(', ')}`
    : base
}

/** `{ "en": { "name": "Coats" } }` or `{ "en": "Coats" }` — both shapes exist in the wild. */
export function categoryName(nameJson: unknown, locale = 'en'): string | null {
  if (!nameJson || typeof nameJson !== 'object') return null
  const byLocale = nameJson as Record<string, unknown>
  for (const key of [locale, 'en', ...Object.keys(byLocale)]) {
    const v = byLocale[key]
    if (typeof v === 'string' && v.trim()) return v
    if (v && typeof v === 'object') {
      const n = (v as Record<string, unknown>).name
      if (typeof n === 'string' && n.trim()) return n
    }
  }
  return null
}

export interface MappingRow {
  categoryId: string
  marketplace: string
  channelCategoryId: string
  channelCategoryPath: string | null
  browseNodeId: string | null
  reviewedAt: Date | string | null
}

function pick(
  rows: MappingRow[],
  categoryId: string,
  marketplace: string,
  ancestor: boolean,
): ResolvedCategory | null {
  const exact = rows.find((r) => r.categoryId === categoryId && r.marketplace === marketplace)
  const wild = rows.find((r) => r.categoryId === categoryId && r.marketplace === '*')
  const hit = exact ?? wild
  if (!hit) return null
  return {
    channelCategoryId: hit.channelCategoryId,
    channelCategoryPath: hit.channelCategoryPath,
    browseNodeId: hit.browseNodeId,
    source: exact
      ? ancestor
        ? 'ancestorExact'
        : 'categoryExact'
      : ancestor
        ? 'ancestorWildcard'
        : 'categoryWildcard',
    categoryId: hit.categoryId,
    categoryName: null,
    reviewed: hit.reviewedAt != null,
  }
}

/**
 * The other Amazon markets of this market's region, from `MARKET_CATALOGUE` (so UK and TR count as EU because the
 * catalogue says so). A market the catalogue does not know has no region and so no siblings: nothing is guessed.
 *
 * Why a sibling listing outranks a mapping (P2, the Owner's D2 = A, 2026-09-27): an ASIN normally carries one product
 * type across a region, and the listing IS Amazon's answer for this product, while a mapping is a default for a whole
 * category. Measured before: GALE-JACKET was COAT in its four listed markets and OUTERWEAR (its own `productType`) in
 * the seven unlisted ones, so one jacket showed COAT's rules in DE and OUTERWEAR's in BE (249 vs 163 columns).
 */
export function amazonRegionSiblings(marketplace: string): string[] {
  const code = marketplace.trim().toUpperCase()
  const own = MARKET_CATALOGUE.find(m => m.channel === 'AMAZON' && m.code === code)
  return own ? MARKET_CATALOGUE.filter(m => m.channel === 'AMAZON' && m.region === own.region && m.code !== code).map(m => m.code) : []
}

/** productId → product type → the sibling markets whose listings carry it. One query for the whole set. */
async function amazonTypesInSiblingMarkets(productIds: string[], marketplace: string, channelConnectionId: string | null | undefined) {
  const markets = amazonRegionSiblings(marketplace)
  const out = new Map<string, Map<string, Set<string>>>()
  if (!markets.length || !productIds.length) return out
  // Raw on purpose: `platformAttributes` averages ~12 KB per Amazon listing (a local database, 2026-09-27) and this reads up
  // to ten markets per product, so the model API would pull megabytes per sheet load for one key. The workspace adapter
  // scopes raw SQL exactly as it scopes model queries. `undefined` = the caller reads every account's listings.
  const rows = await prisma.$queryRaw<Array<{ productId: string; marketplace: string; productType: string }>>(Prisma.sql`
    SELECT DISTINCT "productId", marketplace, upper(btrim("platformAttributes"->>'productType')) AS "productType"
    FROM "ChannelListing"
    WHERE "productId" IN (${Prisma.join(productIds)}) AND channel = 'AMAZON' AND marketplace IN (${Prisma.join(markets)})
      AND jsonb_typeof("platformAttributes"->'productType') = 'string' AND btrim("platformAttributes"->>'productType') <> ''
      ${channelConnectionId === undefined ? Prisma.empty : Prisma.sql`AND "channelConnectionId" IS NOT DISTINCT FROM ${channelConnectionId}`}`)
  for (const row of rows) {
    const types = out.get(row.productId) ?? new Map<string, Set<string>>()
    types.set(row.productType, (types.get(row.productType) ?? new Set()).add(row.marketplace))
    out.set(row.productId, types)
  }
  return out
}

/**
 * Resolve the effective channel category for MANY products in one pass — the sheet and the
 * batch resolver both need it per row, so a per-product query would be N+1 by construction.
 *
 * `channelConnectionId` scopes the Amazon sibling-market listings to the account the caller reads its own listings
 * with (the sheet, the batch resolver); omitted, every account's listings count.
 */
export async function resolveCategoriesForProducts(input: {
  productIds: string[]
  channel: string
  marketplace: string
  mappingSnapshot?: MappingRow[]
  channelConnectionId?: string | null
}): Promise<Record<string, ResolvedCategory>> {
  const { channel, marketplace } = input
  const productIds = [...new Set(input.productIds)].filter(Boolean)
  const out: Record<string, ResolvedCategory> = {}
  if (productIds.length === 0) return out

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } }, select: { id: true, parentId: true, productType: true },
  })
  const membershipIds = [...new Set([...productIds, ...products.map(p => p.parentId).filter((id): id is string => !!id)])]
  const amazon = channel.toUpperCase() === 'AMAZON'
  // Step 5's parent fallback needs the type of a parent that was not asked for (a bulk save names only the edited rows).
  const typeOf = new Map(products.map(p => [p.id, p.productType]))
  const typelessParentIds = amazon ? [...new Set(products.filter(p => !p.productType && p.parentId && !typeOf.has(p.parentId)).map(p => p.parentId!))] : []
  const [memberships, mappings, siblingTypes, typelessParents] = await Promise.all([
    prisma.productCategory.findMany({
      where: { productId: { in: membershipIds } },
      select: { productId: true, categoryId: true, isPrimary: true },
    }),
    input.mappingSnapshot ? Promise.resolve(input.mappingSnapshot.filter(m => categoryMappingMarkets(channel, marketplace).includes(m.marketplace))) : prisma.categoryChannelMapping.findMany({
      where: { channel: channel.toUpperCase(), marketplace: { in: categoryMappingMarkets(channel, marketplace) } },
      select: {
        categoryId: true,
        marketplace: true,
        channelCategoryId: true,
        channelCategoryPath: true,
        browseNodeId: true,
        reviewedAt: true,
      },
    }),
    amazon ? amazonTypesInSiblingMarkets(membershipIds, marketplace, input.channelConnectionId) : Promise.resolve(new Map<string, Map<string, Set<string>>>()),
    typelessParentIds.length ? prisma.product.findMany({ where: { id: { in: typelessParentIds } }, select: { id: true, productType: true } }) : Promise.resolve([]),
  ])
  for (const parent of typelessParents) typeOf.set(parent.id, parent.productType)

  const mappedCategoryIds = new Set(mappings.map((m) => m.categoryId))
  const productCategoryIds = [...new Set(memberships.map((m) => m.categoryId))]

  // Ancestors of every category the products sit in, nearest first (depth ascending).
  const closure =
    productCategoryIds.length > 0 && mappedCategoryIds.size > 0
      ? await prisma.categoryClosure.findMany({
          where: {
            descendantId: { in: productCategoryIds },
            ancestorId: { in: [...mappedCategoryIds] },
            depth: { gt: 0 },
          },
          select: { ancestorId: true, descendantId: true, depth: true },
          orderBy: { depth: 'asc' },
        })
      : []
  const ancestorsOf = new Map<string, string[]>()
  for (const c of closure) {
    const list = ancestorsOf.get(c.descendantId) ?? []
    list.push(c.ancestorId)
    ancestorsOf.set(c.descendantId, list)
  }

  const byProduct = new Map<string, Array<{ categoryId: string; isPrimary: boolean }>>()
  for (const m of memberships) {
    const list = byProduct.get(m.productId) ?? []
    list.push({ categoryId: m.categoryId, isPrimary: m.isPrimary })
    byProduct.set(m.productId, list)
  }

  // Names for whatever we end up citing.
  const nameRows = await prisma.category.findMany({
    where: { id: { in: [...mappedCategoryIds] } },
    select: { id: true, name: true },
  })
  const names = new Map(nameRows.map((r) => [r.id, categoryName(r.name)]))

  const disagreements = new Map<string, string[]>()
  for (const p of products) {
    // Tier 0 (Amazon): the variant's own sibling listings, else its parent's, like category memberships below.
    const sibling = siblingTypes.get(p.id) ?? siblingTypes.get(p.parentId ?? '')
    if (sibling?.size === 1) {
      const [[type, markets]] = [...sibling]
      out[p.id] = { ...EMPTY, channelCategoryId: type, source: 'listingOtherMarket', fromMarkets: [...markets].sort() }
      continue
    }
    // Disagreeing listings are never settled by a guess: fall through, and say so on whatever resolves below.
    if (sibling && sibling.size > 1) {
      disagreements.set(p.id, [...sibling].flatMap(([type, markets]) => [...markets].map(m => `${m} → ${type}`)).sort())
    }
    const cats = (byProduct.get(p.id) ?? byProduct.get(p.parentId ?? '') ?? []).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.categoryId.localeCompare(b.categoryId))
    let resolved: ResolvedCategory | null = null
    const candidates: Array<{ primary: boolean; value: ResolvedCategory }> = []
    for (const c of cats) {
      let value = pick(mappings, c.categoryId, marketplace, false)
      if (!value) for (const anc of ancestorsOf.get(c.categoryId) ?? []) {
        value = pick(mappings, anc, marketplace, true)
        if (value) break
      }
      if (value) candidates.push({ primary: c.isPrimary, value })
    }
    const tier = candidates.some(c => c.primary) ? candidates.filter(c => c.primary) : candidates
    const targets = [...new Set(tier.map(c => c.value.channelCategoryId))]
    if (targets.length > 1) {
      out[p.id] = { ...EMPTY, conflicts: tier.map(c => `${c.value.categoryId} → ${c.value.channelCategoryId}`) }
      continue
    }
    resolved = tier[0]?.value ?? null

    if (resolved) {
      resolved.categoryName = resolved.categoryId ? (names.get(resolved.categoryId) ?? null) : null
      out[p.id] = resolved
    } else if (amazon && p.productType) {
      out[p.id] = { ...EMPTY, channelCategoryId: p.productType, source: 'productType' }
    } else if (amazon && p.parentId && typeOf.get(p.parentId)) {
      // Without it every column of the variation's type is "Not applicable" (REGAL DE, 2026-09-30: 16 rows, 2,816 cells).
      out[p.id] = { ...EMPTY, channelCategoryId: typeOf.get(p.parentId)!, source: 'productType', fromParent: true }
    } else {
      out[p.id] = { ...EMPTY }
    }
  }
  for (const [id, conflicts] of disagreements) out[id] = { ...out[id], otherMarketConflicts: conflicts }

  for (const id of productIds) if (!out[id]) out[id] = { ...EMPTY }
  return out
}

/** One product — a thin wrapper so callers do not build a one-element array. */
export async function resolveCategoryForProduct(input: {
  productId: string
  channel: string
  marketplace: string
  channelConnectionId?: string | null
}): Promise<ResolvedCategory> {
  const map = await resolveCategoriesForProducts({
    productIds: [input.productId],
    channel: input.channel,
    marketplace: input.marketplace,
    channelConnectionId: input.channelConnectionId,
  })
  return map[input.productId] ?? { ...EMPTY }
}

/**
 * One product's category for its listing in one market — `platformAttributes` of that listing, or null/undefined when
 * it has none yet. The one call for a caller that holds a single product and listing (the product-page schema, GTIN
 * status, direct publish and its preflight, the Amazon pre-flight report), so none of them re-derives the rule.
 */
export async function resolveListingCategory(input: {
  productId: string
  channel: string
  marketplace: string
  platformAttributes: unknown
  channelConnectionId?: string | null
}): Promise<ResolvedCategory> {
  return categoryForListing(await resolveCategoryForProduct(input), input.channel, input.platformAttributes)
}

// ────────────────────────────────────────────────────────────────────
// The editor's read + write
// ────────────────────────────────────────────────────────────────────

export interface CategoryMappingRow {
  categoryId: string
  categoryName: string
  categoryPath: string
  depth: number
  parentId: string | null
  productCount: number
  mapping: {
    id: string
    marketplace: string
    channelCategoryId: string
    channelCategoryPath: string | null
    browseNodeId: string | null
    confidence: string
    reviewedAt: string | null
    notes: string | null
  } | null
  /** Inherited from a mapped ancestor rather than declared here. */
  inheritedFrom: { categoryId: string; categoryName: string; channelCategoryId: string; reviewed?: boolean } | null
}

/** The left rail: our whole category tree with its mapping state for one channel × market. */
export async function listCategoryMappings(input: {
  channel: string
  marketplace: string
}): Promise<{ rows: CategoryMappingRow[]; counts: { total: number; mapped: number; inherited: number } }> {
  const channel = input.channel.toUpperCase()
  const { marketplace } = input

  const [categories, mappings, counts, closure] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, name: true, parentId: true, depth: true, slug: true },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    }),
    prisma.categoryChannelMapping.findMany({
      where: { channel, marketplace: { in: categoryMappingMarkets(channel, marketplace) } },
    }),
    prisma.productCategory.groupBy({ by: ['categoryId'], _count: { productId: true } }),
    prisma.categoryClosure.findMany({
      where: { depth: { gt: 0 } },
      select: { ancestorId: true, descendantId: true, depth: true },
      orderBy: { depth: 'asc' },
    }),
  ])

  const nameOf = new Map(categories.map((c) => [c.id, categoryName(c.name) ?? c.slug]))
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]))
  const pathOf = (id: string): string => {
    const parts: string[] = []
    let cur: string | null | undefined = id
    let guard = 0
    while (cur && guard++ < 20) {
      parts.unshift(nameOf.get(cur) ?? cur)
      cur = parentOf.get(cur) ?? null
    }
    return parts.join(' › ')
  }

  const countOf = new Map(counts.map((c) => [c.categoryId, c._count.productId]))
  const own = new Map<string, (typeof mappings)[number]>()
  for (const m of mappings) {
    const existing = own.get(m.categoryId)
    // An exact-market row beats the '*' row.
    if (!existing || (existing.marketplace === '*' && m.marketplace === marketplace)) own.set(m.categoryId, m)
  }
  const ancestorsOf = new Map<string, string[]>()
  for (const c of closure) {
    const list = ancestorsOf.get(c.descendantId) ?? []
    list.push(c.ancestorId)
    ancestorsOf.set(c.descendantId, list)
  }

  const rows: CategoryMappingRow[] = categories.map((c) => {
    const m = own.get(c.id) ?? null
    let inheritedFrom: CategoryMappingRow['inheritedFrom'] = null
    if (!m) {
      for (const anc of ancestorsOf.get(c.id) ?? []) {
        const am = own.get(anc)
        if (am) {
          inheritedFrom = {
            categoryId: anc,
            categoryName: nameOf.get(anc) ?? anc,
            channelCategoryId: am.channelCategoryId,
            reviewed: am.reviewedAt != null,
          }
          break
        }
      }
    }
    return {
      categoryId: c.id,
      categoryName: nameOf.get(c.id) ?? c.slug,
      categoryPath: pathOf(c.id),
      depth: c.depth,
      parentId: c.parentId,
      productCount: countOf.get(c.id) ?? 0,
      mapping: m
        ? {
            id: m.id,
            marketplace: m.marketplace,
            channelCategoryId: m.channelCategoryId,
            channelCategoryPath: m.channelCategoryPath,
            browseNodeId: m.browseNodeId,
            confidence: m.confidence,
            reviewedAt: m.reviewedAt?.toISOString() ?? null,
            notes: m.notes,
          }
        : null,
      inheritedFrom,
    }
  })

  return {
    rows,
    counts: {
      total: rows.length,
      mapped: rows.filter((r) => r.mapping).length,
      inherited: rows.filter((r) => !r.mapping && r.inheritedFrom).length,
    },
  }
}

export async function upsertCategoryMapping(input: {
  categoryId: string
  channel: string
  marketplace: string
  channelCategoryId: string
  channelCategoryPath?: string | null
  browseNodeId?: string | null
  confidence?: string
  notes?: string | null
  reviewedBy?: string | null
}) {
  const channel = input.channel.toUpperCase()
  const marketplace = input.marketplace || '*'
  assertCategoryMappingMarket(channel, marketplace)
  const confidence = input.confidence ?? 'MANUAL'
  // A hand-made mapping is reviewed by definition; an AI suggestion is not until confirmed.
  const reviewedAt = confidence === 'MANUAL' ? new Date() : null

  return prisma.categoryChannelMapping.upsert({
    where: {
      categoryId_channel_marketplace: workspaceKey({ categoryId: input.categoryId, channel, marketplace }),
    },
    create: {
      categoryId: input.categoryId,
      channel,
      marketplace,
      channelCategoryId: input.channelCategoryId,
      channelCategoryPath: input.channelCategoryPath ?? null,
      browseNodeId: input.browseNodeId ?? null,
      confidence,
      reviewedAt,
      reviewedBy: input.reviewedBy ?? null,
      notes: input.notes ?? null,
    },
    update: {
      channelCategoryId: input.channelCategoryId,
      channelCategoryPath: input.channelCategoryPath ?? null,
      browseNodeId: input.browseNodeId ?? null,
      confidence,
      reviewedAt,
      reviewedBy: input.reviewedBy ?? null,
      notes: input.notes ?? null,
    },
  })
}

export async function removeCategoryMapping(input: {
  categoryId: string
  channel: string
  marketplace: string
}) {
  return prisma.categoryChannelMapping.deleteMany({
    where: {
      categoryId: input.categoryId,
      channel: input.channel.toUpperCase(),
      marketplace: input.marketplace || '*',
    },
  })
}

/**
 * The channel categories worth offering in the picker: every productType we hold a cached
 * definition for on this market, plus every one that already carries a rule overlay. Honest
 * about being a subset — we do not hold Amazon's whole 4,582-node taxonomy.
 */
export async function listChannelCategories(input: {
  channel: string
  marketplace: string
}): Promise<{ options: Array<{ id: string; label: string; hasSchema: boolean }>; note: string }> {
  const channel = input.channel.toUpperCase()
  const [rows, mapping] = await Promise.all([
      prisma.categorySchema.findMany({
          // LX.F2 R-LX-20 — one authority, and no per-channel branch at the call site: the helper
          // answers a one-element list for a non-eBay channel. This branch also composed
          // `EBAY_EBAY_IT` for a caller already holding the prefixed spelling.
          where: { channel, marketplace: { in: categorySchemaMarkets(channel, input.marketplace) }, isActive: true },
          select: { productType: true },
          distinct: ['productType'],
          orderBy: { productType: 'asc' },
        }),
      getMappingForMarketplace(channel, input.marketplace),
  ])
  const options = rows.map((r) => ({ id: r.productType, label: r.productType, hasSchema: true }))
  for (const id of Object.keys(mapping.byProductType ?? {})) {
    if (!options.some(option => option.id === id)) options.push({ id, label: id, hasSchema: false })
  }
  options.sort((a, b) => a.label.localeCompare(b.label))
  return {
    options,
    note:
      options.length > 0
        ? 'Categories with cached definitions or saved mapping rules. Use a category ID to inspect another category.'
        : 'No cached definitions or saved category rules. Enter a category ID to inspect its fields.',
  }
}
