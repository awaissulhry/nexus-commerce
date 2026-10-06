/**
 * ADS AUTONOMY W4-5 — the watch-week comparison, in `ads-manager-runs` and in the daily run's e-mail, on PGlite with the
 * production schema and business policies. Claude asks real ad changes at watch through its own door (runToolForClaude:
 * the door records each verdict), the requests are moved six days back, and the test writes what then happened to
 * their entities: engine and person writes, an engine suggestion, a negative an engine created for a search term, and
 * daily figures. Values are made up (public repo). Business profiles follow the environment (run with them on and off).
 *
 *   wanted      the kit stores each item's value in the preview's facts (`limitFacts.wanted`): the watch week reads it back
 *   steps       a request asked at watch and a watched step of a change plan; their verdicts and what a person did
 *   72 hours    an engine moved it the same way, the opposite way, or not at all (a write after 72 h does not count);
 *               a person's write; an engine's suggestion; a search term followed through the negative created for it
 *   figures     the 3 and 7 days after against the days before, next to the campaign's comparable entities nothing
 *               wrote to (a written one is left out), labelled observed, not proof of cause; better / no peers / no data
 *   table       per kind: would have run, would have waited, agreed, conflicted, held by limits, outcome
 *   money       without the ad-money permission: the same answer without the amounts and the rule's own reasons
 *   business    another business's watched steps are not read
 *   e-mail      the day's e-mail carries the table while watch mode is on, and not after
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
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
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
const mail = vi.hoisted(() => ({ sent: [] as Array<{ subject: string; html: string; text?: string }> }))
vi.mock('../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email/transport.js')>()),
  sendEmail: vi.fn(async (message: { subject: string; html: string; text?: string }) => {
    mail.sent.push(message)
    return { ok: true, provider: 'resend', dryRun: false, messageId: `test-${mail.sent.length}` }
  }),
}))

import { callTool, type UserPrincipal } from './call-tool.js'
import { getTool } from './tool-registry.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import { __claudeStrategyTest } from '../advertising/ads-strategy/claude.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { ADS_MANAGER_AGENT_KEY } from './ads-manager-run.service.js'
import { engineRelation, OBSERVED_LABEL, outcomeOf, parseEntityKey, relationOf, suggestionDirection, verdictMeaning, WATCH_WEEK_MONEY, writeDirection, type WatchWindow } from './ads-watch-week.service.js'
import { RESTRICTED_FIELDS } from '../../lib/auth/financial-fields.js'
import { measure, wantedOf } from './tools/ads-autonomy-kit.js'

const A = LEGACY_WORKSPACE_ID
const B = 'w4_watch_week_bravo'
const TIMEOUT = 60_000
const DAY = 86_400_000
const HOUR = 3_600_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', noMoney: '', cut: '', raise: '', plan: '', term: '', rule: '', bWatched: '' }
const names = { A: '', B: 'Bravo watch business' }

/**
 * The verdicts' day, at noon UTC, six days back — inside the e-mail's 7 days. The figures reach yesterday (D + 5): the 3
 * days after are all in Nexus, the 7 days after are not yet.
 */
const D = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 6 * DAY)
const CHECKED = new Date(D.getTime() + 12 * HOUR)
const dayOf = (offset: number) => new Date(D.getTime() + offset * DAY)
const iso = (offset: number) => dayOf(offset).toISOString().slice(0, 10)
const TERM_KEY = 'searchTerm:EXT-c-it:EXT-g-c-it:cheap helmet'

const person = (permissions: Set<string>, workspaceId = A, userId = ids.person): UserPrincipal => ({
  kind: 'user', userId, label: 'Wanda Watch', permissions: { isOwner: false, permissions }, workspace: business(workspaceId), via: 'claude', oauthGrantId: 'grant-w45',
})
function claude(scopes: string[], workspaceId = A): McpPrincipal {
  return { ...person(EVERYTHING, workspaceId), business: { id: workspaceId, name: workspaceId === A ? names.A : names.B }, scopes } as McpPrincipal
}
type Answer = Record<string, any>
async function ask(tool: string, args: Record<string, unknown>, scopes = ['nexus.read', 'nexus.write', 'nexus.run']): Promise<Answer> {
  const who = claude(scopes)
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: names.A }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
async function runs(who: UserPrincipal, days = 9, workspaceId = A): Promise<Answer> {
  return inside(async () => ((await callTool(who, 'ads-manager-runs', { days })).visible as Answer).data as Answer, workspaceId)
}
/** A watched request moves to the verdicts' day: asked then, checked then. */
async function backdate(approvalId: string) {
  await inside(async () => {
    const row = await db().agentApproval.findUniqueOrThrow({ where: { id: approvalId } })
    await db().agentApproval.update({ where: { id: approvalId }, data: { requestedAt: CHECKED, ruleVerdict: { ...(row.ruleVerdict as object), checkedAt: CHECKED.toISOString() } } })
  })
}
const write = (data: { entityType: string; entityId: string; actionType: string; userId: string | null; before: object; after: object; at: Date; executionId?: string }) =>
  inside(() => db().advertisingActionLog.create({
    data: { entityType: data.entityType, entityId: data.entityId, actionType: data.actionType, userId: data.userId, payloadBefore: data.before, payloadAfter: data.after, createdAt: data.at, executionId: data.executionId ?? null },
  }))
/** One day of a target's figures (spend and sales in cents). */
const targetDay = (targetId: string, offset: number, spendCents: number, salesCents: number, clicks = 3, orders = 1) =>
  inside(() => db().amazonAdsDailyPerformance.create({
    data: {
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayOf(offset), entityType: 'AD_TARGET', entityId: `EXT-${targetId}`, localEntityId: targetId,
      clicks, costMicros: BigInt(spendCents * 10_000), currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders, reportRunId: 'test-run', reportedAt: new Date(),
    },
  }))
const termDay = (query: string, offset: number, spendCents: number, salesCents: number) =>
  inside(() => db().amazonAdsSearchTerm.create({
    data: {
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayOf(offset), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it', query,
      clicks: 2, costMicros: BigInt(spendCents * 10_000), currencyCode: 'EUR', sales7dCents: salesCents, orders7d: salesCents ? 1 : 0, reportRunId: 'test-run',
    },
  }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('NEXUS_ADS_DIGEST_RECIPIENTS', 'owner@example.test')
  const client = database.client
  const role = await client.role.create({ data: { key: `W45_${randomUUID().slice(0, 8)}`, name: 'Watcher', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const adsOnly = await client.role.create({ data: { key: `W45_ADS_${randomUUID().slice(0, 8)}`, name: 'Ads only', description: 'test', isSystem: false, permissions: [F.adsView, F.aiRun] } })
  const who = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Wanda Watch' } })
  const noMoney = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'No Money' } })
  ids.person = who.id
  ids.noMoney = noMoney.id
  await client.userRole.create({ data: { userId: who.id, roleId: role.id } })
  await client.userRole.create({ data: { userId: noMoney.id, roleId: adsOnly.id } })
  await client.workspace.create({ data: { id: B, name: names.B, createdByUserId: who.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const m = await client.workspaceMembership.create({ data: { workspaceId, userId: who.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: m.id, roleId: role.id } })
  }
  const n = await client.workspaceMembership.create({ data: { workspaceId: A, userId: noMoney.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: n.id, roleId: adsOnly.id } })
  names.A = (await client.workspace.findUniqueOrThrow({ where: { id: A }, select: { name: true } })).name

  await inside(async () => {
    await seedAdsFixture(client)
    // c-it's other keywords: two quiet ones, one an engine writes to (never comparable), one a plan changes.
    for (const [id, text, bidCents] of [['t-p1', 'touring jacket', 50], ['t-p2', 'rain jacket', 50], ['t-p3', 'busy jacket', 50], ['t-plan', 'plan jacket', 50]] as const) {
      await client.adTarget.create({ data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id}` } })
    }
    // IT: Claude may change bids alone, inside the strategy; set-target-bid is at watch.
    await client.adsStrategy.create({
      data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', minBidCents: 5, maxBidCents: 100, claudeAutonomy: { bid: 'auto' }, claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 5, version: 1, updatedBy: 'user:test' },
    })
    await client.agentTool.create({ data: { name: 'set-target-bid', riskTier: 'high', requiresApproval: true, claudeTrust: 'watch' } })
    // The engine whose writes and suggestions the test records (off: it moves nothing a change of Claude's would meet).
    ids.rule = (await client.automationRule.create({ data: { domain: 'advertising', name: 'TEST negate wasters', trigger: 'SCHEDULE', enabled: false, dryRun: true, autonomyLevel: 'PROPOSE', actions: [], conditions: [] } })).id
  })
  __claudeStrategyTest.reset()
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W4-5 — the kit keeps what each item would set', () => {
  it('wantedOf: the entity, the way it moves spend, the value in its own units', () => {
    expect(wantedOf('target:t1', { field: 'bid', fromCents: 45, toCents: 40 })).toEqual({ entity: 'target:t1', field: 'bid', direction: 'cut', wantedFromCents: 45, wantedToCents: 40 })
    expect(wantedOf('target:new', { field: 'bid', fromCents: null, toCents: 30 })).toMatchObject({ direction: 'raise', wantedFromCents: null })
    expect(wantedOf('campaign:c1', { field: 'placementPct', fromPct: 10, toPct: 30 })).toEqual({ entity: 'campaign:c1', field: 'placementPct', direction: 'raise', wantedFromPct: 10, wantedToPct: 30 })
    expect(wantedOf('campaign:c1', { field: 'status', from: 'ENABLED', to: 'PAUSED' })).toEqual({ entity: 'campaign:c1', field: 'status', direction: 'cut', from: 'ENABLED', to: 'PAUSED' })
    expect(wantedOf(TERM_KEY, { field: 'negative', term: 'cheap helmet', matchType: 'NEGATIVE_EXACT' })).toEqual({ entity: TERM_KEY, field: 'negative', direction: 'cut', term: 'cheap helmet', matchType: 'NEGATIVE_EXACT' })
    expect(measure({ field: 'automation' }).direction).toBe('same')
  })
})

describe('W4-5 — pure readers', () => {
  it('a write\'s direction from its before and after; a suggestion\'s from its action', () => {
    expect(writeDirection({ actionType: 'AD_BID_UPDATE', payloadBefore: { bidCents: 45, status: 'ENABLED' }, payloadAfter: { bidCents: 42, status: 'ENABLED' } })).toBe('cut')
    expect(writeDirection({ actionType: 'CAMPAIGN_UPDATE', payloadBefore: { dailyBudget: 20 }, payloadAfter: { dailyBudget: 25 } })).toBe('raise')
    expect(writeDirection({ actionType: 'update_placement_bidding', payloadBefore: { adjustments: [{ placement: 'TOP', percentage: 50 }] }, payloadAfter: { adjustments: [{ placement: 'TOP', percentage: 20 }] } })).toBe('cut')
    expect(writeDirection({ actionType: 'AD_ENTITY_STATE_UPDATE', payloadBefore: { status: 'PAUSED' }, payloadAfter: { status: 'ENABLED' } })).toBe('raise')
    expect(writeDirection({ actionType: 'create_negative_keyword', payloadBefore: {}, payloadAfter: { keywordText: 'x' } })).toBe('cut')
    // Two fields the opposite way, or none of them: not read.
    expect(writeDirection({ actionType: 'x', payloadBefore: { bidCents: 40, status: 'ENABLED' }, payloadAfter: { bidCents: 50, status: 'PAUSED' } })).toBeNull()
    expect(writeDirection({ actionType: 'rename', payloadBefore: { name: 'a' }, payloadAfter: { name: 'b' } })).toBeNull()
    expect(suggestionDirection({ type: 'bid_down', percent: 10 })).toBe('cut')
    expect(suggestionDirection({ type: 'budget_apply', op: 'incPct', value: 20 })).toBe('raise')
    expect(suggestionDirection({ type: 'promote_to_exact' })).toBe('raise')
    expect(suggestionDirection({ type: 'bid_apply', op: 'set', value: 1 })).toBeNull()
  })

  it('same, opposite, other; an item\'s engines together', () => {
    expect(relationOf('cut', 'cut')).toBe('same')
    expect(relationOf('cut', 'raise')).toBe('opposite')
    expect(relationOf('cut', null)).toBe('other')
    expect(relationOf(null, 'cut')).toBe('other')
    expect(engineRelation([])).toBe('none')
    expect(engineRelation(['same', 'other'])).toBe('same')
    expect(engineRelation(['same', 'opposite'])).toBe('mixed')
    expect(engineRelation(['other'])).toBe('other')
  })

  it('the outcome: the 7 days when all are in, else the 3; the ACoS move against the comparable entities\'', () => {
    const p = (spendCents: number, salesCents: number) => ({ spendCents, salesCents, clicks: 1, orders: 1, acos: salesCents ? spendCents / salesCents : null })
    const w = (days: number, complete: boolean, entity: WatchWindow['entity'], peers: WatchWindow['peers']): WatchWindow =>
      ({ days, before: { from: '', to: '' }, after: { from: '', to: '' }, complete, entity, peers })
    const peers = { count: 2, before: p(100, 200), after: p(100, 200) }
    expect(outcomeOf([w(3, false, null, null), w(7, false, null, null)])).toBe('not_yet')
    expect(outcomeOf([w(3, true, { before: p(100, 200), after: p(100, 400) }, peers), w(7, false, null, null)])).toBe('better')
    expect(outcomeOf([w(3, true, { before: p(100, 200), after: p(100, 400) }, peers), w(7, true, { before: p(100, 400), after: p(100, 200) }, peers)])).toBe('worse')
    expect(outcomeOf([w(7, true, { before: p(100, 200), after: p(105, 200) }, peers)])).toBe('flat')
    expect(outcomeOf([w(7, true, { before: p(100, 0), after: p(100, 200) }, peers)])).toBe('no_sales')
    expect(outcomeOf([w(7, true, { before: p(100, 200), after: p(100, 400) }, null)])).toBe('no_peers')
    expect(outcomeOf([w(7, true, null, peers)])).toBe('no_data')
    expect(outcomeOf([])).toBe('no_data')
  })

  it('entity keys read back; a verdict reads in its check\'s own words', () => {
    expect(parseEntityKey('target:t1')).toEqual({ kind: 'target', id: 't1' })
    expect(parseEntityKey(TERM_KEY)).toEqual({ kind: 'searchTerm', id: null, term: { ext: 'EXT-c-it', adGroupExt: 'EXT-g-c-it', query: 'cheap helmet' } })
    expect(parseEntityKey('searchTerm:EXT-1:*:a:b')).toMatchObject({ term: { ext: 'EXT-1', adGroupExt: null, query: 'a:b' } })
    expect(verdictMeaning({ wouldRun: false, check: 'limits' })).toBe('would have waited for a person — outside the kind\'s limits')
    expect(verdictMeaning({ wouldRun: false, check: 'scope' })).toMatch(/nexus\.run/)
    expect(verdictMeaning({ wouldRun: true, check: null })).toBe('would have run by rule')
  })

  it('ads-manager-runs hides exactly the watch week\'s money keys (and spend, sales and ACoS everywhere)', () => {
    expect(Object.keys(getTool('ads-manager-runs')!.restrictedFields ?? {}).sort()).toEqual([...WATCH_WEEK_MONEY].sort())
    for (const key of ['spendCents', 'salesCents', 'acos']) expect(RESTRICTED_FIELDS[key]).toBe(FIELDS.financialsAdspendView)
  })
})

describe('W4-5 — the watch week, read back from what the door recorded', { timeout: TIMEOUT }, () => {
  beforeAll(async () => {
    // A cut inside every limit (it would have run by rule); a raise outside the kind's limits (it would have waited).
    const cut = await ask('set-target-bid', { targetId: 't-it', proposedBidCents: 40, why: 'a test cut' })
    expect(cut, JSON.stringify(cut)).toMatchObject({ trust: { level: 'watch', watch: { wouldRun: true } } })
    const raise = await ask('set-target-bid', { targetId: 't-p1', proposedBidCents: 60, why: 'a test raise' }, ['nexus.read', 'nexus.write', 'nexus.run'])
    expect(raise, JSON.stringify(raise)).toMatchObject({ trust: { level: 'watch', watch: { wouldRun: false, check: 'limits' } } })
    const plan = await ask('submit-change-plan', { title: 'Test plan', steps: [{ tool: 'set-target-bid', args: { targetId: 't-plan', proposedBidCents: 45, why: 'a plan cut' } }] }, ['nexus.read', 'nexus.write'])
    expect(plan, JSON.stringify(plan)).toMatchObject({ trust: { level: 'watch' } })
    ids.cut = cut.approvalId
    ids.raise = raise.approvalId
    ids.plan = plan.approvalId
    for (const id of [ids.cut, ids.raise, ids.plan]) await backdate(id)

    // A negative Claude asked at watch for a search term (its facts as the kit stores them).
    ids.term = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', userId: ids.person, via: 'claude' } })
      const facts = {
        v: 1, tool: 'create-negative-keyword', action: 'negative', markets: { IT: { strategy: { version: 'v1' }, currency: 'EUR' } }, scopes: {}, entityScopes: {},
        labels: { [TERM_KEY]: 'search term "cheap helmet"' }, this: { markets: ['IT'], items: 1, entities: [TERM_KEY] },
        wanted: [{ entity: TERM_KEY, field: 'negative', direction: 'cut', term: 'cheap helmet', matchType: 'NEGATIVE_EXACT' }],
      }
      return (await db().agentApproval.create({
        data: {
          agentRunId: run.id, toolName: 'create-negative-keyword', riskTier: 'high', args: {}, status: 'expired', requestedAt: CHECKED, preview: { limitFacts: facts },
          ruleVerdict: { level: 'watch', wouldRun: false, check: 'scope', why: 'this Claude connection may not run changes by rule', checkedAt: CHECKED.toISOString(), changes: 1 },
        },
      })).id
    })

    const at = (hours: number) => new Date(CHECKED.getTime() + hours * HOUR)
    // t-it (Claude: cut): an engine cut it the same way within 72 h, raised it after 72 h (not counted); an engine suggested a cut.
    await write({ entityType: 'AD_TARGET', entityId: 't-it', actionType: 'AD_BID_UPDATE', userId: 'automation:auto-bid', before: { bidCents: 45, status: 'ENABLED' }, after: { bidCents: 42, status: 'ENABLED' }, at: at(10) })
    await write({ entityType: 'AD_TARGET', entityId: 't-it', actionType: 'AD_BID_UPDATE', userId: 'automation:auto-bid', before: { bidCents: 42, status: 'ENABLED' }, after: { bidCents: 60, status: 'ENABLED' }, at: at(80) })
    await inside(() => db().adsRuleSuggestion.create({ data: { ruleId: ids.rule, ruleName: 'TEST negate wasters', entityType: 'AD_TARGET', entityId: 't-it', proposedAction: { type: 'bid_down', percent: 10 }, proposedKey: 'bid_down:10', createdAt: at(2), lastSeenAt: at(2) } }))
    // t-p1 (Claude: raise): an engine cut it (the opposite way); a person raised it.
    await write({ entityType: 'AD_TARGET', entityId: 't-p1', actionType: 'AD_BID_UPDATE', userId: `automation:${ids.rule}`, before: { bidCents: 50 }, after: { bidCents: 45 }, at: at(5) })
    await write({ entityType: 'AD_TARGET', entityId: 't-p1', actionType: 'AD_BID_UPDATE', userId: `user:${ids.person}`, before: { bidCents: 45 }, after: { bidCents: 55 }, at: at(20) })
    // t-p3: an engine wrote to it in the span, so it is never comparable.
    await write({ entityType: 'AD_TARGET', entityId: 't-p3', actionType: 'AD_BID_UPDATE', userId: 'automation:auto-bid', before: { bidCents: 50 }, after: { bidCents: 40 }, at: at(-30) })
    // The search term: an engine created a negative for its words in its campaign, and suggested one.
    const negative = await inside(() => db().adTarget.create({ data: { adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'Cheap Helmet', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', createdAt: at(3) } }))
    await write({ entityType: 'AD_TARGET', entityId: negative.id, actionType: 'create_negative_keyword', userId: `automation:${ids.rule}`, before: {}, after: { keywordText: 'Cheap Helmet' }, at: at(3) })
    await inside(() => db().adsRuleSuggestion.create({ data: { ruleId: ids.rule, ruleName: 'TEST negate wasters', entityType: 'SEARCH_TERM', entityId: 'EXT-c-it:cheap helmet', proposedAction: { type: 'add_negative_exact' }, proposedKey: 'add_negative_exact', createdAt: at(1), lastSeenAt: at(1) } }))

    // Figures: t-it's ACoS halves while its quiet peers' holds (better); t-p1 has none (no data); t-p3's would swamp the
    // peers if it were counted. Every day from 7 before to yesterday (5 after), the verdicts' own day left out.
    for (let offset = -7; offset <= 5; offset++) {
      if (offset === 0) continue
      const after = offset > 0
      await targetDay('t-it', offset, 100, after ? 400 : 200)
      await targetDay('t-p2', offset, 50, 100)
      await targetDay('t-low', offset, 50, 100)
      await targetDay('t-p3', offset, 10_000, 100)
      await termDay('cheap helmet', offset, 80, 0)
      await termDay('good helmet', offset, 100, after ? 500 : 250)
    }
  }, 120_000)

  it('every watched ad step, each item with the value it would have set, its verdict and what a person did', async () => {
    const week = (await runs(person(EVERYTHING))).watchWeek
    expect(week.label).toBe(OBSERVED_LABEL)
    expect(week.totalSteps).toBe(4)
    const step = (approvalId: string) => week.steps.find((s: Answer) => s.approvalId === approvalId)
    expect(step(ids.cut)).toMatchObject({
      step: null, tool: 'set-target-bid', action: 'bid', checkedAt: CHECKED.toISOString(),
      verdict: { wouldRun: true, check: null, meaning: 'would have run by rule', ruleWhy: null },
      request: { status: 'pending', fate: 'waiting', ran: false },
      items: [{ entity: { key: 'target:t-it', kind: 'target', id: 't-it', market: 'IT', currency: 'EUR' }, wanted: { field: 'bid', direction: 'cut', wantedFromCents: 45, wantedToCents: 40 } }],
    })
    expect(step(ids.raise)).toMatchObject({
      verdict: { wouldRun: false, check: 'limits', meaning: 'would have waited for a person — outside the kind\'s limits', ruleWhy: expect.any(String) },
      items: [{ wanted: { direction: 'raise', wantedFromCents: 50, wantedToCents: 60 } }],
    })
    // The plan's watched step: its own step number and preview.
    expect(step(ids.plan)).toMatchObject({ step: 1, tool: 'set-target-bid', verdict: { wouldRun: false, check: 'scope' }, items: [{ entity: { key: 'target:t-plan' }, wanted: { wantedFromCents: 50, wantedToCents: 45 } }] })
    expect(step(ids.term)).toMatchObject({ tool: 'create-negative-keyword', action: 'negative', request: { fate: 'expired' }, items: [{ entity: { key: TERM_KEY, kind: 'searchTerm', market: 'IT' }, wanted: { field: 'negative', term: 'cheap helmet' } }] })
  })

  it('72 hours: the same way, the opposite way, a person; a write after 72 h does not count; suggestions; a search term\'s negative', async () => {
    const week = (await runs(person(EVERYTHING))).watchWeek
    const item = (approvalId: string) => week.steps.find((s: Answer) => s.approvalId === approvalId).items[0].after72h
    const cut = item(ids.cut)
    expect(cut.engine).toBe('same')
    expect(cut.moves).toEqual([expect.objectContaining({ by: 'engine', who: 'auto bid', what: 'AD_BID_UPDATE', direction: 'cut', relation: 'same' })])
    expect(cut.suggestions).toEqual([expect.objectContaining({ rule: 'TEST negate wasters', direction: 'cut', relation: 'same' })])
    const raise = item(ids.raise)
    expect(raise.engine).toBe('opposite')
    expect(raise.moves).toEqual([
      expect.objectContaining({ by: 'engine', who: 'TEST negate wasters', direction: 'cut', relation: 'opposite' }),
      expect.objectContaining({ by: 'person', who: 'a person', direction: 'raise', relation: 'same' }),
    ])
    expect(item(ids.plan)).toMatchObject({ engine: 'none', moves: [], suggestions: [] })
    expect(item(ids.term)).toMatchObject({
      engine: 'same',
      moves: [expect.objectContaining({ by: 'engine', who: 'TEST negate wasters', what: 'create_negative_keyword', direction: 'cut', relation: 'same' })],
      suggestions: [expect.objectContaining({ direction: 'cut', relation: 'same' })],
    })
  })

  it('figures: 3 and 7 days after against before, next to the comparable entities nothing wrote to — observed, not proof of cause', async () => {
    const week = (await runs(person(EVERYTHING))).watchWeek
    const observed = (approvalId: string) => week.steps.find((s: Answer) => s.approvalId === approvalId).items[0].observed
    const cut = observed(ids.cut)
    // The 7 days after are not all in yet: the outcome reads the 3.
    expect(cut).toMatchObject({ label: OBSERVED_LABEL, dataAsOf: iso(5), outcome: 'better', meaning: expect.stringContaining('the change never ran (watch)') })
    const [three, seven] = cut.windows
    expect(three).toMatchObject({
      days: 3, before: { from: iso(-3), to: iso(-1) }, after: { from: iso(1), to: iso(3) }, complete: true,
      entity: { before: { spendCents: 300, salesCents: 600, clicks: 9, orders: 3, acos: 0.5 }, after: { spendCents: 300, salesCents: 1200, acos: 0.25 } },
      // c-it's keywords nothing wrote to and no step watched: t-sup, t-low, t-p2 (t-p3 was written to; t-p1, t-plan are watched).
      peers: { count: 3, before: { spendCents: 300, salesCents: 600 }, after: { spendCents: 300, salesCents: 600 } },
    })
    expect(seven).toMatchObject({ days: 7, after: { from: iso(1), to: iso(7) }, complete: false, entity: { before: { spendCents: 700, salesCents: 1400 }, after: { spendCents: 500, salesCents: 2000 } } })
    expect(observed(ids.raise)).toMatchObject({ outcome: 'no_data' })
    // The search term spent without a sale on both sides: no ACoS to compare. Its peers are the campaign's other terms.
    expect(observed(ids.term)).toMatchObject({
      outcome: 'no_sales',
      windows: [expect.objectContaining({ entity: { before: expect.objectContaining({ spendCents: 240, salesCents: 0 }), after: expect.objectContaining({ spendCents: 240 }) }, peers: { count: null, before: expect.objectContaining({ salesCents: 750 }), after: expect.objectContaining({ salesCents: 1500 }) } }), expect.anything()],
    })
  })

  it('the table per kind: would run, would wait, agreed, conflicted, held by limits, outcome', async () => {
    const week = (await runs(person(EVERYTHING))).watchWeek
    const bid = week.table.find((r: Answer) => r.action === 'bid')
    expect(bid).toMatchObject({
      tools: ['set-target-bid'], steps: 3, wouldRun: 1, wouldWait: 2, agreedWithEngine: 1, conflictedWithEngine: 1, heldByLimits: 1,
      byCheck: { limits: 1, scope: 1 }, suggestedSame: 1, suggestedOpposite: 0, requests: { waiting: 3, approved: 0, declined: 0, expired: 0 },
      outcome: expect.objectContaining({ better: 1, no_data: 2 }),
    })
    expect(week.table.find((r: Answer) => r.action === 'negative')).toMatchObject({ steps: 1, wouldWait: 1, agreedWithEngine: 1, requests: { expired: 1 }, outcome: expect.objectContaining({ no_sales: 1 }) })
    expect(week.totals).toMatchObject({ steps: 4, wouldRun: 1, wouldWait: 3, agreedWithEngine: 2, conflictedWithEngine: 1 })
  })

  it('without the ad-money permission: the same answer without the amounts (and without the rule\'s own reason)', async () => {
    const full = (await runs(person(EVERYTHING))).watchWeek
    const plain = (await runs(person(new Set([F.adsView, F.aiRun]), A, ids.noMoney))).watchWeek
    const money = new Set<string>([...WATCH_WEEK_MONEY, ...Object.keys(RESTRICTED_FIELDS)])
    expect(plain).toEqual(JSON.parse(JSON.stringify(full, (key, value) => (key && money.has(key) ? undefined : value))))
    const text = JSON.stringify(plain)
    for (const key of ['wantedFromCents', 'wantedToCents', 'spendCents', 'salesCents', '"acos"', 'ruleWhy']) expect(text).not.toContain(key)
    const raise = plain.steps.find((s: Answer) => s.approvalId === ids.raise)
    expect(raise.verdict).toEqual({ wouldRun: false, check: 'limits', meaning: 'would have waited for a person — outside the kind\'s limits' })
    expect(raise.items[0].wanted).toEqual({ field: 'bid', direction: 'raise' })
    // Clicks and orders are not money.
    expect(plain.steps.find((s: Answer) => s.approvalId === ids.cut).items[0].observed.windows[0].entity.before).toEqual({ clicks: 9, orders: 3 })
  })

  it('another business\'s watched steps are not read, and it does not read these', async () => {
    ids.bWatched = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', userId: ids.person, via: 'claude' } })
      return (await db().agentApproval.create({
        data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', args: {}, status: 'pending', requestedAt: CHECKED, ruleVerdict: { level: 'watch', wouldRun: true, check: null, why: null, checkedAt: CHECKED.toISOString(), changes: 1 } },
      })).id
    }, B)
    const a = (await runs(person(EVERYTHING))).watchWeek
    expect(a.steps.map((s: Answer) => s.approvalId)).not.toContain(ids.bWatched)
    const b = (await runs(person(EVERYTHING, B), 9, B)).watchWeek
    expect(b.steps.map((s: Answer) => s.approvalId)).toEqual([ids.bWatched])
    expect(b.steps[0].items).toEqual([])
  })
})

describe('W4-5 — the day\'s e-mail carries the table while watch mode is on', { timeout: TIMEOUT }, () => {
  const finish = async () => {
    const who = claude(['nexus.read', 'nexus.write'])
    const result = await inside(() => runToolForClaude(who, getTool('report-ads-run')!, { op: 'finish', nextFocus: 'Look at the watch week', business: names.A }))
    return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
  }
  /** The day's one e-mail is free again (another day, as far as the cap reads it). */
  const freeTheDay = () => inside(() => db().agentMemory.deleteMany({ where: { scope: ADS_MANAGER_AGENT_KEY, entityType: 'report-email' } }))

  it('a kind at watch: the e-mail has the table, counts only, labelled', async () => {
    mail.sent.length = 0
    await freeTheDay()
    const answer = await finish()
    expect(answer, JSON.stringify(answer)).toMatchObject({ email: { status: 'sent' } })
    const [message] = mail.sent
    expect(message.html).toContain('Watch week so far (last 7 days)')
    expect(message.html).toContain(OBSERVED_LABEL)
    expect(message.html).toContain('Would run by rule')
    expect(message.text).toMatch(/bid: would run 1, would wait 2, agreed with an engine 1, conflicted 1, held by limits 1; outcome 1 better/)
    // Counts only: no amount.
    expect(message.html).not.toMatch(/EUR|€/)
  })

  it('watch mode off (no kind at watch, nothing watched in 24 hours): no table', async () => {
    mail.sent.length = 0
    await freeTheDay()
    await inside(() => db().agentTool.updateMany({ where: { name: 'set-target-bid' }, data: { claudeTrust: 'ask' } }))
    const answer = await finish()
    expect(answer, JSON.stringify(answer)).toMatchObject({ email: { status: 'sent' } })
    expect(mail.sent[0].html).not.toContain('Watch week')
    expect(mail.sent[0].text).not.toContain('Watch week')
  })
})
