import { nativeFieldError, nativeFieldValueError, nativeValuesEqual, nativeEditAddress, type InformationField, type InformationRow, type NativeEdit } from './shopify-information.js'
import { fieldAddress, validateShopifyField, shopifyDefinitionApplicability, type ShopifyLinkedDraft } from './shopify-linked-products.js'

export function informationRestriction(row: InformationRow, field: InformationField, draft: ShopifyLinkedDraft, disabled: boolean): string | null {
  if (row.kind !== field.owner) return `This field belongs to ${field.owner === 'PRODUCT' ? 'the product' : 'a variant'}.`
  if (disabled) return 'Editing is unavailable during synchronization or without product edit permission.'
  if (field.reason) return field.reason
  if (row.locale && !row.translations?.[field.id]) return field.definition && !row.fields.some(f => f.namespace === field.definition!.namespace && f.key === field.definition!.key)
    ? 'Create and synchronize this field in the store’s primary language before adding a translation.'
    : 'Shopify shares this field across languages. Select the store’s primary language to edit its base value.'
  if (field.definition) {
    const applicability = shopifyDefinitionApplicability(field.definition, row.values.category)
    if (applicability) return applicability
    if (field.definition.constraints?.key && draft.nativeEdits?.some(e => e.ownerId === row.productId && e.field === 'category')) return 'Synchronize the category change before editing its category-specific fields.'
    const stored = row.fields.find(f => f.namespace === field.definition!.namespace && f.key === field.definition!.key)
    const pending = draft.edits.find(f => f.ownerId === row.id && f.namespace === field.definition!.namespace && f.key === field.definition!.key)
    if ([stored, pending].some(f => f && f.type !== field.type)) return 'The metafield type changed in Shopify. Review the stored value and pending edit before editing.'
  }
  if (field.definition && row.kind === 'PRODUCT') {
    const def = field.definition, rel = draft.relationship
    if (rel?.namespace === def.namespace && rel.key === def.key) return 'This field is managed by Product family to keep linked products consistent.'
    const rule = draft.sharedFields?.find(r => r.namespace === def.namespace && r.key === def.key)
    if (rule && rule.sourceProductId !== row.id && !rule.excludedProductIds.includes(row.id)) return 'This product follows shared content. Open sharing rules to create an individual override.'
  }
  return null
}
export interface InformationCellChange { row: InformationRow; field: InformationField; value: string | null }
/** One semantic command over existing identities; callers keep the prior draft for undo. */
export function applyInformationCells(draft: ShopifyLinkedDraft, cells: InformationCellChange[], rows: InformationRow[], disabled: boolean): ShopifyLinkedDraft {
  if (cells.length > 10000) throw new Error('Apply at most 10,000 cells in one command.')
  const next = structuredClone(draft)
  for (const { row, field, value } of cells) {
    const reason = informationRestriction(row, field, draft, disabled)
    if (reason) throw new Error(`${row.title} / ${field.label}: ${reason}`)
    const ownerLabel = row.kind === 'PRODUCT' ? row.title : `${rows.find(r => r.id === row.productId)?.title ?? row.handle} / ${row.title}`
    if (row.locale) {
      const source = row.translations?.[field.id]
      if (!source) throw new Error('This field has no independent value in the selected language.')
      const error = value === null ? null : field.definition ? validateShopifyField(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value)
      if (error) throw new Error(error)
      const { value: baseline, sourceValue: _source, outdated: _outdated, ...translation } = source
      const address = { ownerId: row.id, field: 'translation' as const, translation }
      const existing = next.nativeEdits?.find(e => nativeEditAddress(e) === nativeEditAddress(address))
      const edit: NativeEdit = { ...address, productId: row.productId, ownerLabel, value: existing ? existing.value : baseline, nextValue: value }
      next.nativeEdits = (next.nativeEdits ?? []).filter(e => nativeEditAddress(e) !== nativeEditAddress(edit))
      if (edit.value !== edit.nextValue) next.nativeEdits.push(edit)
      continue
    }
    if (field.definition) {
      const error = validateShopifyField(field.definition, value)
      if (error) throw new Error(`${ownerLabel} / ${field.label}: ${error}`)
      const address = { ownerId: row.id, namespace: field.definition.namespace, key: field.definition.key }
      const base = next.edits.find(e => fieldAddress(e) === fieldAddress(address)) ?? row.fields.find(e => fieldAddress(e) === fieldAddress(address)) ?? { ...address, type: field.type, value: null, compareDigest: null }
      next.edits = next.edits.filter(e => fieldAddress(e) !== fieldAddress(address))
      if (base.value !== value) next.edits.push({ ...base, nextValue: value, ownerLabel })
    } else {
      if (!(field.id in row.values)) throw new Error(`${field.label} is unavailable on this row.`)
      const base = next.nativeEdits?.find(e => e.ownerId === row.id && e.field === field.id)
      const edit: NativeEdit = { ownerId: row.id, productId: row.productId, field: field.id as NativeEdit['field'], value: base ? base.value : row.values[field.id], nextValue: value, ownerLabel }
      const error = nativeFieldError(edit)
      if (error) throw new Error(`${ownerLabel} / ${field.label}: ${error}`)
      next.nativeEdits = (next.nativeEdits ?? []).filter(e => !(e.ownerId === row.id && e.field === field.id))
      if (!nativeValuesEqual(edit.field, edit.value, edit.nextValue)) next.nativeEdits.push(edit)
    }
  }
  if (!next.members.length && (next.edits.length || next.nativeEdits?.length)) { next.informationOnly = true; next.members = rows.filter(r => r.kind === 'PRODUCT').map(r => ({ id: r.id, title: r.title, handle: r.handle, image: r.image })) }
  return next
}
