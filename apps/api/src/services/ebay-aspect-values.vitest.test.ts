import { describe, expect, it, vi } from 'vitest'
// The builder's module reaches the database for its other exports; the pure builder below does not.
vi.mock('./ebay-presentation-consumer.service.js', () => ({ assertLegacyPresentationPublishAllowed: vi.fn(async () => undefined) }))
vi.mock('./pim/publish-review-gate.js', () => ({ assertListingContentReviewed: vi.fn(async () => undefined) }))
vi.mock('../db.js', () => ({ default: {} }))
import { EBAY_ASPECT_VALUE_MAX, ebayAspectValues } from './ebay-aspect-values.js'
import { buildSharedListingInput } from './ebay-shared-listing-push.service.js'
import { validateChannelValue } from './pim/mapping/validate-channel-value.js'

/**
 * P1 of fix/product-sheet-editing — what eBay receives for one item specific, from ONE function the publisher and the
 * verdict share. Report 3 I-3.2: every list-valued item specific (Chiusura, Caratteristiche, Protezione, Adatto a) was
 * left out of what is sent, because the builder skipped any value that was not a string.
 */
describe('ebayAspectValues', () => {
  it('sends each member of a list, trimmed, without blanks or duplicates', () => {
    expect(ebayAspectValues([' Uomo ', 'Donna', '', 'Uomo', null])).toEqual(['Uomo', 'Donna'])
  })
  it('splits a legacy joined value over 65 characters at commas (Incident #26); a shorter one stays one value', () => {
    const joined = 'Ventilato, Impermeabile, Imbottitura rimovibile, Leggero, Resistente all\'abrasione'
    expect(joined.length).toBeGreaterThan(EBAY_ASPECT_VALUE_MAX)
    expect(ebayAspectValues(joined)).toEqual(['Ventilato', 'Impermeabile', 'Imbottitura rimovibile', 'Leggero', 'Resistente all\'abrasione'])
    expect(ebayAspectValues('Poliestere, Nylon')).toEqual(['Poliestere, Nylon'])
    expect(ebayAspectValues([joined])).toHaveLength(5)
  })
  it('a number is a value; an object is not an item-specific value', () => {
    expect(ebayAspectValues(1)).toEqual(['1'])
    expect(ebayAspectValues({ value: 2 })).toEqual([])
  })
})

describe('buildSharedListingInput sends list-valued item specifics', () => {
  const parent = { sku: 'FAM', title: 'T', category_id: '1', aspect_Chiusura: ['Cerniera'], aspect_Caratteristiche: ['Ventilato', 'Impermeabile'], aspect_Marca: 'Xavia', aspect_Vuoto: [] }
  const variants = [{ sku: 'FAM-M', it_price: 10, it_qty: 1, aspect_Taglia: 'M', aspect_Genere: ['Uomo'] }, { sku: 'FAM-L', it_price: 10, it_qty: 1, aspect_Taglia: 'L' }]
  const built = buildSharedListingInput(parent, variants, 'IT', undefined, undefined, 'EUR')
  it('a one-member list is one value, a longer list several, a string stays a string; an empty list sends nothing', () => {
    expect(built.itemSpecifics).toMatchObject({ Chiusura: 'Cerniera', Caratteristiche: ['Ventilato', 'Impermeabile'], Marca: 'Xavia', Genere: 'Uomo' })
    expect(built.itemSpecifics).not.toHaveProperty('Vuoto')
  })
  it('control: the axis stays a variation specific, not a listing-level one', () => {
    expect(built.variationSpecificNames).toEqual(['Taglia'])
    expect(built.itemSpecifics).not.toHaveProperty('Taglia')
  })
})

describe('the verdict measures an item specific as eBay receives it (report 3 I-3.9)', () => {
  const aspect = (extra: Record<string, unknown>) => ({ fieldKey: 'f', label: 'Features', options: null, selectionOnly: false, maxLength: 65, maxBytes: null, priority: 'optional',
    channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Caratteristiche'] }, ...extra }) as never
  it('one value over 65 characters is a length finding (blocks at publish)', () => {
    expect(validateChannelValue(aspect({ shape: 'list' }), ['x'.repeat(70)]).findings.map(f => f.rule)).toEqual(['length'])
  })
  it('a joined list over 65 characters is judged as the parts eBay receives: no finding', () => {
    expect(validateChannelValue(aspect({ shape: 'list' }), ['Ventilato, Impermeabile, Imbottitura rimovibile, Leggero, Resistente all\'abrasione']).findings).toEqual([])
  })
  it('a SINGLE aspect holding a joined list would send several values: a count finding', () => {
    expect(validateChannelValue(aspect({ shape: 'scalar' }), 'Ventilato, Impermeabile, Imbottitura rimovibile, Leggero, Resistente all\'abrasione').findings.map(f => f.rule)).toEqual(['count'])
  })
  it('control: a field outside item specifics keeps measuring its raw text', () => {
    expect(validateChannelValue(aspect({ shape: 'list', channelStore: { kind: 'platformAttributes', path: ['subtitle'] } }), ['a, '.repeat(30)]).findings.map(f => f.rule)).toEqual(['length'])
  })
})
