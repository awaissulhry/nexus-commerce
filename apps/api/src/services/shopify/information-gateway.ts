import { applyInformationPublications, readInformationPublications } from './information-publications.js'
import { applyInformationInventory, readInformationInventory } from './information-inventory.js'
import { addInformationTranslations, applyInformationTranslation, verifyTranslationEdits } from './information-translations.js'
import { applyMediaMembership, verifyMediaMembership } from './information-media-membership.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { InformationSnapshot, InformationRow, InformationMedia, NativeEdit, MediaOrderEdit } from '@nexus/shared/shopify-information'
import { mediaMoves, nativeFieldError, nativeValuesEqual } from '@nexus/shared/shopify-information'
import type { ShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { collectShopifyPages, readLinkedOwner, readLinkedStoreSchema } from './linked-products-gateway.js'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

const pageInfo = 'pageInfo { hasNextPage endCursor }'
const mediaSelection = 'id alt mediaContentType status preview { image { url } } ... on MediaImage { image { url } } ... on Video { sources { url mimeType } } ... on ExternalVideo { embeddedUrl } ... on Model3d { sources { url mimeType } }'
const productNativeSelection = 'id title handle descriptionHtml tags status vendor productType templateSuffix publishedAt category { id fullName } seo { title description }'
const variantNativeSelection = 'id price compareAtPrice barcode taxable inventoryPolicy unitPriceMeasurement { quantityUnit quantityValue referenceUnit referenceValue } inventoryItem { sku tracked requiresShipping harmonizedSystemCode countryCodeOfOrigin unitCost { amount currencyCode } measurement { weight { value unit } } }'
const variantSelection = `${variantNativeSelection} title image { url } metafields(first:100) { nodes { id namespace key type value compareDigest } ${pageInfo} }`


const json = (value: unknown): string | null => value == null ? null : JSON.stringify(value)
function productValues(p: any): InformationRow['values'] {
  return { title: p.title, handle: p.handle, descriptionHtml: p.descriptionHtml, tags: json(p.tags), status: p.status, vendor: p.vendor,
    productType: p.productType, templateSuffix: p.templateSuffix ?? '', category: p.category?.id ?? null, publishDate: p.publishedAt ?? null, 'seo.title': p.seo?.title ?? null, 'seo.description': p.seo?.description ?? null }
}
function variantValues(v: any): InformationRow['values'] {
  const i = v.inventoryItem
  const boolean = (value: unknown) => value == null ? null : String(value)
  return { price: v.price, compareAtPrice: v.compareAtPrice ?? null, barcode: v.barcode ?? '', taxable: boolean(v.taxable), inventoryPolicy: v.inventoryPolicy,
    unitPriceMeasurement: json(v.unitPriceMeasurement), sku: i?.sku ?? '', tracked: boolean(i?.tracked), requiresShipping: boolean(i?.requiresShipping),
    harmonizedSystemCode: i?.harmonizedSystemCode ?? null, countryCodeOfOrigin: i?.countryCodeOfOrigin ?? null, cost: i?.unitCost?.amount ?? null,
    weight: json(i?.measurement?.weight) }
}

type NativeOwner = Pick<InformationRow, 'id' | 'productId' | 'kind' | 'values'>
/** Bounded reads of scalar owners; saving one cell never traverses a variant matrix or gallery. */
export async function readInformationNativeOwners(gql: ShopifyGraphql, ownerIds: string[], fields: readonly string[] = []): Promise<NativeOwner[]> {
  const ids = [...new Set(ownerIds)]
  if (ids.length > 10100 || ids.some(id => !/^gid:\/\/shopify\/(Product|ProductVariant)\/\d+$/.test(id))) throw new WorkspaceScopeError('Choose valid Shopify field owners.', 400)
  const rows: NativeOwner[] = []
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50)
    const { nodes } = await gql(`query NexusInformationNativeOwners($ids:[ID!]!) { nodes(ids:$ids) {
      ... on Product { ${productNativeSelection} }
      ... on ProductVariant { ${variantNativeSelection} product { id } }
    } }`, { ids: batch })
    if (!Array.isArray(nodes) || nodes.length !== batch.length || nodes.some((n: any, i: number) => n?.id !== batch[i])) throw new WorkspaceScopeError('A field owner is unavailable in this Shopify store.', 409)
    rows.push(...nodes.map((n: any): NativeOwner => ({ id: n.id, productId: n.id.includes('/ProductVariant/') ? n.product?.id : n.id, kind: n.id.includes('/ProductVariant/') ? 'PRODUCTVARIANT' : 'PRODUCT', values: n.id.includes('/ProductVariant/') ? variantValues(n) : productValues(n) })))
  }
  if (fields.includes('salesChannels')) for (const row of rows.filter(r => r.kind === 'PRODUCT')) row.values.salesChannels = JSON.stringify(await readInformationPublications(gql, row.id))
  if (fields.includes('inventory')) {
    const quantities = await readInformationInventory(gql, rows.filter(r => r.kind === 'PRODUCTVARIANT').map(r => r.id))
    for (const row of rows) if (quantities.has(row.id)) row.values.inventory = JSON.stringify(quantities.get(row.id)!.value)
  }
  return rows
}

export async function readInformationMedia(gql: ShopifyGraphql, productId: string): Promise<InformationMedia[]> {
  return (await collectShopifyPages<any>(async after => {
    const data = await gql(`query NexusInformationMedia($id:ID!,$after:String) { product(id:$id) { media(first:100,after:$after) { nodes { ${mediaSelection} } ${pageInfo} } } }`, { id: productId, after })
    if (!data.product) throw new WorkspaceScopeError('This product is unavailable in the selected Shopify store.', 404)
    return data.product.media
  }, 250)).map(m => ({ id: m.id, alt: m.alt ?? '', type: m.mediaContentType, status: m.status, preview: m.preview?.image?.url ?? null,
    url: m.image?.url ?? m.sources?.find((s: any) => s.mimeType === 'video/mp4')?.url ?? m.embeddedUrl ?? m.sources?.[0]?.url ?? null,
    sources: Array.isArray(m.sources) ? m.sources.map((s: { url: string; mimeType: string }) => ({ url: s.url, mimeType: s.mimeType })) : undefined }))
}
export async function readInformation(gql: ShopifyGraphql, productIds: string[], schema?: ShopifyStoreSchema, locale?: string): Promise<InformationSnapshot> {
  if (productIds.length > 100 || new Set(productIds).size !== productIds.length || productIds.some(id => !/^gid:\/\/shopify\/Product\/\d+$/.test(id))) throw new WorkspaceScopeError('Load at most 100 distinct Shopify products at a time.', 400)
  const { shop } = await gql('query NexusInformationContext { shop { currencyCode ianaTimezone } }')
  if (!shop?.currencyCode || !shop?.ianaTimezone) throw new WorkspaceScopeError('The store currency or timezone could not be read.', 502)
  const rows: InformationRow[] = []
  for (const id of productIds) {
    const { product: p } = await gql(`query NexusInformationProduct($id:ID!) { product(id:$id) { ${productNativeSelection} } }`, { id })
    if (p?.id !== id) throw new WorkspaceScopeError('A product is unavailable in this Shopify store.', 404)
    const owner = await readLinkedOwner(gql, id, false), media = await readInformationMedia(gql, id)
    const values = productValues(p)
    if (schema?.publications) {
      const publications = await readInformationPublications(gql, id)
      values.salesChannels = JSON.stringify(publications)
      values.scheduled = String(publications.some(p => p.publishDate))
    }
    rows.push({ id, productId: id, kind: 'PRODUCT', title: p.title, handle: p.handle, image: media[0]?.preview ?? null, values, fields: owner.fields, media })
    const variants = await collectShopifyPages<any>(async after => {
      const data = await gql(`query NexusInformationVariants($id:ID!,$after:String) { product(id:$id) { variants(first:100,after:$after) { nodes { ${variantSelection} } ${pageInfo} } } }`, { id, after })
      if (!data.product) throw new WorkspaceScopeError('A product changed while loading. Refresh its information.', 409)
      return data.product.variants
    }, 10000)
    for (const v of variants) {
      const item = v.inventoryItem
      if (!v.id || !item || !v.metafields?.nodes || !v.metafields.pageInfo) throw new WorkspaceScopeError('Variant information is incomplete. Refresh before editing.', 502)
      const fields = v.metafields.pageInfo.hasNextPage ? (await readLinkedOwner(gql, v.id)).fields : v.metafields.nodes.map((f: any) => ({ ...f, ownerId: v.id }))
      rows.push({ id: v.id, productId: id, kind: 'PRODUCTVARIANT', title: v.title, handle: p.handle, image: v.image?.url ?? null, media: [], fields,
        values: variantValues(v) })
    }
    if (rows.length > 10100) throw new WorkspaceScopeError('This workspace exceeds 10,000 variants. Open a smaller family.', 422)
  }
  if (schema?.native?.scopes.some(s => ['read_inventory', 'write_inventory'].includes(s))) {
    const quantities = await readInformationInventory(gql, rows.filter(r => r.kind === 'PRODUCTVARIANT').map(r => r.id))
    for (const row of rows) if (quantities.has(row.id)) row.values.inventory = JSON.stringify(quantities.get(row.id)!.value)
  }
  if (schema && locale) await addInformationTranslations(gql, rows, locale, schema)
  return { currency: shop.currencyCode, timezone: shop.ianaTimezone, rows }
}
export async function verifyInformationPlan(gql: ShopifyGraphql, draft: ShopifyLinkedDraft) {
  const nativeEdits = (draft.nativeEdits ?? []).filter(e => !nativeValuesEqual(e.field, e.value, e.nextValue)), mediaEdits = (draft.mediaEdits ?? []).filter(e => JSON.stringify(e.value) !== JSON.stringify(e.nextValue) || e.altEdits?.length).map(e => ({ ...e }))
  if (!nativeEdits.length && !mediaEdits.length) return { nativeEdits, mediaEdits }
  const ordinary = nativeEdits.filter(e => e.field !== 'translation')
  const owners = new Map((await readInformationNativeOwners(gql, ordinary.map(e => e.ownerId), ordinary.map(e => e.field))).map(row => [row.id, row]))
  for (const edit of ordinary) {
    const row = owners.get(edit.ownerId), error = nativeFieldError(edit)
    if (error || row?.productId !== edit.productId || !(edit.field in row.values) || !nativeValuesEqual(edit.field, row.values[edit.field], edit.value)) throw new WorkspaceScopeError(`${edit.ownerLabel}: ${error ?? 'This value changed in Shopify. Review both versions.'}`)
  }
  const translations = nativeEdits.filter(e => e.field === 'translation')
  if (translations.length) await verifyTranslationEdits(gql, translations, await readLinkedStoreSchema(gql))
  for (const edit of mediaEdits) {
    const media = await readInformationMedia(gql, edit.productId)
    if (JSON.stringify(media.map(m => m.id)) !== JSON.stringify(edit.value)) throw new WorkspaceScopeError(`${edit.ownerLabel}: the gallery changed in Shopify. Review its membership and order.`)
    if (!edit.membershipChanged) mediaMoves(edit.value, edit.nextValue)
    if (edit.membershipChanged || edit.altEdits?.length) Object.assign(edit, await verifyMediaMembership(gql, edit))
  }
  return { nativeEdits, mediaEdits }
}

/** Each operation patches exactly one field. No broad productSet or variant replacement. */
export async function applyNativeEdit(gql: ShopifyGraphql, edit: NativeEdit, operationId?: string) {
  const error = nativeFieldError(edit)
  if (error) throw new WorkspaceScopeError(error, 422)
  if (edit.field === 'translation') { await applyInformationTranslation(gql, edit, await readLinkedStoreSchema(gql)); return }
  if (edit.field === 'inventory') {
    if (!operationId) throw new WorkspaceScopeError('A reviewed operation is required for an inventory adjustment.', 422)
    await applyInformationInventory(gql, edit, operationId); return
  }
  if (edit.field === 'salesChannels') { await applyInformationPublications(gql, edit); return }
  const [current] = await readInformationNativeOwners(gql, [edit.ownerId])
  if (!current || current.productId !== edit.productId || !(edit.field in current.values)) throw new WorkspaceScopeError('This field owner is unavailable.', 409)
  if (nativeValuesEqual(edit.field, current.values[edit.field], edit.nextValue)) return // reconcile an uncertain acknowledgement
  if (!nativeValuesEqual(edit.field, current.values[edit.field], edit.value)) throw new WorkspaceScopeError(`${edit.ownerLabel}: this value changed in Shopify. Review both versions.`)
  const boolean = ['taxable', 'requiresShipping', 'tracked'].includes(edit.field)
  const value = boolean ? edit.nextValue === 'true' : ['tags', 'weight', 'unitPriceMeasurement'].includes(edit.field) ? JSON.parse(edit.nextValue!) : edit.nextValue
  if (current.kind === 'PRODUCT') {
    const patch = edit.field.startsWith('seo.') ? { seo: { [edit.field.slice(4)]: value } } : { [edit.field]: value }
    if (edit.field === 'handle') {
      const { productByIdentifier } = await gql('query NexusInformationHandle($identifier:ProductIdentifierInput!) { productByIdentifier(identifier:$identifier) { id } }', { identifier: { handle: edit.nextValue } })
      if (productByIdentifier && productByIdentifier.id !== edit.productId) throw new WorkspaceScopeError('This URL handle belongs to another product. Choose a unique handle.', 409)
      Object.assign(patch, { redirectNewHandle: true })
    }
    if (edit.field === 'category') Object.assign(patch, { deleteConflictingConstrainedMetafields: false })
    assertShopifyResult((await gql('mutation NexusInformationProductUpdate($product:ProductUpdateInput!) { productUpdate(product:$product) { product { id } userErrors { field message } } }', { product: { id: edit.ownerId, ...patch } })).productUpdate, 'Update product information')
  } else {
    const patch = edit.field === 'weight' ? { inventoryItem: { measurement: { weight: value } } }
      : ['sku', 'requiresShipping', 'harmonizedSystemCode', 'countryCodeOfOrigin', 'cost', 'tracked'].includes(edit.field) ? { inventoryItem: { [edit.field]: value } } : { [edit.field]: value }
    assertShopifyResult((await gql('mutation NexusInformationVariantUpdate($id:ID!,$variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$id,variants:$variants,allowPartialUpdates:false) { productVariants { id } userErrors { field message } } }', { id: edit.productId, variants: [{ id: edit.ownerId, ...patch }] })).productVariantsBulkUpdate, 'Update variant information')
  }
  const [verified] = await readInformationNativeOwners(gql, [edit.ownerId])
  if (!nativeValuesEqual(edit.field, verified?.values[edit.field], edit.nextValue)) throw new WorkspaceScopeError(`${edit.ownerLabel}: Shopify has not confirmed the requested value. Keep the draft for review.`, 502)
}

/** Checkpoint submitting BEFORE mutation. An unknown submission is reconciled, never blindly repeated. */
export async function advanceMediaOrder(gql: ShopifyGraphql, edit: MediaOrderEdit, state: { submitted?: boolean; jobId?: string } | undefined,
  checkpoint: (state: { submitted: boolean; jobId?: string }) => Promise<void>): Promise<boolean> {
  if (state?.jobId) {
    const { job } = await gql('query NexusInformationMediaJob($id:ID!) { job(id:$id) { id done } }', { id: state.jobId })
    if (!job || job.id !== state.jobId) throw new WorkspaceScopeError('The media job could not be verified. The intended order is retained.', 502)
    if (!job.done) return false
  }
  const media = !state?.submitted && (edit.membershipChanged || edit.altEdits?.length) ? await applyMediaMembership(gql, edit) : await readInformationMedia(gql, edit.productId), ids = media.map(m => m.id)
  if (JSON.stringify(ids) === JSON.stringify(edit.nextValue)) return true
  if (state?.submitted) throw new WorkspaceScopeError('The previous media request has an uncertain or different result. Review the latest gallery before submitting another reorder.')
  if (!edit.membershipChanged && JSON.stringify(ids) !== JSON.stringify(edit.value)) throw new WorkspaceScopeError('The gallery changed in Shopify. Review the current order before synchronizing.')
  if (media.some(m => m.status !== 'READY')) throw new WorkspaceScopeError('Wait until every gallery item has finished processing before reordering.', 422)
  const moves = mediaMoves(ids, edit.nextValue)
  await checkpoint({ submitted: true })
  const { productReorderMedia: result } = await gql('mutation NexusInformationReorder($id:ID!,$moves:[MoveInput!]!) { productReorderMedia(id:$id,moves:$moves) { job { id } mediaUserErrors { field message } } }', { id: edit.productId, moves })
  if (!result || result.mediaUserErrors?.length || !result.job?.id) throw new WorkspaceScopeError(result?.mediaUserErrors?.map((e: any) => e.message).join('; ') || 'Shopify did not confirm a media job. Review the saved operation.', 502)
  await checkpoint({ submitted: true, jobId: result.job.id })
  return false
}
