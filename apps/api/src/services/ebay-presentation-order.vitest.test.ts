/**
 * VTR step 0 — the eBay order tab's "Restore inherited" must hand the axes back to Shared.
 *
 * The Information sheet's own Reset (`family-projection.service.ts`, `input.reset`) leaves
 * `_variationAxesMode = 'inherit'`. The order tab's reset deleted `_variationAxes` but left an `'override'` mode behind,
 * and `ebayAxisSet` reads `'override'` + no axes as a deliberate EMPTY set: every eBay axis was dropped.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db.js', () => ({ default: {} }))

import { changePresentationOrder } from './ebay-presentation-order.service.js'
import { axisSynonymKey } from './ebay-theme-axes.js'
import { ebayAxisSet, resolveVariationProjection, type ResolveVariationInput } from './pim/variation-rules.service.js'
import { limitsFor, vocabularyFor } from './pim/family-projection-limits.js'

/** The dimensions `readPresentationOrder` serves: `key` is the synonym key, never the raw name. */
const AXES = [
  { name: 'Colore', key: axisSynonymKey('Colore'), values: ['Nero', 'Rosso'] },
  { name: 'Taglia', key: axisSynonymKey('Taglia'), values: ['M', 'L'] },
]

/** What the Information sheet stores when an operator gives eBay-IT its own axis setup. */
const OVERRIDE = {
  _variationAxesMode: 'override',
  _variationAxes: ['Taglia', 'Colore'],
  _axisNameLabels: { Taglia: 'Taglia', Colore: 'Colore' },
  _axisValueOrder: { [axisSynonymKey('Taglia')]: ['L', 'M'] },
}

function ebayCell(platformAttributes: Record<string, unknown>) {
  const input: ResolveVariationInput = {
    coordinate: { channel: 'EBAY', market: 'IT', accountId: null, aliasKey: '', label: 'EBAY · IT' },
    family: { familyAxes: ['Colore', 'Taglia'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 1, productTheme: null, childIds: [] },
    listing: { version: 3, variationTheme: null, variationMapping: null, platformAttributes, externalListingId: null, listingStatus: 'DRAFT' },
    rule: null,
    schema: {},
    limits: limitsFor('EBAY'),
    vocabulary: vocabularyFor('EBAY'),
  }
  return resolveVariationProjection(input)
}

const listingWith = (platformAttributes: Record<string, unknown>) =>
  ({ version: 3, variationTheme: null, variationMapping: null, platformAttributes, externalListingId: null, listingStatus: 'DRAFT' })

describe('eBay order tab — restore inherited', () => {
  it('positive control: the override itself delivers both axes in its own order', () => {
    expect(ebayCell(OVERRIDE).axes.filter(a => a.included).map(a => a.axisKey)).toEqual(['size', 'color'])
  })

  it('"Restore inherited ordering" returns the axes to Shared — it never leaves an empty override', () => {
    const next = changePresentationOrder(OVERRIDE, { reset: true }, AXES)
    expect(ebayAxisSet(listingWith(next), null).from).not.toBe('coordinate')
    expect(ebayCell(next).axes.filter(a => a.included).map(a => a.axisKey)).toEqual(['color', 'size'])
    // The same state the Information sheet's Reset leaves.
    expect(next._variationAxesMode).toBe('inherit')
    expect(next._variationAxes).toBeUndefined()
    expect(next._axisNameLabels).toBeUndefined()
    expect(next._axisValueOrder).toBeUndefined()
  })

  it('"Restore inherited axis order" (axes: null) returns the axes to Shared too', () => {
    const next = changePresentationOrder(OVERRIDE, { axes: null }, AXES)
    expect(ebayCell(next).axes.filter(a => a.included).map(a => a.axisKey)).toEqual(['color', 'size'])
    expect(next._variationAxesMode).toBe('inherit')
    expect(next._axisValueOrder).toEqual({ [axisSynonymKey('Taglia')]: ['L', 'M'] })
  })

  it('a listing with no mode keeps today\'s behaviour: the order is cleared and the legacy product theme still applies', () => {
    const legacy = { _variationAxes: ['Taglia', 'Colore'], _axisNameLabels: { Taglia: 'Taglia' } }
    const next = changePresentationOrder(legacy, { reset: true }, AXES)
    expect(next).toEqual({ _axisNameLabels: { Taglia: 'Taglia' } })
    expect(ebayAxisSet(listingWith(next), 'Colore,Taglia')).toEqual({ names: ['Colore', 'Taglia'], from: 'product' })
  })

  it('a reorder keeps the override mode (only a restore hands the axes back)', () => {
    const next = changePresentationOrder(OVERRIDE, { axes: ['Colore', 'Taglia'] }, AXES)
    expect(next._variationAxesMode).toBe('override')
    expect(ebayCell(next).axes.filter(a => a.included).map(a => a.axisKey)).toEqual(['color', 'size'])
  })
})
