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
