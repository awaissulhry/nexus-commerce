import type { ColourPlanProduct } from '@nexus/shared/shopify-colour-products'
import { canonicalVariantAxis } from '../../pim/variant-attribute-keys.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import type { ShopifyGraphql } from '../admin-client.js'

export interface ColourRemoteVariant {
  id: string; sku: string; selectedOptions: Array<{ name: string; value: string }>
  inventoryItem: { id: string; tracked?: boolean }
}
export interface ColourRemoteProduct {
  id: string; status: string; onlineStorePublished: boolean; identity: { value: string } | null
  options: Array<{ id: string; name: string; values: string[] }>
  variants: { nodes: ColourRemoteVariant[]; pageInfo: { hasNextPage: boolean } }
}
export const colourIsPublished = (p: Pick<ColourRemoteProduct, 'status' | 'onlineStorePublished'>) =>
  ['ACTIVE', 'UNLISTED'].includes(p.status) && p.onlineStorePublished === true

/** A URL is null on password-protected stores even when published (dev-store proof, 2026-09-30).
 * Find the Online Store app's publication, never the calling app's own publication or a translated display name. */
export async function readOnlineStorePublication(gql: ShopifyGraphql): Promise<string> {
  const found = new Set<string>()
  let after: string | null = null
  do {
    const page = (await gql(`query NexusColourPublications($after:String) { publications(first:100,after:$after,catalogType:APP) {
      nodes { id catalog { ... on AppCatalog { apps(first:10) { nodes { handle } pageInfo { hasNextPage } } } } }
      pageInfo { hasNextPage endCursor }
    } }`, { after })).publications
    if (!page?.pageInfo || !Array.isArray(page.nodes)) throw new WorkspaceScopeError('Shopify did not return its store publications.', 502)
    for (const publication of page.nodes) {
      if (publication.catalog?.apps?.pageInfo?.hasNextPage) throw new WorkspaceScopeError('The store publication has an incomplete app list. No publication was chosen.')
      if (publication.catalog?.apps?.nodes?.some((app: { handle: string }) => app.handle === 'online_store')) found.add(publication.id)
    }
    if (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)) throw new WorkspaceScopeError('Shopify returned an incomplete publication page.', 502)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  if (found.size !== 1) throw new WorkspaceScopeError('This store has no single Online Store publication. Check its sales channels before syncing colours.')
  return [...found][0]
}

export const COLOUR_SYNC_READ = `query NexusColourSyncRead($id:ID!,$publication:ID!) { product(id:$id) {
  id status onlineStorePublished:publishedOnPublication(publicationId:$publication) identity:metafield(namespace:"nexus",key:"family_id") { value }
  options { id name values }
  variants(first:250) { nodes { id sku selectedOptions { name value } inventoryItem { id tracked } } pageInfo { hasNextPage } }
} }`
export const COLOUR_SIZE_CREATE = `mutation NexusColourSizes($id:ID!,$variants:[ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId:$id,variants:$variants,strategy:PRESERVE_STANDALONE_VARIANT) {
    productVariants { id } userErrors { field message }
  }
}`
export const COLOUR_SIZE_ORDER = `mutation NexusColourSizeOrder($id:ID!,$options:[OptionReorderInput!]!) {
  productOptionsReorder(productId:$id,options:$options) { product { id } userErrors { field message } }
}`
export const readColourRemote = async (gql: ShopifyGraphql, id: string, publication: string): Promise<ColourRemoteProduct | null> => {
  const result = await gql<{ product: ColourRemoteProduct | null }>(COLOUR_SYNC_READ, { id, publication })
  // Only an explicit null proves absence. Malformed or incomplete responses must never erase mappings.
  if (!Object.prototype.hasOwnProperty.call(result, 'product') || result.product === undefined) throw new WorkspaceScopeError('Shopify returned an incomplete colour product read.', 502)
  if (result.product && (!result.product.variants?.pageInfo || !Array.isArray(result.product.variants.nodes) || !Array.isArray(result.product.options)))
    throw new WorkspaceScopeError('Shopify returned an incomplete size list.', 502)
  return result.product
}

/** Existing IDs are authoritative. Recovery of an unsaved create needs an exact SKU AND option tuple. */
export function planColourVariants(product: ColourPlanProduct, remote: ColourRemoteProduct, mappings: ReadonlyMap<string, { variantId?: string; inventoryItemId?: string }>) {
  if (remote.variants.pageInfo.hasNextPage) throw new WorkspaceScopeError('This colour has more than 250 Shopify variants. Review it before syncing sizes.', 422)
  const defaultOnly = product.options.length === 0 && product.variants.length === 1 && remote.variants.nodes.length === 1
    && remote.options.length === 1 && remote.options[0].name === 'Title' && JSON.stringify(remote.options[0].values) === '["Default Title"]'
  if (!product.options.length && !defaultOnly) throw new WorkspaceScopeError('This colour needs its one confirmed Default Title variant. Review the mapping.')
  const native = product.options.map(o => {
    const found = remote.options.filter(r => [o.name, o.axis].some(name => canonicalVariantAxis(name) === canonicalVariantAxis(r.name)))
    if (found.length !== 1) throw new WorkspaceScopeError(`The Shopify option for ${o.name} changed. Review the variation theme before syncing sizes.`)
    return found[0]
  })
  if (new Set(native.map(o => o.id)).size !== native.length || !defaultOnly && native.length !== remote.options.length)
    throw new WorkspaceScopeError('The Shopify option axes differ from the confirmed family. Review the variation theme.')
  const matched: Array<{ productId: string; remote: ColourRemoteVariant }> = []
  const missing: Array<{ productId: string; sku: string; optionValues: Array<{ optionId: string; name: string }> }> = []
  for (const variant of product.variants) {
    const desired = variant.options.map((o, i) => ({ optionId: native[i].id, name: o.value }))
    const sameOptions = (v: ColourRemoteVariant) => variant.options.every((o, i) => v.selectedOptions.find(s => s.name === native[i].name)?.value === o.value)
    const saved = mappings.get(variant.productId)
    const bySku = remote.variants.nodes.filter(v => v.sku === variant.sku)
    if (bySku.length > 1) throw new WorkspaceScopeError(`${variant.sku} appears more than once in this Shopify colour.`)
    const found = saved?.variantId ? remote.variants.nodes.find(v => v.id === `gid://shopify/ProductVariant/${saved.variantId.replace(/^.*\//, '')}`) : bySku[0]
    if (saved?.variantId && !found) throw new WorkspaceScopeError(`${variant.sku}: the stored variant was removed in Shopify. Review the mapping; no replacement was created.`)
    if (found) {
      if (found.sku !== variant.sku || !sameOptions(found) || !found.inventoryItem?.id
        || saved?.inventoryItemId && found.inventoryItem.id.split('/').pop() !== String(saved.inventoryItemId).split('/').pop())
        throw new WorkspaceScopeError(`${variant.sku}: Shopify changed the size identity or options. Review the mapping.`)
      matched.push({ productId: variant.productId, remote: found })
    } else {
      if (remote.variants.nodes.some(sameOptions)) throw new WorkspaceScopeError(`${variant.sku}: this Shopify size belongs to another SKU. Confirm its mapping first.`)
      missing.push({ productId: variant.productId, sku: variant.sku, optionValues: desired })
    }
  }
  const order = product.options.map((o, i) => ({ id: native[i].id,
    values: [...o.values, ...native[i].values.filter(value => !o.values.includes(value))].map(name => ({ name })) }))
  const reordered = !defaultOnly && (remote.options.length !== order.length || order.some((o, i) => o.id !== remote.options[i].id || JSON.stringify(o.values.map(v => v.name)) !== JSON.stringify(remote.options[i].values)))
  return { matched, missing, order, reordered }
}
