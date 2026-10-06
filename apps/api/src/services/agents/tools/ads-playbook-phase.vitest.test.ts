/**
 * ADS PLAYBOOK PB-9 — apply-ads-playbook op phase, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one). One enrolled product with three adopted slot campaigns,
 * its strategy row in LAUNCH, Amazon's daily advertised-product report for four weeks. Values are made up (public repo).
 *
 *   check     the effective view's phase check: days in phase, the hold, each exit rule with its numbers, the proposal
 *   lower     LAUNCH → PROFIT lowers every field (the goal moves with them): no code; by rule it waits inside the hold;
 *             a person's own switch is never held — approved, it writes the strategy row and both versions; its undo is the
 *             switch back
 *   raise     PROFIT → GROW raises the target: the whole switch needs the approver's code — a plain approve is not run
 *   by rule   only the move the check proposes, outside the hold; a raise only with allowPhaseUp, written without a code
 *             and said so — never one that lets Claude do more alone (the Owner's rule: always his code)
 *   slots     DEFEND floors the research slots (low bids, remembered, never paused); leaving it in a running playbook gives
 *             back only the floor it set — a raise — never an engine's, nor a stopped built campaign's (only START does);
 *             a built campaign START started and left at the phase's floor is released here, with the code
 *   rank      a phase that switches an hourly plan off is a raise when the floors it set come back, a lowering when kept
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { seedProductPlaybook, templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
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
import { limitsTighten } from '../claude-trust.service.js'
import { applyStrategyPlan, planStrategyChange } from '../../advertising/ads-strategy/write.js'
import { phaseItem } from './ads-playbook-apply.tools.js'

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
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)
const preview = async (args: Record<string, unknown>) => (await inside(() => callTool(claude, 'apply-ads-playbook', args))).raw
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool('apply-ads-playbook', args, claude, run.id, { forceAsk: true })
  })
}
/** Approve, as a person in Nexus (`via` nexus), with their code (nexus-step-up), or as the business's rule (auto). */
async function approve(approvalId: string, via: 'nexus' | 'nexus-step-up' | 'auto' = 'nexus') {
  if (via !== 'nexus') await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { decisionVia: via } }))
  return inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool('apply-ads-playbook')!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}
const phase = (to: string, extra: Record<string, unknown> = {}) => ({ op: 'phase', market: 'IT', productId: pb.parent, phase: to, ...extra })

/** Each phase's numbers for the product, as enrollment would make them (made up). */
const NEGATE = { negateMinSpendCents: 100, negateMaxOrders: 0, negateWindowDays: 30 }
const RECIPES = {
  LAUNCH: { targetAcosPct: 40, harvestMinOrders: 1, harvestMinClicks: 0, harvestWindowDays: 30, negateMinClicks: 25, ...NEGATE },
  GROW: { targetAcosPct: 50, harvestMinOrders: 1, harvestMinClicks: 0, harvestWindowDays: 30, negateMinClicks: 25, ...NEGATE },
  PROFIT: { targetAcosPct: 25, harvestMinOrders: 3, harvestMinClicks: 5, harvestMaxAcosPct: 25, harvestWindowDays: 30, negateMinClicks: 30, ...NEGATE, negateMinSpendCents: 150 },
  DEFEND: { targetAcosPct: 30, harvestMinOrders: 2, harvestMinClicks: 0, harvestWindowDays: 30, negateMinClicks: 25, ...NEGATE },
}

let pb: Awaited<ReturnType<typeof seedProductPlaybook>>
let strategyId = ''
const campaigns: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(db())
    pb = await seedProductPlaybook(db(), { token: 'TESTPHZ', asinPrefix: 'B0TESTPZ' })
    await db().adsPlaybook.update({ where: { id: pb.rowId }, data: { phaseRecipes: RECIPES } })
    // The market lets changes run by rule today (C5); the tool's own checks still decide.
    await db().adsStrategy.updateMany({ where: { market: 'IT', level: 'MARKET' }, data: { claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000 } })
    // The product's strategy row in LAUNCH, switched there three days ago.
    const launch = { goal: 'LAUNCH', targetKind: 'ACOS', targetPct: 40, harvestMinOrders: 1, harvestMinClicks: 0, harvestWindowDays: 30, negateMinClicks: 25, negateMinSpendCents: 100, negateMaxOrders: 0, negateWindowDays: 30 }
    const row = await db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: pb.parent, label: `${pb.skus.parent} (IT)`, ...launch, version: 1, updatedBy: 'user:test' } })
    strategyId = row.id
    await db().adsStrategyVersion.create({ data: {
      strategyId, channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: pb.parent, version: 1, op: 'set', values: launch, changes: [], direction: 'raise',
      via: 'screen', actor: 'Test Owner', createdAt: daysAgo(3),
    } })
    // Three adopted slots (two research, one performance), each one ad group with one keyword.
    for (const [slot, parts] of [['auto', 'Auto'], ['broad-category', 'Broad | Category'], ['exact-category', 'Exact | Category']] as const) {
      const name = `TESTPHZ | IT | ${parts}`
      const c = await db().campaign.create({ data: { name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: `EXT-PHZ-${slot}`, liveBidWritesEnabled: true } })
      const g = await db().adGroup.create({ data: { campaignId: c.id, name, externalAdGroupId: `EXT-PHZ-G-${slot}`, defaultBidCents: 40 } })
      const ad = await db().adProductAd.create({ data: { adGroupId: g.id, productId: pb.v1, asin: 'B0TESTPZ01', sku: pb.skus.v1, externalAdId: `EXT-PHZ-AD-${slot}` } })
      await db().adTarget.create({ data: { adGroupId: g.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${slot}`, bidCents: 50, externalTargetId: `EXT-PHZ-T-${slot}` } })
      await db().adsPlaybookLink.create({ data: { playbookId: pb.rowId, kind: 'slot', key: slot, refId: c.id, adGroupId: g.id, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
      campaigns[slot] = c.id
      // Amazon's daily report for the Auto slot's ad: one order a day for four weeks, spend 2.00 and sales 7.00 a day.
      if (slot === 'auto') {
        for (let d = 1; d <= 28; d++) {
          const day = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - d * DAY)
          await db().amazonAdsDailyPerformance.create({ data: {
            profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, entityType: 'PRODUCT_AD', entityId: `EXT-PHZ-AD-${slot}`,
            localEntityId: ad.id, costMicros: 2_000_000n, sales7dCents: 700, orders7d: 1, currencyCode: 'EUR', reportedAt: new Date(),
          } })
        }
      }
    }
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('the phase check, in the effective view', () => {
  it('days in phase, the hold, each exit rule with its numbers; no proposal inside the hold', async () => {
    const r = (await inside(() => callTool(claude, 'ads-playbook', { market: 'IT', productId: pb.parent }))).raw as Row
    const check = r.data.markets[0].phaseCheck
    expect(check).toMatchObject({
      phase: 'LAUNCH', daysInPhase: 3, lastSwitch: { by: 'person', via: 'screen', version: 1 },
      hold: { minDays: 14, held: true, daysLeft: 11 },
      proposal: null,
      measured: { windows: [{ days: 14, adOrders: 14, previousAdOrders: 14, spendCents: 2800, salesCents: 9800, acosPct: 28.6 }], targetAcosPct: 40 },
      notMeasured: expect.stringMatching(/DEFEND starts and ends on the Owner's word/),
    })
    expect(check.exits).toEqual([
      { to: 'GROW', met: false, conditions: [
        { metric: 'daysInPhase', op: 'gte', value: 21, daysInPhase: 3, met: false },
        { metric: 'adOrders', op: 'gte', value: 10, windowDays: 14, adOrders: 14, met: true },
      ] },
      { to: 'GROW', met: false, conditions: [{ metric: 'daysInPhase', op: 'gte', value: 35, daysInPhase: 3, met: false }] },
    ])
    expect(check.measured.stock).toMatchObject({ products: expect.any(Number), shared: false })
  })
})

describe('LAUNCH → PROFIT lowers every field: no code, and a person may switch inside the hold', () => {
  let approvalId = ''
  it('the preview judges each field; the goal moves with its numbers; by rule it waits (inside the hold, not proposed)', async () => {
    const r = await preview(phase('PROFIT'))
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({ op: 'phase', phase: { from: 'LAUNCH', to: 'PROFIT' }, direction: 'lower', raises: [], stepUp: null, proposed: false, limitFacts: { action: 'phase' } })
    const dir = Object.fromEntries(p.strategy.changes.map((c: Row) => [c.field, c.direction]))
    expect(dir).toEqual({ goal: 'lower', target: 'lower', harvest: 'lower', negate: 'lower' })
    expect(p.strategy.changes.find((c: Row) => c.field === 'goal')).toMatchObject({ goal: { from: 'LAUNCH', to: 'PROFIT' } })
    expect(p.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Inside the 14-day hold of LAUNCH/)]))
    expect(judge(p)).toMatch(/LAUNCH is inside its 14-day hold \(11 more days\): only a person's own switch moves it now/)
  })

  it('approved by a person it runs: the strategy row, its version (goal by effect), the playbook version; undo switches back', async () => {
    const asked = await ask(phase('PROFIT', { why: 'test: margins first' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    approvalId = asked.approvalId!
    const done = await approve(approvalId)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { phase: { from: 'LAUNCH', to: 'PROFIT' }, direction: 'lower', strategy: { version: 2, direction: 'lower' } } })
    const row = await inside(() => db().adsStrategy.findUniqueOrThrow({ where: { id: strategyId } }))
    expect(row).toMatchObject({ goal: 'PROFIT', targetKind: 'ACOS', targetPct: 25, harvestMinOrders: 3, harvestMaxAcosPct: 25, negateMinClicks: 30, version: 2 })
    const version = await inside(() => db().adsStrategyVersion.findFirstOrThrow({ where: { strategyId, version: 2 } }))
    expect(version).toMatchObject({ direction: 'lower', approvalId, stepUpAt: null })
    expect((version.changes as Row[]).find((c) => c.field === 'goal')).toMatchObject({ from: 'LAUNCH', to: 'PROFIT', direction: 'lower' })
    const pbVersion = await inside(() => db().adsPlaybookVersion.findFirstOrThrow({ where: { refId: pb.rowId, op: 'phase' }, orderBy: { version: 'desc' } }))
    expect(pbVersion).toMatchObject({ direction: 'lower', approvalId })
    expect((pbVersion.changes as Row[])[0]).toMatchObject({ field: 'phase', from: 'LAUNCH', to: 'PROFIT', direction: 'lower' })
    expect(await inside(() => undoRequestFor({ approvalId }))).toMatchObject({ request: { tool: 'apply-ads-playbook', args: { op: 'phase', market: 'IT', productId: pb.parent, phase: 'LAUNCH' } } })
  })

  it('refused, and not queued: no phase named, the phase it is in, a phase it holds no recipe for', async () => {
    expect((await preview({ op: 'phase', market: 'IT', productId: pb.parent })).error).toMatch(/Name the phase to switch to/)
    expect((await preview(phase('PROFIT'))).error).toMatch(/is in PROFIT already in IT: nothing to switch/)
    expect((await preview(phase('CLEAR_STOCK'))).error).toMatch(/holds no CLEAR_STOCK recipe/)
  })
})

describe('PROFIT → GROW raises the target: the whole switch needs the approver\'s code', () => {
  it('stepUp on the preview; a plain approve is not run; approved with the code it runs and keeps when the code was typed', async () => {
    const p = (await preview(phase('GROW'))).preview as Row
    expect(p).toMatchObject({ direction: 'raise', raises: expect.arrayContaining(['Target']), stepUp: { what: expect.stringMatching(/adds spend/), raises: expect.arrayContaining(['Target']) } })
    expect(p.strategy.changes.find((c: Row) => c.field === 'goal')).toMatchObject({ direction: 'raise' })
    const asked = await ask(phase('GROW'))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/it raises, and a raise runs only when a person with settings.security.manage approved it with their authenticator code/) })
    expect(await inside(() => db().adsStrategy.findUniqueOrThrow({ where: { id: strategyId } }))).toMatchObject({ goal: 'PROFIT', version: 2 })
    expect(await approve(asked.approvalId!, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed', result: { direction: 'raise', strategy: { version: 3, direction: 'raise' } } })
    const version = await inside(() => db().adsStrategyVersion.findFirstOrThrow({ where: { strategyId, version: 3 } }))
    expect(version.stepUpAt).toBeInstanceOf(Date)
    expect(await inside(() => db().adsStrategy.findUniqueOrThrow({ where: { id: strategyId } }))).toMatchObject({ goal: 'GROW', targetPct: 50 })
  })
})

describe('by rule: only the move the phase check proposes, outside the hold; a raise only with allowPhaseUp', () => {
  it('the check proposes PROFIT once GROW has run its hold and its exit rule holds; another move waits for a person', async () => {
    // GROW started 20 days ago.
    await inside(() => db().adsStrategyVersion.updateMany({ where: { strategyId, version: 3 }, data: { createdAt: daysAgo(20) } }))
    const p = (await preview(phase('PROFIT'))).preview as Row
    expect(p).toMatchObject({ direction: 'lower', proposed: true, phaseCheck: { daysInPhase: 20, hold: { held: false }, proposal: { to: 'PROFIT', rule: 0 } } })
    expect(p.phaseCheck.exits[0].conditions.map((c: Row) => [c.metric, c.met])).toEqual([['daysInPhase', true], ['acosToTargetPct', true], ['ordersChangePct', true]])
    expect(judge(p)).toBeNull()
    expect(judge(p, { markets: ['DE'] })).toMatch(/only in DE/)
    // A raise the check proposes still waits unless the Owner allowed raising moves.
    const raising = { ...p, direction: 'raise', raises: ['Target'] }
    expect(judge(raising)).toMatch(/allowPhaseUp is off/)
    expect(judge(raising, { allowPhaseUp: true })).toBeNull()
    // allowPhaseUp on is a LOOSENING of the tool's limits: only a person with settings.security.manage and a fresh code
    // turns it on (claude-trust.service.ts mayRaise); off again is a free brake.
    const tool = getTool('apply-ads-playbook')!
    expect(limitsTighten(tool, { allowPhaseUp: false }, { allowPhaseUp: true })).toBe(false)
    expect(limitsTighten(tool, { allowPhaseUp: true }, { allowPhaseUp: false })).toBe(true)
    const other = (await preview(phase('DEFEND'))).preview as Row
    expect(judge(other)).toMatch(/Nexus's phase check proposes PROFIT now, not DEFEND: a switch it does not propose is a person's own/)
    expect(judge({ op: 'phase', market: 'IT', phase: { to: 'PROFIT' } })).toMatch(/there is no phase check in this preview/)
  })

  it('run by rule: a lowering runs; a raise runs only as allowPhaseUp lets it — no code typed, and the version says so', async () => {
    const down = await ask(phase('PROFIT'))
    expect(await approve(down.approvalId!, 'auto')).toMatchObject({ ok: true, status: 'executed', result: { direction: 'lower' } })
    const up = await ask(phase('GROW'))
    expect(await approve(up.approvalId!, 'auto')).toMatchObject({ ok: true, status: 'executed', result: { direction: 'raise' } })
    const version = await inside(() => db().adsStrategyVersion.findFirstOrThrow({ where: { strategyId }, orderBy: { version: 'desc' } }))
    expect(version).toMatchObject({ direction: 'raise', stepUpAt: null, reason: expect.stringMatching(/allowPhaseUp/) })
  })

  it("a switch that lets Claude do more alone never runs by rule — allowPhaseUp or not; the strategy writer refuses it without a code", async () => {
    // LAUNCH narrows Claude's budget changes to ask; the row holds it, and LAUNCH has run 40 days: the check proposes GROW.
    await inside(async () => {
      const row = await db().adsStrategy.findUniqueOrThrow({ where: { id: strategyId } })
      const version = row.version + 1
      await db().adsStrategy.update({ where: { id: strategyId }, data: { goal: 'LAUNCH', claudeAutonomy: { budget: 'ask' }, version } })
      await db().adsStrategyVersion.create({ data: {
        strategyId, channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: pb.parent, version, op: 'set', values: { goal: 'LAUNCH', claudeAutonomy: { budget: 'ask' } }, changes: [], direction: 'lower',
        via: 'screen', actor: 'Test Owner', createdAt: daysAgo(40),
      } })
    })
    const p = (await preview(phase('GROW'))).preview as Row
    expect(p).toMatchObject({ direction: 'raise', raisesClaude: true, proposed: true })
    expect(p.strategy.changes.find((c: Row) => c.field === 'claudeAutonomy')).toMatchObject({ direction: 'raise', claudeAutonomy: { from: { budget: 'ask' }, to: null } })
    expect(judge(p, { allowPhaseUp: true })).toMatch(/it lets Claude do more alone .* always needs a person with settings.security.manage and their authenticator code, never a rule/)
    expect(judge({ ...p, raisesClaude: undefined }, { allowPhaseUp: true })).toMatch(/does not say whether it raises what Claude may do alone/)
    // Run by rule anyway (a stale preview): not run, nothing written.
    const asked = await ask(phase('GROW'))
    expect(await approve(asked.approvalId!, 'auto')).toMatchObject({ ok: false, error: expect.stringMatching(/lets Claude do more alone, which always needs a person's authenticator code/) })
    expect(await inside(() => db().adsStrategy.findUniqueOrThrow({ where: { id: strategyId } }))).toMatchObject({ goal: 'LAUNCH' })
    // The writer holds the line on its own: a raise of Claude's levels is never written under raiseByRule.
    const planned = await inside(() => planStrategyChange({ channel: 'AMAZON', market: 'IT', level: 'product', productId: pb.parent, values: { claudeAutonomy: null } }))
    if (!('plan' in planned)) throw new Error('no plan')
    await expect(inside(() => applyStrategyPlan(planned.plan, { via: 'claude', actor: 'Test', actorUserId: null, updatedBy: 'claude:test', raiseByRule: 'a test rule' }))).rejects.toThrow(/never by rule/)
    // Back to GROW for the slots below, approved with the code (Claude's budget level comes off with it).
    const back = await ask(phase('GROW'))
    expect(await approve(back.approvalId!, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed' })
  })
})

describe('slots: a phase floors with low bids, and gives back only the floor it set', () => {
  it('DEFEND floors the research slots: every bid to the floor, remembered, never paused', async () => {
    const p = (await preview(phase('DEFEND'))).preview as Row
    expect(p.slots.map((s: Row) => [s.slot, s.does, s.direction])).toEqual([['auto', 'floor', 'lower'], ['broad-category', 'floor', 'lower']])
    expect(p.direction).toBe('lower')
    // The kit counts it as a stop from the highest bid it lowers: a cut, never a raise.
    expect(p.limitFacts.this).toMatchObject({ raises: 0, cuts: 1 })
    const asked = await ask(phase('DEFEND'))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { floored: [{ slot: 'auto' }, { slot: 'broad-category' }] } })
    for (const slot of ['auto', 'broad-category']) {
      const c = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: campaigns[slot] }, include: { adGroups: { include: { targets: true } } } }))
      expect(c).toMatchObject({ status: 'ENABLED', bidsSuppressedBy: 'user:u-approver' })
      expect(c.bidsSuppressedAt).toBeInstanceOf(Date)
      expect(c.adGroups[0].targets[0]).toMatchObject({ bidCents: 2, suppressedFromBidCents: 50 })
    }
    const exact = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: campaigns['exact-category'] } }))
    expect(exact.bidsSuppressedAt).toBeNull()
    // Each floor is recorded as the phase's own, held by the approver: only such a floor comes back later.
    const links = await inside(() => db().adsPlaybookLink.findMany({ where: { playbookId: pb.rowId, kind: 'phaseFloor' }, select: { refId: true, updatedBy: true } }))
    expect(links.map((l: Row) => [l.refId, l.updatedBy]).sort()).toEqual([[campaigns.auto, 'user:u-approver'], [campaigns['broad-category'], 'user:u-approver']].sort())
  })

  it('leaving DEFEND in a running playbook: its own floor comes back (a raise, the code); an engine\'s floor stays', async () => {
    await inside(async () => {
      await db().adsPlaybook.update({ where: { id: pb.rowId }, data: { state: 'RUNNING' } })
      // A person floored the Broad slot again by hand meanwhile: his floor, not the phase's.
      await db().campaign.update({ where: { id: campaigns['broad-category'] }, data: { bidsSuppressedBy: 'user:u-owner-hand' } })
    })
    // PB-5b — a campaign the playbook BUILT that is not started (off the allowlist: stopped) gets its bids back only
    // through START: named, left. Started (on the allowlist), the floor its phase held is the phase's to release.
    await inside(async () => {
      await db().adsPlaybookLink.updateMany({ where: { playbookId: pb.rowId, kind: 'slot', key: 'auto' }, data: { origin: 'built' } })
      await db().campaign.update({ where: { id: campaigns.auto }, data: { liveBidWritesEnabled: false } })
    })
    const stopped = (await preview(phase('GROW'))).preview as Row
    expect(stopped.slots.find((s: Row) => s.slot === 'auto')).toMatchObject({ does: 'report', direction: 'same', summary: expect.stringMatching(/stays at the floor: it was built by an ads playbook: its bids go back only with apply-ads-playbook op start/) })
    await inside(() => db().campaign.update({ where: { id: campaigns.auto }, data: { liveBidWritesEnabled: true } }))
    const p = (await preview(phase('GROW'))).preview as Row
    expect(p.slots.map((s: Row) => [s.slot, s.does, s.direction])).toEqual([['auto', 'restore', 'raise'], ['broad-category', 'keep', 'same']])
    expect(p.slots[1].summary).toMatch(/at a floor user:u-owner-hand set, not the phase's own: it stays/)
    expect(p).toMatchObject({ direction: 'raise', raises: expect.arrayContaining(['bids given back: "TESTPHZ | IT | Auto"']), stepUp: expect.any(Object) })
    // One kit item per raising part: the restart (its daily budget spends again), the higher target and GROW's looser
    // harvest group — each counted as a raise.
    expect(p.strategy.changes.filter((c: Row) => c.direction === 'raise').map((c: Row) => c.field).sort()).toEqual(['goal', 'harvest', 'target'])
    expect(p.limitFacts.this).toMatchObject({ items: 3, raises: 3, budgetIncreaseCents: 500 })
    // By rule, the bids it gives back are held to START's limit (this tool's maxBidCents, default 0).
    const outsideHold = { ...p, phaseCheck: { ...p.phaseCheck, hold: { held: false }, proposal: { to: 'GROW' } } }
    // (The product ran by rule twice today above: the per-entity limit is widened to reach the bid check.)
    const roomy = { allowPhaseUp: true, maxItems: 5, maxChangesPerEntityPerDay: 24 }
    expect(judge(outsideHold, roomy)).toMatch(/its highest restored bid EUR 0\.50 is above the EUR 0\.00 this tool's limits allow by rule/)
    expect(judge(outsideHold, { ...roomy, maxBidCents: 60 })).toBeNull()
    expect(judge(outsideHold, { ...roomy, maxItems: 1, maxBidCents: 60 })).toMatch(/it changes 3 items, more than the 1/)
    const asked = await ask(phase('GROW'))
    expect(await approve(asked.approvalId!, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed', result: { restored: [{ slot: 'auto' }] } })
    const auto = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: campaigns.auto }, include: { adGroups: { include: { targets: true } } } }))
    expect(auto.bidsSuppressedAt).toBeNull()
    expect(auto.adGroups[0].targets[0]).toMatchObject({ bidCents: 50, suppressedFromBidCents: null })
    const broad = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: campaigns['broad-category'] } }))
    expect(broad).toMatchObject({ bidsSuppressedBy: 'user:u-owner-hand' })
    // The floor that came back drops its link; the one a person holds keeps the phase's (not his) as it was.
    expect(await inside(() => db().adsPlaybookLink.count({ where: { playbookId: pb.rowId, kind: 'phaseFloor', refId: campaigns.auto } }))).toBe(0)
  })
})

describe('rank: an hourly plan the phase switches off', () => {
  it('is a raise when the floors it set come back (rankFloors giveBack), a lowering when they are kept', async () => {
    await inside(async () => {
      const plan = templateDoc().rank.roles.performance!
      const group = await db().rankScheduleGroup.create({ data: { name: 'TESTPHZ | IT | Playbook Performance', marketplace: 'IT', windows: plan.windows, defaultTargetKey: plan.baseline, enabled: true } })
      await db().adSchedule.create({ data: { campaignId: campaigns['exact-category'], name: 'TESTPHZ exact', windows: plan.windows, enabled: true, groupId: group.id } })
      await db().adsPlaybookLink.create({ data: { playbookId: pb.rowId, kind: 'rankGroup', key: 'rank:performance', refId: group.id, origin: 'built', compiledVersion: 1, updatedBy: 'user:test' } })
      // The hourly plan holds the Exact slot at its Min-bid floor right now.
      await db().campaign.update({ where: { id: campaigns['exact-category'] }, data: { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:rank-defend-test' } })
      await db().adTarget.updateMany({ where: { adGroup: { campaignId: campaigns['exact-category'] } }, data: { bidCents: 2, suppressedFromBidCents: 50 } })
    })
    const kept = (await preview(phase('PROFIT'))).preview as Row
    const off = (p: Row) => p.rank.find((r: Row) => r.role === 'performance')
    expect(off(kept)).toMatchObject({ does: 'disable', direction: 'lower' })
    expect(kept.direction).toBe('lower')
    const given = (await preview(phase('PROFIT', { rankFloors: 'giveBack' }))).preview as Row
    expect(off(given)).toMatchObject({ does: 'disable', direction: 'raise', summary: expect.stringMatching(/gets the bids rank floored back \(a raise\)/) })
    expect(given).toMatchObject({ direction: 'raise', raises: expect.arrayContaining(['the performance hourly plan gives back the floors it set']), stepUp: expect.any(Object) })
  })
})

describe("the kit's one item for a phase switch", () => {
  const slot = (does: string, extra: Record<string, unknown> = {}) => ({ slot: 's', campaignId: 'c', name: 'n', from: 'active', to: 'floor', does, direction: 'same', summary: '', ...extra }) as never
  const strategy = (changes: Row[]) => ({ changes }) as never
  it('a restart (its budgets), else the target move, else a stop from the highest bid it lowers — never a new bid', () => {
    expect(phaseItem({ slots: [slot('restore', { dailyBudgetCents: 300 }), slot('restore', { dailyBudgetCents: 200 })], strategy: strategy([]) }))
      .toEqual({ field: 'status', from: 'LOW_BIDS', to: 'ENABLED', dailyBudgetCents: 500 })
    expect(phaseItem({ slots: [slot('floor', { floorCents: 3, highestBidCents: 60 })], strategy: strategy([{ field: 'target', effectiveFrom: { targetPct: 40 }, effectiveTo: { targetPct: 30 } }]) }))
      .toEqual({ field: 'targetAcosPct', fromPct: 40, toPct: 30 })
    expect(phaseItem({ slots: [slot('floor', { floorCents: 3, highestBidCents: 60 }), slot('floor', { floorCents: 3, highestBidCents: 80 })], strategy: strategy([{ field: 'goal' }]) }))
      .toEqual({ field: 'bid', fromCents: 80, toCents: 3, forced: true })
    expect(phaseItem({ slots: [slot('keep')], strategy: strategy([{ field: 'goal' }]) })).toEqual({ field: 'automation' })
  })
})
