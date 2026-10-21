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
  app: null as null | ((req: Req) => { status: number; text: string; verdict?: Record<string, unknown> }),
  taken: new Set<string>(),
  adSets: new Set<string>(),
  // Step 39 (BS-033) — what the content block list's CSV export answers.
  exported: { status: 200, text: '{}' } as { status: number; text: string; verdict?: Record<string, unknown> },
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
      return { outcome: 'sent', ok: a.status < 400, status: a.status, text: a.text, verdict: a.verdict ?? null, json: () => JSON.parse(a.text), headers: new Headers(), url: '', attempts: 1, rate: { remaining: null, limit: null } }
    }),
    metaRestFileExport: vi.fn(async (req: { operation: string; contentBlockListId: string }) => {
      h.calls.push({ operation: req.operation, path: `content_block_lists/${req.contentBlockListId}/file_download`, via: 'export' })
      const a = h.exported
      return { outcome: 'sent', ok: a.status < 400, status: a.status, text: a.text, verdict: a.verdict ?? null, json: () => JSON.parse(a.text), headers: new Headers(), url: '', attempts: 1, rate: { remaining: null, limit: null } }
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

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.graph = null; h.app = null; h.taken = new Set(); h.adSets = new Set([ADSET]); h.exported = { status: 200, text: '{}' } })

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
    expect(res.error).toMatch(/^Meta has not granted this capability: the app needs Meta's block_list_management_v2_api_access grant\./)
    expect(res.error).toMatch(/no-grant controls are the inventory filter .*placement .*excluded publisher categories .*set-meta-brand-safety/)
    expect((await run('meta-brand-safety', { view: 'content-block-lists' })).error).toMatch(/brand_safety_content_block_list/)
    expect((await run('meta-brand-safety', { view: 'partner-publishers', position: 'instream_video' })).error).toMatch(/brand_safety_third_party_partners/)
    expect((await run('meta-brand-safety', { view: 'adjacent-report-dates', platform: 'instagram', position: 'reels' })).error).toMatch(/brand_safety_feed_verification/)
  })
  it('content-block-list: only the portfolio\'s; its posts per platform; the ad accounts using it, another business\'s masked', async () => {
    h.graph = () => ({ id: '120000000000701', name: 'Risky', business: { id: '5550009999' } })
    expect((await run('meta-brand-safety', { view: 'content-block-list', contentBlockListId: '120000000000701' })).error).toMatch(/not the business portfolio's/)
    h.graph = (req) => (req.path === '120000000000701' ? { id: '120000000000701', name: 'Risky', business: { id: PORTFOLIO } }
      : req.path === `${PORTFOLIO}/content_block_lists` ? { data: [{ id: '120000000000701' }] }
        : req.path.endsWith('/instagram_content') ? { data: [{ id: '178000000000001' }], paging: { cursors: { after: 'c' }, next: 'n' } }
          : { data: [{ id: '1234567891', account_id: 'act_1234567891' }] })
    h.taken = new Set(['1234567891'])
    const res = await run('meta-brand-safety', { view: 'content-block-list', contentBlockListId: '120000000000701', content: 'instagram' })
    expect(res.data).toMatchObject({ content: { platform: 'instagram', ids: ['178000000000001'], nextAfter: 'c' }, appliedToAdAccounts: [{ adAccountId: '1234567891', takenByAnotherBusiness: true }] })
    expect(h.calls.map((c) => [c.path, c.query?.fields])).toEqual([
      ['120000000000701', 'id,name,business'], ['120000000000701', 'id,name,business'], [`${PORTFOLIO}/content_block_lists`, 'id'], ['120000000000701/instagram_content', 'id'], ['120000000000701/applied_ad_accounts', 'id,account_id'],
    ])
    expect(refusedByGateway()).toEqual([])
  })
  it('step 39 review A1 — an id of the portfolio that is no content block list (a catalog also answers business) is not read as one', async () => {
    h.graph = (req) => (req.path === '120000000000801' ? { id: '120000000000801', name: 'Catalog A', business: { id: PORTFOLIO } }
      : req.path === `${PORTFOLIO}/content_block_lists` ? (req.query?.after ? { data: [{ id: '120000000000702' }] } : { data: [{ id: '120000000000701' }], paging: { cursors: { after: 'p2' }, next: 'n' } })
        : { data: [] })
    for (const view of ['content-block-list', 'content-block-list-file']) {
      h.calls.length = 0
      expect((await run('meta-brand-safety', { view, contentBlockListId: '120000000000801' })).error, view).toMatch(/not one of the business portfolio's content block lists/)
      expect(h.calls.map((c) => [c.path, c.query?.after ?? null]), view).toEqual([['120000000000801', null], [`${PORTFOLIO}/content_block_lists`, null], [`${PORTFOLIO}/content_block_lists`, 'p2']])
    }
    expect(h.calls.some((c) => c.via === 'export')).toBe(false)
  })
  it('what Meta cannot do (yet) answers in words with no call: the account\'s content block lists, one post\'s check', async () => {
    expect((await run('meta-brand-safety', { view: 'account-content-block-lists' })).data).toMatchObject({ available: false, sentence: expect.stringMatching(/planned but not yet available/) })
    expect(h.calls).toHaveLength(0)
  })
  it('step 39 (BS-033) — content-block-list-file: only the portfolio\'s own list; Meta makes the CSV; its name, size and counts — never the download link', async () => {
    expect((await run('meta-brand-safety', { view: 'content-block-list-file' })).error).toMatch(/Name the content block list/)
    h.graph = () => ({ id: '120000000000701', name: 'Posts A', business: { id: '5550009999' } })
    expect((await run('meta-brand-safety', { view: 'content-block-list-file', contentBlockListId: '120000000000701' })).error).toMatch(/not the business portfolio's/)
    expect(h.calls.map((c) => c.via)).toEqual(['graph'])
    h.calls.length = 0
    h.graph = (req) => (req.path === `${PORTFOLIO}/content_block_lists` ? { data: [{ id: '120000000000701' }] } : { id: '120000000000701', name: 'Posts A', business: { id: PORTFOLIO } })
    h.exported = { status: 200, text: JSON.stringify({ content_block_list_id: '120000000000701', download_url: 'https://example.com/content_ids.csv?oh=abc&oe=def', file_metadata: { name: 'content_ids.csv', size_bytes: 2048, facebook_content_count: 3, instagram_content_count: 4 } }) }
    const res = await run('meta-brand-safety', { view: 'content-block-list-file', contentBlockListId: '120000000000701' })
    expect(h.calls.map((c) => [c.via, c.path])).toEqual([['graph', '120000000000701'], ['graph', `${PORTFOLIO}/content_block_lists`], ['export', 'content_block_lists/120000000000701/file_download']])
    expect(res.data).toMatchObject({ contentBlockList: { contentBlockListId: '120000000000701', name: 'Posts A' }, file: { name: 'content_ids.csv', sizeBytes: 2048, facebookPosts: 3, instagramPosts: 4 }, sentence: expect.stringMatching(/does not show its download link/) })
    expect(JSON.stringify(res)).not.toMatch(/example\.com|oh=|download_url/)
    // D6: Meta refusing the export for its grant names the grant and the no-grant controls.
    h.exported = { status: 403, text: '{"error":{"code":200}}', verdict: { errorClass: 'forbidden', channelCode: '200', channelMessage: '(#200) Permissions error' } }
    expect((await run('meta-brand-safety', { view: 'content-block-list-file', contentBlockListId: '120000000000701' })).error).toMatch(/^Meta has not granted this capability: the app needs Meta's brand_safety_content_block_list grant\..*The no-grant controls are the inventory filter/)
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
    expect(data.pageAppsNotRead).toMatch(/only to the Page's own token.*Manage, Create content or Moderate.*set-meta-webhooks install-page installs the app on the Page/)
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
  it('step 12 rounds 2–3 — Meta refusing the APP token (190) ends only the app part; a throttle in a part keeps the parts read (as #706)', async () => {
    h.app = () => ({ status: 400, text: '{"error":{"code":190}}', verdict: { errorClass: 'auth_revoked', channelCode: '190', channelMessage: 'Invalid OAuth access token' } })
    h.graph = (req) => (req.path === 'act_1234567890/subscribed_apps' ? { data: [{ app_id: '5550000001', app_name: 'Nexus' }] } : { data: [] })
    const res = await run('meta-webhooks', {})
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.appSubscriptions).toBeNull()
    expect(data.appSubscriptionsNotRead).toBe('Meta does not accept the app token; check the app id / secret in Settings › Channels › Meta.')
    expect(data.adAccountApps).toEqual([{ appId: '5550000001', appName: 'Nexus', isNexusApp: true }])
    expect(data.alertSubscriptions).toEqual([])
    h.app = () => ({ status: 400, text: '{"error":{"code":17}}', verdict: { errorClass: 'rate_limited', channelCode: '17', channelMessage: 'User request limit reached' } })
    const throttled = await run('meta-webhooks', {})
    expect(throttled.ok).toBe(true)
    expect(throttled.data).toMatchObject({ appSubscriptions: null, appSubscriptionsNotRead: expect.stringMatching(/slow down/), adAccountApps: [{ appId: '5550000001' }] })
    h.app = null
    h.graph = (req) => (req.path === 'act_1234567890/subscribed_apps' ? metaError('17', 'User request limit reached', 'rate_limited') : { data: [] })
    expect((await run('meta-webhooks', {})).data).toMatchObject({ adAccountApps: null, adAccountAppsNotRead: expect.stringMatching(/slow down/), alertSubscriptions: [] })
  })
  it('step 12 round 3 — a throttle in one part of a block list or content block list keeps the parts read (as #706)', async () => {
    h.graph = (req) => {
      if (req.path === '120000000000901') return { id: '120000000000901', name: 'Apps', business_owner_id: PORTFOLIO }
      if (req.path.endsWith('/agencies')) return metaError('17', 'User request limit reached', 'rate_limited')
      return { data: [{ id: 'act_1234567890' }] }
    }
    expect((await run('meta-brand-safety', { view: 'block-list', blockListId: '120000000000901' })).data).toMatchObject({
      sharedWithBusinesses: null, sharedWithNotRead: expect.stringMatching(/slow down/), appliedToAdAccounts: [{ adAccountId: '1234567890' }],
    })
    h.graph = (req) => (req.path === '120000000000701' ? { id: '120000000000701', name: 'Risky', business: { id: PORTFOLIO } }
      : req.path.endsWith('/instagram_content') ? metaError('17', 'User request limit reached', 'rate_limited')
        // Step 39 — a content block list is the portfolio's own only when its content_block_lists list names it.
        : req.path.endsWith('/content_block_lists') ? { data: [{ id: '120000000000701' }] }
          : { data: [{ id: '1234567890', account_id: 'act_1234567890' }] })
    expect((await run('meta-brand-safety', { view: 'content-block-list', contentBlockListId: '120000000000701', content: 'instagram' })).data).toMatchObject({
      content: { ids: null, notRead: expect.stringMatching(/slow down/) }, appliedToAdAccounts: [{ adAccountId: '1234567890' }],
    })
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
