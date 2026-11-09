import { describe, expect, it } from 'vitest'
import { linkPermissions } from '../../links/purposes'
import { trackingLinkMail } from './mail'
import {
  claimHeld,
  deliveryPlaceOf,
  expectedDeliveryOf,
  makeHeld,
  normalPostcode,
  normalReference,
  papersShown,
  postcodeMatches,
  searchProblems,
  trackerOf,
  trackingEndsAt,
  trackingOpen,
  type TrackerFacts,
} from './rules'

const at = (iso: string) => new Date(iso)
const NOW = at('2026-11-20T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const base: TrackerFacts = { status: 'SHIPPED', packedAt: at('2026-11-10T08:00:00.000Z'), shippedAt: at('2026-11-10T15:00:00.000Z'), deliveredAt: null, returnedAt: null, events: [] }
const event = (status: TrackerFacts['events'][number]['status'], iso: string, parcelId: string | null = 'p1') => ({ status, occurredAt: at(iso), parcelId })

describe('where it is (B-W2b-170, links.tracking sec:tracker)', () => {
  it('a packed shipment waits for the carrier: Packed is now, the rest to come', () => {
    const tracker = trackerOf({ ...base, status: 'PACKED', shippedAt: null })
    expect(tracker.pill).toBe('PACKED')
    expect(tracker.steps.map((step) => [step.code, step.state])).toEqual([
      ['PACKED', 'CURRENT'],
      ['COLLECTED', 'TODO'],
      ['IN_TRANSIT', 'TODO'],
      ['OUT_FOR_DELIVERY', 'TODO'],
      ['DELIVERED', 'TODO'],
    ])
  })

  it('collected, then the carrier\'s first scan on the way, then out for delivery, each with its time', () => {
    expect(trackerOf(base).pill).toBe('COLLECTED')
    const moving = trackerOf({ ...base, events: [event('LABEL_CREATED', '2026-11-10T10:00:00Z'), event('IN_TRANSIT', '2026-11-11T07:00:00Z'), event('IN_TRANSIT', '2026-11-12T07:00:00Z')] })
    expect(moving.pill).toBe('IN_TRANSIT')
    expect(moving.steps[2]).toEqual({ code: 'IN_TRANSIT', state: 'CURRENT', at: at('2026-11-11T07:00:00Z') })
    const out = trackerOf({ ...base, events: [event('IN_TRANSIT', '2026-11-11T07:00:00Z'), event('OUT_FOR_DELIVERY', '2026-11-13T06:30:00Z')] })
    expect(out.pill).toBe('OUT_FOR_DELIVERY')
    expect(out.steps.map((step) => step.state)).toEqual(['DONE', 'DONE', 'DONE', 'CURRENT', 'TODO'])
  })

  it('delivered: every step done, the day it arrived; a step passed without its own scan has no time', () => {
    const tracker = trackerOf({ ...base, status: 'DELIVERED', deliveredAt: at('2026-11-13T11:00:00Z'), events: [event('DELIVERED', '2026-11-13T11:00:00Z')] })
    expect(tracker.pill).toBe('DELIVERED')
    expect(tracker.steps.every((step) => step.state === 'DONE')).toBe(true)
    expect(tracker.steps[3]!.at).toBeNull()
    expect(tracker.steps[4]!.at).toEqual(at('2026-11-13T11:00:00Z'))
  })

  it('a problem: the carrier\'s delay, a parcel going back, the goods back with us', () => {
    expect(trackerOf({ ...base, events: [event('IN_TRANSIT', '2026-11-11T07:00:00Z'), event('EXCEPTION', '2026-11-12T07:00:00Z')] })).toMatchObject({ pill: 'PROBLEM', problem: 'DELAYED' })
    // The newest news of the parcel counts: a delay that was followed by a scan on the way is over.
    expect(trackerOf({ ...base, events: [event('EXCEPTION', '2026-11-12T07:00:00Z'), event('IN_TRANSIT', '2026-11-12T19:00:00Z')] }).problem).toBeNull()
    expect(trackerOf({ ...base, events: [event('RETURNED', '2026-11-14T07:00:00Z')] }).problem).toBe('RETURNING')
    expect(trackerOf({ ...base, status: 'RETURNED', returnedAt: at('2026-11-16T07:00:00Z') })).toMatchObject({ pill: 'PROBLEM', problem: 'RETURNED' })
  })

  it('says the expected delivery only while packed or on the way', () => {
    const eta = at('2026-11-14T12:00:00Z')
    expect(expectedDeliveryOf('SHIPPED', eta)).toEqual(eta)
    expect(expectedDeliveryOf('PACKED', eta)).toEqual(eta)
    expect(expectedDeliveryOf('DELIVERED', eta)).toBeNull()
  })
})

describe('how long it answers (expiry 60 days after delivery)', () => {
  it('ends at the link\'s expiry, or 60 days after the goods arrived or came back, whichever is first', () => {
    const expires = at('2027-05-01T00:00:00Z')
    expect(trackingEndsAt(expires, { deliveredAt: null, returnedAt: null })).toEqual(expires)
    expect(trackingEndsAt(expires, { deliveredAt: at('2026-11-13T11:00:00Z'), returnedAt: null })).toEqual(new Date(at('2026-11-13T11:00:00Z').getTime() + 60 * DAY))
    expect(trackingEndsAt(at('2026-12-01T00:00:00Z'), { deliveredAt: at('2026-11-13T11:00:00Z'), returnedAt: null })).toEqual(at('2026-12-01T00:00:00Z'))
  })

  it('opens only a shipment that is packed, on the way, delivered or back, before that end', () => {
    const expires = at('2027-05-01T00:00:00Z')
    expect(trackingOpen({ status: 'SHIPPED', deliveredAt: null, returnedAt: null }, expires, NOW)).toBe(true)
    expect(trackingOpen({ status: 'DRAFT', deliveredAt: null, returnedAt: null }, expires, NOW)).toBe(false)
    expect(trackingOpen({ status: 'CANCELLED', deliveredAt: null, returnedAt: null }, expires, NOW)).toBe(false)
    expect(trackingOpen({ status: 'DELIVERED', deliveredAt: new Date(NOW.getTime() - 61 * DAY), returnedAt: null }, expires, NOW)).toBe(false)
  })

  it('makes no link for a shipment not packed, cancelled, back with us, or delivered more than 60 days ago', () => {
    expect(makeHeld({ status: 'DRAFT', deliveredAt: null, returnedAt: null }, NOW)).toBe('NOT_PACKED')
    expect(makeHeld({ status: 'CANCELLED', deliveredAt: null, returnedAt: null }, NOW)).toBe('CANCELLED')
    expect(makeHeld({ status: 'RETURNED', deliveredAt: null, returnedAt: NOW }, NOW)).toBe('RETURNED')
    expect(makeHeld({ status: 'DELIVERED', deliveredAt: new Date(NOW.getTime() - 61 * DAY), returnedAt: null }, NOW)).toBe('ENDED')
    expect(makeHeld({ status: 'PACKED', deliveredAt: null, returnedAt: null }, NOW)).toBeNull()
  })
})

describe('what the page shows of the address, the papers and the claim', () => {
  it('the town, postcode and country only: never the name, street or phone', () => {
    const place = deliveryPlaceOf({ name: 'Made-up Rider', line1: 'Via Esempio 12', postalCode: '40100', city: 'Bologna', country: 'it', phone: '+39 000' })
    expect(place).toEqual({ city: 'Bologna', postcode: '40100', country: 'IT' })
    expect(JSON.stringify(place)).not.toMatch(/Esempio|Rider|\+39/)
    expect(deliveryPlaceOf(null)).toEqual({ city: null, postcode: null, country: null })
  })

  it('papers and a claim for our own links; a link found by the public search sends to our e-mail instead', () => {
    expect(papersShown('SHIPPED')).toBe(true)
    expect(papersShown('PORTAL')).toBe(true)
    expect(papersShown('SEARCH')).toBe(false)
    expect(claimHeld('SHIPPED', 'SHIPPED')).toBeNull()
    expect(claimHeld('DELIVERED', 'OFFICE')).toBeNull()
    expect(claimHeld('SHIPPED', 'SEARCH')).toBe('SEARCH')
    expect(claimHeld('PACKED', 'SHIPPED')).toBe('NOT_LEFT')
    expect(claimHeld('RETURNED', 'SHIPPED')).toBe('RETURNED')
  })

  it('the link session holds no money: open and download only', () => {
    expect(linkPermissions('SHIPMENT_TRACK')).toEqual(['links.download', 'links.open'])
  })
})

describe('the public search (sec:search)', () => {
  it('normalises the reference and the postcode', () => {
    expect(normalReference('  PO   4500-1234 ')).toBe('PO 4500-1234')
    expect(normalPostcode('40 100')).toBe('40100')
    expect(normalPostcode('sw1a-1aa')).toBe('SW1A1AA')
    expect(postcodeMatches({ postalCode: '40100' }, ' 40 100 ')).toBe(true)
    expect(postcodeMatches({ postalCode: '40100' }, '40121')).toBe(false)
    expect(postcodeMatches({}, '40100')).toBe(false)
    expect(postcodeMatches({ postalCode: '' }, '')).toBe(false)
  })

  it('says what is missing per field before anything is looked up', () => {
    expect(searchProblems({ reference: ' ', postcode: '' }).map((issue) => issue.path)).toEqual(['body/reference', 'body/postcode'])
    expect(searchProblems({ reference: 'x'.repeat(61), postcode: '40100' })[0]!.path).toBe('body/reference')
    expect(searchProblems({ reference: 'PO-1', postcode: '40/100' })[0]!.path).toBe('body/postcode')
    expect(searchProblems({ reference: 'PO-1', postcode: '40100' })).toEqual([])
  })
})

describe('the mail (it/en), never stored with its link', () => {
  const input = { locale: 'en' as const, companyName: 'Officina Demo', shipmentNumber: 'SH-26-0042', orderNumber: 'SO-0007', customerRef: '4500-1234', status: 'SHIPPED' as const, carrierName: 'Demo Express', expectedDeliveryAt: at('2026-11-14T12:00:00Z'), renewal: false }

  it('names the customer\'s own reference first, the carrier and the expected day, then the link', () => {
    const mail = trackingLinkMail(input, 'https://factory.example/l#token=abc')
    expect(mail.subject).toBe('Your order 4500-1234 — Officina Demo')
    expect(mail.body).toContain('your order 4500-1234 is on its way (shipment SH-26-0042).')
    expect(mail.body).toContain('Carrier: Demo Express.')
    expect(mail.body).toContain('Expected delivery: 14 November 2026.')
    expect(mail.body).toContain('https://factory.example/l#token=abc')
  })

  it('in Italian, and without the link when none is given', () => {
    const mail = trackingLinkMail({ ...input, locale: 'it', status: 'PACKED', expectedDeliveryAt: null }, null)
    expect(mail.subject).toBe('Il suo ordine 4500-1234 — Officina Demo')
    expect(mail.body).toContain('è imballato e attende il corriere')
    expect(mail.body).not.toContain('token=')
    expect(mail.body).not.toContain('Consegna prevista')
  })
})
