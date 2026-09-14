import { describe, expect, it } from 'vitest'
import { studioEditHref } from './legacy-edit-redirect'

describe('historical product editor links', () => {
  it('opens the studio with the same product, market, language, and listing identity', () => {
    expect(studioEditHref('product-id', { market: 'IT', locale: 'it', listing: 'listing-id', account: 'account-id' }))
      .toBe('/products/product-id/edit/studio?market=IT&locale=it&listing=listing-id&account=account-id')
  })
  it('converts a channel tab into a studio destination', () => {
    const query = new URL(studioEditHref('p', { tab: 'AMAZON', market: 'DE' }), 'https://nexus.test').searchParams
    expect(Object.fromEntries(query)).toEqual({ tab: 'sheet', market: 'DE', scope: 'AMAZON' })
  })
  it.each([['variations', 'variants'], ['timeline', 'activity'], ['master', 'sheet'], ['images', 'images'], ['matrix', 'matrix']])('maps %s to %s', (oldTab, tab) => {
    expect(new URL(studioEditHref('p', { tab: oldTab }), 'https://nexus.test').searchParams.get('tab')).toBe(tab)
  })
  it('preserves explicit destination and repeated query values', () => {
    const query = new URL(studioEditHref('p', { tab: 'EBAY__IT', scope: 'EBAY', market: 'DE', chip: ['one', 'two'] }), 'https://nexus.test').searchParams
    expect(query.get('market')).toBe('DE')
    expect(query.getAll('chip')).toEqual(['one', 'two'])
  })
})
