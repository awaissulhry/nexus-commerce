import type { ShopifyFieldDefinition, ShopifyFieldOwner, ShopifyFieldSnapshot, ShopifyLinkedMember, ShopifyReference, ShopifyReferencePage, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyCategoryCode, shopifyGid, shopifyProductGid } from '@nexus/shared/shopify-linked-products'
import { createHash } from 'node:crypto'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import type { ShopifyGraphql } from './admin-client.js'
import { WorkspaceCache } from '../../lib/workspace-cache.js'
/** Per store and category: the category-limited definitions that apply there. A day old at most; cleared whenever a
 *  definition changes (the definition webhooks, a switch-on). Writes never use it: they ask Shopify again. */
const applicableByCategory = new WorkspaceCache<string, { expires: number; ids: Promise<Set<string>> }>()
const APPLICABLE_CACHE_MS = 24 * 60 * 60 * 1000
export function invalidateShopifyDefinitionConstraints() { applicableByCategory.clear() }
/** The most categories one schema read asks about; the rest are left to Shopify's check before a write. */
export const SHOPIFY_SCHEMA_CATEGORY_LIMIT = 100

export const linkedDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pageInfo = 'pageInfo { hasNextPage endCursor }'
/**
 * An entry's own picture: the field its definition marks as the thumbnail (a file or a colour). Shopify's admin draws
 * exactly this beside each entry — the swatch in the category Color list, the icon in a "Text with icon" list
 * (measured in the bulk editor 2026-09-27, docs/sheet-popup-editor/PLAN-2026-09-27.md §2). Read generically: no field
 * key is assumed.
 */
const entryThumbnail = 'thumbnailField { thumbnail { hex file { preview { image { url } } } } }'
const entryPicture = (n: any): { image: string | null; swatch: string | null } => ({
  image: n?.thumbnailField?.thumbnail?.file?.preview?.image?.url ?? null,
  swatch: n?.thumbnailField?.thumbnail?.hex ?? null,
})
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
/** A category's applicable definitions, cached per store (`shopId`) — for display only; see `applicableByCategory`. */
function cachedApplicableDefinitions(gql: ShopifyGraphql, shopId: string | undefined, category: string): Promise<Set<string>> {
  if (!shopId) return readApplicableShopifyDefinitions(gql, category)
  const key = `${shopId}:${category}`, cached = applicableByCategory.get(key)
  if (cached && cached.expires > Date.now()) return cached.ids
  const ids = readApplicableShopifyDefinitions(gql, category)
  if (applicableByCategory.size >= 5000) applicableByCategory.delete(applicableByCategory.keys().next().value!)
  applicableByCategory.set(key, { expires: Date.now() + APPLICABLE_CACHE_MS, ids })
  ids.catch(() => { if (applicableByCategory.get(key)?.ids === ids) applicableByCategory.delete(key) })
  return ids
}

/**
 * The store's field list. `categories`: the Shopify categories the caller needs exact category-field answers for (the
 * store's categories in use). A category-limited definition keeps only the first page of its category list: Color alone
 * lists ~11,000, and paging them all made every fresh read slow. Instead, one read per requested category (cached a day)
 * says which of those definitions apply there.
 */
export async function readLinkedStoreSchema(gql: ShopifyGraphql, options: { categories?: readonly string[] } = {}): Promise<ShopifyStoreSchema> {
  // Independent reads run together. In sequence a cold read measured 34 s on production (2026-09-24),
  // past the web proxy's ~30 s limit. The handler below only marks the promise handled; it is awaited later.
  const entriesRead = collectShopifyPages<any>(async after => (await gql(`query NexusLinkedEntryDefinitions($after:String) { metaobjectDefinitions(first:100,after:$after) { nodes { ${metaDefinitionSelection} } ${pageInfo} } }`, { after })).metaobjectDefinitions)
  entriesRead.catch(() => undefined)
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
  // Product and variant definitions are read side by side; `definitions` is sorted below, so arrival order is not identity.
  await Promise.all(['PRODUCT', 'PRODUCTVARIANT'].map(async ownerType => {
    const rows = await collectShopifyPages<any>(async after => (await gql(`query NexusLinkedDefinitions($ownerType:MetafieldOwnerType!,$after:String) { metafieldDefinitions(ownerType:$ownerType,first:100,after:$after) { nodes { ${definitionSelection} } ${pageInfo} } }`, { ownerType, after })).metafieldDefinitions)
    for (const row of rows) {
      if (row.constraints) {
        const page = row.constraints.values as Page<{ value: string }> | null
        row.constraints = { key: row.constraints.key, values: (page?.nodes ?? []).map(v => v.value).sort(), ...(page?.pageInfo?.hasNextPage ? { complete: false } : {}) }
      }
      definitions.push(fieldDefinition(row))
    }
  }))
  // Exact answers for the requested categories, only where a list is partial. Product definitions only: Shopify limits
  // product fields by category.
  const partial = definitions.filter(d => d.ownerType === 'PRODUCT' && d.constraints?.key === 'category' && d.constraints.complete === false)
  const categories = [...new Set((options.categories ?? []).map(shopifyCategoryCode).filter(Boolean))].sort().slice(0, SHOPIFY_SCHEMA_CATEGORY_LIMIT)
  if (partial.length && categories.length) {
    const answers: Set<string>[] = []
    for (let i = 0; i < categories.length; i += 8) answers.push(...await Promise.all(categories.slice(i, i + 8).map(code => cachedApplicableDefinitions(gql, settings.shop?.id, `gid://shopify/TaxonomyCategory/${code}`))))
    for (const definition of partial) {
      const applies = categories.filter((_, i) => answers[i].has(definition.id))
      definition.constraints = { ...definition.constraints!, values: [...new Set([...definition.constraints!.values, ...applies])].sort(), checked: categories }
    }
  }
  const entries = await entriesRead
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

/** A file's name for pickers and cells (gap G11): its alt text, else the video's file name or the last part of its address.
 *  Never an empty name and never a raw id. */
const FILE_TYPENAMES = ['MediaImage', 'GenericFile', 'Video', 'Model3d']
export function linkedFileLabel(n: any): string {
  if (typeof n?.alt === 'string' && n.alt.trim()) return n.alt
  if (typeof n?.filename === 'string' && n.filename) return n.filename
  const url = n?.image?.url ?? n?.url ?? null
  if (typeof url === 'string') { try { const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); if (last) return last } catch { /* fall through */ } }
  return 'Untitled file'
}
/** `Image,Video` (a field's `file_type_options`) → Shopify's file search filter. Unknown kinds are ignored, never guessed. */
export function linkedFileKindsQuery(fileTypes: string | undefined): string | null {
  const kinds = (fileTypes ?? '').split(',').map(kind => ({ Image: 'media_type:IMAGE', Video: 'media_type:VIDEO' } as Record<string, string>)[kind.trim()]).filter(Boolean)
  return kinds.length ? kinds.join(' OR ') : null
}
/**
 * Shopify's values for one taxonomy attribute ("color", "pattern", …) — the values a category Color entry's "Base color"
 * and "Base pattern" take (gap G12; docs/shopify-metafields/PLAN-2026-09-28.md §6.2). Shopify lists an attribute's values
 * only through a category: the attribute is found by its handle among a category's attributes, then its values are read
 * page by page. Taxonomy is Shopify's public data, the same for every store, so both reads are cached for a day.
 * `attribute: null` means no given category carries the attribute — the caller says so; it never guesses.
 */
export const taxonomyHandle = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const TAXONOMY_TTL_MS = 24 * 60 * 60 * 1000
const taxonomyCache = new WorkspaceCache<string, { expires: number; value: Promise<unknown> }>(500)
function cachedTaxonomy<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = taxonomyCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>
  const value = read()
  taxonomyCache.set(key, { expires: Date.now() + TAXONOMY_TTL_MS, value })
  value.catch(() => { if (taxonomyCache.get(key)?.value === value) taxonomyCache.delete(key) })
  return value
}
export function invalidateTaxonomyCache() { taxonomyCache.clear() }
/** A category as Shopify's node id. A definition's category constraint holds the bare code (`aa-1-13`, measured on a live
 *  store 2026-09-28); a product's category holds the full id. Anything else is not a category: null, never guessed. */
export function taxonomyCategoryId(category: string): string | null {
  if (/^gid:\/\/shopify\/TaxonomyCategory\/[a-z]{2}(-\d+)*$/.test(category)) return category
  return /^[a-z]{2}(-\d+)*$/.test(category) ? `gid://shopify/TaxonomyCategory/${category}` : null
}
export async function readTaxonomyAttributeValues(gql: ShopifyGraphql, handle: string, categoryIds: string[]): Promise<{ attribute: { id: string; name: string } | null; values: ShopifyReference[] }> {
  let attribute: { id: string; name: string } | null = null
  for (const category of [...new Set(categoryIds.map(taxonomyCategoryId).filter((id): id is string => !!id))].slice(0, 5)) {
    const attributes = await cachedTaxonomy(`category|${category}`, async () => {
      const data = await gql(`query NexusTaxonomyCategoryAttributes($id:ID!) { node(id:$id) { ... on TaxonomyCategory { attributes(first:250) { nodes { __typename ... on TaxonomyChoiceListAttribute { id name } } } } } }`, { id: category })
      return ((data?.node?.attributes?.nodes ?? []) as any[]).filter(n => n?.id && n?.name).map(n => ({ id: String(n.id), name: String(n.name) }))
    })
    attribute = attributes.find(a => taxonomyHandle(a.name) === handle) ?? null
    if (attribute) break
  }
  if (!attribute) return { attribute: null, values: [] }
  const found = attribute
  const values = await cachedTaxonomy(`values|${found.id}`, async () => (await collectShopifyPages<{ id: string; name: string }>(async after => {
    const data = await gql(`query NexusTaxonomyAttributeValues($id:ID!,$after:String) { node(id:$id) { ... on TaxonomyChoiceListAttribute { values(first:250,after:$after) { nodes { id name } ${pageInfo} } } } }`, { id: found.id, after })
    return data?.node?.values
  }, 5000)).map(v => ({ id: v.id, label: v.name, image: null, type: 'TaxonomyValue', available: true } as ShopifyReference)))
  return { attribute: found, values }
}

export async function searchLinkedReferences(gql: ShopifyGraphql, input: { type: string; query?: string; cursor?: string; metaobjectType?: string; fileTypes?: string; attribute?: string; categories?: string }): Promise<ShopifyReferencePage> {
  const type = input.type.replace(/^list\./, '')
  const query = input.query?.trim().slice(0, 200) || null, after = input.cursor || null
  let selection: string, root: string, args = 'first:40,after:$after,query:$query', variables: Record<string, unknown> = { after, query }, extra = ''
  if (type === 'product_reference') { root = 'products'; selection = 'id title handle featuredMedia { preview { image { url } } }' }
  else if (type === 'variant_reference') { root = 'productVariants'; selection = 'id title sku product { title featuredMedia { preview { image { url } } } } media(first:1) { nodes { preview { image { url } } } }' }
  else if (type === 'collection_reference') { root = 'collections'; selection = 'id title image { url }' }
  else if (type === 'customer_reference') { root = 'customers'; selection = 'id displayName' }
  else if (type === 'company_reference') { root = 'companies'; selection = 'id name' }
  else if (type === 'order_reference') { root = 'orders'; selection = 'id name' }
  else if (type === 'page_reference') { root = 'pages'; selection = 'id title' }
  else if (type === 'article_reference') { root = 'articles'; selection = 'id title' }
  else if (type === 'file_reference') {
    root = 'files'; selection = 'id __typename alt ... on MediaImage { image { url } } ... on GenericFile { url } ... on Video { filename preview { image { url } } }'
    /* Only the kinds the field allows (gap G8), combined with the typed search like the product-media search below. */
    const kinds = linkedFileKindsQuery(input.fileTypes)
    if (kinds) variables.query = query ? `(${kinds}) AND (${query})` : kinds
  }
  else if (type === 'product_media') { root = 'files'; selection = '__typename id alt fileStatus preview { image { url } } ... on MediaImage { image { url } } ... on Video { sources { url mimeType } } ... on Model3d { sources { url mimeType } }'; variables.query = `media_type:IMAGE OR media_type:VIDEO OR media_type:MODEL_3D`; if (query) variables.query = `(${variables.query}) AND (${query})` }
  else if (type === 'metaobject_reference' || type === 'mixed_reference' || type === 'disclosure_reference') {
    if (!input.metaobjectType) throw new WorkspaceScopeError('Choose the reusable entry type.', 400)
    root = 'metaobjects'; selection = `id displayName handle type ${entryThumbnail}`; args += ',type:$type'; extra = ',$type:String!'; variables.type = input.metaobjectType
  } else if (type === 'product_taxonomy_value_reference' && input.attribute) {
    /* The attribute's own list, searched by name (gap G12): no raw id is typed any more. */
    const { attribute, values } = await readTaxonomyAttributeValues(gql, input.attribute, (input.categories ?? '').split(',').map(c => c.trim()).filter(Boolean))
    if (!attribute) throw new WorkspaceScopeError(`Shopify lists the “${input.attribute}” values only through a product category, and this field has none that carries it. The stored value is kept.`, 422)
    const needle = query?.toLowerCase() ?? '', start = Number(after ?? 0) || 0
    const matches = values.filter(v => !needle || v.label.toLowerCase().includes(needle))
    return { items: matches.slice(start, start + 40), cursor: start + 40 < matches.length ? String(start + 40) : null }
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
  return { items: page.nodes.filter((n: any) => type !== 'product_media' || ['MediaImage', 'Video', 'Model3d'].includes(n.__typename)).map((n: any) => ({ id: n.id, label: n.displayName ?? (n.product ? `${n.product.title} / ${n.title}${n.sku ? ` · ${n.sku}` : ''}` : n.title ?? n.name ?? (FILE_TYPENAMES.includes(n.__typename) ? linkedFileLabel(n) : n.alt ?? n.id)), image: referenceImage(n), ...(n.thumbnailField?.thumbnail?.hex ? { swatch: n.thumbnailField.thumbnail.hex } : {}), ...(n.type || n.__typename ? { type: n.type ?? n.__typename } : {}), ...(n.handle ? { handle: n.handle } : {}),
    ...(type === 'product_media' ? { media: { id: n.id, alt: n.alt ?? '', type: ({ MediaImage: 'IMAGE', Video: 'VIDEO', Model3d: 'MODEL_3D' } as Record<string, string>)[n.__typename], status: n.fileStatus, preview: n.preview?.image?.url ?? n.image?.url ?? null, url: n.image?.url ?? n.sources?.[0]?.url ?? null, ...(n.sources ? { sources: n.sources } : {}) } } : {}) })), cursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null }
}

/** The picture a reference carries, whatever its kind: an entry's thumbnail file, a variant's first media (else its
 *  product's), a collection or file image, a product's featured media. */
function referenceImage(n: any): string | null {
  return entryPicture(n).image ?? n?.media?.nodes?.[0]?.preview?.image?.url ?? n?.image?.url ?? n?.preview?.image?.url ?? n?.featuredMedia?.preview?.image?.url
    ?? n?.product?.featuredMedia?.preview?.image?.url ?? null
}

export async function resolveLinkedReferences(gql: ShopifyGraphql, ids: string[]): Promise<ShopifyReference[]> {
  if (ids.length > 100 || ids.some(id => !shopifyGid.safeParse(id).success)) throw new WorkspaceScopeError('Select at most 100 references at a time.', 400)
  const { nodes } = await gql(`query NexusLinkedReferenceNames($ids:[ID!]!) { nodes(ids:$ids) { id __typename ... on Product { title featuredMedia { preview { image { url } } } } ... on ProductVariant { title product { title featuredMedia { preview { image { url } } } } media(first:1) { nodes { preview { image { url } } } } } ... on Collection { title image { url } } ... on Page { title } ... on Article { title } ... on TaxonomyValue { name } ... on Customer { displayName } ... on Company { name } ... on Order { name } ... on Metaobject { displayName type ${entryThumbnail} } ... on MediaImage { alt image { url } } ... on GenericFile { alt url } ... on Model3d { alt } ... on Video { alt filename preview { image { url } } } } }`, { ids })
  if (!Array.isArray(nodes) || nodes.length !== ids.length || nodes.some((n: any, i: number) => n && n.id !== ids[i])) throw new WorkspaceScopeError('Shopify returned incomplete or mismatched references. Retry before synchronizing.', 502)
  return nodes.map((n: any, i: number) => ({ id: ids[i], label: n?.displayName ?? (n?.product ? `${n.product.title} / ${n.title}` : n?.title ?? n?.name ?? (FILE_TYPENAMES.includes(n?.__typename) ? linkedFileLabel(n) : n?.alt ?? (n ? ids[i] : 'Unavailable reference'))), image: referenceImage(n), ...(entryPicture(n).swatch ? { swatch: entryPicture(n).swatch } : {}), available: !!n, type: n?.type ?? n?.__typename }))
}

/**
 * Names and pictures for DISPLAY — the sheet's cells and the pop-ups — cached per store for 10 minutes.
 *
 * Every sheet load used to ask Shopify for every referenced name and picture again, and every pop-up opening asked
 * once more (research 2026-09-27). Only display reads use this: validation (`shopifyReferenceError`) and
 * synchronization call `resolveLinkedReferences` directly and always read fresh. An unavailable reference is never
 * cached (it may be restored); saving an entry clears the cache (`invalidateLinkedReferenceNames`).
 */
export const REFERENCE_NAME_TTL_MS = 10 * 60 * 1000
const referenceNames = new WorkspaceCache<string, { expires: number; value: ShopifyReference }>(20000)
export function invalidateLinkedReferenceNames() { referenceNames.clear() }
export async function resolveLinkedReferenceNames(gql: ShopifyGraphql, accountId: string, ids: string[], now = Date.now()): Promise<ShopifyReference[]> {
  if (ids.length > 100) throw new WorkspaceScopeError('Select at most 100 references at a time.', 400)
  const key = (id: string) => `${accountId}|${id}`
  const known = new Map<string, ShopifyReference>()
  for (const id of ids) { const hit = referenceNames.get(key(id)); if (hit && hit.expires > now) known.set(id, hit.value) }
  const missing = [...new Set(ids.filter(id => !known.has(id)))]
  if (missing.length) {
    for (const ref of await resolveLinkedReferences(gql, missing)) {
      known.set(ref.id, ref)
      if (ref.available) referenceNames.set(key(ref.id), { expires: now + REFERENCE_NAME_TTL_MS, value: ref })
    }
  }
  return ids.map(id => known.get(id)!)
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
