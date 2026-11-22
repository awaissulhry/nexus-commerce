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
