/**
 * SD reports below the campaign (2026-10-20) — the report pipeline for the four Sponsored Display reports, on the
 * production schema with the business-isolation policies (PGlite). Amazon is stubbed at its one door (`liveCall`, the
 * gateway's caller) and the report file download; every id is made up.
 *
 * What must hold:
 *   · the cycle asks the four reports only where Display delivers, one ranged DAILY job each, with Amazon's SD columns;
 *     asked again while pending, it creates nothing (idempotent);
 *   · ad group, target and product ad rows land in AmazonAdsSdDailyPerformance, joined to Nexus's own entity (a product
 *     ad not yet linked by Amazon's ad id is found by its ASIN in its ad group; one Nexus does not hold still lands);
 *   · a re-pull of a day REPLACES it — never a second row — and an older pull that finishes late never puts its older
 *     copy back; an ingest run twice writes nothing twice;
 *   · purchased-product days are replaced whole by a newer pull, and a pull with no row for a day leaves that day.
 */
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../ads-profile-facts.service.js', () => ({ reportCurrencyOrSkip: async () => 'EUR' }))

const sent: Array<{ profileId: string; method: string; path: string; body: Record<string, any> }> = []
vi.mock('../ads-api-client.js', () => ({
  REPORT_V3_MIME: 'application/vnd.createasyncreportrequest.v3+json',
  liveCall: vi.fn(async (args: { profileId: string; method: string; path: string; body: Record<string, any> }) => {
    sent.push(args)
    return { reportId: `rep-${sent.length}`, status: 'PENDING' }
  }),
}))

const files = new Map<string, unknown[]>()
vi.stubGlobal('fetch', async (url: string) => {
  const body = gzipSync(Buffer.from(JSON.stringify(files.get(url) ?? [])))
  return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
})

const { ingestCompletedJob, runSdReportCycle } = await import('../ads-reports.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const CAMPAIGN = '900000000000001'
const GROUP = '900000000000011'
const TARGET = '900000000000021'
const AD = '900000000000031'

let n = 0
/** A completed SD report job whose file holds `rows`; ingested by the test, in the order it chooses. */
async function job(reportTypeId: string, startDate: string, endDate: string, createdAt: string, rows: unknown[]): Promise<string> {
  const url = `https://reports.example/sd/${++n}`
  files.set(url, rows)
  const j = await db().amazonAdsReportJob.create({
    data: {
      profileId: 'p-it', adProduct: 'SPONSORED_DISPLAY', reportTypeId, externalReportId: `sd${n}`,
      startDate: d(startDate), endDate: d(endDate), configuration: {}, status: 'COMPLETED', location: url,
      createdAt: new Date(createdAt), completedAt: new Date(createdAt),
    },
    select: { id: true },
  })
  return j.id
}
const figures = (sales: number, orders: number, clicks = 20) => ({
  impressions: 9000, impressionsViews: 7000, clicks, cost: 12.5,
  sales, salesClicks: sales / 2, purchases: orders, purchasesClicks: Math.floor(orders / 2), unitsSold: orders, unitsSoldClicks: Math.floor(orders / 2),
  detailPageViews: 50, detailPageViewsClicks: 20,
  newToBrandPurchases: 1, newToBrandPurchasesClicks: 0, newToBrandSales: 30, newToBrandSalesClicks: 0, newToBrandUnitsSold: 1, newToBrandUnitsSoldClicks: 0,
})
const targetRow = (date: string, sales: number, orders: number, targetingId = TARGET) => ({
  date, campaignId: Number(CAMPAIGN), adGroupId: Number(GROUP), targetingId: Number(targetingId),
  targetingExpression: 'asinSameAs=B0FXTEST01', targetingText: 'asin="B0FXTEST01"', adKeywordStatus: 'ENABLED', ...figures(sales, orders),
})
const rowsOf = (entityType: string, date?: string) =>
  db().amazonAdsSdDailyPerformance.findMany({
    where: { entityType, ...(date ? { date: d(date) } : {}) },
    orderBy: [{ date: 'asc' }, { entityId: 'asc' }],
    select: { entityId: true, date: true, localEntityId: true, sales14dCents: true, salesClicks14dCents: true, orders14d: true, viewableImpressions: true, reportRunId: true, marketplace: true, currencyCode: true },
  })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().amazonAdsProfile.create({ data: { profileId: 'p-it', marketplace: 'IT', currencyCode: 'EUR' } })
    await db().amazonAdsConnection.create({ data: { profileId: 'p-it', marketplace: 'IT', region: 'EU', isActive: true } })
    await db().amazonAdsConnection.create({ data: { profileId: 'p-de', marketplace: 'DE', region: 'EU', isActive: true } })
    await db().campaign.create({ data: { id: 'c-sd', name: 'Display IT', type: 'SD', adProduct: 'SPONSORED_DISPLAY', status: 'ENABLED', marketplace: 'IT', externalCampaignId: CAMPAIGN, dailyBudget: '10.00', startDate: d('2026-08-01') } as never })
    // Germany runs Sponsored Products only: Display is dormant there.
    await db().campaign.create({ data: { id: 'c-sp-de', name: 'Products DE', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED', marketplace: 'DE', externalCampaignId: '900000000000002', dailyBudget: '10.00', startDate: d('2026-08-01') } as never })
    await db().adGroup.create({ data: { id: 'g-sd', campaignId: 'c-sd', name: 'Display group', externalAdGroupId: GROUP } })
    await db().adTarget.create({ data: { id: 't-sd', adGroupId: 'g-sd', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0FXTEST01', externalTargetId: TARGET } })
    await db().adProductAd.create({ data: { id: 'pa-linked', adGroupId: 'g-sd', asin: 'B0FXTEST01', sku: 'SKU-TEST-1', externalAdId: AD } })
    await db().adProductAd.create({ data: { id: 'pa-unlinked', adGroupId: 'g-sd', asin: 'B0FXTEST02', sku: 'SKU-TEST-2' } })
  })
}, 60_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { sent.length = 0 })

describe('the cycle asks Amazon for the four SD reports', () => {
  it('one ranged DAILY job per report, only for the account whose market delivers Display; asked again, nothing new', async () => {
    await inside(async () => {
      const first = await runSdReportCycle({ startDate: '2026-09-23', endDate: '2026-10-07' })
      expect(first).toEqual({ jobsCreated: 4, jobsSkipped: 0, errors: [] })
      expect(sent.map((s) => s.profileId)).toEqual(['p-it', 'p-it', 'p-it', 'p-it'])
      expect(sent.every((s) => s.method === 'POST' && s.path === '/reporting/reports')).toBe(true)
      expect(sent.map((s) => ({ startDate: s.body.startDate, endDate: s.body.endDate, ...s.body.configuration, columns: undefined }))).toEqual(
        [['sdAdGroup', 'adGroup'], ['sdTargeting', 'targeting'], ['sdAdvertisedProduct', 'advertiser'], ['sdPurchasedProduct', 'asin']].map(([reportTypeId, groupBy]) => ({
          startDate: '2026-09-23', endDate: '2026-10-07', adProduct: 'SPONSORED_DISPLAY', reportTypeId, groupBy: [groupBy], timeUnit: 'DAILY', format: 'GZIP_JSON', columns: undefined,
        })),
      )
      expect(sent[1].body.configuration.columns).toEqual(expect.arrayContaining(['targetingId', 'impressionsViews', 'sales', 'salesClicks', 'purchases', 'purchasesClicks']))
      const jobs = await db().amazonAdsReportJob.findMany({ where: { adProduct: 'SPONSORED_DISPLAY', status: 'PENDING' }, select: { profileId: true, reportTypeId: true } })
      expect(jobs.map((j) => j.reportTypeId).sort()).toEqual(['sdAdGroup', 'sdAdvertisedProduct', 'sdPurchasedProduct', 'sdTargeting'])

      sent.length = 0
      expect(await runSdReportCycle({ startDate: '2026-09-23', endDate: '2026-10-07' })).toEqual({ jobsCreated: 0, jobsSkipped: 4, errors: [] })
      expect(sent).toEqual([])
      // The settle catch-up asks one report at a time.
      expect(await runSdReportCycle({ startDate: '2026-08-09', endDate: '2026-08-31', reports: ['sdTargeting'] })).toEqual({ jobsCreated: 1, jobsSkipped: 0, errors: [] })
      expect(sent.map((s) => s.body.configuration.reportTypeId)).toEqual(['sdTargeting'])
    })
  })
})

describe('targets: a re-pull replaces the day', () => {
  it('first copy, then the settled copy replaces it; the newer pull also brings a new day', async () => {
    await inside(async () => {
      const first = await job('sdTargeting', '2026-09-20', '2026-09-20', '2026-09-21T01:15:00Z', [targetRow('2026-09-20', 40, 1)])
      expect(await ingestCompletedJob(first)).toMatchObject({ rowsIngested: 1 })
      expect(await rowsOf('AD_TARGET', '2026-09-20')).toEqual([{
        entityId: TARGET, date: d('2026-09-20'), localEntityId: 't-sd', sales14dCents: 4000, salesClicks14dCents: 2000, orders14d: 1, viewableImpressions: 7000,
        reportRunId: first, marketplace: 'IT', currencyCode: 'EUR',
      }])

      const settle = await job('sdTargeting', '2026-09-20', '2026-10-04', '2026-10-06T01:15:00Z', [targetRow('2026-09-20', 95.5, 3), targetRow('2026-09-25', 10, 0)])
      await ingestCompletedJob(settle)
      expect(await rowsOf('AD_TARGET', '2026-09-20')).toEqual([expect.objectContaining({ sales14dCents: 9550, orders14d: 3, reportRunId: settle })])
      expect(await rowsOf('AD_TARGET', '2026-09-25')).toHaveLength(1)

      // Ingested again (a retried tick): the same rows, nothing added.
      await ingestCompletedJob(settle)
      expect(await rowsOf('AD_TARGET')).toHaveLength(2)
    })
  })

  it('an older pull that finishes late never puts its older copy back', async () => {
    await inside(async () => {
      const late = await job('sdTargeting', '2026-09-19', '2026-09-20', '2026-09-22T01:15:00Z', [targetRow('2026-09-19', 12, 1), targetRow('2026-09-20', 50, 2)])
      await ingestCompletedJob(late)
      expect(await rowsOf('AD_TARGET', '2026-09-20')).toEqual([expect.objectContaining({ sales14dCents: 9550, orders14d: 3 })])
      expect(await rowsOf('AD_TARGET', '2026-09-19')).toEqual([expect.objectContaining({ sales14dCents: 1200, reportRunId: late })])
    })
  })

  it('a target Nexus does not hold still lands (its spend was real), with no local id', async () => {
    await inside(async () => {
      const other = await job('sdTargeting', '2026-10-10', '2026-10-10', '2026-10-11T01:15:00Z', [targetRow('2026-10-10', 0, 0, '900000000000099')])
      await ingestCompletedJob(other)
      expect(await rowsOf('AD_TARGET', '2026-10-10')).toEqual([expect.objectContaining({ entityId: '900000000000099', localEntityId: null, sales14dCents: 0 })])
    })
  })
})

describe('ad groups and product ads', () => {
  it('each joined to Nexus\'s own: the ad group by Amazon\'s id, a product ad by its ad id or, unlinked, by its ASIN in the ad group', async () => {
    await inside(async () => {
      const groups = await job('sdAdGroup', '2026-09-20', '2026-09-20', '2026-09-21T01:15:00Z', [
        { date: '2026-09-20', campaignId: CAMPAIGN, adGroupId: GROUP, adGroupName: 'Display group', ...figures(60, 2) },
      ])
      await ingestCompletedJob(groups)
      expect(await rowsOf('AD_GROUP')).toEqual([expect.objectContaining({ entityId: GROUP, localEntityId: 'g-sd', sales14dCents: 6000, orders14d: 2 })])

      const ads = await job('sdAdvertisedProduct', '2026-09-20', '2026-09-20', '2026-09-21T01:15:00Z', [
        { date: '2026-09-20', campaignId: CAMPAIGN, adGroupId: GROUP, adId: AD, promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1', ...figures(40, 1) },
        { date: '2026-09-20', campaignId: CAMPAIGN, adGroupId: GROUP, adId: '900000000000032', promotedAsin: 'B0FXTEST02', promotedSku: 'SKU-TEST-2', ...figures(20, 1) },
        // No ad id: it cannot be keyed, so it is not stored.
        { date: '2026-09-20', campaignId: CAMPAIGN, adGroupId: GROUP, promotedAsin: 'B0FXTEST03', ...figures(5, 0) },
      ])
      expect(await ingestCompletedJob(ads)).toMatchObject({ rowsIngested: 2 })
      expect((await rowsOf('PRODUCT_AD')).map((r) => [r.entityId, r.localEntityId])).toEqual([[AD, 'pa-linked'], ['900000000000032', 'pa-unlinked']])
    })
  })
})

describe('purchased products: a re-pull replaces the whole day', () => {
  const bought = (date: string, purchasedAsin: string, sales: number, orders: number) => ({
    date, campaignId: CAMPAIGN, adGroupId: GROUP, promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1', asinBrandHalo: purchasedAsin,
    salesBrandHalo: sales, salesBrandHaloClicks: sales / 2, conversionsBrandHalo: orders, conversionsBrandHaloClicks: orders, unitsSoldBrandHalo: orders, unitsSoldBrandHaloClicks: orders,
  })
  const day = (date: string) => db().amazonAdsSdPurchasedProduct.findMany({
    where: { date: d(date) }, orderBy: { purchasedAsin: 'asc' }, select: { purchasedAsin: true, sales14dCents: true, salesClicks14dCents: true, orders14d: true, reportRunId: true },
  })

  it('the newer copy of a day replaces the older one; ingested twice, it is not doubled; a day the pull has no row for is left', async () => {
    await inside(async () => {
      const first = await job('sdPurchasedProduct', '2026-09-20', '2026-09-21', '2026-09-22T01:15:00Z', [
        bought('2026-09-20', 'B0FXTEST04', 30, 1), bought('2026-09-20', 'B0FXTEST05', 20, 1), bought('2026-09-21', 'B0FXTEST04', 15, 1),
      ])
      expect(await ingestCompletedJob(first)).toMatchObject({ rowsIngested: 3 })
      expect(await day('2026-09-20')).toHaveLength(2)

      const settle = await job('sdPurchasedProduct', '2026-09-20', '2026-09-20', '2026-10-06T01:15:00Z', [bought('2026-09-20', 'B0FXTEST04', 45, 2)])
      await ingestCompletedJob(settle)
      await ingestCompletedJob(settle)
      expect(await day('2026-09-20')).toEqual([{ purchasedAsin: 'B0FXTEST04', sales14dCents: 4500, salesClicks14dCents: 2250, orders14d: 2, reportRunId: settle }])
      expect(await day('2026-09-21')).toEqual([expect.objectContaining({ purchasedAsin: 'B0FXTEST04', reportRunId: first })])
    })
  })
})
