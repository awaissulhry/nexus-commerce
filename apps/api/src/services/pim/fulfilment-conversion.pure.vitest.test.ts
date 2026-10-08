/**
 * Amazon fulfilment conversion (2026-10-07) — the pure rules: when a set-fulfilment is a no-change, a refusal or a send
 * (`amazonConversionRefusal`, shared with the page), every fixable refusal at once (`conversionRefusals`,
 * `allRefusalsLine`), the patch sent per market (`conversionPatches`), the change's note, how a run reads in the
 * Fulfilment cell (`conversionStatusOf`), what one report read does to a record (`confirmVerdict`), and the reported copy
 * a confirmation leaves (`withConfirmedReport`).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: {} }))

import { amazonConversionNote, amazonConversionRefusal, type AmazonFulfilmentFacts } from '@nexus/shared/matrix-preview'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { allRefusalsLine, confirmVerdict, conversionPatches, conversionRefusals, conversionStatusOf, policyPausedSentence, reportMethod, withConfirmedReport, type ConversionRecordFacts } from './fulfilment-conversion.service.js'
import { reportedFulfilment } from './matrix-cells.js'

const facts = (over: Partial<AmazonFulfilmentFacts> = {}): AmazonFulfilmentFacts => ({
  markets: ['IT', 'DE'], skipped: [], quantity: 5, quantityRefusal: null, fbaUnits: { onHand: 0, reserved: 0, inbound: 0 },
  activeFbaOffer: false, keptCodeReason: null, notListed: false, locked: null, latest: null, ...over,
})
const cell = { method: 'FBM' as const, source: 'set' as const, guard: 'FBM' as const, reported: null }

describe('amazonConversionRefusal', () => {
  it('a no-change only when Nexus, its guard and Amazon\'s report (or a confirmed run) agree', () => {
    expect(amazonConversionRefusal(facts(), 'FBM', cell)).toBe('noop')
    // Nexus says FBM but Amazon reports AFN (the GALE case): sent again, so Amazon gets FBM for certain.
    expect(amazonConversionRefusal(facts(), 'FBM', { ...cell, reported: 'AFN' })).toBeNull()
    // The guard reads FBA: sent (the FBA facts refuse it when units or an offer keep it FBA).
    expect(amazonConversionRefusal(facts(), 'FBM', { ...cell, guard: 'FBA' })).toBeNull()
    // A derived method is not a no-change.
    expect(amazonConversionRefusal(facts(), 'FBM', { ...cell, source: 'derived' })).toBeNull()
    // A confirmed run wins over a stale reported copy; a still-old one asks to send again.
    const at = '2026-10-07T10:00:00Z'
    expect(amazonConversionRefusal(facts({ latest: { status: 'CONFIRMED', to: 'FBM', at, markets: ['IT'], message: null } }), 'FBM', { ...cell, reported: 'AFN' })).toBe('noop')
    expect(amazonConversionRefusal(facts({ latest: { status: 'STILL_OLD', to: 'FBM', at, markets: ['IT'], message: null } }), 'FBM', cell)).toBeNull()
    expect(amazonConversionRefusal(facts({ latest: { status: 'SENT', to: 'FBM', at, markets: ['IT'], message: null } }), 'FBM', { ...cell, reported: 'AFN' }))
      .toMatchObject({ kind: 'not-applicable', reason: expect.stringContaining('Already sent to Amazon') })
  })

  it('refuses by name, in order', () => {
    const fba = { ...cell, method: 'FBA' as const, guard: 'FBA' as const }
    expect(amazonConversionRefusal(facts({ notListed: true }), 'FBM', fba)).toMatchObject({ kind: 'no-listing' })
    expect(amazonConversionRefusal(facts({ keptCodeReason: 'Remote Fulfilment (EU stock → UK) is switched on in Seller Central' }), 'FBA', cell)).toMatchObject({ kind: 'guard', reason: expect.stringContaining('Remote Fulfilment') })
    expect(amazonConversionRefusal(facts({ markets: [], skipped: [{ market: 'DE', why: 'inactive' }, { market: 'FR', why: 'not-listed' }] }), 'FBM', fba))
      .toEqual({ kind: 'not-applicable', reason: 'No open offer to convert here: DE (Inactive), FR (not listed)' })
    expect(amazonConversionRefusal(facts({ locked: 'Amazon IT: Listing sync is paused. Resume sync before sending changes.' }), 'FBM', fba)).toMatchObject({ kind: 'guard', reason: expect.stringContaining('Resume sync') })
    expect(amazonConversionRefusal(facts({ fbaUnits: { onHand: 3, reserved: 0, inbound: 0 } }), 'FBM', fba)).toMatchObject({ reason: expect.stringContaining('3 units of FBA stock on hand keep the guard closed') })
    expect(amazonConversionRefusal(facts({ fbaUnits: { onHand: 0, reserved: 2, inbound: 0 } }), 'FBM', fba)).toMatchObject({ reason: expect.stringContaining('2 FBA units reserved') })
    expect(amazonConversionRefusal(facts({ fbaUnits: { onHand: 0, reserved: 0, inbound: 9 } }), 'FBM', fba)).toMatchObject({ reason: expect.stringContaining('9 FBA units inbound') })
    expect(amazonConversionRefusal(facts({ activeFbaOffer: true }), 'FBM', fba)).toMatchObject({ reason: expect.stringContaining('an active FBA offer') })
    expect(amazonConversionRefusal(facts({ quantity: null, quantityRefusal: 'no stock location is routed to Amazon IT for this SKU' }), 'FBM', fba))
      .toMatchObject({ reason: 'Refused — no stock location is routed to Amazon IT for this SKU; an FBM offer needs one' })
    // FBM → FBA is not held by FBA units (they are what FBA sells).
    expect(amazonConversionRefusal(facts({ fbaUnits: { onHand: 3, reserved: 1, inbound: 2 }, quantity: null }), 'FBA', cell)).toBeNull()
  })

  it('the note says what is sent, where, and what Amazon reports now', () => {
    expect(amazonConversionNote(facts({ skipped: [{ market: 'FR', why: 'inactive' }] }), 'FBM', 'AFN')).toBe('Amazon reports AFN. Sends Amazon FBM (DEFAULT) with quantity 5 on IT DE — skips FR (Inactive)')
    expect(amazonConversionNote(facts(), 'FBA', null)).toBe('Sends Amazon FBA (AMAZON_EU) on IT DE, no quantity — out of stock until Amazon receives units')
  })
})

describe('conversionPatches — the ONE patch per marketplace (Amazon\'s documented switch: add the new record, delete the old)', () => {
  const FA = '/attributes/fulfillment_availability'
  it('FBA → FBM: add DEFAULT with the quantity (and the handling time when known), then delete the Amazon record', () => {
    expect(conversionPatches('FBM', { quantity: 2, leadTime: 3 }, 'AMAZON_EU')).toEqual([
      { op: 'add', path: FA, value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2, lead_time_to_ship_max_days: 3 }] },
      { op: 'delete', path: FA, value: [{ fulfillment_channel_code: 'AMAZON_EU' }] },
    ])
    expect(conversionPatches('FBM', { quantity: 0, leadTime: null }, 'AMAZON_EU')[0]!.value).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 0 }])
  })
  it('FBM → FBA: add the Amazon record with no quantity, then delete DEFAULT (the last merchant quantity leaves Amazon)', () => {
    for (const code of ['AMAZON_EU', 'AMAZON_NA']) {
      expect(conversionPatches('FBA', { quantity: 7, leadTime: 2 }, code)).toEqual([
        { op: 'add', path: FA, value: [{ fulfillment_channel_code: code }] },
        { op: 'delete', path: FA, value: [{ fulfillment_channel_code: 'DEFAULT' }] },
      ])
    }
  })
})

describe('every refusal at once (`conversionRefusals` + `allRefusalsLine`)', () => {
  const pause = policyPausedSentence('DE FR')
  it('the pause says what to do in one line, for every market it holds', () => {
    expect(pause).toBe('Pushes to Amazon DE FR are paused — release them in Sync Control, or set DE FR Inactive in the product sheet if you do not sell there')
  })
  it('FBM: the locks, every FBA-units fact, an active FBA offer and the quantity — in the shared rule\'s own words', () => {
    const f = facts({ fbaUnits: { onHand: 4, reserved: 1, inbound: 0 }, activeFbaOffer: true, quantity: null, quantityRefusal: 'no stock location is routed to Amazon IT for this SKU' })
    expect(conversionRefusals(f, [pause], 'FBM')).toEqual([
      pause,
      'Refused — 4 units of FBA stock on hand keep the guard closed; Amazon must hold no FBA units of this SKU before its offer is converted to FBM',
      'Refused — 1 FBA units reserved at Amazon keep the guard closed; Amazon must hold no FBA units of this SKU before its offer is converted to FBM',
      'Refused — an active FBA offer keeps the guard closed; convert the offer in Seller Central first',
      'Refused — no stock location is routed to Amazon IT for this SKU; an FBM offer needs one',
    ])
    // FBA: FBA units and the merchant quantity do not hold it (they are what FBA sells); the locks still do.
    expect(conversionRefusals(f, [pause], 'FBA')).toEqual([pause])
    // The method unknown: the locks only.
    expect(conversionRefusals(f, [pause], null)).toEqual([pause])
  })
  it('one line, each thing once: the lead and a repeated clause are said once; one refusal = the shared sentence', () => {
    const f = facts({ fbaUnits: { onHand: 4, reserved: 0, inbound: 3 } })
    expect(allRefusalsLine(conversionRefusals(f, [pause], 'FBM'))).toBe('Refused — 3 things to fix: '
      + `1) ${pause} `
      + '2) 4 units of FBA stock on hand keep the guard closed; Amazon must hold no FBA units of this SKU before its offer is converted to FBM '
      + '3) 3 FBA units inbound to Amazon keep the guard closed')
    expect(allRefusalsLine([pause])).toBeNull()
    expect(allRefusalsLine([])).toBeNull()
  })
  it('the combined line reaches the person through the shared rule (as `locked`), after the refusals that leave nothing to fix', () => {
    const line = allRefusalsLine([pause, 'Refused — an active FBA offer keeps the guard closed; convert the offer in Seller Central first'])!
    const fba = { ...cell, method: 'FBA' as const, guard: 'FBA' as const }
    expect(amazonConversionRefusal(facts({ locked: line, activeFbaOffer: true }), 'FBM', fba)).toEqual({ kind: 'guard', reason: line })
    expect(amazonConversionRefusal(facts({ locked: line, notListed: true }), 'FBM', fba)).toMatchObject({ kind: 'no-listing' })
  })
})

describe('conversionStatusOf — the newest run, as the Fulfilment cell reads it', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 10, m))
  const r = (over: Partial<ConversionRecordFacts>): ConversionRecordFacts => ({
    runId: 'run-2', channelListingId: 'l', marketplace: 'IT', toMethod: 'FBM', status: 'SENT', message: null,
    createdAt: t(0), sentAt: t(1), confirmedAt: null, lastReportAt: null, updatedAt: t(1), ...over,
  })
  const now = t(30)
  it('folds the newest run over its markets; an older run is ignored', () => {
    expect(conversionStatusOf([], now)).toBeNull()
    const older = r({ runId: 'run-1', createdAt: new Date(Date.UTC(2026, 9, 6)), status: 'STILL_OLD' })
    expect(conversionStatusOf([older, r({ marketplace: 'IT', status: 'CONFIRMED', confirmedAt: t(19) }), r({ marketplace: 'DE', status: 'CONFIRMED', confirmedAt: t(17) })], now))
      .toEqual({ status: 'CONFIRMED', to: 'FBM', at: t(19).toISOString(), markets: ['IT', 'DE'], message: null })
    expect(conversionStatusOf([r({ marketplace: 'IT', status: 'CONFIRMED', confirmedAt: t(19) }), r({ marketplace: 'DE' })], now)).toMatchObject({ status: 'SENT', markets: ['IT', 'DE'] })
    expect(conversionStatusOf([r({ marketplace: 'IT' }), r({ marketplace: 'DE', status: 'REFUSED', message: 'Amazon refused it: 8541' })], now))
      .toMatchObject({ status: 'SENT', markets: ['IT'], message: 'Amazon DE refused: Amazon refused it: 8541' })
    expect(conversionStatusOf([r({ marketplace: 'IT', status: 'REFUSED', message: 'gated' }), r({ marketplace: 'DE', status: 'REFUSED', message: 'gated' })], now))
      .toMatchObject({ status: 'REFUSED', markets: ['IT', 'DE'], message: 'gated' })
    expect(conversionStatusOf([r({ status: 'STILL_OLD', message: 'Amazon still reports FBA (AMAZON_EU) — check Seller Central → Manage Inventory' }), r({ marketplace: 'DE', status: 'CONFIRMED' })], now))
      .toMatchObject({ status: 'STILL_OLD' })
  })
  it('a send never confirmed within 24 h is no longer on its way: it reads STILL_OLD, and the same change can be sent again', () => {
    const late = new Date(t(0).getTime() + 24 * 3_600_000 + 60_000)
    const sent = [r({ marketplace: 'IT' }), r({ marketplace: 'DE', status: 'SENDING' })]
    expect(conversionStatusOf(sent, now)).toMatchObject({ status: 'SENDING' })
    const stale = conversionStatusOf(sent, late)!
    expect(stale).toMatchObject({ status: 'STILL_OLD', markets: ['IT', 'DE'], message: "Amazon's report did not confirm it within 24 h — check Seller Central → Manage Inventory" })
    const fba = { ...cell, method: 'FBA' as const, guard: 'FBA' as const }
    expect(amazonConversionRefusal(facts({ latest: conversionStatusOf(sent, now) }), 'FBM', fba)).toMatchObject({ reason: expect.stringContaining('Already sent to Amazon') })
    expect(amazonConversionRefusal(facts({ latest: stale }), 'FBM', fba)).toBeNull()
  })

  it('reads in one line', () => {
    const at = t(4).toISOString()
    const hhmm = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    expect(MATRIX_COPY.conversion({ status: 'SENT', to: 'FBM', at, markets: ['IT'], message: null })).toBe(`Sent to Amazon ${hhmm} · waiting for Amazon's report`)
    expect(MATRIX_COPY.conversion({ status: 'CONFIRMED', to: 'FBM', at, markets: ['IT'], message: null })).toBe(`Confirmed by Amazon ${hhmm}`)
    expect(MATRIX_COPY.conversion({ status: 'STILL_OLD', to: 'FBM', at, markets: ['IT'], message: null })).toBe('Amazon still reports FBA — check Seller Central')
  })
})

describe('confirmVerdict and the reported copy', () => {
  const now = new Date('2026-10-07T16:00:00Z')
  const rec = (over = {}) => ({ id: 'c', sku: 'S', status: 'SENT', fromMethod: 'FBA', toMethod: 'FBM', reportPulls: 0, sentAt: new Date('2026-10-07T15:00:00Z'), createdAt: new Date('2026-10-07T15:00:00Z'), ...over })
  it('CONFIRMED on the new channel; waits; STILL_OLD only after 3 reads AND 4 h; NOT_IN_REPORT after 3 reads', () => {
    expect(confirmVerdict(rec(), { present: true, channel: 'DEFAULT' }, now)).toMatchObject({ status: 'CONFIRMED', confirmed: true, reportPulls: 1 })
    expect(confirmVerdict(rec({ toMethod: 'FBA', fromMethod: 'FBM' }), { present: true, channel: 'AMAZON_EU' }, now)).toMatchObject({ status: 'CONFIRMED' })
    expect(confirmVerdict(rec({ reportPulls: 5 }), { present: true, channel: 'AMAZON_EU' }, now)).toMatchObject({ status: 'SENT', confirmed: false })
    const late = rec({ reportPulls: 2, sentAt: new Date('2026-10-07T11:00:00Z') })
    expect(confirmVerdict(late, { present: true, channel: 'AMAZON_EU' }, now)).toMatchObject({ status: 'STILL_OLD', message: 'Amazon still reports FBA (AMAZON_EU) — check Seller Central → Manage Inventory' })
    expect(confirmVerdict(rec({ reportPulls: 1 }), { present: false, channel: null }, now)).toMatchObject({ status: 'SENT' })
    expect(confirmVerdict(rec({ reportPulls: 2 }), { present: false, channel: null }, now)).toMatchObject({ status: 'NOT_IN_REPORT' })
    expect([reportMethod('DEFAULT'), reportMethod(''), reportMethod('AMAZON_EU'), reportMethod('AMAZON_EU_RAFN'), reportMethod('???')]).toEqual(['FBM', 'FBM', 'FBA', 'FBA', null])
  })
  it('a confirmation rewrites only the reported copy, keeping its merchant leaves', () => {
    const pa = { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }], attributes: { item_name: [{ value: 'x' }], fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }, { fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 3 }] } }
    const fbm = withConfirmedReport(pa, 'FBM', 'DEFAULT')
    expect(fbm).toEqual({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }], attributes: { item_name: [{ value: 'x' }], fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 3 }] } })
    expect(reportedFulfilment(pa)).toBe('AFN')
    expect(reportedFulfilment(fbm)).toBe('MFN')
    expect(reportedFulfilment(withConfirmedReport({}, 'FBA', 'AMAZON_EU'))).toBe('AFN')
  })
})
