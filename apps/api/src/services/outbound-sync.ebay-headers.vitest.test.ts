import { describe, it, expect, vi } from 'vitest'
// P1.5 — the language comes from the Marketplace row (stood in here: the seeded eBay rows).
vi.mock('../db.js', () => ({ default: { marketplace: { findFirst: vi.fn(async ({ where }: any) => ({
  IT: { marketplaceId: 'EBAY_IT', languages: ['it'], language: 'it' }, DE: { marketplaceId: 'EBAY_DE', languages: ['de'], language: 'de' },
  UK: { marketplaceId: 'EBAY_GB', languages: ['en'], language: 'en' },
} as Record<string, unknown>)[where.code] ?? null) } } }))
import { ebayInventoryHeaders } from './outbound-sync.service.js'

describe('ebayInventoryHeaders', () => {
  it('sets it-IT for EBAY_IT and includes both language headers + marketplace id', async () => {
    const h = await ebayInventoryHeaders('TOK', 'EBAY_IT')
    expect(h['Content-Language']).toBe('it-IT')
    expect(h['Accept-Language']).toBe('it-IT')
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_IT')
    expect(h.Authorization).toBe('Bearer TOK')
  })
  it('maps EBAY_DE -> de-DE and EBAY_GB -> en-GB (from the Marketplace row)', async () => {
    expect((await ebayInventoryHeaders('T', 'EBAY_DE'))['Accept-Language']).toBe('de-DE')
    expect((await ebayInventoryHeaders('T', 'EBAY_GB'))['Accept-Language']).toBe('en-GB')
  })
  it('defaults marketplace + locale when marketplaceId missing', async () => {
    const h = await ebayInventoryHeaders('T', undefined as any)
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_IT')
    expect(h['Accept-Language']).toBe('it-IT')
  })
})
