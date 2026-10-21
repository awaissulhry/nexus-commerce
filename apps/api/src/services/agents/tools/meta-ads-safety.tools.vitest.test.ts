/**
 * Meta ads step 16 — meta-brand-safety and meta-webhooks. Block lists only when they are the chosen ad account's or its
 * portfolio's, content block lists only the portfolio's, delivery reports only for the chosen account's own ad sets (Nexus's
 * rows, else one live check of account and kind); D6: when Meta refuses for its capability grant, the answer says so and
 * names the no-grant controls; Meta's "not available" and PUT-only reads answer in words with no call; webhooks read the
 * app's subscriptions with the app token and never show a secret; alert thresholds are money (cents). Every call passes the
 * real gateway verdict. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown>; auth?: unknown }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Req & { via: string }>,
  graph: null as null | ((req: Req) => unknown),
  app: null as null | ((req: Req) => { status: number; text: string }),
  taken: new Set<string>(),
  adSets: new Set<string>(),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../cx/token.service.js', () => ({ metaAppIdOf: vi.fn(async () => '5550000001') }))
vi.mock('../../marketing/meta-ads/read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push({ ...req, via: 'graph' })
    const body = h.graph?.(req) ?? {}
    if (body instanceof Error) throw body
    return { body, calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))
vi.mock('../../gateway/meta.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../gateway/meta.js')>()
  return {
    ...real,
    metaCall: vi.fn(async (req: Req) => {
      h.calls.push({ ...req, via: 'metaCall' })
      const a = h.app?.(req) ?? { status: 200, text: '{"data":[]}' }
      return { outcome: 'sent', ok: a.status < 400, status: a.status, text: a.text, verdict: null, json: () => JSON.parse(a.text), headers: new Headers(), url: '', attempts: 1, rate: { remaining: null, limit: null } }
    }),
  }
})
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) },
    metaAdsAdSet: { findFirst: vi.fn(async ({ where }: { where: { adSetId: string } }) => (h.adSets.has(where.adSetId) ? { id: 'x' } : null)) },
    metaAdsAd: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async (_s: unknown, _product: unknown, ids: string[]) => ids.filter((id) => h.taken.has(id)).map((id) => ({ id }))),
  },
}))

import { META_ADS_SAFETY_TOOLS } from './meta-ads-safety.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_SAFETY_TOOLS.find((t) => t.name === name)!
const can = (granted: string[] = ['ads.view']) => ({ can: (p: string) => granted.includes(p), via: 'claude' as const })
const run = (name: string, args: Record<string, unknown>, ctx = can()) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const PAGE = '120000000000010'
const PORTFOLIO = '9876543210'
const ADSET = '120000000000201'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE }, instagram: null, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation', status = 400) => new MetaReadError(failureOfAnswer({ status, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const refusedByGateway = () => h.calls
  .map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read', auth: c.auth })])
  .filter(([, problem]) => problem)

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.graph = null; h.app = null; h.taken = new Set(); h.adSets = new Set([ADSET]) })

describe('the two tools are reads', () => {
  it('none changes anything; both reach Meta; an alert threshold is money', () => {
    for (const t of META_ADS_SAFETY_TOOLS) expect({ readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, requires: t.requires }).toEqual({ readOnly: true, execute: undefined, openWorld: true, requires: ['ads.view'] })
    expect(tool('meta-webhooks').restrictedFields).toEqual({ thresholdCents: 'financials.adspend.view', valueCents: 'financials.adspend.view' })
    expect(tool('meta-brand-safety').restrictedFields).toBeUndefined()
  })
})

describe('meta-brand-safety', () => {
  it('block-lists: the chosen ad account\'s, with fixed fields', async () => {
    h.graph = () => ({ data: [{ id: '120000000000901', name: 'Apps', items_count: 12, owner_ad_account_id: '1234567890', is_auto_blocking_on: true }] })
    const res = await run('meta-brand-safety', { view: 'block-lists' })
    expect(h.calls[0]).toMatchObject({ path: 'act_1234567890/publisher_block_lists', query: { fields: 'id,name,last_update_user,last_update_time,business_owner_id,owner_ad_account_id,items_count,is_auto_blocking_on' } })
    expect((res.data as { items: unknown[] }).items).toEqual([expect.objectContaining({ blockListId: '120000000000901', items: 12, ownerAdAccountId: '1234567890', autoBlocking: true })])
    expect(refusedByGateway()).toEqual([])
  })
  it('block-list: only the account\'s or the portfolio\'s; people\'s roles only for someone who may see the team; applied ad accounts masked', async () => {
    h.graph = () => ({ id: '120000000000902', name: 'Foreign', owner_ad_account_id: '5550001112', business_owner_id: '5550009999' })
    expect((await run('meta-brand-safety', { view: 'block-list', blockListId: '120000000000902' })).error).toMatch(/not the chosen ad account's or its business portfolio's/)
    expect(h.calls).toHaveLength(1)
    h.calls.length = 0
    h.graph = (req) => {
      if (req.path === '120000000000901') return { id: '120000000000901', name: 'Apps', business_owner_id: PORTFOLIO, web_publishers: [{ domain_url: 'example.com', publisher_name: 'Example', id: '1' }] }
      if (req.path.endsWith('/agencies')) return { data: [{ id: '5550000002', name: 'Agency' }] }
      if (req.path.endsWith('/assigned_users')) return { data: [{ id: '700000000000001', name: 'A person', permitted_roles: ['APPLY_BLOCK_LIST'] }] }
      return { data: [{ id: 'act_1234567890' }, { id: 'act_1234567891' }] }
    }
    h.taken = new Set(['1234567891'])
    const res = await run('meta-brand-safety', { view: 'block-list', blockListId: '120000000000901', items: true })
    expect(res.data).toMatchObject({
      blockList: { blockListId: '120000000000901', ownerBusinessId: PORTFOLIO }, webPublishers: { items: [{ url: 'example.com' }], total: 1, cut: false },
      sharedWithBusinesses: [{ businessId: '5550000002', name: 'Agency' }], peopleRoles: null, peopleRolesNotRead: expect.stringMatching(/Team & access/),
      appliedToAdAccounts: [{ adAccountId: '1234567890', chosenHere: true, takenByAnotherBusiness: false }, { adAccountId: '1234567891', takenByAnotherBusiness: true }],
    })
    expect(h.calls.map((c) => c.path)).not.toContain('120000000000901/assigned_users')
    h.calls.length = 0
    const team = await run('meta-brand-safety', { view: 'block-list', blockListId: '120000000000901' }, can(['ads.view', 'users.manage']))
    expect(team.data).toMatchObject({ peopleRoles: [{ userId: '700000000000001', roles: ['APPLY_BLOCK_LIST'] }] })
    expect(h.calls.find((c) => c.path.endsWith('/assigned_users'))?.query).toMatchObject({ business_id: PORTFOLIO })
    expect(refusedByGateway()).toEqual([])
  })
  it('D6 — when Meta has not granted the capability, the answer says so and names the controls that need no grant', async () => {
    h.graph = () => metaError('200', 'Application does not have the capability to make this API call', 'forbidden', 403)
    const res = await run('meta-brand-safety', { view: 'block-lists' })
    expect(res.error).toMatch(/^Meta has not granted this capability to the business \(block_list_management_v2_api_access\)/)
    expect(res.error).toMatch(/no-grant controls are the inventory filter .*placement .*excluded publisher categories/)
    expect((await run('meta-brand-safety', { view: 'content-block-lists' })).error).toMatch(/brand_safety_content_block_list/)
    expect((await run('meta-brand-safety', { view: 'partner-publishers', position: 'instream_video' })).error).toMatch(/brand_safety_third_party_partners/)
    expect((await run('meta-brand-safety', { view: 'adjacent-report-dates', platform: 'instagram', position: 'reels' })).error).toMatch(/brand_safety_feed_verification/)
  })
  it('content-block-list: only the portfolio\'s; its posts per platform; the ad accounts using it, another business\'s masked', async () => {
    h.graph = () => ({ id: '120000000000701', name: 'Risky', business: { id: '5550009999' } })
    expect((await run('meta-brand-safety', { view: 'content-block-list', contentBlockListId: '120000000000701' })).error).toMatch(/not the business portfolio's/)
    h.graph = (req) => (req.path === '120000000000701' ? { id: '120000000000701', name: 'Risky', business: { id: PORTFOLIO } }
      : req.path.endsWith('/instagram_content') ? { data: [{ id: '178000000000001' }], paging: { cursors: { after: 'c' }, next: 'n' } }
        : { data: [{ id: '1234567891', account_id: 'act_1234567891' }] })
    h.taken = new Set(['1234567891'])
    const res = await run('meta-brand-safety', { view: 'content-block-list', contentBlockListId: '120000000000701', content: 'instagram' })
    expect(res.data).toMatchObject({ content: { platform: 'instagram', ids: ['178000000000001'], nextAfter: 'c' }, appliedToAdAccounts: [{ adAccountId: '1234567891', takenByAnotherBusiness: true }] })
    expect(h.calls.map((c) => [c.path, c.query?.fields])).toEqual([
      ['120000000000701', 'id,name,business'], ['120000000000701', 'id,name,business'], ['120000000000701/instagram_content', 'id'], ['120000000000701/applied_ad_accounts', 'id,account_id'],
    ])
    expect(refusedByGateway()).toEqual([])
  })
  it('what Meta cannot do (yet) answers in words with no call: the account\'s content block lists, one post\'s check, the CSV (a PUT)', async () => {
    expect((await run('meta-brand-safety', { view: 'account-content-block-lists' })).data).toMatchObject({ available: false, sentence: expect.stringMatching(/planned but not yet available/) })
    expect((await run('meta-brand-safety', { view: 'content-block-list-file' })).data).toMatchObject({ available: false, comesWith: 'step 39', sentence: expect.stringMatching(/^The CSV export of a content block list comes with step 39 \(Nexus brand-safety changes\)/) })
    expect(h.calls).toHaveLength(0)
  })
  it('publisher-report: only an ad set of the chosen account (Nexus\'s rows, else account and kind live); Meta\'s parameters', async () => {
    h.graph = (req) => (req.path === '120000000000299' ? { account_id: '5550001112', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' } : { data: [{ url: 'www.facebook.com/example1', name: 'Acme', estimated_impressions: 4823, content_types: ['vod'], status: 'partner' }], summary: { total_count: 1 } })
    expect((await run('meta-brand-safety', { view: 'publisher-report', adSetId: '120000000000299', platform: 'facebook', position: 'instream_video' })).error).toMatch(/does not belong to the ad account/)
    h.graph = (req) => (req.path === '120000000000298' ? metaError('100', '(#100) Tried accessing nonexisting field (optimization_goal) on node type (Adgroup)') : {})
    expect((await run('meta-brand-safety', { view: 'publisher-report', adSetId: '120000000000298', platform: 'facebook', position: 'instream_video' })).error).toMatch(/not an ad set/)
    expect(h.calls.map((c) => c.operation)).toEqual(['safety.adSetCheck', 'safety.adSetCheck'])
    h.calls.length = 0
    h.graph = () => ({ data: [{ url: 'www.facebook.com/example1', name: 'Acme', estimated_impressions: 4823, content_types: ['vod'], status: 'partner' }], summary: { total_count: 1, start_date: '2026-09-21', end_date: '2026-10-20' } })
    const res = await run('meta-brand-safety', { view: 'publisher-report', adSetId: ADSET, platform: 'facebook', position: 'instream_video', publisherStatus: 'partner', from: '2026-10-01', to: '2026-10-20' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ path: `${ADSET}/publisher_delivery_report`, query: { platform: 'facebook', position: 'instream_video', publisher_status: 'partner', start_date: '2026-10-01', end_date: '2026-10-20', summary: 'true', fields: 'url,name,estimated_impressions,content_types,status' } })
    expect(h.calls[0].query!.limit).toBeUndefined()
    expect(res.data).toMatchObject({ items: [{ url: 'www.facebook.com/example1', estimatedImpressions: 4823 }], summary: { total_count: 1 } })
    expect((await run('meta-brand-safety', { view: 'publisher-report', adSetId: ADSET, platform: 'facebook', position: 'instream_video', from: '2026-10-01' })).error).toMatch(/from and to together/)
    expect(refusedByGateway()).toEqual([])
  })
  it('content-report, adjacent-report and their dates: one hour in Pacific Time; the platform fixed where Meta has one', async () => {
    expect(() => tool('meta-brand-safety').input.parse({ view: 'content-report', adSetId: ADSET, position: 'instream_video', datetime: '2026-10-20T10:30' })).toThrow()
    await run('meta-brand-safety', { view: 'content-report', adSetId: ADSET, position: 'facebook_reels_overlay', datetime: '2026-10-20T10:00' })
    await run('meta-brand-safety', { view: 'adjacent-report', adSetId: ADSET, platform: 'instagram', position: 'feed', limit: 10 })
    await run('meta-brand-safety', { view: 'content-report-dates', position: 'instream_video' })
    await run('meta-brand-safety', { view: 'adjacent-report-dates', platform: 'threads', position: 'reels' })
    await run('meta-brand-safety', { view: 'publisher-report-dates', platform: 'audience_network', position: 'an_classic' })
    expect(h.calls.map((c) => [c.path, c.query])).toEqual([
      [`${ADSET}/content_delivery_report`, { platform: 'facebook', position: 'facebook_reels_overlay', datetime: '2026-10-20T10:00', fields: 'content_id,creator_id,estimated_impressions', summary: 'true' }],
      [`${ADSET}/adjacent_content_delivery_report`, { platform: 'instagram', position: 'feed', limit: 25 }],
      ['content_delivery_report_date_ranges', { platform: 'facebook', position: 'instream_video', fields: 'earliest_datetime,latest_datetime' }],
      ['adjacent_content_delivery_report_date_ranges', { platform: 'threads', position: 'reels', fields: 'earliest_datetime,latest_datetime,missing_datetimes' }],
      ['publisher_delivery_report_date_ranges', { platform: 'audience_network', position: 'an_classic', fields: 'start_date,end_date' }],
    ])
    expect((await run('meta-brand-safety', { view: 'content-report-dates' })).error).toMatch(/Name the placement/)
    expect(refusedByGateway()).toEqual([])
  })
  it('content-lookup: a video or Page found in a report; one of another business is its id and the flag only', async () => {
    h.taken = new Set(['120000000000011'])
    expect((await run('meta-brand-safety', { view: 'content-lookup', pageId: '120000000000011' })).data).toMatchObject({ pageId: '120000000000011', takenByAnotherBusiness: true })
    expect(h.calls).toHaveLength(0)
    h.graph = () => ({ id: '773000000000001', permalink_url: '/x/videos/773000000000001/', from: { id: '120000000000011', name: 'Shop B' }, source: 'https://video.example/x.mp4' })
    const res = await run('meta-brand-safety', { view: 'content-lookup', videoId: '773000000000001' })
    expect(res.data).toMatchObject({ videoId: '773000000000001', pageId: '120000000000011', takenByAnotherBusiness: true })
    expect(JSON.stringify(res)).not.toMatch(/Shop B|video\.example/)
    expect(h.calls[0].query!.fields).toBe('id,permalink_url,created_time,updated_time,from{id,name},description,picture')
    h.graph = () => ({ id: '120000000000030', name: 'Creator', category: 'Video creator' })
    expect((await run('meta-brand-safety', { view: 'content-lookup', pageId: '120000000000030' })).data).toMatchObject({ page: { pageId: '120000000000030', name: 'Creator', category: 'Video creator' } })
    expect(refusedByGateway()).toEqual([])
  })
  it('partner-publishers: the fields of the platform asked; Facebook needs its position; the metadata of every placement', async () => {
    expect((await run('meta-brand-safety', { view: 'partner-publishers', platform: 'facebook' })).error).toMatch(/Name the position for Facebook/)
    await run('meta-brand-safety', { view: 'partner-publishers', platform: 'facebook', position: 'facebook_reels_overlay', followerCount: 'between_100K_and_1M', blueVerified: 'yes', search: 'moto' })
    await run('meta-brand-safety', { view: 'partner-publishers', platform: 'audience_network', appCategory: 'Sports' })
    await run('meta-brand-safety', { view: 'partner-publishers-dates' })
    expect(h.calls[0].query).toMatchObject({ platform: 'facebook', position: 'facebook_reels_overlay', follower_count: 'between_100K_and_1M', blue_verified: 'yes', search_query: 'moto', include_summary: true, fields: expect.stringContaining('page_followers') })
    expect(h.calls[1].query).toMatchObject({ platform: 'audience_network', app_store_category_contains: 'Sports', fields: expect.stringContaining('app_store_category') })
    expect(h.calls[1].query!.position).toBeUndefined()
    expect(h.calls[2].path).toBe('brand_safety_publisher_list_metadata')
    expect(refusedByGateway()).toEqual([])
  })
})

describe('meta-webhooks', () => {
  it('all: the app\'s subscriptions with the APP token, the ad account\'s and the Page\'s apps, the alerts — each part on its own', async () => {
    h.app = () => ({ status: 200, text: JSON.stringify({ data: [{ object: 'ad_account', callback_url: 'https://nexus.example/hooks/catch/123456/abcSECRETkey/?verify=s3cret', active: true, fields: [{ name: 'effective_status', version: 'v26.0' }, 'creative_fatigue'] }] }) })
    h.graph = (req) => {
      if (req.path === 'act_1234567890/subscribed_apps') return { data: [{ app_id: '5550000001', app_name: 'Nexus' }, { app_id: '5550000009', app_name: 'Other' }] }
      if (req.path === `${PAGE}/subscribed_apps`) return metaError('200', 'Requires a Page access token', 'forbidden', 403)
      return { data: [{ subscription_id: '900000000000001', event_type: 'INSIGHTS_UPDATED', field: 'cpc', value: '200', operator: 'GREATER_THAN', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }, { field: 'daily_budget', value: '1000,5000', operator: 'IN_RANGE' }], status: 'ENABLED' }, { subscription_id: '900000000000002', event_type: 'INSIGHTS_UPDATED', field: 'ctr', value: '0.5', operator: 'LESS_THAN' }] }
    }
    const res = await run('meta-webhooks', {})
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.appSubscriptions).toEqual([{ object: 'ad_account', callbackUrl: 'https://nexus.example', active: true, fields: ['effective_status', 'creative_fatigue'] }])
    expect(JSON.stringify(data)).not.toMatch(/s3cret|abcSECRETkey|hooks\/catch/)
    expect(data.adAccountApps).toEqual([{ appId: '5550000001', appName: 'Nexus', isNexusApp: true }, { appId: '5550000009', appName: 'Other', isNexusApp: false }])
    expect(data.pageApps).toBeNull()
    expect(data.pageAppsNotRead).toMatch(/Page access token.*step 30/)
    expect(data.alertSubscriptions).toEqual([
      { subscriptionId: '900000000000001', eventType: 'INSIGHTS_UPDATED', status: 'ENABLED', field: 'cpc', operator: 'GREATER_THAN', thresholdCents: 200, filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'AD' }, { field: 'daily_budget', operator: 'IN_RANGE', valueCents: [1000, 5000] }] },
      { subscriptionId: '900000000000002', eventType: 'INSIGHTS_UPDATED', status: null, field: 'ctr', operator: 'LESS_THAN', threshold: '0.5', filters: [] },
    ])
    const app = h.calls.find((c) => c.via === 'metaCall')!
    expect(app).toMatchObject({ path: '5550000001/subscriptions', auth: 'app', query: { fields: 'object,callback_url,fields,active' } })
    expect(refusedByGateway()).toEqual([])
  })
  it('alerts: one subscription by id; another view reads only its part', async () => {
    h.graph = () => ({ subscription_id: '900000000000001', event_type: 'OBJECT_CREATED', filters: [{ field: 'entity_type', value: 'CAMPAIGN', operator: 'EQUAL' }] })
    const res = await run('meta-webhooks', { view: 'alerts', subscriptionId: '900000000000001' })
    expect(h.calls.map((c) => c.path)).toEqual(['act_1234567890/subscriptions/900000000000001'])
    expect(res.data).toMatchObject({ alertSubscriptions: [{ subscriptionId: '900000000000001', eventType: 'OBJECT_CREATED' }] })
    expect(res.data).not.toHaveProperty('appSubscriptions')
    expect(refusedByGateway()).toEqual([])
  })
  it('a business without Meta is told who connects it', async () => {
    h.connections = []
    expect((await run('meta-webhooks', {})).error).toMatch(/Settings › Channels › Meta/)
    expect((await run('meta-brand-safety', { view: 'block-lists' })).error).toMatch(/Settings › Channels › Meta/)
  })
})

describe('step 16 review fixes', () => {
  it('A5 — a block list owned by an ad account another business in Nexus uses: its id and the flag only, nothing more read', async () => {
    h.taken = new Set(['1234567891'])
    h.graph = () => ({ data: [{ id: '120000000000901', name: 'Ours', owner_ad_account_id: '1234567890' }, { id: '120000000000903', name: 'Shop B list', owner_ad_account_id: 'act_1234567891' }] })
    const list = await run('meta-brand-safety', { view: 'block-lists' })
    expect((list.data as { items: unknown[] }).items).toEqual([expect.objectContaining({ blockListId: '120000000000901', name: 'Ours' }), { blockListId: '120000000000903', takenByAnotherBusiness: true }])
    h.calls.length = 0
    h.graph = () => ({ id: '120000000000903', name: 'Shop B list', owner_ad_account_id: '1234567891', business_owner_id: PORTFOLIO })
    const one = await run('meta-brand-safety', { view: 'block-list', blockListId: '120000000000903' }, can(['ads.view', 'users.manage']))
    expect(one.data).toEqual({ adAccountId: '1234567890', blockListId: '120000000000903', takenByAnotherBusiness: true })
    expect(h.calls).toHaveLength(1)
    expect(JSON.stringify([list, one])).not.toContain('Shop B list')
  })
  it('B2 — when Meta refuses items_count, the block list is read again without it, and says so', async () => {
    h.graph = (req) => (String(req.query?.fields).includes('items_count') ? metaError('100', 'Tried accessing nonexisting field (items_count)') : { data: [{ id: '120000000000901', name: 'Ours', owner_ad_account_id: '1234567890' }] })
    const res = await run('meta-brand-safety', { view: 'block-lists' })
    expect(h.calls.map((c) => String(c.query?.fields).includes('items_count'))).toEqual([true, false])
    expect(res.data).toMatchObject({ itemsCountNote: expect.stringMatching(/refused items_count/), items: [{ blockListId: '120000000000901' }] })
    expect(refusedByGateway()).toEqual([])
  })
  it('B3 — AS-018: when Meta has no ad-set adjacent report, it says Meta gives it only as a business-wide file Nexus does not read', async () => {
    h.graph = () => metaError('100/33', 'Unsupported get request. Object with ID does not support this operation', 'not_found')
    const res = await run('meta-brand-safety', { view: 'adjacent-report', adSetId: ADSET, platform: 'facebook', position: 'feed' })
    expect(res.error).toMatch(/only as a business-wide file covering every ad account of the portfolio; Nexus does not read it/)
    // The grant refusal stays the D6 sentence.
    h.graph = () => metaError('3', 'Application does not have the capability to make this API call', 'forbidden', 403)
    expect((await run('meta-brand-safety', { view: 'adjacent-report', adSetId: ADSET, platform: 'facebook', position: 'feed' })).error).toMatch(/brand_safety_feed_verification.*no-grant controls/)
  })
  it('B7 — a video Meta will not show is answered in Meta\'s own words, not as the delivery-report grant', async () => {
    h.graph = () => metaError('10', 'Permission denied for this video', 'forbidden', 403)
    const res = await run('meta-brand-safety', { view: 'content-lookup', videoId: '773000000000002' })
    expect(res.error).toMatch(/Permission denied for this video.*Page Public Content Access/)
    expect(res.error).not.toMatch(/brand_safety_third_party_partners|capability/)
  })
})
