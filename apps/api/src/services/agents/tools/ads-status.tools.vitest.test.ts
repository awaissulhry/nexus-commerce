/**
 * ADS AUTONOMY AA-W2-12 — pause-ads and enable-ads, run for real through the door and the approval gate (PGlite,
 * production schema; the job queue a stub; the ads write gate the real one, sandbox unless a test goes live). Made-up ids.
 *
 * Proven: the preview names each ad from → to, what a paused campaign holds and the budget that stops, where it lands and
 * the strategy facts; what Nexus cannot change is refused and not queued; approved, it writes as the approver with
 * changeSetId = the approval and undo asks the other tool for the same ads; enable-ads switches on only what a Claude
 * request paused — never what a person paused, in Nexus or at Amazon; a pause run by the business's rule passes a halt
 * (it lets go) and an enable does not; the default limits let nothing run alone.
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
import { ruleFrom } from '../claude-trust.service.js'
import { updateCampaignWithSync } from '../../advertising/ads-mutation.service.js'

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
/** A request approved by the business's standing rule, not a person (decisionVia auto). */
const approveByRule = async (approvalId: string) => {
  await inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'auto' } }))
  return approve(approvalId)
}
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const statusOf = async (table: 'Campaign' | 'AdGroup' | 'AdTarget' | 'AdProductAd', id: string) => (await sql<{ s: string }>(`SELECT status::text AS s FROM "${table}" WHERE id = $1`, [id]))[0]?.s
const halt = (halted: boolean) => inside(() => database.client.adsAutomationState.upsert({
  where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted, haltReason: halted ? 'test halt' : null }, update: { halted, haltReason: halted ? 'test halt' : null },
}))

/** One SP campaign in IT with one ad group, one keyword and one product ad, all enabled unless said otherwise. */
async function campaign(id: string, extra: Record<string, unknown> = {}) {
  const db = database.client
  await db.campaign.create({ data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
  await db.adGroup.create({ data: { id: `g-${id}`, campaignId: id, name: `group ${id}`, externalAdGroupId: `EXT-g-${id}`, defaultBidCents: 30 } })
  await db.adTarget.create({ data: { id: `t-${id}`, adGroupId: `g-${id}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `term ${id}`, bidCents: 45, externalTargetId: `EXT-t-${id}` } })
  await db.adProductAd.create({ data: { id: `pa-${id}`, adGroupId: `g-${id}`, sku: `TEST-SKU-${id}`, asin: `B0TEST${id.replace(/\W/g, '').slice(-4).toUpperCase()}`, externalAdId: `EXT-pa-${id}` } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    for (const id of ['c-p1', 'c-p2', 'c-p3', 'c-p4', 'c-p5', 'c-h1', 'c-h2', 'c-lim']) await campaign(id)
    await campaign('c-arch', { status: 'ARCHIVED' })
    await campaign('c-draft', { status: 'DRAFT', externalCampaignId: null })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await halt(false); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('the tools as the contract holds them', () => {
  it('strategy-bound, alwaysAsk, ceiling auto, fully undoable; offered to Claude at ask (no row = ask)', () => {
    for (const name of ['pause-ads', 'enable-ads']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'full', openWorld: true, requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
      expect(ruleFrom(tool, null).level, name).toBe('ask')
      // By default nothing runs alone: every request waits for a person until he types a number.
      expect(tool.limits!.parse({})).toMatchObject({ maxItems: 0, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, levels: ['campaign', 'adGroup', 'target', 'productAd'] })
    }
    expect(getTool('pause-ads')!.description).toMatch(/lower its bids instead \(suppress-campaign/)
    expect(getTool('enable-ads')!.description).toMatch(/Never an ad a person paused, in Nexus or at Amazon/)
  })
})

describe('pause-ads', () => {
  it('previews each ad Enabled → Paused, what a campaign holds, the budget that stops, where it lands and the strategy facts', async () => {
    const r = await preview('pause-ads', { campaignIds: ['c-p1'], targetIds: ['t-it'], productAds: [{ adGroupId: 'g-c-p5', product: 'TEST-SKU-c-p5' }] })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'pause-ads',
      totals: { changing: 3, alreadyPaused: 0 },
      holds: { adGroups: 1, targets: 1, productAds: 1 },
      budgetsStop: { EUR: 1200 },
      reach: { reach: 'sandbox' },
      warning: expect.stringMatching(/about an hour after enable-ads.*lower its bids instead \(suppress-campaign\): it serves again about a minute/),
      limitFacts: { tool: 'pause-ads', action: 'pause', this: { items: 3, cuts: 3, raises: 0 } },
    })
    expect(p.changes).toEqual([
      { label: 'campaign "Test c-p1"', marketplace: 'IT', fromLabel: 'Enabled', toLabel: 'Paused' },
      { label: 'keyword "race jacket" (campaign "Italy exact")', marketplace: 'IT', fromLabel: 'Enabled', toLabel: 'Paused' },
      { label: 'the ad of TEST-SKU-c-p5 (campaign "Test c-p5")', marketplace: 'IT', fromLabel: 'Enabled', toLabel: 'Paused' },
    ])
    expect(p.effect).toMatch(/^Pauses 3 ads at Amazon \(1 campaign, 1 keyword or target, 1 product ad\)/)
    expect(p.effect).toMatch(/EUR 12.00 of daily budget stops spending\. enable-ads switches them back on; they serve again about an hour after that\.$/)
    expect(p.limitsNote).toEqual(expect.arrayContaining([expect.stringMatching(/^IT: no ads strategy/)]))
  })

  it('refuses what Nexus cannot pause, and is not queued; an ad already paused is left as it is', async () => {
    expect((await preview('pause-ads', {})).error).toMatch(/^Name the ads/)
    expect((await preview('pause-ads', { campaignIds: ['nope'] })).error).toBe('Not queued: campaign nope was not found in this business.')
    expect((await preview('pause-ads', { campaignIds: ['c-sb'] })).error).toMatch(/^Not queued: campaign "Italy brands": .*not a Sponsored Products campaign/)
    expect((await preview('pause-ads', { targetIds: ['t-neg'] })).error).toMatch(/it is a negative keyword/)
    expect((await preview('pause-ads', { campaignIds: ['c-arch'] })).error).toMatch(/is archived already: an archived ad serves no more/)
    expect((await preview('pause-ads', { campaignIds: ['c-draft'] })).error).toMatch(/a draft in Nexus and was never sent to Amazon/)
    expect((await preview('pause-ads', { productAds: [{ adGroupId: 'g-c-p1', product: 'NO-SUCH-SKU' }] })).error).toMatch(/the ad of NO-SUCH-SKU in ad group g-c-p1 was not found/)
    await expect(preview('pause-ads', { targetIds: Array.from({ length: 101 }, (_, i) => `x-${i}`) })).rejects.toThrow(/called wrongly/)
    expect((await preview('pause-ads', { campaignIds: Array.from({ length: 60 }, (_, i) => `c-${i}`), targetIds: Array.from({ length: 41 }, (_, i) => `x-${i}`) })).error)
      .toBe('101 ads named: at most 100 change in one request. Split them.')
    // A market Nexus does not send to (UK has no checked Amazon limits row): refused before it is queued.
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('pause-ads', { campaignIds: ['c-uk'] })).error).toMatch(/^Not queued: Amazon's write gate refuses it/)
    vi.unstubAllEnvs()
    await inside(() => database.client.adTarget.update({ where: { id: 't-low' }, data: { status: 'PAUSED' } }))
    expect((await preview('pause-ads', { targetIds: ['t-low'] })).error).toMatch(/^Nothing would change: keyword "cheap boots" .* is already paused/)
    expect((await preview('pause-ads', { targetIds: ['t-low', 't-it'] })).preview).toMatchObject({ totals: { changing: 1, alreadyPaused: 1 } })
  })

  it('approved, pauses as the approver in one change set marked as letting go; undo asks enable-ads for the same ads', async () => {
    const asked = await ask('pause-ads', { campaignIds: ['c-p1'], productAds: [{ adGroupId: 'g-c-p1', product: 'TEST-SKU-c-p1' }], why: 'season over' })
    expect(asked.approvalId).toBeTruthy()
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { paused: 2, failed: 0, reach: { reach: 'sandbox' } } })
    expect(await statusOf('Campaign', 'c-p1')).toBe('PAUSED')
    expect(await statusOf('AdProductAd', 'pa-c-p1')).toBe('PAUSED')
    const logs = await sql('SELECT "userId", "executionId", "entityType" FROM "AdvertisingActionLog" WHERE "executionId" = $1 ORDER BY "entityType"', [asked.approvalId])
    expect(logs).toEqual([
      { userId: 'user:u-approver', executionId: asked.approvalId, entityType: 'CAMPAIGN' },
      { userId: 'user:u-approver', executionId: asked.approvalId, entityType: 'PRODUCT_AD' },
    ])
    const [queued] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-p1'])
    expect(queued.payload).toMatchObject({ letsGo: true, manual: true, fieldChanges: [{ field: 'status', oldValue: 'ENABLED', newValue: 'PAUSED' }] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'enable-ads', args: { campaignIds: ['c-p1'], productAds: [{ adGroupId: 'g-c-p1', product: 'TEST-SKU-c-p1' }] } },
    })
  })

  it('an ad whose status moved after the person approved is not run', async () => {
    const asked = await ask('pause-ads', { targetIds: ['t-c-p2'] })
    await inside(() => database.client.adTarget.update({ where: { id: 't-c-p2' }, data: { status: 'PAUSED' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false })
    await inside(() => database.client.adTarget.update({ where: { id: 't-c-p2' }, data: { status: 'ENABLED' } }))
  })
})

describe('enable-ads — only what a Claude request paused', () => {
  it('switches back on what pause-ads paused: who paused it, the budget and the highest bid that serve again; undo asks pause-ads', async () => {
    const r = await preview('enable-ads', { campaignIds: ['c-p1'] })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'enable-ads', totals: { changing: 1, alreadyEnabled: 0 }, budgetsResume: { EUR: 1200 }, reach: { reach: 'sandbox' },
      restartBids: { 'campaign:c-p1': { cents: 45, currency: 'EUR' } },
      limitFacts: { tool: 'enable-ads', action: 'enable', this: { raises: 1 } },
    })
    expect(p.changes[0]).toMatchObject({ fromLabel: 'Paused', toLabel: 'Enabled', highestBidCents: 45, pausedBy: expect.stringMatching(/^Claude request \S+ paused it/) })
    expect(p.effect).toMatch(/Spend resumes: EUR 12.00 of daily budget, the highest bid serving again EUR 0.45\./)
    const asked = await ask('enable-ads', { campaignIds: ['c-p1'] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { enabled: 1 } })
    expect(await statusOf('Campaign', 'c-p1')).toBe('ENABLED')
    const [queued] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-p1'])
    expect(queued.payload.letsGo).toBeUndefined()
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'pause-ads', args: { campaignIds: ['c-p1'] } } })
    // The product ad Claude paused with it is still paused, and still Claude's to switch on.
    expect((await preview('enable-ads', { productAds: [{ adGroupId: 'g-c-p1', product: 'TEST-SKU-c-p1' }] })).ok).toBe(true)
  })

  it('never re-enables what a person paused in Nexus, what was paused at Amazon, nor one Amazon reported changed since', async () => {
    // A person's own pause on the Nexus screens.
    await inside(() => updateCampaignWithSync({ campaignId: 'c-p2', patch: { status: 'PAUSED' }, actor: 'user:u-person', manual: true }))
    expect((await preview('enable-ads', { campaignIds: ['c-p2'] })).error).toMatch(/^Not queued: enable-ads switches back on only what a Claude request paused .* campaign "Test c-p2": a person paused it in Nexus \(user:u-person/)
    // Paused at Amazon (Seller Central): the sync pulled PAUSED down; Nexus recorded no pause.
    await inside(() => database.client.campaign.update({ where: { id: 'c-p3' }, data: { status: 'PAUSED' } }))
    expect((await preview('enable-ads', { campaignIds: ['c-p3'] })).error).toMatch(/Nexus has no record of who paused it: it was paused at Amazon \(Seller Central\)/)
    // Claude paused it, then Amazon reported its status changed outside Nexus.
    const asked = await ask('pause-ads', { campaignIds: ['c-p4'] })
    await approve(asked.approvalId!)
    expect((await preview('enable-ads', { campaignIds: ['c-p4'] })).ok).toBe(true)
    await inside(() => database.client.adDrift.create({ data: { entityType: 'CAMPAIGN', entityId: 'c-p4', field: 'status', ourValue: 'PAUSED', amazonValue: 'ENABLED', classification: 'EXTERNAL_CHANGE' } }))
    expect((await preview('enable-ads', { campaignIds: ['c-p4'] })).error).toMatch(/Amazon reported its status changed outside Nexus since/)
    // An archived ad cannot be switched on at all.
    expect((await preview('enable-ads', { campaignIds: ['c-arch'] })).error).toMatch(/Amazon cannot switch an archived ad on again; to advertise it again, a new one is created/)
    expect((await preview('enable-ads', { campaignIds: ['c-p5'] })).error).toMatch(/^Nothing would change: campaign "Test c-p5" is already enabled/)
  })
})

/**
 * The fixed rule (agent-results/5 §12): a pause passes a halt — it lets go — and an enable does not. A request a person
 * approved passes as his own click either way (4A); this is the request the business's rule approved.
 */
describe('a halt: a pause by rule lets go, an enable by rule waits', () => {
  afterAll(async () => { await halt(false) })

  it('approved by the business\'s rule during a halt: a pause runs (letting go), an enable does not', async () => {
    const paused = await ask('pause-ads', { campaignIds: ['c-h2'] })
    await approve(paused.approvalId!)
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await halt(true)
    const pause = await ask('pause-ads', { campaignIds: ['c-h1'] })
    expect(await approveByRule(pause.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { paused: 1 } })
    expect(await statusOf('Campaign', 'c-h1')).toBe('PAUSED')
    const [row] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-h1'])
    expect(row.payload).toMatchObject({ letsGo: true, actor: 'user:u-approver' })
    expect(row.payload.manual).toBeUndefined()
    // The ads audit says the business's rule decided it.
    expect(row.payload.reason).toBe(`Claude request ${pause.approvalId} (run by rule): a real pause`)
    const enable = await ask('enable-ads', { campaignIds: ['c-h2'] })
    expect(await approveByRule(enable.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: .*(stopped|halt)/i) })
    expect(await statusOf('Campaign', 'c-h2')).toBe('PAUSED')
  })
})

describe('the limits: nothing runs alone by default; inside the strategy and the limits, it may', () => {
  const judge = (tool: string, p: unknown, limits: Record<string, unknown> = {}) => {
    const t = getTool(tool)!
    return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
  }

  it('without a strategy for the market, or at the default limits, a person decides', async () => {
    const p = (await preview('pause-ads', { campaignIds: ['c-lim'] })).preview
    expect(judge('pause-ads', p, { maxItems: 5 })).toMatch(/there is no ads strategy for IT/)
    expect(judge('pause-ads', { summary: 'no facts' })).toMatch(/no limit facts/)
  })

  it('with a strategy that allows it: inside at maxItems ≥ 1, outside at the default 0, outside for a kind the limits leave out', async () => {
    const row = await inside(() => database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 5000, maxBidCents: 40 } }))
    try {
      const p = (await preview('pause-ads', { campaignIds: ['c-lim'] })).preview
      expect(judge('pause-ads', p)).toMatch(/more than the 0 this tool's limits allow/)
      expect(judge('pause-ads', p, { maxItems: 5 })).toBeNull()
      expect(judge('pause-ads', p, { maxItems: 5, levels: ['target'] })).toMatch(/it changes campaigns, which this tool's limits do not let change by rule/)
      // The strategy narrows the kind: pause held at ask for the market.
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: { pause: 'ask' }, version: 2 } }))
      expect(judge('pause-ads', (await preview('pause-ads', { campaignIds: ['c-lim'] })).preview, { maxItems: 5 })).toMatch(/lets Claude only ask for pausing ads \(a real pause\)/)
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: null, version: 3 } }))
      // An enable never restarts a bid above the strategy's highest bid where it lands.
      const paused = await ask('pause-ads', { campaignIds: ['c-lim'] })
      await approve(paused.approvalId!)
      const e = (await preview('enable-ads', { campaignIds: ['c-lim'] })).preview
      expect(judge('enable-ads', e, { maxItems: 5 })).toMatch(/would serve again with a bid of EUR 0.45, above the highest bid EUR 0.40 \(ads strategy: Test market \(IT\)/)
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { maxBidCents: 60, version: 4 } }))
      expect(judge('enable-ads', (await preview('enable-ads', { campaignIds: ['c-lim'] })).preview, { maxItems: 5 })).toBeNull()
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
  })
})
