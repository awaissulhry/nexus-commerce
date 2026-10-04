/**
 * 1f — no automation pauses a campaign or an ad group (Owner rule; decision S5, 2026-10-04; review G.12).
 *
 * Four paths could still pause on Amazon after SYNC.1, because SYNC.1 banned only the two cron engines and let
 * operator-authored rules through:
 *   · the rule actions `pause_campaign`, `pause_ad_group` and `pause_all_campaigns`;
 *   · `dayparting_apply`, the builder's "Dayparting schedule", which set Campaign.status on hour windows;
 *   · `liquidate_aged_stock`, whose step 2 paused every campaign advertising another product of the same type.
 * Pinned here: each now changes no campaign or ad-group status, `dayparting_apply` acts through the bid floor and
 * restores only its own floor, and the mutation layer refuses an automated pause as the backstop. A person can
 * still pause (control).
 *
 * On a real PostgreSQL (PGlite, production schema) through the real mutation path; only the queue is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const RULE = 'tstrule-np'
const RULE_ACTOR = `automation:${RULE}`
/** Every hour of every day: the handler's window check passes whatever the clock says. */
const allWeek = (adj: 'pause' | 'enable') => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00', adj }))

const run = async (type: string, action: Record<string, unknown>, context: Record<string, unknown>, dryRun = false) => {
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  return inside(() => ACTION_HANDLERS[type]({ type, ...action }, context, { dryRun, ruleId: RULE }))
}
const campaign = (id: string) => inside(() => database.client.campaign.findUniqueOrThrow({
  where: { id }, select: { status: true, bidsSuppressedAt: true, bidsSuppressedBy: true },
}))
const statusWrites = () => inside(() => database.client.advertisingActionLog.count({ where: { actionType: 'AD_ENTITY_STATE_UPDATE' } }))
const bid = async (id: string) => (await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents

beforeAll(async () => {
  database = await formulaDatabase()
  await import('./automation-action-handlers.js')
  await inside(async () => {
    await seedAdsFixture(database.client)
    // liquidate_aged_stock: an aged jacket, and another jacket advertised in c-off — the campaign step 2 used to pause.
    await database.client.product.create({ data: { id: 'p-aged', sku: 'NP-AGED-1', name: 'Aged jacket', basePrice: '99.00', totalStock: 5, productType: 'JACKET' } })
    await database.client.product.create({ data: { id: 'p-new', sku: 'NP-NEW-1', name: 'New jacket', basePrice: '129.00', totalStock: 5, productType: 'JACKET' } })
    await database.client.adProductAd.create({ data: { adGroupId: 'g-c-off', productId: 'p-new', asin: 'B0NPTEST01', sku: 'NP-NEW-1' } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('the mutation layer refuses an automated pause (backstop)', () => {
  it('a rule actor pausing a campaign is refused, and nothing is written', async () => {
    const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
    const before = await statusWrites()
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { status: 'PAUSED' }, actor: RULE_ACTOR as never }))
    expect(r).toMatchObject({ ok: false, error: 'automation_may_not_pause_campaign', outboundQueueId: null })
    expect((await campaign('c-it')).status).toBe('ENABLED')
    expect(await statusWrites()).toBe(before)
  })

  it('a rule actor pausing an ad group is refused', async () => {
    const { updateAdGroupWithSync } = await import('./ads-mutation.service.js')
    const r = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-it', patch: { status: 'PAUSED' }, actor: RULE_ACTOR as never }))
    expect(r).toMatchObject({ ok: false, error: 'automation_may_not_pause_ad_group' })
    const g = await inside(() => database.client.adGroup.findUniqueOrThrow({ where: { id: 'g-c-it' }, select: { status: true } }))
    expect(g.status).toBe('ENABLED')
  })

  // Control: the refusal is about WHO, not about pausing. A person's Pause button keeps working, and a rule may
  // still put a campaign back on (enable_campaign / resume_campaign).
  it('a person may pause a campaign and an ad group; a rule may enable again', async () => {
    const { updateCampaignWithSync, updateAdGroupWithSync } = await import('./ads-mutation.service.js')
    const p = await inside(() => updateCampaignWithSync({ campaignId: 'c-pin', patch: { status: 'PAUSED' }, actor: 'user:np-test' }))
    expect(p).toMatchObject({ ok: true, error: null })
    expect((await campaign('c-pin')).status).toBe('PAUSED')
    const g = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-pin', patch: { status: 'PAUSED' }, actor: 'user:np-test' }))
    expect(g).toMatchObject({ ok: true, error: null })
    const e = await inside(() => updateCampaignWithSync({ campaignId: 'c-pin', patch: { status: 'ENABLED' }, actor: RULE_ACTOR as never }))
    expect(e).toMatchObject({ ok: true, error: null })
    expect((await campaign('c-pin')).status).toBe('ENABLED')
  })
})

describe('the three pause actions refuse with a plain sentence', () => {
  for (const [type, context, what] of [
    ['pause_campaign', { campaign: { id: 'c-it' } }, 'a campaign'],
    ['pause_ad_group', { adGroup: { id: 'g-c-it' } }, 'an ad group'],
    ['pause_all_campaigns', { marketplace: 'IT' }, 'campaigns'],
  ] as const) {
    it(`${type}: refused live AND in a dry run, and no status changes`, async () => {
      const before = await statusWrites()
      for (const dryRun of [false, true]) {
        const out = await run(type, { marketplace: 'IT' }, context, dryRun)
        expect(out.ok).toBe(false)
        expect(out.error).toBe(`Refused: no automation may pause ${what}. An automation lowers bids or budgets instead; a person can still pause by hand.`)
        expect(out.output).toMatchObject({ refusedBy: 'no-automated-pause' })
      }
      expect(await statusWrites()).toBe(before)
      const statuses = await inside(() => database.client.campaign.findMany({ where: { marketplace: 'IT' }, select: { status: true } }))
      expect(statuses.every((c) => c.status === 'ENABLED')).toBe(true)
    })
  }
})

describe('dayparting_apply acts through bids, never campaign status', () => {
  it('a dry run says how many campaigns it would floor and writes nothing', async () => {
    const out = await run('dayparting_apply', { timezone: 'UTC', windows: allWeek('pause'), campaignIds: ['c-it'] }, { marketplace: 'IT' }, true)
    expect(out).toMatchObject({ ok: true, output: { dryRun: true, action: 'pause', wouldChange: 1 } })
    expect((await campaign('c-it')).bidsSuppressedAt).toBeNull()
    expect(await bid('t-it')).toBe(45)
  })

  it("a 'pause' window floors the bids, remembers them, and leaves the campaign ENABLED", async () => {
    const before = await statusWrites()
    const out = await run('dayparting_apply', { timezone: 'UTC', windows: allWeek('pause'), campaignIds: ['c-it'] }, { marketplace: 'IT' })
    expect(out).toMatchObject({ ok: true, output: { action: 'pause', changed: 1 } })
    const c = await campaign('c-it')
    expect(c.status).toBe('ENABLED')
    expect(c.bidsSuppressedAt).not.toBeNull()
    expect(c.bidsSuppressedBy).toBe(RULE_ACTOR)
    expect(await bid('t-it')).toBe(2)
    expect(await statusWrites()).toBe(before)
  })

  it("the next tick of the same 'pause' window changes nothing", async () => {
    const out = await run('dayparting_apply', { timezone: 'UTC', windows: allWeek('pause'), campaignIds: ['c-it'] }, { marketplace: 'IT' })
    expect(out).toMatchObject({ ok: true, output: { changed: 0 } })
  })

  it("an 'enable' window restores the bids this rule floored", async () => {
    const out = await run('dayparting_apply', { timezone: 'UTC', windows: allWeek('enable'), campaignIds: ['c-it'] }, { marketplace: 'IT' })
    expect(out).toMatchObject({ ok: true, output: { action: 'enable', changed: 1 } })
    const c = await campaign('c-it')
    expect(c.status).toBe('ENABLED')
    expect(c.bidsSuppressedAt).toBeNull()
    expect(await bid('t-it')).toBe(45)
  })

  // The flag is shared with the rank engine, budget stop-over-spend and the retail guard. Lifting a floor another
  // actor set would undo that actor's decision on the next 'enable' hour.
  it("an 'enable' window does NOT lift a floor another actor set", async () => {
    const { suppressCampaignBids } = await import('./ads-bid-suppression.service.js')
    await inside(() => suppressCampaignBids('c-uk', { actor: 'automation:rank-defend-np-test' }))
    expect(await bid('t-uk')).toBe(2)
    const out = await run('dayparting_apply', { timezone: 'UTC', windows: allWeek('enable'), campaignIds: ['c-uk'] }, { marketplace: 'UK' })
    expect(out).toMatchObject({ ok: true, output: { action: 'enable', changed: 0 } })
    const c = await campaign('c-uk')
    expect(c.bidsSuppressedBy).toBe('automation:rank-defend-np-test')
    expect(await bid('t-uk')).toBe(2)
  })
})

describe('liquidate_aged_stock no longer pauses other products\' campaigns', () => {
  it('step 2 is reported as not done and the campaign advertising the other jacket stays ENABLED', async () => {
    const before = await statusWrites()
    const out = await run('liquidate_aged_stock', { productId: 'p-aged', marketplace: 'IT', boostPercent: 10 }, {})
    const o = out.output as { subActions: Array<{ step: string; ok: boolean; output?: Record<string, unknown> }>; pausedCampaignIds: string[] }
    const step2 = o.subActions.find((s) => s.step === 'pause_new_product_ads')
    expect(step2).toMatchObject({ ok: true, output: { skipped: 'Not done: no automation may pause a campaign. Ads for the other products keep running.' } })
    expect(o.pausedCampaignIds).toEqual([])
    expect((await campaign('c-off')).status).toBe('ENABLED')
    expect(await statusWrites()).toBe(before)
  })
})
