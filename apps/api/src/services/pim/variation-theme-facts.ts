/** Cached category facts and stored rules for the effective variation projection.
 * Schema expiry does not hide usable cached choices; the editor exposes the fetch date.
 * No provider request is made here. Every schema and rule is scoped to its workspace,
 * channel, market and listing category, including category aliases.
 */

import prisma from '../../db.js'
import { categoryForListing, resolveCategoriesForProducts } from './mapping/category-mapping.service.js'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import { getMappingForMarketplaceWithWarnings, getVariationRule, MarketplaceNotFoundError } from './schema-mapping.service.js'
import { loadEtsyTaxonomySpec } from './channel-specs/etsy-loader.js'
import type { SheetColumn } from './sheet-columns.service.js'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { themeSchemaFacts, type ThemeSchemaFacts } from './variation-theme-segments.js'
import {
  resolveVariationProjection,
  VT_COPY,
  type ResolveVariationInput,
  type VariationListingFacts,
  type VariationSchemaFacts,
  type VariationThemeCell,
} from './variation-rules.service.js'

// ------------------------------------------------------------------
// Amazon: the cached product-type schema
// ------------------------------------------------------------------

interface CachedThemeFacts { facts: ThemeSchemaFacts; fetchedAt: string | null; readAt: number }

/**
 * Per-process cache. The KEY is the coordinate (marketplace x productType) because Amazon versions its schemas
 * per marketplace - measured: six different `schemaVersion`s for the identical 52-value OUTERWEAR enum, so a
 * channel-wide cache would be wrong even where the payloads agree today.
 *
 * The 5-minute window is on the CACHE, not on the schema: it bounds how long a refreshed schema takes to reach
 * an open sheet. `expiresAt` on the row is deliberately ignored (see the file header).
 */
const THEME_FACTS_TTL_MS = 5 * 60 * 1000
const themeFactsCache = new Map<string, CachedThemeFacts>()

export function clearVariationThemeFactsCache(): void {
  themeFactsCache.clear()
}

/**
 * 🔴 P0, found by VT.4 on the live publish path — ONE authority for code ↔ SP-API marketplace id.
 *
 * `CategorySchema.marketplace` stores the market CODE (measured on this catalogue: the AMAZON rows are
 * `BE 3 · DE 32 · ES 24 · FR 25 · IT 61 · NL 3 · UK 22` — **zero** SP-API ids). But the publish payload's
 * `marketplaceId` holds the SP-API ID (`submission.service.ts` resolves `AMAZON:<code>` through
 * `Marketplace.marketplaceId` and only falls back to the code when the row has none) — and the adapter even names its
 * local copy `marketplaceCode`, which is how a lookup written against one key and read with another looked correct.
 * The consequence was silent: the schema never resolved on the publish path, so the attribute binding never ran and
 * the legacy `${axis}_name` fallback shipped — VT.4 measured a live plan carrying the attribute name
 * `"fit type_name"`, a space inside an SP-API attribute name.
 *
 * The authority is the `Marketplace` row, never a literal map: whatever the caller holds — code or id — this resolves
 * it to the CODE the schema store is keyed by. Memoised per process; an unknown value is returned unchanged so a
 * caller that already holds a code keeps working even before any `Marketplace` row exists.
 */
const marketCodeCache = new Map<string, string>()

export function clearAmazonMarketCodeCache(): void { marketCodeCache.clear() }

export async function resolveAmazonMarketCode(marketplaceOrId: string): Promise<string> {
  const raw = String(marketplaceOrId ?? '').trim()
  if (!raw) return raw
  const cacheKey = `${workspaceIdForQuery()}:${raw}`
  const hit = marketCodeCache.get(cacheKey)
  if (hit !== undefined) return hit
  let code = raw
  try {
    const row = await prisma.marketplace.findFirst({
      where: { channel: 'AMAZON', OR: [{ code: raw }, { code: raw.toUpperCase() }, { marketplaceId: raw }] },
      select: { code: true },
    })
    if (row?.code) code = row.code
  } catch {
    // An unreadable Marketplace table is not a reason to guess: keep what the caller gave us and let the schema read
    // answer `null` (= "could not look"), which the publish path refuses on rather than inventing an attribute.
  }
  marketCodeCache.set(cacheKey, code)
  return code
}

export async function loadAmazonThemeFacts(
  marketplaceOrId: string,
  productType: string | null | undefined,
): Promise<{ facts: ThemeSchemaFacts; fetchedAt: string | null } | null> {
  if (!productType) return null
  const marketplace = await resolveAmazonMarketCode(marketplaceOrId)
  const key = `${workspaceIdForQuery()}:${String(marketplace).toUpperCase()}:${String(productType).toUpperCase()}`
  const hit = themeFactsCache.get(key)
  if (hit && Date.now() - hit.readAt < THEME_FACTS_TTL_MS) return { facts: hit.facts, fetchedAt: hit.fetchedAt }
  // A schema store that cannot be READ is `null` = "we could not look", which the cell renders as
  // `candidates.state: 'unavailable'` with a reason. It is never an exception: the variation theme column is served
  // on every scope of every sheet read, so a missing or unavailable `CategorySchema` store would otherwise take the
  // whole sheet down instead of one cell's candidate list. (It also keeps the column out of the way of test
  // harnesses that mock a narrow prisma surface.)
  let row: { schemaDefinition: unknown; fetchedAt: Date | null } | null = null
  try {
    row = await prisma.categorySchema.findFirst({
      where: { isActive: true, channel: 'AMAZON', marketplace: String(marketplace).toUpperCase(), productType: String(productType).toUpperCase() },
      orderBy: { fetchedAt: 'desc' },
      select: { schemaDefinition: true, fetchedAt: true },
    })
  } catch {
    return null
  }
  if (!row) return null
  const facts = themeSchemaFacts(row.schemaDefinition)
  const fetchedAt = row.fetchedAt ? new Date(row.fetchedAt).toISOString() : null
  themeFactsCache.set(key, { facts, fetchedAt, readAt: Date.now() })
  return { facts, fetchedAt }
}

// ------------------------------------------------------------------
// eBay: the site's variation-enabled aspects, from the sheet's own columns
// ------------------------------------------------------------------

/**
 * The eBay aspects this coordinate offers as variation specifics.
 *
 * Derived from the columns the sheet already serves - `variantEligible` plus the coordinate's own facts - which is
 * the SAME rule `targetOptionsFrom()` uses for the Variants dock (`family-projection.service.ts`). The specific
 * NAME is the leaf of the store path (`itemSpecifics` then `Colore`), because that is the `Name` eBay's
 * NameValueList carries; the English name is the column's own label, so the axis match never needs a localized
 * synonym table.
 */
export function ebayAspectFactsFromColumns(
  columns: SheetColumn[],
  coordinateLabel: string,
  categoryId: string | null,
  market: string,
): NonNullable<VariationSchemaFacts['ebay']> {
  const aspects: Array<{ name: string; englishName: string | null; variantEligible: boolean; required: boolean }> = []
  for (const column of columns) {
    if (!column.variantEligible) continue
    const facts = (column as unknown as {
      channels?: Record<string, { label?: string; store?: { path?: string[] }; requirement?: string }>
    }).channels?.[coordinateLabel]
    const path = facts?.store?.path ?? []
    const name = path.length > 0 ? String(path[path.length - 1]) : column.key
    aspects.push({
      name,
      englishName: column.label ?? null,
      variantEligible: true,
      required: facts?.requirement === 'required' || column.requiredBy.indexOf(coordinateLabel) >= 0,
    })
  }
  return {
    categoryId,
    aspects,
    // The honest sentence for an empty list: we could not look, because there is no category on this listing.
    unavailableReason: aspects.length === 0 && !categoryId ? VT_COPY.ebayNoCategory(market) : null,
  }
}

// ------------------------------------------------------------------
// Master: the axes an operator may ADD, and the English labels
// ------------------------------------------------------------------

/**
 * The master candidate axes - T1's rule verbatim: the sheet columns that are `editable`, `per_variant` and scalar.
 * `getFamilyVariationAxes` applies the same filter for the Variants page's `+ Add axis`; both read the same
 * column set, so the cell editor and that band offer the same list.
 */
export function masterAxisCandidates(
  columns: SheetColumn[],
  valueCounts: Record<string, number>,
): Array<{ key: string; label: string; axisKey: string; valueCount: number }> {
  const out: Array<{ key: string; label: string; axisKey: string; valueCount: number }> = []
  for (const column of columns) {
    if (column.editable === false) continue
    if (column.scope !== 'per_variant') continue
    if (column.shape && column.shape !== 'scalar') continue
    if (column.storage !== 'categoryAttributes'
      && !(column.storage === 'localizedContent' && column.writeField.startsWith('attr_'))) continue
    const axisKey = canonicalVariantAxis(column.key)
    out.push({ key: column.key, label: column.label, axisKey, valueCount: valueCounts[axisKey] ?? 0 })
  }
  return out
}

/**
 * canonical axisKey -> the ENGLISH label, so no label in the cell is spelled by this programme.
 *
 * Three sources, in order, and the second exists because of a measurement: on the Shopify coordinate there is NO
 * column whose key canonicalises to `color` or `size` at all (checked on GALE-JACKET: 74 columns, zero matches), so
 * the first source cannot answer and the cell fell back to the family's STORED keys - it read `Colore · Taglia` on
 * Shopify where the design says the English label. The second source fixes that without inventing a label table:
 * when the stored key is a localized ALIAS of a canonical axis (`Colore`, `Taglia`, `Farbe`, `Größe` - the map in
 * `variant-attribute-keys.ts` is the only authority for that), the canonical key's own word IS the English label.
 * A key that is already canonical (`Stile`, `Fit Type` - no alias entry) keeps its stored spelling, because
 * inventing an English word for it would be a guess.
 */
export function axisLabelsFromColumns(columns: SheetColumn[], familyAxes: string[]): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const column of columns) {
    if (column.kind === 'variationTheme') continue
    const axisKey = canonicalVariantAxis(column.key)
    if (labels[axisKey] === undefined) labels[axisKey] = column.label
  }
  const normalise = (v: string) => v.toLowerCase().replace(/[\s_-]/g, '')
  const titleCase = (v: string) => v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()
  for (const axis of familyAxes) {
    const axisKey = canonicalVariantAxis(axis)
    if (labels[axisKey] !== undefined) continue
    // The canonicaliser CHANGED the key => the stored key is a localized alias, and the canonical key is English.
    labels[axisKey] = axisKey !== normalise(axis) ? titleCase(axisKey) : titleCase(axis)
  }
  return labels
}

// ------------------------------------------------------------------
// The one entry point the sheet calls
// ------------------------------------------------------------------

export interface BuildVariationCellsInput {
  /** null = master scope. */
  coordinate: { channel: string; marketplace: string; label: string } | null
  market: string
  accountId: string | null
  columns: SheetColumn[]
  family: {
    rootId: string
    familyAxes: string[]
    productVersion: number
    productTheme: string | null
    productType: string | null
    childIds: string[]
    /** Every child's axis values, for the collision rule and the master value counts. ABSENT = not computed. */
    variants?: Array<{ id: string; sku: string; included: boolean; axisValues: Record<string, string> }>
  }
  /** The PARENT listing row per aliasKey ('' = primary). Absent entries mean "no listing on that coordinate". */
  parentListings: Map<string, VariationListingFacts | null>
  /** A mapping-page rule for this coordinate, when one exists. VT.3 supplies the writer; VT.1 reads it. */
  rule?: ResolveVariationInput['rule']
  categoriesByAlias?: Map<string, string | null>
  variantsByAlias?: Map<string, NonNullable<BuildVariationCellsInput['family']['variants']>>
}

/**
 * One `VariationThemeCell` per alias key. The map's key is the `aliasKey` ('' for the primary listing), matching
 * the sheet's own `${productId}:${aliasId ?? ''}` addressing - an alias row shows the ALIAS's own projection,
 * because the store is the alias's own parent listing row (T10).
 */
/** Load the exact category and rule for one listing, including aliases. No provider calls. */
export async function loadVariationProjectionInput(input: BuildVariationCellsInput, aliasKey = ''): Promise<ResolveVariationInput> {
  const channel = input.coordinate?.channel.toUpperCase() ?? null
  const listing = input.parentListings.get(aliasKey) ?? null
  const category = input.categoriesByAlias?.has(aliasKey) ? input.categoriesByAlias.get(aliasKey)! : channel ? await resolveVariationCategory(channel, input.coordinate!.marketplace, input.family.rootId, listing) : null
  let schema: VariationSchemaFacts = {}
  if (channel === 'AMAZON') schema.amazon = await loadAmazonThemeFacts(input.coordinate!.marketplace, category)
  if (channel === 'EBAY') {
    const { loadEbaySpec } = await import('./channel-specs/index.js')
    const spec = category ? await loadEbaySpec(input.coordinate!.marketplace, [category]) : null
    schema.ebay = {
      categoryId: category,
      aspects: (spec?.fields ?? []).filter(f => f.variantEligible).map(f => ({ name: ('path' in f.channelStore ? f.channelStore.path.at(-1) : null) ?? f.key, englishName: f.englishLabel ?? f.label, variantEligible: true, required: f.requirement === 'required' })),
      unavailableReason: !spec || spec.absent ? `The variation specifics for this category on ${input.coordinate!.marketplace} have not been loaded.` : null,
    }
  }
  if (channel === 'ETSY') {
    const spec = category && /^[1-9]\d*$/.test(category) ? await loadEtsyTaxonomySpec(category) : null
    schema.etsy = { properties: (spec?.fields ?? []).filter(f => f.variantEligible).map(f => ({ code: f.key, label: f.label, axisKey: f.defaultRule?.source ?? f.label })), fetchedAt: spec?.fetchedAt?.toISOString() ?? null, available: !!spec && !spec.absent }
  }
  let rule = input.rule ?? null
  if (channel && input.rule === undefined) {
    try {
      const { mapping } = await getMappingForMarketplaceWithWarnings(channel, input.coordinate!.marketplace)
      const stored = getVariationRule(mapping, category)
      if (stored) rule = { label: stored.rule.label ?? (category ? `${category} variations` : 'Channel variations'), category: stored.scope === 'category' ? category : null, theme: stored.rule.theme, mapping: stored.rule.axes }
    } catch (error) {
      if (!(error instanceof MarketplaceNotFoundError)) throw error
    }
  }
  const variants = input.variantsByAlias?.get(aliasKey) ?? input.family.variants
  const values = new Map<string, Set<string>>()
  for (const variant of variants ?? []) for (const [key, value] of Object.entries(variant.axisValues)) {
    if (!value) continue
    const canonical = canonicalVariantAxis(key)
    const set = values.get(canonical) ?? new Set<string>(); set.add(value); values.set(canonical, set)
  }
  return {
    coordinate: { channel, market: input.coordinate?.marketplace ?? input.market, accountId: input.accountId, aliasKey, label: input.coordinate?.label ?? 'Master' },
    family: { ...input.family, axisLabels: axisLabelsFromColumns(input.columns, input.family.familyAxes), ...(variants ? { variants } : {}),
      ...(channel === null ? { masterCandidates: masterAxisCandidates(input.columns, Object.fromEntries([...values].map(([key, set]) => [key, set.size]))) } : {}) },
    listing, rule, schema, limits: limitsFor(channel ?? 'MASTER', schema.amazon?.facts.themes ?? []), vocabulary: vocabularyFor(channel ?? 'MASTER'),
  }
}

export async function buildVariationThemeCells(input: BuildVariationCellsInput): Promise<Map<string, VariationThemeCell>> {
  const keys = input.coordinate ? [...input.parentListings.keys()] : ['']
  return new Map(await Promise.all((keys.length ? keys : ['']).map(async key => [key, resolveVariationProjection(await loadVariationProjectionInput(input, key))] as const)))
}

/** Use the same taxonomy inheritance and explicit listing assignment as ordinary sheet fields. */
export async function resolveVariationCategory(channel: string, market: string, productId: string, listing: VariationListingFacts | null): Promise<string | null> {
  const defaults = await resolveCategoriesForProducts({ productIds: [productId], channel, marketplace: market })
  return categoryForListing(defaults[productId], channel, listing?.platformAttributes).channelCategoryId
}
