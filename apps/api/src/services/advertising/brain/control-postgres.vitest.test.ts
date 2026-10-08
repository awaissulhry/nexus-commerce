/**
 * ONE BRAIN — the Owner's control of a product's brain (set-ads-brain, brain/control.ts) on a real PostgreSQL (the
 * throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime
 * login, business profiles ON), through the REAL approval path: Claude asks (runOrQueueTool), a person approves or rejects
 * (decideApproval), the tool runs as the approver. The job queue is a stub: nothing leaves the process; Amazon ads writes
 * are in sandbox (a give-back is recorded in Nexus only).
 *
 *   enroll     the preview names every campaign (own, shared), refuses each level a lever does not take and a bids level
 *              other than its campaigns' — all at once, nothing queued; the adopted AUTO is a big door. Rejected: nothing
 *              written. A plain approve runs nothing; approved with the code it runs as the approver: the enrollment, the
 *              adopted levels and his levels, no campaign moved, nothing at Amazon, the change recorded
 *   set-level  AUTO a big door, OBSERVE on one campaign a normal approval; precedence after set (campaign > product >
 *              default) in the settings and in the ads-brain map with who and why; undo asks for the inverse; a reset that
 *              lets AUTO apply on a campaign is a big door
 *   lock       a whole lever with his value and one hour cell: the map shows each with its source; a bad ref and a value
 *              out of bounds refused; an unlock that lets AUTO apply again is a big door
 *   exclude    a campaign out of the brain (normal approval), shown in the map; include brings AUTO back (a big door)
 *   set-value  inside its bounds, per product and per campaign; a raise said, no code; out of bounds, the wrong scope, a
 *              level a lever does not take and a change that changes nothing refused
 *   bids       OBSERVE takes the LIVE campaign back to shadow (normal approval); AUTO puts it LIVE again (the code), the
 *              adopted shadow campaign and the excluded one named as not reached
 *   stale      a change approved on another version of the brain does not run
 *   Amazon     a lever refused AUTO by name on a campaign where Amazon's own budget rule acts (AB-4); nothing queued
 *   leave      every lever back to OFF, levels and values ended, his locks and exclusion kept, the LIVE campaign's bid given
 *              back as the approver; undo asks to enroll again (a big door: its AUTO levels). Batch 2 fix: the brain's
 *              request still waiting is withdrawn (one a person decided is left), and the campaign its own pause holds is
 *              resumed as the approver — a big door (the approver's code); with pauses "keep" it stays paused, no code
 *   another    another business finds no product and changes nothing
 *
 * Values are made up (public repo).
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

const { brainSettings } = await import('./enrollment.js')
const { decideApproval, runOrQueueTool } = await import('../../agents/approval-gate.service.js')
const { ADS_BRAIN_CONTROL_TOOLS } = await import('../../agents/tools/ads-brain-control.tools.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { DAY_TO_DAY_NO_CODE } = await import('../../agents/tools/ads-code-rule.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ctl_brain_${hex}`
const W2 = `ctl_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const P = id('p'), P1 = id('p1'), Q = id('q'), Q1 = id('q1')
const C = (s: string) => id(`c-${s}`)
const TOOL = 'set-ads-brain'
const tool = ADS_BRAIN_CONTROL_TOOLS[0]

type Data = Record<string, any>
const person = (userId: string, via: 'claude' | 'app', workspaceId = W) => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: scope(workspaceId),
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
/** The dry run as Claude sees it (no approval). */
const preview = (args: Record<string, unknown>, inside = inW) => inside(() => tool.handler!(args, {} as never)) as Promise<{ ok: boolean; preview?: Data; error?: string }>
/** Claude asks: the request waits for a person. */
async function ask(args: Record<string, unknown>): Promise<{ approvalId: string; preview: Data }> {
  return inW(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
    const asked = await runOrQueueTool(TOOL, args, person('u-asker', 'claude'), run.id)
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
    const [row] = await rows<{ preview: Data }>('SELECT preview FROM "AgentApproval" WHERE id = $1', [asked.approvalId])
    return { approvalId: asked.approvalId!, preview: row.preview }
  })
}
/** A person approves (with their authenticator code, as the Approvals page records it, when `code`). */
const approve = (approvalId: string, opts: { code?: boolean } = {}) => inW(async () => {
  if (opts.code) await database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'nexus-step-up' } })
  return decideApproval(approvalId, 'approve', person('u-approver', 'app') as never)
}) as Promise<{ ok: boolean; status?: string; error?: string; result?: Data }>
const reject = (approvalId: string) => inW(() => decideApproval(approvalId, 'reject', person('u-approver', 'app') as never, 'not now'))
const map = () => inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'map', productId: P, market: 'IT' }, {} as never)) as Promise<{ ok: boolean; data: Data }>
const campaignRow = (data: Data, key: string) => data.campaigns.find((c: Data) => c.campaignId === C(key))
const enrollmentRow = async () => (await rows<{ version: number }>('SELECT version FROM "AdsBrainEnrollment" WHERE "workspaceId" = $1 AND "productId" = $2 AND marketplace = \'IT\'', [W, P]))[0] ?? null
const openOverrides = async () => rows<{ scope: string; campaignId: string | null; kind: string; key: string; ref: string; value: unknown; by: string; reason: string | null }>(
  'SELECT scope, "campaignId", kind, key, ref, value, by, reason FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND "endedAt" IS NULL ORDER BY kind, key, scope, "campaignId"', [W])
const modes = async () => Object.fromEntries((await rows<{ campaignId: string; mode: string }>('SELECT "campaignId", mode FROM "BidBrainEnrollment" WHERE "workspaceId" = $1', [W])).map((r) => [r.campaignId, r.mode]))
const bidOf = async (targetId: string) => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', [targetId]))[0].b
const changeOf = async (approvalId: string) => (await rows<{ before: Data; after: Data }>('SELECT before, after FROM "AgentChange" WHERE "approvalId" = $1', [approvalId]))[0]
const amazonQueue = async () => (await rows<{ n: number }>('SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(P, `CTL-JACKET-${hex}`, { isParent: true, name: `Test jacket ${hex}` })
  await product(P1, `CTL-JACKET-M-${hex}`, { parentId: P, amazonAsin: `B0CTLJKM${H}` })
  await product(Q, `CTL-GLOVE-${hex}`, { isParent: true })
  await product(Q1, `CTL-GLOVE-L-${hex}`, { parentId: Q, amazonAsin: `B0CTLGLL${H}` })
  const campaign = async (key: string, ads: Array<{ productId: string; asin: string }>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `Jacket ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `jacket ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    for (const ad of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId: ad.productId, asin: ad.asin } })
  }
  const jacket = { productId: P1, asin: `B0CTLJKM${H}` }
  await campaign('a-live', [jacket])
  await campaign('b-shadow', [jacket])
  await campaign('c-off', [jacket], { liveBidWritesEnabled: false })
  await campaign('e-shared', [jacket, { productId: Q1, asin: `B0CTLGLL${H}` }])
  // The bid brain runs a-live LIVE (put LIVE one by one, before the product is enrolled): its snapshot holds the bid 40;
  // the brain has moved it to 55 since.
  await db.bidBrainEnrollment.create({ data: { campaignId: C('a-live'), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-test', snapshot: { takenAt: '2026-10-08T10:00:00.000Z', adGroups: [], targets: [{ id: `t-${C('a-live')}`, bidCents: 40 }], placements: [] } } })
  await db.adTarget.update({ where: { id: `t-${C('a-live')}` }, data: { bidCents: 55 } })
}

describe.skipIf(!concurrentDatabaseUrl())('set-ads-brain — the Owner\'s control of a product\'s brain, through the approval path (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  let firstEnroll = ''
  const enrollArgs = { op: 'enroll', productId: P1, market: 'IT', levels: { budgets: 'PROPOSE', state: 'AUTO' }, why: 'test enrollment' }

  it('enroll — the preview names every campaign and the adopted AUTO as a big door; every refusal said at once, nothing queued', async () => {
    const refused = await preview({ op: 'enroll', productId: P1, market: 'IT', levels: { structure: 'AUTO', hours: 'AUTO', bids: 'OBSERVE' } })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/^Not queued — 3 refusals: \(1\)/)
    expect(refused.error).toMatch(/the structure lever takes OFF or OBSERVE or PROPOSE today, not AUTO: AB-16: .*never AUTO: the brain never creates, splits or moves a campaign without a person's approval/)
    expect(refused.error).toMatch(/the hours lever takes OFF or OBSERVE or PROPOSE today, not AUTO/)
    expect(refused.error).toMatch(/bids: enrolling adopts the bids lever as its campaigns hold it — AUTO, because the bid brain already runs Jacket a-live LIVE/)
    expect(await rows('SELECT id FROM "AgentApproval" WHERE "workspaceId" = $1', [W])).toEqual([])

    const asked = await ask(enrollArgs)
    firstEnroll = asked.approvalId
    const p = asked.preview
    expect(p).toMatchObject({ action: TOOL, op: 'enroll', brain: { productId: P, market: 'IT', enrolled: false, version: null }, needsCode: true, stepUp: { raises: ['Brain level'] } })
    expect(p.campaigns.map((c: Data) => [c.name, c.owner, c.reached])).toEqual([
      ['Jacket a-live', 'own', true], ['Jacket b-shadow', 'own', true], ['Jacket c-off', 'own', true], ['Jacket e-shared', 'shared', false],
    ])
    expect(p.notReached).toEqual([expect.objectContaining({ name: 'Jacket e-shared', why: expect.stringMatching(/shared campaign: no product's brain owns its levers/) })])
    expect(p.bigDoor).toEqual([expect.stringMatching(/^keyword bids AUTO \(adopted: the bid brain already runs Jacket a-live LIVE\)$/), expect.stringMatching(/^state \(pause, enable, archive\) AUTO$/)])
    expect(p.enroll).toMatchObject({ adoptedBids: 'AUTO', adoptedLive: [C('a-live')], keptInShadow: [C('b-shadow'), C('c-off')], levels: { budgets: 'PROPOSE', state: 'AUTO' } })
    expect(p.raises).toEqual([expect.stringMatching(/may resume campaigns it paused/)])
    expect(p.summary).toMatch(/^Enrolls Test jacket .* in the brain for IT: every lever starts OBSERVE \(shadow\), the keyword bids AUTO as the bid brain already runs 1 campaign LIVE \(adopted\), and state \(pause, enable, archive\) AUTO, daily budget PROPOSE\. It speaks for 3 own campaigns \(1 shared campaign named, owned by no brain\); no campaign moves\.$/)
    expect(p.reachNote).toMatch(/^Nexus only/)
    expect(p.effect).toMatch(/big door: approving it needs the approver's authenticator code/)
    expect(await enrollmentRow()).toBeNull()
  })

  it('rejected: nothing is written', async () => {
    expect(await reject(firstEnroll)).toMatchObject({ ok: true, status: 'rejected' })
    expect(await enrollmentRow()).toBeNull()
    expect(await openOverrides()).toEqual([])
  })

  it('a plain approve of the big door runs nothing; with the code it runs as the approver — no campaign moves, nothing at Amazon, the change recorded', async () => {
    const { approvalId } = await ask(enrollArgs)
    const plain = await approve(approvalId)
    expect(plain.status).not.toBe('executed')
    expect(plain.error).toMatch(/authenticator code/)
    expect(await enrollmentRow()).toBeNull()
    expect(await approve(approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
    expect(await enrollmentRow()).toEqual({ version: 3 })
    const open = await openOverrides()
    expect(open.map((o) => [o.scope, o.campaignId, o.kind, o.key, o.value, o.by])).toEqual([
      ['CAMPAIGN', C('b-shadow'), 'LEVEL', 'bids', 'OBSERVE', 'user:u-approver'],
      ['CAMPAIGN', C('c-off'), 'LEVEL', 'bids', 'OBSERVE', 'user:u-approver'],
      ['PRODUCT', null, 'LEVEL', 'bids', 'AUTO', 'user:u-approver'],
      ['PRODUCT', null, 'LEVEL', 'budgets', 'PROPOSE', 'user:u-approver'],
      ['PRODUCT', null, 'LEVEL', 'state', 'AUTO', 'user:u-approver'],
    ])
    expect(open.find((o) => o.key === 'budgets')?.reason).toContain('test enrollment')
    expect(await modes()).toEqual({ [C('a-live')]: 'LIVE' })
    expect(await amazonQueue()).toBe(0)
    expect(await changeOf(approvalId)).toEqual({
      before: { op: 'enroll', productId: P, market: 'IT', enrolled: false },
      after: { op: 'enroll', productId: P, market: 'IT', enrolled: true, version: 3, levels: { budgets: 'PROPOSE', state: 'AUTO' } },
    })
  })

  it('set-level — AUTO is a big door, OBSERVE on one campaign a normal approval; campaign > product > default in the settings and the map, with who and why; undo asks for the inverse', async () => {
    const auto = await preview({ op: 'set-level', productId: P, market: 'IT', lever: 'budgets', level: 'AUTO' })
    expect(auto.preview).toMatchObject({ needsCode: true, stepUp: { raises: ['Brain level'] }, change: { kind: 'LEVEL', key: 'budgets', from: expect.stringMatching(/^PROPOSE \(the Owner's product override/), to: expect.stringMatching(/^AUTO/) } })
    expect(auto.preview!.turnsAuto.map((t: Data) => t.where)).toEqual(['the product', 'Jacket a-live', 'Jacket b-shadow', 'Jacket c-off'])
    expect(auto.preview!.raises).toEqual([expect.stringMatching(/may raise campaign budgets inside the pace/)])
    expect(auto.preview!.starts[0]).toMatch(/^daily budget: PROPOSE → AUTO — the brain decides each campaign's daily budget/)
    const a = await ask({ op: 'set-level', productId: P, market: 'IT', lever: 'budgets', level: 'AUTO', why: 'test budgets alone' })
    expect(await approve(a.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })

    const one = await ask({ op: 'set-level', productId: P, market: 'IT', campaignId: C('b-shadow'), lever: 'budgets', level: 'OBSERVE', why: 'test keep this one in shadow' })
    expect(one.preview).toMatchObject({ needsCode: false, noCode: expect.any(String), scope: { level: 'campaign', campaignId: C('b-shadow'), owner: 'own' } })
    expect(one.preview.stepUp).toBeUndefined()
    expect(one.preview.campaigns).toEqual([expect.objectContaining({ name: 'Jacket b-shadow', reached: true, changes: [{ what: 'budgets', from: 'AUTO', to: 'OBSERVE (shadow)' }] })])
    expect(one.preview.warnings).toEqual([expect.stringMatching(/Today's engines may write these levers again .* daily budget on Jacket b-shadow/)])
    expect(await approve(one.approvalId)).toMatchObject({ ok: true, status: 'executed' })

    const product = await inW(() => brainSettings(P1, 'IT'))
    const b = await inW(() => brainSettings(P1, 'IT', C('b-shadow')))
    const live = await inW(() => brainSettings(P1, 'IT', C('a-live')))
    expect(product!.levers.budgets.level).toMatchObject({ value: 'AUTO', source: 'product', by: 'user:u-approver' })
    expect(b!.levers.budgets).toMatchObject({ effective: 'OBSERVE', level: { source: 'campaign' } })
    expect(live!.levers.budgets).toMatchObject({ effective: 'AUTO', level: { source: 'product' } })
    const m = (await map()).data
    expect(m.product.levers.budgets).toMatchObject({ level: 'AUTO', effective: 'AUTO', source: 'product', by: 'user:u-approver', reason: expect.stringContaining('test budgets alone') })
    expect(campaignRow(m, 'b-shadow').levers.budgets).toMatchObject({ brain: 'OBSERVE', brainWhy: expect.stringMatching(/OBSERVE by the Owner's campaign override \(user:u-approver/) })
    expect(campaignRow(m, 'a-live').levers.budgets).toMatchObject({ brain: 'AUTO' })

    const change = await changeOf(one.approvalId)
    expect(change.after).toMatchObject({ op: 'set-level', scope: 'CAMPAIGN', campaignId: C('b-shadow'), kind: 'LEVEL', key: 'budgets', open: true, value: 'OBSERVE' })
    expect(await inW(() => tool.undo!.current(change))).toEqual(change.after)
    expect(tool.undo!.request(change)).toEqual({ tool: TOOL, args: expect.objectContaining({ op: 'set-level', lever: 'budgets', reset: true, campaignId: C('b-shadow') }) })
    // The reset that undo would ask for lets the product's AUTO apply on that campaign: a big door.
    expect((await preview({ op: 'set-level', productId: P, market: 'IT', campaignId: C('b-shadow'), lever: 'budgets', reset: true })).preview).toMatchObject({ needsCode: true, bigDoor: [expect.stringMatching(/^daily budget to AUTO on Jacket b-shadow$/)] })
  })

  it('lock / unlock — a whole lever at his value and one hour cell, each in the map with its source; a bad ref and a value out of bounds refused; an unlock that lets AUTO apply again is a big door', async () => {
    const lock = await ask({ op: 'lock', productId: P, market: 'IT', campaignId: C('a-live'), lever: 'budgets', value: { dailyBudgetCents: 2500 }, why: 'test my own budget' })
    expect(lock.preview).toMatchObject({ needsCode: false, change: { kind: 'LOCK', key: 'budgets', from: 'not locked', to: expect.stringMatching(/^locked at dailyBudgetCents 2500/) } })
    expect(lock.preview.campaigns).toEqual([expect.objectContaining({ name: 'Jacket a-live', changes: [{ what: 'budgets', from: 'AUTO', to: 'LOCKED' }] })])
    expect(await approve(lock.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const cell = await ask({ op: 'lock', productId: P, market: 'IT', lever: 'hours', ref: 'hourCell:d1h14' })
    expect(cell.preview.starts).toEqual([expect.stringMatching(/the brain leaves hourCell:d1h14 as it is/)])
    expect(await approve(cell.approvalId)).toMatchObject({ ok: true, status: 'executed' })

    const m = (await map()).data
    expect(campaignRow(m, 'a-live').levers.budgets).toMatchObject({ brain: 'LOCKED', ownerLock: { value: { dailyBudgetCents: 2500 }, source: 'campaign', by: 'user:u-approver', reason: expect.stringContaining('test my own budget') } })
    expect(campaignRow(m, 'a-live').levers.budgets.writers).toEqual(expect.arrayContaining([expect.objectContaining({ who: 'the Owner', state: 'holds' })]))
    expect(m.product.levers.hours.lockedThings).toEqual([expect.objectContaining({ ref: 'hourCell:d1h14', source: 'product' })])
    expect(campaignRow(m, 'b-shadow').levers.hours.writers).toEqual(expect.arrayContaining([expect.objectContaining({ who: 'the Owner', state: 'watches', why: expect.stringMatching(/1 thing locked at his own value \(hourCell:d1h14\)/) })]))

    expect((await preview({ op: 'lock', productId: P, market: 'IT', lever: 'hours', ref: 'hourCell:d9h30' })).error).toMatch(/^Not queued: an hour cell is d<weekday 0-6/)
    expect((await preview({ op: 'lock', productId: P, market: 'IT', lever: 'budgets', value: { dailyBudgetCents: 50 } })).error).toMatch(/budget lock takes \{ dailyBudgetCents \} \(100 to 100,000,000\)/)
    expect((await preview({ op: 'unlock', productId: P, market: 'IT', campaignId: C('a-live'), lever: 'budgets' })).preview).toMatchObject({ needsCode: true, bigDoor: [expect.stringMatching(/^daily budget to AUTO on Jacket a-live$/)] })
  })

  it('exclude / include — a campaign out of the brain (a normal approval), in the map; include brings AUTO back (a big door)', async () => {
    const ex = await ask({ op: 'exclude', productId: P, market: 'IT', campaignId: C('c-off'), why: 'test keep it out' })
    expect(ex.preview).toMatchObject({ needsCode: false, change: { kind: 'EXCLUDE', from: 'in the brain', to: expect.stringMatching(/^excluded \(the Owner's campaign override/) } })
    expect(ex.preview.campaigns[0].changes).toEqual(expect.arrayContaining([{ what: 'state, budgets', from: 'AUTO', to: 'EXCLUDED' }]))
    expect(await approve(ex.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await inW(() => brainSettings(P1, 'IT', C('c-off'))))!.excluded).toMatchObject({ value: true, source: 'campaign' })
    expect(campaignRow((await map()).data, 'c-off').excluded).toMatchObject({ source: 'campaign', by: 'user:u-approver' })
    expect((await preview({ op: 'include', productId: P, market: 'IT', campaignId: C('c-off') })).preview).toMatchObject({ needsCode: true })
  })

  it('set-value — inside its bounds per product and per campaign, a raise said with no code; out of bounds, the wrong scope, a level a lever does not take and nothing-changes refused', async () => {
    expect((await preview({ op: 'set-value', productId: P, market: 'IT', key: 'paceTargetPct', value: 150 })).error).toMatch(/paceTargetPct .* takes a whole number from 10 to 100/)
    expect((await preview({ op: 'set-value', productId: P, market: 'IT', campaignId: C('b-shadow'), key: 'portfolioCapPct', value: 120 })).error).toMatch(/is set per product, not per campaign/)
    expect((await preview({ op: 'set-level', productId: P, market: 'IT', lever: 'offAmazon', level: 'PROPOSE' })).error).toMatch(/the offAmazon lever takes OFF or OBSERVE today, not PROPOSE: the off-Amazon lane waits for AB-18/)
    const pace = await ask({ op: 'set-value', productId: P, market: 'IT', key: 'paceTargetPct', value: 95, why: 'test pace closer' })
    expect(pace.preview).toMatchObject({ needsCode: false, noCode: DAY_TO_DAY_NO_CODE, raises: [expect.stringMatching(/^paceTargetPct 90 → 95: the pace aims at more/)], campaigns: [], reachNote: expect.stringMatching(/^Nexus only/) })
    expect(pace.preview.effect).toMatch(/ADDS SPEND .* a day-to-day change/)
    expect(await approve(pace.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const stop = await ask({ op: 'set-value', productId: P, market: 'IT', campaignId: C('a-live'), key: 'longStopUntil', value: '2026-11-02' })
    expect(await approve(stop.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const m = (await map()).data
    expect(m.product.settings.paceTargetPct).toMatchObject({ paceTargetPct: 95, source: 'product', reason: expect.stringContaining('test pace closer') })
    expect(campaignRow(m, 'a-live').ownSettings).toEqual({ longStopUntil: expect.objectContaining({ longStopUntil: '2026-11-02', source: 'campaign' }) })
    expect(campaignRow(m, 'b-shadow').ownSettings).toBeUndefined()
    expect((await preview({ op: 'set-value', productId: P, market: 'IT', key: 'paceTargetPct', value: 95 })).error).toMatch(/^Not queued: nothing would change — paceTargetPct on Test jacket .* is already 95/)
  })

  it('the keyword bids — OBSERVE takes the LIVE campaign back to shadow (a normal approval, bids stay); AUTO puts it LIVE again (the code), the adopted and the excluded campaigns named as not reached', async () => {
    const obs = await ask({ op: 'set-level', productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE' })
    expect(obs.preview).toMatchObject({ needsCode: false, bids: expect.arrayContaining([expect.objectContaining({ campaignId: C('a-live'), op: 'shadow' })]) })
    expect(obs.preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Jacket a-live goes back to shadow: the bid brain stops writing its keyword bids/)]))
    expect(await approve(obs.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await modes()).toEqual({ [C('a-live')]: 'SHADOW' })
    expect(await bidOf(`t-${C('a-live')}`)).toBe(55)

    const auto = await ask({ op: 'set-level', productId: P, market: 'IT', lever: 'bids', level: 'AUTO' })
    expect(auto.preview).toMatchObject({ needsCode: true, totals: { goLive: 1 } })
    expect(auto.preview.bigDoor).toEqual(expect.arrayContaining([expect.stringMatching(/^1 campaign under the bid brain \(Jacket a-live\)$/)]))
    expect(auto.preview.notReached.map((n: Data) => n.name)).toEqual(['Jacket b-shadow', 'Jacket c-off', 'Jacket e-shared'])
    expect(auto.preview.summary).toMatch(/1 campaign goes LIVE under the bid brain\.$/)
    expect((await approve(auto.approvalId)).status).not.toBe('executed')
    expect(await approve(auto.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
    expect(await modes()).toEqual({ [C('a-live')]: 'LIVE' })
  })

  it('stale — a change approved on another version of the brain does not run', async () => {
    const queued = await ask({ op: 'set-value', productId: P, market: 'IT', key: 'paceTargetPct', value: 85 })
    const other = await ask({ op: 'set-value', productId: P, market: 'IT', key: 'archiveDeadWeeks', value: 6 })
    expect(await approve(other.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const out = await approve(queued.approvalId)
    expect(out.status).not.toBe('executed')
    expect(out.error).toMatch(/changed since/)
    expect((await inW(() => brainSettings(P1, 'IT')))!.values.paceTargetPct.value).toBe(95)
  })

  it('Amazon\'s own budget rule on a campaign refuses its budgets to AUTO there, by name; nothing queued', async () => {
    await inW(() => database.client.adsNativeRuleSnapshot.create({
      data: {
        campaignId: C('b-shadow'), externalCampaignId: `EXT-${C('b-shadow')}`, marketplace: 'IT', fetchedAt: new Date(),
        readings: { budgetRules: { state: 'read', rules: [{ ruleId: 'r-test-1', name: 'Test weekend boost', ruleType: 'SCHEDULE', ruleState: 'ACTIVE', ruleStatus: 'ACTIVE', increasePct: 25, startDate: '20261001', endDate: null, eventName: null, recurrence: 'DAILY', daysOfWeek: ['SATURDAY'], metric: null, comparison: null, threshold: null }] } },
      },
    }))
    const before = (await rows('SELECT id FROM "AgentApproval" WHERE "workspaceId" = $1', [W])).length
    const out = await preview({ op: 'set-level', productId: P, market: 'IT', campaignId: C('b-shadow'), lever: 'budgets', reset: true })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/the budgets lever cannot go AUTO while Amazon's own rule acts on it there — .*"Test weekend boost" on campaign Jacket b-shadow/)
    await inW(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
      expect(await runOrQueueTool(TOOL, { op: 'set-level', productId: P, market: 'IT', campaignId: C('b-shadow'), lever: 'budgets', reset: true }, person('u-asker', 'claude'), run.id)).toMatchObject({ ok: false })
    })
    expect((await rows('SELECT id FROM "AgentApproval" WHERE "workspaceId" = $1', [W])).length).toBe(before)
  })

  it('leave — every lever back to OFF, levels and values ended, his locks and exclusion kept, the LIVE campaign\'s bid given back as the approver; the brain\'s waiting request withdrawn and its pause lifted (a big door); undo asks to enroll again (a big door)', async () => {
    // The bid brain moved the keyword again since it went LIVE (its snapshot holds 55).
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 60 WHERE id = $1', [`t-${C('a-live')}`])
    // Batch 2 fix — what the brain still holds: its own pause of b-shadow (a stock stop), a budget request still waiting for
    // a person, and one a person already refused.
    const pausedAt = new Date(Date.now() - 3 * 86_400_000)
    await inW(async () => {
      const db = database.client
      await db.campaign.update({ where: { id: C('b-shadow') }, data: { status: 'PAUSED' } })
      await db.advertisingActionLog.create({ data: { userId: 'automation:ads-brain-state', actionType: 'AD_CAMPAIGN_UPDATE', entityType: 'CAMPAIGN', entityId: C('b-shadow'), payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'PAUSED' }, amazonResponseStatus: 'SUCCESS', createdAt: pausedAt } })
      await db.adsBrainStateDecision.create({ data: {
        runId: 'run-test', mode: 'LIVE', kind: 'change', productId: P, marketplace: 'IT', campaignId: C('b-shadow'), level: 'AUTO', action: 'keep', outcome: 'none', cause: 'stock', status: 'PAUSED', decisionHash: 'h1', why: 'test pause',
        decision: { memory: { pausedAt: pausedAt.toISOString(), via: 'auto', approvalId: null, statusBefore: 'ENABLED', causes: ['stock'], expectedEndAt: null, stop: {} } },
      } })
      const run = await db.agentRun.create({ data: { agentKey: 'ads-brain-money', trigger: 'schedule', status: 'done' } })
      for (const [key, status] of [['budgets:waiting', 'pending'], ['budgets:refused', 'rejected']] as const) {
        const a = await db.agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-campaign-budget', riskTier: 'high', args: {}, status } })
        await db.adsBrainAsk.create({ data: { key: `${key}:${hex}`, kind: 'budgets', productId: P, marketplace: 'IT', day: new Date('2026-10-08T00:00:00Z'), status: 'asked', approvalId: a.id } })
      }
    })
    const [waiting] = await rows<{ id: string }>('SELECT a.id FROM "AgentApproval" a JOIN "AdsBrainAsk" k ON k."approvalId" = a.id WHERE k."workspaceId" = $1 AND a.status = \'pending\'', [W])
    // Leave keeping the pauses: a normal approval, the pause named with its cause.
    const keep = await preview({ op: 'leave', productId: P1, market: 'IT', pauses: 'keep' })
    expect(keep.preview).toMatchObject({ op: 'leave', needsCode: false, leave: { pauses: 'keep', brainPauses: [expect.objectContaining({ campaignId: C('b-shadow'), causes: ['stock'], resumes: false })] } })
    expect(keep.preview!.stepUp).toBeUndefined()
    expect(keep.preview!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Jacket b-shadow stays paused \(Jacket b-shadow: paused since .* for stock\)/)]))
    const left = await ask({ op: 'leave', productId: P1, market: 'IT', why: 'test take it out' })
    expect(left.preview).toMatchObject({
      op: 'leave', needsCode: true, brain: { enrolled: true },
      leave: {
        bids: 'give-back', giveBack: [expect.objectContaining({ campaignId: C('a-live'), keywordBids: 1, raises: 0 })], toShadow: [], keepLive: [],
        pauses: 'resume', brainPauses: [expect.objectContaining({ campaignId: C('b-shadow'), resumes: true })],
        withdraws: [{ approvalId: waiting.id, tool: 'set-campaign-budget', lever: 'budgets', requestedAt: expect.any(String) }],
      },
    })
    expect(left.preview.bigDoor).toEqual([expect.stringMatching(/lifts the brain's own pause on Jacket b-shadow/)])
    expect(left.preview.stepUp).toMatchObject({ what: expect.stringMatching(/^takes the product out of the ads brain and lifts the brain's own pause/) })
    expect(left.preview.raises).toEqual(expect.arrayContaining([expect.stringMatching(/the brain's own pause lifted on Jacket b-shadow \(spend restarts\)/)]))
    expect(left.preview.leave.keeps.map((k: Data) => `${k.kind}:${k.key}:${k.campaignId ?? 'product'}`).sort()).toEqual([`EXCLUDE:*:${C('c-off')}`, `LOCK:budgets:${C('a-live')}`, 'LOCK:hours:product'])
    expect(left.preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/locks and exclusions stay/), expect.stringMatching(/1 request the brain asked for still waits .*: withdrawn as the product leaves/)]))
    expect(left.preview.summary).toMatch(/^Takes Test jacket .* out of the brain for IT: every lever back to OFF.* 1 request the brain asked for is withdrawn\. 1 campaign the brain paused is resumed\.$/)
    // A plain approve of the big door runs nothing; with the code it runs.
    const plain = await approve(left.approvalId)
    expect(plain.status).not.toBe('executed')
    expect(plain.error).toMatch(/authenticator code/)
    expect(await enrollmentRow()).not.toBeNull()
    expect(await approve(left.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
    // The brain's waiting request is withdrawn; the one a person decided is his.
    expect(await rows('SELECT status, reason FROM "AgentApproval" WHERE id = $1', [waiting.id])).toEqual([{ status: 'rejected', reason: 'withdrawn: the product left the ads brain (set-ads-brain op leave)' }])
    expect(await rows('SELECT a.status FROM "AgentApproval" a JOIN "AdsBrainAsk" k ON k."approvalId" = a.id WHERE k."workspaceId" = $1 ORDER BY a.status', [W])).toEqual([{ status: 'rejected' }, { status: 'rejected' }])
    // The brain's pause lifted as the approver.
    expect(await rows('SELECT status::text AS status FROM "Campaign" WHERE id = $1', [C('b-shadow')])).toEqual([{ status: 'ENABLED' }])
    expect(await rows('SELECT "userId", "payloadAfter" ->> \'status\' AS s FROM "AdvertisingActionLog" WHERE "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [C('b-shadow')])).toEqual([{ userId: 'user:u-approver', s: 'ENABLED' }])

    expect(await enrollmentRow()).toBeNull()
    expect((await openOverrides()).map((o) => `${o.kind}:${o.key}:${o.campaignId ?? 'product'}`).sort()).toEqual([`EXCLUDE:*:${C('c-off')}`, `LOCK:budgets:${C('a-live')}`, 'LOCK:hours:product'])
    expect(await rows('SELECT DISTINCT "endedBy" FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind IN (\'LEVEL\', \'VALUE\') AND "endedAt" IS NOT NULL AND "endedBy" IS NOT NULL ORDER BY 1', [W])).toEqual([{ endedBy: 'user:u-approver' }])
    expect(await modes()).toEqual({ [C('a-live')]: 'SHADOW' })
    expect(await bidOf(`t-${C('a-live')}`)).toBe(55)
    expect(await rows('SELECT "userId", "payloadAfter" ->> \'bidCents\' AS b FROM "AdvertisingActionLog" WHERE "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [`t-${C('a-live')}`])).toEqual([{ userId: 'user:u-approver', b: '55' }])
    const m = (await map()).data
    expect(m.product).toMatchObject({ enrolled: false, levers: { bids: { effective: 'NOT_ENROLLED' }, budgets: { effective: 'NOT_ENROLLED' } } })

    const change = await changeOf(left.approvalId)
    expect(change.after).toEqual({ op: 'leave', productId: P, market: 'IT', enrolled: false })
    expect(await inW(() => tool.undo!.current(change))).toEqual(change.after)
    const back = tool.undo!.request(change) as { tool: string; args: Data }
    expect(back.args).toMatchObject({ op: 'enroll', productId: P, market: 'IT', levels: { budgets: 'AUTO', state: 'AUTO' } })
    expect(back.args.levels.bids).toBeUndefined()
    // Enrolling again with budgets AUTO is refused by name while Amazon's own budget rule still acts on b-shadow (AB-4)…
    expect((await preview(back.args)).error).toMatch(/the budgets lever cannot go AUTO while Amazon's own rule acts on it there — .*"Test weekend boost" on campaign Jacket b-shadow/)
    // …and once it is detached, it is a big door (its AUTO levels), the bids lever as the campaigns hold it now (shadow).
    await database.pool.query('DELETE FROM "AdsNativeRuleSnapshot" WHERE "workspaceId" = $1', [W])
    expect((await preview(back.args)).preview).toMatchObject({ op: 'enroll', needsCode: true, enroll: { adoptedBids: 'OBSERVE' } })
  })

  it('another business finds no product and changes nothing', async () => {
    const before = await openOverrides()
    for (const args of [{ op: 'enroll', productId: P1, market: 'IT' }, { op: 'leave', productId: P, market: 'IT' }, { op: 'set-level', productId: P, market: 'IT', lever: 'budgets', level: 'AUTO' }]) {
      expect(await preview(args, inW2)).toEqual({ ok: false, error: 'Product not found' })
    }
    expect(await inW2(() => database.client.adsBrainOverride.findMany())).toEqual([])
    expect(await openOverrides()).toEqual(before)
  })
})
