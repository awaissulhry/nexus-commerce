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
