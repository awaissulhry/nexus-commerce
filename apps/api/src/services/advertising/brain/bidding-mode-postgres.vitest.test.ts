/**
 * ONE BRAIN AB-17 — the bidding-strategy lever on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles ON),
 * the server switch `live`, the ads mode LIVE (the real write gate judges every write) and the job queue a stub: nothing
 * leaves the process — a write is at most queued (OutboundSyncQueue), never sent to Amazon.
 *
 *   tables    AdsBrainStrategyDecision, AdsBrainStrategyTest, AdsBrainLeverClock: invisible to another business, refused
 *             without one, row-level security forced with the business policy and the reference guard
 *   no-op     nothing enrolled: nothing decided, nothing written, no clock
 *   OBSERVE   the JACKET family: each up-and-down campaign of a thin product logged as a SHADOW switch to down only; the one a
 *             stop floors held; nothing asked, nothing queued, no test, no clock
 *   person    a person's own strategy (his edit) on a campaign the bid brain runs is a STRATEGY hold: the brain leaves it
 *   N4        the lever at AUTO, its clock just started: the switch is ASKED through the real approval queue (set-campaign-
 *             settings as "Nexus ads brain"), a test opened, nothing queued; a rerun asks nothing again
 *   approved  the person's approval runs it as him through the tool's own write: switched, and — the brain's own request —
 *             no STRATEGY hold on the bid brain's campaign; the next run starts the switchback test from when it landed
 *   AUTO      the clock older than the approval days: the brain's switch through the real campaign path and gate (one
 *             queued write as the brain, its evidence layer), a test opened; a rerun writes nothing
 *   gate      the brain's strategy writer refused where a stop holds the campaign, on a campaign no brain owns, and under the
 *             Owner's lock (in his words; the decision holds it and ends its test)
 *   verdict   20 days on with worse figures after the switch than before: switched back as the brain (layer switchback), the
 *             test REVERTED with its windows and figures; the next run does not try the same switch again (no flip-flop)
 *   cycle     the product cycle's step: a campaign the state step pauses is a stop, held; its lines and counts
 *   business  another business with nothing enrolled decides nothing and sees none of these rows
 *   view      the ads-brain view bidding: each campaign decided now beside what was logged, the tests, the N4 clock; the
 *             market's tests; nothing stored
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
// The app's client as db.ts builds it: an inDatabaseTransaction's statements run on its transaction (all or nothing).
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

const { runBiddingModeOnce, writeAsTheBrain, STRATEGY_REQUESTER } = await import('./bidding-mode-run.js')
const { modeWatchProducts } = await import('./bidding-mode-load.js')
const { biddingStep } = await import('./cycle-steps.js')
const { enrollProduct, setLever, setOverride, endOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { BRAIN_STRATEGY_ACTOR } = await import('../ads-write-gate.js')
const { BRAIN_STRATEGY_AGENT_KEY } = await import('../bid-brain/brain-holds.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
const { decideApproval } = await import('../../agents/approval-gate.service.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab17_mode_${hex}`
const W2 = `ab17_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const P = `${hex}-jacket`, P1 = `${hex}-jacket-m`, R = `${hex}-gloves`, R1 = `${hex}-gloves-m`
// The real clock: the campaign path stamps its own rows with it, and the lever reads them against `now`.
const NOW = new Date()
const DAY = 86_400_000
const later = (days: number) => new Date(NOW.getTime() + days * DAY)
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const TABLES = ['AdsBrainStrategyDecision', 'AdsBrainStrategyTest', 'AdsBrainLeverClock']

type Data = Record<string, any>
const person = (userId: string) => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via: 'app' as const, workspace: scope(W),
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const decisions = () => rows<Data>('SELECT * FROM "AdsBrainStrategyDecision" WHERE "workspaceId" = $1 ORDER BY "createdAt", "campaignId", id', [W])
const tests = () => rows<Data>('SELECT * FROM "AdsBrainStrategyTest" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W])
const queued = () => rows<Data>('SELECT payload->>\'entityId\' AS "entityId", payload FROM "OutboundSyncQueue" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W])
const strategyOf = async (id: string) => (await rows<{ s: string }>('SELECT "biddingStrategy"::text AS s FROM "Campaign" WHERE id = $1', [id]))[0].s
const approvals = () => rows<Data>('SELECT a.id, a."toolName", a.status, a.args, r."agentKey", r."entityId" FROM "AgentApproval" a JOIN "AgentRun" r ON r.id = a."agentRunId" WHERE a."workspaceId" = $1 ORDER BY a."requestedAt"', [W])
const strategyHolds = () => rows<Data>('SELECT "campaignId", by FROM "BidHold" WHERE "workspaceId" = $1 AND kind = \'STRATEGY\' AND "endedAt" IS NULL ORDER BY "campaignId"', [W])
const run = (opts: Record<string, unknown> = {}) => inW(() => runBiddingModeOnce({ now: NOW, weekly: true, ...opts }))
const byCampaign = (r: { campaigns: Array<Data> }) => Object.fromEntries(r.campaigns.map((c) => [c.campaignId, c]))
const view = (args: Record<string, unknown>) => inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'bidding', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>

async function seed(prefix = '') {
  const db = database.client
  await seedAdsFixture(db, { prefix })
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: `${prefix}${id}`, sku: `${prefix}${sku}`, name: sku, basePrice: '80.00', totalStock: 20, ...extra } })
  await product(P, `AB17-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(P1, `AB17-JACKET-M-${hex}`, { parentId: `${prefix}${P}`, amazonAsin: `B0AB17JM${H}` })
  await product(R, `AB17-GLOVES-${hex}`, { isParent: true, name: 'Gloves' })
  await product(R1, `AB17-GLOVES-M-${hex}`, { parentId: `${prefix}${R}`, amazonAsin: `B0AB17GM${H}` })
  const campaign = async (key: string, name: string, ad: [string, string], extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: `${prefix}${key}`, name: `${prefix}${name}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${prefix}${key}`, dailyBudget: '20.00', startDate: new Date(NOW.getTime() - 100 * DAY), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: `${prefix}g-${key}`, campaignId: `${prefix}${key}`, name: `group ${key}`, externalAdGroupId: `EXT-${prefix}g-${key}` } })
    await db.adProductAd.create({ data: { adGroupId: `${prefix}g-${key}`, productId: `${prefix}${ad[0]}`, asin: ad[1] } })
    await db.adTarget.create({ data: { id: `${prefix}t-${key}`, adGroupId: `${prefix}g-${key}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `jacket ${key}`, bidCents: 40, externalTargetId: `EXT-${prefix}t-${key}` } })
  }
  const jacket: [string, string] = [P1, `B0AB17JM${H}`]
  // c-it (the fixture's: a stop floors its keyword t-sup) now advertises JACKET too, on up and down.
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-it`, productId: `${prefix}${P1}`, asin: `B0AB17JM${H}` } })
  await db.campaign.update({ where: { id: `${prefix}c-it` }, data: { biddingStrategy: 'AUTO_FOR_SALES' } })
  await campaign('c-up', 'Jacket up', jacket, { biddingStrategy: 'AUTO_FOR_SALES' })
  await campaign('c-auto', 'Jacket auto', jacket, { biddingStrategy: 'LEGACY_FOR_SALES' })
  await campaign('c-person', 'Jacket person', jacket, { biddingStrategy: 'AUTO_FOR_SALES' })
  await campaign('c-other', 'Gloves exact', [R1, `B0AB17GM${H}`], { biddingStrategy: 'AUTO_FOR_SALES' })
  // The bid brain runs c-up and c-person LIVE (AB-2: a person's own strategy there becomes a STRATEGY hold).
  for (const key of ['c-up', 'c-person']) await db.bidBrainEnrollment.create({ data: { campaignId: `${prefix}${key}`, marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner' } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-17 — the bidding-strategy lever (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    await inW2(async () => { await seed('w2-'); await setAutonomy('AUTO', 'test') })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the tables: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client as any
    const data = {
      AdsBrainStrategyDecision: { runId: 'x', mode: 'SHADOW', kind: 'change', productId: 'x-table-test', marketplace: 'IT', campaignId: 'c-x', level: 'OBSERVE', action: 'keep', outcome: 'none', rule: 'none', decisionHash: 'h', decision: {}, why: 'w' },
      AdsBrainStrategyTest: { productId: 'x-table-test', marketplace: 'IT', campaignId: 'c-x', fromStrategy: 'AUTO_FOR_SALES', toStrategy: 'LEGACY_FOR_SALES', rule: 'thin', level: 'AUTO', status: 'ENDED', why: 'w' },
      AdsBrainLeverClock: { productId: 'x-table-test', marketplace: 'IT', lever: 'biddingStrategy', since: NOW, by: 'user:owner', seenAt: NOW },
    } as const
    for (const table of TABLES) {
      const model = table.charAt(0).toLowerCase() + table.slice(1)
      const row = await inW(() => db[model].create({ data: (data as Data)[table] }))
      expect(row, table).toMatchObject({ workspaceId: W, productId: 'x-table-test' })
      await inW2(async () => {
        expect(await db[model].findMany(), table).toEqual([])
        expect(await db.$queryRawUnsafe(`SELECT id FROM "${table}"`), table).toEqual([])
        await expect(db[model].create({ data: { ...(data as Data)[table], workspaceId: W } }), table).rejects.toMatchObject({ code: 'workspace_mismatch' })
      })
      await expect(db[model].findMany(), table).rejects.toMatchObject({ code: 'workspace_required' })
      expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [table]), table).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
      expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [table]), table).toEqual([{ policyname: 'nexus_workspace_isolation' }])
      expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [table]), table).toEqual([{ tgname: 'nexus_workspace_references' }])
      await database.pool.query(`DELETE FROM "${table}" WHERE "productId" = 'x-table-test'`)
    }
  })

  it('no-op: nothing enrolled — nothing decided, nothing written, no clock', async () => {
    expect(await inW(() => modeWatchProducts())).toEqual([])
    expect(await run()).toMatchObject({ ran: false, campaigns: [], tests: [] })
    expect(await decisions()).toEqual([])
    expect(await tests()).toEqual([])
    expect(await rows('SELECT id FROM "AdsBrainLeverClock" WHERE "workspaceId" = $1', [W])).toEqual([])
    expect(await queued()).toEqual([])
  })

  it('OBSERVE (the default): a thin product\'s up-and-down campaigns logged as SHADOW switches to down only; the floored one held; nothing asked or queued', async () => {
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: P })
    expect(await inW(() => modeWatchProducts())).toEqual([{ productId: P, market: 'IT', level: 'OBSERVE' }])
    const r = await run()
    expect(r).toMatchObject({ ran: true, failed: [], weekly: true })
    const c = byCampaign(r)
    expect(c['c-it']).toMatchObject({ action: 'hold', outcome: 'held', why: expect.stringMatching(/a stop floors 1 of its keywords .*: the stop recipe owns the bidding strategy while a stop lasts/) })
    expect(c['c-up']).toMatchObject({ action: 'switch', outcome: 'shadow', to: 'LEGACY_FOR_SALES', why: expect.stringMatching(/^SHADOW \(OBSERVE\) — would switch: up and down → down only: the product's ad orders of 30 settled days could not be read/) })
    expect(c['c-person']).toMatchObject({ action: 'switch', outcome: 'shadow' })
    expect(c['c-auto']).toMatchObject({ action: 'keep', outcome: 'none' })
    expect(c['c-other']).toBeUndefined() // another product's campaign
    expect((await decisions()).map((d) => [d.campaignId, d.mode, d.action, d.outcome, d.rule])).toEqual([
      ['c-auto', 'SHADOW', 'keep', 'none', 'thin'], ['c-it', 'SHADOW', 'hold', 'held', 'none'], ['c-person', 'SHADOW', 'switch', 'shadow', 'thin'], ['c-up', 'SHADOW', 'switch', 'shadow', 'thin'],
    ])
    expect(await tests()).toEqual([])
    expect(await queued()).toEqual([])
    expect(await rows('SELECT id FROM "AdsBrainLeverClock" WHERE "workspaceId" = $1', [W])).toEqual([])
    // A rerun on the same facts writes no row.
    const count = (await decisions()).length
    await run()
    expect((await decisions()).length).toBe(count)
  })

  it('a person\'s own strategy on a campaign the bid brain runs is a STRATEGY hold: the brain leaves it', async () => {
    const own = await inW(() => updateCampaignWithSync({ campaignId: 'c-person', patch: { biddingStrategy: 'MANUAL' }, actor: 'user:owner', manual: true, reason: 'my own strategy', askGate: true }))
    expect(own).toMatchObject({ ok: true })
    expect(await strategyHolds()).toEqual([{ campaignId: 'c-person', by: 'user:owner' }])
    const r = await run()
    expect(byCampaign(r)['c-person']).toMatchObject({ action: 'hold', outcome: 'held', why: expect.stringMatching(/a person's own strategy \(held by user:owner until .*\): the brain leaves it until then/) })
    expect(await queued()).toHaveLength(1) // the person's own write
  })

  it('N4: at AUTO with a fresh clock the switch is asked through the real approval queue — a test opened, nothing queued; asked once', async () => {
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'biddingStrategy', level: 'AUTO', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const r = await run()
    const c = byCampaign(r)
    expect(c['c-up']).toMatchObject({ action: 'switch', outcome: 'asked', why: expect.stringMatching(/AUTO, but for the first 30 days the lever is the brain's .* every switch asks a person \(N4\)/) })
    const [clock] = await rows<Data>('SELECT * FROM "AdsBrainLeverClock" WHERE "workspaceId" = $1', [W])
    expect(clock).toMatchObject({ productId: P, marketplace: 'IT', lever: 'biddingStrategy', by: 'user:owner' })
    const asked = await approvals()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ toolName: 'set-campaign-settings', status: 'pending', agentKey: BRAIN_STRATEGY_AGENT_KEY, args: { campaignIds: ['c-up'], biddingStrategy: 'legacyForSales' } })
    expect(asked[0].args.why).toMatch(/^The ads brain: up and down → down only/)
    const [t] = await tests()
    expect(t).toMatchObject({ campaignId: 'c-up', status: 'ASKED', fromStrategy: 'AUTO_FOR_SALES', toStrategy: 'LEGACY_FOR_SALES', rule: 'thin', level: 'AUTO', approvalId: asked[0].id })
    expect(asked[0].entityId).toBe(t.id)
    expect(await queued()).toHaveLength(1)
    expect(await strategyOf('c-up')).toBe('AUTO_FOR_SALES')
    expect(STRATEGY_REQUESTER).toBe('Nexus ads brain')
    // The next run: the request waits — not asked twice.
    const again = await run()
    expect(byCampaign(again)['c-up']).toMatchObject({ action: 'switch', outcome: 'waiting', approvalId: asked[0].id })
    expect(await approvals()).toHaveLength(1)
  })

  it('approved: it runs as the person through the tool\'s own write — the brain\'s own switch, no STRATEGY hold; the next run starts the test', async () => {
    const [ap] = await approvals()
    const out = await inW(() => decideApproval(ap.id, 'approve', person('u-approver') as never))
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, status: 'executed' })
    expect(await strategyOf('c-up')).toBe('LEGACY_FOR_SALES')
    const q = await queued()
    expect(q).toHaveLength(2)
    expect(q[1]).toMatchObject({ entityId: 'c-up', payload: { actor: 'user:u-approver' } })
    // The brain asked for it: no person's hold on c-up (the bid brain runs it); c-person's own stays.
    expect(await strategyHolds()).toEqual([{ campaignId: 'c-person', by: 'user:owner' }])
    const r = await run()
    expect(byCampaign(r)['c-up']).toMatchObject({ action: 'test', outcome: 'none', why: expect.stringMatching(/^testing down only since .*: the verdict once 2 whole weeks after it have settled/) })
    const t = (await tests()).find((x) => x.campaignId === 'c-up')!
    expect(t).toMatchObject({ status: 'TESTING' })
    expect(t.switchedAt).not.toBeNull()
    expect(t.why).toMatch(/a person approved it: switched to down only on .* — the test starts/)
  })

  it('AUTO after the approval days: the brain\'s switch through the real campaign path and gate — one queued write as the brain, a test opened; a rerun writes nothing', async () => {
    await database.pool.query('UPDATE "AdsBrainLeverClock" SET since = $2 WHERE "workspaceId" = $1', [W, new Date(NOW.getTime() - 31 * DAY)])
    await database.pool.query('UPDATE "Campaign" SET "biddingStrategy" = \'AUTO_FOR_SALES\' WHERE id = \'c-auto\'')
    const r = await run()
    expect(byCampaign(r)['c-auto']).toMatchObject({ action: 'switch', outcome: 'queued', to: 'LEGACY_FOR_SALES' })
    expect(await strategyOf('c-auto')).toBe('LEGACY_FOR_SALES')
    const q = await queued()
    expect(q).toHaveLength(3)
    expect(q[2]).toMatchObject({ entityId: 'c-auto', payload: { actor: BRAIN_STRATEGY_ACTOR, fieldChanges: [{ field: 'biddingStrategy', oldValue: 'AUTO_FOR_SALES', newValue: 'LEGACY_FOR_SALES' }] } })
    const [log] = await rows<Data>('SELECT "userId", "actionType", evidence FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = \'c-auto\'', [W])
    expect(log).toMatchObject({ userId: BRAIN_STRATEGY_ACTOR, actionType: 'AD_BIDDING_STRATEGY_UPDATE', evidence: { metric: 'biddingStrategy', brain: { layer: 'bidding_mode' } } })
    expect((await tests()).find((x) => x.campaignId === 'c-auto')).toMatchObject({ status: 'TESTING', level: 'AUTO' })
    expect((await decisions()).find((d) => d.campaignId === 'c-auto' && d.outcome === 'queued')).toMatchObject({ mode: 'LIVE', action: 'switch', level: 'AUTO' })
    await run()
    expect(await queued()).toHaveLength(3)
  })

  it('the gate: the brain\'s strategy writer refused where a stop holds the campaign, where no brain owns it, and under the Owner\'s lock (in his words)', async () => {
    forgetLeverOwners()
    await database.pool.query('UPDATE "Campaign" SET "suppressedFromBiddingStrategy" = \'AUTO_FOR_SALES\', "biddingStrategy" = \'LEGACY_FOR_SALES\' WHERE id = \'c-it\'')
    const stop = await inW(() => writeAsTheBrain({ campaignId: 'c-it', to: 'MANUAL', reason: 'test', runId: 'run-test', layer: 'bidding_mode', dataDay: isoDay(NOW) }))
    expect(stop).toMatchObject({ queued: false })
    expect(stop.error).toMatch(/a stop holds campaign .*c-it.*: its bidding strategy is the stop recipe's until the stop ends/)
    expect(await strategyOf('c-it')).toBe('LEGACY_FOR_SALES')
    const other = await inW(() => writeAsTheBrain({ campaignId: 'c-other', to: 'LEGACY_FOR_SALES', reason: 'test', runId: 'run-test', layer: 'bidding_mode', dataDay: isoDay(NOW) }))
    expect(other.error).toMatch(/writes only a lever the brain owns: the bidding strategy of campaign .*c-other.* is not the brain's/)
    expect(await strategyOf('c-other')).toBe('AUTO_FOR_SALES')
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'my own strategy', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-auto', kind: 'LOCK', key: 'biddingStrategy' } }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const locked = await inW(() => writeAsTheBrain({ campaignId: 'c-auto', to: 'MANUAL', reason: 'test', runId: 'run-test', layer: 'bidding_mode', dataDay: isoDay(NOW) }))
    expect(locked.error).toMatch(/the Owner locked it \(.*"my own strategy"/)
    const r = await run()
    expect(byCampaign(r)['c-auto']).toMatchObject({ action: 'hold', outcome: 'held', why: expect.stringMatching(/locked at the Owner's own value/) })
    expect((await tests()).find((x) => x.campaignId === 'c-auto')).toMatchObject({ status: 'ENDED', why: expect.stringMatching(/the Owner locked the strategy/) })
    expect(byCampaign(r)['c-it']).toMatchObject({ action: 'hold', why: expect.stringMatching(/a stop holds it at down only \(the stop recipe saved its up and down\)/) })
    expect(await queued()).toHaveLength(3)
    expect(await inW(() => endOverride({ productId: P, market: 'IT', by: 'user:owner', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-auto', kind: 'LOCK', key: 'biddingStrategy' } }))).toMatchObject({ ok: true })
  })

  it('the verdict: 20 days on, worse after the switch than before — switched back as the brain (layer switchback), the test REVERTED; never the same switch again at once', async () => {
    // Day 0 of c-up's test 20 days ago: its approved switch and its test moved back; the market's daily report written.
    const switchedAt = new Date(NOW.getTime() - 20 * DAY)
    const t = (await tests()).find((x) => x.campaignId === 'c-up')!
    await database.pool.query('UPDATE "AdsBrainStrategyTest" SET "switchedAt" = $2 WHERE id = $1', [t.id, switchedAt])
    await database.pool.query('UPDATE "AdvertisingActionLog" SET "createdAt" = $2 WHERE "workspaceId" = $1 AND "entityId" = \'c-up\'', [W, switchedAt])
    const switchDay = Date.parse(`${isoDay(switchedAt)}T00:00:00Z`)
    const daily = []
    for (let i = -16; i <= 19; i++) {
      if (i === 0) continue
      const date = new Date(switchDay + i * DAY)
      const after = i > 0
      daily.push({ profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'CAMPAIGN', entityId: 'EXT-c-up', localEntityId: 'c-up', impressions: 400, clicks: after ? 12 : 10, costMicros: after ? 10_000_000n : 5_000_000n, sales7dCents: 2_000, orders7d: 1, currencyCode: 'EUR', reportRunId: 'run-test', reportedAt: NOW })
    }
    await inW(() => (database.client as any).amazonAdsDailyPerformance.createMany({ data: daily }))
    const r = await run({ weekly: false })
    expect(byCampaign(r)['c-up']).toMatchObject({ action: 'revert', outcome: 'queued', to: 'AUTO_FOR_SALES', why: expect.stringMatching(/AUTO: switched back by the brain — worse over the 2 weeks after the switch against the 2 weeks before: its ACoS rose 25 points .* back to up and down/) })
    expect(await strategyOf('c-up')).toBe('AUTO_FOR_SALES')
    const q = await queued()
    expect(q.at(-1)).toMatchObject({ entityId: 'c-up', payload: { actor: BRAIN_STRATEGY_ACTOR, fieldChanges: [{ field: 'biddingStrategy', oldValue: 'LEGACY_FOR_SALES', newValue: 'AUTO_FOR_SALES' }] } })
    const [revertLog] = await rows<Data>('SELECT evidence FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = \'c-up\' AND "userId" = $2', [W, BRAIN_STRATEGY_ACTOR])
    expect(revertLog.evidence).toMatchObject({ brain: { layer: 'switchback' } })
    const done = (await tests()).find((x) => x.id === t.id)!
    expect(done).toMatchObject({ status: 'REVERTED', verdict: 'revert' })
    // A DATE column read as text (the driver would parse it at the machine's local midnight).
    const [days] = await rows<Data>('SELECT "testFrom"::text AS "testFrom", "testTo"::text AS "testTo", "baselineFrom"::text AS "baselineFrom", "baselineTo"::text AS "baselineTo" FROM "AdsBrainStrategyTest" WHERE id = $1', [t.id])
    expect(days).toEqual({ testFrom: isoDay(new Date(switchDay + DAY)), testTo: isoDay(new Date(switchDay + 14 * DAY)), baselineFrom: isoDay(new Date(switchDay - 14 * DAY)), baselineTo: isoDay(new Date(switchDay - DAY)) })
    expect(done.figures).toMatchObject({ weeks: 2, before: { spendCents: 7_000, salesCents: 28_000 }, after: { spendCents: 14_000, salesCents: 28_000 } })
    expect(done.revertedAt).not.toBeNull()
    // The next weekly run: the thin product's rule still says down only, but its test was worse — kept, no flip-flop.
    const next = await run({ now: later(1) })
    expect(byCampaign(next)['c-up']).toMatchObject({ action: 'keep', outcome: 'none', why: expect.stringMatching(/its switchback test of down only was worse on .* — tried again from/) })
    expect((await queued()).length).toBe(q.length)
  })

  it('the cycle\'s step: a campaign the state step pauses is a stop — held; the step names what it did', async () => {
    await database.pool.query('UPDATE "Campaign" SET "biddingStrategy" = \'AUTO_FOR_SALES\' WHERE id = \'c-auto\'')
    const tick = { now: later(2), dataDay: isoDay(NOW), stateWatch: new Map(), moneyWatch: new Map(), termsDue: [] }
    const ctx = {
      productId: P, market: 'IT', key: `IT|${P}`, changeSetId: 'cyc-test', own: new Map([['c-auto', 'Jacket auto'], ['c-up', 'Jacket up']]),
      records: { state: { status: 'done', why: 'AUTO: pause 1', acts: true, holds: [['c-auto', 'it pauses Jacket auto (queued)']], attempt: 1, at: NOW.toISOString() } },
      acts: { state: true, terms: false, negatives: false, harvest: false, money: false, bids: false, hours: false, bidding: true }, tick,
    }
    const out = await inW(() => biddingStep(ctx as never))
    expect(out).toMatchObject({ status: 'done', why: expect.stringMatching(/^AUTO/) })
    expect(out.did?.lines).toEqual(expect.arrayContaining([expect.stringMatching(/new switches are decided on the weekly run|Jacket auto|campaigns? decided/)]))
    const logged = (await decisions()).filter((d) => d.campaignId === 'c-auto').at(-1)!
    expect(logged).toMatchObject({ action: 'hold', outcome: 'held', why: expect.stringMatching(/the product cycle's stops and state step: it pauses Jacket auto \(queued\)/) })
    expect(await strategyOf('c-auto')).toBe('AUTO_FOR_SALES')
    // A product the lever does not watch: off.
    expect(await inW(() => biddingStep({ ...ctx, productId: R } as never))).toMatchObject({ status: 'off' })
  })

  it('another business: nothing enrolled there — it decides nothing and sees none of these rows', async () => {
    forgetLeverOwners()
    expect(await inW2(() => modeWatchProducts())).toEqual([])
    expect(await inW2(() => runBiddingModeOnce({ now: NOW, weekly: true }))).toMatchObject({ ran: false })
    for (const table of TABLES) expect(await rows(`SELECT id FROM "${table}" WHERE "workspaceId" = $1`, [W2]), table).toEqual([])
    expect(await inW2(() => (database.client as any).adsBrainStrategyTest.findMany())).toEqual([])
    expect(await rows('SELECT id FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W2])).toEqual([])
  })

  it('the ads-brain view bidding: each campaign decided now beside what was logged, the tests, the N4 clock; the market\'s tests; nothing stored', async () => {
    const before = (await decisions()).length
    const testsBefore = (await tests()).length
    const one = await view({ productId: P1, market: 'it', now: later(3) })
    expect(one.ok).toBe(true)
    expect(one.data).toMatchObject({ view: 'bidding', scope: { productId: P, market: 'IT' }, enrolled: true, dryRun: true, switches: { serverSwitchLive: true, adsAutomation: 'auto' }, n4: { owned: true, stored: true, approvalDays: 30 } })
    const camps = Object.fromEntries(one.data!.campaigns.map((c: Data) => [c.campaignId, c]))
    expect(camps['c-person']).toMatchObject({ action: 'hold', hold: expect.stringMatching(/held by user:owner/) })
    expect(camps['c-up']).toMatchObject({ strategy: 'AUTO_FOR_SALES', action: 'keep', logged: { action: 'keep' } })
    expect(one.data!.tests.map((t: Data) => [t.campaignId, t.status])).toEqual(expect.arrayContaining([['c-up', 'REVERTED'], ['c-auto', 'ENDED']]))
    expect(one.data!.rules.n4).toMatch(/strategyApprovalDays \(30\)/)
    const market = await view({ market: 'IT', now: later(3) })
    expect(market.data).toMatchObject({ view: 'bidding', scope: { market: 'IT' }, products: [{ productId: P, level: 'AUTO' }] })
    expect(await view({ market: 'XX1' })).toMatchObject({ ok: false })
    expect(await view({ productId: 'no-such-product', market: 'IT', now: later(3) })).toMatchObject({ ok: false, error: 'Product not found' })
    expect((await decisions()).length).toBe(before)
    expect((await tests()).length).toBe(testsBefore)
  })
})
