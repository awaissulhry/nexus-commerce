import type { ShopifyFieldDefinition, ShopifyFieldOwner, ShopifyFieldSnapshot, ShopifyLinkedMember, ShopifyReferencePage, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyGid, shopifyProductGid } from '@nexus/shared/shopify-linked-products'
import { createHash } from 'node:crypto'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import type { ShopifyGraphql } from './admin-client.js'
import { WorkspaceCache } from '../../lib/workspace-cache.js'
const constraintPages = new WorkspaceCache<string, { fingerprint: string; expires: number; values: Promise<string[]> }>()
export function invalidateShopifyDefinitionConstraints() { constraintPages.clear() }

export const linkedDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pageInfo = 'pageInfo { hasNextPage endCursor }'
const fieldSelection = 'id namespace key type value compareDigest'
const definitionSelection = `id name description namespace key ownerType type { name } validations { name value } access { admin storefront } constraints { key values(first:250) { nodes { value } ${pageInfo} } }`
const metaDefinitionSelection = 'id name type description access { admin storefront } capabilities { publishable { enabled } } fieldDefinitions { key name description required type { name } validations { name value } }'
interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

/** No partial collections: a broken/repeated cursor or resource ceiling fails the read. */
export async function collectShopifyPages<T>(fetchPage: (after: string | null) => Promise<Page<T>>, limit = 20000): Promise<T[]> {
  const out: T[] = [], cursors = new Set<string>()
  let after: string | null = null
  do {
    const page = await fetchPage(after)
    if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new WorkspaceScopeError('Shopify returned an incomplete page. Retry before editing.', 502)
    out.push(...page.nodes)
    if (out.length > limit) throw new WorkspaceScopeError(`This read exceeds ${limit} resources. No partial result was used.`, 422)
    if (!page.pageInfo.hasNextPage) return out
    after = page.pageInfo.endCursor
    if (!after || cursors.has(after)) throw new WorkspaceScopeError('Shopify pagination changed while reading. Refresh before editing.', 502)
    cursors.add(after)
  } while (after)
  return out
}

function accessReason(namespace: string, access: { admin?: string | null } | null, appId?: string): string | null {
  const own = appId && (namespace === `$app` || namespace.startsWith('$app:') || namespace === `app--${appId}` || namespace.startsWith(`app--${appId}--`))
  if (/^(\$app|app--|apps--)/.test(namespace) && !own) return 'Shopify reserves writes to this app-owned namespace for its owning app. Edit it through that app.'
  if (access?.admin === 'MERCHANT_READ' && !own) return 'Shopify grants this connection read-only access to the definition.'
  return null
}
function fieldDefinition(raw: any): ShopifyFieldDefinition {
  return { ...raw, type: raw.type.name, access: raw.access ?? { admin: null, storefront: null }, readOnlyReason: accessReason(raw.namespace, raw.access) }
}
export async function readLinkedStoreSchema(gql: ShopifyGraphql): Promise<ShopifyStoreSchema> {
  const settings = await gql(`query NexusLinkedSettings { shopLocales { locale primary published } metafieldDefinitionTypes { name category }
    shop { id currencyCode } currentAppInstallation { app { id } accessScopes { handle } }
    productInput: __type(name:"ProductUpdateInput") { inputFields { name } }
    variantInput: __type(name:"ProductVariantsBulkInput") { inputFields { name } }
    inventoryInput: __type(name:"InventoryItemInput") { inputFields { name } }
    measurementInput: __type(name:"InventoryItemMeasurementInput") { inputFields { name } }
    statusEnum: __type(name:"ProductStatus") { enumValues { name description } }
    countryEnum: __type(name:"CountryCode") { enumValues { name description } }
    weightEnum: __type(name:"WeightUnit") { enumValues { name description } }
    unitPriceEnum: __type(name:"UnitPriceMeasurementMeasuredUnit") { enumValues { name description } }
    inventoryPolicyEnum: __type(name:"ProductVariantInventoryPolicy") { enumValues { name description } }
  }`)
  const definitions: ShopifyFieldDefinition[] = []
  for (const ownerType of ['PRODUCT', 'PRODUCTVARIANT']) {
    const rows = await collectShopifyPages<any>(async after => (await gql(`query NexusLinkedDefinitions($ownerType:MetafieldOwnerType!,$after:String) { metafieldDefinitions(ownerType:$ownerType,first:100,after:$after) { nodes { ${definitionSelection} } ${pageInfo} } }`, { ownerType, after })).metafieldDefinitions)
    for (const row of rows) {
      if (row.constraints) {
        const initial = row.constraints.values
        const cacheKey = settings.shop?.id ? `${settings.shop.id}:${row.id}` : null
        const fingerprint = linkedDigest(row), cached = cacheKey ? constraintPages.get(cacheKey) : null
        const values = cached && cached.fingerprint === fingerprint && cached.expires > Date.now() ? cached.values : collectShopifyPages<{ value: string }>(async after => {
          if (!after) return initial
          const data = await gql(`query NexusLinkedDefinitionConstraints($id:ID!,$after:String) { node(id:$id) { ... on MetafieldDefinition { constraints { values(first:250,after:$after) { nodes { value } ${pageInfo} } } } } }`, { id: row.id, after })
          return data.node?.constraints?.values
        }).then(values => values.map(v => v.value).sort())
        if (cacheKey) {
          if (constraintPages.size >= 1000) constraintPages.delete(constraintPages.keys().next().value!)
          constraintPages.set(cacheKey, { fingerprint, expires: cached?.values === values ? cached.expires : Date.now() + 300_000, values })
        }
        try { row.constraints = { key: row.constraints.key, values: await values } }
        catch (error) { if(cacheKey && constraintPages.get(cacheKey)?.values === values) constraintPages.delete(cacheKey); throw error }
      }
      definitions.push(fieldDefinition(row))
    }
  }
  const entries = await collectShopifyPages<any>(async after => (await gql(`query NexusLinkedEntryDefinitions($after:String) { metaobjectDefinitions(first:100,after:$after) { nodes { ${metaDefinitionSelection} } ${pageInfo} } }`, { after })).metaobjectDefinitions)
  const metaobjectDefinitions = entries.map(raw => ({ id: raw.id, name: raw.name, type: raw.type, description: raw.description, access: raw.access, publishable: raw.capabilities?.publishable?.enabled ?? false,
    fields: raw.fieldDefinitions.map((f: any) => fieldDefinition({ ...f, id: `${raw.id}/${f.key}`, namespace: raw.type, ownerType: 'METAOBJECT', access: raw.access })) }))
  const appId = settings.currentAppInstallation?.app?.id?.split('/').at(-1)
  for (const definition of definitions) definition.readOnlyReason = accessReason(definition.namespace, definition.access, appId)
  for (const entry of metaobjectDefinitions) for (const field of entry.fields) field.readOnlyReason = accessReason(field.namespace, entry.access, appId)
  // Order-independent schema identity; pagination order is not a schema change.
  definitions.sort((a, b) => a.id.localeCompare(b.id)); metaobjectDefinitions.sort((a, b) => a.id.localeCompare(b.id))
  const native = settings.productInput ? {
    enums: Object.fromEntries(['status', 'country', 'weight', 'unitPrice', 'inventoryPolicy'].map(key => [key, settings[`${key}Enum`]?.enumValues ?? []])),
    inputs: Object.fromEntries(['product', 'variant', 'inventory', 'measurement'].map(key => [key, settings[`${key}Input`]?.inputFields?.map((f: { name: string }) => f.name) ?? []])),
    scopes: settings.currentAppInstallation?.accessScopes?.map((s: { handle: string }) => s.handle) ?? [],
  } : undefined
  const publications = native?.scopes.some(s => ['read_publications', 'write_publications'].includes(s))
    ? await collectShopifyPages<any>(async after => (await gql(`query NexusInformationStorePublications($after:String) { publications(first:100,after:$after) { nodes { id name supportsFuturePublishing } ${pageInfo} } }`, { after })).publications) : undefined
  const data = { ...(publications ? { publications } : {}), definitions, metaobjectDefinitions, types: settings.metafieldDefinitionTypes, locales: settings.shopLocales, ...(native ? { native, currency: settings.shop?.currencyCode } : {}) }
  return { ...data, revision: linkedDigest(data) }
}

export async function readLinkedOwner(gql: ShopifyGraphql, id: string, includeVariants = true): Promise<ShopifyFieldOwner> {
  if (!/^gid:\/\/shopify\/(Product|ProductVariant)\/\d+$/.test(id)) throw new WorkspaceScopeError('Choose a Shopify product or variant.', 400)
  let owner: any
  const fields = await collectShopifyPages<ShopifyFieldSnapshot>(async after => {
    const data = await gql(`query NexusLinkedOwner($id:ID!,$after:String) { node(id:$id) { ... on Product { id title metafields(first:100,after:$after) { nodes { ${fieldSelection} } ${pageInfo} } } ... on ProductVariant { id title product { id } metafields(first:100,after:$after) { nodes { ${fieldSelection} } ${pageInfo} } } } }`, { id, after })
    if (!data.node?.metafields) throw new WorkspaceScopeError('This Shopify product or variant is unavailable in the selected store.', 404)
    owner = data.node
    return { ...owner.metafields, nodes: owner.metafields.nodes.map((f: any) => ({ ...f, ownerId: id })) }
  })
  const isProduct = id.includes('/Product/')
  const variants = isProduct && includeVariants ? await collectShopifyPages<{ id: string; title: string; sku: string | null }>(async after => {
    const data = await gql(`query NexusLinkedOwnerVariants($id:ID!,$after:String) { product(id:$id) { variants(first:100,after:$after) { nodes { id title sku } ${pageInfo} } } }`, { id, after })
    if (!data.product) throw new WorkspaceScopeError('This product was removed while loading.', 409)
    return data.product.variants
  }) : []
  return { id, title: owner.title, productId: isProduct ? id : owner.product.id, ownerType: isProduct ? 'PRODUCT' : 'PRODUCTVARIANT', fields, variants }
}

export async function readLinkedProducts(gql: ShopifyGraphql, ids: string[]): Promise<ShopifyLinkedMember[]> {
  if (ids.some(id => !shopifyProductGid.safeParse(id).success)) throw new WorkspaceScopeError('Select valid Shopify products.', 400)
  const products: ShopifyLinkedMember[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const data = await gql(`query NexusLinkedProducts($ids:[ID!]!) { nodes(ids:$ids) { ... on Product { id title handle featuredMedia { preview { image { url } } } } } }`, { ids: ids.slice(i, i + 100) })
    if (data.nodes.length !== ids.slice(i, i + 100).length || data.nodes.some((n: any, index: number) => n?.id !== ids[i + index])) throw new WorkspaceScopeError('A family member is unavailable in the selected store. Refresh the family.', 409)
    products.push(...data.nodes.map((p: any) => ({ id: p.id, title: p.title, handle: p.handle, image: p.featuredMedia?.preview?.image?.url ?? null })))
  }
  return products
}

export async function readLinkedFields(gql: ShopifyGraphql, addresses: { ownerId: string; namespace: string; key: string }[]): Promise<ShopifyFieldSnapshot[]> {
  const out: ShopifyFieldSnapshot[] = []
  for (let offset = 0; offset < addresses.length; offset += 25) {
    const batch = addresses.slice(offset, offset + 25), variables: Record<string, string> = {}
    const declarations = batch.flatMap((a, i) => { variables[`id${i}`] = a.ownerId; variables[`ns${i}`] = a.namespace; variables[`key${i}`] = a.key; return [`$id${i}:ID!`, `$ns${i}:String!`, `$key${i}:String!`] })
    const selections = batch.map((_, i) => `owner${i}:node(id:$id${i}) { id ... on Product { metafield(namespace:$ns${i},key:$key${i}) { ${fieldSelection} } } ... on ProductVariant { metafield(namespace:$ns${i},key:$key${i}) { ${fieldSelection} } } }`)
    const data = await gql(`query NexusLinkedFieldValues(${declarations.join(',')}) { ${selections.join(' ')} }`, variables)
    for (let i = 0; i < batch.length; i++) {
      const owner = data[`owner${i}`], address = batch[i]
      if (owner?.id !== address.ownerId || !/^gid:\/\/shopify\/(Product|ProductVariant)\/\d+$/.test(address.ownerId)) throw new WorkspaceScopeError('A field owner is unavailable in this Shopify store.', 404)
      out.push(owner.metafield ? { ...owner.metafield, ownerId: owner.id } : { ...address, type: '', value: null, compareDigest: null })
    }
  }
  return out
}

export async function searchLinkedReferences(gql: ShopifyGraphql, input: { type: string; query?: string; cursor?: string; metaobjectType?: string }): Promise<ShopifyReferencePage> {
  const type = input.type.replace(/^list\./, '')
  const query = input.query?.trim().slice(0, 200) || null, after = input.cursor || null
  let selection: string, root: string, args = 'first:40,after:$after,query:$query', variables: Record<string, unknown> = { after, query }, extra = ''
  if (type === 'product_reference') { root = 'products'; selection = 'id title handle featuredMedia { preview { image { url } } }' }
  else if (type === 'variant_reference') { root = 'productVariants'; selection = 'id title sku product { title } image { url }' }
  else if (type === 'collection_reference') { root = 'collections'; selection = 'id title image { url }' }
  else if (type === 'customer_reference') { root = 'customers'; selection = 'id displayName' }
  else if (type === 'company_reference') { root = 'companies'; selection = 'id name' }
  else if (type === 'order_reference') { root = 'orders'; selection = 'id name' }
  else if (type === 'page_reference') { root = 'pages'; selection = 'id title' }
  else if (type === 'article_reference') { root = 'articles'; selection = 'id title' }
  else if (type === 'file_reference') { root = 'files'; selection = 'id __typename alt ... on MediaImage { image { url } } ... on GenericFile { url } ... on Video { preview { image { url } } }' }
  else if (type === 'product_media') { root = 'files'; selection = '__typename id alt fileStatus preview { image { url } } ... on MediaImage { image { url } } ... on Video { sources { url mimeType } } ... on Model3d { sources { url mimeType } }'; variables.query = `media_type:IMAGE OR media_type:VIDEO OR media_type:MODEL_3D`; if (query) variables.query = `(${variables.query}) AND (${query})` }
  else if (type === 'metaobject_reference' || type === 'mixed_reference' || type === 'disclosure_reference') {
    if (!input.metaobjectType) throw new WorkspaceScopeError('Choose the reusable entry type.', 400)
    root = 'metaobjects'; selection = 'id displayName handle type'; args += ',type:$type'; extra = ',$type:String!'; variables.type = input.metaobjectType
  } else if (type === 'product_taxonomy_value_reference') {
    if (!query || !/^gid:\/\/shopify\/TaxonomyValue\/\d+$/.test(query)) return { items: [], cursor: null }
    const refs = await resolveLinkedReferences(gql, [query])
    return { items: refs.filter((r: any) => r.available), cursor: null }
  } else if (type === 'taxonomy_category') { root = ''; selection = '' }
  else throw new WorkspaceScopeError('This reference type has no browser yet. Its existing value is preserved.', 422)
  if (type === 'taxonomy_category') {
    const { searchTaxonomy } = await import('../taxonomy/repository.js')
    let cursor: { page: number; snapshotId?: string; query?: string } = { page: 1 }
    if (input.cursor) {
      try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) } catch { throw new WorkspaceScopeError('Refresh the category search before continuing.', 400) }
      if (!Number.isSafeInteger(cursor.page) || cursor.page < 1 || cursor.page > 10000 || typeof cursor.snapshotId !== 'string' || cursor.query !== (query ?? '')) throw new WorkspaceScopeError('Refresh the category search before continuing.', 400)
    }
    const result = await searchTaxonomy('SHOPIFY', 'GLOBAL', { query: query ?? '', page: cursor.page, snapshotId: cursor.snapshotId, assignableOnly: true })
    if (result.state === 'missing') throw new WorkspaceScopeError('Synchronize Shopify in Products → Categories → Taxonomy updates.', 409)
    return { items: result.items.map(node => ({ id: node.externalId, label: node.path, image: null })), cursor: result.page < result.pages ? Buffer.from(JSON.stringify({ page: result.page + 1, snapshotId: result.snapshotId, query: query ?? '' })).toString('base64url') : null }
  }
  const data = await gql(`query NexusLinkedReferenceSearch($after:String,$query:String${extra}) { ${root}(${args}) { nodes { ${selection} } ${pageInfo} } }`, variables)
  const page = data[root]
  if (!page || !Array.isArray(page.nodes) || (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)) throw new WorkspaceScopeError('The search result is incomplete. Retry.', 502)
  return { items: page.nodes.filter((n: any) => type !== 'product_media' || ['MediaImage', 'Video', 'Model3d'].includes(n.__typename)).map((n: any) => ({ id: n.id, label: n.displayName ?? (n.product ? `${n.product.title} / ${n.title}${n.sku ? ` · ${n.sku}` : ''}` : n.title ?? n.name ?? n.alt ?? n.id), image: n.image?.url ?? n.featuredMedia?.preview?.image?.url ?? n.preview?.image?.url ?? null, ...(n.type || n.__typename ? { type: n.type ?? n.__typename } : {}), ...(n.handle ? { handle: n.handle } : {}),
    ...(type === 'product_media' ? { media: { id: n.id, alt: n.alt ?? '', type: ({ MediaImage: 'IMAGE', Video: 'VIDEO', Model3d: 'MODEL_3D' } as Record<string, string>)[n.__typename], status: n.fileStatus, preview: n.preview?.image?.url ?? n.image?.url ?? null, url: n.image?.url ?? n.sources?.[0]?.url ?? null, ...(n.sources ? { sources: n.sources } : {}) } } : {}) })), cursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null }
}

export async function resolveLinkedReferences(gql: ShopifyGraphql, ids: string[]) {
  if (ids.length > 100 || ids.some(id => !shopifyGid.safeParse(id).success)) throw new WorkspaceScopeError('Select at most 100 references at a time.', 400)
  const { nodes } = await gql(`query NexusLinkedReferenceNames($ids:[ID!]!) { nodes(ids:$ids) { id __typename ... on Product { title } ... on ProductVariant { title product { title } } ... on Collection { title } ... on Page { title } ... on Article { title } ... on TaxonomyValue { name } ... on Customer { displayName } ... on Company { name } ... on Order { name } ... on Metaobject { displayName type } ... on MediaImage { alt image { url } } ... on GenericFile { alt } ... on Model3d { alt } ... on Video { alt preview { image { url } } } } }`, { ids })
  if (!Array.isArray(nodes) || nodes.length !== ids.length || nodes.some((n: any, i: number) => n && n.id !== ids[i])) throw new WorkspaceScopeError('Shopify returned incomplete or mismatched references. Retry before synchronizing.', 502)
  return nodes.map((n: any, i: number) => ({ id: ids[i], label: n?.displayName ?? (n?.product ? `${n.product.title} / ${n.title}` : n?.title ?? n?.name ?? n?.alt ?? (n ? ids[i] : 'Unavailable reference')), image: n?.image?.url ?? n?.preview?.image?.url ?? null, available: !!n, type: n?.type ?? n?.__typename }))
}

export async function readLinkedMetaobject(gql: ShopifyGraphql, id: string) {
  if (!/^gid:\/\/shopify\/Metaobject\/\d+$/.test(id)) throw new WorkspaceScopeError('Choose a reusable entry.', 400)
  const { metaobject } = await gql(`query NexusLinkedEntry($id:ID!) { metaobject(id:$id) { id type handle displayName updatedAt capabilities { publishable { status } } fields { key type value } definition { ${metaDefinitionSelection} } referencedBy(first:100) { nodes { referencer { ... on Product { id title } ... on ProductVariant { id title product { title } } ... on Metaobject { id displayName } } } ${pageInfo} } } }`, { id })
  if (!metaobject) throw new WorkspaceScopeError('This reusable entry is unavailable in the selected store.', 404)
  return metaobject
}

/** Fresh, narrow applicability check; never trusts a cached 10,000-subtype catalog when writing. */
export async function readApplicableShopifyDefinitions(gql: ShopifyGraphql, category: string): Promise<Set<string>> {
  const rows = await collectShopifyPages<{ id: string }>(async after => (await gql(`query NexusApplicableDefinitions($category:String!,$after:String) {
    metafieldDefinitions(ownerType:PRODUCT,first:100,after:$after,constraintSubtype:{key:"category",value:$category},constraintStatus:CONSTRAINED_ONLY) { nodes { id } ${pageInfo} }
  }`, { category, after })).metafieldDefinitions)
  return new Set(rows.map(row => row.id))
}
