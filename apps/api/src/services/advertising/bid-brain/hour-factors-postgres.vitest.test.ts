/**
 * BID BRAIN BB-22 — learned hour factors inside the approved hourly plan, on a real PostgreSQL (the throwaway PostgreSQL 17
 * of scripts/run-real-postgres-tests.mjs, row-level policies on, business profiles ON), the bid brain's server switch
 * `live` with one owned campaign (c-it) whose hourly plan holds a 200 % top-of-search target from 08:00 to 16:00 (Rome),
 * the ads mode LIVE (the real write gate) and Amazon a recorder (its current placements read, its PUT kept).
 *
 *   table     BidBrainHourFactor: invisible to another business, refused without one, row-level security forced
 *   shadow    (the default) a full run learns the product once — the curves from the stored hours (its mornings convert
 *             poorly), its plan against them — and stores one row; the placements written are exactly the approved ones;
 *             the why names what the learned factor would do at noon (×0.70, the cell's floor: top of search 200 → 110 %);
 *             a light tick learns nothing and writes nothing; a second full run the same day does not learn again
 *   off       nothing learned, nothing read
 *   on        the product's hours lever not owned (not enrolled): nothing applied, the why says why; enrolled with the
 *             hours lever at PROPOSE: the next tick writes the learned lanes inside the cell's limits (top of search
 *             110 %, product pages 5 %) as the brain, the action log naming the learned factor; the keyword bids unchanged
 *   locked    the Owner locks the noon cell: the next tick puts the approved lanes back
 *   capped    a day the hourly feed was capped is left out of the learning
 *   view      bid-brain view hour-factors: learned against painted per hour, confidence, the marks (moved, locked, Min bid)
 *   another   another business sees and learns nothing
 *
 * Values are made up (public repo): round counts, clicks at 0.40.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
/** Amazon, as a recorder: the campaign's current placements, and every placement PUT. */
const amz = vi.hoisted(() => ({ placements: [] as Array<{ placement: string; percentage: number }>, puts: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('../ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ads-api-client.js')>()
  return {
    ...real,
    listCampaignsV3: async (_ctx: unknown, q: { campaignIds?: string[] }) => (q.campaignIds ?? []).map((id) => ({ campaignId: id, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: amz.placements } })),
    updateCampaign: async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
      amz.puts.push({ externalId, patch })
      amz.placements = (patch.placementBidding as typeof amz.placements | undefined) ?? amz.placements
      return { ok: true, mode: 'live', rawResponse: {} }
    },
  }
})

const { runShadowOnce } = await import('./shadow.js')
const { setEnrollment } = await import('./enrollment.js')
const { readBidBrain } = await import('./read.js')
const { enrollProduct, setLever, setOverride } = await import('../brain/enrollment.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { saveRankScheduleGroup } = await import('../ads-create.service.js')
const { localDayHour, researchDays } = await import('../brain/hours-research.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `bb22_hours_${hex}`
const W2 = `bb22_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
type Data = Record<string, any>
const rows = async <T = Data,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const P = `${hex}-jacket`, P1 = `${hex}-jacket-m`
const TABLE = 'BidBrainHourFactor'
const PLAN_NAME = `Test jacket IT ${hex}`
const EVERY = [0, 1, 2, 3, 4, 5, 6]
// The real clock: the bid brain reads its evidence window and its research days from it. Between Rome's midnight and UTC's
// (22:00–24:00 UTC in summer) the plan's noon below is on another Rome day than NOW: step NOW back into the same day.
const NOW = (() => {
  const n = new Date()
  return localDayHour(n, 'Europe/Rome').day === n.toISOString().slice(0, 10) ? n : new Date(n.getTime() - 3 * 3_600_000)
})()
const DAY = 86_400_000
const today = NOW.toISOString().slice(0, 10)
// The plan's clock (Europe/Rome): 12:00 serves the 200 % top-of-search target.
const NOON = (() => { for (let h = 8; h <= 13; h++) { const t = new Date(`${today}T${String(h).padStart(2, '0')}:00:00Z`); if (localDayHour(t, 'Europe/Rome').hour === 12) return t } throw new Error('no Rome noon today') })()
const NOON_DAY = new Date(`${localDayHour(NOON, 'Europe/Rome').day}T00:00:00Z`).getUTCDay()
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000)
const DAYS = researchDays(NOW, 'Europe/Rome', 4)
const morning = (h: number) => h >= 8 && h < 16

const factorRows = (w = W) => rows('SELECT "productId", marketplace, "campaignIds", "windowFrom", "windowTo", factors, "learnedAt" FROM "BidBrainHourFactor" WHERE "workspaceId" = $1', [w])
const lastPut = () => Object.fromEntries((amz.puts[amz.puts.length - 1].patch.placementBidding as typeof amz.placements).map((p) => [p.placement, p.percentage]))
const whys = async () => (await rows<{ why: string }>('SELECT why FROM "BidBrainDecision" WHERE "workspaceId" = $1 AND "campaignId" = \'c-it\' ORDER BY "createdAt" DESC', [W])).map((r) => r.why)
const bids = async () => Object.fromEntries((await rows<{ id: string; b: number }>('SELECT id, "bidCents" b FROM "AdTarget" WHERE "workspaceId" = $1 AND id IN (\'t-it\', \'t-low\')', [W])).map((r) => [r.id, r.b]))

async function seed() {
  const db = database.client
  await seedAdsFixture(db)
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id, sku, name: sku, basePrice: '80.00', totalStock: 30, ...extra } })
  await product(P, `BB22-JACKET-${hex}`, { isParent: true, name: 'Test jacket' })
  await product(P1, `BB22-JACKET-M-${hex}`, { parentId: P, amazonAsin: `B0BB22JM${H}` })
  await db.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: P1, asin: `B0BB22JM${H}` } })
  // The keywords' settled days (the bid brain decides them) — as the BB-7 suite seeds them.
  const daily: Data[] = []
  for (const [target, d] of Object.entries({ 't-it': { clicks: 6, orders: 1 }, 't-low': { clicks: 2, orders: 0 } })) {
    for (let i = 1; i < 38; i++) {
      daily.push({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - i * DAY), entityType: 'AD_TARGET',
        entityId: `EXT-${target}`, localEntityId: target, clicks: d.clicks, costMicros: BigInt(d.clicks * 300_000), currencyCode: 'EUR',
        orders7d: d.orders, sales7dCents: d.orders * 8000, reportedAt: new Date(NOW.getTime() - 3_600_000),
      })
    }
  }
  await db.amazonAdsDailyPerformance.createMany({ data: daily as never })
  await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, targetLoPct: 18, targetHiPct: 28, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
  await db.rankTarget.create({ data: { key: 'hf-min', name: 'Min bid', pause: true, floorBidCents: 3 } })
  await db.rankTarget.create({ data: { key: 'hf-top', name: 'Top', placement: 'PLACEMENT_TOP', biasPct: 200, maxCpcCents: 900, lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 200 }, { placement: 'PLACEMENT_PRODUCT_PAGE', biasPct: 50 }] } })
  await db.rankTarget.create({ data: { key: 'hf-rest', name: 'Rest of search', placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 0, maxCpcCents: 900 } })
  await saveRankScheduleGroup({
    name: PLAN_NAME, marketplace: 'IT', timezone: 'Europe/Rome', defaultTargetKey: 'hf-rest', targetOverrides: {}, enabled: true, campaignIds: ['c-it'], userId: 'user:owner',
    windows: [{ days: EVERY, startHour: 0, endHour: 6, targetKey: 'hf-min' }, { days: EVERY, startHour: 8, endHour: 16, targetKey: 'hf-top' }] as never,
  })
  // The hourly feed (campaign grain, 1-day conversions in the 7d-named columns): 20 clicks an hour; mornings (08–16, the
  // plan's 200 % hours) convert 0.5 %, the rest 4 %; a morning click costs what the plan's uplift makes it (×2.1).
  const inWindow = new Set(DAYS)
  const carry = Array.from({ length: 24 }, (_, h) => (h * 7 % 24) / 24)
  const hourly: Data[] = []
  const perDay = new Map<string, { clicks: number; cost: number; orders: number }>()
  const start = Date.parse(`${DAYS[0]}T00:00:00Z`) - DAY
  const end = Date.parse(`${DAYS[DAYS.length - 1]}T00:00:00Z`) + 2 * DAY
  for (let t = start; t < end; t += 3_600_000) {
    const instant = new Date(t)
    const { day, hour } = localDayHour(instant, 'Europe/Rome')
    if (!inWindow.has(day)) continue
    carry[hour] += 20 * (morning(hour) ? 0.005 : 0.04)
    const orders = Math.floor(carry[hour] + 1e-9)
    carry[hour] -= orders
    const cpc = morning(hour) ? 84 : 40
    hourly.push({
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${instant.toISOString().slice(0, 10)}T00:00:00Z`), hour: instant.getUTCHours(),
      entityType: 'CAMPAIGN', entityId: 'EXT-c-it', localEntityId: 'c-it', impressions: 600, clicks: 20, costMicros: BigInt(20 * cpc * 10_000),
      currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000, reportedAt: NOW,
    })
    const d = perDay.get(day) ?? { clicks: 0, cost: 0, orders: 0 }
    perDay.set(day, { clicks: d.clicks + 20, cost: d.cost + 20 * cpc, orders: d.orders + orders })
  }
  await db.amazonAdsHourlyPerformance.createMany({ data: hourly as never })
  // The daily report (7-day attribution) and the placement report: top of search converts twice the rest.
  const campaignDays: Data[] = []
  const placements: Data[] = []
  for (const [day, d] of perDay) {
    const orders7 = Math.round(d.orders * 1.3)
    campaignDays.push({
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${day}T00:00:00Z`), entityType: 'CAMPAIGN', entityId: 'EXT-c-it',
      localEntityId: 'c-it', impressions: d.clicks * 30, clicks: d.clicks, costMicros: BigInt(Math.round(d.cost * 10_000)), currencyCode: 'EUR', orders7d: orders7, sales7dCents: orders7 * 8000, reportedAt: NOW,
    })
    for (const [label, clicks, orders, cost] of [['Top of Search on-Amazon', 200, 8, 10_000], ['Other on-Amazon', 200, 4, 6_000], ['Detail Page on-Amazon', 80, 2, 4_000]] as const) {
      placements.push({ profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${day}T00:00:00Z`), campaignId: 'EXT-c-it', localCampaignId: 'c-it', placement: label, impressions: clicks * 30, clicks, costMicros: BigInt(cost * 10_000), currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000 })
    }
  }
  await db.amazonAdsDailyPerformance.createMany({ data: campaignDays as never })
  await db.amazonAdsPlacementReport.createMany({ data: placements as never })
  await setAutonomy('AUTO', 'test')
  await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: NOW })
}

describe.skipIf(!concurrentDatabaseUrl())('BB-22 — learned hour factors inside the approved plan (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_BID_BRAIN_HOUR_FACTORS', '')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const row = await inW(() => db.bidBrainHourFactor.create({ data: { productId: 'x-table-test', marketplace: 'IT', factors: {}, learnedAt: NOW } }))
    expect(row).toMatchObject({ workspaceId: W, productId: 'x-table-test', campaignIds: [] })
    await inW2(async () => {
      expect(await db.bidBrainHourFactor.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "BidBrainHourFactor"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "BidBrainHourFactor" SET marketplace = 'DE' WHERE id = ${row.id}`).toBe(0)
      await expect(db.bidBrainHourFactor.create({ data: { workspaceId: W, productId: 'x', marketplace: 'IT', factors: {}, learnedAt: NOW } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    await expect(db.bidBrainHourFactor.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [TABLE])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [TABLE])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [TABLE])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "BidBrainHourFactor" WHERE "productId" = \'x-table-test\'')
  })

  it('shadow (the default): learned once and stored, the approved placements written, the why names the learned move', async () => {
    await inW(() => runShadowOnce({ now: at(NOW, 1), mode: 'live', clockNow: NOON }))
    const [row] = await factorRows()
    expect(row).toMatchObject({ productId: P, marketplace: 'IT', campaignIds: ['c-it'], windowFrom: DAYS[0], windowTo: DAYS[DAYS.length - 1] })
    const f = row.factors
    expect(f.plans).toHaveLength(1)
    expect(f.plans[0]).toMatchObject({ campaignId: 'c-it' })
    // Its mornings convert poorly: the learned factor sits far below the evening's there.
    const k = (h: number) => NOON_DAY * 24 + h
    expect(f.curves.f[k(12)]).toBeLessThan(0.5 * f.curves.f[k(20)])
    expect(f.plans[0].rho[k(12)]).toBeLessThan(0.7)
    expect(f.plans[0].painted[k(3)]).toBeNull() // a Min-bid hour
    expect(f.tos).toMatchObject({ capPct: expect.any(Number) })
    expect(f.tos.ratio).toBeGreaterThan(1.3)
    expect(f.summary.join(' ')).toMatch(/Conversion \(pooled\) is best .* and worst/)
    // The plan runs exactly as approved: one placement write, 200 % top of search, 50 % product pages.
    expect(amz.puts).toHaveLength(1)
    expect(lastPut()).toMatchObject({ PLACEMENT_TOP: 200, PLACEMENT_PRODUCT_PAGE: 50 })
    // The why: what the learned factor would do to the noon cell — the cell's floor, 30 % below the approved.
    const why = (await whys())[0]
    expect(why).toMatch(/ · hour factors \(shadow — nothing changed\): \w{3} 12:00: learned ×[\d.]+ against the plan's ×[\d.]+ → asks ×0\.\d\d of the cell; 90 %: ×[\d.]+–×[\d.]+ — ×0\.70 \(held at the cell's floor, 30 % below the approved\): top-of-search 200 → 110 % \(limits 110–200 %\), product-page 50 → 5 % \(limits 5–50 %\)$/)
    // A light tick: nothing learned again, nothing written.
    const learnedAt = row.learnedAt.toISOString()
    await inW(() => runShadowOnce({ now: at(NOW, 2), mode: 'live', onlyOwned: true, clockNow: at(NOON, 15) }))
    expect(amz.puts).toHaveLength(1)
    // A second full run the same day: not learned again.
    await inW(() => runShadowOnce({ now: at(NOW, 3), mode: 'live', clockNow: at(NOON, 20) }))
    const again = await factorRows()
    expect(again).toHaveLength(1)
    expect(again[0].learnedAt.toISOString()).toBe(learnedAt)
    expect(amz.puts).toHaveLength(1)
  })

  it('off: nothing learned, nothing read', async () => {
    await database.pool.query('DELETE FROM "BidBrainHourFactor" WHERE "workspaceId" = $1', [W])
    vi.stubEnv('NEXUS_BID_BRAIN_HOUR_FACTORS', 'off')
    try {
      await inW(() => runShadowOnce({ now: at(NOW, 4), mode: 'live', clockNow: at(NOON, 25) }))
      expect(await factorRows()).toEqual([])
      expect(amz.puts).toHaveLength(1)
    } finally { vi.stubEnv('NEXUS_BID_BRAIN_HOUR_FACTORS', '') }
  })

  it('on, the product\'s hours lever not owned (not enrolled): nothing applied, the why says why', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_HOUR_FACTORS', 'on')
    // Fresh decisions, so the full run stores each one with its why.
    await database.pool.query('DELETE FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])
    await inW(() => runShadowOnce({ now: at(NOW, 5), mode: 'live', clockNow: at(NOON, 30) }))
    expect(await factorRows()).toHaveLength(1)
    expect(amz.puts).toHaveLength(1)
    expect((await whys())[0]).toMatch(/ · hour factors \(not applied: the product's hours lever is NOT_ENROLLED .*'on' acts where the product's brain owns it \(PROPOSE\)\): \w{3} 12:00: .* top-of-search 200 → 110 %/)
  })

  it('on, enrolled with the hours lever at PROPOSE: the next tick writes the learned lanes inside the limits; the keyword bids unchanged', async () => {
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'hours', level: 'PROPOSE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    const before = await bids()
    await inW(() => runShadowOnce({ now: at(NOW, 6), mode: 'live', onlyOwned: true, clockNow: at(NOON, 35) }))
    expect(amz.puts).toHaveLength(2)
    expect(lastPut()).toMatchObject({ PLACEMENT_TOP: 110, PLACEMENT_PRODUCT_PAGE: 5 })
    const [log] = await rows<{ userId: string; note: string }>('SELECT "userId", evidence->>\'note\' AS note FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = \'c-it\' AND "actionType" = \'update_placement_bidding\' ORDER BY "createdAt" DESC LIMIT 1', [W])
    expect(log.userId).toBe('automation:bid-brain')
    expect(log.note).toMatch(/hourly plan .*: hf-top — learned hour factor: \w{3} 12:00: .*top-of-search 200 → 110 % \(limits 110–200 %\)/)
    // A full run on the same data day: the keyword bids exactly as before (the learned factor moves placements only).
    await inW(() => runShadowOnce({ now: at(NOW, 7), mode: 'live', clockNow: at(NOON, 40) }))
    expect(await bids()).toEqual(before)
    expect(amz.puts).toHaveLength(2)
  })

  it('the Owner locks the noon cell: the next tick puts the approved lanes back', async () => {
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'noon stays mine', now: NOW, override: { scope: 'PRODUCT', kind: 'LOCK', key: 'hours', ref: `hourCell:d${NOON_DAY}h12` } }))).toMatchObject({ ok: true })
    await inW(() => runShadowOnce({ now: at(NOW, 8), mode: 'live', onlyOwned: true, clockNow: at(NOON, 45) }))
    expect(amz.puts).toHaveLength(3)
    expect(lastPut()).toMatchObject({ PLACEMENT_TOP: 200, PLACEMENT_PRODUCT_PAGE: 50 })
    const [log] = await rows<{ note: string }>('SELECT evidence->>\'note\' AS note FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = \'c-it\' AND "actionType" = \'update_placement_bidding\' ORDER BY "createdAt" DESC LIMIT 1', [W])
    expect(log.note).not.toMatch(/learned hour factor/)
  })

  it('a day the hourly feed was capped is left out of the learning', async () => {
    const capped = DAYS[10]
    await inW(() => database.client.amazonAdsGrainCap.create({ data: { date: new Date(`${capped}T00:00:00Z`), kind: 'rows', cap: 10_000, refused: 5, firstAt: NOW, lastAt: NOW } }))
    await database.pool.query('DELETE FROM "BidBrainHourFactor" WHERE "workspaceId" = $1', [W])
    await inW(() => runShadowOnce({ now: at(NOW, 9), mode: 'live', clockNow: at(NOON, 50) }))
    const [row] = await factorRows()
    const left = row.factors.leftOut.map((x: Data) => x.day)
    expect(left).toContain(capped)
    expect(left).toContain(DAYS[11]) // the UTC day ends at 02:00 Rome on the next local day
    expect(row.factors.window.days).toBe(DAYS.length - left.length)
    expect(row.factors.leftOut[0].why).toMatch(/hourly feed was capped/)
  })

  it('the view: learned against painted per hour, confidence, and the marks', async () => {
    const out = await inW(() => readBidBrain({ view: 'hour-factors', market: 'IT' })) as { data: Data }
    expect(out.data).toMatchObject({ view: 'hour-factors', mode: 'on', markets: ['IT'] })
    const [p] = out.data.products
    expect(p).toMatchObject({ productId: P, market: 'IT', decidedNow: false, timeZone: 'Europe/Rome' })
    expect(p.week).toHaveLength(7)
    expect(p.week[0].day).toBe('Mon')
    expect(p.week[0].learned).toHaveLength(24)
    expect(p.week[0].confidence).toMatch(/^[HML.]{24}$/)
    const plan = p.plans[0]
    expect(plan).toMatchObject({ campaignId: 'c-it', hoursMoved: expect.any(Number) })
    const day = plan.days.find((x: Data) => x.day === ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][NOON_DAY])
    expect(day.marks[12]).toBe('#') // the Owner's lock
    expect(day.marks.slice(0, 6)).toBe('mmmmmm') // Min-bid hours stay
    expect(day.marks[10]).toBe('^') // a morning hour moves
    expect(day.applied[10]).toBe(0.7)
    expect(day.painted[3]).toBeNull()
    expect(out.data.note).toMatch(/never above the approved cell/)
    // A product asked for by id with nothing learned: why, stored nowhere.
    const none = await inW(() => readBidBrain({ view: 'hour-factors', market: 'IT', productId: 'no-such-product' }))
    expect(none).toEqual({ error: 'No product no-such-product in this business.' })
  })

  it('another business sees and learns nothing', async () => {
    const before = amz.puts.length
    await inW2(() => runShadowOnce({ now: at(NOW, 10), mode: 'live', clockNow: at(NOON, 55) }))
    expect(await factorRows(W2)).toEqual([])
    expect(amz.puts).toHaveLength(before)
    const out = await inW2(() => readBidBrain({ view: 'hour-factors', market: 'IT' })) as { data: Data }
    expect(out.data.products).toEqual([])
  })
})
