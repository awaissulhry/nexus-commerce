// apps/api/src/services/ebay-trading-api.service.vitest.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
// P1.2 — Trading calls go through the channel gateway; its account check and ledger are stood in.
vi.mock('../services/gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../services/gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
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
  it('floors negative quantity to 0', () => {
    const xmlNeg = buildReviseInventoryStatusXml({ itemId: '1', sku: 'S', quantity: -3 })
    expect(xmlNeg).toContain('<Quantity>0</Quantity>')
  })
  it('a quantity-only request is byte-for-byte the one sent before StartPrice existed', () => {
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>110556677</ItemID>
    <SKU>LNR-BLK-M</SKU>
    <Quantity>7</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`)
  })
})

// 2026-10-06 (Trading stock sync) — a Trading listing's price row: StartPrice in the market's currency, same InventoryStatus.
describe('buildReviseInventoryStatusXml — StartPrice', () => {
  it('a price alone: StartPrice with its currency and two decimals, no Quantity', () => {
    const xml = buildReviseInventoryStatusXml({ itemId: '110556677', sku: 'LNR-BLK-M', price: 19.9, currency: 'EUR' })
    expect(xml).toContain('<StartPrice currencyID="EUR">19.90</StartPrice>')
    expect(xml).not.toContain('<Quantity>')
  })
  it('a quantity and a price in one InventoryStatus', () => {
    const xml = buildReviseInventoryStatusXml({ itemId: '1', sku: 'S', quantity: 2, price: 12.5, currency: 'GBP' })
    expect(xml).toContain(`  <InventoryStatus>
    <ItemID>1</ItemID>
    <SKU>S</SKU>
    <Quantity>2</Quantity>
    <StartPrice currencyID="GBP">12.50</StartPrice>
  </InventoryStatus>`)
    expect(xml.match(/<InventoryStatus>/g)).toHaveLength(1)
  })
  it('refuses a request with nothing to change, a price that is not a positive number, or a price with no currency', () => {
    expect(() => buildReviseInventoryStatusXml({ itemId: '1', sku: 'S' })).toThrow(/quantity or a price/)
    expect(() => buildReviseInventoryStatusXml({ itemId: '1', sku: 'S', price: 0, currency: 'EUR' })).toThrow(/positive number/)
    expect(() => buildReviseInventoryStatusXml({ itemId: '1', sku: 'S', price: Number.NaN, currency: 'EUR' })).toThrow(/positive number/)
    expect(() => buildReviseInventoryStatusXml({ itemId: '1', sku: 'S', price: 10 })).toThrow(/currency/)
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

  it('CDATA: escapes ]]> in description so the CDATA stays well-formed', () => {
    const xmlWithCdata = buildAddFixedPriceItemXml({
      title: 'T', description: 'a]]>b', categoryId: '1', conditionId: '1000',
      country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'],
      variations: [{ sku: 'A-M', price: 9.9, quantity: 1, specifics: { Size: 'M' } }],
    })
    // The raw closing sequence followed immediately by 'b' must not appear
    expect(xmlWithCdata).not.toContain(']]>b')
    // The split marker must be present
    expect(xmlWithCdata).toContain(']]]]><![CDATA[>')
  })

  it('emits <Pictures> block when variationPictures is provided', () => {
    const xmlWithPics = buildAddFixedPriceItemXml({
      title: 'T', description: 'x', categoryId: '1', conditionId: '1000',
      country: 'IT', currency: 'EUR',
      variationSpecificNames: ['Color'],
      variations: [{ sku: 'A-BLK', price: 49.9, quantity: 2, specifics: { Color: 'Nero' } }],
      variationPictures: { axisName: 'Color', byValue: { Nero: ['https://img/n1.jpg'] } },
    })
    expect(xmlWithPics).toContain('<Pictures>')
    expect(xmlWithPics).toContain('<VariationSpecificName>Color</VariationSpecificName>')
    expect(xmlWithPics).toContain('<VariationSpecificPictureSet>')
    expect(xmlWithPics).toContain('<VariationSpecificValue>Nero</VariationSpecificValue>')
    expect(xmlWithPics).toContain('<PictureURL>https://img/n1.jpg</PictureURL>')
  })

  it('floors negative variation quantity to 0', () => {
    const xmlNeg = buildAddFixedPriceItemXml({
      title: 'T', description: 'x', categoryId: '1', conditionId: '1000',
      country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'],
      variations: [{ sku: 'A-M', price: 9.9, quantity: -5, specifics: { Size: 'M' } }],
    })
    expect(xmlNeg).toContain('<Quantity>0</Quantity>')
  })

  it('truncates fractional variation quantity (floor)', () => {
    const xmlFrac = buildAddFixedPriceItemXml({
      title: 'T', description: 'x', categoryId: '1', conditionId: '1000',
      country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'],
      variations: [{ sku: 'A-M', price: 9.9, quantity: 2.9, specifics: { Size: 'M' } }],
    })
    expect(xmlFrac).toContain('<Quantity>2</Quantity>')
  })
})

import { callTradingApi } from './ebay-trading-api.service.js'

describe('callTradingApi', () => {
  const ctx = { oauthToken: 'OAUTH123', siteId: '101', connectionId: 'conn-1' }
  const OLD = { ...process.env }
  // P0.1 — the real-call cases model production: eBay publish mode `live`.
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'; process.env.EBAY_PUBLISH_MODE = 'live'; delete process.env.EBAY_SANDBOX
  })
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
    // Body must never embed an eBayAuthToken — auth is header-only (IAF)
    expect((fetchSpy.mock.calls[0][1] as RequestInit).body).not.toContain('eBayAuthToken')
  })

  it('P1.2 — each Trading call is ONE gateway ledger row: account, operation, Ack read as the outcome, eBay code classed', async () => {
    const { gatewayLedger } = await import('../test-support/gateway-stubs.js')
    gatewayLedger.length = 0
    process.env.NEXUS_EBAY_REAL_API = 'true'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<R><Ack>Failure</Ack><Errors><ErrorCode>931</ErrorCode><LongMessage>Auth token is invalid.</LongMessage></Errors></R>', { status: 200 }))
    await expect(callTradingApi('GetItem', '<x/>', ctx)).rejects.toThrow('Auth token is invalid.')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'EBAY', connectionId: 'conn-1', operation: 'trading.GetItem', statusCode: 200, success: false, errorClass: 'auth_revoked', errorCode: '931' })])
  })

  it('P1.2 — a Trading call that names no account is refused before anything is sent', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(callTradingApi('GetItem', '<x/>', { oauthToken: 'T', siteId: '101' } as never)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('P1.2 — read, listing write, order action or setup per Trading call', async () => {
    const { tradingCallKind } = await import('./ebay-trading-api.service.js')
    expect(['GetItem', 'VerifyAddFixedPriceItem', 'ReviseFixedPriceItem', 'EndFixedPriceItem', 'CompleteSale', 'LeaveFeedback', 'SetNotificationPreferences'].map(tradingCallKind))
      .toEqual(['read', 'read', 'write', 'write', 'action', 'action', 'setup'])
  })

  it('real call throws on Ack=Failure with the short message', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    const body = '<R><Ack>Failure</Ack><Errors><ShortMessage>Bad category</ShortMessage></Errors></R>'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    await expect(callTradingApi('AddFixedPriceItem', '<x/>', ctx)).rejects.toThrow(/Bad category/)
  })

  it.each([
    ['1', '110040602158', '110040602158'],
    ['0', '110040602158', undefined],
    ['1', 'invalid', undefined],
  ])('retains a duplicate UUID receipt only with same-app evidence (%s, %s)', async (sameApp, itemId, expected) => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    const body = `<R><Ack>Failure</Ack><Errors><ErrorCode>488</ErrorCode><ShortMessage>Duplicate UUID</ShortMessage><ErrorParameters ParamID="0"><Value>${sameApp}</Value></ErrorParameters><ErrorParameters ParamID="1"><Value>${itemId}</Value></ErrorParameters></Errors></R>`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    await expect(callTradingApi('AddFixedPriceItem', '<Item><UUID>0123456789ABCDEF0123456789ABCDEF</UUID></Item>', ctx))
      .rejects.toMatchObject({ duplicateSubmission: true, priorItemId: expected })
  })

  it.each([
    ['Success', '0123456789ABCDEF0123456789ABCDEF', '110040602158'],
    ['InProgress', '0123456789ABCDEF0123456789ABCDEF', undefined],
    ['Success', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', undefined],
  ])('correlates duplicate revise completion before retaining its item (%s, %s)', async (status, invocationId, expected) => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    const body = `<R><Ack>Failure</Ack><Errors><ErrorCode>21060</ErrorCode></Errors><DuplicateInvocationDetails><DuplicateInvocationID>${invocationId}</DuplicateInvocationID><Status>${status}</Status><InvocationTrackingID>999</InvocationTrackingID></DuplicateInvocationDetails></R>`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    await expect(callTradingApi('ReviseFixedPriceItem', '<Item><ItemID>110040602158</ItemID><InvocationID>0123456789ABCDEF0123456789ABCDEF</InvocationID></Item>', ctx))
      .rejects.toMatchObject({ duplicateSubmission: true, priorItemId: expected })
  })
})

import { addFixedPriceItem, reviseInventoryStatus } from './ebay-trading-api.service.js'

describe('addFixedPriceItem / reviseInventoryStatus (dry-run composition)', () => {
  const base = { oauthToken: 'OAUTH', market: 'IT', connectionId: 'conn-1' }
  beforeEach(() => { process.env.NEXUS_EBAY_REAL_API = 'false'; process.env.NODE_ENV = 'test' })

  it('addFixedPriceItem returns the dry-run ItemID', async () => {
    const { itemId } = await addFixedPriceItem(
      {
        title: 'X', description: 'x', categoryId: '1', conditionId: '1000',
        country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'],
        variations: [{ sku: 'A-M', price: 9.9, quantity: 1, specifics: { Size: 'M' } }],
      },
      base,
    )
    expect(itemId).toMatch(/^DRYRUN-/)
  })

  it('reviseInventoryStatus resolves without throwing in dry-run', async () => {
    await expect(
      reviseInventoryStatus({ itemId: '110', sku: 'A-M', quantity: 4 }, base),
    ).resolves.toBeUndefined()
  })

  it('addFixedPriceItem rejects an unknown market', async () => {
    await expect(
      addFixedPriceItem(
        { title: 'X', description: 'x', categoryId: '1', conditionId: '1000', country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'], variations: [{ sku: 'A', price: 1, quantity: 1, specifics: { Size: 'M' } }] },
        { oauthToken: 'O', market: 'ZZ', connectionId: 'conn-1' },
      ),
    ).rejects.toThrow(/unknown eBay market/i)
  })
})

// RT.2 — batched ReviseInventoryStatus (≤4 InventoryStatus nodes per call)
import { buildReviseInventoryStatusBatchXml, REVISE_INVENTORY_STATUS_MAX_ENTRIES } from './ebay-trading-api.service.js'

describe('RT.2 — buildReviseInventoryStatusBatchXml', () => {
  it('emits one InventoryStatus node per entry, same ItemID', () => {
    const xml = buildReviseInventoryStatusBatchXml({
      itemId: '900',
      entries: [
        { sku: 'A', quantity: 3 },
        { sku: 'B', quantity: 0 },
        { sku: 'C&D', quantity: 7.9 },
      ],
    })
    expect(xml.match(/<InventoryStatus>/g)).toHaveLength(3)
    expect(xml.match(/<ItemID>900<\/ItemID>/g)).toHaveLength(3)
    expect(xml).toContain('<SKU>C&amp;D</SKU>') // escaped
    expect(xml).toContain('<Quantity>7</Quantity>') // truncated
    expect(xml).toContain('<Quantity>0</Quantity>') // zero preserved
  })

  it('rejects empty and >4-entry batches (eBay hard limit)', () => {
    expect(() => buildReviseInventoryStatusBatchXml({ itemId: '1', entries: [] })).toThrow()
    expect(() =>
      buildReviseInventoryStatusBatchXml({
        itemId: '1',
        entries: Array.from({ length: REVISE_INVENTORY_STATUS_MAX_ENTRIES + 1 }, (_, i) => ({ sku: `S${i}`, quantity: 1 })),
      }),
    ).toThrow()
  })
})

// 2026-10-06 (Trading stock sync) — eBay's "this is an Inventory item" answer to a Trading revise (21919474).
import { isEbayInventoryManagedRefusal, tradingErrorBlocks } from './ebay-trading-api.service.js'
describe('isEbayInventoryManagedRefusal', () => {
  it('the code decides; eBay\'s English and Italian words are recognised without it', () => {
    expect(isEbayInventoryManagedRefusal(['21919474'], '')).toBe(true)
    expect(isEbayInventoryManagedRefusal([], 'This operation is not allowed for inventory items.')).toBe(true)
    expect(isEbayInventoryManagedRefusal([], 'operazione non consentita per gli oggetti del magazzino')).toBe(true)
  })
  it('another ReviseInventoryStatus refusal that names InventoryStatus is not one', () => {
    expect(isEbayInventoryManagedRefusal(['21916585'], 'The SKU in InventoryStatus is not in this listing.')).toBe(false)
  })
})
describe('tradingErrorBlocks', () => {
  it('reads each error block\'s code, classification and words, and leaves warnings out', () => {
    const raw = '<Errors><ShortMessage>Note</ShortMessage><ErrorCode>21917091</ErrorCode><SeverityCode>Warning</SeverityCode></Errors>'
      + '<Errors><LongMessage>Internal error.</LongMessage><ErrorCode>10007</ErrorCode><SeverityCode>Error</SeverityCode><ErrorClassification>SystemError</ErrorClassification></Errors>'
    expect(tradingErrorBlocks(raw)).toEqual([{ code: '10007', classification: 'SystemError', message: 'Internal error' }])
  })
})
