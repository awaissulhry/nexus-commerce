/**
 * ONE BRAIN AB-15 — auto-undo per lever and the kill switch per lever on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the server switch `live`, the ads mode LIVE (the real write gate) and the job queue a stub: every write below is
 * refused by the real gate or only queued (no worker runs) — nothing leaves the process.
 *
 * Product A's campaigns A1 and A2 and Product B's B1 in IT; the money writer raised A1's budget 12 days ago (10 → 13) and
 * since then A1 spent more than twice as much a day and sold nothing; the bid brain raised a keyword of B1 10 days ago and
 * it then sold nothing either. Product A's ACoS target 25 %.
 *
 *   today      production as AB-15 ships: nothing enrolled — the brain pass adds nothing (no `brain` in the answer, the line
 *              as before) and the money writer's raise is left alone as the brain's; the bid brain's raise judged as before
 *   enrolled   the brain pass judges the money raise (only spend: worse; OBSERVE would undo it) and the bid brain's raise is
 *              judged exactly as with nothing enrolled; a dry run records nothing
 *   auto       the raise is put back through the Undo's own path as auto-undo (A1's budget 13 → 10, queued with the 5-minute
 *              window, the raise marked undone) and the brain holds that budget 7 days (brain/lever-holds.ts); a rerun does
 *              nothing more
 *   kill       the Owner stops A's budgets lever: auto-undo at AUTO asks a person instead of undoing A2's raise; the gate
 *              refuses the money writer on A2's budget (brain_killed), a person's own edit passes, another engine is refused as
 *              before, and the brain's state writer on A2 (another lever) still passes; the map shows the kill
 *   all        a kill of the state lever for every product in IT stops the state writer on A1; ending it frees the lever
 *   harvest    AB-11's WORSE judgement of a harvest pair: at AUTO the pair is put back (keyword paused, source negative
 *              retired, both as auto-undo) and the harvest is UNDONE (AB-11's cooldown is the hold); a rerun does nothing
 *   business   another business: no brain pass, no kill
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

const { runAutoUndo, autoUndoSummaryLine } = await import('../ads-auto-undo.service.js')
const { setEngineSwitch } = await import('../../automation/engine-switch.service.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { enrollProduct, setLever } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { setBrainKill, endBrainKill, openKills, forgetKills } = await import('./kill-switch.js')
const { leverHolds, moneyHolds } = await import('./lever-holds.js')
const { brainMap } = await import('./read-map.js')
const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
const { MONEY_BUDGETS_ACTOR } = await import('./budget-ladder.js')
const { BRAIN_STATE_ACTOR } = await import('../ads-write-gate.js')
const { BRAIN_ACTOR } = await import('../bid-brain/live.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab15_undo_${hex}`
const W2 = `ab15_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const A = id('prod-a'), A_S = id('prod-a-s'), B = id('prod-b'), B_L = id('prod-b-l')
const NOW = new Date('2026-10-08T12:00:00Z')
const DAY = 86_400_000
const dayAt = (d: string) => new Date(`${d}T09:00:00Z`)
const OWNER = 'user:owner'

type Data = Record<string, any>
const judgements = () => rows<Data>('SELECT * FROM "AdsAutoUndoJudgement" WHERE "workspaceId" = $1 ORDER BY "changedAt", id', [W])
const queued = async () => (await rows<{ payload: Data }>('SELECT payload FROM "OutboundSyncQueue" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W])).map((r) => ({ entityId: r.payload.entityId, fieldChanges: r.payload.fieldChanges, actor: r.payload.actor }))
const budgetOf = async (key: string) => (await rows<{ b: string }>('SELECT "dailyBudget"::text AS b FROM "Campaign" WHERE id = $1', [C(key)]))[0]?.b
const approvals = () => rows<Data>('SELECT "toolName", status, args FROM "AgentApproval" WHERE "workspaceId" = $1 ORDER BY "requestedAt", id', [W])
const fresh = () => { forgetLeverOwners(); forgetKills() }
/** One auto-undo run on the scenario's clock (the code's own clock is set to NOW too: the gate and the queue read it). */
const undo = (dryRun = false) => inW(() => runAutoUndo({ now: NOW, dryRun }))
const bidItem = (out: Awaited<ReturnType<typeof runAutoUndo>>) => out.items.find((i) => i.entity.id === `t-${C('b1')}`)

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(A, `AB15-A-${hex}`, { isParent: true, name: 'Product A' })
  await product(A_S, `AB15-A-S-${hex}`, { parentId: A, amazonAsin: `B0AB15AS${H}` })
  await product(B, `AB15-B-${hex}`, { isParent: true, name: 'Product B' })
  await product(B_L, `AB15-B-L-${hex}`, { parentId: B, amazonAsin: `B0AB15BL${H}` })
  const campaign = async (key: string, name: string, budget: string, ad: [string, string]) => {
    await db.campaign.create({ data: { id: C(key), name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: budget, startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, status: 'ENABLED' } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    for (const t of ['', '-p1', '-p2']) await db.adTarget.create({ data: { id: `t-${C(key)}${t}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `keyword ${key}${t}`, bidCents: t ? 40 : 50, externalTargetId: `EXT-t-${C(key)}${t}` } })
    await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId: ad[0], asin: ad[1] } })
  }
  await campaign('a1', 'Campaign A1', '13.00', [A_S, `B0AB15AS${H}`])
  await campaign('a2', 'Campaign A2', '13.00', [A_S, `B0AB15AS${H}`])
  await campaign('b1', 'Campaign B1', '10.00', [B_L, `B0AB15BL${H}`])
  await db.amazonAdsConnection.create({ data: { profileId: 'p-it', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date('2026-01-01T00:00:00Z'), isActive: true } })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: A, label: 'Product A (IT)', version: 1, targetKind: 'ACOS', targetPct: 25, updatedBy: OWNER } })
  // The daily report, 1 September → 7 October. A1: before the raise (26 Sept) €5 a day with an order a day; after it €12 a day
  // and no order. A2: the same shape around its raise (27 Sept). B1 steady; its keyword sells nothing after the bid brain's raise.
  const daily: Array<Record<string, unknown>> = []
  const push = (entityType: string, local: string, ext: string, t: number, spend: number, sales: number, clicks: number, orders: number) =>
    daily.push({ profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(t), entityType, entityId: ext, localEntityId: local, costMicros: BigInt(spend) * 10_000n, sales7dCents: sales, orders7d: orders, clicks, currencyCode: 'EUR', reportRunId: 'run-test', reportedAt: new Date(t + DAY) })
  for (let t = Date.parse('2026-09-01T00:00:00Z'); t <= Date.parse('2026-10-07T00:00:00Z'); t += DAY) {
    const after = (d: string) => t > Date.parse(`${d}T00:00:00Z`)
    push('CAMPAIGN', C('a1'), `EXT-${C('a1')}`, t, after('2026-09-26') ? 1_200 : 500, after('2026-09-26') ? 0 : 2_500, after('2026-09-26') ? 20 : 10, after('2026-09-26') ? 0 : 1)
    push('CAMPAIGN', C('a2'), `EXT-${C('a2')}`, t, after('2026-09-27') ? 1_200 : 500, after('2026-09-27') ? 0 : 2_500, after('2026-09-27') ? 20 : 10, after('2026-09-27') ? 0 : 1)
    push('CAMPAIGN', C('b1'), `EXT-${C('b1')}`, t, 500, 2_000, 10, 1)
    push('AD_TARGET', `t-${C('b1')}`, `EXT-t-${C('b1')}`, t, after('2026-09-28') ? 1_200 : 500, after('2026-09-28') ? 0 : 2_000, after('2026-09-28') ? 20 : 10, after('2026-09-28') ? 0 : 2)
    for (const p of ['-p1', '-p2']) push('AD_TARGET', `t-${C('b1')}${p}`, `EXT-t-${C('b1')}${p}`, t, 500, 2_000, 10, 2)
  }
  await db.amazonAdsDailyPerformance.createMany({ data: daily as never })
  const log = (logId: string, data: Record<string, unknown>) => db.advertisingActionLog.create({ data: { id: id(logId), amazonResponseStatus: 'SUCCESS', ...data } as never })
  // The money writer's base raises of A1 (12 days ago) and A2 (11 days ago): 10 → 13, the day's base move.
  for (const [key, day] of [['a1', '2026-09-26'], ['a2', '2026-09-27']] as const) {
    await log(`log-money-${key}`, {
      entityType: 'CAMPAIGN', entityId: C(key), actionType: 'update_campaign', userId: MONEY_BUDGETS_ACTOR,
      payloadBefore: { dailyBudget: 10, status: 'ENABLED' }, payloadAfter: { dailyBudget: 13, status: 'ENABLED' },
      evidence: { metric: 'dailyBudget', note: 'test raise', brain: { runId: 'bm-test', layer: 'base', dataDay: day, goalBidCents: null } }, createdAt: dayAt(day),
    })
  }
  // The bid brain's raise of a keyword of B1 (10 days ago): 40 → 50.
  await log('log-bid-brain', { entityType: 'AD_TARGET', entityId: `t-${C('b1')}`, actionType: 'AD_BID_UPDATE', userId: BRAIN_ACTOR, payloadBefore: { bidCents: 40 }, payloadAfter: { bidCents: 50 }, createdAt: dayAt('2026-09-28') })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-15 — auto-undo per lever and the kill switch per lever (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_ENABLE_AMAZON_ADS_CRON', '1')
    vi.stubEnv('NEXUS_ADS_AUTOMATION_KILL', '')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  }, 240_000)
  afterAll(async () => { vi.useRealTimers(); await database?.close(); vi.unstubAllEnvs() }, 60_000)

  let bidBefore: Data | undefined
  it('today: nothing enrolled — no brain pass (the answer and its line as before); the money raise is left alone as the brain\'s, the bid brain\'s raise judged as before', async () => {
    fresh()
    const out = await undo()
    expect(out.level).toBe('OBSERVE')
    expect('brain' in out).toBe(false)
    expect(autoUndoSummaryLine(out)).not.toContain('brain')
    expect(out.leftAlone).toMatchObject({ brain: 2 })
    bidBefore = bidItem(out) as Data
    expect(bidBefore).toMatchObject({ origin: 'engine', by: 'Bid brain', lever: 'bid', direction: 'raise', fromValue: 40, toValue: 50, verdict: 'worse', outcome: 'no_sales', action: 'would_undo' })
    expect((await judgements()).map((j) => [j.origin, j.lever])).toEqual([['engine', 'bid']])
    expect(await queued()).toEqual([])
  })

  it('enrolled: a dry run records nothing; the brain pass judges the money raise (only spend, OBSERVE would undo it); the bid brain\'s raise judged exactly as before', async () => {
    expect(await inW(() => enrollProduct({ productId: A, market: 'IT', by: OWNER, now: NOW }))).toMatchObject({ ok: true })
    fresh()
    const dry = await undo(true)
    expect(dry.brain).toMatchObject({ counts: { read: 2, judged: 2, worse: 2, wouldUndo: 2 } })
    expect((await judgements()).map((j) => j.origin)).toEqual(['engine'])
    const out = await undo()
    expect(out.brain).toBeDefined()
    expect(autoUndoSummaryLine(out)).toMatch(/ · brain: read=2 judged=2 worse=2 would_undo=2 proposed=0 undone=0/)
    const a1 = out.brain!.items.find((i) => i.entity.id === C('a1'))!
    expect(a1).toMatchObject({ lever: 'budgets', kind: 'raise', by: 'Brain budgets', productId: A, fromValue: 1_000, toValue: 1_300, verdict: 'worse', action: 'would_undo', why: expect.stringMatching(/^only spend: in the 7 days after the raise its spend rose by more than 50 % and it brought no order/) })
    // The bid brain's judgement is the one of before, word for word.
    const bidNow = bidItem(out) as Data
    expect({ ...bidNow, judgementId: undefined }).toEqual({ ...bidBefore, judgementId: undefined })
    const stored = (await judgements()).find((j) => j.entityId === C('a1'))!
    expect(stored).toMatchObject({ origin: 'brain', originLabel: 'Brain budgets', lever: 'budgets', direction: 'raise', verdict: 'worse', action: 'would_undo', level: 'OBSERVE', final: true, actor: MONEY_BUDGETS_ACTOR })
    expect(stored.evidence).toMatchObject({ pass: 'brain', productId: A, campaignId: C('a1'), band: { aim: 0.25 }, rule: { holdDays: 7, ceiling: 'AUTO' }, window: { days: 7 } })
    expect(await queued()).toEqual([])
  })

  it('AUTO: the raise judged bad is put back through the Undo\'s own path as auto-undo, and the brain holds that budget 7 days', async () => {
    // A1's judgement closed at OBSERVE (its window was whole): judged again from scratch at AUTO (A2's stays closed).
    await database.pool.query('DELETE FROM "AdsAutoUndoJudgement" WHERE "workspaceId" = $1 AND origin = \'brain\' AND "entityId" = $2', [W, C('a1')])
    await inW(() => setEngineSwitch('auto-undo', 'AUTO', OWNER))
    fresh()
    const out = await undo()
    expect(out.level).toBe('AUTO')
    const a1 = out.brain!.items.find((i) => i.entity.id === C('a1'))!
    expect(a1).toMatchObject({ action: 'undone', reason: 'AUTO: put back by auto-undo, inside its caps', undoActionLogId: expect.any(String) })
    expect(await budgetOf('a1')).toBe('10.00')
    expect((await queued()).filter((q) => q.entityId === C('a1'))).toEqual([expect.objectContaining({ actor: 'automation:auto-undo', fieldChanges: [expect.objectContaining({ field: 'dailyBudget' })] })])
    expect((await rows<Data>('SELECT "rolledBackAt" FROM "AdvertisingActionLog" WHERE id = $1', [id('log-money-a1')]))[0].rolledBackAt).not.toBeNull()
    expect((await judgements()).find((j) => j.entityId === C('a1'))).toMatchObject({ origin: 'brain', action: 'undone', final: true })
    // The hold: the money writer leaves A1's budget for 7 days; A2 is free.
    const money = await inW(() => moneyHolds(A, 'IT', NOW))
    expect(money.budget(C('a1'))).toMatch(/^auto-undo put back a brain change here on 2026-10-08 \(judgement .+\): the brain writes no budget of that campaign for 7 days — held until 2026-10-15$/)
    expect(money.budget(C('a2'))).toBeNull()
    expect((await inW(() => moneyHolds(A, 'IT', new Date(NOW.getTime() + 8 * DAY)))).budget(C('a1'))).toBeNull()
    // A rerun: nothing more is undone or queued for A1.
    const before = (await queued()).length
    const again = await undo()
    expect(again.brain!.items.find((i) => i.entity.id === C('a1'))).toBeUndefined()
    expect((await queued()).length).toBe(before)
  })

  it('kill: auto-undo at AUTO asks a person instead; the gate refuses the money writer on the killed budgets only — a person, another lever and other engines as before; the map shows it', async () => {
    await inW(() => setLever({ productId: A, market: 'IT', lever: 'budgets', level: 'AUTO', by: OWNER, now: NOW }))
    await inW(() => setLever({ productId: A, market: 'IT', lever: 'state', level: 'AUTO', by: OWNER, now: NOW }))
    // A2's judgement closed at OBSERVE: judged again from scratch, now under the kill.
    await database.pool.query('DELETE FROM "AdsAutoUndoJudgement" WHERE "workspaceId" = $1 AND origin = \'brain\' AND "entityId" = $2', [W, C('a2')])
    const set = await inW(() => setBrainKill({ lever: 'budgets', productId: A_S, market: 'IT', by: OWNER, reason: 'test stop of the budgets' }))
    expect(set).toMatchObject({ ok: true, kill: { lever: 'budgets', productId: A, market: 'IT', by: OWNER } })
    fresh()
    const out = await undo()
    const a2 = out.brain!.items.find((i) => i.entity.id === C('a2'))!
    expect(a2).toMatchObject({ verdict: 'worse', action: 'proposed', reason: expect.stringMatching(/^AUTO, but the lever is stopped by the Owner's kill switch .*: auto-undo writes nothing on it alone/), undoApprovalId: expect.any(String) })
    expect(await budgetOf('a2')).toBe('13.00')
    expect((await approvals()).filter((a) => a.toolName === 'set-campaign-budget')).toEqual([expect.objectContaining({ status: 'pending', args: expect.objectContaining({ campaigns: [{ campaignId: C('a2'), dailyBudgetCents: 1_000 }] }) })])
    // The gate: the money writer on A2's budget is refused by the kill, nothing left behind.
    const before = (await queued()).length
    const refused = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { dailyBudget: 12 }, actor: MONEY_BUDGETS_ACTOR as never, askGate: true }))
    expect(refused).toMatchObject({ ok: false, outboundQueueId: null })
    expect(refused.error).toMatch(/the daily budget of campaign "Campaign A2" .* is stopped by the Owner's kill switch \(user:owner, 2026-10-08, product .* in IT\): "test stop of the budgets"/)
    expect(await budgetOf('a2')).toBe('13.00')
    // Another engine: refused as before the kill (the brain owns the budget), in the ownership's words.
    const rule = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { dailyBudget: 12 }, actor: 'automation:rule-test' as never, askGate: true }))
    expect(rule.error).toMatch(/run by the brain of product/)
    // A person's own edit passes.
    const person = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { dailyBudget: 12 }, actor: OWNER as never, manual: true, askGate: true }))
    expect(person).toMatchObject({ ok: true, outboundQueueId: expect.any(String) })
    // The brain's state writer on A2 — another lever — still passes.
    const pause = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { status: 'PAUSED' }, actor: BRAIN_STATE_ACTOR as never, askGate: true }))
    expect(pause).toMatchObject({ ok: true, outboundQueueId: expect.any(String) })
    expect((await queued()).length).toBe(before + 2)
    // The map: the kill on the product's budgets lever, with who, when and why; the market lists it.
    const map = await inW(() => brainMap({ view: 'map', productId: A, market: 'IT' } as never)) as { data: Data }
    expect(map.data.product.levers.budgets.killed).toMatchObject({ lever: 'budgets', products: 'one', productId: A, market: 'IT', by: OWNER, reason: 'test stop of the budgets' })
    expect(map.data.product.levers.state.killed).toBeNull()
    expect(map.data.product.kills).toHaveLength(1)
    const market = await inW(() => brainMap({ view: 'map', market: 'IT' } as never)) as { data: Data }
    expect(market.data.kills).toEqual([expect.objectContaining({ lever: 'budgets', productId: A })])
  })

  it('every product: a kill of the state lever in IT stops the brain\'s state writer on every product; ending it frees the lever', async () => {
    const set = await inW(() => setBrainKill({ lever: 'state', market: 'IT', by: OWNER, reason: 'test stop of every pause' }))
    expect(set).toMatchObject({ ok: true, kill: { lever: 'state', productId: null, market: 'IT' } })
    fresh()
    const refused = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { status: 'ENABLED' }, actor: BRAIN_STATE_ACTOR as never, askGate: true }))
    expect(refused.error).toMatch(/the state \(pause, enable, archive\) of campaign "Campaign A2" .* is stopped by the Owner's kill switch \(user:owner, 2026-10-08, every product in IT\): "test stop of every pause"/)
    expect((await inW(() => leverHolds('state', A, 'IT', NOW))).kill).toMatch(/every product in IT/)
    expect(await inW(() => openKills())).toHaveLength(2)
    expect(await inW(() => endBrainKill({ lever: 'state', market: 'IT', by: OWNER }))).toMatchObject({ ok: true, ended: { lever: 'state' } })
    fresh()
    const freed = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { status: 'ENABLED' }, actor: BRAIN_STATE_ACTOR as never, askGate: true }))
    expect(freed).toMatchObject({ ok: true, outboundQueueId: expect.any(String) })
    // Kept, never deleted: who ended it is on the row.
    expect((await rows<Data>('SELECT "endedBy", reason FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind = \'KILL\' AND key = \'state\'', [W]))).toEqual([{ endedBy: OWNER, reason: 'test stop of every pause' }])
    // Ending one that is not there says so.
    expect(await inW(() => endBrainKill({ lever: 'state', market: 'IT', by: OWNER }))).toMatchObject({ ok: false, refusal: expect.stringMatching(/nothing to end/) })
  })

  it('harvest: AB-11\'s WORSE judgement of a pair is put back as a pair at AUTO (the source negative retired, then the keyword paused), AB-11\'s own waiting undo request withdrawn, and the term waits AB-11\'s cooldown', async () => {
    // Today's undos so far moved to yesterday: the daily cap is not what this step measures.
    await database.pool.query('UPDATE "AdsAutoUndoJudgement" SET "actionAt" = "actionAt" - interval \'2 days\' WHERE "workspaceId" = $1', [W])
    await inW(async () => {
      const db = database.client
      await db.adTarget.create({ data: { id: id('h-kw'), adGroupId: `g-${C('a1')}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test harvest term', bidCents: 40, externalTargetId: `EXT-${id('h-kw')}` } })
      await db.adTarget.create({ data: { id: id('h-neg'), adGroupId: `g-${C('a2')}`, kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'test harvest term', isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: `EXT-${id('h-neg')}` } as never })
      await db.adsBrainHarvest.create({
        data: {
          id: id('harvest'), productId: A, marketplace: 'IT', term: 'test harvest term', isAsin: false, status: 'DONE', level: 'AUTO', destinationKind: 'EXISTING',
          destCampaignId: C('a1'), destAdGroupId: `g-${C('a1')}`, bidCents: 40, keywordTargetId: id('h-kw'), landedAt: new Date(NOW.getTime() - 12 * DAY),
          sources: [{ adGroupId: `g-${C('a2')}`, action: 'negate', negativeTargetId: id('h-neg'), result: 'landed' }], why: 'test harvest', evidence: {},
          judgeAfter: new Date(NOW.getTime() - 2 * DAY), judgedAt: new Date(NOW.getTime() - DAY), verdict: 'WORSE', judgement: { why: 'test: it stopped converting where it landed', final: true },
          digest: 'test', runId: 'test', decidedAt: new Date(NOW.getTime() - 13 * DAY), checkedAt: NOW, changedAt: NOW,
        } as never,
      })
      // AB-11's own undo request for this harvest, still waiting for a person (batch 2 fix: auto-undo withdraws it).
      const run = await db.agentRun.create({ data: { agentKey: 'ads-brain-harvest', trigger: 'schedule', status: 'done' } })
      await db.agentApproval.create({ data: { id: id('ab11-undo'), agentRunId: run.id, toolName: 'apply-brain-harvest', riskTier: 'high', args: { op: 'undo', harvestId: id('harvest') }, status: 'pending' } })
    })
    fresh()
    const out = await undo()
    const h = out.brain!.items.find((i) => i.lever === 'harvest')!
    expect(h).toMatchObject({ kind: 'harvest', entity: { type: 'HARVEST', id: id('harvest'), label: 'harvest of "test harvest term"' }, verdict: 'worse', action: 'undone', why: 'test: it stopped converting where it landed' })
    const record = (await rows<Data>('SELECT status, why FROM "AdsBrainHarvest" WHERE id = $1', [id('harvest')]))[0]
    expect(record).toMatchObject({ status: 'UNDONE', why: 'put back by auto-undo: 1 source negative retired, the keyword paused' })
    // The pair order: the source runs the term again first, then the keyword pauses (never a term without a home).
    const writes = (await queued()).filter((q) => q.entityId === id('h-kw') || q.entityId === id('h-neg'))
    expect(writes.map((w) => [w.entityId, w.actor])).toEqual([[id('h-neg'), 'automation:auto-undo'], [id('h-kw'), 'automation:auto-undo']])
    // AB-11's own waiting undo request is withdrawn: one undo, not two.
    expect(await rows('SELECT status, reason FROM "AgentApproval" WHERE id = $1', [id('ab11-undo')])).toEqual([{ status: 'rejected', reason: 'withdrawn: auto-undo put the harvest back first' }])
    expect((await judgements()).find((j) => j.lever === 'harvest')).toMatchObject({ origin: 'brain', actionLogId: `harvest:${id('harvest')}`, action: 'undone', final: true })
    // A rerun: the pair is not put back twice.
    const again = await undo()
    expect(again.brain!.items.find((i) => i.lever === 'harvest')).toBeUndefined()
  })

  it('another business: no brain pass and no kill', async () => {
    fresh()
    const out = await inW2(() => runAutoUndo({ now: NOW }))
    expect('brain' in out).toBe(false)
    expect(await inW2(() => openKills())).toEqual([])
  })
})
