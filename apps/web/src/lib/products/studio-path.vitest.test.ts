import { describe, expect, it } from 'vitest'
import { productStudioPath } from './studio-path'

describe('productStudioPath — where a product is edited and published', () => {
  it('opens the studio of the product, workspace-relative', () => {
    expect(productStudioPath('p_1')).toBe('/products/p_1/edit/studio')
    expect(productStudioPath('a/b')).toBe('/products/a%2Fb/edit/studio')
  })
  it('keeps the channel and market the old wizard link carried, as the studio reads them', () => {
    expect(productStudioPath('p_1', { channel: 'ebay', market: 'it' })).toBe('/products/p_1/edit/studio?scope=EBAY&market=IT')
    expect(productStudioPath('p_1', { channel: 'AMAZON' })).toBe('/products/p_1/edit/studio?scope=AMAZON')
    // A market without a channel names no coordinate: the studio opens on its default.
    expect(productStudioPath('p_1', { market: 'DE' })).toBe('/products/p_1/edit/studio')
  })
  it('opens one account and one listing of the market — an alias lands on the alias, not the main listing', () => {
    expect(productStudioPath('p_1', { channel: 'EBAY', market: 'IT', account: 'acc_1', listing: 'alias_1' }))
      .toBe('/products/p_1/edit/studio?scope=EBAY&market=IT&account=acc_1&listing=alias_1')
    // The main listing: the account only (no alias id).
    expect(productStudioPath('p_1', { channel: 'EBAY', market: 'IT', account: 'acc_1', listing: '' }))
      .toBe('/products/p_1/edit/studio?scope=EBAY&market=IT&account=acc_1')
    expect(productStudioPath('p_1', { channel: 'EBAY', market: 'IT', account: null, listing: null })).toBe('/products/p_1/edit/studio?scope=EBAY&market=IT')
    // An alias id resolves only inside its account and market: without them it is not carried.
    expect(productStudioPath('p_1', { channel: 'EBAY', market: 'IT', listing: 'alias_1' })).toBe('/products/p_1/edit/studio?scope=EBAY&market=IT')
    expect(productStudioPath('p_1', { channel: 'EBAY', account: 'acc_1', listing: 'alias_1' })).toBe('/products/p_1/edit/studio?scope=EBAY')
  })
})
