import { describe, expect, it } from 'vitest'
import type { QueueRow } from './queueDatasource'
import { bulkHeldReason, bulkLabel, bulkResultWords, leftOutLines, queueBulkPlan, snoozeHeld } from './queueBulk'

const NOW = new Date('2026-10-26T12:00:00Z')
const row = (id: string, over: Partial<QueueRow> = {}): QueueRow => ({
  id, orderId: `o-${id}`, orderLabel: id, buyer: 'Giulia F.', channel: 'AMAZON', market: 'IT', product: 'Jacket', productType: 'jacket',
  deliveredAt: '2026-10-20T10:00:00Z', deliveredEstimate: true, dayWords: 'Day 6', nextTryAt: '2026-10-27T10:00:00Z', sentAt: null,
  status: 'SCHEDULED', tries: 0, reasonKey: 'first_try_waits', reasonWords: 'Waits for its first try', ruleId: 'r1', ruleName: 'Rule', sendNowHeld: null,
  ...over,
})

describe('queue bulk bar', () => {
  it('sends now only the rows the server would send, and names the others', () => {
    const rows = [row('a'), row('b', { sendNowHeld: 'Too early for Amazon (before its day 5).' }), row('c', { channel: 'EBAY' })]
    const plan = queueBulkPlan(rows, 'send-now', NOW)
    expect(plan.apply).toEqual(['a', 'c'])
    expect(plan.held).toEqual([{ id: 'b', words: 'Too early for Amazon (before its day 5).' }])
    expect(bulkHeldReason(plan, 'send-now')).toBeNull()
    expect(bulkLabel('Send now', plan)).toBe('Send now (2 of 3)')
    expect(leftOutLines(plan)).toEqual(['1 left out: Too early for Amazon (before its day 5).'])
  })

  it('is held, with the reason, when no ticked row can change', () => {
    const rows = [row('a', { status: 'SENT' }), row('b', { status: 'SENT' })]
    const skip = queueBulkPlan(rows, 'skip', NOW)
    expect(bulkHeldReason(skip, 'skip')).toBe('None of the 2 ticked requests can be skipped: Already sent — a sent request cannot be taken back')
    const one = queueBulkPlan([row('a', { status: 'SKIPPED' })], 'skip', NOW)
    expect(bulkHeldReason(one, 'skip')).toBe('The ticked request cannot be skipped: Already skipped')
    const mixed = queueBulkPlan([row('a', { status: 'SENT' }), row('b', { status: 'SKIPPED' })], 'skip', NOW)
    expect(bulkHeldReason(mixed, 'skip')).toMatch(/\(and 1 other reason\)$/)
    expect(bulkLabel('Skip', mixed)).toBe('Skip')
  })

  it('holds a snooze that would move an Amazon request past day 30', () => {
    const late = row('a', { deliveredAt: '2026-09-28T10:00:00Z', nextTryAt: '2026-10-27T10:00:00Z' })
    expect(snoozeHeld(late, 1, NOW)).toBeNull()
    expect(snoozeHeld(late, 3, NOW)).toBe('That moves it past Amazon’s day 30 (28 Oct) — it would never go')
    expect(snoozeHeld(row('b', { channel: 'EBAY', deliveredAt: '2026-09-01T10:00:00Z' }), 7, NOW)).toBeNull()
    expect(snoozeHeld(row('c', { status: 'SUPPRESSED' }), 1, NOW)).toBe('Not in the queue — use Allow again first')
  })

  it('says what the server changed and what it left out', () => {
    expect(bulkResultWords('snooze', 3, [], 7)).toBe('3 requests snoozed by 1 week')
    expect(bulkResultWords('send-now', 1, [{ words: 'Sending is paused — resume first, then send' }])).toBe('1 request sent now · 1 left out: Sending is paused — resume first, then send')
    expect(bulkResultWords('skip', 0, [{ words: 'a' }, { words: 'b' }])).toBe('0 requests skipped · 2 left out: a (+1 more reasons)')
  })
})
