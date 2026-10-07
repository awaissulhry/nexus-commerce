/**
 * SQP pacing — the nightly request pass must not lose a report to the gateway's own rate limit.
 *
 * Measured 2026-10-01..10-05: every night ended `created=6 failed=24`. ~30 createReport calls went out
 * back to back; Amazon allows about one a minute, the gateway waits at most 30 s for a slot, and then
 * answers "Not sent yet: … needs 56 s more. Retry later." (GatewayRefusal RATE_LIMITED_LOCAL). The pass
 * counted that as failed and moved on, and sqp-collect turned the same refusal into a permanent ERROR.
 *
 * Amazon and the database are stand-ins: `callAPI` answers what each test queues, `prisma` records the
 * writes. The refusal is the gateway's real class. Fake timers: no real waits, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ operation: string; at: number; asin?: string }>,
  answers: [] as Array<() => unknown>,
  created: [] as Array<Record<string, any>>,
  updates: [] as Array<{ id: string; data: Record<string, any> }>,
  outstanding: [] as Array<Record<string, any>>,
}))

vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
// The gateway module is loaded for its refusal class only; its ledger writer stays out of it (as in gateway.p11).
vi.mock('../outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async () => {}) }))
vi.mock('../../db.js', () => ({ default: {
  sqpReportRequest: {
    // requestSqpReports reads "outstanding" and "ingested" for the window (none here); collect reads the queue.
    findMany: vi.fn(async ({ where }: any) => (where?.pollAttempts ? h.outstanding : [])),
    create: vi.fn(async ({ data }: any) => { h.created.push(data); return data }),
    update: vi.fn(async ({ where, data }: any) => { h.updates.push({ id: where.id, data }); return {} }),
  },
  searchQueryPerformance: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})) },
} }))
vi.mock('../sp-api-reports.service.js', () => ({
  getSpApiClient: vi.fn(async () => ({
    callAPI: vi.fn(async (req: any) => {
      h.calls.push({ operation: req.operation, at: Date.now(), asin: req.body?.reportOptions?.asin })
      const answer = h.answers.shift()
      if (!answer) throw new Error(`test: no answer queued for ${req.operation}`)
      return answer()
    }),
    download: vi.fn(async () => '{}'),
  })),
  fetchSpApiJsonReport: vi.fn(),
}))

import { GatewayRefusal } from '../gateway/gateway.js'
import {
  collectSqpReports, createReportPacer, requestSqpReports,
  SQP_CREATE_PACE_MS, SQP_CREATE_RATE_RETRIES,
} from './sqp-async.service.js'

const T0 = Date.UTC(2026, 9, 6, 3, 45, 0)
const notSentYet = (retryAfterMs: number | null) => () => {
  throw new GatewayRefusal('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: the Amazon rate limit for this account needs ${Math.ceil((retryAfterMs ?? 0) / 1000)} s more. Retry later.`, 429, retryAfterMs)
}
const reportId = (id: string) => () => ({ reportId: id })
const at = (i: number) => h.calls[i]!.at - T0

const ask = (asins: string[], extra: Partial<Parameters<typeof requestSqpReports>[0]> = {}) =>
  requestSqpReports({ marketplaceCode: 'IT', marketplaceId: 'APJ6JRA9NG5V4', asins, period: 'WEEK', start: new Date('2026-09-27T00:00:00Z'), end: new Date('2026-10-03T23:59:59Z'), ...extra })

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  h.calls = []; h.answers = []; h.created = []; h.updates = []; h.outstanding = []
})
afterEach(() => { vi.useRealTimers() })

describe('request pass — the gateway\'s "not sent yet" is retried, not counted as failed', () => {
  it('waits the time the refusal names, sends the SAME request again, and records it', async () => {
    h.answers.push(notSentYet(70_000), reportId('r-1'))
    const run = ask(['B0IT1'])

    await vi.advanceTimersByTimeAsync(70_999)
    expect(h.calls).toHaveLength(1) // not before the named 70 s + 1 s margin

    await vi.advanceTimersByTimeAsync(1)
    const r = await run
    expect(h.calls.map((c) => c.asin)).toEqual(['B0IT1', 'B0IT1'])
    expect(at(1)).toBe(71_000)
    expect(r).toMatchObject({ created: 1, failed: 0, deferred: 0 })
    expect(h.created).toEqual([expect.objectContaining({ reportId: 'r-1', asin: 'B0IT1', marketplace: 'IT', status: 'PENDING' })])
  })

  it('without a named wait it waits one createReport slot (~61 s)', async () => {
    h.answers.push(notSentYet(null), reportId('r-1'))
    const run = ask(['B0IT1'])
    await vi.advanceTimersByTimeAsync(SQP_CREATE_PACE_MS - 1)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run).toMatchObject({ created: 1, failed: 0 })
  })

  it('paces createReport calls one slot apart, so the burst never meets the limit', async () => {
    h.answers.push(reportId('r-1'), reportId('r-2'), reportId('r-3'))
    const run = ask(['A1', 'A2', 'A3'])
    await vi.runAllTimersAsync()
    expect(await run).toMatchObject({ created: 3, failed: 0, deferred: 0 })
    expect(h.calls.map((_, i) => at(i))).toEqual([0, SQP_CREATE_PACE_MS, 2 * SQP_CREATE_PACE_MS])
  })

  it('one pacer shared by two markets keeps the spacing across them', async () => {
    h.answers.push(reportId('r-de'), reportId('r-it'))
    const pacer = createReportPacer()
    const both = (async () => { await ask(['DE1'], { marketplaceCode: 'DE', pacer }); await ask(['IT1'], { pacer }) })()
    await vi.runAllTimersAsync()
    await both
    expect(h.calls.map((_, i) => at(i))).toEqual([0, SQP_CREATE_PACE_MS])
  })

  it('is bounded: still refused after the retries → deferred (not failed, no row), and the pass goes on', async () => {
    for (let i = 0; i <= SQP_CREATE_RATE_RETRIES; i++) h.answers.push(notSentYet(56_000))
    h.answers.push(reportId('r-2'))
    const run = ask(['A1', 'A2'])
    await vi.runAllTimersAsync()
    const r = await run
    expect(h.calls.filter((c) => c.asin === 'A1')).toHaveLength(1 + SQP_CREATE_RATE_RETRIES)
    expect(r).toMatchObject({ created: 1, failed: 0, deferred: 1 })
    expect(h.created.map((c) => c.asin)).toEqual(['A2'])
  })

  it('stops sending at the deadline and defers the rest', async () => {
    h.answers.push(reportId('r-1'), reportId('r-2'))
    const run = ask(['A1', 'A2', 'A3', 'A4'], { deadlineAt: T0 + SQP_CREATE_PACE_MS + 30_000 })
    await vi.runAllTimersAsync()
    expect(await run).toMatchObject({ created: 2, failed: 0, deferred: 2 })
    expect(h.calls).toHaveLength(2)
  })

  it('does not retry an answer from Amazon — only the gateway\'s own "not sent"', async () => {
    h.answers.push(() => { throw new Error('InvalidInput: reportOptions.asin is not valid') })
    const run = ask(['A1'])
    await vi.runAllTimersAsync()
    expect(await run).toMatchObject({ created: 0, failed: 1, deferred: 0 })
    expect(h.calls).toHaveLength(1)
  })
})

describe('collect pass — a gateway refusal keeps the request retryable', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, reportId: `rep-${id}`, marketplace: 'IT', marketplaceId: 'APJ6JRA9NG5V4', asin: `B0${id}`, reportPeriod: 'WEEK',
    startDate: new Date('2026-09-27T00:00:00Z'), requestedAt: new Date(T0 - 3_600_000), reportDocumentId: null, doneAt: null,
    status: 'PENDING', pollAttempts: 0, ...extra,
  })
  const statusesWritten = () => h.updates.map((u) => u.data.status).filter(Boolean)

  it('getReport "not sent yet" → stays PENDING (no ERROR, no poll attempt), and the pass stops there', async () => {
    h.outstanding = [row('1'), row('2')]
    h.answers.push(notSentYet(56_000))
    const r = await collectSqpReports({})
    expect(r).toMatchObject({ notSent: 1, errors: 0, expired: 0 })
    expect(statusesWritten()).toEqual([])
    expect(h.updates).toEqual([]) // pollAttempts untouched too: Amazon was never asked
    expect(h.calls).toHaveLength(1) // row 2 waits for the next tick instead of meeting the same refusal
  })

  it('getReportDocument "not sent yet" → stays DONE with its document id (not EXPIRED, not ERROR)', async () => {
    h.outstanding = [row('1', { status: 'DONE', reportDocumentId: 'doc-1', doneAt: new Date(T0 - 60_000) })]
    h.answers.push(notSentYet(5_000))
    const r = await collectSqpReports({})
    expect(r).toMatchObject({ notSent: 1, errors: 0, expired: 0, ingested: 0 })
    expect(statusesWritten()).toEqual([])
  })

  it('a real 404 from Amazon is still EXPIRED (the text test still runs for answers that were sent)', async () => {
    h.outstanding = [row('1')]
    h.answers.push(() => { throw new Error('404 NotFound: report not found') })
    const r = await collectSqpReports({})
    expect(r).toMatchObject({ notSent: 0, expired: 1 })
    expect(statusesWritten()).toEqual(['EXPIRED'])
  })
})
