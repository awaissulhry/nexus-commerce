/**
 * ONE BRAIN AB-14 — the product cycle on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON) with every lever's REAL module, the ads mode LIVE (the real write gate judges every write) and the job queue a stub:
 * nothing leaves the process — a write is at most queued (OutboundSyncQueue), never sent to Amazon.
 *
 *   table      AdsBrainCycle: invisible to another business through Prisma and raw SQL, refused without a business,
 *              row-level security forced with the business policy and the reference guard
 *   off        NEXUS_ADS_BRAIN_CYCLE off (the default): the tick runs nothing; the state cron runs the enrolled JACKET as before
 *   skip       on: every lever's own cron leaves JACKET — the state cron, the term ledger's, negatives' and harvest's crons, the money
 *              at the bid brain's full slot — and the bid brain's full run leaves JACKET's own campaigns (it decides the
 *              pinned campaign no product owns, as before)
 *   cycle      on: one cycle for JACKET in IT, every step ended in the design's order — the state lever's shadow pauses (the
 *              Owner's long stop), the ledger, negatives, harvest, money and hours logged in shadow, the
 *              bid brain on JACKET's own campaigns only; the day's report through the ads-brain view report
 *   rerun      the same data day again: no step runs, no row of any lever and no cycle row changes
 *   sees       the state lever at PROPOSE: the next data day's cycle asks for the pauses (the real approval queue) and the
 *              bids step holds the raise on the campaign it asks to pause, in the decision's own why
 *   change set the state lever at AUTO under the live switch: the brain's pause goes through the real status path and gate,
 *              and its action-log row carries the cycle's change set and step in its evidence
 *   business   another business sees none of it
 *
 * Values are made up (public repo).
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
// The crons' run record: the work only (cron-observability's own table and the settled-window prime stay out of it).
vi.mock('../../../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (_job: string, run: () => Promise<unknown>) => run()) }))

const { runCycleTick } = await import('./cycle-run.js')
const { changeSetIdOf } = await import('./cycle.js')
const { enrollProduct, setLever, setOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { BRAIN_STATE_ACTOR } = await import('../ads-write-gate.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { settledEnd } = await import('../ads-settled-window.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { runBrainStateTick } = await import('../../../jobs/ads-brain-state.job.js')
const { runBrainTermsTick } = await import('../../../jobs/ads-brain-terms.job.js')
const { runBrainNegativesTick } = await import('../../../jobs/ads-brain-negatives.job.js')
const { runBrainHarvestTick } = await import('../../../jobs/ads-brain-harvest.job.js')
const { runBidBrainCron } = await import('../../../jobs/ads-bid-brain.job.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab14_cycle_${hex}`
const W2 = `ab14_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
type Data = Record<string, any>
const rows = async <T = Data,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const P = `${hex}-jacket`, P1 = `${hex}-jacket-m`
// The real clock: the status path stamps its own rows with it, and the bid brain reads its window from it.
const NOW = new Date()
const HOUR = 3_600_000
const DAY = 86_400_000
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR)
const dayOf = (now: Date) => settledEnd('SPONSORED_PRODUCTS', { now }).until.toISOString().slice(0, 10)
const TABLE = 'AdsBrainCycle'
/** A full slot of the bid brain's cron (:45 of a 6th UTC hour): today's 00:45. */
const FULL_SLOT = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 0, 45))

// The day as text: the pg driver reads a DATE as the reader's local midnight (this Mac runs on CEST).
const cycles = () => rows('SELECT *, to_char("dataDay", \'YYYY-MM-DD\') AS day FROM "AdsBrainCycle" WHERE "workspaceId" = $1 ORDER BY "dataDay"', [W])
const counts = async () => (await rows<Data>(`SELECT
  (SELECT count(*)::int FROM "BidBrainDecision" WHERE "workspaceId" = $1) bids,
  (SELECT count(*)::int FROM "AdsBrainStateDecision" WHERE "workspaceId" = $1) state,
  (SELECT count(*)::int FROM "AdsBrainBudgetDecision" WHERE "workspaceId" = $1) money,
  (SELECT count(*)::int FROM "AdsBrainTerm" WHERE "workspaceId" = $1) terms,
  (SELECT count(*)::int FROM "AdsBrainNegative" WHERE "workspaceId" = $1) negatives,
  (SELECT count(*)::int FROM "AdsBrainHarvest" WHERE "workspaceId" = $1) harvests,
  (SELECT count(*)::int FROM "AdsBrainHourProposal" WHERE "workspaceId" = $1) hours,
  (SELECT count(*)::int FROM "AgentApproval" WHERE "workspaceId" = $1) approvals,
  (SELECT count(*)::int FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) queued`, [W]))[0]
const report = (args: Record<string, unknown>, inside = inW) => inside(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'report', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>

async function seed(prefix = '') {
  const db = database.client
  await seedAdsFixture(db, { prefix })
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: `${prefix}${id}`, sku: `${prefix}${sku}`, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(P, `AB14-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(P1, `AB14-JACKET-M-${hex}`, { parentId: `${prefix}${P}`, amazonAsin: `B0AB14JM${H}`, totalStock: 30 })
  // c-it (the fixture's, with its keywords) and c-two advertise JACKET only; c-pin (the fixture's) no product.
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-it`, productId: `${prefix}${P1}`, asin: `B0AB14JM${H}` } })
  await db.campaign.create({ data: { id: `${prefix}c-two`, name: `${prefix}Jacket broad`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${prefix}c-two`, dailyBudget: '20.00', startDate: new Date(NOW.getTime() - 100 * DAY), liveBidWritesEnabled: true } })
  await db.adGroup.create({ data: { id: `${prefix}g-c-two`, campaignId: `${prefix}c-two`, name: 'group c-two', externalAdGroupId: `EXT-${prefix}g-c-two` } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-two`, productId: `${prefix}${P1}`, asin: `B0AB14JM${H}` } })
  // The keywords' evidence (the bid brain decides on it) and the campaigns' daily rows, reported an hour ago.
  const data: Data[] = []
  const perDay: Record<string, { clicks: number; orders: number }> = { 't-it': { clicks: 6, orders: 1 }, 't-low': { clicks: 2, orders: 0 }, 't-pin': { clicks: 3, orders: 0 } }
  for (let i = 1; i < 38; i++) {
    const date = new Date(Date.parse(`${new Date(NOW.getTime() - i * DAY).toISOString().slice(0, 10)}T00:00:00Z`))
    for (const [target, d] of Object.entries(perDay)) {
      data.push({ profileId: `${prefix}P-IT-TEST`, marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'AD_TARGET', entityId: `EXT-${prefix}${target}`, localEntityId: `${prefix}${target}`, clicks: d.clicks, costMicros: BigInt(d.clicks * 300_000), currencyCode: 'EUR', orders7d: d.orders, sales7dCents: d.orders * 8000, reportRunId: 'run-test', reportedAt: new Date(NOW.getTime() - HOUR) })
    }
    data.push({ profileId: `${prefix}P-IT-TEST`, marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'CAMPAIGN', entityId: `EXT-${prefix}c-it`, localEntityId: `${prefix}c-it`, impressions: 100, clicks: 8, costMicros: 2_400_000n, currencyCode: 'EUR', orders7d: 1, sales7dCents: 8000, reportRunId: 'run-test', reportedAt: new Date(NOW.getTime() - HOUR) })
  }
  await db.amazonAdsDailyPerformance.createMany({ data })
  await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-14 — the product cycle (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    await inW2(async () => { await seed('w2-'); await setAutonomy('AUTO', 'test') })
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: P })
    // The Owner's long stop of 10 days (a stop of 3 days or more: the state lever pauses); the jacket stays in stock, so the
    // bid brain still wants to raise its best keyword.
    const until = new Date(NOW.getTime() + 10 * DAY).toISOString().slice(0, 10)
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'a long stop', now: NOW, override: { scope: 'PRODUCT', kind: 'VALUE', key: 'longStopUntil', value: until } }))).toMatchObject({ ok: true })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const data = { productId: 'x-table-test', marketplace: 'IT', dataDay: new Date('2026-01-01T00:00:00Z'), changeSetId: 'cyc-x', status: 'DONE', steps: {} }
    const row = await inW(() => db.adsBrainCycle.create({ data }))
    expect(row).toMatchObject({ workspaceId: W, productId: 'x-table-test' })
    expect(row.dataDay.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    await inW2(async () => {
      expect(await db.adsBrainCycle.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainCycle"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainCycle" SET status = 'PARTIAL' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsBrainCycle.create({ data: { ...data, workspaceId: W } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    await expect(db.adsBrainCycle.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    // One cycle per product × market × data day.
    await expect(inW(() => db.adsBrainCycle.create({ data }))).rejects.toMatchObject({ code: 'P2002' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [TABLE])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [TABLE])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [TABLE])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "AdsBrainCycle" WHERE "productId" = \'x-table-test\'')
  })

  it('off (the default): the tick runs nothing; the state cron runs the enrolled JACKET as before', async () => {
    expect(await inW(() => runCycleTick({ now: NOW }))).toMatchObject({ ran: false, cycles: [] })
    expect(await cycles()).toEqual([])
    await inW(() => runBrainStateTick(NOW))
    expect((await rows('SELECT "campaignId", mode, action FROM "AdsBrainStateDecision" WHERE "workspaceId" = $1 ORDER BY "campaignId"', [W])).map((r) => [r.campaignId, r.mode, r.action])).toEqual([['c-it', 'SHADOW', 'pause'], ['c-two', 'SHADOW', 'pause']])
    await database.pool.query('DELETE FROM "AdsBrainStateDecision" WHERE "workspaceId" = $1', [W])
  })

  it('on: every lever\'s own cron leaves JACKET, and the bid brain\'s full run leaves its own campaigns (the pinned one no product owns still decided)', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    const before = await counts()
    await inW(() => runBrainStateTick(NOW))
    expect(await inW(() => runBrainTermsTick(NOW))).toMatchObject({ ran: false, why: expect.stringMatching(/the product cycle runs it/) })
    expect(await inW(() => runBrainNegativesTick(NOW))).toMatchObject({ ran: false })
    expect(await inW(() => runBrainHarvestTick(NOW))).toMatchObject({ ran: false, why: expect.stringMatching(/the product cycle runs it/) })
    await inW(() => runBidBrainCron(FULL_SLOT))
    const after = await counts()
    expect({ ...after, bids: 0 }).toEqual({ ...before, bids: 0 })
    expect((await rows('SELECT DISTINCT "campaignId" FROM "BidBrainDecision" WHERE "workspaceId" = $1 ORDER BY 1', [W])).map((r) => r.campaignId)).toEqual(['c-pin'])
    await database.pool.query('DELETE FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])
  })

  it('the cycle: every step of JACKET in IT in the design\'s order, the bid brain on its own campaigns only; the day\'s report through the view', async () => {
    const r = await inW(() => runCycleTick({ now: NOW }))
    const day = dayOf(NOW)
    expect(r).toMatchObject({ ran: true, dataDay: day, left: [] })
    expect(r.cycles).toHaveLength(1)
    const [row] = await cycles()
    expect(row).toMatchObject({ productId: P, marketplace: 'IT', changeSetId: changeSetIdOf(P, 'IT', day), status: 'DONE', attempts: 1, leaseUntil: null })
    const status = Object.fromEntries(Object.entries(row.steps as Data).map(([k, v]) => [k, (v as Data).status]))
    expect(status).toMatchObject({ state: 'done', money: 'done', bids: 'done' })
    for (const s of ['terms', 'negatives', 'harvest', 'hours']) expect(['done', 'skipped'], s).toContain(status[s])
    expect(row.steps.state.why).toMatch(/^OBSERVE: pause 2/)
    expect(row.steps.harvest.acts).toBe(false)
    // The bid brain decided JACKET's own campaigns only, in the cycle's bids run.
    expect((await rows('SELECT DISTINCT "campaignId", "runId" FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])).map((x) => [x.campaignId, x.runId])).toEqual([['c-it', row.steps.bids.runId]])
    expect((await rows('SELECT "campaignId", outcome FROM "AdsBrainStateDecision" WHERE "workspaceId" = $1 ORDER BY "campaignId"', [W])).map((x) => [x.campaignId, x.outcome])).toEqual([['c-it', 'shadow'], ['c-two', 'shadow']])
    expect((await counts()).money).toBe(1)
    expect((await counts()).queued).toBe(0)
    // The report.
    expect(row.report).toMatchObject({ v: 1, productId: P, name: 'Jacket', market: 'IT', dataDay: day, status: 'DONE', changeSetId: changeSetIdOf(P, 'IT', day) })
    expect(row.report.levers.map((l: Data) => l.step)).toEqual(['state', 'terms', 'negatives', 'harvest', 'structure', 'money', 'bids', 'hours'])
    expect(row.report.money.inOut.week).toMatchObject({ spendCents: expect.any(Number), salesCents: expect.any(Number) })
    expect(row.summary).toMatch(/^Jacket in IT, data day /)
    expect(row.summary).not.toMatch(/€/)
    const view = await report({ market: 'IT', productId: P1 })
    expect(view.data).toMatchObject({ view: 'report', switch: 'on', scope: { productId: P, market: 'IT' }, status: 'DONE', summary: row.summary })
  })

  it('a rerun on the same data day: no step runs, no row of any lever and no cycle row changes (the hourly state pass decided nothing new)', async () => {
    const before = { counts: await counts(), cycles: await cycles(), terms: await rows('SELECT * FROM "AdsBrainTerm" WHERE "workspaceId" = $1 ORDER BY id', [W]) }
    const r = await inW(() => runCycleTick({ now: later(1) }))
    expect(r.cycles).toEqual([])
    expect(r.statePasses).toEqual([{ productId: P, market: 'IT', status: 'done', stored: false }])
    expect(await counts()).toEqual(before.counts)
    expect(await cycles()).toEqual(before.cycles)
    expect(await rows('SELECT * FROM "AdsBrainTerm" WHERE "workspaceId" = $1 ORDER BY id', [W])).toEqual(before.terms)
  })

  it('each step sees the steps before it: the state lever at PROPOSE asks for the pauses, and the bids hold the raise on the campaign it asks to pause', async () => {
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'state', level: 'PROPOSE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    const at = later(24)
    const r = await inW(() => runCycleTick({ now: at, startHourUtc: 0 }))
    expect(r.cycles.map((c) => [c.productId, c.status])).toEqual([[P, 'DONE']])
    const row = (await cycles()).at(-1)!
    expect(row.day).toBe(dayOf(at))
    expect(row.steps.state).toMatchObject({ status: 'done', acts: true })
    expect(row.steps.state.holds.map((x: [string, string]) => x[0]).sort()).toEqual(['c-it', 'c-two'])
    const approvals = await rows('SELECT id, "toolName", status FROM "AgentApproval" WHERE "workspaceId" = $1', [W])
    expect(approvals).toEqual([expect.objectContaining({ toolName: 'pause-ads', status: 'pending' })])
    expect(row.report.waitsForOwner).toEqual([expect.objectContaining({ approvalId: approvals[0].id }), expect.objectContaining({ approvalId: approvals[0].id })])
    // The bid brain's decision on the keyword it would raise names the hold.
    const held = await rows('SELECT "targetId", action, why FROM "BidBrainDecision" WHERE "workspaceId" = $1 AND "runId" = $2 AND "targetId" = \'t-it\'', [W, row.steps.bids.runId])
    expect(held).toEqual([expect.objectContaining({ action: 'hold', why: expect.stringMatching(/raise held — the product cycle's stops and state step: it pauses Italy exact \(asked\)/) })])
    expect((await counts()).queued).toBe(0)
  })

  it('one change set: at AUTO under the live switch the brain\'s pause goes through the real gate, and its action-log row carries the cycle\'s change set', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    forgetLeverOwners()
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'state', level: 'AUTO', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    const at = later(48)
    await inW(() => runCycleTick({ now: at, startHourUtc: 0 }))
    const row = (await cycles()).at(-1)!
    const id = changeSetIdOf(P, 'IT', dayOf(at))
    expect(row).toMatchObject({ changeSetId: id, status: 'DONE' })
    const logs = await rows('SELECT "entityId", "userId", "actionType", evidence FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "userId" = $2 ORDER BY "entityId"', [W, BRAIN_STATE_ACTOR])
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) expect(l, l.entityId).toMatchObject({ actionType: 'AD_ENTITY_STATE_UPDATE', evidence: { cycle: { changeSetId: id, step: 'state' } } })
    expect(logs.map((l) => l.entityId)).toContain('c-it')
    expect((await counts()).queued).toBe(logs.length)
  })

  it('another business sees none of it', async () => {
    expect(await inW2(() => database.client.adsBrainCycle.findMany())).toEqual([])
    expect(await rows('SELECT id FROM "AdsBrainCycle" WHERE "workspaceId" = $1', [W2])).toEqual([])
    expect((await report({ market: 'IT' }, inW2)).data).toMatchObject({ products: [] })
    expect(await rows('SELECT id FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W2])).toEqual([])
  })
})
