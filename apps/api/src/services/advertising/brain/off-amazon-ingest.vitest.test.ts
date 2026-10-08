/**
 * ONE BRAIN AB-18 — the off-Amazon lane from the report file to the brain, on the production schema (PGlite): a placement
 * report (spCampaigns grouped by campaignPlacement) whose rows carry an off-Amazon label goes through the real ingest
 * (ads-reports.service.ts ingestCompletedJob; only the download is stubbed), and the brain's reader takes it from there
 * (brain/off-amazon-read.ts). The off-Amazon label is the fixture's ASSUMPTION (could not verify Amazon's own label):
 * the ingest must keep it as Amazon sent it, and the reader must count it as the lane and nothing else.
 *
 * Every value is made up (public repo).
 */
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { BUSINESS_LABEL, OFF_AMAZON_LABEL, placementDay } from './__fixtures__/off-amazon-report.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../ads-profile-facts.service.js', () => ({ reportCurrencyOrSkip: async () => 'EUR' }))

const files = new Map<string, unknown[]>()
vi.stubGlobal('fetch', async (url: string) => {
  const body = gzipSync(Buffer.from(JSON.stringify(files.get(url) ?? [])))
  return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
})

const { ingestCompletedJob, PLACEMENT_REPORT_TYPE_ID } = await import('../ads-reports.service.js')
const { loadPlacementRows, loadStreamWitness, offAmazonWindow, productOffAmazon } = await import('./off-amazon-read.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const NOW = new Date('2026-10-08T12:00:00Z')
const WINDOW = offAmazonWindow(NOW)
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.parse(`${WINDOW.from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))
const EXT = 1001
const REFS = [{ id: 'c-a1', externalCampaignId: String(EXT) }]

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().amazonAdsProfile.create({ data: { profileId: 'p-it', marketplace: 'IT', currencyCode: 'EUR' } })
    await db().campaign.create({ data: { id: 'c-a1', name: 'Campaign A1', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: String(EXT), dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    // The report: 14 days, off Amazon at 1.00 a day with no sales in the first week and 1.00 of sales a day in the second.
    const rows = DAYS.flatMap((day, i) => placementDay(day, EXT, { cost: 1, sales: i < 7 ? 0 : 1, orders: i < 7 ? 0 : 1 }))
    files.set('https://reports.example/placement', rows)
    const job = await db().amazonAdsReportJob.create({
      data: {
        profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: PLACEMENT_REPORT_TYPE_ID, externalReportId: 'r-placement',
        startDate: new Date(`${WINDOW.from}T00:00:00Z`), endDate: new Date(`${WINDOW.to}T00:00:00Z`), configuration: {}, status: 'COMPLETED',
        location: 'https://reports.example/placement', createdAt: NOW, completedAt: NOW,
      },
      select: { id: true },
    })
    const result = await ingestCompletedJob(job.id)
    expect(result).toMatchObject({ rowsIngested: 14 * 5 })
  })
}, 60_000)
afterAll(async () => { await database?.close() })

describe('AB-18 — the ingest keeps the off-Amazon rows as Amazon sent them', () => {
  it('every placement label lands under its own name, the off-Amazon one and Amazon Business included', async () => {
    await inside(async () => {
      const stored = await db().amazonAdsPlacementReport.groupBy({ by: ['placement'], _count: { _all: true }, _sum: { costMicros: true } })
      const byLabel = Object.fromEntries(stored.map((s) => [s.placement, { n: s._count._all, cost: Number(s._sum.costMicros) }]))
      expect(byLabel[OFF_AMAZON_LABEL]).toEqual({ n: 14, cost: 14_000_000 })
      expect(byLabel[BUSINESS_LABEL]).toEqual({ n: 14, cost: 7_000_000 })
      expect(Object.keys(byLabel).sort()).toEqual([BUSINESS_LABEL, 'Detail Page on-Amazon', OFF_AMAZON_LABEL, 'Other on-Amazon', 'Top of Search on-Amazon'])
      // The ingest ties each row to the Nexus campaign by its Amazon id.
      expect(await db().amazonAdsPlacementReport.count({ where: { localCampaignId: 'c-a1' } })).toBe(70)
    })
  })
})

describe('AB-18 — the brain reads the lane from them', () => {
  it('the reader returns each row by the Nexus campaign, and the lane is measured: off Amazon above the band in both weeks', async () => {
    await inside(async () => {
      const rows = await loadPlacementRows(REFS, WINDOW)
      expect(rows).toHaveLength(70)
      expect(rows.filter((r) => r.label === OFF_AMAZON_LABEL).every((r) => r.campaignId === 'c-a1' && r.costCents === 100)).toBe(true)
      const lane = await productOffAmazon({
        productId: 'prod-a', name: 'Product A', market: 'IT', currency: 'EUR', now: NOW,
        campaigns: [{ campaignId: 'c-a1', name: 'Campaign A1', owner: 'product', excluded: false }],
        bandTop: { hi: 0.25, words: 'band up to 25 %' }, lever: { effective: 'OBSERVE', lock: null },
      })
      // 14.00 off Amazon of 133.00 placed in all (9.50 a day); 7.00 of off-Amazon sales: ACoS 200 %.
      expect(lane).toMatchObject({ status: 'measured', verdict: 'limit_suggested', limit: [{ campaignId: 'c-a1' }], product: { offSpendCents: 1_400, spendCents: 13_300, sharePct: 10.53, offAcosPct: 200 } })
      expect(lane.labels.find((l) => l.label === BUSINESS_LABEL)?.lane).toBe(`OTHER:${BUSINESS_LABEL}`)
      expect(lane.stream).toBeNull()
    })
  })

  it('a day outside the settled window is left out', async () => {
    await inside(async () => {
      expect(await loadPlacementRows(REFS, { from: DAYS[0], to: DAYS[6] })).toHaveLength(35)
      expect(await loadPlacementRows([{ id: 'c-other', externalCampaignId: '9999' }], WINDOW)).toEqual([])
    })
  })

  it('the Marketing Stream hours mapped to OFF_AMAZON are a second witness; its other lanes are not', async () => {
    await inside(async () => {
      expect(await loadStreamWitness(REFS, WINDOW)).toBeNull()
      const hour = (placement: string, h: number, cost: bigint) => ({
        campaignId: String(EXT), adGroupId: '2001', placement, date: new Date(`${DAYS[3]}T00:00:00Z`), hour: h, costMicros: cost, sales7dCents: 50, orders7d: 1,
        firstArrivalAt: NOW, lastArrivalAt: NOW,
      })
      await db().amazonAdsHourlyPlacement.createMany({ data: [hour('OFF_AMAZON', 9, 300_000n), hour('OFF_AMAZON', 10, 200_000n), hour('PLACEMENT_TOP', 10, 900_000n)] })
      expect(await loadStreamWitness(REFS, WINDOW)).toEqual({ costCents: 50, salesCents: 100, orders: 2, hours: 2 })
    })
  })
})
