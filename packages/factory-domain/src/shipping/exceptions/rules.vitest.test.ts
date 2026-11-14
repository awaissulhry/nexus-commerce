import { describe, expect, it } from 'vitest'
import { exceptionKindOf, exceptionsDue, exceptionTaskOf, hasTestLabel, NO_SCAN_DAYS, type ExceptionFacts } from './rules'

/** Tracking problems (B-W2b-398; LOG-063): which carrier news is which problem, what the daily check raises, never for a TEST label. */

const NOW = new Date('2026-11-14T09:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const parcel = { id: 'p1', carrierParcelId: 'fk-1:1', trackingNumber: 'FK0001', labelledAt: new Date(NOW.getTime() - 5 * DAY) }

const facts = (over: Partial<ExceptionFacts> = {}): ExceptionFacts => ({
  status: 'SHIPPED',
  shippedAt: new Date(NOW.getTime() - 4 * DAY),
  expectedDeliveryAt: null,
  parcels: [parcel],
  latest: new Map([['p1', { status: 'IN_TRANSIT', occurredAt: new Date(NOW.getTime() - HOUR), carrierStatusCode: 'in_transit', description: null }]]),
  open: [],
  ...over,
})

describe('the kind of a carrier problem', () => {
  it('reads Sendcloud webhook ids, v3 codes and, else, the carrier words; anything unnamed is a delay', () => {
    expect(exceptionKindOf('8', 'Delivery attempt failed')).toBe('FAILED_DELIVERY')
    expect(exceptionKindOf('4', null)).toBe('DELAYED')
    expect(exceptionKindOf('62992', null)).toBe('FAILED_DELIVERY')
    expect(exceptionKindOf('exception:address_error', null)).toBe('ADDRESS_PROBLEM')
    expect(exceptionKindOf('attempted', null)).toBe('FAILED_DELIVERY')
    expect(exceptionKindOf('unknown', 'Customer not home')).toBe('FAILED_DELIVERY')
    expect(exceptionKindOf('exception:something_new', null)).toBe('DELAYED')
  })
})

describe('what is due on a travelling shipment', () => {
  it('raises the newest news when it is an exception, at the carrier time', () => {
    const at = new Date(NOW.getTime() - 2 * HOUR)
    expect(exceptionsDue(facts({ latest: new Map([['p1', { status: 'EXCEPTION', occurredAt: at, carrierStatusCode: 'exception:address_error', description: null }]]) }), NOW)).toEqual([{ kind: 'ADDRESS_PROBLEM', raisedAt: at }])
  })

  it(`raises NO_SCAN after ${NO_SCAN_DAYS} days without news, and DELAYED once the expected day passed`, () => {
    const silent = new Map([['p1', { status: 'IN_TRANSIT' as const, occurredAt: new Date(NOW.getTime() - NO_SCAN_DAYS * DAY - HOUR), carrierStatusCode: 'in_transit', description: null }]])
    expect(exceptionsDue(facts({ latest: silent }), NOW)).toEqual([{ kind: 'NO_SCAN', raisedAt: NOW }])
    expect(exceptionsDue(facts({ expectedDeliveryAt: new Date('2026-11-12T10:00:00.000Z') }), NOW)).toEqual([{ kind: 'DELAYED', raisedAt: NOW }])
    expect(exceptionsDue(facts({ expectedDeliveryAt: new Date('2026-11-14T16:00:00.000Z') }), NOW)).toEqual([])
  })

  it('never raises one already open, nothing once delivered or not left, and nothing for a TEST label or a parcel without a carrier', () => {
    expect(exceptionsDue(facts({ expectedDeliveryAt: new Date('2026-11-12T10:00:00.000Z'), open: ['DELAYED'] }), NOW)).toEqual([])
    expect(exceptionsDue(facts({ status: 'DELIVERED', expectedDeliveryAt: new Date('2026-11-12T10:00:00.000Z') }), NOW)).toEqual([])
    expect(exceptionsDue(facts({ status: 'PACKED', expectedDeliveryAt: new Date('2026-11-12T10:00:00.000Z') }), NOW)).toEqual([])
    const test = { ...parcel, carrierParcelId: 'test:p1.v1', trackingNumber: 'TEST-0a1b2c3d4e-1' }
    expect(hasTestLabel([test])).toBe(true)
    expect(exceptionsDue(facts({ parcels: [test], latest: new Map(), expectedDeliveryAt: new Date('2026-11-12T10:00:00.000Z') }), NOW)).toEqual([])
    expect(exceptionsDue(facts({ parcels: [{ ...parcel, carrierParcelId: null }], latest: new Map() }), NOW)).toEqual([])
  })

  it('names the task in the company language', () => {
    expect(exceptionTaskOf('SH-0001', 'FAILED_DELIVERY', 'it-IT').title).toBe('Problema di tracciamento su SH-0001: Consegna non riuscita')
    expect(exceptionTaskOf('SH-0001', 'NO_SCAN', 'en').title).toBe(`Tracking problem on SH-0001: No carrier news for ${NO_SCAN_DAYS} days`)
  })
})
