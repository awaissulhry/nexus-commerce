import { describe, expect, it, vi } from 'vitest'
import { formulaLookupMap } from '../studio-sheet.service.js'
import { getFormulaColumns, overlayFormulaChannelValues } from './formula-reference-values.js'

const columns = vi.hoisted(() => vi.fn(async (input: unknown) => ({ columns: [], input })))
vi.mock('../studio-columns.js', () => ({ getStudioColumns: columns }))
vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['177104'], byRow: new Map([['p1:', { channelCategoryId: '177104' }]]) }) }))

const field = (key: string, more = {}) => ({ key, storage: 'column', kind: 'text', scope: 'global', ...more })

describe('formula sources match the sheet', () => {
  it('inherits a blank global master field from the parent, but not a variant field', () => {
    const cols = [field('brand'), field('size', { scope: 'per_variant' })]
    expect(formulaLookupMap(cols as never, { brand: null, size: null }, {}, { brand: 'Xavia', size: 'M' })).toEqual({ brand: 'Xavia', size: null })
  })
  it('uses mapped overrides and explicit empty values, with slot projection', () => {
    const cols = [field('brand', { channels: { 'eBay · IT': { key: 'aspect_Marca' } } }),
      field('bulletPoints_2', { slot: { of: 'bulletPoints', index: 2 }, channels: { 'eBay · IT': { key: 'bullets' } } })]
    expect(overlayFormulaChannelValues({ brand: 'Master', bulletPoints_2: 'Old' }, cols as never, 'eBay · IT', {
      aspect_Marca: { status: 'mapped', value: 'Listing brand' }, bullets: { status: 'mapped', value: ['One', 'Two'] },
    })).toEqual({ brand: 'Listing brand', bulletPoints_2: 'Two' })
    expect(overlayFormulaChannelValues({ brand: 'Master' }, cols as never, 'eBay · IT', {
      aspect_Marca: { status: 'mapped', value: null },
    }).brand).toBeNull()
  })
  it('builds channel columns using the actual listing categories and scope', async () => {
    await getFormulaColumns({ product: { id: 'p1', productType: 'OUTERWEAR', categoryAttributes: {} }, scope: 'channel', channel: 'EBAY', marketplace: 'IT', market: 'IT' })
    expect(columns).toHaveBeenLastCalledWith(expect.objectContaining({ scopeKind: 'channel', onlyChannels: ['EBAY'], includeEmptyChannels: true, ebayCategoryIds: ['177104'] }))
  })
})
