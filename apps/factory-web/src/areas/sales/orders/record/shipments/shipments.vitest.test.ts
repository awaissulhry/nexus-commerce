import { describe, expect, it } from 'vitest'
import { carrierOf, httpsOrNull, shownShipments, trackingDoorOf, trackingOf, type ShipmentRow } from './model'

/**
 * F-OP-119 (order page plan N5) — the Shipments tab's rows, pure: who carries each shipment, its tracking, the tracking door held
 * with its words and the door that fixes it, the cancelled rows behind "Show N cancelled". Every number is made up.
 */

const row = (over: Partial<ShipmentRow> = {}): ShipmentRow => ({
  id: 'sh-1',
  number: 'SH-2026-0041',
  status: 'SHIPPED',
  shippedAt: '2026-11-12T10:00:00.000Z',
  deliveredAt: null,
  version: 3,
  transportBy: 'CARRIER',
  carrier: { code: 'brt', name: 'BRT' },
  tracking: null,
  expectedDeliveryAt: null,
  ddt: { number: '144/2026', date: '2026-11-12' },
  mayTypeTracking: { allowed: true, code: null, why: null },
  withheld: [],
  ...over,
})

describe('who carries it', () => {
  it('our van, the customer collecting, a carrier booked by hand (its typed number), the aggregator’s carrier', () => {
    expect(carrierOf(row({ transportBy: 'SENDER', carrier: null }))).toEqual({ key: 'ship.carrier.ownVan' })
    expect(carrierOf(row({ transportBy: 'RECIPIENT', carrier: null }))).toEqual({ key: 'ship.carrier.collects' })
    expect(carrierOf(row({ tracking: { number: '123', source: 'TYPED', parcels: [], live: false } }))).toEqual({ key: 'ship.carrier.manual', params: { carrier: 'BRT' } })
    expect(carrierOf(row({ carrier: { code: 'seed-express', name: 'Seed Express' }, tracking: { number: null, source: 'PARCELS', parcels: [{ number: 'P1', url: null }], live: true } }))).toEqual({ key: 'ship.carrier.named', params: { name: 'Seed Express' } })
    expect(carrierOf(row({ carrier: { code: 'gls', name: null } }))).toEqual({ key: 'ship.carrier.named', params: { name: 'gls' } })
  })

  it('withheld from a reader without shipping.view: no carrier said, no tracking shown', () => {
    const blind = row({ carrier: null, tracking: null, withheld: ['shipments.detail'], mayTypeTracking: { allowed: false, code: 'NO_RIGHT', why: 'x' } })
    expect(carrierOf(blind)).toBeNull()
    expect(trackingOf(blind)).toBeNull()
    expect(trackingDoorOf(blind)).toEqual({ kind: 'held', words: { key: 'ship.tracking.held.NO_RIGHT' }, door: null })
    // How it travels is not withheld: our van still says so.
    expect(carrierOf(row({ transportBy: 'SENDER', carrier: null, withheld: ['shipments.detail'] }))).toEqual({ key: 'ship.carrier.ownVan' })
  })
})

describe('its tracking', () => {
  it('a typed number is never live; a label’s parcels keep their https carrier pages only', () => {
    expect(trackingOf(row({ tracking: { number: 'T-123', source: 'TYPED', parcels: [], live: false } }))).toEqual({ typed: 'T-123', live: false, parcels: [] })
    expect(trackingOf(row({ tracking: { number: null, source: 'PARCELS', parcels: [{ number: 'A1', url: 'https://carrier.example.com/A1' }, { number: 'A2', url: 'http://carrier.example.com/A2' }], live: true } }))).toEqual({
      typed: null,
      live: true,
      parcels: [
        { number: 'A1', url: 'https://carrier.example.com/A1' },
        { number: 'A2', url: null },
      ],
    })
    expect(httpsOrNull(' https://x.example.com/1 ')).toBe('https://x.example.com/1')
    expect(httpsOrNull('javascript:alert(1)')).toBeNull()
  })
})

describe('the tracking door: open, or held with its words and the door that fixes it', () => {
  it('open when the read allows it', () => {
    expect(trackingDoorOf(row())).toEqual({ kind: 'open' })
  })

  it('a carrier label: void it on the shipment’s page; our van before it leaves: change how it travels; after: words only', () => {
    expect(trackingDoorOf(row({ mayTypeTracking: { allowed: false, code: 'LABELLED', why: 'x' } }))).toEqual({ kind: 'held', words: { key: 'ship.tracking.held.LABELLED' }, door: 'shipment' })
    expect(trackingDoorOf(row({ status: 'PACKED', transportBy: 'SENDER', mayTypeTracking: { allowed: false, code: 'NOT_A_CARRIER', why: 'x' } }))).toEqual({ kind: 'held', words: { key: 'ship.tracking.held.NOT_A_CARRIER' }, door: 'arrange' })
    expect(trackingDoorOf(row({ status: 'SHIPPED', transportBy: 'SENDER', mayTypeTracking: { allowed: false, code: 'NOT_A_CARRIER', why: 'x' } }))).toEqual({ kind: 'held', words: { key: 'ship.tracking.held.NOT_A_CARRIER_LEFT' }, door: null })
  })

  it('cancelled, tracked by the carrier, or no right (a warehouse person adds it): words, no door', () => {
    for (const code of ['CANCELLED', 'CARRIER_TRACKED', 'NO_RIGHT'] as const) {
      expect(trackingDoorOf(row({ mayTypeTracking: { allowed: false, code, why: 'x' } }))).toEqual({ kind: 'held', words: { key: `ship.tracking.held.${code}` }, door: null })
    }
    expect(trackingDoorOf(row({ mayTypeTracking: undefined }))).toEqual({ kind: 'held', words: { key: 'ship.tracking.held.NO_RIGHT' }, door: null })
    expect(trackingDoorOf(row({ mayTypeTracking: { allowed: false, code: 'SOMETHING_NEW', why: 'x' } }))).toEqual({ kind: 'held', words: { key: 'ship.tracking.held.other' }, door: null })
  })
})

describe('cancelled shipments behind "Show N cancelled"', () => {
  it('hides them until asked, counts them, keeps the read’s order', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', status: 'CANCELLED' }), row({ id: 'c', status: 'DRAFT' }), row({ id: 'd', status: 'CANCELLED' })]
    const hidden = shownShipments(rows, false)
    expect(hidden.rows.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(hidden.cancelled).toBe(2)
    expect(shownShipments(rows, true).rows.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(shownShipments([row()], false).cancelled).toBe(0)
  })
})
