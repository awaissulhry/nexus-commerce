import { z } from 'zod'
import { shopifyJsonSchemaError, shopifyObjectBoundError } from './shopify-definition-validation.js'
export { shopifyJson } from './shopify-json.js'
import { shopifyObjectError, shopifyObjectType, shopifyTypeReason } from './shopify-field-codecs.js'
export { shopifyMeasurementUnits, shopifyObjectType, shopifyTypeReason, shopifyTypeSupported } from './shopify-field-codecs.js'
import { nativeEditSchema, mediaOrderEditSchema, nativeFieldError, nativeEditAddress, type InformationMedia, type NativeEdit, type MediaOrderEdit } from './shopify-information.js'

export const shopifyGid = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/)
export const shopifyProductGid = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/)
const address = { namespace: z.string().min(1).max(255), key: z.string().min(1).max(255) }
export const shopifyFieldSnapshotSchema = z.object({
  id: shopifyGid.optional(),
  ownerId: shopifyGid, ...address, type: z.string().min(1), value: z.string().nullable(), compareDigest: z.string().nullable(),
}).strict()
export const shopifyFieldEditSchema = shopifyFieldSnapshotSchema.extend({ nextValue: z.string().nullable(), ownerLabel: z.string().max(1000) })
export const shopifySharedFieldSchema = z.object({
  ...address, sourceProductId: shopifyProductGid, excludedProductIds: z.array(shopifyProductGid).max(2048),
  baseline: z.array(shopifyFieldSnapshotSchema).max(2048),
}).strict()
export type ShopifySharedField = z.infer<typeof shopifySharedFieldSchema>
export interface ShopifySharedSuggestion { name: string; rule: ShopifySharedField }
export const shopifyLinkedDraftSchema = z.object({
  version: z.literal(1),
  /** Editing existing listings does not opt into separate-product family publication. */
  informationOnly: z.literal(true).optional(),
  members: z.array(z.object({ id: shopifyProductGid, title: z.string().max(1000), handle: z.string(), image: z.string().nullable() }).strict()).max(2048),
  relationship: z.object({ ...address, includeSelf: z.boolean() }).strict().nullable(),
  baselineLinks: z.array(shopifyFieldSnapshotSchema).max(4096),
  edits: z.array(shopifyFieldEditSchema).max(10000),
  sharedFields: z.array(shopifySharedFieldSchema).max(100).optional(),
  nativeEdits: z.array(nativeEditSchema).max(10000).optional(),
  mediaEdits: z.array(mediaOrderEditSchema).max(2048).optional(),
  /** Durable listing pins are independent of pending synchronization commands. */
  sheetValues: z.array(z.object({ ownerId: shopifyGid, fieldId: z.string().min(1), type: z.string().min(1), locale: z.string(), value: z.string().nullable(), inherited: z.literal(true).optional() }).strict()).max(10000).optional(),
}).strict().superRefine((draft, ctx) => {
  if (draft.informationOnly && draft.relationship) ctx.addIssue({ code: 'custom', message: 'Choose Product family explicitly before managing product relationships.' })
  for (const [name, keys] of [
    ['members', draft.members.map(m => m.id)],
    ['baselineLinks', draft.baselineLinks.map(fieldAddress)],
    ['edits', draft.edits.map(fieldAddress)],
    ['sheetValues', (draft.sheetValues ?? []).map(sheetValueAddress)],
  ] as const) if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${name}.` })
  const rules = draft.sharedFields ?? [], members = new Set(draft.members.map(m => m.id))
  const nativeKeys = (draft.nativeEdits ?? []).map(nativeEditAddress)
  if (new Set(nativeKeys).size !== nativeKeys.length || new Set(draft.mediaEdits?.map(e => e.productId)).size !== (draft.mediaEdits?.length ?? 0)) ctx.addIssue({ code: 'custom', message: 'A cell or gallery can have only one pending change.' })
  for (const edit of draft.nativeEdits ?? []) {
    const error = nativeFieldError(edit)
    if (!members.has(edit.productId) || error) ctx.addIssue({ code: 'custom', message: error ?? 'The edited product must belong to this workspace.' })
  }
  if (draft.mediaEdits?.some(e => !members.has(e.productId))) ctx.addIssue({ code: 'custom', message: 'The gallery must belong to this workspace.' })
  if (new Set(rules.map(definitionAddress)).size !== rules.length) ctx.addIssue({ code: 'custom', message: 'A field can have only one shared-content rule.' })
  for (const rule of rules) {
    if (!members.has(rule.sourceProductId) || rule.excludedProductIds.some(id => !members.has(id)) || rule.excludedProductIds.includes(rule.sourceProductId))
      ctx.addIssue({ code: 'custom', message: 'Shared content sources and overrides must belong to this family.' })
    const followers = draft.members.filter(m => m.id !== rule.sourceProductId && !rule.excludedProductIds.includes(m.id))
    if (new Set(rule.baseline.map(fieldAddress)).size !== rule.baseline.length || rule.baseline.some(f => !members.has(f.ownerId) || f.namespace !== rule.namespace || f.key !== rule.key)
      || followers.some(m => !rule.baseline.some(f => f.ownerId === m.id))) ctx.addIssue({ code: 'custom', message: 'Read each shared-content destination before saving its rule.' })
    if (draft.relationship?.namespace === rule.namespace && draft.relationship.key === rule.key) ctx.addIssue({ code: 'custom', message: 'Family links cannot be a shared-content rule.' })
    if (draft.edits.some(e => e.namespace === rule.namespace && e.key === rule.key && followers.some(m => m.id === e.ownerId)))
      ctx.addIssue({ code: 'custom', message: 'Make a product override before editing inherited content.' })
  }
  if (draft.baselineLinks.some(f => !shopifyProductGid.safeParse(f.ownerId).success || f.type !== 'list.product_reference'
    || f.namespace !== draft.relationship?.namespace || f.key !== draft.relationship?.key))
    ctx.addIssue({ code: 'custom', message: 'The observed links must belong to the selected product relationship field.' })
  if (draft.relationship && draft.edits.some(f => f.namespace === draft.relationship!.namespace && f.key === draft.relationship!.key && f.ownerId.includes('/Product/')))
    ctx.addIssue({ code: 'custom', message: 'Edit the relationship field through Product family so every sibling stays consistent.' })
})
export type ShopifyLinkedDraft = z.infer<typeof shopifyLinkedDraftSchema>
export type ShopifyFieldSnapshot = z.infer<typeof shopifyFieldSnapshotSchema>
export type ShopifyFieldEdit = z.infer<typeof shopifyFieldEditSchema>
export type ShopifyLinkedMember = ShopifyLinkedDraft['members'][number]
export const emptyShopifyLinkedDraft = (): ShopifyLinkedDraft => ({ version: 1, members: [], relationship: null, baselineLinks: [], edits: [] })

/** Object-key order is transport detail; ordered reference/media arrays remain significant. */
export function linkedDraftSignature(draft: ShopifyLinkedDraft | null): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
  if (!draft) return 'null'
  const result = shopifyLinkedDraftSchema.safeParse(draft)
  const parsed = result.success ? result.data : draft
  return JSON.stringify(canonical({ ...parsed, nativeEdits: parsed.nativeEdits ?? [], mediaEdits: parsed.mediaEdits ?? [], sharedFields: parsed.sharedFields ?? [], sheetValues: parsed.sheetValues ?? [] }))
}
export const sheetValueAddress = (f: { ownerId: string; fieldId: string; locale: string }) => JSON.stringify([f.ownerId, f.fieldId, f.locale])
export const fieldAddress = (f: { ownerId: string; namespace: string; key: string }) => JSON.stringify([f.ownerId, f.namespace, f.key])
export const definitionAddress = (f: { namespace: string; key: string }) => `${f.namespace}.${f.key}`

/** Retain baselines for removed products so a replacement import can unlink them. */
export function mergeImportedLinkedFamily(current: ShopifyLinkedDraft, imported: ShopifyLinkedDraft): ShopifyLinkedDraft {
  const sameField = current.relationship?.namespace === imported.relationship?.namespace && current.relationship?.key === imported.relationship?.key
  if (!sameField && current.baselineLinks.length) throw new Error('Select the current relationship field before replacing this family.')
  const baseline = new Map(current.baselineLinks.map(f => [fieldAddress(f), f]))
  // Keep previous observations for existing members; importing must not silently
  // acknowledge an external edit. New members carry their freshly read baseline.
  for (const field of imported.baselineLinks) if (!baseline.has(fieldAddress(field))) baseline.set(fieldAddress(field), field)
  return { ...imported, baselineLinks: [...baseline.values()], edits: current.edits, ...(current.sharedFields ? { sharedFields: current.sharedFields } : {}), ...(current.nativeEdits ? { nativeEdits: current.nativeEdits } : {}), ...(current.mediaEdits ? { mediaEdits: current.mediaEdits } : {}), ...(current.sheetValues ? { sheetValues: current.sheetValues } : {}) }
}

export interface ShopifyFieldDefinition {
  id: string; name: string; description: string | null; namespace: string; key: string; ownerType: string; type: string
  validations: { name: string; value: string }[]; access: { admin: string | null; storefront: string | null }
  required?: boolean; readOnlyReason?: string | null
  constraints?: { key: string | null; values: string[] } | null
}
/** Shopify currently constrains product definitions by exact taxonomy category subtype. */
export function shopifyDefinitionApplicability(definition: ShopifyFieldDefinition, category: string | null | undefined): string | null {
  const constraints = definition.constraints
  if (!constraints?.key) return null
  if (constraints.key !== 'category') return `This definition uses a ${constraints.key} applicability rule that needs a Nexus adapter update. Its value is preserved.`
  if (!category) return 'Choose and synchronize a Shopify product category before editing this category-specific field.'
  const code = category.replace('gid://shopify/TaxonomyCategory/', '')
  return constraints.values.some(value => value.replace('gid://shopify/TaxonomyCategory/', '') === code) ? null : 'This field does not apply to the selected Shopify product category. Its existing value is preserved.'
}
export interface ShopifyMetaobjectDefinition {
  id: string; name: string; type: string; description: string | null
  access: { admin: string | null; storefront: string | null }; fields: ShopifyFieldDefinition[]; publishable?: boolean
}
export { shopifyReferenceError, shopifyReferenceTypes } from './shopify-reference-validation.js'
export interface ShopifyStoreSchema {
  definitions: ShopifyFieldDefinition[]; metaobjectDefinitions: ShopifyMetaobjectDefinition[]
  native?: { enums: Record<string, { name: string; description: string | null }[]>; scopes: string[]; inputs: Record<string, string[]> };
  publications?: { id: string; name: string; supportsFuturePublishing: boolean }[];
  currency?: string;
  types: { name: string; category: string }[]; locales: { locale: string; primary: boolean; published: boolean }[]; revision: string
}
export interface ShopifyFieldOwner {
  id: string; title: string; productId: string; ownerType: 'PRODUCT' | 'PRODUCTVARIANT'
  fields: ShopifyFieldSnapshot[]; variants: { id: string; title: string; sku: string | null }[]
}
export interface ShopifyReference { id: string; label: string; image: string | null; type?: string; handle?: string; available?: boolean; media?: InformationMedia }
export interface ShopifyReferencePage { items: ShopifyReference[]; cursor: string | null }
export interface ShopifyReusableEntry {
  id: string; type: string; handle: string; name: string; revision: string
  status?: 'ACTIVE' | 'DRAFT' | null
  fields: { key: string; type: string; value: string | null }[]; definition: ShopifyMetaobjectDefinition
  usedBy: { id: string; label: string }[]; moreUses: boolean
}
export interface ShopifyLinkedPlan {
  revision: string; schemaRevision: string; changes: ShopifyFieldEdit[]; warnings: string[]
  nativeEdits?: NativeEdit[]; mediaEdits?: MediaOrderEdit[]
  sheetGalleries?: ShopifySheetGallery[]; galleryRevision?: string
  /** Sources and unchanged followers are verified too, including after the final batch. */
  verification?: ShopifyFieldEdit[]
  sources?: ShopifyFieldSnapshot[]
}
/** Reviewed common-sheet gallery intent. File creation begins only during synchronization. */
export interface ShopifySheetGallery {
  listingId: string; nexusProductId: string; productId: string; variantId?: string; ownerLabel: string
  signature: string; assets: import('./shopify-content.js').ShopifyContent['assets']; locale: string
  value: string[]; variantValue?: string[]; affectedVariants?: MediaOrderEdit['affectedVariants']
}
export interface ShopifyLinkedDiscovery {
  draft: ShopifyLinkedDraft | null; candidates: { namespace: string; key: string; name: string; linkedProducts: number }[]; reasons: string[]
}
export interface ShopifyLinkedAutomation {
  mode: 'PAUSED' | 'MONITOR' | 'AUTOMATIC'; status: 'IDLE' | 'CHECKING' | 'VERIFIED' | 'NEEDS_REVIEW' | 'ERROR'
  lastCheckedAt: string | null; lastVerifiedAt: string | null; message: string | null; changes: number
}
export interface ShopifyLinkedWorkspace {
  productId: string; familyId: string; name: string; destination: { accountId: string; listingId: string | null; market: string }
  revision: string; draft: ShopifyLinkedDraft; suggestedProductIds: string[]
  operation: { id: string; status: 'RUNNING' | 'UNVERIFIED' | 'VERIFIED'; completed: number; total: number; error: string | null; includesSheetMedia?: boolean } | null
  automation?: ShopifyLinkedAutomation
  hasSheetMedia?: boolean
}

/** No inferred field names, colours or ordering. Removed members lose only this reviewed family's links. */
export function linkedFamilyChanges(draft: ShopifyLinkedDraft): ShopifyFieldEdit[] {
  if (!draft.relationship) return []
  const { namespace, key, includeSelf } = draft.relationship
  const ids = draft.members.map(m => m.id)
  const observedIds = draft.baselineLinks.map(f => f.ownerId)
  if (ids.some(id => !observedIds.includes(id))) throw new Error('Read the relationship field on every member before reviewing changes.')
  const familyIds = new Set([...ids, ...observedIds])
  return draft.baselineLinks.flatMap(field => {
    let previous: unknown
    try { previous = field.value === null ? [] : JSON.parse(field.value) } catch { throw new Error('An existing relationship value cannot be read. Refresh the product.') }
    if (!Array.isArray(previous) || previous.some(id => !shopifyProductGid.safeParse(id).success)) throw new Error('An existing relationship contains an invalid product reference.')
    const values = ids.includes(field.ownerId) ? ids.filter(id => includeSelf || id !== field.ownerId) : previous.filter(id => !familyIds.has(id))
    // An absent field and an empty resulting list are already equivalent; avoid creating noise.
    if ((field.value === null && !values.length) || JSON.stringify(previous) === JSON.stringify(values)) return []
    return [{ ...field, namespace, key, nextValue: JSON.stringify(values), ownerLabel: draft.members.find(m => m.id === field.ownerId)?.title ?? 'Removed family member' }]
  })
}

/** Common type validation; Shopify remains authoritative for store-specific and future constraints. */
export function validateShopifyField(def: Pick<ShopifyFieldDefinition, 'type' | 'validations' | 'required'>, raw: string | null): string | null {
  const unsupported = shopifyTypeReason(def.type)
  if (unsupported) return unsupported
  if (raw === null) return def.required ? 'This field is required.' : null
  if (raw.length > 2000000) return 'This field exceeds the supported value size.'
  const list = def.type.startsWith('list.'), type = list ? def.type.slice(5) : def.type
  let values: unknown[] = [raw]
  if (list) {
    try { const parsed = JSON.parse(raw); if (!Array.isArray(parsed)) return 'Choose a list of values.'; values = parsed } catch { return 'Enter a valid list.' }
    if (new Set(values.map(v => JSON.stringify(v))).size !== values.length && type.endsWith('_reference')) return 'Select each reference only once.'
  }
  for (const value of values) {
    const text = typeof value === 'string' ? value : String(value)
    if (shopifyObjectType(type)) {
      let object: unknown = value
      if (!list) { try { object = JSON.parse(text) } catch { return 'Enter a valid structured value.' } }
      const error = shopifyObjectError(type, object)
      if (error) return error
      for (const rule of def.validations.filter(r => ['min', 'max'].includes(r.name))) {
        const error = shopifyObjectBoundError(type, object as Record<string, unknown>, rule)
        if (error) return error
      }
      if (type === 'rating') for (const rule of def.validations.filter(r => ['scale_min', 'scale_max'].includes(r.name))) {
        if (Number((object as Record<string, unknown>)[rule.name]) !== Number(rule.value)) return `Use the store’s rating scale (${rule.name === 'scale_min' ? 'minimum' : 'maximum'} ${rule.value}).`
      }
      continue
    }
    if (list && typeof value !== 'string' && !(type === 'number_integer' && Number.isSafeInteger(value)) && !(type === 'number_decimal' && typeof value === 'number' && Number.isFinite(value)) && !(type === 'boolean' && typeof value === 'boolean')) return 'This list contains a value of the wrong type.'
    if (type.endsWith('_reference')) {
      if (!shopifyGid.safeParse(value).success) return 'Choose an existing Shopify reference.'
      const resource = ({ product_reference: 'Product', variant_reference: 'ProductVariant', metaobject_reference: 'Metaobject', collection_reference: 'Collection', page_reference: 'Page', customer_reference: 'Customer', company_reference: 'Company', order_reference: 'Order', article_reference: 'Article', disclosure_reference: 'Metaobject', product_taxonomy_value_reference: 'TaxonomyValue', mixed_reference: 'Metaobject' } as Record<string, string>)[type]
      if (resource && !text.startsWith(`gid://shopify/${resource}/`)) return `Choose a ${resource} reference.`
      if (type === 'file_reference' && !/^gid:\/\/shopify\/(MediaImage|GenericFile|Video|Model3d)\/\d+$/.test(text)) return 'Choose an image, video or file.'
    }
    if (type === 'jurisdiction' && !/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(text)) return 'Enter a country or subdivision code, such as US or US-CA.'
    if (type === 'boolean' && !['true', 'false'].includes(text)) return 'Choose Yes or No.'
    if (type === 'number_integer' && (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))) return 'Enter a whole number.'
    if (type === 'number_decimal' && (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text)))) return 'Enter a decimal number.'
    if (['single_line_text_field', 'id'].includes(type) && (!text.length || /[\r\n]/.test(text))) return 'Enter one line of text, or clear the field.'
    if (type === 'language') { try { if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text) || !Intl.getCanonicalLocales(text).length) return 'Enter a supported language tag.' } catch { return 'Enter a supported language tag.' } }
    if (type === 'color' && !/^#[\da-f]{6}$/i.test(text)) return 'Enter a six-digit colour, such as #123456.'
    if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) return 'Enter a valid date.'
    if (type === 'date_time' && Number.isNaN(Date.parse(text))) return 'Enter a valid date and time.'
    if (type === 'url') { try { if (!['https:', 'http:', 'mailto:', 'sms:', 'tel:'].includes(new URL(text).protocol)) return 'Enter a supported URL.' } catch { return 'Enter a valid URL.' } }
    if (['json', 'rich_text_field'].includes(type)) {
      try { const data = JSON.parse(text); if (type === 'rich_text_field' && (data?.type !== 'root' || !Array.isArray(data.children))) return 'Use rich text with a root and children.' } catch { return 'Enter valid JSON.' }
    }
    for (const rule of def.validations) {
      if (rule.name === 'schema' && type === 'json') { const error = shopifyJsonSchemaError(rule.value, text); if (error) return error }
      if (rule.name === 'max_precision' && type === 'number_decimal' && (text.split('.')[1]?.length ?? 0) > Number(rule.value)) return `Use at most ${rule.value} decimal places.`
      if (rule.name === 'allowed_domains' && type === 'url') { try { if (!(JSON.parse(rule.value) as string[]).some(domain => new URL(text).hostname.toLowerCase() === domain.toLowerCase())) return 'Choose a URL on one of the store’s allowed domains.' } catch { return 'This definition’s allowed domains cannot be read. Refresh the store schema.' } }
      if (['min', 'max'].includes(rule.name) && ['date', 'date_time'].includes(type) && (rule.name === 'min' ? Date.parse(text) < Date.parse(rule.value) : Date.parse(text) > Date.parse(rule.value))) return `Shopify requires ${rule.name} ${rule.value}.`
      if (rule.name === 'regex') {
        try { if (!new RegExp(rule.value, 'u').test(text)) return 'This value does not match the store’s required format.' } catch { return 'The store’s validation pattern cannot be read. Refresh its schema.' }
      }
      if (['min', 'max'].includes(rule.name) && ['number_integer', 'number_decimal', 'single_line_text_field', 'multi_line_text_field', 'id'].includes(type)) {
        const actual = type.startsWith('number_') ? Number(text) : [...text].length
        if ((rule.name === 'min' && actual < Number(rule.value)) || (rule.name === 'max' && actual > Number(rule.value))) return `Shopify requires ${rule.name === 'min' ? 'at least' : 'at most'} ${rule.value}${type.startsWith('number_') ? '' : ' characters'}.`
      }
      if (rule.name === 'choices') { try { if (!(JSON.parse(rule.value) as string[]).includes(text)) return 'Choose one of the store’s allowed values.' } catch { return 'This definition’s choices cannot be read. Refresh the store schema.' } }
    }
  }
  for (const rule of def.validations) if (list && ((rule.name === 'list.min' && values.length < Number(rule.value)) || (rule.name === 'list.max' && values.length > Number(rule.value)))) return `The store requires ${rule.name === 'list.min' ? 'at least' : 'at most'} ${rule.value} values.`
  return null
}
