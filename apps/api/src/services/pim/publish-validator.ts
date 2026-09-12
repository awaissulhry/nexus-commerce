/** Validate the same effective values, transforms and constraints as preview and the grid. */
import { resolveBatch } from './mapping/resolve-batch.service.js'
import type { FieldMappingRule } from './schema-mapping.service.js'
import { isPresent } from './resolve-channel-field.js'
export { resolveSourcePath } from './resolve-channel-field.js'

export interface FieldValidationError {
  fieldKey: string
  rule: FieldMappingRule
  /** Why this field failed: 'missing_required' | 'unresolved_source' |
   *  'fallback_also_missing'. UI groups by code. */
  code: 'missing_required' | 'unresolved_source' | 'fallback_also_missing' | 'invalid_value' | 'translation_pending' | 'schema_unavailable'
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
  /** Fields required by the selected category or mapping rule. */
  requiredFields: number
  errors: FieldValidationError[]
  /** Convenience: true when errors.length === 0. */
  ok: boolean
}

export async function validatePublish(input: {
  channelConnectionId?: string | null
  aliasKey?: string
  productId: string
  channel: string
  marketplace: string
  locale?: string
}): Promise<ValidationResult> {
  const result = await resolveBatch({ ...input, productIds: [input.productId], includeCatalogue: false })
  const product = result.products[0]
  if (!product) throw new Error(`Product not found: ${input.productId}`)
  const cells = Object.values(product.cells)
  const errors: FieldValidationError[] = cells.flatMap(cell => cell.errors.map(message => ({
    fieldKey: cell.fieldKey,
    rule: cell.rule ?? { source: '' },
    code: cell.required && !isPresent(cell.value) ? 'missing_required' as const : 'invalid_value' as const,
    message,
    resolvedSource: cell.raw ?? null,
    resolvedFallback: cell.legacySource === 'fallback' ? cell.value : null,
  })))
  for (const cell of cells.filter(cell => cell.needsTranslation)) errors.push({ fieldKey: cell.fieldKey, rule: cell.rule ?? { source: '' },
    code: 'translation_pending', message: 'Translation must complete before publishing this field.', resolvedSource: cell.raw, resolvedFallback: null })
  if (product.readiness?.schemaValidation !== undefined && product.readiness.schemaValidation !== 'evaluated') errors.push({ fieldKey: 'category', rule: { source: '' },
    code: 'schema_unavailable', message: 'Category schema validation is missing or unavailable. Refresh the schema before publishing.', resolvedSource: null, resolvedFallback: null })
  return { productId: product.productId, productSku: product.sku, channel: result.channel,
    marketplace: result.marketplace, totalFields: cells.length,
    requiredFields: cells.filter(cell => cell.required).length, errors, ok: errors.length === 0 }
}
