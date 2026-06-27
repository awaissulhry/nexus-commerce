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
