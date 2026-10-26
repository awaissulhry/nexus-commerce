import { describe, expect, it } from 'vitest'
import type { RequestDetail } from './queueDatasource'
import { MANAGE_HELD, headerView, moneyWords, requestActions, returnWords, snoozeChoices, timelineView, windowView } from './requestDetailModel'

const TZ = 'Europe/Rome'
const detail = (over: Partial<RequestDetail['request']> = {}, held: Partial<RequestDetail['held']> = {}): RequestDetail => ({
  request: {
    id: 'q1', orderId: 'o1', orderLabel: '405-1', buyer: 'Giulia F.', channel: 'AMAZON', market: 'DE', product: 'Mesh jacket', productType: 'jacket',
    deliveredAt: '2026-10-14T10:00:00Z', deliveredEstimate: true, dayWords: 'Day 12', nextTryAt: '2026-10-27T09:00:00Z', sentAt: null,
    status: 'RETRYING', tries: 1, reasonKey: 'amazon_too_early', reasonWords: 'Amazon: too early', ruleId: 'r1', ruleName: 'Germany jackets',
    sendNowHeld: 'Amazon said too early today', createdAt: null, scheduledFor: null, lastAttemptAt: null, nextRetryAt: null, reasonCode: 'OUTSIDE_WINDOW', rule: null,
    ...over,
  },
  order: { id: 'o1', label: '405-1', status: 'DELIVERED', fulfilment: 'FBM', total: 89.9, currency: 'EUR', lines: [], dates: { ordered: null, shipped: null, delivered: null, cancelled: null }, refund: null, return: null },
  window: { deliveredAt: '2026-10-14T10:00:00Z', estimate: true, firstDay: '2026-10-18T10:00:00Z', lastDay: '2026-11-13T10:00:00Z' },
  amazonAnswer: null,
  timeline: [
    { at: '2026-10-14T11:00:00Z', words: 'Added to the queue by the rule “Germany jackets”', kind: 'added' },
    { at: '2026-10-26T09:00:00Z', words: 'Day 12 — Amazon said too early', kind: 'try' },
    { at: null, words: 'Next try (day 13)', kind: 'next' },
    { at: null, words: 'Review from this buyer: not known', kind: 'note' },
  ],
  held: { snooze: null, sendNow: 'Amazon said too early today', skip: null, allowAgain: 'Only a request that was not asked can be allowed again', ...held },
  snoozeOptions: [
    { days: 1, to: '2026-10-28T09:00:00Z', held: null },
    { days: 7, to: '2026-11-03T09:00:00Z', held: null },
  ],
})

describe('request pop-up', () => {
  it('orders the actions and keeps the server’s reasons', () => {
    expect(requestActions(detail(), true)).toEqual([
      { id: 'snooze', label: 'Snooze', held: null },
      { id: 'skip', label: 'Skip', held: null },
      { id: 'send-now', label: 'Send now', held: 'Amazon said too early today' },
    ])
  })

  it('offers Allow again only for a request that was not asked', () => {
    const ids = requestActions(detail({ status: 'SUPPRESSED' }, { allowAgain: null }), true).map((a) => `${a.id}:${a.held ?? 'ok'}`)
    expect(ids[3]).toBe('allow-again:ok')
  })

  it('holds everything without the permission, before any other reason', () => {
    const actions = requestActions(detail({ status: 'SKIPPED' }), false)
    expect(actions.every((a) => a.held === MANAGE_HELD)).toBe(true)
    expect(snoozeChoices(detail(), false, TZ).every((c) => c.held === MANAGE_HELD)).toBe(true)
  })

  it('words the header and the snooze dates', () => {
    expect(headerView(detail())).toEqual({ title: 'Request for order 405-1', subtitle: 'Giulia F. · Amazon Germany · Mesh jacket', triesWords: '1 try' })
    expect(snoozeChoices(detail(), true, TZ).map((c) => `${c.label} → ${c.to}`)).toEqual(['1 day → Wed 28 Oct', '1 week → Tue 3 Nov'])
  })

  it('shows Amazon’s window from our delivery date', () => {
    const now = new Date('2026-10-26T12:00:00Z')
    expect(windowView(detail(), now, TZ)).toEqual({
      delivered: 'Wed 14 Oct',
      deliveredHint: 'our estimate: shipped + 3 working days',
      amazon: { day: 12, value: 40, words: 'Day 12 of Amazon’s day 5–30 window', lastDay: 'Fri 13 Nov' },
    })
    expect(windowView(detail(), new Date('2026-10-16T12:00:00Z'), TZ).amazon?.words).toBe('Day 2 — Amazon’s window opens on day 5')
    expect(windowView(detail({ channel: 'EBAY' }), now, TZ).amazon).toBeNull()
  })

  it('tones the timeline and marks the next try as not yet', () => {
    expect(timelineView(detail()).map((s) => [s.tone, 'at' in s ? s.at : 'none'])).toEqual([
      ['neutral', '2026-10-14T11:00:00Z'],
      ['warning', '2026-10-26T09:00:00Z'],
      ['info', null],
      ['neutral', 'none'],
    ])
  })

  it('words money and returns', () => {
    expect(moneyWords(89.9, 'EUR')).toBe('€89.90')
    expect(moneyWords(null, 'EUR')).toBe('—')
    expect(returnWords(null)).toBe('None')
    expect(returnWords({ id: 'r', rma: 'RMA-1', status: 'IN_TRANSIT', open: true, openedAt: null })).toBe('Open (in transit) · RMA-1')
  })
})
