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

export class FamilyCompletenessService {
  constructor(private readonly client: PrismaClient = prisma) {}

  /** Compute completeness for a single product. */
  async compute(productId: string): Promise<CompletenessResult> {
    const product = await this.client.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        familyId: true,
        categoryAttributes: true,
        // Translation rows are loaded so localizable attrs can be
        // checked against the operator's primary locale. For now we
        // count the primary-locale field as filled if ANY translation
        // row has a value for it.
        translations: {
          select: {
            language: true,
            name: true,
            description: true,
            bulletPoints: true,
            keywords: true,
          },
        },
      },
    })
    if (!product) {
      throw new Error(`FamilyCompletenessService: product ${productId} not found`)
    }
    if (!product.familyId) {
      return {
        productId,
        familyId: null,
        filled: 0,
        totalRequired: 0,
        score: -1,
        missing: [],
        byChannel: {},
      }
    }

    const effective = await familyHierarchyService.resolveEffectiveAttributes(
      product.familyId,
    )

    // Build attributeId → code lookup. Restricted to the attrs that
    // appear in `effective` (no need to fetch the entire registry).
    const attrIds = effective.map((e) => e.attributeId)
    const attrs = await this.client.customAttribute.findMany({
      where: { id: { in: attrIds } },
      select: { id: true, code: true, localizable: true },
    })
    const attributeCodes = new Map(attrs.map((a) => [a.id, a.code]))
    const localizableCodes = new Set(
      attrs.filter((a) => a.localizable).map((a) => a.code),
    )

    // Build code → value map. Layer 1: categoryAttributes JSON
    // (the legacy + canonical store today). Layer 2: localizable
    // attrs draw from ProductTranslation if any row has the value.
    const values = new Map<string, unknown>()
    const ca = (product.categoryAttributes ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(ca)) values.set(k, v)

    // Layer 2: localizable. ProductTranslation only has fixed columns
    // today (name/description/bulletPoints/keywords) — those map to
    // hard-coded attribute codes if the family declares them. Future
    // commits expand ProductTranslation to a generic per-locale value
    // bag (W2.x); until then this is the conservative read.
    const HARDCODED_TRANSLATION_FIELDS: Record<string, keyof (typeof product.translations)[number]> = {
      name: 'name',
      description: 'description',
      bullet_points: 'bulletPoints',
      keywords: 'keywords',
    }
    for (const code of localizableCodes) {
      const field = HARDCODED_TRANSLATION_FIELDS[code]
      if (!field) continue
      const anyFilled = product.translations.some((t) => isFilled(t[field]))
      if (anyFilled) values.set(code, true)
    }

    return {
      productId,
      familyId: product.familyId,
      ...score(effective, values, attributeCodes),
    }
  }
}

export const familyCompletenessService = new FamilyCompletenessService()
