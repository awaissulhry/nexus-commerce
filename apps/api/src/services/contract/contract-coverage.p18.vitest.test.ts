/**
 * P1.8 completion — what the contract run may call GREEN, and what its eBay dry run may call a pass.
 *
 * Three defects this file reproduces (audit 2026-09-22):
 *   1. a run was green when nothing failed and ONE check passed, however many channels or required
 *      operations were unconfigured or had no check at all — and the cron recorded that as a success;
 *   2. the eBay Verify check passed on ANY Failure carrying <Errors>, including eBay refusing the token,
 *      and it sent none of the Trading headers (no IAF token, SITEID or compatibility level);
 *   3. Etsy, which has no sandbox at all, was reported "not configured" — a gap that sounds fixable.
 *
 * Review 2026-09-26 (Owner-approved rework) — two INTENDED changes pinned here, replacing rules above:
 *   - Etsy is NOT APPLICABLE: excluded from the verdict with its reason stated, so a run CAN be green when
 *     every applicable operation passed (before: "unsupported", which kept every run partial forever);
 *   - the Amazon SP checks read Amazon's FIXED static-sandbox examples, so they are labelled what they are —
 *     sign-in and reachability — and no failure of theirs claims a vendor contract change.
 *
 * The gateway is stood in and records every call; the account token comes from a stood-in token service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import listingExample from './fixtures/amazon-listings-sandbox.json' with { type: 'json' }

type Call = { channel: string; kind: string; url: string; method: string; connectionId: string | null; operation: string; headers: Record<string, string>; auth: unknown; body: unknown; answerOk: unknown }
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  answer: null as null | ((call: Call) => { status: number; text: string; body?: unknown }),
  tokenFails: false,
  tokenEmpty: false,
  fetched: [] as Array<{ url: string; headers: Record<string, string>; auth: unknown; kind: string }>,
  cron: [] as Array<{ ok: boolean; value: unknown }>,
  tokenAsked: [] as string[],
  /** The named accounts' connectionMetadata; a missing id is an account that does not exist. */
  accounts: {} as Record<string, { environment?: string }>,
  apps: [] as Array<{ key: string; environment: string }>,
  appFails: false,
}))
vi.mock('../gateway/gateway.js', async (original) => ({
  ...(await original<object>()),
  gatewayCall: vi.fn(async (request: any) => {
    const call: Call = { channel: request.channel, kind: request.kind, url: request.url, method: request.method, connectionId: request.connectionId, operation: request.operation, headers: { ...(request.headers ?? {}) }, auth: request.auth, body: request.body, answerOk: request.answerOk }
    h.calls.push(call)
    const answer = h.answer!(call)
    const body = answer.body !== undefined ? answer.body : (() => { try { return JSON.parse(answer.text) } catch { return null } })()
    return { outcome: 'sent', ok: answer.status < 300, status: answer.status, text: answer.text, url: request.url, attempts: 1, verdict: null, rate: { remaining: null, limit: null }, headers: new Headers(), json: () => body }
  }),
  // The real Trading client's door (callTradingApi → gatewayFetch), for the header comparison.
  gatewayFetch: vi.fn(async (request: any) => {
    h.fetched.push({ url: request.url, headers: { ...(request.headers ?? {}) }, auth: request.auth, kind: request.kind })
    return new Response('<GetItemResponse><Ack>Success</Ack></GetItemResponse>', { status: 200 })
  }),
}))
vi.mock('../cx/connectors/ebay/client.js', () => ({ ebayAppToken: vi.fn(async () => 'sandbox-application-token') }))
vi.mock('../listing-issue-recorder.service.js', () => ({
  itemIdOfTradingXml: () => null,
  resolveEbayListingIds: async () => [],
  recordEbayTradingRejection: async () => undefined,
}))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async (connectionId: string) => {
    h.tokenAsked.push(connectionId)
    if (h.tokenFails) throw new Error('the account needs to be reconnected')
    return h.tokenEmpty ? '' : `iaf-token-of-${connectionId}`
  }),
}))
vi.mock('../../db.js', () => ({ default: { channelConnection: {
  findUnique: vi.fn(async ({ where }: any) => (where.id in h.accounts ? { connectionMetadata: h.accounts[where.id] } : null)),
} } }))
vi.mock('../cx/apps.service.js', () => ({
  getChannelApp: vi.fn(async (key: string, environment: string) => {
    h.apps.push({ key, environment })
    if (h.appFails) throw new Error(`No ${key} app for ${environment}`)
    return { clientId: `client-${key}-${environment}`, clientSecret: 'app-secret-never-sent' }
  }),
}))
vi.mock('../../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (_name: string, handler: () => Promise<unknown>) => {
    try {
      const value = await handler()
      h.cron.push({ ok: true, value })
      return value
    } catch (error) {
      h.cron.push({ ok: false, value: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }),
}))

import { runChannelContracts, summarizeContractRun, type ContractCheckResult } from './contract-run.service.js'
import { runChannelContractsOnce } from '../../jobs/channel-contract.job.js'
import { assertVerifyAnswer, CHANNEL_CONTRACTS, REQUIRED_OPERATIONS, NOT_APPLICABLE_CHANNELS, OUT_OF_SCOPE_CHANNELS, VERIFY_VALIDATION_CODES } from './channel-contracts.js'
import { sandboxUrlOf } from '../gateway/channels.js'
import { callTradingApi, siteIdForMarket, tradingAnswerOk } from '../ebay-trading-api.service.js'

const tradingCall = (call: Call) => call.headers['X-EBAY-API-CALL-NAME']

/** eBay's answer to a deliberately incomplete item: validation errors, which IS the contract. */
const VERIFY_VALIDATION = `<?xml version="1.0" encoding="UTF-8"?>
<VerifyAddFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Failure</Ack>
<Errors><ShortMessage>Input data is invalid.</ShortMessage><LongMessage>Input data for tag &lt;Item.Currency&gt; is invalid or missing. Please check API documentation.</LongMessage><ErrorCode>37</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>RequestError</ErrorClassification></Errors>
<Errors><ShortMessage>Invalid category.</ShortMessage><LongMessage>The category selected is not a leaf category.</LongMessage><ErrorCode>87</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>RequestError</ErrorClassification></Errors>
</VerifyAddFixedPriceItemResponse>`
const verifyError = (code: string, message: string, classification = 'RequestError') => `<?xml version="1.0" encoding="UTF-8"?>
<VerifyAddFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Failure</Ack>
<Errors><ShortMessage>${message}</ShortMessage><LongMessage>${message}</LongMessage><ErrorCode>${code}</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>${classification}</ErrorClassification></Errors>
</VerifyAddFixedPriceItemResponse>`

/** What each channel answers when its contract still holds — never an empty list, which proves no field. */
const PROFILE = { profileId: 1000000000000001, countryCode: 'IT', currencyCode: 'EUR', timezone: 'Europe/Rome', accountInfo: { marketplaceStringId: 'APJ6JRA9NG5V4', id: 'A2EXAMPLESELLER', type: 'seller', name: 'Test' } }
/** Amazon's static sandbox example for getMarketplaceParticipations (sellers.json, x-amzn-api-sandbox). */
const PARTICIPATION = { marketplace: { id: 'ATVPDKIKX0DER', countryCode: 'US', name: 'Amazon.com', defaultCurrencyCode: 'USD', defaultLanguageCode: 'en_US', domainName: 'www.amazon.com' }, storeName: 'BestSellerStore', participation: { isParticipating: true, hasSuspendedListings: false } }
const INVENTORY = { total: 1, size: 1, inventoryItems: [{ sku: 'NX-CONTRACT-01', product: { title: 'Nexus contract item' }, availability: { shipToLocationAvailability: { quantity: 3 } } }] }
const healthy = (call: Call): { status: number; text: string; body?: unknown } => {
  if (call.url.includes('/ws/api.dll')) {
    return tradingCall(call) === 'GetItem'
      ? { status: 200, text: '<GetItemResponse><Ack>Success</Ack><Item><Quantity>5</Quantity><SellingStatus><QuantitySold>1</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus></Item></GetItemResponse>' }
      : { status: 200, text: VERIFY_VALIDATION }
  }
  if (call.url.includes('/sell/inventory/v1/offer')) {
    return { status: 200, text: JSON.stringify({ total: 1, offers: [{ offerId: '5001', sku: new URL(call.url).searchParams.get('sku'), marketplaceId: 'EBAY_IT', status: 'PUBLISHED', listing: { listingId: '110550' } }] }) }
  }
  if (call.url.includes('/sell/inventory/v1/inventory_item')) return { status: 200, text: JSON.stringify(INVENTORY) }
  if (call.url.includes('marketplaceParticipations')) return { status: 200, text: JSON.stringify({ payload: [PARTICIPATION] }) }
  // Amazon's static sandbox example for listTransactions (finances_2024-06-19.json, x-amzn-api-sandbox).
  if (call.url.includes('/finances/2024-06-19/transactions')) {
    return { status: 200, text: JSON.stringify({ payload: { nextToken: 'Next token value', transactions: [{ sellingPartnerMetadata: { sellingPartnerId: 'A3TH9S8BH6GOGM', accountType: 'PAYABLE', marketplaceId: 'ATIV93840DER' }, relatedIdentifiers: [{ relatedIdentifierName: 'FINANCIAL_EVENT_GROUP_ID', relatedIdentifierValue: '4MVaHcsAfaYAlwlaPWrXJxrfUiKfYZ2ooWtY7528FUA' }, { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: '8129762527551' }], transactionType: 'Shipment', postedDate: '2020-07-14T03:35:13.214Z', totalAmount: { currencyAmount: 10, currencyCode: 'USD' } }] } }) }
  }
  if (call.url.includes('/listings/2021-08-01/items/')) return { status: 200, text: JSON.stringify(listingExample) }
  if (call.url.includes('/commerce/notification/v1/topic')) return { status: 200, text: JSON.stringify({ topics: [{ topicId: 'AUTHORIZATION_REVOCATION', status: 'ENABLED', supportedPayloads: [{ format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0', deprecated: false }] }] }) }
  if (call.url.includes('/commerce/notification/v1/destination')) return { status: 200, text: JSON.stringify({ destinations: [{ destinationId: 'fixture-destination', status: 'ENABLED', name: 'Fixture', deliveryConfig: { endpoint: 'https://example.test/inbound' } }] }) }
  if (call.url.includes('/commerce/notification/v1/subscription')) return { status: 200, text: JSON.stringify({ subscriptions: [{ subscriptionId: 'fixture-subscription', status: 'ENABLED', topicId: 'AUTHORIZATION_REVOCATION', destinationId: 'fixture-destination', payload: { format: 'JSON', deliveryProtocol: 'HTTPS', schemaVersion: '1.0' } }] }) }
  if (call.url.includes('/v2/profiles')) return { status: 200, text: JSON.stringify([PROFILE]) }
  return { status: 599, text: `no fixture for ${call.url}` }
}

const ENV = ['NEXUS_EBAY_REAL_API', 'EBAY_SANDBOX', 'NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', 'NEXUS_CONTRACT_ACCOUNT_EBAY', 'NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'NEXUS_CONTRACT_ACCOUNT_SHOPIFY', 'NEXUS_CONTRACT_ACCOUNT_ETSY', 'NEXUS_CONTRACT_EBAY_SANDBOX_SKU', 'NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID', 'NEXUS_CONTRACT_AMAZON_SELLER_ID', 'NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID', 'NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID', 'NEXUS_CONTRACT_EBAY_SANDBOX_SUBSCRIPTION_ID', 'NEXUS_CONTRACT_AMAZON_SANDBOX_SKU']
const configureEveryAccount = () => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'amazon-sandbox')
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
}

beforeEach(() => {
  h.calls = []; h.cron = []; h.fetched = []; h.tokenFails = false; h.tokenEmpty = false; h.tokenAsked = []; h.apps = []; h.appFails = false
  h.accounts = { 'ebay-sandbox': { environment: 'sandbox' }, 'amazon-sandbox': {}, 'ads-test': {} }
  h.answer = healthy
  for (const key of ENV) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

describe('defect 1 — a partial run is NOT green', () => {
  it('every account named and every check healthy, but required operations unproven: PARTIAL, and the sentence names each gap', async () => {
    configureEveryAccount()
    const summary = await runChannelContracts()
    expect(summary.results.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.detail}`)).toEqual([])
    expect(summary.status).toBe('partial')
    expect(summary.sentence).not.toMatch(/passed;/)
    // each gap, by name: two unnamed sandbox fixtures, two operations with no check, Etsy's missing sandbox
    expect(summary.sentence).toMatch(/NEXUS_CONTRACT_EBAY_SANDBOX_SKU/)
    expect(summary.sentence).toMatch(/NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID/)
    expect(summary.sentence).toMatch(/notification/i)
    expect(summary.sentence).toMatch(/getListingsItem/)
    expect(summary.sentence).toMatch(/Etsy/)
  })
  it('ONE passing check with every other channel unconfigured is partial, not green', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
    const summary = await runChannelContracts()
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.status).toBe('partial')
    expect(summary.sentence).toMatch(/NEXUS_CONTRACT_ACCOUNT_EBAY/)
  })
  it('the cron record of a partial run says partial, never passed', async () => {
    configureEveryAccount()
    const summary = await runChannelContractsOnce('manual')
    expect(summary.status).toBe('partial')
    expect(h.cron).toHaveLength(1)
    // Review 2026-09-23: a partial run is recorded as PARTIAL (not SUCCESS), proven/required first.
    // Review 2026-09-26: Etsy is not applicable, so the applicable required operations are 9, not 11.
    expect(h.cron[0].value).toEqual({ summary: summary.sentence, cronStatus: 'PARTIAL' })
    expect(summary.sentence).toMatch(/^5\/9 required operations proven — Partial, not green\./)
    expect(summary.sentence).not.toMatch(/passed;/)
  })
})

describe('defect 2 — the eBay dry run passes only on a VALIDATION answer, sent with the Trading headers', () => {
  const verifyOf = (summary: Awaited<ReturnType<typeof runChannelContracts>>) => summary.results.find((r) => r.name === 'ebay.verifyAddFixedPriceItem')
  it('an auth failure (931, the token eBay refused) FAILS the check', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    h.answer = (call) => (call.url.includes('/ws/api.dll') ? { status: 200, text: verifyError('931', 'Auth token is invalid.') } : healthy(call))
    const summary = await runChannelContracts()
    expect(verifyOf(summary)).toMatchObject({ status: 'failed', detail: expect.stringContaining('931') })
    expect(summary.status).toBe('red')
  })
  it('a validation failure (the item is incomplete, which it is on purpose) passes', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    const summary = await runChannelContracts()
    expect(verifyOf(summary)).toMatchObject({ status: 'passed', detail: null })
  })
  it('the dry run carries the IAF token, site, compatibility level and call name, with no bearer from the gateway', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    await runChannelContracts()
    const verify = h.calls.find((call) => tradingCall(call) === 'VerifyAddFixedPriceItem')!
    expect(verify).toBeDefined()
    expect(verify.headers).toMatchObject({
      'X-EBAY-API-IAF-TOKEN': 'iaf-token-of-ebay-sandbox',
      'X-EBAY-API-SITEID': '101',
      'X-EBAY-API-COMPATIBILITY-LEVEL': expect.stringMatching(/^\d+$/),
      'X-EBAY-API-CALL-NAME': 'VerifyAddFixedPriceItem',
    })
    expect(verify.auth).toBe('none')
  })
})

describe('defect 3 — Etsy is not applicable, not "not configured"', () => {
  it('Etsy has no sandbox: its operations are NOT APPLICABLE, with the reason, and nothing is sent', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_ETSY', 'etsy-shop')
    const summary = await runChannelContracts()
    const etsy = summary.results.filter((r) => r.channel === 'ETSY')
    expect(etsy.length).toBeGreaterThan(0)
    for (const row of etsy) expect(row).toMatchObject({ status: 'not-applicable', detail: expect.stringContaining('no sandbox') })
    expect(h.calls.filter((call) => call.channel === 'ETSY')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The verdict rule on its own, against stood-in required lists.
// ─────────────────────────────────────────────────────────────────────────────

const result = (channel: string, covers: string, status: ContractCheckResult['status'], name = covers): ContractCheckResult =>
  ({ channel: channel as ContractCheckResult['channel'], name, covers, what: 'read', status, detail: status === 'passed' ? null : `${name} is ${status}`, latencyMs: null })
const PLAN = {
  EBAY: [{ id: 'e.inventory', label: 'eBay inventory read' }, { id: 'e.offer', label: 'eBay offer read' }],
  ETSY: [{ id: 't.shop', label: 'Etsy shop read' }],
}

describe('the verdict — green only when every required operation of every in-scope channel passed', () => {
  it('positive control: every required operation passed → GREEN, every channel covered', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed'), result('ETSY', 't.shop', 'passed')], PLAN)
    expect(summary.status).toBe('green')
    expect(summary.channels.map((c) => [c.channel, c.status])).toEqual([['EBAY', 'covered'], ['ETSY', 'covered']])
    expect(summary).toMatchObject({ required: 3, proven: 3, gaps: [] })
    expect(summary.sentence).toMatch(/^3\/3 required operations proven — Green on EBAY, ETSY\./)
    expect(summary.sentence).not.toMatch(/Not applicable/)
  })
  it('a channel with one operation passed and one NOT APPLICABLE is partial, not covered: only a WHOLE channel is excluded', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'not-applicable'), result('ETSY', 't.shop', 'passed')], PLAN)
    expect(summary.channels.find((c) => c.channel === 'EBAY')?.status).toBe('partial')
    expect(summary.status).toBe('partial')
  })
  it('an operation proven by one check but blocked by another is not passed', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed', 'a'), result('EBAY', 'e.offer', 'not-configured', 'b'), result('ETSY', 't.shop', 'passed')], PLAN)
    expect(summary.channels[0].operations.find((op) => op.operation === 'e.offer')).toMatchObject({ status: 'not-configured', checks: ['a', 'b'] })
    expect(summary.status).toBe('partial')
  })
  it('channel statuses: partial, not-configured, failed — and a failure anywhere is RED', () => {
    const partial = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'not-configured'), result('ETSY', 't.shop', 'not-configured')], PLAN)
    expect(partial.channels.map((c) => c.status)).toEqual(['partial', 'not-configured'])
    expect(partial.status).toBe('partial')
    const red = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'failed'), result('ETSY', 't.shop', 'passed')], PLAN)
    expect(red.channels[0].status).toBe('failed')
    expect(red.status).toBe('red')
    // Out of scope (no required list) but failed: a channel changed — still red.
    const outOfScope = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed'), result('ETSY', 't.shop', 'passed'), result('SHOPIFY', 's.shop', 'failed')], PLAN)
    expect(outOfScope.status).toBe('red')
  })
  it('nothing passed → NOT-CONFIGURED; a required operation with no check is UNCOVERED and named with its reason', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'not-configured')], { EBAY: [...PLAN.EBAY, { id: 'e.notify', label: 'eBay notification reads', gap: 'no check: needs an app token' }] })
    expect(summary.status).toBe('not-configured')
    expect(summary.channels[0].status).toBe('not-configured')
    const ops = summary.channels[0].operations
    expect(ops.find((op) => op.operation === 'e.notify')).toMatchObject({ status: 'uncovered', checks: [], detail: 'no check: needs an app token' })
    expect(ops.find((op) => op.operation === 'e.offer')).toMatchObject({ status: 'uncovered', detail: 'no check proves it yet' })
    expect(summary.sentence).toMatch(/eBay notification reads — no check: needs an app token/)
  })
  it('an empty required list proves nothing: never green', () => {
    expect(summarizeContractRun([result('EBAY', 'e.inventory', 'passed')], {}).status).toBe('partial')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Today's required list, through the runner.
// ─────────────────────────────────────────────────────────────────────────────

const namedFixtures = () => {
  vi.stubEnv('NEXUS_CONTRACT_EBAY_SANDBOX_SKU', 'NX-CONTRACT 01/A')
  vi.stubEnv('NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID', '110550123456')
}

describe('coverage with today\'s required list', () => {
  it('the list is honest: every check proves an operation its channel requires, and every operation without a check says why', () => {
    for (const check of CHANNEL_CONTRACTS) {
      expect(REQUIRED_OPERATIONS[check.channel]?.map((op) => op.id), `${check.name}`).toContain(check.covers)
    }
    const notApplicable = new Set(NOT_APPLICABLE_CHANNELS.map((u) => u.channel))
    for (const [channel, ops] of Object.entries(REQUIRED_OPERATIONS)) {
      if (notApplicable.has(channel as never)) continue
      for (const op of ops!) {
        if (!CHANNEL_CONTRACTS.some((c) => c.channel === channel && c.covers === op.id)) expect(op.gap, `${op.id} has no check and no stated gap`).toMatch(/^no check/)
      }
    }
    // The brief's required operations, by channel; Shopify stays out of the verdict.
    expect(Object.keys(REQUIRED_OPERATIONS).sort()).toEqual(['AMAZON_ADS', 'AMAZON_SP', 'EBAY', 'ETSY'])
    expect(REQUIRED_OPERATIONS.AMAZON_SP!.map((op) => op.id)).toEqual(['amazon.finances.listTransactions', 'amazon.sellers.getMarketplaceParticipations', 'amazon.listings.getListingsItem'])
    expect(REQUIRED_OPERATIONS.EBAY!.map((op) => op.id)).toEqual(['ebay.inventory.read', 'ebay.offer.read', 'ebay.trading.GetItem', 'ebay.trading.VerifyAddFixedPriceItem', 'ebay.notification.read'])
    expect(REQUIRED_OPERATIONS.ETSY!.map((op) => op.id)).toEqual(['etsy.shop.read', 'etsy.receipt.read'])
    expect(OUT_OF_SCOPE_CHANNELS.map((c) => c.channel)).toEqual(['SHOPIFY'])
  })
  it('every account and fixture named, every answer healthy: 7 of 9 proven, PARTIAL, per-channel statuses', async () => {
    configureEveryAccount(); namedFixtures()
    const summary = await runChannelContracts()
    expect(summary.failed).toBe(0)
    expect(summary.status).toBe('partial')
    expect(Object.fromEntries(summary.channels.map((c) => [c.channel, c.status]))).toEqual({ EBAY: 'partial', AMAZON_SP: 'partial', AMAZON_ADS: 'covered', ETSY: 'not-applicable' })
    expect(summary).toMatchObject({ required: 9, proven: 7, notApplicable: 2 })
    expect(summary.gaps).toHaveLength(2)
    expect(summary.channels.some((c) => c.channel === 'SHOPIFY')).toBe(false)
    expect(summary.results.find((r) => r.channel === 'SHOPIFY')).toMatchObject({ status: 'not-configured', detail: expect.stringContaining('development-store') })
    expect(summary.sentence).toMatch(/^7\/9 required operations proven — Partial, not green\. Not proven: /)
  })
  it('nothing configured: NOT-CONFIGURED, no call, Etsy still not applicable and eBay not-configured', async () => {
    const summary = await runChannelContracts()
    expect(h.calls).toEqual([])
    expect(summary.status).toBe('not-configured')
    expect(Object.fromEntries(summary.channels.map((c) => [c.channel, c.status]))).toEqual({ EBAY: 'not-configured', AMAZON_SP: 'not-configured', AMAZON_ADS: 'not-configured', ETSY: 'not-applicable' })
    expect(summary.sentence).toMatch(/^0\/9 required operations proven — No channel contract check could run\./)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The new checks: gated on named fixtures, reads, sandbox hosts only.
// ─────────────────────────────────────────────────────────────────────────────

const SANDBOX_HOST: Record<string, string> = { EBAY: 'api.sandbox.ebay.com', AMAZON_SP: 'sandbox.sellingpartnerapi-eu.amazon.com', AMAZON_ADS: 'advertising-api-test.amazon.com' }
const byName = (summary: Awaited<ReturnType<typeof runChannelContracts>>, name: string) => summary.results.find((r) => r.name === name)

describe('new checks — fixture-gated, reads only, sandbox hosts only', () => {
  it('eBay offer read and GetItem are NOT CONFIGURED, with the variable named and nothing sent, until their fixture is named', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    const summary = await runChannelContracts()
    expect(byName(summary, 'ebay.getOffers')).toMatchObject({ status: 'not-configured', detail: expect.stringContaining('NEXUS_CONTRACT_EBAY_SANDBOX_SKU') })
    expect(byName(summary, 'ebay.getItem')).toMatchObject({ status: 'not-configured', detail: expect.stringContaining('NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID') })
    expect(h.calls.filter((call) => call.url.includes('/offer') || tradingCall(call) === 'GetItem')).toEqual([])
  })
  it('every check goes out ONCE, as a read, to its channel\'s exact sandbox host — never a production host', async () => {
    configureEveryAccount(); namedFixtures()
    for (const [key, value] of Object.entries({ NEXUS_CONTRACT_AMAZON_SELLER_ID: 'AXXXXXXXXXXXX', NEXUS_CONTRACT_AMAZON_SANDBOX_SKU: 'GM-ZDPI-9B4E', NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID: 'AUTHORIZATION_REVOCATION', NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID: 'fixture-destination', NEXUS_CONTRACT_EBAY_SANDBOX_SUBSCRIPTION_ID: 'fixture-subscription' })) vi.stubEnv(key, value)
    const summary = await runChannelContracts()
    // Review 2026-09-26: every applicable operation proven, Etsy not applicable — GREEN (was partial, 9/11).
    expect(summary).toMatchObject({ status: 'green', failed: 0, required: 9, proven: 9 })
    expect(h.calls.map((call) => call.operation).sort()).toEqual(CHANNEL_CONTRACTS.map((c) => `contract.${c.name}`).sort())
    for (const call of h.calls) {
      expect(call.kind).toBe('read')
      expect(new URL(call.url).hostname, call.operation).toBe(call.operation === 'contract.amazon.getListingsItem' ? 'sandbox.sellingpartnerapi-na.amazon.com' : SANDBOX_HOST[call.channel])
    }
  })
  it('the sandbox rule holds for every check: its URL is production, and only the sandbox mapping makes it sendable', () => {
    const ctx = { accountId: 'a', fixture: { NEXUS_CONTRACT_EBAY_SANDBOX_SKU: 'S', NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID: '1' } }
    for (const check of CHANNEL_CONTRACTS) {
      const production = check.url(ctx)
      expect(new URL(production).hostname, check.name).not.toMatch(/sandbox|-test\./)
      expect(new URL(sandboxUrlOf(check.channel, production)!).hostname, check.name).toBe(check.name === 'amazon.getListingsItem' ? 'sandbox.sellingpartnerapi-na.amazon.com' : SANDBOX_HOST[check.channel])
    }
  })
  it('eBay offer read: the named SKU, encoded; passes on the shape the reconcile reads, fails on an empty or renamed offer', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); namedFixtures()
    const ok = await runChannelContracts()
    const call = h.calls.find((c) => c.operation === 'contract.ebay.getOffers')!
    expect(new URL(call.url).searchParams.get('sku')).toBe('NX-CONTRACT 01/A')
    expect(byName(ok, 'ebay.getOffers')).toMatchObject({ status: 'passed' })
    h.answer = (c) => (c.url.includes('/offer') ? { status: 200, text: JSON.stringify({ total: 0, offers: [] }) } : healthy(c))
    expect(byName(await runChannelContracts(), 'ebay.getOffers')).toMatchObject({ status: 'failed', detail: expect.stringContaining('no offer') })
    h.answer = (c) => (c.url.includes('/offer') ? { status: 200, text: JSON.stringify({ offers: [{ id: '5001', sku: 'x', status: 'PUBLISHED', listing: { listingId: '1' } }] }) } : healthy(c))
    expect(byName(await runChannelContracts(), 'ebay.getOffers')).toMatchObject({ status: 'failed', detail: expect.stringContaining('offerId') })
  })
  it('eBay GetItem: the read-back request for the named item, with the IAF token; fails on an auth answer or a missing ListingStatus', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); namedFixtures()
    const ok = await runChannelContracts()
    const call = h.calls.find((c) => tradingCall(c) === 'GetItem')!
    expect(String(call.body)).toContain('<ItemID>110550123456</ItemID>')
    expect(call.headers['X-EBAY-API-IAF-TOKEN']).toBe('iaf-token-of-ebay-sandbox')
    expect(call.auth).toBe('none')
    expect(byName(ok, 'ebay.getItem')).toMatchObject({ status: 'passed' })
    h.answer = (c) => (tradingCall(c) === 'GetItem' ? { status: 200, text: '<GetItemResponse><Ack>Failure</Ack><Errors><ErrorCode>931</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>RequestError</ErrorClassification><LongMessage>Auth token is invalid.</LongMessage></Errors></GetItemResponse>' } : healthy(c))
    expect(byName(await runChannelContracts(), 'ebay.getItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('931') })
    h.answer = (c) => (tradingCall(c) === 'GetItem' ? { status: 200, text: '<GetItemResponse><Ack>Success</Ack><Item><Quantity>5</Quantity></Item></GetItemResponse>' } : healthy(c))
    expect(byName(await runChannelContracts(), 'ebay.getItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('ListingStatus') })
  })
  it('Amazon listTransactions: Amazon\'s static-sandbox request, read with our own reader; a renamed list fails', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'amazon-sandbox')
    const ok = await runChannelContracts()
    const call = h.calls.find((c) => c.operation === 'contract.amazon.listTransactions')!
    const url = new URL(call.url)
    expect(url.pathname).toBe('/finances/2024-06-19/transactions')
    expect(Object.fromEntries(url.searchParams)).toEqual({ postedAfter: '2023-03-07', nextToken: 'jehgri34yo7jr9e8f984tr9i4o' })
    expect(byName(ok, 'amazon.listTransactions')).toMatchObject({ status: 'passed' })
    h.answer = (c) => (c.url.includes('/transactions') ? { status: 200, text: JSON.stringify({ payload: { items: [] } }) } : healthy(c))
    expect(byName(await runChannelContracts(), 'amazon.listTransactions')).toMatchObject({ status: 'failed', detail: expect.stringContaining('readTransactionsPage') })
  })
  it('no token for the eBay account: both Trading checks FAIL and nothing is sent to Trading without its token', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); namedFixtures()
    h.tokenFails = true
    const summary = await runChannelContracts()
    expect(byName(summary, 'ebay.verifyAddFixedPriceItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reconnected') })
    expect(byName(summary, 'ebay.getItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reconnected') })
    expect(h.calls.filter((call) => call.url.includes('/ws/api.dll'))).toEqual([])
    expect(summary.status).toBe('red')
    // An empty token is no token: never an IAF header with nothing in it.
    h.tokenFails = false; h.tokenEmpty = true
    const empty = await runChannelContracts()
    expect(byName(empty, 'ebay.verifyAddFixedPriceItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('No token') })
    expect(h.calls.filter((call) => call.url.includes('/ws/api.dll'))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The Verify fixture pair, and the Trading headers against the real Trading client.
// ─────────────────────────────────────────────────────────────────────────────

describe('Verify — only a validation answer proves the dry-run contract', () => {
  it.each([
    ['37', 'Input data for tag <Item.Currency> is invalid or missing.'],
    ['107', 'The category is not valid, select another category.'],
    ['21919303', 'The item specific Brand is missing.'],
  ])('validation error %s passes', (code, message) => {
    expect(assertVerifyAnswer(200, verifyError(code, message))).toBeNull()
  })
  it.each([
    ['931', 'Auth token is invalid.', /auth: token invalid/],
    ['932', 'Auth token is hard expired.', /auth: token hard-expired/],
    ['930', 'No Password and no token.', /auth: no token/],
    ['21916984', 'IAF token supplied is invalid.', /auth: IAF token invalid/],
    ['21917053', 'IAF token supplied is expired.', /auth: IAF token expired/],
    ['2', 'The API call "" is invalid or not supported in this release.', /header: unsupported call name/],
    ['26', 'The site ID you have entered is invalid.', /header: invalid site id/],
    ['127', 'API application "" invalid.', /header: application name invalid/],
    ['10007', 'System error. Unable to process your request.', /system error/],
    ['99999', 'Something eBay never documented.', /99999/],
  ])('error %s FAILS the check', (code, message, reason) => {
    const detail = assertVerifyAnswer(200, verifyError(code, message))
    expect(detail).toEqual(expect.stringMatching(/eBay did not validate the item/))
    expect(detail).toEqual(expect.stringMatching(reason))
  })
  it('a validation code classified as a SystemError fails; a validation error beside an auth error fails', () => {
    expect(assertVerifyAnswer(200, verifyError('37', 'Input data is invalid.', 'SystemError'))).toEqual(expect.stringMatching(/SystemError/))
    const mixed = VERIFY_VALIDATION.replace('</VerifyAddFixedPriceItemResponse>', '<Errors><ErrorCode>931</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>RequestError</ErrorClassification><LongMessage>Auth token is invalid.</LongMessage></Errors></VerifyAddFixedPriceItemResponse>')
    expect(assertVerifyAnswer(200, mixed)).toEqual(expect.stringMatching(/931/))
  })
  it('a warning beside validation errors still passes; Failure with no error, Success with no fees, no Ack, or HTTP 500 fail', () => {
    const withWarning = VERIFY_VALIDATION.replace('</VerifyAddFixedPriceItemResponse>', '<Errors><ErrorCode>21916516</ErrorCode><SeverityCode>Warning</SeverityCode><ErrorClassification>RequestError</ErrorClassification></Errors></VerifyAddFixedPriceItemResponse>')
    expect(assertVerifyAnswer(200, withWarning)).toBeNull()
    expect(assertVerifyAnswer(200, '<R><Ack>Success</Ack><Fees/></R>')).toBeNull()
    expect(assertVerifyAnswer(200, '<R><Ack>Failure</Ack></R>')).toEqual(expect.stringMatching(/no error/))
    expect(assertVerifyAnswer(200, '<R><Ack>Success</Ack></R>')).toEqual(expect.stringMatching(/no fees/))
    expect(assertVerifyAnswer(200, '<R><Ack>PartialFailure</Ack></R>')).toEqual(expect.stringMatching(/<Ack>/))
    expect(assertVerifyAnswer(500, VERIFY_VALIDATION)).toEqual(expect.stringMatching(/HTTP 500/))
  })
  it('the accepted set holds no auth, header or system code', () => {
    for (const code of ['2', '26', '124', '127', '131', '518', '930', '931', '932', '10007', '16100', '16110', '16112', '16119', '17470', '21916013', '21916984', '21917053']) {
      expect(VERIFY_VALIDATION_CODES.has(code), code).toBe(false)
    }
  })
})

describe('the Trading headers are the real Trading client\'s — minus the app keys eBay ignores', () => {
  // eBay (Trading "Making a call", HTTP headers): DEV/APP/CERT-NAME are "only required for calls that set up
  // and retrieve a user's authentication token … In all other calls, this value is ignored." The real client
  // still sends the PRODUCTION values; a sandbox contract call must not carry them (CERT is a secret).
  const APP_KEYS = ['X-EBAY-API-DEV-NAME', 'X-EBAY-API-APP-NAME', 'X-EBAY-API-CERT-NAME']
  const PROD = { EBAY_DEV_ID: 'prod-dev-0001', EBAY_APP_ID: 'Prod-App-PRD-0001', EBAY_CERT_ID: 'PRD-cert-secret-0001' }
  it('GetItem and VerifyAddFixedPriceItem go out with callTradingApi\'s headers except the app keys, and gateway auth none', async () => {
    vi.stubEnv('EBAY_COMPAT_LEVEL', '1235')
    for (const [name, value] of Object.entries(PROD)) vi.stubEnv(name, value)
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true'); vi.stubEnv('EBAY_SANDBOX', 'true')
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); namedFixtures()
    await runChannelContracts()
    const ctx = { oauthToken: 'iaf-token-of-ebay-sandbox', siteId: siteIdForMarket('IT'), connectionId: 'ebay-sandbox', market: 'IT' }
    for (const callName of ['GetItem', 'VerifyAddFixedPriceItem']) {
      h.fetched = []
      await callTradingApi(callName, '<GetItemRequest/>', ctx).catch(() => undefined)
      const real = h.fetched[0]
      const contract = h.calls.find((call) => tradingCall(call) === callName)!
      expect(real, callName).toBeDefined()
      // Positive control: the real client DOES send the production keys, so the comparison can see them.
      expect(real.headers['X-EBAY-API-CERT-NAME']).toBe(PROD.EBAY_CERT_ID)
      expect(contract.headers, callName).toEqual(Object.fromEntries(Object.entries(real.headers).filter(([name]) => !APP_KEYS.includes(name))))
      expect(contract.auth).toBe(real.auth)
      expect(new URL(contract.url).host).toBe(new URL(real.url).host)
      expect(contract.kind).toBe('read')
    }
  })
  it('no contract call carries a production app key, under any header name', async () => {
    for (const [name, value] of Object.entries(PROD)) vi.stubEnv(name, value)
    configureEveryAccount(); namedFixtures()
    await runChannelContracts()
    expect(h.calls.length).toBeGreaterThan(0)
    for (const call of h.calls) {
      for (const name of APP_KEYS) expect(call.headers, `${call.operation} ${name}`).not.toHaveProperty(name)
      for (const secret of Object.values(PROD)) expect(JSON.stringify(call.headers), call.operation).not.toContain(secret)
    }
  })
})

describe('review 2026-09-23 — eBay checks run only as an eBay SANDBOX account', () => {
  it('a named account whose connection is production: every eBay check FAILS, nothing is sent, no token is read', async () => {
    h.accounts['ebay-live'] = { environment: 'production' }
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-live'); namedFixtures()
    const summary = await runChannelContracts()
    const ebay = summary.results.filter((r) => r.channel === 'EBAY')
    expect(ebay).toHaveLength(7)
    for (const row of ebay) expect(row).toMatchObject({ status: 'failed', detail: expect.stringContaining('not an eBay sandbox account') })
    expect(h.calls.filter((call) => call.channel === 'EBAY')).toEqual([])
    expect(h.tokenAsked).toEqual([])
    expect(summary.status).toBe('red')
  })
  it('a connection with no environment recorded counts as production', async () => {
    h.accounts['ebay-unmarked'] = {}
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-unmarked')
    const summary = await runChannelContracts()
    expect(byName(summary, 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('not an eBay sandbox account') })
    expect(h.calls).toEqual(h.calls.filter((call) => call.channel !== 'EBAY'))
  })
  it('a named account that does not exist: failed, nothing sent', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-missing')
    const summary = await runChannelContracts()
    expect(byName(summary, 'ebay.verifyAddFixedPriceItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('does not exist') })
    expect(h.calls.filter((call) => call.channel === 'EBAY')).toEqual([])
  })
  it('positive control: the sandbox account sends', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    await runChannelContracts()
    expect(h.calls.filter((call) => call.channel === 'EBAY').length).toBe(2)
  })
})

describe('review 2026-09-23 — a check passes only on an answer that proves the fields Nexus reads', () => {
  const run = async (match: string, answer: { status: number; text: string }) => {
    h.answer = (call) => (call.url.includes(match) ? answer : healthy(call))
    return runChannelContracts()
  }
  it('eBay inventory: inventoryItems renamed while total/size remain FAILS; an empty list FAILS; an item without sku FAILS', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    const renamed = await run('inventory_item', { status: 200, text: JSON.stringify({ total: 1, size: 1, items: INVENTORY.inventoryItems }) })
    expect(byName(renamed, 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('inventoryItems') })
    const empty = await run('inventory_item', { status: 200, text: JSON.stringify({ total: 0, size: 0, inventoryItems: [] }) })
    expect(byName(empty, 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('no inventory item') })
    const noSku = await run('inventory_item', { status: 200, text: JSON.stringify({ total: 1, size: 1, inventoryItems: [{ SKU: 'x', product: {} }] }) })
    expect(byName(noSku, 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('sku') })
    const ok = await run('inventory_item', { status: 200, text: JSON.stringify(INVENTORY) })
    expect(byName(ok, 'ebay.getInventoryItems')).toMatchObject({ status: 'passed' })
  })
  it('Amazon participations: {payload: []} FAILS; a row without participation.isParticipating FAILS; the static example passes', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'amazon-sandbox')
    const empty = await run('marketplaceParticipations', { status: 200, text: JSON.stringify({ payload: [] }) })
    expect(byName(empty, 'amazon.getMarketplaceParticipations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('no participation') })
    const renamed = await run('marketplaceParticipations', { status: 200, text: JSON.stringify({ payload: [{ ...PARTICIPATION, participation: { participating: true, hasSuspendedListings: false } }] }) })
    expect(byName(renamed, 'amazon.getMarketplaceParticipations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('isParticipating') })
    const noMarket = await run('marketplaceParticipations', { status: 200, text: JSON.stringify({ payload: [{ ...PARTICIPATION, marketplace: { countryCode: 'US' } }] }) })
    expect(byName(noMarket, 'amazon.getMarketplaceParticipations')).toMatchObject({ status: 'failed', detail: expect.stringContaining('marketplace.id') })
    const ok = await run('marketplaceParticipations', { status: 200, text: JSON.stringify({ payload: [PARTICIPATION] }) })
    expect(byName(ok, 'amazon.getMarketplaceParticipations')).toMatchObject({ status: 'passed' })
  })
  it('Amazon Ads profiles: [] FAILS; a renamed profileId FAILS; a profile without accountInfo.marketplaceStringId FAILS', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
    const empty = await run('/v2/profiles', { status: 200, text: '[]' })
    expect(byName(empty, 'ads.listProfiles')).toMatchObject({ status: 'failed', detail: expect.stringContaining('no profile') })
    const { profileId, ...withoutId } = PROFILE
    const renamed = await run('/v2/profiles', { status: 200, text: JSON.stringify([{ ...withoutId, id: profileId }]) })
    expect(byName(renamed, 'ads.listProfiles')).toMatchObject({ status: 'failed', detail: expect.stringContaining('profileId') })
    const noMarket = await run('/v2/profiles', { status: 200, text: JSON.stringify([{ ...PROFILE, accountInfo: { id: 'A', type: 'seller' } }]) })
    expect(byName(noMarket, 'ads.listProfiles')).toMatchObject({ status: 'failed', detail: expect.stringContaining('marketplaceStringId') })
    const ok = await run('/v2/profiles', { status: 200, text: JSON.stringify([PROFILE]) })
    expect(byName(ok, 'ads.listProfiles')).toMatchObject({ status: 'passed' })
  })
  it('eBay GetItem: a <Variations> block whose variations no longer read (SKU renamed) FAILS instead of falling back to the item quantity', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox'); namedFixtures()
    const variation = (sku: string) => `<Variation>${sku}<Quantity>4</Quantity><SellingStatus><QuantitySold>1</QuantitySold></SellingStatus></Variation>`
    const item = (variations: string) => ({ status: 200, text: `<GetItemResponse><Ack>Success</Ack><Item><Quantity>9</Quantity><SellingStatus><QuantitySold>2</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus><Variations>${variations}</Variations></Item></GetItemResponse>` })
    const answerGetItem = async (answer: { status: number; text: string }) => {
      h.answer = (call) => (tradingCall(call) === 'GetItem' ? answer : healthy(call))
      return byName(await runChannelContracts(), 'ebay.getItem')
    }
    expect(await answerGetItem(item(variation('<SellerSKU>A</SellerSKU>')))).toMatchObject({ status: 'failed', detail: expect.stringContaining('Variation') })
    expect(await answerGetItem(item(variation('<SKU>A</SKU>') + variation('<SellerSKU>B</SellerSKU>')))).toMatchObject({ status: 'failed', detail: expect.stringContaining('1 of 2') })
    expect(await answerGetItem(item(variation('<SKU>A</SKU>') + variation('<SKU>B</SKU>')))).toMatchObject({ status: 'passed' })
  })
})

describe('review 2026-09-23 — Amazon Ads carries its app client id; Trading calls tell the gateway how to read an Ack', () => {
  it('the Ads call sends Amazon-Advertising-API-ClientId from the app of the named account\'s environment', async () => {
    h.accounts['ads-test'] = { environment: 'sandbox' }
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
    await runChannelContracts()
    const ads = h.calls.find((call) => call.channel === 'AMAZON_ADS')!
    expect(ads.headers['Amazon-Advertising-API-ClientId']).toBe('client-AMAZON_ADS-sandbox')
    expect(h.apps).toEqual([{ key: 'AMAZON_ADS', environment: 'sandbox' }])
    expect(JSON.stringify(ads.headers)).not.toContain('app-secret-never-sent')
  })
  it('no Ads app for that environment: the Ads check FAILS and nothing is sent', async () => {
    h.appFails = true
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
    const summary = await runChannelContracts()
    expect(byName(summary, 'ads.listProfiles')).toMatchObject({ status: 'failed', detail: expect.stringContaining('client id') })
    expect(h.calls.filter((call) => call.channel === 'AMAZON_ADS')).toEqual([])
  })
  it('Trading contract calls pass tradingAnswerOk, so the ledger records <Ack>Failure</Ack> as a failure; other checks do not', async () => {
    configureEveryAccount(); namedFixtures()
    await runChannelContracts()
    for (const call of h.calls) {
      if (call.url.includes('/ws/api.dll')) expect(call.answerOk, call.operation).toBe(tradingAnswerOk)
      else expect(call.answerOk, call.operation).toBeUndefined()
    }
    expect(tradingAnswerOk(VERIFY_VALIDATION)).toBe(false)
  })
  it('the Amazon operations proven only by Amazon\'s static sandbox example say so in their label', () => {
    const label = (id: string) => REQUIRED_OPERATIONS.AMAZON_SP!.find((op) => op.id === id)!.label
    expect(label('amazon.finances.listTransactions')).toMatch(/static sandbox example/)
    expect(label('amazon.sellers.getMarketplaceParticipations')).toMatch(/static sandbox example/)
    expect(label('amazon.listings.getListingsItem')).toMatch(/static sandbox example/)
  })
})

describe('the cron record', () => {
  it('a RED run fails the cron row with its sentence; a run with nothing configured completes it saying so', async () => {
    configureEveryAccount()
    h.answer = (call) => (call.url.includes('/ws/api.dll') ? { status: 200, text: verifyError('931', 'Auth token is invalid.') } : healthy(call))
    const red = await runChannelContractsOnce('manual')
    expect(red.status).toBe('red')
    expect(h.cron.at(-1)).toMatchObject({ ok: false, value: expect.stringContaining('ebay.verifyAddFixedPriceItem') })
    vi.unstubAllEnvs()
    for (const key of ENV) vi.stubEnv(key, '')
    h.answer = healthy
    const none = await runChannelContractsOnce('manual')
    expect(none.status).toBe('not-configured')
    expect(h.cron.at(-1)).toMatchObject({ ok: true, value: { cronStatus: 'NOT_CONFIGURED', summary: expect.stringMatching(/^0\/9 required operations proven — No channel contract check could run/) } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Review 2026-09-26 (Owner-approved rework): a channel with no sandbox is NOT APPLICABLE — out of the verdict,
// its reason stated — and the Amazon static-sandbox checks are sign-in and reachability checks, nothing more.
// ─────────────────────────────────────────────────────────────────────────────

describe('review 2026-09-26 — a channel with no sandbox is not applicable, so the run CAN be green', () => {
  const na = (channel: string, covers: string) => ({ ...result(channel, covers, 'not-applicable'), detail: 'Etsy has no sandbox (stood-in reason)' })
  it('every applicable operation passed, Etsy not applicable → GREEN; Etsy is out of the counts and its reason is stated', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed'), na('ETSY', 't.shop')], PLAN)
    expect(summary.status).toBe('green')
    expect(summary.channels.map((c) => [c.channel, c.status])).toEqual([['EBAY', 'covered'], ['ETSY', 'not-applicable']])
    expect(summary).toMatchObject({ required: 2, proven: 2, notApplicable: 1, gaps: [] })
    expect(summary.sentence).toMatch(/^2\/2 required operations proven — Green on EBAY\./)
    expect(summary.sentence).toMatch(/Not applicable \(excluded from the verdict\): ETSY — Etsy has no sandbox \(stood-in reason\)/)
  })
  it('not applicable never lifts NOT CONFIGURED: an applicable operation unproven keeps the run partial', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'not-configured'), na('ETSY', 't.shop')], PLAN)
    expect(summary.status).toBe('partial')
    expect(summary).toMatchObject({ required: 2, proven: 1 })
    expect(summary.sentence).toMatch(/^1\/2 required operations proven — Partial, not green\./)
    expect(summary.sentence).toMatch(/Not applicable \(excluded from the verdict\): ETSY/)
  })
  it('not applicable never lifts a FAILURE: an applicable failure is red', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'failed'), na('ETSY', 't.shop')], PLAN)
    expect(summary.status).toBe('red')
  })
  it('a failed result on the not-applicable channel itself is still RED and the channel is failed, not excluded', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed'), na('ETSY', 't.shop'), result('ETSY', 't.shop', 'failed', 'etsy.live')], PLAN)
    expect(summary.channels.find((c) => c.channel === 'ETSY')?.status).toBe('failed')
    expect(summary.status).toBe('red')
  })
  it('an operation that is both not configured and marked not applicable counts as NOT CONFIGURED: never excluded', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed'), na('ETSY', 't.shop'), result('ETSY', 't.shop', 'not-configured', 'etsy.check')], PLAN)
    expect(summary.channels.find((c) => c.channel === 'ETSY')).toMatchObject({ status: 'not-configured' })
    expect(summary.status).toBe('partial')
    expect(summary).toMatchObject({ required: 3, proven: 2 })
  })
  it('only not-applicable channels, or nothing passed beside one: NOT-CONFIGURED, never green', () => {
    expect(summarizeContractRun([na('ETSY', 't.shop')], { ETSY: PLAN.ETSY }).status).toBe('not-configured')
    const none = summarizeContractRun([result('EBAY', 'e.inventory', 'not-configured'), result('EBAY', 'e.offer', 'not-configured'), na('ETSY', 't.shop')], PLAN)
    expect(none.status).toBe('not-configured')
    expect(none.sentence).toMatch(/^0\/2 required operations proven — No channel contract check could run\./)
  })
  it('today\'s list: every account and fixture named, every answer healthy → GREEN 9/9, Etsy stated, cron row SUCCESS', async () => {
    configureEveryAccount(); namedFixtures()
    for (const [key, value] of Object.entries({ NEXUS_CONTRACT_AMAZON_SELLER_ID: 'AXXXXXXXXXXXX', NEXUS_CONTRACT_AMAZON_SANDBOX_SKU: 'GM-ZDPI-9B4E', NEXUS_CONTRACT_EBAY_SANDBOX_TOPIC_ID: 'AUTHORIZATION_REVOCATION', NEXUS_CONTRACT_EBAY_SANDBOX_DESTINATION_ID: 'fixture-destination', NEXUS_CONTRACT_EBAY_SANDBOX_SUBSCRIPTION_ID: 'fixture-subscription' })) vi.stubEnv(key, value)
    const summary = await runChannelContractsOnce('manual')
    expect(summary.results.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.detail}`)).toEqual([])
    expect(summary).toMatchObject({ status: 'green', required: 9, proven: 9, notApplicable: 2, gaps: [] })
    expect(Object.fromEntries(summary.channels.map((c) => [c.channel, c.status]))).toEqual({ EBAY: 'covered', AMAZON_SP: 'covered', AMAZON_ADS: 'covered', ETSY: 'not-applicable' })
    expect(summary.sentence).toMatch(/^9\/9 required operations proven — Green on EBAY, AMAZON_SP, AMAZON_ADS\./)
    expect(summary.sentence).toMatch(/Not applicable \(excluded from the verdict\): ETSY — Etsy has no sandbox/)
    // Green does not overclaim: the Amazon SP part is sign-in and reachability only.
    expect(summary.sentence).toMatch(/AMAZON_SP: sign-in and reachability only/)
    expect(h.cron.at(-1)).toEqual({ ok: true, value: { summary: summary.sentence, cronStatus: 'SUCCESS' } })
    expect(h.calls.filter((call) => call.channel === 'ETSY')).toEqual([])
  })
  it('a channel that requires nothing is never excluded as not applicable nor covered: the run stays partial', () => {
    const summary = summarizeContractRun([result('EBAY', 'e.inventory', 'passed'), result('EBAY', 'e.offer', 'passed')], { EBAY: PLAN.EBAY, ETSY: [] })
    expect(summary.channels.find((c) => c.channel === 'ETSY')?.status).toBe('not-configured')
    expect(summary.status).toBe('partial')
  })
  it('the not-applicable list is Etsy only, each with a reason that says why no check can run', () => {
    expect(NOT_APPLICABLE_CHANNELS.map((c) => c.channel)).toEqual(['ETSY'])
    for (const { reason } of NOT_APPLICABLE_CHANNELS) expect(reason).toMatch(/no sandbox/)
  })
})

describe('review 2026-09-26 — the Amazon static-sandbox checks are sign-in and reachability checks', () => {
  const amazonSp = CHANNEL_CONTRACTS.filter((c) => c.channel === 'AMAZON_SP')
  it('every Amazon SP required operation is marked and labelled sign-in and reachability; no other channel is', () => {
    expect(REQUIRED_OPERATIONS.AMAZON_SP!.length).toBe(3)
    for (const op of REQUIRED_OPERATIONS.AMAZON_SP!) {
      expect(op.proves, op.id).toBe('sign-in and reachability')
      expect(op.label, op.id).toMatch(/sign-in and reachability/)
      expect(op.label, op.id).not.toMatch(/contract/i)
    }
    for (const [channel, ops] of Object.entries(REQUIRED_OPERATIONS)) {
      if (channel === 'AMAZON_SP') continue
      for (const op of ops!) expect(op.proves, op.id).toBeUndefined()
    }
  })
  it('coordinator 2026-09-26 — the Amazon Ads check stays a contract check and its label says exactly what it proves', () => {
    const ads = REQUIRED_OPERATIONS.AMAZON_ADS!.find((op) => op.id === 'ads.profiles.list')!
    expect(ads.proves).toBeUndefined()
    expect(ads.label).toBe('Amazon Ads profiles read — the profile fields Nexus reads, from the Ads test account')
  })
  it('no Amazon SP failure sentence claims a vendor contract change, and each names the static sandbox example', () => {
    expect(amazonSp.map((c) => c.name).sort()).toEqual(['amazon.getListingsItem', 'amazon.getMarketplaceParticipations', 'amazon.listTransactions'])
    const ctx = { accountId: 'a', fixture: { NEXUS_CONTRACT_AMAZON_SELLER_ID: 'AXXXXXXXXXXXX', NEXUS_CONTRACT_AMAZON_SANDBOX_SKU: 'GM-ZDPI-9B4E' } }
    const answers: Array<{ status: number; body: unknown }> = [
      { status: 500, body: null }, { status: 200, body: {} }, { status: 200, body: { payload: [] } }, { status: 200, body: { payload: { transactions: [] } } },
      { status: 200, body: { payload: [{ marketplace: { countryCode: 'US' } }] } }, { status: 200, body: { payload: { transactions: [{ transactionType: 1 }] } } },
      { status: 200, body: { ...listingExample, summaries: [] } }, { status: 200, body: { ...listingExample, issues: [] } }, { status: 200, body: { ...listingExample, offers: [] } },
      { status: 200, body: { ...listingExample, fulfillmentAvailability: [] } }, { status: 200, body: { ...listingExample, sku: 'other' } },
    ]
    let failures = 0
    for (const check of amazonSp) {
      for (const { status, body } of answers) {
        const detail = check.assert({ status, text: JSON.stringify(body), json: () => body as never }, ctx)
        if (detail === null) continue
        failures += 1
        expect(detail, `${check.name}: ${detail}`).not.toMatch(/contract/i)
        expect(detail, `${check.name}: ${detail}`).toMatch(/static sandbox|static-sandbox/)
      }
    }
    // Positive control: the answers above do fail the checks, so the sentences were really read.
    expect(failures).toBeGreaterThanOrEqual(amazonSp.length * 5)
  })
})
