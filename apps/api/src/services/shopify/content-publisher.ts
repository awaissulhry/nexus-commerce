import { createHash } from 'node:crypto'
import { fieldKey, inspectShopifyContent, resolveShopifyContent, localizedValue, collectionCards, type ShopifyContent, type ContentVariant, type ContentField, type ContentValue } from '@nexus/shared/shopify-content'
import { assertShopifyResult as checked, type ShopifyGraphql } from './admin-client.js'
import { readInformationMedia, advanceMediaOrder } from './information-gateway.js'
import { verifyMediaMembership } from './information-media-membership.js'
import type { MediaOrderEdit } from '@nexus/shared/shopify-information'

export type ContentGalleryOperation = { edit: MediaOrderEdit; state?: { submitted?: boolean; jobId?: string }; verified?: boolean }
export async function resumeContentGallery(gql: ShopifyGraphql, operation: ContentGalleryOperation, productId: string | undefined, checkpoint: (patch: Record<string, unknown>) => Promise<void>) {
  if (operation.edit.productId !== productId) throw new Error('The saved media operation belongs to a different Shopify product. Reconcile that operation before publishing.')
  let state = operation.state
  for (let attempt = 0; attempt < 20; attempt++) {
    const done = await advanceMediaOrder(gql, operation.edit, state, async next => { state = next; await checkpoint({ galleryOperation: { edit: operation.edit, state: next } }) })
    if (done) { await checkpoint({ galleryOperation: { edit: operation.edit, state, verified: true } }); return }
    if (attempt === 19) throw new Error('The gallery order is still processing. Its saved job must be verified before publication is complete.')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

export interface ShopifyRemoteProduct {
  id: string; handle: string; status: string; updatedAt: string
  variants: { nodes: { id: string; sku: string; price: string; compareAtPrice?: string | null; selectedOptions: { name: string; value: string }[]; inventoryItem: { id: string }; media: { nodes: { id: string }[] } }[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }
  media: { nodes: { id: string; status: string }[]; pageInfo: { hasNextPage: boolean } }
  metafields: { nodes: { id: string; namespace: string; key: string; type: string; value: string; compareDigest: string }[]; pageInfo: { hasNextPage: boolean } }
}
const VARIANT_SELECTION = `id sku price compareAtPrice selectedOptions { name value } inventoryItem { id } media(first:1) { nodes { id } }`
export const PRODUCT_SELECTION = `id handle status updatedAt variants(first:50) { nodes { ${VARIANT_SELECTION} } pageInfo { hasNextPage endCursor } } media(first:250) { nodes { id status } pageInfo { hasNextPage } } metafields(first:250) { nodes { id namespace key type value compareDigest } pageInfo { hasNextPage } }`
export const toGid = (type: string, value: string) => value.startsWith('gid://') ? value : `gid://shopify/${type}/${value}`
export const shortId = (gid: string) => gid.split('/').at(-1)!
export async function readRemoteProduct(gql: ShopifyGraphql, productId?: string | null, familyIdentity?: string): Promise<ShopifyRemoteProduct | null> {
  if (!productId) {
    const existing = await definitions(gql, 'PRODUCT')
    if (!existing.some(d => d.namespace === 'nexus' && d.key === 'family_id' && d.capabilities.uniqueValues.enabled)) return null
  }
  const data = productId ? await gql(`query NexusProduct($id:ID!) { product(id:$id) { ${PRODUCT_SELECTION} } }`, { id: toGid('Product', productId) })
    : await gql(`query NexusProductIdentity($identifier:ProductIdentifierInput!) { product:productByIdentifier(identifier:$identifier) { ${PRODUCT_SELECTION} } }`, { identifier: { customId: { namespace: 'nexus', key: 'family_id', value: familyIdentity } } })
  const product = data.product as ShopifyRemoteProduct | null
  while (product?.variants.pageInfo.hasNextPage && product.variants.nodes.length <= 250) {
    const next = await gql(`query NexusMoreVariants($id:ID!,$after:String!) { product(id:$id) { variants(first:100,after:$after) { nodes { ${VARIANT_SELECTION} } pageInfo { hasNextPage endCursor } } } }`, { id: product.id, after: product.variants.pageInfo.endCursor })
    if (!next.product) throw new Error('The Shopify product disappeared while reading variants.')
    product.variants.nodes.push(...next.product.variants.nodes)
    product.variants.pageInfo = next.product.variants.pageInfo
  }
  if (product && product.variants.nodes.length > 250) throw new Error('This Shopify product exceeds the supported 250 variants. Nothing has been changed.')
  if (product && [product.variants, product.media, product.metafields].some(c => c.pageInfo.hasNextPage)) throw new Error('This Shopify product exceeds the supported 250 variants, media or metafields. Nothing has been changed.')
  return product
}

type Definition = { id: string; namespace: string; key: string; type: { name: string }; access: { storefront: string }; validations: { name: string; value: string }[]; capabilities: { uniqueValues: { enabled: boolean } } }
async function definitions(gql: ShopifyGraphql, ownerType: string): Promise<Definition[]> {
  const all: Definition[] = []; let after: string | null = null
  do {
    const { metafieldDefinitions: page } = await gql(`query NexusDefinitions($ownerType:MetafieldOwnerType!,$after:String) { metafieldDefinitions(ownerType:$ownerType,first:100,after:$after) { nodes { id namespace key type { name } access { storefront } validations { name value } capabilities { uniqueValues { enabled } } } pageInfo { hasNextPage endCursor } } }`, { ownerType, after })
    all.push(...page.nodes); after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return all
}

/** Reuse compatible merchant definitions; never overwrite their types, access or validation. */
export async function ensureContentDefinitions(gql: ShopifyGraphql, content: ShopifyContent) {
  const metaIds: Record<string, string> = {}
  const pending = [...content.metaobjectDefinitions]
  while (pending.length) {
    const index = pending.findIndex(d => d.fields.every(f => !f.metaobjectType || metaIds[f.metaobjectType]))
    if (index < 0) throw new Error('Metaobject definitions contain a cycle or reference an undefined type.')
    const def = pending.splice(index, 1)[0]
    const { metaobjectDefinitionByType: existing } = await gql(`query NexusMetaobjectDefinition($type:String!) { metaobjectDefinitionByType(type:$type) { id access { storefront } capabilities { translatable { enabled } } fieldDefinitions { key type { name } validations { name value } } } }`, { type: def.type })
    const fields = def.fields.map(f => ({ key: f.key, name: f.label, type: f.type, ...(f.metaobjectType ? { validations: [{ name: 'metaobject_definition_id', value: metaIds[f.metaobjectType] }] } : {}) }))
    if (existing) {
      for (const f of fields) {
        const actual = existing.fieldDefinitions.find((a: any) => a.key === f.key)
        if (!actual || actual.type.name !== f.type || f.validations?.some(v => !actual.validations.some((a: any) => a.name === v.name && a.value === v.value))) throw new Error(`Metaobject ${def.type}.${f.key} has an incompatible Shopify definition.`)
      }
      if (existing.access.storefront !== 'PUBLIC_READ') throw new Error(`Metaobject ${def.type} is not readable by the storefront.`)
      if (!existing.capabilities.translatable.enabled && content.metaobjects.some(m => m.type === def.type && Object.values(m.fields).some(v => Object.keys(v.translations).length))) throw new Error(`Enable translations on metaobject ${def.type} before publishing translated entries.`)
      metaIds[def.type] = existing.id
    } else {
      const data = await gql(`mutation NexusCreateMetaobjectDefinition($definition:MetaobjectDefinitionCreateInput!) { metaobjectDefinitionCreate(definition:$definition) { metaobjectDefinition { id } userErrors { field message } } }`, { definition: { type: def.type, name: def.name, access: { storefront: 'PUBLIC_READ' }, capabilities: { translatable: { enabled: true } }, fieldDefinitions: fields } })
      metaIds[def.type] = checked(data.metaobjectDefinitionCreate, 'Create metaobject definition').metaobjectDefinition.id
    }
  }
  for (const ownerType of ['PRODUCT', 'PRODUCTVARIANT']) {
    const existing = await definitions(gql, ownerType)
    const fields = [...content.fields, { namespace: 'nexus', key: 'resolved', label: 'Nexus resolved content', type: 'json' as const }, ...(ownerType === 'PRODUCT' ? [{ namespace: 'nexus', key: 'family_id', label: 'Nexus family identity', type: 'single_line_text_field' as const }] : [])]
    for (const f of fields) {
      const isIdentity = f.namespace === 'nexus' && f.key === 'family_id'
      const validations = 'metaobjectType' in f && f.metaobjectType ? [{ name: 'metaobject_definition_id', value: metaIds[f.metaobjectType] }] : []
      if (validations.some(v => !v.value)) throw new Error(`Missing metaobject definition for ${fieldKey(f)}.`)
      const current = existing.find(d => d.namespace === f.namespace && d.key === f.key)
      if (current) {
        if (current.type.name !== f.type || current.access.storefront !== 'PUBLIC_READ' || (isIdentity && !current.capabilities.uniqueValues.enabled) || validations.some(v => !current.validations.some(a => a.name === v.name && a.value === v.value))) throw new Error(`${ownerType} ${fieldKey(f)} has an incompatible type, reference validation or storefront access.`)
      } else {
        checked((await gql(`mutation NexusCreateDefinition($definition:MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition:$definition) { createdDefinition { id } userErrors { field message } } }`, { definition: { namespace: f.namespace, key: f.key, name: f.label, type: f.type, ownerType, access: { storefront: 'PUBLIC_READ' }, validations, ...(isIdentity ? { capabilities: { uniqueValues: { enabled: true } } } : {}) } })).metafieldDefinitionCreate, 'Create metafield definition')
      }
    }
  }
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function publishContentImages(gql: ShopifyGraphql, content: ShopifyContent, checkpoint: (patch: Record<string, unknown>) => Promise<void>, identity?: string) {
  const ids: Record<string, string> = {}
  for (const asset of content.assets) {
    // Content includes alt so one family's alt change never mutates another family's reused file.
    const ext = new URL(asset.url).pathname.match(/\.(jpe?g|png|webp|gif|avif|mp4|mov|webm|glb|usdz)$/i)?.[1]?.toLowerCase() ?? (asset.type === 'VIDEO' ? 'mp4' : asset.type === 'MODEL_3D' ? 'glb' : 'jpg')
    const filename = `nexus-${hash([asset.url, asset.alt, ...(identity ? [identity, asset.translations] : [])]).slice(0, 40)}.${ext}`
    const { files } = await gql(`query NexusImage($query:String!) { files(first:2,query:$query) { nodes { id fileStatus ... on MediaImage { image { url } } } } }`, { query: `filename:${filename}` })
    if (files.nodes.length > 1) throw new Error(`Image identity is ambiguous: ${asset.id}.`)
    let file = files.nodes[0]
    if (!file) {
      const result = checked((await gql(`mutation NexusImageCreate($files:[FileCreateInput!]!) { fileCreate(files:$files) { files { id fileStatus } userErrors { field message } } }`, { files: [{ originalSource: asset.url, contentType: asset.type ?? 'IMAGE', filename, alt: asset.alt, duplicateResolutionMode: 'RAISE_ERROR' }] })).fileCreate, 'Create media')
      file = result.files[0]
    }
    const ownerType = asset.type === 'VIDEO' ? 'Video' : asset.type === 'MODEL_3D' ? 'Model3d' : 'MediaImage'
    if (!file?.id?.startsWith(`gid://shopify/${ownerType}/`)) throw new Error(`Shopify did not return the expected ${asset.type ?? 'IMAGE'} file for ${asset.id}.`)
    ids[asset.id] = file.id
    await checkpoint({ mediaIds: { ...ids } })
    // Bounded processing wait. Unready media never reaches the variant manifest.
    for (let attempt = 0; file.fileStatus !== 'READY' && attempt < 20; attempt++) {
      if (file.fileStatus === 'FAILED') throw new Error(`Shopify could not process image ${asset.id}. Replace it and retry.`)
      await new Promise(resolve => setTimeout(resolve, 1500))
      file = (await gql(`query NexusFileStatus($id:ID!) { node(id:$id) { ... on File { id fileStatus } } }`, { id: file.id })).node
      if (!file) throw new Error(`Image ${asset.id} disappeared during processing.`)
    }
    if (file.fileStatus !== 'READY') throw new Error(`Image ${asset.id} is still processing. Retry to continue with the same file.`)
  }
  return ids
}

function replaceReferences(value: string, ids: Record<string, string>, media: Record<string, string> = {}) { return value.replace(/@(metaobject|image):([A-Za-z0-9_-]+)/g, (match, kind, id) => { const resolved = (kind === 'image' ? media : ids)[id]; if (!resolved) throw new Error(`Unresolved ${kind} ${id}.`); return resolved }) }
export async function publishTranslations(gql: ShopifyGraphql, resourceId: string, values: Record<string, ContentValue>, content: ShopifyContent) {
  const locales = content.locales.filter(l => l !== content.defaultLocale)
  if (!locales.length) return
  const { translatableResource: resource } = await gql(`query NexusTranslationSource($id:ID!) { translatableResource(resourceId:$id) { translatableContent { key digest locale } } }`, { id: resourceId })
  if (!resource) { if (Object.values(values).some(v => Object.keys(v.translations).length)) throw new Error(`Shopify cannot translate resource ${resourceId}.`); return }
  const translations = [], remove: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const source = resource.translatableContent.find((v: any) => v.key === key)
    if (!source) { if (Object.keys(value.translations).length) throw new Error(`Shopify cannot translate ${key} on ${resourceId}.`); continue }
    for (const locale of locales) {
      if (Object.prototype.hasOwnProperty.call(value.translations, locale)) translations.push({ key, locale, value: value.translations[locale], translatableContentDigest: source.digest })
      else remove.push(`${key}\u0000${locale}`)
    }
  }
  for (const locale of locales) {
    const keys = remove.filter(v => v.endsWith(`\u0000${locale}`)).map(v => v.split('\u0000')[0])
    if (keys.length) checked((await gql(`mutation NexusTranslationsRemove($id:ID!,$keys:[String!]!,$locales:[String!]!) { translationsRemove(resourceId:$id,translationKeys:$keys,locales:$locales) { userErrors { field message } } }`, { id: resourceId, keys, locales: [locale] })).translationsRemove, 'Remove stale translations')
  }
  if (translations.length) checked((await gql(`mutation NexusTranslations($id:ID!,$translations:[TranslationInput!]!) { translationsRegister(resourceId:$id,translations:$translations) { userErrors { field message } } }`, { id: resourceId, translations })).translationsRegister, 'Save translations')
  for (const locale of locales) {
    const result = await gql(`query NexusTranslationReadback($id:ID!,$locale:String!) { translatableResource(resourceId:$id) { translations(locale:$locale) { key value outdated } } }`, { id: resourceId, locale })
    if (!result.translatableResource) throw new Error(`Translation readback is unavailable for ${resourceId}.`)
    for (const key of Object.keys(values).filter(key => resource.translatableContent.some((v: any) => v.key === key))) {
      const actual = result.translatableResource.translations.find((t: any) => t.key === key)
      if (actual?.value !== values[key].translations[locale] || actual?.outdated) throw new Error(`Translation readback differs for ${key} (${locale}).`)
    }
  }
}

export async function publishMetaobjects(gql: ShopifyGraphql, content: ShopifyContent, mediaIds: Record<string, string> = {}) {
  const ids: Record<string, string> = {}, pending = [...content.metaobjects]
  while (pending.length) {
    const index = pending.findIndex(m => Object.entries(m.fields).filter(([key]) => content.metaobjectDefinitions.find(d => d.type === m.type)?.fields.find(f => f.key === key)?.type.includes('metaobject_reference')).every(([, v]) => !(v.value?.match(/@metaobject:([A-Za-z0-9_-]+)/g) ?? []).some(ref => !ids[ref.slice(12)])))
    if (index < 0) throw new Error('Reusable entries contain a cycle or a missing reference.')
    const entry = pending.splice(index, 1)[0]
    const fields = Object.entries(entry.fields).filter(([, value]) => value.value !== null).map(([key, value]) => { const raw = localizedValue(value, content.defaultLocale, content.defaultLocale)!; const field = content.metaobjectDefinitions.find(d => d.type === entry.type)!.fields.find(f => f.key === key)!; return { key, value: field.type.includes('reference') ? replaceReferences(raw, ids, mediaIds) : raw } })
    const { metaobjectDefinitionByType: definition } = await gql(`query NexusEntryCapabilities($type:String!) { metaobjectDefinitionByType(type:$type) { capabilities { publishable { enabled } } } }`, { type: entry.type })
    // Immutable versions preserve source/live products during draft review; identical entries remain reusable.
    const handle = `nexus-${hash([entry.type, entry.id, fields, entry.fields]).slice(0, 32)}`
    const result = checked((await gql(`mutation NexusMetaobject($handle:MetaobjectHandleInput!,$metaobject:MetaobjectUpsertInput!) { metaobjectUpsert(handle:$handle,metaobject:$metaobject) { metaobject { id } userErrors { field message } } }`, { handle: { type: entry.type, handle }, metaobject: { fields, ...(definition?.capabilities.publishable.enabled ? { capabilities: { publishable: { status: 'ACTIVE' } } } : {}) } })).metaobjectUpsert, 'Save reusable entry')
    ids[entry.id] = result.metaobject.id
    await publishTranslations(gql, result.metaobject.id, entry.fields, content)
    const readback = await gql(`query NexusEntryReadback($id:ID!) { metaobject(id:$id) { fields { key value } } }`, { id: result.metaobject.id })
    if (!readback.metaobject || fields.some(f => readback.metaobject.fields.find((v: any) => v.key === f.key)?.value !== f.value)) throw new Error(`Reusable entry readback differs for ${entry.id}.`)
  }
  return ids
}

/** Native variant IDs are stable. Refuse implicit removals and ambiguous SKU matches. */
export function mapRemoteVariants(variants: ContentVariant[], remote: ShopifyRemoteProduct | null) {
  const ids: Record<string, string> = {}
  for (const v of variants) {
    const matches = remote?.variants.nodes.filter(r => v.shopifyVariantId ? r.id === toGid('ProductVariant', v.shopifyVariantId) : r.sku === v.sku) ?? []
    if (matches.length > 1) throw new Error(`Shopify has multiple variants with SKU ${v.sku}. Resolve the duplicate before syncing.`)
    if (v.shopifyVariantId && !matches.length) throw new Error(`The mapped Shopify variant for ${v.sku} was removed. Reconcile its identity before syncing.`)
    if (matches.length) ids[v.id] = matches[0].id
  }
  if (remote?.variants.nodes.some(v => !Object.values(ids).includes(v.id))) throw new Error('Shopify has variants outside this Nexus family. Import or reconcile them before syncing; no variants were removed.')
  return ids
}

/**
 * 🔴 VT.4 — EXTRACTED VERBATIM from `publishContent`'s body (2026-09-13). Same expression, same output;
 * `publishContent` now calls it instead of inlining it.
 *
 * Why: the dry-run `shopify-in-place` theme-change plan (`services/pim/theme-change.service.ts`, VX §9 / D8)
 * has to show the operator the option list a re-theme would send, and the ONE thing this codebase already
 * knows about Shopify options is this expression. Composing it a second time inside the plan would be the
 * "second composer" the design forbids (VX §8). `theme-change.vitest.test.ts` pins plan ≡ this function.
 *
 * Measured, and stated so the plan does not overclaim: `productOptionsCreate`, `productOptionUpdate` and
 * `productOptionsDelete` do **not exist anywhere in this codebase** (0 occurrences outside the web design
 * mock's fixture strings). The plan therefore NAMES those three mutations and their constraints as steps,
 * and the only payload it can pin against live code is this option list — which is what the `productSet`
 * publish actually sends.
 *
 * `'Title'` / `'Default Title'` are Shopify's own names for the single implicit option a product with no
 * axes carries; they are not a Nexus label and are not translated.
 */
export function shopifyOptionAxes(axes: string[]): string[] {
  return axes.length ? axes : ['Title']
}

export function buildShopifyProductOptions(
  axes: string[],
  variants: Array<{ options: Record<string, string> }>,
  optionNames: Record<string, string> = {},
): Array<{ name: string; position: number; values: Array<{ name: string }> }> {
  return shopifyOptionAxes(axes).map((name, index) => ({
    name: optionNames[name] ?? name,
    position: index + 1,
    values: [...new Set(variants.map(v => axes.length ? v.options[name] : 'Default Title'))].map(name => ({ name })),
  }))
}

export interface PublishContentInput { identity: string; title: string; description: string; vendor: string; productType: string; tags?: string[]; content: ShopifyContent; variants: ContentVariant[]; locationId: string; remote: ShopifyRemoteProduct | null; confirmActive?: boolean; managedMediaIds?: string[]; reconcileGallery?: boolean; galleryOperation?: ContentGalleryOperation }
export async function publishContent(gql: ShopifyGraphql, input: PublishContentInput, checkpoint: (patch: Record<string, unknown>) => Promise<void>) {
  const { content, variants, remote } = input
  const problems = inspectShopifyContent(content, variants)
  if (problems.length) throw new Error(problems.join('\n'))
  if (remote && remote.status !== 'DRAFT' && !input.confirmActive) throw new Error('This product is live or archived. Review the remote changes and explicitly approve synchronisation before continuing.')
  if (input.galleryOperation && !input.galleryOperation.verified) await resumeContentGallery(gql, input.galleryOperation, remote?.id, checkpoint)
  if (input.reconcileGallery) await checkpoint({ managedMediaIds: input.managedMediaIds ?? [] })
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(input.locationId)) throw new Error('Choose a Shopify inventory location before publishing.')
  const { location } = await gql(`query NexusInventoryLocation($id:ID!) { location(id:$id) { id isActive } }`, { id: input.locationId })
  if (!location?.isActive) throw new Error('The selected Shopify inventory location is unavailable.')
  const variantIds = mapRemoteVariants(variants, remote)
  const observedStock: Record<string, number> = {}
  for (const variant of variants.filter(v => variantIds[v.id])) {
    const result = await gql(`query NexusInventoryBefore($id:ID!,$location:ID!) { productVariant(id:$id) { inventoryItem { inventoryLevel(locationId:$location) { quantities(names:["available"]) { name quantity } } } } }`, { id: variantIds[variant.id], location: input.locationId })
    const quantity = result.productVariant?.inventoryItem.inventoryLevel?.quantities.find((q: any) => q.name === 'available')?.quantity
    if (!Number.isSafeInteger(quantity)) throw new Error(`${variant.sku}: inventory is not active at the selected location. Activate it in Shopify before synchronising this existing product.`)
    observedStock[variant.id] = quantity
  }
  await ensureContentDefinitions(gql, content)
  const mediaIds = await publishContentImages(gql, content, checkpoint)
  const metaobjectIds = await publishMetaobjects(gql, content, mediaIds)
  const resolved = variants.map(v => ({ variant: v, content: resolveShopifyContent(content, v) }))
  const family = resolveShopifyContent(content, null)
  const ordered = [...new Set([...family.assetIds, ...resolved.flatMap(r => r.content.assetIds)])].map(id => mediaIds[id])
  const files = [...new Set([...ordered, ...(remote?.media.nodes.map(m => m.id) ?? [])])].map(id => ({ id }))
  if (files.length > 250) throw new Error('The combined existing and assigned media exceed Shopify’s 250 product-media limit. Review unused media before syncing.')
  const axes = shopifyOptionAxes(content.axes)
  const productOptions = buildShopifyProductOptions(content.axes, variants, content.optionNames)
  if (remote && hash(await readRemoteProduct(gql, remote.id)) !== hash(remote)) throw new Error('The Shopify product changed while preparing images and entries. Refresh the review before synchronising.')
  // Metafields are written separately: preserve unrelated merchant/app fields.
  const productSet = { title: input.title, descriptionHtml: input.description, vendor: input.vendor, productType: input.productType, ...(Array.isArray(input.tags) ? { tags: input.tags } : {}), ...(!remote ? { status: 'DRAFT', templateSuffix: 'nexus' } : {}), productOptions, files,
    variants: resolved.map(({ variant: v, content: r }) => ({ ...(variantIds[v.id] ? { id: variantIds[v.id] } : { inventoryPolicy: 'DENY', inventoryItem: { tracked: true } }), sku: v.sku, price: v.price, ...(v.compareAtPrice !== undefined ? { compareAtPrice: v.compareAtPrice } : {}),
      ...(!variantIds[v.id] ? { inventoryQuantities: [{ locationId: input.locationId, name: 'available', quantity: v.stock }] } : {}), optionValues: axes.map(optionName => ({ optionName: content.optionNames?.[optionName] ?? optionName, name: content.axes.length ? v.options[optionName] : 'Default Title' })), ...(r.featuredId ? { file: { id: mediaIds[r.featuredId] } } : {}),
    })) }
  const result = checked((await gql(`mutation NexusProductSet($input:ProductSetInput!,$identifier:ProductSetIdentifiers) { productSet(input:$input,identifier:$identifier,synchronous:true) { product { id } userErrors { field message } } }`, { input: productSet, identifier: remote ? { id: remote.id } : { customId: { namespace: 'nexus', key: 'family_id', value: input.identity } } })).productSet, 'Synchronise native variants')
  const productId: string = result.product?.id
  if (!productId) throw new Error('Shopify did not return a product ID. Reconcile before retrying.')
  await checkpoint({ productId })
  const published = await readRemoteProduct(gql, productId)
  if (!published) throw new Error('The saved Shopify product could not be read back.')
  const savedIds = mapRemoteVariants(variants.map(v => ({ ...v, shopifyVariantId: null })), published)
  if (Object.keys(savedIds).length !== variants.length) throw new Error('Shopify variant readback does not match the complete Nexus family.')
  const inventoryItemIds = Object.fromEntries(variants.map(v => [v.id, published.variants.nodes.find(r => r.id === savedIds[v.id])!.inventoryItem.id]))
  await checkpoint({ variantIds: savedIds, inventoryItemIds, mediaIds, metaobjectIds })
  const stockChanges = variants.filter(v => variantIds[v.id] && observedStock[v.id] !== v.stock).map(v => ({ inventoryItemId: inventoryItemIds[v.id], locationId: input.locationId, quantity: v.stock, changeFromQuantity: observedStock[v.id] }))
  if (stockChanges.length) checked((await gql(`mutation NexusFamilyInventory($input:InventorySetQuantitiesInput!,$idempotencyKey:String!) { inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey) { userErrors { field message } } }`, { input: { name: 'available', reason: 'correction', referenceDocumentUri: `nexus://family/${encodeURIComponent(input.identity)}`, quantities: stockChanges }, idempotencyKey: hash([input.identity, remote?.updatedAt, stockChanges]) })).inventorySetQuantities, 'Synchronise variant inventory')
  const manifest = (r: ReturnType<typeof resolveShopifyContent>, isFamily = false) => ({ version: 1, managed: true, defaultLocale: content.defaultLocale,
    ...(isFamily ? { cards: collectionCards(content, variants).map(card => ({ ...card, variantIds: card.variantIds.map(id => shortId(savedIds[id])) })), swatches: collectionCards({ ...content, collectionMode: 'groups' }, variants).map(card => ({ ...card, variantIds: card.variantIds.map(id => shortId(savedIds[id])) })), thumbnailAxisIndexes: collectionCards({ ...content, collectionMode: 'groups' }, variants)[0]?.optionIndexes ?? [] } : {}),
    mediaIds: r.assetIds.map(id => shortId(mediaIds[id])), featuredId: r.featuredId ? shortId(mediaIds[r.featuredId]) : null,
    fields: content.fields.map(fieldKey), displayFields: content.fields.filter(f => f.storefront).map(f => ({ key: fieldKey(f), label: f.label })), entryTypes: content.metaobjectDefinitions.map(d => ({ type: d.type, fields: d.fields.map(f => ({ key: f.key, label: f.label })) })), cleared: content.fields.filter(f => r.fields[fieldKey(f)] === null || !Object.prototype.hasOwnProperty.call(r.fields, fieldKey(f))).map(fieldKey),
    alts: Object.fromEntries(r.assetIds.map(id => { const a = content.assets.find(a => a.id === id)!; return [shortId(mediaIds[id]), { ...a.translations, default: a.alt, [content.defaultLocale]: a.alt }] })),
    accessibility: Object.fromEntries(r.assetIds.filter(id => content.assets.find(a => a.id === id)?.accessibility).map(id => [shortId(mediaIds[id]), content.assets.find(a => a.id === id)!.accessibility])),
  })
  const detach = []
  for (const r of resolved.filter(r => !r.content.featuredId)) {
    const old = published.variants.nodes.find(v => v.id === savedIds[r.variant.id])!
    if (!old.media.nodes.length) continue
    const result = await gql(`query NexusVariantMedia($id:ID!) { productVariant(id:$id) { media(first:250) { nodes { id } pageInfo { hasNextPage } } } }`, { id: old.id })
    if (!result.productVariant || result.productVariant.media.pageInfo.hasNextPage) throw new Error('Variant media could not be read completely before clearing its featured image.')
    detach.push({ variantId: old.id, mediaIds: result.productVariant.media.nodes.map((m: any) => m.id) })
  }
  if (detach.length) checked((await gql(`mutation NexusDetachFeatured($productId:ID!,$variantMedia:[ProductVariantDetachMediaInput!]!) { productVariantDetachMedia(productId:$productId,variantMedia:$variantMedia) { userErrors { field message } } }`, { productId, variantMedia: detach })).productVariantDetachMedia, 'Clear variant featured images')
  const targets = [...resolved.map(r => ({ id: savedIds[r.variant.id], resolved: r.content })), { id: productId, resolved: family }]
  for (const target of targets) {
    const current = await gql(`query NexusOwnerFields($id:ID!) { node(id:$id) { ... on Product { metafields(first:250) { nodes { id namespace key value compareDigest } pageInfo { hasNextPage } } } ... on ProductVariant { metafields(first:250) { nodes { id namespace key value compareDigest } pageInfo { hasNextPage } } } } }`, { id: target.id })
    if (current.node?.metafields.pageInfo.hasNextPage) throw new Error('The metafield readback is incomplete; no field updates were attempted for this owner.')
    const existing = current.node?.metafields.nodes ?? []
    const writes = [], deletes = []
    for (const field of content.fields) {
      const key = fieldKey(field), raw = target.resolved.fields[key], old = existing.find((f: any) => f.namespace === field.namespace && f.key === field.key)
      if (raw === null || raw === undefined) { if (old) deletes.push({ ownerId: target.id, namespace: field.namespace, key: field.key }); continue }
      writes.push({ ownerId: target.id, namespace: field.namespace, key: field.key, type: field.type, value: field.type.includes('reference') ? replaceReferences(raw, metaobjectIds, mediaIds) : raw, compareDigest: old?.compareDigest ?? null })
    }
    const oldManifest = existing.find((f: any) => f.namespace === 'nexus' && f.key === 'resolved')
    // The manifest is committed last so the theme never observes a new field contract before its data.
    for (let i = 0; i < writes.length; i += 25) {
      const payload = checked((await gql(`mutation NexusFields($metafields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$metafields) { metafields { id namespace key } userErrors { field message } } }`, { metafields: writes.slice(i, i + 25) })).metafieldsSet, 'Save metafields')
      for (const saved of payload.metafields) {
        const value = target.resolved.values[`${saved.namespace}.${saved.key}`]
        const field = content.fields.find(f => f.namespace === saved.namespace && f.key === saved.key)!
        if (['single_line_text_field', 'multi_line_text_field', 'rich_text_field'].includes(field.type)) await publishTranslations(gql, saved.id, { value }, content)
      }
    }
    for (let i = 0; i < deletes.length; i += 25) checked((await gql(`mutation NexusClearFields($metafields:[MetafieldIdentifierInput!]!) { metafieldsDelete(metafields:$metafields) { userErrors { field message } } }`, { metafields: deletes.slice(i, i + 25) })).metafieldsDelete, 'Clear overridden fields')
    checked((await gql(`mutation NexusManifest($metafields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$metafields) { userErrors { field message } } }`, { metafields: [{ ownerId: target.id, namespace: 'nexus', key: 'resolved', type: 'json', value: JSON.stringify(manifest(target.resolved, target.id === productId)), compareDigest: oldManifest?.compareDigest ?? null }] })).metafieldsSet, 'Commit resolved content')
  }
  if (input.reconcileGallery) {
    const gallery = await readInformationMedia(gql, productId), currentIds = gallery.map(m => m.id)
    const managed = new Set(input.managedMediaIds ?? [])
    const nextValue = [...new Set([...ordered, ...(remote?.media.nodes.map(m => m.id).filter(id => !managed.has(id)) ?? [])])]
    if (currentIds.some(id => !nextValue.includes(id) && !managed.has(id))) throw new Error('The Shopify gallery changed outside the reviewed publication. Review its attachments before retrying.')
    const edit = await verifyMediaMembership(gql, { productId, ownerLabel: input.title, value: currentIds, nextValue, membershipChanged: true })
    await checkpoint({ galleryOperation: { edit } })
    await resumeContentGallery(gql, { edit }, productId, checkpoint)
  }
  const verified = await readRemoteProduct(gql, productId)
  if (!verified || verified.variants.nodes.length !== variants.length) throw new Error('Final Shopify readback is incomplete.')
  for (const target of targets) {
    const readback = await gql(`query NexusContentReadback($id:ID!) { node(id:$id) { ... on Product { metafields(first:250) { nodes { namespace key value } pageInfo { hasNextPage } } } ... on ProductVariant { metafields(first:250) { nodes { namespace key value } pageInfo { hasNextPage } } } } }`, { id: target.id })
    const actual = readback.node?.metafields
    if (!actual || actual.pageInfo.hasNextPage) throw new Error('Custom content readback is incomplete.')
    for (const field of content.fields) {
      const raw = target.resolved.fields[fieldKey(field)], saved = actual.nodes.find((f: any) => f.namespace === field.namespace && f.key === field.key)
      const expected = raw == null ? undefined : field.type.includes('reference') ? replaceReferences(raw, metaobjectIds, mediaIds) : raw
      if (saved?.value !== expected) throw new Error(`Custom content readback differs for ${fieldKey(field)} on ${target.id}.`)
    }
    if (actual.nodes.find((f: any) => f.namespace === 'nexus' && f.key === 'resolved')?.value !== JSON.stringify(manifest(target.resolved, target.id === productId))) throw new Error(`Resolved content readback differs on ${target.id}.`)
  }
  for (const v of variants) {
    const actual = verified.variants.nodes.find(r => r.id === savedIds[v.id])
    const expected = resolveShopifyContent(content, v)
    if (!actual || actual.sku !== v.sku || Number(actual.price) !== Number(v.price) || (v.compareAtPrice !== undefined && Number(actual.compareAtPrice) !== Number(v.compareAtPrice)) || content.axes.some(axis => !actual.selectedOptions.some(o => o.name === (content.optionNames?.[axis] ?? axis) && o.value === v.options[axis])) || (expected.featuredId ? actual.media.nodes[0]?.id !== mediaIds[expected.featuredId] : actual.media.nodes.length > 0)) throw new Error(`Shopify readback differs for ${v.sku}. The publication is not verified.`)
    const check = await gql(`query NexusVariantReadback($id:ID!,$location:ID!) { productVariant(id:$id) { metafield(namespace:"nexus",key:"resolved") { value } inventoryItem { inventoryLevel(locationId:$location) { quantities(names:["available"]) { name quantity } } } } }`, { id: actual.id, location: input.locationId })
    if (check.productVariant?.metafield?.value !== JSON.stringify(manifest(expected)) || check.productVariant?.inventoryItem.inventoryLevel?.quantities[0]?.quantity !== v.stock) throw new Error(`Gallery or inventory readback differs for ${v.sku}.`)
  }
  return { productId, variantIds: savedIds, inventoryItemIds, mediaIds, metaobjectIds, contentHash: hash(content), status: 'VERIFIED', lastVerifiedAt: new Date().toISOString(), remoteUpdatedAt: verified.updatedAt, handle: verified.handle }
}
