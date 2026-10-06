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
    expect(getTool('set-campaign-budget')).toMatchObject({ alwaysAsk: true, openWorld: true, reversibility: 'full', maxClaudeTrust: 'ask' })
  })

  it('refuses the campaign\'s own bounds, the same value, a pin, a non-SP or unknown campaign — and live, the gate', async () => {
    expect((await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 400 })).error).toMatch(/below the campaign's own minimum budget \(EUR 5.00\)/)
    expect((await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 6000 })).error).toMatch(/above the campaign's own maximum budget \(EUR 50.00\)/)
    expect((await preview('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2000 })).error).toMatch(/already EUR 20.00/)
    expect((await preview('set-campaign-budget', { campaignId: 'c-pin', dailyBudgetCents: 2500 })).error).toMatch(/^authority pin/)
    expect((await preview('set-campaign-budget', { campaignId: 'c-sb', dailyBudgetCents: 2500 })).error).toMatch(/not a Sponsored Products campaign/)
    expect((await preview('set-campaign-budget', { campaignId: 'nope', dailyBudgetCents: 2500 })).error).toBe('campaign nope not found')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('set-campaign-budget', { campaignId: 'c-off', dailyBudgetCents: 2500 })).error).toMatch(/^Not queued: .*live-write allowlist/)
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
    expect((await preview('set-placement-multipliers', { campaignId: 'c-pin', topOfSearchPct: 50 })).error).toMatch(/^authority pin/)
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
      totals: { asked: 8, changing: 2, excluded: { suppressed: 1, lowUnflagged: 1, pinned: 1, notSponsoredProducts: 1, notFound: 1, unchanged: 1 } },
      byCurrency: { EUR: { targets: 1, deltaCents: 15 }, GBP: { targets: 1, deltaCents: 10 } },
      reach: { reach: 'sandbox' },
    })
    expect((r.preview as Row).changes.map((c: Row) => [c.targetId, c.fromCents, c.toCents, c.currency])).toEqual([['t-it', 45, 60, 'EUR'], ['t-uk', 60, 70, 'GBP']])
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
    const r = await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 50 }, { targetId: 't-off', bidCents: 40 }] })
    expect(r.preview).toMatchObject({ totals: { changing: 1, excluded: { refusedByGate: 1 } }, reach: { reach: 'live', profileId: 'P-IT-TEST' } })
    expect((r.preview as Row).excludedLines).toEqual([{ targetId: 't-off', why: expect.stringMatching(/write gate refuses its campaign: .*allowlist/) }])
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-off', bidCents: 40 }] })).error).toMatch(/^Nothing would change: 1 Amazon's write gate refuses its campaign/)
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
    expect(getTool('suppress-campaign')).toMatchObject({ requires: ['ads.bids.edit'], maxClaudeTrust: 'confirm', reversibility: 'full' })
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
    expect(getTool('restore-campaign')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask' })
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

describe('A12 — set-campaign-live-writes (the allowlist, d2)', () => {
  it('previews the switch and the connection; approved, flips it as the approver; undo flips it back', async () => {
    const r = await preview('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
    expect(r.preview).toMatchObject({ liveWrites: { from: false, to: true }, connection: { profileId: 'P-IT-TEST', mode: 'production', writesEnabled: true }, effect: expect.stringMatching(/^Puts Italy not allowlisted on the live-write allowlist/) })
    expect(getTool('set-campaign-live-writes')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: false, requires: ['ads.campaigns.manage', 'ads.automation.manage'] })
    expect((await preview('set-campaign-live-writes', { campaignId: 'c-it', enabled: true })).error).toMatch(/already on the live-write allowlist/)
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
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
