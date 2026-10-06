/**
 * ADS PLAYBOOK PB-5a — apply-ads-playbook, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one, sandbox). The SP Super Wizard launch is a stand-in that
 * makes the campaigns in Nexus (ads-sp-wizard-launch.vitest.test.ts proves the launch itself). Values are made up.
 *
 *   preview   op build: every campaign it makes (slot, budget, start bid, counts), born at the floor and off the
 *             allowlist, placements at START, where it lands, the strategy's facts; refused and not queued when the
 *             product is not enrolled, the row moved (expectVersion) or nothing is missing
 *   by rule   the default limits refuse a build (maxCampaigns 0); inside the strategy and limits it may run; an adopt
 *             (Nexus only) is not narrowed by the strategy
 *   approved  a build answers RUNNING with its run at once and runs detached; approval-status follows the run; a basis
 *             that moved after approval is not run
 *   undo      a build: archive-ads of every campaign it made (buildRunId; refused while the build runs); an adopt: the
 *             opposite adopt
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { seedProductPlaybook } from '../../../test-support/ads-playbook-fixtures.js'
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
/** The wizard's launch, as a stand-in that makes each campaign and its ad group in Nexus (sandbox ids). */
const launches = vi.hoisted(() => ({ calls: 0, hold: null as null | Promise<void> }))
vi.mock('../../advertising/ads-sp-wizard-launch.service.js', () => ({
  spWizardLaunch: async (body: any) => {
    launches.calls++
    if (launches.hold) await launches.hold
    const prisma = (await import('../../../db.js')).default as any
    const created: any[] = []
    const slots: Record<string, { campaignId: string; adGroupId: string }> = {}
    for (const c of body.campaigns) {
      const camp = await prisma.campaign.create({ data: { name: c.name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: body.market, dailyBudget: String(c.budgetEur), startDate: new Date(), externalCampaignId: `SBX-${c.name}` } })
      const g = await prisma.adGroup.create({ data: { campaignId: camp.id, name: c.adGroupName, externalAdGroupId: `SBX-G-${c.name}` } })
      created.push({ name: c.name, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, mode: 'sandbox' })
      slots[c.id] = { campaignId: camp.id, adGroupId: g.id }
    }
    return { status: 200, body: { ok: true, created, slots, deferredPlacements: [], launch: { ok: true, campaigns: created.map((c) => ({ name: c.name, status: 'live', reason: null })) }, verification: { ok: true, problems: [] } } }
  },
}))
vi.mock('../../advertising/ads-portfolio.service.js', () => ({
  createPortfolio: async (input: { name: string }) => ({ portfolio: { portfolioId: 'pf-apply-test', name: input.name }, mode: 'live' }),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
type Row = Record<string, any>
const db = () => database.client
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const finished = async (applicationId: string) => {
  await vi.waitFor(async () => {
    const row = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 10_000, interval: 50 })
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool('apply-ads-playbook')!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}

let built: Awaited<ReturnType<typeof seedProductPlaybook>>
let moved: Awaited<ReturnType<typeof seedProductPlaybook>>
let adopted: Awaited<ReturnType<typeof seedProductPlaybook>>
const build = (productId: string, extra: Record<string, unknown> = {}) => ({ op: 'build', market: 'IT', productId, ...extra })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(db())
    built = await seedProductPlaybook(db(), { token: 'TESTAPA', asinPrefix: 'B0TESTAA' })
    moved = await seedProductPlaybook(db(), { token: 'TESTAPB', asinPrefix: 'B0TESTAB' })
    adopted = await seedProductPlaybook(db(), { token: 'TESTAPC', asinPrefix: 'B0TESTAC' })
    // The market strategy lets changes run by rule today (C5): the default limits of the tool still hold a build.
    await db().adsStrategy.updateMany({ where: { market: 'IT', level: 'MARKET' }, data: { claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000 } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('the build preview, and what refuses it', () => {
  it('every campaign it makes, born at the floor and off the allowlist, placements at START, where it lands, the facts', async () => {
    const r = await preview('apply-ads-playbook', build(built.parent))
    expect(r.ok).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'apply-ads-playbook', op: 'build', market: 'IT', product: { productId: built.parent }, playbook: { id: built.rowId, version: 1, state: 'DRAFT' },
      currency: 'EUR', dailyBudgetCents: expect.any(Number), liveWrites: false, startsSuppressed: { floorCents: 2 }, reach: { reach: 'sandbox' },
      portfolio: { name: 'Test TESTAPA IT', does: 'create' }, limitFacts: { tool: 'apply-ads-playbook', action: 'create' },
      effect: expect.stringMatching(/^Builds 5 Sponsored Products campaigns of TEST-TESTAPA-PARENT's playbook in IT through the SP Super Wizard's launch/),
      undoNote: expect.stringMatching(/archive-ads buildRunId/),
    })
    expect((r.preview as Row).campaigns.map((c: Row) => [c.slot, c.placementsAtStart])).toEqual([['auto', 0], ['broad-category', 0], ['exact-category', 1], ['exact-brand', 0], ['pat', 2]])
    // PB-8 — one hourly plan per rank role for the campaigns it makes, switched off until START.
    expect((r.preview as Row).artifacts.map((a: Row) => [a.kind, a.key, a.does])).toEqual([['rankGroup', 'rank:performance', 'create'], ['rankGroup', 'rank:research', 'create']])
    expect((r.preview as Row).artifacts[0].summary).toMatch(/for the campaigns this build makes for exact-category, exact-brand .*switched OFF with its campaigns: nothing runs until START\.$/)
    expect(getTool('apply-ads-playbook')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', reversibility: 'partial', openWorld: true, readOnly: false })
  })

  it('refused, and not queued: not enrolled, the row moved (expectVersion), one slot asked that is not in the playbook', async () => {
    await inside(() => db().adsPlaybook.update({ where: { id: moved.rowId }, data: { enrolled: false } }))
    expect((await preview('apply-ads-playbook', build(moved.parent))).error).toMatch(/is not enrolled in its playbook in IT: a person includes it first/)
    await inside(() => db().adsPlaybook.update({ where: { id: moved.rowId }, data: { enrolled: true } }))
    expect((await preview('apply-ads-playbook', build(moved.parent, { expectVersion: 7 }))).error).toMatch(/moved since you read it/)
    expect((await preview('apply-ads-playbook', build(moved.parent, { slots: ['nope'] }))).error).toMatch(/The playbook has no slot "nope"/)
    expect((await inside(() => db().agentApproval.count()))).toBe(0)
  })

  it('by rule: the default limits refuse a build; inside the strategy and its limits it may run; an adopt is not narrowed', async () => {
    const p = (await preview('apply-ads-playbook', build(built.parent))).preview as Row
    expect(judge(p)).toMatch(/it creates 5 campaigns, more than the 0 this tool's limits let a build create by rule \(0: every build waits for a person\)/)
    const roomy = { maxCampaigns: 5, maxDailyBudgetCents: 100_000, maxBidCents: 100 }
    expect(judge(p, roomy)).toBeNull()
    expect(judge(p, { ...roomy, maxBidCents: 10 })).toMatch(/its highest planned bid EUR 0\.\d\d is above the EUR 0\.10/)
    expect(judge(p, { ...roomy, markets: ['DE'] })).toMatch(/only in DE/)
    expect(judge({ summary: 'no op' }, roomy)).toMatch(/there is no preview of this playbook apply/)
    expect(judge({ op: 'adopt', market: 'IT' })).toBeNull()
  })
})

describe('approved, a build runs on its own', () => {
  let approvalId = ''
  let applicationId = ''
  it('answers RUNNING with its run at once; the campaigns land, linked; approval-status follows the run', async () => {
    const asked = await ask('apply-ads-playbook', build(built.parent, { why: 'build the test playbook' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    approvalId = asked.approvalId!
    const done = await approve(approvalId) as Row
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', applicationId: expect.any(String), changeSetId: approvalId } })
    applicationId = done.result.applicationId
    await finished(applicationId)
    const run = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
    expect(run).toMatchObject({ status: 'APPLIED', playbookId: built.rowId, actor: 'user:u-approver' })
    expect((run.options as Row)).toMatchObject({ changeSetId: approvalId, requester: 'user:u-asker', compiledVersion: 1 })
    const s = (await inside(() => callTool(claude, 'approval-status', { approvalId }))).visible.data as Row
    expect(s.ads).toMatchObject({ reach: 'sandbox', build: { applicationId, status: 'APPLIED', campaigns: 5 }, created: { atAmazon: 0 } })
    const view = (await inside(() => callTool(claude, 'ads-playbook', { view: 'build', applicationId }))).visible as Row
    expect(view.data.run).toMatchObject({ applicationId, status: 'APPLIED', created: expect.arrayContaining([expect.objectContaining({ atAmazon: true })]) })
    expect(view.data.run.created).toHaveLength(5)
  })

  it('undo: archive-ads of every campaign the build made (buildRunId), a new request a person approves', async () => {
    expect(await inside(() => undoRequestFor({ approvalId }))).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId } } })
    const archive = await preview('archive-ads', { buildRunId: applicationId })
    expect(archive.ok).toBe(true)
    expect((archive.preview as Row).totals).toMatchObject({ changing: 5 })
    expect(archive.preview).toMatchObject({ permanent: expect.stringMatching(/^PERMANENT/) })
  })

  it('nothing is left to build; a build still running is not archived', async () => {
    expect((await preview('apply-ads-playbook', build(built.parent))).error).toMatch(/^Nothing to build: every slot of the playbook is held by a live campaign/)
    const running = await inside(() => db().adBlueprintApplication.create({ data: { productToken: 'TESTAPA', marketplace: 'IT', status: 'RUNNING', plan: {}, playbookId: built.rowId, createdCampaignIds: [] } }))
    expect((await preview('archive-ads', { buildRunId: running.id })).error).toMatch(/that build is still running/)
    expect((await preview('archive-ads', { buildRunId: 'no-such-build' })).error).toMatch(/Playbook build no-such-build not found in this business/)
    await inside(() => db().adBlueprintApplication.update({ where: { id: running.id }, data: { status: 'FAILED' } }))
  })

  it('a playbook that moved after approval is not run, and nothing is built', async () => {
    const before = launches.calls
    const asked = await ask('apply-ads-playbook', build(moved.parent))
    await inside(() => db().adsPlaybook.update({ where: { id: moved.rowId }, data: { dailyBudgetCents: 2500, version: 2 } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/basis changed/) })
    expect(launches.calls).toBe(before)
    expect(await inside(() => db().adBlueprintApplication.count({ where: { playbookId: moved.rowId } }))).toBe(0)
  })
})

describe('approved, an adopt writes Nexus links; its undo is the opposite adopt', () => {
  it('binds, then the undo asks to take them off again', async () => {
    const campaign = await inside(async () => {
      const c = await db().campaign.create({ data: { name: 'TESTAPC | IT | PAT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: 'EXT-TESTAPC-PAT' } })
      const g = await db().adGroup.create({ data: { campaignId: c.id, name: 'TESTAPC PAT group' } })
      await db().adProductAd.create({ data: { adGroupId: g.id, asin: 'B0TESTAC01', sku: 'TEST-TESTAPC-V1' } })
      await db().adTarget.create({ data: { adGroupId: g.id, kind: 'PRODUCT', expressionType: 'ASIN_SAME_AS', expressionValue: 'B0TESTRIV1', bidCents: 30 } })
      return c.id
    })
    const p = (await preview('apply-ads-playbook', { op: 'adopt', market: 'IT', productId: adopted.parent })).preview as Row
    expect(p).toMatchObject({ op: 'adopt', bindings: [{ slot: 'pat', campaignId: campaign, why: 'named' }], reachNote: expect.stringMatching(/^Nexus only/) })
    // PB-8 — the preview shows the playbook's own hourly plans; a slot with no rank role makes none.
    expect(p.artifacts).toEqual([])
    const asked = await ask('apply-ads-playbook', { op: 'adopt', market: 'IT', productId: adopted.parent })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { bound: 1, unbound: 0 } })
    expect(await inside(() => db().adsPlaybookLink.findMany({ where: { playbookId: adopted.rowId, kind: 'slot' }, select: { key: true, refId: true, origin: true } }))).toEqual([{ key: 'pat', refId: campaign, origin: 'adopted' }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'apply-ads-playbook', args: { op: 'adopt', market: 'IT', productId: adopted.parent, unbind: ['pat'] } } })
  })
})
