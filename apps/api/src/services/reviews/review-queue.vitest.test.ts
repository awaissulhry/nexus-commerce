/**
 * Reviews area PR C — the review queue's pure parts, without a database:
 *   - each queue status (incl. DUE and RETRYING) and each reason filter, as a Prisma where, selects exactly the rows
 *     the words module names that way (a small evaluator runs the where with SQL's NULL rules);
 *   - the query string is checked; the bulk bar's held rules (send now too early for Amazon, sent, paused, missing);
 *   - the Rules bulk bar's held rules (no market, already on/off, a channel Nexus never asks);
 *   - a grid row never carries the buyer's e-mail or a raw code.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import {
  QueueInputError,
  parseQueueBulk,
  parseQueueQuery,
  parseRulesBulk,
  parseRunSummary,
  queueBulkPlan,
  queueWhere,
  reasonWhere,
  rulesBulkPlan,
  statusFilterWhere,
  statusWhere,
  testEmailWords,
  toQueueRow,
  type QueueRowInput,
} from './review-queue.service.js'
import { QUEUE_STATUSES, REASON_FACET_WORDS, queueStatusOf, reasonKeyOf, type ReasonKey } from './review-queue-words.js'
import { COMMAND_SCOPE_ROUTES } from '../../lib/command-idempotency.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY)

// ── A tiny evaluator of the Prisma where shapes the service builds, with SQL's three-valued logic ─────────────────
type Tri = boolean | null
const and = (v: Tri[]): Tri => (v.includes(false) ? false : v.includes(null) ? null : true)
const or = (v: Tri[]): Tri => (v.includes(true) ? true : v.includes(null) ? null : false)
const not = (v: Tri): Tri => (v === null ? null : !v)
const cmp = (a: unknown) => (a instanceof Date ? a.getTime() : a)

function field(value: unknown, cond: unknown): Tri {
  if (cond === null) return value === null || value === undefined
  if (typeof cond !== 'object' || cond instanceof Date) return value == null ? null : cmp(value) === cmp(cond)
  const c = cond as Record<string, unknown>
  if ('is' in c) return c.is === null ? value == null : value == null ? false : evalWhere(c.is as Record<string, unknown>, value as Record<string, unknown>)
  const insensitive = c.mode === 'insensitive'
  const s = (x: unknown) => (insensitive ? String(x).toLowerCase() : String(x))
  const parts: Tri[] = []
  for (const [op, arg] of Object.entries(c)) {
    if (op === 'mode') continue
    if (op === 'not') {
      if (arg === null) parts.push(value != null)
      else if (typeof arg === 'object' && !(arg instanceof Date)) parts.push(not(field(value, arg)))
      else parts.push(value == null ? null : cmp(value) !== cmp(arg))
      continue
    }
    if (value == null) { parts.push(null); continue }
    switch (op) {
      case 'equals': parts.push(s(value) === s(arg)); break
      case 'in': parts.push((arg as unknown[]).map(cmp).includes(cmp(value))); break
      case 'notIn': parts.push(!(arg as unknown[]).map(cmp).includes(cmp(value))); break
      case 'lt': parts.push((cmp(value) as number) < (cmp(arg) as number)); break
      case 'lte': parts.push((cmp(value) as number) <= (cmp(arg) as number)); break
      case 'gt': parts.push((cmp(value) as number) > (cmp(arg) as number)); break
      case 'gte': parts.push((cmp(value) as number) >= (cmp(arg) as number)); break
      case 'contains': parts.push(s(value).includes(s(arg))); break
      case 'startsWith': parts.push(s(value).startsWith(s(arg))); break
      default: throw new Error(`evaluator: unknown operator ${op}`)
    }
  }
  return and(parts)
}

function evalWhere(where: Record<string, unknown>, row: Record<string, unknown>): Tri {
  const parts: Tri[] = []
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') parts.push(and((cond as Record<string, unknown>[]).map((w) => evalWhere(w, row))))
    else if (key === 'OR') parts.push(or((cond as Record<string, unknown>[]).map((w) => evalWhere(w, row))))
    else if (key === 'NOT') parts.push(not(evalWhere(cond as Record<string, unknown>, row)))
    else parts.push(field(row[key], cond))
  }
  return and(parts)
}
const matches = (where: Record<string, unknown>, row: Record<string, unknown>) => evalWhere(where, row) === true

// ── The rows: every state the senders and the scheduler leave ───────────────────────────────────────────────────
function rows(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const codes = [null, 'OUTSIDE_WINDOW', 'ALREADY_SOLICITED', 'NOT_IMPLEMENTED', 'UNKNOWN_MARKETPLACE', 'SUPPRESSED', 'DIVERTED_NEGATIVE', 'NO_RESPONSE_NO_FALLBACK', 'SKIPPED_BY_HAND', 'HTTP_403', 'HTTP_429', 'HTTP_500', 'EXCEPTION']
  const reasons = [null, 'has refund', 'active return', 'not delivered', 'Outside Amazon 4-30d window (34d)', 'Order refunded in Nexus — no review is asked for', 'No customer email on order', 'No channelOrderId for Amazon solicitation', 'non-Amazon — track-only', 'rule_exclusion:has_refund', 'rule_exclusion:has_active_return', 'rule_exclusion:is_cancelled', 'rule_exclusion:asked_buyer_90d', 'rule_exclusion:other', 'Suppressed: suppressed (BOUNCE_HARD)', 'something else']
  const errors = [null, 'RESEND_API_KEY not set', 'Invalid `to` field', 'sentiment_email: boom', 'This business has no identity for buyers yet', 'boom']
  const checks = [null, { sentimentEmailSentAt: daysAgo(1), response: 'NONE' }, { sentimentEmailSentAt: null, response: 'NONE' }, { sentimentEmailSentAt: daysAgo(3), response: 'POSITIVE' }]
  for (const status of ['ELIGIBLE', 'SCHEDULED', 'SENT', 'FAILED', 'SKIPPED', 'SUPPRESSED']) {
    for (const channel of ['AMAZON', 'EBAY']) {
      for (const scheduledFor of [null, daysAgo(1), inDays(1)]) {
        for (const providerResponseCode of codes) {
          const base = { status, channel, scheduledFor, providerResponseCode, attemptCount: 1, nextRetryAt: null as Date | null, suppressedReason: null as string | null, errorMessage: null as string | null, sentimentCheck: null as unknown }
          if (status === 'FAILED') {
            for (const errorMessage of errors) for (const [nextRetryAt, attemptCount] of [[inDays(1), 1], [null, 3], [inDays(1), 3]] as const) out.push({ ...base, errorMessage, nextRetryAt, attemptCount })
          } else if (status === 'SKIPPED' || status === 'SUPPRESSED') {
            for (const suppressedReason of reasons) out.push({ ...base, suppressedReason })
          } else if (status === 'SCHEDULED' || status === 'ELIGIBLE') {
            for (const sentimentCheck of checks) out.push({ ...base, sentimentCheck })
          } else out.push(base)
        }
      }
    }
  }
  return out
}

describe('review queue: status and reason as where', () => {
  const all = rows()

  it('each status where selects exactly the rows queueStatusOf names so (DUE, RETRYING included)', () => {
    for (const row of all) {
      const named = queueStatusOf(row as never, NOW)
      for (const status of QUEUE_STATUSES) {
        expect({ status, row, hit: matches(statusWhere(status, NOW), row) }).toEqual({ status, row, hit: status === named })
      }
    }
  })

  it('each reason filter selects exactly the rows reasonKeyOf names so', () => {
    const keys = (Object.keys(REASON_FACET_WORDS) as ReasonKey[]).filter((k) => reasonWhere(k, NOW) !== null)
    expect(keys.length).toBe(Object.keys(REASON_FACET_WORDS).length - 1) // all but not_asked_other
    for (const row of all) {
      const named = reasonKeyOf(row as never, NOW)
      for (const key of keys) {
        expect({ key, row, hit: matches(reasonWhere(key, NOW)!, row) }).toEqual({ key, row, hit: key === named })
      }
    }
  })

  it('the period keeps everything still waiting, plus what changed in it', () => {
    const { full } = queueWhere(parseQueueQuery({ period: '7d' }), NOW)
    expect(matches(full, { status: 'SCHEDULED', updatedAt: daysAgo(40) })).toBe(true)
    expect(matches(full, { status: 'FAILED', nextRetryAt: inDays(1), updatedAt: daysAgo(40) })).toBe(true)
    expect(matches(full, { status: 'SENT', nextRetryAt: null, updatedAt: daysAgo(40) })).toBe(false)
    expect(matches(full, { status: 'SENT', nextRetryAt: null, updatedAt: daysAgo(2) })).toBe(true)
    const { base: everything } = queueWhere(parseQueueQuery({ period: 'all' }), NOW)
    expect(everything).toEqual({})
  })

  it('status filters on top of the others; the tiles use the rest', () => {
    const { base, full } = queueWhere(parseQueueQuery({ status: 'due', channel: 'amazon', market: 'it', period: 'all' }), NOW)
    expect(base).toEqual({ AND: [{ channel: 'AMAZON' }, { marketplace: 'IT' }] })
    expect(full).toEqual({ AND: [{ channel: 'AMAZON' }, { marketplace: 'IT' }, statusWhere('DUE', NOW)] })
  })

  it('the Skipped filter shows every request the Skipped tile counts: skipped and blocked; Blocked alone stays its own', () => {
    const skipped = queueWhere(parseQueueQuery({ status: 'skipped', period: 'all' }), NOW).full
    const blocked = queueWhere(parseQueueQuery({ status: 'suppressed', period: 'all' }), NOW).full
    for (const row of all) {
      const named = queueStatusOf(row as never, NOW)
      expect({ row, hit: matches(skipped, row) }).toEqual({ row, hit: named === 'SKIPPED' || named === 'SUPPRESSED' })
      expect({ row, hit: matches(blocked, row) }).toEqual({ row, hit: named === 'SUPPRESSED' })
      // The tile counts with the same where as the filter.
      expect(matches(statusFilterWhere('SKIPPED', NOW), row)).toBe(matches(skipped, row))
    }
    expect(all.some((row) => row.status === 'SUPPRESSED' && matches(skipped, row))).toBe(true)
    for (const status of QUEUE_STATUSES.filter((s) => s !== 'SKIPPED')) expect(statusFilterWhere(status, NOW)).toEqual(statusWhere(status, NOW))
  })
})

describe('review queue: input', () => {
  it('refuses an unknown status, reason, period or sort in words', () => {
    expect(() => parseQueueQuery({ status: 'LOST' })).toThrow(QueueInputError)
    expect(() => parseQueueQuery({ reason: 'not_asked_other' })).toThrow(/Unknown reason/)
    expect(() => parseQueueQuery({ period: '5y' })).toThrow(/period/)
    expect(() => parseQueueQuery({ sort: 'buyerEmail:asc' })).toThrow(/sort/)
    expect(parseQueueQuery({})).toMatchObject({ period: '30d', page: 1, pageSize: 50, sort: { field: 'updatedAt', dir: 'desc' } })
    expect(parseQueueQuery({ pageSize: '900' }).pageSize).toBe(200)
  })

  it('bulk: ids ≤ 200, a known action, snooze by 1, 3 or 7 days', () => {
    expect(() => parseQueueBulk({ ids: [], action: 'skip' })).toThrow(/at least one/)
    expect(() => parseQueueBulk({ ids: Array.from({ length: 201 }, (_, i) => `r${i}`), action: 'skip' })).toThrow(/200/)
    expect(() => parseQueueBulk({ ids: ['a'], action: 'delete' })).toThrow(/snooze, skip or send-now/)
    expect(() => parseQueueBulk({ ids: ['a'], action: 'snooze', days: 2 })).toThrow(/1, 3 or 7/)
    expect(parseQueueBulk({ ids: ['a', 'a', ' b '], action: 'snooze', days: 3 })).toEqual({ ids: ['a', 'b'], action: 'snooze', days: 3 })
    expect(() => parseRulesBulk({ ids: ['a'], action: 'archive' })).toThrow(/on, off or delete/)
  })
})

describe('review queue: bulk held rules', () => {
  const amazon = (id: string, over: Record<string, unknown> = {}) => ({ id, status: 'SCHEDULED', channel: 'AMAZON', scheduledFor: inDays(2), deliveredAt: daysAgo(8), ...over })

  it('send now: too early for Amazon, already sent, waiting for "How was it?" are held with their reason; the rest go', () => {
    const plan = queueBulkPlan(['r1', 'r2', 'r3', 'r4', 'r5', 'gone'], [
      amazon('r1'),
      amazon('r2', { deliveredAt: daysAgo(2) }),
      amazon('r3', { status: 'SENT', sentAt: daysAgo(1) }),
      { id: 'r4', status: 'FAILED', channel: 'EBAY', nextRetryAt: inDays(1), attemptCount: 1, customerEmail: 'buyer@example.com' },
      amazon('r5', { sentimentCheck: { sentimentEmailSentAt: daysAgo(1), response: 'NONE' } }),
    ], 'send-now', 1, NOW)
    expect(plan.apply).toEqual(['r1', 'r4'])
    expect(plan.held).toEqual([
      { id: 'r2', words: expect.stringMatching(/^Too early for Amazon \(before its day 5\)/) },
      { id: 'r3', words: expect.stringMatching(/^Already sent on .* Amazon allows one request per order\.$/) },
      { id: 'r5', words: expect.stringMatching(/How was it/) },
      { id: 'gone', words: 'Not found — it may have been removed' },
    ])
  })

  it('send now while sending is paused: every row is held with that reason', () => {
    const plan = queueBulkPlan(['r1'], [amazon('r1')], 'send-now', 1, NOW, { heldAll: 'Sending is paused — resume first, then send' })
    expect(plan).toEqual({ apply: [], held: [{ id: 'r1', words: 'Sending is paused — resume first, then send' }] })
  })

  it('skip holds sent and already-skipped rows; snooze holds a move past Amazon’s day 30', () => {
    const rowsIn = [amazon('a'), amazon('b', { status: 'SENT' }), amazon('c', { status: 'SKIPPED' }), amazon('d', { deliveredAt: daysAgo(27) })]
    expect(queueBulkPlan(['a', 'b', 'c', 'd'], rowsIn, 'skip', 1, NOW)).toEqual({
      apply: ['a', 'd'],
      held: [{ id: 'b', words: 'Already sent — a sent request cannot be taken back' }, { id: 'c', words: 'Already skipped' }],
    })
    const snooze = queueBulkPlan(['a', 'd'], rowsIn, 'snooze', 7, NOW)
    expect(snooze.apply).toEqual(['a'])
    expect(snooze.held[0]).toMatchObject({ id: 'd', words: expect.stringMatching(/past Amazon’s day 30/) })
  })
})

describe('rules bulk held rules', () => {
  const rule = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Rule ${id}`, scope: 'AMAZON_GLOBAL', marketplace: null, isActive: false, ...over })

  it('turning on: a rule without a market or on a channel Nexus never asks is held ("matches no orders"); an on rule says so', () => {
    const plan = rulesBulkPlan(['a', 'b', 'c', 'd', 'x'], [
      rule('a'),
      rule('b', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: null }),
      rule('c', { scope: 'ETSY' }),
      rule('d', { isActive: true }),
    ], 'on')
    expect(plan.apply).toEqual(['a'])
    expect(plan.held).toEqual([
      { id: 'b', words: '“Rule b” matches no orders: it has no market. Open it and pick one.' },
      { id: 'c', words: '“Rule c” matches no orders: Nexus asks only Amazon, eBay and Shopify buyers.' },
      { id: 'd', words: '“Rule d” is already on' },
      { id: 'x', words: 'Not found — it may have been deleted' },
    ])
  })

  it('off holds rules already off; delete takes every rule found', () => {
    expect(rulesBulkPlan(['a', 'b'], [rule('a'), rule('b', { isActive: true })], 'off')).toEqual({ apply: ['b'], held: [{ id: 'a', words: '“Rule a” is already off' }] })
    expect(rulesBulkPlan(['a', 'b'], [rule('a'), rule('b', { isActive: true })], 'delete')).toEqual({ apply: ['a', 'b'], held: [] })
  })
})

describe('review queue rows and run words', () => {
  const input = (over: Partial<QueueRowInput> = {}): QueueRowInput => ({
    id: 'rq1', orderId: 'o1', channel: 'AMAZON', marketplace: 'DE', status: 'SCHEDULED', scheduledFor: inDays(1), sentAt: null,
    providerResponseCode: 'OUTSIDE_WINDOW', errorMessage: "HTTP 403 — You can't use this feature…", suppressedReason: null, attemptCount: 0,
    lastAttemptAt: daysAgo(0.1), nextRetryAt: null, createdAt: daysAgo(6), updatedAt: daysAgo(0.1), ruleId: 'rule1',
    rule: { id: 'rule1', name: 'Amazon — all markets' }, sentimentCheck: null,
    order: {
      id: 'o1', channelOrderId: '405-0000000-0000000', customerName: 'Sample Buyer', customerEmail: 'buyer@marketplace.example',
      deliveredAt: daysAgo(6), deliveredAtSource: 'HEURISTIC_FBA_3D', marketplace: 'DE',
      items: [{ sku: 'SKU-1', product: { name: 'Mesh jacket — Grey — L', productType: 'jacket' } }],
    },
    ...over,
  })

  it('a row in words: status, reason, buyer short name; never the e-mail or the code', () => {
    const row = toQueueRow(input(), NOW)
    expect(row).toMatchObject({
      status: 'RETRYING', reasonKey: 'amazon_too_early', reasonWords: 'Amazon: too early — tries again tomorrow', buyer: 'Sample B.',
      orderLabel: '405-0000000-0000000', product: 'Mesh jacket — Grey — L', productType: 'jacket', deliveredEstimate: true, dayWords: 'day 6',
      ruleName: 'Amazon — all markets', tries: 0, market: 'DE',
    })
    expect(row.sendNowHeld).toMatch(/said too early today/)
    expect(JSON.stringify(row)).not.toMatch(/buyer@|OUTSIDE_WINDOW|HTTP 403/)
  })

  it('reads the summary a run leaves', () => {
    expect(parseRunSummary('deliverySwept=0 scheduled=2 retried=0 due=18 sent=12 sentimentEmails=0 failed=0 skipped=3 tooEarly=3 durationMs=900')).toEqual({ sent: 12, failed: 0, skipped: 3, tooEarly: 3, paused: false })
    expect(parseRunSummary('manual scheduled=0 due=2 sent=2 failed=0 skipped=0 tooEarly=0 only=2')).toMatchObject({ sent: 2 })
    expect(parseRunSummary('PAUSED — reason="x" durationMs=3')).toMatchObject({ paused: true })
    expect(parseRunSummary('deliverySwept=0 scheduled=2 sent=1 failed=0 skipped=1 durationMs=900')).toMatchObject({ tooEarly: 0 })
    expect(parseRunSummary(null)).toBeNull()
  })

  it('the test e-mail result is words, never the transport error', () => {
    expect(testEmailWords({ ok: true, dryRun: false }, 'me@example.com')).toBe('Sent to me@example.com')
    expect(testEmailWords({ ok: true, dryRun: true }, 'me@example.com')).toMatch(/switched off/)
    expect(testEmailWords({ ok: false, dryRun: false, error: 'RESEND_API_KEY not set' }, 'me@example.com')).toBe('Not sent: our email service is not set up')
    expect(testEmailWords({ ok: false, dryRun: false, suppressed: true }, 'me@example.com')).toMatch(/do-not-email/)
  })
})

describe('review queue: one press, one command', () => {
  it('Run now, the queue and rules bulk bars and the test e-mail keep Idempotency-Key receipts', () => {
    expect(COMMAND_SCOPE_ROUTES).toEqual(expect.arrayContaining(['/api/review-queue/run', '/api/review-queue/bulk', '/api/review-emails/test', '/api/review-rules/bulk']))
  })
})
