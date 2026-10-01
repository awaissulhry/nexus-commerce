import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Audit P2/P3 (2026-10-01) — reading an eBay account keeps its item location (country, postal code, city) and which
 * policies each market has, on the account, so a dry-run review and readiness know them without asking eBay. The account
 * service, its fetch parsing and the writer are REAL; eBay's answers (a stubbed `fetch`) and the database row are a fixture.
 */
const m = vi.hoisted(() => ({ row: null as null | { connectionMetadata: unknown; updatedAt: Date }, updates: [] as any[] }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'fixture-token' } }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordApiCall: async (_meta: unknown, request: () => Promise<unknown>) => request() }))
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((s) => s.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((s) => s.ledgerModule))
vi.mock('../db.js', () => ({ default: { channelConnection: {
  findUnique: async () => m.row,
  updateMany: async (input: any) => { m.updates.push(input); if (m.row) m.row = { connectionMetadata: input.data.connectionMetadata, updatedAt: new Date() }; return { count: 1 } },
} } }))

import { EbayAccountService } from './ebay-account.service.js'
import { ebayLocationKnownMissing, ebayMarketplaceId, ebayPolicyKnownMissing, rememberEbayAccountRead, resolveEbayItemLocation, usableEbayLocation } from './ebay-account-defaults.js'

const LOCATIONS = { locations: [
  { merchantLocationKey: 'old', name: 'Old store', merchantLocationStatus: 'DISABLED', location: { address: { country: 'IT', postalCode: '00100', city: 'Roma' } } },
  { merchantLocationKey: 'warehouse', name: 'Magazzino', merchantLocationStatus: 'ENABLED', location: { address: { country: 'IT', postalCode: '47822', city: 'Santarcangelo di Romagna' } } },
] }
const fetcher = vi.fn()
const answer = (url: string, policies: Record<string, unknown[]> = {}) => {
  const kind = url.includes('fulfillment_policy') ? 'fulfillment' : url.includes('payment_policy') ? 'payment' : url.includes('return_policy') ? 'return' : null
  return new Response(JSON.stringify(kind ? { [`${kind}Policies`]: policies[kind] ?? [{ [`${kind}PolicyId`]: `${kind}-1`, name: kind, marketplaceId: 'EBAY_IT' }] } : LOCATIONS))
}
beforeEach(() => {
  m.row = { connectionMetadata: { environment: 'production', ebayPolicies: { paymentPolicyId: 'pay' } }, updatedAt: new Date('2026-10-01T10:00:00Z') }
  m.updates = []
  fetcher.mockReset().mockImplementation(async (url: string) => answer(url))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => vi.unstubAllGlobals())

describe('reading the account keeps its location and policy facts', () => {
  it('keeps the first enabled location with its postal code and city, and which policies this market has', async () => {
    await new EbayAccountService().getSnapshot('acc', 'EBAY_IT')
    expect(m.updates).toHaveLength(1)
    expect(m.updates[0].where).toEqual({ id: 'acc', updatedAt: new Date('2026-10-01T10:00:00Z') })
    const metadata = m.updates[0].data.connectionMetadata
    // Everything else on the account is kept as it was.
    expect(metadata).toMatchObject({ environment: 'production', ebayPolicies: { paymentPolicyId: 'pay' } })
    expect(metadata.itemLocation).toMatchObject({ country: 'IT', postalCode: '47822', city: 'Santarcangelo di Romagna', locationKey: 'warehouse', source: 'ebay' })
    expect(metadata.ebayAccountRead.locations).toMatchObject({ found: true })
    expect(metadata.ebayAccountRead.policies.EBAY_IT).toMatchObject({ shipping: true, payment: true, return: true })
  })
  it('a second identical read writes nothing', async () => {
    await new EbayAccountService().getSnapshot('acc', 'EBAY_IT')
    await new EbayAccountService().getSnapshot('acc', 'EBAY_IT')
    expect(m.updates).toHaveLength(1)
  })
  it('a list eBay did not answer is not recorded as empty', async () => {
    fetcher.mockImplementation(async (url: string) => url.includes('return_policy') ? new Response('Provider error', { status: 503 }) : answer(url))
    await new EbayAccountService().getSnapshot('acc', 'EBAY_IT')
    const facts = m.updates[0].data.connectionMetadata.ebayAccountRead.policies.EBAY_IT
    expect(facts).toMatchObject({ shipping: true, payment: true })
    expect('return' in facts).toBe(false)
    expect(ebayPolicyKnownMissing(m.row!.connectionMetadata, 'IT').return).toBeNull()
  })
  it('a market with no shipping policy is known as such', async () => {
    fetcher.mockImplementation(async (url: string) => answer(url, { fulfillment: [] }))
    await new EbayAccountService().getSnapshot('acc', 'EBAY_IT')
    expect(ebayPolicyKnownMissing(m.row!.connectionMetadata, 'IT')).toEqual({ shipping: true, payment: false, return: false })
    expect(ebayPolicyKnownMissing(m.row!.connectionMetadata, 'DE')).toEqual({ shipping: null, payment: null, return: null })
  })
  it('never replaces a location set by other means', async () => {
    m.row!.connectionMetadata = { itemLocation: { country: 'IT', city: 'Riccione' } }
    await new EbayAccountService().getSnapshot('acc', 'EBAY_IT')
    expect(m.updates[0].data.connectionMetadata.itemLocation).toEqual({ country: 'IT', city: 'Riccione' })
  })
})

describe('the account defaults, read back', () => {
  it('the first usable location is enabled and has a country with a postal code or city', () => {
    expect(usableEbayLocation([{ key: 'a', name: 'A', country: 'IT', enabled: true }, { key: 'b', name: 'B', country: 'it', city: 'Rimini' }]))
      .toEqual({ key: 'b', country: 'IT', postalCode: '', city: 'Rimini' })
    expect(usableEbayLocation([{ key: 'a', name: 'A', country: null, postalCode: '47822' }])).toBeNull()
  })
  it('a listing\'s own cells win, then the stored account location, then the server', () => {
    const stored = { itemLocation: { country: 'IT', postalCode: '47822', city: 'Santarcangelo' } }
    expect(resolveEbayItemLocation({ country: 'IT', postalCode: ' ', city: 'Riccione' }, stored, {})).toEqual({ country: 'IT', postalCode: '47822', city: 'Riccione' })
    expect(resolveEbayItemLocation({}, {}, { EBAY_ITEM_COUNTRY: 'DE', EBAY_ITEM_POSTAL_CODE: '10115' })).toEqual({ country: 'DE', postalCode: '10115', city: '' })
  })
  it('knows "no usable location" only after a read that found none', async () => {
    expect(ebayLocationKnownMissing({})).toBeNull()
    m.row = { connectionMetadata: {}, updatedAt: new Date() }
    await rememberEbayAccountRead('acc', 'EBAY_IT', { locations: [{ key: 'x', name: 'X', country: 'IT' }] })
    expect(ebayLocationKnownMissing(m.row.connectionMetadata)).toBe(true)
    expect((m.row.connectionMetadata as any).itemLocation).toBeUndefined()
  })
  it('names UK as eBay\'s GB site', () => {
    expect(ebayMarketplaceId('UK')).toBe('EBAY_GB')
    expect(ebayMarketplaceId('it')).toBe('EBAY_IT')
  })
})
