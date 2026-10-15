/**
 * Google Ads programme 2, G12 (2026-10-16) — the Merchant Center changes the gateway lets through: exactly the methods,
 * paths, queries and bodies the Merchant tools send, each a write (the Merchant API has no check), for a Merchant Center
 * account the business chose through this connection only — reads that name an account too. Everything else stays
 * refused before anything is sent, with its ledger row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayLedger, gatewayMerchantUnlinked } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { googleCall, googleKind } from './google.js'
import { attributeProblem, googleMerchantCall, googleMerchantCallBodyOf, MERCHANT_CALL_KINDS, merchantReadAccount } from './google-merchant-calls.js'

const API = 'https://merchantapi.googleapis.com'
const INSERT = `${API}/products/v1/accounts/555/productInputs:insert?dataSource=${encodeURIComponent('accounts/555/dataSources/71')}`
const DELETE_INPUT = `${API}/products/v1/accounts/555/productInputs/aXR-SVQtU0tVLUE?dataSource=accounts/555/dataSources/71`
const CREATE = `${API}/datasources/v1/accounts/555/dataSources`
const RENAME = `${API}/datasources/v1/accounts/555/dataSources/71?updateMask=displayName`
const FETCH = `${API}/datasources/v1/accounts/555/dataSources/81:fetch`
const PROMOTION = `${API}/promotions/v1/accounts/555/promotions:insert`
const INPUT = { offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', productAttributes: { customLabel0: 'top', pause: 'ADS', gtins: ['1234567890128'] } }
const PROMO = {
  dataSource: 'accounts/555/dataSources/72',
  promotion: {
    promotionId: 'PROMO-A', contentLanguage: 'it', targetCountry: 'IT', redemptionChannel: ['ONLINE'],
    attributes: {
      longTitle: 'Ten off', couponValueType: 'PERCENT_OFF', percentOff: '10', offerType: 'NO_CODE', productApplicability: 'ALL_PRODUCTS',
      promotionEffectiveTimePeriod: { startTime: '2026-11-01T00:00:00Z', endTime: '2026-11-08T00:00:00Z' }, promotionDestinations: ['SHOPPING_ADS', 'FREE_LISTINGS'],
    },
  },
}

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; gatewayLedger.length = 0; gatewayMerchantUnlinked.clear()
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('which Merchant calls are changes Nexus sends', () => {
  it('exactly these kinds (a new one is a new line here, on purpose)', () => {
    expect([...MERCHANT_CALL_KINDS].sort()).toEqual([
      'dataSources:create', 'dataSources:delete', 'dataSources:fetch', 'dataSources:patch', 'productInputs:delete', 'productInputs:insert', 'promotions:insert',
    ])
  })

  it('reads the account, the data source and the method from the exact path and query', () => {
    expect(googleMerchantCall('POST', INSERT)).toEqual({ kind: 'productInputs:insert', account: '555', dataSource: '71' })
    expect(googleMerchantCall('DELETE', DELETE_INPUT)).toEqual({ kind: 'productInputs:delete', account: '555', dataSource: '71', productInput: 'aXR-SVQtU0tVLUE' })
    expect(googleMerchantCall('POST', CREATE)).toEqual({ kind: 'dataSources:create', account: '555' })
    expect(googleMerchantCall('PATCH', RENAME)).toEqual({ kind: 'dataSources:patch', account: '555', dataSource: '71', updateMask: 'displayName' })
    expect(googleMerchantCall('DELETE', `${CREATE}/71`)).toEqual({ kind: 'dataSources:delete', account: '555', dataSource: '71' })
    expect(googleMerchantCall('POST', FETCH)).toEqual({ kind: 'dataSources:fetch', account: '555', dataSource: '81' })
    expect(googleMerchantCall('POST', PROMOTION)).toEqual({ kind: 'promotions:insert', account: '555' })
  })

  it('anything broader is not one: another account in the query, another field, another method, another sub-API or version', () => {
    for (const [method, url] of [
      ['POST', `${API}/products/v1/accounts/555/productInputs:insert?dataSource=accounts/556/dataSources/71`],
      ['POST', `${API}/products/v1/accounts/555/productInputs:insert`],
      ['POST', `${INSERT}&x=1`],
      ['PATCH', `${API}/products/v1/accounts/555/productInputs/aXR-SVQtU0tVLUE?dataSource=accounts/555/dataSources/71`],
      ['PATCH', `${API}/datasources/v1/accounts/555/dataSources/71?updateMask=primaryProductDataSource.defaultRule`],
      ['PATCH', `${API}/datasources/v1/accounts/555/dataSources/71`],
      ['POST', `${API}/products/v1beta/accounts/555/productInputs:insert?dataSource=accounts/555/dataSources/71`],
      ['POST', `${API}/inventories/v1/accounts/555/products/aXR-SVQtU0tVLUE/localInventories:insert`],
      ['DELETE', `${API}/promotions/v1/accounts/555/promotions/PROMO-A`],
      ['POST', `${API}/accounts/v1/accounts/555/developerRegistration:registerGcp`],
      ['POST', `https://example.com/products/v1/accounts/555/productInputs:insert?dataSource=accounts/555/dataSources/71`],
    ] as const) expect(googleMerchantCall(method, url), `${method} ${url}`).toBeNull()
  })

  it('the account a Merchant read names (none for the account list discovery reads)', () => {
    expect(merchantReadAccount(`${API}/products/v1/accounts/555/products?pageSize=1000`)).toBe('555')
    expect(merchantReadAccount(`${API}/reports/v1/accounts/555/reports:search`)).toBe('555')
    expect(merchantReadAccount(`${API}/accounts/v1/accounts/555`)).toBe('555')
    expect(merchantReadAccount(`${API}/accounts/v1/accounts`)).toBeNull()
    expect(merchantReadAccount('https://googleads.googleapis.com/v25/customers/1/googleAds:search')).toBeNull()
  })
})

describe('the bodies the gateway lets through', () => {
  const judge = (method: string, url: string, body: unknown) => googleMerchantCallBodyOf(googleMerchantCall(method, url)!, body === undefined ? undefined : JSON.stringify(body))

  it('a product input of the attributes Nexus sends; price, availability, link and unknown fields are refused', () => {
    expect(judge('POST', INSERT, INPUT)).toEqual({ body: JSON.stringify(INPUT) })
    for (const [extra, why] of [
      [{ price: { amountMicros: '1000000', currencyCode: 'EUR' } }, /price is not an attribute/],
      [{ availability: 'IN_STOCK' }, /availability is not an attribute/],
      [{ link: 'https://shop.example/a' }, /link is not an attribute/],
      [{ title: 'x'.repeat(151) }, /title is not 1 to 150/],
      [{ gtins: ['12'] }, /GTINs of 8 to 14 digits/],
      [{ pause: 'SOME' }, /pause is not one of ADS, ALL/],
      [{ custom_label_0: 'x' }, /snake_case/],
    ] as const) {
      expect(judge('POST', INSERT, { ...INPUT, productAttributes: { ...INPUT.productAttributes, ...extra } })).toEqual({ refusal: expect.stringMatching(why) })
    }
    expect(judge('POST', INSERT, { ...INPUT, versionNumber: '3' })).toEqual({ refusal: 'the product input names versionNumber' })
    expect(judge('POST', INSERT, { ...INPUT, productAttributes: {} })).toEqual({ refusal: 'the product input holds no attribute' })
    expect(attributeProblem('description', 'two\nlines')).toBeNull()
    expect(attributeProblem('title', 'two\nlines')).toMatch(/1 to 150/)
  })

  it('a delete carries no body', () => {
    expect(googleMerchantCallBodyOf(googleMerchantCall('DELETE', DELETE_INPUT)!, null)).toEqual({ body: null })
    expect(googleMerchantCallBodyOf(googleMerchantCall('DELETE', DELETE_INPUT)!, '{}')).toEqual({ refusal: 'a delete carries no body' })
  })

  it('data sources: a supplemental or a promotion one, a rename of the one in the path, an empty fetch — never a primary', () => {
    expect(judge('POST', CREATE, { displayName: 'Nexus A', supplementalProductDataSource: {} })).toMatchObject({ body: expect.any(String) })
    expect(judge('POST', CREATE, { displayName: 'Nexus A', supplementalProductDataSource: { feedLabel: 'IT', contentLanguage: 'it' } })).toMatchObject({ body: expect.any(String) })
    expect(judge('POST', CREATE, { displayName: 'Nexus P', promotionDataSource: { targetCountry: 'IT', contentLanguage: 'it' } })).toMatchObject({ body: expect.any(String) })
    expect(judge('POST', CREATE, { displayName: 'Nexus A', primaryProductDataSource: {} })).toMatchObject({ refusal: expect.stringMatching(/supplemental product data source or a promotion/) })
    expect(judge('POST', CREATE, { displayName: 'Nexus A', supplementalProductDataSource: { feedLabel: 'IT' } })).toMatchObject({ refusal: expect.stringMatching(/language/) })
    expect(judge('POST', CREATE, { displayName: 'A', supplementalProductDataSource: {}, fileInput: {} })).toMatchObject({ refusal: expect.any(String) })
    expect(judge('PATCH', RENAME, { name: 'accounts/555/dataSources/71', displayName: 'Nexus B' })).toMatchObject({ body: expect.any(String) })
    expect(judge('PATCH', RENAME, { name: 'accounts/555/dataSources/72', displayName: 'Nexus B' })).toEqual({ refusal: 'the body does not name the data source in the path' })
    expect(judge('PATCH', RENAME, { name: 'accounts/555/dataSources/71', displayName: 'Nexus B', input: 'API' })).toEqual({ refusal: 'a rename names the data source and its new name only' })
    expect(judge('POST', FETCH, {})).toEqual({ body: '{}' })
    expect(judge('POST', FETCH, { x: 1 })).toEqual({ refusal: 'a fetch carries an empty body' })
  })

  it('a promotion in a data source of the same account, with Google\'s rules for its type', () => {
    expect(judge('POST', PROMOTION, PROMO)).toMatchObject({ body: expect.any(String) })
    const attributes = PROMO.promotion.attributes
    const variant = (a: Record<string, unknown>, p: Record<string, unknown> = {}) => ({ ...PROMO, promotion: { ...PROMO.promotion, ...p, attributes: { ...attributes, ...a } } })
    expect(judge('POST', PROMOTION, { ...PROMO, dataSource: 'accounts/556/dataSources/72' })).toEqual({ refusal: 'it does not name a data source of this account' })
    expect(judge('POST', PROMOTION, variant({ couponValueType: 'FREE_SHIPPING_STANDARD', percentOff: undefined }))).toEqual({ refusal: 'a free shipping promotion needs a code (Google\'s rule)' })
    expect(judge('POST', PROMOTION, variant({ longTitle: 'x'.repeat(61) }))).toEqual({ refusal: 'the promotion title is not 1 to 60 characters' })
    expect(judge('POST', PROMOTION, variant({ promotionEffectiveTimePeriod: { startTime: '2026-11-08T00:00:00Z', endTime: '2026-11-01T00:00:00Z' } }))).toEqual({ refusal: 'the promotion period does not end after it starts' })
    expect(judge('POST', PROMOTION, variant({ itemIdInclusion: ['SKU-A'] }))).toEqual({ refusal: 'a promotion for all products names no product filter' })
    expect(judge('POST', PROMOTION, variant({ couponValueType: 'MONEY_OFF', percentOff: undefined, moneyOffAmount: { amountMicros: '1234', currencyCode: 'EUR' } }))).toEqual({ refusal: 'the money off is not whole cents (amountMicros) with a currency' })
    expect(judge('POST', PROMOTION, variant({}, { redemptionChannel: ['IN_STORE'] }))).toEqual({ refusal: 'Nexus sends online promotions only (redemptionChannel ONLINE)' })
    expect(judge('POST', PROMOTION, variant({ storeApplicability: 'ALL_STORES' }))).toEqual({ refusal: 'the promotion names storeApplicability' })
  })
})

describe('on the gateway', () => {
  it('a Merchant change is a write, sent once with the body as judged, on the Google publish mode', async () => {
    expect(googleKind('POST', INSERT, INPUT)).toBe('write')
    expect(googleKind('DELETE', DELETE_INPUT)).toBe('write')
    expect(googleKind('PATCH', RENAME, { name: 'accounts/555/dataSources/71', displayName: 'B' })).toBe('write')
    const res = await googleCall({ connectionId: 'g-1', operation: 'merchant.productInputs.insert', method: 'POST', url: INSERT, body: INPUT })
    expect(res.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual(INPUT)
    await googleCall({ connectionId: 'g-1', operation: 'merchant.productInputs.delete', method: 'DELETE', url: DELETE_INPUT })
    expect(h.calls[1].init.method).toBe('DELETE')
    expect(h.calls[1].init.body).toBeUndefined()
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['sent', 'sent'])

    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const gated = await googleCall({ connectionId: 'g-1', operation: 'merchant.productInputs.insert', method: 'POST', url: INSERT, body: INPUT }).catch((e) => e)
    expect(gated).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(2)
  })

  it('a Merchant Center account the business did not choose through this connection: refused, change or read', async () => {
    gatewayMerchantUnlinked.add('g-1:555')
    const change = await googleCall({ connectionId: 'g-1', operation: 'merchant.productInputs.insert', method: 'POST', url: INSERT, body: INPUT }).catch((e) => e)
    expect(change).toBeInstanceOf(GatewayRefusal)
    expect(change).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    const read = await googleCall({ connectionId: 'g-1', operation: 'merchant.products.list', method: 'GET', url: `${API}/products/v1/accounts/555/products` }).catch((e) => e)
    expect(read).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    const search = await googleCall({ connectionId: 'g-1', operation: 'merchant.reports.search', method: 'POST', url: `${API}/reports/v1/accounts/555/reports:search`, body: { query: 'SELECT clicks FROM product_performance_view' } }).catch((e) => e)
    expect(search).toMatchObject({ code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    // The account list (discovery) names no account and still goes.
    await googleCall({ connectionId: 'g-1', operation: 'merchant.accounts.list', method: 'GET', url: `${API}/accounts/v1/accounts` })
    expect(h.calls.map((c) => c.url)).toEqual([`${API}/accounts/v1/accounts`])
  })

  it('a body Nexus does not send, or a change declared as a read, is refused before anything is sent', async () => {
    const tries = [
      googleCall({ connectionId: 'g-1', operation: 'merchant.productInputs.insert', method: 'POST', url: INSERT, body: { ...INPUT, productAttributes: { price: { amountMicros: '1', currencyCode: 'EUR' } } } }),
      googleCall({ connectionId: 'g-1', operation: 'merchant.dataSources.create', method: 'POST', url: CREATE, body: { displayName: 'P', primaryProductDataSource: {} } }),
      gatewayCall({ channel: 'GOOGLE', operation: 'merchant.sneaky', kind: 'read', connectionId: 'g-1', url: INSERT, method: 'POST', body: JSON.stringify(INPUT) }),
      googleCall({ connectionId: 'g-1', operation: 'merchant.dataSources.patch', method: 'PATCH', url: `${API}/datasources/v1/accounts/555/dataSources/71?updateMask=primaryProductDataSource.defaultRule`, body: {} }),
    ]
    for (const t of tries) expect(await t.catch((e) => e)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger.map((r) => r.errorCode)).toEqual(['GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY'])
  })
})
