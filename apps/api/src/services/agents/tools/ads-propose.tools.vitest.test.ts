/**
 * NAF.C / MCP full control A4 — the fleet's ads tools, shared with Claude, run for real: through the one door
 * (call-tool.ts) and the approval gate (approval-gate.service.ts), on PGlite with the production schema and the
 * business-isolation policies. The job queue is a stub (nothing leaves the process); the ads write gate is the real one,
 * in sandbox mode unless a test switches Amazon Ads writes to live.
 *
 * set-target-bid (A4): previews in the campaign's own currency with the bid that lands; refuses, without queuing, what
 * the gate would refuse (not on the live-write allowlist), a pin, a non-SP campaign and a raise of a suppressed bid;
 * once approved it writes as the approver with changeSetId = the approval, records the change, and undo-change puts the
 * old bid back; a moved bid, a changed reach and a request made before the switch are never run.
 * create-negative-keyword (A5): ad-group negatives only, created as the approver, undone by undo-ad-change retiring
 * them; createNegative binds the live-write allowlist when it is given the campaign. graduate-keyword (A5): into the
 * named or the resolved harvest destination, created as the approver, undone by lowering it to the floor (d3).
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

// The queue row's destination account: on PGlite's single connection the account lookup cannot run beside the open
// enqueue transaction, and an ads row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { expirePreSwitchAdRequests } from '../../agent-fleet/approval-inbox.service.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

function person(userId: string, via: 'claude' | 'app' = 'claude'): UserPrincipal {
  return {
    kind: 'user', userId, label: `Person ${userId}`, via,
    permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
    workspace: business,
  }
}
const claude = person('u-asker')
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
const bidOf = (id: string) => inside(async () => (await database.client.adTarget.findUnique({ where: { id }, select: { bidCents: true } }))!.bidCents)
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.campaign.update({ where: { id: 'c-it' }, data: { dynamicBidding: { maxBidChangePct: 50 } } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('A4 — set-target-bid previews what lands, where, in which currency', () => {
  it('sandbox: the bid it starts from and the bid that lands, in the campaign\'s currency, with the bound automations', async () => {
    const r = await preview('set-target-bid', { targetId: 't-it', proposedBidCents: 55 })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'set-target-bid', currency: 'EUR', currentBidCents: 45, proposedBidCents: 55, deltaCents: 10,
      reach: { reach: 'sandbox' }, reachNote: expect.stringMatching(/nothing reaches Amazon/), alsoChangedBy: [],
      effect: 'Moves "race jacket" from EUR 0.45 to EUR 0.55 in Italy exact.',
    })
    const uk = await preview('set-target-bid', { targetId: 't-uk', proposedBidCents: 70 })
    expect(uk.preview).toMatchObject({ currency: 'GBP', effect: expect.stringContaining('GBP 0.60 to GBP 0.70') })
  })

  it('W4-4 — past the campaign\'s max-change guardrail: a person\'s approval sends the bid asked for after the card\'s warning; a run by rule writes the stepped bid', async () => {
    const r = await preview('set-target-bid', { targetId: 't-it', proposedBidCents: 200 })
    expect(r.preview).toMatchObject({
      proposedBidCents: 200, effectiveBidCents: 200, deltaCents: 155, byRuleBidCents: 68, byRuleSteppedBy: expect.stringContaining('max-change'),
      reach: { reach: 'sandbox', pastOwnLimits: [{ limit: 'bid_step', reason: expect.stringContaining('more than the largest bid change 50 % (the campaign\'s own max-change guardrail)') }] },
    })
    expect(r.preview).not.toHaveProperty('clampedBy')
  })

  it('live: it lands on the Amazon Ads profile; 4A — off the allowlist it lands too (an approved request is his click); a market Nexus does not send to is refused and not queued', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const ok = await preview('set-target-bid', { targetId: 't-it', proposedBidCents: 50 })
    expect(ok.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, reachNote: expect.stringContaining('P-IT-TEST') })
    const off = await preview('set-target-bid', { targetId: 't-off', proposedBidCents: 40 })
    expect(off.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' } })
    const uk = await preview('set-target-bid', { targetId: 't-uk', proposedBidCents: 70 })
    expect(uk).toEqual({ ok: false, error: expect.stringMatching(/^Not queued: .*does not change ads in UK/) })
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval"')
    const asked = await ask('set-target-bid', { targetId: 't-uk', proposedBidCents: 70 })
    expect(asked).toMatchObject({ ok: false, mode: 'error', error: expect.stringContaining('UK') })
    expect(await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval"')).toEqual(before)
  })

  it('refuses the floor, a non-SP campaign, a negative, a raise of a suppressed or floored bid (a pin no longer, 4A)', async () => {
    expect((await preview('set-target-bid', { targetId: 't-it', proposedBidCents: 4 })).error).toMatch(/below the 5c floor/)
    // 4A — a pin no longer refuses a request a person approves (his own click).
    expect((await preview('set-target-bid', { targetId: 't-pin', proposedBidCents: 50 })).ok).toBe(true)
    // W4-11 — a Sponsored Brands keyword's bid only in a campaign Nexus has read pays per click (ads-sbsd-tools.vitest.test.ts).
    expect((await preview('set-target-bid', { targetId: 't-sb', proposedBidCents: 50 })).error).toMatch(/has not read from Amazon whether it pays per click/)
    expect((await preview('set-target-bid', { targetId: 't-neg', proposedBidCents: 50 })).error).toMatch(/not found \(or is a negative\)/)
    expect((await preview('set-target-bid', { targetId: 't-sup', proposedBidCents: 30 })).error).toMatch(/is suppressed .*Restoring the campaign lifts it/)
    expect((await preview('set-target-bid', { targetId: 't-low', proposedBidCents: 30 })).error).toMatch(/sits at 3c/)
    expect((await preview('set-target-bid', { targetId: 'nope', proposedBidCents: 30 })).error).toMatch(/not found/)
  })
})

describe('A4 — an approved set-target-bid runs as the approver, once, and can be put back', () => {
  it('writes the bid with changeSetId = the approval, actor user:<approver>, the Claude request reason; records the change', async () => {
    const asked = await ask('set-target-bid', { targetId: 't-it', proposedBidCents: 52, why: 'converting well at 23% ACoS' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued', preview: expect.objectContaining({ reach: { reach: 'sandbox' } }) })
    const id = asked.approvalId!
    const done = await approve(id)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: expect.objectContaining({ changed: true, bidCents: 52, changeSetId: id }) })
    expect(await bidOf('t-it')).toBe(52)
    const [log] = await sql('SELECT "userId", "executionId", "actionType", "outboundQueueId" FROM "AdvertisingActionLog" WHERE "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1', ['t-it'])
    expect(log).toMatchObject({ userId: 'user:u-approver', executionId: id, actionType: 'AD_BID_UPDATE', outboundQueueId: expect.any(String) })
    const [history] = await sql('SELECT "changedBy", reason, "oldValue", "newValue" FROM "CampaignBidHistory" WHERE "entityId" = $1 ORDER BY "changedAt" DESC LIMIT 1', ['t-it'])
    expect(history).toEqual({ changedBy: 'user:u-approver', reason: `Claude request ${id}: converting well at 23% ACoS`, oldValue: '45', newValue: '52' })
    const [queued] = await sql('SELECT "syncType", "syncStatus" FROM "OutboundSyncQueue" WHERE id = $1', [log.outboundQueueId])
    expect(queued).toEqual({ syncType: 'AD_BID_UPDATE', syncStatus: 'PENDING' })
    const [change] = await sql('SELECT "toolName", before, after, "undoTool", "undoArgs", outbound FROM "AgentChange" WHERE "approvalId" = $1', [id])
    expect(change).toEqual({
      toolName: 'set-target-bid', outbound: true,
      before: { targetId: 't-it', bidCents: 45, changeSetId: id }, after: { targetId: 't-it', bidCents: 52 },
      undoTool: 'set-target-bid', undoArgs: { targetId: 't-it', proposedBidCents: 45, why: 'undo of an earlier bid change' },
    })
    // Once: a second approve of the same request is refused, and nothing is written twice.
    expect(await approve(id)).toMatchObject({ ok: false, error: 'already executed' })

    // Undo asks set-target-bid for the old bid — while the bid is still the one it wrote.
    const undo = await inside(() => undoRequestFor({ approvalId: id }))
    expect(undo).toMatchObject({ request: { tool: 'set-target-bid', args: { targetId: 't-it', proposedBidCents: 45 } } })
    await inside(() => database.client.adTarget.update({ where: { id: 't-it' }, data: { bidCents: 47 } }))
    expect(await inside(() => undoRequestFor({ approvalId: id }))).toEqual({ error: expect.stringMatching(/^Not undone: it has changed since this change ran/) })
    await inside(() => database.client.adTarget.update({ where: { id: 't-it' }, data: { bidCents: 45 } }))
  })

  it('a bid that moved after the person approved is not run, and nothing is written', async () => {
    const asked = await ask('set-target-bid', { targetId: 't-uk', proposedBidCents: 66 })
    await inside(() => database.client.adTarget.update({ where: { id: 't-uk' }, data: { bidCents: 61 } }))
    const out = await approve(asked.approvalId!)
    expect(out).toMatchObject({ ok: false, status: 'pending', error: expect.stringMatching(/^Not run: what you approved has moved since — currentBidCents changed/) })
    expect(await bidOf('t-uk')).toBe(61)
    expect(await sql('SELECT id FROM "AdvertisingActionLog" WHERE "executionId" = $1', [asked.approvalId])).toEqual([])
  })

  it('approved as sandbox, now live: not run', async () => {
    const asked = await ask('set-target-bid', { targetId: 't-it', proposedBidCents: 50 })
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const out = await approve(asked.approvalId!)
    expect(out).toMatchObject({ ok: false, error: 'Not run: it was approved as sandbox, and it would now be live (profile P-IT-TEST).' })
    expect(await bidOf('t-it')).toBe(45)
  })

  it('a request made before the switch (no stored reach) is never run, and the sweep expires it', async () => {
    const id = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'amazon-ads-director', trigger: 'schedule', status: 'done', mode: 'tick' } })
      const row = await database.client.agentApproval.create({
        data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', args: { targetId: 't-it', proposedBidCents: 50 }, preview: { action: 'set-target-bid', currentBidCents: 45, proposedBidCents: 50 }, status: 'pending' },
      })
      return row.id
    })
    expect(await approve(id)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: this request was made before approved ad changes could reach Amazon/) })
    expect(await bidOf('t-it')).toBe(45)
    expect(await inside(() => expirePreSwitchAdRequests())).toBe(1)
    const [row] = await sql('SELECT status, reason FROM "AgentApproval" WHERE id = $1', [id])
    expect(row).toEqual({ status: 'expired', reason: expect.stringMatching(/^expired: asked before approved ad changes could reach Amazon/) })
    // A request made after the switch is left alone.
    const fresh = await ask('set-target-bid', { targetId: 't-it', proposedBidCents: 49 })
    expect(await inside(() => expirePreSwitchAdRequests())).toBe(0)
    expect((await sql('SELECT status FROM "AgentApproval" WHERE id = $1', [fresh.approvalId]))[0]).toEqual({ status: 'pending' })
  })

  it('declares the change contract: open world, reversible, at most run by rule inside the ads strategy (AA-W2-6), material fields', () => {
    const tool = getTool('set-target-bid')!
    expect({ openWorld: tool.openWorld, reversibility: tool.reversibility, trust: tool.maxClaudeTrust, bound: tool.strategyBound, execute: typeof tool.execute, undo: !!tool.undo })
      .toEqual({ openWorld: true, reversibility: 'full', trust: 'auto', bound: 'amazon-ads', execute: 'function', undo: true })
  })
})

describe('A5 — create-negative-keyword: ad-group negatives only, executed once approved, undone by retiring it', () => {
  beforeAll(async () => {
    await inside(async () => {
      await database.client.amazonAdsSearchTerm.create({
        data: { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it', query: 'giacca pelle', impressions: 900, clicks: 25, costMicros: 42_000_000n, currencyCode: 'EUR', orders7d: 0, sales7dCents: 0 },
      })
      await database.client.adKeywordProtection.create({ data: { term: 'xavia', mode: 'WHITELIST', reason: 'brand term' } as never })
    })
  })
  const neg = { externalCampaignId: 'EXT-c-it', keywordText: 'giacca pelle', externalAdGroupId: 'EXT-g-c-it' }

  it('previews the term\'s record, the ad group and where it lands', async () => {
    const r = await preview('create-negative-keyword', neg)
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      term: 'giacca pelle', scope: 'AD_GROUP', campaign: { id: 'c-it', name: 'Italy exact' }, adGroup: { id: 'g-c-it', externalAdGroupId: 'EXT-g-c-it' },
      currency: 'EUR', metrics: { clicks: 25, costCents: 4200 }, alreadyNegated: false, reach: { reach: 'sandbox' },
      effect: expect.stringContaining('was EUR 42.00 with 0 orders'),
    })
  })

  it('refuses a campaign-level negative, a missing or foreign ad group, a protected or existing term, an unknown campaign', async () => {
    expect((await preview('create-negative-keyword', { ...neg, scope: 'CAMPAIGN' })).error).toMatch(/^Campaign-level negatives are not offered/)
    expect((await preview('create-negative-keyword', { externalCampaignId: 'EXT-c-it', keywordText: 'giacca pelle' })).error).toMatch(/^Name the ad group/)
    expect((await preview('create-negative-keyword', { ...neg, externalAdGroupId: 'EXT-g-c-uk' })).error).toMatch(/ad group EXT-g-c-uk not found in Italy exact/)
    expect((await preview('create-negative-keyword', { ...neg, keywordText: 'xavia' })).error).toBe('"xavia" cannot be negated: it matches the protected term "xavia" (brand term).')
    expect((await preview('create-negative-keyword', { ...neg, keywordText: 'FREE' })).error).toMatch(/already negated/)
    expect((await preview('create-negative-keyword', { ...neg, externalCampaignId: 'EXT-nope' })).error).toMatch(/not found/)
    expect((await preview('create-negative-keyword', { externalCampaignId: 'EXT-c-sb', keywordText: 'x', externalAdGroupId: 'EXT-g-c-sb' })).error).toMatch(/not a Sponsored Products campaign/)
  })

  // 5a — the write gate's matcher: phrase-aware, Amazon's text limits, and binding in sandbox before anything is written.
  it('refuses a phrase that a protected term contains and a text Amazon would not take; createNegative refuses a protected term in sandbox', async () => {
    await inside(() => database.client.adKeywordProtection.create({ data: { term: 'xavia gale', mode: 'WHITELIST', matchType: 'CONTAINS' } as never }))
    expect((await preview('create-negative-keyword', { ...neg, keywordText: 'gale', matchType: 'NEGATIVE_PHRASE' })).error)
      .toBe('"gale" cannot be a phrase negative: it would also block searches for the protected term "xavia gale".')
    expect((await preview('create-negative-keyword', { ...neg, keywordText: 'gale', matchType: 'NEGATIVE_EXACT' })).ok).toBe(true)
    expect((await preview('create-negative-keyword', { ...neg, keywordText: 'giacca moto donna estiva rete', matchType: 'NEGATIVE_PHRASE' })).error)
      .toMatch(/has 5 words; Amazon accepts at most 4 in a negative phrase keyword/)
    const { createNegative } = await import('../../advertising/ads-negative-kw.service.js')
    const denied = await inside(() => createNegative({ profileId: 'P-IT-TEST', externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: 'gale', matchType: 'NEGATIVE_PHRASE', scope: 'AD_GROUP', marketplace: 'IT', nexusCampaignId: 'c-it' }))
    expect(denied).toMatchObject({ ok: false, mode: 'sandbox', denied: { deniedAt: 'keyword_protected' } })
    await inside(() => database.client.adKeywordProtection.deleteMany({ where: { term: 'xavia gale' } }))
  })

  it('live: 4A — off the allowlist an approved request still lands (his click); createNegative from an engine is bound by the allowlist', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('create-negative-keyword', { externalCampaignId: 'EXT-c-off', keywordText: 'cheap', externalAdGroupId: 'EXT-g-c-off' })).preview)
      .toMatchObject({ reach: { reach: 'live' } })
    const { createNegative } = await import('../../advertising/ads-negative-kw.service.js')
    const denied = await inside(() => createNegative({ profileId: 'P-IT-TEST', externalCampaignId: 'EXT-c-off', externalAdGroupId: 'EXT-g-c-off', keywordText: 'cheap', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: 'IT', nexusCampaignId: 'c-off' }))
    expect(denied).toMatchObject({ ok: false, denied: { deniedAt: 'campaign_allowlist' } })
  })

  it('approved, it creates the negative as the approver; undo-change asks undo-ad-change, which retires it', async () => {
    const asked = await ask('create-negative-keyword', { ...neg, why: 'spent 42 with no order' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { created: true, reachedAmazon: false, note: expect.stringMatching(/^Sandbox/) } })
    const targetId = (done.result as Row).targetId as string
    const [row] = await sql('SELECT "isNegative", "negativeLevel", "expressionType", "expressionValue", "adGroupId" FROM "AdTarget" WHERE id = $1', [targetId])
    expect(row).toEqual({ isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT', expressionValue: 'giacca pelle', adGroupId: 'g-c-it' })
    const [change] = await sql('SELECT before, after, "undoTool", "undoArgs" FROM "AgentChange" WHERE "approvalId" = $1', [asked.approvalId])
    expect(change).toEqual({
      before: { changeSetId: asked.approvalId, negatives: [] }, after: { negatives: [{ targetId }] },
      undoTool: 'undo-ad-change', undoArgs: { changeSetId: asked.approvalId, why: 'undo of a negative keyword' },
    })
    // Asked again: the term is negated now, so it is refused rather than duplicated.
    expect((await preview('create-negative-keyword', neg)).error).toMatch(/already negated/)

    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'undo-ad-change', args: { changeSetId: asked.approvalId } } })
    const p = await preview('undo-ad-change', { changeSetId: asked.approvalId })
    expect(p.preview).toMatchObject({ rows: [], negatives: [{ targetId, keywordText: 'giacca pelle' }], effect: expect.stringMatching(/^Undo removes the negative keyword it created at Amazon/) })
    const retire = await ask('undo-ad-change', { changeSetId: asked.approvalId })
    expect(await approve(retire.approvalId!)).toMatchObject({ ok: true, result: { negatives: { retired: 1, refused: 0, failed: 0 } } })
    // A negative that never reached Amazon is removed here: nothing was there to archive.
    expect(await sql('SELECT id FROM "AdTarget" WHERE id = $1', [targetId])).toEqual([])
    expect((await sql('SELECT "undoneAt" IS NOT NULL AS undone FROM "AgentChange" WHERE "approvalId" = $1', [asked.approvalId]))[0]).toEqual({ undone: true })
  })
})

describe('A5 — graduate-keyword: into the named or resolved ad group, executed once approved, undone to the floor', () => {
  it('previews the suggested bid from real cost and clicks, the ad group, where it lands', async () => {
    const r = await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it' })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({ query: 'giacca pelle', suggestedBidCents: 168, destination: { id: 'c-it' }, destinationAdGroup: { id: 'g-c-it', why: 'named in the request' }, currency: 'EUR', reach: { reach: 'sandbox' } })
  })

  it('without a named ad group it takes the stored harvest destination — another campaign of the market; one gone or in another market is refused by name (batch 2 re-review fix)', async () => {
    await inside(() => database.client.adsHarvestDestination.create({ data: { scopeGrain: 'campaign', scopeId: 'c-it', matchType: 'EXACT', adGroupId: 'g-c-pin', updatedBy: 'test' } }))
    const r = await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it' })
    expect(r.preview).toMatchObject({ destination: { id: 'c-pin' }, destinationAdGroup: { id: 'g-c-pin', externalAdGroupId: 'EXT-g-c-pin', why: 'the harvest destination stored for this scope' }, currency: 'EUR' })
    // A named destination campaign that is not where the stored destination is: refused, name the ad group.
    expect((await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it', destExternalCampaignId: 'EXT-c-it' })).error)
      .toMatch(/harvest destination for this term is in Italy pinned/)
    // His stored destination in another market, or gone: refused by name, never the resolver's own pick.
    await inside(() => database.client.adsHarvestDestination.updateMany({ data: { adGroupId: 'g-c-uk' } }))
    expect((await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it' })).error)
      .toMatch(/^The harvest destination stored for this match type \(at the campaign grain\), “group c-uk”, is in UK, but this search term is from IT, so nothing was created\..* Or name one: destExternalAdGroupId\./)
    await inside(() => database.client.adsHarvestDestination.updateMany({ data: { adGroupId: 'g-no-such-group' } }))
    expect((await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it' })).error)
      .toMatch(/^The harvest destination stored for this match type \(at the campaign grain\) no longer exists, so nothing was created/)
    await inside(() => database.client.adsHarvestDestination.deleteMany({}))
  })

  it('the destination stored for the source\'s product line is taken (batch 2 re-review fix: the line grain, as the Keyword Harvest page and the brain read it)', async () => {
    const line = await inside(() => database.client.product.create({ data: { sku: 'TEST-B2RF-LINE', name: 'Test line', basePrice: '10.00', amazonAsin: 'B0TESTLINE' } }))
    await inside(async () => {
      await database.client.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: line.id, asin: 'B0TESTLINE' } })
      await database.client.adsHarvestDestination.create({ data: { scopeGrain: 'line', scopeId: line.id, matchType: 'EXACT', adGroupId: 'g-c-pin', updatedBy: 'test' } })
    })
    try {
      const r = await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it' })
      expect(r.preview, r.error).toMatchObject({ destination: { id: 'c-pin' }, destinationAdGroup: { id: 'g-c-pin', why: 'the harvest destination stored for this scope' } })
    } finally {
      await inside(async () => {
        await database.client.adsHarvestDestination.deleteMany({})
        await database.client.adProductAd.deleteMany({ where: { asin: 'B0TESTLINE' } })
      })
    }
  })

  it('refuses no ad group to go to, an existing exact keyword, a non-SP destination (a pin no longer, 4A)', async () => {
    expect((await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it' })).error).toMatch(/^Name the ad group to add the keyword to/)
    // 4A — a pin no longer refuses a request a person approves.
    expect((await preview('graduate-keyword', { query: 'giacca pelle', sourceExternalCampaignId: 'EXT-c-it', destExternalCampaignId: 'EXT-c-pin', destExternalAdGroupId: 'EXT-g-c-pin' })).ok).toBe(true)
    expect((await preview('graduate-keyword', { query: 'race jacket', sourceExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it' })).error).toMatch(/already exists/)
    expect((await preview('graduate-keyword', { query: 'x', sourceExternalCampaignId: 'EXT-c-it', destExternalCampaignId: 'EXT-c-sb', destExternalAdGroupId: 'EXT-g-c-sb' })).error).toMatch(/not a Sponsored Products campaign/)
  })

  it('approved, it creates the EXACT keyword as the approver; undo lowers it to the floor, never pausing it', async () => {
    const asked = await ask('graduate-keyword', { query: 'pelle nera', sourceExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it', bidCents: 37 })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { bidCents: 37, reachedAmazon: false } })
    const targetId = (done.result as Row).targetId as string
    expect((await sql('SELECT "expressionType", "bidCents", "isNegative", status FROM "AdTarget" WHERE id = $1', [targetId]))[0])
      .toEqual({ expressionType: 'EXACT', bidCents: 37, isNegative: false, status: 'ENABLED' })
    expect((await sql('SELECT "userId" FROM "AdvertisingActionLog" WHERE "entityId" = $1 AND "actionType" = $2', [targetId, 'create_keyword']))[0]).toEqual({ userId: 'user:u-approver' })
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'set-target-bid', args: { targetId, proposedBidCents: 5 } } })
    expect(getTool('graduate-keyword')!.reversibility).toBe('partial')
  })
})

/**
 * PB-6a (L2) — winners stay: graduate-keyword refuses a term that already lives as an exact keyword for the SAME product
 * (an ad group in the market advertising what the destination advertises), and never refuses one another product holds:
 * two products may buy the same keyword (the Owner's rule 3). Made-up ASINs.
 */
describe('PB-6a — graduate-keyword never creates a winner twice for one product', () => {
  it('refuses a term at home for the same product; allows a term another product holds', async () => {
    await inside(async () => {
      for (const [adGroupId, asin] of [['g-c-it', 'B0TESTSAME'], ['g-c-pin', 'B0TESTSAME'], ['g-c-off', 'B0TESTOTHR']]) {
        await database.client.adProductAd.create({ data: { adGroupId, asin } })
      }
    })
    const same = await preview('graduate-keyword', { query: 'Pinned Jacket', sourceExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it' })
    expect(same.ok).toBe(false)
    expect(same.error).toMatch(/already lives as an exact keyword in Italy pinned › group c-pin, which advertises the same product/)
    const other = await preview('graduate-keyword', { query: 'winter jacket', sourceExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it' })
    expect(other.ok, other.error).toBe(true)

    // A destination shared with another product: only the product the term converted for counts (nit b). The term
    // converted in c-pin (the SAME product only); c-it also advertises the other product, whose ad group holds it.
    await inside(() => database.client.adProductAd.create({ data: { adGroupId: 'g-c-it', asin: 'B0TESTOTHR' } }))
    const shared = await preview('graduate-keyword', { query: 'winter jacket', sourceExternalCampaignId: 'EXT-c-pin', sourceExternalAdGroupId: 'EXT-g-c-pin', destExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it' })
    expect(shared.ok, shared.error).toBe(true)
    await inside(() => database.client.adProductAd.deleteMany({ where: { asin: { in: ['B0TESTSAME', 'B0TESTOTHR'] } } }))
  })

  it('a sibling variant of one parent is the same product: its exact keyword is a home', async () => {
    await inside(async () => {
      const parent = await database.client.product.create({ data: { sku: 'TEST-PB6A-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })
      const [kid1, kid2] = await Promise.all(['1', '2'].map((n) => database.client.product.create({ data: { sku: `TEST-PB6A-KID${n}`, name: `Test kid ${n}`, basePrice: '10.00', parentId: parent.id, amazonAsin: `B0TESTKID${n}` } })))
      await database.client.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: kid1.id, asin: 'B0TESTKID1' } })
      await database.client.adProductAd.create({ data: { adGroupId: 'g-c-pin', productId: kid2.id, asin: 'B0TESTKID2' } })
    })
    const sibling = await preview('graduate-keyword', { query: 'pinned jacket', sourceExternalCampaignId: 'EXT-c-it', destExternalAdGroupId: 'EXT-g-c-it' })
    expect(sibling.error).toMatch(/already lives as an exact keyword in Italy pinned › group c-pin/)
    await inside(() => database.client.adProductAd.deleteMany({ where: { asin: { in: ['B0TESTKID1', 'B0TESTKID2'] } } }))
  })
})
