/**
 * PIM D.6 — Payload preview / dry-run.  (FM.2: delegates to the unified
 * resolver.)
 *
 * Generates the exact key/value payload a publish would send for one
 * product on one marketplace, given the current Marketplace.schemaMapping
 * rules (FM.1 productType-resolved). Per field it delegates to the FM.2
 * unified resolver (resolveChannelField), so the value + transforms here
 * match exactly what cascade / sync (FM.5–FM.8) will produce — "what you
 * preview" == "what ships".
 *
 * The legacy `source` vocabulary ('source' | 'fallback' | 'default' |
 * 'missing') is preserved byte-for-byte for the mapping canvas via
 * resolveChannelField's `legacySource`. The richer FM.2 signal —
 * `provenance` (locked/override/linked/catalogRule/…) and
 * `needsTranslation` — rides alongside as additive fields.
 *
 * Returns per-field provenance:
 *   value         — the final value after transforms (or null if skipped)
 *   source        — 'source' | 'fallback' | 'default' | 'missing' (legacy)
 *   provenance    — FM.2 enriched origin (optional)
 *   needsTranslation — FM.2 cross-language linked flag (optional)
 *   raw           — what the source path resolved to before transforms
 *   appliedTransforms — list of transform types that ran
 *   warnings      — non-blocking notes (e.g. truncated from 250→200)
 */

import prisma from '../../db.js'
import { resolveAttributes } from './attribute-resolver.js'
import {
  getResolvedRules,
  type FieldMappingRule,
  type TransformOp,
} from './schema-mapping.service.js'
import {
  resolveChannelField,
  linkForCoordinate,
  isPresent,
  type ChannelFieldSource,
  type FieldLinkGroupLike,
} from './resolve-channel-field.js'
import { loadValueMapLookup, loadSizeScaleLookup } from './value-map.service.js'

export interface PreviewField {
  fieldKey: string
  rule: FieldMappingRule
  value: unknown
  source: 'source' | 'fallback' | 'default' | 'missing'
  /** FM.2 — richer provenance (locked / override / linked / catalogRule /
   *  fallback / default / missing). */
  provenance?: ChannelFieldSource
  /** FM.2 — linked field whose cross-language translation isn't pinned
   *  yet (the propagation step would fill it). */
  needsTranslation?: boolean
  raw: unknown
  appliedTransforms: TransformOp['type'][]
  warnings: string[]
  required: boolean
}

export interface PreviewResult {
  productId: string
  productSku: string
  channel: string
  marketplace: string
  payload: Record<string, unknown>
  fields: PreviewField[]
  /** Field keys that the mapping marks required and that have no
   *  value after resolution + fallback + default — would block publish. */
  missingRequired: string[]
}

/** Load a product's FieldLinkGroups in the shape the resolver needs.
 *  One query per preview; shared by validate (D.5) once it adopts the
 *  resolver. */
export async function loadFieldLinkGroups(productId: string): Promise<FieldLinkGroupLike[]> {
  const groups = await prisma.fieldLinkGroup.findMany({
    where: { productId },
    select: {
      fieldKey: true,
      variantId: true,
      translatePolicy: true,
      sourceLanguage: true,
      members: true,
    },
  })
  return groups as unknown as FieldLinkGroupLike[]
}

/**
 * Generate the dry-run payload for one product against one
 * marketplace's mapping rules.
 */
export async function previewPayload(input: {
  productId: string
  channel: string
  marketplace: string
  locale?: string
}): Promise<PreviewResult> {
  const { productId, channel, marketplace, locale = 'en' } = input

  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw new Error(`Product not found: ${productId}`)
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId } })
    : null

  // FM.1 — resolve the effective rule set for this product's type.
  const rules = await getResolvedRules(channel, marketplace, product.productType)
  const channelListing = await prisma.channelListing.findFirst({
    where: { productId, channel, marketplace },
  })

  // FM.2 — provenance-carrying resolve (vs the flat map) so the resolver
  // can detect per-coordinate overrides; link groups enrich provenance +
  // the needs-translation flag without changing the value.
  const resolvedAttrs = resolveAttributes({
    product: product as any,
    parent: parent as any,
    channelListing: channelListing as any,
    locale,
  })
  const linkGroups = await loadFieldLinkGroups(productId)
  // FM.4 — value-map / size-scale lookups for the data-backed transform
  // ops (cached; inert until a rule uses valueMap/sizeScale).
  const lookupValueMap = await loadValueMapLookup(channel, marketplace)
  const lookupSizeScale = await loadSizeScaleLookup()

  const fields: PreviewField[] = []
  const payload: Record<string, unknown> = {}
  const missingRequired: string[] = []

  for (const fieldKey of Object.keys(rules)) {
    const rule = rules[fieldKey]
    if (!rule) continue

    // Preview is product-level → match PARENT link groups (variantId null).
    const link = linkForCoordinate(linkGroups, fieldKey, channel, marketplace, null)
    const r = resolveChannelField({
      fieldKey,
      rule,
      resolvedAttrs,
      product: product as any,
      locale,
      link,
      transformCtx: { lookupValueMap, lookupSizeScale },
    })

    if (isPresent(r.value)) {
      payload[fieldKey] = r.value
    } else if (r.required) {
      missingRequired.push(fieldKey)
    }

    fields.push({
      fieldKey,
      rule,
      value: r.value,
      source: r.legacySource,
      provenance: r.source,
      needsTranslation: r.needsTranslation,
      raw: r.raw,
      appliedTransforms: r.appliedTransforms,
      warnings: r.warnings,
      required: r.required,
    })
  }

  return {
    productId,
    productSku: product.sku,
    channel,
    marketplace,
    payload,
    fields,
    missingRequired,
  }
}
