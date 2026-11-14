import { describe, expect, it } from 'vitest'
import { noticeHeld, noticeLocaleOf, noticeMail, type NoticeFacts } from './rules'

/** The shipping notice to the customer (B-W2b-398; LOG-061): behind the site's switch, never a TEST tracking number, in the customer's language. */

const facts = (over: Partial<NoticeFacts> = {}): NoticeFacts => ({
  status: 'SHIPPED',
  parcels: [{ carrierParcelId: 'fk-1:1', trackingNumber: 'FK0001' }],
  manualTrackingNumber: null,
  recipients: 1,
  switchOn: true,
  automatic: true,
  sentBefore: false,
  ...over,
})

describe('when the notice goes', () => {
  it('goes by itself only with the switch on, once; by hand whatever the switch', () => {
    expect(noticeHeld(facts())).toBeNull()
    expect(noticeHeld(facts({ switchOn: false }))).toBe('SWITCH_OFF')
    expect(noticeHeld(facts({ sentBefore: true }))).toBe('SENT')
    expect(noticeHeld(facts({ switchOn: false, automatic: false, sentBefore: true }))).toBeNull()
  })

  it('never for a TEST label, before the goods left, without a tracking number or without a recipient', () => {
    expect(noticeHeld(facts({ parcels: [{ carrierParcelId: 'test:p1.v1', trackingNumber: 'TEST-0a1b2c3d4e-1' }], automatic: false }))).toBe('TEST_LABELS')
    expect(noticeHeld(facts({ status: 'PACKED', automatic: false }))).toBe('NOT_LEFT')
    expect(noticeHeld(facts({ status: 'CANCELLED' }))).toBe('CANCELLED')
    expect(noticeHeld(facts({ parcels: [{ carrierParcelId: null, trackingNumber: null }] }))).toBe('NO_TRACKING')
    expect(noticeHeld(facts({ parcels: [{ carrierParcelId: null, trackingNumber: null }], manualTrackingNumber: 'MAN-1' }))).toBeNull()
    expect(noticeHeld(facts({ recipients: 0, automatic: false }))).toBe('NO_RECIPIENT')
  })
})

describe('the mail', () => {
  it('says the reference, the carrier, each parcel tracking number and page (https only) and what is in it, never a price', () => {
    const mail = noticeMail({
      locale: 'en',
      companyName: 'Demo Factory',
      shipmentNumber: 'SH-0001',
      orderNumber: 'SO-0002',
      customerRef: 'PO-78',
      carrierName: 'Fake Carrier',
      manualTrackingNumber: null,
      expectedDeliveryAt: new Date('2026-11-16T10:00:00.000Z'),
      parcels: [
        { seq: 1, trackingNumber: 'FK0001', trackingUrl: 'https://tracking.example/FK0001', contents: [{ style: 'GP1 Jacket', colour: 'Black', sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }] }] },
        { seq: 2, trackingNumber: 'FK0002', trackingUrl: 'http://insecure.example/FK0002', contents: [] },
      ],
    })
    expect(mail.subject).toBe('Your order PO-78 is on its way - Demo Factory')
    expect(mail.text).toContain('your order PO-78 has left us. (our order SO-0002)')
    expect(mail.text).toContain('Expected delivery: 16 November 2026')
    expect(mail.text).toContain('Tracking number: FK0001 - https://tracking.example/FK0001')
    expect(mail.text).toContain('Tracking number: FK0002\n')
    expect(mail.text).toContain('- GP1 Jacket · Black: 50 × 1, 52 × 2 (3 pieces)')
    expect(mail.html).not.toContain('http://insecure.example')
    expect(noticeMail({ locale: 'it', companyName: 'Demo', shipmentNumber: 'SH-1', orderNumber: null, customerRef: null, carrierName: null, manualTrackingNumber: 'MAN-1', expectedDeliveryAt: null, parcels: [] }).subject).toBe('Il Suo ordine SH-1 è in viaggio - Demo')
  })

  it('speaks the contact language, else the customer one, else the order one, else Italian', () => {
    expect(noticeLocaleOf('en', 'it')).toBe('en')
    expect(noticeLocaleOf(null, 'it', 'en')).toBe('it')
    expect(noticeLocaleOf(null, null, 'de')).toBe('en')
    expect(noticeLocaleOf(null, undefined)).toBe('it')
  })
})
