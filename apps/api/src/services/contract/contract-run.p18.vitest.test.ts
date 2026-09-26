/**
 * P1.8 — the nightly contract run. What matters is what it CANNOT do: it never writes, it never leaves a
 * sandbox host, and it never reports green when nothing could run. The gateway is stood in and records
 * every call it was asked to make.
 *
 * P1.8 completion (2026-09-23) — an INTENDED behaviour change pinned here: with every account named and every
 * check healthy the run is now PARTIAL, not green, because required operations stay unproven (Etsy has no
 * sandbox; eBay notification reads and Amazon getListingsItem have no check; the offer / GetItem fixtures are
 * unnamed). The coverage rules themselves are pinned in contract-coverage.p18.vitest.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ channel: string; kind: string; url: string; method: string; connectionId: string | null; operation: string; headers: Record<string, string> }>,
  answer: (_url: string, _headers: Record<string, string>) => ({ status: 200, text: '', body: null as unknown }),
  throwFor: null as string | null,
}))
vi.mock('../gateway/gateway.js', async (original) => ({
  ...(await original<object>()),
  gatewayCall: vi.fn(async (request: any) => {
    h.calls.push({ channel: request.channel, kind: request.kind, url: request.url, method: request.method, connectionId: request.connectionId, operation: request.operation, headers: request.headers ?? {} })
    if (h.throwFor && request.operation.includes(h.throwFor)) throw new Error('the account needs to be reconnected')
    const answer = h.answer(request.url, request.headers ?? {})
    return { outcome: 'sent', ok: true, status: answer.status, text: answer.text, url: request.url, attempts: 1, verdict: null, rate: { remaining: null, limit: null }, json: () => answer.body }
  }),
}))
// eBay Trading checks carry the account's token in their own header.
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async (connectionId: string) => `token-of-${connectionId}`) }))
// The named accounts: eBay's is a sandbox account (the run refuses any other); Ads reads its app client id.
vi.mock('../../db.js', () => ({ default: { channelConnection: {
  findUnique: vi.fn(async ({ where }: any) => ({ connectionMetadata: { environment: String(where.id).includes('sandbox') ? 'sandbox' : 'production' } })),
} } }))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async (key: string, environment: string) => ({ clientId: `client-${key}-${environment}` })) }))

import { runChannelContracts, contractAccountOf, isContractRunEnabled } from './contract-run.service.js'

/** What each channel answers when its contract still holds — never an empty list, which proves no field. */
const PROFILE = { profileId: 1000000000000001, countryCode: 'IT', currencyCode: 'EUR', timezone: 'Europe/Rome', accountInfo: { marketplaceStringId: 'APJ6JRA9NG5V4', id: 'A2EXAMPLESELLER', type: 'seller', name: 'Test' } }
const PARTICIPATION = { marketplace: { id: 'ATVPDKIKX0DER', countryCode: 'US', name: 'Amazon.com' }, participation: { isParticipating: true, hasSuspendedListings: false } }
const healthy = (url: string, _headers: Record<string, string> = {}) => url.includes('api.dll')
  ? { status: 200, text: '<Ack>Success</Ack><Fees/>', body: null as unknown }
  : url.includes('/v2/profiles') ? { status: 200, text: '[]', body: [PROFILE] as unknown }
  : url.includes('marketplaceParticipations') ? { status: 200, text: '{}', body: { payload: [PARTICIPATION] } as unknown }
  // Amazon's static-sandbox example for listTransactions (finances_2024-06-19.json).
  : url.includes('/finances/2024-06-19/transactions') ? { status: 200, text: '{}', body: { payload: { transactions: [{ transactionType: 'Shipment', postedDate: '2020-07-14T03:35:13.214Z', totalAmount: { currencyAmount: 10, currencyCode: 'USD' } }] } } as unknown }
  : { status: 200, text: '{}', body: { total: 1, size: 1, inventoryItems: [{ sku: 'NX-CONTRACT-01', product: { title: 'Nexus contract item' } }] } as unknown }

const configureEveryChannel = () => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'amazon-sandbox')
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
}

beforeEach(() => {
  h.calls = []; h.throwFor = null
  h.answer = healthy
  for (const key of ['NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', 'NEXUS_CONTRACT_ACCOUNT_EBAY', 'NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'NEXUS_CONTRACT_ACCOUNT_SHOPIFY', 'NEXUS_CONTRACT_ACCOUNT_ETSY']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

describe('P1.8 — what the contract run cannot do', () => {
  it('DONE-WHEN: every call is a read, on a sandbox host, as the named sandbox account', async () => {
    configureEveryChannel()
    const summary = await runChannelContracts()
    expect(h.calls.length).toBeGreaterThan(0)
    for (const call of h.calls) {
      expect(call.kind).toBe('read')
      expect(new URL(call.url).hostname).toMatch(/sandbox|-test\./)
      expect(call.operation.startsWith('contract.')).toBe(true)
    }
    expect(h.calls.map((c) => c.connectionId)).toEqual(h.calls.map((c) => (c.channel === 'EBAY' ? 'ebay-sandbox' : c.channel === 'AMAZON_SP' ? 'amazon-sandbox' : 'ads-test')))
    expect(summary.results.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.detail}`)).toEqual([])
    // Intended change (P1.8 completion): healthy is not the same as covered — this run is PARTIAL, not green.
    expect(summary.status).toBe('partial')
    expect(summary.failed).toBe(0)
  })
  it('no account named for a channel: that channel is NOT CONFIGURED and nothing is sent for it', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    const summary = await runChannelContracts()
    expect(h.calls.every((call) => call.channel === 'EBAY')).toBe(true)
    expect(summary.results.filter((r) => r.channel === 'AMAZON_SP').every((r) => r.status === 'not-configured')).toBe(true)
    expect(summary.results.find((r) => r.channel === 'AMAZON_SP')?.detail).toMatch(/NEXUS_CONTRACT_ACCOUNT_AMAZON_SP/)
  })
  it('nothing configured at all: not-configured, never green, and no call', async () => {
    const summary = await runChannelContracts()
    expect(h.calls).toHaveLength(0)
    expect(summary.status).toBe('not-configured')
    expect(summary.passed).toBe(0)
    expect(summary.sentence).toMatch(/No channel contract check could run/)
  })
  it('Shopify and Etsy are reported with their reason, not silently missing', async () => {
    const summary = await runChannelContracts()
    const shopify = summary.results.find((r) => r.channel === 'SHOPIFY')
    const etsy = summary.results.find((r) => r.channel === 'ETSY')
    expect(shopify).toMatchObject({ status: 'not-configured', detail: expect.stringContaining('development-store') })
    // Intended change (P1.8 completion): Etsy has no sandbox at all — not "not configured".
    // Review 2026-09-26: "not applicable" (excluded from the verdict, reason stated), was "unsupported".
    expect(etsy).toMatchObject({ status: 'not-applicable', detail: expect.stringContaining('no sandbox') })
  })
})

describe('P1.8 — a channel change turns it red', () => {
  it('a renamed field in the answer fails the check and the whole run', async () => {
    configureEveryChannel()
    // eBay renamed inventoryItems → items and nothing else: total / size still arrive (review 2026-09-23 —
    // the first version of this fixture also dropped them, so it passed for the wrong reason).
    h.answer = (url, headers) => url.includes('inventory_item')
      ? { status: 200, text: '{}', body: { total: 1, size: 1, items: [{ sku: 'NX-CONTRACT-01', product: { title: 'Nexus contract item' } }] } }
      : healthy(url, headers)
    const summary = await runChannelContracts()
    expect(summary.status).toBe('red')
    expect(summary.results.find((r) => r.name === 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('inventoryItems') })
    expect(summary.sentence).toMatch(/ebay.getInventoryItems/)
  })
  it('an HTTP error fails the check with the status', async () => {
    configureEveryChannel()
    h.answer = () => ({ status: 503, text: '', body: null })
    const summary = await runChannelContracts()
    expect(summary.status).toBe('red')
    expect(summary.results.filter((r) => r.status === 'failed').length).toBeGreaterThan(2)
    expect(summary.results.find((r) => r.status === 'failed')?.detail).toMatch(/503/)
  })
  it('the gateway itself refuses (account needs sign-in): a failed check, never a quiet pass', async () => {
    configureEveryChannel()
    h.throwFor = 'ebay.getInventoryItems'
    const summary = await runChannelContracts()
    expect(summary.status).toBe('red')
    expect(summary.results.find((r) => r.name === 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reconnected') })
  })
  it('an eBay dry-run answer with no Ack is a contract change', async () => {
    configureEveryChannel()
    h.answer = (url, headers) => url.includes('api.dll')
      ? { status: 200, text: '<VerifyAddFixedPriceItemResponse/>', body: null }
      : healthy(url, headers)
    const summary = await runChannelContracts()
    expect(summary.results.find((r) => r.name === 'ebay.verifyAddFixedPriceItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('<Ack>') })
  })
})

describe('P1.8 — the switch', () => {
  it('is off unless the Owner turns it on', () => {
    expect(isContractRunEnabled()).toBe(false)
    vi.stubEnv('NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', 'true')
    expect(isContractRunEnabled()).toBe(true)
  })
  it('reads one account per channel', () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', ' ebay-sandbox ')
    expect(contractAccountOf('EBAY')).toBe('ebay-sandbox')
    expect(contractAccountOf('SHOPIFY')).toBeNull()
  })
})
