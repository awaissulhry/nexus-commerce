/**
 * 4k — a refused write leaves no local change (review 5.2), and the spend ceiling reads the budget a queued raise
 * replaces (group 3's N1).
 *
 * The mutation layer wrote Nexus's own copy first and the worker asked the write gate only at dispatch, so a refusal
 * ended SKIPPED and Nexus kept showing a bid or budget Amazon never got, while the rule, screen or Claude was told
 * `ok`. Now: the entity's own bounds are asked before the local write (refused → ok:false with the gate's sentence,
 * nothing changes); every refusal only the dispatch can know (allowlist, pin, halt, ceiling, day move) is put back by
 * the worker — field by field, and only where Nexus still holds the refused value. And the spend ceiling used the
 * campaign row, already the NEW budget, as "current", so no ceiling ever refused a queued raise.
 *
 * Real mutation service → real ads worker → real write gate in LIVE mode, on PGlite (production schema) with the
 * shared ads fixture. Amazon is a recorder; nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// Nothing here may open a Redis connection; the enqueue's BullMQ add is best-effort and the drain does the work.
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// The real gate in live mode: production profiles with writes enabled, automation running.
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, rawResponse: {} }
  }
  return {
    ...(await importOriginal<object>()),
    adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record,
  }
})
vi.mock('./ads-profile-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsProfileFor: async (marketplace: string) => ({
    profileId: `P-${marketplace}-TEST`, region: 'EU', connectionId: null, mode: 'production', writesEnabledAt: new Date('2026-01-01T00:00:00Z'),
    lastWriteAt: null, marketplace, source: 'row',
  }),
  recordWriteForMarket: async () => undefined,
}))
vi.mock('./ads-automation-state.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAutomation: async () => 0,
}))

const { updateAdTargetWithSync, updateAdGroupWithSync, updateCampaignWithSync } = await import('./ads-mutation.service.js')
const { drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const PERSON = 'user:refusal-test' as const
const RULE = 'automation:tstrule-refusal' as const

/** Everything a write leaves behind: queue rows, audit rows, history rows. A refusal before the write moves none. */
const trail = () => inside(async () => ({
  queue: await database.client.outboundSyncQueue.count(),
  log: await database.client.advertisingActionLog.count(),
  history: await database.client.campaignBidHistory.count(),
}))
const bidOf = async (id: string) => (await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents
const campaignOf = (id: string) => inside(() => database.client.campaign.findUniqueOrThrow({ where: { id }, select: { dailyBudget: true, name: true } }))

/** Run the worker over everything queued; how each queue row settled. */
async function drain() {
  amazon.calls = []
  const out = await inside(() => drainAdsSyncOnce(50))
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({
    where: { id: { in: out.results.map((r) => r.queueId) } },
    select: { id: true, syncStatus: true, errorMessage: true },
  }))
  return rows
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    // c-it carries its own bounds, the shape of the 82 live campaigns that do (maxBidCents 80–190¢ seen).
    await database.client.campaign.update({ where: { id: 'c-it' }, data: { minBidCents: 10, maxBidCents: 100, maxBudgetCents: 5000 } })
    await database.client.adBidPolicy.create({ data: { grain: 'MARKET', scopeId: 'UK', label: "the UK market's €0.50 ceiling", maxBidCents: 50 } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(() => { amazon.calls = [] })

describe('a bound is refused before Nexus writes its copy', () => {
  it('a keyword bid above the campaign ceiling: the gate\'s sentence, nothing changed, the refusal recorded', async () => {
    const before = await trail()
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 150 }, actor: RULE }))
    expect(r).toEqual({
      ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null,
      error: 'bid 150¢ exceeds the 100¢ ceiling (Campaign.maxBidCents on c-it)',
    })
    expect(await bidOf('t-it')).toBe(45)
    expect(await trail()).toEqual(before)
    // Recorded where the gate records its own refusals (fire-and-forget there too), with no queue row to name.
    await vi.waitFor(async () => {
      const refusal = await inside(() => database.client.adWriteRefusal.findFirst({ where: { entityId: 't-it' } }))
      expect(refusal).toMatchObject({ deniedAt: 'entity_bounds', queueId: null, campaignId: 'c-it', entityType: 'AD_TARGET', payloadValueCents: 150 })
    })
  })

  it('an ad-group default bid below the floor, and a budget above the campaign maximum', async () => {
    const before = await trail()
    const g = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-it', patch: { defaultBidCents: 6 }, actor: RULE }))
    expect(g).toMatchObject({ ok: false, outboundQueueId: null, error: 'bid 6¢ is below the 10¢ floor (Campaign.minBidCents on c-it)' })
    const c = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 60 }, actor: PERSON }))
    expect(c).toMatchObject({ ok: false, outboundQueueId: null, error: 'budget €60.00 exceeds Campaign.maxBudgetCents=€50.00 on c-it' })
    expect(Number((await campaignOf('c-it')).dailyBudget)).toBe(20)
    expect(await trail()).toEqual(before)
  })

  it('a bid policy binds the same way when the campaign sets no bound of its own', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-uk', patch: { bidCents: 70 }, actor: RULE }))
    expect(r).toMatchObject({ ok: false, error: "bid 70¢ exceeds the 50¢ ceiling (the UK market's €0.50 ceiling)" })
    expect(await bidOf('t-uk')).toBe(60)
  })

  it('1a stays: a forced lowering still passes the floor; a forced raise is still held to the ceiling', async () => {
    // t-low 3¢ → 2¢ under a 10¢ floor: a suppression (forced, every value down), exempt from the minimum only.
    const down = await inside(() => updateAdTargetWithSync({ adTargetId: 't-low', patch: { bidCents: 2 }, actor: RULE, force: true, applyImmediately: true }))
    expect(down).toMatchObject({ ok: true, error: null })
    expect(await bidOf('t-low')).toBe(2)
    // A forced write that RAISES is not a suppression — refused before the write, as the gate refused it after.
    const up = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 150 }, actor: RULE, force: true }))
    expect(up).toMatchObject({ ok: false, error: 'bid 150¢ exceeds the 100¢ ceiling (Campaign.maxBidCents on c-it)' })
    expect(await bidOf('t-it')).toBe(45)

    const rows = await drain()
    expect(rows).toEqual([expect.objectContaining({ syncStatus: 'SUCCESS' })])
    expect(amazon.calls).toEqual([{ externalId: 'EXT-t-low', patch: { bid: 0.02 } }])
  })
})

describe('a refusal only the dispatch can know is put back by the worker', () => {
  it('not on the live-write allowlist: SKIPPED, nothing sent, and Nexus shows the old bid again', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-off', patch: { bidCents: 35 }, actor: PERSON, applyImmediately: true }))
    expect(r.ok).toBe(true)
    expect(await bidOf('t-off')).toBe(35) // Nexus's copy, written when queued
    const rows = await drain()
    expect(rows).toEqual([expect.objectContaining({ syncStatus: 'SKIPPED', errorMessage: expect.stringContaining('campaign_allowlist') })])
    expect(amazon.calls).toEqual([])
    expect(await bidOf('t-off')).toBe(30)
  })

  it('a bids pin: the same', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 't-pin', patch: { bidCents: 55 }, actor: RULE, applyImmediately: true }))
    const rows = await drain()
    expect(rows).toEqual([expect.objectContaining({ syncStatus: 'SKIPPED', errorMessage: expect.stringContaining('authority_pin') })])
    expect(await bidOf('t-pin')).toBe(40)
  })

  it('a newer change is never overwritten — field by field', async () => {
    // A budget and a rename in one write to the non-allowlisted campaign; another writer renames it again meanwhile.
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-off', patch: { dailyBudget: 22, name: 'Italy renamed' }, actor: PERSON, applyImmediately: true }))
    expect(r.ok).toBe(true)
    await inside(() => database.client.campaign.update({ where: { id: 'c-off' }, data: { name: 'Italy renamed again' } }))
    // And a bid that a sync from Amazon moved on after it was queued.
    await inside(() => updateAdTargetWithSync({ adTargetId: 't-off', patch: { bidCents: 33 }, actor: PERSON, applyImmediately: true }))
    await inside(() => database.client.adTarget.update({ where: { id: 't-off' }, data: { bidCents: 41 } }))

    const rows = await drain()
    expect(rows.map((x) => x.syncStatus)).toEqual(['SKIPPED', 'SKIPPED'])
    const c = await campaignOf('c-off')
    expect(Number(c.dailyBudget)).toBe(20) // still the refused value → put back
    expect(c.name).toBe('Italy renamed again') // moved on since → kept
    expect(await bidOf('t-off')).toBe(41)
  })

  it('a write the gate allows is left as written', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 60 }, actor: RULE, applyImmediately: true }))
    const rows = await drain()
    expect(rows).toEqual([expect.objectContaining({ syncStatus: 'SUCCESS' })])
    expect(amazon.calls).toEqual([{ externalId: 'EXT-t-it', patch: { bid: 0.6 } }])
    expect(await bidOf('t-it')).toBe(60)
  })
})

describe('N1 — the spend ceiling measures a queued raise from the budget it replaces', () => {
  it('a campaign ceiling refuses a raise past it, and the budget is put back', async () => {
    await inside(() => database.client.adSpendCeiling.create({ data: { grain: 'CAMPAIGN', scopeId: 'c-it', label: 'the Italy exact ceiling', dailyCapCents: 500 } }))
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 28 }, actor: RULE, applyImmediately: true }))
    expect(r.ok).toBe(true)
    const rows = await drain()
    // Before N1 the gate read €28 (Nexus's copy) as current: a €0 increase, never refused.
    expect(rows).toEqual([expect.objectContaining({
      syncStatus: 'SKIPPED',
      errorMessage: expect.stringContaining('spend_ceiling: raising this budget by €8.00 would take the Italy exact ceiling past its €5.00/day ceiling — €0.00 of increases already authorised today'),
    })])
    expect(amazon.calls).toEqual([])
    expect(Number((await campaignOf('c-it')).dailyBudget)).toBe(20)
  })

  it('the write\'s own audit row is not counted twice: a raise inside the ceiling still goes', async () => {
    // +£7 under a £10 ceiling. Counting this write's own audit row as "already authorised" would make it £14.
    await inside(() => database.client.adSpendCeiling.create({ data: { grain: 'CAMPAIGN', scopeId: 'c-uk', label: 'the UK exact ceiling', dailyCapCents: 1000 } }))
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-uk', patch: { dailyBudget: 22 }, actor: RULE, applyImmediately: true }))
    expect(r.ok).toBe(true)
    const rows = await drain()
    expect(rows).toEqual([expect.objectContaining({ syncStatus: 'SUCCESS' })])
    expect(amazon.calls).toEqual([{ externalId: 'EXT-c-uk', patch: { dailyBudget: 22 } }])
    expect(Number((await campaignOf('c-uk')).dailyBudget)).toBe(22)
  })
})
