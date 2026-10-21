/**
 * Meta step 33 — the Conversions API draft (pure): it sends only to a consolidated dataset, only sales the shop never saw
 * (taken in by hand in Nexus, so no website gap check applies: review F3) — never a sale of the shop's website
 * (the shop platform sends those with an event_id Nexus cannot rebuild) or of a marketplace —, never an order older than
 * 7 days (less a margin) or one Meta confirmed, and the buyer's e-mail and phone only hashed, as Meta normalises them.
 * Nothing a person reads, nor the plan it is checked by, carries a hash or a plain value. Made-up ids and buyers.
 */
import { describe, expect, it } from 'vitest'
import { metaEventsDataProblem } from '../../gateway/meta-events-rules.js'
import { AGE_MARGIN_S, eventIdOf, eventsDraft, eventsWindowProblem, MAX_EVENTS_PER_CHANGE, metaCountry, metaEmail, metaPhone, sha256Hex, type EventsLive, type EventsRequest } from './change-events.js'
import type { EventOrder } from './events-orders.js'

const NOW = new Date('2026-10-21T12:00:00Z')
const PIXEL = '120000000000050'
const EMAIL = 'Buyer.One@Example.com '
const order = (o: Partial<EventOrder> = {}): EventOrder => ({
  orderId: 'ord-1', channel: 'MANUAL', channelOrderId: 'M-1001', status: 'DELIVERED', at: new Date('2026-10-19T10:00:00Z'), cancelled: false,
  totalCents: 4990, currency: 'EUR', email: EMAIL, phone: '+39 333 123 4567', country: 'IT', customerKey: 'cust-1',
  items: [{ sku: 'SKU-1', quantity: 2, priceCents: 2495 }], ...o,
})
const live = (o: Partial<EventsLive> = {}): EventsLive => ({
  pixel: { pixelId: PIXEL, consolidated: true },
  orders: [order()], sent: new Map(), firstOrderAt: new Map(), now: NOW, ...o,
})
const request = (o: Partial<EventsRequest> = {}): EventsRequest => ({ pixelId: PIXEL, from: '2026-10-15', to: '2026-10-20', manualAs: 'phone_call', customerSegment: false, contents: false, ...o })
const draftOf = (r = request(), l = live()) => {
  const d = eventsDraft(r, l)
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}
const events = (r = request(), l = live()) => JSON.parse(draftOf(r, l).requests[0].params.data) as Array<Record<string, any>>

describe('normalising and hashing as Meta asks', () => {
  it('e-mail trimmed and lower-cased; phone digits with its country code only; country ISO-2 lower case', () => {
    expect(metaEmail(EMAIL)).toBe('buyer.one@example.com')
    expect(metaEmail('not an e-mail')).toBeNull()
    expect(metaPhone('+39 333 123 4567')).toBe('393331234567')
    expect(metaPhone('0039 (333) 123-4567')).toBe('393331234567')
    expect(metaPhone('333 123 4567')).toBeNull()
    expect(metaPhone('+0 333')).toBeNull()
    expect(metaCountry(' IT ')).toBe('it')
    expect(metaCountry('Italy')).toBeNull()
  })
  it('sends the SHA-256 of the normalised values, and nothing plain', () => {
    const [e] = events()
    expect(e.user_data).toEqual({ em: [sha256Hex('buyer.one@example.com')], ph: [sha256Hex('393331234567')], country: [sha256Hex('it')] })
    const raw = draftOf().requests[0].params.data
    expect(raw).not.toMatch(/example\.com|393331234567|Buyer/i)
  })
})

describe('when Nexus sends (D2)', () => {
  it('a hand-typed sale needs no website gap check (the shop never saw it); the preview says why', () => {
    expect(draftOf().warnings.join(' ')).toMatch(/no pixel or server of the shop can have sent them, so they need no website check/)
  })
  it('only to a consolidated dataset', () => {
    expect(eventsDraft(request(), live({ pixel: { pixelId: PIXEL, consolidated: false } }))).toEqual({ refusal: expect.stringMatching(/not a consolidated dataset/) })
    expect(eventsDraft(request(), live({ pixel: { pixelId: PIXEL, consolidated: null } }))).toEqual({ refusal: expect.stringMatching(/not shown to be a consolidated dataset/) })
  })
  it('never a sale of the shop\'s website (Shopify, WooCommerce) nor of a marketplace; manual sales go', () => {
    const orders = [
      order({ orderId: 'ord-s', channel: 'SHOPIFY', channelOrderId: '5001' }),
      order({ orderId: 'ord-w', channel: 'WOOCOMMERCE', channelOrderId: '77' }),
      order({ orderId: 'ord-a', channel: 'AMAZON', channelOrderId: '402-1' }),
      order({ orderId: 'ord-e', channel: 'EBAY', channelOrderId: '12-1' }),
      order({ orderId: 'ord-t', channel: 'ETSY', channelOrderId: '9' }),
      order(),
    ]
    const d = draftOf(request(), live({ orders }))
    expect(d.requests[0].sales.map((s) => s.orderId)).toEqual(['ord-1'])
    expect(d.skipped.join(' ')).toMatch(/2 orders not sent — sold on the shop's website: the shop platform's own Meta pixel and Conversions API send that purchase with an event_id Nexus cannot rebuild/)
    expect(d.skipped.join(' ')).toMatch(/3 orders not sent — sold on a marketplace/)
    expect(eventsDraft(request(), live({ orders: orders.slice(0, 5) }))).toEqual({ refusal: expect.stringMatching(/^No sale to send/) })
  })
  it('a manual sale needs to be said how it was made (Meta: action_source accurate)', () => {
    expect(eventsDraft(request({ manualAs: undefined }), live())).toEqual({ refusal: expect.stringMatching(/say how such sales were made \(manualAs\)/) })
    expect(events(request({ manualAs: 'physical_store' }))[0].action_source).toBe('physical_store')
  })
  it('each event: Purchase, the sale\'s time in seconds, event_id nexus.<order id>, value and currency of the order', () => {
    const [e] = events()
    expect(e).toMatchObject({ event_name: 'Purchase', event_time: Date.parse('2026-10-19T10:00:00Z') / 1000, event_id: eventIdOf('ord-1'), action_source: 'phone_call' })
    expect(e.custom_data).toEqual({ value: 49.9, currency: 'EUR', order_id: 'ord-1' })
    expect(e).not.toHaveProperty('event_source_url')
    expect(e).not.toHaveProperty('data_processing_options')
    expect(draftOf().requests[0].params).toMatchObject({ partner_agent: 'nexus' })
  })
  it('the request passes the gateway\'s own judge', () => {
    const d = draftOf(request({ contents: true, customerSegment: true }))
    expect(metaEventsDataProblem(d.requests[0].params.data, Math.floor(NOW.getTime() / 1000))).toBeNull()
  })
  it('an order older than 7 days less the margin is left out and named (one would refuse the whole request)', () => {
    const old = new Date(NOW.getTime() - (7 * 86_400 - AGE_MARGIN_S + 60) * 1000)
    const d = draftOf(request({ orderIds: ['ord-1', 'ord-2'], from: undefined, to: undefined }), live({ orders: [order(), order({ orderId: 'ord-2', channelOrderId: 'M-1002', at: old })] }))
    expect(d.requests[0].sales.map((s) => s.orderId)).toEqual(['ord-1'])
    expect(d.skipped.join(' ')).toMatch(/older than 7 days by the time it would be sent/)
  })
  it('cancelled, refunded, returned or unpaid orders, and orders without a matchable e-mail or phone, stay out', () => {
    const orders = [
      order({ orderId: 'c', status: 'CANCELLED' }), order({ orderId: 'r', status: 'REFUNDED' }), order({ orderId: 'x', status: 'RETURNED' }),
      order({ orderId: 'p', status: 'AWAITING_PAYMENT' }), order({ orderId: 'k', cancelled: true }),
      order({ orderId: 'n', email: null, phone: '333 123 4567' }), order({ orderId: 'v', totalCents: 0 }), order({ orderId: 'y', currency: null }),
    ]
    const d = eventsDraft(request(), live({ orders }))
    expect(d).toEqual({ refusal: expect.stringMatching(/cancelled, refunded, returned or not paid.*no e-mail or phone Meta can match/s) })
  })
})

describe('never twice', () => {
  it('an order Meta confirmed is never sent again', () => {
    const sent = new Map([['ord-1', { orderId: 'ord-1', eventId: eventIdOf('ord-1'), pixelId: PIXEL, eventTime: null, sentAt: new Date(NOW.getTime() - 3_600_000), confirmed: true }]])
    expect(eventsDraft(request(), live({ sent }))).toEqual({ refusal: expect.stringMatching(/sent before and confirmed by Meta \(never sent twice\)/) })
  })
  it('one Meta did not confirm goes again within 46 hours with the SAME event_id, never later', () => {
    const at = (hours: number, eventTime: Date | null = new Date('2026-10-19T10:00:00Z')) => new Map([['ord-1', { orderId: 'ord-1', eventId: 'nexus.ord-1', pixelId: PIXEL, eventTime, sentAt: new Date(NOW.getTime() - hours * 3_600_000), confirmed: false }]])
    const d = draftOf(request(), live({ sent: at(10) }))
    expect(JSON.parse(d.requests[0].params.data)[0]).toMatchObject({ event_id: 'nexus.ord-1', event_time: Date.parse('2026-10-19T10:00:00Z') / 1000 })
    expect(d.warnings.join(' ')).toMatch(/sent again with the same event_id/)
    expect(eventsDraft(request(), live({ sent: at(47) }))).toEqual({ refusal: expect.stringMatching(/more than 46 hours ago/) })
  })
  it('review B2 — a resend goes only with the sale time it went with (Meta\'s offline rule merges by event_time too)', () => {
    const sent = new Map([['ord-1', { orderId: 'ord-1', eventId: 'nexus.ord-1', pixelId: PIXEL, eventTime: new Date('2026-10-19T09:00:00Z'), sentAt: new Date(NOW.getTime() - 3_600_000), confirmed: false }]])
    expect(eventsDraft(request(), live({ sent }))).toEqual({ refusal: expect.stringMatching(/its sale time changed since/) })
    expect(draftOf().warnings.join(' ')).toMatch(/same event_time, event_name and order_id within 7 days/)
  })
})

describe('options', () => {
  it('a test code goes with the request and the preview says Meta counts test events', () => {
    const d = draftOf(request({ testEventCode: 'TEST123' }))
    expect(d.requests[0].params.test_event_code).toBe('TEST123')
    expect(d.warnings.join(' ')).toMatch(/NOT a dry run: Meta does not drop test events/)
  })
  it('contents: SKU, quantity and price; buyer segment from the orders Nexus holds', () => {
    const returning = live({ firstOrderAt: new Map([['cust-1', new Date('2026-01-01T00:00:00Z')]]) })
    const [e] = events(request({ contents: true, customerSegment: true }), returning)
    expect(e.custom_data).toEqual({ value: 49.9, currency: 'EUR', order_id: 'ord-1', content_type: 'product', contents: [{ id: 'SKU-1', quantity: 2, item_price: 24.95 }], customer_segmentation: 'existing_customer_to_business' })
    const [first] = events(request({ customerSegment: true }), live({ firstOrderAt: new Map([['cust-1', new Date('2026-10-19T10:00:00Z')]]) }))
    expect(first.custom_data.customer_segmentation).toBe('new_customer_to_business')
  })
  it('at most 250 sales per change', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_CHANGE + 1 }, (_, i) => order({ orderId: `ord-${i}`, channelOrderId: `M-${i}` }))
    expect(eventsDraft(request(), live({ orders: many }))).toEqual({ refusal: expect.stringMatching(/More than 250 sales/) })
  })
  it('the days: the last 6 days, before today; or order ids (each must exist)', () => {
    expect(eventsWindowProblem({ from: '2026-10-14', to: '2026-10-20' }, NOW)).toMatch(/2026-10-15 or later/)
    expect(eventsWindowProblem({ from: '2026-10-15', to: '2026-10-21' }, NOW)).toMatch(/before today/)
    expect(eventsWindowProblem({ orderIds: ['x'], from: '2026-10-15' }, NOW)).toMatch(/not both/)
    expect(eventsDraft(request({ orderIds: ['ord-9'], from: undefined, to: undefined }), live())).toEqual({ refusal: expect.stringMatching(/No Nexus order ord-9/) })
  })
})

describe('what a person reads and the plan never carry the buyer', () => {
  it('no hash and no plain e-mail or phone outside the request body', () => {
    const d = draftOf(request({ contents: true, customerSegment: true }))
    const { requests, ...rest } = d
    const visible = JSON.stringify({ ...rest, requests: requests.map(({ params: _params, ...r }) => r) })
    expect(visible).not.toMatch(/[a-f0-9]{64}/)
    expect(visible).not.toMatch(/example\.com|393331234567/i)
    expect(d.spendsMoney[0]).toMatch(/may then spend more of their budgets \(never above them\)/)
    expect(d.summary).toMatch(/Send 1 purchase \(49\.90 EUR\) taken in by hand in Nexus to Meta pixel 120000000000050/)
  })
})
