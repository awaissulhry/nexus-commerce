import { describe, expect, it } from 'vitest'
import { destinationCategories, destinationCategoryLabel, destinationMarkets, languageName, workbookSelection } from './workbookSelection'
import type { TransferOptions } from './sourceMapping'
const options: TransferOptions = {
  families: [], accounts: [{ id: 'a', channelType: 'AMAZON', marketplace: null, displayName: 'Main shop' }, { id: 'b', channelType: 'EBAY', marketplace: 'IT', displayName: 'Italy shop' }],
  markets: [{ channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', language: 'it' }, { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', language: 'de' }, { channel: 'EBAY', code: 'IT', name: 'eBay Italy', language: 'it' }, { channel: 'EBAY', code: 'DE', name: 'eBay Germany', language: 'de' }],
  channelCategories: [{ channel: 'AMAZON', marketplace: 'IT', productType: 'COAT' }, { channel: 'AMAZON', marketplace: 'DE', productType: 'COAT' }, { channel: 'EBAY', marketplace: 'EBAY_IT', productType: '177104' }],
}
const italy = { accountId: 'a', marketplace: 'IT', category: 'COAT' }
describe('workbook destination guidance', () => {
  it('includes marketplace languages automatically, deduplicates them and preserves regional extras', () => {
    const result = workbookSelection(options, [italy, { ...italy, marketplace: 'DE' }, { accountId: 'b', marketplace: 'IT', category: '177104' }], [' IT ', 'en-gb'])
    expect(result.languages).toEqual(['it', 'de', 'en-gb'])
    expect(result.destinationErrors).toEqual(['', '', ''])
    expect(result.languageError).toBe('')
    expect(languageName('de')).toBe('German')
  })
  it('blocks duplicate destinations but allows distinct marketplaces and seller accounts', () => {
    expect(workbookSelection(options, [italy, italy], []).destinationErrors[1]).toContain('already included')
    expect(workbookSelection(options, [italy, { ...italy, marketplace: 'DE' }], []).destinationErrors).toEqual(['', ''])
  })
  it('only offers markets that match the account restriction, and rejects a forged selection', () => {
    expect(destinationMarkets(options, 'b').map(m => m.code)).toEqual(['IT'])
    expect(workbookSelection(options, [{ accountId: 'b', marketplace: 'DE', category: '177104' }], []).destinationErrors[0]).toContain('available for this account')
  })
  it('requires a category available in the exact marketplace', () => {
    expect(workbookSelection(options, [{ ...italy, category: 'SHOES' }], []).destinationErrors[0]).toContain('no available field definition')
    expect(workbookSelection(options, [{ ...italy, category: '' }], []).destinationErrors[0]).toContain('Choose the product category')
  })
  it('shows a readable category path while preserving the exact provider ID and marketplace', () => {
    const data = { ...options, channelCategories: [
      { channel: 'EBAY', marketplace: 'EBAY_IT', productType: '177104', label: 'Motorcycle clothing > Jackets' },
      { channel: 'EBAY', marketplace: 'DE', productType: '177104', label: 'German category path' },
    ] }
    const destination = { accountId: 'b', marketplace: 'IT', category: '177104' }
    expect(destinationCategories(data, destination)).toEqual(['177104'])
    expect(destinationCategoryLabel(data, destination, '177104')).toBe('Motorcycle clothing > Jackets')
    expect(workbookSelection(data, [destination], []).destinationErrors).toEqual([''])
  })
  it('rejects malformed and excessive language choices before download', () => {
    expect(workbookSelection(options, [], ['Italian please']).languageError).not.toBe('')
    expect(workbookSelection(options, [italy], Array.from({ length: 30 }, (_, i) => `en-x${i}`)).languageError).toContain('at most 30')
  })
})


it.each(['SHOPIFY', 'ETSY'])('includes a %s GLOBAL draft destination without a cached category', channel => {
  const o = { families: [], accounts: [{ id: 'store', channelType: channel, marketplace: 'GLOBAL', displayName: 'Store' }], markets: [{ channel, code: 'GLOBAL', name: 'Store', language: 'de' }], channelCategories: [] }
  const selected = workbookSelection(o, [{ accountId: 'store', marketplace: 'GLOBAL', category: '' }], [])
  expect(selected.destinationErrors).toEqual([''])
  expect(selected.requiredLanguages).toEqual(['de'])
})
