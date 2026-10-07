/**
 * SQP catch-up inside the nightly request pass (`runCatchUp`): the weeks it asks for, through the same
 * paced request path, and the summary it hands back.
 *
 * Amazon and the database are stand-ins; `requestSqpReports` is the real pass's entry point, recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requests: [] as Array<Record<string, any>>,
  ledger: [] as Array<{ asin: string; startDate: Date; status: string }>,
  held: [] as Array<{ asin: string; startDate: Date }>,
}))

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({ default: {
  sqpReportRequest: {
    findMany: vi.fn(async ({ where }: any) => h.ledger.filter((r) =>
      where.startDate.in.some((d: Date) => +d === +r.startDate) && where.asin.in.includes(r.asin) && where.status.in.includes(r.status))),
  },
  searchQueryPerformance: {
    findMany: vi.fn(async ({ where }: any) => h.held.filter((r) =>
      where.startDate.in.some((d: Date) => +d === +r.startDate) && where.asin.in.includes(r.asin))),
  },
} }))
vi.mock('../services/sp-api-reports.service.js', () => ({ fetchSpApiJsonReport: vi.fn(), getSpApiClient: vi.fn() }))
vi.mock('../services/advertising/share-of-voice.service.js', () => ({ SOV_DEFAULT_WEEKS: 8 }))
vi.mock('../services/advertising/sqp-async.service.js', () => ({
  requestSqpReports: vi.fn(async (args: any) => {
    h.requests.push(args)
    return { marketplace: args.marketplaceCode, period: 'WEEK', startDate: '', asinsRequested: args.asins.length, created: args.asins.length, failed: 0, alreadyOutstanding: 0, alreadySettled: 0, deferred: 0 }
  }),
}))

import { runCatchUp } from './sqp-ingest.job.js'
import type { AsinYieldEvidence } from '../services/advertising/sqp-yield.js'

const NOW = new Date('2026-10-07T03:45:00Z') // a Wednesday: the normal week is 09-27, catch-up 09-20 … 08-23
const day = (iso: string) => new Date(`${iso}T00:00:00Z`)

/** A market's pool with rows per ASIN: > 0 is proven, 0 with a request is barren, absent is unproven. */
const yieldOf = (byMarket: Record<string, Record<string, number>>) => async (mkt: string) => {
  const rows = byMarket[mkt] ?? {}
  const pool = Object.keys(rows)
  const evidence = new Map<string, AsinYieldEvidence>(pool.map((a) => [a, { rows: rows[a], weeksMeasured: rows[a] > 0 ? 4 : 0, reportsRequested: 4 }]))
  return { pool, evidence }
}

const run = (byMarket: Record<string, Record<string, number>>, markets = Object.keys(byMarket)) => runCatchUp({
  markets,
  idOf: new Map(markets.map((m) => [m, `MKT-${m}`])),
  yieldOf: yieldOf(byMarket),
  pacer: async () => true,
  deadlineAt: +NOW + 75 * 60_000,
  now: NOW,
})

beforeEach(() => { h.requests = []; h.ledger = []; h.held = [] })

describe('runCatchUp — the missed weeks, asked for again', () => {
  it('asks for the newest missed complete weeks, every market first, at most 4 a night, proven ASINs only', async () => {
    const out = await run({ IT: { I1: 30, I2: 10, I0: 0 }, DE: { D1: 5 }, ES: { E1: 7 } })
    expect(h.requests.map((r) => `${r.marketplaceCode} ${r.start.toISOString().slice(0, 10)} ${r.asins.join(',')}`)).toEqual([
      'IT 2026-09-20 I1,I2', 'DE 2026-09-20 D1', 'ES 2026-09-20 E1', 'IT 2026-09-13 I1,I2',
    ])
    // Through the pass's own path: a complete Sunday–Saturday week, the marketplace id, the shared pacer.
    expect(h.requests[0]).toMatchObject({ marketplaceId: 'MKT-IT', period: 'WEEK', end: day('2026-09-26') })
    expect(out).toMatchObject({ units: 4, gaps: 15, created: 6, deferred: 0, failed: 0 })
    expect(out.summary).toContain('catchUp=4/15 weeks asked: requested=6')
  })

  it('skips an (ASIN, week) already answered — rows held, in flight, ingested or ended by Amazon — and asks again after ERROR / EXPIRED', async () => {
    h.held.push({ asin: 'I1', startDate: day('2026-09-20') })
    h.ledger.push(
      { asin: 'I2', startDate: day('2026-09-20'), status: 'PENDING' },
      { asin: 'I1', startDate: day('2026-09-13'), status: 'FATAL' },
      { asin: 'I2', startDate: day('2026-09-13'), status: 'ERROR' },
      { asin: 'I1', startDate: day('2026-09-06'), status: 'EXPIRED' },
    )
    await run({ IT: { I1: 30, I2: 10 } })
    expect(h.requests.map((r) => `${r.start.toISOString().slice(0, 10)} ${r.asins.join(',')}`)).toEqual([
      '2026-09-13 I2', '2026-09-06 I1,I2', '2026-08-30 I1,I2', '2026-08-23 I1,I2',
    ])
  })

  it('says so when nothing is missing, and asks for nothing', async () => {
    for (const d of ['2026-09-20', '2026-09-13', '2026-09-06', '2026-08-30', '2026-08-23']) h.held.push({ asin: 'I1', startDate: day(d) })
    const out = await run({ IT: { I1: 30 } })
    expect(h.requests).toEqual([])
    expect(out.summary).toBe(' · catchUp=none (no missing week)')
  })

  it('🔴 never writes a rows= token: keyword-tracker reads /rows=(\\d+)/ out of this summary', async () => {
    const out = await run({ IT: { I1: 30 } })
    expect(out.summary).not.toMatch(/rows=/)
  })
})
