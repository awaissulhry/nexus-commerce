import { emptyShopifyLinkedDraft, shopifyProductGid, type ShopifyLinkedDiscovery, type ShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import type { ShopifyGraphql } from './admin-client.js'
import { readLinkedFields, readLinkedProducts, readLinkedStoreSchema } from './linked-products-gateway.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

function productList(value: string | null): string[] {
  if (value === null) return []
  let ids: unknown
  try { ids = JSON.parse(value) } catch { throw new WorkspaceScopeError('An existing product list is malformed. Review it in Shopify.', 422) }
  if (!Array.isArray(ids) || ids.some(id => !shopifyProductGid.safeParse(id).success) || new Set(ids).size !== ids.length)
    throw new WorkspaceScopeError('An existing product list contains invalid or duplicate references.', 422)
  return ids as string[]
}

/** Discover only from explicit listing identities and reciprocal store references, never titles. */
export async function discoverLinkedFamily(gql: ShopifyGraphql, seeds: string[], relationship: ShopifyLinkedDraft['relationship']): Promise<ShopifyLinkedDiscovery> {
  if (!seeds.length) return { draft: null, candidates: [], reasons: ['Link one Shopify product to this Nexus family or choose a source product to discover its existing links.'] }
  const schema = await readLinkedStoreSchema(gql)
  const definitions = schema.definitions.filter(d => d.ownerType === 'PRODUCT' && d.type === 'list.product_reference' && !d.readOnlyReason
    && (!relationship || (relationship.namespace === d.namespace && relationship.key === d.key)))
  const candidates: ShopifyLinkedDiscovery['candidates'] = [], drafts = new Map<string, ShopifyLinkedDraft>()
  for (const def of definitions) {
    const initial = await readLinkedFields(gql, seeds.map(ownerId => ({ ownerId, namespace: def.namespace, key: def.key })))
    const source = initial.find(f => productList(f.value).some(id => id !== f.ownerId))
    if (!source) continue
    const sourceIds = productList(source.value), ids = [...new Set([...sourceIds, source.ownerId])]
    if (ids.length > 2048 || seeds.some(id => !ids.includes(id))) continue
    const fields = await readLinkedFields(gql, ids.map(ownerId => ({ ownerId, namespace: def.namespace, key: def.key })))
    // A recommendation that merely points at another product is not a family.
    if (fields.some(f => { const refs = productList(f.value); return refs.some(id => !ids.includes(id)) || ids.some(id => id !== f.ownerId && !refs.includes(id)) })) continue
    const draft = emptyShopifyLinkedDraft()
    draft.members = await readLinkedProducts(gql, ids)
    draft.relationship = { namespace: def.namespace, key: def.key, includeSelf: sourceIds.includes(source.ownerId) }
    draft.baselineLinks = fields.map(f => ({ ...f, type: f.type || 'list.product_reference' }))
    candidates.push({ namespace: def.namespace, key: def.key, name: def.name, linkedProducts: ids.length })
    drafts.set(def.id, draft)
  }
  if (candidates.length !== 1) return { draft: null, candidates, reasons: [candidates.length
    ? 'More than one reciprocal product list exists. Choose the field used by your storefront, then discover again.'
    : 'No complete reciprocal family was found. Choose the storefront relationship field and import a source product to review incomplete links.'] }
  return { draft: [...drafts.values()][0], candidates, reasons: ['Discovered from linked Nexus listings and reciprocal Shopify references. Review the products and order before saving.'] }
}
