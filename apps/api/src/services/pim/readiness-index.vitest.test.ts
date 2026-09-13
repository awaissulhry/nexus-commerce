import { expect, it, vi } from 'vitest'
import { readinessCoordinateKey, readinessLanguages } from './readiness-model.js'
import { withCachedSchemas } from './cached-schema-context.js'
vi.mock('../shopify/admin-client.js', () => ({ shopifyAdmin: vi.fn() }))
vi.mock('../shopify/linked-products-gateway.js', () => ({ readLinkedStoreSchema: vi.fn(), invalidateShopifyDefinitionConstraints: vi.fn() }))
import { shopifyAdmin } from '../shopify/admin-client.js'
import { readShopifyMappingSchema } from './channel-specs/shopify.js'
it('keeps shared, primary, aliases and accounts distinct even with delimiter characters', () => {
 const c = { channel: null, market: null, accountId: null, aliasId: null }
 const keys = [c, { ...c, channel: 'AMAZON', market: 'BE' }, { ...c, accountId: 'a|b', aliasId: 'c' }, { ...c, accountId: 'a', aliasId: 'b|c' }].map(readinessCoordinateKey)
 expect(new Set(keys).size).toBe(4)
})
it('a cache-only producer never enters the Shopify credential or transport gateway on a miss', async () => {
 await expect(withCachedSchemas(async () => readShopifyMappingSchema('uncached-account'))).rejects.toThrow('not cached')
 expect(shopifyAdmin).not.toHaveBeenCalled()
})

it('preserves the source first and Belgium’s ordered languages in the matrix', () => {
 expect(readinessLanguages([{ channel: 'AMAZON', code: 'BE', languages: ['nl','fr'] }, { channel: 'AMAZON', code: 'DE', languages: ['de'] }])).toEqual(['it','nl','fr','de'])
})
