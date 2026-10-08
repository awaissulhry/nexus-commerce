/**
 * ONE BRAIN AB-13 — the brain's hourly research, painting and proposal on a real PostgreSQL (the throwaway PostgreSQL 17
 * of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business
 * profiles ON). Nothing here reaches Amazon: the plan is saved in Nexus only, and only by an approval.
 *
 *   table     AdsBrainHourProposal: invisible to another business through Prisma and raw SQL, refused without a business,
 *             row-level security forced with the business policy and the reference guard
 *   no-op     nothing enrolled: the run reads no hours, stores nothing, asks nothing; the plan stays as it is
 *   shadow    enrolled, hours lever OBSERVE (the default): researched from the stored Marketing Stream hours and the daily
 *             reports, painted (Min bid where conversion is near zero and the spend real), stored as SHADOW — no approval,
 *             no plan version; a second run the same day is not due
 *   propose   hours lever PROPOSE, one hour locked by the Owner: a PROPOSED row and ONE approval request whose card holds
 *             the research summary, the before / after grid, the expected effect and the locked hour; the plan unchanged
 *   reject    a person rejects it: the plan stays exactly as it was, the row says REJECTED, the view says so
 *   approve   a person approves the next one: the plan's week is the painted one (the locked hour kept), a new version
 *             written as that person, the row APPLIED with that version, the change recorded for undo (set-hourly-bid-plan
 *             paints the old week back); the next research paints nothing more (NO_CHANGE)
 *   stale     the Owner edits the plan after the painting: the approval does not run and his edit stays
 *   view      ads-brain view hours: status, research in words, grid, money hidden without ad-spend money
 *   another   another business sees and runs nothing of it
 *
 * Values are made up (public repo): a jacket at 80.00, clicks at 0.40, round counts.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
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

const { runHoursOnce, HOURS_TOOL } = await import('./hours-proposal.js')
const { enrollProduct, setLever, setOverride } = await import('./enrollment.js')
const { decideApproval } = await import('../../agents/approval-gate.service.js')
const { saveRankScheduleGroup } = await import('../ads-create.service.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { HOURLY_PLAN_UNDO } = await import('../../agents/tools/ads-hourly-plan.tools.js')
const { getTool } = await import('../../agents/tool-registry.js')
const { visibleTo } = await import('../../agents/call-tool.js')
const { weekOf } = await import('./hours-paint.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab13_hours_${hex}`
const W2 = `ab13_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const P = id('p'), P1 = id('p1'), Q = id('q'), Q1 = id('q1')
const PLAN_NAME = `Test jacket IT ${hex}`
const NOW = new Date('2026-10-08T04:50:00Z') // a Thursday; the research reads 2026-09-10 … 2026-10-07 (Rome)
const TABLE = 'AdsBrainHourProposal'
const EVERY = [0, 1, 2, 3, 4, 5, 6]
const PLAN_WINDOWS = [{ days: EVERY, startHour: 16, endHour: 22, targetKey: 'own-top' }, { days: EVERY, startHour: 0, endHour: 6, targetKey: 'defend-top' }]

type Data = Record<string, any>
const person = (userId: string, opts: { money?: boolean } = {}) => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via: 'app' as const, workspace: scope(W),
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS).filter((f) => opts.money !== false || !String(f).startsWith('financials.'))]) },
})
const view = (args: Record<string, unknown>) => inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'hours', market: 'IT', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>

const planRow = async () => (await rows<{ id: string; windows: unknown; defaultTargetKey: string | null }>('SELECT id, windows, "defaultTargetKey" FROM "RankScheduleGroup" WHERE "workspaceId" = $1 AND name = $2', [W, PLAN_NAME]))[0]
const versions = async () => rows<{ id: string; changedBy: string | null }>('SELECT v.id, v."changedBy" FROM "RankScheduleVersion" v JOIN "RankScheduleGroup" g ON g.id = v."groupId" WHERE v."workspaceId" = $1 AND g.name = $2 ORDER BY v."createdAt" DESC', [W, PLAN_NAME])
const proposals = async () => rows<Data>('SELECT * FROM "AdsBrainHourProposal" WHERE "workspaceId" = $1 ORDER BY "createdAt" ASC', [W])
const approvals = async () => rows<Data>('SELECT id, status, "toolName", preview, args, reason FROM "AgentApproval" WHERE "workspaceId" = $1 AND "toolName" = $2 ORDER BY "requestedAt" ASC', [W, HOURS_TOOL])
const amazonRows = async () => (await rows<{ n: number }>(
  'SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdvertisingActionLog" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n

/** The local days of the research (Rome is UTC+2 throughout it). */
const DAYS = Array.from({ length: 28 }, (_, i) => new Date(Date.parse('2026-09-10T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10))
const evening = (h: number) => h >= 16 && h < 20
const night = (h: number) => h < 4

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(P, `AB13-JACKET-${hex}`, { isParent: true, name: 'Test jacket' })
  await product(P1, `AB13-JACKET-M-${hex}`, { parentId: P, amazonAsin: `B0AB13JM${H}` })
  await product(Q, `AB13-GLOVE-${hex}`, { isParent: true })
  await product(Q1, `AB13-GLOVE-L-${hex}`, { parentId: Q, amazonAsin: `B0AB13GL${H}` })
  const campaign = async (key: string, productId: string, asin: string) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} campaign`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
  }
  await campaign('a', P1, `B0AB13JM${H}`)
  await campaign('b', P1, `B0AB13JM${H}`)
  await campaign('q', Q1, `B0AB13GL${H}`)
  // The market's goal: ACoS 25 %, band 20–30 %.
  await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 25, targetLoPct: 20, targetHiPct: 30, goal: 'PROFIT', updatedBy: 'user:test' } })
  // The library: rest of search, defend top, own top, Min bid.
  await db.rankTarget.create({ data: { key: 'rest-of-search', name: 'Rest of Search', placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 0 } })
  await db.rankTarget.create({ data: { key: 'defend-top', name: 'Defend Top', placement: 'PLACEMENT_TOP', biasPct: 50 } })
  await db.rankTarget.create({ data: { key: 'own-top', name: 'Own Top of Search', placement: 'PLACEMENT_TOP', biasPct: 100 } })
  await db.rankTarget.create({ data: { key: 'pause', name: 'Min bid', pause: true } })
  // The Owner's hourly plan over the jacket's two campaigns, switched on (his own save, as the page saves it).
  await saveRankScheduleGroup({ name: PLAN_NAME, marketplace: 'IT', timezone: 'Europe/Rome', windows: PLAN_WINDOWS as never, defaultTargetKey: 'rest-of-search', targetOverrides: {}, enabled: true, campaignIds: [C('a'), C('b')], userId: 'user:owner' })
  // Marketing Stream hours (campaign grain, 1-day conversions): 30 clicks an hour on each jacket campaign, 100 on the glove's;
  // evenings convert 4 %, nights never (real spend, no order), the rest 1.5 %. Clicks at 0.40.
  const hourly: Data[] = []
  const daily: Data[] = []
  for (const [key, perHour] of [['a', 30], ['b', 30], ['q', 100]] as const) {
    // Each hour of the day carries its own remainder, so every hour converts at its own rate over the weeks.
    const carry = Array.from({ length: 24 }, (_, h) => (h * 7 % 24) / 24)
    for (const day of DAYS) {
      let dayOrders = 0
      for (let h = 0; h < 24; h++) {
        const cr = night(h) ? 0 : evening(h) ? 0.04 : 0.015
        carry[h] += perHour * cr
        const orders = Math.floor(carry[h] + 1e-9)
        carry[h] -= orders
        dayOrders += orders
        const utc = new Date(Date.parse(`${day}T00:00:00Z`) + (h - 2) * 3_600_000) // Rome = UTC+2
        hourly.push({
          profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${utc.toISOString().slice(0, 10)}T00:00:00Z`), hour: utc.getUTCHours(),
          entityType: 'CAMPAIGN', entityId: `EXT-${C(key)}`, localEntityId: C(key), impressions: perHour * 40, clicks: perHour, costMicros: BigInt(perHour * 400_000),
          currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000, reportedAt: NOW,
        })
      }
      // The daily report (7-day attribution) of the same day: about 30 % more orders than the 1-day hours, as attribution adds.
      const orders7 = Math.round(dayOrders * 1.3)
      daily.push({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${day}T00:00:00Z`), entityType: 'CAMPAIGN', entityId: `EXT-${C(key)}`,
        localEntityId: C(key), impressions: perHour * 24 * 40, clicks: perHour * 24, costMicros: BigInt(perHour * 24 * 400_000), currencyCode: 'EUR',
        orders7d: orders7, sales7dCents: orders7 * 8000, reportedAt: NOW,
      })
    }
  }
  await db.amazonAdsHourlyPerformance.createMany({ data: hourly as never })
  await db.amazonAdsDailyPerformance.createMany({ data: daily as never })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-13 — the brain\'s hourly research, painting and proposal (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const row = await inW(() => db.adsBrainHourProposal.create({ data: { productId: 'x-table-test', marketplace: 'IT', level: 'OBSERVE', status: 'SHADOW', why: 'test', research: {} } }))
    expect(row).toMatchObject({ workspaceId: W, status: 'SHADOW' })
    await inW2(async () => {
      expect(await db.adsBrainHourProposal.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainHourProposal"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainHourProposal" SET status = 'APPLIED' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsBrainHourProposal.create({ data: { workspaceId: W, productId: 'x', marketplace: 'IT', level: 'OBSERVE', status: 'SHADOW', why: 'x', research: {} } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    await expect(db.adsBrainHourProposal.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [TABLE])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [TABLE])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [TABLE])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "AdsBrainHourProposal" WHERE "productId" = \'x-table-test\'')
  })

  it('no-op: nothing enrolled — no research stored, nothing asked, the plan as it was', async () => {
    const before = await planRow()
    expect(await inW(() => runHoursOnce({ now: NOW }))).toMatchObject({ ran: false, why: expect.stringMatching(/no product is enrolled/) })
    expect(await proposals()).toEqual([])
    expect(await approvals()).toEqual([])
    expect(await planRow()).toEqual(before)
  })

  it('shadow: enrolled at OBSERVE — researched and painted (Min bid at night), stored, nothing asked or written; not due again the same day', async () => {
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: P })
    const versionsBefore = (await versions()).length
    expect(await inW(() => runHoursOnce({ now: NOW }))).toMatchObject({ ran: true, products: 1, shadow: 1, proposed: 0 })
    const [row] = await proposals()
    expect(row).toMatchObject({ productId: P, marketplace: 'IT', status: 'SHADOW', level: 'OBSERVE', approvalId: null })
    expect(row.why).toMatch(/Shadow \(the hours lever is OBSERVE\): the brain would paint 28 hours/)
    // The research: four weeks of hours, its words, the night that never converts.
    expect(row.research.window).toMatchObject({ days: 28, from: '2026-09-10', to: '2026-10-07' })
    expect(row.research.sources.campaignGrainHours).toBe(28 * 24 * 3)
    expect(row.research.summary.join('\n')).toMatch(/Research of "Test jacket" in IT: 28 days/)
    expect(row.research.blocks.filter((b: Data) => b.part === 0).every((b: Data) => b.crIndex < 0.2)).toBe(true)
    expect(row.research.confidence).toMatchObject({ label: 'high', thin: false })
    // The painting: 00–04 of every day to Min bid, from defend top.
    expect(row.paint.changes).toHaveLength(28)
    expect(new Set(row.paint.changes.map((c: Data) => `${c.from}>${c.to}`))).toEqual(new Set(['defend-top>pause']))
    expect(row.paint.changes.every((c: Data) => c.h < 4)).toBe(true)
    expect(row.paint.effect.delta.spendCents.hi).toBeLessThan(0)
    expect(await approvals()).toEqual([])
    expect((await versions()).length).toBe(versionsBefore)
    expect((await planRow()).windows).toEqual(PLAN_WINDOWS)
    expect(await amazonRows()).toBe(0)
    expect(await inW(() => runHoursOnce({ now: new Date(NOW.getTime() + 3_600_000) }))).toMatchObject({ ran: true, notDue: 1, stored: 0 })
  })

  let firstApproval = ''
  it('propose: PROPOSE with one hour locked — ONE request carrying the research, the grid, the effect and the lock; the plan unchanged', async () => {
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'hours', level: 'PROPOSE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'Wednesday night stays mine', now: NOW, override: { scope: 'PRODUCT', kind: 'LOCK', key: 'hours', ref: 'hourCell:d3h1' } }))).toMatchObject({ ok: true })
    expect(await inW(() => runHoursOnce({ now: NOW, force: true }))).toMatchObject({ ran: true, proposed: 1 })
    const all = await proposals()
    const row = all[all.length - 1]
    expect(row).toMatchObject({ status: 'PROPOSED', level: 'PROPOSE' })
    expect(row.paint.changes).toHaveLength(27)
    expect(row.paint.locked).toEqual(['d3h1'])
    const [ap] = await approvals()
    expect(ap).toMatchObject({ id: row.approvalId, status: 'pending', toolName: HOURS_TOOL, args: { planId: row.planId } })
    firstApproval = ap.id
    const p = ap.preview
    expect(p.summary).toMatch(new RegExp(`Saves the week the brain painted for the hourly plan "${PLAN_NAME}" \\(IT, 2 campaigns\\) as a new version: 27 hours of the week change`))
    expect(p.research.summary.join('\n')).toMatch(/leans on/)
    expect(p.grid.days[2]).toMatchObject({ day: 'Wed', marks: `^#^^${' '.repeat(20)}` })
    expect(p.expected.effect.delta.spendCents.mid).toBeLessThan(0)
    expect(p.locked).toEqual(['d3h1'])
    expect(p.reach).toEqual({ reach: 'sandbox' })
    expect((await planRow()).windows).toEqual(PLAN_WINDOWS)
    // The brain's request is the only one: asking again by hand is refused while it waits.
    const again = await inW(() => getTool(HOURS_TOOL)!.handler({ planId: row.planId }, { can: () => true, via: 'claude' } as never))
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/already waits for a person/) })
    // Batch 2 review fix — the saved plan reaches Amazon through the hourly bid engine: the tool says so (openWorld), as
    // set-hourly-bid-plan does, and always waits for a person.
    expect(getTool(HOURS_TOOL)).toMatchObject({ openWorld: true, alwaysAsk: true, maxClaudeTrust: 'ask' })
    expect(getTool('set-hourly-bid-plan')!.openWorld).toBe(true)
  })

  it('reject: the plan stays exactly as it was; the row and the view say REJECTED', async () => {
    const before = await planRow()
    const versionsBefore = (await versions()).length
    expect(await inW(() => decideApproval(firstApproval, 'reject', person('owner-1') as never, 'not this week'))).toMatchObject({ ok: true, status: 'rejected' })
    expect(await planRow()).toEqual(before)
    expect((await versions()).length).toBe(versionsBefore)
    expect((await view({ productId: P })).data).toMatchObject({ status: 'REJECTED', approval: { status: 'rejected' } })
    // The next tick (not due yet) takes the outcome over.
    expect(await inW(() => runHoursOnce({ now: new Date(NOW.getTime() + 2 * 3_600_000) }))).toMatchObject({ synced: 1, notDue: 1 })
    expect((await proposals()).at(-1)).toMatchObject({ status: 'REJECTED', decidedBy: 'Person owner-1' })
  })

  it('approve: the painted week saved as a new version, as the person who approved it; recorded for undo; the next research paints nothing more', async () => {
    expect(await inW(() => runHoursOnce({ now: NOW, force: true }))).toMatchObject({ proposed: 1 })
    const row = (await proposals()).at(-1)!
    const versionsBefore = await versions()
    const out = await inW(() => decideApproval(row.approvalId, 'approve', person('owner-2') as never))
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    const plan = await planRow()
    const week = weekOf({ windows: plan.windows, defaultTargetKey: plan.defaultTargetKey })
    for (const d of EVERY) {
      expect(week[d].slice(0, 4)).toEqual(d === 3 ? ['pause', 'defend-top', 'pause', 'pause'] : ['pause', 'pause', 'pause', 'pause'])
      expect(week[d].slice(4, 6)).toEqual(['defend-top', 'defend-top'])
      expect(week[d].slice(16, 22)).toEqual(Array(6).fill('own-top'))
      expect(week[d][12]).toBe('rest-of-search')
    }
    const now = await versions()
    expect(now.length).toBe(versionsBefore.length + 1)
    expect(now[0].changedBy).toBe('user:owner-2')
    expect((await proposals()).at(-1)).toMatchObject({ status: 'APPLIED', versionId: now[0].id, decidedBy: 'user:owner-2' })
    // The members' schedules (what the engines run) carry the painted week too.
    const schedules = await rows<{ windows: unknown }>('SELECT windows FROM "AdSchedule" WHERE "workspaceId" = $1 AND "campaignId" = ANY($2)', [W, [C('a'), C('b')]])
    expect(schedules.map((s) => s.windows)).toEqual([plan.windows, plan.windows])
    // Recorded as a change: undo asks set-hourly-bid-plan to paint the week it replaced back.
    const [change] = await rows<Data>('SELECT "toolName", before, after FROM "AgentChange" WHERE "workspaceId" = $1 AND "approvalId" = $2', [W, row.approvalId])
    expect(change).toMatchObject({ toolName: HOURS_TOOL, before: { op: 'update-windows', windows: PLAN_WINDOWS }, after: { op: 'update-windows', versionId: now[0].id } })
    const undo = HOURLY_PLAN_UNDO.request({ before: change.before, after: change.after })
    expect(undo).toMatchObject({ tool: 'set-hourly-bid-plan', args: { op: 'update-windows', planId: plan.id, defaultTargetKey: 'rest-of-search' } })
    expect(getTool('set-hourly-bid-plan')!.input.safeParse((undo as Data).args).success).toBe(true)
    expect(await amazonRows()).toBe(0)
    // A week on, the brain researches the plan it painted: nothing more to paint.
    expect(await inW(() => runHoursOnce({ now: NOW, force: true }))).toMatchObject({ noChange: 1 })
    expect((await proposals()).at(-1)).toMatchObject({ status: 'NO_CHANGE' })
  })

  it('stale: the Owner edits the plan after the painting — the approval does not run and his edit stays', async () => {
    // Back to his original week, then a fresh proposal, then his own edit before anyone approves it.
    const plan = await planRow()
    await inW(() => saveRankScheduleGroup({ id: plan.id, name: PLAN_NAME, marketplace: 'IT', timezone: 'Europe/Rome', windows: PLAN_WINDOWS as never, defaultTargetKey: 'rest-of-search', targetOverrides: {}, enabled: true, campaignIds: [C('a'), C('b')], userId: 'user:owner' }))
    expect(await inW(() => runHoursOnce({ now: NOW, force: true }))).toMatchObject({ proposed: 1 })
    const row = (await proposals()).at(-1)!
    const edited = [...PLAN_WINDOWS, { days: [6], startHour: 10, endHour: 12, targetKey: 'own-top' }]
    await inW(() => saveRankScheduleGroup({ id: plan.id, name: PLAN_NAME, marketplace: 'IT', timezone: 'Europe/Rome', windows: edited as never, defaultTargetKey: 'rest-of-search', targetOverrides: {}, enabled: true, campaignIds: [C('a'), C('b')], userId: 'user:owner' }))
    const out = await inW(() => decideApproval(row.approvalId, 'approve', person('owner-2') as never))
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/changed after the brain painted it/) })
    expect((await planRow()).windows).toEqual(edited)
    expect((await proposals()).at(-1)).toMatchObject({ status: 'PROPOSED' })
  })

  it('the view: status, the research in words, the grid; money hidden without ad-spend money', async () => {
    const out = await view({ productId: P1 }) // a variation names its parent
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(d).toMatchObject({ view: 'hours', productId: P, market: 'IT', status: 'PROPOSED', plan: { name: PLAN_NAME, on: true, members: 2 }, hoursLever: { level: 'PROPOSE' }, decidedNow: false })
    expect(d.research.summary[0]).toMatch(/Research of "Test jacket" in IT/)
    expect(d.painted.grid.days).toHaveLength(7)
    expect(d.painted.changes.length).toBeGreaterThan(0)
    expect(d.research.money.lines.join('\n')).toMatch(/spend \d+\.\d{2}/)
    expect(d.history.length).toBeGreaterThan(0)
    const hidden = visibleTo(person('reader', { money: false }) as never, ADS_BRAIN_TOOLS[0], d) as Data
    expect(hidden.research.money).toBeUndefined()
    expect(hidden.painted.money).toBeUndefined()
    expect(hidden.research.summary.length).toBe(d.research.summary.length)
    expect(JSON.stringify(hidden)).not.toMatch(/"(spendCents|salesCents|acos|cpcCents)"/)
    expect(JSON.stringify(hidden)).not.toMatch(/ACoS \d|expected ACoS/)
    expect(hidden.painted.changes[0]).toEqual({ cell: expect.any(String), d: expect.any(Number), h: expect.any(Number), from: expect.any(String), to: expect.any(String) })
  })

  it('another business: sees nothing of it and runs nothing', async () => {
    expect(await inW2(() => runHoursOnce({ now: NOW }))).toMatchObject({ ran: false })
    const other = await inW2(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'hours', market: 'IT', productId: P }, {} as never)) as { ok: boolean; error?: string }
    expect(other).toMatchObject({ ok: false, error: expect.stringMatching(/was not found in this business/) })
    expect(await inW2(() => database.client.adsBrainHourProposal.findMany())).toEqual([])
  })
})
