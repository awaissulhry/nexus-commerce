import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import listingsFixture from './fixtures/amazon-listings-sandbox.json' with { type: 'json' }

const h = vi.hoisted(() => ({ calls: [] as any[], token: vi.fn(), environment: 'sandbox', reply: null as any }))
vi.mock('../gateway/gateway.js', () => ({
  GatewayRefusal: class extends Error {},
  gatewayCall: vi.fn(async (request: any) => {
    h.calls.push(request)
    const body = h.reply?.(request) ?? {}
    return { status: 200, text: JSON.stringify(body), json: () => body }
  }),
}))
vi.mock('../cx/connectors/ebay/client.js', () => ({ ebayAppToken: h.token }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'account-token') }))
vi.mock('../../db.js', () => ({ default: { channelConnection: { findUnique: vi.fn(async () => ({ channelType: 'EBAY', connectionMetadata: { environment: h.environment } })) } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { CHANNEL_CONTRACTS, REQUIRED_OPERATIONS } from './channel-contracts.js'
import { runChannelContracts } from './contract-run.service.js'

const keys = {
  NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID: 'AUTHORIZATION_REVOCATION',
  NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID: 'destination-fixture',
  NEXUS_CONTRACT_EBAY_SANDBOX_SUBSCRIPTION_ID: 'subscription-fixture',
  NEXUS_CONTRACT_AMAZON_SELLER_ID: 'AXXXXXXXXXXXX', NEXUS_CONTRACT_AMAZON_SANDBOX_SKU: 'GM-ZDPI-9B4E',
}
const payload = { format: 'JSON', deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }
const bodies: Record<string, any> = {
  'ebay.getTopics': { topics: [{ topicId: keys.NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID, status: 'ENABLED', supportedPayloads: [{ ...payload, format: ['JSON'], deprecated: false }] }] },
  'ebay.getDestinations': { destinations: [{ destinationId: keys.NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID, name: 'Synthetic destination', status: 'ENABLED', deliveryConfig: { endpoint: 'https://example.test/inbound', verificationToken: 'synthetic-private-token' } }] },
  'ebay.getSubscriptions': { subscriptions: [{ subscriptionId: keys.NEXUS_CONTRACT_EBAY_SANDBOX_SUBSCRIPTION_ID, topicId: keys.NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID, destinationId: keys.NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID, status: 'ENABLED', payload }] },
  'amazon.getListingsItem': listingsFixture,
}
function check(name: string) { const found = CHANNEL_CONTRACTS.find(row => row.name === name); expect(found, `Missing required check ${name}`).toBeDefined(); return found! }
function assess(name: string, body: unknown, status = 200) {
  return check(name).assert({ status, text: JSON.stringify(body), json: () => body }, { accountId: 'fixture-account', sellerId: keys.NEXUS_CONTRACT_AMAZON_SELLER_ID, fixture: keys })
}
beforeEach(() => {
  vi.resetAllMocks(); h.calls = []; h.environment = 'sandbox'; h.token.mockResolvedValue('sandbox-app-token')
  for (const key of ['EBAY', 'AMAZON_SP', 'AMAZON_ADS', 'SHOPIFY', 'ETSY']) vi.stubEnv(`NEXUS_CONTRACT_ACCOUNT_${key}`, '')
  for (const [key, value] of Object.entries(keys)) vi.stubEnv(key, value)
  h.reply = (request: any) => bodies[request.operation.replace('contract.', '')]
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live request in contract tests') }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('implements every missing read while retaining the existing required operations', () => {
  const notification = CHANNEL_CONTRACTS.filter(row => row.covers === 'ebay.notification.read')
  expect(notification.map(row => row.name).sort()).toEqual(['ebay.getDestinations', 'ebay.getSubscriptions', 'ebay.getTopics'])
  expect(check('amazon.getListingsItem').covers).toBe('amazon.listings.getListingsItem')
  expect(REQUIRED_OPERATIONS.EBAY!.find(row => row.id === 'ebay.notification.read')).not.toHaveProperty('gap')
})
it.each(Object.keys(bodies))('%s accepts documented shapes and rejects HTTP failures, missing/empty structures', name => {
  expect(assess(name, bodies[name])).toBeNull()
  expect(assess(name, bodies[name], 403)).toBeTypeOf('string')
  expect(assess(name, {})).toBeTypeOf('string')
  const empty = name === 'amazon.getListingsItem' ? { ...listingsFixture, summaries: [] } : { [Object.keys(bodies[name])[0]]: [] }
  expect(assess(name, empty)).toBeTypeOf('string')
  // Empty provider data is a shape-proof gap; a nonempty page missing the fixture is a different operator action.
  if (name.startsWith('ebay.')) expect(assess(name, empty)).toMatch(/no collection entries/)
})
it.each([
  ['ebay.getTopics', 'topics', 'topicId'], ['ebay.getDestinations', 'destinations', 'destinationId'],
  ['ebay.getSubscriptions', 'subscriptions', 'subscriptionId'],
])('%s cannot pass on an unrelated named fixture', (name, list, field) => {
  const body = structuredClone(bodies[name]); body[list][0][field] = 'another-fixture'
  expect(assess(name, body)).toBeTypeOf('string')
})
it('validates notification payload capabilities and destination/subscription configuration shapes without disclosing secrets', () => {
  const topic = structuredClone(bodies['ebay.getTopics']); topic.topics[0].supportedPayloads[0].format = 'JSON'
  expect(assess('ebay.getTopics', topic)).toBeTypeOf('string')
  const destination = structuredClone(bodies['ebay.getDestinations']); destination.destinations[0].deliveryConfig.endpoint = null
  const reason = assess('ebay.getDestinations', destination); expect(reason).toBeTypeOf('string'); expect(reason).not.toContain('synthetic-private-token')
  const subscription = structuredClone(bodies['ebay.getSubscriptions']); delete subscription.subscriptions[0].payload.schemaVersion
  expect(assess('ebay.getSubscriptions', subscription)).toBeTypeOf('string')
})
it('checks Amazon identity and the summaries/issues used by listing diagnostics', () => {
  for (const patch of [{ sku: 'different' }, { summaries: [{ marketplaceId: 'ATVPDKIKX0DER' }] }, { issues: [{ code: '90220' }] }, { issues: {} }]) {
    expect(assess('amazon.getListingsItem', { ...listingsFixture, ...patch })).toBeTypeOf('string')
  }
  const url = new URL(check('amazon.getListingsItem').url({ accountId: 'fixture-account', sellerId: keys.NEXUS_CONTRACT_AMAZON_SELLER_ID, fixture: keys }))
  expect(url.pathname).toBe('/listings/2021-08-01/items/AXXXXXXXXXXXX/GM-ZDPI-9B4E')
  expect(url.searchParams.get('marketplaceIds')).toBe('ATVPDKIKX0DER')
  expect(url.searchParams.get('includedData')?.split(',')).toContain('issues')
})
it.each([
  { offers: [] }, { offers: [{ marketplaceId: 'ATVPDKIKX0DER', price: { currencyCode: 'USD', amount: 'not-money' } }] },
  { fulfillmentAvailability: [] }, { fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: -1 }] },
  { fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 1.5 }] },
])('rejects incomplete static listing price/quantity evidence %j', patch => {
  expect(assess('amazon.getListingsItem', { ...listingsFixture, ...patch })).toBeTypeOf('string')
})
it('rejects a named subscription that points at another topic or destination', () => {
  for (const field of ['topicId', 'destinationId']) {
    const body = structuredClone(bodies['ebay.getSubscriptions']); body.subscriptions[0][field] = 'different'
    expect(assess('ebay.getSubscriptions', body)).toBeTypeOf('string')
  }
})
it.each(['ebay.getTopics', 'ebay.getDestinations', 'ebay.getSubscriptions'])('%s rejects missing status and null rows without echoing provider content', name => {
  const body = structuredClone(bodies[name]), key = Object.keys(body)[0]
  body[key][0].status = ''
  expect(assess(name, body)).toBeTypeOf('string')
  body[key] = [null]
  expect(assess(name, body)).toBeTypeOf('string')
})
it('uses only a sandbox app token for eBay notification GETs, never the seller token or a write', async () => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
  const summary = await runChannelContracts()
  const reads = h.calls.filter(row => row.operation.includes('getTopics') || row.operation.includes('getDestinations') || row.operation.includes('getSubscriptions'))
  expect(reads).toHaveLength(3)
  for (const read of reads) expect(read).toMatchObject({ auth: 'none', kind: 'read', method: 'GET', headers: { Authorization: 'Bearer sandbox-app-token' } })
  expect(reads.every(row => new URL(row.url).hostname === 'api.sandbox.ebay.com')).toBe(true)
  expect(h.token.mock.calls.every(call => call[0] === 'sandbox')).toBe(true)
  expect(summary.channels.find(row => row.channel === 'EBAY')!.operations.find(row => row.operation === 'ebay.notification.read')!.status).toBe('passed')
  expect(fetch).not.toHaveBeenCalled()
})
it('holds missing fixtures and refuses production accounts before requesting an app token', async () => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
  for (const key of Object.keys(keys)) vi.stubEnv(key, '')
  const missing = await runChannelContracts()
  expect(missing.results.filter(row => row.covers === 'ebay.notification.read').map(row => row.status)).toEqual(['not-configured', 'not-configured', 'not-configured'])
  expect(h.token).not.toHaveBeenCalled()
  for (const [key, value] of Object.entries(keys)) vi.stubEnv(key, value)
  h.environment = 'production'; await runChannelContracts()
  expect(h.token).not.toHaveBeenCalled()
})
it('reports app-token failures without exposing their private message and sends no notification read', async () => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); h.token.mockRejectedValue(new Error('private-client-secret'))
  const result = await runChannelContracts(); const reads = result.results.filter(row => row.covers === 'ebay.notification.read')
  expect(reads).toHaveLength(3); expect(reads.every(row => row.status === 'failed')).toBe(true)
  expect(JSON.stringify(reads)).not.toContain('private-client-secret')
  expect(h.calls.filter(row => row.url.includes('/commerce/notification/'))).toEqual([])
})
it.each(['', '   '])('refuses an unusable app token %j before any notification read', async token => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); h.token.mockResolvedValue(token)
  const result = await runChannelContracts()
  expect(result.results.filter(row => row.covers === 'ebay.notification.read').every(row => row.status === 'failed')).toBe(true)
  expect(h.calls.filter(row => row.url.includes('/commerce/notification/'))).toEqual([])
})
