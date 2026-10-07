/**
 * ADS AUTONOMY W4-1 — ad-hourly-plans and set-hourly-bid-plan, run for real through the door and the approval gate
 * (PGlite, production schema; the job queue a stub; the ads write gate the real one, sandbox). Made-up ids and values.
 *
 *   read        every plan with whose it is; one plan as a 7 × 24 summary per day, its targets, members, the next 24 h
 *   create      born switched off, through the screen's own save: a version row names the approver; Claude's plan after
 *   paint       a week painted on a plan: the version row, from → to per day; undo paints the old week back
 *   switch      on is a raise: the approver's code, a plain approve is not run; off gives back the floored bids exactly as
 *               the screen does, each write carrying the request as its change set
 *   owners      a person's plan is named (never by rule: the limits refuse it); the playbook's plan is refused
 *   members     one campaign, one plan: a campaign another plan holds needs move; the playbook's never
 *   values      a campaign's own placement %, from → to; a raise when the plan is on; undo sets it back
 *   delete      gives back; undo asks for the plan again, born off
 *   pointers    turn-down-automation and automation-detail name the plan of a rank row
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
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
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { limitsTighten, ruleFrom } from '../claude-trust.service.js'
import { applyValue } from './ads-hourly-plan.tools.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
type Row = Record<string, any>
const db = () => database.client as any
const TOOL = 'set-hourly-bid-plan'

const call = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
const preview = (args: Record<string, unknown>) => call(TOOL, args)
async function ask(args: Record<string, unknown>, tool = TOOL) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  }) as Promise<Row>
}
/** Approve, as a person in Nexus, with their code (nexus-step-up), or as the business's rule (auto). */
async function approve(approvalId: string, via: 'nexus' | 'nexus-step-up' | 'auto' = 'nexus') {
  if (via !== 'nexus') await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { decisionVia: via } }))
  return inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool(TOOL)!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}
const plan = (id: string) => inside(() => db().rankScheduleGroup.findUnique({ where: { id } })) as Promise<Row | null>
const members = (groupId: string) => inside(() => db().adSchedule.findMany({ where: { groupId }, orderBy: { campaignId: 'asc' } })) as Promise<Row[]>
const versions = (groupId: string) => inside(() => db().rankScheduleVersion.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } })) as Promise<Row[]>

const WEEK = [{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 6, targetKey: 'test-floor' }, { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'test-push' }]
const ids = { person: '', book: '', bookSchedule: '', personSchedule: '' }

/** One SP campaign in IT with one ad group and one keyword. */
async function campaign(id: string, extra: Record<string, unknown> = {}) {
  await db().campaign.create({ data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
  await db().adGroup.create({ data: { id: `g-${id}`, campaignId: id, name: `group ${id}`, externalAdGroupId: `EXT-g-${id}`, defaultBidCents: 30 } })
  await db().adTarget.create({ data: { id: `t-${id}`, adGroupId: `g-${id}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `term ${id}`, bidCents: 45, externalTargetId: `EXT-t-${id}` } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(db())
    for (const id of ['c-h1', 'c-h2', 'c-h3', 'c-h4', 'c-h5', 'c-own', 'c-book']) await campaign(id)
    await db().rankTarget.create({ data: { key: 'test-floor', name: 'Test min bid', pause: true } })
    await db().rankTarget.create({ data: { key: 'test-top', name: 'Test top', biasPct: 50 } })
    await db().rankTarget.create({ data: { key: 'test-push', name: 'Test push', biasPct: 150, bidMode: 'absolute', bidValueCents: 80 } })
    // A person's plan (made on the screen, on), holding c-h1.
    const own = await db().rankScheduleGroup.create({ data: { name: 'Test person plan', marketplace: 'IT', windows: WEEK, defaultTargetKey: 'test-top', enabled: true } })
    ids.person = own.id
    ids.personSchedule = (await db().adSchedule.create({ data: { campaignId: 'c-h1', name: 'Test c-h1 — Test person plan', windows: WEEK, defaultTargetKey: 'test-top', enabled: true, groupId: own.id } })).id
    await db().rankScheduleVersion.create({ data: { groupId: own.id, name: own.name, windows: WEEK, defaultTargetKey: 'test-top', campaignCount: 1, enabled: true, changedBy: 'user:anonymous' } })
    // The ads playbook's plan, holding c-book.
    const book = await db().rankScheduleGroup.create({ data: { name: 'TESTBOOK | IT | Playbook Research', marketplace: 'IT', windows: [], defaultTargetKey: 'test-top', enabled: false } })
    ids.book = book.id
    ids.bookSchedule = (await db().adSchedule.create({ data: { campaignId: 'c-book', name: 'Test c-book', windows: [], defaultTargetKey: 'test-top', enabled: false, groupId: book.id } })).id
    await db().adsPlaybookLink.create({ data: { playbookId: 'test-playbook-row', kind: 'rankGroup', key: 'rank:research', refId: book.id, origin: 'built', compiledVersion: 1, updatedBy: 'user:test' } })
    // IT has an ads strategy that lets changes run by rule today (C1, C5); the tool's own limits still decide.
    await db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, version: 1, updatedBy: 'user:test' } })
    // A campaign with a schedule of its own (no plan).
    await db().adSchedule.create({ data: { campaignId: 'c-own', name: 'Test own schedule', windows: [{ days: [1], startHour: 0, endHour: 6 }], enabled: true } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('the tools as the contract holds them', () => {
  it('set-hourly-bid-plan: strategy-bound, alwaysAsk, ceiling auto, undoable in part; at ask by default; its limits run nothing alone', () => {
    const tool = getTool(TOOL)!
    expect(tool).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'partial', openWorld: true, readOnly: false, requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
    expect(ruleFrom(tool, null).level).toBe('ask')
    expect(tool.limits!.parse({})).toEqual({ maxItems: 0, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, markets: [], campaignIds: [], allowRaise: false, maxPlacementPct: 0, maxBaseBidCents: 0, allowPeoplesPlans: false, allowDelete: false })
    // A shorter campaign list is a tighter one (no code), and an empty one refuses everything by rule.
    expect(limitsTighten(tool, { campaignIds: ['c1', 'c2'] }, { campaignIds: ['c1'] })).toBe(true)
    expect(limitsTighten(tool, { campaignIds: [] }, { campaignIds: ['c1'] })).toBe(false)
    expect(getTool('ad-hourly-plans')).toMatchObject({ readOnly: true, openWorld: false, requires: ['ads.view'] })
  })

  it('a campaign\'s own values: a value set, null back to the library\'s, the keys it does not set kept, clear drops them', () => {
    const held = { biasPct: 40, stepUpPct: 10 }
    expect(applyValue(held, { targetKey: 'k', placementPct: 80 })).toEqual({ biasPct: 80, stepUpPct: 10 })
    expect(applyValue(held, { targetKey: 'k', placementPct: null })).toEqual({ stepUpPct: 10 })
    expect(applyValue(undefined, { targetKey: 'k', baseBidCents: 70 })).toEqual({ bidMode: 'absolute', bidValueCents: 70 })
    expect(applyValue({ bidMode: 'absolute', bidValueCents: 70 }, { targetKey: 'k', holdBaseBid: true })).toEqual({ bidMode: 'hold' })
    expect(applyValue(held, { targetKey: 'k', clear: true })).toBeNull()
  })
})

describe('ad-hourly-plans — the read', () => {
  it('every plan, with whose it is and its week in numbers', async () => {
    const r = await call('ad-hourly-plans', {})
    expect(r.ok).toBe(true)
    const byName = Object.fromEntries((r.data.items as Row[]).map((i) => [i.name, i]))
    expect(byName['Test person plan']).toMatchObject({
      planId: ids.person, market: 'IT', on: true, members: 1,
      owner: { by: 'person', words: expect.stringMatching(/^a person on the Hourly Bids page \(not named\) — last changed /) },
      week: { hoursAtFloor: 30, hoursPlanned: 168, highestPlacementPct: 150, highestBaseBidCents: 80 },
    })
    expect(byName['TESTBOOK | IT | Playbook Research']).toMatchObject({ owner: { by: 'playbook', words: expect.stringContaining('rank:research') } })
    expect((await call('ad-hourly-plans', { status: 'off' })).data.items.map((i: Row) => i.name)).not.toContain('Test person plan')
  })

  it('one plan as a 7 × 24 summary per day, its targets, its members, the next 24 hours; found by a campaign too', async () => {
    const r = await call('ad-hourly-plans', { campaignId: 'c-h1' })
    expect(r.ok).toBe(true)
    expect(r.data.plan).toMatchObject({ planId: ids.person, name: 'Test person plan', on: true, timezone: 'Europe/Rome' })
    expect(r.data.week.days[0]).toMatchObject({ day: 'Mon', hours: 'AAAAAABBBBBBBBBBBBCCCCBB', hoursAtFloor: 6, highestPlacementPct: 150, highestBaseBidCents: 80 })
    expect(r.data.week.legend).toEqual({ A: 'test-floor (Test min bid)', B: 'test-top (Test top)', C: 'test-push (Test push)' })
    expect(r.data.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'test-floor', minBid: true, floorBidCents: null }),
      expect.objectContaining({ key: 'test-push', placementPct: 150, bidMode: 'absolute', bidValueCents: 80 }),
    ]))
    expect(r.data.members).toEqual([expect.objectContaining({ campaignId: 'c-h1', name: 'Test c-h1', status: 'ENABLED', liveWrites: true, scheduleOn: true })])
    expect(r.data.next24h.length).toBeGreaterThan(0)
    expect(r.data.ifSwitchedOffOrDeleted).toMatchObject({ restore: 0 })
    expect(r.data.change).toMatch(/set-hourly-bid-plan/)
    expect((await call('ad-hourly-plans', { campaignId: 'c-own' })).error).toMatch(/schedule of its own, not a plan/)
  })
})

describe('set-hourly-bid-plan — create, paint, switch', () => {
  let planId = ''

  it('create: born switched off through the screen\'s save; a version row names the approver; Claude\'s plan after', async () => {
    const p = (await preview({ op: 'create', name: 'Test claude plan', market: 'IT', campaignIds: ['c-h2', 'c-h3'], windows: WEEK, defaultTargetKey: 'test-top' })).preview
    expect(p).toMatchObject({
      action: TOOL, op: 'create', plan: { planId: null, name: 'Test claude plan', market: 'IT', timezone: 'Europe/Rome', enabled: { from: null, to: false } },
      owner: { by: 'new' }, peoplesPlans: [], raises: [], members: { from: 0, to: 2 },
      reach: { reach: 'sandbox' }, consequences: expect.stringMatching(/^Nexus only/),
      limitFacts: { tool: TOOL, action: 'hourly' },
    })
    expect(p.week).toHaveLength(7)
    expect(p.week[0]).toMatchObject({ day: 'Mon', to: { hours: 'AAAAAABBBBBBBBBBBBCCCCBB', hoursAtFloor: 6 } })
    expect(p.stepUp).toBeUndefined()
    expect(p.effect).toMatch(/^Creates the hourly plan "Test claude plan" in IT over 2 campaigns, switched OFF/)
    expect(judge(p)).toMatch(/limits name no market where a plan change may run by rule \(markets is empty\)/)
    expect(judge(p, { markets: ['IT'] })).toMatch(/limits name no campaign whose plan changes may run by rule \(campaignIds is empty\)/)
    expect(judge(p, { markets: ['IT'], campaignIds: ['c-h2'] })).toMatch(/1 campaign it touches is not on this tool's list of campaigns/)
    const mine = { markets: ['IT'], campaignIds: ['c-h2', 'c-h3'] }
    expect(judge(p, mine)).toMatch(/the plan holds a placement of 150 % in some hour, above the 0 % this tool's limits allow by rule/)
    expect(judge(p, { ...mine, maxPlacementPct: 900, maxBaseBidCents: 10_000 })).toMatch(/more than the 0 this tool's limits allow/)

    const asked = await ask({ op: 'create', name: 'Test claude plan', market: 'IT', campaignIds: ['c-h2', 'c-h3'], windows: WEEK, defaultTargetKey: 'test-top' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { op: 'create', enabled: false, members: 2 } })
    const made = await inside(() => db().rankScheduleGroup.findFirst({ where: { name: 'Test claude plan' } }))
    planId = made.id
    expect(made).toMatchObject({ enabled: false, marketplace: 'IT', defaultTargetKey: 'test-top', createdBy: 'user:u-approver' })
    expect((await members(planId)).map((m) => [m.campaignId, m.enabled])).toEqual([['c-h2', false], ['c-h3', false]])
    expect(await versions(planId)).toEqual([expect.objectContaining({ changedBy: 'user:u-approver', enabled: false, campaignCount: 2 })])
    const listed = (await call('ad-hourly-plans', {})).data.items.find((i: Row) => i.planId === planId)
    expect(listed.owner).toMatchObject({ by: 'claude', words: expect.stringContaining(asked.approvalId) })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId }))).toMatchObject({ request: { tool: TOOL, args: { op: 'delete', planId } } })
  })

  it('paint: given days only, from → to per day, a version row for the change; undo paints the old week back', async () => {
    const args = { op: 'update-windows', planId, days: [1], windows: [{ days: [1], startHour: 8, endHour: 12, targetKey: 'test-push' }] }
    const p = (await preview(args)).preview
    // The plan is off: a new week adds nothing at Amazon until it is switched on.
    expect(p).toMatchObject({ op: 'update-windows', raises: [], owner: { by: 'claude' }, consequences: expect.stringMatching(/the plan is off/) })
    expect(p.week[0]).toMatchObject({ day: 'Mon', from: { hoursAtFloor: 6 }, to: { hoursAtFloor: 0 } })
    expect(p.week[1].from).toEqual(p.week[1].to)
    const asked = await ask(args)
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const now = await plan(planId)
    expect(now!.windows[0]).toEqual({ days: [1], startHour: 8, endHour: 12, targetKey: 'test-push' })
    // The members the engine reads hold the new week too (the screen's own save, never the group row alone).
    expect((await members(planId))[0].windows).toEqual(now!.windows)
    expect(await versions(planId)).toHaveLength(2)
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId }))
    expect(undo).toMatchObject({ request: { tool: TOOL, args: { op: 'update-windows', planId, windows: WEEK, defaultTargetKey: 'test-top' } } })
    expect(await approve((await ask(undo.request.args)).approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await plan(planId))!.windows).toEqual(WEEK)
  })

  it('switch on is a raise: the approver\'s code; a plain approve is not run, with the code it runs', async () => {
    const p = (await preview({ op: 'switch', planId, on: true })).preview
    expect(p.raises[0]).toMatch(/^switches the plan on: from the hourly bid engine's next run it holds its week on 2 campaigns/)
    expect(p.stepUp).toMatchObject({ what: 'switches an hourly bid plan on', raises: ['Hourly bid plans'] })
    expect(judge(p, { maxItems: 5, markets: ['IT'], campaignIds: ['c-h2', 'c-h3'] })).toMatch(/allowRaise is off/)
    const plain = await ask({ op: 'switch', planId, on: true })
    expect(await approve(plain.approvalId)).toMatchObject({ ok: false })
    expect((await plan(planId))!.enabled).toBe(false)
    const coded = await ask({ op: 'switch', planId, on: true })
    expect(await approve(coded.approvalId, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed', result: { enabled: true } })
    expect((await members(planId)).every((m) => m.enabled)).toBe(true)
    expect((await versions(planId)).at(-1)).toMatchObject({ enabled: true, changedBy: 'user:u-approver' })
  })

  it('values: a campaign\'s own placement %, from → to; a raise when the plan is on; undo sets it back', async () => {
    const args = { op: 'set-target-values', planId, values: [{ campaignId: 'c-h2', targetKey: 'test-top', placementPct: 80 }] }
    const p = (await preview(args)).preview
    expect(p.targetValues).toEqual([expect.objectContaining({ campaignId: 'c-h2', targetKey: 'test-top', from: expect.objectContaining({ placementPct: 50 }), to: expect.objectContaining({ placementPct: 80 }), raises: ['a higher placement %'] })])
    expect(p.raises).toEqual(["1 campaign holds a higher placement % in the plan's hours"])
    expect(p.highest.placementPct).toBe(150)
    const asked = await ask(args)
    expect(await approve(asked.approvalId, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed' })
    expect((await members(planId)).find((m) => m.campaignId === 'c-h2')!.targetOverrides).toEqual({ 'test-top': { biasPct: 80 } })
    // A version row even though only a campaign's values moved (Claude's change always leaves one).
    expect((await versions(planId)).at(-1)).toMatchObject({ changedBy: 'user:u-approver' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId }))).toMatchObject({ request: { tool: TOOL, args: { op: 'set-target-values', planId, values: [{ campaignId: 'c-h2', targetKey: 'test-top', clear: true }] } } })
  })

  it('switch off gives back the floored bids as the screen does, each write carrying the request as its change set', async () => {
    // The engine floored c-h3 during a Min-bid hour: its keyword at 2 cents, 45 remembered.
    const schedule = (await members(planId)).find((m) => m.campaignId === 'c-h3')!
    await inside(async () => {
      await db().campaign.update({ where: { id: 'c-h3' }, data: { bidsSuppressedAt: new Date(), bidsSuppressedBy: `automation:rank-defend-${schedule.id}`, bidsSuppressedFloorCents: 2 } })
      await db().adTarget.update({ where: { id: 't-c-h3' }, data: { bidCents: 2, suppressedFromBidCents: 45 } })
    })
    const p = (await preview({ op: 'switch', planId, on: false })).preview
    expect(p).toMatchObject({
      givesBack: { restore: 1, bids: 1, bidLines: [expect.objectContaining({ campaign: 'Test c-h3', currentCents: 2, backCents: 45 })] },
      consequences: expect.stringMatching(/^At Amazon now: the bids the plan floored on 1 campaign come back/),
    })
    expect(p.raises).toEqual([expect.stringMatching(/^gives back the bids it floored on 1 campaign \(1 bid leave the Min-bid floor\)/)])
    expect(p.stepUp).toMatchObject({ what: 'gives back bids an hourly bid plan floored', raises: ['Hourly bid plans', 'Bids'] })
    const asked = await ask({ op: 'switch', planId, on: false })
    expect(await approve(asked.approvalId, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed', result: { enabled: false, givesBack: { restored: 1 } } })
    const [camp, target] = await inside(() => Promise.all([db().campaign.findUnique({ where: { id: 'c-h3' } }), db().adTarget.findUnique({ where: { id: 't-c-h3' } })]))
    expect(camp.bidsSuppressedAt).toBeNull()
    expect(target).toMatchObject({ bidCents: 45, suppressedFromBidCents: null })
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: 't-c-h3' } }))
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((l: Row) => l.executionId === asked.approvalId && l.userId === `automation:rank-defend-${schedule.id}`)).toBe(true)
  })
})

describe('set-hourly-bid-plan — members', () => {
  it('add and take out in one request, from → to; undo adds back and takes out the other way', async () => {
    const made = await inside(() => db().rankScheduleGroup.findFirst({ where: { name: 'Test claude plan' } }))
    const args = { op: 'set-campaigns', planId: made.id, add: ['c-h4'], remove: ['c-h2'] }
    const p = (await preview(args)).preview
    expect(p).toMatchObject({ members: { from: 2, to: 2, added: [{ campaignId: 'c-h4', from: null }], removed: [{ campaignId: 'c-h2' }] }, raises: [] })
    expect(p.effect).toMatch(/^Adds 1 campaign and takes 1 campaign out of the hourly plan "Test claude plan" \(2 → 2\)/)
    expect((await preview({ op: 'set-campaigns', planId: made.id, remove: ['c-h1'] })).error).toMatch(/not in "Test claude plan"/)
    expect((await preview({ op: 'set-campaigns', planId: made.id, remove: ['c-h2', 'c-h3'] })).error).toMatch(/holding no campaign: delete it instead/)
    const asked = await ask(args)
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await members(made.id)).map((m) => m.campaignId)).toEqual(['c-h3', 'c-h4'])
    // A version row even with the same count (Claude's change always leaves one).
    expect((await versions(made.id)).at(-1)).toMatchObject({ campaignCount: 2, changedBy: 'user:u-approver' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId }))).toMatchObject({ request: { tool: TOOL, args: { op: 'set-campaigns', planId: made.id, add: ['c-h2'], remove: ['c-h4'] } } })
  })
})

describe('set-hourly-bid-plan — whose plan, and which campaigns', () => {
  it('a person\'s plan is named, and its change never runs by rule while allowPeoplesPlans is off', async () => {
    const p = (await preview({ op: 'rename', planId: ids.person, name: 'Test person plan renamed' })).preview
    expect(p).toMatchObject({ owner: { by: 'person' }, peoplesPlans: ['Test person plan'], raises: [], rename: { from: 'Test person plan', to: 'Test person plan renamed' } })
    const open = { maxItems: 5, markets: ['IT'], campaignIds: ['c-h1'], allowRaise: true, maxPlacementPct: 900, maxBaseBidCents: 10_000, allowEngineOwned: true }
    expect(judge(p, open)).toMatch(/made or last changed by a person: a person's hourly plan changes only with a person's approval \(allowPeoplesPlans is off\)/)
    expect(judge(p, { ...open, allowPeoplesPlans: true })).toBeNull()
  })

  it('the playbook\'s plan is refused, naming apply-ads-playbook; its campaign is never taken, even with move', async () => {
    expect((await preview({ op: 'switch', planId: ids.book, on: true })).error).toMatch(/is the ads playbook's hourly plan \(rank:research.*Change it with apply-ads-playbook/)
    expect((await preview({ op: 'create', name: 'Test taker', market: 'IT', campaignIds: ['c-book'], defaultTargetKey: 'test-top', move: true })).error)
      .toMatch(/"Test c-book" is held by the ads playbook's hourly plan: one campaign, one plan/)
  })

  it('one campaign, one plan: another plan\'s campaign or one with a schedule of its own needs move; with move the person\'s plan is named', async () => {
    expect((await preview({ op: 'create', name: 'Test taker', market: 'IT', campaignIds: ['c-h1'], defaultTargetKey: 'test-top' })).error)
      .toMatch(/one campaign, one plan — "Test c-h1" \(hourly plan "Test person plan"\) is held already\. Ask again with move: true/)
    expect((await preview({ op: 'create', name: 'Test taker', market: 'IT', campaignIds: ['c-own'], defaultTargetKey: 'test-top' })).error)
      .toMatch(/"Test c-own" \(a schedule of its own\)/)
    const moved = (await preview({ op: 'create', name: 'Test taker', market: 'IT', campaignIds: ['c-h1'], defaultTargetKey: 'test-top', move: true })).preview
    expect(moved).toMatchObject({ peoplesPlans: ['Test person plan'], members: { added: [{ campaignId: 'c-h1', from: 'hourly plan "Test person plan"' }] } })
    expect(moved.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/It takes "Test c-h1" out of "Test person plan" \(move\)/)]))
    expect((await preview({ op: 'create', name: 'Test person plan', market: 'IT', campaignIds: ['c-h5'], defaultTargetKey: 'test-top' })).error).toMatch(/A plan called "Test person plan" exists already/)
    expect((await preview({ op: 'create', name: 'Test uk', market: 'IT', campaignIds: ['c-uk'], defaultTargetKey: 'test-top' })).error).toMatch(/"UK exact" is in UK, not IT/)
    expect((await preview({ op: 'create', name: 'Test sb', market: 'IT', campaignIds: ['c-sb'], defaultTargetKey: 'test-top' })).error).toMatch(/not a Sponsored Products campaign/)
    expect((await preview({ op: 'create', name: 'Test gone', market: 'IT', campaignIds: ['c-h5'], windows: [{ days: [1], startHour: 0, endHour: 6, targetKey: 'test-gone' }] })).error).toMatch(/There is no rank target "test-gone"/)
  })
})

describe('set-hourly-bid-plan — delete, and the pointers from the engine\'s rows', () => {
  it('delete gives back; undo asks for the plan again, born off', async () => {
    const asked = await ask({ op: 'create', name: 'Test short plan', market: 'IT', campaignIds: ['c-h5'], windows: WEEK, defaultTargetKey: 'test-top' })
    await approve(asked.approvalId)
    const made = await inside(() => db().rankScheduleGroup.findFirst({ where: { name: 'Test short plan' } }))
    const p = (await preview({ op: 'delete', planId: made.id })).preview
    expect(p).toMatchObject({ op: 'delete', givesBack: { campaigns: 1 }, effect: expect.stringMatching(/^Deletes the hourly plan "Test short plan"/) })
    expect(judge(p, { maxItems: 5, markets: ['IT'], campaignIds: ['c-h5'], allowEngineOwned: true })).toMatch(/allowDelete is off/)
    const gone = await ask({ op: 'delete', planId: made.id })
    expect(await approve(gone.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { deleted: true } })
    expect(await plan(made.id)).toBeNull()
    expect(await inside(() => undoRequestFor({ approvalId: gone.approvalId }))).toMatchObject({
      request: { tool: TOOL, args: { op: 'create', name: 'Test short plan', market: 'IT', campaignIds: ['c-h5'], windows: WEEK, defaultTargetKey: 'test-top', timezone: 'Europe/Rome' } },
    })
  })

  it('turn-down-automation on a plan\'s row names the plan and set-hourly-bid-plan; automation-detail points to it', async () => {
    const down = await call('turn-down-automation', { automation: 'A10', rowId: ids.personSchedule, level: 'OFF' })
    expect(down.error).toBe(`The hourly bid plans switch as a whole here (leave rowId out for the engine's own switch). To switch ONE plan, ask set-hourly-bid-plan {"op":"switch","planId":"${ids.person}","on":false} — row ${ids.personSchedule} is in the plan "Test person plan" (now on).`)
    const detail = await call('automation-detail', { automation: 'A10', rowId: ids.personSchedule })
    expect(detail.data.hourlyPlan).toMatchObject({ planId: ids.person, name: 'Test person plan', on: true })
    expect((await call('automation-detail', { automation: 'A10', rowId: ids.person })).data.hourlyPlan).toMatchObject({ planId: ids.person })
  })
})
