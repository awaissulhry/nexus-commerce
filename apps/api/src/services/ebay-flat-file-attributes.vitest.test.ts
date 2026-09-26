/**
 * VTR step 0b — saving the eBay flat file must keep every listing key the row does not own.
 *
 * The rows save wrote `platformAttributes: packSharedFields(row).platformAttributes`, which REPLACES the whole bag. Measured on
 * a private copy (2026-09-26): one open-and-save of GALE-JACKET · eBay IT erased 26 keys — `__offerIds` on 20 listings (the
 * Inventory/Trading lane marker, Incident #23) and, on the parent, `_variationAxes`, `_axisNameLabels`, `_axisValueOrder`,
 * `__lastPublishedAxes`, `_presentationOrderRevision`, `descriptionPush`.
 */
import { describe, expect, it } from 'vitest'
import { flatFileListingAttributes } from './ebay-flat-file-attributes.js'

const stored = {
  categoryId: '57988', subtitle: 'old subtitle', itemSpecifics: { Marca: 'Old' },
  __offerIds: { EBAY_IT: 'offer-1' }, __lastPublishedAxes: { EBAY_IT: ['Colore', 'Taglia'] },
  _variationAxes: ['Colore', 'Taglia'], _variationAxesMode: 'override', _axisNameLabels: { Colore: 'Colore' },
  _axisValueOrder: { __dim0__: ['Nero', 'Rosso'] }, _presentationOrderRevision: 3, descriptionPush: { at: '2026-09-01' },
}
const packed = { categoryId: '57989', subtitle: '', itemSpecifics: { Marca: 'New' }, imageUrls: [], sharedSkuListing: false }

describe('flatFileListingAttributes', () => {
  it('the row wins on the fields it carries, including a cleared one', () => {
    const next = flatFileListingAttributes(stored, packed)
    expect(next.categoryId).toBe('57989')
    expect(next.subtitle).toBe('')
    expect(next.itemSpecifics).toEqual({ Marca: 'New' })
  })

  it('every key the row does not own survives the save', () => {
    const next = flatFileListingAttributes(stored, packed)
    for (const key of ['__offerIds', '__lastPublishedAxes', '_variationAxes', '_variationAxesMode', '_axisNameLabels', '_axisValueOrder', '_presentationOrderRevision', 'descriptionPush'])
      expect(next[key]).toEqual((stored as Record<string, unknown>)[key])
  })

  it('a listing with nothing stored gets exactly the row', () => {
    expect(flatFileListingAttributes(null, packed)).toEqual(packed)
    expect(flatFileListingAttributes(['not', 'a', 'bag'], packed)).toEqual(packed)
  })
})
