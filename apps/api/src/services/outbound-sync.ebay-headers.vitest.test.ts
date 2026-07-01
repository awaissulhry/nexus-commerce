import { describe, it, expect } from 'vitest'
import { ebayInventoryHeaders } from './outbound-sync.service.js'

describe('ebayInventoryHeaders', () => {
  it('sets it-IT for EBAY_IT and includes both language headers + marketplace id', () => {
    const h = ebayInventoryHeaders('TOK', 'EBAY_IT')
    expect(h['Content-Language']).toBe('it-IT')
    expect(h['Accept-Language']).toBe('it-IT')
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_IT')
    expect(h.Authorization).toBe('Bearer TOK')
  })
  it('maps EBAY_DE -> de-DE and EBAY_GB -> en-GB', () => {
    expect(ebayInventoryHeaders('T', 'EBAY_DE')['Accept-Language']).toBe('de-DE')
    expect(ebayInventoryHeaders('T', 'EBAY_GB')['Accept-Language']).toBe('en-GB')
  })
  it('defaults marketplace + locale when marketplaceId missing', () => {
    const h = ebayInventoryHeaders('T', undefined as any)
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_IT')
    expect(h['Accept-Language']).toBe('it-IT')
  })
})
