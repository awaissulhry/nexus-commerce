/**
 * Meta ads step 8 — meta-recommendations, meta-experiments and meta-ad-rules. Each reads ONLY the business's chosen ad
 * account and what is its own: the portfolio is asked about the chosen account only (another account's row is dropped);
 * a study only when Meta's list of studies that touch the account names it, an objective only when it is that study's, a
 * rule only when its account_id is the chosen account, a Page video test only when the chosen Page lists it; another
 * business's ad account is its id only; people are ids only. Every call they make passes the real gateway (GET, query
 * keys on its allow-list). Money only under the tools' restricted keys. Meta and the database are stubbed; made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  bodies: new Map<string, unknown>(),
  fail: null as null | ((req: Req) => Error | null),
  known: new Map<string, string>(),
  taken: [] as Array<{ id: string }>,
}))
const answerOf = (req: Req): unknown => {
  const body = h.bodies.get(req.path)
  return typeof body === 'function' ? (body as (r: Req) => unknown)(req) : body ?? {}
}
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const refusal = h.fail?.(req)
    if (refusal) throw refusal
    return { body: answerOf(req), calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const refusal = h.fail?.(req)
    if (refusal) throw refusal
    const rows = ((answerOf(req) as { data?: Record<string, unknown>[] }).data ?? [])
    onRows(rows)
    return { rows: rows.length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../../db.js', () => {
  const first = (pairs: Array<[string, string]>) => vi.fn(async ({ where }: { where: Record<string, string> }) =>
    (pairs.some(([key, kind]) => where[key] && h.known.get(where[key]) === kind) ? { id: 'x' } : null))
  const many = (key: string, kind: string) => vi.fn(async ({ where }: { where: Record<string, { in: string[] }> }) =>
    [...h.known.entries()].filter(([id, k]) => k === kind && where[key].in.includes(id)).map(([id]) => ({ [key]: id, name: `Shop A ${kind} ${id.slice(-3)}` })))
  return {
    default: {
      metaAdsCampaign: { findFirst: first([['campaignId', 'campaign']]), findMany: many('campaignId', 'campaign') },
      metaAdsAdSet: { findFirst: first([['adSetId', 'adset']]), findMany: many('adSetId', 'adset') },
      metaAdsAd: { findFirst: first([['adId', 'ad'], ['creativeId', 'creative']]), findMany: many('adId', 'ad') },
      $queryRaw: vi.fn(async () => h.taken),
    },
  }
})

import { EXPERIMENT_MONEY, META_ADS_OPTIMIZE_TOOLS, RECOMMENDATION_MONEY, RULE_MONEY } from './meta-ads-optimize.tools.js'
import { MetaReadError, type MetaFailure } from '../../marketing/meta-ads/errors.js'
import { accountToday, accountYesterday, addDays } from '../../marketing/meta-ads/dates.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_OPTIMIZE_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const data = async (name: string, args: Record<string, unknown>) => {
  const res = await run(name, args)
  expect(res, JSON.stringify(res)).toMatchObject({ ok: true })
  return res.data as Record<string, any>
}
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: '9000000000001', name: null },
  adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: '120000000000010' }, instagram: null, read: {},
}
const metaRefusal = (code: string, sentence = `Meta refused the read: (#${code}) nope`, more: Partial<MetaFailure> = {}) =>
  new MetaReadError({ origin: 'meta', httpStatus: 400, code, authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence, ...more }, 'x', 1)
/** Every call made passes the real gateway (a GET of Meta, its query keys on the allow-list for that path). */
const gatewayProblems = () => h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, p]) => p)
/** Every key in an answer that is money (…Cents, …AsMeta) is one of the tool's restricted keys. */
const moneyKeys = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => moneyKeys(v, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (/Cents$|AsMeta$/.test(k)) out.add(k); moneyKeys(v, out) }
  return out
}

const NOW = Date.now()
const iso = (days: number) => new Date(NOW + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+0000')
const STUDY_RUNNING = { id: '6100000000001', name: 'Shop A audience test', type: 'SPLIT_TEST', start_time: iso(-5), end_time: iso(5), created_by: { id: '9000000000001' } }
const STUDY_DONE = { id: '6100000000002', name: 'Shop A lift', type: 'LIFT', start_time: iso(-60), end_time: iso(-30), observation_end_time: iso(-20) }

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.bodies = new Map(); h.fail = null; h.known = new Map(); h.taken = []
})

describe('three read tools', () => {
  it('read only, reach Meta, need ads.view, and name their money keys', () => {
    expect(META_ADS_OPTIMIZE_TOOLS.map((t) => [t.name, t.readOnly, !!t.openWorld, t.execute, t.requires])).toEqual([
      ['meta-recommendations', true, true, undefined, ['ads.view']], ['meta-experiments', true, true, undefined, ['ads.view']], ['meta-ad-rules', true, true, undefined, ['ads.view']],
    ])
    expect(tool('meta-recommendations').restrictedFields).toEqual(RECOMMENDATION_MONEY)
    expect(tool('meta-experiments').restrictedFields).toEqual(EXPERIMENT_MONEY)
    expect(tool('meta-ad-rules').restrictedFields).toEqual(RULE_MONEY)
  })
  it('a business without Meta, or without a chosen ad account, is told who sets it up — before any call', async () => {
    h.connections = []
    for (const name of ['meta-recommendations', 'meta-experiments', 'meta-ad-rules']) expect((await run(name, {})).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect((await run('meta-experiments', {})).error).toMatch(/No Meta ad account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('meta-recommendations', () => {
  const RECS = { data: [{ recommendations: [
    { recommendation_signature: '1234567', recommendation_stage: 'mid_flight_recommendation', recommendation_time: '2026-10-20T08:00:00+0000', type: 'SCALE_GOOD_CAMPAIGN', object_ids: ['120000000000201'], recommendation_content: { lift_estimate: 'Up to 8% more purchases', body: 'Two ad sets deliver well', opportunity_score_lift: '6' }, url: 'https://adsmanager.facebook.com/adsmanager/x' },
    { recommendation_stage: 'mid_flight_recommendation', type: 'BUDGET_LIMITED', object_ids: ['120000000000101', '120000000000999'], lift_estimate: 'More results', opportunity_score_lift: 4 },
  ] }] }
  it('overview: the score now with each recommendation and how to act on it (like Meta\'s ads_get_opportunity_score)', async () => {
    h.known = new Map([['120000000000201', 'adset'], ['120000000000101', 'campaign']])
    h.bodies.set('act_1234567890', { opportunity_score: 71.5 })
    h.bodies.set('act_1234567890/recommendations', RECS)
    const out = await data('meta-recommendations', {})
    expect(out).toMatchObject({ opportunityScore: 71.5, totalScoreLift: 10, scoreNotRead: null, itemsNotRead: null })
    expect(out.items[0]).toMatchObject({
      type: 'SCALE_GOOD_CAMPAIGN', signature: '1234567', liftEstimate: 'Up to 8% more purchases', opportunityScoreLift: 6, stageText: 'for campaigns, ad sets or ads that run now',
      objects: [{ id: '120000000000201', kind: 'adset', name: 'Shop A adset 201' }], howToAct: { byApi: true, tool: 'apply-meta-recommendations', spendsMoney: 'yes' },
    })
    expect(out.items[1]).toMatchObject({ type: 'BUDGET_LIMITED', signature: null, objects: [{ id: '120000000000101', kind: 'campaign' }, { id: '120000000000999', kind: null, name: null }], howToAct: { byApi: false, nexusTools: ['set-meta-ad-set', 'set-meta-campaign'] } })
    expect(out.note).toMatch(/cannot be dismissed by API/)
    expect(h.calls.map((c) => [c.path, c.query])).toEqual([['act_1234567890', { fields: 'opportunity_score' }], ['act_1234567890/recommendations', {}]])
    expect(gatewayProblems()).toEqual([])
  })
  it('overview still answers when one half fails; list sends the account\'s own spelling of the stage and the names', async () => {
    h.fail = (req) => (req.path === 'act_1234567890' ? metaRefusal('100', 'Meta refused the read: no score') : null)
    h.bodies.set('act_1234567890/recommendations', RECS)
    expect(await data('meta-recommendations', { view: 'overview' })).toMatchObject({ opportunityScore: null, scoreNotRead: 'Meta refused the read: no score' })
    h.calls.length = 0
    await data('meta-recommendations', { view: 'list', stage: 'MID_FLIGHT', names: ['Fragmentation', 'scale_good_campaign'] })
    expect(h.calls[0].query).toEqual({ recommendation_stages: ['mfr'], recommendation_names: ['fragmentation', 'scale_good_campaign'] })
    expect(gatewayProblems()).toEqual([])
  })
  it('portfolio: asked about the chosen account only; a row of another account is dropped, never shown', async () => {
    h.bodies.set('9876543210/recommendations', { data: [
      { ad_account_id: '1234567890', opportunity_score: 78, recommendations: [{ recommendation_name: 'reels_pc_recommendation', level: 'ad_set', object_ids: ['120000000000201'], recommendation_signature: '7720466', recommendation_content: { lift_estimate: 'Up to 8% lower cost', body: 'Use 9:16 video' } }] },
      { ad_account_id: '5555555555', opportunity_score: 12, recommendations: [{ recommendation_name: 'other_business_secret' }] },
    ] })
    const out = await data('meta-recommendations', { view: 'portfolio', stage: 'pre_create', locale: 'it_IT' })
    expect(h.calls[0]).toMatchObject({ path: '9876543210/recommendations', query: { ad_account_ids: '1234567890', fields: 'recommendation_content', recommendation_stages: ['pre_create_guidance'], locale: 'it_IT' } })
    expect(out).toMatchObject({ businessId: '9876543210', opportunityScore: 78, otherAccountsLeftOut: 1, items: [{ name: 'reels_pc_recommendation', level: 'ad_set', body: 'Use 9:16 video' }] })
    expect(JSON.stringify(out)).not.toMatch(/5555555555|other_business_secret/)
    expect(gatewayProblems()).toEqual([])
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    h.calls.length = 0
    expect((await run('meta-recommendations', { view: 'portfolio' })).error).toMatch(/no business portfolio/)
    expect(h.calls).toHaveLength(0)
  })
  it('history: up to yesterday, at most 45 days, with what moved the score; budgets in minor units', async () => {
    h.bodies.set('act_1234567890/opportunity_score_history', { data: [{ date: '2026-10-18', opportunity_score: '90', changelog: [{ campaign_id: '120000000000101', score_change: '+34', campaign_details: [{ ad_object_id: '120000000000201', ad_object_type: 'ad_set', budget_then: '5000', budget_now: '6000', eligible_recommendation_types_then: ['advantage_plus_audience'], applied_recommendation_types_now: ['advantage_plus_audience'] }] }] }] })
    const out = await data('meta-recommendations', { view: 'history' })
    const to = accountYesterday('Europe/Rome')
    expect(h.calls[0]).toEqual({ operation: 'recommendations.history', path: 'act_1234567890/opportunity_score_history', query: { from_date: addDays(to, -14), to_date: to, get_reason: true } })
    expect(out.days).toEqual([{ date: '2026-10-18', opportunityScore: 90, changes: [{ campaignId: '120000000000101', scoreChange: 34, objects: [{ objectId: '120000000000201', objectType: 'ad_set', budgetThenCents: 5000, budgetNowCents: 6000, eligibleThen: ['advantage_plus_audience'], eligibleNow: [], appliedThen: [], appliedNow: ['advantage_plus_audience'] }] }] }])
    expect([...moneyKeys(out)].every((k) => k in RECOMMENDATION_MONEY)).toBe(true)
    expect(gatewayProblems()).toEqual([])
    h.calls.length = 0
    const today = accountToday('Europe/Rome')
    expect((await run('meta-recommendations', { view: 'history', to: today })).error).toMatch(/before today/)
    expect((await run('meta-recommendations', { view: 'history', from: addDays(to, -46), to })).error).toMatch(/at most 45 days/)
    expect((await run('meta-recommendations', { view: 'history', from: to, to: addDays(to, -1) })).error).toMatch(/from is after to/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('meta-experiments', () => {
  it('list: the studies that touch the chosen account, with their state in words; Nexus filters kind, state and name', async () => {
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [STUDY_RUNNING, STUDY_DONE] })
    const out = await data('meta-experiments', { view: 'list', state: 'running' })
    expect(out).toMatchObject({ matching: 1, read: 2, running: 1, items: [{ studyId: '6100000000001', type: 'SPLIT_TEST', typeText: 'A/B test (split test)', state: 'running', createdBy: { id: '9000000000001', isThisSystemUser: true } }] })
    expect(h.calls[0].query?.fields).toMatch(/^id,name,description,type,start_time,end_time/)
    expect((await data('meta-experiments', { view: 'list', type: 'lift' })).items.map((s: any) => [s.studyId, s.state])).toEqual([['6100000000002', 'finished']])
    expect((await data('meta-experiments', { view: 'list', nameContains: 'AUDIENCE' })).matching).toBe(1)
    expect(gatewayProblems()).toEqual([])
  })
  it('portfolio: a study that does not touch the chosen account is its id only', async () => {
    h.bodies.set('9876543210/ad_studies', { data: [STUDY_RUNNING, { id: '6100000000099', name: 'Another business test', type: 'LIFT' }] })
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [{ id: '6100000000001' }] })
    const out = await data('meta-experiments', { view: 'portfolio' })
    expect(out.items).toEqual([expect.objectContaining({ studyId: '6100000000001', touchesThisAdAccount: true }), { studyId: '6100000000099', touchesThisAdAccount: false }])
    expect(JSON.stringify(out)).not.toMatch(/Another business/)
    expect(gatewayProblems()).toEqual([])
  })
  it('study: details, groups (SDK fields dropped when Meta refuses them), goals and results; another business\'s account is its id only', async () => {
    h.taken = [{ id: '1111111111' }]
    h.known = new Map([['120000000000201', 'adset']])
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [{ id: '6100000000001', type: 'SPLIT_TEST', start_time: STUDY_RUNNING.start_time }] })
    h.bodies.set('6100000000001', STUDY_RUNNING)
    h.bodies.set('6100000000001/cells', { data: [{ id: '6200000000001', name: 'Group A', treatment_percentage: 50, adaccounts: { data: [{ id: 'act_1234567890' }, { id: 'act_1111111111' }] }, adsets: { data: [{ id: '120000000000201' }] } }] })
    h.bodies.set('6100000000001/objectives', { data: [{ id: '6300000000001', name: 'Purchases', type: 'CONVERSIONS', is_primary: true }] })
    h.bodies.set('6300000000001', { id: '6300000000001', name: 'Purchases', results: [JSON.stringify({ cell_id: '6200000000001', conversions_incremental: 12.5, spend: 260 })] })
    h.fail = (req) => (req.path === '6100000000001/cells' && String(req.query?.fields).includes('ad_ids') ? metaRefusal('100', 'Meta refused the read: (#100) nonexisting field (ad_ids)') : null)
    const out = await data('meta-experiments', { view: 'study', studyId: '6100000000001' })
    expect(out.study).toMatchObject({ studyId: '6100000000001', state: 'running' })
    expect(out.cells).toEqual([{
      cellId: '6200000000001', name: 'Group A', treatmentPercentage: 50, controlPercentage: null, adEntitiesCount: null,
      adAccounts: [{ adAccountId: '1234567890', chosenHere: true, takenByAnotherBusiness: false }, { adAccountId: '1111111111', takenByAnotherBusiness: true }],
      campaigns: [], adSets: [{ adSetId: '120000000000201', name: 'Shop A adset 201', inNexus: true }], ads: [],
    }])
    expect(out.cellsNote).toMatch(/ad_ids/)
    expect(out.objectives).toEqual([{ objectiveId: '6300000000001', name: 'Purchases', type: 'CONVERSIONS', isPrimary: true, lastUpdatedResults: null }])
    expect(out.results[0]).toMatchObject({ objectiveId: '6300000000001', breakdowns: ['cell_id'], results: [{ cellId: '6200000000001', numbers: { conversions_incremental: 12.5 }, costAsMeta: { spend: 260 } }] })
    expect(h.calls.find((c) => c.path === '6300000000001')?.query).toEqual({ fields: 'id,name,type,is_primary,last_updated_results,results', breakdowns: ['cell_id'] })
    expect([...moneyKeys(out)].every((k) => k in EXPERIMENT_MONEY)).toBe(true)
    expect(gatewayProblems()).toEqual([])
  })
  it('a study Meta does not list for the chosen account is never read; an objective of another study neither', async () => {
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [{ id: '6100000000001' }] })
    expect((await run('meta-experiments', { view: 'study', studyId: '6100000000099' })).error).toMatch(/does not touch the ad account this business chose/)
    expect(h.calls.map((c) => c.path)).toEqual(['act_1234567890/impacting_ad_studies'])
    h.bodies.set('6100000000001/objectives', { data: [{ id: '6300000000001' }] })
    expect((await run('meta-experiments', { view: 'results', studyId: '6100000000001', objectiveId: '6300000000099' })).error).toMatch(/not one of this study's/)
    expect(h.calls.some((c) => c.path === '6300000000099')).toBe(false)
    h.calls.length = 0
    expect((await run('meta-experiments', { view: 'results', studyId: '6100000000001', breakdowns: ['country'] })).error).toMatch(/only together with cell_id/)
    expect(h.calls).toHaveLength(0)
  })
  it('results: Meta\'s breakdowns, a creative test\'s high performers; a refusal for the lift grant is passed on in Meta\'s words', async () => {
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [{ id: '6100000000003', type: 'SPLIT_TEST_V2', start_time: iso(-3) }] })
    h.bodies.set('6100000000003/objectives', { data: [{ id: '6300000000003' }] })
    h.bodies.set('6300000000003', { id: '6300000000003', results: [{ high_performer_ids: ['120000000000301'], confidence_by_ad_object_id: { 120000000000301: 0.9 }, winner_ad_object_id: null }] })
    const out = await data('meta-experiments', { view: 'results', studyId: '6100000000003', breakdowns: ['cell_id', 'age'] })
    expect(out.objectives[0]).toMatchObject({ breakdowns: ['cell_id', 'age'], results: [{ creativeTest: { highPerformerAdIds: ['120000000000301'] } }] })
    expect(out.note).toMatch(/no "buyers" metrics/)
    expect(gatewayProblems()).toEqual([])
    h.fail = (req) => (req.path === '6300000000003' ? metaRefusal('270', 'Meta does not let this system user read this: (#270) development access level', { permissionDenied: true }) : null)
    expect((await run('meta-experiments', { view: 'results', studyId: '6100000000003' })).error).toMatch(/#270/)
  })
  it('object: is a campaign, ad set or ad in a test (read before changing it); never an object of another account', async () => {
    h.known = new Map([['120000000000201', 'adset']])
    h.bodies.set('120000000000201/ad_studies', { data: [STUDY_RUNNING] })
    const out = await data('meta-experiments', { view: 'object', objectKind: 'adset', objectId: '120000000000201' })
    expect(out).toMatchObject({ inATestNow: true, sentence: expect.stringMatching(/can spoil the test/) })
    h.bodies.set('120000000000302', { account_id: '5555555555' })
    expect((await run('meta-experiments', { view: 'object', objectKind: 'ad', objectId: '120000000000302' })).error).toMatch(/does not belong to the ad account/)
    expect(h.calls.some((c) => c.path === '120000000000302/ad_studies')).toBe(false)
    expect(gatewayProblems()).toEqual([])
  })
  it('sharing: people as ids only; ad accounts another business uses as id only', async () => {
    h.taken = [{ id: '1111111111' }]
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [{ id: '6100000000001' }] })
    h.bodies.set('6100000000001/viewers', { data: [{ id: '9000000000002', name: 'A Person' }] })
    h.bodies.set('6100000000001/related_ad_accounts', { data: [{ account_id: '1234567890', name: 'Shop A ads' }, { account_id: '1111111111', name: 'Other business ads' }] })
    const out = await data('meta-experiments', { view: 'sharing', studyId: '6100000000001' })
    expect(out.viewers).toEqual([{ id: '9000000000002', isThisSystemUser: false }])
    expect(out.adAccounts).toEqual([{ adAccountId: '1234567890', name: 'Shop A ads', chosenHere: true, takenByAnotherBusiness: false }, { adAccountId: '1111111111', takenByAnotherBusiness: true }])
    expect(JSON.stringify(out)).not.toMatch(/A Person|Other business/)
    expect(h.calls.find((c) => c.path === '6100000000001/viewers')?.query?.fields).toBe('id')
    expect(gatewayProblems()).toEqual([])
  })
  it('brand-lift and private-lift: each part answers on its own; a refusal is Meta\'s sentence', async () => {
    h.known = new Map([['120000000000101', 'campaign']])
    h.bodies.set('act_1234567890', { can_create_brand_lift_study: false })
    h.bodies.set('120000000000101', { can_create_brand_lift_study: true, brand_lift_studies: { data: [STUDY_DONE] } })
    const lift = await data('meta-experiments', { view: 'brand-lift', campaignId: '120000000000101' })
    expect(lift).toMatchObject({ canCreateBrandLiftStudy: false, campaign: { campaignId: '120000000000101', canCreateBrandLiftStudy: true, studies: [{ studyId: '6100000000002', state: 'finished' }] } })
    h.bodies.set('act_1234567890/impacting_ad_studies', { data: [{ id: '6100000000002' }] })
    h.fail = (req) => (req.path === '6100000000002/instances' ? metaRefusal('100', 'Meta refused the read: not a private lift study') : null)
    h.bodies.set('6100000000002/continuous_lift_config', { data: [] })
    const priv = await data('meta-experiments', { view: 'private-lift', studyId: '6100000000002' })
    expect(priv).toMatchObject({ privateLiftInstances: null, instancesNotRead: 'Meta refused the read: not a private lift study', continuousLiftConfigs: [] })
    expect(gatewayProblems()).toEqual([])
  })
  it('page video tests: only the chosen Page; one test only when that Page lists it; the guide\'s fields after a refusal; earnings apart', async () => {
    h.bodies.set('120000000000010/ab_tests', (req: Req) => ({ data: [{ id: '7100000000001', name: 'Hook test', optimization_goal: 'REELS_PLAYS', experiment_video_ids: ['7200000000001', '7200000000002'], publish_status: 'LIVE', creation_time: '1760000000' }].map((r) => (String(req.query?.fields) === 'id' ? { id: r.id } : r)) }))
    const list = await data('meta-experiments', { view: 'page-video-tests', since: '2026-10-01', until: '2026-10-20' })
    expect(h.calls[0].query).toMatchObject({ since: Date.parse('2026-10-01T00:00:00Z') / 1000, until: Date.parse('2026-10-20T00:00:00Z') / 1000 })
    expect(list.items[0]).toMatchObject({ testId: '7100000000001', videoIds: ['7200000000001', '7200000000002'], createdTime: '2025-10-09T08:53:20.000Z' })
    expect((await run('meta-experiments', { view: 'page-video-test', testId: '7100000000099' })).error).toMatch(/not one of the chosen Page's video tests/)
    h.fail = (req) => (req.path === '7100000000001' && String(req.query?.fields).includes('insight_snapshots') ? metaRefusal('100', 'Meta refused the read: (#100) nonexisting field (insight_snapshots)') : null)
    h.bodies.set('7100000000001', { id: '7100000000001', declared_winning_video: '7200000000001', test_insights: { timestamp: '1760000000', videos: { 7200000000001: { plays: 10, instream_ads_earnings: 3 } } } })
    const one = await data('meta-experiments', { view: 'page-video-test', testId: '7100000000001' })
    expect(one.test).toMatchObject({ declaredWinnerVideoId: '7200000000001', videos: [{ videoId: '7200000000001', plays: 10, earningsAsMeta: 3 }] })
    expect(JSON.stringify(one)).not.toMatch(/instream_ads_earnings/)
    expect(h.calls.filter((c) => c.path === '7100000000001').map((c) => c.query?.fields)).toEqual([expect.stringContaining('insight_snapshots'), expect.stringContaining('test_insights')])
    expect([...moneyKeys(one)].every((k) => k in EXPERIMENT_MONEY)).toBe(true)
    expect(gatewayProblems()).toEqual([])
    h.connections = [{ ...CHOSEN, page: null }]
    h.calls.length = 0
    expect((await run('meta-experiments', { view: 'page-video-tests' })).error).toMatch(/No Facebook Page is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('meta-ad-rules', () => {
  const RULE = {
    id: '23850000000000001', account_id: '1234567890', name: 'Pause costly ads', status: 'ENABLED',
    evaluation_spec: { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL' }, { field: 'cpa', value: 2500, operator: 'GREATER_THAN' }] },
    execution_spec: { execution_type: 'PAUSE' }, schedule_spec: { schedule_type: 'DAILY' },
  }
  const TRIGGER = { id: '23850000000000002', account_id: '1234567890', name: 'Watch spend', status: 'HAS_ISSUES', disable_error_code: 1815, evaluation_spec: { evaluation_type: 'TRIGGER', trigger: { type: 'STATS_CHANGE', field: 'spent', value: 10000, operator: 'GREATER_THAN' }, filters: [] }, execution_spec: { execution_type: 'NOTIFICATION' } }
  it('list: trigger rules too (Ads Manager never shows them), the ones Meta stopped, money in minor units', async () => {
    h.bodies.set('act_1234567890/adrules_library', { data: [RULE, TRIGGER] })
    const out = await data('meta-ad-rules', {})
    expect(out.counts).toEqual({ all: 2, on: 1, withIssues: 1, triggerRules: 1, canRaiseSpend: 0 })
    expect(out.items[0]).toMatchObject({ ruleId: '23850000000000001', action: { type: 'PAUSE', text: 'pauses the matching objects' }, filters: [{ field: 'entity_type' }, { field: 'time_preset' }, { field: 'cpa', valueCents: 2500 }] })
    expect(out.items[1]).toMatchObject({ visibleInAdsManager: false, hasIssues: true, trigger: { field: 'spent', valueCents: 10000 } })
    expect(h.calls[0].query?.fields).toBe('id,account_id,name,status,evaluation_spec,execution_spec,schedule_spec,created_by{id},created_time,updated_time,disable_error_code')
    expect((await data('meta-ad-rules', { status: 'has_issues' })).items.map((r: any) => r.ruleId)).toEqual(['23850000000000002'])
    expect((await data('meta-ad-rules', { evaluationType: 'schedule' })).items.map((r: any) => r.ruleId)).toEqual(['23850000000000001'])
    expect([...moneyKeys(out)].every((k) => k in RULE_MONEY)).toBe(true)
    expect(gatewayProblems()).toEqual([])
  })
  it('rule and history: only a rule whose account_id is the chosen account; Meta\'s "not found" is a refusal in words', async () => {
    h.bodies.set('23850000000000001', RULE)
    expect((await data('meta-ad-rules', { view: 'rule', ruleId: '23850000000000001' })).rule).toMatchObject({ name: 'Pause costly ads', schedule: { type: 'DAILY' } })
    h.bodies.set('23850000000000003', { id: '23850000000000003', account_id: '5555555555', name: 'Other business rule' })
    const other = await run('meta-ad-rules', { view: 'rule', ruleId: '23850000000000003' })
    expect(other.error).toMatch(/belongs to another ad account/)
    expect(JSON.stringify(other)).not.toMatch(/Other business rule/)
    h.calls.length = 0
    expect((await run('meta-ad-rules', { view: 'history', ruleId: '23850000000000003' })).error).toMatch(/belongs to another ad account/)
    expect(h.calls.map((c) => c.path)).toEqual(['23850000000000003'])
    h.fail = (req) => (req.path === '23850000000000004' ? metaRefusal('100/33', 'Meta says this does not exist', { notFound: true }) : null)
    expect((await run('meta-ad-rules', { view: 'rule', ruleId: '23850000000000004' })).error).toMatch(/not a rule of the ad account/)
  })
  it('history: the rule\'s runs with Meta\'s filters; old and new budgets in minor units; account-history carries the rule id', async () => {
    h.bodies.set('23850000000000001', { account_id: '1234567890' })
    h.bodies.set('23850000000000001/history', { data: [{ timestamp: '2026-10-20T00:30:00+0000', is_manual: false, evaluation_spec: { evaluation_type: 'SCHEDULE' }, execution_spec: { execution_type: 'CHANGE_BUDGET' }, results: [{ object_id: '120000000000201', object_type: 'ADSET', actions: [{ action: 'CHANGED_BUDGET', field: 'daily_budget', old_value: '5000', new_value: '6000' }] }] }] })
    const out = await data('meta-ad-rules', { view: 'history', ruleId: '23850000000000001', objectId: '120000000000201', action: 'changed_budget', hideNoChanges: true })
    expect(h.calls.map((c) => c.path)).toEqual(['23850000000000001', '23850000000000001/history'])
    expect(h.calls[0].query).toEqual({ fields: 'id,account_id,evaluation_spec' })
    expect(h.calls[1].query).toMatchObject({ object_id: '120000000000201', action: 'CHANGED_BUDGET', hide_no_changes: true })
    expect(out.runs).toEqual([{ time: '2026-10-20T00:30:00.000Z', manual: false, error: null, ruleAtRun: { evaluationType: 'SCHEDULE', action: 'CHANGE_BUDGET' }, changedSomething: true, results: [{ objectId: '120000000000201', objectType: 'ADSET', actions: [{ action: 'CHANGED_BUDGET', actionText: 'changed the budget', field: 'daily_budget', oldValueCents: 5000, newValueCents: 6000 }] }] }])
    h.bodies.set('act_1234567890/adrules_history', { data: [
      { rule_id: '23850000000000002', timestamp: '2026-10-20T01:00:00+0000', evaluation_spec: { evaluation_type: 'TRIGGER' }, results: [] },
      { rule_id: 23850000000000001, evaluation_spec: { evaluation_type: 'TRIGGER' }, results: [] },
      { rule_id: 23850000000000003, evaluation_spec: { evaluation_type: 'SCHEDULE' }, results: [] },
    ] })
    const all = await data('meta-ad-rules', { view: 'account-history', evaluationType: 'TRIGGER' })
    // A rule id Meta sends as a JSON number past 2^53 is not guessed.
    expect(all.runs.map((r: any) => [r.ruleId, !!r.ruleIdNote])).toEqual([['23850000000000002', false], [null, true]])
    expect(h.calls.at(-1)?.query?.fields).toMatch(/,rule_id$/)
    expect([...moneyKeys(out)].every((k) => k in RULE_MONEY)).toBe(true)
    expect(gatewayProblems()).toEqual([])
  })
  it('preview: Meta\'s preview is a POST with no read form — it comes with set-meta-ad-rule, and no call is made', async () => {
    const out = await data('meta-ad-rules', { view: 'preview', ruleId: '23850000000000001' })
    expect(out.sentence).toMatch(/POST request/)
    expect(out.sentence).toMatch(/set-meta-ad-rule \(step 29\)/)
    expect(h.calls).toHaveLength(0)
  })
})
