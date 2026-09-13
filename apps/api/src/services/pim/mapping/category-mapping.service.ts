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
 *   1. its PRIMARY category's mapping for (channel, exact market)
 *   2. its primary category's mapping for (channel, '*')
 *   3. the nearest MAPPED ancestor of that category, same two steps — a mapping on
 *      `Clothing > Outerwear` covers `Clothing > Outerwear > Coats` without re-declaring it,
 *      which is the whole reason we keep a closure table
 *   4. any other category the product belongs to, by the same rules
 *   5. `Product.productType` for Amazon only — the legacy answer, kept so nothing that works today stops
 *      working, and REPORTED as `source: 'productType'` so the UI never implies a mapping
 *      exists when one does not
 *
 * Ancestor inheritance uses `CategoryClosure` (already maintained), so step 3 is one indexed
 * query, not a recursive walk.
 */

import prisma from '../../../db.js'
import { getMappingForMarketplace } from '../schema-mapping.service.js'

export type CategoryResolutionSource =
  | 'categoryExact'    // mapped on this category, this market
  | 'categoryWildcard' // mapped on this category, marketplace '*'
  | 'ancestorExact'
  | 'ancestorWildcard'
  | 'productType'      // legacy Product.productType
  | 'listing'          // the category/product type assigned to this channel listing
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

/** Existing listings can pin their own category. Amazon product types are never eBay category ids. */
export function categoryForListing(
  category: ResolvedCategory | undefined,
  channel: string,
  platformAttributes: unknown,
): ResolvedCategory {
  const ch = channel.toUpperCase()
  const attrs = platformAttributes && typeof platformAttributes === 'object'
    ? platformAttributes as Record<string, unknown> : {}
  const raw = ch === 'AMAZON' ? attrs.productType : ch === 'EBAY' ? attrs.categoryId
    : ch === 'SHOPIFY' ? attrs.category : ch === 'ETSY' ? attrs.taxonomy_id : null
  // Store drafts support an explicit empty category, distinct from removing the override.
  if (raw === null && (ch === 'SHOPIFY' || ch === 'ETSY')) return { ...EMPTY }
  const id = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
  if (id) return { ...EMPTY, channelCategoryId: ch === 'AMAZON' ? id.toUpperCase() : id, source: 'listing' }
  if (ch !== 'AMAZON' && category?.source === 'productType') return { ...EMPTY }
  return category ?? { ...EMPTY }
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
 * Resolve the effective channel category for MANY products in one pass — the sheet and the
 * batch resolver both need it per row, so a per-product query would be N+1 by construction.
 */
export async function resolveCategoriesForProducts(input: {
  productIds: string[]
  channel: string
  marketplace: string
  mappingSnapshot?: MappingRow[]
}): Promise<Record<string, ResolvedCategory>> {
  const { channel, marketplace } = input
  const productIds = [...new Set(input.productIds)].filter(Boolean)
  const out: Record<string, ResolvedCategory> = {}
  if (productIds.length === 0) return out

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } }, select: { id: true, parentId: true, productType: true },
  })
  const membershipIds = [...new Set([...productIds, ...products.map(p => p.parentId).filter((id): id is string => !!id)])]
  const [memberships, mappings] = await Promise.all([
    prisma.productCategory.findMany({
      where: { productId: { in: membershipIds } },
      select: { productId: true, categoryId: true, isPrimary: true },
    }),
    input.mappingSnapshot ? Promise.resolve(input.mappingSnapshot) : prisma.categoryChannelMapping.findMany({
      where: { channel: channel.toUpperCase(), marketplace: { in: [marketplace, '*'] } },
      select: {
        categoryId: true,
        marketplace: true,
        channelCategoryId: true,
        channelCategoryPath: true,
        browseNodeId: true,
        reviewedAt: true,
      },
    }),
  ])

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

  for (const p of products) {
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
    } else if (channel.toUpperCase() === 'AMAZON' && p.productType) {
      out[p.id] = { ...EMPTY, channelCategoryId: p.productType, source: 'productType' }
    } else {
      out[p.id] = { ...EMPTY }
    }
  }

  for (const id of productIds) if (!out[id]) out[id] = { ...EMPTY }
  return out
}

/** One product — a thin wrapper so callers do not build a one-element array. */
export async function resolveCategoryForProduct(input: {
  productId: string
  channel: string
  marketplace: string
}): Promise<ResolvedCategory> {
  const map = await resolveCategoriesForProducts({
    productIds: [input.productId],
    channel: input.channel,
    marketplace: input.marketplace,
  })
  return map[input.productId] ?? { ...EMPTY }
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
      where: { channel, marketplace: { in: [marketplace, '*'] } },
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
