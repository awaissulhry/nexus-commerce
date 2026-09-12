import { expect, it } from 'vitest'
import type { ProductTransferOptions } from '@nexus/shared/catalog-transfer'
import { editorTransferSelection, updateTransferProducts, transferDestinationGroups } from './productTransferSelection'
const options: ProductTransferOptions = { productId: 'child', rootId: 'parent', products: [{ id: 'parent', sku: 'COAT', parentId: null }, { id: 'child', sku: 'COAT-S', parentId: 'parent' }], accounts: [],
  locales: ['it', 'de'], markets: [{ channel: 'AMAZON', code: 'IT', name: 'Italy', language: 'it' }],
  listings: [
    { id: 'it-a', productId: 'child', channel: 'AMAZON', accountId: 'a', marketplace: 'IT', aliasKey: '' },
    { id: 'it-b', productId: 'child', channel: 'AMAZON', accountId: 'b', marketplace: 'IT', aliasKey: '' },
    { id: 'it-alias', productId: 'child', channel: 'AMAZON', accountId: 'a', marketplace: 'IT', aliasKey: 'alias' },
    { id: 'de-a', productId: 'child', channel: 'AMAZON', accountId: 'a', marketplace: 'DE', aliasKey: '' },
    { id: 'parent-it', productId: 'parent', channel: 'AMAZON', accountId: 'a', marketplace: 'IT', aliasKey: '' },
  ] }
const context = { productId: 'child', market: 'IT', channel: 'AMAZON', accountId: 'a' }
it('defaults shared edits to the chosen SKU and editor language', () => {
  expect(editorTransferSelection(options, { productId: 'child', market: 'IT' }, ['child'])).toEqual({ productIds: ['child'], includeShared: true, locales: ['it'], listingIds: [] })
})
it('selects one exact channel account, market and primary or alias listing', () => {
  expect(editorTransferSelection(options, context, ['child']).listingIds).toEqual(['it-a'])
  expect(editorTransferSelection(options, { ...context, aliasKey: 'alias' }, ['child']).listingIds).toEqual(['it-alias'])
  expect(editorTransferSelection(options, { ...context, accountId: undefined }, ['child']).listingIds).toEqual([])
})
it('does not expand product scope when all destinations are requested', () => {
  const selection = editorTransferSelection(options, context, ['child'], true)
  expect(selection).toEqual({ productIds: ['child'], includeShared: true, locales: ['it', 'de'], listingIds: ['it-a', 'it-b', 'it-alias', 'de-a'] })
})
it('includes a parent or sibling only after explicit selection', () => {
  expect(editorTransferSelection(options, context, ['parent', 'child']).listingIds).toEqual(['it-a', 'parent-it'])
})
it('selects every alias in the current account and market without adding shared data', () => {
  const selection = editorTransferSelection(options, context, ['child'])
  expect(updateTransferProducts(options, context, selection, ['child'], 'aliases')).toEqual({ productIds: ['child'], includeShared: false, locales: [], listingIds: ['it-a', 'it-alias'] })
})
it('keeps shared ownership and content languages independent of destination selection', () => {
  const shared = { ...editorTransferSelection(options, context, ['child']), includeShared: true, locales: ['de'] }
  expect(updateTransferProducts(options, context, shared, ['parent', 'child'], 'all')).toMatchObject({ includeShared: true, locales: ['de'], listingIds: ['it-a', 'it-b', 'it-alias', 'de-a', 'parent-it'] })
})
it('retains chosen alias coordinates when products change without broadening to another account', () => {
  const selected = { ...editorTransferSelection(options, context, ['child']), listingIds: ['it-alias'] }
  expect(updateTransferProducts(options, context, selected, ['parent', 'child'], 'custom').listingIds).toEqual(['it-alias'])
})
it('uses readable alias labels and groups the same listing destination across selected SKUs', () => {
  const labeled = { ...options, listings: options.listings.map(l => ({ ...l, aliasLabel: l.aliasKey ? 'Summer listing' : 'Primary listing' })) }
  const groups = transferDestinationGroups(labeled, ['parent', 'child'])
  expect(groups.find(g => g.label.includes('Summer listing'))?.listingIds).toEqual(['it-alias'])
  expect(groups.find(g => g.listingIds.includes('parent-it'))?.listingIds).toEqual(['it-a', 'parent-it'])
})
