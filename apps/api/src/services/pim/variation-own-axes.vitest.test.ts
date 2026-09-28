/**
 * Sheet pop-up P3 (PLAN §10, the Owner 2026-09-28) — channel-only axes: the one value reader and the resolver's rules.
 *
 * eBay and Etsy take axes the family does not have; Amazon never does (its themes decide); Shopify's arrive with P3b,
 * so until then a stored one is refused with a reason instead of being dropped at publish. Made-up family and ids only.
 */

import { describe, expect, it } from 'vitest'
import { ownAxisKey } from '@nexus/shared/variation-mapping'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import { ownAxisValue, ownAxisValuesFor, storedOwnAxisKeys } from './variation-own-axes.js'
import { resolveVariationProjection, variationReadinessItems, VT_COPY, type ResolveVariationInput } from './variation-rules.service.js'

const NECK = ownAxisKey({ from: 'channel', field: 'scollatura' })
const FIT = ownAxisKey({ from: 'shared', field: 'fit' })

/** Four variants: two colours × two sizes; the neckline tells two of them apart only when the size is dropped. */
const VARIANTS = [
  { id: 'v1', sku: 'TEST-JACKET-RED-S', included: true, axisValues: { Colore: 'Rosso', Taglia: 'S', [NECK]: 'V', [FIT]: 'Slim' } },
  { id: 'v2', sku: 'TEST-JACKET-RED-M', included: true, axisValues: { Colore: 'Rosso', Taglia: 'M', [NECK]: 'Tondo', [FIT]: 'Slim' } },
  { id: 'v3', sku: 'TEST-JACKET-BLUE-S', included: true, axisValues: { Colore: 'Blu', Taglia: 'S', [NECK]: 'V', [FIT]: 'Regular' } },
  { id: 'v4', sku: 'TEST-JACKET-BLUE-M', included: true, axisValues: { Colore: 'Blu', Taglia: 'M', [NECK]: '', [FIT]: 'Regular' } },
]

const EBAY = {
  categoryId: '1000001',
  aspects: [
    { name: 'Taglia', englishName: 'Size', variantEligible: true, required: false, columnKey: 'size' },
    { name: 'Colore', englishName: 'Color', variantEligible: true, required: false, columnKey: 'color' },
    { name: 'Scollatura', englishName: 'Neckline', variantEligible: true, required: false, columnKey: 'scollatura' },
  ],
  unavailableReason: null,
  nonVariationAspects: ['Marca', 'Brand', 'Stile', 'Style'],
}

function input(channel: string, over: Partial<ResolveVariationInput> = {}): ResolveVariationInput {
  return {
    coordinate: { channel, market: 'IT', accountId: 'acct-1', aliasKey: '', label: `${channel} · IT` },
    family: { familyAxes: ['Colore', 'Taglia'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 3, productTheme: null,
      childIds: VARIANTS.map(v => v.id), variants: VARIANTS },
    listing: { version: 5, variationTheme: null, variationMapping: null, platformAttributes: null, externalListingId: null, listingStatus: 'DRAFT' },
    rule: null,
    schema: channel === 'EBAY' ? { ebay: EBAY } : {},
    limits: limitsFor(channel),
    vocabulary: vocabularyFor(channel),
    ...over,
  }
}

const ebayListing = (axes: string[], names: Record<string, string>) =>
  ({ version: 5, variationTheme: null, variationMapping: null, platformAttributes: { _variationAxesMode: 'override', _variationAxes: axes, _axisNameLabels: names }, externalListingId: null, listingStatus: 'DRAFT' })
const mappedListing = (axes: Array<{ axisKey: string; target: string }>) =>
  ({ version: 5, variationTheme: null, variationMapping: { axes: axes.map((a, order) => ({ ...a, order })) }, platformAttributes: null, externalListingId: null, listingStatus: 'DRAFT' })

describe('ownAxisValue — one reader for every caller', () => {
  it('a channel column reads its mapped value first, then its stored cell, and a blank is a gap', () => {
    const cells = { scollatura: { value: 'stored', mapped: { status: 'mapped', value: 'From mapping' } }, other: { value: '  ' } }
    expect(ownAxisValue({ from: 'channel', field: 'scollatura' }, cells, null)).toBe('From mapping')
    expect(ownAxisValue({ from: 'channel', field: 'scollatura' }, { scollatura: { value: 'Tondo', mapped: { status: 'unmapped' } } }, null)).toBe('Tondo')
    expect(ownAxisValue({ from: 'channel', field: 'other' }, cells, null)).toBe('')
    expect(ownAxisValue({ from: 'channel', field: 'missing' }, cells, null)).toBe('')
  })

  it('a Shared attribute reads Product.categoryAttributes, never a channel cell', () => {
    expect(ownAxisValue({ from: 'shared', field: 'fit' }, { fit: { value: 'channel value' } }, { fit: 'Slim' })).toBe('Slim')
    expect(ownAxisValue({ from: 'shared', field: 'length' }, null, { length: 72 })).toBe('72')
    expect(ownAxisValue({ from: 'shared', field: 'fit' }, null, { fit: { nested: true } })).toBe('')
    expect(ownAxisValue({ from: 'shared', field: 'fit' }, null, null)).toBe('')
  })

  it('reads only channel-only keys, under the raw key', () => {
    expect(ownAxisValuesFor(['Colore', FIT], null, { fit: 'Slim' })).toEqual({ [FIT]: 'Slim' })
  })

  it('finds the stored channel-only keys in either store, and none after a reset', () => {
    expect(storedOwnAxisKeys('EBAY', { platformAttributes: { _variationAxes: ['Colore', NECK, 'Taglia'] } })).toEqual([NECK])
    expect(storedOwnAxisKeys('EBAY', { platformAttributes: { _variationAxesMode: 'inherit', _variationAxes: [NECK] } })).toEqual([])
    expect(storedOwnAxisKeys('SHOPIFY', { variationMapping: { axes: [{ axisKey: 'Colore', target: 'Color', order: 0 }, { axisKey: FIT, target: 'Fit', order: 1 }] } })).toEqual([FIT])
    expect(storedOwnAxisKeys('ETSY', { variationMapping: null })).toEqual([])
    expect(storedOwnAxisKeys('EBAY', null)).toEqual([])
  })
})

describe('eBay — own axes from the category list or under a typed name (P3-D1 b)', () => {
  it('an aspect axis keeps eBay\'s name, reads the column, and counts its gaps like any axis', () => {
    const cell = resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore', 'Taglia', NECK], { Colore: 'Colore', Taglia: 'Taglia', [NECK]: 'Scollatura' }) }))
    const neck = cell.axes.find(a => a.familyKey === NECK)!
    expect(neck).toMatchObject({ channelName: 'Scollatura', target: 'Scollatura', label: 'Neckline', included: true, own: { from: 'channel', field: 'scollatura', custom: false } })
    expect(neck.unbound).toBeUndefined()
    expect(cell.valueGaps).toMatchObject({ unresolved: 1, skus: ['TEST-JACKET-BLUE-M'] })
    expect(cell.valueSummary![NECK]).toEqual({ values: ['V', 'Tondo'], filled: 3, of: 4 })
    expect(cell.ownCandidates).toEqual([])
  })

  it('offers the unused variation aspects with their fill count, and never one a family axis already uses', () => {
    const cell = resolveVariationProjection(input('EBAY'))
    expect(cell.ownCandidates).toEqual([{ axisKey: NECK, name: 'Scollatura', label: 'Neckline', filled: 3, of: 4 }])
    expect(cell.ownNames).toEqual({ allowed: true, maxLength: 40, reason: null, refused: ['Marca', 'Brand', 'Stile', 'Style'].map(name => ({ name, reason: VT_COPY.ebayNotForVariations(name) })) })
  })

  it('a category eBay could not read turns own names off, with the reason', () => {
    const cell = resolveVariationProjection(input('EBAY', { schema: { ebay: { categoryId: null, aspects: [], unavailableReason: 'No category yet.' } } }))
    expect(cell.ownNames).toMatchObject({ allowed: false, reason: 'No category yet.' })
  })

  it('a typed name outside eBay\'s list is a custom specific; values come from the Shared attribute', () => {
    const cell = resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore', 'Taglia', FIT], { [FIT]: 'Vestibilità' }) }))
    const fit = cell.axes.find(a => a.familyKey === FIT)!
    expect(fit).toMatchObject({ channelName: 'Vestibilità', target: 'Vestibilità', own: { from: 'shared', field: 'fit', custom: true } })
    expect(fit.unbound).toBeUndefined()
    expect(cell.valueSummary![FIT]).toEqual({ values: ['Slim', 'Regular'], filled: 4, of: 4 })
  })

  it('refuses a name eBay lists for the category but not for variations (219451), an empty one and a long one', () => {
    const at = (name: string) => resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore', FIT], { [FIT]: name }) })).axes.find(a => a.familyKey === FIT)!
    expect(at('stile').unbound?.reason).toBe(VT_COPY.ebayNotForVariations('stile'))
    expect(at('').unbound?.reason).toBe(VT_COPY.ownNameMissing('specific'))
    expect(at('x'.repeat(41)).unbound?.reason).toBe(VT_COPY.ownNameTooLong('eBay', 'specific', 40))
    expect(at('x'.repeat(40)).unbound).toBeUndefined()
    // a typed name that IS a variation aspect is fine, and not custom
    expect(at('Scollatura')).toMatchObject({ own: { custom: false } })
  })

  it('an aspect axis whose column is not a variation aspect here is refused with the reason', () => {
    const key = ownAxisKey({ from: 'channel', field: 'marca' })
    const axis = resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore', key], { [key]: 'Marca' }) })).axes.find(a => a.familyKey === key)!
    expect(axis.unbound?.reason).toBe(VT_COPY.ebayNotAnAspect('Marca'))
  })

  it('a channel-only axis tells variants apart: dropping Taglia collides, adding Scollatura resolves most of it', () => {
    const dropped = resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore'], {}) }))
    expect(dropped.collisions!.unresolved).toBe(4)
    const own = resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore', NECK], { [NECK]: 'Scollatura' }) }))
    // Blu·V and Blu·(empty) differ; Rosso·V and Rosso·Tondo differ — no two included variants share both values
    expect(own.collisions!.unresolved).toBe(0)
  })
})

describe('the other channels', () => {
  it('Etsy takes a typed name with values from an attribute, and refuses a channel column source', () => {
    const cell = resolveVariationProjection(input('ETSY', { listing: mappedListing([{ axisKey: 'Colore', target: 'primary_color' }, { axisKey: FIT, target: 'Fit' }]) }))
    expect(cell.axes.find(a => a.familyKey === FIT)).toMatchObject({ channelName: 'Fit', own: { from: 'shared', custom: true } })
    expect(cell.axes.find(a => a.familyKey === FIT)!.unbound).toBeUndefined()
    const bad = resolveVariationProjection(input('ETSY', { listing: mappedListing([{ axisKey: NECK, target: 'Neckline' }]) }))
    expect(bad.axes.find(a => a.familyKey === NECK)!.unbound?.reason).toBe(VT_COPY.etsyOwnFromAttribute)
  })

  it('Shopify: none offered and a stored one refused until P3b, so a publish can never drop it silently', () => {
    const cell = resolveVariationProjection(input('SHOPIFY', { listing: mappedListing([{ axisKey: 'Colore', target: 'Color' }, { axisKey: FIT, target: 'Fit' }]) }))
    expect(cell.ownNames).toEqual({ allowed: false, maxLength: 255, reason: VT_COPY.ownNotYet('Shopify') })
    expect(cell.axes.find(a => a.familyKey === FIT)!.unbound?.reason).toBe(VT_COPY.ownNotYet('Shopify'))
  })

  it('Amazon: the theme decides — no own names, and a stored channel-only key is not read as a theme segment', () => {
    const plain = resolveVariationProjection(input('AMAZON'))
    const stored = resolveVariationProjection(input('AMAZON', { listing: mappedListing([{ axisKey: 'Colore', target: 'color' }, { axisKey: FIT, target: 'Fit' }]) }))
    expect(plain.ownNames).toEqual({ allowed: false, maxLength: null, reason: VT_COPY.amazonOwnAxes })
    expect(plain.ownCandidates).toEqual([])
    expect(stored.axes.some(a => a.familyKey === FIT)).toBe(false)
  })
})

describe('A1 review — keys spelled differently by two builders, and a refused axis at publish', () => {
  it('a channel column read tolerates a spelling difference, exactly as the family axes\' reader does', () => {
    expect(ownAxisValue({ from: 'channel', field: 'item_type_name' }, { itemTypeName: { value: 'Giacca' } }, null)).toBe('Giacca')
    expect(ownAxisValue({ from: 'channel', field: 'scollatura' }, { scollatura: { value: 'V' }, Scollatura: { value: 'other' } }, null)).toBe('V')
  })

  it('the resolver finds the aspect when the sheet spells its column differently', () => {
    const ebay = { ...EBAY, aspects: EBAY.aspects.map(a => a.name === 'Scollatura' ? { ...a, columnKey: 'Scollatura' } : a) }
    const axis = resolveVariationProjection(input('EBAY', { schema: { ebay }, listing: ebayListing(['Colore', NECK], { [NECK]: 'Scollatura' }) })).axes.find(a => a.familyKey === NECK)!
    expect(axis.unbound).toBeUndefined()
  })

  it('a refused channel-only axis is a readiness ERROR on eBay (publish stops), with its own reason', () => {
    const cell = resolveVariationProjection(input('EBAY', { listing: ebayListing(['Colore', FIT], { [FIT]: 'Marca' }) }))
    const items = variationReadinessItems(cell, 'EBAY IT').filter(i => i.kind === 'attribute-unbound')
    expect(items).toEqual([expect.objectContaining({ severity: 'error', message: `Marca on EBAY IT: ${VT_COPY.ebayNotForVariations('Marca')}` })])
  })
})

