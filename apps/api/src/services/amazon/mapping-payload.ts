import type { ChannelSpec } from '../pim/channel-specs/types.js'
import type { ResolveBatchResult } from '../pim/mapping/resolve-batch.service.js'
import { attributeDeleteValue, attributesFromCells, validateSchemaAttributes } from '../pim/mapping/schema-requirements.js'
import { isPresent } from '../pim/resolve-channel-field.js'

export interface AttributePatch { op: 'replace' | 'delete'; path: string; value?: unknown }

type MappedField = { fieldKey: string; sourceOwner?: unknown; schemaKnown?: boolean }

/**
 * A-33 (R-31) — the ONE serializer of mapped Amazon attribute roots, shared by the studio / cockpit feed (below) and the
 * mapping cascade (`pim/mapping/prepare-dispatch.ts`). They had drifted: `e0791ea9d` (2026-09-14, the GALE import) made the
 * studio clear an attribute by its schema selectors "instead of deleting by name alone", and the cascade kept deleting by
 * name alone. One function, so a fix cannot land in one builder again.
 *
 * A root that also holds listing-owned leaves is refused: a partial envelope would overwrite them.
 */
export function mappedAmazonRoots(spec: ChannelSpec, catalogue: readonly MappedField[], cells: Record<string, { value?: unknown } | undefined>, roots: ReadonlySet<string>): Record<string, unknown> {
  for (const root of roots) {
    if (spec.fields.some(f => f.attribute === root && catalogue.some(field => field.fieldKey === f.key && field.sourceOwner))) {
      throw new Error(`The mixed ownership of ${root} requires a structured listing edit.`)
    }
  }
  const mapped = new Set(catalogue.filter(f => !f.sourceOwner && f.schemaKnown !== false).map(f => f.fieldKey))
  return attributesFromCells(spec, Object.fromEntries(spec.fields.filter(f => roots.has(f.attribute) && mapped.has(f.key)).map(f => [f.key, cells[f.key]?.value])))
}

/** A-33 — one root as a listing patch. A clear names the instance by the schema's selector values (`attributeDeleteValue`). */
export function amazonRootPatch(spec: ChannelSpec, root: string, value: unknown, deleteInstances?: readonly unknown[]): AttributePatch {
  return value === undefined
    ? { op: 'delete', path: `/attributes/${root}`, value: attributeDeleteValue(spec, root, deleteInstances) }
    : { op: 'replace', path: `/attributes/${root}`, value }
}
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
  const roots = new Set(spec.fields.filter(f => fields.some(field => field.fieldKey === f.key)).map(f => f.attribute))
  // A-33 — the shared serializer; it also refuses a root with listing-owned leaves.
  const attributes = mappedAmazonRoots(spec, result.catalogue.fields, product.cells, roots)
  const next = { ...(message.attributes ?? {}) }
  const removed = new Set<string>()
  for (const root of roots) {
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
      ...Object.entries(next).map(([key, value]) => amazonRootPatch(spec, key, value)),
      ...[...removed].map(key => amazonRootPatch(spec, key, undefined)),
    ]
    delete message.attributes
  } else message.attributes = next
  return JSON.stringify(envelope)
}
