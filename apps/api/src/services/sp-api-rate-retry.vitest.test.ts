/**
 * The gateway's "Not sent yet … Retry later." on createReport, outside the SQP pass.
 *
 * Every createReport of an Amazon account shares one gateway rate bucket (about one a minute). The
 * report pulls through `fetchSpApiReport` (sales & traffic, FBA, returns, suppressions, fees, …) and
 * the catalog report in `AmazonService.fetchActiveCatalog` sent createReport once and failed the whole
 * pull on that refusal, although nothing had reached Amazon.
 *
 * Amazon is a stand-in that answers what each test queues. Fake timers: no real waits, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ operation: string; at: number }>,
  answers: [] as Array<() => unknown>,
}))

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async () => {}) }))
vi.mock('./amazon-report-registry.service.js', () => ({
  startReportRun: vi.fn(async () => null), completeReportRun: vi.fn(async () => {}), failReportRun: vi.fn(async () => {}),
}))
vi.mock('../lib/amazon-sp-client.js', () => ({
  getAmazonRegion: async () => 'eu',
  amazonSpClient: () => ({
    callAPI: vi.fn(async (req: any) => {
      h.calls.push({ operation: req.operation, at: Date.now() })
      const answer = h.answers.shift()
      if (!answer) throw new Error(`test: no answer queued for ${req.operation}`)
      return answer()
    }),
    download: vi.fn(async () => '{"rows":[1,2]}'),
  }),
}))

import { GatewayRefusal } from './gateway/gateway.js'
import { isGatewayRateRefusal, sendWithRateRetry, RATE_RETRY_DEFAULT_RETRIES, RATE_RETRY_MAX_WAIT_MS } from './sp-api-rate-retry.js'
import { fetchSpApiReport } from './sp-api-reports.service.js'

const T0 = Date.UTC(2026, 9, 7, 2, 0, 0)
const notSentYet = (retryAfterMs: number | null) => () => {
  throw new GatewayRefusal('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: the Amazon rate limit for this account needs ${Math.ceil((retryAfterMs ?? 0) / 1000)} s more. Retry later.`, 429, retryAfterMs)
}

beforeEach(() => { vi.useFakeTimers({ now: T0 }); h.calls = []; h.answers = [] })
afterEach(() => { vi.useRealTimers() })

describe('isGatewayRateRefusal', () => {
  it('knows the rate refusal and nothing else', () => {
    expect(isGatewayRateRefusal(new GatewayRefusal('refused', 'RATE_LIMITED_LOCAL', 'Not sent yet', 429, 1000))).toBe(true)
    expect(isGatewayRateRefusal(new GatewayRefusal('held', 'ACCOUNT_NEEDS_SIGNIN', 'Held, nothing sent', 409))).toBe(false)
    expect(isGatewayRateRefusal(new Error('Not sent yet: … Retry later.'))).toBe(false)
  })
})

describe('sendWithRateRetry', () => {
  it('sends the same request again after the named wait, and stops after the last retry', async () => {
    let n = 0
    const send = vi.fn(async () => { n++; throw new GatewayRefusal('refused', 'RATE_LIMITED_LOCAL', 'Not sent yet', 429, 500_000) })
    const run = sendWithRateRetry(send).catch((e) => e)
    await vi.advanceTimersByTimeAsync(RATE_RETRY_MAX_WAIT_MS * RATE_RETRY_DEFAULT_RETRIES)
    const err = await run
    expect(isGatewayRateRefusal(err)).toBe(true)
    expect(n).toBe(RATE_RETRY_DEFAULT_RETRIES + 1) // every wait is capped, so the retries all happen
  })

  it('never retries an answer from Amazon', async () => {
    const send = vi.fn(async () => { throw new Error('400 InvalidInput') })
    await expect(sendWithRateRetry(send)).rejects.toThrow('400 InvalidInput')
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('fetchSpApiReport — createReport', () => {
  it('a "Not sent yet" is sent again after the wait, and the report is fetched', async () => {
    h.answers.push(
      notSentYet(40_000),
      () => ({ reportId: 'r-1' }),
      () => ({ processingStatus: 'DONE', reportDocumentId: 'doc-1' }),
      () => ({ url: 'https://example.invalid/doc' }),
    )
    const run = fetchSpApiReport({ reportType: 'GET_SALES_AND_TRAFFIC_REPORT', marketplaceId: 'APJ6JRA9NG5V4', dataStartTime: new Date(T0), dataEndTime: new Date(T0) })
    await vi.advanceTimersByTimeAsync(41_000 + 10_000)
    const r = await run
    expect(h.calls.map((c) => c.operation)).toEqual(['createReport', 'createReport', 'getReport', 'getReportDocument'])
    expect(h.calls[1].at - h.calls[0].at).toBe(41_000)
    expect(r.reportId).toBe('r-1')
  })
})
