import { getAmazonSellerId, getAmazonSpClient } from '../../lib/amazon-sp-client.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import type { ChannelSpec } from '../pim/channel-specs/types.js'
import { amazonLocale, amazonMarketplaceId } from './marketplace-ids.js'
import { downloadAmazonSchema, schemaFingerprint } from './schema-document.js'

const cache = new TtlCache<Promise<ChannelSpec>>({ ttlMs: 15 * 60_000, maxEntries: 200 })
/** Seller requirements never overwrite the shared taxonomy cache or use another account's credentials. */
export async function amazonSellerSpec(accountId: string, marketplace: string, productType: string, refresh = false): Promise<ChannelSpec> {
  const key = JSON.stringify([workspaceIdForQuery(), accountId, marketplace, productType])
  const prior = cache.get(key)
  if (prior && !refresh) return prior
  const pending = (async () => {
    const sellerId = await getAmazonSellerId(accountId)
    if (!sellerId) throw new Error('The selected Amazon account has no verified seller identity.')
    const sp = await getAmazonSpClient(accountId)
    const envelope = await sp.callAPI({ operation: 'getDefinitionsProductType', endpoint: 'productTypeDefinitions', version: '2020-09-01',
      path: { productType }, query: { marketplaceIds: [amazonMarketplaceId(marketplace)], sellerId, requirements: 'LISTING', requirementsEnforced: 'ENFORCED', locale: await amazonLocale(marketplace) } })
    if (!envelope?.schema?.link?.resource) throw new Error('Amazon returned no requirements for this seller and product type.')
    const definition = await downloadAmazonSchema(envelope.schema)
    if (envelope.propertyGroups) definition.__propertyGroups = envelope.propertyGroups
    definition.__requirementsEnforced = envelope.requirementsEnforced
    return amazonSpecFromDefinition({ marketplace, productType, schemaDefinition: definition, fetchedAt: new Date(), schemaVersion: schemaFingerprint(definition) })
  })().catch(error => { cache.delete(key); throw error })
  cache.set(key, pending)
  return pending
}
