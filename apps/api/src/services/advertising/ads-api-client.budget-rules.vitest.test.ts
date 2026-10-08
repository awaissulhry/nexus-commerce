/**
 * ONE BRAIN AB-4 — the read of Amazon's own budget rules on one campaign (GET /sp/campaigns/{campaignId}/budgetRules),
 * driven through the REAL Ads client and the REAL channel gateway with `fetch` stubbed (the pattern of
 * gateway/ads.p12.vitest.test.ts): the answer parsed from a fixture in the published spec's shape, one ledger row per
 * send, a read (never an action), and nothing sent in sandbox mode. Values are made up (public repo).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from '../gateway/rate.js'
import { AmazonAnswerNotUnderstood, budgetRulesPath, listCampaignBudgetRules, parseCampaignBudgetRules } from './ads-api-client.js'

const FIXTURE = JSON.parse(readFileSync(new URL('./brain/__fixtures__/sp-campaign-budget-rules.json', import.meta.url), 'utf8')) as unknown
const ctx = { profileId: '123', region: 'EU' as const }

describe('AB-4 parseCampaignBudgetRules — Amazon\'s answer in the spec\'s shape', () => {
  it('reads every rule: id, name, type, state, the raise, its dates or event, its days and its condition', () => {
    const parsed = parseCampaignBudgetRules(FIXTURE)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.rules).toHaveLength(4)
    expect(parsed.rules[0]).toEqual({
      ruleId: '0b9c1f2e-0000-4000-8000-000000000001', name: 'Weekend boost', ruleType: 'SCHEDULE', ruleState: 'ACTIVE', ruleStatus: 'ACTIVE',
      increasePct: 25, startDate: '20261001', endDate: '20261231', eventName: null, recurrence: 'DAILY', daysOfWeek: ['SATURDAY', 'SUNDAY'],
      metric: null, comparison: null, threshold: null,
    })
    expect(parsed.rules[1]).toMatchObject({ name: 'ROAS above 4', ruleType: 'PERFORMANCE', increasePct: 20, startDate: '20260901', endDate: null, metric: 'ROAS', comparison: 'GREATER_THAN', threshold: 4 })
    expect(parsed.rules[2]).toMatchObject({ name: 'Event push', ruleState: 'PAUSED', eventName: 'Autumn event', startDate: '20261020', endDate: '20261022' })
    expect(parsed.rules[3]).toMatchObject({ name: 'Summer sale', endDate: '20260831' })
  })

  it('no rule attached is an empty list; a bare array is read as the list', () => {
    expect(parseCampaignBudgetRules({ associatedRules: [] })).toEqual({ rules: [] })
    expect(parseCampaignBudgetRules([{ ruleId: 7, ruleState: 'ACTIVE', ruleDetails: { budgetIncreaseBy: { type: 'PERCENT', value: '15' } } }]))
      .toEqual({ rules: [expect.objectContaining({ ruleId: '7', name: null, increasePct: 15, daysOfWeek: [] })] })
  })

  it('an answer without the list is not understood — never "no rules"', () => {
    for (const answer of [{}, null, 'text', { associatedRules: 'x' }, { rules: [] }]) {
      expect(parseCampaignBudgetRules(answer)).toEqual({ error: expect.stringMatching(/no associatedRules list.*cannot say whether/) })
    }
  })
})

describe('AB-4 listCampaignBudgetRules — through the channel gateway', () => {
  beforeEach(() => {
    __rateTest.useMemory()
    h.calls = []; h.answers = []; gatewayLedger.length = 0
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      h.calls.push({ url: String(url), init })
      return h.answers.shift()?.() ?? new Response(JSON.stringify({ associatedRules: [] }), { status: 200 })
    }))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

  it('one GET to the campaign\'s budgetRules path with the account\'s token and the profile scope, logged by the gateway as a read', async () => {
    h.answers.push(() => new Response(JSON.stringify(FIXTURE), { status: 200 }))
    const rules = await listCampaignBudgetRules(ctx, '3141592653')
    expect(rules?.map((r) => r.name)).toEqual(['Weekend boost', 'ROAS above 4', 'Event push', 'Summer sale'])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe('https://advertising-api-eu.amazon.com/sp/campaigns/3141592653/budgetRules')
    expect(h.calls[0].init.method).toBe('GET')
    expect(h.calls[0].init.body ?? null).toBeNull()
    expect(h.calls[0].init.headers).toMatchObject({ Authorization: 'Bearer ads-token', 'Amazon-Advertising-API-ClientId': 'amzn1.application-oa2-client.x', 'Amazon-Advertising-API-Scope': '123', Accept: 'application/json' })
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS', connectionId: 'ads-1', method: 'GET', outcome: 'sent', success: true, operation: 'GET /sp/campaigns/:id/budgetRules' })])
  })

  it('an id is never spliced raw into the path', () => {
    expect(budgetRulesPath('12/../34')).toBe('/sp/campaigns/12%2F..%2F34/budgetRules')
  })

  it('a refused read throws with Amazon\'s status (the daily read records "could not read"); a 5xx is retried by the client first', async () => {
    h.answers.push(() => new Response('{"code":"UNAUTHORIZED"}', { status: 403 }))
    await expect(listCampaignBudgetRules(ctx, '1')).rejects.toMatchObject({ statusCode: 403 })
    expect(h.calls).toHaveLength(1)
    h.calls = []
    h.answers.push(() => new Response('{}', { status: 503 }), () => new Response(JSON.stringify({ associatedRules: [] }), { status: 200 }))
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const pending = listCampaignBudgetRules(ctx, '2')
      await vi.runAllTimersAsync()
      expect(await pending).toEqual([])
    } finally { vi.useRealTimers() }
    expect(h.calls).toHaveLength(2)
  })

  it('an answer that is not understood throws, so nothing says "no rules"', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }))
    await expect(listCampaignBudgetRules(ctx, '1')).rejects.toBeInstanceOf(AmazonAnswerNotUnderstood)
  })

  it('sandbox mode asks nothing and answers null (no made-up rules)', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    expect(await listCampaignBudgetRules(ctx, '1')).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toHaveLength(0)
  })
})
