/**
 * Auto-bid honest writes (2026-10-07) — on PGlite (production schema), with the real optimiser, the real bid write, the
 * real write gate in LIVE mode and the real ads worker; Amazon is a recorder. Made-up values only.
 *
 * Seen live on 10-06/10-07: auto-bid moved a bid in a campaign off the live-write allowlist (7→9¢) four runs in a row.
 * Nexus wrote 9¢, the worker's gate refused it and put 7¢ back, and the change feed read APPLIED (fixed in W4-12); the
 * run still counted it applied. A bid in a PAUSED campaign was sent, Amazon rejected it (the keyword no longer
 * existed), and the change feed read FAILED with no reason. Proven here:
 *   · a bid in a campaign off the allowlist, or in a paused campaign or ad group, is left alone and counted per reason
 *     (the preview counts the same): nothing is written, queued or logged for it;
 *   · auto-bid asks the gate before Nexus writes its copy: a write the gate refuses (here: a market without Amazon's
 *     checked limits) leaves the stored bid as it was, makes no queue row, and is counted as not sent, with the reason;
 *   · a write Amazon rejected reads FAILED in the change feed with Amazon's reason, not with none;
 *   · ad-targets' marker: a bid Nexus holds that is still queued, or failed and was kept, is named with the bid Amazon
 *     still has; a refused write that was put back, and a write Amazon took, are not.
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
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Profit data is a stand-in (the account default target wins before it is read).
vi.mock('./ads-target-acos.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeAdGroupTargetAcos: async () => ({ targetAcos: null, products: 1 }),
}))
const notices = vi.hoisted(() => ({ sent: [] as Array<{ title: string; body: string }> }))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAutomation: async (n: { title: string; body: string }) => { notices.sent.push(n); return 1 },
}))
/** Amazon, as a recorder: every update answers `updateAnswer`. */
const amz = vi.hoisted(() => ({
  updateAnswer: { ok: true, rawResponse: {} } as { ok: boolean; rawResponse: unknown; error?: string | null },
  updates: [] as Array<{ externalId: string; patch: Record<string, unknown> }>,
}))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const update = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amz.updates.push({ externalId, patch })
    return amz.updateAnswer
  }
  return { ...real, updateCampaign: update, updateAdGroup: update, updateTarget: update, updateProductAd: update }
})

const { runAutoBidOnce, autoBidSummaryLine, cannotReachAmazon } = await import('./ads-auto-bid.service.js')
const { automationAdapter } = await import('../automation/automation-catalog.service.js')
const { previewAutomation } = await import('../automation/automation-preview.service.js')
const { setAutonomy, setDefaultTargetAcosPct } = await import('./ads-automation-state.service.js')
const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
const { drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js')
const { listChanges, bidsNotAtAmazon } = await import('./ads-changes.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id } }))).bidCents as number
/** The writes for one target: its queued writes (each typed mutation names its queue row), action log and bid history rows. */
const writesFor = (id: string) => inside(async () => ({
  queue: await db().adMutation.count({ where: { entityId: id } }),
  log: await db().advertisingActionLog.count({ where: { entityId: id } }),
  history: await db().campaignBidHistory.count({ where: { entityId: id } }),
}))
const NONE = { queue: 0, log: 0, history: 0 }

/** Every keyword that spent: 20 clicks, 2 orders, ACoS 50 % — the 40 % account default makes each one's goal 40¢. */
const SPENT = { clicks: 20, spendCents: 1000, salesCents: 2000, ordersCount: 2 }

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    // c-it (IT, allowlisted) t-it 45¢ · c-uk (UK, allowlisted) t-uk 60¢ · c-off (IT, NOT allowlisted) t-off 30¢ ·
    // c-pin (bids pinned) t-pin 40¢. Added: a paused campaign, and an enabled campaign whose ad group is paused.
    await seedAdsFixture(database.client)
    const campaign = (id: string, extra: Record<string, unknown> = {}) => db().campaign.create({
      data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra },
    })
    await campaign('c-paused', { status: 'PAUSED' })
    await campaign('c-pg')
    await db().adGroup.create({ data: { id: 'g-c-paused', campaignId: 'c-paused', name: 'group paused campaign', externalAdGroupId: 'EXT-g-c-paused' } })
    await db().adGroup.create({ data: { id: 'g-c-pg', campaignId: 'c-pg', name: 'paused group', externalAdGroupId: 'EXT-g-c-pg', status: 'PAUSED' } })
    for (const [id, group] of [['t-paused', 'g-c-paused'], ['t-pg', 'g-c-pg']]) {
      await db().adTarget.create({ data: { id, adGroupId: group, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${id}`, bidCents: 50, externalTargetId: `EXT-${id}` } })
    }
    for (const id of ['t-it', 't-uk', 't-off', 't-pin', 't-paused', 't-pg']) await db().adTarget.update({ where: { id }, data: SPENT })
    // C3 — t-pin's 40¢ is already its goal (40 % of €1.00 sales a click), which proposes nothing: 50¢, so the pin holds a move.
    await db().adTarget.update({ where: { id: 't-pin' }, data: { bidCents: 50 } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(async () => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  delete process.env.NEXUS_BID_OPTIMIZER_SOURCE
  amz.updateAnswer = { ok: true, rawResponse: {} }
  amz.updates = []
  notices.sent = []
  await inside(() => setAutonomy('AUTO', 'test'))
  await inside(() => setDefaultTargetAcosPct(40, 'test'))
})

describe('cannotReachAmazon — a bid that cannot reach Amazon', () => {
  it('a paused or archived campaign or ad group is not running; a campaign off the allowlist is refused by the gate', () => {
    const live = { status: 'ENABLED', liveBidWritesEnabled: true }
    expect(cannotReachAmazon({ status: 'ENABLED', campaign: live })).toBeNull()
    expect(cannotReachAmazon({ campaign: live })).toBeNull()
    expect(cannotReachAmazon({ status: 'ENABLED', campaign: { ...live, status: 'PAUSED' } })).toBe('notRunning')
    expect(cannotReachAmazon({ status: 'ENABLED', campaign: { ...live, status: 'ARCHIVED' } })).toBe('notRunning')
    expect(cannotReachAmazon({ status: 'PAUSED', campaign: live })).toBe('notRunning')
    expect(cannotReachAmazon({ status: 'ENABLED', campaign: { ...live, liveBidWritesEnabled: false } })).toBe('notOnAllowlist')
    // Not running counts first: a paused campaign off the allowlist is not running.
    expect(cannotReachAmazon({ status: 'ENABLED', campaign: { status: 'PAUSED', liveBidWritesEnabled: false } })).toBe('notRunning')
  })
})

describe('auto-bid moves only bids that can reach Amazon, and asks the gate before it writes', () => {
  it('leaves off-allowlist and paused bids alone, and a write the gate refuses changes nothing and is counted not sent', async () => {
    const before = { off: await bidOf('t-off'), paused: await bidOf('t-paused'), pg: await bidOf('t-pg'), uk: await bidOf('t-uk'), it: await bidOf('t-it') }
    const r = await inside(() => runAutoBidOnce())

    // t-it is queued; t-uk is refused by the gate at once (UK has no checked Amazon limits in Nexus).
    expect(r).toMatchObject({ proposed: 2, applied: 1, notSent: 1, dryRun: false })
    expect(r.notSentReasons).toHaveLength(1)
    expect(r.notSentReasons![0]).toMatch(/^Not sent to Amazon: /)
    // Left alone, per reason: two not running (a paused campaign, a paused ad group), one off the allowlist, one pinned.
    expect(r.leftAlone).toEqual({ noTargetSetByYou: 0, notRunning: 2, notOnAllowlist: 1, hourlyPlan: 0, goalPlan: 0, person: 0, pinned: 1, bidBrain: 0 })

    // Nothing written, queued or logged for what was left alone or refused: the stored bid is what Amazon has.
    for (const [id, was] of [['t-off', before.off], ['t-paused', before.paused], ['t-pg', before.pg], ['t-uk', before.uk]] as const) {
      expect(await bidOf(id), id).toBe(was)
      expect(await writesFor(id), id).toEqual(NONE)
    }
    // The queued one: Nexus holds the new bid, one queue row, still waiting for its cancel window.
    expect(await bidOf('t-it')).toBeLessThan(before.it)
    expect((await writesFor('t-it')).queue).toBe(1)

    // The summary line and the notification say it in words.
    const line = autoBidSummaryLine(r)
    expect(line).toMatch(/^proposed=2 applied=1 dryRun=false not-sent=1 \(1 not sent to Amazon, nothing changed in Nexus \(Not sent to Amazon: /)
    expect(line).toContain('left-alone=4 (2 in a paused or archived campaign or ad group, 1 in a campaign not on the live-write allowlist, 1 a pin holds')
    expect(notices.sent).toHaveLength(1)
    expect(notices.sent[0].title).toBe('Auto-bid: 1 bid changes queued for Amazon')
    expect(notices.sent[0].body).toContain('1 not sent to Amazon, nothing changed in Nexus')
  })

  it('the A4 preview leaves the same bids alone, for the same reasons', async () => {
    const out = await inside(() => previewAutomation(automationAdapter('A4')!, {}))
    expect(out.ok).toBe(true)
    const preview = (out as { data: { preview: { proposals: Array<{ targetId: string }>; leftAlone: Record<string, number>; leftAloneNote: string } } }).data.preview
    // C3 — t-it already sits at its goal (40¢) since the run above: no second cut on the same evidence. t-uk, refused
    // there, still waits at 60¢.
    expect(preview.proposals.map((p) => p.targetId).sort()).toEqual(['t-uk'])
    expect(preview.leftAlone).toMatchObject({ notRunning: 2, notOnAllowlist: 1, pinned: 1 })
    expect(preview.leftAloneNote).toContain('2 in a paused or archived campaign or ad group, 1 in a campaign not on the live-write allowlist')
  })
})

describe('the read side says what did not reach Amazon', () => {
  it('a bid Amazon rejected reads FAILED in the change feed with Amazon\'s reason, and is put back', async () => {
    await inside(() => db().adTarget.create({ data: { id: 't-gone', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'gone jacket', bidCents: 40, externalTargetId: 'EXT-t-gone' } }))
    const w = await inside(() => updateAdTargetWithSync({ adTargetId: 't-gone', patch: { bidCents: 36 }, actor: 'automation:auto-bid', applyImmediately: true }))
    expect(w.ok).toBe(true)
    const rejection = 'amazon_rejected: [{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{"entityId":"EXT-t-gone"}}}]'
    amz.updateAnswer = { ok: false, rawResponse: {}, error: rejection }
    await inside(() => drainAdsSyncOnce(50))
    expect(amz.updates.map((u) => u.externalId)).toEqual(['EXT-t-gone'])
    expect(await bidOf('t-gone')).toBe(40)

    const feed = await inside(() => listChanges({ entityIds: ['t-gone'] }))
    const bid = feed.items.find((r) => r.field === 'bid')!
    expect(bid).toMatchObject({ oldValue: '40', newValue: '36' })
    // Before: { state: 'FAILED', lastError: null } — the op row carries no error of its own.
    expect(bid.delivery).toMatchObject({ state: 'FAILED', lastError: rejection })
    expect(bid.undoable).toBe(false)
    // The rejected write is not "a bid Amazon does not have": Nexus put the old bid back.
    expect((await inside(() => bidsNotAtAmazon([{ id: 't-gone', bidCents: 40 }]))).size).toBe(0)
  })

  it('ad-targets\' marker: a queued bid, and a failed one Nexus kept, name the bid Amazon still has; a landed one does not', async () => {
    // From the first test: t-it's auto-bid write waits in its cancel window; t-uk's was refused and changed nothing.
    const itBid = await bidOf('t-it')
    const ukBid = await bidOf('t-uk')
    const queued = await inside(() => bidsNotAtAmazon([{ id: 't-it', bidCents: itBid }, { id: 't-uk', bidCents: ukBid }, { id: 't-off', bidCents: 30 }]))
    expect([...queued.keys()]).toEqual(['t-it'])
    expect(queued.get('t-it')).toMatchObject({ state: 'PENDING', amazonBidCents: 45, deliveryError: null })

    // Its last attempt fails with a transient error: Nexus keeps the bid (the reconcile sweep may send it again).
    const mutation = await inside(() => db().adMutation.findFirstOrThrow({ where: { entityId: 't-it', state: 'PENDING' } }))
    const row = await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: mutation.outboundQueueId } }))
    await inside(() => db().outboundSyncQueue.update({ where: { id: row.id }, data: { holdUntil: new Date(Date.now() - 1000), retryCount: row.maxRetries - 1 } }))
    amz.updateAnswer = { ok: false, rawResponse: {}, error: 'HTTP 503 Service Unavailable' }
    await inside(() => drainAdsSyncOnce(50))
    expect((await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: row.id } }))).syncStatus).toBe('FAILED')
    expect(await bidOf('t-it')).toBe(itBid)
    const failed = await inside(() => bidsNotAtAmazon([{ id: 't-it', bidCents: itBid }]))
    expect(failed.get('t-it')).toMatchObject({ state: 'FAILED', amazonBidCents: 45, deliveryError: 'HTTP 503 Service Unavailable' })

    // A person sends the same bid again and Amazon takes it: the marker clears.
    amz.updateAnswer = { ok: true, rawResponse: {} }
    const again = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: itBid }, actor: 'user:u-test', manual: true, applyImmediately: true, forceResync: true }))
    expect(again.ok).toBe(true)
    await inside(() => drainAdsSyncOnce(50))
    expect((await inside(() => bidsNotAtAmazon([{ id: 't-it', bidCents: itBid }]))).size).toBe(0)
  })
})
