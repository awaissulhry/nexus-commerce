/**
 * SQP collect — the rows the OLD collect code retired for nothing come back, once.
 *
 * Before #483 the collect pass marked a report ERROR when the channel gateway answered its poll with
 * "Not sent yet: the Amazon rate limit for this account needs N s more. Retry later." Nothing had been
 * sent, so Amazon still holds those reports; only the queue had dropped them.
 *
 * Amazon and the database are stand-ins. Fake timers: no real waits, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  answers: [] as Array<() => unknown>,
  updates: [] as Array<{ id: string; data: Record<string, any> }>,
  updateMany: [] as Array<{ where: any; data: any }>,
  requeueCount: 0,
  outstanding: [] as Array<Record<string, any>>,
}))

vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async () => {}) }))
vi.mock('../../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../../db.js', () => ({ default: {
  sqpReportRequest: {
    findMany: vi.fn(async () => h.outstanding),
    findFirst: vi.fn(async () => null),
    groupBy: vi.fn(async () => [{ status: 'PENDING', _count: { _all: h.outstanding.length } }]),
    update: vi.fn(async ({ where, data }: any) => { h.updates.push({ id: where.id, data }); return {} }),
    updateMany: vi.fn(async (args: any) => { h.updateMany.push(args); return { count: h.requeueCount } }),
  },
  searchQueryPerformance: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})) },
} }))
vi.mock('../sp-api-reports.service.js', () => ({
  getSpApiClient: vi.fn(async () => ({
    callAPI: vi.fn(async () => {
      const answer = h.answers.shift()
      if (!answer) throw new Error('test: no answer queued')
      return answer()
    }),
    download: vi.fn(async () => '{}'),
  })),
  fetchSpApiJsonReport: vi.fn(),
}))

import {
  collectSqpReports, requeueNotSentErrors, SQP_REPORT_RETENTION_DAYS, SQP_REQUEUED_MESSAGE,
} from './sqp-async.service.js'
import { runSqpCollectOnce } from '../../jobs/sqp-collect.job.js'

const T0 = Date.UTC(2026, 9, 7, 4, 20, 0)
const row = (id: string, extra: Record<string, any> = {}) => ({
  id, reportId: `rep-${id}`, marketplace: 'IT', asin: 'B0IT', reportPeriod: 'WEEK', startDate: new Date('2026-08-23T00:00:00Z'),
  requestedAt: new Date(T0 - 30 * 86_400_000), reportDocumentId: null, doneAt: null, errorMessage: null, pollAttempts: 0, ...extra,
})
const notFound = () => () => { throw new Error('Request failed with status code 404 NotFound') }

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  h.answers = []; h.updates = []; h.updateMany = []; h.requeueCount = 0; h.outstanding = []
})
afterEach(() => { vi.useRealTimers() })

describe('requeueNotSentErrors', () => {
  it('moves back exactly the gateway\'s not-sent ERROR rows, inside Amazon\'s 90-day retention, and marks them', async () => {
    h.requeueCount = 7
    expect(await requeueNotSentErrors(new Date(T0))).toBe(7)
    const [{ where, data }] = h.updateMany
    expect(where.status).toBe('ERROR')
    expect(where.AND).toEqual([{ errorMessage: { startsWith: 'Not sent yet:' } }, { errorMessage: { contains: 'Retry later' } }])
    expect(+where.requestedAt.gte).toBe(T0 - SQP_REPORT_RETENTION_DAYS * 86_400_000)
    expect(data).toEqual({ status: 'PENDING', errorMessage: SQP_REQUEUED_MESSAGE })
  })

  it('🔴 once: the marker it writes can never match its own filter again', () => {
    expect(SQP_REQUEUED_MESSAGE.startsWith('Not sent yet:')).toBe(false)
  })
})

describe('a requeued report Amazon no longer holds', () => {
  it('ends EXPIRED but is counted apart from a fresh expiry', async () => {
    h.outstanding = [row('old', { errorMessage: SQP_REQUEUED_MESSAGE }), row('fresh', { requestedAt: new Date(T0 - 3_600_000) })]
    h.answers.push(notFound(), notFound())
    const r = await collectSqpReports()
    expect(r.expiredAfterRequeue).toBe(1)
    expect(r.expired).toBe(1)
    expect(h.updates.find((u) => u.id === 'old')!.data).toMatchObject({ status: 'EXPIRED' })
    expect(String(h.updates.find((u) => u.id === 'old')!.data.errorMessage)).toContain('(after requeue)')
  })
})

describe('runSqpCollectOnce', () => {
  it('requeues first, says how many in its summary, and does not fail the row for a requeued report that is gone', async () => {
    h.requeueCount = 3
    h.outstanding = [row('old', { errorMessage: SQP_REQUEUED_MESSAGE })]
    h.answers.push(notFound())
    const summary = await runSqpCollectOnce()
    expect(h.updateMany).toHaveLength(1)
    expect(summary).toContain('requeued=3')
    expect(summary).toContain('expiredAfterRequeue=1')
  })

  it('still fails the row for a FRESH expiry — that one is the collect cadence losing data', async () => {
    h.outstanding = [row('fresh', { requestedAt: new Date(T0 - 3_600_000) })]
    h.answers.push(notFound())
    await expect(runSqpCollectOnce()).rejects.toThrow(/EXPIRED un-collected/)
  })
})
