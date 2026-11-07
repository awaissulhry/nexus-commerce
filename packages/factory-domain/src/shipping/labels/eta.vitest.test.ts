import { describe, expect, it } from 'vitest'
import { customerEtaOf, trackingLinkOf } from '../../sales/portal-orders/shipments'
import { expectedDeliveryOf, shipmentEtaOf, trackingPageOf } from './tracking'

/** The carrier's ETA and tracking page (B-W2b-F14; Shipment.expectedDeliveryAt, Parcel.trackingUrl, schema wave 23). */
describe("the carrier's tracking page", () => {
  it('keeps and shows only an https address without spaces, up to 2000 characters', () => {
    expect(trackingPageOf('https://tracking.example.com/FK1')).toBe('https://tracking.example.com/FK1')
    expect(trackingPageOf('  https://tracking.example.com/FK1 ')).toBe('https://tracking.example.com/FK1')
    for (const wrong of ['http://tracking.example.com/FK1', '/track/FK1', 'javascript:alert(1)', 'https://tracking.example.com/a b', 'https://', '', null, undefined]) expect(trackingPageOf(wrong)).toBeNull()
    expect(trackingPageOf(`https://t.example.com/${'x'.repeat(1978)}`)).toHaveLength(2000)
    expect(trackingPageOf(`https://t.example.com/${'x'.repeat(1979)}`)).toBeNull()
  })

  it('is the customer\'s "Track on the carrier\'s site" link only when it is one', () => {
    expect(trackingLinkOf('https://tracking.example.com/FK1')).toEqual({ url: 'https://tracking.example.com/FK1', words: { it: 'Segui sul sito del corriere', en: "Track on the carrier's site" } })
    expect(trackingLinkOf('http://tracking.example.com/FK1')).toBeNull()
    expect(trackingLinkOf(null)).toBeNull()
  })
})

describe("the carrier's expected delivery", () => {
  it('reads an instant as given and a day alone at noon UTC; anything else is no ETA', () => {
    expect(expectedDeliveryOf('2026-11-10T16:30:00.000Z')?.toISOString()).toBe('2026-11-10T16:30:00.000Z')
    expect(expectedDeliveryOf('2026-11-10T17:30:00+01:00')?.toISOString()).toBe('2026-11-10T16:30:00.000Z')
    expect(expectedDeliveryOf('2026-11-10')?.toISOString()).toBe('2026-11-10T12:00:00.000Z')
    for (const wrong of ['2026-02-30', 'tomorrow', '10/11/2026', '', null, undefined]) expect(expectedDeliveryOf(wrong)).toBeNull()
  })

  it("is the shipment's latest parcel's, and the customer sees it only while the goods are packed or on the way", () => {
    const early = new Date('2026-11-10T12:00:00Z')
    const late = new Date('2026-11-12T12:00:00Z')
    expect(shipmentEtaOf([early, null, late])).toEqual(late)
    expect(shipmentEtaOf([null, null])).toBeNull()
    expect(customerEtaOf('PACKED', early)).toEqual(early)
    expect(customerEtaOf('SHIPPED', early)).toEqual(early)
    expect(customerEtaOf('DELIVERED', early)).toBeNull()
    expect(customerEtaOf('RETURNED', early)).toBeNull()
  })
})
