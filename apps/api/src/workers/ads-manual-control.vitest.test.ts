/**
 * 1e (CM-9, CM-10, CM-19) — the Owner's own edits from the campaign-manager screens.
 *
 * His rule: a brake may stop AUTOMATION, never second-guess his own clicks; a refusal is fine only when Amazon would
 * reject the action anyway, and it says why. Four things broke it, each pinned here with the real enqueue (typed rows
 * + queue row), the real worker and the real suppression services:
 *   CM-10  a halt or autonomy OFF refused his edits as if he were an engine — his pass it now, engines still do not;
 *   CM-19  a 5¢ floor of Nexus's own refused the 2¢ bids Amazon accepts (his off switch) — he may go to Amazon's minimum;
 *   CM-19  the campaign's `maxBidChangePct` step clamp rewrote his bid without a word — it now binds engines only;
 *   CM-9   a bid he set while the no-pause floor held was overwritten by the restore — the restore now puts back his.
 *
 * PGlite with the production schema. The gate is a stand-in that answers as a HALTED gate does (ACR.0.7 + 1e: a
 * suppression or a person's own edit passes, everything else is refused); the real gate's own arms in
 * ads-write-gate-bounds prove that half. Amazon is a recorder; nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Nothing here may open a Redis connection; the enqueue's BullMQ add is best-effort and the drain does the work.
vi.mock('../lib/queue.js', () => {
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
const gate = vi.hoisted(() => ({ seen: [] as GateContext[] }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
    gate.seen.push(ctx)
    return ctx.isSuppression || ctx.manual
      ? { allowed: true, mode: 'live', profileId: 'P-IT-TEST' }
      : { allowed: false, deniedAt: 'automation_halted', reason: 'ads automation is stopped (halted: test)' }
  },
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, mode: 'live', rawResponse: {} }
  }
  // The placement path reads Amazon's current array before its PUT (G.4).
  const listCampaignsV3 = async (_ctx: unknown, q: { campaignIds: string[] }) =>
    q.campaignIds.map((campaignId) => ({ campaignId, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [] } }))
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record, listCampaignsV3 }
})

const { drainAdsSyncOnce } = await import('./ads-sync.worker.js')
const { suppressCampaignBids, restoreCampaignBids } = await import('../services/advertising/ads-bid-suppression.service.js')
const { updateAdTargetWithSync, updateAdGroupWithSync, updateCampaignWithSync, bulkUpdateAdTargetBids, isPersonEdit, amazonMinBidCents } =
  await import('../services/advertising/ads-mutation.service.js')
const { updatePlacementBidding } = await import('../services/advertising/ads-create.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const OWNER = 'user:owner-test' as const
const ENGINE = 'automation:rank-defend-test' as const

/** Drain the ready queue rows; per row, what the worker handed the gate and how the row settled. */
async function drain() {
  gate.seen = []
  amazon.calls = []
  const out = await inside(() => drainAdsSyncOnce(50))
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({
    where: { id: { in: out.results.map((r) => r.queueId) } },
    select: { id: true, syncStatus: true, errorCode: true, errorMessage: true },
  }))
  return { out, rows, manual: gate.seen.map((c) => c.manual === true) }
}
const bidOf = (id: string) => inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true, suppressedFromBidCents: true } }))
const groupOf = (id: string) => inside(() => database.client.adGroup.findUniqueOrThrow({ where: { id }, select: { defaultBidCents: true, suppressedFromBidCents: true } }))
const queuedBid = (queueId: string | null) => inside(async () => {
  const row = await database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: queueId! }, select: { payload: true } })
  return (row.payload as { fieldChanges: Array<{ field: string; newValue: string }> }).fieldChanges.find((c) => c.field === 'bid')?.newValue
})

/** One SP campaign with one ad group and two keywords, all on Amazon. */
async function seedCampaign(id: string, opts: { marketplace?: string; dynamicBidding?: object; minBidCents?: number } = {}) {
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: opts.marketplace ?? 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        ...(opts.dynamicBidding ? { dynamicBidding: opts.dynamicBidding } : {}),
        ...(opts.minBidCents != null ? { minBidCents: opts.minBidCents } : {}),
      } as never,
    })
    await db.adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, externalAdGroupId: `EXT-${id}-g`, defaultBidCents: 40 } as never })
    for (const [n, bid] of [['t1', 35], ['t2', 60]] as const) {
      await db.adTarget.create({
        data: { id: `${id}-${n}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `kw ${id} ${n}`, bidCents: bid, externalTargetId: `EXT-${id}-${n}` } as never,
      })
    }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await seedCampaign('halt-c')
  await seedCampaign('min-c')
  await seedCampaign('uk-c', { marketplace: 'UK' })
  await seedCampaign('own-min-c', { minBidCents: 10 })
  await seedCampaign('clamp-c', { dynamicBidding: { maxBidChangePct: 20 } })
  await seedCampaign('floor-c')
  // The placement path resolves the market's Ads profile before it asks the gate.
  await inside(() => database.client.amazonAdsConnection.create({
    data: { profileId: 'P-IT-TEST', marketplace: 'IT', region: 'EU', mode: 'production', isActive: true, writesEnabledAt: new Date() } as never,
  }))
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { gate.seen = []; amazon.calls = [] })

describe('isPersonEdit — what counts as the Owner\'s own edit', () => {
  it('only the routes\' flag together with a person\'s actor', () => {
    expect(isPersonEdit(true, OWNER)).toBe(true)
    expect(isPersonEdit(true, ENGINE)).toBe(false) // an engine that passed the flag by mistake is still an engine
    expect(isPersonEdit(undefined, OWNER)).toBe(false) // the actor string alone proves nothing (`user:budget-manager` was a machine)
    expect(isPersonEdit('true', OWNER)).toBe(false)
  })
})

describe('CM-10 — while the account is halted (or autonomy is OFF)', () => {
  it('his own bid edit reaches Amazon; an engine\'s bid edit is still refused', async () => {
    await drain() // leftovers from other arms, if any
    const mine = await inside(() => updateAdTargetWithSync({ adTargetId: 'halt-c-t1', patch: { bidCents: 50 }, actor: OWNER, applyImmediately: true, manual: true }))
    const engine = await inside(() => updateAdTargetWithSync({ adTargetId: 'halt-c-t2', patch: { bidCents: 70 }, actor: ENGINE, applyImmediately: true }))
    expect(mine.ok && engine.ok).toBe(true)
    const { rows, manual } = await drain()
    expect(manual).toEqual([true, false])
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(mine.outboundQueueId!)!.syncStatus).toBe('SUCCESS')
    expect(byId.get(engine.outboundQueueId!)!.syncStatus).toBe('SKIPPED')
    expect(byId.get(engine.outboundQueueId!)!.errorMessage).toContain('automation_halted')
    expect(amazon.calls).toEqual([{ externalId: 'EXT-halt-c-t1', patch: { bid: 0.5 } }])
    // 4k — the engine's refused write is put back in Nexus; his stays.
    expect((await bidOf('halt-c-t1')).bidCents).toBe(50)
    expect((await bidOf('halt-c-t2')).bidCents).toBe(60)
  })

  it('the flag with an engine\'s actor is not a person: refused like any engine write', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'halt-c-t2', patch: { bidCents: 70 }, actor: ENGINE, applyImmediately: true, manual: true }))
    expect(r.ok).toBe(true)
    const { manual, rows } = await drain()
    expect(manual).toEqual([false])
    expect(rows[0]!.syncStatus).toBe('SKIPPED')
  })

  it('his campaign budget, his Enable/Pause, his ad-group bid and his bulk bid edit pass too', async () => {
    const budget = await inside(() => updateCampaignWithSync({ campaignId: 'halt-c', patch: { dailyBudget: 25 }, actor: OWNER, applyImmediately: true, manual: true }))
    const status = await inside(() => updateCampaignWithSync({ campaignId: 'halt-c', patch: { status: 'PAUSED' }, actor: OWNER, applyImmediately: true, manual: true }))
    const group = await inside(() => updateAdGroupWithSync({ adGroupId: 'halt-c-g', patch: { defaultBidCents: 45 }, actor: OWNER, applyImmediately: true, manual: true }))
    const bulk = await inside(() => bulkUpdateAdTargetBids({ entries: [{ adTargetId: 'halt-c-t2', bidCents: 65 }], actor: OWNER, applyImmediately: true, manual: true }))
    expect([budget.ok, status.ok, group.ok, bulk.applied]).toEqual([true, true, true, 1])
    const { rows, manual } = await drain()
    expect(manual).toEqual([true, true, true, true])
    expect(rows.map((r) => r.syncStatus)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS'])
  })

  it('his placement edit is sent; an engine\'s placement move is blocked with the halt\'s sentence', async () => {
    const mine = await inside(() => updatePlacementBidding({ campaignId: 'halt-c', adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 50 }], actor: OWNER, manual: true }))
    expect(gate.seen.at(-1)!.manual).toBe(true)
    expect(mine).toMatchObject({ ok: true, mode: 'live' })
    const engine = await inside(() => updatePlacementBidding({ campaignId: 'halt-c', adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 90 }], actor: ENGINE }))
    expect(gate.seen.at(-1)!.manual).toBe(false)
    expect(engine).toMatchObject({ ok: false, mode: 'blocked', deniedAt: 'automation_halted' })
  })
})

describe('CM-19 — his bid floor is Amazon\'s minimum, not Nexus\'s 5¢', () => {
  it('Amazon\'s minimum comes from the one limits table (2¢ in the euro markets, none where Nexus has no checked row)', () => {
    expect(amazonMinBidCents('IT')).toBe(2)
    expect(amazonMinBidCents('A1PA6795UKMFR9')).toBe(2) // an Amazon marketplace id on an older row (DE)
    expect(amazonMinBidCents('UK')).toBeNull()
  })

  it('his 2¢ keyword bid and 2¢ ad-group default bid are accepted (his off switch)', async () => {
    const t = await inside(() => updateAdTargetWithSync({ adTargetId: 'min-c-t1', patch: { bidCents: 2 }, actor: OWNER, manual: true }))
    const g = await inside(() => updateAdGroupWithSync({ adGroupId: 'min-c-g', patch: { defaultBidCents: 2 }, actor: OWNER, manual: true }))
    expect(t).toMatchObject({ ok: true, error: null })
    expect(g).toMatchObject({ ok: true, error: null })
    expect((await bidOf('min-c-t1')).bidCents).toBe(2)
    expect((await groupOf('min-c-g')).defaultBidCents).toBe(2)
    expect(await queuedBid(t.outboundQueueId)).toBe('2')
  })

  it('under Amazon\'s minimum is refused in Amazon\'s words, and nothing changes', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'min-c-t2', patch: { bidCents: 1 }, actor: OWNER, manual: true }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("below Amazon's minimum of €0.02 in IT")
    expect(r.outboundQueueId).toBeNull()
    expect((await bidOf('min-c-t2')).bidCents).toBe(60)
  })

  it('an engine\'s ordinary write keeps the 5¢ floor', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'min-c-t2', patch: { bidCents: 3 }, actor: ENGINE }))
    expect(r).toMatchObject({ ok: false, error: 'bid_below_floor_5_cents' })
    const g = await inside(() => updateAdGroupWithSync({ adGroupId: 'min-c-g', patch: { defaultBidCents: 3 }, actor: ENGINE }))
    expect(g).toMatchObject({ ok: false, error: 'bid_below_floor_5_cents' })
  })

  it('in a market with no checked Amazon limits the 5¢ floor stays (the gate refuses that market anyway)', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'uk-c-t1', patch: { bidCents: 2 }, actor: OWNER, manual: true }))
    expect(r).toMatchObject({ ok: false, error: 'bid_below_floor_5_cents' })
  })

  it('his own min-bid setting on the campaign still binds, and the refusal names it', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'own-min-c-t1', patch: { bidCents: 2 }, actor: OWNER, manual: true }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('below the 10¢ floor (Campaign.minBidCents')
    expect((await bidOf('own-min-c-t1')).bidCents).toBe(35)
  })
})

describe('CM-19 — the maxBidChangePct step clamp binds engines, not his clicks', () => {
  it('his 35→100¢ lands as 100¢; an engine\'s same move is still clamped to +20% (42¢)', async () => {
    const mine = await inside(() => updateAdTargetWithSync({ adTargetId: 'clamp-c-t1', patch: { bidCents: 100 }, actor: OWNER, manual: true }))
    expect(mine.ok).toBe(true)
    expect(await queuedBid(mine.outboundQueueId)).toBe('100')
    expect((await bidOf('clamp-c-t1')).bidCents).toBe(100)

    await inside(() => database.client.adTarget.update({ where: { id: 'clamp-c-t2' }, data: { bidCents: 35 } }))
    const engine = await inside(() => updateAdTargetWithSync({ adTargetId: 'clamp-c-t2', patch: { bidCents: 100 }, actor: ENGINE }))
    expect(engine.ok).toBe(true)
    expect(await queuedBid(engine.outboundQueueId)).toBe('42')
  })

  it('his bulk bid edit is not clamped either', async () => {
    const r = await inside(() => bulkUpdateAdTargetBids({ entries: [{ adTargetId: 'clamp-c-t2', bidCents: 10 }], actor: OWNER, manual: true }))
    expect(r.applied).toBe(1)
    expect(await queuedBid(r.outcomes[0]!.outboundQueueId)).toBe('10')
  })
})

describe('CM-9 — a bid he sets while the no-pause floor holds survives the restore', () => {
  it('the restore puts back HIS bid where he set one, the remembered bid elsewhere', async () => {
    await inside(() => suppressCampaignBids('floor-c', { actor: ENGINE, reason: 'test: night floor' }))
    expect(await bidOf('floor-c-t1')).toEqual({ bidCents: 2, suppressedFromBidCents: 35 })
    expect(await groupOf('floor-c-g')).toEqual({ defaultBidCents: 2, suppressedFromBidCents: 40 })

    // During the floor he raises one keyword and the ad group's default bid.
    expect((await inside(() => updateAdTargetWithSync({ adTargetId: 'floor-c-t1', patch: { bidCents: 50 }, actor: OWNER, manual: true }))).ok).toBe(true)
    expect((await inside(() => updateAdGroupWithSync({ adGroupId: 'floor-c-g', patch: { defaultBidCents: 30 }, actor: OWNER, manual: true }))).ok).toBe(true)
    expect(await bidOf('floor-c-t1')).toEqual({ bidCents: 50, suppressedFromBidCents: 50 })
    expect(await groupOf('floor-c-g')).toEqual({ defaultBidCents: 30, suppressedFromBidCents: 30 })

    await inside(() => restoreCampaignBids('floor-c', { actor: ENGINE, reason: 'test: morning restore' }))
    expect(await bidOf('floor-c-t1')).toEqual({ bidCents: 50, suppressedFromBidCents: null }) // his, not the old 35
    expect(await bidOf('floor-c-t2')).toEqual({ bidCents: 60, suppressedFromBidCents: null }) // untouched by him: remembered
    expect(await groupOf('floor-c-g')).toEqual({ defaultBidCents: 30, suppressedFromBidCents: null })
    const camp = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'floor-c' }, select: { bidsSuppressedAt: true } }))
    expect(camp.bidsSuppressedAt).toBeNull()
  })

  it('"keep it at 2¢" — confirming the floored value is no change on Amazon, but the restore keeps it at 2¢', async () => {
    await inside(() => suppressCampaignBids('floor-c', { actor: ENGINE, reason: 'test: night floor 2' }))
    expect(await bidOf('floor-c-t2')).toEqual({ bidCents: 2, suppressedFromBidCents: 60 })
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'floor-c-t2', patch: { bidCents: 2 }, actor: OWNER, manual: true }))
    expect(r).toMatchObject({ ok: true, outboundQueueId: null, error: 'no_changes' })
    expect(await bidOf('floor-c-t2')).toEqual({ bidCents: 2, suppressedFromBidCents: 2 })

    await inside(() => restoreCampaignBids('floor-c', { actor: ENGINE, reason: 'test: morning restore 2' }))
    expect(await bidOf('floor-c-t2')).toEqual({ bidCents: 2, suppressedFromBidCents: null })
    expect((await bidOf('floor-c-t1')).bidCents).toBe(50)
  })

  it('an engine\'s bid during the floor does not touch the memory: the restore still puts back the remembered bid', async () => {
    await inside(() => database.client.adTarget.update({ where: { id: 'floor-c-t2' }, data: { bidCents: 60 } }))
    await inside(() => suppressCampaignBids('floor-c', { actor: ENGINE, reason: 'test: night floor 3' }))
    expect(await bidOf('floor-c-t2')).toEqual({ bidCents: 2, suppressedFromBidCents: 60 })
    expect((await inside(() => updateAdTargetWithSync({ adTargetId: 'floor-c-t2', patch: { bidCents: 9 }, actor: ENGINE }))).ok).toBe(true)
    expect((await bidOf('floor-c-t2')).suppressedFromBidCents).toBe(60)
    await inside(() => restoreCampaignBids('floor-c', { actor: ENGINE, reason: 'test: morning restore 3' }))
    expect((await bidOf('floor-c-t2')).bidCents).toBe(60)
  })
})
