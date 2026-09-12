import { informationMetafieldId, nativeTranslationKeys, nativeFieldValueError, nativeValuesEqual, type InformationRow, type NativeEdit } from '@nexus/shared/shopify-information'
import { validateShopifyField, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { collectShopifyPages } from './linked-products-gateway.js'

export async function readTranslationResources(gql: ShopifyGraphql, ids: string[], locale: string) {
  const result = new Map<string, any>()
  const unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += 100) {
    const resources = await collectShopifyPages<any>(async after => (await gql(`query NexusInformationTranslations($ids:[ID!]!,$locale:String!,$after:String) {
      translatableResourcesByIds(first:100,after:$after,resourceIds:$ids) { nodes { resourceId translatableContent { key value digest locale }
        translations(locale:$locale) { key value outdated market { id } } } pageInfo { hasNextPage endCursor } }
    }`, { ids: unique.slice(offset, offset + 100), locale, after })).translatableResourcesByIds)
    for (const resource of resources) result.set(resource.resourceId, resource)
  }
  return result
}
/** Query only valid translatable resource classes. ProductVariant is not a translatable
 * resource in 2026-07; its computed title is generated from option values. */
export async function addInformationTranslations(gql: ShopifyGraphql, rows: InformationRow[], locale: string, schema: ShopifyStoreSchema) {
  locale = schema.locales.find(l => l.locale.toLowerCase() === locale.toLowerCase())?.locale ?? locale.toLowerCase()
  if (schema.locales.find(l => l.primary)?.locale === locale) return
  if (!schema.locales.some(l => l.locale === locale)) throw new WorkspaceScopeError('This language is not enabled in the selected Shopify store.', 422)
  if (!schema.native?.scopes.some(s => ['read_translations', 'write_translations'].includes(s))) throw new WorkspaceScopeError('This Shopify connection needs read_translations permission to open another language.', 403)
  const ids = rows.flatMap(r => [...(r.kind === 'PRODUCT' ? [r.id] : []), ...r.fields.flatMap(f => f.id ? [f.id] : [])])
  const resources = await readTranslationResources(gql, ids, locale)
  for (const row of rows) {
    row.locale = locale; row.translations = {}
    const addresses = [...(row.kind === 'PRODUCT' ? Object.entries(nativeTranslationKeys).map(([fieldId, key]) => ({ resourceId: row.id, fieldId, key })) : []),
      ...row.fields.flatMap(f => f.id ? [{ resourceId: f.id, fieldId: informationMetafieldId(row.kind, f.namespace, f.key), key: 'value' }] : [])]
    for (const address of addresses) {
      const resource = resources.get(address.resourceId), content = resource?.translatableContent.find((c: any) => c.key === address.key)
      if (!content?.digest) continue
      const translated = resource.translations.find((t: any) => t.key === address.key && t.market === null)
      row.translations[address.fieldId] = { ...address, locale, digest: content.digest, sourceValue: content.value, value: translated?.value ?? null, outdated: translated?.outdated ?? false }
    }
  }
}

/** Verify the actual source owner and definition in this account; client supplied resource
 * IDs and language labels never establish authorization or translatability. */
export async function verifyTranslationEdits(gql: ShopifyGraphql, edits: NativeEdit[], schema: ShopifyStoreSchema, phase: 'baseline' | 'result' | 'resume' = 'baseline') {
  if (!edits.length) return
  for (const locale of new Set(edits.map(e => e.translation!.locale))) {
    const changes = edits.filter(e => e.translation?.locale === locale)
    const resources = await readTranslationResources(gql, changes.map(e => e.translation!.resourceId), locale)
    const ownerIds = [...new Set(changes.map(e => e.translation!.resourceId))], sources = new Map<string, any>()
    for (let offset = 0; offset < ownerIds.length; offset += 100) {
      const { nodes } = await gql(`query NexusInformationTranslationOwners($ids:[ID!]!) { nodes(ids:$ids) {
        ... on Product { id } ... on Metafield { id namespace key type owner { ... on Product { id } ... on ProductVariant { id product { id } } } }
      } }`, { ids: ownerIds.slice(offset, offset + 100) })
      for (const node of nodes ?? []) if (node) sources.set(node.id, node)
    }
    for (const edit of changes) {
      const t = edit.translation!, source = sources.get(t.resourceId), resource = resources.get(t.resourceId)
      const productId = source?.owner?.product?.id ?? source?.owner?.id ?? source?.id
      if (productId !== edit.productId || (source.owner?.id ?? source.id) !== edit.ownerId) throw new WorkspaceScopeError('The translation resource belongs to another product or variant.', 422)
      const def = source.owner ? schema.definitions.find(d => d.namespace === source.namespace && d.key === source.key && d.ownerType === (source.owner.product ? 'PRODUCTVARIANT' : 'PRODUCT')) : null
      if (source.owner ? !def || t.fieldId !== informationMetafieldId(def.ownerType, def.namespace, def.key) || def.type !== source.type || t.key !== 'value' : nativeTranslationKeys[t.fieldId] !== t.key) throw new WorkspaceScopeError('This translation no longer matches the source field.', 422)
      const content = resource?.translatableContent.find((c: any) => c.key === t.key)
      if (!content?.digest || content.digest !== t.digest) throw new WorkspaceScopeError('The source content changed in Shopify. Review the translation against its latest source.', 409)
      const actual = resource.translations.find((c: any) => c.key === t.key && c.market === null)?.value ?? null
      const result = nativeValuesEqual('translation', actual, edit.nextValue), baseline = nativeValuesEqual('translation', actual, edit.value)
      if (!(phase === 'result' ? result : phase === 'resume' ? result || baseline : baseline)) throw new WorkspaceScopeError('This translation changed in Shopify. The intended text is retained for review.', 409)
      const validation = edit.nextValue === null ? null : def ? validateShopifyField(def, edit.nextValue) : nativeFieldValueError(t.fieldId as NativeEdit['field'], edit.nextValue)
      if (validation) throw new WorkspaceScopeError(validation, 422)
    }
  }
}
export async function applyInformationTranslation(gql: ShopifyGraphql, edit: NativeEdit, schema: ShopifyStoreSchema) {
  await verifyTranslationEdits(gql, [edit], schema, 'resume')
  const t = edit.translation!
  const resource = (await readTranslationResources(gql, [t.resourceId], t.locale)).get(t.resourceId)
  if ((resource?.translations.find((v: any) => v.key === t.key && v.market === null)?.value ?? null) === edit.nextValue) return
  if (edit.nextValue === null) assertShopifyResult((await gql(`mutation NexusInformationTranslationRemove($id:ID!,$keys:[String!]!,$locales:[String!]!) {
    translationsRemove(resourceId:$id,translationKeys:$keys,locales:$locales) { userErrors { field message } }
  }`, { id: t.resourceId, keys: [t.key], locales: [t.locale] })).translationsRemove, 'Clear Shopify translation')
  else assertShopifyResult((await gql(`mutation NexusInformationTranslationSet($id:ID!,$translations:[TranslationInput!]!) {
    translationsRegister(resourceId:$id,translations:$translations) { userErrors { field message } }
  }`, { id: t.resourceId, translations: [{ key: t.key, locale: t.locale, value: edit.nextValue, translatableContentDigest: t.digest }] })).translationsRegister, 'Save Shopify translation')
  await verifyTranslationEdits(gql, [edit], schema, 'result')
}
