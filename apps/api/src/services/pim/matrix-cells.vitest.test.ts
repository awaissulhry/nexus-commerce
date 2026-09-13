/**
 * MX.1 — the Matrix read's PURE rules, pinned without a database.
 *
 * The writable cases are the SAME cases the web fixture test runs (`_studio/matrix/matrix.vitest.test.ts`: an
 * FBA row has no writable inventory cell and every refusal is named `Amazon-managed`; the parent writes nothing
 * but price; a pinned row's buffer is held) plus the two only the live read can know (a missing
 * `products.price.edit` holds the price cells; a CLOSED offer holds the inventory lane). The listing-state
 * TABLE is asserted row by row in its precedence order; the queue fold's ranking and the PAUSED/FBA overrides
 * are asserted with a positive control beside every negative.
 */
import { describe, expect, it } from 'vitest'
import { MATRIX_COPY, type SyncCell } from '@nexus/shared/matrix-contract'
import {
  channelRank, channelShape, circled, compareMarkets, deriveFulfilment, foldQueue, listingStateOf, priceCellOf,
  reportedFulfilment, syncCellOf, withoutInventory, writableFor, FORMULA_REASON, PARENT_PRICE_REASON, PARENT_REASON, PINNED_BUFFER_REASON, PRICE_PERMISSION_REASON,
} from './matrix-cells.js'
import { businessAbsence, flattenAudience } from './matrix-cells.js'

const facts = (over: Partial<Parameters<typeof listingStateOf>[0]> = {}) => ({
  listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0X', offerClosedAt: null, suppressed: false, excluded: false, needsValue: false, ...over,
})

describe('listing state — the table, in precedence order', () => {
  it.each([
    ['excluded beats everything', facts({ excluded: true, offerClosedAt: new Date(), suppressed: true }), 'excluded', null],
    ['a closed offer beats a suppression', facts({ offerClosedAt: new Date(), suppressed: true }), 'closed', null],
    ['an open suppression beats ENDED', facts({ suppressed: true, listingStatus: 'ENDED' }), 'suppressed', null],
    ['ENDED', facts({ listingStatus: 'ENDED' }), 'ended', null],
    ['REMOVED reads as ended', facts({ listingStatus: 'REMOVED' }), 'ended', null],
    ['ERROR', facts({ listingStatus: 'ERROR' }), 'error', null],
    ['a variant missing an axis value', facts({ needsValue: true }), 'needs-value', null],
    ['DISCOVERABLE is listed and not buyable — Amazon\'s own meaning', facts({ listingStatus: 'DISCOVERABLE' }), 'listed', 'not buyable'],
    ['INACTIVE is listed with the detail', facts({ listingStatus: 'INACTIVE' }), 'listed', 'inactive'],
    ['ACTIVE', facts(), 'listed', null],
    ['BUYABLE', facts({ listingStatus: 'BUYABLE' }), 'listed', null],
    ['an external id with an unknown status is listed', facts({ listingStatus: 'WHATEVER' }), 'listed', null],
    ['DRAFT without an external id', facts({ listingStatus: 'DRAFT', externalListingId: null }), 'draft', null],
  ])('%s', (_name, f, state, detail) => {
    expect(listingStateOf(f)).toMatchObject({ state, detail })
  })
  it('carries isPublished and the external id verbatim', () => {
    expect(listingStateOf(facts({ isPublished: false }))).toMatchObject({ published: false, externalId: 'B0X' })
  })
})

describe('queue fold — the worst of the two lanes, paused and FBA overrides', () => {
  const row = (syncType: string, syncStatus: string, over: Partial<{ isDead: boolean; errorMessage: string | null; at: string | null }> = {}) =>
    ({ syncType, syncStatus, isDead: false, errorMessage: null, at: '2026-09-13T05:00:00.000Z', ...over })
  const follow: SyncCell = { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 5, held: 5, buffer: 0, poolAvailable: 5, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }
  it('ranks dead > failed > sending > queued > sent, and reports the failure sentence verbatim', () => {
    expect(foldQueue([row('QUANTITY_UPDATE', 'SUCCESS'), row('PRICE_UPDATE', 'FAILED', { errorMessage: 'eBay: 25002' })], follow)).toMatchObject({ state: 'failed', reason: 'eBay: 25002', syncType: 'PRICE_UPDATE' })
    expect(foldQueue([row('QUANTITY_UPDATE', 'FAILED', { isDead: true, errorMessage: 'MAX_RETRIES_EXCEEDED' }), row('PRICE_UPDATE', 'FAILED')], follow)).toMatchObject({ state: 'dead', syncType: 'QUANTITY_UPDATE' })
    expect(foldQueue([row('QUANTITY_UPDATE', 'IN_PROGRESS'), row('PRICE_UPDATE', 'PENDING')], follow).state).toBe('sending')
    expect(foldQueue([row('QUANTITY_UPDATE', 'PENDING')], follow).state).toBe('queued')
    expect(foldQueue([row('QUANTITY_UPDATE', 'SUCCESS')], follow)).toMatchObject({ state: 'sent', reason: null })
    expect(foldQueue([], follow)).toMatchObject({ state: 'never', at: null, syncType: null })
  })
  it('a SKIPPED row reached no channel: an honest non-success with the server\'s sentence', () => {
    expect(foldQueue([row('QUANTITY_UPDATE', 'SKIPPED', { errorMessage: 'NEXUS_ENABLE_AMAZON_PUBLISH=false' })], follow)).toMatchObject({ state: 'failed', reason: 'NEXUS_ENABLE_AMAZON_PUBLISH=false' })
  })
  it('a PAUSED verdict wins outright and names the lever; an FBA row ignores its quantity lane', () => {
    expect(foldQueue([row('QUANTITY_UPDATE', 'FAILED')], { ...follow, kind: 'PAUSED', via: 'POLICY' })).toEqual({ state: 'paused', at: null, reason: null, syncType: null, via: 'POLICY' })
    const fba: SyncCell = { ...follow, kind: 'FBA_EXCLUDED', intended: null }
    expect(foldQueue([row('QUANTITY_UPDATE', 'FAILED')], fba).state).toBe('never')
    /* positive control: the price lane still speaks on an FBA row */
    expect(foldQueue([row('QUANTITY_UPDATE', 'FAILED'), row('PRICE_UPDATE', 'SUCCESS')], fba)).toMatchObject({ state: 'sent', syncType: 'PRICE_UPDATE' })
  })
})

describe('writable — the fixture\'s rules, plus the two the live read can know', () => {
  const sync = (over: Partial<SyncCell>): SyncCell => ({ kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 9, held: 9, buffer: 0, poolAvailable: 9, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false, ...over })
  const all = ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice'] as const
  const price = { value: 10, currency: 'EUR', source: 'master' as const, formula: null, clamped: null }
  it('an FBA row is Amazon-managed: no writable inventory cell, every refusal named; fulfilment stays open', () => {
    const g = writableFor({ role: 'variant', cells: all, sync: sync({ kind: 'FBA_EXCLUDED', intended: null }), fulfilment: { method: 'FBA', guard: 'FBA' }, price, canEditPrice: true })
    for (const k of ['syncMode', 'syncQty', 'syncBuffer'] as const) { expect(g.writable[k]).toBe(false); expect(g.writeBlockedReason[k]).toBe(MATRIX_COPY.amazonManaged) }
    expect(g.writable.fulfilment).toBe(true); expect(g.writable.price).toBe(true); expect(g.writable.listing).toBeUndefined()
  })
  it('a stored FBM under an FBA guard is held with the GUARD\'s sentence, not a lock', () => {
    const g = writableFor({ role: 'variant', cells: all, sync: sync({ kind: 'FBA_EXCLUDED', intended: null }), fulfilment: { method: 'FBM', guard: 'FBA' }, price, canEditPrice: true })
    expect(g.writeBlockedReason.syncQty).toBe(MATRIX_COPY.guardFba)
  })
  it('the parent row writes NOTHING — inventory held with the parent sentence, price held with the not-buyable sentence', () => {
    const g = writableFor({ role: 'parent', cells: all, sync: null, fulfilment: null, price, canEditPrice: true })
    expect(g.writable).toEqual({ fulfilment: false, syncMode: false, syncQty: false, syncBuffer: false, price: false, salePrice: false })
    expect(g.writeBlockedReason.syncQty).toBe(PARENT_REASON); expect(g.writeBlockedReason.price).toBe(PARENT_PRICE_REASON); expect(g.writeBlockedReason.salePrice).toBe(PARENT_PRICE_REASON)
  })
  it('a pinned row\'s buffer is held; a formula holds the price; a missing products.price.edit holds both price cells', () => {
    expect(writableFor({ role: 'variant', cells: all, sync: sync({ kind: 'PINNED', mode: 'PINNED' }), fulfilment: null, price, canEditPrice: true }).writeBlockedReason.syncBuffer).toBe(PINNED_BUFFER_REASON)
    expect(writableFor({ role: 'variant', cells: all, sync: sync({}), fulfilment: null, price: { ...price, source: 'formula', formula: '= $basePrice * 0.95' }, canEditPrice: true }).writeBlockedReason.price).toBe(FORMULA_REASON)
    const g = writableFor({ role: 'variant', cells: all, sync: sync({}), fulfilment: null, price, canEditPrice: false })
    expect(g.writeBlockedReason.price).toBe(PRICE_PERMISSION_REASON); expect(g.writeBlockedReason.salePrice).toBe(PRICE_PERMISSION_REASON)
    expect(g.writable.syncQty).toBe(true) // positive control: the inventory lane is untouched by the price permission
  })
  it('a CLOSED offer holds the whole inventory lane with the Sync Control pointer', () => {
    const g = writableFor({ role: 'variant', cells: all, sync: sync({ kind: 'CLOSED', intended: null }), fulfilment: { method: 'FBM', guard: 'FBM' }, price, canEditPrice: true })
    for (const k of ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer'] as const) expect(g.writeBlockedReason[k]).toBe(MATRIX_COPY.closedHint)
    expect(g.writable.price).toBe(true)
  })
})

describe('sync, price, fulfilment and coordinate helpers', () => {
  it('syncCellOf carries the resolver verdict verbatim and derives oversold from the publishable ceiling', () => {
    const c = syncCellOf({ kind: 'FOLLOW', quantity: 7, routedAvailable: 9, routedLocations: ['IT-MAIN'] }, { followMasterQuantity: true, held: 12, buffer: 2, routed: [{ locationCode: 'IT-MAIN', available: 9 }], fbaAtAmazon: null, publishable: 7 })
    expect(c).toMatchObject({ kind: 'FOLLOW', mode: 'FOLLOW', intended: 7, held: 12, buffer: 2, poolAvailable: 9, routedLocations: ['IT-MAIN'], oversold: true })
    expect(syncCellOf({ kind: 'PAUSED', via: 'LISTING' }, { followMasterQuantity: false, held: 3, buffer: 0, routed: [], fbaAtAmazon: null, publishable: 0 })).toMatchObject({ kind: 'PAUSED', via: 'LISTING', mode: 'PINNED', intended: null, poolAvailable: null, oversold: true })
    expect(syncCellOf({ kind: 'FBA_EXCLUDED' }, { followMasterQuantity: true, held: 50, buffer: 0, routed: [], fbaAtAmazon: 49, publishable: null }).oversold).toBe(false)
  })
  it('priceCellOf: the push number first, the base price only on a master-following row, the formula owns its cell', () => {
    expect(priceCellOf({ price: null, priceOverride: null, followMasterPrice: true, basePrice: 105, currency: 'EUR', formula: null, clamped: null })).toMatchObject({ value: 105, source: 'master' })
    expect(priceCellOf({ price: 99, priceOverride: 99, followMasterPrice: false, basePrice: 105, currency: 'EUR', formula: null, clamped: 'floor' })).toMatchObject({ value: 99, source: 'override', clamped: 'floor' })
    expect(priceCellOf({ price: 99.75, priceOverride: null, followMasterPrice: false, basePrice: 105, currency: 'GBP', formula: '= $basePrice * 0.95', clamped: null })).toMatchObject({ value: 99.75, source: 'formula', currency: 'GBP' })
  })
  it('fulfilment derivation is the route\'s own, and the reported channel comes only from the nested pull key', () => {
    expect(deriveFulfilment('EBAY', 'AFN', 'FBA')).toBe('FBM')
    expect(deriveFulfilment('AMAZON', 'AFN', null)).toBe('FBA'); expect(deriveFulfilment('AMAZON', 'MFN', 'FBA')).toBe('FBM')
    expect(deriveFulfilment('AMAZON', undefined, 'FBA')).toBe('FBA'); expect(deriveFulfilment('AMAZON', undefined, null)).toBe('FBM')
    expect(reportedFulfilment({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] })).toBe('AFN')
    expect(reportedFulfilment({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] })).toBe('MFN')
    expect(reportedFulfilment({ fulfillmentChannel: 'AFN' })).toBeNull() // the flat key is the operator's own mirror, never Amazon's report
  })
  it('coordinate shape: eBay has no sale, the global channels have no fulfilment, an EU market carries no inventory kinds', () => {
    expect(channelShape('EBAY').absent).toEqual([{ cell: 'salePrice', reason: MATRIX_COPY.absentSaleEbay }])
    expect(channelShape('SHOPIFY').absent.map((a) => a.cell)).toEqual(['fulfilment']); expect(channelShape('SHOPIFY').fulfilment).toBeNull()
    expect(withoutInventory(channelShape('AMAZON').cells)).toEqual(['listing', 'price', 'salePrice'])
    expect(['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE', 'OTHER'].map(channelRank)).toEqual([0, 1, 2, 3, 4, 5])
    expect(['ES', 'UK', 'DE', 'IT', 'ZZ', 'FR'].sort(compareMarkets)).toEqual(['IT', 'DE', 'FR', 'ES', 'UK', 'ZZ'])
    expect(circled(2)).toBe('②'); expect(circled(1)).toBe('①')
  })
})

describe('business pricing absence — derived from the cached schema, three honest sentences (MX.F, design §3.11)', () => {
  it('flattens the JSONPath projection of the audience enum', () => {
    expect(flattenAudience([['ALL']])).toEqual(['ALL'])
    expect(flattenAudience([['ALL', 'B2B'], ['ALL']])).toEqual(['ALL', 'B2B'])
    expect(flattenAudience([])).toEqual([])
    expect(flattenAudience(null)).toEqual([])
  })
  it('a cached schema without B2B → MX.1\'s sentence naming the schema and the market, on BOTH reserved cells', () => {
    const out = businessAbsence({ productType: 'OUTERWEAR', market: 'IT', audience: ['ALL'] })
    expect(out.map((a) => a.cell)).toEqual(['businessPrice', 'businessTiers'])
    for (const a of out) expect(a.reason).toBe(MATRIX_COPY.absentBusiness('OUTERWEAR', 'IT'))
    expect(out[0]!.reason).toContain('checked against the OUTERWEAR schema on IT')
  })
  it('no cached schema for (productType, market) → the unchecked sentence, never a false "checked against"', () => {
    const out = businessAbsence({ productType: 'OUTERWEAR', market: 'PL', audience: null })
    for (const a of out) expect(a.reason).toBe(MATRIX_COPY.absentBusinessUnchecked('PL'))
    expect(out[0]!.reason).not.toContain('checked against')
    /* A family with no product type has nothing to check against either. */
    expect(businessAbsence({ productType: null, market: 'IT', audience: ['ALL'] })[0]!.reason).toBe(MATRIX_COPY.absentBusinessUnchecked('IT'))
  })
  it('a schema WITH the B2B audience → still absent, saying the cells are not built (positive control for the enum test)', () => {
    const out = businessAbsence({ productType: 'OUTERWEAR', market: 'DE', audience: ['ALL', 'B2B'] })
    for (const a of out) expect(a.reason).toBe(MATRIX_COPY.absentBusinessNotBuilt('OUTERWEAR', 'DE'))
    expect(out[0]!.reason).not.toBe(MATRIX_COPY.absentBusiness('OUTERWEAR', 'DE'))
  })
})
