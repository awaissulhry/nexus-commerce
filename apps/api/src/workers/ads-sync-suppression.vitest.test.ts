/**
 * 2.2 — the suppression flag reaches the write gate, lowering-only.
 *
 * The gate exempts a suppression from the account halt, the min bid bound and the bids pin, so the night floor and
 * stop-over-spend still land while automation is stopped. The worker built that flag from `payload.force`, but since
 * AX-ZD.1f `payload` is read from the typed AdMutation rows, which carry no `force` — so the gate never saw a
 * suppression and, during a halt, the 2¢ floors were refused with everything else.
 *
 * `force` is also set by restores and base-bid deltas, which RAISE bids; those must stay refused while stopped
 * (Owner decision S1). These arms run the real enqueue (suppress / restore / delta services, typed rows + queue row)
 * and the real worker, and pin what the worker hands the gate.
 *
 * PGlite with the production schema. The gate is a stand-in that records its input and answers as a HALTED gate
 * does (ACR.0.7: only a suppression passes — the real gate's own arms in ads-write-gate-bounds prove that half).
 * Amazon is a recorder; nothing leaves the process.
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
    return ctx.isSuppression
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
    return { ok: true, rawResponse: {} }
  }
  const archive = async (_ctx: unknown, entity: string, externalId: string) => {
    amazon.calls.push({ externalId, patch: { archive: entity } })
    return { ok: true, rawResponse: {} }
  }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record, archiveSpEntity: archive }
})

const { drainAdsSyncOnce } = await import('./ads-sync.worker.js')
const { suppressCampaignBids, restoreCampaignBids, applyBaseBidDelta } = await import('../services/advertising/ads-bid-suppression.service.js')
const { updateAdTargetWithSync, updateCampaignWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { listChanges } = await import('../services/advertising/ads-changes.service.js')
const { getBidGrid, getBidSeries } = await import('../services/advertising/bid-grid.service.js')
const { cancelPendingMutation } = await import('../services/advertising/ads-mutation.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ACTOR = 'automation:rank-defend-test' as const

/** Drain the queue and return, per queue row, the flag the worker handed the gate and how the row settled. */
async function drain() {
  gate.seen = []
  amazon.calls = []
  const out = await inside(() => drainAdsSyncOnce(50))
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({
    where: { id: { in: out.results.map((r) => r.queueId) } },
    select: { id: true, syncStatus: true, errorCode: true, errorMessage: true },
  }))
  return { out, rows, flags: gate.seen.map((c) => c.isSuppression) }
}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id: 'sup-c', name: 'sup-c', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-sup-c',
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: 'sup-g', campaignId: 'sup-c', name: 'sup-g', externalAdGroupId: 'EXT-sup-g', defaultBidCents: 40 } as never })
    const target = (id: string, bidCents: number) => db.adTarget.create({
      data: { id, adGroupId: 'sup-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `kw ${id}`, bidCents, externalTargetId: `EXT-${id}` } as never,
    })
    await target('sup-t1', 35)
    await target('sup-t2', 60)
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { gate.seen = []; amazon.calls = [] })

describe('while automation is stopped', () => {
  it('the night floor is a suppression at the gate and lands on Amazon (35→2¢ and friends)', async () => {
    const moved = await inside(() => suppressCampaignBids('sup-c', { actor: ACTOR, reason: 'test: night floor' }))
    expect(moved).toBe(3)
    const { out, rows, flags } = await drain()
    expect(out.processed).toBe(3)
    // Before 2.2 every one of these was `false` — the flag never survived the typed rows — and all three were refused.
    expect(flags).toEqual([true, true, true])
    expect(rows.every((r) => r.syncStatus === 'SUCCESS')).toBe(true)
    expect(amazon.calls.map((c) => c.patch).sort((a, b) => Object.keys(a)[0]!.localeCompare(Object.keys(b)[0]!)))
      .toEqual([{ bid: 0.02 }, { bid: 0.02 }, { defaultBid: 0.02 }])
  })

  it('the morning restore is forced too, but it RAISES bids: not a suppression, refused by the halt', async () => {
    const moved = await inside(() => restoreCampaignBids('sup-c', { actor: ACTOR, reason: 'test: morning restore' }))
    expect(moved).toBe(3)
    const { out, rows, flags } = await drain()
    expect(out.processed).toBe(3)
    expect(flags).toEqual([false, false, false])
    expect(rows.map((r) => r.syncStatus)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED'])
    expect(rows.every((r) => r.errorCode === 'WRITE_GATE_DENIED' && r.errorMessage?.includes('automation_halted'))).toBe(true)
    expect(amazon.calls).toEqual([])
    // 4k — and Nexus shows what Amazon still has: each refused restore is put back to the 2¢ floor.
    const local = await inside(() => database.client.adTarget.findMany({ where: { adGroupId: 'sup-g' }, select: { bidCents: true } }))
    expect(local.map((t) => t.bidCents)).toEqual([2, 2])
  })

  it('a forced +% base-bid delta raises bids: refused; a forced −% delta only lowers: passes', async () => {
    // 4k — the refused restore above left Nexus at the floor (as Amazon is), so this arm starts from served bids.
    await inside(async () => {
      await database.client.adGroup.update({ where: { id: 'sup-g' }, data: { defaultBidCents: 40 } })
      await database.client.adTarget.update({ where: { id: 'sup-t1' }, data: { bidCents: 35 } })
      await database.client.adTarget.update({ where: { id: 'sup-t2' }, data: { bidCents: 60 } })
    })
    await inside(() => applyBaseBidDelta('sup-c', 20, { actor: ACTOR }))
    const up = await drain()
    expect(up.out.processed).toBe(3)
    expect(up.flags).toEqual([false, false, false])
    expect(amazon.calls).toEqual([])

    await inside(() => applyBaseBidDelta('sup-c', -50, { actor: ACTOR }))
    const down = await drain()
    expect(down.out.processed).toBe(3)
    expect(down.flags).toEqual([true, true, true])
    expect(down.rows.every((r) => r.syncStatus === 'SUCCESS')).toBe(true)
  })

  it('a lowering WITHOUT force is not a suppression (an operator or rule cut stays refused)', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t2', patch: { bidCents: 10 }, actor: ACTOR, applyImmediately: true }))
    expect(r.ok).toBe(true)
    const { flags, rows } = await drain()
    expect(flags).toEqual([false])
    expect(rows[0]!.syncStatus).toBe('SKIPPED')
  })

  it('a forced re-push of an unchanged bid is not a suppression (it may still move Amazon up)', async () => {
    // 4k — the bid Nexus holds now: the refused cut above was put back, so 10¢ is no longer "unchanged".
    const { bidCents } = await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id: 'sup-t2' }, select: { bidCents: true } }))
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t2', patch: { bidCents }, actor: ACTOR, applyImmediately: true, force: true, forceResync: true }))
    expect(r.ok).toBe(true)
    const { flags } = await drain()
    expect(flags).toEqual([false])
  })

  it('a pre-ZD.1 queue row (JSON payload, no typed rows) keeps its flag under the same lowering-only rule', async () => {
    const legacy = (id: string, oldValue: string, newValue: string) => database.client.outboundSyncQueue.create({
      data: {
        id, productId: null, channelListingId: null, targetChannel: 'AMAZON', targetRegion: 'IT', syncStatus: 'PENDING', syncType: 'AD_BID_UPDATE',
        holdUntil: new Date(Date.now() - 1_000), externalListingId: 'EXT-sup-t1',
        payload: {
          entityType: 'AD_TARGET', entityId: 'sup-t1', externalId: 'EXT-sup-t1', marketplace: 'IT', actor: ACTOR, reason: 'legacy',
          fieldChanges: [{ field: 'bid', oldValue, newValue }], force: true,
        },
      } as never,
    })
    await inside(() => legacy('sup-legacy-down', '35', '2'))
    expect((await drain()).flags).toEqual([true])
    await inside(() => legacy('sup-legacy-up', '2', '35'))
    expect((await drain()).flags).toEqual([false])
  })
})

/**
 * AA-W2-12 — a deliberate pause (pause-ads, run by the business's rule: a `user:` actor without a person's mark) lets go
 * of spend, so its queue row carries `letsGo` and the worker hands the halted gate a suppression. An enable, and a pause
 * without the mark, stay refused while stopped.
 */
describe('while automation is stopped — a real pause lets go, an enable does not', () => {
  const RULE_RUN = 'user:u-rule-approver' as const

  it('a marked pause of a campaign and a keyword passes the halted gate and lands on Amazon', async () => {
    await inside(() => updateCampaignWithSync({ campaignId: 'sup-c', patch: { status: 'PAUSED' }, actor: RULE_RUN, applyImmediately: true, letsGo: true }))
    await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t1', patch: { status: 'PAUSED' }, actor: RULE_RUN, applyImmediately: true, letsGo: true }))
    const { out, rows, flags } = await drain()
    expect(out.processed).toBe(2)
    expect(flags).toEqual([true, true])
    expect(rows.every((r) => r.syncStatus === 'SUCCESS')).toBe(true)
    expect(amazon.calls).toHaveLength(2)
  })

  it('an enable is never letting go: refused by the halt, and Nexus shows what Amazon still has', async () => {
    await inside(() => updateCampaignWithSync({ campaignId: 'sup-c', patch: { status: 'ENABLED' }, actor: RULE_RUN, applyImmediately: true, letsGo: true }))
    const { rows, flags } = await drain()
    expect(flags).toEqual([false])
    expect(rows[0]!.syncStatus).toBe('SKIPPED')
    expect(amazon.calls).toEqual([])
    expect((await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'sup-c' }, select: { status: true } }))).status).toBe('PAUSED')
  })

  it('a pause without the mark (a rule\'s pause_target, say) is judged as before: refused while stopped', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t2', patch: { status: 'PAUSED' }, actor: RULE_RUN, applyImmediately: true }))
    const { rows, flags } = await drain()
    expect(flags).toEqual([false])
    expect(rows[0]!.syncStatus).toBe('SKIPPED')
  })
})

/**
 * AA-W2-13 — an archive archive-ads marks (`letsGo`) passes the halted gate like a pause, and goes out as Amazon's delete
 * operation (archiveSpEntity), never a PUT Amazon does not accept. An unmarked archive is judged and sent as before.
 */
describe('while automation is stopped — a marked archive lets go, as Amazon\'s delete', () => {
  const RULE_RUN = 'user:u-rule-approver' as const

  it('a marked archive of a campaign and of a keyword: passes the halt, sent as the delete of each', async () => {
    await inside(() => updateCampaignWithSync({ campaignId: 'sup-c', patch: { status: 'ARCHIVED' }, actor: RULE_RUN, applyImmediately: true, letsGo: true }))
    await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t2', patch: { status: 'ARCHIVED' }, actor: RULE_RUN, applyImmediately: true, letsGo: true }))
    const { rows, flags } = await drain()
    expect(flags).toEqual([true, true])
    expect(rows.every((r) => r.syncStatus === 'SUCCESS')).toBe(true)
    expect(amazon.calls.map((c) => c.patch).sort((a, b) => String(a.archive).localeCompare(String(b.archive)))).toEqual([{ archive: 'campaign' }, { archive: 'keyword' }])
  })

  it('an unmarked archive (a person\'s screen, say) is judged as before: refused while stopped, never sent as a delete', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t1', patch: { status: 'ARCHIVED' }, actor: RULE_RUN, applyImmediately: true }))
    const { rows, flags } = await drain()
    expect(flags).toEqual([false])
    expect(rows[0]!.syncStatus).toBe('SKIPPED')
    expect(amazon.calls).toEqual([])
  })
})

/**
 * W4-12 — a write the gate refused is never APPLIED. Before: the worker left its action log PENDING, the change feed
 * read a paired PENDING op as APPLIED (and undoable), and the bid grid read the put-back bid as "changed outside Nexus"
 * because the put-back writes no history row. Nothing had reached Amazon.
 */
describe('W4-12 — a refused write, as the change feed and the bid grid tell it', () => {
  it('its action log says SKIPPED; the feed says CANCELLED with the gate\'s reason, not undoable; the grid sees no outside change', async () => {
    await inside(() => database.client.adTarget.create({
      data: { id: 'sup-t3', adGroupId: 'sup-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'kw sup-t3', bidCents: 7, externalTargetId: 'EXT-sup-t3' } as never,
    }))
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t3', patch: { bidCents: 9 }, actor: 'automation:auto-bid', applyImmediately: true }))
    expect(r.ok).toBe(true)
    const { rows } = await drain()
    expect(rows.map((row) => row.syncStatus)).toEqual(['SKIPPED'])
    expect(amazon.calls).toEqual([])

    const logs = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: 'sup-t3' }, select: { amazonResponseStatus: true } }))
    expect(logs.map((l) => l.amazonResponseStatus)).toEqual(['SKIPPED'])
    expect((await inside(() => database.client.adTarget.findUnique({ where: { id: 'sup-t3' }, select: { bidCents: true } })))?.bidCents).toBe(7)

    const feed = await inside(() => listChanges({ entityId: 'sup-t3', from: new Date(Date.now() - 3_600_000) }))
    const bid = feed.items.find((item) => item.field === 'bid')
    expect(bid).toMatchObject({ oldValue: '7', newValue: '9', undoable: false })
    expect(bid?.delivery?.state).toBe('CANCELLED')
    expect(bid?.delivery?.lastError).toMatch(/automation_halted/)

    const grid = await inside(() => getBidGrid({
      market: 'all', line: null, portfolio: null, campaign: 'sup-c', view: 'targets', status: 'all', kind: [], match: [],
      band: null, measured: 'all', q: 'sup-t3', windowDays: 30, sort: null, dir: 'desc', limit: 50,
    }))
    const row = (grid.rows as Array<{ id: string; lastAuditedCents: number | null; unrecorded: boolean }>).find((g) => g.id === 'sup-t3')
    expect(row).toMatchObject({ lastAuditedCents: 9, unrecorded: false })
    // The bid series counts it as not landed.
    const series = await inside(() => getBidSeries({ entityIds: ['sup-t3'] }))
    expect(series['sup-t3']?.map((p) => p.delivered)).toEqual(['FAILED'])

    // A real change outside Nexus after the put-back is still one.
    await inside(() => database.client.adTarget.update({ where: { id: 'sup-t3' }, data: { bidCents: 12 } }))
    const after = await inside(() => getBidGrid({
      market: 'all', line: null, portfolio: null, campaign: 'sup-c', view: 'targets', status: 'all', kind: [], match: [],
      band: null, measured: 'all', q: 'sup-t3', windowDays: 30, sort: null, dir: 'desc', limit: 50,
    }))
    expect((after.rows as Array<{ id: string; unrecorded: boolean }>).find((g) => g.id === 'sup-t3')?.unrecorded).toBe(true)
  })

  it('a write cancelled in its grace window: its action log says CANCELLED, and the feed offers no undo', async () => {
    await inside(() => database.client.adTarget.create({
      data: { id: 'sup-t4', adGroupId: 'sup-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'kw sup-t4', bidCents: 20, externalTargetId: 'EXT-sup-t4' } as never,
    }))
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'sup-t4', patch: { bidCents: 15 }, actor: 'automation:auto-bid' }))
    expect(r.ok).toBe(true)
    const cancelled = await inside(() => cancelPendingMutation(r.outboundQueueId!))
    expect(cancelled.ok).toBe(true)
    const logs = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: 'sup-t4' }, select: { amazonResponseStatus: true } }))
    expect(logs.map((l) => l.amazonResponseStatus)).toEqual(['CANCELLED'])
    const feed = await inside(() => listChanges({ entityId: 'sup-t4', from: new Date(Date.now() - 3_600_000) }))
    const bid = feed.items.find((item) => item.field === 'bid')
    expect(bid?.delivery?.state).toBe('CANCELLED')
    expect(bid).toMatchObject({ undoable: false, undoBlockedReason: 'This change never reached Amazon, so there is nothing to reverse.' })
  })
})
