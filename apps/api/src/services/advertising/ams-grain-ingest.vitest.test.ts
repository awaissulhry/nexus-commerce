/**
 * BID BRAIN BB-16 — the Marketing Stream ingest at ad group × placement grain, on a disposable PostgreSQL (PGlite: the
 * schema, the policies, the restricted runtime role), through the real `ingestMarketingStream` (the path both the SQS
 * poller and the forwarder's POST use), inside the legacy business.
 *
 *   beside       the campaign-grain table gets exactly the rows it got before (same records with the grain off)
 *   grain        one row per campaign × ad group × placement × hour; keywords and ads of one ad group summed
 *   restatement  conversions arriving over days add up, 1-day and 7-day kept apart; each arrival in its age bucket
 *   negative     a correction subtracts exactly (no clamp); with no row to correct it is refused; a reader clamps a
 *                transient negative cell at 0 and counts it, and the late original makes it right
 *   idempotency  the same record twice adds once; another record with the same numbers adds again
 *   malformed    refused with a reason, nothing written, the campaign grain unchanged
 *   guard        the row-count ceiling refuses NEW rows only; an existing row still takes its deltas; another day is free
 *   late         a row first seen long after its hour is marked, and the reader counts it
 *   switch       NEXUS_AMS_GRAIN_ENABLED=0 writes nothing here
 *   read         today and the last 14 days per campaign × placement × hour in the caller's time zone
 *   keep         the weekly prune drops both tables' rows older than 90 days, in chunks
 *   follow-up    a capped day is marked (rows / arrivals) and the reader returns it; the day's count is read once, not per
 *                row; the arrival log has its own ceiling; the arrival age runs from the record's SQS SentTimestamp; a
 *                throw inside the grain leaves the campaign grain and the POST's answer as they were
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
/** The SQL of every raw read the code under test sent (to count the day-count reads). */
const rawReads: string[] = []
vi.mock('../../db.js', () => ({
  default: new Proxy({}, {
    get: (_target, property) => {
      const value = Reflect.get(database.client, property)
      if (property !== '$queryRaw' || typeof value !== 'function') return value
      return (...args: unknown[]) => { rawReads.push(String((args[0] as { sql?: string })?.sql ?? args[0])); return value.apply(database.client, args) }
    },
  }),
}))
vi.mock('./ads-cache.js', () => ({ flushAdsCache: vi.fn(async () => undefined) }))

const { ingestMarketingStream } = await import('./ads-marketing-stream.service.js')
const { ingestAmsBatch } = await import('./ams-ingest.service.js')
const { loadPlacementHours, cleanupOldPlacementHours, rollUpPlacementHours, forgetGrainDayCounts } = await import('./ams-grain.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const AT = new Date('2026-10-08T12:20:00Z')
const HOUR = '2026-10-08T10:00:00Z'
let seq = 0
const traffic = (over: Record<string, unknown> = {}) => ({
  dataset_id: 'sp-traffic', idempotency_id: `t-${++seq}`, advertiser_id: 'ADV1', marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR',
  campaign_id: '1001', ad_group_id: '2001', ad_id: '3001', keyword_id: '4001', placement: 'Top of Search on-Amazon',
  time_window_start: HOUR, impressions: 100, clicks: 2, cost: 0.8, ...over,
})
const conversion = (over: Record<string, unknown> = {}) => ({
  dataset_id: 'sp-conversion', idempotency_id: `c-${++seq}`, advertiser_id: 'ADV1', marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR',
  campaign_id: '1001', ad_group_id: '2001', placement: 'Top of Search on-Amazon', time_window_start: HOUR,
  attributed_conversions_1d: 0, attributed_conversions_7d: 1, attributed_units_ordered_1d: 0, attributed_units_ordered_7d: 1,
  attributed_sales_1d: 0, attributed_sales_7d: 80, ...over,
})
const ingest = (records: Array<Record<string, unknown>>, at = AT) => inside(() => ingestMarketingStream(records as never, { arrivedAt: at }))
const grainRows = () => inside(() => database.client.amazonAdsHourlyPlacement.findMany({ orderBy: [{ date: 'asc' }, { hour: 'asc' }, { adGroupId: 'asc' }, { placement: 'asc' }] }))
const arrivals = () => inside(() => database.client.amazonAdsHourlyArrival.findMany({ orderBy: [{ kind: 'asc' }, { ageHours: 'asc' }] }))
const campaignRows = async () => (await inside(() => database.client.amazonAdsHourlyPerformance.findMany({ orderBy: [{ entityId: 'asc' }, { date: 'asc' }, { hour: 'asc' }] })))
  .map(({ id: _id, createdAt: _c, reportedAt: _r, workspaceId: _w, ...rest }) => rest)
const metrics = (r: Record<string, any>) => ({ impressions: r.impressions, clicks: r.clicks, costMicros: r.costMicros, orders1d: r.orders1d, orders7d: r.orders7d, sales1dCents: r.sales1dCents, sales7dCents: r.sales7dCents })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    for (const [id, ext] of [['c-local-1', '1001'], ['c-local-2', '1002'], ['c-local-3', null]] as const) {
      await database.client.campaign.create({ data: { id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: ext, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    }
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

beforeEach(async () => {
  vi.unstubAllEnvs()
  forgetGrainDayCounts()
  rawReads.length = 0
  await inside(async () => {
    await database.client.amazonAdsGrainCap.deleteMany({})
    await database.client.amazonAdsHourlyArrival.deleteMany({})
    await database.client.amazonAdsHourlyPlacement.deleteMany({})
    await database.client.amazonAdsHourlyPerformance.deleteMany({})
  })
})

describe('beside the campaign grain', () => {
  it('the campaign-grain table gets exactly what it got before; the new grain splits ad groups and placements', async () => {
    const batch = () => [
      traffic({ keyword_id: '4001' }), traffic({ keyword_id: '4002', impressions: 50, clicks: 1, cost: 0.5 }),
      traffic({ placement: 'Detail Page on-Amazon', impressions: 30, clicks: 1, cost: 0.3 }),
      traffic({ ad_group_id: '2002', placement: 'Other on-Amazon', impressions: 20, clicks: 0, cost: 0 }),
      conversion(), { dataset_id: 'sb-traffic', campaign_id: '1009', time_window_start: HOUR, impressions: 5, idempotency_id: 'sb-1' },
    ]
    vi.stubEnv('NEXUS_AMS_GRAIN_ENABLED', '0')
    const off = await ingest(batch())
    expect(off.grain).toBeUndefined()
    const before = await campaignRows()
    expect(await grainRows()).toEqual([])
    await inside(() => database.client.amazonAdsHourlyPerformance.deleteMany({}))

    vi.unstubAllEnvs()
    const on = await ingest(batch())
    expect(await campaignRows()).toEqual(before)
    expect({ received: on.received, upserted: on.upserted, skipped: on.skipped }).toEqual({ received: off.received, upserted: off.upserted, skipped: off.skipped })
    expect(on.grain).toMatchObject({ received: 6, applied: 5, created: 3, notGrain: 1, duplicates: 0 })

    const rows = await grainRows()
    expect(rows.map((r) => [r.adGroupId, r.placement, r.hour, r.impressions, r.clicks, Number(r.costMicros), r.orders7d, r.sales7dCents])).toEqual([
      ['2001', 'PLACEMENT_PRODUCT_PAGE', 10, 30, 1, 300_000, 0, 0],
      ['2001', 'PLACEMENT_TOP', 10, 150, 3, 1_300_000, 1, 8_000],
      ['2002', 'PLACEMENT_REST_OF_SEARCH', 10, 20, 0, 0, 0, 0],
    ])
    expect(rows[1]).toMatchObject({ profileId: 'ADV1', marketplace: 'IT', currencyCode: 'EUR', campaignId: '1001', lateStart: false })
    expect(rows[1].appliedKeys).toHaveLength(3)
    // Sponsored Brands keeps the campaign grain only.
    expect(before.some((r) => r.entityId === '1009')).toBe(true)
  })
})

describe('restatements', () => {
  it('conversions arriving over days add up, 1-day and 7-day apart, each arrival in its age bucket', async () => {
    await ingest([traffic()], new Date('2026-10-08T11:30:00Z'))
    await ingest([conversion({ attributed_conversions_1d: 1, attributed_conversions_7d: 1, attributed_sales_1d: 80, attributed_sales_7d: 80 })], new Date('2026-10-08T12:10:00Z'))
    await ingest([conversion({ attributed_conversions_7d: 1, attributed_sales_7d: 40 })], new Date('2026-10-11T13:00:00Z'))
    await ingest([conversion({ attributed_conversions_7d: 1, attributed_sales_7d: 40 })], new Date('2026-10-11T15:00:00Z'))
    const [row] = await grainRows()
    expect(metrics(row)).toEqual({ impressions: 100, clicks: 2, costMicros: 800_000n, orders1d: 1, orders7d: 3, sales1dCents: 8_000, sales7dCents: 16_000 })
    expect(row.firstArrivalAt.toISOString()).toBe('2026-10-08T11:30:00.000Z')
    expect(row.lastArrivalAt.toISOString()).toBe('2026-10-11T15:00:00.000Z')
    expect((await arrivals()).map((a) => [a.kind, a.ageHours, a.records, a.orders7d, a.sales7dCents, a.clicks, a.grainId === row.id])).toEqual([
      ['conversion', 1, 1, 1, 8_000, 0, true],
      ['conversion', 72, 2, 2, 8_000, 0, true],
      ['traffic', 0, 1, 0, 0, 2, true],
    ])
  })
})

describe('negative deltas', () => {
  it('subtract exactly against a row; with no row to correct they are refused', async () => {
    await ingest([traffic({ clicks: 4, cost: 1.2 })])
    const out = await ingest([traffic({ impressions: 0, clicks: -1, cost: -0.3 })])
    expect(out.grain).toMatchObject({ applied: 1, created: 0 })
    expect(metrics((await grainRows())[0])).toMatchObject({ clicks: 3, costMicros: 900_000n })

    const orphan = await ingest([traffic({ ad_group_id: '2009', impressions: -10, clicks: -1, cost: -0.3 })])
    expect(orphan.grain).toMatchObject({ applied: 0, noBaseline: 1 })
    expect((await grainRows()).map((r) => r.adGroupId)).toEqual(['2001'])
    // A negative conversion (a return) against its row.
    await ingest([conversion()])
    await ingest([conversion({ attributed_conversions_7d: -1, attributed_units_ordered_7d: -1, attributed_sales_7d: -80 })])
    expect(metrics((await grainRows())[0])).toMatchObject({ orders7d: 0, sales7dCents: 0 })
  })

  it('a correction that arrives before its original is kept exactly; the reader reads 0 for a moment and says so', async () => {
    await ingest([traffic({ keyword_id: '4001', clicks: 1, cost: 0.4 })])
    await ingest([traffic({ keyword_id: '4002', impressions: 0, clicks: -2, cost: -0.8 })])
    expect(metrics((await grainRows())[0])).toMatchObject({ clicks: -1, costMicros: -400_000n })
    const early = await inside(() => loadPlacementHours({ campaignIds: ['c-local-1'], now: AT }))
    expect(early.negativeCells).toBe(1)
    expect(early.cells[0]).toMatchObject({ clicks: 0, spendCents: 0 })
    await ingest([traffic({ keyword_id: '4002', impressions: 40, clicks: 5, cost: 2 })])
    expect(metrics((await grainRows())[0])).toMatchObject({ clicks: 4, costMicros: 1_600_000n })
  })
})

describe('idempotency', () => {
  it('the same record twice adds once (also inside one batch); another record with the same numbers adds again', async () => {
    const once = traffic({ idempotency_id: 'same-1' })
    const first = await ingest([once, once])
    expect(first.grain).toMatchObject({ applied: 1, duplicates: 1 })
    const again = await ingest([{ ...once }], new Date('2026-10-08T14:00:00Z'))
    expect(again.grain).toMatchObject({ applied: 0, duplicates: 1 })
    expect(metrics((await grainRows())[0])).toMatchObject({ impressions: 100, clicks: 2 })
    expect((await arrivals()).map((a) => [a.kind, a.ageHours, a.records])).toEqual([['traffic', 1, 1]])

    await ingest([traffic({ idempotency_id: 'same-2' })])
    expect(metrics((await grainRows())[0])).toMatchObject({ impressions: 200, clicks: 4 })
    // The same id in the other dataset is another record.
    await ingest([conversion({ idempotency_id: 'same-1' })])
    expect((await grainRows())[0].orders7d).toBe(1)
  })
})

describe('malformed records', () => {
  it('are refused with a reason and write nothing here; the campaign grain takes what it took before', async () => {
    const out = await ingest([
      traffic({ ad_group_id: undefined }), traffic({ clicks: 'two' }), traffic({ idempotency_id: '' }),
      traffic({ time_window_start: 'not a time' }), traffic({ impressions: 0, clicks: 0, cost: 0 }),
      traffic({ time_window_start: '2026-06-01T10:00:00Z' }),
    ])
    expect(out.grain).toMatchObject({ received: 6, applied: 0, malformed: 3, noIdempotencyKey: 1, zero: 1, tooOld: 1 })
    expect(await grainRows()).toEqual([])
    expect(await arrivals()).toEqual([])
    // The campaign grain is unchanged by this PR: it still sums what it accepts (here every record but the bad time).
    expect((await campaignRows()).length).toBeGreaterThan(0)
  })
})

describe('the row-count guard', () => {
  it('refuses NEW rows above the ceiling of a data day; an existing row still takes its deltas; another day is free', async () => {
    vi.stubEnv('NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY', '2')
    const out = await ingest([traffic({ ad_group_id: '2001' }), traffic({ ad_group_id: '2002' }), traffic({ ad_group_id: '2003' })])
    expect(out.grain).toMatchObject({ applied: 2, created: 2, capped: 1 })
    const more = await ingest([traffic({ ad_group_id: '2001', clicks: 3 }), traffic({ ad_group_id: '2004' })])
    expect(more.grain).toMatchObject({ applied: 1, created: 0, capped: 1 })
    expect((await grainRows()).map((r) => [r.adGroupId, r.clicks])).toEqual([['2001', 5], ['2002', 2]])
    const nextDay = await ingest([traffic({ ad_group_id: '2003', time_window_start: '2026-10-09T01:00:00Z' })], new Date('2026-10-09T02:30:00Z'))
    expect(nextDay.grain).toMatchObject({ created: 1, capped: 0 })
    // A refused record left no arrival behind.
    expect((await arrivals()).length).toBe(3)
  })

  it('a ceiling of 0 creates nothing; the campaign grain carries on', async () => {
    vi.stubEnv('NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY', '0')
    const out = await ingest([traffic()])
    expect(out).toMatchObject({ upserted: 1, grain: { capped: 1, applied: 0 } })
    expect(await grainRows()).toEqual([])
  })

  it('never drops quietly: the capped day is marked for its business, and the reader returns it', async () => {
    vi.stubEnv('NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY', '1')
    await ingest([traffic({ ad_group_id: '2001' }), traffic({ ad_group_id: '2002' }), traffic({ ad_group_id: '2003' })])
    const marks = await inside(() => database.client.amazonAdsGrainCap.findMany())
    expect(marks.map((m) => [m.date.toISOString().slice(0, 10), m.kind, m.cap, m.refused])).toEqual([['2026-10-08', 'rows', 1, 2]])
    // Later refusals in the same process are added at most every 10 minutes (the first one is marked at once).
    await ingest([traffic({ ad_group_id: '2004' })])
    expect((await inside(() => database.client.amazonAdsGrainCap.findMany()))[0].refused).toBe(2)
    const read = await inside(() => loadPlacementHours({ campaignIds: ['c-local-1'], now: AT }))
    expect(read.cappedDays).toEqual([{ date: '2026-10-08', kind: 'rows', cap: 1, refusedAtLeast: 2 }])
    // A day with no refusal is not marked; the prune drops the marks with the rows.
    expect((await inside(() => loadPlacementHours({ campaignIds: ['c-local-1'], now: new Date('2026-09-01T12:00:00Z'), pastDays: 3 }))).cappedDays).toEqual([])
    await inside(() => cleanupOldPlacementHours(90, new Date('2027-01-10T05:00:00Z')))
    expect(await inside(() => database.client.amazonAdsGrainCap.findMany())).toEqual([])
  })

  it('reads the day\'s count once (then counts in memory), not one count(*) per new row', async () => {
    await ingest(Array.from({ length: 25 }, (_, i) => traffic({ ad_group_id: `30${i}` })))
    await ingest([traffic({ ad_group_id: '3100' }), traffic({ ad_group_id: '3101', time_window_start: '2026-10-07T10:00:00Z' })])
    expect((await grainRows()).length).toBe(27)
    // Two data days touched: two reads of a day's counts in all, whatever the number of rows.
    expect(rawReads.filter((q) => q.includes('count(*)')).length).toBe(2)
    // In memory the ceiling still holds exactly: 27 rows on the 8th; a ceiling of 27 refuses the next new row.
    vi.stubEnv('NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY', '26')
    expect((await ingest([traffic({ ad_group_id: '3102' })])).grain).toMatchObject({ capped: 1, created: 0 })
  })
})

describe('the arrival log\'s own ceiling', () => {
  it('past it a new bucket is left out (the row still takes the delta), an existing bucket still adds, and the day is marked', async () => {
    vi.stubEnv('NEXUS_AMS_GRAIN_MAX_ARRIVALS_PER_DAY', '1')
    const first = await ingest([traffic({ clicks: 2 })])
    expect(first.grain).toMatchObject({ applied: 1, created: 1, arrivalsCapped: 0 })
    // The same row, conversions (another bucket): the row adds, the bucket is not made.
    const second = await ingest([conversion()])
    expect(second.grain).toMatchObject({ applied: 1, created: 0, arrivalsCapped: 1 })
    // The same row and bucket as the first record: the existing bucket still adds.
    const third = await ingest([traffic({ clicks: 3 })])
    expect(third.grain).toMatchObject({ applied: 1, arrivalsCapped: 0 })
    const [row] = await grainRows()
    expect(metrics(row)).toMatchObject({ clicks: 5, orders7d: 1 })
    expect((await arrivals()).map((a) => [a.kind, a.records, a.clicks])).toEqual([['traffic', 2, 5]])
    expect((await inside(() => database.client.amazonAdsGrainCap.findMany())).map((m) => [m.kind, m.refused])).toEqual([['arrivals', 1]])
  })
})

describe('the arrival time', () => {
  it('runs from when the record left the queue (its SQS SentTimestamp, else the caller\'s), not from when it was read', async () => {
    // Read at 12:20, but sent at 11:05 (the 10:00 hour ended at 11:00): age 0 h, not 1 h.
    const sent = new Date('2026-10-08T11:05:00Z')
    await ingest([traffic({ SentTimestamp: String(sent.getTime()) })])
    expect((await arrivals()).map((a) => [a.ageHours, a.firstAt.toISOString()])).toEqual([[0, sent.toISOString()]])
    // The caller's sent time (the SQS poller's message), when the record carries none.
    await ingest([conversion()], new Date('2026-10-08T13:30:00Z'))
    expect((await arrivals()).find((a) => a.kind === 'conversion')!.ageHours).toBe(2)
  })
})

describe('a throw inside the grain', () => {
  it('leaves the campaign grain and the POST\'s answer exactly as with the grain off', async () => {
    const batch = () => [traffic({ campaign_id: '1001' }), traffic({ campaign_id: '1002', impressions: 7 })]
    // The grain off: what the campaign grain and the POST answer were before BB-16.
    vi.stubEnv('NEXUS_AMS_GRAIN_ENABLED', '0')
    const off = await inside(() => ingestAmsBatch(batch()))
    const offRows = await campaignRows()
    await inside(() => database.client.amazonAdsHourlyPerformance.deleteMany({}))
    vi.unstubAllEnvs()
    // A record whose ad group cannot even be read: the grain's parse throws, outside its per-record catch.
    const exploding = () => batch().map((r, i) => (i === 0 ? Object.defineProperty({ ...r }, 'ad_group_id', { get() { throw new Error('grain blew up') }, enumerable: false }) : r))
    const on = await inside(() => ingestAmsBatch(exploding()))
    expect(await campaignRows()).toEqual(offRows)
    expect(on).toEqual(off)
    expect(await grainRows()).toEqual([])
    // A statement that fails inside the per-record catch (7-day sales past a 32-bit integer): counted as failed, the rest
    // of the batch written, the campaign grain unharmed.
    await inside(() => database.client.amazonAdsHourlyPerformance.deleteMany({}))
    const failing = await inside(() => ingestMarketingStream([conversion({ attributed_sales_7d: 900_000_000 }), traffic({ campaign_id: '1002' })] as never, { arrivedAt: AT }))
    expect(failing).toMatchObject({ received: 2, upserted: 2, grain: { failed: 1, applied: 1, created: 1 } })
    expect((await campaignRows()).length).toBe(2)
  })
})

describe('a late start', () => {
  it('a row first seen more than 12 hours after its hour is marked, and the reader counts it', async () => {
    await ingest([conversion({ time_window_start: '2026-10-06T10:00:00Z' })])
    await ingest([traffic()])
    const rows = await grainRows()
    expect(rows.map((r) => [r.date.toISOString().slice(0, 10), r.lateStart])).toEqual([['2026-10-06', true], ['2026-10-08', false]])
    const read = await inside(() => loadPlacementHours({ campaignIds: ['c-local-1'], now: AT }))
    expect(read.lateStartCells).toBe(1)
  })
})

describe('the read helper', () => {
  it('today and the last 14 days per campaign × placement × hour, in the caller\'s time zone, ad groups summed', async () => {
    const at = new Date('2026-10-08T12:20:00Z')
    await ingest([
      // 22:00 UTC on the 7th is 00:00 on the 8th in Rome (CEST): today.
      traffic({ time_window_start: '2026-10-07T22:00:00Z', ad_group_id: '2001', impressions: 10, clicks: 1, cost: 0.25 }),
      traffic({ time_window_start: '2026-10-07T22:00:00Z', ad_group_id: '2002', impressions: 10, clicks: 1, cost: 0.25 }),
      traffic({ time_window_start: '2026-10-08T09:00:00Z', placement: 'Other on-Amazon' }),
      conversion({ time_window_start: '2026-10-08T09:00:00Z', placement: 'Other on-Amazon', attributed_conversions_1d: 1, attributed_sales_1d: 80 }),
      // 10 days ago: in the window. 20 days ago: out of it.
      traffic({ time_window_start: '2026-09-28T10:00:00Z' }),
      traffic({ time_window_start: '2026-09-18T10:00:00Z' }),
      traffic({ campaign_id: '1002', time_window_start: '2026-10-08T09:00:00Z' }),
    ], at)
    const read = await inside(() => loadPlacementHours({ campaignIds: ['c-local-1', 'c-local-3', 'c-missing'], now: at, timeZone: 'Europe/Rome' }))
    // All of it reached Nexus at 12:20 UTC: the hour 10 days ago and the one at 22:00 UTC yesterday were first seen more
    // than 12 hours after they ended, so their cells are counted as late starts.
    expect(read).toMatchObject({ timeZone: 'Europe/Rome', today: '2026-10-08', negativeCells: 0, lateStartCells: 2, unlinked: ['c-local-3', 'c-missing'] })
    expect(read.days).toHaveLength(15)
    expect(read.days[0]).toBe('2026-09-24')
    expect(read.cells.map((c) => [c.campaignId, c.placement, c.day, c.hour, c.impressions, c.clicks, c.spendCents, c.orders1d, c.orders7d, c.sales1dCents])).toEqual([
      ['c-local-1', 'PLACEMENT_TOP', '2026-09-28', 12, 100, 2, 80, 0, 0, 0],
      ['c-local-1', 'PLACEMENT_TOP', '2026-10-08', 0, 20, 2, 50, 0, 0, 0],
      ['c-local-1', 'PLACEMENT_REST_OF_SEARCH', '2026-10-08', 11, 100, 2, 80, 1, 1, 8_000],
    ])
    expect(read.lastArrivalAt?.toISOString()).toBe(at.toISOString())
    const byDay = rollUpPlacementHours(read.cells, (c) => (c.day === read.today ? 'today' : 'past'))
    expect(byDay.get('today')).toMatchObject({ clicks: 4, spendCents: 130, orders7d: 1 })
    expect(byDay.get('past')).toMatchObject({ clicks: 2, spendCents: 80 })

    const utc = await inside(() => loadPlacementHours({ campaignIds: ['c-local-1'], now: at, pastDays: 0 }))
    expect(utc).toMatchObject({ timeZone: 'UTC', days: ['2026-10-08'] })
    expect(utc.cells.map((c) => [c.placement, c.hour])).toEqual([['PLACEMENT_REST_OF_SEARCH', 9]])
    expect((await inside(() => loadPlacementHours({ campaignIds: [], now: at }))).cells).toEqual([])
  })
})

describe('the weekly prune', () => {
  it('drops both tables\' rows older than 90 days and keeps the rest', async () => {
    await ingest([traffic({ time_window_start: '2026-07-12T10:00:00Z' })], new Date('2026-07-12T12:00:00Z'))
    await ingest([traffic()])
    expect((await grainRows()).length).toBe(2)
    const out = await inside(() => cleanupOldPlacementHours(90, new Date('2026-10-12T05:00:00Z')))
    expect(out).toEqual({ deletedRows: 1, deletedArrivals: 1, cutoffDate: '2026-07-14' })
    expect((await grainRows()).map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-10-08'])
  })

  it('deletes in chunks: every old row goes, a chunk at a time, and the new ones stay', async () => {
    await ingest(Array.from({ length: 5 }, (_, i) => traffic({ ad_group_id: `40${i}`, time_window_start: '2026-07-12T10:00:00Z' })), new Date('2026-07-12T12:00:00Z'))
    await ingest([traffic()])
    const out = await inside(() => cleanupOldPlacementHours(90, new Date('2026-10-12T05:00:00Z'), { chunk: 2 }))
    expect(out).toEqual({ deletedRows: 5, deletedArrivals: 5, cutoffDate: '2026-07-14' })
    expect((await grainRows()).length).toBe(1)
    expect((await arrivals()).length).toBe(1)
  })
})
