/**
 * BB-13 — the report ingest when the same day is read again and again (the nightly 8 / 15-day span), on the production
 * schema with the business-isolation policies (PGlite). Only the download is stubbed: each report job's file is the
 * rows the test gives it.
 *
 * What must hold:
 *   · a newer pull overwrites the day (campaign grain: upsert), and each pull that changed the numbers is kept as a
 *     vintage; a day that held a copy before any vintage existed keeps that first copy as `stored`;
 *   · an older pull that finishes late never puts its older copy back;
 *   · search terms (inserted, no unique key) are never counted twice: the older copy of a re-read day is replaced, and an
 *     empty answer for a day never wipes it.
 */
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./ads-profile-facts.service.js', () => ({ reportCurrencyOrSkip: async () => 'EUR' }))

const files = new Map<string, unknown[]>()
vi.stubGlobal('fetch', async (url: string) => {
  const rows = files.get(url) ?? []
  const body = gzipSync(Buffer.from(JSON.stringify(rows)))
  return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
})

const { ingestCompletedJob } = await import('./ads-reports.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

let n = 0
/** A completed report job whose file holds `rows`; ingested by the test, in the order it chooses. */
async function job(reportTypeId: string, startDate: string, endDate: string, createdAt: string, rows: unknown[]): Promise<string> {
  const url = `https://reports.example/${++n}`
  files.set(url, rows)
  const j = await db().amazonAdsReportJob.create({
    data: {
      profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId, externalReportId: `r${n}`,
      startDate: d(startDate), endDate: d(endDate), configuration: {}, status: 'COMPLETED', location: url,
      createdAt: new Date(createdAt), completedAt: new Date(createdAt),
    },
    select: { id: true },
  })
  return j.id
}
const campaignRow = (date: string, sales: number, orders: number, clicks = 10) => ({
  date, campaignId: 145908602168724, impressions: 500, clicks, cost: 4.2,
  sales1d: sales / 2, sales7d: sales, sales14d: sales, purchases1d: 0, purchases7d: orders, purchases14d: orders,
})
const termRow = (date: string, query: string, clicks: number) => ({
  date, campaignId: 145908602168724, adGroupId: 1, keywordId: 7, matchType: 'BROAD', searchTerm: query,
  impressions: 40, clicks, cost: 0.3 * clicks, sales7d: 0, purchases7d: 0,
})

async function day(date: string) {
  return db().amazonAdsDailyPerformance.findFirst({ where: { entityType: 'CAMPAIGN', date: d(date) }, select: { sales7dCents: true, orders7d: true, reportRunId: true } })
}
async function vintages(date: string) {
  return db().adsDailyVintage.findMany({ where: { date: d(date) }, orderBy: { pulledAt: 'asc' }, select: { source: true, ageDays: true, sales7dCents: true, orders7d: true, reportRunId: true } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => db().amazonAdsProfile.create({ data: { profileId: 'p-it', marketplace: 'IT', currencyCode: 'EUR' } }))
}, 60_000)
afterAll(async () => { await database?.close() })

describe('campaign days read again', () => {
  it('the newer pull overwrites the day and each changed pull is kept as a vintage', async () => {
    await inside(async () => {
      const first = await job('spCampaigns', '2026-09-20', '2026-09-20', '2026-09-21T01:15:00Z', [campaignRow('2026-09-20', 80, 1)])
      await ingestCompletedJob(first)
      expect(await day('2026-09-20')).toMatchObject({ sales7dCents: 8000, orders7d: 1, reportRunId: first })

      const settle = await job('spCampaigns', '2026-09-20', '2026-09-27', '2026-09-28T01:15:00Z', [campaignRow('2026-09-20', 161, 2), campaignRow('2026-09-27', 10, 0)])
      await ingestCompletedJob(settle)
      expect(await day('2026-09-20')).toMatchObject({ sales7dCents: 16100, orders7d: 2, reportRunId: settle })
      expect(await vintages('2026-09-20')).toEqual([
        { source: 'pull', ageDays: 0, sales7dCents: 8000, orders7d: 1, reportRunId: first },
        { source: 'pull', ageDays: 7, sales7dCents: 16100, orders7d: 2, reportRunId: settle },
      ])

      // A re-read that changed nothing keeps no new vintage.
      const again = await job('spCampaigns', '2026-09-20', '2026-09-27', '2026-09-29T01:15:00Z', [campaignRow('2026-09-20', 161, 2)])
      await ingestCompletedJob(again)
      expect(await vintages('2026-09-20')).toHaveLength(2)
    })
  })

  it('a day stored before any vintage keeps that first copy as `stored`, dated when it was asked', async () => {
    await inside(async () => {
      const old = await job('spCampaigns', '2026-09-15', '2026-09-15', '2026-09-16T01:15:00Z', [campaignRow('2026-09-15', 50, 1)])
      await ingestCompletedJob(old)
      await db().adsDailyVintage.deleteMany({ where: { date: d('2026-09-15') } }) // as before BB-13: no vintage
      const repull = await job('spCampaigns', '2026-09-08', '2026-09-15', '2026-10-08T03:20:00Z', [campaignRow('2026-09-15', 95, 2)])
      await ingestCompletedJob(repull)
      expect(await vintages('2026-09-15')).toEqual([
        { source: 'stored', ageDays: 0, sales7dCents: 5000, orders7d: 1, reportRunId: old },
        { source: 'pull', ageDays: 22, sales7dCents: 9500, orders7d: 2, reportRunId: repull },
      ])
      expect(await day('2026-09-15')).toMatchObject({ sales7dCents: 9500 })
    })
  })

  it('an older pull that finishes late never puts its older copy back', async () => {
    await inside(async () => {
      // Asked on 09-22 for 09-19..09-20, finished after the 09-28 settling pull of 09-20..09-27 was ingested.
      const late = await job('spCampaigns', '2026-09-19', '2026-09-20', '2026-09-22T01:15:00Z', [campaignRow('2026-09-19', 30, 1), campaignRow('2026-09-20', 120, 1)])
      await ingestCompletedJob(late)
      expect(await day('2026-09-20')).toMatchObject({ sales7dCents: 16100, orders7d: 2 })
      expect(await day('2026-09-19')).toMatchObject({ sales7dCents: 3000, reportRunId: late })
    })
  })
})

describe('search-term days read again', () => {
  const terms = (date: string) => db().amazonAdsSearchTerm.findMany({ where: { date: d(date) }, select: { query: true, clicks: true, reportRunId: true } })

  it('the older copy of a re-read day is replaced, never added to', async () => {
    await inside(async () => {
      const first = await job('spSearchTerm', '2026-09-20', '2026-09-20', '2026-09-21T01:30:00Z', [termRow('2026-09-20', 'giacca moto', 3)])
      await ingestCompletedJob(first)
      const settle = await job('spSearchTerm', '2026-09-20', '2026-09-27', '2026-09-28T01:30:00Z', [termRow('2026-09-20', 'giacca moto', 4), termRow('2026-09-25', 'giubbotto', 1)])
      await ingestCompletedJob(settle)
      expect(await terms('2026-09-20')).toEqual([{ query: 'giacca moto', clicks: 4, reportRunId: settle }])
      expect(await terms('2026-09-25')).toHaveLength(1)
    })
  })

  it('a pull with no rows for a day leaves that day as it was', async () => {
    await inside(async () => {
      const newer = await job('spSearchTerm', '2026-09-20', '2026-09-25', '2026-09-29T01:30:00Z', [termRow('2026-09-25', 'giubbotto', 2)])
      await ingestCompletedJob(newer)
      expect(await terms('2026-09-20')).toEqual([{ query: 'giacca moto', clicks: 4, reportRunId: expect.any(String) }])
      expect(await terms('2026-09-25')).toEqual([{ query: 'giubbotto', clicks: 2, reportRunId: newer }])
    })
  })
})

/**
 * Integration review fix (2026-10-10) — the top-of-search share's unit, once per report. Amazon reports it in percent: a
 * report with any value above 1 is percent (÷ 100, a 0.8 in it is 0.8 %); a report whose values are all ≤ 1 is
 * ambiguous and writes nothing for that field — the stored reading stays, and the rows are counted.
 */
describe('top-of-search share — percent or ambiguous, never guessed', () => {
  const tos = async (date: string) => (await db().amazonAdsDailyPerformance.findMany({
    where: { entityType: 'CAMPAIGN', date: d(date) }, orderBy: { entityId: 'asc' }, select: { entityId: true, topOfSearchIS: true, clicks: true },
  })).map((r) => [r.entityId, r.topOfSearchIS == null ? null : Number(r.topOfSearchIS), r.clicks])
  const row = (campaignId: number, share: number | null, clicks = 10) => ({ ...campaignRow('2026-10-03', 80, 1, clicks), campaignId, topOfSearchImpressionShare: share })

  it('a percent report divides by 100 (0.8 → 0.8 %); a later ambiguous report keeps the stored reading and counts its rows', async () => {
    await inside(async () => {
      const percent = await job('spCampaigns', '2026-10-03', '2026-10-03', '2026-10-04T01:15:00Z', [row(101, 62.5), row(102, 0.8)])
      expect(await ingestCompletedJob(percent)).toEqual({ jobId: percent, rowsIngested: 2 })
      expect(await tos('2026-10-03')).toEqual([['101', 0.625, 10], ['102', 0.008, 10]])

      const ambiguous = await job('spCampaigns', '2026-10-03', '2026-10-03', '2026-10-05T01:15:00Z', [row(101, 0.4, 12), row(102, null, 12)])
      expect(await ingestCompletedJob(ambiguous)).toEqual({ jobId: ambiguous, rowsIngested: 2, tosAmbiguousRows: 1 })
      // The other columns took the newer pull; the share was not written (not 0.4, not 40 %, not null).
      expect(await tos('2026-10-03')).toEqual([['101', 0.625, 12], ['102', 0.008, 12]])
    })
  })
})
