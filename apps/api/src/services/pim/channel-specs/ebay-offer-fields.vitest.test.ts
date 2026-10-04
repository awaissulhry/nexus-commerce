/**
 * E1 (2026-10-04) — the eBay listing fields the sheet offers say what publish sends:
 *   · Listing format offers fixed price only (publish refuses anything else); a stored AUCTION shows off the list;
 *   · Package type is eBay's closed list, the SAME list publish knows (`ebay-packages.ts`); '' is blank;
 *   · Max per buyer is a column (publish sent the stored value with no cell to see it).
 */
import { describe, expect, it } from 'vitest'
import { ebaySpecFromCache } from './ebay.js'
import { EBAY_PACKAGE_TYPES, EBAY_TRADING_PACKAGES } from '../ebay-packages.js'
import { normalizeEbayListingValue } from '../ebay-listing-values.js'
import { validateChannelValue } from '../mapping/validate-channel-value.js'
import type { CatalogueField } from '../mapping/field-catalogue.service.js'
import { publishVerdict } from '../value-verdict.js'
import { ebayFieldLabel } from '../studio-publication-ebay-problems.js'

const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] })
const field = (key: string) => spec.fields.find(f => f.key === key)!
/** The catalogue field the verdict reads, as the field catalogue builds it from the spec (`selectionOnly` = strict). */
const catalogue = (key: string) => {
  const f = field(key)
  return { fieldKey: f.key, label: f.englishLabel ?? f.label, kind: f.kind, shape: f.shape, cardinality: f.cardinality, options: f.options ?? null,
    optionLabels: f.optionLabels ?? null, selectionOnly: f.mode === 'strict', priority: 'optional', channelStore: f.channelStore, maxLength: null, maxBytes: null } as unknown as CatalogueField
}

describe('Listing format', () => {
  it('offers fixed price only', () => {
    expect(field('listingFormat')).toMatchObject({ mode: 'strict', options: ['FIXED_PRICE'] })
  })
  it('a stored AUCTION shows off the list, a warning at publish (publish itself still refuses it with its reason)', () => {
    const checked = validateChannelValue(catalogue('listingFormat'), 'AUCTION')
    expect(checked.findings.map(f => f.rule)).toEqual(['offList'])
    expect(publishVerdict('EBAY', checked.findings[0])).toBe('warn')
  })
})

describe('Package type', () => {
  it('is strict, with exactly the list publish knows', () => {
    expect(field('packageType')).toMatchObject({ mode: 'strict', options: [...EBAY_PACKAGE_TYPES] })
    expect(EBAY_PACKAGE_TYPES).toEqual(Object.keys(EBAY_TRADING_PACKAGES))
    expect(EBAY_PACKAGE_TYPES).toHaveLength(29)
  })
  it.each(['', null, undefined])('a blank value (%j) is not off the list: no finding, no refusal', (value) => {
    expect(validateChannelValue(catalogue('packageType'), value).findings).toEqual([])
    expect(normalizeEbayListingValue('packageType', value)).toBe(value)
  })
  it('a code on the list has no finding; a type eBay does not know is off the list', () => {
    expect(validateChannelValue(catalogue('packageType'), 'PACKAGE_THICK_ENVELOPE').findings).toEqual([])
    expect(validateChannelValue(catalogue('packageType'), 'SHOEBOX').findings.map(f => f.rule)).toEqual(['offList'])
  })
  it('a type stored as eBay Trading\'s name, or in another case, reads as the sheet\'s code', () => {
    expect(normalizeEbayListingValue('packageType', 'PackageThickEnvelope')).toBe('PACKAGE_THICK_ENVELOPE')
    expect(normalizeEbayListingValue('packageType', 'MailingBoxes')).toBe('MAILING_BOX')
    expect(normalizeEbayListingValue('packageType', 'mailing_box')).toBe('MAILING_BOX')
    expect(normalizeEbayListingValue('packageType', 'SHOEBOX')).toBe('SHOEBOX')
  })
})

describe('Max per buyer', () => {
  it('is an offer column, a number, with the label the review uses', () => {
    expect(field('quantityLimitPerBuyer')).toMatchObject({ kind: 'number', englishLabel: 'Max per buyer', channelStore: { kind: 'platformAttributes', path: ['quantityLimitPerBuyer'] } })
    expect(field('quantityLimitPerBuyer').group?.key).toBe('offer')
    expect(ebayFieldLabel('quantityLimitPerBuyer')).toBe('Max per buyer')
  })
  it('a blank value (null, as every live listing holds) has no finding', () => {
    expect(validateChannelValue(catalogue('quantityLimitPerBuyer'), null).findings).toEqual([])
  })
})
