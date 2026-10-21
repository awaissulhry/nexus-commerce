/**
 * Meta ads step 16 — meta-partnership-content and meta-ad-library. Each view reads only the business's chosen portfolio,
 * Page and Instagram account (the Ad Library apart), asks fixed fields and only the parameters the gateway allows on that
 * route (checked against the real gateway verdict), keeps big Page ids exact, answers a Page or Instagram account another
 * business uses by its id and the flag only, and says in words what Meta needs when it refuses. Meta and the database are
 * stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Req & { host: 'graph' | 'rest' }>,
  graph: null as null | ((req: Req) => unknown),
  rest: null as null | ((req: Req) => { status: number; text: string; verdict?: Record<string, unknown> }),
  taken: new Set<string>(),
  all: [] as Record<string, unknown>[],
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push({ ...req, host: 'graph' })
    const body = h.graph?.(req) ?? {}
    if (body instanceof Error) throw body
    return { body, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push({ ...req, host: 'graph' })
    onRows(h.all)
    return { rows: h.all.length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../gateway/meta.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../gateway/meta.js')>()
  return {
    ...real,
    metaRestCall: vi.fn(async (req: Req) => {
      h.calls.push({ ...req, host: 'rest' })
      const a = h.rest?.(req) ?? { status: 200, text: '[]' }
      return { outcome: 'sent', ok: a.status < 400, status: a.status, text: a.text, verdict: a.verdict ?? null, json: () => JSON.parse(a.text), headers: new Headers(), url: '', attempts: 1, rate: { remaining: null, limit: null } }
    }),
  }
})
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) }, metaAdsAdSet: { findFirst: vi.fn(async () => null) }, metaAdsAd: { findFirst: vi.fn(async () => null) },
    // nexus_meta_links_taken(product, ids): the ids another business uses.
    $queryRaw: vi.fn(async (_s: unknown, _product: unknown, ids: string[]) => ids.filter((id) => h.taken.has(id)).map((id) => ({ id }))),
  },
}))

import { META_ADS_PARTNERS_TOOLS } from './meta-ads-partners.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaRestUrl, metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_PARTNERS_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const PAGE = '120000000000010'
const IG = '170000000000001'
const PORTFOLIO = '9876543210'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE }, instagram: { instagramId: IG }, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation', status = 400) => new MetaReadError(failureOfAnswer({ status, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
/** Every call made, judged by the real gateway: the problem of each one it would refuse (none expected). */
const refusedByGateway = () => h.calls
  .map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: c.host === 'rest' ? metaRestUrl(c.path, (c.query ?? {}) as never) : metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })])
  .filter(([, problem]) => problem)

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.graph = null; h.rest = null; h.taken = new Set(); h.all = [] })

describe('the two tools are reads', () => {
  it('none changes anything; both reach Meta; no money in them', () => {
    for (const t of META_ADS_PARTNERS_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, requires: t.requires, restricted: t.restrictedFields })
        .toEqual({ name: t.name, readOnly: true, execute: undefined, openWorld: true, requires: ['ads.view'], restricted: undefined })
    }
  })
})

describe('meta-partnership-content', () => {
  it('search: the portfolio\'s edge with the chosen Page and Instagram account, fixed fields, filters as Meta spells them, forward cursor only', async () => {
    h.graph = () => ({
      data: [
        { content_id: '178000000000001', platform: 'INSTAGRAM', caption: 'Ride', author: { display_name: 'rider_x', ig_user_id: '170000000000099' }, partnership_info: [{ ad_eligibility: 'INELIGIBLE', eligibility_errors: [{ code: 'REEL_CAN_NOT_BE_BOOSTED_COPY_RIGHTED_MUSIC', message: 'Music', severity: 'error' }] }], organic_insights: { likes: 5, views: 100 } },
        { content_id: '178000000000002', author: { display_name: 'Shop B', fb_page_id: '120000000000011' } },
      ],
      paging: { cursors: { after: 'c1' } },
    })
    h.taken = new Set(['120000000000011'])
    const res = await run('meta-partnership-content', { view: 'search', platforms: ['instagram'], contentTypes: ['collab_post'], partnerPageIds: ['120000000000012'], insights: true, limit: 80, from: '2026-10-01', to: '2026-10-20' })
    expect(res.ok).toBe(true)
    const call = h.calls[0]
    expect(call.path).toBe(`${PORTFOLIO}/partnership-ads-advertisable-content`)
    expect(call.query).toMatchObject({ fb_page_id: PAGE, ig_user_id: IG, platform_types: ['INSTAGRAM'], content_types: ['COLLAB_POST'], ad_partner_page_ids: '[120000000000012]', start_date: '2026-10-01', end_date: '2026-10-20', limit: 50 })
    expect(String(call.query!.fields)).toMatch(/^content_id,.*partnership_info\{.*eligibility_errors\{code,message,severity\}.*organic_insights$/)
    const data = res.data as { items: Array<Record<string, unknown>>; nextAfter: string | null }
    expect(data.nextAfter).toBe('c1')
    expect(data.items[0]).toMatchObject({ contentId: '178000000000001', author: { name: 'rider_x', instagramId: '170000000000099' }, partnerships: [{ adEligibility: 'INELIGIBLE', eligibilityErrors: [{ code: 'REEL_CAN_NOT_BE_BOOSTED_COPY_RIGHTED_MUSIC' }] }], organicInsights: { likes: 5, views: 100, reach: null } })
    // Content by a Page another business in Nexus uses: its id and the flag only.
    expect(data.items[1]).toEqual({ contentId: '178000000000002', takenByAnotherBusiness: true })
    expect(JSON.stringify(res)).not.toContain('Shop B')
    expect(refusedByGateway()).toEqual([])
  })
  it('search: when Meta refuses the full field list, the core fields once more, and it says so; from without to is refused', async () => {
    h.graph = (req) => (String(req.query?.fields).includes('partnership_info') ? metaError('100', 'Tried accessing nonexisting field (tagged_partner)') : { data: [{ content_id: '178000000000003' }] })
    const res = await run('meta-partnership-content', { view: 'search' })
    expect(res).toMatchObject({ ok: true, data: { fieldsNote: expect.stringMatching(/refused the full field list/), items: [{ contentId: '178000000000003' }] } })
    expect(h.calls).toHaveLength(2)
    expect((await run('meta-partnership-content', { view: 'search', from: '2026-10-01' })).error).toMatch(/from and to together/)
  })
  it('lookup and content-insights: ONE kind of id per request; content-insights asks the organic numbers', async () => {
    expect((await run('meta-partnership-content', { view: 'lookup', contentIds: ['1'], adCodes: ['ABC'] })).error).toMatch(/ONE of contentIds, permalinks or adCodes/)
    expect((await run('meta-partnership-content', { view: 'content-insights' })).error).toMatch(/Name the content/)
    expect(h.calls).toHaveLength(0)
    await run('meta-partnership-content', { view: 'content-insights', contentIds: ['178000000000001', '120000000000010_330000000000001'] })
    expect(h.calls[0].query).toMatchObject({ content_ids: ['178000000000001', '120000000000010_330000000000001'], fields: expect.stringMatching(/,organic_insights$/) })
    await run('meta-partnership-content', { view: 'lookup', permalinks: ['https://www.instagram.com/p/ABC123/'] })
    expect(h.calls[1].query).toMatchObject({ permalinks: ['https://www.instagram.com/p/ABC123/'] })
    expect((await run('meta-partnership-content', { view: 'lookup', permalinks: ['https://example.com/p/1'] })).error).toMatch(/instagram\.com|facebook\.com/)
    expect(refusedByGateway()).toEqual([])
  })
  it('facebook-permissions: Meta\'s REST host for the chosen Page; status words to Meta\'s numbers; big ids kept exact; another business\'s Page flagged', async () => {
    h.rest = () => ({ status: 200, text: '[{"id": 9007199254740993001, "partner_page_id": 12345678901234567, "status": 7, "permission_direction": "received"}, {"id": 2, "partner_page_id": 120000000000011, "status": 1}]' })
    h.taken = new Set(['120000000000011'])
    const res = await run('meta-partnership-content', { view: 'facebook-permissions', statuses: ['approved', 'pending_approval'], partnerPageIds: ['12345678901234567'], direction: 'received' })
    expect(h.calls[0]).toMatchObject({ host: 'rest', path: `partnership-ads/fb-account-level-permissions/${PAGE}`, query: { status: [2, 7, 1], partner_page_ids: '[12345678901234567]', permission_direction: 'received', limit: 100, offset: 0 } })
    expect((res.data as { items: unknown[] }).items).toEqual([
      { permissionId: '9007199254740993001', partnerPageId: '12345678901234567', status: 'APPROVED', direction: 'received', createdAt: null },
      { permissionId: '2', partnerPageId: '120000000000011', takenByAnotherBusiness: true },
    ])
    expect(refusedByGateway()).toEqual([])
  })
  it('allowlist: the status and the creators each on their own — one refused part says why and never hides the other', async () => {
    h.rest = (req) => (req.path.endsWith('brand-allowlist-status')
      ? { status: 200, text: '{"allowlist_status": "ENABLED"}' }
      : { status: 403, text: '{"error":{"code":200}}', verdict: { errorClass: 'forbidden', channelCode: '200', channelMessage: 'Missing facebook_branded_content_ads_brand' } })
    const res = await run('meta-partnership-content', { view: 'allowlist' })
    expect(res).toMatchObject({ ok: true, data: { allowlistStatus: 'ENABLED', allowlistStatusNotRead: null, creators: null, creatorsNotRead: expect.stringMatching(/facebook_branded_content_ads_brand/) } })
    expect(h.calls.map((c) => c.path)).toEqual([`partnership-ads/fb-branded-content/${PAGE}/brand-allowlist-status`, `partnership-ads/fb-branded-content/${PAGE}/brand-allowlisted-creators`])
    h.calls.length = 0
    h.rest = () => ({ status: 200, text: '[{"creator_page_id": 120000000000020, "creator_page_name": "Rider", "creator_ineligible_for_bc": true}]' })
    expect((await run('meta-partnership-content', { view: 'allowlist' })).data).toMatchObject({ creators: [{ creatorPageId: '120000000000020', creatorPageName: 'Rider', ineligibleForBrandedContent: true }] })
    expect(refusedByGateway()).toEqual([])
  })
  it('tagged-posts and instagram-permissions read the chosen Page / Instagram account; tag-approvals says what Meta needs when it refuses', async () => {
    await run('meta-partnership-content', { view: 'tagged-posts', from: '2026-10-01', to: '2026-10-21', creatorPageIds: ['120000000000020'], limit: 900, offset: 100 })
    expect(h.calls[0]).toMatchObject({ host: 'rest', path: `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`, query: { start_date: '2026-10-01', end_date: '2026-10-21', creator_page_ids: '[120000000000020]', limit: 500, offset: 100 } })
    await run('meta-partnership-content', { view: 'instagram-permissions', creatorUsername: '@rider_x' })
    expect(h.calls[1]).toMatchObject({ path: `${IG}/branded_content_ad_permissions`, query: { creator_username: 'rider_x' } })
    h.graph = () => metaError('10', 'Requires advanced access', 'forbidden', 403)
    const res = await run('meta-partnership-content', { view: 'tag-approvals', userIds: ['170000000000020', '170000000000021'] })
    expect(h.calls[2]).toMatchObject({ path: `${IG}/branded_content_tag_approval`, query: { user_ids: '170000000000020,170000000000021' } })
    expect(res.error).toMatch(/Advanced Access.*Instagram app/)
    h.graph = () => ({ data: [{ id: '170000000000021' }] })
    expect((await run('meta-partnership-content', { view: 'tag-approvals', userIds: ['170000000000020', '170000000000021'] })).data).toMatchObject({ items: [{ instagramId: '170000000000020', approvedToTag: false }, { instagramId: '170000000000021', approvedToTag: true }] })
    expect(refusedByGateway()).toEqual([])
  })
  it('creator-id: business discovery on the chosen Instagram account; a username is checked first; an account another business uses is its id only', async () => {
    expect((await run('meta-partnership-content', { view: 'creator-id', username: 'not a name' })).error).toMatch(/1–30 letters/)
    expect(h.calls).toHaveLength(0)
    h.graph = () => ({ business_discovery: { id: '170000000000099', username: 'rider_x' }, id: IG })
    expect((await run('meta-partnership-content', { view: 'creator-id', username: '@rider_x' })).data).toMatchObject({ instagramId: '170000000000099', username: 'rider_x' })
    expect(h.calls[0]).toMatchObject({ path: IG, query: { fields: 'business_discovery.username(rider_x){id,username}' } })
    h.taken = new Set(['170000000000099'])
    const res = await run('meta-partnership-content', { view: 'creator-id', username: 'rider_x' })
    expect(res.data).toEqual({ adAccountId: '1234567890', pageId: PAGE, instagramId: '170000000000099', takenByAnotherBusiness: true })
    expect(refusedByGateway()).toEqual([])
  })
  it('creators: no filter with a username; a saved audience must be the chosen ad account\'s; filters as Meta names them', async () => {
    expect((await run('meta-partnership-content', { view: 'creators', username: 'rider_x', creatorFilters: { countries: ['IT'] } })).error).toMatch(/no other filter with a creator's username/)
    expect((await run('meta-partnership-content', { view: 'creators', creatorFilters: { query: 'moto', similarTo: ['rider_x'] } })).error).toMatch(/does not combine similarTo/)
    h.graph = (req) => (req.path === '120000000000501' ? { account_id: '5550001112', subtype: 'CUSTOM' } : { data: [] })
    expect((await run('meta-partnership-content', { view: 'creators', customAudienceId: '120000000000501' })).error).toMatch(/not one of the ad account this business chose/)
    expect(h.calls.map((c) => c.operation)).toEqual(['partners.audienceCheck'])
    h.calls.length = 0
    h.graph = (req) => (req.path === '120000000000501' ? { account_id: 'act_1234567890', subtype: 'LOOKALIKE' } : { data: [{ id: '170000000000099', username: 'rider_x', badges: ['Partnership ads'], email: 'x@example.com' }, { id: '170000000000098', page_id: '120000000000011' }] })
    h.taken = new Set(['120000000000011'])
    const res = await run('meta-partnership-content', { view: 'creators', customAudienceId: '120000000000501', creatorFilters: { countries: ['it'], minFollowers: 10000, interests: ['sports'], recommendation: 'high_ad_performance', similarTo: ['@rider_y'], verified: true } })
    expect(h.calls[1]).toMatchObject({ path: `${IG}/creator_marketplace_creators`, query: { custom_audience_id: '120000000000501', creator_countries: ['IT'], creator_min_followers: 10000, creator_interests: ['SPORTS'], recommendation_type: 'high_ad_performance', similar_to_creators: ['rider_y'], verified_account: true } })
    expect(String(h.calls[1].query!.fields)).not.toMatch(/email|gender|age_bucket/)
    expect((res.data as { items: unknown[] }).items).toEqual([expect.objectContaining({ id: '170000000000099', username: 'rider_x', badges: ['Partnership ads'] }), { id: '170000000000098', takenByAnotherBusiness: true }])
    expect(JSON.stringify(res)).not.toContain('x@example.com')
    expect(() => tool('meta-partnership-content').input.parse({ view: 'creators', creatorFilters: { minFollowers: 12345 } })).toThrow()
    expect(refusedByGateway()).toEqual([])
  })
  it('creator-marketplace: a saved audience of another ad account carries no name; Meta\'s refusal names what Creator Marketplace needs', async () => {
    h.graph = () => ({ custom_audiences_access_status: 'HAS_ACCESS', custom_audiences: [{ id: '120000000000501', name: 'Buyers 30d' }, { id: '120000000000502', name: 'Shop B buyers' }] })
    h.all = [{ id: '120000000000501' }]
    const res = await run('meta-partnership-content', { view: 'creator-marketplace' })
    expect((res.data as { customAudiences: unknown[] }).customAudiences).toEqual([{ customAudienceId: '120000000000501', name: 'Buyers 30d' }, { customAudienceId: '120000000000502', inChosenAdAccount: false }])
    expect(h.calls.map((c) => c.path)).toEqual([`${IG}/creator_marketplace_brand_info`, 'act_1234567890/customaudiences'])
    expect(JSON.stringify(res)).not.toContain('Shop B buyers')
    h.graph = () => metaError('10', 'App missing permission', 'forbidden', 403)
    expect((await run('meta-partnership-content', { view: 'creator-marketplace' })).error).toMatch(/App missing permission.*Advanced access \(Meta's App Review/)
    expect(refusedByGateway()).toEqual([])
  })
  it('collab-invites and collab-media read the chosen Instagram account (one post by id too)', async () => {
    await run('meta-partnership-content', { view: 'collab-invites' })
    await run('meta-partnership-content', { view: 'collab-media' })
    await run('meta-partnership-content', { view: 'collab-media', mediaId: '178000000000005' })
    expect(h.calls.map((c) => [c.path, String(c.query?.fields).split('{')[0]])).toEqual([
      [`${IG}/collaboration_invites`, 'media_id,media_owner_username,caption,media_url'],
      [`${IG}/collaborative_media`, 'id,caption,media_type,media_product_type,permalink,timestamp,username,total_like_count,total_comments_count,total_views_count'],
      [IG, 'collaborative_media_search.media_id(178000000000005)'],
    ])
    expect(refusedByGateway()).toEqual([])
  })
  it('without a chosen Page, Instagram account or portfolio, each view says who chooses it — before any call', async () => {
    h.connections = [{ ...CHOSEN, page: null, instagram: null }]
    expect((await run('meta-partnership-content', { view: 'allowlist' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-partnership-content', { view: 'collab-invites' })).error).toMatch(/No Instagram account is chosen/)
    expect((await run('meta-partnership-content', { view: 'search' })).error).toMatch(/No Facebook Page is chosen/)
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run('meta-partnership-content', { view: 'search' })).error).toMatch(/names no Meta business portfolio/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('meta-ad-library', () => {
  it('search: /ads_archive with the countries, words or Pages, fixed fields; the public Ad Library link, never the snapshot link', async () => {
    expect((await run('meta-ad-library', { view: 'search', countries: ['IT'] })).error).toMatch(/Name what to search/)
    expect((await run('meta-ad-library', { view: 'search', searchTerms: 'casco' })).error).toMatch(/Name the countries/)
    expect(() => tool('meta-ad-library').input.parse({ view: 'search', adType: 'POLITICAL_AND_ISSUE_ADS' })).toThrow()
    expect(h.calls).toHaveLength(0)
    h.graph = () => ({ data: [{ id: '880000000000001', page_id: '120000000000030', page_name: 'Rival', ad_creative_bodies: ['Casco nuovo'], ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=880000000000001', eu_total_reach: 12000 }], paging: { cursors: { after: 'c2' }, next: 'n' } })
    const res = await run('meta-ad-library', { view: 'search', searchTerms: 'casco moto', exactPhrase: true, countries: ['it', 'DE'], pageIds: ['120000000000030'], languages: ['it'], platforms: ['instagram'], status: 'all' })
    expect(h.calls[0]).toMatchObject({ path: 'ads_archive', query: { ad_reached_countries: ['IT', 'DE'], search_terms: 'casco moto', search_type: 'KEYWORD_EXACT_PHRASE', search_page_ids: '[120000000000030]', languages: ['it'], publisher_platforms: ['INSTAGRAM'], ad_active_status: 'ALL' } })
    expect(String(h.calls[0].query!.fields)).toContain('eu_total_reach,total_reach_by_location,age_country_gender_reach_breakdown,beneficiary_payers,target_ages,target_gender,target_locations')
    const data = res.data as { items: Array<Record<string, unknown>>; nextAfter: string | null }
    expect(data.items[0]).toMatchObject({ libraryId: '880000000000001', pageName: 'Rival', bodies: ['Casco nuovo'], euTotalReach: 12000, libraryUrl: 'https://www.facebook.com/ads/library/?id=880000000000001' })
    expect(JSON.stringify(data)).not.toContain('render_ad')
    expect(data.nextAfter).toBe('c2')
    h.graph = () => metaError('10', 'Application does not have permission for this action', 'forbidden', 403)
    expect((await run('meta-ad-library', { view: 'search', searchTerms: 'casco', countries: ['IT'] })).error).toMatch(/Ad Library API access.*facebook\.com\/ads\/library/)
    expect(refusedByGateway()).toEqual([])
  })
  it('instagram-account and hashtag go through the chosen Instagram account; another business\'s account is never read here', async () => {
    h.graph = () => ({ business_discovery: { id: '170000000000099', username: 'rival_moto', followers_count: 5000, media: { data: [{ id: '178000000000010', like_count: 3 }] } } })
    const res = await run('meta-ad-library', { view: 'instagram-account', username: 'rival_moto', mediaLimit: 5 })
    expect(h.calls[0].query!.fields).toBe('business_discovery.username(rival_moto){id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(5){id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count}}')
    expect(res.data).toMatchObject({ instagramId: '170000000000099', followers: 5000, media: [{ mediaId: '178000000000010', likes: 3 }] })
    h.taken = new Set(['170000000000099'])
    expect((await run('meta-ad-library', { view: 'instagram-account', username: 'rival_moto' })).data).toEqual({ instagramId: '170000000000099', takenByAnotherBusiness: true })
    h.calls.length = 0
    h.graph = (req) => (req.path === 'ig_hashtag_search' ? { data: [{ id: '17800000000000591' }] } : { data: [{ id: '178000000000011', caption: '#motogp' }] })
    const tag = await run('meta-ad-library', { view: 'hashtag', hashtag: '#motogp', order: 'recent' })
    expect(h.calls.map((c) => [c.path, c.query?.user_id, c.query?.q])).toEqual([['ig_hashtag_search', IG, 'motogp'], ['17800000000000591/recent_media', IG, undefined]])
    expect(tag.data).toMatchObject({ hashtagId: '17800000000000591', order: 'recent', items: [{ mediaId: '178000000000011' }], note: expect.stringMatching(/30 different hashtags/) })
    expect((await run('meta-ad-library', { view: 'hashtag', hashtag: 'two words' })).error).toMatch(/no #, spaces or emojis/)
    await run('meta-ad-library', { view: 'recent-hashtags' })
    expect(h.calls.at(-1)).toMatchObject({ path: `${IG}/recently_searched_hashtags`, query: { fields: 'id,name' } })
    expect(refusedByGateway()).toEqual([])
  })
  it('page-posts: another Page\'s public posts; a Page another business in Nexus uses is not read at all', async () => {
    h.taken = new Set(['120000000000011'])
    expect((await run('meta-ad-library', { view: 'page-posts', pageId: '120000000000011' })).data).toMatchObject({ pageId: '120000000000011', takenByAnotherBusiness: true })
    expect(h.calls).toHaveLength(0)
    h.graph = () => metaError('10', 'Requires Page Public Content Access', 'forbidden', 403)
    expect((await run('meta-ad-library', { view: 'page-posts', pageId: '120000000000030' })).error).toMatch(/Page Public Content Access.*open the Page on Facebook/)
    expect(h.calls[0]).toMatchObject({ path: '120000000000030/feed', query: { fields: 'id,message,created_time,permalink_url,status_type' } })
    expect(refusedByGateway()).toEqual([])
  })
})

describe('step 16 review fixes', () => {
  it('A1 — no creator filter by gender or age (the audience filters stay)', () => {
    const parse = (creatorFilters: Record<string, unknown>) => tool('meta-partnership-content').input.parse({ view: 'creators', creatorFilters })
    expect(() => parse({ gender: ['female'] })).toThrow()
    expect(() => parse({ ageBuckets: ['18_to_24'] })).toThrow()
    expect(() => parse({ audienceGender: ['female'], audienceAgeBuckets: ['25_to_34'] })).not.toThrow()
  })
  it('A3 — the Ad Library never searches another business\'s Page, and masks an ad of one', async () => {
    h.taken = new Set(['120000000000011'])
    const refused = await run('meta-ad-library', { view: 'search', pageIds: ['120000000000011', '120000000000030'], countries: ['IT'] })
    expect(refused.error).toMatch(/Another business in Nexus uses 120000000000011/)
    expect(h.calls).toHaveLength(0)
    h.graph = () => ({ data: [{ id: '880000000000002', page_id: '120000000000011', page_name: 'Shop B', ad_creative_bodies: ['Promo'] }, { id: '880000000000003', page_id: '120000000000030', page_name: 'Rival' }] })
    const res = await run('meta-ad-library', { view: 'search', searchTerms: 'casco', countries: ['IT'] })
    expect((res.data as { items: unknown[] }).items).toEqual([{ pageId: '120000000000011', takenByAnotherBusiness: true }, expect.objectContaining({ libraryId: '880000000000003', pageName: 'Rival' })])
    expect(JSON.stringify(res)).not.toMatch(/Shop B|Promo/)
  })
  it('A3 — a hashtag id that is another business\'s Page or Instagram account is not read', async () => {
    h.taken = new Set(['170000000000099'])
    expect((await run('meta-ad-library', { view: 'hashtag', hashtagId: '170000000000099' })).data).toEqual({ hashtagId: '170000000000099', takenByAnotherBusiness: true })
    expect(h.calls).toHaveLength(0)
  })
  it('B1 — Instagram permissions: Meta\'s default answer (no fields named), both spellings of the status mapped', async () => {
    h.graph = () => ({ data: [{ id: '990000000000001', creator_username: 'rider_x', creator_id: '170000000000099', permission_status: 'PENDING' }, { id: '990000000000002', status: 'APPROVED', permission_type: 'ACCOUNT' }] })
    const res = await run('meta-partnership-content', { view: 'instagram-permissions' })
    expect(h.calls[0].query).not.toHaveProperty('fields')
    expect((res.data as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ permissionId: '990000000000001', status: 'PENDING', creatorUsername: 'rider_x' }),
      expect.objectContaining({ permissionId: '990000000000002', status: 'APPROVED', permissionType: 'ACCOUNT' }),
    ])
    expect(refusedByGateway()).toEqual([])
  })
  it('B5 — one creator by username: Meta\'s creator insights too (never the word comments); without them, then the profile, when Meta refuses', async () => {
    h.graph = () => ({ data: [{ id: '170000000000099', username: 'rider_x', insights: { data: [{ name: 'total_followers', period: 'overall', total_value: { value: 52000 } }] } }] })
    const res = await run('meta-partnership-content', { view: 'creators', username: 'rider_x' })
    const fields = String(h.calls[0].query!.fields)
    expect(fields).toContain('insights.metrics(total_followers,creator_reach,creator_engaged_accounts,reels_interaction_rate,total_views,account_interactions)')
    expect(fields).not.toMatch(/comments/)
    expect((res.data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ insights: [{ metric: 'total_followers', period: 'overall', value: 52000 }] })
    h.calls.length = 0
    h.graph = (req) => (String(req.query?.fields).includes('insights.metrics') || String(req.query?.fields).includes('recent_media') ? metaError('100', 'Invalid parameter') : { data: [{ id: '170000000000099', username: 'rider_x' }] })
    const fallback = await run('meta-partnership-content', { view: 'creators', username: 'rider_x' })
    expect(h.calls.map((c) => [String(c.query?.fields).includes('insights.metrics'), String(c.query?.fields).includes('recent_media')])).toEqual([[true, true], [false, true], [false, false]])
    expect(fallback).toMatchObject({ ok: true, data: { fieldsNote: expect.stringMatching(/profile only/), items: [{ id: '170000000000099' }] } })
    expect(refusedByGateway()).toEqual([])
  })
})
