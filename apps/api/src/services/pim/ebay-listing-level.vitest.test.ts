import { describe, expect, it } from 'vitest'
import { ebayAxisIdentities, ebayFamilySupplier, isEbayListingLevel, listingLevelWarning, projectionAxisNames, sameEbayValue, showEbayListingLevel } from './ebay-listing-level.js'

/**
 * P1 of fix/product-sheet-editing (report 5 I-1) — eBay takes one value per listing for an item specific that is not a
 * variation axis: parent first, then the first variation in SKU order (`buildSharedListingInput`). The sheet shows that
 * value on every row, and says which rows hold another one.
 */
const store = (name: string) => ({ kind: 'platformAttributes', path: ['itemSpecifics', name] })
const axes = ebayAxisIdentities(['Colore', 'Taglia'])

describe('the rule', () => {
  it('an item specific is listing-level unless it is an axis (by its eBay name, key or label, any spelling)', () => {
    expect(isEbayListingLevel({ store: store('Paese di origine') }, axes)).toBe(true)
    expect(isEbayListingLevel({ store: store('Colore') }, axes)).toBe(false)
    expect(isEbayListingLevel({ store: store('Color'), names: ['color'] }, axes)).toBe(false)
    expect(isEbayListingLevel({ store: { kind: 'platformAttributes', path: ['subtitle'] } }, axes)).toBe(false)
  })
  it('the axes are the projection\'s INCLUDED ones', () => {
    expect(projectionAxisNames([{ included: true, channelName: 'Colore', familyKey: 'color' }, { included: false, channelName: 'Scollatura' }])).toEqual(['Colore', 'color'])
  })
  it('the supplier is the parent when it holds one, else the first variation in SKU order', () => {
    const rows = [{ productId: 'b', sku: 'F-B', isParent: false, value: 'Albania' }, { productId: 'a', sku: 'F-A', isParent: false, value: 'Cina' }, { productId: 'p', sku: 'F', isParent: true, value: '' }]
    expect(ebayFamilySupplier(rows)?.productId).toBe('a')
    expect(ebayFamilySupplier([...rows, { productId: 'p2', sku: 'F', isParent: true, value: 'Pakistan' }])?.productId).toBe('p2')
  })
  it('a legacy "x" and ["x"] are the same value', () => expect(sameEbayValue('x', ['x'])).toBe(true))
  it('the warning names the value eBay gets, where it comes from, and the rows (ten at most)', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ sku: `S${i}`, value: 'Donna' }))
    expect(listingLevelWarning('Genere', 'Uomo', 'S', rows)).toMatch(/^Genere: eBay takes one value for the whole listing and will get "Uomo" \(from S\)\. 12 rows hold another value that is not sent: S0 \("Donna"\).* and 2 more\.$/)
  })
})

describe('showEbayListingLevel — what the eBay sheet shows', () => {
  const cell = (value: unknown) => ({ value, pinned: true, inherited: false, inheritedFrom: null, mapped: { value, warnings: [], errors: [] as string[] } })
  const rows = () => [
    { id: 'p', sku: 'F', parentId: null, aliasId: null, values: { origin: cell('Pakistan'), color: cell(null), fit: cell(null) } },
    { id: 'a', sku: 'F-A', parentId: 'p', aliasId: null, values: { origin: cell('Cina'), color: cell('Rosso'), fit: cell('Slim') } },
    { id: 'b', sku: 'F-B', parentId: 'p', aliasId: null, values: { origin: cell(null), color: cell('Giallo'), fit: cell('Regular') } },
    { id: 'x', sku: 'F-X', parentId: 'p', aliasId: null, values: { origin: cell('Albania'), color: cell('Blu'), fit: cell(null) } },
  ]
  const columns = [{ key: 'origin', label: 'Country of origin', channels: { 'eBay · IT': { store: store('Paese di origine') } } },
    { key: 'color', label: 'Color', channelLabel: 'Colore', channels: { 'eBay · IT': { store: store('Colore') } } },
    { key: 'fit', label: 'Fit', channels: { 'eBay · IT': { store: store('Vestibilità') } } }]
  const show = (input = rows(), included = ['a', 'b']) => {
    showEbayListingLevel({ rows: input as never, columns, label: 'eBay · IT', groups: [{ aliasKey: '', axes: [{ included: true, channelName: 'Colore', familyKey: 'color' }], includedIds: new Set(included) }] })
    return Object.fromEntries(input.map(row => [row.id, row.values]))
  }
  it('every row shows the parent\'s value; a row with its own different value says so; the parent is marked as the source', () => {
    const out = show()
    expect([out.p.origin.value, out.a.origin.value, out.b.origin.value, out.x.origin.value]).toEqual(['Pakistan', 'Pakistan', 'Pakistan', 'Pakistan'])
    expect(out.a.origin).toMatchObject({ inherited: true, inheritedFrom: 'p', pinned: false, mapped: { value: 'Pakistan', listingLevel: { productId: 'p', sku: 'F', ownValue: 'Cina' } } })
    expect(out.a.origin.mapped.warnings.join(' ')).toContain('This row holds "Cina", which eBay does not receive')
    expect(out.b.origin.mapped.listingLevel).toEqual({ productId: 'p', sku: 'F' })
    expect(out.p.origin.mapped.listingLevel).toEqual({ productId: 'p', sku: 'F' })
  })
  it('control: an axis stays per row', () => {
    const out = show()
    expect([out.a.color.value, out.b.color.value]).toEqual(['Rosso', 'Giallo'])
  })
  it('no parent value: the first INCLUDED variation in SKU order supplies it (an excluded row is not sent, so it never does)', () => {
    const out = show(rows(), ['b', 'a'])
    expect([out.p.fit.value, out.b.fit.value, out.x.fit.value]).toEqual(['Slim', 'Slim', 'Slim'])
    expect(out.b.fit.mapped.listingLevel).toMatchObject({ productId: 'a', ownValue: 'Regular' })
    const excludedFirst = rows(); excludedFirst[0].values.origin = cell(null)
    expect(show(excludedFirst, ['a']).b.origin.value).toBe('Cina')
  })
})
