/**
 * Sponsored Display extras (P3c) — the optimization-rule, budget-rule, budget-insight, forecast and brand-safety tools, run
 * for real through the door, the approval gate and undo (PGlite, production schema; Amazon's write gate the real one).
 * Amazon is a fake behind the Ads client's one door (liveCall): it keeps the rules and the deny list as Amazon's spec
 * shapes them, answers 207 items and HTTP errors as Amazon does, and records every request — so each test reads the
 * exact body Amazon would get. Made-up names, ids and amounts only.
 *
 * Proven: in sandbox mode nothing is asked and no change is queued; another business's or an unknown campaign / ad group /
 * market is "not found"; every Amazon limit Nexus can check is refused before anything is queued; a preview shows each
 * value from → to, where it lands (live, profile) and what can add spend (ADDS SPEND), the deny list as account-wide and a
 * budget rule's clash with Nexus's own budget writers; an approved request sends exactly Amazon's body; Amazon's refusal
 * reaches the person in its words and nothing is recorded as done; what moved at Amazon after approval is refused; undo
 * asks for the opposite change.
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

type Row = Record<string, any>
/** The fake Amazon: Sponsored Display's rules and deny list, and every request it was sent. */
const amazon = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body: unknown; profileId: string }>,
  optRules: new Map<string, Row>(),
  groupRules: new Map<string, string[]>(),
  budgetRules: new Map<string, Row>(),
  campaignRules: new Map<string, string[]>(),
  deny: [] as Row[],
  requests: [] as Row[],
  /** One answer to force for the next call of `method path` (an Amazon refusal). */
  force: new Map<string, { status?: number; body: unknown }>(),
  next: 1,
}))

vi.mock('../../advertising/ads-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../advertising/ads-api-client.js')>()
  const fail = (status: number, body: unknown) => Object.assign(new Error(`[ADS-LIVE] → ${status}`), { statusCode: status, body: JSON.stringify(body) })
  return {
    ...actual,
    liveCall: async (opts: { method: string; path: string; body?: unknown; profileId: string }) => {
      const a = amazon
      a.calls.push({ method: opts.method, path: opts.path, body: opts.body ?? null, profileId: opts.profileId })
      const [path, query = ''] = opts.path.split('?')
      const forced = a.force.get(`${opts.method} ${path}`)
      if (forced) {
        a.force.delete(`${opts.method} ${path}`)
        if (forced.status && forced.status >= 300) throw fail(forced.status, forced.body)
        return forced.body
      }
      const q = new URLSearchParams(query)
      const body = opts.body as any
      let m: RegExpMatchArray | null
      // ── optimization rules
      if (opts.method === 'GET' && path === '/sd/optimizationRules') {
        const name = q.get('name')
        return [...a.optRules.values()].filter((r) => !name || r.ruleName === name)
      }
      if ((m = path.match(/^\/sd\/optimizationRules\/(.+)$/)) && opts.method === 'GET') {
        const r = a.optRules.get(decodeURIComponent(m[1]))
        if (!r) throw fail(404, { code: 'NOT_FOUND', description: 'Rule not found' })
        return r
      }
      if (path === '/sd/optimizationRules' && opts.method === 'POST') {
        const ruleId = `OR-${a.next++}`
        a.optRules.set(ruleId, { ruleId, ...body[0] })
        return [{ code: 'SUCCESS', description: 'created', ruleId }]
      }
      if (path === '/sd/optimizationRules' && opts.method === 'PUT') {
        const { ruleId, ...rest } = body[0]
        a.optRules.set(ruleId, { ruleId, ...rest })
        return [{ code: 'SUCCESS', ruleId }]
      }
      if ((m = path.match(/^\/sd\/adGroups\/(\d+)\/optimizationRules(\/disassociate)?$/))) {
        const group = m[1]
        if (opts.method === 'GET') return (a.groupRules.get(group) ?? []).map((id) => a.optRules.get(id))
        const id = body.optimizationRuleIds[0]
        if (m[2]) {
          a.groupRules.set(group, (a.groupRules.get(group) ?? []).filter((x) => x !== id))
          return { code: '207', responses: [{ code: 'SUCCESS', details: 'disassociated', optimizationRuleId: id }] }
        }
        a.groupRules.set(group, [...(a.groupRules.get(group) ?? []), id])
        return [{ code: 'SUCCESS', ruleId: id }]
      }
      // ── budget rules
      if (path === '/sd/budgetRules' && opts.method === 'GET') return { budgetRulesForAdvertiserResponse: [...a.budgetRules.values()], nextToken: null }
      if ((m = path.match(/^\/sd\/budgetRules\/([^/]+)\/campaigns$/))) {
        const id = decodeURIComponent(m[1])
        return { associatedCampaigns: [...a.campaignRules].filter(([, ids]) => ids.includes(id)).map(([campaignId]) => ({ campaignId, campaignName: `Amazon ${campaignId}`, ruleStatus: 'ACTIVE' })) }
      }
      if ((m = path.match(/^\/sd\/budgetRules\/([^/]+)$/))) {
        const r = a.budgetRules.get(decodeURIComponent(m[1]))
        if (!r) throw fail(404, { code: 'NOT_FOUND', details: 'Budget rule not found' })
        return { budgetRule: r }
      }
      if (path === '/sd/budgetRules' && opts.method === 'POST') {
        const ruleId = `BR-${a.next++}`
        a.budgetRules.set(ruleId, { ruleId, ruleState: 'ACTIVE', ruleStatus: 'ACTIVE', ruleDetails: body.budgetRulesDetails[0] })
        return { responses: [{ code: 'SUCCESS', ruleId }] }
      }
      if (path === '/sd/budgetRules' && opts.method === 'PUT') {
        const { ruleId, ruleState, ruleDetails } = body.budgetRulesDetails[0]
        a.budgetRules.set(ruleId, { ...a.budgetRules.get(ruleId), ruleId, ruleState, ruleDetails })
        return { responses: [{ code: 'SUCCESS', ruleId }] }
      }
      if ((m = path.match(/^\/sd\/campaigns\/(\d+)\/budgetRules(?:\/(.+))?$/))) {
        const campaign = m[1]
        if (opts.method === 'GET') return { associatedRules: (a.campaignRules.get(campaign) ?? []).map((id) => a.budgetRules.get(id)) }
        if (opts.method === 'DELETE') {
          a.campaignRules.set(campaign, (a.campaignRules.get(campaign) ?? []).filter((x) => x !== decodeURIComponent(m![2])))
          return {}
        }
        a.campaignRules.set(campaign, [...(a.campaignRules.get(campaign) ?? []), ...body.budgetRuleIds])
        return { responses: body.budgetRuleIds.map((ruleId: string) => ({ code: 'SUCCESS', ruleId })) }
      }
      // ── budget recommendations and usage
      if (path === '/sd/campaigns/budgetRecommendations') {
        return {
          budgetRecommendationsSuccessResults: [{ index: 0, campaignId: body.campaignIds[0], suggestedBudget: 35.5, sevenDaysMissedOpportunities: { startDate: '2026-10-13', endDate: '2026-10-19', percentTimeInBudget: 62.5, estimatedMissedSalesLower: 40, estimatedMissedSalesUpper: 90.25, estimatedMissedClicksLower: 12, estimatedMissedClicksUpper: 30, estimatedMissedImpressionsLower: 900, estimatedMissedImpressionsUpper: 2000 } }],
          budgetRecommendationsErrorResults: body.campaignIds.slice(1).map((campaignId: string, i: number) => ({ index: i + 1, campaignId, code: 'INVALID_ARGUMENT', details: 'Campaign has no recommendation' })),
        }
      }
      if (path === '/sd/campaigns/budget/usage') {
        return { success: body.campaignIds.map((campaignId: string, index: number) => ({ campaignId, index, budgetUsagePercent: 41.2, budget: 20, usageUpdatedTimestamp: new Date().toISOString() })), error: [] }
      }
      // ── forecast
      if (path === '/sd/forecasts') {
        return {
          bidOptimization: body.adGroup.bidOptimization, forecastStatus: 'COMPLETE',
          lifetimeForecasts: [{ metric: 'IMPRESSIONS', value: { min: 1000, max: 5000 } }, { metric: 'CLICKS', value: { min: 10, max: 40 } }],
          weeklyForecasts: [{ metric: 'CLICKS', value: { min: 10, max: 40 } }], dailyForecasts: [{ metric: 'CLICKS', value: { min: 1, max: 6 } }],
          curves: [{ graph: 'BUDGET', meetThreshold: true, points: Array.from({ length: 50 }, (_, i) => ({ isFocus: i === 20, x: [{ value: 5 + i }], y: [{ label: 'CLICKS', value: { min: i, max: i * 2 } }] })) }],
        }
      }
      // ── brand safety
      if (path === '/sd/brandSafety/deny') {
        if (opts.method === 'GET') {
          const start = Number(q.get('startIndex') ?? 0), count = Number(q.get('count') ?? 1000)
          return { pagination: { total: a.deny.length, offset: start, limit: count }, domains: a.deny.slice(start, start + count) }
        }
        const requestId = `REQ-${a.next++}`
        if (opts.method === 'POST') for (const d of body.domains) a.deny.push({ domainId: a.next++, name: d.name, type: d.type, state: 'ENABLED' })
        else a.deny = []
        a.requests.push({ requestId, status: 'COMPLETED', statusDetails: 'done', timestamp: '2026-10-20T10:00:00Z' })
        return { requestId }
      }
      if (path === '/sd/brandSafety/status') return { requestStatusList: a.requests }
      if ((m = path.match(/^\/sd\/brandSafety\/([^/]+)\/status$/))) return { requestStatus: a.requests.find((r) => r.requestId === m![1]) }
      if ((m = path.match(/^\/sd\/brandSafety\/([^/]+)\/results$/))) return { results: [{ status: 'SUCCESS', details: 'Domain successfully added', domainId: 1, name: 'example.com' }] }
      throw new Error(`the fake Amazon has no answer for ${opts.method} ${opts.path}`)
    },
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
const db = () => database.client as any
const call = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
const sent = (method: string, prefix: string) => amazon.calls.filter((c) => c.method === method && c.path.startsWith(prefix))
const live = () => vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const rule = (ruleId: string, ruleName: string, metricName: string, threshold: number) => ({ ruleId, ruleName, state: 'enabled', ruleConditions: [{ metricName, comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold }] })

const EXT = { cSd: '100000000301', gSd: '200000000301', cLow: '100000000302', gLow: '200000000302', gEmpty: '200000000303', gHeld: '200000000304' }

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    const campaign = (id: string, name: string, externalCampaignId: string, dailyBudget: string) =>
      db().campaign.create({ data: { id, name, type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId, dailyBudget, costType: 'cpc', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
    await campaign('c-sd', 'Test display', EXT.cSd, '60.00')
    await campaign('c-sd-low', 'Test display low budget', EXT.cLow, '3.00')
    const group = async (id: string, campaignId: string, name: string, externalAdGroupId: string, sku: string | null) => {
      await db().adGroup.create({ data: { id, campaignId, name, externalAdGroupId } })
      if (sku) await db().adProductAd.create({ data: { adGroupId: id, sku, asin: null } })
    }
    await group('g-sd', 'c-sd', 'Test display group', EXT.gSd, 'TEST-SKU-1')
    await group('g-sd-low', 'c-sd-low', 'Test low group', EXT.gLow, 'TEST-SKU-2')
    await group('g-sd-empty', 'c-sd', 'Test group without ads', EXT.gEmpty, null)
    await group('g-sd-held', 'c-sd', 'Test group with a rule', EXT.gHeld, 'TEST-SKU-3')
    // A Nexus budget schedule that also moves the SD campaign's budget: the budget rule's preview names it.
    await db().budgetSchedule.create({ data: { name: 'Test evening boost', campaigns: [{ id: 'c-sd' }], enabled: true } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.unstubAllEnvs()
  amazon.calls.length = 0
  amazon.force.clear()
  amazon.optRules.clear(); amazon.groupRules.clear(); amazon.budgetRules.clear(); amazon.campaignRules.clear()
  amazon.deny = []; amazon.requests = []
  amazon.optRules.set('OR-HELD', rule('OR-HELD', 'Held rule', 'COST_PER_CLICK', 0.8))
  amazon.groupRules.set(EXT.gHeld, ['OR-HELD'])
})

describe('the tools as the contract holds them', () => {
  it('each change is a request a person approves (never by rule), reaches Amazon, and can be partly undone', () => {
    for (const name of ['set-sd-optimization-rule', 'set-sd-budget-rule', 'set-sd-brand-safety']) {
      expect(getTool(name), name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, reversibility: 'partial', riskTier: 'high' })
      expect(getTool(name)!.limits).toBeUndefined()
    }
    for (const name of ['sd-optimization-rules', 'sd-budget-rules', 'sd-budget-insights', 'sd-forecast', 'sd-brand-safety']) {
      expect(getTool(name), name).toMatchObject({ readOnly: true, openWorld: true, requires: ['ads.view'] })
    }
  })
})

describe('sandbox mode: nothing is asked, nothing is queued', () => {
  it('a change is refused before it is queued, a read asks nothing', async () => {
    const asked = await call('set-sd-optimization-rule', { op: 'attach', adGroupId: 'g-sd', ruleId: 'OR-HELD' })
    expect(asked.error).toMatch(/sandbox mode on this server.*Nexus keeps no copy of Sponsored Display rules or the deny list, so approving it would change nothing\. Nothing was queued\./)
    expect((await call('sd-brand-safety', { market: 'IT' })).error).toMatch(/sandbox mode on this server.*nothing was asked of Amazon/)
    expect(amazon.calls).toEqual([])
  })

  it('what this business does not have is "not found" first', async () => {
    live()
    expect((await call('set-sd-optimization-rule', { op: 'attach', adGroupId: 'g-nowhere', ruleId: 'OR-HELD' })).error).toMatch(/Ad group g-nowhere not found in this business/)
    expect((await call('set-sd-budget-rule', { op: 'attach', campaignId: 'c-nowhere', ruleId: 'BR-1' })).error).toMatch(/Campaign c-nowhere not found in this business/)
    expect((await call('set-sd-brand-safety', { op: 'clear', market: 'ZZ' })).error).toMatch(/Amazon Ads market ZZ not found in this business/)
    // A Sponsored Products campaign is not Sponsored Display's.
    expect((await call('set-sd-budget-rule', { op: 'attach', campaignId: 'c-it', ruleId: 'BR-1' })).error).toMatch(/is not a Sponsored Display campaign \(SPONSORED_PRODUCTS\)/)
    expect(amazon.calls).toEqual([])
  })
})

describe('optimization rules (cost control)', () => {
  it('create on an ad group: the preview, the exact bodies Amazon gets, the record and its undo', async () => {
    live()
    const answer = await call('set-sd-optimization-rule', { op: 'create', market: 'IT', name: 'Test cost cap', metric: 'cost-per-order', thresholdCents: 1000, adGroupId: 'g-sd' })
    expect(answer.error).toBeUndefined()
    const p = answer.preview
    expect(p).toMatchObject({
      op: 'create', market: 'IT', reach: { reach: 'live', profileId: 'P-IT-TEST' },
      changes: {
        'optimization rule': { from: null, to: '"Test cost cap": cost per order at most EUR 10.00' },
        'rule on ad group "Test display group" in campaign "Test display"': { from: 'none', to: '"Test cost cap"' },
      },
      raises: [expect.stringMatching(/overrides its targets' manual bids and may add targets/)],
      effect: expect.stringMatching(/ADDS SPEND/),
      reachNote: expect.stringMatching(/^live: after approval it is sent to Amazon at once \(Amazon Ads profile P-IT-TEST\)/),
    })
    const asked = await ask('set-sd-optimization-rule', { op: 'create', market: 'IT', name: 'Test cost cap', metric: 'cost-per-order', thresholdCents: 1000, adGroupId: 'g-sd' })
    expect(asked.approvalId).toBeTruthy()
    amazon.calls.length = 0
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { ruleId: expect.stringMatching(/^OR-/), attached: true, reach: { reach: 'live', profileId: 'P-IT-TEST' } } })
    const created = sent('POST', '/sd/optimizationRules')[0]
    expect(created).toMatchObject({ profileId: 'P-IT-TEST', body: [{ state: 'enabled', ruleName: 'Test cost cap', ruleConditions: [{ metricName: 'COST_PER_ORDER', comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: 10 }] }] })
    expect(sent('POST', `/sd/adGroups/${EXT.gSd}/optimizationRules`)[0].body).toEqual({ optimizationRuleIds: [done.result.ruleId] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-sd-optimization-rule', args: { op: 'detach', adGroupId: 'g-sd', ruleId: done.result.ruleId } } })
  })

  it("Amazon's limits are refused before anything is queued", async () => {
    live()
    const refused = async (args: Record<string, unknown>) => (await call('set-sd-optimization-rule', args)).error as string
    expect(await refused({ op: 'create', market: 'IT', name: 'Too low', metric: 'cost-per-order', thresholdCents: 400 })).toMatch(/Amazon's lowest cost per order limit is EUR 5.00; EUR 4.00 is below it/)
    expect(await refused({ op: 'create', market: 'IT', name: 'Low budget', metric: 'cost-per-order', thresholdCents: 1000, adGroupId: 'g-sd-low' }))
      .toMatch(/daily budget is at least 5× it \(EUR 50.00\); campaign "Test display low budget" has EUR 3.00 in Nexus/)
    expect(await refused({ op: 'attach', adGroupId: 'g-sd-empty', ruleId: 'OR-HELD' })).toMatch(/only on an ad group with product ads/)
    expect(await refused({ op: 'create', market: 'IT', name: 'Held rule', metric: 'cost-per-click', thresholdCents: 60 })).toMatch(/already has an optimization rule named "Held rule" \(ruleId OR-HELD\)/)
    amazon.optRules.set('OR-OTHER', rule('OR-OTHER', 'Other rule', 'COST_PER_CLICK', 0.6))
    expect(await refused({ op: 'attach', adGroupId: 'g-sd-held', ruleId: 'OR-OTHER' })).toMatch(/one optimization rule per ad group, and ad group "Test group with a rule" holds "Held rule" \(OR-HELD\): detach it first/)
    expect(await refused({ op: 'detach', adGroupId: 'g-sd', ruleId: 'OR-HELD' })).toMatch(/Nothing would change: ad group "Test display group" holds no optimization rule/)
    // Nothing reached Amazon but reads.
    expect(amazon.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('update: from → to on every ad group it is on, a higher limit adds spend; Amazon\'s refusal is said; undo puts the old limit back', async () => {
    live()
    const answer = await call('set-sd-optimization-rule', { op: 'update', market: 'IT', ruleId: 'OR-HELD', thresholdCents: 120 })
    expect(answer.error).toBeUndefined()
    const p = answer.preview
    expect(p).toMatchObject({
      changes: { 'cost control': { from: 'cost per click at most EUR 0.80', to: 'cost per click at most EUR 1.20' } },
      onAdGroups: [{ adGroupId: 'g-sd-held', name: 'Test group with a rule' }],
      raises: ['a higher limit lets Amazon bid higher on 1 ad group it is on'],
    })
    // Amazon refuses the first run: its words come back, nothing is recorded as done, the request waits again.
    const asked = await ask('set-sd-optimization-rule', { op: 'update', market: 'IT', ruleId: 'OR-HELD', thresholdCents: 120 })
    amazon.force.set('PUT /sd/optimizationRules', { body: [{ code: 'INVALID_ARGUMENT', description: 'Threshold not allowed for this ad group', ruleId: 'OR-HELD' }] })
    const refused = await approve(asked.approvalId!)
    expect(refused).toMatchObject({ ok: false, status: 'pending', error: expect.stringMatching(/Amazon refused it: INVALID_ARGUMENT — Threshold not allowed for this ad group\. Nothing was changed\./) })
    expect(amazon.optRules.get('OR-HELD')!.ruleConditions[0].threshold).toBe(0.8)
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed' })
    expect(sent('PUT', '/sd/optimizationRules').at(-1)!.body).toEqual([{ ruleId: 'OR-HELD', state: 'enabled', ruleName: 'Held rule', ruleConditions: [{ metricName: 'COST_PER_CLICK', comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: 1.2 }] }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { args: { op: 'update', ruleId: 'OR-HELD', name: 'Held rule', metric: 'cost-per-click', thresholdCents: 80 } } })
  })

  it('what moved at Amazon after approval is not run', async () => {
    live()
    const asked = await ask('set-sd-optimization-rule', { op: 'detach', adGroupId: 'g-sd-held' })
    amazon.optRules.set('OR-HELD', rule('OR-HELD', 'Held rule', 'COST_PER_CLICK', 0.9))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/basis changed/) })
    expect(sent('POST', `/sd/adGroups/${EXT.gHeld}/optimizationRules/disassociate`)).toEqual([])
  })

  it('an HTTP refusal reaches the read in Amazon\'s code and description', async () => {
    live()
    amazon.force.set('GET /sd/optimizationRules', { status: 403, body: { code: 'UNAUTHORIZED', description: 'Optimization rules are not available for this advertiser' } })
    expect((await call('sd-optimization-rules', { market: 'IT' })).error).toBe('Amazon answered 403: UNAUTHORIZED — Optimization rules are not available for this advertiser.')
    const read = (await call('sd-optimization-rules', { market: 'IT', withAdGroups: true })).data
    expect(read.rules).toEqual([expect.objectContaining({ ruleId: 'OR-HELD', metric: 'cost-per-click', thresholdCents: 80, onAdGroups: [expect.stringMatching(/"Test group with a rule" \(g-sd-held\)/)] })])
  })
})

describe('budget rules', () => {
  const weekend = { name: 'Test weekend boost', type: 'schedule', increasePct: 25, startDate: inDays(3), endDate: inDays(60), recurrence: 'weekly', daysOfWeek: ['saturday', 'sunday'], hours: { from: '18:00', to: '23:00' } }

  it("create on a campaign: SPENDS MONEY, the clash with Nexus's budget writers, Amazon's body; undo detaches", async () => {
    live()
    const p = (await call('set-sd-budget-rule', { op: 'create', market: 'IT', campaignId: 'c-sd', ...weekend })).preview
    expect(p).toMatchObject({
      raises: [expect.stringMatching(/campaign "Test display"'s daily budget rises by 25 %/)],
      effect: expect.stringMatching(/ADDS SPEND/),
      changes: { 'budget rule': { from: null, to: expect.stringMatching(/\+25 % from .* weekly on saturday, sunday, 18:00–23:00/) } },
      warnings: expect.arrayContaining([expect.stringMatching(/the two stack/), 'Campaign "Test display": Nexus\'s budget schedule "Test evening boost" also changes it — they stack with Amazon\'s rule.']),
    })
    const asked = await ask('set-sd-budget-rule', { op: 'create', market: 'IT', campaignId: 'c-sd', ...weekend })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { attached: true } })
    expect(sent('POST', '/sd/budgetRules')[0].body).toEqual({
      budgetRulesDetails: [{
        name: 'Test weekend boost', ruleType: 'SCHEDULE', budgetIncreaseBy: { type: 'PERCENT', value: 25 },
        duration: { dateRangeTypeRuleDuration: { startDate: weekend.startDate.split('-').join(''), endDate: weekend.endDate.split('-').join('') } },
        recurrence: { type: 'WEEKLY', daysOfWeek: ['SATURDAY', 'SUNDAY'], intraDaySchedule: [{ startTime: '18:00:00', endTime: '23:00:00' }] },
      }],
    })
    expect(sent('POST', `/sd/campaigns/${EXT.cSd}/budgetRules`)[0].body).toEqual({ budgetRuleIds: [done.result.ruleId] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { args: { op: 'detach', campaignId: 'c-sd', ruleId: done.result.ruleId } } })
  })

  it('a pause raises nothing; its undo switches it on again; a new rule on no campaign is undone by a pause', async () => {
    live()
    const create = await ask('set-sd-budget-rule', { op: 'create', market: 'IT', ...weekend, name: 'Test loose rule' })
    const ruleId = (await approve(create.approvalId!)).result.ruleId
    // Amazon has no delete: a new rule on no campaign is undone by a pause.
    expect(await inside(() => undoRequestFor({ approvalId: create.approvalId! }))).toMatchObject({ request: { args: { op: 'update', market: 'IT', ruleId, state: 'paused' } } })
    const pause = (await call('set-sd-budget-rule', { op: 'update', market: 'IT', ruleId, state: 'paused' })).preview
    expect(pause).toMatchObject({ changes: { 'rule state': { from: 'active', to: 'paused' } }, raises: [], warnings: ['It is on no campaign: it raises no budget now.'] })
    const asked = await ask('set-sd-budget-rule', { op: 'update', market: 'IT', ruleId, state: 'paused' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(sent('PUT', '/sd/budgetRules').at(-1)!.body).toMatchObject({ budgetRulesDetails: [{ ruleId, ruleState: 'PAUSED', ruleDetails: { name: 'Test loose rule', ruleType: 'SCHEDULE' } }] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { args: { op: 'update', ruleId, state: 'active' } } })
    // Attaching a paused rule raises nothing now, and says why.
    const attach = (await call('set-sd-budget-rule', { op: 'attach', campaignId: 'c-sd', ruleId })).preview
    expect(attach).toMatchObject({ raises: [], warnings: expect.arrayContaining([expect.stringMatching(/The rule is paused: it raises nothing/)]) })
  })

  it('what Amazon would refuse is refused first', async () => {
    live()
    const refused = async (args: Record<string, unknown>) => (await call('set-sd-budget-rule', { op: 'create', market: 'IT', ...args })).error as string
    expect(await refused({ ...weekend, type: 'performance' })).toMatch(/a performance rule needs condition/)
    expect(await refused({ ...weekend, startDate: '2020-01-01' })).toMatch(/Amazon starts a rule today or later, not on 2020-01-01/)
    expect(await refused({ ...weekend, recurrence: 'daily' })).toMatch(/daysOfWeek is for a weekly rule/)
    expect(await refused({ ...weekend, hours: { from: '20:00', to: '08:00' } })).toMatch(/its hours end \(08:00\) must be after their start \(20:00\)/)
    amazon.budgetRules.set('BR-SAME', { ruleId: 'BR-SAME', ruleState: 'ACTIVE', ruleDetails: { name: 'Test weekend boost', ruleType: 'SCHEDULE', budgetIncreaseBy: { type: 'PERCENT', value: 10 } } })
    amazon.campaignRules.set(EXT.cSd, ['BR-SAME'])
    expect(await refused({ ...weekend, campaignId: 'c-sd' })).toMatch(/already holds a budget rule named "Test weekend boost" \(ruleId BR-SAME\), and Amazon takes one name once per campaign/)
  })

  it('a performance rule reads back as it was sent', async () => {
    live()
    const roas = { name: 'Test ROAS boost', type: 'performance', increasePct: 15, startDate: inDays(1), condition: { metric: 'roas', comparison: 'greater-than', threshold: 4 } }
    const done = await approve((await ask('set-sd-budget-rule', { op: 'create', market: 'IT', ...roas })).approvalId!)
    expect(sent('POST', '/sd/budgetRules')[0].body).toMatchObject({ budgetRulesDetails: [{ ruleType: 'PERFORMANCE', performanceMeasureCondition: { metricName: 'ROAS', comparisonOperator: 'GREATER_THAN', threshold: 4 } }] })
    const read = (await call('sd-budget-rules', { market: 'IT', ruleId: done.result.ruleId })).data.rules[0]
    expect(read).toMatchObject({ type: 'performance', state: 'active', increasePct: 15, condition: { metric: 'roas', comparison: 'greater-than', threshold: 4 }, says: expect.stringMatching(/^\+15 % from .* \(no end\), while ROAS > 4$/), campaigns: [] })
  })
})

describe('budget insights and forecasts (reads)', () => {
  it("Amazon's recommendation and today's usage per campaign, in minor units; a campaign Amazon refused says why", async () => {
    live()
    const data = (await call('sd-budget-insights', { campaignIds: ['c-sd', 'c-sd-low'] })).data
    expect(sent('POST', '/sd/campaigns/budgetRecommendations')[0].body).toEqual({ campaignIds: [EXT.cSd, EXT.cLow] })
    expect(data.campaigns[0]).toMatchObject({
      campaignId: 'c-sd', dailyBudgetCents: 6000,
      recommendation: { suggestedBudgetCents: 3550, percentTimeInBudget: 62.5, missedSalesLowCents: 4000, missedSalesHighCents: 9025, missedClicks: { low: 12, high: 30 } },
      usage: { usedPct: 41.2, amazonBudgetCents: 2000, current: true },
    })
    expect(data.campaigns[1].recommendation).toEqual({ error: 'INVALID_ARGUMENT — Campaign has no recommendation' })
  })

  it('a forecast sends the planned ad group as Amazon takes it, and refuses what Amazon would', async () => {
    live()
    const args = { market: 'IT', startDate: inDays(2), bidOptimization: 'clicks', dailyBudgetCents: 2000, skus: ['TEST-SKU-1'], targets: [{ kind: 'category', value: '12345', bidCents: 60 }, { kind: 'audience', audienceType: 'views-remarketing', value: 'exactProduct', lookbackDays: 30, bidCents: 70 }], costControl: { metric: 'cost-per-click', thresholdCents: 80 } }
    const data = (await call('sd-forecast', args)).data
    expect(sent('POST', '/sd/forecasts')[0].body).toEqual({
      campaign: { startDate: args.startDate.split('-').join(''), costType: 'cpc', budget: 20, budgetType: 'daily' },
      adGroup: { bidOptimization: 'clicks' },
      productAds: [{ sku: 'TEST-SKU-1' }],
      targetingClauses: [
        { expressionType: 'manual', expression: [{ type: 'asinCategorySameAs', value: '12345' }], bid: 0.6 },
        { expressionType: 'manual', expression: [{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }], bid: 0.7 },
      ],
      optimizationRules: [{ state: 'enabled', ruleConditions: [{ metricName: 'COST_PER_CLICK', comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: 0.8 }] }],
    })
    expect(data).toMatchObject({ status: 'COMPLETE', lifetime: { CLICKS: { min: 10, max: 40 } }, budgetCurve: expect.arrayContaining([{ budgetCents: 2500, focus: true, clicks: { min: 20, max: 40 }, reach: null }]) })
    expect(data.budgetCurve.length).toBeLessThanOrEqual(13)
    expect((await call('sd-forecast', { ...args, bidOptimization: 'reach' })).error).toMatch(/Amazon optimizes a cpc ad group for clicks or conversions, not reach/)
    expect((await call('sd-forecast', { ...args, targets: [{ kind: 'product', value: 'not-an-asin', bidCents: 50 }] })).error).toMatch(/targets\[0\]: "not-an-asin" is not an ASIN/)
  })
})

describe('the brand-safety deny list', () => {
  it('add: account-wide, ones already on it left out, Amazon\'s body; undo of an add to an empty list clears it', async () => {
    live()
    const p = (await call('set-sd-brand-safety', { op: 'add', market: 'IT', domains: [{ name: 'Example.com', type: 'website' }, { name: 'com.example.app', type: 'app' }] })).preview
    expect(p).toMatchObject({ accountWide: true, raises: [], totals: { onListNow: 0, adding: 2 }, warnings: expect.arrayContaining([expect.stringMatching(/^ACCOUNT-WIDE: the deny list is one list for the whole advertiser \(Amazon Ads profile P-IT-TEST, IT\)/)]) })
    expect((await call('set-sd-brand-safety', { op: 'add', market: 'IT', domains: [{ name: 'https://example.com/page', type: 'website' }] })).error).toMatch(/no http:\/\/, no path/)
    const asked = await ask('set-sd-brand-safety', { op: 'add', market: 'IT', domains: [{ name: 'Example.com', type: 'website' }, { name: 'com.example.app', type: 'app' }] })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { requestId: expect.stringMatching(/^REQ-/), added: 2 } })
    expect(sent('POST', '/sd/brandSafety/deny')[0].body).toEqual({ domains: [{ name: 'example.com', type: 'WEBSITE' }, { name: 'com.example.app', type: 'APP' }] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { args: { op: 'clear', market: 'IT' } } })
    expect((await call('set-sd-brand-safety', { op: 'add', market: 'IT', domains: [{ name: 'example.com', type: 'website' }] })).error).toMatch(/Nothing would change: 1 entry is on the deny list already/)
  })

  it('clear: every entry, listed as a raise; Amazon gets one DELETE; undo adds them back', async () => {
    live()
    amazon.deny = [{ domainId: 1, name: 'example.com', type: 'WEBSITE', state: 'ENABLED' }, { domainId: 2, name: '1234567890', type: 'APP', state: 'ENABLED' }]
    const p = (await call('set-sd-brand-safety', { op: 'clear', market: 'IT' })).preview
    expect(p).toMatchObject({ raises: ['its Sponsored Display ads may show again on 2 websites and apps'], changes: { 'deny list': { from: '2 entries: example.com, 1234567890', to: 'empty' } }, effect: expect.stringMatching(/ADDS SPEND/) })
    expect((await call('set-sd-brand-safety', { op: 'clear', market: 'IT', domains: [{ name: 'example.com', type: 'website' }] })).error).toMatch(/op clear removes every entry and takes no domains/)
    const asked = await ask('set-sd-brand-safety', { op: 'clear', market: 'IT' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { removed: 2 } })
    expect(sent('DELETE', '/sd/brandSafety/deny')).toHaveLength(1)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { args: { op: 'add', market: 'IT', domains: [{ name: 'example.com', type: 'website' }, { name: '1234567890', type: 'app' }] } } })
    const status = (await call('sd-brand-safety', { market: 'IT', view: 'requests' })).data
    expect(status.requests).toEqual([expect.objectContaining({ status: 'COMPLETED' })])
  })
})
