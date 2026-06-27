// apps/api/src/services/ebay-trading-api.service.vitest.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { escapeXml, siteIdForMarket } from './ebay-trading-api.service.js'

describe('escapeXml', () => {
  it('escapes XML metacharacters', () => {
    expect(escapeXml(`Tom & "Jerry" <b>'x'</b>`)).toBe(
      'Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;x&apos;&lt;/b&gt;',
    )
  })
})

describe('siteIdForMarket', () => {
  it('maps the five EU markets to Trading-API site ids', () => {
    expect(siteIdForMarket('IT')).toBe('101')
    expect(siteIdForMarket('DE')).toBe('77')
    expect(siteIdForMarket('FR')).toBe('71')
    expect(siteIdForMarket('ES')).toBe('186')
    expect(siteIdForMarket('UK')).toBe('3')
  })
  it('is case-insensitive', () => {
    expect(siteIdForMarket('it')).toBe('101')
  })
  it('throws on an unknown market', () => {
    expect(() => siteIdForMarket('XX')).toThrow(/unknown eBay market/i)
  })
})

import { buildReviseInventoryStatusXml } from './ebay-trading-api.service.js'

describe('buildReviseInventoryStatusXml', () => {
  const xml = buildReviseInventoryStatusXml({ itemId: '110556677', sku: 'LNR-BLK-M', quantity: 7 })

  it('targets the variation by ItemID + SKU', () => {
    expect(xml).toContain('<ItemID>110556677</ItemID>')
    expect(xml).toContain('<SKU>LNR-BLK-M</SKU>')
    expect(xml).toContain('<Quantity>7</Quantity>')
  })
  it('does not embed an auth token in the body (IAF header is used instead)', () => {
    expect(xml).not.toContain('eBayAuthToken')
    expect(xml).not.toContain('<RequesterCredentials>')
  })
  it('is a ReviseInventoryStatusRequest', () => {
    expect(xml).toContain('<ReviseInventoryStatusRequest')
  })
})

import { buildAddFixedPriceItemXml } from './ebay-trading-api.service.js'

describe('buildAddFixedPriceItemXml', () => {
  const xml = buildAddFixedPriceItemXml({
    title: 'Inner Liner & Pad',
    description: '<p>Liner</p>',
    categoryId: '57988',
    conditionId: '1000',
    country: 'IT',
    currency: 'EUR',
    variationSpecificNames: ['Size'],
    variations: [
      { sku: 'LNR-BLK-M', price: 49.9, quantity: 5, specifics: { Size: 'M' } },
      { sku: 'LNR-BLK-L', price: 49.9, quantity: 3, specifics: { Size: 'L' } },
    ],
    policies: { fulfillmentPolicyId: 'F1', paymentPolicyId: 'P1', returnPolicyId: 'R1' },
  })

  it('is an AddFixedPriceItemRequest with a GTC fixed-price item', () => {
    expect(xml).toContain('<AddFixedPriceItemRequest')
    expect(xml).toContain('<ListingDuration>GTC</ListingDuration>')
    expect(xml).toContain('<PrimaryCategory><CategoryID>57988</CategoryID></PrimaryCategory>')
  })
  it('NEVER sets InventoryTrackingMethod to SKU (keeps default ItemID)', () => {
    expect(xml).not.toContain('InventoryTrackingMethod')
  })
  it('emits one Variation per row with SKU + price + quantity + specifics', () => {
    expect(xml).toContain('<SKU>LNR-BLK-M</SKU>')
    expect(xml).toContain('<SKU>LNR-BLK-L</SKU>')
    expect(xml).toContain('<StartPrice>49.9</StartPrice>')
    expect(xml).toContain('<Quantity>5</Quantity>')
    expect(xml).toContain('<NameValueList><Name>Size</Name><Value>M</Value></NameValueList>')
  })
  it('aggregates distinct axis values in VariationSpecificsSet', () => {
    expect(xml).toMatch(/<VariationSpecificsSet>[\s\S]*<Name>Size<\/Name>[\s\S]*<Value>M<\/Value>[\s\S]*<Value>L<\/Value>[\s\S]*<\/VariationSpecificsSet>/)
  })
  it('wires seller profiles when policies are provided', () => {
    expect(xml).toContain('<ShippingProfileID>F1</ShippingProfileID>')
    expect(xml).toContain('<PaymentProfileID>P1</PaymentProfileID>')
    expect(xml).toContain('<ReturnProfileID>R1</ReturnProfileID>')
  })
  it('escapes the title', () => {
    expect(xml).toContain('<Title>Inner Liner &amp; Pad</Title>')
  })
})

import { callTradingApi } from './ebay-trading-api.service.js'

describe('callTradingApi', () => {
  const ctx = { oauthToken: 'OAUTH123', siteId: '101' }
  const OLD = { ...process.env }
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { process.env = { ...OLD } })

  it('dry-run (no real-API) returns simulated success without calling fetch (non-prod)', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'false'
    process.env.NODE_ENV = 'test'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await callTradingApi('AddFixedPriceItem', '<x/>', ctx)
    expect(res.ack).toBe('Success')
    expect(res.itemId).toMatch(/^DRYRUN-/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('production without real-API throws (fail-loud)', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'false'
    process.env.NODE_ENV = 'production'
    await expect(callTradingApi('AddFixedPriceItem', '<x/>', ctx)).rejects.toThrow(/NEXUS_EBAY_REAL_API/)
  })

  it('real call sends IAF token + site id headers and parses ItemID', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    process.env.EBAY_APP_ID = 'APP'; process.env.EBAY_DEV_ID = 'DEV'; process.env.EBAY_CERT_ID = 'CERT'
    const body = '<AddFixedPriceItemResponse><Ack>Success</Ack><ItemID>110556677</ItemID></AddFixedPriceItemResponse>'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200 }),
    )
    const res = await callTradingApi('AddFixedPriceItem', '<x/>', ctx)
    expect(res.ack).toBe('Success')
    expect(res.itemId).toBe('110556677')
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-EBAY-API-IAF-TOKEN']).toBe('OAUTH123')
    expect(headers['X-EBAY-API-SITEID']).toBe('101')
    expect(headers['X-EBAY-API-CALL-NAME']).toBe('AddFixedPriceItem')
  })

  it('real call throws on Ack=Failure with the short message', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    const body = '<R><Ack>Failure</Ack><Errors><ShortMessage>Bad category</ShortMessage></Errors></R>'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    await expect(callTradingApi('AddFixedPriceItem', '<x/>', ctx)).rejects.toThrow(/Bad category/)
  })
})
