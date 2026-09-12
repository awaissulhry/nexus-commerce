import type { ChannelSpec } from '../pim/channel-specs/types.js'
import type { ResolveBatchResult } from '../pim/mapping/resolve-batch.service.js'
import { attributesFromCells, validateSchemaAttributes } from '../pim/mapping/schema-requirements.js'
import { isPresent } from '../pim/resolve-channel-field.js'

export interface AttributePatch { op: 'replace' | 'delete'; path: string; value?: unknown }
/** Overlay the real resolver outputs onto the actual JSON feed envelope. Pricing,
 * inventory, media and policy attributes retain their owning builder's values. */
export function applyResolvedMappingToAmazonFeed(feedBody: string, result: ResolveBatchResult, spec: ChannelSpec): string {
  if (!result.catalogue?.schema.present || spec.absent) throw new Error('Sync this category schema before publishing.')
  const product = result.products[0]
  if (!product) throw new Error('The product could not be resolved for publication.')
  const envelope = JSON.parse(feedBody)
  if (envelope.messages?.length !== 1) throw new Error('A product mapping requires exactly one feed message.')
  const message = envelope.messages[0]
  if (message.operationType === 'DELETE') return feedBody
  if (product.readiness?.schemaValidation === 'unavailable') throw new Error('Category validation is unavailable. Refresh the schema before publishing.')
  if (result.catalogue.fields.some(f => f.schemaKnown === false && product.cells[f.fieldKey]?.rule)) throw new Error('A saved mapping no longer exists in the category schema. Review it before publishing.')
  const fullUpdate = message.operationType === 'UPDATE'
  const fields = result.catalogue.fields.filter(f => !f.sourceOwner && f.schemaKnown !== false)
  const problems = fields.flatMap(field => {
    const cell = product.cells[field.fieldKey]
    if (!cell) return [`${field.label}: resolution is missing`]
    if (cell.needsTranslation) return [`${field.label}: translation is pending`]
    return fullUpdate || isPresent(cell.value) ? cell.errors.map(e => `${field.label}: ${e}`) : []
  })
  if (problems.length) throw new Error(`Mapping validation failed: ${problems.join('; ')}`)
  const values = Object.fromEntries(fields.map(f => [f.fieldKey, product.cells[f.fieldKey]?.value]))
  const attributes = attributesFromCells(spec, values)
  const roots = new Set(spec.fields.filter(f => fields.some(field => field.fieldKey === f.key)).map(f => f.attribute))
  const next = { ...(message.attributes ?? {}) }
  const removed = new Set<string>()
  for (const root of roots) {
    // A compound root with both listing-owned and mapped leaves needs a structured
    // owner merge; refuse to overwrite it with a partial envelope.
    if (spec.fields.some(f => f.attribute === root && result.catalogue!.fields.some(field => field.fieldKey === f.key && field.sourceOwner))) {
      throw new Error(`The mixed ownership of ${root} requires a structured listing edit.`)
    }
    delete next[root]
    if (attributes[root] !== undefined) next[root] = attributes[root]
    else if (spec.fields.some(f => f.attribute === root && product.cells[f.key]?.provenance === 'override')) removed.add(root)
  }
  message.productType = product.category.channelCategoryId ?? message.productType
  if (fullUpdate) {
    const errors = validateSchemaAttributes(spec, next)
    if (errors.length) throw new Error(`The completed listing payload is invalid: ${errors.join('; ')}`)
  }
  if (removed.size && !fullUpdate) {
    message.operationType = 'PATCH'
    message.patches = [
      ...Object.entries(next).map(([key, value]) => ({ op: 'replace', path: `/attributes/${key}`, value })),
      ...[...removed].map(key => ({ op: 'delete', path: `/attributes/${key}` })),
    ]
    delete message.attributes
  } else message.attributes = next
  return JSON.stringify(envelope)
}
