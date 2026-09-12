import { z } from 'zod'
import { informationTranslationSchema, type InformationTranslationValue } from './shopify-information-translations.js'
export { informationTranslationSchema, nativeTranslationKeys, type InformationTranslation, type InformationTranslationValue } from './shopify-information-translations.js'
import { inventoryEditError, type InformationInventory } from './shopify-information-inventory.js'
export { informationInventorySchema, inventoryEditError, type InformationInventory } from './shopify-information-inventory.js'
import { shopifyTypeReason } from './shopify-field-codecs.js'
import type { ShopifyFieldDefinition, ShopifyFieldSnapshot, ShopifyStoreSchema } from './shopify-linked-products.js'

export const informationGroups = ['General', 'Publishing', 'Pricing', 'Inventory', 'Shipping', 'SEO', 'Metafields', 'Category Metafields'] as const
export type InformationGroup = typeof informationGroups[number]
export interface InformationField {
  id: string; label: string; group: InformationGroup; owner: 'PRODUCT' | 'PRODUCTVARIANT'; source: string | null
  type: string; width: number; editor: 'scalar' | 'typed' | 'media' | 'unavailable'; reason?: string
  definition?: ShopifyFieldDefinition; cardinality: 'scalar' | 'list'; sortable: boolean; filterable: boolean
  permission: 'products.edit'; discovery: 'adapter' | 'definition'
  /** Original Shopify name for native fields; display labels never change field identities. */
  channelLabel?: string
  currency?: string
}
type Core = [string, string, InformationGroup, 'PRODUCT' | 'PRODUCTVARIANT', string, string?]
const P = 'PRODUCT', V = 'PRODUCTVARIANT'
/** Confirmed Nexus equivalents, independent of editable mapping rules and store definitions. */
const nexusLabels: Record<string, string> = { title: 'Name', vendor: 'Brand', harmonizedSystemCode: 'HS code' }
/** Native fields describe the connector capabilities. Custom fields come only from the selected store. */
const core: Core[] = [
  ['title', 'Title', 'General', P, 'single_line_text_field'],
  ['descriptionHtml', 'Description', 'General', P, 'multi_line_text_field'],
  ['media', 'Product media', 'General', P, 'media'],
  ['tags', 'Tags', 'General', P, 'list.single_line_text_field'],
  ['status', 'Status', 'General', P, 'status'],
  ['category', 'Product category', 'General', P, 'category'],
  ['productType', 'Product type', 'General', P, 'single_line_text_field'],
  ['vendor', 'Vendor', 'General', P, 'single_line_text_field'],
  ['templateSuffix', 'Theme template', 'General', P, 'single_line_text_field'],
  ['salesChannels', 'Sales channels', 'Publishing', P, 'publication'],
  ['scheduled', 'Online store schedule', 'Publishing', P, 'boolean', 'Computed from publication schedules. Edit Sales channels to add, change or remove a schedule.'],
  ['publishDate', 'Publish date', 'Publishing', P, 'date_time', 'Shopify’s recorded Online Store publication date. Not set when unpublished. Edit Sales channels to manage publication and future schedules.'],
  ['price', 'Base price', 'Pricing', V, 'money'],
  ['unitPriceMeasurement', 'Unit price', 'Pricing', V, 'measurement'],
  ['compareAtPrice', 'Compare-at price', 'Pricing', V, 'money'],
  ['cost', 'Cost', 'Pricing', V, 'money'],
  ['taxable', 'Charge taxes', 'Pricing', V, 'boolean'],
  ['sku', 'SKU', 'Inventory', V, 'single_line_text_field'],
  ['barcode', 'Barcode', 'Inventory', V, 'single_line_text_field'],
  ['inventory', 'Inventory quantity', 'Inventory', V, 'inventory'],
  ['inventoryPolicy', 'Continue selling when out of stock', 'Inventory', V, 'inventory_policy'],
  ['tracked', 'Track quantity', 'Inventory', V, 'boolean'],
  ['package', 'Package', 'Shipping', V, 'package', 'Shopify API 2026-07 accepts a package ID but exposes neither a package catalog nor the assigned package on InventoryItemMeasurement. Nexus cannot discover or verify a package change. Manage it in Shopify.'],
  ['weight', 'Weight', 'Shipping', V, 'weight'],
  ['requiresShipping', 'Physical product', 'Shipping', V, 'boolean'],
  ['harmonizedSystemCode', 'Harmonized system code', 'Shipping', V, 'single_line_text_field'],
  ['countryCodeOfOrigin', 'Country of origin', 'Shipping', V, 'country'],
  ['seo.title', 'SEO title', 'SEO', P, 'single_line_text_field'],
  ['seo.description', 'SEO description', 'SEO', P, 'multi_line_text_field'],
  ['handle', 'URL handle', 'SEO', P, 'handle'],
]
/** Owner + namespace + key remains stable across definition renames and recreation. */
export const informationMetafieldId = (owner: string, namespace: string, key: string) => `metafield:${owner}:${namespace}.${key}`

/** Mapping identity is store- and type-specific; labels never determine a source match. */
export function shopifyMappingFieldKey(field: InformationField, accountId: string): string {
  // The common sheet reserves `sku` for Nexus row identity. Shopify's editable inventory SKU
  // is a separate listing attribute and must not disappear into that identity band.
  if (field.id === 'sku' && !field.definition) return 'listing_sku'
  if (!field.definition) return field.id.replace(/^seo\./, 'seo_')
  return ['shopify_metafield', accountId, field.owner, field.definition.namespace, field.definition.key, field.type]
    .map(encodeURIComponent).join(':')
}

export function informationRegistry(schema: ShopifyStoreSchema | null): InformationField[] {
  const result: InformationField[] = core.map(([id, label, group, owner, type, reason]) => ({ id, label: nexusLabels[id] ?? label,
    channelLabel: id === 'price' ? 'Price' : label, group, owner, source: id, type,
    width: ['title', 'descriptionHtml', 'media'].includes(id) ? 360 : label.length > 23 ? 240 : 160,
    editor: reason ? 'unavailable' : id === 'media' ? 'media' : 'scalar', reason, cardinality: type.startsWith('list.') || id === 'media' ? 'list' : 'scalar',
    sortable: false, filterable: false, permission: 'products.edit', discovery: 'adapter' }))
  const fields = new Map<string, InformationField>()
  for (const def of schema?.definitions ?? []) {
    if (def.ownerType !== P && def.ownerType !== V) continue
    const id = informationMetafieldId(def.ownerType, def.namespace, def.key)
    fields.set(id, {
      id, label: def.name, group: def.namespace === 'shopify' ? 'Category Metafields' : 'Metafields', owner: def.ownerType,
      source: `${def.namespace}.${def.key}`, type: def.type, width: 240, definition: def, ...(def.type === 'money' && schema?.currency ? { currency: schema.currency } : {}),
      editor: def.readOnlyReason || shopifyTypeReason(def.type) ? 'unavailable' : 'typed', reason: def.readOnlyReason ?? shopifyTypeReason(def.type) ?? undefined,
      cardinality: def.type.startsWith('list.') ? 'list' : 'scalar', sortable: false, filterable: false, permission: 'products.edit', discovery: 'definition',
    })
  }
  return [...result, ...[...fields.values()].sort((a, b) => informationGroups.indexOf(a.group) - informationGroups.indexOf(b.group) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))].map(field => {
    const reason = field.reason ?? nativeCapabilityReason(schema, field)
    return reason ? { ...field, reason, editor: 'unavailable' as const } : field
  })
}

export function nativeCapabilityReason(schema: ShopifyStoreSchema | null, field: InformationField): string | undefined {
  const cap = schema?.native
  if (!cap) return undefined
  if (!cap.scopes.includes('write_products')) return 'This Shopify connection needs write_products permission. Reconnect the store with product editing access.'
  if (field.id === 'inventory') return cap.scopes.includes('write_inventory') ? undefined : 'This Shopify connection needs write_inventory permission to adjust stock.'
  if (field.id === 'salesChannels') return cap.scopes.includes('write_publications') ? undefined : 'This Shopify connection needs write_publications permission. Reconnect the store with publication editing access.'
  if (field.definition || field.id === 'media') return undefined
  const inventory = ['sku', 'requiresShipping', 'harmonizedSystemCode', 'countryCodeOfOrigin', 'cost', 'tracked'].includes(field.id)
  const input = field.id === 'weight' ? 'measurement' : inventory ? 'inventory' : field.owner === 'PRODUCT' ? 'product' : 'variant'
  const key = field.id.startsWith('seo.') ? 'seo' : field.id
  if (nativeFieldKeys.includes(field.id as NativeEdit['field']) && !cap.inputs[input]?.includes(key)) return `Shopify API 2026-07 does not expose ${key} in this store’s ${input} input. Refresh the connection capabilities.`
  return undefined
}

export function nativeSchemaError(schema: ShopifyStoreSchema, edit: NativeEdit): string | null {
  if (edit.field === 'translation') {
    if (!edit.translation || !schema.locales.some(l => l.locale === edit.translation!.locale && !l.primary)) return 'Choose a non-primary language enabled in this Shopify store.'
    if (!schema.native?.scopes.includes('write_translations')) return 'This Shopify connection needs write_translations permission.'
    const field = informationRegistry(schema).find(f => f.id === edit.translation!.fieldId)
    return !field ? 'Refresh the source field definition.' : field.reason ?? nativeFieldError(edit)
  }
  const field = informationRegistry(schema).find(f => f.id === edit.field)
  if (!field) return 'Refresh the Shopify field schema.'
  if (field.reason) return field.reason
  const basic = nativeFieldError(edit)
  if (basic || edit.nextValue === null || !schema.native) return basic
  const enumKey = ({ status: 'status', countryCodeOfOrigin: 'country', inventoryPolicy: 'inventoryPolicy' } as Record<string, string>)[edit.field]
  if (enumKey && !schema.native.enums[enumKey]?.some(c => c.name === edit.nextValue)) return 'Choose a value accepted by this store’s Shopify API.'
  if (edit.field === 'salesChannels') {
    for (const value of JSON.parse(edit.nextValue)) {
      const publication = schema.publications?.find(p => p.id === value.publicationId)
      if (!publication) return 'Choose a publication available in this store.'
      if (value.publishDate && !publication.supportsFuturePublishing) return 'This Shopify publication does not support scheduling.'
    }
  }
  if (edit.field === 'unitPriceMeasurement') {
    const value = JSON.parse(edit.nextValue)
    if (![value.quantityUnit, value.referenceUnit].every(unit => schema.native!.enums.unitPrice?.some(c => c.name === unit))) return 'Choose units accepted by this store’s Shopify API.'
  }
  return null
}

export const nativeFieldKeys = ['title', 'descriptionHtml', 'tags', 'productType', 'vendor', 'price', 'compareAtPrice', 'taxable', 'sku', 'inventoryPolicy', 'requiresShipping', 'harmonizedSystemCode', 'seo.title', 'seo.description', 'status', 'category', 'templateSuffix', 'unitPriceMeasurement', 'cost', 'barcode', 'tracked', 'weight', 'countryCodeOfOrigin', 'handle', 'salesChannels', 'inventory', 'translation'] as const
const ownerId = z.string().regex(/^gid:\/\/shopify\/(Product|ProductVariant)\/\d+$/)
export const nativeEditSchema = z.object({ ownerId, productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/), field: z.enum(nativeFieldKeys), value: z.string().nullable(), nextValue: z.string().nullable(), ownerLabel: z.string().max(1000), translation: informationTranslationSchema.optional() }).strict()
export const informationMediaSchema = z.object({ id: z.string().regex(/^gid:\/\/shopify\/(MediaImage|Video|ExternalVideo|Model3d)\/\d+$/), alt: z.string().max(2000), type: z.string(), status: z.string(),
  preview: z.string().nullable(), url: z.string().nullable(), sources: z.array(z.object({ url: z.string(), mimeType: z.string().optional() })).optional(),
})
export const mediaOrderEditSchema = z.object({ productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/), ownerLabel: z.string().max(1000),
  value: z.array(z.string().regex(/^gid:\/\/shopify\/(MediaImage|Video|ExternalVideo|Model3d)\/\d+$/)).max(250),
  nextValue: z.array(z.string().regex(/^gid:\/\/shopify\/(MediaImage|Video|ExternalVideo|Model3d)\/\d+$/)).max(250),
  membershipChanged: z.literal(true).optional(), added: z.array(informationMediaSchema).max(250).optional(),
  altEdits: z.array(z.object({ id: z.string(), value: z.string().max(2000), nextValue: z.string().max(2000) }).strict()).max(250).optional(),
  sharedAltConfirmed: z.literal(true).optional(),
  affectedVariants: z.array(z.object({ id: z.string(), title: z.string(), mediaIds: z.array(z.string()) })).max(10000).optional(),
}).strict().refine(e => new Set(e.value).size === e.value.length && new Set(e.nextValue).size === e.nextValue.length && (e.membershipChanged || e.value.length === e.nextValue.length && e.value.every(id => e.nextValue.includes(id)))
  && e.nextValue.filter(id => !e.value.includes(id)).every(id => e.added?.some(m => m.id === id)) && (e.added ?? []).every(m => e.nextValue.includes(m.id) && !e.value.includes(m.id))
  && new Set(e.altEdits?.map(e => e.id)).size === (e.altEdits?.length ?? 0) && (e.altEdits ?? []).every(a => e.nextValue.includes(a.id)) && (!e.altEdits?.length || e.sharedAltConfirmed), 'Review gallery membership and shared-file metadata before applying this change.')
export type NativeEdit = z.infer<typeof nativeEditSchema>
export const nativeEditAddress = (edit: Pick<NativeEdit, 'ownerId' | 'field' | 'translation'>) => JSON.stringify([edit.ownerId, edit.field, edit.translation?.fieldId, edit.translation?.locale])
export type MediaOrderEdit = z.infer<typeof mediaOrderEditSchema>
/** Money comparison is decimal-string based; never round through a JavaScript number. */
export function nativeValuesEqual(field: string, a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b
  if (field === 'tags') {
    try {
      const left = JSON.parse(a), right = JSON.parse(b)
      if (Array.isArray(left) && Array.isArray(right) && [...left, ...right].every(v => typeof v === 'string')) return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    } catch { /* Malformed values remain different and go through validation. */ }
  }
  if (field === 'salesChannels') {
    try { return JSON.stringify(JSON.parse(a).sort((a: { publicationId: string }, b: { publicationId: string }) => a.publicationId.localeCompare(b.publicationId))) === JSON.stringify(JSON.parse(b).sort((a: { publicationId: string }, b: { publicationId: string }) => a.publicationId.localeCompare(b.publicationId))) } catch { return a === b }
  }
  if (['weight', 'unitPriceMeasurement', 'inventory'].includes(field)) {
    try {
      const normalize = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)])) : value
      return JSON.stringify(normalize(JSON.parse(a))) === JSON.stringify(normalize(JSON.parse(b)))
    } catch { return a === b }
  }
  if (!['price', 'compareAtPrice', 'cost'].includes(field)) return a === b
  const decimal = (s: string) => /^\d+(\.\d+)?$/.test(s) ? s.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : s
  return decimal(a) === decimal(b)
}
export interface InformationMedia { id: string; alt: string; type: string; status: string; preview: string | null; url: string | null; sources?: Array<{ url: string; mimeType?: string }> }
export interface InformationRow { id: string; productId: string; title: string; handle: string; kind: 'PRODUCT' | 'PRODUCTVARIANT'; image: string | null; values: Record<string, string | null>; fields: ShopifyFieldSnapshot[]; media: InformationMedia[]; locale?: string; translations?: Record<string, InformationTranslationValue> }
export interface InformationSnapshot { currency: string; timezone: string; rows: InformationRow[] }
export const nativeNullableFields: readonly string[] = ['compareAtPrice', 'seo.title', 'seo.description', 'harmonizedSystemCode', 'countryCodeOfOrigin', 'cost', 'category']
/** Inventory verification checks intended quantity changes; Shopify owns the companion state. */
export function nativeEditVerified(edit: NativeEdit, actual: string | null | undefined): boolean {
  if (edit.field !== 'inventory') return nativeValuesEqual(edit.field, actual, edit.nextValue)
  try {
    const before: InformationInventory = JSON.parse(edit.value!), after: InformationInventory = JSON.parse(edit.nextValue!), live: InformationInventory = JSON.parse(actual!)
    return live.inventoryItemId === after.inventoryItemId && live.tracked === after.tracked && after.locations.every(l => {
      const old = before.locations.find(b => b.locationId === l.locationId), now = live.locations.find(b => b.locationId === l.locationId)
      return old && now && (['available', 'onHand'] as const).every(key => old[key] === l[key] || now[key] === l[key])
    })
  } catch { return false }
}
export function nativeFieldError(edit: NativeEdit): string | null {
  if (edit.field === 'translation') return !edit.translation ? 'The translation destination is missing.' : edit.nextValue !== null && edit.nextValue.length > 2000000 ? 'The translation is too long.' : null
  if (edit.translation) return 'Use a translation operation for localized content.'
  const field = core.find(f => f[0] === edit.field)
  if (!field || field[5] || (field[3] === P ? edit.ownerId !== edit.productId : !edit.ownerId.includes('/ProductVariant/'))) return 'This field does not belong to this row.'
  return nativeFieldValueError(edit.field, edit.nextValue, edit.value)
}
export function nativeFieldValueError(key: NativeEdit['field'], raw: string | null, baseline: string | null = null): string | null {
  const field = core.find(f => f[0] === key)
  if (!field || field[5]) return field?.[5] ?? 'This Shopify field is unavailable.'
  const edit = { field: key, nextValue: raw, value: baseline }
  if (edit.field === 'inventory') return inventoryEditError(edit.value, raw)
  if (raw === null) return nativeNullableFields.includes(edit.field) ? null : 'Enter a value for this field.'
  if (raw.length > 60000) return 'This value is too long.'
  if (field[4] === 'money' && !/^\d+(\.\d{1,4})?$/.test(raw)) return 'Enter a nonnegative decimal amount with up to four decimal places.'
  if (field[4] === 'boolean' && !['true', 'false'].includes(raw)) return 'Choose True or False.'
  if (edit.field === 'inventoryPolicy' && !['DENY', 'CONTINUE'].includes(raw)) return 'Choose whether to continue selling.'
  if (edit.field === 'salesChannels') {
    try {
      const entries = JSON.parse(raw)
      if (!Array.isArray(entries) || entries.length > 250 || new Set(entries.map(p => p.publicationId)).size !== entries.length || entries.some(p => !p || !/^gid:\/\/shopify\/Publication\/\d+$/.test(p.publicationId) || Object.keys(p).some(k => !['publicationId', 'publishDate'].includes(k)) || (p.publishDate !== null && (typeof p.publishDate !== 'string' || !/Z$/.test(p.publishDate) || !Number.isFinite(Date.parse(p.publishDate)))))) return 'Choose unique store publications and valid UTC schedule dates.'
    } catch { return 'Choose the product publications.' }
  }
  if (edit.field === 'status' && !['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'].includes(raw)) return 'Choose a Shopify product status.'
  if (edit.field === 'countryCodeOfOrigin' && !/^[A-Z]{2}$/.test(raw)) return 'Choose a two-letter country code.'
  if (edit.field === 'category' && !/^gid:\/\/shopify\/TaxonomyCategory\/[a-zA-Z0-9-]+$/.test(raw)) return 'Choose a Shopify taxonomy category.'
  if (edit.field === 'handle' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return 'Use lowercase letters, numbers and separating hyphens.'
  if (edit.field === 'templateSuffix' && !/^[a-zA-Z0-9_-]*$/.test(raw)) return 'Enter a template suffix, or leave it empty for the default template.'
  if (edit.field === 'weight' || edit.field === 'unitPriceMeasurement') {
    try {
      const v = JSON.parse(raw)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Enter a measurement.'
      if (edit.field === 'weight') {
        if (typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < 0 || !['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS'].includes(v.unit) || Object.keys(v).some(k => !['value', 'unit'].includes(k))) return 'Enter a nonnegative weight and a Shopify weight unit.'
      } else if (typeof v.quantityValue !== 'number' || !Number.isFinite(v.quantityValue) || v.quantityValue <= 0 || !Number.isInteger(v.referenceValue) || v.referenceValue <= 0 || typeof v.quantityUnit !== 'string' || typeof v.referenceUnit !== 'string' || Object.keys(v).some(k => !['quantityValue', 'quantityUnit', 'referenceValue', 'referenceUnit'].includes(k))) return 'Enter positive quantity and reference measurements.'
    } catch { return 'Enter a valid measurement.' }
  }
  if (edit.field === 'title' && !raw.trim()) return 'Product title is required.'
  if (field[4] === 'single_line_text_field' && /[\r\n]/.test(raw)) return 'Use one line of text.'
  if (edit.field === 'tags') { try { const tags = JSON.parse(raw); if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string' || !t.trim()) || new Set(tags).size !== tags.length) return 'Enter unique, nonempty tags.' } catch { return 'Enter a list of tags.' } }
  return null
}
export function moveMedia(ids: readonly string[], id: string, position: number): string[] {
  if (!Number.isInteger(position) || position < 0 || position >= ids.length || !ids.includes(id)) return [...ids]
  const next = ids.filter(item => item !== id); next.splice(position, 0, id); return next
}
export function mediaMoves(before: readonly string[], after: readonly string[]) {
  if (before.length !== after.length || new Set(before).size !== before.length || new Set(after).size !== after.length || before.some(id => !after.includes(id))) throw new Error('Gallery membership changed. Review the latest gallery before reordering.')
  let current = [...before]
  return after.flatMap((id, index) => { if (current[index] === id) return []; current = moveMedia(current, id, index); return [{ id, newPosition: String(index) }] })
}

export { informationPendingValue, informationStoredValue, informationSheetValue, type ShopifySheetWrite, type ShopifySheetRow } from './shopify-sheet.js'
