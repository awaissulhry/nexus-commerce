import { getAmazonSellerId, getAmazonSpClient } from '../../lib/amazon-sp-client.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import type { ChannelSpec } from '../pim/channel-specs/types.js'
import { amazonLocale, amazonMarketplaceId } from './marketplace-ids.js'
import { downloadAmazonSchema, schemaFingerprint } from './schema-document.js'

/** One seller-scoped definition download: with `sellerId`, Amazon adds what only this account may use (e.g. the B2B audience). */
async function fetchSellerDefinition(accountId: string, marketplace: string, productType: string): Promise<Record<string, any>> {
  const sellerId = await getAmazonSellerId(accountId)
  if (!sellerId) throw new Error('The selected Amazon account has no verified seller identity.')
  const sp = await getAmazonSpClient(accountId)
  const envelope = await sp.callAPI({ operation: 'getDefinitionsProductType', endpoint: 'productTypeDefinitions', version: '2020-09-01',
    path: { productType }, query: { marketplaceIds: [amazonMarketplaceId(marketplace)], sellerId, requirements: 'LISTING', requirementsEnforced: 'ENFORCED', locale: await amazonLocale(marketplace) } })
  if (!envelope?.schema?.link?.resource) throw new Error('Amazon returned no requirements for this seller and product type.')
  const definition = await downloadAmazonSchema(envelope.schema)
  if (envelope.propertyGroups) definition.__propertyGroups = envelope.propertyGroups
  definition.__requirementsEnforced = envelope.requirementsEnforced
  return definition
}

const cache = new TtlCache<Promise<ChannelSpec>>({ ttlMs: 15 * 60_000, maxEntries: 200 })
/** Seller requirements never overwrite the shared taxonomy cache or use another account's credentials. */
export async function amazonSellerSpec(accountId: string, marketplace: string, productType: string, refresh = false): Promise<ChannelSpec> {
  const key = JSON.stringify([workspaceIdForQuery(), accountId, marketplace, productType])
  const prior = cache.get(key)
  if (prior && !refresh) return prior
  const pending = fetchSellerDefinition(accountId, marketplace, productType)
    .then(definition => amazonSpecFromDefinition({ marketplace, productType, schemaDefinition: definition, fetchedAt: new Date(), schemaVersion: schemaFingerprint(definition) }))
    .catch(error => { cache.delete(key); throw error })
  cache.set(key, pending)
  return pending
}

/** `purchasable_offer`'s audience options in a definition, code → Amazon's name (`{ B2B: 'Amazon Business (B2B)', ALL: … }`); `{}` when it has none. */
export function offerAudienceLabels(definition: Record<string, any> | null | undefined): Record<string, string> {
  const node = definition?.properties?.purchasable_offer?.items?.properties?.audience
  const codes: unknown[] = Array.isArray(node?.enum) ? node.enum : []
  const names: unknown[] = Array.isArray(node?.enumNames) ? node.enumNames : []
  return Object.fromEntries(codes.filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map((code, i) => [code, typeof names[i] === 'string' && names[i] ? names[i] as string : code]))
}

/**
 * The offer audiences Amazon allows THIS account for one market and product type — `B2B` only once the account is an
 * Amazon Business seller there. The shared `CategorySchema` cache is fetched without `sellerId` and never lists `B2B`.
 * One live call, no in-process cache: the nightly schema refresh is its caller and keeps the answer durably.
 */
export async function amazonSellerOfferAudience(accountId: string, marketplace: string, productType: string): Promise<Record<string, string>> {
  return offerAudienceLabels(await fetchSellerDefinition(accountId, marketplace, productType))
}
