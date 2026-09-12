/** Preview and validation consume the same effective values as the mapping grid. */
import prisma from '../../db.js'
import { resolveBatch, type ResolveBatchResult } from './mapping/resolve-batch.service.js'
import type { FieldMappingRule, TransformOp } from './schema-mapping.service.js'
import { isPresent, type ChannelFieldSource, type FieldLinkGroupLike } from './resolve-channel-field.js'

export interface PreviewField {
  fieldKey: string
  label?: string
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
  errors?: string[]
  required: boolean
}

export interface PreviewResult {
  productId: string
  productSku: string
  channel: string
  marketplace: string
  categoryId?: string | null
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

export async function previewPayload(input: {
  channelConnectionId?: string | null
  aliasKey?: string
  productId: string
  channel: string
  marketplace: string
  locale?: string
}): Promise<PreviewResult> {
  const result = await resolveBatch({ ...input, productIds: [input.productId], includeCatalogue: false })
  return previewFromResolution(result, input.productId)
}

/** Reuse an existing resolution when a workflow also needs provenance or a baseline. */
export function previewFromResolution(result: ResolveBatchResult, productId: string): PreviewResult {
  const product = result.products[0]
  if (!product) throw new Error(`Product not found: ${productId}`)
  const payload: Record<string, unknown> = {}
  const missingRequired: string[] = []
  const fields: PreviewField[] = Object.values(product.cells).map(cell => {
    if (isPresent(cell.value)) payload[cell.fieldKey] = cell.value
    else if (cell.required) missingRequired.push(cell.fieldKey)
    return {
      fieldKey: cell.fieldKey,
      label: result.catalogue?.fields.find(field => field.fieldKey === cell.fieldKey)?.label,
      rule: cell.rule ?? { source: '' },
      value: cell.value,
      source: cell.legacySource ?? (isPresent(cell.value) ? 'source' : 'missing'),
      provenance: (cell.provenance ?? 'missing') as ChannelFieldSource,
      needsTranslation: cell.needsTranslation,
      raw: cell.raw ?? null,
      appliedTransforms: cell.appliedTransforms as TransformOp['type'][],
      warnings: [...cell.warnings, ...cell.errors],
      errors: cell.errors,
      required: cell.required,
    }
  })
  return { productId: product.productId, productSku: product.sku, channel: result.channel,
    marketplace: result.marketplace, categoryId: product.category.channelCategoryId, payload, fields, missingRequired }
}
