import { WorkspaceCache } from '../../../lib/workspace-cache.js'
import { shopifyAdmin } from '../../shopify/admin-client.js'
import { readLinkedStoreSchema, invalidateShopifyDefinitionConstraints } from '../../shopify/linked-products-gateway.js'
import { shopifyProductSpec } from './store.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

const schemas = new WorkspaceCache<string, { expires: number; pending: Promise<ShopifyStoreSchema> }>()
export function invalidateShopifyMappingSchema(accountId: string) { schemas.delete(accountId); invalidateShopifyDefinitionConstraints() }

/** Workspace/store isolation and single-flight reads. Failures never become an empty schema. */
export function readShopifyMappingSchema(accountId: string, fresh = false): Promise<ShopifyStoreSchema> {
  const cached = schemas.get(accountId)
  if (!fresh && cached && cached.expires > Date.now()) return cached.pending
  const entry = { expires: Date.now() + 30_000, pending: Promise.resolve(null as unknown as ShopifyStoreSchema) }
  entry.pending = shopifyAdmin(accountId).then(({ graphql }) => readLinkedStoreSchema(graphql)).catch(error => {
    if (schemas.get(accountId) === entry) schemas.delete(accountId)
    throw error
  })
  schemas.set(accountId, entry)
  return entry.pending
}

export async function loadShopifyProductSpec(accountId?: string | null, locale?: string) {
  return shopifyProductSpec(accountId ? await readShopifyMappingSchema(accountId) : null, accountId, locale)
}
