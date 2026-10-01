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
})
