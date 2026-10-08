/**
 * ONE BRAIN AB-6 — budget enforcement's PACING leaves a daily budget a product's brain owns (or the Owner holds), while its
 * stop over spend (a safety owner's floor) still lands there. Real PostgreSQL with the production schema (PGlite), one
 * business; the brain's holders and the budget write are stand-ins, so nothing is queued. Values are made up.
 *   held     a live run paces the other campaign only; the held one keeps its budget; the floor lands on both; counted
 *   today    nothing enrolled: both paced, exactly as before
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))
const h = vi.hoisted(() => ({
  update: vi.fn(async (_args: { campaignId: string }) => ({ ok: true, outboundQueueId: 'q1', actionLogId: 'l1' })),
  suppress: vi.fn(async (_id: string, _opts: Record<string, unknown>) => 2),
  restore: vi.fn(async () => 0),
  campaignLeverOwners: vi.fn(),
  anyBrainEnrolled: vi.fn(),
}))
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), updateCampaignWithSync: h.update }))
vi.mock('./ads-bid-suppression.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), suppressCampaignBids: h.suppress, restoreCampaignBids: h.restore }))
vi.mock('./brain/lever-owners.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

import { applyBudgetEnforcement } from './ads-budget-enforce.service.js'

const W = 'ab6_pacing_alpha'
const inW = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const now = new Date()
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const firstDay = new Date(`${month}-01T00:00:00Z`)
const ids = { gale: '', misano: '' }
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [W])
  await inW(async () => {
    const c = database.client
    const camp = (name: string) => c.campaign.create({ data: { name, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ENABLED' } as never })
    ids.gale = (await camp('Test GALE exact')).id
    ids.misano = (await camp('Test MISANO exact')).id
    // A €100 month already €90 spent on the 1st: the pace runs far over, so pacing cuts both, and Stop Over Spend floors them.
    await c.adBudgetPlan.create({ data: { marketplace: 'IT', month, monthlyBudgetCents: 10_000, autoPacing: true, stopOverSpend: true } as never })
    for (const [id, cents] of [[ids.gale, 6_000], [ids.misano, 6_000]] as const) {
      await c.amazonAdsDailyPerformance.create({ data: {
        profileId: 'P-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: firstDay, entityType: 'CAMPAIGN', entityId: `EXT-${id}`,
        localEntityId: id, costMicros: BigInt(cents) * 10_000n, currencyCode: 'EUR', reportRunId: 'RUN-TEST', reportedAt: new Date(),
      } as never })
    }
    await c.adsAutomationState.create({ data: { autonomy: 'AUTO' } as never })
  })
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.update.mockClear(); h.suppress.mockClear(); h.restore.mockClear()
  h.anyBrainEnrolled.mockReset().mockResolvedValue(true)
  h.campaignLeverOwners.mockReset().mockResolvedValue(new Map())
})

describe('AB-6 — budget enforcement\'s pacing leaves a held daily budget; its stop does not', () => {
  it('nothing enrolled (production today): both campaigns paced as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const run = await inW(() => applyBudgetEnforcement({ month, dryRun: false, actor: 'automation:budget-manager-cron' }))
    expect(new Set(h.update.mock.calls.map(([a]) => a.campaignId))).toEqual(new Set([ids.gale, ids.misano]))
    expect(run).not.toHaveProperty('leverHeld')
  })

  it('a held budget is not paced, the other is; the floor (the safety stop) lands on both; counted', async () => {
    h.campaignLeverOwners.mockImplementation(async (campaignIds: string[]) => new Map(campaignIds.filter((id) => id === ids.gale).map((id) => [id, { campaignId: id, name: 'Test GALE exact', market: 'IT', levers: { budgets: OWNED } }])))
    const run = await inW(() => applyBudgetEnforcement({ month, dryRun: false, actor: 'automation:budget-manager-cron' }))
    expect(h.update.mock.calls.map(([a]) => a.campaignId)).toEqual([ids.misano])
    expect(new Set(h.suppress.mock.calls.map(([id]) => id))).toEqual(new Set([ids.gale, ids.misano]))
    expect(run).toMatchObject({ budgetApplied: 1, suppressed: 2, leverHeld: { productBrain: { budgets: 1 } } })
    expect(h.campaignLeverOwners).toHaveBeenCalledTimes(1)
  })

  it('a dry run reads nothing', async () => {
    await inW(() => applyBudgetEnforcement({ month, dryRun: true }))
    expect(h.campaignLeverOwners).not.toHaveBeenCalled()
  })
})
