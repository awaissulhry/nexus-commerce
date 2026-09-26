import type { ContractCheck } from './channel-contracts.js'

const TOPIC = 'NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID'
const DESTINATION = 'NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID'
const SUBSCRIPTION = 'NEXUS_CONTRACT_EBAY_SANDBOX_SUBSCRIPTION_ID'
const AMAZON_SKU = 'NEXUS_CONTRACT_AMAZON_SANDBOX_SKU'
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const payload = (value: unknown) => record(value) && text(value.format) && text(value.deliveryProtocol) && text(value.schemaVersion)

/** Documented collection reads, one bounded page each. No subscription provisioning or test delivery. */
export const EBAY_NOTIFICATION_READ_CHECKS: ContractCheck[] = [
  { resource: 'topic', collection: 'topics', name: 'getTopics', id: 'topicId', needs: [TOPIC], fixture: TOPIC,
    valid: (row: Record<string, any>) => Array.isArray(row.supportedPayloads) && row.supportedPayloads.length > 0
      && row.supportedPayloads.every((item: unknown) => record(item) && strings(item.format) && item.format.length > 0 && text(item.deliveryProtocol) && text(item.schemaVersion) && typeof item.deprecated === 'boolean') },
  { resource: 'destination', collection: 'destinations', name: 'getDestinations', id: 'destinationId', needs: [DESTINATION], fixture: DESTINATION,
    valid: (row: Record<string, any>) => text(row.name) && record(row.deliveryConfig) && text(row.deliveryConfig.endpoint) },
  { resource: 'subscription', collection: 'subscriptions', name: 'getSubscriptions', id: 'subscriptionId', needs: [SUBSCRIPTION, TOPIC, DESTINATION], fixture: SUBSCRIPTION,
    valid: (row: Record<string, any>) => text(row.topicId) && text(row.destinationId) && payload(row.payload) },
].map(spec => ({
  channel: 'EBAY', name: `ebay.${spec.name}`, covers: 'ebay.notification.read', what: 'read', auth: 'ebay-app', needs: spec.needs,
  url: () => `https://api.ebay.com/commerce/notification/v1/${spec.resource}?limit=100`,
  assert: ({ status, json }, context) => {
    if (status !== 200) return `eBay answered HTTP ${status} to ${spec.name}.`
    const body = json(), rows = record(body) ? body[spec.collection] : null
    if (!Array.isArray(rows) || rows.length === 0) return `eBay ${spec.name} returned no collection entries; the fixture's shape was not proven.`
    if (rows.some(row => !record(row) || !text(row[spec.id]) || !text(row.status) || !spec.valid(row))) return `eBay ${spec.name} no longer carries the notification fields used by Nexus.`
    const named = rows.find(row => row[spec.id] === context?.fixture[spec.fixture])
    if (!named) return `The named sandbox fixture was not returned in the ${spec.name} page; this check proves no configured fixture.`
    if (spec.resource === 'subscription' && (named.topicId !== context?.fixture[TOPIC] || named.destinationId !== context?.fixture[DESTINATION])) return 'The named sandbox subscription does not reference the named topic and destination.'
    return null
  },
}))

/**
 * SIGN-IN AND REACHABILITY only (review 2026-09-26): Amazon's static sandbox answers its published, FIXED
 * example, so a pass proves our sign-in reached the route and the example still reads — not a live seller's
 * listing state and not that Amazon's live contract is unchanged.
 */
export const AMAZON_LISTING_READ_CHECK: ContractCheck = {
  channel: 'AMAZON_SP', name: 'amazon.getListingsItem', covers: 'amazon.listings.getListingsItem', what: 'read',
  needs: ['NEXUS_CONTRACT_AMAZON_SELLER_ID', AMAZON_SKU],
  url: context => `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${encodeURIComponent(context.fixture.NEXUS_CONTRACT_AMAZON_SELLER_ID)}/${encodeURIComponent(context.fixture[AMAZON_SKU])}?marketplaceIds=ATVPDKIKX0DER&includedData=summaries,issues,offers,fulfillmentAvailability`,
  assert: ({ status, json }, context) => {
    if (status !== 200) return `Amazon's static sandbox answered HTTP ${status} to getListingsItem: sign-in or reachability failed.`
    const body = json()
    if (!record(body) || !text(body.sku) || body.sku !== context?.fixture[AMAZON_SKU]) return 'Amazon\'s static sandbox getListingsItem did not return the named example SKU.'
    if (!Array.isArray(body.summaries) || body.summaries.length === 0 || body.summaries.some(row => !record(row)
      || !text(row.marketplaceId) || !text(row.asin) || !text(row.productType) || !strings(row.status) || !text(row.itemName))) return 'Amazon\'s static sandbox getListingsItem example no longer carries the listing summary fields used by Nexus.'
    if (!Array.isArray(body.issues) || body.issues.length === 0 || body.issues.some(row => !record(row) || !text(row.code) || !text(row.message)
      || !['ERROR', 'WARNING', 'INFO'].includes(row.severity) || (row.attributeNames !== undefined && !strings(row.attributeNames)))) return 'Amazon\'s static sandbox getListingsItem example no longer carries the issue fields.'
    if (!Array.isArray(body.offers) || body.offers.length === 0 || body.offers.some(row => !record(row) || !text(row.marketplaceId)
      || !record(row.price) || !text(row.price.currencyCode) || typeof row.price.amount !== 'string' || !/^\d+(\.\d+)?$/.test(row.price.amount))) return 'Amazon\'s static sandbox getListingsItem example no longer carries the offer price fields.'
    if (!Array.isArray(body.fulfillmentAvailability) || body.fulfillmentAvailability.length === 0 || body.fulfillmentAvailability.some(row => !record(row)
      || !text(row.fulfillmentChannelCode) || !Number.isSafeInteger(row.quantity) || row.quantity < 0)) return 'Amazon\'s static sandbox getListingsItem example no longer carries fulfillment availability.'
    return null
  },
}
