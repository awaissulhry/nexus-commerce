import { contentKeys, contentLanguages, listingContentState } from '../pim/content-read.js'
import { contentField, translationMissing } from '../pim/content-resolver.js'
import { normalizeLanguage } from '../pim/content-language.js'
import type { ChannelFieldSpec } from '../pim/channel-specs/types.js'
import { emptyShopifyLinkedDraft, validateShopifyField, shopifyDefinitionApplicability, type ShopifyLinkedDraft, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { nativeFieldKeys, nativeFieldValueError, type NativeEdit } from '@nexus/shared/shopify-information'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { storedChannelState } from '../pim/channel-value-mutation.js'
import { readInformation } from './information-gateway.js'
import type { ShopifyGraphql } from './admin-client.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

type Listing = { productId: string; channelConnectionId: string | null; platformAttributes: unknown; [key: string]: unknown }
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const raw = (value: unknown) => value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)
function listingLanguages(listing: Listing): string[] {
  const product = listing.product as Record<string, any> | undefined
  if (!product) throw new Error('Shopify content requires hydrated product translations.')
  return contentLanguages(product, product.parent).filter(language => language !== (listing.languages as string[])[0])
}
/** One value pick for shared source, translations and listing pins; factual overrides retain their stores. */
export function informationContentState(listing: Listing, spec: ChannelFieldSpec, locale?: string) {
  const product = listing.product as Record<string, any> | undefined
  if (!product) throw new Error('Shopify content requires hydrated product translations.')
  const key = contentField(spec.masterKey ?? spec.key)
  if (!contentKeys(product, product.parent).includes(key)) return storedChannelState(listing, spec.channelStore, [spec.masterKey ?? spec.key, spec.key])
  const requested = normalizeLanguage(locale ?? (listing.languages as string[])[0])
  const resolved = listingContentState(listing, requested, key)
  if (locale && translationMissing(resolved, requested) || resolved.tier === 'computed' && resolved.value == null) return { state: 'inherited' as const, value: undefined }
  return { state: 'stored' as const, value: resolved.value }
}

/** Validate saved overrides before creating any Shopify resource. */
export function validateListingInformationOverrides(listings: Listing[], accountId: string, schema: ShopifyStoreSchema, requireCategory = true) {
  for (const listing of listings) {
    if (listing.channelConnectionId !== accountId) throw new WorkspaceScopeError('A draft belongs to another Shopify store.', 422)
    const locales = listingLanguages(listing)
    for (const locale of [undefined, ...locales]) for (const spec of shopifyProductSpec(schema, accountId, locale).fields) {
      const field = spec.shopifyField!, stored = informationContentState(listing, spec, locale)
      if (stored.state !== 'stored' || (!field.definition && !nativeFieldKeys.includes(field.id as NativeEdit['field']))) continue
      const category = object(listing.platformAttributes).category
      // Existing Shopify products can inherit their remote category. Their reviewed plan checks
      // that exact category; a new product must have a category before constrained fields are created.
      const value = raw(stored.value), error = spec.readOnlyReason ?? (field.definition && value !== null && (requireCategory || category !== undefined) ? shopifyDefinitionApplicability(field.definition, category) : null) ?? (locale && value === null ? null : field.definition ? validateShopifyField(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value))
      if (error) throw new WorkspaceScopeError(`${field.label}${locale ? ` (${locale})` : ''}: ${error}`, 422)
      if (field.definition && field.type === 'money' && value !== null && schema.currency && JSON.parse(value).currency_code !== schema.currency) throw new WorkspaceScopeError(`${field.label}: use the selected store’s ${schema.currency} currency.`, 422)
    }
  }
}

export function listingInformationOverrideReview(listings: Listing[], accountId: string, schema: ShopifyStoreSchema) {
  return listings.flatMap(listing => [undefined, ...listingLanguages(listing)].flatMap(locale => shopifyProductSpec(schema, accountId, locale).fields.flatMap(spec => {
    const field = spec.shopifyField!, stored = informationContentState(listing, spec, locale)
    return stored.state === 'stored' && (field.definition || nativeFieldKeys.includes(field.id as NativeEdit['field'])) ? [{ productId: listing.productId, label: field.label, type: field.type, locale: locale ?? schema.locales.find(l => l.primary)?.locale ?? '', value: raw(stored.value) }] : []
  })))
}

export async function listingInformationTranslations(gql: ShopifyGraphql, input: { accountId: string; familyId: string; productId: string; variantIds: Record<string, string>; listings: Listing[] }, schema: ShopifyStoreSchema): Promise<ShopifyLinkedDraft> {
  const locales = [...new Set(input.listings.flatMap(l => listingLanguages(l)))]
  const draft = emptyShopifyLinkedDraft(); draft.informationOnly = true
  for (const locale of locales) {
    const { rows } = await readInformation(gql, [input.productId], schema, locale)
    draft.members = rows.filter(r => r.kind === 'PRODUCT').map(r => ({ id: r.id, title: r.title, handle: r.handle, image: r.image }))
    for (const listing of input.listings) for (const spec of shopifyProductSpec(schema, input.accountId, locale).fields) {
      const field = spec.shopifyField!, fieldId = field.id
      const state = informationContentState(listing, spec, locale)
      if (state.state !== 'stored' || spec.channelStore?.kind !== 'platformAttributes' || spec.channelStore.path[0] !== '_shopifyInformationLocales') continue
      const incoming = state.value
      if (field.owner === 'PRODUCT' && listing.productId !== input.familyId) throw new WorkspaceScopeError('A product translation is stored on another row.', 422)
      const ownerId = field.owner === 'PRODUCT' ? input.productId : input.variantIds[listing.productId]
      const row = rows.find(r => r.id === ownerId), source = row?.translations?.[fieldId], value = raw(incoming)
      if (!source) { if (value === null) continue; throw new WorkspaceScopeError(`${field.label}: Shopify does not expose a translatable source yet. Synchronize its primary-language value first.`, 422) }
      if (source.value === value) continue
      const { value: baseline, sourceValue: _source, outdated: _outdated, ...translation } = source
      ;(draft.nativeEdits ??= []).push({ ownerId, productId: input.productId, ownerLabel: row!.title, field: 'translation', value: baseline, nextValue: value, translation })
    }
  }
  return draft
}

/** Explicit listing overrides only. The reviewed publication owns native creation and ID mapping.
 * This bridge never matches a variant by SKU, chooses a store, or touches a shared Product. */
export async function listingInformationDraft(gql: ShopifyGraphql, input: {
  accountId: string; familyId: string; productId: string; variantIds: Record<string, string>; listings: Listing[]
}, schema: ShopifyStoreSchema): Promise<ShopifyLinkedDraft> {
  const fields = shopifyProductSpec(schema, input.accountId).fields
  const rows = (await readInformation(gql, [input.productId], schema)).rows
  const draft = emptyShopifyLinkedDraft()
  draft.informationOnly = true
  draft.members = rows.filter(r => r.kind === 'PRODUCT').map(r => ({ id: r.id, title: r.title, handle: r.handle, image: r.image }))
  for (const listing of input.listings) {
    if (listing.channelConnectionId !== input.accountId) throw new WorkspaceScopeError('A draft belongs to another Shopify store.', 422)
    for (const spec of fields) {
      const field = spec.shopifyField!
      if (field.owner === 'PRODUCT' && listing.productId !== input.familyId) continue
      if (field.owner === 'PRODUCTVARIANT' && !input.variantIds[listing.productId]) continue
      const stored = informationContentState(listing, spec)
      if (stored.state !== 'stored') continue
      // These families have their own explicit publication/stock/media operations.
      if (!field.definition && !nativeFieldKeys.includes(field.id as NativeEdit['field'])) continue
      if (field.reason) throw new WorkspaceScopeError(`${field.label}: ${field.reason}`, 422)
      const ownerId = field.owner === 'PRODUCT' ? input.productId : input.variantIds[listing.productId]
      const row = rows.find(r => r.id === ownerId)
      if (!row || row.productId !== input.productId) throw new WorkspaceScopeError('The Shopify draft variant mapping changed. Review publication again.', 409)
      const value = stored.value == null ? null : typeof stored.value === 'object' ? JSON.stringify(stored.value) : String(stored.value)
      if (field.definition) {
        const { namespace, key } = field.definition
        const existing = row.fields.find(f => f.namespace === namespace && f.key === key) ?? { ownerId, namespace, key, value: null, type: field.type, compareDigest: null }
        if (existing.value !== value) draft.edits.push({ ...existing, nextValue: value, ownerLabel: row.title })
      } else if (row.values[field.id] !== value) (draft.nativeEdits ??= []).push({ ownerId, productId: row.productId, ownerLabel: row.title, field: field.id as NativeEdit['field'], value: row.values[field.id], nextValue: value })
    }
  }
  return draft
}
