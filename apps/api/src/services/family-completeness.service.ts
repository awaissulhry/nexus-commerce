import { resolveContent, translationMissing } from './pim/content-resolver.js'
import { PRIMARY_CONTENT_LOCALE } from './pim/content-locale.js'
/**
 * W2.14 — FamilyCompletenessService.
 *
 * "How much of this product is filled relative to what its family
 * declares?" — the score that powers the per-row completeness
 * column in /products and the per-family rollup on the families
 * list page.
 *
 * Inputs:
 *   - productId
 * Outputs:
 *   - { totalRequired, filled, score, missing[], byChannel }
 *
 * Algorithm:
 *   1. Load product (with family + categoryAttributes + translations).
 *   2. If no family: return null score (caller renders an em-dash;
 *      "no family" is not a completeness state, it's the absence of
 *      one). Legacy products with categoryAttributes but no family
 *      stay scoreless until W2.15 migrates them.
 *   3. Resolve effective FamilyAttribute set via W2.4.
 *   4. For each required attribute, check whether the product has a
 *      filled value:
 *        - non-localizable + global scope → categoryAttributes[code]
 *        - localizable + global scope     → ProductTranslation rows;
 *                                            we count it filled if at
 *                                            least the primary locale
 *                                            has a value
 *        - per_variant scope (W2.x)       → currently treated as
 *                                            global; full per-variant
 *                                            handling needs the
 *                                            Variant data path that
 *                                            isn't wired yet
 *   5. Aggregate. The headline score is required-only filled / total
 *      required. byChannel further restricts to attrs where
 *      `channels` is empty OR includes that channel.
 *
 * What "filled" means:
 *   - non-null
 *   - non-empty string (after trim)
 *   - non-empty array (for multiselect / future asset[])
 *   - true | false counts as filled (booleans are explicit signals)
 *   - 0 counts as filled (operator might literally mean "0")
 *
 * Pure / impure split:
 *   - load() hits the DB.
 *   - score() is pure: fed (effective set + product values), it
 *     deterministically produces the score. Exported separately so
 *     unit tests can run without Prisma.
 */

import type { PrismaClient } from '@prisma/client'
import prisma from '../db.js'
import {
  familyHierarchyService,
  type EffectiveFamilyAttribute,
} from './family-hierarchy.service.js'

export interface CompletenessResult {
  productId: string
  familyId: string | null
  /** Number of required attributes (resolved via family hierarchy)
   *  whose value is filled on this product. */
  filled: number
  /** Total required attributes the family declares. */
  totalRequired: number
  /** 0–100. -1 when familyId is null (no family attached → not
   *  scoreable). null is reserved for "couldn't compute" (DB error
   *  etc.); -1 distinguishes the legitimate "no family" state. */
  score: number
  missing: Array<{
    attributeId: string
    /** Inherited from this ancestor family, or 'self'. */
    source: 'self' | string
  }>
  /** Per-channel breakdown. Channels referenced by any required
   *  attribute (including the 'all' bucket for channels=[]).
   *  byChannel.all is the headline; per-channel keys are computed
   *  only when at least one required attribute lists channels[]. */
  byChannel: Record<string, { filled: number; totalRequired: number; score: number }>
}

/**
 * Pure scoring function. Tests construct fixtures here without
 * going through Prisma.
 *
 * @param effective  Output of FamilyHierarchyService.resolveEffectiveAttributes.
 * @param values     Map of attribute *code* → stored value. The
 *                   caller resolves Product.categoryAttributes (and
 *                   later, ProductTranslation rows) into this shape
 *                   so this function stays purely about scoring.
 * @param attributeCodes Map from attributeId → code so the resolver
 *                   output (id-keyed) can look up a value (code-keyed).
 */
export function score(
  effective: EffectiveFamilyAttribute[],
  values: Map<string, unknown>,
  attributeCodes: Map<string, string>,
): Pick<CompletenessResult, 'filled' | 'totalRequired' | 'score' | 'missing' | 'byChannel'> {
  const required = effective.filter((e) => e.required)
  const totalRequired = required.length

  if (totalRequired === 0) {
    // Family declares nothing required → 100% by definition.
    return {
      filled: 0,
      totalRequired: 0,
      score: 100,
      missing: [],
      byChannel: { all: { filled: 0, totalRequired: 0, score: 100 } },
    }
  }

  const missing: CompletenessResult['missing'] = []
  let filled = 0
  for (const req of required) {
    const code = attributeCodes.get(req.attributeId)
    if (!code) {
      // Attribute mapping missing — count as not filled but record
      // so the caller can surface a "schema drift" warning.
      missing.push({ attributeId: req.attributeId, source: req.source })
      continue
    }
    if (isFilled(values.get(code))) filled++
    else missing.push({ attributeId: req.attributeId, source: req.source })
  }

  // Per-channel breakdown. 'all' = every required attr regardless of
  // channels[]. Per-channel buckets: only required attrs where
  // channels=[] (universal) OR channels.includes(channel).
  const channels = new Set<string>()
  for (const r of required) for (const c of r.channels) channels.add(c)

  const byChannel: CompletenessResult['byChannel'] = {
    all: {
      filled,
      totalRequired,
      score: Math.round((filled / totalRequired) * 100),
    },
  }
  for (const ch of channels) {
    let cFilled = 0
    let cTotal = 0
    for (const req of required) {
      const applies = req.channels.length === 0 || req.channels.includes(ch)
      if (!applies) continue
      cTotal++
      const code = attributeCodes.get(req.attributeId)
      if (code && isFilled(values.get(code))) cFilled++
    }
    byChannel[ch] =
      cTotal === 0
        ? { filled: 0, totalRequired: 0, score: 100 }
        : { filled: cFilled, totalRequired: cTotal, score: Math.round((cFilled / cTotal) * 100) }
  }

  return {
    filled,
    totalRequired,
    score: byChannel.all.score,
    missing,
    byChannel,
  }
}

/** "Filled" = present and non-empty. See file header for full rules. */
export function isFilled(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'boolean' || typeof v === 'number') return true
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return false
}

const COMPLETENESS_PRODUCT_SELECT = {
  id: true,
  familyId: true,
  categoryAttributes: true,
  workspaceId: true, parentId: true, name: true, description: true, bulletPoints: true, keywords: true,
  translations: true, parent: { include: { translations: true } },
} as const

type CompletenessProduct = { id: string; familyId: string | null; categoryAttributes: unknown; parent: unknown } & Record<string, unknown>
type CompletenessAttribute = { id: string; code: string; localizable: boolean }

/** The completeness of one loaded product. Pure over its inputs; `compute` and `computeMany` both call it. */
function completenessOf(product: CompletenessProduct, effective: EffectiveFamilyAttribute[], attrs: CompletenessAttribute[]): CompletenessResult {
  // Build attributeId → code lookup, restricted to the attrs that appear in `effective`.
  const wanted = new Set(effective.map((e) => e.attributeId))
  const own = attrs.filter((a) => wanted.has(a.id))
  const attributeCodes = new Map(own.map((a) => [a.id, a.code]))
  const localizableCodes = new Set(own.filter((a) => a.localizable).map((a) => a.code))

  // Build code → value map. Layer 1: categoryAttributes JSON
  // (the legacy + canonical store today). Layer 2: localizable
  // attrs draw from ProductTranslation if any row has the value.
  const values = new Map<string, unknown>()
  const ca = (product.categoryAttributes ?? {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(ca)) values.set(k, v)

  // Family completeness is the shared source-language view. Other languages cannot fill it.
  for (const code of localizableCodes) {
    const field = code === 'bullet_points' ? 'bulletPoints' : code
    const resolved = resolveContent({ product: product as any, parent: product.parent as any, field,
      localizableKeys: [...localizableCodes], address: { requested: PRIMARY_CONTENT_LOCALE } })
    values.set(code, translationMissing(resolved, PRIMARY_CONTENT_LOCALE) ? null : resolved.value)
  }

  return {
    productId: product.id,
    familyId: product.familyId,
    ...score(effective, values, attributeCodes),
  }
}

const noFamily = (productId: string): CompletenessResult => ({
  productId,
  familyId: null,
  filled: 0,
  totalRequired: 0,
  score: -1,
  missing: [],
  byChannel: {},
})

export class FamilyCompletenessService {
  constructor(private readonly client: PrismaClient = prisma) {}

  /** Compute completeness for a single product. */
  async compute(productId: string): Promise<CompletenessResult> {
    const product = await this.client.product.findUnique({ where: { id: productId }, select: COMPLETENESS_PRODUCT_SELECT })
    if (!product) {
      throw new Error(`FamilyCompletenessService: product ${productId} not found`)
    }
    if (!product.familyId) return noFamily(productId)

    const effective = await familyHierarchyService.resolveEffectiveAttributes(
      product.familyId,
    )
    const attrs = await this.client.customAttribute.findMany({
      where: { id: { in: effective.map((e) => e.attributeId) } },
      select: { id: true, code: true, localizable: true },
    })
    return completenessOf(product as never, effective, attrs)
  }

  /**
   * P3 (docs/attributes/PLAN.md §4.1) — the same answer as `compute` for many products, with a FIXED number of
   * queries: one for the products, one per family hierarchy level, one for the attributes. `compute` per product cost
   * three queries plus one per family ancestor, each, in sequence.
   * A product that does not exist gets `{ error }`, with the message `compute` throws.
   */
  async computeMany(productIds: readonly string[]): Promise<Map<string, CompletenessResult | { error: string }>> {
    const ids = [...new Set(productIds)]
    const products = await this.client.product.findMany({ where: { id: { in: ids } }, select: COMPLETENESS_PRODUCT_SELECT })
    const byId = new Map(products.map((p) => [p.id, p]))
    const familyIds = [...new Set(products.map((p) => p.familyId).filter((id): id is string => !!id))]
    const effectiveByFamily = new Map<string, EffectiveFamilyAttribute[] | { error: string }>()
    if (familyIds.length) {
      try {
        for (const [id, effective] of await familyHierarchyService.resolveEffectiveAttributesMany(familyIds)) effectiveByFamily.set(id, effective)
      } catch {
        // One broken family must not fail the others: fall back to per-family resolution for the errors' sake.
        for (const id of familyIds) {
          try { effectiveByFamily.set(id, await familyHierarchyService.resolveEffectiveAttributes(id)) }
          catch (err: any) { effectiveByFamily.set(id, { error: err?.message ?? String(err) }) }
        }
      }
    }
    const attributeIds = [...new Set([...effectiveByFamily.values()].flatMap((e) => (Array.isArray(e) ? e.map((a) => a.attributeId) : [])))]
    const attrs = attributeIds.length
      ? await this.client.customAttribute.findMany({ where: { id: { in: attributeIds } }, select: { id: true, code: true, localizable: true } })
      : []
    const results = new Map<string, CompletenessResult | { error: string }>()
    for (const id of ids) {
      const product = byId.get(id)
      if (!product) { results.set(id, { error: `FamilyCompletenessService: product ${id} not found` }); continue }
      if (!product.familyId) { results.set(id, noFamily(id)); continue }
      const effective = effectiveByFamily.get(product.familyId)!
      results.set(id, Array.isArray(effective) ? completenessOf(product as never, effective, attrs) : effective)
    }
    return results
  }

  /**
   * MCP full control P8 — completeness of these products as if each family declared `effectiveByFamily` (a change not
   * made yet: Claude's dry run of a family change measures "N products become incomplete" without writing). The same
   * scoring as `computeMany`; a product whose family is not in the map, or that does not exist, is left out.
   */
  async computeManyWith(
    productIds: readonly string[],
    effectiveByFamily: ReadonlyMap<string, EffectiveFamilyAttribute[]>,
  ): Promise<Map<string, CompletenessResult>> {
    const ids = [...new Set(productIds)]
    const products = ids.length ? await this.client.product.findMany({ where: { id: { in: ids } }, select: COMPLETENESS_PRODUCT_SELECT }) : []
    const attributeIds = [...new Set([...effectiveByFamily.values()].flatMap((e) => e.map((a) => a.attributeId)))]
    const attrs = attributeIds.length
      ? await this.client.customAttribute.findMany({ where: { id: { in: attributeIds } }, select: { id: true, code: true, localizable: true } })
      : []
    const results = new Map<string, CompletenessResult>()
    for (const product of products) {
      const effective = product.familyId ? effectiveByFamily.get(product.familyId) : undefined
      if (effective) results.set(product.id, completenessOf(product as never, effective, attrs))
    }
    return results
  }
}

export const familyCompletenessService = new FamilyCompletenessService()
