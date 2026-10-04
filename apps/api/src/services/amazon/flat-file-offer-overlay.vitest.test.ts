/**
 * Amazon sheet gaps U4b — the old flat-file page reads and writes the SAME offer facts as the sheet and the jobs:
 * its rows show the live values of the new stores (`readAmazonOfferFacts(…, 'job')`, never a draft), and its save
 * writes min/max/MAP price, the offer window, the Automate Pricing rule, handling time, restock date and always
 * available into those stores (`amazonOfferLivePath`), not only into its snapshot. Pure: no database.
 */
import { describe, expect, it } from 'vitest'
import { applySnapshotOverlay, flatFileOfferCells, withFlatFileOfferStores } from './flat-file.service.js'

const IT = 'APJ6JRA9NG5V4'
const MIN = 'purchasable_offer__minimum_seller_allowed_price__schedule__value_with_tax'
const MAX = 'purchasable_offer__maximum_seller_allowed_price__schedule__value_with_tax'
const MAP = 'purchasable_offer__map_price__schedule__value_with_tax'
const START = 'purchasable_offer__start_at'
const END = 'purchasable_offer__end_at'
const RULE = 'purchasable_offer__automated_pricing_merchandising_rule_plan__merchandising_rule__rule_id'
const LEAD = 'fulfillment_availability__lead_time_to_ship_max_days'
const RESTOCK = 'fulfillment_availability__restock_date'
const ALWAYS = 'fulfillment_availability__is_inventory_available'
const CODE = 'fulfillment_availability__fulfillment_channel_code'

const DRAFT = { v: 1, leaves: { minimum_seller_allowed_price: { value: 35, base: 30, savedAt: '2026-10-01T00:00:00Z', savedBy: 'u' } } }
const listing = (platformAttributes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ marketplace: 'IT', fulfillmentMethod: null, flatFileSnapshot: null, platformAttributes, ...extra })

describe('rows show the live facts (the overlay)', () => {
  const pa = {
    amazonOffer: { minimum_seller_allowed_price: 30, map_price: null },
    amazonFulfillment: { restock_date: '2026-11-01' },
    amazonOfferDraft: DRAFT,
    attributes: {
      purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 60 }] }], start_at: { value: '2026-10-01' } }],
      fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 2, is_inventory_available: false }],
    },
  }

  it('each cell holds the job lane value: live store first, then Amazon\'s report; a draft never shows; cleared = blank', () => {
    expect(flatFileOfferCells(listing(pa))).toEqual({
      [MIN]: '30',            // live store (the draft's 35 waits for Publish)
      [MAX]: '60',            // Amazon's report
      [MAP]: '',              // cleared in Nexus
      [START]: '2026-10-01',
      [LEAD]: '2',
      [RESTOCK]: '2026-11-01',
      [ALWAYS]: 'false',
    })
  })

  it('the snapshot row takes the live cells over its own text; a cell nobody holds keeps the snapshot; a label code reads as its code', () => {
    const snapshot = { item_sku: 'S', [MIN]: '25', [MAP]: '45', [END]: '2026-12-31', [RESTOCK]: '2026-01-01', [CODE]: 'Gestito dal venditore (default)' }
    const liveRow = { item_sku: 'S', _rowId: 'p', _listingId: 'l' } as never
    const row = applySnapshotOverlay(snapshot, liveRow, {}, flatFileOfferCells(listing(pa)))
    expect(row[MIN]).toBe('30')
    expect(row[MAP]).toBe('')
    expect(row[END]).toBe('2026-12-31')
    expect(row[RESTOCK]).toBe('2026-11-01')
    expect(row[CODE]).toBe('DEFAULT')
  })

  it('an unknown label is left as typed (never guessed); a label naming Amazon\'s logistics reads as FBA and hides the quantity', () => {
    const liveRow = { item_sku: 'S', fulfillment_availability__quantity: '4' } as never
    expect(applySnapshotOverlay({ [CODE]: 'Versand ???' }, liveRow)[CODE]).toBe('Versand ???')
    const fba = applySnapshotOverlay({ [CODE]: 'Logistica di Amazon (UE)', fulfillment_availability__quantity: '4' }, liveRow)
    expect(fba[CODE]).toBe('AMAZON_EU')
    expect(fba.fulfillment_availability__quantity).toBe('')
  })
})

describe('the save writes the live stores', () => {
  const previous = {
    amazonOffer: { map_price: 40, maximum_seller_allowed_price: 60 },
    amazonFulfillment: { lead_time_to_ship_max_days: 2 },
    amazonOfferDraft: DRAFT,
    _amazonMediaWorkspace: { slots: ['a'] },
    attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] },
  }
  // What buildPlatformAttributes hands over: the previous bag with the row's attributes.
  const bag = () => ({ ...previous, attributes: { item_name: [{ value: 'x' }] } })
  const labels = { 'fulfillment_availability.is_inventory_available': { Abilitato: 'true', Disabilitato: 'false' } }

  it('an FBM row: every offer and fulfilment cell lands in its store; drafts and other keys are untouched', () => {
    const row = {
      [CODE]: 'DEFAULT', [MIN]: '32,50', [MAX]: '60', [MAP]: '', [START]: '2026-10-05', [END]: '2026-12-31', [RULE]: 'R-9',
      [LEAD]: '4', [RESTOCK]: '2026-11-01', [ALWAYS]: 'Abilitato',
    }
    const out = withFlatFileOfferStores(bag(), row, { listing: listing(previous), isParent: false, enumCodeMap: labels })
    expect(out.amazonOffer).toEqual({
      minimum_seller_allowed_price: 32.5, maximum_seller_allowed_price: 60, map_price: null, // cleared: the store held 40
      start_at: '2026-10-05', end_at: '2026-12-31', automated_pricing_rule_id: 'R-9',
    })
    expect(out.amazonFulfillment).toEqual({ lead_time_to_ship_max_days: 4, restock_date: '2026-11-01', is_inventory_available: true })
    expect(out.amazonOfferDraft).toBe(DRAFT)
    expect(out._amazonMediaWorkspace).toEqual({ slots: ['a'] })
    expect(out.attributes).toEqual({ item_name: [{ value: 'x' }] })
  })

  it('an FBA row: the fulfilment cells are kept as they are (FBM only); offer cells still save', () => {
    const row = { [CODE]: 'AMAZON_EU', [MIN]: '30', [LEAD]: '9', [RESTOCK]: '2026-11-01', [ALWAYS]: 'true' }
    const out = withFlatFileOfferStores(bag(), row, { listing: listing(previous), isParent: false })
    expect(out.amazonFulfillment).toEqual({ lead_time_to_ship_max_days: 2 })
    expect(out.amazonOffer).toEqual({ map_price: 40, maximum_seller_allowed_price: 60, minimum_seller_allowed_price: 30 })
  })

  it('a DEFAULT row on a listing with FBA evidence is FBA too (fail-closed)', () => {
    const fbaListing = listing({ ...previous, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] })
    const out = withFlatFileOfferStores(bag(), { [CODE]: 'DEFAULT', [LEAD]: '9' }, { listing: fbaListing, isParent: false })
    expect(out.amazonFulfillment).toEqual({ lead_time_to_ship_max_days: 2 })
  })

  it('a parent row writes nothing', () => {
    const out = withFlatFileOfferStores(bag(), { [CODE]: 'DEFAULT', [MIN]: '30', [LEAD]: '9' }, { listing: listing(previous), isParent: true })
    expect(out.amazonOffer).toEqual(previous.amazonOffer)
    expect(out.amazonFulfillment).toEqual(previous.amazonFulfillment)
  })

  it('a blank cell clears only a value the store holds; a value Amazon would refuse is not saved', () => {
    const out = withFlatFileOfferStores(bag(), { [CODE]: 'DEFAULT', [MIN]: '', [MAX]: '', [LEAD]: '200', [RESTOCK]: 'soon' }, { listing: listing(previous), isParent: false })
    expect(out.amazonOffer).toEqual({ map_price: 40, maximum_seller_allowed_price: null })
    expect(out.amazonFulfillment).toEqual({ lead_time_to_ship_max_days: 2 })
  })

  it('a snapshot value nobody holds and nobody edited stays in the snapshot; an edit is saved', () => {
    const stale = listing({}, { flatFileSnapshot: { [MIN]: '25', [END]: '2026-12-31' } })
    const out = withFlatFileOfferStores({ attributes: {} }, { [CODE]: 'DEFAULT', [MIN]: '25', [END]: '2027-01-31' }, { listing: stale, isParent: false })
    expect(out.amazonOffer).toEqual({ end_at: '2027-01-31' })
  })

  it('a value only Amazon reports is promoted to the store (the save replaces the report it came from)', () => {
    const reported = listing({ attributes: { purchasable_offer: [{ marketplace_id: IT, minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 28 }] }] }] } },
      { flatFileSnapshot: { [MIN]: '28' } })
    const out = withFlatFileOfferStores({ attributes: {} }, { [CODE]: 'DEFAULT', [MIN]: '28' }, { listing: reported, isParent: false })
    expect(out.amazonOffer).toEqual({ minimum_seller_allowed_price: 28 })
  })

  it('a new listing (no previous row) saves what the row holds', () => {
    const out = withFlatFileOfferStores({ attributes: {} }, { [CODE]: 'DEFAULT', [MAP]: '45', [LEAD]: '1' }, { listing: null, isParent: false })
    expect(out.amazonOffer).toEqual({ map_price: 45 })
    expect(out.amazonFulfillment).toEqual({ lead_time_to_ship_max_days: 1 })
  })
})
