/**
 * Meta ads step 10 — the media, posts, Instagram media, preview and Instant Experience reads. Every read is of the
 * business's CHOSEN ad account, its portfolio, its chosen Page or its chosen Instagram account: another Page's post,
 * another account's media, a video or Instant Experience that is not the business's is refused (before any call where an
 * id says it; after one owner-only read where only Meta knows). Every call is one the real gateway lets through. A
 * preview link goes to the caller and is said to be public. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  one: null as null | ((req: Req) => unknown),
  all: null as null | ((req: Req) => unknown),
  known: new Map<string, string>(),
  taken: [] as Array<{ id: string }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    // A list page (step 6's listPaged asks `limit`) answers h.all's rows; one object answers h.one.
    if (req.query?.limit !== undefined && h.all) {
      const rows = h.all(req)
      if (rows instanceof Error) throw rows
      return { body: { data: rows ?? [] }, calls: 1 }
    }
    const answer = h.one?.(req) ?? {}
    if (answer instanceof Error) throw answer
    return { body: answer, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const answer = h.all?.(req) ?? []
    if (answer instanceof Error) throw answer
    onRows(answer as Record<string, unknown>[])
    return { rows: (answer as unknown[]).length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../../db.js', () => {
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

import { META_ADS_MEDIA_TOOLS } from './meta-ads-media.tools.js'
import { META_ADS_READ_TOOLS } from './meta-ads-read.tools.js'
import { IX_TEMPLATE_REFUSED, linkOfIframe, PAGE_TOKEN_NOTE, pagePostId, PORTFOLIO_TAKEN, tidy, VISITOR_POSTS_UNAVAILABLE } from '../../marketing/meta-ads/live-media.js'
import { offeredOn } from '../call-tool.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaCallVerdict, metaReadOnlyProblem } from '../../gateway/meta-calls.js'
import { META_IX_TEMPLATE_READ } from '../../meta/meta-media-lists.js'

const tool = (name: string) => META_ADS_MEDIA_TOOLS.find((t) => t.name === name)!
const ctx = { can: (p: string) => ['ads.view'].includes(p), via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const ACCOUNT = '1234567890'
const PAGE = '120000000000010'
const IG = '170000000000001'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: '100000000000001', name: null },
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: PAGE, name: 'Shop A' }, instagram: { instagramId: IG, username: 'shop_a' }, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
/** Each recorded call as the real gateway judges it (null: it goes). */
const gatewayProblems = () => h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.one = null; h.all = null; h.known = new Map(); h.taken = [] })

describe('the five tools are reads', () => {
  it('none changes anything; each reaches Meta (open world) with ads.view; no answer holds money', () => {
    expect(META_ADS_MEDIA_TOOLS.map((t) => t.name)).toEqual(['meta-media-library', 'meta-page-posts', 'meta-instagram-media', 'meta-ad-preview', 'meta-instant-experiences'])
    for (const t of META_ADS_MEDIA_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, requires: t.requires, riskTier: t.riskTier, category: t.category })
        .toEqual({ name: t.name, readOnly: true, execute: undefined, openWorld: true, requires: ['ads.view'], riskTier: 'low', category: 'insights' })
    }
  })
  it('a business without Meta, or without a chosen Page / Instagram account, is told who sets it up — before any call', async () => {
    h.connections = []
    expect((await run('meta-media-library', { view: 'images' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, page: null, instagram: null }]
    expect((await run('meta-page-posts', { view: 'feed' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-instant-experiences', { view: 'list' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-instagram-media', { view: 'media' })).error).toMatch(/No Instagram account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('every view asks only what the real gateway lets through', () => {
  it('meta-media-library, meta-page-posts, meta-instagram-media, meta-instant-experiences, meta-ad-preview', async () => {
    h.known = new Map([['120000000000101', 'campaign'], ['120000000000301', 'ad'], ['120000000000401', 'creative']])
    h.one = (req) => {
      if (/OwnerCheck$/.test(req.operation) && req.path === '200000000000001') return { id: '200000000000001', from: { id: PAGE }, owner: { id: PAGE } }
      if (req.operation === 'instagram.mediaOwnerCheck') return { id: req.path, owner: { id: IG } }
      if (req.path.startsWith(`${PAGE}_`)) return { id: req.path }
      if (req.operation === 'ix.template') return { id: req.path, document: { id: '397000000000001', name: 'Get New Customers', body_elements: [{ id: '397000000000002', name: 'Text', element_type: 'RICH_TEXT' }] } }
      if (/^posts\.(adCreative|creative)$|^preview\.shareLink$/.test(req.operation)) return { id: req.path, account_id: ACCOUNT, creative: { id: '120000000000401', account_id: ACCOUNT } }
      return { data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQ1&amp;t=AQ2"></iframe>' }] }
    }
    h.all = () => []
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-media-library', { view: 'images', hashes: ['0123456789abcdef0123456789abcdef'], name: 'hero', minWidth: 600, minHeight: 600 }],
      ['meta-media-library', { view: 'videos', name: 'promo', minSeconds: 3, maxSeconds: 60 }],
      ['meta-media-library', { view: 'video', videoId: '200000000000001' }],
      ['meta-media-library', { view: 'video-ads', from: '2026-10-01', to: '2026-10-20' }],
      ['meta-media-library', { view: 'playables' }],
      ['meta-media-library', { view: 'business-images', folderId: '300000000000001' }],
      ['meta-media-library', { view: 'business-videos', folderId: '300000000000001' }],
      ['meta-media-library', { view: 'business-creatives' }],
      ['meta-media-library', { view: 'folders' }], ['meta-media-library', { view: 'tags' }], ['meta-media-library', { view: 'my-folders' }],
      ['meta-media-library', { view: 'website-assets', link: 'https://shop.example.com/jackets' }], ['meta-media-library', { view: 'asset-urls' }],
      ['meta-media-library', { view: 'campaign-videos', campaignId: '120000000000101', from: '2026-10-01', to: '2026-10-20' }],
      ['meta-media-library', { view: 'live-videos', broadcastStatus: ['VOD'] }], ['meta-media-library', { view: 'playlists' }],
      ['meta-media-library', { view: 'playlist-videos', playlistId: '200000000000001' }],
      ['meta-page-posts', { view: 'feed', includeHidden: true, showExpired: true }], ['meta-page-posts', { view: 'published' }],
      ['meta-page-posts', { view: 'visitor', includeHidden: true }],
      ['meta-page-posts', { view: 'ads-posts', excludeDynamic: true, from: '2026-10-01', to: '2026-10-20' }],
      ['meta-page-posts', { view: 'post', postId: `${PAGE}_500000000000001` }],
      ['meta-page-posts', { view: 'post-sponsors', postId: `${PAGE}_500000000000001` }],
      ['meta-page-posts', { view: 'post-dynamic', postId: `${PAGE}_500000000000001` }],
      ['meta-page-posts', { view: 'post-insights', postId: `${PAGE}_500000000000001`, metrics: ['post_clicks'], period: 'lifetime', breakdown: 'is_from_ads' }],
      ['meta-page-posts', { view: 'page-insights', metrics: ['page_media_view'], period: 'day', from: '2026-10-01', to: '2026-10-20', breakdown: 'is_from_ads' }],
      ['meta-page-posts', { view: 'ad-post', adId: '120000000000301' }], ['meta-page-posts', { view: 'ad-post', creativeId: '120000000000401' }],
      ['meta-instagram-media', { view: 'accounts' }], ['meta-instagram-media', { view: 'media', from: '2026-10-01', to: '2026-10-20' }],
      ['meta-instagram-media', { view: 'stories' }], ['meta-instagram-media', { view: 'media-detail', mediaId: '180000000000001' }],
      ['meta-instagram-media', { view: 'media-insights', mediaId: '180000000000001', metrics: ['profile_activity'], breakdown: 'action_type' }],
      ['meta-instagram-media', { view: 'account-insights', metrics: ['reach'], metricType: 'time_series', from: '2026-10-01', to: '2026-10-20' }],
      ['meta-instagram-media', { view: 'account-insights', metrics: ['follower_demographics'], breakdown: 'country', timeframe: 'this_month' }],
      ['meta-instagram-media', { view: 'quota' }],
      ['meta-instagram-media', { view: 'upcoming-events' }], ['meta-instagram-media', { view: 'video-check', videoId: '200000000000001' }],
      ['meta-instant-experiences', { view: 'list', published: true, hidden: false }], ['meta-instant-experiences', { view: 'one', canvasId: '200000000000001' }],
      ['meta-instant-experiences', { view: 'elements' }], ['meta-instant-experiences', { view: 'template', template: 'get-new-customers' }],
      ['meta-ad-preview', { view: 'ad', adId: '120000000000301', adFormats: ['INSTAGRAM_STANDARD', 'FACEBOOK_REELS_MOBILE'], creativeFeature: 'image_uncrop' }],
      ['meta-ad-preview', { view: 'creative', creativeId: '120000000000401', productItemIds: ['400000000000001'], language: 'fr_XX', country: 'FR', assetLabel: 'french' }],
      ['meta-ad-preview', { view: 'spec', spec: { kind: 'image', link: 'https://shop.example.com/', imageHash: '0123456789abcdef0123456789abcdef', message: 'New season', callToAction: 'SHOP_NOW' } }],
      ['meta-ad-preview', { view: 'instant-experience', canvasId: '200000000000001' }], ['meta-ad-preview', { view: 'share-link', adId: '120000000000301' }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args.view, res.error])
    }
    expect(failed).toEqual([])
    expect(h.calls.length).toBeGreaterThan(60)
    expect(gatewayProblems()).toEqual([])
  })
  it('each read names its fields from a fixed list: never comments, leads, messages, a stream key or a person', async () => {
    h.known = new Map([['120000000000301', 'ad']])
    h.one = (req) => (req.path.startsWith(`${PAGE}_`) ? { id: req.path } : { id: req.path, account_id: ACCOUNT, creative: {} })
    h.all = () => []
    for (const [name, args] of [
      ['meta-page-posts', { view: 'feed' }], ['meta-page-posts', { view: 'visitor' }], ['meta-page-posts', { view: 'post', postId: `${PAGE}_500000000000001` }],
      ['meta-media-library', { view: 'live-videos' }], ['meta-instant-experiences', { view: 'list' }], ['meta-instagram-media', { view: 'media' }],
    ] as Array<[string, Record<string, unknown>]>) await run(name, args)
    const fields = h.calls.map((c) => String(c.query?.fields ?? '')).join(',')
    expect(fields).not.toMatch(/(^|[^a-z_])(comments|leads|messages|conversations|stream_url|secure_stream_url|dash_ingest_url|ingest_streams|last_editor|admin_creator|access_token)([^a-z_]|$)/)
  })
})

describe('only the chosen Page, Instagram account and the account\'s own media', () => {
  it('a post of another Page is refused before any call; a post id is <page id>_<post id>', async () => {
    expect((await run('meta-page-posts', { view: 'post', postId: '120000000000099_500000000000001' })).error).toMatch(/not on the Facebook Page this business chose/)
    expect((await run('meta-page-posts', { view: 'post-insights', postId: '120000000000099_500000000000001' })).error).toMatch(/not on the Facebook Page/)
    expect(() => tool('meta-page-posts').input.parse({ view: 'post', postId: '500000000000001' })).toThrow()
    expect(() => pagePostId(PAGE, '500000000000001')).toThrow(/not a Facebook post id/)
    expect(h.calls).toHaveLength(0)
  })
  it('when Meta answers a post with another Page\'s canonical id, nothing of it is returned', async () => {
    h.one = () => ({ id: '120000000000099_500000000000001', message: 'Shop B news' })
    const res = await run('meta-page-posts', { view: 'post', postId: `${PAGE}_500000000000001` })
    expect(res.error).toMatch(/not on the Facebook Page this business chose/)
    expect(JSON.stringify(res)).not.toContain('Shop B')
  })
  it('who wrote a post is the Page or "someone else": a visitor\'s id is never handed on', async () => {
    h.all = () => [
      { id: `${PAGE}_1`, message: 'Where is my order?', story: 'A Person wrote on Shop A', from: { id: '900000000000001' } },
      { id: `${PAGE}_2`, message: 'News', story: 'Shop A updated its cover photo', from: { id: PAGE } },
      { id: '120000000000099_3', message: 'Shop B news', from: { id: '120000000000099' } },
    ]
    const res = await run('meta-page-posts', { view: 'feed' })
    expect((res.data as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ id: `${PAGE}_1`, postedBy: 'someone else' }), expect.objectContaining({ id: `${PAGE}_2`, postedBy: 'the Page', story: 'Shop A updated its cover photo' }),
    ])
    // Review A6 — a row not on the chosen Page is dropped and counted; a visitor's story (it names the person) is removed.
    expect(res.data).toMatchObject({ droppedNotOnPage: 1 })
    expect(JSON.stringify(res)).not.toMatch(/900000000000001|A Person|Shop B/)
    expect(h.calls[0]).toMatchObject({ path: `${PAGE}/feed` })
  })
  it('an Instagram media of another account is refused after one owner-only read; the chosen username is enough when Meta hides owner', async () => {
    // Review A5 — the chosen account's username is read LIVE (it may have changed since it was chosen), never the stored one.
    h.connections = [{ ...CHOSEN, instagram: { instagramId: IG, username: 'shop_b' } }]
    h.one = (req) => (req.operation === 'instagram.mediaOwnerCheck' ? { id: req.path, username: 'shop_b' }
      : req.operation === 'instagram.accountUsername' ? { id: IG, username: 'shop_a' } : { id: req.path, caption: 'Shop B' })
    const res = await run('meta-instagram-media', { view: 'media-detail', mediaId: '180000000000001' })
    expect(res.error).toMatch(/not the chosen Instagram account's/)
    expect(h.calls.map((c) => [c.operation, c.path, c.query?.fields])).toEqual([
      ['instagram.mediaOwnerCheck', '180000000000001', 'id,owner,username,media_product_type'], ['instagram.accountUsername', IG, 'id,username'],
    ])
    h.calls.length = 0
    h.one = (req) => (req.operation === 'instagram.mediaOwnerCheck' ? { id: req.path, username: 'Shop_A' }
      : req.operation === 'instagram.accountUsername' ? { id: IG, username: 'shop_a' }
        : { id: req.path, caption: 'ok', boost_eligibility_info: { eligible_to_boost: false, boost_ineligible_reason: 'Copyrighted music' }, boost_ads_list: { data: [{ ad_id: '120000000000301', ad_status: 'ACTIVE' }] } })
    h.known = new Map([['120000000000301', 'ad']])
    const ok = await run('meta-instagram-media', { view: 'media-detail', mediaId: '180000000000001' })
    // Review B7 — the SDK's shapes: IGMediaBoostEligibilityInfo and IGBoostMediaAd.
    expect(ok).toMatchObject({ ok: true, data: { media: { caption: 'ok' }, boost: { eligible: false, reason: 'Copyrighted music' }, boostAds: [{ adId: '120000000000301', status: 'ACTIVE', inChosenAdAccount: true }] } })
  })
  it('a video is read only when it is the chosen Page\'s or in the chosen ad account\'s library', async () => {
    h.one = (req) => (req.operation === 'media.videoOwnerCheck' ? { id: req.path, from: { id: '120000000000099' } } : { id: req.path })
    h.all = () => [{ id: '200000000000002' }]
    expect((await run('meta-media-library', { view: 'video', videoId: '200000000000001' })).error).toMatch(/not in the chosen ad account's library or on the chosen Facebook Page/)
    expect(h.calls.map((c) => c.operation)).toEqual(['media.videoOwnerCheck', 'media.videoLibraryCheck'])
    h.calls.length = 0
    expect((await run('meta-media-library', { view: 'video', videoId: '200000000000002' })).ok).toBe(true)
    expect(h.calls.map((c) => c.operation)).toEqual(['media.videoOwnerCheck', 'media.videoLibraryCheck', 'media.video', 'media.videoThumbnails', 'media.videoCaptions'])
  })
  it('an Instant Experience or playlist of another Page is refused; nothing else of it is read', async () => {
    h.one = (req) => (req.operation.endsWith('OwnerCheck') ? { id: req.path, owner: { id: '120000000000099' } } : { data: [{ body: '<iframe src="https://x"></iframe>' }] })
    expect((await run('meta-instant-experiences', { view: 'one', canvasId: '200000000000001' })).error).toMatch(/not the chosen Facebook Page's/)
    expect((await run('meta-ad-preview', { view: 'instant-experience', canvasId: '200000000000001' })).error).toMatch(/not the chosen Facebook Page's/)
    expect((await run('meta-media-library', { view: 'playlist-videos', playlistId: '200000000000001' })).error).toMatch(/not the chosen Facebook Page's/)
    expect(h.calls.every((c) => c.operation.endsWith('OwnerCheck'))).toBe(true)
  })
  it('an ad or creative is checked with the ONE owner + kind check (objectInAccount): another account\'s, or another kind, is refused', async () => {
    h.one = () => ({ account_id: '5550001112', adset_id: '120000000000201', creative: { id: '1' }, object_type: 'SHARE', status: 'ACTIVE' })
    expect((await run('meta-ad-preview', { view: 'ad', adId: '120000000000999' })).error).toMatch(/does not belong to the ad account/)
    expect((await run('meta-page-posts', { view: 'ad-post', creativeId: '120000000000999' })).error).toMatch(/does not belong to the ad account/)
    expect(h.calls.map((c) => [c.operation, c.query?.fields])).toEqual([['preview.adCheck', 'account_id,adset_id,creative'], ['posts.creativeCheck', 'account_id,object_type,status']])
    // A campaign id given as an ad: the ad's own fields are missing, so it is refused before any preview is asked.
    h.calls.length = 0
    h.one = () => ({ account_id: ACCOUNT })
    expect((await run('meta-ad-preview', { view: 'ad', adId: '120000000000998', adFormats: ['MOBILE_FEED_STANDARD'] })).error).toMatch(/not an ad of this ad account/)
    expect(h.calls.map((c) => c.operation)).toEqual(['preview.adCheck'])
    // One Nexus has read as a campaign is refused as an ad with no call at all.
    h.calls.length = 0
    h.known = new Map([['120000000000101', 'campaign']])
    expect((await run('meta-ad-preview', { view: 'share-link', adId: '120000000000101' })).error).toMatch(/is a campaign of this ad account, not an ad/)
    expect(h.calls).toHaveLength(0)
  })
  it('a Page or Instagram account another business uses is its id and the flag only', async () => {
    h.one = (req) => (req.path === PAGE ? { id: PAGE, instagram_business_account: { id: IG, username: 'shop_a' } } : { id: req.path })
    h.all = (req) => (req.path.endsWith('/sponsor_tags') ? [{ id: '120000000000011', name: 'Shop B' }, { id: '120000000000012', name: 'Brand C' }]
      : req.path.endsWith('instagram_accounts') ? [{ id: IG, username: 'shop_a' }, { id: '170000000000002', username: 'shop_b' }] : [])
    h.taken = [{ id: '120000000000011' }, { id: '170000000000002' }]
    const sponsors = await run('meta-page-posts', { view: 'post-sponsors', postId: `${PAGE}_500000000000001` })
    expect((sponsors.data as { sponsors: unknown[] }).sponsors).toEqual([
      { pageId: '120000000000011', takenByAnotherBusiness: true }, { pageId: '120000000000012', name: 'Brand C', takenByAnotherBusiness: false },
    ])
    const accounts = await run('meta-instagram-media', { view: 'accounts' })
    expect((accounts.data as { portfolio: unknown[] }).portfolio).toEqual([
      { instagramId: IG, username: 'shop_a', chosenHere: true, takenByAnotherBusiness: false, where: 'portfolio' },
      { instagramId: '170000000000002', takenByAnotherBusiness: true, where: 'portfolio' },
    ])
    expect(JSON.stringify([sponsors, accounts])).not.toMatch(/Shop B|shop_b/)
    expect(h.calls.map((c) => c.path)).toEqual(expect.arrayContaining(['9876543210/instagram_accounts', '9876543210/instagram_business_accounts', PAGE, `${PAGE}/instagram_accounts`, `${PAGE}/page_backed_instagram_accounts`]))
  })
  it('the portfolio\'s library is the chosen account\'s own portfolio; the system user\'s folders are its own', async () => {
    h.all = () => []
    await run('meta-media-library', { view: 'business-images', folderId: '300000000000001' })
    await run('meta-media-library', { view: 'my-folders' })
    expect(h.calls.map((c) => [c.path, c.query?.creative_folder_id])).toEqual([['9876543210/images', '300000000000001'], ['100000000000001/assigned_creative_folders', undefined]])
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run('meta-media-library', { view: 'folders' })).error).toMatch(/names no business portfolio/)
  })
})

describe('meta-ad-preview — links go to the caller, are said to be public, and specs use the chosen assets only', () => {
  it('a spec is built from the chosen Page and Instagram account; a raw page id in it is dropped by the schema', async () => {
    h.one = () => ({ data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQ1&amp;t=AQ2" width="274"></iframe>' }] })
    const res = await run('meta-ad-preview', { view: 'spec', adFormats: ['INSTAGRAM_STANDARD'], spec: { kind: 'image', link: 'https://shop.example.com/', imageHash: '0123456789abcdef0123456789abcdef', headline: 'Jackets', callToAction: 'SHOP_NOW', page_id: '120000000000099' } })
    expect(res).toMatchObject({ ok: true, data: { spec: 'image', previews: [{ adFormat: 'INSTAGRAM_STANDARD', link: 'https://www.facebook.com/ads/api/preview_iframe.php?d=AQ1&t=AQ2' }], note: expect.stringMatching(/PUBLIC.*never stores or logs/) } })
    expect(h.calls[0]).toMatchObject({ path: `act_${ACCOUNT}/generatepreviews`, query: { ad_format: 'INSTAGRAM_STANDARD' } })
    expect(h.calls[0].query!.creative).toEqual({ object_story_spec: { page_id: PAGE, instagram_user_id: IG, link_data: { link: 'https://shop.example.com/', name: 'Jackets', image_hash: '0123456789abcdef0123456789abcdef', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://shop.example.com/' } } } } })
    expect(JSON.stringify(h.calls)).not.toContain('120000000000099')
  })
  it('a page-post spec takes a post of the chosen Page only; an instagram-post spec a media of the chosen account only', async () => {
    expect((await run('meta-ad-preview', { view: 'spec', spec: { kind: 'page-post', postId: '120000000000099_500000000000001' } })).error).toMatch(/not on the Facebook Page/)
    expect(h.calls).toHaveLength(0)
    h.one = (req) => (req.operation === 'instagram.mediaOwnerCheck' ? { id: req.path, owner: { id: '170000000000002' } } : { data: [] })
    expect((await run('meta-ad-preview', { view: 'spec', spec: { kind: 'instagram-post', instagramMediaId: '180000000000001' } })).error).toMatch(/not the chosen Instagram account's/)
    expect(h.calls.map((c) => c.operation)).toEqual(['instagram.mediaOwnerCheck'])
  })
  it('a multi-language spec previews one language by its label (asset_feed_spec with exactly one default)', async () => {
    h.one = () => ({ data: [{ body: '<iframe src="https://p"></iframe>' }] })
    const languages = [
      { label: 'italian', locales: [23], isDefault: true, message: 'Nuova stagione', headline: 'Giacche', link: 'https://shop.example.com/it' },
      { label: 'french', locales: [9, 44], message: 'Nouvelle saison', headline: 'Vestes', link: 'https://shop.example.com/fr' },
    ]
    await run('meta-ad-preview', { view: 'spec', assetLabel: 'french', spec: { kind: 'multi-language', imageHash: '0123456789abcdef0123456789abcdef', languages } })
    const creative = h.calls[0].query!.creative as { asset_feed_spec: { asset_customization_rules: unknown[]; ad_formats: string[] } }
    expect(h.calls[0].query).toMatchObject({ dynamic_asset_label: 'french' })
    expect(creative.asset_feed_spec.ad_formats).toEqual(['SINGLE_IMAGE'])
    expect(creative.asset_feed_spec.asset_customization_rules).toEqual([
      expect.objectContaining({ customization_spec: { locales: [23] }, is_default: true, body_label: { name: 'italian' } }),
      expect.objectContaining({ customization_spec: { locales: [9, 44] }, body_label: { name: 'french' } }),
    ])
    expect((await run('meta-ad-preview', { view: 'spec', spec: { kind: 'multi-language', imageHash: 'abc', languages: languages.map((l) => ({ ...l, isDefault: true })) } })).error).toMatch(/exactly one of them isDefault/)
    // The spec travels in a GET's URL: a spec too long for one read is refused in words before any call.
    h.calls.length = 0
    const long = Array.from({ length: 10 }, (_, i) => ({ ...languages[1], label: `lang_${i}`, isDefault: i === 0, message: 'x'.repeat(2000) }))
    expect((await run('meta-ad-preview', { view: 'spec', spec: { kind: 'multi-language', imageHash: 'abc', languages: long } })).error).toMatch(/too long to preview in one read/)
    expect(h.calls).toHaveLength(0)
  })
  it('one preview per placement: a placement Meta cannot render says so; an Advantage+ feature without a preview is not eligible', async () => {
    h.known = new Map([['120000000000301', 'ad']])
    h.one = (req) => (req.query?.ad_format === 'FACEBOOK_STORY_MOBILE'
      ? metaError('2606', 'Unable to display a preview of this ad')
      : { data: [{ body: '<iframe src="https://p1"></iframe>', ...(req.query?.ad_format === 'INSTAGRAM_REELS' ? { transformation_spec: { image_uncrop: [{ status: 'eligible', body: '<iframe src="https://p2"></iframe>' }] } } : {}) }] })
    const res = await run('meta-ad-preview', { view: 'ad', adId: '120000000000301', adFormats: ['INSTAGRAM_REELS', 'FACEBOOK_STORY_MOBILE', 'MOBILE_FEED_STANDARD'], creativeFeature: 'image_uncrop' })
    expect((res.data as { previews: unknown[] }).previews).toEqual([
      { adFormat: 'INSTAGRAM_REELS', link: 'https://p1', iframe: '<iframe src="https://p1"></iframe>', features: { image_uncrop: [{ status: 'eligible', link: 'https://p2' }] }, featureNote: null },
      { adFormat: 'FACEBOOK_STORY_MOBILE', link: null, notRendered: expect.stringMatching(/Unable to display a preview/) },
      expect.objectContaining({ adFormat: 'MOBILE_FEED_STANDARD', features: null, featureNote: expect.stringMatching(/not eligible.*will not apply/) }),
    ])
    expect(h.calls.map((c) => [c.path, c.query?.creative_feature])).toEqual(Array(3).fill([`120000000000301/previews`, 'image_uncrop']))
  })
  it('the share link is the ad\'s own field, said to be shareable outside the business', async () => {
    h.known = new Map([['120000000000301', 'ad']])
    h.one = () => ({ id: '120000000000301', account_id: ACCOUNT, preview_shareable_link: 'https://fb.me/abc' })
    expect(await run('meta-ad-preview', { view: 'share-link', adId: '120000000000301' })).toMatchObject({ ok: true, data: { shareLink: 'https://fb.me/abc', note: expect.stringMatching(/shareable outside the business/) } })
    expect(h.calls[0]).toMatchObject({ path: '120000000000301', query: { fields: 'id,account_id,preview_shareable_link' } })
  })
  it('linkOfIframe reads Meta\'s src back; tidy drops paging links and tokens and camel-cases keys', () => {
    expect(linkOfIframe('<iframe src="https://a?d=1&amp;t=2"></iframe>')).toBe('https://a?d=1&t=2')
    expect(linkOfIframe(null)).toBeNull()
    expect(tidy({ is_published: true, paging: { next: 'n' }, url_128: 'https://x?access_token=T' })).toEqual({ isPublished: true, url128: 'https://x?access_token=[redacted]' })
  })
})

describe('what Meta refuses is said plainly', () => {
  it('a Page read Meta refuses for the token says what the Page needs — Meta\'s words and the Page\'s tasks, never the ad account\'s ads_read hint (MD-101)', async () => {
    h.all = () => metaError('10', 'This endpoint requires the pages_read_engagement permission', 'forbidden')
    for (const args of [{ view: 'feed' }, { view: 'ads-posts' }, { view: 'published' }]) {
      const res = await run('meta-page-posts', args)
      expect(res.error, args.view).toContain(PAGE_TOKEN_NOTE)
      expect(res.error, args.view).toMatch(/Meta's words: This endpoint requires the pages_read_engagement permission/)
      expect(res.error, args.view).not.toMatch(/ads_read|the ad account is assigned/)
    }
    expect(PAGE_TOKEN_NOTE).toMatch(/Create content, Manage or Moderate.*Advertise.*Analyze/)
    // Meta's "needs a Page Access Token" on a read Nexus does not send with it yet: said as such, the token still works.
    h.all = null
    h.one = (req) => (req.operation === 'posts.post' ? metaError('190', 'This method must be called with a Page Access Token', 'auth_revoked') : { id: req.path })
    const post = await run('meta-page-posts', { view: 'post', postId: `${PAGE}_500000000000001` })
    expect(post.error).toMatch(/only to the Page's own access token, and Nexus does not send this one with the Page's token yet/)
    expect(post.error).not.toMatch(/Make a new token/)
  })
  it('live-probe fix EN-926 — view visitor makes no call: Meta does not answer visitor posts on the New Pages Experience; the feed holds them', async () => {
    const res = await run('meta-page-posts', { view: 'visitor', includeHidden: true })
    expect(res).toEqual({ ok: true, data: { pageId: PAGE, items: [], unavailable: VISITOR_POSTS_UNAVAILABLE } })
    expect(VISITOR_POSTS_UNAVAILABLE).toMatch(/New Pages Experience.*view feed \(postedBy: someone else/)
    expect(h.calls).toHaveLength(0)
  })
  it('live-probe fix ST10-03 — a media-library edge Meta answers "does not exist" for this token is said in words, with what to use instead', async () => {
    h.known = new Map([['120000000000101', 'campaign']])
    const hidden = (edge: string) => metaError('100', `(#100) Tried accessing nonexisting field (${edge}) on node type (Business)`, 'configuration')
    const views: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ view: 'business-images' }, 'images', /portfolio's images \(its media library\).*Business Suite › Media library/],
      [{ view: 'business-videos' }, 'videos', /portfolio's videos/],
      [{ view: 'business-creatives' }, 'creatives', /portfolio's creatives/],
      [{ view: 'folders' }, 'creative_folders', /media-library folders/],
      [{ view: 'tags' }, 'creative_asset_tags', /media-library tags/],
      [{ view: 'my-folders' }, 'assigned_creative_folders', /assigned to the business's system user/],
      [{ view: 'asset-urls' }, 'urls_for_asset_extraction', /urls_for_asset_extraction.*Ads Manager/],
      [{ view: 'campaign-videos', campaignId: '120000000000101' }, 'video_groups', /a campaign's video groups.*meta-ad-details/],
    ]
    for (const [args, edge, words] of views) {
      h.all = (req) => (req.path.endsWith(`/${edge}`) ? hidden(edge) : [])
      const res = await run('meta-media-library', args)
      expect(res.error, edge).toMatch(new RegExp(`Meta does not answer .* on API v26: Meta's reference pages list the read \\(GET …/${edge}, with v25 examples\\), but on v26 Meta answers that the edge does not exist`))
      // Review of #771 — only what is known: no guessed cause.
      expect(res.error, edge).not.toMatch(/Meta answers so when/)
      expect(res.error, edge).toMatch(words)
      expect(res.error, edge).toMatch(/none of Meta's v26 SDKs carries a read of it/)
      expect(res.error, edge).not.toMatch(/for Nexus to fix/)
    }
    // website-assets: both parts said in words; another #100 (a field) is not taken for a hidden edge.
    h.all = (req) => hidden(req.path.split('/')[1])
    const site = await run('meta-media-library', { view: 'website-assets', link: 'https://shop.example.com/' })
    expect(site.error).toMatch(/website_creative_assets.*A person sees what Meta suggests/)
    h.all = () => metaError('100', '(#100) Tried accessing nonexisting field (media_library_url) on node type (BusinessImage)', 'configuration')
    expect((await run('meta-media-library', { view: 'business-images' })).error).not.toMatch(/reference pages list the read/)
  })
  it('live-probe fix CR-489 — Meta\'s #4701 on the template read is said in words: no permission is named, and making one needs no template read', async () => {
    h.one = () => metaError('4701', 'Insufficient permissions to access this data')
    const res = await run('meta-instant-experiences', { view: 'template', template: 'get-new-customers' })
    expect(res.error).toContain(IX_TEMPLATE_REFUSED)
    expect(res.error).toMatch(/Meta's words: Insufficient permissions to access this data/)
    expect(IX_TEMPLATE_REFUSED).toMatch(/create-meta-instant-experience takes the template by name/)
    // Gap 46b — the read goes with the chosen Page's own token now: a #4701 to it too is said so, nothing guessed.
    expect(IX_TEMPLATE_REFUSED).toMatch(/even with the chosen Facebook Page's own token/)
    expect(IX_TEMPLATE_REFUSED).not.toMatch(/likely fix|does not send this read with it yet/)
    // Anything else Meta answers stays its own failure.
    h.one = () => metaError('100', 'Unsupported get request')
    expect((await run('meta-instant-experiences', { view: 'template', template: 'get-new-customers' })).error).not.toContain(IX_TEMPLATE_REFUSED)
  })
  it('gap 46b (CR-489) — a template\'s parts: ONE read of Meta\'s template node, its document expanded, which the gateway sends with the chosen Page\'s token', async () => {
    h.one = (req) => (req.operation === 'ix.template'
      ? { id: req.path, document: { id: '397000000000001', name: 'Get New Customers', body_elements: [{ id: '397000000000002', name: 'Cover Image or Video', element_type: 'PHOTO' }, { id: '397000000000003', name: 'Button', element_type: 'BUTTON' }] } }
      : {})
    const res = await run('meta-instant-experiences', { view: 'template', template: 'get-new-customers' })
    expect(res).toMatchObject({ ok: true, data: { templateId: '133471657203838', document: { id: '397000000000001', name: 'Get New Customers' }, parts: [{ elementType: 'PHOTO' }, { elementType: 'BUTTON' }] } })
    expect((res as { data: { note: string } }).data.note).toMatch(/read with the chosen Facebook Page's own token/)
    // One call, not the guide's two: no read of the document's own id (the Page's token never goes to an id Nexus did not name).
    expect(h.calls).toEqual([expect.objectContaining({ operation: 'ix.template', path: '133471657203838', query: { fields: META_IX_TEMPLATE_READ } })])
    const verdict = metaCallVerdict({ method: 'GET', url: metaUrl('133471657203838', { fields: META_IX_TEMPLATE_READ }), kind: 'read' })
    expect(verdict).toMatchObject({ problem: null, pageRead: { pageId: null } })
    // A document without its parts is said, not shown as "no parts".
    h.one = () => ({ id: '133471657203838', document: { id: '397000000000001', name: 'Get New Customers' } })
    expect((await run('meta-instant-experiences', { view: 'template', template: 'get-new-customers' })).error).toMatch(/without its parts \(body_elements\)/)
  })
  it('gap 46b (the live read of 2026-10-26) — view post, its id check and set-meta-page-post\'s state read go with the chosen Page\'s token', async () => {
    // Meta refused view post to the system-user token: "(#10) This endpoint requires the 'pages_read_engagement' permission or
    // the 'Page Public Content Access' feature". Each post read Nexus sends is now one the gateway sends with the Page's token.
    h.one = (req) => (req.path.startsWith(`${PAGE}_`) ? { id: req.path, from: { id: PAGE } } : {})
    for (const args of [{ view: 'post', postId: `${PAGE}_500000000000001` }, { view: 'post-sponsors', postId: `${PAGE}_500000000000001` }]) await run('meta-page-posts', args)
    const postReads = h.calls.filter((c) => c.path === `${PAGE}_500000000000001`)
    expect(postReads.map((c) => c.operation)).toEqual(expect.arrayContaining(['posts.post', 'posts.postCheck']))
    for (const c of postReads) expect(metaCallVerdict({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' }), c.operation).toMatchObject({ problem: null, pageRead: { pageId: PAGE } })
    const { PAGE_POST_STATE_FIELDS } = await import('../../marketing/meta-ads/live-posts.js')
    expect(metaCallVerdict({ method: 'GET', url: metaUrl(`${PAGE}_500000000000001`, { fields: PAGE_POST_STATE_FIELDS }), kind: 'read' })).toMatchObject({ problem: null, pageRead: { pageId: PAGE } })
  })
  it('live-probe fix MD-126 — boostAds lists the ads that boost or boosted the media, active or not', async () => {
    h.one = (req) => (req.operation === 'instagram.mediaOwnerCheck' ? { id: req.path, owner: { id: IG } }
      : { id: req.path, boost_eligibility_info: { eligible_to_boost: true }, boost_ads_list: { data: [{ ad_id: '120000000000301', ad_status: 'inactive' }] } })
    const res = await run('meta-instagram-media', { view: 'media-detail', mediaId: '180000000000001' })
    expect(res).toMatchObject({ ok: true, data: { boostAds: [{ adId: '120000000000301', status: 'inactive' }], note: expect.stringMatching(/the ads that boost or boosted it, active or not/) } })
    expect(JSON.stringify(res)).not.toMatch(/the ACTIVE ads/)
    expect(tool('meta-instagram-media').description).not.toMatch(/ACTIVE ads/)
  })
  it('review B2/B7 — a video read never asks `name`; only the SDK-only field Meta names is dropped, the others stay', async () => {
    h.all = (req) => (String(req.query?.fields).includes('length') ? metaError('100', 'Tried accessing nonexisting field (length) on node type (AdVideo)') : [{ id: '200000000000001', title: 'Promo' }])
    const res = await run('meta-media-library', { view: 'videos' })
    expect(res).toMatchObject({ ok: true, data: { items: [{ id: '200000000000001', title: 'Promo' }], fieldsNote: expect.stringMatching(/Meta refused length here, so it is missing: .*nonexisting field/) } })
    expect(h.calls.map((c) => c.query?.fields)).toEqual([
      'id,description,picture,created_time,updated_time,title,length,status,permalink_url,is_instagram_eligible',
      'id,description,picture,created_time,updated_time,title,status,permalink_url,is_instagram_eligible',
    ])
    expect(h.calls.some((c) => /(^|,)name(,|$)/.test(String(c.query?.fields)))).toBe(false)
    // When Meta names no field, every SDK-only one goes at once.
    h.calls.length = 0
    h.all = (req) => (String(req.query?.fields).includes('title') ? metaError('100', 'Invalid parameter') : [{ id: '200000000000001' }])
    expect((await run('meta-media-library', { view: 'videos' })).ok).toBe(true)
    expect(h.calls.map((c) => c.query?.fields)).toEqual(['id,description,picture,created_time,updated_time,title,length,status,permalink_url,is_instagram_eligible', 'id,description,picture,created_time,updated_time'])
  })
  it('review A6 / B7 — a post read asks the extra fields once; one refused field keeps the others (never allowed_advertising_objects: Meta has no such field on a post)', async () => {
    h.one = (req) => (String(req.query?.fields).includes('promotion_status') ? metaError('100', 'Tried accessing nonexisting field (promotion_status)') : { id: `${PAGE}_500000000000001`, is_inline_created: false })
    const res = await run('meta-page-posts', { view: 'post', postId: `${PAGE}_500000000000001` })
    expect(res).toMatchObject({ ok: true, data: { post: { isInlineCreated: false }, fieldsNote: expect.stringMatching(/Meta refused promotion_status/) } })
    expect(String(h.calls[1].query?.fields)).toMatch(/is_inline_created$/)
  })
  it('a metric of the other kind is refused by name before any call; IG demographics carry their timeframe', async () => {
    expect((await run('meta-page-posts', { view: 'page-insights', metrics: ['post_clicks'] })).error).toMatch(/"post_clicks" is not a metric Nexus asks here/)
    expect((await run('meta-instagram-media', { view: 'account-insights', metrics: ['saved'] })).error).toMatch(/"saved" is not a metric Nexus asks of an account/)
    expect(h.calls).toHaveLength(0)
    h.one = () => ({ data: [] })
    await run('meta-instagram-media', { view: 'account-insights', metrics: ['follower_demographics'], breakdown: 'age' })
    // Review B1 — the last_… timeframes are gone since v20: this_month by default, this_week the only other.
    expect(h.calls[0]).toMatchObject({ path: `${IG}/insights`, query: { metric: 'follower_demographics', period: 'lifetime', timeframe: 'this_month', metric_type: 'total_value', breakdown: 'age' } })
    expect(() => tool('meta-instagram-media').input.parse({ view: 'account-insights', timeframe: 'last_30_days' })).toThrow()
  })
  it('review B3 — a story\'s insights default to what a story has; likes on a story are refused before the read', async () => {
    h.one = (req) => (req.operation === 'instagram.mediaOwnerCheck' ? { id: req.path, owner: { id: IG }, media_product_type: 'STORY' } : { data: [] })
    const res = await run('meta-instagram-media', { view: 'media-insights', mediaId: '180000000000001' })
    expect(res).toMatchObject({ ok: true, data: { productType: 'STORY', metrics: ['views', 'reach', 'shares', 'total_interactions', 'replies', 'navigation'] } })
    expect(h.calls[1]).toMatchObject({ path: '180000000000001/insights', query: { metric: 'views,reach,shares,total_interactions,replies,navigation' } })
    h.calls.length = 0
    expect((await run('meta-instagram-media', { view: 'media-insights', mediaId: '180000000000001', metrics: ['likes'] })).error).toMatch(/Meta has no "likes" for a story/)
    expect(h.calls.map((c) => c.operation)).toEqual(['instagram.mediaOwnerCheck'])
  })
  it('a video\'s status is said in words', async () => {
    h.one = (req) => (req.operation === 'media.videoOwnerCheck' ? { id: req.path, from: { id: PAGE } } : { id: req.path, status: { video_status: 'processing', processing_progress: 40 } })
    h.all = () => []
    const res = await run('meta-media-library', { view: 'video', videoId: '200000000000001' })
    expect(res).toMatchObject({ ok: true, data: { video: { statusText: 'Meta is still processing it (40%): wait before a creative uses it' } } })
  })
})

describe('step 10 review fixes', () => {
  it('A1 — a business portfolio another business\'s ad account belongs to is its id and the flag only, with NO call', async () => {
    h.taken = [{ id: '9876543210' }]
    // Round 3 F1 — the system user's own folders too: they are that shared portfolio's.
    for (const view of ['business-images', 'business-videos', 'business-creatives', 'folders', 'tags', 'my-folders']) {
      expect(await run('meta-media-library', { view })).toEqual({ ok: true, data: { adAccountId: ACCOUNT, portfolioId: '9876543210', takenByAnotherBusiness: true, sentence: PORTFOLIO_TAKEN } })
    }
    expect(PORTFOLIO_TAKEN).toMatch(/views images and videos/)
    expect(PORTFOLIO_TAKEN).not.toMatch(/my-folders/)
    expect(h.calls).toHaveLength(0)
    // The ad account's own library still reads.
    expect((await run('meta-media-library', { view: 'images' })).ok).toBe(true)
  })
  it('A2 — meta-ad-preview is Claude\'s door only: the in-app chat (which keeps tool results in its run) never gets a public link', () => {
    const preview = tool('meta-ad-preview')
    expect(preview.surfaces).toEqual(['mcp'])
    expect([offeredOn(preview, 'mcp'), offeredOn(preview, 'app')]).toEqual([true, false])
    expect(META_ADS_MEDIA_TOOLS.filter((t) => t.surfaces).map((t) => t.name)).toEqual(['meta-ad-preview'])
  })
  it('A4 — there is no container view (Nexus makes no Instagram containers yet)', () => {
    expect(() => tool('meta-instagram-media').input.parse({ view: 'container' })).toThrow()
  })
  it('B4 — Instant Experience parts ask CanvasBodyElement\'s one field; B8 — THREADS_STREAM is not a v26 ad_format', async () => {
    await run('meta-instant-experiences', { view: 'elements' })
    expect(h.calls[0]).toMatchObject({ path: `${PAGE}/canvas_elements`, query: { fields: 'element' } })
    expect(() => tool('meta-ad-preview').input.parse({ view: 'ad', adId: '1', adFormats: ['THREADS_STREAM'] })).toThrow()
  })
  it('B6 — a multi-language video spec labels the video and names it in every rule; a blank description is one space', async () => {
    h.one = (req) => (req.operation === 'media.videoOwnerCheck' ? { id: req.path, from: { id: PAGE } } : { data: [{ body: '<iframe src="https://p"></iframe>' }] })
    const languages = [
      { label: 'italian', locales: [23], isDefault: true, message: 'Nuova stagione', headline: 'Giacche', link: 'https://shop.example.com/it' },
      { label: 'french', locales: [9], message: 'Nouvelle saison', headline: 'Vestes', description: '  ', link: 'https://shop.example.com/fr' },
    ]
    await run('meta-ad-preview', { view: 'spec', spec: { kind: 'multi-language', videoId: '200000000000001', imageHash: '0123456789abcdef0123456789abcdef', languages } })
    const feed = (h.calls.at(-1)!.query!.creative as { asset_feed_spec: Record<string, unknown> }).asset_feed_spec
    expect(feed.ad_formats).toEqual(['SINGLE_VIDEO'])
    expect(feed.videos).toEqual([{ video_id: '200000000000001', adlabels: [{ name: 'nexus_video' }], thumbnail_hash: '0123456789abcdef0123456789abcdef' }])
    expect((feed.asset_customization_rules as Array<Record<string, unknown>>).map((r) => r.video_label)).toEqual([{ name: 'nexus_video' }, { name: 'nexus_video' }])
    expect((feed.descriptions as Array<{ text: string }>).map((d) => d.text)).toEqual([' ', ' '])
  })
  it('B5 — post video metrics: the 30-second complete views are the unique ones', () => {
    expect(() => tool('meta-page-posts').input.parse({ view: 'post-insights', metrics: ['post_video_complete_views_30s_unique'] })).not.toThrow()
    expect(() => tool('meta-page-posts').input.parse({ view: 'post-insights', metrics: ['post_video_complete_views_30s'] })).toThrow()
  })
  it('no tool description holds a bare number of four digits or more (a money-like value)', () => {
    for (const t of META_ADS_MEDIA_TOOLS) expect({ name: t.name, numbers: t.description.match(/\b\d{4,}\b/g) }).toEqual({ name: t.name, numbers: null })
  })
  it('round 2 (b) — meta-ads-graph-read never sends the organic-insight keys on a campaign\'s insights: refused with no call', async () => {
    h.known = new Map([['120000000000101', 'campaign']])
    const graphRead = META_ADS_READ_TOOLS.find((t) => t.name === 'meta-ads-graph-read')!
    for (const params of [{ metric: 'page_media_view' }, { period: 'day' }, { since: '2026-10-01' }]) {
      const res = await graphRead.handler(graphRead.input.parse({ path: '120000000000101/insights', fields: 'spend', params }), { can: () => true, via: 'claude' } as never)
      expect({ params, ok: res.ok }).toEqual({ params, ok: false })
    }
    expect(h.calls).toHaveLength(0)
  })
  it('round 3 F2 — Instagram demographics go apart from the other metrics, with their timeframe and never a since / until', async () => {
    expect((await run('meta-instagram-media', { view: 'account-insights', metrics: ['follower_demographics', 'reach'] })).error).toMatch(/demographics .* apart from the other metrics/)
    expect(h.calls).toHaveLength(0)
    h.one = () => ({ data: [] })
    await run('meta-instagram-media', { view: 'account-insights', metrics: ['engaged_audience_demographics'], timeframe: 'this_week', from: '2026-10-01', to: '2026-10-20' })
    expect(h.calls[0].query).toEqual({ metric: 'engaged_audience_demographics', period: 'lifetime', metric_type: 'total_value', timeframe: 'this_week' })
    h.calls.length = 0
    await run('meta-instagram-media', { view: 'account-insights', metrics: ['reach'], from: '2026-10-01', to: '2026-10-20' })
    expect(h.calls[0].query).toEqual({ metric: 'reach', period: 'day', metric_type: 'total_value', since: '2026-10-01', until: '2026-10-20' })
  })
  it('round 3 N1 — a multi-language image spec labels the image and names it in every rule, as the video is', async () => {
    h.one = () => ({ data: [{ body: '<iframe src="https://p"></iframe>' }] })
    const languages = [
      { label: 'italian', locales: [23], isDefault: true, message: 'Nuova stagione', headline: 'Giacche', link: 'https://shop.example.com/it' },
      { label: 'french', locales: [9], message: 'Nouvelle saison', headline: 'Vestes', link: 'https://shop.example.com/fr' },
    ]
    await run('meta-ad-preview', { view: 'spec', spec: { kind: 'multi-language', imageHash: '0123456789abcdef0123456789abcdef', languages } })
    const feed = (h.calls[0].query!.creative as { asset_feed_spec: Record<string, unknown> }).asset_feed_spec
    expect(feed.images).toEqual([{ hash: '0123456789abcdef0123456789abcdef', adlabels: [{ name: 'nexus_image' }] }])
    expect((feed.asset_customization_rules as Array<Record<string, unknown>>).map((r) => [r.image_label, r.video_label])).toEqual([[{ name: 'nexus_image' }, undefined], [{ name: 'nexus_image' }, undefined]])
    expect((await run('meta-ad-preview', { view: 'spec', spec: { kind: 'multi-language', imageHash: 'abc', languages: [{ ...languages[0], label: 'nexus_image' }, languages[1]] } })).error).toMatch(/the media's own labels/)
  })
})
