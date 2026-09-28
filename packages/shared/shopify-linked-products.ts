import { z } from 'zod'
import { shopifyJsonSchemaError, shopifyObjectBoundError } from './shopify-definition-validation.js'
export { shopifyJson } from './shopify-json.js'
import { shopifyObjectError, shopifyObjectType, shopifyTypeReason } from './shopify-field-codecs.js'
import { plainNumber, shopifyDateTimeMs, shopifyFileKind, shopifyFileKindsWords, shopifyJsonProblem, shopifyLimitMs, shopifyMomentWords, shopifyNoun } from './shopify-field-rules.js'
export { plainNumber, shopifyDateMs, shopifyDateTimeMs, shopifyDateTimeValue, shopifyFileKind, shopifyFileKindsWords, shopifyJsonProblem, shopifyLimitMs, shopifyMomentWords, shopifyNoun, shopifyRuleSummary, shopifyValuesEqual, type ShopifyNoun } from './shopify-field-rules.js'
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
export { shopifyReferenceError, shopifyReferenceTypes, shopifyTaxonomyCategories } from './shopify-reference-validation.js'
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
/** `swatch`: a `#RRGGBB` colour an entry declares as its picture (Shopify `Metaobject.thumbnailField` → `thumbnail.hex`),
 *  drawn when there is no `image` — a colour entry such as the category `shopify--color-pattern`. */
export interface ShopifyReference { id: string; label: string; image: string | null; swatch?: string | null; type?: string; handle?: string; available?: boolean; media?: InformationMedia }
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

/**
 * Common type validation; Shopify remains authoritative for store-specific and future constraints.
 *
 * The refusal sentences are the plain words of docs/shopify-metafields/PLAN-2026-09-28.md §5: one sentence, what is wrong
 * and what to do. The pop-up, the draft save and publish all call this, so they all say the same words. In a list, an
 * item's sentence starts with "Value N:", so it is clear which value to fix.
 */
export function validateShopifyField(def: Pick<ShopifyFieldDefinition, 'type' | 'validations' | 'required'>, raw: string | null): string | null {
  const unsupported = shopifyTypeReason(def.type)
  if (unsupported) return unsupported
  if (raw === null) return def.required ? 'Enter a value. Shopify needs this field.' : null
  if (raw.length > 2000000) return 'This field exceeds the supported value size.'
  const list = def.type.startsWith('list.'), type = list ? def.type.slice(5) : def.type
  const noun = shopifyNoun(def.type)
  const rule = (name: string) => def.validations.find(r => r.name === name)?.value
  let values: unknown[] = [raw]
  if (list) {
    try { const parsed = JSON.parse(raw); if (!Array.isArray(parsed)) return 'Choose a list of values.'; values = parsed } catch { return 'Enter a valid list.' }
    if (new Set(values.map(v => JSON.stringify(v))).size !== values.length && type.endsWith('_reference')) return `The same ${noun.one} is in the list twice. Remove one.`
  }
  for (const [index, value] of values.entries()) {
    const error = itemError(def, type, list, value, rule)
    if (error) return list ? `Value ${index + 1}: ${error}` : error
  }
  const listMin = rule('list.min'), listMax = rule('list.max')
  if (list && listMin !== undefined && values.length < Number(listMin)) return `Add at least ${listMin} ${listMin === '1' ? noun.one : noun.other}.`
  if (list && listMax !== undefined && values.length > Number(listMax)) return `Use ${listMax} ${listMax === '1' ? noun.one : noun.other} or fewer. Remove ${values.length - Number(listMax)}.`
  return null
}

/** One value (a list's item, or the whole value) against its type and the definition's rules. */
function itemError(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, type: string, list: boolean, value: unknown, rule: (name: string) => string | undefined): string | null {
  const text = typeof value === 'string' ? value : String(value)
  if (shopifyObjectType(type)) {
    let object: unknown = value
    if (!list) { try { object = JSON.parse(text) } catch { return 'Enter a valid structured value.' } }
    if (type === 'rating') {
      const low = rule('scale_min'), high = rule('scale_max')
      const scale = low !== undefined && high !== undefined ? `Choose a rating from ${plainNumber(low)} to ${plainNumber(high)}.` : null
      const error = shopifyObjectError(type, object)
      if (error) return scale ?? error
      for (const name of ['scale_min', 'scale_max'] as const) {
        const expected = rule(name)
        if (expected !== undefined && Number((object as Record<string, unknown>)[name]) !== Number(expected)) return scale ?? 'Use the store’s rating scale.'
      }
      return null
    }
    const error = shopifyObjectError(type, object)
    if (error) return error
    const domains = rule('allowed_domains')
    if (type === 'link' && domains !== undefined) { const refusal = domainError(String((object as Record<string, unknown>).url), domains); if (refusal) return refusal }
    for (const bound of def.validations.filter(r => ['min', 'max'].includes(r.name))) {
      const boundError = shopifyObjectBoundError(type, object as Record<string, unknown>, bound)
      if (boundError) return boundError
    }
    return null
  }
  if (list && typeof value !== 'string' && !(type === 'number_integer' && Number.isSafeInteger(value)) && !(type === 'number_decimal' && typeof value === 'number' && Number.isFinite(value)) && !(type === 'boolean' && typeof value === 'boolean')) return 'This value has the wrong kind of data. Fix or remove it.'
  if (type.endsWith('_reference')) {
    const noun = shopifyNoun(type)
    if (!shopifyGid.safeParse(value).success) return `Choose ${/^[aeiou]/.test(noun.one) ? 'an' : 'a'} ${noun.one} from the store.`
    const resource = ({ product_reference: 'Product', variant_reference: 'ProductVariant', metaobject_reference: 'Metaobject', collection_reference: 'Collection', page_reference: 'Page', customer_reference: 'Customer', company_reference: 'Company', order_reference: 'Order', article_reference: 'Article', disclosure_reference: 'Metaobject', product_taxonomy_value_reference: 'TaxonomyValue', mixed_reference: 'Metaobject' } as Record<string, string>)[type]
    if (resource && !text.startsWith(`gid://shopify/${resource}/`)) return `This field takes ${noun.other} only.`
    if (type === 'file_reference') {
      const kind = shopifyFileKind(text)
      if (!kind) return 'This field takes files only.'
      const limit = rule('file_type_options')
      if (limit) {
        let allowed: string[]
        try { allowed = JSON.parse(limit) } catch { return 'This field’s file limit cannot be read. Refresh the store schema.' }
        if (Array.isArray(allowed) && allowed.length && !allowed.includes(kind)) return `This field takes ${shopifyFileKindsWords(allowed)} only.`
      }
    }
  }
  if (type === 'jurisdiction' && !/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(text)) return 'Enter a country or subdivision code, such as US or US-CA.'
  if (type === 'boolean' && !['true', 'false'].includes(text)) return 'Choose Yes or No.'
  if (type === 'number_integer' && (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))) return 'Enter a whole number, for example 12.'
  if (type === 'number_decimal' && (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text)))) return 'Enter a number, for example 12.5.'
  if (['single_line_text_field', 'id'].includes(type) && (!text.length || /[\r\n]/.test(text))) return 'Enter one line of text, or clear the field.'
  if (type === 'language') { try { if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text) || !Intl.getCanonicalLocales(text).length) return 'Enter a language code, for example en or it-IT.' } catch { return 'Enter a language code, for example en or it-IT.' } }
  if (type === 'color' && !/^#[\da-f]{6}$/i.test(text)) return 'Enter a colour as # and six characters, for example #1A2B3C.'
  if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) return 'Enter a date as YYYY-MM-DD, for example 2026-09-28.'
  if (type === 'date_time' && shopifyDateTimeMs(text) === null) return 'Choose a date and a time.'
  if (type === 'url') { try { if (!['https:', 'http:', 'mailto:', 'sms:', 'tel:'].includes(new URL(text).protocol)) return 'Enter a full web address, for example https://example.com.' } catch { return 'Enter a full web address, for example https://example.com.' } }
  if (['json', 'rich_text_field'].includes(type)) {
    /* The parser decides WHETHER; `shopifyJsonProblem` says where and why in the same words in every engine (G16). */
    try { const data = JSON.parse(text); if (type === 'rich_text_field' && (data?.type !== 'root' || !Array.isArray(data.children))) return 'Use rich text with a root and children.' } catch { return `This is not valid JSON: ${shopifyJsonProblem(text) ?? 'check its quotes, commas and brackets'}.` }
  }
  for (const r of def.validations) {
    if (r.name === 'schema' && type === 'json') { const error = shopifyJsonSchemaError(r.value, text); if (error) return error }
    if (r.name === 'max_precision' && type === 'number_decimal' && (text.split('.')[1]?.length ?? 0) > Number(r.value)) return `Use at most ${r.value} decimal places.`
    if (r.name === 'allowed_domains' && type === 'url') { const refusal = domainError(text, r.value); if (refusal) return refusal }
    if (['min', 'max'].includes(r.name) && ['date', 'date_time'].includes(type)) {
      /* Both sides as UTC moments — a limit with no zone is UTC, like the value (G15). A limit Nexus cannot read is left
         to Shopify's own check when you publish; it never blocks the save. */
      const actual = shopifyLimitMs(text), limit = shopifyLimitMs(r.value)
      if (actual !== null && limit !== null && (r.name === 'min' ? actual < limit : actual > limit)) {
        return `Choose ${type === 'date_time' ? `${shopifyMomentWords(limit)} (UTC)` : r.value} or ${r.name === 'min' ? 'later' : 'earlier'}.`
      }
    }
    if (r.name === 'regex') {
      try { if (!new RegExp(r.value, 'u').test(text)) return `This text does not have the format the store needs (${r.value}).` } catch { return 'The store’s validation pattern cannot be read. Refresh its schema.' }
    }
    if (['min', 'max'].includes(r.name) && ['number_integer', 'number_decimal'].includes(type)) {
      const actual = Number(text), limit = Number(r.value)
      if (r.name === 'min' && actual < limit) return `Enter ${plainNumber(r.value)} or more.`
      if (r.name === 'max' && actual > limit) return `Enter ${plainNumber(r.value)} or less.`
    }
    if (['min', 'max'].includes(r.name) && ['single_line_text_field', 'multi_line_text_field', 'id'].includes(type)) {
      const length = [...text].length, limit = Number(r.value)
      if (r.name === 'min' && length < limit) return `Use at least ${r.value} characters. Now: ${length}.`
      if (r.name === 'max' && length > limit) return `Use ${r.value} characters or fewer. Now: ${length}.`
    }
    if (r.name === 'choices') {
      let choices: string[]
      try { choices = JSON.parse(r.value) } catch { return 'This definition’s choices cannot be read. Refresh the store schema.' }
      if (!choices.includes(text)) return `Choose one of these values: ${choices.length > 10 ? `${choices.slice(0, 10).join(', ')}, …` : choices.join(', ')}.`
    }
  }
  return null
}

/** `allowed_domains` on a web address: the one check for a `url` and for a `link`'s URL (B3b, gap G17). The format check
 *  runs first, so the address is a real URL here. An empty list sets no limit. */
function domainError(url: string, rule: string): string | null {
  let domains: unknown
  try { domains = JSON.parse(rule) } catch { return 'This definition’s allowed domains cannot be read. Refresh the store schema.' }
  if (!Array.isArray(domains)) return 'This definition’s allowed domains cannot be read. Refresh the store schema.'
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return null }
  return !domains.length || domains.some(domain => String(domain).toLowerCase() === host) ? null : `Use a link on one of these sites: ${domains.join(', ')}.`
}
