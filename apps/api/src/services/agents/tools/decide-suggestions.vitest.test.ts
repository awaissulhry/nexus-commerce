/**
 * MCP full control R11 — decide-automation-suggestions, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: a batch applies and dismisses through the Suggestions page's own decide path; a pausing suggestion, one on a
 * target held at the floor by no-pause suppression, one already decided, and any apply while ads automation is halted
 * are refused before anything waits for a person; each family needs its own permission; a dismissal's undo restores it,
 * an applied one is undone from the Change Log; eBay never approves a removal; another business's suggestion is not found.
 * D7 — each Amazon apply says where it lands (live or sandbox), one Amazon's write gate would refuse is not queued, and
 * a decision records the person who approved it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// Wrapped as db.ts wraps it (AA-W2-10): inside a transaction, `prisma.x` is that transaction's client — an ad write
// opens one (the queue row and its typed rows), and on the raw client its inner queries waited for the only connection.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r11_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)]
const as = (permissions: string[]): UserPrincipal => ({ kind: 'user', userId: 'u-r11', label: 'R11 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business(A), via: 'claude' })
const person = as(everything)
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>, who = person) => (await callTool(who, 'decide-automation-suggestions', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'decide-automation-suggestions', args, { via: 'claude' })).raw as Out
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  const { ACTION_HANDLERS } = await import('../../automation-rule.service.js')
  ACTION_HANDLERS.tst_ok = (async (action: { type: string }) => ({ type: action.type, ok: true, output: { applied: 'test' } })) as never
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const db = database.client
    const campaign = await db.campaign.create({ data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT' } })
    const adGroup = await db.adGroup.create({ data: { campaignId: campaign.id, name: 'TEST AG' } })
    const target = await db.adTarget.create({ data: { adGroupId: adGroup.id, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'test term', bidCents: 2, suppressedFromBidCents: 60 } })
    // 4l — a suggestion is applied only while its rule stands behind it, so the rule exists (on, at PROPOSE).
    await db.automationRule.create({ data: { id: 'tst-rule', domain: 'advertising', name: 'TEST rule', trigger: 'SCHEDULE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', actions: [], conditions: [] } })
    const sug =(key: string, entityType: string, entityId: string, action: object, status = 'pending') => db.adsRuleSuggestion.create({
      data: { ruleId: 'tst-rule', ruleName: 'TEST rule', marketplace: 'IT', entityType, entityId, entityName: `TEST ${key}`, proposedAction: action, proposedKey: key, status },
    })
    ids.apply = (await sug('k-apply', 'CAMPAIGN', campaign.id, { type: 'tst_ok' })).id
    ids.dismiss = (await sug('k-dismiss', 'CAMPAIGN', campaign.id, { type: 'tst_ok', value: 1 })).id
    ids.pause = (await sug('k-pause', 'CAMPAIGN', campaign.id, { type: 'pause_campaign' })).id
    ids.suppressed = (await sug('k-supp', 'AD_TARGET', target.id, { type: 'bid_apply', op: 'setValue', value: 0.8 })).id
    ids.done = (await sug('k-done', 'CAMPAIGN', campaign.id, { type: 'tst_ok' }, 'applied')).id
    ids.bid = (await sug('k-bid', 'CAMPAIGN', campaign.id, { type: 'bid_down', value: 10 })).id
    ids.ebayPause = (await db.ebayAdsProposal.create({ data: { kind: 'pause_ad', entityRef: { campaignId: 'TEST-EBAY-CMP', listingId: 'TEST-ITEM' }, proposedAction: {}, proposedKey: 'e-pause' } })).id
    // D7 — a negative on a protected term (the write gate refuses it even in sandbox), and a bid on a target that is gone.
    ids.campaign = campaign.id
    await db.campaign.create({ data: { name: 'TEST CAMPAIGN 2', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-EXT-1' } })
    await db.adKeywordProtection.create({ data: { term: 'test protected', mode: 'WHITELIST', reason: 'TEST brand term' } as never })
    ids.protectedNeg = (await sug('k-neg', 'SEARCH_TERM', 'TEST-EXT-1:test protected', { type: 'add_negative_exact' })).id
    ids.gone = (await sug('k-gone', 'AD_TARGET', 'TEST-GONE-TARGET', { type: 'bid_down', percent: 10 })).id
  })
  await inside(() => database.client.adsRuleSuggestion.create({ data: { ruleId: 'r', entityType: 'CAMPAIGN', entityId: 'c', proposedAction: { type: 'tst_ok' }, proposedKey: 'other' } }).then((s) => { ids.other = s.id }), OTHER)
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R11 — decide-automation-suggestions', () => {
  it('a batch applies and dismisses through the Suggestions page’s own path; dismissals undo, applies do not', async () => {
    const args = { kind: 'amazon-ads', decisions: [{ suggestionId: ids.apply, decide: 'apply' }, { suggestionId: ids.dismiss, decide: 'dismiss' }] }
    const preview = await dry(args)
    expect(preview.preview).toMatchObject({ action: 'decide-automation-suggestions', items: [{ suggestionId: ids.apply, decide: 'apply', status: 'pending' }, { suggestionId: ids.dismiss, decide: 'dismiss' }] })
    // D7 — the apply says where it lands, as the write gate answers (sandbox here); a dismissal lands nowhere.
    expect(preview.preview!.items[0]).toMatchObject({ landsOn: { scope: 'campaign', campaignId: ids.campaign, marketplace: 'IT' }, reach: { reach: 'sandbox' } })
    expect(preview.preview!.items[1]).not.toHaveProperty('reach')
    expect(preview.preview!.effect).toContain('1 to apply at Amazon, through the write gate (0 live, 1 in sandbox)')
    expect(preview.preview!.reachNote).toContain('sandbox: after approval they are recorded in Nexus only')
    const out = await run(args)
    expect(out).toMatchObject({ ok: true, data: { decided: 2 } })
    expect(out.change!.after.items).toEqual([{ id: ids.apply, status: 'applied' }, { id: ids.dismiss, status: 'dismissed' }])
    // D7 — each decision records the person who approved it, not the page's anonymous 'operator'.
    const decided = await inside(() => database.client.adsRuleSuggestion.findMany({ where: { id: { in: [ids.apply, ids.dismiss] } }, select: { id: true, decidedBy: true } }))
    expect(Object.fromEntries(decided.map((r) => [r.id, r.decidedBy]))).toEqual({ [ids.apply]: 'user:u-r11', [ids.dismiss]: 'user:u-r11' })
    const tool = getTool('decide-automation-suggestions')!
    expect(tool.undo!.request(out.change!)).toEqual({ refusal: '1 of these suggestions were applied: what they changed at Amazon is undone from the Change Log in Nexus.' })
    const dismissed = { before: { kind: 'amazon-ads', items: [{ id: ids.dismiss, status: 'pending' }] }, after: { kind: 'amazon-ads', items: [{ id: ids.dismiss, status: 'dismissed' }] } }
    expect(await inside(() => tool.undo!.current(dismissed))).toEqual(dismissed.after)
    const request = tool.undo!.request(dismissed) as { tool: string; args: Record<string, unknown> }
    expect(request).toEqual({ tool: 'decide-automation-suggestions', args: { kind: 'amazon-ads', decisions: [{ suggestionId: ids.dismiss, decide: 'restore' }] } })
    expect(await run(request.args)).toMatchObject({ ok: true })
    expect(await inside(() => database.client.adsRuleSuggestion.findUniqueOrThrow({ where: { id: ids.dismiss } }))).toMatchObject({ status: 'pending' })
  })

  it('never pause; never lift a suppressed target; never twice — refused before anything waits, each named', async () => {
    const out = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.pause, decide: 'apply' }, { suggestionId: ids.suppressed, decide: 'apply' }, { suggestionId: ids.done, decide: 'dismiss' }] })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('pause_campaign refused — it pauses — never (Owner rule: lower bids, never pause); dismiss it and use lower_bid_to_floor')
    expect(out.error).toContain('TEST k-supp: its target is held at the floor bid by no-pause suppression')
    expect(out.error).toContain('TEST k-done: it is applied')
    // Dismissing the pausing suggestion is fine.
    expect((await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.pause, decide: 'dismiss' }] })).ok).toBe(true)
  })

  it('D7 — an apply Amazon\'s write gate would refuse, or whose campaign is gone, is not queued; dismissing it is fine', async () => {
    const out = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.protectedNeg, decide: 'apply' }, { suggestionId: ids.gone, decide: 'apply' }] })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Not queued')
    expect(out.error).toContain('TEST k-neg: Amazon\'s write gate refuses it')
    expect(out.error).toContain('TEST k-gone: its campaign is not found in Nexus')
    expect((await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.protectedNeg, decide: 'dismiss' }, { suggestionId: ids.gone, decide: 'dismiss' }] })).ok).toBe(true)
  })

  it('each family needs its own permission; nothing is applied while ads automation is halted', async () => {
    const noBids = as(everything.filter((p) => p !== FEATURES.adsBidsEdit))
    expect((await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.bid, decide: 'dismiss' }] }, noBids)).error).toContain('a bids suggestion needs the ads.bids.edit permission')
    await inside(() => database.client.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', halted: true, haltReason: 'TEST halt' }, update: { halted: true, haltReason: 'TEST halt' } }))
    expect((await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.bid, decide: 'apply' }] })).error).toContain('ads automation is halted')
    expect((await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.bid, decide: 'dismiss' }] })).ok).toBe(true)
  })

  it('eBay never approves a removal; another business’s suggestion is not found', async () => {
    expect((await dry({ kind: 'ebay-ads', decisions: [{ suggestionId: ids.ebayPause, decide: 'apply' }] })).error).toContain('pause_ad')
    expect((await dry({ kind: 'ebay-ads', decisions: [{ suggestionId: ids.ebayPause, decide: 'dismiss' }] })).ok).toBe(true)
    expect(await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.other, decide: 'dismiss' }] })).toEqual({ ok: false, error: `Suggestions not found in this business: ${ids.other} (not found).` })
  })
})

/**
 * AA-W2-10 — decided by the business's rule: inside the ads strategy where each apply lands and the tool's limits per
 * family; an apply run by an approval writes as its rule, joins the approval's change set (undo-ad-change finds it) with
 * an audit reason naming the request and who decided it; one decided by rule is not a person's write.
 */
describe('AA-W2-10 — decide-automation-suggestions by rule', () => {
  const tool = () => getTool('decide-automation-suggestions')!
  const defaults = () => tool().limits!.parse({}) as Record<string, unknown>
  const seen: Array<Record<string, unknown>> = []
  const w2: Record<string, string> = {}

  beforeAll(async () => {
    const { ACTION_HANDLERS } = await import('../../automation-rule.service.js')
    // A handler that records how it was asked, and makes one negative as an approved apply would.
    ACTION_HANDLERS.tst_meta = (async (action: { type: string }, _context: unknown, meta: Record<string, unknown> & { approval?: { negatives: string[] } }) => {
      seen.push({ ...meta, approval: meta.approval ? { ...meta.approval } : undefined })
      meta.approval?.negatives.push(w2.negative)
      return { type: action.type, ok: true, output: {} }
    }) as never
    await inside(async () => {
      const db = database.client
      await db.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', halted: false }, update: { halted: false, haltReason: null } })
      const campaign = await db.campaign.create({ data: { name: 'TEST W2 CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-EXT-W2' } })
      const adGroup = await db.adGroup.create({ data: { campaignId: campaign.id, name: 'TEST W2 AG', externalAdGroupId: 'TEST-EXT-AG-W2' } })
      const target = await db.adTarget.create({ data: { adGroupId: adGroup.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test w2 term', bidCents: 50, externalTargetId: 'TEST-EXT-T-W2' } })
      w2.negative = (await db.adTarget.create({ data: { adGroupId: adGroup.id, kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'test w2 negative', isNegative: true, bidCents: 0 } })).id
      const sug = (key: string, entityType: string, entityId: string, action: object) => db.adsRuleSuggestion.create({
        data: { ruleId: 'tst-rule', ruleName: 'TEST rule', marketplace: 'IT', entityType, entityId, entityName: `TEST ${key}`, proposedAction: action, proposedKey: key },
      })
      w2.cut = (await sug('w2-cut', 'AD_TARGET', target.id, { type: 'bid_down', percent: 10 })).id
      w2.raise = (await sug('w2-raise', 'AD_TARGET', target.id, { type: 'bid_up', percent: 10 })).id
      w2.sweep = (await sug('w2-sweep', 'ACCOUNT', 'account', { type: 'harvest_and_negate' })).id
      w2.dismiss = (await sug('w2-dismiss', 'CAMPAIGN', campaign.id, { type: 'tst_ok' })).id
      w2.metaByRule = (await sug('w2-meta-rule', 'CAMPAIGN', campaign.id, { type: 'tst_meta' })).id
      w2.metaByPerson = (await sug('w2-meta-person', 'CAMPAIGN', campaign.id, { type: 'tst_meta' })).id
      w2.write = (await sug('w2-write', 'AD_TARGET', target.id, { type: 'bid_down', percent: 20, adTargetId: target.id })).id
      w2.target = target.id
    })
  }, 60_000)

  it('the preview carries the strategy\'s facts; without a strategy for the market nothing runs by rule', async () => {
    const out = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: w2.cut, decide: 'apply' }] })
    expect(out.ok).toBe(true)
    expect(out.preview!.limitFacts).toMatchObject({ tool: 'decide-automation-suggestions', action: 'suggestion', this: { markets: ['IT'], items: 1, cuts: 1, largestCutPct: 10 } })
    expect(out.preview!.suggestions).toMatchObject({ decisions: 1, applies: 1, unjudged: 0, bids: { largestCutPct: 10 } })
    expect(out.preview!.limitsNote).toEqual(expect.arrayContaining([expect.stringContaining('IT: no ads strategy')]))
    expect(tool().withinLimits!(out.preview, defaults())).toContain('there is no ads strategy for IT')
  })

  it('inside the strategy a bid cut runs by rule; a raise, a sweep and an eBay proposal wait for a person; dismissals run', async () => {
    await inside(() => database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeMaxChangesPerDay: 10, version: 1, updatedBy: 'user:test' } }))
    const cut = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: w2.cut, decide: 'apply' }] })
    expect(tool().withinLimits!(cut.preview, defaults())).toBeNull()
    const raise = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: w2.raise, decide: 'apply' }] })
    expect(tool().withinLimits!(raise.preview, defaults())).toContain('raise')
    expect(tool().withinLimits!(raise.preview, { ...defaults(), maxBidRaisePct: 10 })).toContain('most raises Claude may run by rule a day') // the strategy sets no raises a day: 0
    const sweep = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: w2.sweep, decide: 'apply' }] })
    expect(tool().withinLimits!(sweep.preview, defaults())).toContain('it acts across a market or the account')
    const dismissals = await dry({ kind: 'amazon-ads', decisions: [{ suggestionId: w2.raise, decide: 'dismiss' }, { suggestionId: w2.sweep, decide: 'dismiss' }] })
    expect(tool().withinLimits!(dismissals.preview, defaults())).toBeNull()
    const ebay = await dry({ kind: 'ebay-ads', decisions: [{ suggestionId: ids.ebayPause, decide: 'dismiss' }] })
    expect(tool().withinLimits!(ebay.preview, defaults())).toContain('an eBay proposal is not decided by rule')
  })

  it('decided by rule: not a person\'s write; the writes join the approval\'s change set; undo puts them back through undo-ad-change', async () => {
    const args = { kind: 'amazon-ads', decisions: [{ suggestionId: w2.metaByRule, decide: 'apply' }] }
    const out = (await executeTool(person, 'decide-automation-suggestions', args, { via: 'claude', approvalId: 'appr-w2-rule', decidedVia: 'auto' })).raw as Out
    expect(out.ok).toBe(true)
    expect(seen.at(-1)).toMatchObject({ operatorApproved: false, approval: { changeSetId: 'appr-w2-rule', reason: 'Claude request appr-w2-rule (run by rule)' } })
    expect(out.change!.after).toEqual({ kind: 'amazon-ads', items: [{ id: w2.metaByRule, status: 'applied' }], changeSetId: 'appr-w2-rule', negatives: [{ targetId: w2.negative }] })
    expect(await inside(() => tool().undo!.current(out.change!))).toEqual(out.change!.after)
    expect(tool().undo!.request(out.change!)).toEqual({ tool: 'undo-ad-change', args: { changeSetId: 'appr-w2-rule', why: 'undo of applied rule suggestions' } })
    // A person who decides (in Nexus) is still a person's write.
    await executeTool(person, 'decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: w2.metaByPerson, decide: 'apply' }] }, { via: 'claude', approvalId: 'appr-w2-person', decidedVia: 'nexus', approvedByPerson: true })
    expect(seen.at(-1)).toMatchObject({ operatorApproved: true, approval: { changeSetId: 'appr-w2-person', reason: 'Claude request appr-w2-person (approved by user:u-r11)' } })
    // A batch that applied and dismissed names both ways back.
    const mixed = { before: {}, after: { kind: 'amazon-ads', items: [{ id: 'a', status: 'applied' }, { id: 'b', status: 'dismissed' }], changeSetId: 'appr-x' } }
    expect(tool().undo!.request(mixed)).toEqual({ refusal: '1 of these suggestions were applied and 1 dismissed: put the applied ones back with undo-ad-change (changeSetId appr-x), and restore the dismissed ones with decide-automation-suggestions (decide: restore).' })
  })

  it('a real bid write of the rule carries the change set and the request; undo-ad-change by the approval id finds it', async () => {
    const out = (await executeTool(person, 'decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: w2.write, decide: 'apply' }] }, { via: 'claude', approvalId: 'appr-w2-write', decidedVia: 'auto' })).raw as Out
    expect(out, out.error).toMatchObject({ ok: true, data: { decided: 1, changeSetId: 'appr-w2-write' } })
    const logs = await inside(() => database.client.advertisingActionLog.findMany({ where: { executionId: 'appr-w2-write' }, select: { userId: true, entityId: true, outboundQueueId: true } }))
    expect(logs).toEqual([expect.objectContaining({ userId: 'automation:tst-rule', entityId: w2.target })]) // the rule stays the writer
    const queued = await inside(() => database.client.outboundSyncQueue.findMany({ where: { id: { in: logs.map((l) => l.outboundQueueId).filter((id): id is string => !!id) } }, select: { payload: true } }))
    expect(queued).toHaveLength(1)
    for (const q of queued) expect((q.payload as { reason?: string }).reason).toBe('Claude request appr-w2-write (run by rule): bid_down -20% via rule tst-rule')
    const undo = (await callTool(person, 'undo-ad-change', { changeSetId: 'appr-w2-write' })).raw as Out
    expect(undo).toMatchObject({ ok: true, preview: { source: { mode: 'set', changeSetId: 'appr-w2-write' }, rows: [expect.objectContaining({ entityId: w2.target })] } })
  })
})
