/**
 * PIM D.5 — Publish-time validator.
 *
 * Walks every FieldMappingRule on a Marketplace and resolves the rule's
 * source (and fallback) against a real Product via the A.1-A.4 attribute
 * resolver. Returns per-field errors for any required field whose
 * resolved value is missing.
 *
 * Stateless / DB-aware: caller hands over productId + (channel, code),
 * we load the entities + run resolution. Used by:
 *   - The mapping editor "Validate against product" affordance (D.5)
 *   - Future publish-gate middleware that blocks bad publishes
 *
 * No payload generation here — that's D.6 dry-run.
 */

import prisma from '../../db.js'
import { resolveAttributes, resolveAttributesFlat } from './attribute-resolver.js'
import {
  getResolvedRules,
  type FieldMappingRule,
} from './schema-mapping.service.js'
import { resolveSourcePath, isPresent } from './resolve-channel-field.js'

// The dotted-path resolver + presence check moved to the FM.2 core module
// (resolve-channel-field) so preview / validate / cascade / sync share one
// implementation. Re-exported for back-compat with callers/docs that
// reference D.5's resolveSourcePath.
export { resolveSourcePath }

export interface FieldValidationError {
  fieldKey: string
  rule: FieldMappingRule
  /** Why this field failed: 'missing_required' | 'unresolved_source' |
   *  'fallback_also_missing'. UI groups by code. */
  code: 'missing_required' | 'unresolved_source' | 'fallback_also_missing'
  /** Human-readable message. */
  message: string
  /** What the resolver returned for the source path. */
  resolvedSource: unknown
  /** What the resolver returned for the fallback path (if any). */
  resolvedFallback: unknown
}

export interface ValidationResult {
  productId: string
  productSku: string
  channel: string
  marketplace: string
  totalFields: number
  /** Fields the rule marks `required: true` — the only ones that can
   *  generate publish-blocking errors. */
  requiredFields: number
  errors: FieldValidationError[]
  /** Convenience: true when errors.length === 0. */
  ok: boolean
}

/**
 * Run validation for one product against one marketplace's mapping
 * rules. Loads entities, runs resolver, walks each rule, returns
 * structured errors.
 */
export async function validatePublish(input: {
  productId: string
  channel: string
  marketplace: string
  locale?: string
}): Promise<ValidationResult> {
  const { productId, channel, marketplace, locale = 'en' } = input

  // Load product + parent + the marketplace mapping.
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) {
    throw new Error(`Product not found: ${productId}`)
  }
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId } })
    : null

  // FM.1 — resolve the effective rule set for this product's type.
  let rules: Record<string, FieldMappingRule>
  try {
    rules = await getResolvedRules(channel, marketplace, product.productType)
  } catch {
    throw new Error(`Marketplace not found: ${channel}/${marketplace}`)
  }

  // Pull the channel listing if one exists for this (productId, channel,
  // marketplace) — gives the resolver the SSOT layer to consult.
  const channelListing = await prisma.channelListing.findFirst({
    where: { productId, channel, marketplace },
  })

  // Run the resolver once; reuse the flat output for every rule.
  const resolved = resolveAttributesFlat({
    product: product as any,
    parent: parent as any,
    channelListing: channelListing as any,
    locale,
  })

  // Full provenance result kept for future "which layer broke?" UI;
  // not used today.
  void resolveAttributes({
    product: product as any,
    parent: parent as any,
    channelListing: channelListing as any,
    locale,
  })

  const errors: FieldValidationError[] = []
  const fieldKeys = Object.keys(rules)
  let requiredCount = 0

  for (const fieldKey of fieldKeys) {
    const rule = rules[fieldKey]
    if (!rule) continue

    const sourceValue = resolveSourcePath(
      rule.source,
      resolved,
      product as any,
      locale,
    )

    if (isPresent(sourceValue)) continue // happy path

    // Source missing — try fallback if defined.
    const fallbackValue = rule.fallback
      ? resolveSourcePath(rule.fallback, resolved, product as any, locale)
      : null

    if (rule.required) {
      requiredCount++
      if (isPresent(fallbackValue)) continue // fallback saves us

      const code: FieldValidationError['code'] = rule.fallback
        ? 'fallback_also_missing'
        : 'missing_required'
      const message = rule.fallback
        ? `Required field "${fieldKey}" missing: source "${rule.source}" and fallback "${rule.fallback}" both resolve to empty.`
        : `Required field "${fieldKey}" missing: source "${rule.source}" resolves to empty.`

      errors.push({
        fieldKey,
        rule,
        code,
        message,
        resolvedSource: sourceValue,
        resolvedFallback: fallbackValue,
      })
    }
    // Non-required fields with missing values are silent — they'd
    // just publish without that attribute. D.6 dry-run can surface
    // them as warnings if we want.
  }

  return {
    productId,
    productSku: product.sku,
    channel,
    marketplace,
    totalFields: fieldKeys.length,
    requiredFields: requiredCount + errors.filter((e) => e.code === 'missing_required' || e.code === 'fallback_also_missing').length,
    errors,
    ok: errors.length === 0,
  }
}
