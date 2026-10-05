/**
 * E1 (2026-10-04) — the eBay listing fields the sheet offers say what publish sends:
 *   · Listing format offers fixed price only (publish refuses anything else); a stored AUCTION shows off the list;
 *   · Package type is eBay's closed list, the SAME list publish knows (`ebay-packages.ts`); '' is blank;
 *   · Max per buyer is a column (publish sent the stored value with no cell to see it).
 */
import { describe, expect, it } from 'vitest'
import { EBAY_HELD_REASONS, ebaySpecFromCache } from './ebay.js'
import { EBAY_PACKAGE_TYPES, EBAY_TRADING_PACKAGES } from '../ebay-packages.js'
import { EBAY_FIXED_VALUES, normalizeEbayListingValue } from '../ebay-listing-values.js'
import { buildSheetColumns } from '../sheet-columns.service.js'
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

// Wave 2 (2026-10-05) — the columns Publish fixes or does not use are read-only on the sheet, with the reason.
describe('held columns (wave 2: duration, handling time, Shared-SKU switch)', () => {
  const coordinate = { channel: 'EBAY' as const, marketplace: 'IT', label: 'eBay · IT', inMarket: true }
  const column = (key: string) => buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    .columns.find(c => c.channels?.[coordinate.label]?.key === key)!
  it.each([
    ['listingDuration', 'eBay fixed-price listings run until cancelled. Publish always sends GTC.'],
    ['handlingTime', 'eBay takes the handling time from the listing\'s shipping policy. Change it in that policy on eBay.'],
    ['sharedSkuListing', 'Publish here does not use this. It only steered the old eBay flat-file page. To sell the same SKUs on another eBay listing, add a listing alias.'],
  ])('%s: read-only, and the column says why', (key, reason) => {
    expect(field(key).editHeldReason).toBe(reason)
    expect(column(key)).toMatchObject({ editable: false, formulaWritable: false, helpText: reason })
  })
  it('the duration offers GTC only; the cell shows GTC and the handling time cell is blank, whatever is stored', () => {
    expect(field('listingDuration')).toMatchObject({ mode: 'strict', options: ['GTC'] })
    expect(EBAY_FIXED_VALUES).toEqual({ listingDuration: 'GTC', handlingTime: null })
    // Every fixed value belongs to a held column (an editable cell showing a fixed value would ignore the edit).
    for (const key of Object.keys(EBAY_FIXED_VALUES)) expect(field(key).editHeldReason).toBe(EBAY_HELD_REASONS[key as keyof typeof EBAY_HELD_REASONS])
  })
  it('positive control: Max per buyer and VAT stay editable', () => {
    expect(column('quantityLimitPerBuyer').editable).toBe(true)
    expect(column('vatRate').editable).toBe(true)
  })
})

// Wave 2 (Owner decision 8) — every listing setting kept in the listing's own bag says what a BLANK cell does at Publish.
// Item specifics follow their own rule (blank sends none), a held column gives its reason instead, and the photos column
// is the Media page's (not a setting).
describe('"Blank:" sentences', () => {
  const settings = spec.fields.filter(f => f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] !== 'itemSpecifics')
  it('every listing setting stored in platformAttributes has one', () => {
    const missing = settings.filter(f => !f.editHeldReason && f.key !== 'imageUrls' && !/(^| )Blank: /.test(f.helpText ?? '')).map(f => f.key)
    expect(missing).toEqual([])
    expect(settings.length).toBeGreaterThan(20)
  })
  it('a held column has none: its reason is the column\'s help', () => {
    expect(settings.filter(f => f.editHeldReason).map(f => [f.key, f.helpText])).toEqual([['listingDuration', undefined], ['handlingTime', undefined], ['sharedSkuListing', undefined]])
  })
  it('the wording decided for policies, location and the other settings', () => {
    for (const key of ['paymentPolicyId', 'returnPolicyId', 'fulfillmentPolicyId']) expect(field(key).helpText).toBe('Blank: Publish uses this eBay account\'s default policy.')
    for (const key of ['itemLocationCountry', 'itemLocation', 'itemPostalCode']) expect(field(key).helpText).toMatch(/Blank: Publish uses the eBay account's location\. A live listing keeps eBay's, unless a Full update sends the account's\.$/)
    for (const key of ['bestOffer', 'vatRate', 'packageType', 'packageWeight', 'videoId']) expect(field(key).helpText).toMatch(/Blank: Publish sends none\. A live listing keeps eBay's value\.$/)
  })
  it('Max per buyer says it is true for an Inventory listing too (its photo publish sends it)', () => {
    expect(field('quantityLimitPerBuyer').helpText).toBe('The most units one buyer may buy from this listing: a whole number, 1 or more. Publish sends it (an eBay Inventory listing gets it when its photos are published). Blank: no limit is sent, and a live listing keeps the limit eBay holds.')
  })
})
