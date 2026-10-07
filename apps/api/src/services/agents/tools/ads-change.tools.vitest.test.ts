/**
 * MCP full control A6 (budgets, placements), A7 (bulk bids), A8 (suppress / restore) and A12 (live-write allowlist) — Claude's further Amazon ad changes, run for real through the door
 * and the approval gate (PGlite, production schema; the job queue a stub; the ads write gate the real one, sandbox
 * unless a test goes live).
 *
 * Proven for each: the preview in the campaign's own currency with where it lands; what the campaign or the gate
 * refuses is not queued; approved, it writes as the approver with changeSetId = the approval, records the change, and
 * undo asks the same tool for the old value; a starting value that moved is not run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
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
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const budgetOf = async (id: string) => (await sql<{ b: string }>('SELECT "dailyBudget"::text AS b FROM "Campaign" WHERE id = $1', [id]))[0].b

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.campaign.update({ where: { id: 'c-it' }, data: { minBudgetCents: 500, maxBudgetCents: 5000, dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] } } })
    await database.client.campaign.update({ where: { id: 'c-pin' }, data: { pinBudget: true, pinPlacement: true } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('A6 — set-campaign-budget', () => {
  it('previews the budget now and after in the campaign\'s own currency, and where it lands', async () => {
    expect((await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2500 })).preview).toMatchObject({
      currency: 'EUR', currentBudgetCents: 2000, proposedBudgetCents: 2500, deltaCents: 500, reach: { reach: 'sandbox' },
      effect: 'Sets the daily budget of Italy exact from EUR 20.00 to EUR 25.00.',
    })
    expect((await preview('set-campaign-budget', { campaignId: 'c-uk', dailyBudgetCents: 1200 })).preview).toMatchObject({ currency: 'GBP', currentBudgetCents: 1500 })
    // AA-W2-8 — strategy-bound: the business may let it run by rule, only inside its limits and the ads strategy.
    expect(getTool('set-campaign-budget')).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', openWorld: true, reversibility: 'full', maxClaudeTrust: 'auto' })
  })

  it('refuses the same value, a non-SP or unknown campaign and what Amazon refuses — his own limits only warn (4A)', async () => {
    expect((await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2000 })).error).toMatch(/already EUR 20.00/)
    // W4-11 — a Sponsored Brands budget is sent to SB's own endpoint only once Nexus has read it is daily
    // (ads-sbsd-tools.vitest.test.ts); the fixture's c-sb holds no budget object, so it is refused, by name.
    expect((await preview('set-campaign-budget', { campaignId: 'c-sb', dailyBudgetCents: 2500 })).error).toMatch(/^Italy brands is a Sponsored Brands campaign, and Nexus has not read from Amazon whether its budget is daily/)
    expect((await preview('set-campaign-budget', { campaignId: 'nope', dailyBudgetCents: 2500 })).error).toBe('campaign nope not found')
    // 4A (Owner decided 2026-10-06) — it runs only once a person approves it, as his own click: a pin no longer refuses it.
    expect((await preview('set-campaign-budget', { campaignId: 'c-pin', dailyBudgetCents: 2500 })).ok).toBe(true)
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    // …nor the live-write allowlist (c-off is off it)…
    expect((await preview('set-campaign-budget', { campaignId: 'c-off', dailyBudgetCents: 2500 })).preview).toMatchObject({ reach: { reach: 'live' } })
    // …and his own max budget is a WARNING on the card before he approves: approving sends it anyway.
    const over = (await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 6000 })).preview as { reach: { pastOwnLimits?: unknown[] }; reachNote: string }
    expect(over.reach.pastOwnLimits).toEqual(expect.arrayContaining([expect.objectContaining({ limit: 'entity_bounds' })]))
    expect(over.reachNote).toMatch(/Warning — this goes past your own limits: .*Approving it sends it anyway\./)
    // The gate's own cap on one write (default 500.00): a budget above it is refused before it is queued.
    expect((await preview('set-campaign-budget', { campaignId: 'c-uk', dailyBudgetCents: 60_000 })).error).toMatch(/^Not queued: /)
    expect((await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2500 })).preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' } })
  })

  it('approved, it writes the budget as the approver with changeSetId = the approval; undo asks for the old budget', async () => {
    const asked = await ask('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2500, why: 'out of budget by noon' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { dailyBudgetCents: 2500, currency: 'EUR' } })
    expect(await budgetOf('c-it')).toBe('25.00')
    const [log] = await sql('SELECT "userId", "executionId", "actionType" FROM "AdvertisingActionLog" WHERE "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1', ['c-it'])
    expect(log).toEqual({ userId: 'user:u-approver', executionId: asked.approvalId, actionType: 'AD_BUDGET_UPDATE' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'set-campaign-budget', args: { campaignId: 'c-it', dailyBudgetCents: 2000 } },
    })
    // The approval queue shows a budget raise as money, in euros.
    const { previewBulk } = await import('../../agent-fleet/approval-inbox.service.js')
    const queued = await ask('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 3000 })
    expect((await inside(() => previewBulk([queued.approvalId!], 'approve'))).euro).toMatchObject({ amount: 500, label: expect.stringMatching(/^raises daily budgets by €5.00/) })
  })

  it('a budget that moved after the person approved is not run', async () => {
    const asked = await ask('set-campaign-budget', { campaignId: 'c-uk', dailyBudgetCents: 1700 })
    await inside(() => database.client.campaign.update({ where: { id: 'c-uk' }, data: { dailyBudget: '16.00' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/currentBudgetCents changed/) })
    expect(await budgetOf('c-uk')).toBe('16.00')
  })
})

describe('A6 — set-placement-multipliers', () => {
  it('previews the adjustments now and after; the same, a pin or none asked are refused', async () => {
    expect((await preview('set-placement-multipliers', { campaignId: 'c-it', topOfSearchPct: 80, productPagesPct: 10 })).preview).toMatchObject({
      current: { topOfSearchPct: 50, productPagesPct: null, restOfSearchPct: null },
      proposed: { topOfSearchPct: 80, productPagesPct: 10, restOfSearchPct: null },
      reach: { reach: 'sandbox' }, effect: expect.stringContaining('bids rise on top of search and product pages'),
    })
    expect((await preview('set-placement-multipliers', { campaignId: 'c-it', topOfSearchPct: 50 })).error).toMatch(/already has these placement adjustments/)
    // 4A — a pin does not stop a change a person approves.
    expect((await preview('set-placement-multipliers', { campaignId: 'c-pin', topOfSearchPct: 50 })).ok).toBe(true)
    expect((await preview('set-placement-multipliers', { campaignId: 'c-it' })).error).toMatch(/at least one of/)
  })

  it('approved, it sets them as the approver in one change set; undo asks for the old ones, undo-ad-change can too', async () => {
    const asked = await ask('set-placement-multipliers', { campaignId: 'c-it', topOfSearchPct: 120 })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { placements: { topOfSearchPct: 120 } } })
    const [c] = await sql('SELECT "dynamicBidding" AS d FROM "Campaign" WHERE id = $1', ['c-it'])
    expect(c.d.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 120 }])
    const [log] = await sql('SELECT "userId", "executionId" FROM "AdvertisingActionLog" WHERE "actionType" = $1 ORDER BY "createdAt" DESC LIMIT 1', ['update_placement_bidding'])
    expect(log).toEqual({ userId: 'user:u-approver', executionId: asked.approvalId })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'set-placement-multipliers', args: { campaignId: 'c-it', topOfSearchPct: 50, productPagesPct: 0, restOfSearchPct: 0 } },
    })
    const undo = await ask('undo-ad-change', { changeSetId: asked.approvalId })
    expect(await approve(undo.approvalId!)).toMatchObject({ ok: true, result: { reversed: 1 } })
    const [back] = await sql('SELECT "dynamicBidding" AS d FROM "Campaign" WHERE id = $1', ['c-it'])
    expect(back.d.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 50 }])
  })
})

describe('A7 — bulk-ad-bid-change', () => {
  beforeAll(async () => {
    await inside(async () => {
      for (let i = 0; i < 22; i++) {
        await database.client.adTarget.create({ data: { id: `x-${String(i).padStart(2, '0')}`, adGroupId: 'g-c-uk', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `bulk term ${i}`, bidCents: 30 } })
      }
    })
  })

  it('a list: counts what changes and what does not, by reason; totals per currency', async () => {
    const r = await preview('bulk-ad-bid-change', { bids: [
      { targetId: 't-it', bidCents: 60 }, { targetId: 't-uk', bidCents: 70 }, { targetId: 't-sup', bidCents: 30 }, { targetId: 't-low', bidCents: 30 },
      { targetId: 't-pin', bidCents: 50 }, { targetId: 't-sb', bidCents: 50 }, { targetId: 'nope', bidCents: 50 }, { targetId: 't-off', bidCents: 30 },
    ] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      mode: 'list',
      // 4A — a pinned campaign's bid is no longer left out: the request runs only once a person approves it.
      // W4-11 — an SB keyword takes a bid only in a campaign Nexus has read pays per click; the fixture's c-sb has no cost type.
      totals: { asked: 8, changing: 3, excluded: { suppressed: 1, lowUnflagged: 1, notSponsoredProducts: 1, notFound: 1, unchanged: 1 } },
      byCurrency: { EUR: { targets: 2, deltaCents: 25 }, GBP: { targets: 1, deltaCents: 10 } },
      reach: { reach: 'sandbox' },
    })
    expect((r.preview as Row).changes.map((c: Row) => [c.targetId, c.fromCents, c.toCents, c.currency])).toEqual([['t-it', 45, 60, 'EUR'], ['t-pin', 40, 50, 'EUR'], ['t-uk', 60, 70, 'GBP']])
  })

  it('a selection moved by a percent; never the whole account, never both forms, nothing to do is refused', async () => {
    const r = await preview('bulk-ad-bid-change', { campaignId: 'c-it', percent: -10 })
    expect(r.preview).toMatchObject({ mode: 'selection', percent: -10, totals: { changing: 1, excluded: { suppressed: 1, lowUnflagged: 1 } } })
    expect((r.preview as Row).changes).toEqual([expect.objectContaining({ targetId: 't-it', fromCents: 45, toCents: 41 })])
    expect((await preview('bulk-ad-bid-change', { percent: 10 })).error).toMatch(/never the whole account/)
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 50 }], percent: 10 })).error).toMatch(/not both/)
    expect((await preview('bulk-ad-bid-change', {})).error).toMatch(/^Give bids/)
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-sup', bidCents: 30 }] })).error).toMatch(/^Nothing would change: 1 suppressed/)
    expect((await preview('bulk-ad-bid-change', { campaignId: 'nope', percent: 10 })).error).toBe('Campaign not found')
  })

  it('live: a campaign the gate refuses is left out with the gate\'s reason; alone, nothing is queued', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    // 4A — the allowlist no longer refuses an approved request (t-off's campaign is off it); a market Nexus does not
    // send to still is (UK has no checked Amazon limits row).
    const r = await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 50 }, { targetId: 't-off', bidCents: 40 }, { targetId: 't-uk', bidCents: 70 }] })
    expect(r.preview).toMatchObject({ totals: { changing: 2, excluded: { refusedByGate: 1 } }, reach: { reach: 'live', profileId: 'P-IT-TEST' } })
    expect((r.preview as Row).excludedLines).toEqual([{ targetId: 't-uk', why: expect.stringMatching(/write gate refuses its campaign: .*does not change ads in UK/) }])
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-uk', bidCents: 70 }] })).error).toMatch(/^Nothing would change: 1 Amazon's write gate refuses its campaign/)
  })

  it('approved, every write (not only the 20 shown) carries the approval as its change set; undo reverses the set as one', async () => {
    const targets = Array.from({ length: 22 }, (_, i) => ({ targetId: `x-${String(i).padStart(2, '0')}`, bidCents: 35 }))
    const asked = await ask('bulk-ad-bid-change', { bids: targets, why: 'raise the long tail' })
    expect(asked.preview).toMatchObject({ totals: { changing: 22 }, moreChanges: 2 })
    expect((asked.preview as Row).changes).toHaveLength(20)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { applied: 22, failed: 0 } })
    const logs = await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AdvertisingActionLog" WHERE "executionId" = $1 AND "userId" = $2', [asked.approvalId, 'user:u-approver'])
    expect(logs[0].n).toBe(22)
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AdTarget" WHERE id LIKE $1 AND "bidCents" = 35', ['x-%']))[0].n).toBe(22)
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'undo-ad-change', args: { changeSetId: asked.approvalId } } })
    const put = await ask('undo-ad-change', { changeSetId: asked.approvalId })
    expect(await approve(put.approvalId!)).toMatchObject({ ok: true, result: { reversed: 22 } })
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AdTarget" WHERE id LIKE $1 AND "bidCents" = 30', ['x-%']))[0].n).toBe(22)
  })

  it('a bid that moved after approval stops the whole request; the euro exposure counts euros only', async () => {
    const asked = await ask('bulk-ad-bid-change', { bids: [{ targetId: 'x-00', bidCents: 33 }, { targetId: 'x-01', bidCents: 33 }] })
    await inside(() => database.client.adTarget.update({ where: { id: 'x-01' }, data: { bidCents: 31 } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/basis changed/) })
    expect((await sql<{ b: number }>('SELECT "bidCents" AS b FROM "AdTarget" WHERE id = $1', ['x-00']))[0].b).toBe(30)
    const { previewBulk } = await import('../../agent-fleet/approval-inbox.service.js')
    const eur = await ask('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 55 }] })
    expect((await inside(() => previewBulk([eur.approvalId!], 'approve'))).euro).toMatchObject({ amount: 10 })
    const gbp = await ask('bulk-ad-bid-change', { bids: [{ targetId: 'x-02', bidCents: 40 }] })
    expect((await inside(() => previewBulk([gbp.approvalId!], 'approve'))).euro).toBeNull()
  })
})

/**
 * D4 — a stop row: one bid to the ads strategy's stop bid in one move (the Owner's temporary stop: low bids, never a
 * pause). It is not a step of the bid's pace, so the strategy's largest change per action does not clamp it — in the
 * preview, in the approved run and in the mutation layer — and it is a lowering only: a raise can never use it.
 */
describe('D4 — bulk-ad-bid-change stop rows: the stop bid in one move, never a raise', () => {
  let strategyId = ''
  const bidOf = async (id: string) => (await sql<{ b: number }>('SELECT "bidCents" AS b FROM "AdTarget" WHERE id = $1', [id]))[0].b
  beforeAll(async () => {
    strategyId = await inside(async () => {
      await database.client.campaign.create({ data: { id: 'c-d4', name: 'Italy stop rows', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-d4', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await database.client.adGroup.create({ data: { id: 'g-d4', campaignId: 'c-d4', name: 'stop rows group', externalAdGroupId: 'EXT-g-d4', defaultBidCents: 40 } })
      for (const [id, bid] of [['d4-high', 48], ['d4-low', 8], ['d4-bot', 3], ['d4-eng', 48]] as const) {
        await database.client.adTarget.create({ data: { id, adGroupId: 'g-d4', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `stop row ${id}`, bidCents: bid, externalTargetId: `EXT-${id}` } })
      }
      return (await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', maxChangePct: 20, stopMethod: 'LOW_BIDS', stopBidCents: 10 } })).id
    })
  })
  afterAll(async () => { await inside(() => database.client.adsStrategy.delete({ where: { id: strategyId } })) })

  it('the kit: the strategy\'s stop bid, at least 5¢, and only below the current bid (null: nothing to stop)', async () => {
    const { stopBidOf } = await import('./ads-change-kit.js')
    expect(stopBidOf(48, { cents: 10 })).toBe(10)
    expect(stopBidOf(48, { cents: 2 })).toBe(5)
    expect(stopBidOf(48, null)).toBe(5)
    expect(stopBidOf(10, { cents: 10 })).toBeNull()
    expect(stopBidOf(3, { cents: 2 })).toBeNull()
  })

  it('a stop row goes to the stop bid past the 20 % step; a bid row of the same bid is stepped; a raise is never a stop', async () => {
    const r = await preview('bulk-ad-bid-change', { bids: [{ targetId: 'd4-high', stop: true }, { targetId: 'd4-low', stop: true }, { targetId: 'd4-bot', stop: true }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({ totals: { asked: 3, changing: 1, excluded: { atStop: 2 } }, stopNote: expect.stringMatching(/never a pause.*does not apply to a stop, and a stop never raises a bid/) })
    expect((r.preview as Row).changes).toEqual([expect.objectContaining({ targetId: 'd4-high', fromCents: 48, toCents: 10, stop: true })])
    expect((r.preview as Row).excludedLines.map((e: Row) => e.why)).toEqual(['already at or below its stop bid (a stop never raises a bid)', 'already at or below its stop bid (a stop never raises a bid)'])
    // The same move asked as a bid is a step of its pace: one 20 % step by rule (W4-4: a person's approval sends it as
    // asked, after the card's warning).
    expect(((await preview('bulk-ad-bid-change', { bids: [{ targetId: 'd4-high', bidCents: 10 }] })).preview as Row).changes).toEqual([expect.objectContaining({ toCents: 10, byRuleCents: 38 })])
    // Nothing but stops below the stop bid: nothing to do.
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 'd4-bot', stop: true }] })).error).toMatch(/^Nothing would change: 1 already at or below its stop bid/)
    // A row is a bid or a stop, never both, never neither.
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 'd4-high', bidCents: 60, stop: true }] })).error).toMatch(/give its new bid \(bidCents\) or stop: true — one of the two/)
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 'd4-high' }] })).error).toMatch(/one of the two/)
  })

  it('approved: it lands at the stop bid, the value previewed; undo puts the bid back', async () => {
    const asked = await ask('bulk-ad-bid-change', { bids: [{ targetId: 'd4-high', stop: true }], why: 'test: a temporary stop' })
    expect((asked.preview as Row).changes[0]).toMatchObject({ toCents: 10, stop: true })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { applied: 1, failed: 0 } })
    expect(await bidOf('d4-high')).toBe(10)
    const put = await ask('undo-ad-change', { changeSetId: asked.approvalId })
    expect(await approve(put.approvalId!)).toMatchObject({ ok: true, result: { reversed: 1 } })
    expect(await bidOf('d4-high')).toBe(48)
  })

  it('the mutation layer: an engine\'s stop is not stepped (its plain lowering is); a stop that raises is refused', async () => {
    const { updateAdTargetWithSync } = await import('../../advertising/ads-mutation.service.js')
    expect(await inside(() => updateAdTargetWithSync({ adTargetId: 'd4-eng', patch: { bidCents: 10 }, actor: 'automation:test', reason: 'test: a plain lowering' }))).toMatchObject({ ok: true })
    expect(await bidOf('d4-eng')).toBe(38)
    expect(await inside(() => updateAdTargetWithSync({ adTargetId: 'd4-eng', patch: { bidCents: 10 }, actor: 'automation:test', reason: 'test: a stop', stop: true }))).toMatchObject({ ok: true })
    expect(await bidOf('d4-eng')).toBe(10)
    expect(await inside(() => updateAdTargetWithSync({ adTargetId: 'd4-eng', patch: { bidCents: 30 }, actor: 'automation:test', reason: 'test: a raise as a stop', stop: true }))).toMatchObject({ ok: false, error: 'a stop only lowers a bid: 30¢ is not below 10¢' })
    expect(await inside(() => updateAdTargetWithSync({ adTargetId: 'd4-eng', patch: { bidCents: 10 }, actor: 'automation:test', reason: 'test: no lowering', stop: true }))).toMatchObject({ ok: false })
    expect(await bidOf('d4-eng')).toBe(10)
  })
})

describe('A8 — suppress-campaign and restore-campaign (never a pause)', () => {
  beforeAll(async () => {
    await inside(async () => {
      await database.client.campaign.create({ data: { id: 'c-a8', name: 'Italy stop test', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-a8', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await database.client.adGroup.create({ data: { id: 'g-a8', campaignId: 'c-a8', name: 'stop group', externalAdGroupId: 'EXT-g-a8', defaultBidCents: 40 } })
      for (const [id, bid] of [['s-1', 55], ['s-2', 25]] as const) {
        await database.client.adTarget.create({ data: { id, adGroupId: 'g-a8', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `stop ${id}`, bidCents: bid, externalTargetId: `EXT-${id}` } })
      }
      await database.client.campaign.create({ data: { id: 'c-engine', name: 'Italy engine stop', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-engine', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:rank-defend-sched9' } })
    })
  })
  const bids = async () => Object.fromEntries((await sql<{ id: string; b: number; r: number | null }>('SELECT id, "bidCents" AS b, "suppressedFromBidCents" AS r FROM "AdTarget" WHERE id LIKE $1 ORDER BY id', ['s-%'])).map((t) => [t.id, [t.b, t.r]]))

  it('suppress: counts what goes to the floor; approved, floors and remembers every bid as the approver, in one change set', async () => {
    expect((await preview('suppress-campaign', { campaignId: 'c-a8' })).preview).toMatchObject({ moves: { targets: 2, adGroups: 1 }, reach: { reach: 'sandbox' }, effect: expect.stringMatching(/without being paused/) })
    // AA-W2-9 — strategy-bound: the business may let a stop run by rule, inside its limits and the ads strategy.
    expect(getTool('suppress-campaign')).toMatchObject({ requires: ['ads.bids.edit'], maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', reversibility: 'full' })
    const asked = await ask('suppress-campaign', { campaignId: 'c-a8', why: 'the product is out of stock' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { moved: 3 } })
    expect(await bids()).toEqual({ 's-1': [2, 55], 's-2': [2, 25] })
    expect((await sql('SELECT "bidsSuppressedBy" AS by, status FROM "Campaign" WHERE id = $1', ['c-a8']))[0]).toEqual({ by: 'user:u-approver', status: 'ENABLED' })
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AdvertisingActionLog" WHERE "executionId" = $1', [asked.approvalId]))[0].n).toBe(3)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'restore-campaign', args: { campaignId: 'c-a8' } } })
    expect((await preview('suppress-campaign', { campaignId: 'c-a8' })).error).toMatch(/already suppressed \(by user:u-approver/)
    // A suppressed bid is never raised by a bid change; only the restore lifts it.
    expect((await preview('set-target-bid', { targetId: 's-1', proposedBidCents: 30 })).error).toMatch(/is suppressed/)
  })

  it('restore: lists the remembered bids; approved, puts them back and lifts the suppression', async () => {
    const r = await preview('restore-campaign', { campaignId: 'c-a8' })
    expect(r.preview).toMatchObject({ suppressedBy: 'user:u-approver', restores: { targets: 2, adGroups: 1 }, currency: 'EUR', effect: expect.stringContaining('the highest EUR 0.55') })
    expect((r.preview as Row).bids).toEqual([{ targetId: 's-1', text: 'stop s-1', fromCents: 2, toCents: 55 }, { targetId: 's-2', text: 'stop s-2', fromCents: 2, toCents: 25 }])
    expect(getTool('restore-campaign')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads' })
    const asked = await ask('restore-campaign', { campaignId: 'c-a8' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 3 } })
    expect(await bids()).toEqual({ 's-1': [55, null], 's-2': [25, null] })
    expect((await sql('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = $1', ['c-a8']))[0]).toEqual({ at: null })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'suppress-campaign', args: { campaignId: 'c-a8' } } })
  })

  it('restore never lifts an engine\'s suppression, nor one that is not there', async () => {
    expect((await preview('restore-campaign', { campaignId: 'c-engine' })).error).toMatch(/suppressed by automation:rank-defend-sched9; only a suppression a person set may be lifted/)
    expect((await preview('restore-campaign', { campaignId: 'c-a8' })).error).toMatch(/its bids are not suppressed/)
  })

  it('a restore whose remembered bids changed after approval is not run', async () => {
    await ask('suppress-campaign', { campaignId: 'c-a8' }).then((a) => approve(a.approvalId!))
    const asked = await ask('restore-campaign', { campaignId: 'c-a8' })
    await inside(() => database.client.adTarget.update({ where: { id: 's-2' }, data: { suppressedFromBidCents: 99 } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/basis changed/) })
    expect((await bids())['s-2']).toEqual([2, 99])
  })

  it('W1-5 — remembered bids above the ads strategy\'s highest bid: the preview shows the held bids, and the run puts back exactly those (never a silent stop)', async () => {
    const row = await inside(() => database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', maxBidCents: 50, updatedBy: 'user:test' } }))
    try {
      const r = await preview('restore-campaign', { campaignId: 'c-a8' })
      const heldBy = 'the highest bid (ads strategy: Test market (IT), market, v1)'
      expect((r.preview as Row).bids).toEqual([
        { targetId: 's-1', text: 'stop s-1', fromCents: 2, toCents: 50, rememberedCents: 55, heldBy },
        { targetId: 's-2', text: 'stop s-2', fromCents: 2, toCents: 50, rememberedCents: 99, heldBy },
      ])
      expect(r.preview).toMatchObject({ effect: expect.stringContaining('the highest EUR 0.50; 2 at a bid limit instead of the bid it had') })
      const asked = await ask('restore-campaign', { campaignId: 'c-a8' })
      expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 3 } })
      expect(await bids()).toEqual({ 's-1': [50, null], 's-2': [50, null] })
      expect((await sql('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = $1', ['c-a8']))[0]).toEqual({ at: null })
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
  })

  it('W1-6 — the stop bid is the ads strategy\'s for the campaign\'s market; a bid already lower stays; a changed stop bid stops the run', async () => {
    const row = await inside(async () => {
      await database.client.campaign.create({ data: { id: 'c-a8s', name: 'Italy strategy stop', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-a8s', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await database.client.adGroup.create({ data: { id: 'g-a8s', campaignId: 'c-a8s', name: 'strategy stop group', externalAdGroupId: 'EXT-g-a8s', defaultBidCents: 40 } })
      for (const [id, bid] of [['ss-1', 55], ['ss-2', 15]] as const) {
        await database.client.adTarget.create({ data: { id, adGroupId: 'g-a8s', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `stop ${id}`, bidCents: bid, externalTargetId: `EXT-${id}` } })
      }
      return database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', stopMethod: 'LOW_BIDS', stopBidCents: 20 } })
    })
    try {
      const p = (await preview('suppress-campaign', { campaignId: 'c-a8s' })).preview as Row
      expect(p).toMatchObject({ moves: { targets: 1, adGroups: 1 }, stopBidCents: 20, stopBidFrom: 'ads strategy: Test market (IT) v1' })
      expect(p.effect).toMatch(/^Lowers every bid of Italy strategy stop to the stop bid of 20 cents \(ads strategy: Test market \(IT\) v1\) — 1 target and 1 ad group default/)
      // The stop bid moved after the approval: what the person approved is not what would run.
      const stale = await ask('suppress-campaign', { campaignId: 'c-a8s' })
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { stopBidCents: 10, version: 2 } }))
      expect(await approve(stale.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/stopBidCents changed/) })
      const asked = await ask('suppress-campaign', { campaignId: 'c-a8s' })
      expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { moved: 3 } }) // at 10 cents, both keywords and the default move
      const after = await sql<{ id: string; b: number; r: number | null }>('SELECT id, "bidCents" AS b, "suppressedFromBidCents" AS r FROM "AdTarget" WHERE id LIKE $1 ORDER BY id', ['ss-%'])
      expect(after.map((t) => [t.id, t.b, t.r])).toEqual([['ss-1', 10, 55], ['ss-2', 10, 15]])
      expect((await sql('SELECT "bidsSuppressedFloorCents" AS floor FROM "Campaign" WHERE id = $1', ['c-a8s']))[0]).toEqual({ floor: 10 })
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
  })
})

describe('W1-6b — a person\'s restore leaves an ad group floored on its own (a product over its monthly cap)', () => {
  it('the preview counts only what the restore gives back and names what stays; approved, the capped ad group stays floored', async () => {
    await inside(async () => {
      await database.client.campaign.create({ data: { id: 'c-a8g', name: 'Italy capped group', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-a8g', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, bidsSuppressedAt: new Date(), bidsSuppressedBy: 'user:u-approver', bidsSuppressedFloorCents: 2 } })
      await database.client.adGroup.create({ data: { id: 'g-a8g-capped', campaignId: 'c-a8g', name: 'capped', externalAdGroupId: 'EXT-g-a8g-capped', defaultBidCents: 2, suppressedFromBidCents: 40, bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:budget-manager-cron', bidsSuppressedFloorCents: 2 } })
      await database.client.adGroup.create({ data: { id: 'g-a8g-free', campaignId: 'c-a8g', name: 'free', externalAdGroupId: 'EXT-g-a8g-free', defaultBidCents: 2, suppressedFromBidCents: 30 } })
      await database.client.adTarget.create({ data: { id: 'tg-capped', adGroupId: 'g-a8g-capped', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'capped kw', bidCents: 2, suppressedFromBidCents: 55, externalTargetId: 'EXT-tg-capped' } })
      await database.client.adTarget.create({ data: { id: 'tg-free', adGroupId: 'g-a8g-free', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'free kw', bidCents: 2, suppressedFromBidCents: 45, externalTargetId: 'EXT-tg-free' } })
    })
    const p = (await preview('restore-campaign', { campaignId: 'c-a8g' })).preview as Row
    // W4-6 review — each own floor says who made it and what lifts it (here the budget manager's: a product over its cap).
    expect(p).toMatchObject({ restores: { targets: 1, adGroups: 1 }, staysFloored: { adGroups: 1, floors: [{ adGroupId: 'g-a8g-capped', name: 'capped' }] }, bids: [{ targetId: 'tg-free', toCents: 45 }] })
    expect(p.effect).toMatch(/1 ad group stays at its own floor: "capped" until the 1st or until that cap is raised \(a product of it is over its monthly cap in the ads strategy\)/)
    const asked = await ask('restore-campaign', { campaignId: 'c-a8g' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 2 } })
    const after = await sql<{ id: string; b: number; r: number | null }>('SELECT id, "bidCents" AS b, "suppressedFromBidCents" AS r FROM "AdTarget" WHERE id LIKE $1 ORDER BY id', ['tg-%'])
    expect(after.map((t) => [t.id, t.b, t.r])).toEqual([['tg-capped', 2, 55], ['tg-free', 45, null]])
    expect((await sql('SELECT "bidsSuppressedBy" AS by FROM "AdGroup" WHERE id = $1', ['g-a8g-capped']))[0]).toEqual({ by: 'automation:budget-manager-cron' })
    expect((await sql('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = $1', ['c-a8g']))[0]).toEqual({ at: null })
  })
})

describe('A12 — set-campaign-live-writes (the allowlist, d2)', () => {
  it('previews the switch and the connection; approved, flips it as the approver; undo flips it back', async () => {
    const r = await preview('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
    expect(r.preview).toMatchObject({ liveWrites: { from: false, to: true }, connection: { profileId: 'P-IT-TEST', mode: 'production', writesEnabled: true }, effect: expect.stringMatching(/^Puts Italy not allowlisted on the live-write allowlist/) })
    // The Owner's code rule A: ON is a big door (a new structure going live) — the approver's code.
    expect(r.preview).toMatchObject({ stepUp: { what: expect.stringMatching(/^puts Italy not allowlisted on the live-write allowlist/), raises: ['Live writes'] }, effect: expect.stringMatching(/A new structure going live: approving it needs the approver's authenticator code\.$/) })
    expect(getTool('set-campaign-live-writes')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', openWorld: false, requires: ['ads.campaigns.manage', 'ads.automation.manage'] })
    expect((await preview('set-campaign-live-writes', { campaignId: 'c-it', enabled: true })).error).toMatch(/already on the live-write allowlist/)
    // OFF is a brake: no code.
    expect((await preview('set-campaign-live-writes', { campaignId: 'c-it', enabled: false })).preview).not.toHaveProperty('stepUp')
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: it puts Italy not allowlisted on the live-write allowlist .*, and that runs only when a person with settings\.security\.manage approved it with their authenticator code/) })
    expect((await sql('SELECT "liveBidWritesEnabled" AS on FROM "Campaign" WHERE id = $1', ['c-off']))[0]).toEqual({ on: false })
    await inside(() => database.client.agentApproval.update({ where: { id: asked.approvalId! }, data: { decisionVia: 'nexus-step-up' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { liveWrites: true } })
    expect((await sql('SELECT "liveBidWritesEnabled" AS on FROM "Campaign" WHERE id = $1', ['c-off']))[0]).toEqual({ on: true })
    // Now a live change to that campaign is no longer refused at the allowlist.
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('set-target-bid', { targetId: 't-off', proposedBidCents: 35 })).preview).toMatchObject({ reach: { reach: 'live' } })
    vi.unstubAllEnvs()
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-campaign-live-writes', args: { campaignId: 'c-off', enabled: false } } })
  })

  it('a setting that changed after approval is not run', async () => {
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: false })
    await inside(() => database.client.campaign.update({ where: { id: 'c-off' }, data: { liveBidWritesEnabled: false } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: .*already off the live-write allowlist/) })
  })
})

/**
 * ADS AUTONOMY AA-W2-8 — set-campaign-budget and set-placement-multipliers may run by the business's rule: each preview
 * carries the ads strategy's facts (limitFacts) and the write gate's answer for the rule's own write (ruleGate), so
 * `withinLimits` judges it without a read. The door-level runs (level, strategy, commit) are in claude-strategy.vitest.
 */
describe('AA-W2-8 — budgets and placements carry what a run by rule is judged on', () => {
  const tool = (name: string) => getTool(name)!
  const judged = (name: string, p: unknown, limits: Record<string, unknown> = {}) => tool(name).withinLimits!(p, tool(name).limits!.parse(limits) as Record<string, unknown>)

  it('the default limits let no raise run alone; no strategy for the market: nothing runs alone there', async () => {
    expect(tool('set-campaign-budget').limits!.parse({})).toEqual({ maxItems: 1, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, maxRaisePct: 0, maxCutPct: 100 })
    expect(tool('set-placement-multipliers').limits!.parse({})).toEqual({ maxItems: 3, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, maxRaisePoints: 0, maxCutPoints: 100 })
    const cut = (await preview('set-campaign-budget', { campaignId: 'c-uk', dailyBudgetCents: 1000 })).preview as Row
    expect(cut).toMatchObject({ ruleGate: null, limitFacts: { action: 'budget', this: { markets: ['UK'], cuts: 1, raises: 0 }, markets: { UK: { strategy: null } } } })
    expect(cut.limitsNote).toContain('UK: no ads strategy — nothing runs alone there.')
    expect(judged('set-campaign-budget', cut)).toBe('there is no ads strategy for UK: nothing runs alone there; a person decides')
    // No facts, no run: a preview made before this (or one whose strategy could not be read) waits for a person.
    expect(judged('set-campaign-budget', { ...cut, limitFacts: undefined })).toMatch(/^there are no limit facts in this preview/)
    const placements = (await preview('set-placement-multipliers', { campaignId: 'c-uk', topOfSearchPct: 40, restOfSearchPct: 10 })).preview as Row
    expect(placements.limitFacts.this).toMatchObject({ items: 2, raises: 2, largestRaisePoints: 40 })
  })

  it('live: off the allowlist a person\'s approval reaches Amazon, but the rule\'s own write would be refused, so it never runs by rule', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const p = (await preview('set-campaign-budget', { campaignId: 'c-off', dailyBudgetCents: 1500 })).preview as Row
    expect(p.reach).toMatchObject({ reach: 'live', profileId: 'P-IT-TEST' })
    expect(p.ruleGate).toMatch(/^campaign "Italy not allowlisted": Amazon's write gate refuses it as a run by rule — .*allowlist/)
    // Inside the strategy in every other way (a covered market with room for a change today): the gate still holds it.
    const covered = { ...p, limitFacts: { ...p.limitFacts, markets: { IT: { ...p.limitFacts.markets.IT, strategy: { version: 'test' }, maxChangesPerDay: 5 } } } }
    expect(judged('set-campaign-budget', covered)).toMatch(/^campaign "Italy not allowlisted": Amazon's write gate refuses it as a run by rule — .+; a person decides$/)
  })

  it('run by rule (no person approved it), the write is the machine\'s and the audit says the rule decided it', async () => {
    const before = Math.round(Number(await budgetOf('c-it')) * 100)
    const asked = await ask('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before - 100, why: 'rule cut' })
    await inside(() => database.client.agentApproval.update({ where: { id: asked.approvalId! }, data: { decisionVia: 'auto' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    const [row] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-it'])
    expect(row.payload).toMatchObject({ actor: 'user:u-approver', reason: `Claude request ${asked.approvalId} (run by rule): rule cut` })
    expect(row.payload.manual).not.toBe(true)
  })
})

/**
 * ADS AUTONOMY AA-W2-9 — suppress-campaign, restore-campaign and set-campaign-live-writes may run by rule too. Their
 * defaults: a stop has no raise to bound; a restore waits until the business sets the highest bid it may put back; on
 * the allowlist none by default, and only a campaign Claude created; off the allowlist is a brake at any limit. The
 * door-level runs are in claude-strategy.vitest.
 */
describe('AA-W2-9 — stop, restore and the allowlist carry what a run by rule is judged on', () => {
  const tool = (name: string) => getTool(name)!
  const judged = (name: string, p: unknown, limits: Record<string, unknown> = {}) => tool(name).withinLimits!(p, tool(name).limits!.parse(limits) as Record<string, unknown>)

  it('the default limits', () => {
    expect(tool('suppress-campaign').limits!.parse({})).toEqual({ maxItems: 1, maxChangesPerEntityPerDay: 1, allowEngineOwned: false })
    expect(tool('restore-campaign').limits!.parse({})).toEqual({ maxItems: 1, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, maxRestoredBidCents: 0 })
    expect(tool('set-campaign-live-writes').limits!.parse({})).toEqual({ maxItems: 1, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, maxCampaignsOnPerDay: 0, allowAnyCampaign: false })
  })

  it('the allowlist: off is a brake, inside at any limit and without a strategy; on carries who made the campaign', async () => {
    const off = (await preview('set-campaign-live-writes', { campaignId: 'c-pin', enabled: false })).preview as Row
    expect(off).toMatchObject({ liveWrites: { from: true, to: false }, limitFacts: { action: 'allowlist' } })
    expect(off).not.toHaveProperty('createdBy')
    expect(judged('set-campaign-live-writes', off)).toBeNull()
    const on = (await preview('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })).preview as Row
    expect(on).toMatchObject({ createdBy: null, onByRuleToday: 0, limitFacts: { this: { items: 1, writes: 0, raises: 0, cuts: 0 } } })
    expect(judged('set-campaign-live-writes', on)).toMatch(/^there is no ads strategy for IT/)
  })
})

/**
 * 4A (Owner decided 2026-10-06) — a Claude request the Owner approved counts as his own click: while ads automation is
 * halted it still runs, carrying his manual mark (the queue row the worker judges says so). A request no person
 * approved — one his standing rule approved (`decisionVia: 'auto'`) — is the machine's write and is refused as before.
 */
describe('4A — an approved request is his own click', () => {
  const halt = (halted: boolean) => inside(() => database.client.adsAutomationState.upsert({
    where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted, haltReason: halted ? 'test halt' : null }, update: { halted, haltReason: halted ? 'test halt' : null },
  }))
  const cents = async (id: string) => Math.round(Number(await budgetOf(id)) * 100)
  afterAll(async () => { await halt(false) })

  it('approved by a person during a halt: it runs, as his own write', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await halt(true)
    const target = (await cents('c-it')) + 100
    const asked = await ask('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: target, why: '4A halt' })
    expect(asked.approvalId).toBeTruthy()
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await cents('c-it')).toBe(target)
    const [row] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-it'])
    expect(row.payload).toMatchObject({ manual: true, actor: 'user:u-approver' })
  })

  it('approved by his standing rule (not a person) during a halt: not run, nothing written', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await halt(true)
    const before = await cents('c-it')
    const asked = await ask('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before + 100, why: '4A rule' })
    await inside(() => database.client.agentApproval.update({ where: { id: asked.approvalId! }, data: { decisionVia: 'auto' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: .*(stopped|halt)/i) })
    expect(await cents('c-it')).toBe(before)
  })
})
