/**
 * P1.7 — every eBay Add goes through eBay's own dry run first. `VerifyAddFixedPriceItem` carries the
 * same XML; eBay answers with the errors the real Add would raise and creates nothing. Success or
 * Warning proceeds, anything else refuses before the Add. `fetch` records the call names that left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[], verifyAck: 'Success', verifyBody: '' }))
// P1.2 — the eBay sends go through the channel gateway; its account check and ledger are stood in.
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'OAUTH') } }))

import { addFixedPriceItem } from './ebay-trading-api.service.js'

const input = {
  title: 'X', description: 'x', categoryId: '1', conditionId: '1000', country: 'IT', currency: 'EUR',
  variationSpecificNames: ['Size'], variations: [{ sku: 'A-M', price: 9.9, quantity: 1, specifics: { Size: 'M' } }],
} as never
const ctx = { oauthToken: 'OAUTH', market: 'IT', connectionId: 'conn-1' }
const answer = (name: string) => {
  if (name === 'VerifyAddFixedPriceItem') {
    if (h.verifyBody === ' ') return ''
    return h.verifyBody || `<R><Ack>${h.verifyAck}</Ack>${h.verifyAck === 'Warning' ? '<Errors><LongMessage>Category will change.</LongMessage></Errors>' : ''}</R>`
  }
  return '<R><Ack>Success</Ack><ItemID>110012345678</ItemID></R>'
}

beforeEach(() => {
  h.calls = []; h.verifyAck = 'Success'; h.verifyBody = ''
  vi.stubEnv('NEXUS_EBAY_REAL_API', 'true'); vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live'); vi.stubEnv('EBAY_SANDBOX', '')
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const name = String(init.headers['X-EBAY-API-CALL-NAME'])
    h.calls.push(name)
    return new Response(answer(name), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P1.7 — verify before add', () => {
  it('DONE-WHEN: the Verify goes first with the same item XML, then the Add', async () => {
    expect(await addFixedPriceItem(input, ctx)).toEqual({ itemId: '110012345678' })
    expect(h.calls).toEqual(['VerifyAddFixedPriceItem', 'AddFixedPriceItem'])
    const [verify, add] = (fetch as unknown as { mock: { calls: any[][] } }).mock.calls
    expect(String(verify[1].body)).toContain('<VerifyAddFixedPriceItemRequest')
    expect(String(add[1].body)).toContain('<AddFixedPriceItemRequest')
    // the same listing, not a second build: the item body is identical apart from the request tag
    expect(String(verify[1].body).replace(/VerifyAddFixedPriceItemRequest/g, 'AddFixedPriceItemRequest'))
      .toBe(String(add[1].body))
  })
  it('eBay refuses the dry run: nothing is added', async () => {
    h.verifyBody = '<R><Ack>Failure</Ack><Errors><ErrorCode>10007</ErrorCode><LongMessage>Item specific Size is missing.</LongMessage></Errors></R>'
    await expect(addFixedPriceItem(input, ctx)).rejects.toThrow(/Item specific Size is missing|did not validate/)
    expect(h.calls).toEqual(['VerifyAddFixedPriceItem'])
  })
  it('a Warning is not a refusal: the Add still goes out', async () => {
    h.verifyAck = 'Warning'
    expect(await addFixedPriceItem(input, ctx)).toEqual({ itemId: '110012345678' })
    expect(h.calls).toEqual(['VerifyAddFixedPriceItem', 'AddFixedPriceItem'])
  })
  it('an unreadable answer to the dry run: nothing is added', async () => {
    h.verifyBody = '<R><Ack>Unknown</Ack></R>'
    await expect(addFixedPriceItem(input, ctx)).rejects.toMatchObject({ notSent: true })
    expect(h.calls).toEqual(['VerifyAddFixedPriceItem'])
  })
  it('a REAL but empty answer is not a rehearsal: nothing is added', async () => {
    h.verifyBody = ' '
    await expect(addFixedPriceItem(input, ctx)).rejects.toMatchObject({ notSent: true })
    expect(h.calls).toEqual(['VerifyAddFixedPriceItem'])
  })
  it('a local rehearsal (real API off) sends nothing at all', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'false')
    expect((await addFixedPriceItem(input, ctx)).itemId).toMatch(/^DRYRUN-/)
    expect(h.calls).toEqual([])
  })
})
