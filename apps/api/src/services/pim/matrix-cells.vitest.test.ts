/**
 * MX.1 — the Matrix read's PURE rules, pinned without a database.
 *
 * The writable cases are the SAME cases the web fixture test runs (`_studio/matrix/matrix.vitest.test.ts`: an
 * FBA row has no writable inventory cell and every refusal is named `Amazon-managed`; the parent writes nothing
 * but price; a pinned row's buffer is held) plus the two only the live read can know (a missing
 * `products.price.edit` holds the price cells; a CLOSED offer holds the inventory lane). The listing-state
 * TABLE is asserted row by row in its precedence order, and against THE engine's selling reader
 * (`destinationSellingStates`: pure, no query) so the Matrix and the sheet share one vocabulary; the queue fold's
 * ranking and the PAUSED/FBA overrides are asserted with a positive control beside every negative.
 */
import { describe, expect, it } from 'vitest'
import { MATRIX_COPY, type SyncCell } from '@nexus/shared/matrix-contract'
import {
  channelRank, channelShape, circled, compareMarkets, deriveFulfilment, foldQueue, lanePushFailure, listingStateOf, priceCellOf, pushFailureReason,
  reportedFulfilment, syncCellOf, withoutInventory, writableFor, FORMULA_REASON, PARENT_PRICE_REASON, PARENT_REASON, PINNED_BUFFER_REASON, PRICE_PERMISSION_REASON,
  inSourceOrder, sharedStockReason, sourceCellOf,
} from './matrix-cells.js'
import { syncLedgerOf } from '../sync-control-core.js'
import { businessAbsence, effectiveFulfilment, flattenAudience } from './matrix-cells.js'
import { destinationSellingStates, type SellingStateListing } from '../listings/listing-action.service.js'

const ACTIVE = { state: 'active', reason: null } as const
const facts = (over: Partial<Parameters<typeof listingStateOf>[0]> = {}) => ({
  listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0X', suppressed: false, excluded: false, needsValue: false, selling: ACTIVE, ...over,
}) as Parameters<typeof listingStateOf>[0]
const inactive = { state: 'paused', reason: 'Inactive: quantity 0 in Shopify, and Nexus holds every stock push.' } as const

describe('listing state — the table, in precedence order (build shape v2: the engine\'s selling state below the health words)', () => {
  it.each([
    ['excluded beats everything', facts({ excluded: true, suppressed: true, selling: inactive }), 'excluded', null],
    ['a suppression beats an inactive offer (health words win)', facts({ suppressed: true, selling: inactive }), 'suppressed', null],
    ['an open suppression beats ENDED', facts({ suppressed: true, listingStatus: 'ENDED', selling: { state: 'ended', reason: null } }), 'suppressed', null],
    ['ERROR beats the selling word', facts({ listingStatus: 'ERROR', selling: inactive }), 'error', null],
    ['a variant missing an axis value beats the selling word', facts({ needsValue: true, selling: inactive }), 'needs-value', null],
    ['Ended', facts({ listingStatus: 'ENDED', selling: { state: 'ended', reason: 'Ended on the channel.' } }), 'ended', null],
    ['Inactive is the wire\'s `closed` key (the word comes from `selling`)', facts({ selling: inactive }), 'closed', null],
    ['Not listed: a draft (never sent) is the wire\'s `draft` key', facts({ listingStatus: 'DRAFT', externalListingId: null, selling: { state: 'draft', reason: null } }), 'draft', null],
    ['Not listed: a listing Nexus deleted (not listed again) is the wire\'s `draft` key, never "Ended"', facts({ listingStatus: 'DRAFT', externalListingId: null,
      selling: { state: 'not_listed', reason: 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.' } }), 'draft', null],
    ['DISCOVERABLE is listed and not buyable — Amazon\'s own meaning', facts({ listingStatus: 'DISCOVERABLE' }), 'listed', 'not buyable'],
    ['Active', facts(), 'listed', null],
    ['Mixed (a main product) is listed', facts({ selling: { state: 'mixed', reason: '1 of 2 variations are inactive.' } }), 'listed', null],
    ['Unknown: REMOVED reads as ended', facts({ listingStatus: 'REMOVED', selling: { state: 'unknown', reason: null } }), 'ended', null],
    ['Unknown: a Nexus-only INACTIVE mark is listed, with no "inactive" detail', facts({ listingStatus: 'INACTIVE', selling: { state: 'unknown', reason: 'never told' } }), 'listed', null],
    ['Unknown: an external id with an unknown status is listed', facts({ listingStatus: 'WHATEVER', selling: { state: 'unknown', reason: null } }), 'listed', null],
    ['Unknown: no external id and no known status is a draft', facts({ listingStatus: 'PENDING', externalListingId: null, selling: { state: 'unknown', reason: null } }), 'draft', null],
  ])('%s', (_name, f, state, detail) => {
    expect(listingStateOf(f)).toMatchObject({ state, detail })
  })
  it('carries isPublished, the external id and the selling facts verbatim', () => {
    expect(listingStateOf(facts({ isPublished: false, selling: inactive }))).toEqual({ state: 'closed', externalId: 'B0X', detail: null, published: false, selling: inactive })
  })
})

describe('listing state — one vocabulary with the engine (the Shopify pause bug)', () => {
  const family = (listings: Array<Partial<SellingStateListing> & { productId: string }>, channel = 'SHOPIFY') => destinationSellingStates({
    familyId: 'root', channel,
    products: [{ id: 'root', sku: 'ROOT', isParent: true }, { id: 's', sku: 'ROOT-S', isParent: false }, { id: 'm', sku: 'ROOT-M', isParent: false }],
    listings: listings.map((l, i) => ({ id: `l${i}`, externalListingId: 'gid://shopify/Product/1', listingStatus: 'ACTIVE', isPublished: true, offerClosedAt: null,
      offerCloseReason: null, offerActive: true, fulfillmentMethod: null, platformAttributes: { status: 'ACTIVE' }, ...l })),
  }).states
  it('a Shopify pause (quantity-0 hold, offerClosedAt + sheet-pause) reads Inactive, never "Listed · inactive"', () => {
    const states = family([{ productId: 'root' }, { productId: 's', offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' }, { productId: 'm' }])
    const s = listingStateOf(facts({ selling: states.get('s')! }))
    expect(s).toMatchObject({ state: 'closed', detail: null, selling: { state: 'paused' } })
    expect(s.selling.reason).toMatch(/quantity 0 in Shopify/)
    // Its product reads Mixed; the other size Active.
    expect(listingStateOf(facts({ selling: states.get('root')! }))).toMatchObject({ state: 'listed', selling: { state: 'mixed' } })
    expect(listingStateOf(facts({ selling: states.get('m')! }))).toMatchObject({ state: 'listed', selling: { state: 'active' } })
  })
  it('the old Shopify pause (Draft in Shopify) and an archive read Inactive and Ended', () => {
    expect(listingStateOf(facts({ listingStatus: 'INACTIVE', selling: family([{ productId: 'root', platformAttributes: { status: 'DRAFT' } }, { productId: 's' }]).get('s')! })))
      .toMatchObject({ state: 'closed', detail: null, selling: { state: 'paused' } })
    expect(listingStateOf(facts({ selling: family([{ productId: 'root', platformAttributes: { status: 'ARCHIVED' } }, { productId: 's' }]).get('s')! })))
      .toMatchObject({ state: 'ended', selling: { state: 'ended' } })
  })
})

describe('per-lane push failure (2026-10-08: the Sync column folds into Qty and Price) — each lane\'s NEWEST push decides', () => {
  const row = (syncType: string, syncStatus: string, createdAt: string, over: Partial<{ isDead: boolean; errorMessage: string | null; at: string | null }> = {}) =>
    ({ syncType, syncStatus, isDead: false, errorMessage: null, at: createdAt, createdAt, ...over })
  const JULY = '2026-07-19T10:00:00.000Z', TODAY = '2026-10-08T09:00:00.000Z', LATER = '2026-10-08T09:30:00.000Z'
  it('a lane whose newest push FAILED is a failure, with the reason, its time and whether a retry is left', () => {
    expect(lanePushFailure([{ market: 'IT', rows: [row('QUANTITY_UPDATE', 'FAILED', TODAY, { isDead: true, errorMessage: 'eBay: 21916750 — the listing has ended' })] }], 'QUANTITY_UPDATE'))
      .toEqual({ reason: 'eBay: 21916750 — the listing has ended', at: TODAY, final: true, markets: [] })
    expect(lanePushFailure([{ market: 'IT', rows: [row('PRICE_UPDATE', 'FAILED', TODAY, { errorMessage: 'Circuit open' })] }], 'PRICE_UPDATE'))
      .toMatchObject({ final: false })
  })
  it('🔴 a newer success, a push on its way or a deliberate skip clears an older failure (the July dead row the Sync column kept)', () => {
    const dead = row('QUANTITY_UPDATE', 'FAILED', JULY, { isDead: true, errorMessage: 'eBay publish circuit open' })
    expect(lanePushFailure([{ market: 'IT', rows: [dead] }], 'QUANTITY_UPDATE')).not.toBeNull() // positive control
    for (const status of ['SUCCESS', 'PENDING', 'IN_PROGRESS', 'SKIPPED']) {
      expect(lanePushFailure([{ market: 'IT', rows: [dead, row('QUANTITY_UPDATE', status, TODAY)] }], 'QUANTITY_UPDATE')).toBeNull()
    }
    /* The order of the rows does not matter — the newest by its creation time decides. */
    expect(lanePushFailure([{ market: 'IT', rows: [row('QUANTITY_UPDATE', 'SUCCESS', TODAY), dead] }], 'QUANTITY_UPDATE')).toBeNull()
  })
  it('🔴 the lanes are separate: a failed PRICE push never marks the stock lane, and the reverse (the Sync column showed price pushes in the stock lane)', () => {
    const rows = [row('QUANTITY_UPDATE', 'SUCCESS', TODAY), row('PRICE_UPDATE', 'FAILED', TODAY, { errorMessage: 'Amazon: 8541' })]
    expect(lanePushFailure([{ market: 'IT', rows }], 'QUANTITY_UPDATE')).toBeNull()
    expect(lanePushFailure([{ market: 'IT', rows }], 'PRICE_UPDATE')).toMatchObject({ reason: 'Amazon: 8541' })
  })
  it('Amazon EU: each market\'s own newest push; the failing markets named, the newest failure\'s words', () => {
    const out = lanePushFailure([
      { market: 'DE', rows: [row('QUANTITY_UPDATE', 'FAILED', TODAY, { errorMessage: 'older' })] },
      { market: 'IT', rows: [row('QUANTITY_UPDATE', 'FAILED', LATER, { isDead: true, errorMessage: 'eu-shared-qty-conflict' })] },
      { market: 'FR', rows: [row('QUANTITY_UPDATE', 'SUCCESS', LATER)] },
    ], 'QUANTITY_UPDATE', true)
    expect(out).toEqual({ reason: pushFailureReason('eu-shared-qty-conflict'), at: LATER, final: true, markets: ['IT', 'DE'] })
    expect(out!.reason).toContain('Amazon EU guard')
  })
  it('a code saved as the error reads as words; an empty one is never an empty reason', () => {
    expect(pushFailureReason('sync-paused-policy')).toContain('channel policy')
    expect(pushFailureReason('eBay: 25002 — the item is not active')).toBe('eBay: 25002 — the item is not active')
    expect(pushFailureReason(null)).toBe('The channel refused the change')
    expect(pushFailureReason('  ')).toBe('The channel refused the change')
  })
  it('nothing pushed on the lane → no failure', () => {
    expect(lanePushFailure([], 'QUANTITY_UPDATE')).toBeNull()
    expect(lanePushFailure([{ market: 'IT', rows: [row('PRICE_UPDATE', 'FAILED', TODAY)] }], 'QUANTITY_UPDATE')).toBeNull()
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
    // Amazon sheet gaps (D3): every code, both places, fail-closed — Amazon's pull writes `attributes.fulfillment_availability`.
    expect(reportedFulfilment({ attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } })).toBe('AFN')
    expect(reportedFulfilment({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] })).toBe('AFN')
    expect(reportedFulfilment({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }], attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_VCS' }] } })).toBe('AFN')
    expect(reportedFulfilment({ attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'GESTITO DAL VENDITORE (DEFAULT)' }] } })).toBe('MFN')
    expect(reportedFulfilment({ attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'SOMETHING' }] } })).toBeNull()
  })
  it('coordinate shape: eBay has no sale, the global channels have no fulfilment, an EU market carries no inventory kinds', () => {
    expect(channelShape('EBAY').absent).toEqual([{ cell: 'salePrice', reason: MATRIX_COPY.absentSaleEbay }])
    // Etsy's listing API has no sale price: the cell is absent with its sentence (and Etsy has no fulfilment either).
    expect(channelShape('ETSY').cells).not.toContain('salePrice'); expect(channelShape('ETSY').cells).toContain('price')
    expect(channelShape('ETSY').absent).toEqual([{ cell: 'salePrice', reason: MATRIX_COPY.absentSaleEtsy }, { cell: 'fulfilment', reason: 'Etsy has no fulfilment method' }])
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
  it('a cached schema without B2B → MX.1\'s sentence naming the schema, on BOTH reserved cells (the market is the coordinate\'s, 2026-10-08)', () => {
    const out = businessAbsence({ productType: 'OUTERWEAR', market: 'IT', audience: ['ALL'] })
    expect(out.map((a) => a.cell)).toEqual(['businessPrice', 'businessTiers'])
    for (const a of out) expect(a.reason).toBe(MATRIX_COPY.absentBusiness('OUTERWEAR'))
    expect(out[0]!.reason).toContain('checked against the OUTERWEAR schema')
    /* One sentence for every market that shares it — Customise groups the markets (`absentHint`). */
    expect(businessAbsence({ productType: 'OUTERWEAR', market: 'DE', audience: ['ALL'] })[0]!.reason).toBe(out[0]!.reason)
  })
  it('no cached schema for (productType, market) → the unchecked sentence, never a false "checked against"', () => {
    const out = businessAbsence({ productType: 'OUTERWEAR', market: 'PL', audience: null })
    for (const a of out) expect(a.reason).toBe(MATRIX_COPY.absentBusinessUnchecked())
    expect(out[0]!.reason).not.toContain('checked against')
    /* A family with no product type has nothing to check against either. */
    expect(businessAbsence({ productType: null, market: 'IT', audience: ['ALL'] })[0]!.reason).toBe(MATRIX_COPY.absentBusinessUnchecked())
  })
  it('a schema WITH the B2B audience → still absent, saying the cells are not built (positive control for the enum test)', () => {
    const out = businessAbsence({ productType: 'OUTERWEAR', market: 'DE', audience: ['ALL', 'B2B'] })
    for (const a of out) expect(a.reason).toBe(MATRIX_COPY.absentBusinessNotBuilt('OUTERWEAR'))
    expect(out[0]!.reason).not.toBe(MATRIX_COPY.absentBusiness('OUTERWEAR'))
  })
})

describe('effectiveFulfilment — ONE rule for the sheet cell, the Matrix and the Amazon publish step (2026-09-27)', () => {
  const nested = (code: string) => ({ fulfillment_availability: [{ fulfillment_channel_code: code }] })

  it('the case that used to split: Amazon reports FBA, no typed column, product flag FBM → FBA, never FBM', () => {
    expect(effectiveFulfilment({ typed: null, platformAttributes: nested('AMAZON_EU'), productMethod: 'FBM' })).toEqual({ method: 'FBA', source: 'reported' })
  })

  it('precedence: active offer → typed → reported → flat mirror → product', () => {
    expect(effectiveFulfilment({ activeOfferMethod: 'FBA', typed: 'FBM', platformAttributes: nested('DEFAULT'), productMethod: 'FBM' })).toEqual({ method: 'FBA', source: 'offer' })
    expect(effectiveFulfilment({ typed: 'FBM', platformAttributes: nested('DEFAULT'), productMethod: 'FBA' })).toEqual({ method: 'FBM', source: 'set' })
    expect(effectiveFulfilment({ platformAttributes: { fulfillmentChannel: 'AFN' }, productMethod: 'FBM' })).toEqual({ method: 'FBA', source: 'mirror' })
    expect(effectiveFulfilment({ platformAttributes: {}, productMethod: 'FBA' })).toEqual({ method: 'FBA', source: 'product' })
  })

  it('D9 = A: the offer and the typed method rank above Amazon\'s report, which shows as "differs"; the report still decides when nothing else says', () => {
    expect(effectiveFulfilment({ typed: 'FBM', platformAttributes: { attributes: nested('AMAZON_EU') } })).toEqual({ method: 'FBM', source: 'set' })
    expect(reportedFulfilment({ attributes: nested('AMAZON_EU') })).toBe('AFN')
    expect(effectiveFulfilment({ activeOfferMethod: 'FBM', typed: 'FBA', platformAttributes: { attributes: nested('AMAZON_EU_RAFN') } })).toEqual({ method: 'FBM', source: 'offer' })
    expect(effectiveFulfilment({ typed: 'FBA', platformAttributes: nested('AMAZON_EU_RAFN') })).toEqual({ method: 'FBA', source: 'set' })
    expect(effectiveFulfilment({ platformAttributes: { attributes: nested('AMAZON_EU') }, productMethod: 'FBM' })).toEqual({ method: 'FBA', source: 'reported' })
  })

  it('nothing says anything → null, so a new listing must still choose', () => {
    expect(effectiveFulfilment({})).toBeNull()
    expect(effectiveFulfilment({ typed: '', platformAttributes: { fulfillmentChannel: 'weird' }, productMethod: null })).toBeNull()
  })
})

/**
 * Step 2 (Owner 2026-10-07) — the From cell ("Sells from"). The default is the market's list, or — with none — the ACTIVE
 * warehouses whose routes allow the market, default first; `effective` is the core's own choice (`sellsFrom`) with this
 * SKU's available per location; the parent, FBA, shared stock and a missing `inventory.adjust` hold it, in that order.
 */
describe('sourceCellOf — the From cell', () => {
  const LOCS = [
    { code: 'MI-3PL', active: true, isDefault: false, syncRoutes: [] },
    { code: 'IT-MAIN', active: true, isDefault: true, syncRoutes: [] },
    { code: 'DE-ONLY', active: true, isDefault: false, syncRoutes: ['AMAZON:DE'] },
    { code: 'OLD', active: false, isDefault: false, syncRoutes: [] },
  ]
  const ROWS = [
    { locationCode: 'IT-MAIN', available: 12, syncRoutes: [] },
    { locationCode: 'MI-3PL', available: 4, syncRoutes: [] },
  ]
  const of = (over: Partial<Parameters<typeof sourceCellOf>[0]> = {}, lists: Array<[string, string[]]> = []) => {
    const marketSources = new Map(lists)
    return sourceCellOf({
      role: 'variant', channel: 'AMAZON', market: 'IT', own: [], ledger: syncLedgerOf(ROWS, { marketSources }), marketSources,
      locations: LOCS, isFba: false, sharedFrom: null, canAdjustStock: true, ...over,
    })
  }

  it('no list anywhere: the routes decide — active warehouses that serve the market, the default first, then by code', () => {
    expect(of()).toEqual({
      own: [], marketDefault: ['IT-MAIN', 'MI-3PL'], defaultOrigin: 'routes',
      effective: [{ code: 'IT-MAIN', available: 12 }, { code: 'MI-3PL', available: 4 }], writable: true, blockedReason: null,
    })
    // DE-ONLY routes to Amazon DE only; OLD is switched off
    expect(of({ market: 'DE' }).marketDefault).toEqual(['IT-MAIN', 'DE-ONLY', 'MI-3PL'])
    expect(inSourceOrder(LOCS).map((l) => l.code)).toEqual(['IT-MAIN', 'DE-ONLY', 'MI-3PL', 'OLD'])
  })

  it('the market list is the default, in its order; a listing list replaces it — exactly those codes, 0 where the SKU holds none', () => {
    const market = of({}, [['AMAZON:IT', ['MI-3PL', 'IT-MAIN']]])
    expect(market).toMatchObject({ own: [], marketDefault: ['MI-3PL', 'IT-MAIN'], defaultOrigin: 'market', effective: [{ code: 'MI-3PL', available: 4 }, { code: 'IT-MAIN', available: 12 }] })
    const own = of({ own: ['MI-3PL', 'DE-ONLY'] }, [['AMAZON:IT', ['IT-MAIN']]])
    expect(own).toMatchObject({ own: ['MI-3PL', 'DE-ONLY'], marketDefault: ['IT-MAIN'], defaultOrigin: 'market', effective: [{ code: 'MI-3PL', available: 4 }, { code: 'DE-ONLY', available: 0 }] })
    // another market's list does not leak (eBay IT is its own key)
    expect(of({ channel: 'EBAY' }, [['AMAZON:IT', ['MI-3PL']]]).defaultOrigin).toBe('routes')
  })

  it('held with the sentence: the parent, FBA, shared stock, no inventory.adjust — in that order; writable otherwise', () => {
    expect(of({ role: 'parent', isFba: true, own: ['MI-3PL'] })).toMatchObject({ writable: false, blockedReason: MATRIX_COPY.sourceParent, own: [], effective: [] })
    expect(of({ isFba: true, sharedFrom: 'Lender' })).toMatchObject({ writable: false, blockedReason: MATRIX_COPY.sourceFba })
    expect(of({ sharedFrom: 'Lender', canAdjustStock: false })).toMatchObject({ writable: false, blockedReason: sharedStockReason('Lender') })
    expect(of({ canAdjustStock: false })).toMatchObject({ writable: false, blockedReason: MATRIX_COPY.sourcePermission })
    expect(of()).toMatchObject({ writable: true, blockedReason: null })
  })

  it('a pooled SKU shows the lent rows (its own list is ignored, as the push ignores it)', () => {
    const pool = syncLedgerOf([{ locationCode: 'LENDER-WH', available: 9, syncRoutes: [] }])
    expect(of({ sharedFrom: 'Lender', ledger: pool, own: ['MI-3PL'] }).effective).toEqual([{ code: 'LENDER-WH', available: 9 }])
  })
})
