/**
 * ONE BRAIN AB-4 — Amazon's own rules on brain campaigns (brain/native-rules.ts): how a budget rule, a bidding strategy
 * and a stored reading are said; what acts; the refusal of AUTO over a rule; and the daily read with the database and
 * Amazon stubbed — the no-op path asks Amazon nothing, a failed read keeps what the last good read saw, a spent quota
 * stops the rest of the market, sandbox asks nothing, a campaign that left the brain loses its row; and (follow-up) a rule
 * only the last good read saw says how the reads since failed, and a 429 from the real liveCall and gateway inside the
 * daily read skips the rest of that market without a crash. Values are made up (public repo).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  enrolled: 0,
  bidRows: [] as Array<{ campaignId: string }>,
  enrollments: [] as Array<{ productId: string; marketplace: string }>,
  campaigns: [] as Array<{ id: string; name: string; externalCampaignId: string | null; marketplace: string | null }>,
  snapshots: new Map<string, { campaignId: string; fetchedAt: Date; readings: unknown }>(),
  calls: [] as string[],
}))
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainEnrollment: {
      count: async () => { db.calls.push('enrollment.count'); return db.enrolled },
      findMany: async () => { db.calls.push('enrollment.findMany'); return db.enrollments },
    },
    bidBrainEnrollment: { findMany: async () => { db.calls.push('bidBrain.findMany'); return db.bidRows } },
    campaign: { findMany: async () => { db.calls.push('campaign.findMany'); return db.campaigns } },
    adsNativeRuleSnapshot: {
      findMany: async () => [...db.snapshots.values()],
      upsert: async (args: { where: { campaign: { campaignId: string } }; create: { campaignId: string; fetchedAt: Date; readings: unknown } }) => {
        db.calls.push('snapshot.upsert')
        db.snapshots.set(args.where.campaign.campaignId, { campaignId: args.create.campaignId, fetchedAt: args.create.fetchedAt, readings: args.create.readings })
        return {}
      },
      deleteMany: async (args: { where: { campaignId: { notIn: string[] } } }) => {
        db.calls.push('snapshot.deleteMany')
        const gone = [...db.snapshots.keys()].filter((k) => !args.where.campaignId.notIn.includes(k))
        for (const k of gone) db.snapshots.delete(k)
        return { count: gone.length }
      },
    },
  },
}))
// The follow-up's 429 case drives the REAL liveCall and gateway with `fetch` stubbed (gateway/ads.p12.vitest.test.ts).
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))
vi.mock('./ownership.js', () => ({
  productCampaigns: vi.fn(async (productId: string) => ({ root: productId, owned: [{ campaignId: 'c-own' }], shared: [{ campaignId: 'c-shared' }] })),
}))

import type { AmazonBudgetRule } from '../ads-api-client.js'
import { gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import {
  actingRules, amazonDayOf, budgetRuleOf, campaignNativeRules, campaignNativeView, NATIVE_RULE_CAPABILITY, nativeAutoRefusal, nativeRuleLines, nativeRuleWriters,
  notReadableKinds, readNativeRulesOnce, storedBudgetReading, strategyReading, type CampaignNativeRules,
} from './native-rules.js'

const NOW = new Date('2026-10-08T04:35:00Z')
const TODAY = amazonDayOf(NOW)
const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/sp-campaign-budget-rules.json', import.meta.url), 'utf8')) as unknown
const parsedFixture = async (): Promise<AmazonBudgetRule[]> => {
  const { parseCampaignBudgetRules } = await import('../ads-api-client.js')
  const p = parseCampaignBudgetRules(FIXTURE)
  if ('error' in p) throw new Error(p.error)
  return p.rules
}
const rule = (over: Partial<AmazonBudgetRule> = {}): AmazonBudgetRule => ({
  ruleId: 'r-1', name: 'Weekend boost', ruleType: 'SCHEDULE', ruleState: 'ACTIVE', ruleStatus: null, increasePct: 25, startDate: '20261001', endDate: null,
  eventName: null, recurrence: 'DAILY', daysOfWeek: [], metric: null, comparison: null, threshold: null, ...over,
})
const reading = (campaignId: string, opts: { rules?: AmazonBudgetRule[]; strategy?: unknown; fetchedAt?: Date } = {}): CampaignNativeRules => campaignNativeRules({
  campaignId,
  snapshot: opts.rules ? { fetchedAt: opts.fetchedAt ?? NOW, readings: { budgetRules: { state: 'read', rules: opts.rules } } } : null,
  strategy: 'strategy' in opts ? opts.strategy : 'LEGACY_FOR_SALES', strategyAt: NOW,
}, NOW)

describe('AB-4 — what Nexus can read of each kind (the capability flag)', () => {
  it('budget rules are read from Amazon, the strategy from the sync; optimization and schedule bid rules are "could not read", never a guessed path', () => {
    expect(Object.fromEntries(Object.entries(NATIVE_RULE_CAPABILITY).map(([k, v]) => [k, v.read]))).toEqual({ budgetRules: 'amazon', ruleBasedBidding: 'synced', optimizationRules: 'none', scheduleBidRules: 'none' })
    expect(NATIVE_RULE_CAPABILITY.budgetRules.how).toContain('GET /sp/campaigns/{campaignId}/budgetRules')
    expect(notReadableKinds().map((k) => [k.kind, k.levers])).toEqual([['optimizationRules', ['bids', 'harvest']], ['scheduleBidRules', ['bids', 'hours']]])
    expect(notReadableKinds()[1].why).toMatch(/^console only/)
  })
})

describe('AB-4 budgetRuleOf — a budget rule in the map\'s words, judged on the day it is shown', () => {
  it('the fixture: two act (in range, open-ended), a paused one and an ended one are attached but idle', async () => {
    const shown = (await parsedFixture()).map((r) => budgetRuleOf(r, TODAY))
    expect(shown.map((r) => [r.name, r.acts])).toEqual([['Weekend boost', true], ['ROAS above 4', true], ['Event push', false], ['Summer sale', false]])
    expect(shown[0]).toMatchObject({ kind: 'budgetRules', id: '0b9c1f2e-0000-4000-8000-000000000001', levers: ['budgets'] })
    expect(shown[0].detail).toBe('raises the daily budget by 25 %; from 2026-10-01 to 2026-12-31; on sat, sun; Amazon\'s status: ACTIVE')
    expect(shown[1].detail).toBe('raises the daily budget by 20 %; when ROAS > 4 (last 7 days); from 2026-09-01')
    expect(shown[2].detail).toMatch(/during the event Autumn event; from 2026-10-20 to 2026-10-22; paused$/)
    expect(shown[3].detail).toMatch(/ended 2026-08-31$/)
  })

  it('a rule that starts later counts as acting (it is attached and will act); no name falls back to the id', () => {
    const later = budgetRuleOf(rule({ name: null, startDate: '2026-11-01', endDate: '2026-11-30' }), TODAY)
    expect(later).toMatchObject({ name: 'r-1', acts: true })
    expect(later.detail).toMatch(/starts 2026-11-01$/)
    expect(budgetRuleOf(rule({ endDate: TODAY }), TODAY).acts).toBe(true)
  })
})

describe('AB-4 strategyReading — a strategy Amazon runs is a rule; fixed, down only and up and down are not', () => {
  it('the three known strategies, in any spelling, are no rule', () => {
    for (const s of ['LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL', 'legacyForSales', 'autoForSales', 'manual']) expect(strategyReading(s, null)).toEqual({ state: 'read', at: null, rules: [] })
  })
  it('rule-based bidding, and any strategy Nexus does not know, act on bids and the bidding strategy', () => {
    const rb = strategyReading('RULE_BASED', '2026-10-08T04:20:00.000Z')
    expect(rb).toMatchObject({ state: 'read', rules: [{ kind: 'ruleBasedBidding', name: 'RULE_BASED', acts: true, levers: ['bids', 'biddingStrategy'] }] })
    expect((rb as { rules: Array<{ detail: string }> }).rules[0].detail).toMatch(/rule-based bidding.*ROAS guardrail/)
    expect(strategyReading('SOMETHING_NEW', null)).toMatchObject({ rules: [{ acts: true, detail: expect.stringMatching(/not fixed, down only or up and down/) }] })
  })
  it('no strategy synced is "could not read"', () => {
    for (const s of [null, undefined, '', 7]) expect(strategyReading(s, null)).toMatchObject({ state: 'could_not_read', why: expect.stringMatching(/has not read/) })
  })
})

describe('AB-4 storedBudgetReading — a snapshot as of now', () => {
  it('none stored: not read yet (brain campaigns only, once a day)', () => {
    expect(storedBudgetReading(null, NOW)).toMatchObject({ state: 'could_not_read', at: null, why: expect.stringMatching(/^not read yet.*04:35 UTC.*brain campaigns only/) })
  })
  it('a fresh read; an old read is "could not read lately" and keeps what it saw', () => {
    expect(storedBudgetReading({ fetchedAt: NOW, readings: { budgetRules: { state: 'read', rules: [rule()] } } }, NOW)).toMatchObject({ state: 'read', at: NOW.toISOString(), rules: [{ name: 'Weekend boost', acts: true }] })
    const old = new Date(NOW.getTime() - 51 * 3_600_000)
    expect(storedBudgetReading({ fetchedAt: old, readings: { budgetRules: { state: 'read', rules: [rule()] } } }, NOW))
      .toMatchObject({ state: 'could_not_read', why: expect.stringMatching(/more than two days ago/), lastSeen: { at: old.toISOString(), rules: [{ acts: true }] } })
  })
  it('a failed read with the last good read: its reason, and what was seen then; garbage is not understood', () => {
    const stored = { budgetRules: { state: 'could_not_read', why: 'the read failed: Amazon answered 500: x', lastRead: { at: '2026-10-07T04:35:00.000Z', rules: [rule()] } } }
    expect(storedBudgetReading({ fetchedAt: NOW, readings: stored }, NOW)).toMatchObject({ state: 'could_not_read', why: 'the read failed: Amazon answered 500: x', lastSeen: { at: '2026-10-07T04:35:00.000Z', rules: [{ name: 'Weekend boost' }] } })
    for (const readings of [null, {}, { budgetRules: { state: 'read', rules: 'x' } }, { budgetRules: { state: 'other' } }]) {
      expect(storedBudgetReading({ fetchedAt: NOW, readings }, NOW)).toMatchObject({ state: 'could_not_read', why: 'the stored reading is not understood' })
    }
  })
})

describe('AB-4 — what acts, the writers it adds, the campaign view', () => {
  it('acting rules: read ones that act, and the last-seen ones of a failed read; never a "could not read" kind', () => {
    const c = reading('c1', { rules: [rule(), rule({ ruleId: 'r-2', name: 'Paused', ruleState: 'PAUSED' })], strategy: 'RULE_BASED' })
    expect(actingRules(c).map((r) => [r.kind, r.name, r.stale])).toEqual([['budgetRules', 'Weekend boost', false], ['ruleBasedBidding', 'RULE_BASED', false]])
    expect(actingRules(reading('c2'))).toEqual([])
    expect(actingRules(undefined)).toEqual([])
  })
  it('writers per lever, named as Amazon\'s', () => {
    const w = nativeRuleWriters(reading('c1', { rules: [rule()], strategy: 'RULE_BASED' }))
    expect(w.map((x) => [x.lever, x.who])).toEqual([
      ['budgets', 'Amazon budget rule "Weekend boost"'], ['bids', 'Amazon-run bidding strategy "RULE_BASED"'], ['biddingStrategy', 'Amazon-run bidding strategy "RULE_BASED"'],
    ])
    expect(w[0].why).toMatch(/^Amazon's own rule \(a second brain inside Amazon\): raises the daily budget by 25 %/)
  })
  it('the campaign view: acting, idle, and only this campaign\'s "could not read" (the unreadable kinds are said once per view)', () => {
    const v = campaignNativeView(reading('c1', { rules: [rule(), rule({ ruleId: 'r-2', name: 'Paused', ruleState: 'PAUSED' })] }))
    expect(v.acting.map((a) => a.name)).toEqual(['Weekend boost'])
    expect(v.idle).toEqual([{ kind: 'budgetRules', name: 'Paused', detail: expect.stringMatching(/paused/) }])
    expect(v.couldNotRead).toEqual([])
    expect(campaignNativeView(reading('c2', { strategy: null })).couldNotRead.map((k) => k.kind)).toEqual(['budgetRules', 'ruleBasedBidding'])
    expect(campaignNativeView(undefined).couldNotRead).toEqual([{ kind: 'budgetRules', why: expect.stringMatching(/^not read yet/), at: null }])
  })
})

describe('AB-4 nativeAutoRefusal — a lever does not go AUTO where Amazon\'s own rule acts on it', () => {
  const readings = new Map([
    ['c-rule', reading('c-rule', { strategy: 'RULE_BASED' })],
    ['c-budget', reading('c-budget', { rules: [rule()] })],
    ['c-none', reading('c-none')],
    ['c-unread', reading('c-unread', { strategy: null })],
  ])
  it('refuses bids AUTO on a campaign whose bids Amazon runs, naming the rule, the campaign and the way out', () => {
    const refusal = nativeAutoRefusal([{ campaignId: 'c-rule', name: 'IT_Exact_Gale', lever: 'bids' }, { campaignId: 'c-none', name: 'IT_Auto', lever: 'bids' }], readings)
    expect(refusal).toMatch(/^the bids lever cannot go AUTO while Amazon's own rule acts on it there — Amazon-run bidding strategy "RULE_BASED" on campaign IT_Exact_Gale/)
    expect(refusal).toMatch(/detach the rule in Amazon's Campaign Manager — Nexus never edits Amazon's rules — and set the lever again after the next daily read \(04:35 UTC\), or keep the lever at OBSERVE$/)
    expect(refusal).not.toContain('IT_Auto')
  })
  it('a budget rule refuses the budgets lever, not the bids lever', () => {
    expect(nativeAutoRefusal([{ campaignId: 'c-budget', name: 'B', lever: 'bids' }], readings)).toBeNull()
    expect(nativeAutoRefusal([{ campaignId: 'c-budget', name: 'B', lever: 'budgets' }], readings)).toMatch(/^the budgets lever cannot go AUTO .*Amazon budget rule "Weekend boost" on campaign B/)
  })
  it('"could not read" refuses nothing; a rule only the last good read saw still refuses', () => {
    expect(nativeAutoRefusal([{ campaignId: 'c-unread', name: 'U', lever: 'bids' }, { campaignId: 'not-read', name: 'N', lever: 'budgets' }], readings)).toBeNull()
    const failed = campaignNativeRules({ campaignId: 'c-f', snapshot: { fetchedAt: NOW, readings: { budgetRules: { state: 'could_not_read', why: 'the read failed', lastRead: { at: '2026-10-07T04:35:00.000Z', rules: [rule()] } } } }, strategy: 'MANUAL', strategyAt: null }, NOW)
    expect(nativeAutoRefusal([{ campaignId: 'c-f', name: 'F', lever: 'budgets' }], new Map([['c-f', failed]]))).toMatch(/Weekend boost.*last read OK on 2026-10-07T04:35:00.000Z/)
  })
  it('follow-up: a rule only the last good read saw says when that read was, how the reads since failed, and the two ways out', () => {
    const lines = (stored: unknown, fetchedAt = NOW) => nativeRuleLines(campaignNativeRules({ campaignId: 'c', snapshot: { fetchedAt, readings: stored }, strategy: 'MANUAL', strategyAt: null }, NOW), 'budgets', 'on campaign F')
    const failed = { budgetRules: { state: 'could_not_read', why: 'the read failed: Amazon answered 500: [ADS-LIVE] GET … → 500: boom', lastRead: { at: '2026-10-06T04:35:00.000Z', rules: [rule()] } } }
    expect(lines(failed)).toEqual(['Amazon budget rule "Weekend boost" on campaign F (raises the daily budget by 25 %; from 2026-10-01; last read OK on 2026-10-06T04:35:00.000Z; reads since then failed (Amazon answered 500); detach it in Amazon or wait for a good read)'])
    // No read reached it for more than two days.
    const old = new Date(NOW.getTime() - 3 * 86_400_000)
    expect(lines({ budgetRules: { state: 'read', rules: [rule()] } }, old)[0]).toContain(`last read OK on ${old.toISOString()}; reads since then failed (no read reached it for more than two days); detach it in Amazon or wait for a good read)`)
    // A read that failed without Amazon's status keeps its own short reason.
    expect(lines({ budgetRules: { state: 'could_not_read', why: 'no advertising profile serves IT', lastRead: { at: '2026-10-06T04:35:00.000Z', rules: [rule()] } } })[0]).toContain('reads since then failed (no advertising profile serves IT)')
    // A fresh read: no such words.
    expect(lines({ budgetRules: { state: 'read', rules: [rule()] } })).toEqual([`Amazon budget rule "Weekend boost" on campaign F (raises the daily budget by 25 %; from 2026-10-01; read ${NOW.toISOString()})`])
    expect(nativeRuleLines(undefined, 'bids')).toEqual([])
  })
  it('one line per rule, however many times it is asked; long lists are cut', () => {
    const many = new Map(Array.from({ length: 7 }, (_, i) => [`c${i}`, reading(`c${i}`, { strategy: 'RULE_BASED' })]))
    const asks = [...many.keys()].flatMap((id) => [{ campaignId: id, name: id, lever: 'bids' as const }, { campaignId: id, name: id, lever: 'bids' as const }])
    expect(nativeAutoRefusal(asks, many)).toMatch(/; and 2 more\./)
  })
})

describe('AB-4 readNativeRulesOnce — the daily read (database and Amazon stubbed)', () => {
  const ctx = { profileId: 'p-it', region: 'EU' as const }
  const listBudgetRules = vi.fn(async (_ctx: unknown, ext: string): Promise<AmazonBudgetRule[] | null> => (ext === 'EXT-B' ? [rule()] : []))
  const contextFor = vi.fn(async (m: string | null) => (m === 'IT' ? ctx : null))
  beforeEach(() => {
    db.enrolled = 0; db.bidRows = []; db.enrollments = []; db.campaigns = []; db.snapshots.clear(); db.calls = []
    listBudgetRules.mockClear(); contextFor.mockClear()
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('no-op: the bid brain not live and no product enrolled — no campaign read, no Amazon call, nothing written', async () => {
    for (const mode of ['shadow', 'off', '']) {
      vi.stubEnv('NEXUS_BID_BRAIN_MODE', mode)
      const s = await readNativeRulesOnce({ now: NOW, listBudgetRules, contextFor, mode: () => 'live' })
      expect(s).toEqual({ ran: false, why: expect.stringMatching(/not live and no product is enrolled/), campaigns: 0, read: 0, couldNotRead: 0, calls: 0, acting: 0, dropped: 0 })
    }
    expect(db.calls).toEqual(['enrollment.count', 'enrollment.count', 'enrollment.count'])
    expect(listBudgetRules).not.toHaveBeenCalled()
    expect(contextFor).not.toHaveBeenCalled()
  })

  it('live: every brain campaign (LIVE rows and the enrolled product\'s own and shared ones) read once through the client, one snapshot each', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    db.bidRows = [{ campaignId: 'c-live' }]
    db.enrollments = [{ productId: 'p-gale', marketplace: 'IT' }]
    db.campaigns = [
      { id: 'c-live', name: 'live', externalCampaignId: 'EXT-A', marketplace: 'IT' },
      { id: 'c-own', name: 'own', externalCampaignId: 'EXT-B', marketplace: 'IT' },
      { id: 'c-shared', name: 'shared', externalCampaignId: null, marketplace: 'IT' },
      { id: 'c-de', name: 'de', externalCampaignId: 'EXT-D', marketplace: 'DE' },
    ]
    // A campaign that left the brain since the last read loses its row.
    db.snapshots.set('c-left', { campaignId: 'c-left', fetchedAt: NOW, readings: { budgetRules: { state: 'read', rules: [] } } })
    const s = await readNativeRulesOnce({ now: NOW, listBudgetRules, contextFor, mode: () => 'live' })
    expect(s).toEqual({ ran: true, why: 'NEXUS_BID_BRAIN_MODE is live', campaigns: 4, read: 2, couldNotRead: 2, calls: 2, acting: 1, dropped: 1 })
    expect(db.snapshots.has('c-left')).toBe(false)
    expect(listBudgetRules.mock.calls.map((c) => [c[0], c[1]])).toEqual([[ctx, 'EXT-A'], [ctx, 'EXT-B']])
    expect(db.snapshots.get('c-own')?.readings).toEqual({ budgetRules: { state: 'read', rules: [rule()] } })
    expect(db.snapshots.get('c-live')?.readings).toEqual({ budgetRules: { state: 'read', rules: [] } })
    expect(db.snapshots.get('c-shared')?.readings).toEqual({ budgetRules: { state: 'could_not_read', why: 'the campaign has no Amazon id in Nexus yet' } })
    expect(db.snapshots.get('c-de')?.readings).toEqual({ budgetRules: { state: 'could_not_read', why: 'no advertising profile serves DE' } })
  })

  it('a product enrolled is enough without the live switch; a failed read keeps what the last good read saw', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    db.enrolled = 1
    db.enrollments = [{ productId: 'p-gale', marketplace: 'IT' }]
    db.campaigns = [{ id: 'c-own', name: 'own', externalCampaignId: 'EXT-B', marketplace: 'IT' }]
    expect(await readNativeRulesOnce({ now: NOW, listBudgetRules, contextFor, mode: () => 'live' })).toMatchObject({ ran: true, why: '1 product is enrolled in the brain', read: 1, acting: 1 })
    const failing = vi.fn(async () => { throw Object.assign(new Error('[ADS-LIVE] GET … → 500: boom'), { statusCode: 500 }) })
    const later = new Date(NOW.getTime() + 86_400_000)
    expect(await readNativeRulesOnce({ now: later, listBudgetRules: failing, contextFor, mode: () => 'live' })).toMatchObject({ read: 0, couldNotRead: 1, calls: 1, acting: 1 })
    expect(db.snapshots.get('c-own')).toMatchObject({
      fetchedAt: later,
      readings: { budgetRules: { state: 'could_not_read', why: expect.stringMatching(/^the read failed: Amazon answered 500/), lastRead: { at: NOW.toISOString(), rules: [rule()] } } },
    })
  })

  it('a spent quota stops the rest of that market (said, not asked); sandbox asks nothing', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    db.bidRows = [{ campaignId: 'a' }, { campaignId: 'b' }, { campaignId: 'c' }]
    db.campaigns = ['a', 'b', 'c'].map((id) => ({ id, name: id, externalCampaignId: `EXT-${id}`, marketplace: 'IT' }))
    const throttled = vi.fn(async () => { throw Object.assign(new Error('quota'), { name: 'AmazonAdsQuotaError' }) })
    expect(await readNativeRulesOnce({ now: NOW, listBudgetRules: throttled, contextFor, mode: () => 'live' })).toMatchObject({ calls: 1, couldNotRead: 3 })
    expect(throttled).toHaveBeenCalledTimes(1)
    expect((db.snapshots.get('c')?.readings as { budgetRules: { why: string } }).budgetRules.why).toMatch(/^not asked: Amazon's request quota was spent/)
    db.snapshots.clear()
    expect(await readNativeRulesOnce({ now: NOW, listBudgetRules, contextFor, mode: () => 'sandbox' })).toMatchObject({ calls: 0, read: 0, couldNotRead: 3 })
    expect(listBudgetRules).not.toHaveBeenCalled()
    expect((db.snapshots.get('a')?.readings as { budgetRules: { why: string } }).budgetRules.why).toMatch(/sandbox mode.*nothing was asked/)
  })
})

describe('AB-4 follow-up — a 429 from Amazon through the real liveCall and gateway, inside the daily read', () => {
  const calls: string[] = []
  beforeEach(() => {
    __rateTest.useMemory()
    calls.length = 0; gatewayLedger.length = 0
    db.enrolled = 0; db.enrollments = []; db.snapshots.clear(); db.calls = []
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
    // Amazon throttles the first IT campaign every time; every other campaign answers "no rule".
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(String(url)).pathname)
      return String(url).includes('/EXT-a/')
        ? new Response('{"code":"THROTTLED"}', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ associatedRules: [] }), { status: 200 })
    }))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

  it('liveCall retries the 429 its own way, then throws; the rest of that market is not asked, another market still is; nothing crashes', async () => {
    db.bidRows = [{ campaignId: 'a' }, { campaignId: 'b' }, { campaignId: 'c' }, { campaignId: 'd' }]
    db.campaigns = [
      { id: 'a', name: 'a', externalCampaignId: 'EXT-a', marketplace: 'IT' },
      { id: 'b', name: 'b', externalCampaignId: 'EXT-b', marketplace: 'IT' },
      { id: 'c', name: 'c', externalCampaignId: 'EXT-c', marketplace: 'IT' },
      { id: 'd', name: 'd', externalCampaignId: 'EXT-d', marketplace: 'DE' },
    ]
    const contextFor = async (m: string | null) => ({ profileId: m === 'DE' ? 'p-de' : 'p-it', region: 'EU' as const })
    const s = await readNativeRulesOnce({ now: NOW, contextFor })
    expect(s).toMatchObject({ ran: true, campaigns: 4, read: 1, couldNotRead: 3, calls: 2 })
    // Three sends for the throttled campaign (liveCall's own 429 policy), one for the other market; each through the gateway.
    expect(calls).toEqual(['/sp/campaigns/EXT-a/budgetRules', '/sp/campaigns/EXT-a/budgetRules', '/sp/campaigns/EXT-a/budgetRules', '/sp/campaigns/EXT-d/budgetRules'])
    expect(gatewayLedger.map((r) => [r.channel, r.statusCode])).toEqual([['AMAZON_ADS', 429], ['AMAZON_ADS', 429], ['AMAZON_ADS', 429], ['AMAZON_ADS', 200]])
    const why = (id: string) => (db.snapshots.get(id)?.readings as { budgetRules: { state: string; why?: string } }).budgetRules
    expect(why('a')).toEqual({ state: 'could_not_read', why: expect.stringMatching(/^the read failed: Amazon answered 429/) })
    for (const id of ['b', 'c']) expect(why(id)).toEqual({ state: 'could_not_read', why: expect.stringMatching(/^not asked: Amazon's request quota was spent earlier in this read \(Amazon answered 429/) })
    expect(why('d')).toEqual({ state: 'read', rules: [] })
  })
})
