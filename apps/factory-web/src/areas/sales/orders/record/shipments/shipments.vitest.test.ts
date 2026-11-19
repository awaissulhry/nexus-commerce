import { describe, expect, it } from 'vitest'
import { carrierOf, httpsOrNull, shownShipments, trackingDoorOf, trackingOf, type ShipmentRow } from './model'
// F-OP-121: where Create shipment… leads.
import { createShipmentDoor } from './model'
import { canOf, order } from '../../_demo/fixtures'
// F-OP-122: shared shipments.
import { alsoCarries, joinableRows } from './model'
import { typedLinkOf } from './model' // F-OP-135
import { trackingBody, trackingProblem } from '../../../../warehouse/shipments/booking/model'
import type { JoinableShipments } from '../../../../warehouse/shipments/api'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'

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

// ── F-OP-121 (order page plan N6): where Create shipment… leads ──────────────────────────────────────────────────────────────────
describe('F-OP-121: Create shipment… opens in place on the order page', () => {
  const ready = order('READY', { progress: { ...order('READY').progress, released: 6, shipped: 2 } })
  it('in place with the container, else Warehouse’s New shipment with this order chosen', () => {
    expect(createShipmentDoor(ready, canOf('owner'), '/f', true)).toEqual({ kind: 'inPlace' })
    expect(createShipmentDoor(ready, canOf('owner'), '/f', false)).toEqual({ kind: 'warehouse', href: `/f/warehouse/shipments?new=1&order=${encodeURIComponent(ready.id)}` })
  })
  it('nothing without released garments left to ship, on a final order, or without shipping.manage', () => {
    expect(createShipmentDoor({ ...ready, progress: { ...ready.progress, shipped: 6 } }, canOf('owner'), '/f', true)).toBeNull()
    expect(createShipmentDoor({ ...ready, status: 'CANCELLED' }, canOf('owner'), '/f', true)).toBeNull()
    expect(createShipmentDoor(ready, canOf('sales'), '/f', true)).toBeNull()
  })
})
// ── end F-OP-121 ──

// ── F-OP-122 (order page plan N6): shared shipments on the order ─────────────────────────────────────────────────────────────────
describe('F-OP-122: a shared shipment names its other orders; the customer’s DRAFTs offer to take this order’s garments', () => {
  it('"Also carries SO-…": every other order of the shipment, never this one; none on a shipment of this order alone', () => {
    const shared = row({ orders: [{ id: 'so-1', number: 'SO-2026-0150', customerRef: 'PO 4471' }, { id: 'so-2', number: 'SO-2026-0151', customerRef: null }] })
    expect(alsoCarries(shared, 'so-1')).toEqual([{ id: 'so-2', number: 'SO-2026-0151' }])
    expect(alsoCarries(shared, 'so-2')).toEqual([{ id: 'so-1', number: 'SO-2026-0150' }])
    expect(alsoCarries(row({ orders: [{ id: 'so-1', number: 'SO-2026-0150', customerRef: null }] }), 'so-1')).toEqual([])
    expect(alsoCarries(row(), 'so-1')).toEqual([])
  })

  it('offers the DRAFTs the order may join (B-OP-047: N6 on); one held for any reason — another site or address, a hold — not at all', () => {
    const draft = (shipmentId: string, joinable: { allowed: boolean; code: 'CUSTOMER_HOLD' | 'SITE' | 'SHIP_TO' | 'SHIPMENT_STATE' | null; why: string | null }, status = 'DRAFT') => ({ shipmentId, number: `SH-${shipmentId}`, status, siteId: 'site-1', joinable }) as JoinableShipments['shipments'][number]
    expect(
      joinableRows([
        draft('1', { allowed: false, code: 'CUSTOMER_HOLD', why: 'x' }),
        draft('2', { allowed: true, code: null, why: null }),
        draft('3', { allowed: false, code: 'SITE', why: 'x' }),
        draft('4', { allowed: false, code: 'SHIP_TO', why: 'x' }),
        draft('5', { allowed: true, code: null, why: null }, 'PACKED'),
      ]),
    ).toEqual([{ shipmentId: '2', number: 'SH-2', held: null }])
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['ship.join.title', 'ship.join.add']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('ship.alsoCarries', { number: 'SO-2026-0151' }), locale).toContain('SO-2026-0151')
      expect(t('ship.joined', { count: 3, number: 'SH-0091' }), locale).toContain('SH-0091')
    }
  })
})
// ── end F-OP-122 ──

// ── F-OP-135 (B-OP-034): the link typed beside a hand-booked carrier's number — the row's Track › ──────────────────────────────────────
describe('F-OP-135: the typed link is the row’s Track › (https only)', () => {
  const typed = (url: string | null | undefined, number: string | null = 'T-123') => row({ tracking: { number, source: 'TYPED', parcels: [], live: false, url } })
  it('an https link typed beside the number; anything else, or no number, none', () => {
    expect(typedLinkOf(typed('https://track.example.com/T-123'))).toBe('https://track.example.com/T-123')
    expect(typedLinkOf(typed('http://track.example.com/T-123'))).toBeNull()
    expect(typedLinkOf(typed('javascript:alert(1)'))).toBeNull()
    expect(typedLinkOf(typed(null))).toBeNull()
    expect(typedLinkOf(typed(undefined))).toBeNull()
    expect(typedLinkOf(typed('https://track.example.com/T-123', null))).toBeNull()
    // A label's parcels keep their own pages; the row has no typed link then.
    expect(typedLinkOf(row({ tracking: { number: null, source: 'PARCELS', parcels: [{ number: 'A1', url: 'https://carrier.example.com/A1' }], live: true, url: null } }))).toBeNull()
  })
  it('the tracking dialog’s "Link (optional, https)": only with its number, the API’s own rule; blank clears it', () => {
    const dialog = (text: string, link?: string) => ({ kind: 'tracking' as const, text, ...(link === undefined ? {} : { link }) })
    expect(trackingProblem(dialog('T-1', 'https://track.example.com/T-1'))).toBeNull()
    expect(trackingProblem(dialog('T-1'))).toBeNull()
    expect(trackingProblem(dialog('', 'https://track.example.com/T-1'))?.key).toBe('transport.form.linkNeedsNumber')
    // op-fx4 (B-OP-034): the number emptied while the shipment has one is Clear it — the link left in the box goes with it, never held.
    expect(trackingProblem(dialog('', 'https://track.example.com/T-1'), 'T-1')).toBeNull()
    expect(trackingProblem(dialog('', 'http://not-https.example.com/T-1'), 'T-1')).toBeNull()
    expect(trackingProblem(dialog('', 'https://track.example.com/T-1'), null)?.key).toBe('transport.form.linkNeedsNumber')
    expect(trackingProblem(dialog('T-2', 'http://track.example.com/T-2'), 'T-1')?.key).toBe('transport.form.trackingLink')
    for (const bad of ['http://track.example.com/T-1', 'https://someone:secret@track.example.com/T-1', 'javascript:alert(1)', `https://track.example.com/${'x'.repeat(500)}`]) expect(trackingProblem(dialog('T-1', bad))?.key, bad).toBe('transport.form.trackingLink')
    expect(trackingBody(dialog(' T-1 ', ' https://track.example.com/T-1 '), 4)).toEqual({ version: 4, trackingNumber: 'T-1', trackingUrl: 'https://track.example.com/T-1' })
    expect(trackingBody(dialog('T-1', ''), 4)).toEqual({ version: 4, trackingNumber: 'T-1', trackingUrl: null })
    // The number cleared clears its link too.
    expect(trackingBody(dialog('', 'https://track.example.com/T-1'), 4)).toEqual({ version: 4, trackingNumber: null, trackingUrl: null })
  })
  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const depth = messagesFor(locale, ['warehouse-shipments-depth'])['warehouse-shipments-depth']!
      for (const key of ['transport.trackingLink', 'transport.trackingLinkHint', 'transport.form.linkNeedsNumber']) expect(createTranslator(locale, depth)(key), `${locale} ${key}`).not.toBe(key)
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('ship.track'), locale).not.toBe('ship.track')
      expect(t('ship.trackLink', { number: 'SH-0091' }), locale).toContain('SH-0091')
    }
  })
})
// ── end F-OP-135 ──
