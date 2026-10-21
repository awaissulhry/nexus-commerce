/**
 * Meta ads step 2 — Claude's Meta read tools. meta-ads-graph-read reads ONLY the chosen ad account and its own objects
 * (an object id is checked against Nexus's rows, else against its account_id on Meta), refuses a batch-shaped path, a
 * people edge without the users permission, the payment method and any parameter the gateway owns, and never hands back
 * a paging link or a token. meta-ad-accounts answers an account another business picked by its id only (never which). meta-ads-live
 * caps an insights window. meta-ads-overview says plainly that benchmarks have no public Meta API, and computes the
 * weekly trend from read days only. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  one: null as null | ((req: { operation: string; path: string }) => unknown),
  rows: [] as Record<string, unknown>[],
  known: new Map<string, string>(),
  taken: [] as Array<{ id: string }>,
  refuseAll: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => Error | null),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: { operation: string; path: string; query?: Record<string, unknown> }) => {
    h.calls.push(req)
    return { body: h.one?.(req) ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: { operation: string; path: string; query?: Record<string, unknown> }, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const refusal = h.refuseAll?.(req)
    if (refusal) throw refusal
    onRows(h.rows)
    return { rows: h.rows.length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../../db.js', () => {
  // Nexus's own rows, by kind: an id is a campaign, an ad set, an ad or a creative of the chosen account.
  const found = (pairs: Array<[string, string]>) => vi.fn(async ({ where }: { where: Record<string, string> }) =>
    (pairs.some(([key, kind]) => where[key] && h.known.get(where[key]) === kind) ? { id: 'x' } : null))
  return {
    default: {
      metaAdsCampaign: { findFirst: found([['campaignId', 'campaign']]) },
      metaAdsAdSet: { findFirst: found([['adSetId', 'adset']]) },
      metaAdsAd: { findFirst: found([['adId', 'ad'], ['creativeId', 'creative']]) },
      $queryRaw: vi.fn(async () => h.taken),
    },
  }
})
vi.mock('../../marketing/meta-ads/read.service.js', () => ({
  MetaAdsReadError: class MetaAdsReadError extends Error {},
  metaAdsOverview: vi.fn(async () => ({
    window: { from: '2026-10-06', to: '2026-10-19' }, currency: 'EUR', dataAsOf: null, account: null, totals: null,
    days: Array.from({ length: 14 }, (_, i) => (i === 13
      ? { date: `2026-10-${String(6 + i).padStart(2, '0')}`, read: false }
      : { date: `2026-10-${String(6 + i).padStart(2, '0')}`, read: true, spendCents: 1000, impressions: 1000, clicks: 10, purchases: 1, purchaseValueCents: 5000 })),
  })),
  metaAdsCampaigns: vi.fn(async () => ({ items: [] })),
  metaAdsAdSets: vi.fn(), metaAdsAds: vi.fn(), metaCampaignDays: vi.fn(),
}))

import { META_ADS_READ_TOOLS, weeklyTrend } from './meta-ads-read.tools.js'
import { graphSafe } from '../../marketing/meta-ads/live.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_READ_TOOLS.find((t) => t.name === name)!
const can = (granted: string[] = ['ads.view', 'financials.adspend.view']) => ({ can: (p: string) => granted.includes(p), via: 'claude' as const })
const run = (name: string, args: Record<string, unknown>, ctx = can()) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: '120000000000010' }, instagram: null, read: {},
}

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.one = null; h.rows = []; h.known = new Map(); h.taken = []; h.refuseAll = null })

describe('the four tools are reads', () => {
  it('none changes anything; the live ones reach Meta (open world); graph-read needs the ad-spend money permission', () => {
    for (const t of META_ADS_READ_TOOLS) expect({ name: t.name, readOnly: t.readOnly, execute: t.execute }).toEqual({ name: t.name, readOnly: true, execute: undefined })
    expect(META_ADS_READ_TOOLS.map((t) => [t.name, !!t.openWorld])).toEqual([['meta-ad-accounts', true], ['meta-ads-overview', false], ['meta-ads-live', true], ['meta-ads-graph-read', true]])
    expect(tool('meta-ads-graph-read').requires).toEqual(['ads.view', 'financials.adspend.view'])
    expect(tool('meta-ads-overview').restrictedFields).toMatchObject({ spendCents: 'financials.adspend.view', purchaseValueCents: 'financials.adspend.view', dailyBudgetCents: 'financials.adspend.view' })
  })
})

describe('meta-ads-graph-read — the chosen ad account and its own objects only', () => {
  it('reads act_<chosen>/<edge> with the fields and parameters asked; strips paging links and tokens', async () => {
    h.one = () => ({ data: [{ id: '1', status: 'DONE' }], paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/v26.0/act_1234567890/async_requests?access_token=SECRET&after=c1' } })
    const res = await run('meta-ads-graph-read', { path: 'act_1234567890/async_requests', fields: 'id,status', params: { status: 'FINISHED' }, limit: 50 })
    expect(res.ok).toBe(true)
    expect(h.calls).toEqual([{ operation: 'graph.read.async_requests', path: 'act_1234567890/async_requests', query: { status: 'FINISHED', fields: 'id,status', limit: 50 } }])
    h.calls.length = 0
    // A parameter the gateway's allow-list does not carry on that path is refused in words before any call.
    expect((await run('meta-ads-graph-read', { path: 'act_1234567890/campaigns', params: { date_preset: 'last_7d' } })).error).toMatch(/does not send the parameter "date_preset"/)
    expect((await run('meta-ads-graph-read', { path: 'act_1234567890', params: { metadata: 1 } })).error).toMatch(/does not send the parameter "metadata"/)
    expect(h.calls).toHaveLength(0)
    expect(JSON.stringify(res.data)).not.toContain('SECRET')
    expect(res.data).toMatchObject({ nextAfter: 'c1', answer: { data: [{ id: '1' }] } })
    expect((res.data as { answer: { paging: Record<string, unknown> } }).answer.paging.next).toBeUndefined()
  })
  it('refuses another ad account, a deeper path, an odd edge, and a parameter the gateway owns — before any call', async () => {
    for (const args of [
      { path: 'act_1234567891/campaigns' }, { path: 'act_1234567890/campaigns/x' }, { path: 'act_1234567890/Campaigns' },
      { path: 'act_1234567890/campaigns', params: { access_token: 'x' } }, { path: 'act_1234567890/campaigns', params: { method: 'post' } },
      { path: 'act_1234567890', fields: 'funding_source_details' }, { path: 'me' },
    ]) {
      const res = await run('meta-ads-graph-read', args)
      expect({ args, ok: res.ok }).toEqual({ args, ok: false })
    }
    expect(h.calls).toHaveLength(0)
  })
  // Review 2 (lead decision) — allow-list only. The reviewers' probes (scratchpad probe2.mts, probe-verdict.mts): every one
  // is refused by name before any call.
  it.each([
    ['act_1234567890', 'business{owned_ad_accounts{id,name,amount_spent}}'],
    ['act_1234567890', 'business{client_ad_accounts{name,insights{spend}}}'],
    ['act_1234567890', 'users{id,name,tasks}'],
    ['120000000000010', 'leadgen_forms{leads{field_data}}'],
    ['act_1234567890', 'owned_ad_accounts.as(x){name}'],
    ['act_1234567890', 'promote_pages.fields(name,business.fields(name,owned_product_catalogs))'],
    ['act_1234567890', 'promote_pages.fields(id,name,instagram_business_account.fields(username,followers_count))'],
    ['act_1234567890', 'instagram_accounts.fields(username,followers_count)'],
    ['act_1234567890', 'promote_pages{name}'],
    ['act_1234567890', 'instagram_accounts{username}'],
    ['act_1234567890', 'ads.fields(leads.fields(field_data))'],
    ['act_1234567890', 'insights{campaign_name,owned_ad_accounts}'],
    ['act_1234567890', 'ad_accounts{name}'],
    ['act_1234567890', 'owner_business{name}'],
    ['act_1234567890', 'customaudiences.fields(name,approximate_count_lower_bound)'],
    ['act_1234567890', 'adspixels.fields(name,owner_business.fields(name))'],
    ['act_1234567890', 'promote_pages.fields(ratings.fields(reviewer,review_text))'],
    ['act_1234567890', 'promote_pages.fields(feed.fields(message,from))'],
    ['act_1234567890', 'adcreatives{object_story_spec,actor_id}'],
    ['act_1234567890', 'creative{effective_object_story_id}'],
    ['120000000000010', 'instagram_business_account{followers_count,username}'],
    ['120000000000010', 'instagram_business_account.fields(followers_count,username,business_discovery.username(rival){followers_count})'],
    ['act_1234567890', 'targeting{custom_audiences}'],
    ['act_1234567890', 'funding_source_details'],
    ['act_1234567890', 'insights.fields(funding_source_details)'],
    ['act_1234567890', 'adspaymentcycle.fields(threshold_amount)'],
    ['act_1234567890', 'Business{name}'],
    ['act_1234567890', 'businesS.fields(name)'],
    ['act_1234567890', 'agency_client_declaration'],
    ['act_1234567890', 'adaccounts.fields(name)'],
    ['act_1234567890', 'id,name,campaigns{adsets{name}}'],
    ['act_1234567890', 'insights.as(x){spend}'],
    ['act_1234567890', 'insights.summary(true){spend}'],
  ])('refuses %s ?fields=%s', async (path, fields) => {
    const res = await run('meta-ads-graph-read', { path, fields })
    expect(res).toMatchObject({ ok: false, error: expect.any(String) })
    expect(h.calls).toHaveLength(0)
  })
  it.each([
    'act_1234567890/promote_pages', 'act_1234567890/instagram_accounts', 'act_1234567890/customaudiences', 'act_1234567890/adspixels',
    'act_1234567890/users', 'act_1234567890/agencies', 'act_1234567890/audience_funnel', '120000000000010', '120000000000010/leadgen_forms',
  ])('refuses the path %s (allow-list of paths)', async (path) => {
    expect((await run('meta-ads-graph-read', { path })).ok).toBe(false)
    // Also with the users permission: no people edge is read here at all.
    expect((await run('meta-ads-graph-read', { path }, can(['ads.view', 'financials.adspend.view', 'users.manage']))).ok).toBe(false)
    expect(h.calls).toHaveLength(0)
  })
  it('the probe\'s insights read names only the account\'s own numbers: refused by name when a field is not one of them', async () => {
    expect((await run('meta-ads-graph-read', { path: 'act_1234567890/insights', fields: 'account_name,account_id' })).error).toMatch(/"account_name" is not a field meta-ads-graph-read reads on insights/)
  })
  it('what the views need still reads: the account\'s own numbers (both nesting forms), an ad\'s creative, a campaign\'s edges', async () => {
    for (const fields of ['id,name,insights.date_preset(last_7d){spend,impressions}', 'insights.fields(spend).date_preset(last_7d)', 'insights.time_range({"since":"2026-10-01","until":"2026-10-19"}).time_increment(1){spend}']) {
      expect((await run('meta-ads-graph-read', { path: 'act_1234567890', fields })).ok, fields).toBe(true)
    }
    h.known = new Map([['120000000000301', 'ad'], ['120000000000101', 'campaign'], ['120000000000401', 'creative']])
    expect((await run('meta-ads-graph-read', { path: '120000000000301', fields: 'id,creative{title,body}' })).ok).toBe(true)
    expect((await run('meta-ads-graph-read', { path: '120000000000101/adsets', fields: 'id,name,targeting{geo_locations,age_min}' })).ok).toBe(true)
    expect((await run('meta-ads-graph-read', { path: '120000000000401', fields: 'id,title,thumbnail_url' })).ok).toBe(true)
    // Each of these the real gateway lets through too.
    const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
    expect(refused).toEqual([])
    // No fields: a few of that object's own (Meta's default answer is never taken).
    h.calls.length = 0
    await run('meta-ads-graph-read', { path: '120000000000101' })
    expect(h.calls.at(-1)).toMatchObject({ operation: 'graph.read', path: '120000000000101', query: { fields: 'id,name,status' } })
  })
  it('step 9 review A1 — graph-read keeps ITS OWN parameter list (step 2\'s), never a key a later step adds to the gateway', async () => {
    h.known = new Map([['120000000000101', 'campaign'], ['120000000000201', 'adset']])
    for (const [path, params] of [
      ['120000000000101', { ad_account_id: '1234567890' }], ['120000000000101', { special_ad_categories: 'HOUSING' }],
      ['act_1234567890/insights', { targeting_spec: '{}' }], ['act_1234567890', { q: 'x' }], ['120000000000101/adsets', { level: 'ad' }],
      ['act_1234567890/async_requests', { effective_status: '["ACTIVE"]' }], ['act_1234567890/adcreatives', { effective_status: '["ACTIVE"]' }],
    ] as Array<[string, Record<string, string>]>) {
      expect((await run('meta-ads-graph-read', { path, params })).error, path).toMatch(/does not send the parameter/)
    }
    expect(h.calls).toHaveLength(0)
    // Every step-2 parameter still works, each where step 2 sent it.
    for (const [path, params] of [
      ['act_1234567890/campaigns', { effective_status: '["ACTIVE"]' }], ['act_1234567890/adsets', { effective_status: '["PAUSED"]' }], ['act_1234567890/ads', { effective_status: '["ACTIVE"]' }],
      ['120000000000101/adsets', { effective_status: '["ACTIVE"]' }], ['120000000000201/ads', { effective_status: '["ACTIVE"]' }],
      ['act_1234567890/insights', { level: 'campaign', time_range: '{"since":"2026-10-01","until":"2026-10-19"}', time_increment: 1, filtering: '[]' }],
      ['120000000000201/insights', { level: 'adset', time_increment: 'all_days' }],
      ['act_1234567890/async_requests', { status: 'FINISHED', type: 'ASYNC_ADGROUP_CREATION' }],
    ] as Array<[string, Record<string, string | number>]>) {
      expect((await run('meta-ads-graph-read', { path, params })).ok, path).toBe(true)
    }
    expect(h.calls).toHaveLength(8)
    const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
    expect(refused).toEqual([])
  })
  it('an object id is read only when Nexus has read it for the chosen account — no live look-up, no Page; only its own edges', async () => {
    h.known = new Map([['120000000000201', 'adset']])
    h.one = () => ({ account_id: '1234567890' })
    expect((await run('meta-ads-graph-read', { path: '120000000000999' })).error).toMatch(/reads only a campaign, ad set, ad or creative Nexus has read/)
    expect((await run('meta-ads-graph-read', { path: '120000000000201/adcreatives' })).error).toMatch(/does not read "adcreatives" of a adset; it reads ads, insights/)
    expect(h.calls).toHaveLength(0)
  })
  it('a business without Meta, or without a chosen account, is told who sets it up', async () => {
    h.connections = []
    expect((await run('meta-ads-graph-read', { path: 'act_1234567890' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect((await run('meta-ads-graph-read', { path: 'act_1234567890' })).error).toMatch(/No Meta ad account is chosen/)
  })
  it('graphSafe removes every next / previous link and masks a token anywhere', () => {
    expect(graphSafe({ a: 'x?access_token=T&y=1', paging: { next: 'n', previous: 'p', cursors: { after: 'c' } } })).toEqual({ a: 'x?access_token=[redacted]&y=1', paging: { cursors: { after: 'c' } } })
  })
})

describe('meta-ad-accounts', () => {
  it('chosen answers from Nexus with no Meta call', async () => {
    expect(await run('meta-ad-accounts', {})).toMatchObject({ ok: true, data: { connected: true, adAccount: { adAccountId: '1234567890' } } })
    expect(h.calls).toHaveLength(0)
  })
  it('a portfolio list marks the chosen one; one another business already picked is its id only (never which)', async () => {
    h.rows = [{ account_id: '1234567890', name: 'Shop A ads', account_status: 1 }, { account_id: '1234567891', name: 'Shop B ads', account_status: 2, currency: 'EUR' }]
    h.taken = [{ id: '1234567891' }]
    const res = await run('meta-ad-accounts', { list: 'owned' })
    expect((res.data as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ adAccountId: '1234567890', statusText: 'Active', chosenHere: true, takenByAnotherBusiness: false, edge: 'owned_ad_accounts' }),
      { adAccountId: '1234567891', chosenHere: false, takenByAnotherBusiness: true, edge: 'owned_ad_accounts' },
    ])
    expect(h.calls[0]).toMatchObject({ path: '9876543210/owned_ad_accounts' })
    // What the system user itself reaches is meta-connection view choices: no second list here.
    expect(() => tool('meta-ad-accounts').input.parse({ list: 'reachable' })).toThrow()
  })
  it('owned / client / pending read the chosen account\'s business portfolio', async () => {
    await run('meta-ad-accounts', { list: 'pending' })
    expect(h.calls.map((c) => c.path)).toEqual(['9876543210/pending_owned_ad_accounts', '9876543210/pending_client_ad_accounts'])
  })
  it('review B2 — a pending request is { id, ad_account }: the account is asked inside ad_account{…} and read from there', async () => {
    h.rows = [{ id: '700000000000001', ad_account: { account_id: '1234567892', name: 'Shop C ads', currency: 'EUR', timezone_name: 'Europe/Rome', account_status: 1, business: { id: '9876543210', name: 'Portfolio' } } }]
    const res = await run('meta-ad-accounts', { list: 'pending' })
    expect(h.calls[0].query).toMatchObject({ fields: 'id,ad_account{account_id,name,currency,timezone_name,account_status,business{id,name}}' })
    expect((res.data as { items: unknown[] }).items[0]).toEqual(expect.objectContaining({ adAccountId: '1234567892', name: 'Shop C ads', statusText: 'Active', requestId: '700000000000001', edge: 'pending_owned_ad_accounts' }))
    // The owned and client lists ask the account's own fields.
    h.calls.length = 0
    await run('meta-ad-accounts', { list: 'client' })
    expect(h.calls[0].query).toMatchObject({ fields: 'account_id,name,currency,timezone_name,account_status,business{id,name}' })
  })
  it('AA-002 — the owned and client lists take Meta\'s search_query; the pending lists have none (said so)', async () => {
    await run('meta-ad-accounts', { list: 'owned', search: 'shop' })
    await run('meta-ad-accounts', { list: 'client', search: 'shop' })
    expect(h.calls.map((c) => [c.path, c.query?.search_query])).toEqual([['9876543210/owned_ad_accounts', 'shop'], ['9876543210/client_ad_accounts', 'shop']])
    expect((await run('meta-ad-accounts', { list: 'pending', search: 'shop' })).error).toMatch(/no search for the pending lists/)
  })
})

describe('meta-ads-live and meta-ads-overview', () => {
  it('an insights window is at most 92 days', async () => {
    expect((await run('meta-ads-live', { view: 'insights', from: '2026-01-01', to: '2026-10-19' })).error).toMatch(/92 days/)
    expect(h.calls).toHaveLength(0)
  })
  it('insights read the chosen account; Meta applies each ad set\'s attribution setting (no ignored flag is sent)', async () => {
    await run('meta-ads-live', { view: 'insights', level: 'adset', from: '2026-10-19', to: '2026-10-20', daily: true })
    expect(h.calls[0]).toMatchObject({ path: 'act_1234567890/insights', query: { level: 'adset', time_increment: 1, time_range: { since: '2026-10-19', until: '2026-10-20' } } })
  })
  it('every live view asks only what the real gateway lets through (its query-key allow-list and fields rules)', async () => {
    h.known = new Map([['120000000000101', 'campaign'], ['120000000000201', 'adset']])
    for (const args of [
      { view: 'account' }, { view: 'campaigns', numbers: 'last_7d' }, { view: 'adsets', campaignId: '120000000000101', numbers: 'today' },
      { view: 'ads', adSetId: '120000000000201' }, { view: 'insights', level: 'ad', from: '2026-10-01', to: '2026-10-19', campaignId: '120000000000101' },
      { view: 'insights', level: 'account', from: '2026-10-19', to: '2026-10-19' }, { view: 'pages' }, { view: 'instagram' },
      { view: 'minimum-budgets' }, { view: 'ads-volume' },
    ]) await run('meta-ads-live', args)
    await run('meta-ad-accounts', { list: 'pending' })
    expect(h.calls.length).toBeGreaterThan(10)
    const refused = h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
    expect(refused).toEqual([])
  })
  it('review B5 — one campaign\'s ad sets and one ad set\'s ads through Meta\'s own edges, each checked to be the account\'s', async () => {
    h.known = new Map([['120000000000101', 'campaign'], ['120000000000201', 'adset']])
    await run('meta-ads-live', { view: 'adsets', campaignId: '120000000000101' })
    await run('meta-ads-live', { view: 'ads', adSetId: '120000000000201' })
    await run('meta-ads-live', { view: 'ads', campaignId: '120000000000101' })
    expect(h.calls.map((c) => [c.path, Object.keys(c.query ?? {}).sort().join(',')])).toEqual([
      ['120000000000101/adsets', 'effective_status,fields,limit'], ['120000000000201/ads', 'effective_status,fields,limit'], ['120000000000101/ads', 'effective_status,fields,limit'],
    ])
    h.calls.length = 0
    h.one = () => ({ account_id: '5550001112' })
    expect((await run('meta-ads-live', { view: 'adsets', campaignId: '120000000000999' })).error).toMatch(/does not belong to the ad account/)
    expect(h.calls.map((c) => c.operation)).toEqual(['graph.ownerCheck'])
  })
  it('review B1 — live insights include archived and deleted objects (an effective_status filter at each object level)', async () => {
    await run('meta-ads-live', { view: 'insights', level: 'ad', from: '2026-10-01', to: '2026-10-19', campaignId: '120000000000101' })
    expect(h.calls[0].query!.filtering).toEqual([
      { field: 'ad.effective_status', operator: 'IN', value: expect.arrayContaining(['ARCHIVED', 'DELETED']) },
      { field: 'campaign.id', operator: 'EQUAL', value: '120000000000101' },
    ])
    h.calls.length = 0
    await run('meta-ads-live', { view: 'insights', level: 'account', from: '2026-10-19', to: '2026-10-19' })
    expect(h.calls[0].query!.filtering).toBeUndefined()
  })
  it('review A4 — when Meta refuses the inline numbers, the list is read again without them and says so', async () => {
    const { MetaReadError, failureOfAnswer } = await import('../../marketing/meta-ads/errors.js')
    h.refuseAll = (req) => (String(req.query?.fields ?? '').includes('insights.date_preset')
      ? new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100', channelMessage: 'Unsupported field expansion' } as never }), req.operation, 1)
      : null)
    h.rows = [{ id: '120000000000101', name: 'Shop A campaign', status: 'ACTIVE' }]
    const res = await run('meta-ads-live', { view: 'campaigns', numbers: 'last_7d' })
    expect(res).toMatchObject({ ok: true, data: { numbers: null, numbersNote: expect.stringMatching(/refused the numbers inside the list.*view insights/) } })
    expect(h.calls.map((c) => String(c.query?.fields).includes('insights.'))).toEqual([true, false])
    // A throttle is never retried without numbers: it ends the read.
    h.calls.length = 0
    h.refuseAll = (req) => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'rate_limited', channelCode: '17', channelMessage: 'limit' } as never }), req.operation, 1)
    expect((await run('meta-ads-live', { view: 'campaigns', numbers: 'last_7d' })).ok).toBe(false)
    expect(h.calls).toHaveLength(1)
  })
  it('review A1 — a promoted Page or Instagram account another business uses is its id and the flag only', async () => {
    h.rows = [{ id: '120000000000010', name: 'Shop A Page' }, { id: '120000000000011', name: 'Shop B Page' }]
    h.taken = [{ id: '120000000000011' }]
    const pages = await run('meta-ads-live', { view: 'pages' })
    expect((pages.data as { items: unknown[] }).items).toEqual([
      { pageId: '120000000000010', name: 'Shop A Page', chosenHere: true, takenByAnotherBusiness: false },
      { pageId: '120000000000011', takenByAnotherBusiness: true },
    ])
    h.rows = [{ id: '170000000000002', username: 'shop_b' }]
    h.taken = [{ id: '170000000000002' }]
    const ig = await run('meta-ads-live', { view: 'instagram' })
    expect((ig.data as { items: unknown[] }).items).toEqual([{ instagramId: '170000000000002', takenByAnotherBusiness: true }])
    expect(JSON.stringify([pages, ig])).not.toMatch(/Shop B Page|shop_b/)
  })
  it('review A8 — the context view\'s share of spend is money', () => {
    expect(tool('meta-ads-overview').restrictedFields).toMatchObject({ spendShare: 'financials.adspend.view' })
  })
  it('benchmarks: Meta has no public API for them, said plainly', async () => {
    expect(await run('meta-ads-overview', { view: 'benchmarks' })).toMatchObject({ ok: true, data: { sentence: expect.stringMatching(/no public API.*Meta's own MCP/) } })
  })
  it('the weekly trend counts read days only and marks a week with a day not read', async () => {
    const res = await run('meta-ads-overview', { view: 'trend' })
    const weeks = (res.data as { weeks: Array<Record<string, unknown>> }).weeks
    expect(weeks.map((w) => [w.daysRead, w.complete, w.spendCents, w.cpcCents, w.roas])).toEqual([[7, true, 7000, 100, 5], [6, false, 6000, 100, 5]])
    expect(weeklyTrend([])).toEqual([])
  })
})
