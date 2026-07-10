/**
 * EFX — eBay Axes Consistency Layer A.
 *
 * ONE server source of truth for a variation family's authoritative axes.
 *
 * Every eBay variation UI surface (variation-order modal, cockpit matrix,
 * images picker + buckets, theme-column combobox) historically re-derived its
 * axes independently from raw data with NO theme filter and inconsistent value
 * sources — so the surfaces disagreed with the operator's declared Variation
 * Theme (the AIREON "Team Name" ghost, the polluted "Colore" swatches, …).
 *
 * The PUSH already gets this right: `resolveVariationAxes` (ebay-variation-
 * push.service.ts) synonym-folds + fingerprint-suppresses the ghost and honors
 * the declared theme. This helper wraps that SAME resolver over the SAME
 * variant-row construction the push consumes (buildFlatRow via
 * buildEbayFamilyRows), so every surface can obey ONE theme-authoritative
 * catalog instead of re-inventing one.
 *
 * ADDITIVE ONLY: this changes no existing response field, no existing resolver,
 * and never writes. It exposes:
 *   • axes       — the declared-ordered, synonym+fingerprint-deduped
 *                  authoritative axes, each with its ONE canonical clean value
 *                  list. Output surfaces render exactly these.
 *   • warnings   — operator-facing reasons an axis wasn't/can't be sent (e.g.
 *                  AIREON's "Tipo di prodotto" resolving to zero clean values).
 *   • suppressed — strays dropped as fingerprint-duplicates of a declared axis
 *                  (the Team Name case) — diagnostics only.
 *   • candidates — the WIDEST discoverable axis-name list for the theme-INPUT
 *                  combobox: variation-eligible category-schema aspects ∪ every
 *                  aspect key observed on the children, synonym-deduped.
 */

import prisma from '../db.js'
import {
  resolveVariationAxes,
  buildEbayFamilyRows,
} from './ebay-variation-push.service.js'
import { parseThemeAxes, axisSynonymKey } from './ebay-theme-axes.js'
import { EbayCategoryService } from './ebay-category.service.js'

const ebayCategoryService = new EbayCategoryService()

/** ONE authoritative axis: canonical display name, its stable synonym key, and
 *  the single clean value list every surface should render. */
export interface ResolvedFamilyAxis {
  name: string
  key: string
  values: string[]
}

export interface ResolveFamilyAxesResult {
  /** Declared-ordered, synonym+fingerprint-deduped authoritative axes. */
  axes: ResolvedFamilyAxis[]
  /** Operator-facing warnings (missing / single-value / undeclared-varying). */
  warnings: string[]
  /** Strays dropped as fingerprint-duplicates of a declared axis (diagnostics). */
  suppressed: string[]
  /** Widest discoverable axis-name list for the theme-input combobox. */
  candidates: string[]
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * Gather every raw aspect KEY observed on a family's children across all three
 * per-variant sources — categoryAttributes.variations, variantAttributes, and
 * each child's eBay itemSpecifics — in first-seen order, preserving display
 * casing. Exact-name duplicates are collapsed; synonym folding is left to
 * {@link unionAxisCandidates} so the widest raw set survives for it to dedupe.
 */
export function collectObservedAxisKeys(
  children: Array<{
    categoryAttributes?: unknown
    variantAttributes?: unknown
    ebayItemSpecifics?: Record<string, unknown> | null
  }>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (rawKey: unknown) => {
    if (typeof rawKey !== 'string') return
    const name = rawKey.trim()
    if (!name) return
    const lk = name.toLowerCase()
    if (seen.has(lk)) return
    seen.add(lk)
    out.push(name)
  }
  const pushKeys = (obj: unknown) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj as Record<string, unknown>)) push(k)
    }
  }
  for (const c of children) {
    const catVars = (c.categoryAttributes as { variations?: unknown } | null)?.variations
    pushKeys(catVars)
    pushKeys(c.variantAttributes)
    pushKeys(c.ebayItemSpecifics)
  }
  return out
}

/**
 * Union of {variation-eligible schema aspects} and {observed family aspect
 * keys}, synonym-deduped by axisSynonymKey, preserving the FIRST-seen display
 * casing (schema names come first, so the locale-correct schema label wins over
 * an ad-hoc observed key when both fold to the same dimension).
 */
export function unionAxisCandidates(
  schemaEligible: string[],
  observed: string[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [...schemaEligible, ...observed]) {
    const name = (raw ?? '').trim()
    if (!name) continue
    const k = axisSynonymKey(name)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
  }
  return out
}

/** Category id for the schema lookup: parent listing platformAttributes wins,
 *  else the first variant row's category_id (child listings). */
function resolveCategoryId(
  parentPlatform: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
): string {
  const fromParent = typeof parentPlatform.categoryId === 'string' ? parentPlatform.categoryId : ''
  if (fromParent) return fromParent
  for (const r of rows) {
    const c = r.category_id
    if (typeof c === 'string' && c) return c
  }
  return ''
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Resolve the ONE authoritative axis/value catalog for a variation family,
 * theme-authoritative, mirroring the push byte-for-byte.
 *
 * @param parentProductId the family parent Product id
 * @param marketplace     eBay marketplace short-code (labels/value-order are
 *                        stored per-market on the parent ChannelListing)
 */
export async function resolveFamilyAxes(
  parentProductId: string,
  marketplace: string,
): Promise<ResolveFamilyAxesResult> {
  const parent = await prisma.product.findUnique({
    where: { id: parentProductId },
    select: {
      id: true,
      variationTheme: true,
      variationAxes: true,
      imageAxisPreference: true,
    },
  })
  if (!parent) return { axes: [], warnings: [], suppressed: [], candidates: [] }

  // variantRows — built via the SAME path the push consumes (buildEbayFamilyRows
  // → buildFlatRow), so this helper's aspect_* construction matches the push
  // exactly. Drop the parent container row (buildFlatRow sets _isParent from
  // !parentId); fall back to the full set if nothing else is present.
  const familyRows = await buildEbayFamilyRows(parentProductId)
  const variantRows = familyRows.filter((r) => r._isParent !== true)
  const rowsForAxes = variantRows.length > 0 ? variantRows : familyRows

  // Parent listing platformAttributes (marketplace-specific) → the SAME label /
  // stored-order opts the push pulls (ebay-variation-push.service.ts ~697-706).
  const parentListing = await prisma.channelListing.findFirst({
    where: { productId: parentProductId, channel: 'EBAY', marketplace },
    select: { platformAttributes: true },
  })
  const pa = (parentListing?.platformAttributes ?? {}) as Record<string, unknown>
  const nameLabels = (pa._axisNameLabels ?? {}) as Record<string, string>
  const valueLabels = (pa._axisValueLabels ?? {}) as Record<string, Record<string, string>>
  const storedAxisOrder = Array.isArray(pa._variationAxes)
    ? (pa._variationAxes as unknown[]).filter((s): s is string => typeof s === 'string')
    : []

  // EFX D2 — theme wins; else the parent's stored _variationAxes; else LEGACY
  // (null) — byte-identical to the push's declaredAxes resolution (~708-714).
  const themeAxes = parseThemeAxes(parent.variationTheme)
  const declaredAxes: string[] | null = themeAxes.length > 0
    ? themeAxes
    : storedAxisOrder.length > 0
      ? storedAxisOrder.slice()
      : null

  // D8 — the operator's explicit image-axis pick (Product.imageAxisPreference),
  // the SAME source the push passes as pictureAxisOverride.
  const pictureAxisOverride = (parent.imageAxisPreference ?? '') || undefined

  const resolved = resolveVariationAxes(rowsForAxes, declaredAxes, {
    nameLabels,
    valueLabels,
    storedAxisOrder,
    pictureAxisOverride,
  })

  const axes: ResolvedFamilyAxis[] = resolved.validSpecs.map((s) => ({
    name: s.name,
    key: axisSynonymKey(s.name),
    values: [...s.values],
  }))

  const candidates = await buildAxisCandidates(parentProductId, marketplace, pa, rowsForAxes)

  return {
    axes,
    warnings: resolved.warnings,
    suppressed: resolved.suppressed,
    candidates,
  }
}

/** Widest discoverable axis-name list: variation-eligible category-schema
 *  aspects ∪ every aspect key observed on the children, synonym-deduped. */
async function buildAxisCandidates(
  parentProductId: string,
  marketplace: string,
  parentPlatform: Record<string, unknown>,
  rowsForAxes: Array<Record<string, unknown>>,
): Promise<string[]> {
  const children = await prisma.product.findMany({
    where: { parentId: parentProductId },
    select: { id: true, categoryAttributes: true, variantAttributes: true },
  })
  // Each child's eBay itemSpecifics (first market with specs wins) — a third
  // observed source (mirrors images-workspace EFX P5.1).
  const childListings = await prisma.channelListing.findMany({
    where: { product: { parentId: parentProductId }, channel: 'EBAY' },
    orderBy: { marketplace: 'asc' },
    select: { productId: true, platformAttributes: true },
  })
  const specsByChild = new Map<string, Record<string, unknown>>()
  for (const l of childListings) {
    if (specsByChild.has(l.productId)) continue
    const specs = (l.platformAttributes as Record<string, unknown> | null)?.itemSpecifics
    if (specs && typeof specs === 'object' && !Array.isArray(specs)) {
      specsByChild.set(l.productId, specs as Record<string, unknown>)
    }
  }
  const observed = collectObservedAxisKeys(
    children.map((c) => ({
      categoryAttributes: c.categoryAttributes,
      variantAttributes: c.variantAttributes,
      ebayItemSpecifics: specsByChild.get(c.id) ?? null,
    })),
  )

  // Variation-eligible category-schema aspects (best-effort — a token/network
  // failure just narrows candidates to the observed set, never throws).
  let schemaEligible: string[] = []
  const categoryId = resolveCategoryId(parentPlatform, rowsForAxes)
  if (categoryId) {
    try {
      const rich = await ebayCategoryService.getCategoryAspectsRich(
        categoryId,
        marketplace,
        { throwOnError: false },
      )
      schemaEligible = rich.filter((a) => a.variantEligible).map((a) => a.name)
    } catch {
      // best-effort — leave schemaEligible empty
    }
  }

  return unionAxisCandidates(schemaEligible, observed)
}
