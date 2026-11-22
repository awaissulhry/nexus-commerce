import { describe, expect, it } from 'vitest'
import {
  arrangeRefusal,
  arrangementData,
  arrangementOf,
  arrangementProblems,
  eventRefusal,
  eventTimeProblems,
  moveOfStatus,
  OWN_TRANSPORT_WORDS,
  trackingNumberProblems,
  trackingRefusal,
  type OwnTransportFacts,
} from './rules'
import { etaProblems, etaRefusal, hasCarrierLabel, overrideReasonProblems } from './rules' // B-OS-015, B-OS-016
import { PARCEL_TRACKING_WORDS, parcelReasonNeeded, parcelReasonProblems, parcelTrackingProblems, parcelTrackingRefusal } from './rules' // B-OS-022
import { seenNumbersReasonNeeded } from './rules' // B-OS-022 (os-fx3)

const facts = (over: Partial<OwnTransportFacts> = {}): OwnTransportFacts => ({ status: 'PACKED', transportBy: 'CARRIER', manualTrackingNumber: null, parcels: [{ trackingNumber: null, providerId: null }], liveDdts: 0, ...over })
const real = { trackingNumber: 'FKABC', providerId: 'fk-1:1' }
const test = { trackingNumber: 'TEST-1-1', providerId: 'test:p.v1' }

describe('how the goods travel (LOG-122)', () => {
  it('reads the arrangement from who carries and the typed number', () => {
    expect(arrangementOf({ transportBy: 'SENDER', manualTrackingNumber: null })).toBe('OWN_VAN')
    expect(arrangementOf({ transportBy: 'RECIPIENT', manualTrackingNumber: null })).toBe('CUSTOMER_COLLECTS')
    expect(arrangementOf({ transportBy: 'CARRIER', manualTrackingNumber: 'X1' })).toBe('MANUAL_CARRIER')
    expect(arrangementOf({ transportBy: 'CARRIER', manualTrackingNumber: null })).toBe('CARRIER')
  })

  it('changes it while planned or packed, with no label and no live DDT', () => {
    expect(arrangeRefusal(facts())).toBeNull()
    expect(arrangeRefusal(facts({ status: 'SHIPPED' }))?.code).toBe('LEFT')
    expect(arrangeRefusal(facts({ status: 'CANCELLED' }))?.code).toBe('CANCELLED')
    expect(arrangeRefusal(facts({ parcels: [test] }))?.code).toBe('LABELLED')
    expect(arrangeRefusal(facts({ liveDdts: 1 }))).toEqual({ code: 'DECLARED', message: OWN_TRANSPORT_WORDS.DECLARED })
  })

  it('checks the fields: our van names nothing, a manual carrier its name or code', () => {
    expect(arrangementProblems({ mode: 'OWN_VAN' })).toEqual([])
    expect(arrangementProblems({ mode: 'OWN_VAN', carrierName: 'X' }).map((issue) => issue.path)).toEqual(['body/carrierName'])
    expect(arrangementProblems({ mode: 'MANUAL_CARRIER' }).map((issue) => issue.path)).toEqual(['body/carrierName'])
    expect(arrangementProblems({ mode: 'MANUAL_CARRIER', carrierCode: 'Not A Code' }).map((issue) => issue.path)).toEqual(['body/carrierCode'])
    expect(arrangementProblems({ mode: 'MANUAL_CARRIER', carrierName: 'Made-up Trasporti', trackingNumber: 'a\nb' }).map((issue) => issue.path)).toEqual(['body/trackingNumber'])
    expect(trackingNumberProblems('x'.repeat(101))).toHaveLength(1)
    expect(trackingNumberProblems('  ')).toEqual([])
  })

  it('writes the shipment: our van clears the carrier; a manual carrier keeps its typed name, no service, no Sendcloud', () => {
    const name = (code: string) => code.toUpperCase()
    expect(arrangementData({ mode: 'OWN_VAN' }, name)).toEqual({ transportBy: 'SENDER', carrierCode: null, carrierName: null, serviceCode: null, integrationAccountId: null, manualTrackingNumber: null })
    expect(arrangementData({ mode: 'MANUAL_CARRIER', carrierName: ' Made-up Trasporti ', trackingNumber: ' MT-1 ' }, name)).toEqual({ transportBy: 'CARRIER', carrierCode: null, carrierName: 'Made-up Trasporti', serviceCode: null, integrationAccountId: null, manualTrackingNumber: 'MT-1' })
    expect(arrangementData({ mode: 'MANUAL_CARRIER', carrierCode: 'brt' }, name)).toMatchObject({ carrierCode: 'brt', carrierName: 'BRT', manualTrackingNumber: null })
  })

  it('types a tracking number for a carrier without labels only, until cancelled', () => {
    expect(trackingRefusal(facts({ status: 'SHIPPED' }))).toBeNull()
    expect(trackingRefusal(facts({ transportBy: 'SENDER' }))?.code).toBe('NOT_A_CARRIER')
    expect(trackingRefusal(facts({ parcels: [real] }))?.code).toBe('LABELLED')
    expect(trackingRefusal(facts({ status: 'CANCELLED' }))?.code).toBe('CANCELLED')
  })

  // B-OS-006 (order shipments tab; X2-B6): a TEST label is never tracked, so it never stops a typed number; a carrier's label does.
  it('B-OS-006: a TEST label does not stop a typed tracking number; a carrier label does (and both stop how the goods travel)', () => {
    expect(trackingRefusal(facts({ parcels: [test] }))).toBeNull()
    expect(trackingRefusal(facts({ status: 'SHIPPED', parcels: [test, { trackingNumber: null, providerId: null }] }))).toBeNull()
    expect(trackingRefusal(facts({ parcels: [test, real] }))?.code).toBe('LABELLED')
    expect(arrangeRefusal(facts({ parcels: [test] }))?.code).toBe('LABELLED')
  })

  it('types a status once the goods left, never for a shipment its carrier tracks or the customer collects', () => {
    expect(eventRefusal(facts({ status: 'SHIPPED', transportBy: 'SENDER' }))).toBeNull()
    expect(eventRefusal(facts({ status: 'SHIPPED', parcels: [test] }))).toBeNull()
    expect(eventRefusal(facts({ status: 'PACKED' }))?.code).toBe('NOT_LEFT')
    expect(eventRefusal(facts({ status: 'DELIVERED' }))?.code).toBe('ARRIVED')
    expect(eventRefusal(facts({ status: 'SHIPPED', parcels: [real] }))?.code).toBe('CARRIER_TRACKED')
    expect(eventRefusal(facts({ status: 'SHIPPED', transportBy: 'RECIPIENT' }))?.code).toBe('CUSTOMER_COLLECTS')
  })

  it('takes a time not in the future and not before the goods left; delivered and returned move the shipment', () => {
    const now = new Date('2026-11-14T10:00:00Z')
    const left = new Date('2026-11-13T08:00:00Z')
    expect(eventTimeProblems(new Date('2026-11-14T09:00:00Z'), left, now)).toEqual([])
    expect(eventTimeProblems(new Date('2026-11-14T10:04:00Z'), left, now)).toEqual([])
    expect(eventTimeProblems(new Date('2026-11-14T11:00:00Z'), left, now)[0]!.message).toBe('The time is in the future.')
    expect(eventTimeProblems(new Date('2026-11-12T11:00:00Z'), left, now)[0]!.message).toBe('The time is before the goods left.')
    expect([moveOfStatus('DELIVERED'), moveOfStatus('RETURNED'), moveOfStatus('IN_TRANSIT'), moveOfStatus('EXCEPTION')]).toEqual(['DELIVERED', 'RETURNED', null, null])
  })
})

// ---- B-OS-015, B-OS-016 (order shipments tab; Owner D5): ended by hand over a carrier's labels; the expected arrival by hand ----
describe('delivered or came back by hand over the carrier’s labels (B-OS-015)', () => {
  it('only DELIVERED or RETURNED, only with the override; any other status stays the carrier’s; delivered and returned stay final', () => {
    const shipped = facts({ status: 'SHIPPED', parcels: [real] })
    expect(eventRefusal(shipped)?.code).toBe('CARRIER_TRACKED')
    expect(eventRefusal(shipped, { status: 'DELIVERED', override: true })).toBeNull()
    expect(eventRefusal(shipped, { status: 'RETURNED', override: true })).toBeNull()
    expect(eventRefusal(shipped, { status: 'DELIVERED', override: false })?.code).toBe('CARRIER_TRACKED')
    expect(eventRefusal(shipped, { status: 'IN_TRANSIT', override: true })?.code).toBe('CARRIER_TRACKED')
    expect(eventRefusal(facts({ status: 'DELIVERED', parcels: [real] }), { status: 'RETURNED', override: true })?.code).toBe('ARRIVED')
    expect(eventRefusal(facts({ status: 'SHIPPED', transportBy: 'RECIPIENT' }), { status: 'DELIVERED', override: true })?.code).toBe('CUSTOMER_COLLECTS')
  })

  it('a carrier label (never a TEST one) asks a reason of 3 to 500 characters', () => {
    expect(hasCarrierLabel(facts({ parcels: [real] }))).toBe(true)
    expect(hasCarrierLabel(facts({ parcels: [test] }))).toBe(false)
    expect(overrideReasonProblems('The customer signed our own delivery note.')).toEqual([])
    expect(overrideReasonProblems('  ok ').map((issue) => issue.path)).toEqual(['body/reason'])
    expect(overrideReasonProblems(null)).toHaveLength(1)
    expect(overrideReasonProblems('x'.repeat(501))).toHaveLength(1)
  })
})

describe('the expected arrival typed by hand (B-OS-016)', () => {
  it('while packed or on the way, when no carrier label tracks it', () => {
    expect(etaRefusal(facts({ status: 'PACKED' }))).toBeNull()
    expect(etaRefusal(facts({ status: 'SHIPPED', parcels: [test] }))).toBeNull()
    expect(etaRefusal(facts({ status: 'SHIPPED', parcels: [real] }))?.code).toBe('CARRIER_FED')
    expect(etaRefusal(facts({ status: 'DRAFT' }))?.code).toBe('NOT_LEFT_OR_PACKED')
    expect(etaRefusal(facts({ status: 'DELIVERED' }))?.code).toBe('ARRIVED')
    expect(etaRefusal(facts({ status: 'CANCELLED' }))?.code).toBe('CANCELLED')
  })

  it('never before the goods left, at most a year ahead; a reason when it changes one the customer reads', () => {
    const now = new Date('2026-11-22T10:00:00.000Z')
    const since = new Date('2026-11-21T08:00:00.000Z')
    const at = new Date('2026-11-25T12:00:00.000Z')
    const paths = (when: Date | null, before: Date | null, reason: string | null = null) => etaProblems(when, { now, since, before, reason }).map((issue) => issue.path)
    expect(paths(at, null)).toEqual([])
    expect(paths(new Date('2026-11-20T08:00:00.000Z'), null)).toEqual(['body/expectedDeliveryAt'])
    expect(paths(new Date('2028-01-01T00:00:00.000Z'), null)).toEqual(['body/expectedDeliveryAt'])
    // The customer reads the one typed before: changing or clearing it says why; the same day again needs nothing.
    expect(paths(new Date('2026-11-26T12:00:00.000Z'), at)).toEqual(['body/reason'])
    expect(paths(new Date('2026-11-26T12:00:00.000Z'), at, 'The truck was held at the border.')).toEqual([])
    expect(paths(null, at)).toEqual(['body/reason'])
    expect(paths(at, at)).toEqual([])
  })
})
// ---- end B-OS-015, B-OS-016

// ---- B-OS-022 (order shipments 1/1; Owner D4): a tracking number typed by hand per parcel ----
describe('a parcel’s number typed by hand (B-OS-022)', () => {
  it('from PACKED on (also after the goods left), never on a parcel with a label (a TEST one too)', () => {
    const none = { trackingNumber: null, providerId: null }
    expect(parcelTrackingRefusal('PACKED', none)).toBeNull()
    expect(parcelTrackingRefusal('SHIPPED', none)).toBeNull()
    expect(parcelTrackingRefusal('DELIVERED', none)).toBeNull()
    expect(parcelTrackingRefusal('DRAFT', none)).toBe('NOT_PACKED')
    expect(parcelTrackingRefusal('SHIPPED', real)).toBe('PARCEL_LABELLED')
    expect(parcelTrackingRefusal('PACKED', test)).toBe('PARCEL_LABELLED')
    expect(PARCEL_TRACKING_WORDS.PARCEL_LABELLED).toBe('This parcel carries a label: its number comes from the label, never typed.')
    // The shipment's own refusals stay first: cancelled, not a carrier, a carrier's labels.
    expect(trackingRefusal(facts({ status: 'CANCELLED' }))?.code).toBe('CANCELLED')
    expect(trackingRefusal(facts({ transportBy: 'SENDER' }))?.code).toBe('NOT_A_CARRIER') // os-fx4: our own van is transportBy SENDER (OWN_VAN is the arrangement, not a transportBy)
    expect(trackingRefusal(facts({ parcels: [real, { trackingNumber: null, providerId: null }] }))?.code).toBe('LABELLED')
  })

  it('each parcel once, each number and link as the shipment’s own (paths per parcel)', () => {
    const a = 'a0000000-0000-4000-8000-000000000001'
    const b = 'a0000000-0000-4000-8000-000000000002'
    expect(parcelTrackingProblems([{ parcelId: a, trackingNumber: 'AWB 020-1234 5675' }, { parcelId: b, trackingNumber: null }])).toEqual([])
    expect(parcelTrackingProblems([{ parcelId: a, trackingNumber: 'X1' }, { parcelId: a, trackingNumber: 'X2' }]).map((issue) => issue.path)).toEqual(['body/parcels/1/parcelId'])
    expect(parcelTrackingProblems([{ parcelId: a, trackingNumber: 'line\nbreak' }]).map((issue) => issue.path)).toEqual(['body/parcels/0/trackingNumber'])
    expect(parcelTrackingProblems([{ parcelId: a, trackingNumber: null, trackingUrl: 'https://track.example.com/1' }]).map((issue) => issue.path)).toEqual(['body/parcels/0/trackingUrl'])
    expect(parcelTrackingProblems([{ parcelId: a, trackingNumber: 'X1', trackingUrl: 'http://track.example.com/1' }]).map((issue) => issue.path)).toEqual(['body/parcels/0/trackingUrl'])
    expect(parcelTrackingProblems(Array.from({ length: 201 }, (_, index) => ({ parcelId: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, trackingNumber: 'X' }))).map((issue) => issue.path)).toEqual(['body/parcels'])
  })

  it('a number the customer could read (the goods left) changes or is cleared only with a reason of 3 to 500', () => {
    expect(parcelReasonNeeded('SHIPPED', 'AWB-1', 'AWB-2')).toBe(true)
    expect(parcelReasonNeeded('DELIVERED', 'AWB-1', null)).toBe(true)
    expect(parcelReasonNeeded('SHIPPED', null, 'AWB-1')).toBe(false)
    expect(parcelReasonNeeded('SHIPPED', 'AWB-1', 'AWB-1')).toBe(false)
    expect(parcelReasonNeeded('PACKED', 'AWB-1', 'AWB-2')).toBe(false)
    expect(parcelReasonProblems('The courier gave a new air waybill.')).toEqual([])
    expect(parcelReasonProblems(' ok ').map((issue) => issue.path)).toEqual(['body/reason'])
    expect(parcelReasonProblems(undefined)).toHaveLength(1)
    expect(parcelReasonProblems('x'.repeat(501))).toHaveLength(1)
  })

  it('os-fx3: the shipment’s own consignment number the customer could read asks the same reason as a parcel’s', () => {
    // After the goods left: the consignment number changed or cleared says why; typed for the first time, or the same again, does not.
    expect(seenNumbersReasonNeeded('SHIPPED', { consignment: { before: 'AWB-1', after: 'AWB-2' } })).toBe(true)
    expect(seenNumbersReasonNeeded('RETURNED', { consignment: { before: 'AWB-1', after: null } })).toBe(true)
    expect(seenNumbersReasonNeeded('SHIPPED', { consignment: { before: null, after: 'AWB-1' } })).toBe(false)
    expect(seenNumbersReasonNeeded('DELIVERED', { consignment: { before: 'AWB-1', after: 'AWB-1' } })).toBe(false)
    // Before the goods left the customer read no number: nothing asks why.
    expect(seenNumbersReasonNeeded('PACKED', { consignment: { before: 'AWB-1', after: 'AWB-2' }, parcels: [{ before: 'P-1', after: null }] })).toBe(false)
    // Any one number asks it: a parcel's alone, with the consignment number unchanged.
    expect(seenNumbersReasonNeeded('SHIPPED', { consignment: { before: 'AWB-1', after: 'AWB-1' }, parcels: [{ before: null, after: 'P-1' }, { before: 'P-2', after: 'P-3' }] })).toBe(true)
    expect(seenNumbersReasonNeeded('SHIPPED', { parcels: [] })).toBe(false)
    expect(seenNumbersReasonNeeded('SHIPPED', { consignment: null })).toBe(false)
    // The same words and the same field as a parcel's (body/reason, 3 to 500).
    expect(parcelReasonProblems('no').map((issue) => issue.path)).toEqual(['body/reason'])
  })
})
// ---- end B-OS-022
