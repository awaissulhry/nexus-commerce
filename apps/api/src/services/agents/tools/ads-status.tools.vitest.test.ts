/**
 * ADS AUTONOMY AA-W2-12 — pause-ads and enable-ads, run for real through the door and the approval gate (PGlite,
 * production schema; the job queue a stub; the ads write gate the real one, sandbox unless a test goes live). Made-up ids.
 *
 * Proven: the preview names each ad from → to, what a paused campaign holds and the budget that stops, where it lands and
 * the strategy facts; what Nexus cannot change is refused and not queued; approved, it writes as the approver with
 * changeSetId = the approval and undo asks the other tool for the same ads; enable-ads switches on only what a Claude
 * request paused — never what a person paused, in Nexus or at Amazon; a pause run by the business's rule passes a halt
 * (it lets go) and an enable does not; the default limits let nothing run alone.
 *
 * W4-2 — asked with includePeoplesPauses, enable-ads also lifts a pause a person made (in Nexus or at Amazon), one Nexus
 * has no record of, one a writer Nexus did not record, and a Claude pause Amazon reported changed: each line says who
 * paused it and when and is marked needsCode, the preview carries stepUp, a plain approve does not run it and the
 * approver's code does; it never runs by rule, whatever the level and limits; a rule's pause stays refused, naming the
 * rule; who paused it is frozen, and a status change recorded after the approval refuses it.
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
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
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
import { setClaudeRule } from '../claude-trust.service.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { generateSecret, generateSync } from 'otplib'
import { updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { __claudeStrategyTest } from '../../advertising/ads-strategy/claude.js'
import { previewStaleness } from '../../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { claudeGateRule } from '../../mcp/mcp-tool-call.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'

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
    for (const id of ['c-p1', 'c-p2', 'c-p3', 'c-p4', 'c-p5', 'c-h1', 'c-h2', 'c-lim', 'c-a1', 'c-a2', 'c-a3', 'c-h3', 'c-w1', 'c-w2', 'c-w3', 'c-w4', 'c-w5', 'c-w6', 'c-w7', 'c-w8']) await campaign(id)
    // AA-W2-13 — a paused campaign whose keyword is paused too; a campaign advertising a product the strategy protects.
    await database.client.campaign.update({ where: { id: 'c-a2' }, data: { status: 'PAUSED' } })
    await database.client.adTarget.update({ where: { id: 't-c-a2' }, data: { status: 'PAUSED' } })
    const guarded = await database.client.product.create({ data: { sku: 'TEST-GUARDED-1', name: 'Test guarded', basePrice: '10.00' } })
    await database.client.adProductAd.update({ where: { id: 'pa-c-a3' }, data: { productId: guarded.id } })
    await campaign('c-arch', { status: 'ARCHIVED' })
    await campaign('c-draft', { status: 'DRAFT', externalCampaignId: null })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await halt(false); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('the tools as the contract holds them', () => {
  it('AA-W2-13 — archive-ads: strategy-bound, alwaysAsk, ceiling auto through the irreversible exception, no undo; at ask by default', () => {
    const tool = getTool('archive-ads')!
    expect(tool).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'none', openWorld: true, requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
    expect(tool.undo).toBeUndefined()
    expect(ruleFrom(tool, null).level).toBe('ask')
    expect(tool.limits!.parse({})).toMatchObject({ maxItems: 0 })
    expect(tool.description).toMatch(/PERMANENT: Amazon cannot switch an archived ad on again \(its API calls this delete\)/)
    expect(tool.description).toMatch(/the advice is to keep it that way/)
  })

  it('strategy-bound, alwaysAsk, ceiling auto, fully undoable; offered to Claude at ask (no row = ask)', () => {
    for (const name of ['pause-ads', 'enable-ads']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'full', openWorld: true, requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
      expect(ruleFrom(tool, null).level, name).toBe('ask')
      // By default nothing runs alone: every request waits for a person until he types a number.
      expect(tool.limits!.parse({})).toMatchObject({ maxItems: 0, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, levels: ['campaign', 'adGroup', 'target', 'productAd'] })
    }
    expect(getTool('pause-ads')!.description).toMatch(/lower its bids instead \(suppress-campaign/)
    // W4-2 — enable-ads lifts a person's pause only when asked so, with the approver's code; never a rule's. pause-ads unchanged.
    expect(getTool('enable-ads')!.description).toMatch(/By default only what a Claude request paused \(pause-ads\)\. With includePeoplesPauses: true, also an ad a person paused/)
    expect(getTool('enable-ads')!.description).toMatch(/it never runs by rule\. Never an ad a Nexus rule or engine paused/)
    expect(Object.keys((getTool('enable-ads')!.input as unknown as { shape: object }).shape)).toContain('includePeoplesPauses')
    expect(Object.keys((getTool('pause-ads')!.input as unknown as { shape: object }).shape)).not.toContain('includePeoplesPauses')
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
    // W4-2 — the refusal names the way a person's pause can be lifted: asked so, with the approver's code.
    expect((await preview('enable-ads', { campaignIds: ['c-p2'] })).error).toMatch(/ask again with includePeoplesPauses: true: a person then approves it in Nexus with their authenticator code, and it never runs by rule\.$/)
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

/** W4-2 — a status change Nexus records with no person behind it (an import, an old writer): no actor on the row. */
const unrecordedPause = (campaignId: string) => inside(async () => {
  await database.client.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } })
  await database.client.advertisingActionLog.create({ data: { userId: null, actionType: 'pause_campaign', entityType: 'CAMPAIGN', entityId: campaignId, payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'PAUSED' } } })
})
const personPause = (campaignId: string, who = 'user:u-person', status: 'PAUSED' | 'ENABLED' = 'PAUSED') =>
  inside(() => updateCampaignWithSync({ campaignId, patch: { status }, actor: who as `user:${string}`, manual: true }))
/** As the Approvals page records a decision taken with the approver's authenticator code. */
const withCode = (approvalId: string) => inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'nexus-step-up' } }))

describe('W4-2 — enable-ads lifts a person\'s pause only when asked so, with the approver\'s code', () => {
  beforeAll(async () => {
    await personPause('c-w1') // a person, on the Nexus screens
    await inside(() => database.client.campaign.update({ where: { id: 'c-w2' }, data: { status: 'PAUSED' } })) // Seller Central
    await unrecordedPause('c-w3') // a writer Nexus did not record
    // A Claude request paused it, then Amazon reported its status changed outside Nexus.
    const paused = await ask('pause-ads', { campaignIds: ['c-w4'] })
    await approve(paused.approvalId!)
    await inside(() => database.client.adDrift.create({ data: { entityType: 'CAMPAIGN', entityId: 'c-w4', field: 'status', ourValue: 'PAUSED', amazonValue: 'ENABLED', classification: 'EXTERNAL_CHANGE' } }))
    // Claude's own pause: as before.
    const own = await ask('pause-ads', { campaignIds: ['c-w5'] })
    await approve(own.approvalId!)
  })

  it('each pause no Claude request made: who paused it and when, needsCode, in raises, and the approver\'s code (stepUp)', async () => {
    const args = { campaignIds: ['c-w1', 'c-w2', 'c-w3', 'c-w4'], includePeoplesPauses: true }
    const r = await preview('enable-ads', args)
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'enable-ads', totals: { changing: 4, alreadyEnabled: 0 }, needsCode: 4,
      raises: ['campaign "Test c-w1"', 'campaign "Test c-w2"', 'campaign "Test c-w3"', 'campaign "Test c-w4"'],
      stepUp: { what: 'switches back on 4 ads paused by a person or by a writer Nexus cannot name', raises: ['Spend'], needs: STEP_UP_NEEDS, how: expect.stringMatching(/authenticator code.*Never by rule/) },
      whoPaused: {
        'campaign:c-w1': { by: 'person', actor: 'user:u-person', at: expect.any(String) },
        'campaign:c-w2': { by: 'none', lastRecorded: null },
        'campaign:c-w3': { by: 'unrecorded', actor: null, at: expect.any(String) },
        'campaign:c-w4': { by: 'amazon', approvalId: expect.any(String), at: expect.any(String) },
      },
      warning: expect.stringMatching(/No Claude request paused them \(each line says who did\): approving needs the approver's authenticator code\.$/),
    })
    // Amazon's report time moves with every reconcile while the difference stands: it is not frozen.
    expect(p.whoPaused['campaign:c-w4']).not.toHaveProperty('seenAt')
    expect(p.changes.map((c: Row) => [c.label, c.needsCode, c.pausedBy])).toEqual([
      ['campaign "Test c-w1"', true, expect.stringMatching(/^a person paused it in Nexus \(user:u-person, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/)],
      ['campaign "Test c-w2"', true, 'Nexus has no record of who paused it: it was paused at Amazon (Seller Central), or before Nexus kept a record'],
      ['campaign "Test c-w3"', true, expect.stringMatching(/^it was paused by a writer Nexus did not record \(/)],
      ['campaign "Test c-w4"', true, expect.stringMatching(/^Claude request \S+ paused it .*Amazon reported its status changed outside Nexus since/)],
    ])
    expect(p.effect).toMatch(/^Switches 4 ads back on at Amazon \(4 campaigns\): .* Not paused by a Claude request \(4 of 4\): .* Approving it needs the approver's authenticator code; it never runs by rule\. Spend resumes: EUR 48\.00 of daily budget/)
    // Without the option: today's refusal, naming it.
    expect((await preview('enable-ads', { campaignIds: ['c-w2'] })).error)
      .toMatch(/^Not queued: enable-ads switches back on only what a Claude request paused \(pause-ads\), unless asked with includePeoplesPauses: true\. campaign "Test c-w2": Nexus has no record of who paused it/)
  })

  it('Claude\'s own pause, with or without the option: as before — no code, nothing marked', async () => {
    for (const args of [{ campaignIds: ['c-w5'] }, { campaignIds: ['c-w5'], includePeoplesPauses: true }]) {
      const p = (await preview('enable-ads', args)).preview as Row
      expect(p).toMatchObject({ needsCode: 0, raises: ['campaign "Test c-w5"'], whoPaused: { 'campaign:c-w5': { by: 'claude' } } })
      expect(p).not.toHaveProperty('stepUp')
      expect(p.changes[0]).not.toHaveProperty('needsCode')
      expect(p.effect).toMatch(/^Switches 1 ad back on at Amazon that a Claude request paused/)
    }
    // Mixed: only the person's pause needs the code, and the request as a whole carries it.
    const mixed = (await preview('enable-ads', { campaignIds: ['c-w5', 'c-w1'], includePeoplesPauses: true })).preview as Row
    expect(mixed).toMatchObject({ needsCode: 1, stepUp: { what: 'switches back on 1 ad paused by a person or by a writer Nexus cannot name' } })
    expect(mixed.changes.map((c: Row) => c.needsCode ?? false)).toEqual([false, true])
    expect(mixed.warning).toMatch(/1 of them no Claude request paused \(each line says who did\)/)
  })

  it('a Nexus rule\'s pause stays refused, even with the option: the refusal names the rule and how to stop it first', async () => {
    const rule = await inside(() => database.client.automationRule.create({ data: { name: 'Test pause rule', domain: 'advertising', trigger: 'SCHEDULE' } }))
    await inside(() => updateAdTargetWithSync({ adTargetId: 't-c-w6', patch: { status: 'PAUSED' }, actor: `automation:${rule.id}` }))
    const ruled = (await preview('enable-ads', { targetIds: ['t-c-w6'], includePeoplesPauses: true })).error
    expect(ruled).toMatch(new RegExp(`^Not queued: keyword "term c-w6" \\(campaign "Test c-w6"\\): the Nexus rule "Test pause rule" paused it \\(automation:${rule.id}, .*\\)\\. A pause a Nexus rule or engine made is never switched back on, even with includePeoplesPauses: the rule would pause it again\\. Stop it first, then ask again — keyword "term c-w6" \\(campaign "Test c-w6"\\): switch the rule off \\(turn-down-automation, automation A1, rowId ${rule.id}, level OFF\\) or change it \\(save-ad-rule\\)\\.$`))
    // Without the option, a rule's pause alone: no offer of the option it would not help.
    const plain = (await preview('enable-ads', { targetIds: ['t-c-w6'] })).error
    expect(plain).toMatch(/^Not queued: enable-ads switches back on only what a Claude request paused \(pause-ads\)\. keyword "term c-w6"/)
    expect(plain).not.toMatch(/unless asked with includePeoplesPauses/)
    // An engine that is not a rule: named by its actor.
    await inside(async () => {
      await database.client.adTarget.update({ where: { id: 't-c-w7' }, data: { status: 'PAUSED' } })
      await database.client.advertisingActionLog.create({ data: { userId: 'automation:test-engine', actionType: 'pause_target', entityType: 'AD_TARGET', entityId: 't-c-w7', payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'PAUSED' } } })
    })
    expect((await preview('enable-ads', { targetIds: ['t-c-w7'], campaignIds: ['c-w1'], includePeoplesPauses: true })).error)
      .toMatch(/^Not queued: keyword "term c-w7" \(campaign "Test c-w7"\): a Nexus rule or engine paused it \(automation:test-engine, .*stop or change that engine \(list-automations names it\)\.$/)
  })

  it('a plain approve does not run it; approved with the code it runs as the approver; undo asks pause-ads', async () => {
    const asked = await ask('enable-ads', { campaignIds: ['c-w1'], includePeoplesPauses: true })
    expect(asked.approvalId).toBeTruthy()
    const stored = (await inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId! } }))).preview as Row
    expect(stored.stepUp).toMatchObject({ raises: ['Spend'] })
    const plain = await approve(asked.approvalId!) as Row
    expect(plain).toMatchObject({ ok: false, status: 'pending' })
    expect(plain.error).toMatch(/^Not run: it switches back on 1 ad paused by a person or by a writer Nexus cannot name, and that runs only when a person with settings\.security\.manage approved it with their authenticator code/)
    expect(await statusOf('Campaign', 'c-w1')).toBe('PAUSED')
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { enabled: 1, failed: 0 } })
    expect(await statusOf('Campaign', 'c-w1')).toBe('ENABLED')
    const [queued] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-w1'])
    expect(queued.payload).toMatchObject({ actor: 'user:u-approver', fieldChanges: [{ field: 'status', oldValue: 'PAUSED', newValue: 'ENABLED' }] })
    expect(queued.payload.reason).toMatch(/switching back on what a person paused, approved with the approver's authenticator code$/)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'pause-ads', args: { campaignIds: ['c-w1'] } } })
  })

  it('never by rule, whatever the level and the limits: the limits refuse it, the gate does not schedule it, and execute refuses a rule\'s run', async () => {
    const strategy = await inside(() => database.client.adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeAutonomy: { enable: 'auto' },
      claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 5000, maxBidCents: 100,
    } }))
    await inside(() => database.client.agentTool.create({ data: { name: 'enable-ads', riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', claudeLimits: { maxItems: 5 } } }))
    __claudeStrategyTest.reset()
    const tool = getTool('enable-ads')!
    const limits = tool.limits!.parse({ maxItems: 5 }) as Record<string, unknown>
    const mcp = { ...claude, business: { id: LEGACY_WORKSPACE_ID, name: 'Test business' }, scopes: ['nexus.read', 'nexus.write', 'nexus.run'], oauthGrantId: 'grant-w42' } as McpPrincipal
    const viaGate = (args: Record<string, unknown>) => inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return runOrQueueTool('enable-ads', args, mcp, run.id, { rule: claudeGateRule(mcp) })
    })
    try {
      // The control: Claude's own pause, inside the same strategy and limits, may run by rule.
      const own = (await preview('enable-ads', { campaignIds: ['c-w5'], includePeoplesPauses: true })).preview
      expect(tool.withinLimits!(own, limits)).toBeNull()
      const ownAsked = await viaGate({ campaignIds: ['c-w5'], includePeoplesPauses: true })
      expect(ownAsked).toMatchObject({ ok: true, mode: 'queued', rule: { by: 'rule', level: 'auto' } })
      await inside(() => database.client.agentApproval.update({ where: { id: ownAsked.approvalId! }, data: { status: 'rejected' } }))
      // A person's pause: never.
      const theirs = (await preview('enable-ads', { campaignIds: ['c-w2'], includePeoplesPauses: true })).preview
      expect(tool.withinLimits!(theirs, limits)).toMatch(/^it switches back on 1 ad paused by a person or by a writer Nexus cannot name: only a person approving with their authenticator code lifts that, never a rule; a person decides$/)
      expect(tool.withinLimits!(theirs, tool.limits!.parse({ maxItems: 100, levels: ['campaign', 'adGroup', 'target', 'productAd'] }) as Record<string, unknown>)).toMatch(/never a rule/)
      // A preview that does not say is a person's too.
      expect(tool.withinLimits!({ ...(own as Row), needsCode: undefined }, limits)).toMatch(/does not say whether it switches back on an ad a person paused/)
      const theirsAsked = await viaGate({ campaignIds: ['c-w2'], includePeoplesPauses: true })
      expect(theirsAsked).toMatchObject({ ok: true, mode: 'queued', rule: { by: 'person', level: 'auto', why: expect.stringMatching(/paused by a person or by a writer Nexus cannot name: only a person approving with their authenticator code lifts that, never a rule; a person approves it in Nexus$/) } })
      expect((await inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: theirsAsked.approvalId! } }))).status).toBe('pending')
      // The last door: a run the rule decided is refused in execute too.
      expect(await approveByRule(theirsAsked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: it switches back on 1 ad paused by a person or by a writer Nexus cannot name, which needs a person's authenticator code, never a rule\./) })
      expect(await statusOf('Campaign', 'c-w2')).toBe('PAUSED')
    } finally {
      await inside(async () => {
        await database.client.agentTool.deleteMany({ where: { name: 'enable-ads' } })
        await database.client.adsStrategy.delete({ where: { id: strategy.id } })
      })
      __claudeStrategyTest.reset()
    }
  })

  it('who paused it is frozen: a status change recorded after the approval refuses it, naming who paused it then and now', async () => {
    await personPause('c-w8')
    const args = { campaignIds: ['c-w8'], includePeoplesPauses: true }
    const asked = await ask('enable-ads', args)
    const stored = (await inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId! } }))).preview
    // Someone else switches it on and pauses it again: still paused, by another person.
    await personPause('c-w8', 'user:u-other', 'ENABLED')
    await personPause('c-w8', 'user:u-other')
    expect(await inside(() => previewStaleness('enable-ads', args, stored, asked.approvalId!))).toMatchObject({ stale: true, why: expect.stringMatching(/whoPaused changed/) })
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Not run: the status of campaign "Test c-w8" changed after it was approved: it was paused by a person in Nexus \(user:u-person, .*\), and now by a person in Nexus \(user:u-other, .*\)\. Ask for it again with the ads as they are now\.$/),
    })
    expect(await statusOf('Campaign', 'c-w8')).toBe('PAUSED')
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

describe('AA-W2-13 — archive-ads: for good', () => {
  it('previews each ad Enabled or Paused → Archived, everything a campaign holds stopping with it, and that it is permanent', async () => {
    const r = await preview('archive-ads', { campaignIds: ['c-a1', 'c-a2'] })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'archive-ads', totals: { changing: 2, alreadyArchived: 0 },
      // c-a2's paused keyword stops for good too; only c-a1 (enabled) has a budget that stops spending.
      holds: { adGroups: 2, targets: 2, productAds: 2 }, budgetsStop: { EUR: 1200 },
      permanent: 'PERMANENT: Amazon cannot switch an archived ad on again. Amazon\'s API calls this delete. Its reports keep its history. To advertise it again, a new one is created.',
      warning: expect.stringMatching(/^PERMANENT: .* To stop an ad for a while, lower its bids \(suppress-campaign\) or pause it \(pause-ads\) instead\.$/),
      limitFacts: { tool: 'archive-ads', action: 'archive' },
    })
    expect(p.changes.map((c: Row) => [c.label, c.fromLabel, c.toLabel])).toEqual([['campaign "Test c-a1"', 'Enabled', 'Archived'], ['campaign "Test c-a2"', 'Paused', 'Archived']])
    expect(p.effect).toMatch(/^Archives 2 ads at Amazon, for good \(2 campaigns\)/)
    expect((await preview('archive-ads', { campaignIds: ['c-arch'] })).error).toMatch(/^Nothing would change: campaign "Test c-arch" is already archived/)
    expect((await preview('archive-ads', { campaignIds: ['c-draft'] })).error).toMatch(/never sent to Amazon/)
  })

  it('approved, archives as the approver, marked as letting go (the worker sends it as Amazon\'s delete); it cannot be undone', async () => {
    const asked = await ask('archive-ads', { campaignIds: ['c-a1'], why: 'product discontinued' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { archived: 1, failed: 0 } })
    expect(await statusOf('Campaign', 'c-a1')).toBe('ARCHIVED')
    const [queued] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['c-a1'])
    expect(queued.payload).toMatchObject({ letsGo: true, fieldChanges: [{ field: 'status', oldValue: 'ENABLED', newValue: 'ARCHIVED' }] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).not.toMatchObject({ request: expect.anything() })
    // Amazon cannot switch it on again: enable-ads refuses it.
    expect((await preview('enable-ads', { campaignIds: ['c-a1'] })).error).toMatch(/Amazon cannot switch an archived ad on again/)
  })

  it('by rule: never the ads of a protected product, paused or not; default count 0; inside the strategy with a count above 0', async () => {
    const judge = (p: unknown, limits: Record<string, unknown> = {}) => getTool('archive-ads')!.withinLimits!(p, getTool('archive-ads')!.limits!.parse(limits) as Record<string, unknown>)
    const guarded = await inside(() => database.client.product.findFirstOrThrow({ where: { sku: 'TEST-GUARDED-1' }, select: { id: true } }))
    const rows = await inside(async () => [
      await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10 } }),
      await database.client.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: guarded.id, label: 'Test guarded', updatedBy: 'user:test', protect: true } }),
    ])
    try {
      const plain = (await preview('archive-ads', { campaignIds: ['c-a2'] })).preview
      expect(judge(plain)).toMatch(/more than the 0 this tool's limits allow/)
      expect(judge(plain, { maxItems: 5 })).toBeNull()
      await inside(() => database.client.campaign.update({ where: { id: 'c-a3' }, data: { status: 'PAUSED' } }))
      const guardedPreview = (await preview('archive-ads', { campaignIds: ['c-a3'] })).preview
      expect(judge(guardedPreview, { maxItems: 5 })).toMatch(/the ads strategy protects a product it advertises \(ads strategy: Test guarded.*\), so archiving its ads waits for a person/)
    } finally {
      await inside(() => database.client.adsStrategy.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }))
    }
  })

  it('approved by the business\'s rule during a halt: an archive runs (it lets go)', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await halt(true)
    try {
      const asked = await ask('archive-ads', { campaignIds: ['c-h3'] })
      expect(await approveByRule(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { archived: 1 } })
      expect(await statusOf('Campaign', 'c-h3')).toBe('ARCHIVED')
    } finally {
      await halt(false)
    }
  })

  it('raising what it may archive alone takes two codes: its level and its limits one at a time (a code is single use)', async () => {
    const secret = generateSecret()
    const person = await database.client.userProfile.create({ data: { email: 'archive-trust@example.test', status: 'active', displayName: 'Test Trust', twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
    const actor = { userId: person.id, label: 'Test Trust', canManage: true }
    const code = () => { __stepUpTest.reset(); return generateSync({ secret }) }
    try {
      expect(await inside(() => setClaudeRule(actor, 'archive-ads', { level: 'auto', limits: { maxItems: 1 }, code: code() })))
        .toMatchObject({ ok: false, status: 400, code: 'second_code_required', error: expect.stringMatching(/cannot be undone: raise its level and loosen its limits one at a time/) })
      expect(await inside(() => setClaudeRule(actor, 'archive-ads', { level: 'auto', code: code() }))).toMatchObject({ ok: true, rule: { level: 'auto' } })
      expect(await inside(() => setClaudeRule(actor, 'archive-ads', { limits: { maxItems: 1 } }))).toMatchObject({ ok: false, code: 'mfa_required' })
      expect(await inside(() => setClaudeRule(actor, 'archive-ads', { limits: { maxItems: 1 }, code: code() }))).toMatchObject({ ok: true, rule: { level: 'auto', limits: { maxItems: 1 } } })
      // Lowering is a free brake.
      expect(await inside(() => setClaudeRule(actor, 'archive-ads', { level: 'ask' }))).toMatchObject({ ok: true, rule: { level: 'ask' } })
      // A kind that can be undone raises both on one code, as before.
      expect(await inside(() => setClaudeRule(actor, 'pause-ads', { level: 'auto', limits: { maxItems: 1 }, code: code() }))).toMatchObject({ ok: true })
    } finally {
      await inside(() => database.client.agentTool.deleteMany({ where: { name: { in: ['archive-ads', 'pause-ads'] } } }))
    }
  })
})
