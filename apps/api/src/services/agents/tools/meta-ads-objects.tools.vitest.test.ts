/**
 * Meta ads step 6 — meta-campaigns, meta-ad-sets, meta-ad-details, meta-labels, meta-value-rules. Every view asks Meta
 * only with fixed field lists and only what the real gateway lets through; every id a caller names is the chosen ad
 * account's own (Nexus's rows, else one live account_id read; labels, value rule sets, budget periods and creative jobs
 * are found in the account's own list first); a Page or Instagram account another business uses is its id and a flag
 * only; a field Meta refuses costs only its own part of the answer; money is in minor units under money keys. Meta and the
 * database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  known: new Map<string, string>(),
  owners: new Map<string, string>(),
  ownerAnswer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    // The live ownership check (live.ts objectInAccount): the object's account_id and a value for each kind field asked.
    if (req.operation === 'graph.ownerCheck') {
      const out = h.ownerAnswer?.(req)
      if (out instanceof Error) throw out
      if (out) return { body: out, calls: 1 }
      return { body: Object.fromEntries(String(req.query?.fields ?? '').split(',').map((f) => [f, f === 'account_id' ? h.owners.get(req.path) ?? '5550001112' : 'x'])), calls: 1 }
    }
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return { body: out ?? { data: [] }, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => { throw new Error('step 6 reads page by page with metaReadOne') }),
}))
vi.mock('../../../db.js', () => {
  const found = (pairs: Array<[string, string]>) => vi.fn(async ({ where }: { where: Record<string, string> }) =>
    (pairs.some(([key, kind]) => where[key] && h.known.get(where[key]) === kind) ? { id: 'x' } : null))
  return {
    default: {
      metaAdsCampaign: { findFirst: found([['campaignId', 'campaign']]) },
      metaAdsAdSet: { findFirst: found([['adSetId', 'adset']]) },
      metaAdsAd: { findFirst: found([['adId', 'ad'], ['creativeId', 'creative']]) },
      // nexus_meta_links_taken(product, ids): the ids of that product another business picked.
      $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
    },
  }
})

import { META_ADS_OBJECTS_TOOLS, META_OBJECTS_MONEY } from './meta-ads-objects.tools.js'
import { META_ADS_READ_TOOLS } from './meta-ads-read.tools.js'
import { roasFloorOf } from '../../marketing/meta-ads/live-objects.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_OBJECTS_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const refusedByMeta = (words: string, code = '100') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: code, channelMessage: words } as never }), 'x', 1)
const fieldsOf = (req: Req) => String(req.query?.fields ?? '')

const CAMPAIGN = '120000000000101'
const ADSET = '120000000000201'
const AD = '120000000000301'
const CREATIVE = '120000000000401'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok',
  adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: '120000000000010' }, instagram: { instagramId: '170000000000001' }, read: {},
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = null; h.taken = []; h.owners = new Map(); h.ownerAnswer = null
  h.known = new Map([[CAMPAIGN, 'campaign'], [ADSET, 'adset'], [AD, 'ad'], [CREATIVE, 'creative']])
})

describe('the five tools are reads of Meta', () => {
  it('read only, open world, ads.view; the money keys are restricted where money is answered', () => {
    expect(META_ADS_OBJECTS_TOOLS.map((t) => t.name)).toEqual(['meta-campaigns', 'meta-ad-sets', 'meta-ad-details', 'meta-labels', 'meta-value-rules'])
    for (const t of META_ADS_OBJECTS_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, openWorld: t.openWorld, execute: t.execute, requires: t.requires }).toEqual({ name: t.name, readOnly: true, openWorld: true, execute: undefined, requires: ['ads.view'] })
    }
    for (const name of ['meta-campaigns', 'meta-ad-sets', 'meta-ad-details']) {
      expect(tool(name).restrictedFields).toMatchObject({ dailyBudgetCents: 'financials.adspend.view', bidInfoCents: 'financials.adspend.view', budgetValue: 'financials.adspend.view', maxBid: 'financials.adspend.view', auctionBid: 'financials.adspend.view', metaRaw: 'financials.adspend.view', spendMeta: 'financials.adspend.view' })
    }
  })
})

describe('every view asks only what the real gateway lets through (its query-key allow-list and fields rules)', () => {
  it('all views, with made-up answers', async () => {
    h.answer = (req) => {
      if (req.path.endsWith('/adlabels')) return { data: [{ id: '120000000000601', name: 'Label A' }] }
      if (req.path.endsWith('/value_rule_set')) return { data: [{ id: '120000000000801', name: 'Rules A' }] }
      if (req.path.endsWith('/budget_schedules')) return { data: [{ id: '120000000000901' }] }
      if (req.path.endsWith('/asyncadcreatives')) return { data: [{ id: '120000000000951' }] }
      if (req.path === ADSET && fieldsOf(req) === 'promoted_object') return { promoted_object: { product_catalog_id: '120000000000700' } }
      if (req.path === '120000000000700') return { business: { id: '9876543210' } }
      return { data: [] }
    }
    const day = { from: '2026-10-01', to: '2026-10-19' }
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-campaigns', { view: 'list', statuses: ['ACTIVE', 'ARCHIVED'], completed: true }], ['meta-campaigns', { view: 'campaign', campaignId: CAMPAIGN }],
      ['meta-campaigns', { view: 'copies', campaignId: CAMPAIGN, statuses: ['PAUSED'], completed: false }], ['meta-campaigns', { view: 'studies', campaignId: CAMPAIGN }],
      ['meta-campaigns', { view: 'rules', campaignId: CAMPAIGN, passEvaluation: true }], ['meta-campaigns', { view: 'budget-schedules', campaignId: CAMPAIGN, ...day }],
      ['meta-campaigns', { view: 'budget-schedules', adSetId: ADSET }], ['meta-campaigns', { view: 'budget-schedule', campaignId: CAMPAIGN, periodId: '120000000000901' }],
      ['meta-ad-sets', { view: 'list', changedSince: '2026-10-01', completed: true }], ['meta-ad-sets', { view: 'list', campaignId: CAMPAIGN }], ['meta-ad-sets', { view: 'adset', adSetId: ADSET }],
      ['meta-ad-sets', { view: 'copies', adSetId: ADSET }], ['meta-ad-sets', { view: 'studies', adSetId: ADSET }], ['meta-ad-sets', { view: 'rules', adSetId: ADSET }],
      ['meta-ad-sets', { view: 'drafts', adSetId: ADSET }], ['meta-ad-sets', { view: 'async-requests', adSetId: ADSET, requestStatuses: ['error'] }],
      ['meta-ad-sets', { view: 'delivery-stats', adSetId: ADSET, bidRecommendation: true }], ['meta-ad-sets', { view: 'targeting-insights', adSetId: ADSET }],
      ['meta-ad-sets', { view: 'actionable-insights', adSetId: ADSET }], ['meta-ad-sets', { view: 'max-bid' }],
      ['meta-ad-details', { view: 'ads', changedSince: '2026-10-01' }], ['meta-ad-details', { view: 'ads', adSetId: ADSET }], ['meta-ad-details', { view: 'ads', campaignId: CAMPAIGN, creativeId: CREATIVE }],
      ['meta-ad-details', { view: 'ad', adId: AD }], ['meta-ad-details', { view: 'creatives' }], ['meta-ad-details', { view: 'creatives', adId: AD }],
      ['meta-ad-details', { view: 'creative', creativeId: CREATIVE, thumbnailWidth: 300, thumbnailHeight: 300 }], ['meta-ad-details', { view: 'drafts' }],
      ['meta-ad-details', { view: 'drafts', campaignId: CAMPAIGN }], ['meta-ad-details', { view: 'rules', adId: AD }], ['meta-ad-details', { view: 'problems', includePausedByParent: true }],
      ['meta-ad-details', { view: 'diagnostics', adSetId: ADSET, ...day }], ['meta-ad-details', { view: 'asset-results', adId: AD, breakdown: 'image_asset', ...day }],
      ['meta-ad-details', { view: 'creative-jobs', completed: true }], ['meta-ad-details', { view: 'creative-jobs', jobId: '120000000000951' }],
      ['meta-ad-details', { view: 'creative-insights', creativeId: CREATIVE }],
      ['meta-ad-details', { view: 'suggested', useCase: 'automated_shopping_ads', objective: 'OUTCOME_SALES', countries: ['IT'], forChosenPage: true }],
      ['meta-ad-details', { view: 'smart-suggested', objective: 'OUTCOME_SALES', destinationType: 'WEBSITE' }], ['meta-ad-details', { view: 'feedback', adId: AD }],
      ['meta-ad-details', { view: 'locales', search: 'Italian' }], ['meta-ad-details', { view: 'catalog-categories', adSetId: ADSET, criteria: 'brand' }],
      ['meta-labels', { view: 'labels' }], ['meta-labels', { view: 'label', labelId: '120000000000601' }], ['meta-labels', { view: 'objects', labelIds: ['120000000000601'], kind: 'ads' }],
      ['meta-labels', { view: 'objects', labelIds: ['120000000000601'], operator: 'all', kind: 'creatives' }],
      ['meta-value-rules', { view: 'sets', productType: 'audience', status: 'active' }], ['meta-value-rules', { view: 'set', ruleSetId: '120000000000801' }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args, res.error])
    }
    expect(failed).toEqual([])
    const refused = h.calls.map((c) => [c.operation, c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, , problem]) => problem)
    expect(refused).toEqual([])
    // Never a public preview link, never people's comments, never a token.
    const asked = h.calls.map((c) => fieldsOf(c)).join(' ')
    expect(asked).not.toMatch(/preview_shareable_link|comments|token|leads/)
  })
})

describe('only the chosen ad account\'s own objects', () => {
  it('an id Nexus has not read is checked live (account_id); another account\'s is refused before its own read', async () => {
    h.known = new Map()
    h.owners.set('120000000000999', '5550001112')
    expect((await run('meta-campaigns', { view: 'campaign', campaignId: '120000000000999' })).error).toMatch(/does not belong to the ad account this business chose/)
    expect(h.calls.map((c) => c.operation)).toEqual(['graph.ownerCheck'])
    h.calls.length = 0
    h.owners.set('120000000000998', '1234567890')
    h.answer = () => ({ id: '120000000000998', name: 'Shop A new campaign', effective_status: 'ACTIVE' })
    expect((await run('meta-campaigns', { view: 'campaign', campaignId: '120000000000998' })).ok).toBe(true)
  })
  it('an id of another kind is refused in words', async () => {
    expect((await run('meta-ad-sets', { view: 'adset', adSetId: CAMPAIGN })).error).toMatch(/is a campaign of this ad account, not an ad set/)
    expect((await run('meta-ad-details', { view: 'creative', creativeId: AD })).error).toMatch(/is an ad of this ad account, not a creative/)
    expect(h.calls).toHaveLength(0)
  })
  it('a label, value rule set, budget period or creative job is read only when the account\'s own list holds it', async () => {
    h.answer = () => ({ data: [{ id: '120000000000601' }] })
    expect((await run('meta-labels', { view: 'label', labelId: '120000000000699' })).error).toMatch(/120000000000699 is not a label of the chosen ad account/)
    expect((await run('meta-labels', { view: 'objects', labelIds: ['120000000000601', '120000000000699'], kind: 'ads' })).error).toMatch(/120000000000699 is not a label of the chosen ad account/)
    expect((await run('meta-value-rules', { view: 'set', ruleSetId: '120000000000899' })).error).toMatch(/not one of the chosen ad account's/)
    expect((await run('meta-campaigns', { view: 'budget-schedule', campaignId: CAMPAIGN, periodId: '120000000000999' })).error).toMatch(/not one of this campaign's/)
    expect((await run('meta-ad-details', { view: 'creative-jobs', jobId: '120000000000999' })).error).toMatch(/not one of the chosen ad account's async creative jobs/)
    // Only list reads went out (never the node itself).
    expect(h.calls.every((c) => /\/(adlabels|value_rule_set|budget_schedules|asyncadcreatives)$/.test(c.path))).toBe(true)
  })
  it('a custom audience of another ad account is refused; an ad of another account using it is left out', async () => {
    h.owners.set('120000000000500', '5550001112')
    expect((await run('meta-ad-sets', { view: 'by-audience', audienceId: '120000000000500' })).error).toMatch(/custom audience does not belong to the ad account/)
    // A campaign's id is not an audience (its ads would be read as the audience's).
    expect((await run('meta-ad-sets', { view: 'by-audience', audienceId: CAMPAIGN })).error).toMatch(/is a campaign of this ad account, not a custom audience/)
    h.owners.set('120000000000501', '1234567890')
    h.answer = () => ({ data: [
      { id: AD, name: 'Ad A', account_id: '1234567890', campaign_id: CAMPAIGN, adset_id: ADSET, effective_status: 'ACTIVE', adset: { id: ADSET, name: 'Ad set A', effective_status: 'ACTIVE' } },
      { id: '120000000000302', name: 'Other', account_id: '5550001112', adset_id: '120000000000202', effective_status: 'ACTIVE' },
    ] })
    const res = await run('meta-ad-sets', { view: 'by-audience', audienceId: '120000000000501' })
    expect(res.data).toMatchObject({ adsRead: 1, adSets: [{ adSetId: ADSET, name: 'Ad set A', ads: [{ adId: AD }] }] })
    expect(JSON.stringify(res.data)).not.toContain('Other')
    expect(h.calls.at(-1)).toMatchObject({ path: '120000000000501/ads' })
  })
  it('review fix A1 — an id of another kind is refused on the kind fields of the one table, with no further call', async () => {
    const AUDIENCE = '120000000000555'
    h.known = new Map([[CAMPAIGN, 'campaign']])
    h.owners.set(AUDIENCE, '1234567890')
    const notThatKind = (req: Req) => (/objective|optimization_goal|adset_id|object_type/.test(fieldsOf(req))
      ? refusedByMeta(`(#100) Tried accessing nonexisting field (${fieldsOf(req).split(',')[1]}) on node type (CustomAudience)`) : null)
    h.ownerAnswer = notThatKind
    for (const [name, args] of [
      ['meta-campaigns', { view: 'campaign', campaignId: AUDIENCE }], ['meta-ad-sets', { view: 'adset', adSetId: AUDIENCE }],
      ['meta-ad-details', { view: 'ads', adSetId: AUDIENCE }], ['meta-ad-details', { view: 'creative', creativeId: AUDIENCE }],
    ] as Array<[string, Record<string, unknown>]>) {
      h.calls.length = 0
      expect((await run(name, args)).error, name).toMatch(/is not an? (campaign|ad set|creative) \(Meta does not know/)
      expect(h.calls.map((c) => c.operation), name).toEqual(['graph.ownerCheck'])
    }
    // The kind's two fields from the one table (services/meta/meta-kinds.ts).
    h.calls.length = 0
    await run('meta-campaigns', { view: 'campaign', campaignId: AUDIENCE })
    expect(h.calls[0].query).toEqual({ fields: 'account_id,objective,effective_status' })
    // A campaign's id is not an audience; an audience answering without its own fields is not one either.
    h.calls.length = 0
    expect((await run('meta-ad-sets', { view: 'by-audience', audienceId: CAMPAIGN })).error).toMatch(/is a campaign of this ad account, not a custom audience/)
    expect(h.calls).toHaveLength(0)
    h.ownerAnswer = () => ({ account_id: '1234567890', subtype: 'CUSTOM' })
    expect((await run('meta-ad-sets', { view: 'by-audience', audienceId: AUDIENCE })).error).toMatch(/is not a custom audience of this ad account/)
    // meta-ads-live (step 2) goes through the same check: an audience as campaignId is refused.
    h.ownerAnswer = notThatKind
    h.calls.length = 0
    const live = META_ADS_READ_TOOLS.find((t) => t.name === 'meta-ads-live')!
    expect((await live.handler(live.input.parse({ view: 'ads', campaignId: AUDIENCE }), ctx as never)).error).toMatch(/is not a campaign \(Meta does not know/)
    expect(h.calls.map((c) => c.operation)).toEqual(['graph.ownerCheck'])
  })
  it('review fix A9 — when Meta could not be asked (a throttle, a lost token) the refusal says so, never "does not belong"', async () => {
    h.known = new Map()
    h.ownerAnswer = () => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'rate_limited', channelCode: '17', channelMessage: 'User request limit reached' } as never }), 'x', 1)
    const res = await run('meta-ad-sets', { view: 'adset', adSetId: ADSET })
    expect(res.error).toMatch(/could not confirm.*slow down/)
    expect(res.error).not.toMatch(/does not belong/)
    h.ownerAnswer = () => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'auth_revoked', channelCode: '190', channelMessage: 'Session invalid' } as never }), 'x', 1)
    expect((await run('meta-ad-sets', { view: 'adset', adSetId: ADSET })).error).toMatch(/could not confirm.*no longer accepts this business's system-user token/)
  })
  it('review fix A2 — every label is checked against ONE read of the account\'s labels', async () => {
    h.answer = (req) => (req.path.endsWith('/adlabels') ? { data: [{ id: '120000000000601' }, { id: '120000000000602' }, { id: '120000000000603' }] } : { data: [] })
    await run('meta-labels', { view: 'objects', labelIds: ['120000000000601', '120000000000602', '120000000000603'], kind: 'campaigns' })
    expect(h.calls.filter((c) => c.path.endsWith('/adlabels'))).toHaveLength(1)
  })
  it('review fix A5 — a transient failure or a permission refusal is never retried part by part', async () => {
    for (const [cls, code] of [['transient', '2'], ['timeout', '-'], ['forbidden', '10'], ['not_found', '100/33']]) {
      h.calls.length = 0
      h.answer = () => new MetaReadError(failureOfAnswer({ status: cls === 'transient' ? 500 : 400, verdict: { errorClass: cls, channelCode: code, channelMessage: 'x' } as never }), 'x', 1)
      expect((await run('meta-ad-details', { view: 'ad', adId: AD })).ok, cls).toBe(false)
      expect(h.calls.map((c) => c.operation), cls).toEqual(['objects.ad'])
    }
  })
  it('a Page or Instagram account of another business is its id and the flag only', async () => {
    h.taken = [{ product: 'PAGE', id: '120000000000011' }]
    h.answer = (req) => (req.path === CREATIVE && fieldsOf(req).startsWith('id,') ? {
      id: CREATIVE, account_id: '1234567890', actor_id: '120000000000011', instagram_user_id: '170000000000001', object_story_spec: { page_id: '120000000000011' },
    } : {})
    const res = await run('meta-ad-details', { view: 'creative', creativeId: CREATIVE })
    expect(res.data).toMatchObject({
      pages: [{ pageId: '120000000000011', chosenHere: false, takenByAnotherBusiness: true }],
      instagram: [{ instagramId: '170000000000001', chosenHere: true, takenByAnotherBusiness: false }],
    })
  })
  it('catalog categories: only of a catalog the ad set promotes and the chosen account\'s portfolio owns', async () => {
    h.answer = (req) => (req.path === ADSET ? { promoted_object: { product_catalog_id: '120000000000700' } } : req.path === '120000000000700' ? { business: { id: '9876543299' } } : { data: [] })
    expect((await run('meta-ad-details', { view: 'catalog-categories', adSetId: ADSET, criteria: 'BRAND' })).error).toMatch(/not owned by the chosen ad account's business portfolio/)
    expect(h.calls.some((c) => c.path.endsWith('/categories'))).toBe(false)
    h.answer = (req) => (req.path === ADSET ? { promoted_object: { page_id: '120000000000010' } } : { data: [] })
    expect((await run('meta-ad-details', { view: 'catalog-categories', adSetId: ADSET, criteria: 'BRAND' })).error).toMatch(/promotes no product catalog/)
  })
  it('a creative Meta says is another account\'s is refused even when its id was known', async () => {
    h.answer = () => ({ id: CREATIVE, account_id: '5550001112', name: 'Shop B creative' })
    const res = await run('meta-ad-details', { view: 'creative', creativeId: CREATIVE })
    expect(res.error).toMatch(/does not belong to the ad account this business chose/)
  })
})

describe('Meta\'s traps, said plainly', () => {
  it('a DELETED filter on a list is refused before any call (Meta errors on it): read a deleted one by id', async () => {
    expect((await run('meta-campaigns', { view: 'list', statuses: ['ACTIVE', 'deleted'] })).error).toMatch(/refuses a DELETED filter.*by its own id/)
    expect((await run('meta-ad-details', { view: 'ads', statuses: ['NOT_A_STATUS'] })).error).toMatch(/is not a status a ad list takes/)
    expect(h.calls).toHaveLength(0)
  })
  it('campaign: money in cents (a removed spend cap is none), Advantage+ asked alone, a legacy shopping campaign said read only', async () => {
    h.answer = (req) => {
      if (fieldsOf(req) === 'advantage_state_info') return { advantage_state_info: { advantage_state: 'ADVANTAGE_PLUS_SALES', advantage_budget_state: 'ENABLED', advantage_audience_state: 'ENABLED', advantage_placement_state: 'ENABLED' } }
      if (req.path.endsWith('/recommendations')) return { data: [{ object_id: CAMPAIGN, title: 'Raise the budget', recommendation_data: { budget: 6000 } }, { object_id: '120000000000102', title: 'Not this one' }] }
      return { id: CAMPAIGN, name: 'Shop A campaign', daily_budget: '2500', spend_cap: '922337203685478', effective_status: 'CAMPAIGN_PAUSED', smart_promotion_type: 'AUTOMATED_SHOPPING_ADS', issues_info: [{ level: 'CAMPAIGN', error_code: 1815, error_summary: 'x', error_type: 'HARD_ERROR', mid: 'm1' }] }
    }
    const res = await run('meta-campaigns', { view: 'campaign', campaignId: CAMPAIGN })
    expect(res.data).toMatchObject({
      campaign: { dailyBudgetCents: 2500, spendCapCents: null, legacy: expect.stringMatching(/refuses every edit/), issues: [{ errorCode: 1815, mid: 'm1' }] },
      advantage: { state: 'ADVANTAGE_PLUS_SALES', budget: 'ENABLED' },
      recommendations: [{ title: 'Raise the budget', metaRaw: { recommendation_data: { budget: 6000 } } }],
    })
    expect((res.data as { recommendations: unknown[] }).recommendations).toHaveLength(1)
    expect(h.calls.map((c) => c.query?.fields)).toContain('advantage_state_info')
  })
  it('when Meta refuses the Advantage+ field, the campaign is still answered and the refusal is said', async () => {
    h.answer = (req) => (fieldsOf(req) === 'advantage_state_info' ? refusedByMeta('Tried accessing nonexisting field (advantage_state_info)') : req.path.endsWith('/recommendations') ? { data: [] } : { id: CAMPAIGN, name: 'Shop A campaign' })
    const res = await run('meta-campaigns', { view: 'campaign', campaignId: CAMPAIGN })
    expect(res).toMatchObject({ ok: true, data: { advantage: null, advantageNote: expect.stringMatching(/did not answer the Advantage\+ state.*nonexisting field/) } })
  })
  it('a field Meta refuses costs only its own part: each group alone, the refused one named; the core must answer', async () => {
    h.answer = (req) => {
      const f = fieldsOf(req)
      if (req.path !== AD) return {}
      if (f.includes('creative_asset_groups_spec')) return refusedByMeta('Tried accessing nonexisting field (creative_asset_groups_spec)')
      if (f === 'ad_review_feedback') return { ad_review_feedback: { global: { POLICY: 'Words of Meta' } } }
      if (f === 'failed_delivery_checks') return {}
      if (f === 'recommendations') return {}
      return { id: AD, name: 'Ad A', effective_status: 'DISAPPROVED', adset: { destination_type: 'WEBSITE' }, creative: { id: CREATIVE, asset_feed_spec: { message_extensions: [{ type: 'whatsapp' }] } } }
    }
    const res = await run('meta-ad-details', { view: 'ad', adId: AD })
    expect(res.data).toMatchObject({
      ad: { adId: AD, statusText: expect.stringMatching(/Rejected/) }, review: { global: { POLICY: 'Words of Meta' } }, failedDeliveryChecks: [], websiteToMessage: true,
      missing: [{ part: 'flexibleFormat', sentence: expect.stringMatching(/nonexisting field/) }],
    })
    // The first call asked every group with review_feedback_breakdown; then one call per group.
    expect(h.calls[0].query).toMatchObject({ review_feedback_breakdown: true })
    expect(h.calls.map((c) => c.operation)).toEqual(['objects.ad', 'objects.ad.core', 'objects.ad.review', 'objects.ad.checks', 'objects.ad.recommendations', 'objects.ad.flexibleFormat', 'objects.ad.autobid'])
    // review_feedback_breakdown goes only with the review group's own call (the gateway lets it through only there).
    expect(h.calls.filter((c) => c.query?.review_feedback_breakdown).map((c) => c.operation)).toEqual(['objects.ad', 'objects.ad.review'])
    // The core refused: the read fails with Meta's words.
    h.calls.length = 0
    h.answer = () => refusedByMeta('Unsupported get request')
    expect((await run('meta-ad-details', { view: 'ad', adId: AD })).error).toMatch(/Unsupported get request/)
  })
  it('a lost token or a throttle is never retried part by part', async () => {
    h.answer = () => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'rate_limited', channelCode: '17', channelMessage: 'limit' } as never }), 'x', 1)
    expect((await run('meta-ad-sets', { view: 'adset', adSetId: ADSET })).ok).toBe(false)
    expect(h.calls).toHaveLength(1)
  })
  it('ad set: learning in words, relaxed targeting, real placements from their own call, bids per 1,000 impressions', async () => {
    h.answer = (req) => (fieldsOf(req).startsWith('targeting{') ? { targeting: { effective_publisher_platforms: ['facebook', 'instagram'], effective_instagram_positions: ['stream'] } } : {
      id: ADSET, campaign_id: CAMPAIGN, billing_event: 'IMPRESSIONS', bid_amount: '350', daily_budget: '1000', daily_spend_cap: '922337203685478', bid_info: { ACTIONS: '120' },
      learning_stage_info: { status: 'FAIL', conversions: 12 }, targeting_optimization_types: [{ key: 'detailed_targeting', value: 1 }], review_feedback: [], value_rule_set_id: '120000000000801',
    })
    const res = await run('meta-ad-sets', { view: 'adset', adSetId: ADSET })
    expect(res.data).toMatchObject({
      adSet: { bidAmountCents: 350, bidPer: expect.stringMatching(/1,000 impressions/), dailyBudgetCents: 1000, dailySpendCapCents: null, bidInfoCents: { ACTIONS: 120 }, valueRuleSetId: '120000000000801' },
      learning: { status: 'FAIL', statusText: expect.stringMatching(/Learning limited/) },
      relaxedTargeting: [{ key: 'detailed_targeting', relaxed: true }],
      placements: { publisherPlatforms: ['facebook', 'instagram'], instagramPositions: ['stream'] },
      reviewFeedback: [],
    })
    expect(h.calls.map((c) => c.operation)).toEqual(['objects.adset', 'objects.adset.placements'])
  })
  it('a high-demand period\'s budget value is Meta\'s number as sent, under a money key, with its unit said to be undocumented', async () => {
    h.answer = () => ({ data: [{ id: '120000000000901', budget_value: 140, budget_value_type: 'ABSOLUTE', time_start: '2026-11-27T00:00:00+0100' }] })
    const res = await run('meta-campaigns', { view: 'budget-schedules', campaignId: CAMPAIGN, from: '2026-11-01', to: '2026-11-30' })
    expect(res.data).toMatchObject({ items: [{ periodId: '120000000000901', budgetValue: 140, budgetValueType: 'ABSOLUTE' }], note: expect.stringMatching(/does not document whether/) })
    expect(h.calls[0].query).toMatchObject({ time_start: String(Date.UTC(2026, 10, 1) / 1000), time_stop: String(Date.UTC(2026, 10, 30) / 1000 + 86_400) })
  })
  it('the ads of one creative: the list is looked through (Meta documents no creative filter) and says how many were', async () => {
    h.answer = () => ({ data: [
      { id: AD, account_id: '1234567890', adset_id: ADSET, campaign_id: CAMPAIGN, name: 'Ad A', creative: { id: CREATIVE } },
      { id: '120000000000302', account_id: '1234567890', adset_id: ADSET, campaign_id: CAMPAIGN, name: 'Ad B', creative: { id: '120000000000402' } },
      { id: '120000000000303', account_id: '5550001112', adset_id: ADSET, campaign_id: CAMPAIGN, name: 'Other', creative: { id: CREATIVE } },
    ] })
    const res = await run('meta-ad-details', { view: 'ads', creativeId: CREATIVE })
    expect(res.data).toMatchObject({ creativeId: CREATIVE, adsLookedAt: 3, items: [{ adId: AD }] })
    expect((res.data as { items: unknown[] }).items).toHaveLength(1)
    expect(h.calls[0].query).not.toHaveProperty('filtering')
  })
  it('feedback asks the ids only (no preview link, no comments); creative asks the WhatsApp number in a call of its own', async () => {
    h.answer = (req) => (req.path.endsWith('/facebook_feedback') ? { data: [{ id: '120000000000351' }] } : fieldsOf(req).startsWith('object_story_spec{') ? { object_story_spec: { whats_app_business_phone_number: '+39 000 0000000' } } : { id: CREATIVE, account_id: '1234567890' })
    expect((await run('meta-ad-details', { view: 'feedback', adId: AD })).data).toMatchObject({ feedbackIds: ['120000000000351'] })
    expect(h.calls.at(-1)).toMatchObject({ path: `${AD}/facebook_feedback`, query: { fields: 'id' } })
    expect((await run('meta-ad-details', { view: 'creative', creativeId: CREATIVE })).data).toMatchObject({ whatsAppNumber: '+39 000 0000000' })
  })
  it('diagnostics: auction amounts under money keys; rankings only when Meta answers them, else said', async () => {
    h.answer = (req) => {
      const f = fieldsOf(req)
      if (f.includes('quality_ranking')) return refusedByMeta('(#100) quality_ranking is not valid for fields param')
      if (f.startsWith('auction_')) return { data: [{ auction_bid: '1.20', auction_competitiveness: '0.4', wish_bid: '2.00' }] }
      if (f.startsWith('deduping_')) return { data: [{ deduping_ratio: '0.12' }] }
      return { data: [{}] }
    }
    const res = await run('meta-ad-details', { view: 'diagnostics', adSetId: ADSET, from: '2026-10-01', to: '2026-10-19' })
    expect(res.data).toMatchObject({ auction: { auctionBid: '1.20', wishBid: '2.00' }, overlap: { dedupingRatio: '0.12' }, rankings: null, missing: [{ part: 'rankings' }] })
    // Review fix A6 — undocumented shapes under metaRaw (money-restricted).
    expect((res.data as { fatigue: unknown; diversity: unknown })).toMatchObject({ fatigue: { metaRaw: expect.any(Object) }, diversity: { metaRaw: expect.any(Object) } })
    expect((await run('meta-ad-details', { view: 'diagnostics', adSetId: ADSET, from: '2026-01-01', to: '2026-10-19' })).error).toMatch(/92 days/)
  })
  it('results per asset: the breakdown asked, spend and purchase value in cents', async () => {
    h.answer = () => ({ data: [{ body_asset: { id: '1', text: 'Words A' }, impressions: '1000', clicks: '20', spend: '12.34', actions: [{ action_type: 'omni_purchase', value: '2' }], action_values: [{ action_type: 'omni_purchase', value: '80.00' }] }] })
    const res = await run('meta-ad-details', { view: 'asset-results', adSetId: ADSET, breakdown: 'body_asset', from: '2026-10-01', to: '2026-10-19' })
    expect(res.data).toMatchObject({ items: [{ asset: { text: 'Words A' }, impressions: 1000, spendCents: 1234, purchases: 2, purchaseValueCents: 8000 }] })
    expect(h.calls.at(-1)!.query).toMatchObject({ breakdowns: ['body_asset'], fields: 'impressions,clicks,spend,reach,actions,action_values' })
  })
  it('problems: the account, issues, rejections and payment apart from ads waiting in review', async () => {
    h.answer = (req) => {
      if (req.path === 'act_1234567890') return { account_status: 3, disable_reason: 0 }
      if (req.path.endsWith('/campaigns')) return { data: [{ id: CAMPAIGN, name: 'C', effective_status: 'WITH_ISSUES', issues_info: [{ error_code: 2446079, error_type: 'SOFT_ERROR' }] }] }
      if (req.path.endsWith('/ads')) return { data: [{ id: AD, name: 'A', effective_status: 'DISAPPROVED', ad_review_feedback: { global: { X: 'y' } } }, { id: '120000000000302', name: 'B', effective_status: 'PENDING_REVIEW' }] }
      return { data: [] }
    }
    const res = await run('meta-ad-details', { view: 'problems' })
    expect(res.data).toMatchObject({
      account: { statusText: expect.stringMatching(/Unsettled/) },
      problems: [{ level: 'campaign', id: CAMPAIGN }, { level: 'ad', id: AD, review: { global: { X: 'y' } } }],
      waiting: [{ id: '120000000000302', statusText: expect.stringMatching(/review/) }],
    })
  })
  it('labels: one label through its own edge; several through the account\'s …bylabels with the operator', async () => {
    h.answer = (req) => (req.path.endsWith('/adlabels') ? { data: [{ id: '120000000000601' }, { id: '120000000000602' }] } : { data: [{ id: CAMPAIGN, account_id: '1234567890', name: 'C' }, { id: '120000000000109', account_id: '5550001112', name: 'Other' }] })
    const one = await run('meta-labels', { view: 'objects', labelIds: ['120000000000601'], kind: 'campaigns' })
    expect(h.calls.at(-1)).toMatchObject({ path: '120000000000601/campaigns' })
    expect((one.data as { items: unknown[] }).items).toEqual([expect.objectContaining({ id: CAMPAIGN })])
    await run('meta-labels', { view: 'objects', labelIds: ['120000000000601', '120000000000602'], operator: 'all', kind: 'adsets' })
    expect(h.calls.at(-1)).toMatchObject({ path: 'act_1234567890/adsetsbylabels', query: { ad_label_ids: ['120000000000601', '120000000000602'], operator: 'ALL' } })
  })
  it('value rules: rules and criteria read from Meta\'s nested lists', async () => {
    h.answer = () => ({ data: [{ id: '120000000000801', name: 'Rules A', rules: { data: [{ id: '1', name: 'Young', adjust_sign: 'INCREASE', adjust_value: 20, criterias: { data: [{ criteria_type: 'AGE', operator: 'CONTAINS', criteria_values: ['18-24'], criteria_value_types: ['NONE'] }] } }] } }] })
    const res = await run('meta-value-rules', {})
    expect(res.data).toMatchObject({ items: [{ ruleSetId: '120000000000801', rules: [{ adjust: 'INCREASE', adjustPercent: 20, criteria: [{ type: 'AGE', values: ['18-24'] }] }] }] })
  })
  it('a list pages with Meta\'s cursor (never its next link) and reports Meta\'s total', async () => {
    let page = 0
    h.answer = () => (page++ === 0
      ? { data: [{ id: CAMPAIGN }], paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/v26.0/next?access_token=SECRET' }, summary: { total_count: 2 } }
      : { data: [{ id: '120000000000102' }], paging: { cursors: { after: 'c2' } } })
    const res = await run('meta-campaigns', { view: 'list' })
    expect(res.data).toMatchObject({ totalCount: 2, more: false })
    expect(h.calls.map((c) => [c.query?.after ?? null, c.query?.summary ?? null])).toEqual([[null, 'total_count'], ['c1', null]])
    expect(JSON.stringify(res.data)).not.toContain('SECRET')
  })
  it('review fix A6 — Page ad limits: explicit fields, a Page of another business is its id and the flag only, no portfolio id', async () => {
    h.taken = [{ product: 'PAGE', id: '120000000000011' }]
    h.answer = (req) => (req.path.endsWith('/ads_volume')
      ? { data: [{ actor_id: '120000000000010', ads_running_or_in_review_count: 12, limit_on_ads_running_or_in_review: 250 }, { actor_id: '120000000000011', ads_running_or_in_review_count: 40 }] }
      : req.path === 'act_1234567890' ? { account_status: 1 } : { data: [] })
    const res = await run('meta-ad-details', { view: 'problems' })
    expect((res.data as { adsVolume: unknown }).adsVolume).toEqual([
      expect.objectContaining({ pageId: '120000000000010', chosenHere: true, adsRunningOrInReview: 12, limit: 250 }),
      { pageId: '120000000000011', takenByAnotherBusiness: true },
    ])
    const volume = h.calls.find((c) => c.path.endsWith('/ads_volume'))!
    expect(volume.query).toMatchObject({ show_breakdown_by_actor: true })
    expect(fieldsOf(volume)).not.toMatch(/actor_name|ad_limit_scope/)
  })
  it('review B F1 — a creative list asks the WhatsApp identity in its own group, and never on an ad set\'s creatives', async () => {
    h.answer = () => ({ data: [] })
    await run('meta-ad-details', { view: 'creatives' })
    expect(fieldsOf(h.calls.at(-1)!)).toMatch(/,wamo_whatsapp_identity_spec$/)
    await run('meta-ad-details', { view: 'creatives', adSetId: ADSET })
    expect(fieldsOf(h.calls.at(-1)!)).not.toMatch(/wamo_whatsapp_identity_spec/)
    expect(h.calls.at(-1)!.path).toBe(`${ADSET}/adcreatives`)
  })
  it('review B F5 — a minimum-ROAS floor is read back as a plain ROAS (Meta writes ROAS × 10,000)', () => {
    expect(roasFloorOf({ roas_average_floor: 25000 })).toBe(2.5)
    expect(roasFloorOf({ roas_average_floor: '100' })).toBe(0.01)
    expect(roasFloorOf({})).toBeNull()
    expect(roasFloorOf(null)).toBeNull()
  })
  it('every money key an answer carries is restricted (scan of the answers above)', () => {
    for (const key of ['dailyBudgetCents', 'lifetimeBudgetCents', 'budgetRemainingCents', 'spendCapCents', 'bidAmountCents', 'dailyMinSpendTargetCents', 'dailySpendCapCents', 'lifetimeMinSpendTargetCents', 'lifetimeSpendCapCents', 'spendCents', 'purchaseValueCents', 'currentAverageCost', 'bidRecommendation', 'auctionMaxCompetitorBid', 'revenueMeta', 'conversionCostMeta']) {
      expect(META_OBJECTS_MONEY, key).toHaveProperty(key, 'financials.adspend.view')
    }
  })
  it('a business without Meta, or without a chosen account, is told who sets it up', async () => {
    h.connections = []
    expect((await run('meta-labels', {})).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect((await run('meta-value-rules', {})).error).toMatch(/No Meta ad account is chosen/)
  })
})
