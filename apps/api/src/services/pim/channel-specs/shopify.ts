import { cachedSchemasOnly } from '../cached-schema-context.js'
import { WorkspaceCache } from '../../../lib/workspace-cache.js'
import { shopifyAdmin } from '../../shopify/admin-client.js'
import { readLinkedStoreSchema, invalidateShopifyDefinitionConstraints } from '../../shopify/linked-products-gateway.js'
import { shopifyProductSpec } from './store.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

const schemas = new WorkspaceCache<string, { expires: number; pending: Promise<ShopifyStoreSchema>; value?: ShopifyStoreSchema }>()
export function invalidateShopifyMappingSchema(accountId: string) { schemas.delete(accountId); invalidateShopifyDefinitionConstraints() }

/** Workspace/store isolation and single-flight reads. Failures never become an empty schema. */
export function readShopifyMappingSchema(accountId: string, fresh = false): Promise<ShopifyStoreSchema> {
  const cached = schemas.get(accountId)
  if (cachedSchemasOnly()) {
    if (cached?.value) return Promise.resolve(cached.value)
    throw new Error('Shopify requirements are not cached for this account.')
  }
  if (!fresh && cached && cached.expires > Date.now()) return cached.pending
  const entry: { expires: number; pending: Promise<ShopifyStoreSchema>; value?: ShopifyStoreSchema } = { expires: Date.now() + 30_000, pending: Promise.resolve(null as unknown as ShopifyStoreSchema) }
  entry.pending = shopifyAdmin(accountId).then(({ graphql }) => readLinkedStoreSchema(graphql)).then(value => { entry.value = value; return value }).catch(error => {
    if (schemas.get(accountId) === entry) schemas.delete(accountId)
    throw error
  })
  schemas.set(accountId, entry)
  return entry.pending
}

export async function loadShopifyProductSpec(accountId?: string | null, locale?: string) {
  return shopifyProductSpec(accountId ? await readShopifyMappingSchema(accountId) : null, accountId, locale)
}
