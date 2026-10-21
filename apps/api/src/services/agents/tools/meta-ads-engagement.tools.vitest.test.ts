/**
 * Meta ads step 14 — lead forms, leads and comments. Every read is of the business's CHOSEN Page, Instagram account or ad
 * account: a form not among the chosen Page's forms, a lead of neither the chosen account's ads nor the Page's forms, an
 * ad of another account, a post of another Page, a comment of another post, an Instagram comment on another account's
 * media — each is refused (before any call where an id says it; after one id-only read where only Meta knows). Every call
 * is one the real gateway lets through, and leads, comments and forms are read only through their own edges. People's data
 * comes back under named keys only, and only to a person who may see customers' data, on Claude's door. Meta and the
 * database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  reply: null as null | ((req: Req) => unknown),
  known: new Map<string, string>(),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const answer = h.reply?.(req) ?? { data: [] }
    if (answer instanceof Error) throw answer
    return { body: answer, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => { throw new Error('not used here') }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../../db.js', () => {
  const found = (pairs: Array<[string, string]>) => vi.fn(async ({ where }: { where: Record<string, string> }) =>
    (pairs.some(([key, kind]) => where[key] && h.known.get(where[key]) === kind) ? { id: 'x' } : null))
  return {
    default: {
      metaAdsCampaign: { findFirst: found([['campaignId', 'campaign']]) },
      metaAdsAdSet: { findFirst: found([['adSetId', 'adset']]) },
      metaAdsAd: { findFirst: found([['adId', 'ad'], ['creativeId', 'creative']]) },
      $queryRaw: vi.fn(async () => []),
    },
  }
})

import { META_ADS_ENGAGEMENT_TOOLS } from './meta-ads-engagement.tools.js'
import { facebookCommentId, isRealDay, LEADS_ACCESS, leadRow, leadTimeFilter, THREADS_NOTE } from '../../marketing/meta-ads/live-engagement.js'
import { PAGE_TOKEN_NOTE } from '../../marketing/meta-ads/live-media.js'
import { callTool, offeredOn, type UserPrincipal } from '../call-tool.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_ENGAGEMENT_TOOLS.find((t) => t.name === name)!
const ctx = { can: (p: string) => ['ads.view', 'customers.view'].includes(p), via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const ACCOUNT = '1234567890'
const PAGE = '120000000000010'
const IG = '170000000000001'
const FORM = '600000000000001'
const AD = '120000000000301'
const LEAD = '700000000000001'
const POST = `${PAGE}_500000000000001`
const COMMENT = '500000000000001_800000000000001'
const MEDIA = '180000000000001'
const IG_COMMENT = '190000000000001'
const DYNAMIC = '900000000000001'
const THREADS = '200000000000077'
/** A photo post's photo, and a comment on it (Meta numbers it after the photo, not the post). */
const PHOTO = '210000000000001'
const PHOTO_COMMENT = `${PHOTO}_800000000000003`
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: '100000000000001', name: null },
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: PAGE, name: 'Shop A' }, instagram: { instagramId: IG, username: 'shop_a' }, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
/** Each recorded call as the real gateway judges it (null: it goes). */
const gatewayProblems = () => h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)

/** A Meta that knows the business's own form, ad, posts, media and comments (and their people). */
const OWN_LEAD = {
  id: LEAD, created_time: '2026-10-20T08:49:14+0000', ad_id: AD, form_id: FORM, ad_name: 'Jackets IT', adset_id: '120000000000201', campaign_id: '120000000000101',
  is_organic: false, platform: 'fb', retailer_item_id: 'SKU-1',
  field_data: [{ name: 'full_name', values: ['A Person'] }, { name: 'email', values: ['person@example.com'] }],
  custom_disclaimer_responses: [{ checkbox_key: 'optional_1', is_checked: '1' }, { checkbox_key: 'optional_2', is_checked: '' }],
  partner_name: 'Partner X', vehicle: { id: '1' }, home_listing: { id: '2' }, unknown_new_field: 'raw',
}
function ownMeta(req: Req): unknown {
  const fields = String(req.query?.fields ?? '')
  // The create guide's in-thread list answers the eligible forms' ids only.
  if (req.path === `${PAGE}/leadgen_forms` && fields === 'id,is_eligible_for_in_thread_forms') return { data: [{ id: FORM }] }
  if (req.path === `${PAGE}/leadgen_forms`) return { data: [{ id: FORM, name: 'Fit check', status: 'ACTIVE', leads_count: 3 }, { id: '600000000000002', name: 'Old', status: 'ARCHIVED' }] }
  if (req.path === FORM) {
    return {
      id: FORM, name: 'Fit check', status: 'ACTIVE', questions: [{ key: 'email', type: 'EMAIL', label: 'Email' }], locale: 'IT_IT', page_id: PAGE,
      context_card: { id: '1', title: 'Find your size', style: 'PARAGRAPH_STYLE', content: ['Two questions'], button_text: 'Start' },
      thank_you_page: { id: '2', title: 'Thanks', body: 'We answer within a day', button_type: 'VIEW_WEBSITE', button_text: 'Shop', website_url: 'https://shop.example.com/', business_phone_number: '+000000000', gated_file: 'raw' },
      legal_content: { id: '3', privacy_policy: { url: 'https://shop.example.com/privacy', link_text: 'Privacy' }, custom_disclaimer: { title: 'Consent', body: { text: 'We may e-mail you' }, checkboxes: [{ id: '4', key: 'optional_1', text: 'E-mail me', is_required: false, is_checked_by_default: false }] } },
    }
  }
  if (/\/(leads|test_leads)$/.test(req.path)) return { data: [OWN_LEAD] }
  if (req.path === LEAD) return fields === 'id,ad_id,form_id' ? { id: LEAD, ad_id: AD, form_id: FORM } : OWN_LEAD
  if (req.operation === 'comments.threadsCreative') return { id: AD, account_id: ACCOUNT, creative: { id: '120000000000401', threads_media_id: THREADS } }
  if (req.path === THREADS) return { id: THREADS, caption: 'New jacket', username: 'shop_a', like_count: 5, reply_count: 1, hide_status: 'UNHUSHED', is_owner_verified: false, owner_profile_pic: 'raw' }
  if (req.path === `${THREADS}/replies`) return { data: [{ id: '200000000000078', caption: 'Love it', username: 'fan_1', like_count: 2, hide_status: 'HUSHED', extra: 'raw' }] }
  if (req.path === POST && fields === 'id,attachments{target{id}}') return { id: POST, attachments: { data: [{ target: { id: PHOTO } }] } }
  if (req.path === PHOTO_COMMENT && fields === 'id,object{id}') return { id: PHOTO_COMMENT, object: { id: PHOTO } }
  if (req.path === PHOTO_COMMENT) return { id: PHOTO_COMMENT, message: 'Nice photo' }
  if (req.operation === 'posts.adCreative') return { id: AD, account_id: ACCOUNT, creative: { id: '120000000000401', account_id: ACCOUNT, effective_object_story_id: POST, effective_instagram_media_id: MEDIA } }
  if (req.operation === 'instagram.mediaOwnerCheck') return { id: req.path, owner: { id: IG } }
  if (req.path === `${POST}/dynamic_posts`) return { data: [{ id: DYNAMIC, product_id: '400000000000001', title: 'Jacket' }] }
  if (/\/(comments|likes)$/.test(req.path) && req.query?.limit === 0) return { data: [], summary: { total_count: 7 } }
  if (/\/(comments|replies|ordered_comments)$/.test(req.path)) {
    return /^\d+\//.test(req.path) && !req.path.startsWith(DYNAMIC)
      ? { data: [{ id: '190000000000002', text: 'Size?', timestamp: '2026-10-20T10:00:00+0000', username: 'buyer_1', from: { id: '300000000000001', username: 'buyer_1' }, like_count: 1, hidden: false, user: { id: 'raw' }, legacy_instagram_comment_id: 'raw' }] }
      : { data: [{ id: '500000000000001_800000000000002', created_time: '2026-10-20T10:00:00+0000', message: 'Great jacket', from: { id: '300000000000001', name: 'A Person' }, like_count: 2, comment_count: 1, is_hidden: false, can_hide: true, admin_creator: { id: 'raw' } }], summary: { total_count: 12, order: 'reverse_chronological' } }
  }
  if (req.path === COMMENT) return { id: COMMENT, message: 'Great jacket', from: { id: '300000000000001', name: 'A Person' }, is_private: false, private_reply_conversation: { id: 't_1' } }
  if (req.path === IG_COMMENT) return { id: IG_COMMENT, text: 'Size?', username: 'buyer_1', media: { id: MEDIA, media_product_type: 'FEED' } }
  if (/\/sharedposts$/.test(req.path)) return { data: [{ id: '300000000000001_1', from: { id: '300000000000001', name: 'A Person' }, message: 'Look', privacy: { value: 'raw' } }] }
  if (/\/blocked$/.test(req.path)) return { data: [{ id: '300000000000009', name: 'Blocked Person', pic: 'raw' }] }
  if (/\/ratings$/.test(req.path)) return { data: [{ created_time: '2026-10-01T00:00:00+0000', recommendation_type: 'positive', review_text: 'Good', reviewer: { id: '300000000000001', name: 'A Person' }, open_graph_story: { id: '1' } }] }
  // Meta filters each page after choosing it: the first page is empty, with a cursor (and never a next link).
  if (/\/tags$/.test(req.path)) return req.query?.after ? { data: [{ id: '180000000000009', username: 'rider_1', caption: 'With @shop_a' }] } : { data: [], paging: { cursors: { after: 'c1' } } }
  if (req.path === IG && /mentioned_comment/.test(fields)) return { id: IG, mentioned_comment: { id: IG_COMMENT, text: 'Shout out to @shop_a', media: { id: '180000000000009', username: 'rider_1' } } }
  if (req.path === IG && /mentioned_media/.test(fields)) return { id: IG, mentioned_media: { id: '180000000000009', caption: 'shop_a gear', username: 'rider_1' } }
  if (/reactions\.type\((\w+)\)/.test(fields)) return { id: req.path, reactions: { data: [], summary: { total_count: fields.includes('LOVE') ? 4 : 1 } } }
  if (/reactions\.limit/.test(fields)) return { id: req.path, reactions: { data: [], summary: { total_count: 9 } }, shares: { count: 3 }, comment_count: 1 }
  if (req.path.startsWith(`${PAGE}_`) || req.path.startsWith('500000000000001_')) return { id: req.path }
  return { data: [] }
}

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.reply = ownMeta; h.known = new Map([[AD, 'ad']]) })

describe('the three tools are reads; leads and comments are people\'s data', () => {
  it('none changes anything; each reaches Meta; leads and comments need customers.view and are Claude\'s door only', () => {
    expect(META_ADS_ENGAGEMENT_TOOLS.map((t) => t.name)).toEqual(['meta-lead-forms', 'meta-leads', 'meta-comments'])
    for (const t of META_ADS_ENGAGEMENT_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, riskTier: t.riskTier, category: t.category, restrictedFields: t.restrictedFields })
        .toEqual({ name: t.name, readOnly: true, execute: undefined, openWorld: true, riskTier: 'low', category: 'insights', restrictedFields: undefined })
    }
    expect(tool('meta-lead-forms').requires).toEqual(['ads.view'])
    expect([offeredOn(tool('meta-lead-forms'), 'app'), offeredOn(tool('meta-lead-forms'), 'mcp')]).toEqual([true, true])
    for (const name of ['meta-leads', 'meta-comments']) {
      expect(tool(name).requires, name).toEqual(['ads.view', 'customers.view'])
      expect([offeredOn(tool(name), 'app'), offeredOn(tool(name), 'mcp')], name).toEqual([false, true])
    }
  })
  it('a business without Meta, or without a chosen Page / Instagram account, is told who sets it up — before any call', async () => {
    h.connections = []
    expect((await run('meta-lead-forms', { view: 'list' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, page: null, instagram: null }]
    expect((await run('meta-lead-forms', { view: 'list' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-leads', { view: 'form', formId: FORM })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-comments', { view: 'post', postId: POST })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-comments', { view: 'instagram', mediaId: MEDIA })).error).toMatch(/No Instagram account is chosen/)
    expect((await run('meta-comments', { view: 'tags' })).error).toMatch(/No Instagram account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('every view asks only what the real gateway lets through, through the edges only', () => {
  it('meta-lead-forms, meta-leads, meta-comments', async () => {
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-lead-forms', { view: 'list', statuses: ['ACTIVE'], messengerOnly: true }], ['meta-lead-forms', { view: 'form', formId: FORM }],
      ['meta-leads', { view: 'form', formId: FORM, from: '2026-10-01', to: '2026-10-20' }], ['meta-leads', { view: 'form', formId: FORM }],
      ['meta-leads', { view: 'ad', adId: AD, from: '2026-10-01' }], ['meta-leads', { view: 'lead', leadId: LEAD }], ['meta-leads', { view: 'test', formId: FORM }],
      ['meta-leads', { view: 'export' }],
      ['meta-comments', { view: 'post', postId: POST, filter: 'stream', order: 'oldest', since: '2026-10-01' }], ['meta-comments', { view: 'post', adId: AD }],
      ['meta-comments', { view: 'comment', postId: POST, commentId: COMMENT }], ['meta-comments', { view: 'replies', postId: POST, commentId: COMMENT, filter: 'toplevel' }],
      ['meta-comments', { view: 'engagement', postId: POST }], ['meta-comments', { view: 'engagement', postId: POST, commentId: COMMENT }],
      ['meta-comments', { view: 'shares', postId: POST }], ['meta-comments', { view: 'dynamic-posts', postId: POST }],
      ['meta-comments', { view: 'dynamic-comments', postId: POST, dynamicPostId: DYNAMIC }],
      ['meta-comments', { view: 'instagram', mediaId: MEDIA, since: '2026-10-01' }], ['meta-comments', { view: 'instagram', adId: AD }],
      ['meta-comments', { view: 'instagram-ordered', mediaId: MEDIA }], ['meta-comments', { view: 'instagram-comment', commentId: IG_COMMENT }],
      ['meta-comments', { view: 'instagram-replies', commentId: IG_COMMENT }], ['meta-comments', { view: 'mentioned-comment', commentId: IG_COMMENT }],
      ['meta-comments', { view: 'mentioned-media', mediaId: '180000000000009' }],
      ['meta-comments', { view: 'tags', from: '2026-10-01', to: '2026-10-20', mediaTypes: ['IMAGE', 'VIDEO'] }],
      ['meta-comments', { view: 'blocked' }], ['meta-comments', { view: 'reviews' }],
      ['meta-comments', { view: 'threads', adId: AD }], ['meta-comments', { view: 'threads-replies', adId: AD }],
      ['meta-comments', { view: 'comment', postId: POST, commentId: PHOTO_COMMENT }], ['meta-comments', { view: 'replies', postId: POST, commentId: PHOTO_COMMENT }],
      ['meta-comments', { view: 'engagement', postId: POST, commentId: PHOTO_COMMENT }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args.view, res.error])
    }
    expect(failed).toEqual([])
    expect(h.calls.length).toBeGreaterThan(50)
    expect(gatewayProblems()).toEqual([])
    // Leads, comments and lead forms only through their own edges: never inside fields.
    const fields = h.calls.map((c) => String(c.query?.fields ?? '')).join(',')
    expect(fields).not.toMatch(/(^|[^a-z_])(comments|leads|leadgen_forms|messages|conversations|creator|admin_creator|access_token)([^a-z_]|$)/)
    const paths = new Set(h.calls.map((c) => c.path.replace(/\d+/g, 'N')))
    for (const edge of ['N/leadgen_forms', 'N/leads', 'N/test_leads', 'N_N/comments', 'N/comments', 'N/ordered_comments', 'N/replies', 'N_N/sharedposts', 'N/blocked', 'N/ratings', 'N/tags', 'N/likes']) {
      expect(paths.has(edge), edge).toBe(true)
    }
  })
  it('a leads time filter is Meta\'s documented one (UTC days); test leads take none; Instagram comments are read 50 a call', async () => {
    await run('meta-leads', { view: 'form', formId: FORM, from: '2026-10-01', to: '2026-10-20' })
    const leads = h.calls.find((c) => c.path === `${FORM}/leads`)!
    expect(leads.query?.filtering).toEqual([
      { field: 'time_created', operator: 'GREATER_THAN_OR_EQUAL', value: Date.UTC(2026, 9, 1) / 1000 },
      { field: 'time_created', operator: 'LESS_THAN', value: Date.UTC(2026, 9, 21) / 1000 },
    ])
    expect(() => leadTimeFilter('2026-10-20', '2026-10-01')).toThrow(/from is after to/)
    // Review fix A6 — the days are judged before any read of Meta (the form's check reads the Page's forms).
    h.calls.length = 0
    expect((await run('meta-leads', { view: 'test', formId: FORM, from: '2026-10-01' })).error).toMatch(/Test leads take no days/)
    expect((await run('meta-leads', { view: 'form', formId: FORM, from: '2026-10-20', to: '2026-10-01' })).error).toMatch(/from is after to/)
    expect((await run('meta-leads', { view: 'ad', adId: AD, from: '2026-10-20', to: '2026-10-01' })).error).toMatch(/from is after to/)
    expect(h.calls).toHaveLength(0)
    h.calls.length = 0
    await run('meta-comments', { view: 'instagram', mediaId: MEDIA })
    expect(h.calls.find((c) => c.path === `${MEDIA}/comments`)?.query).toMatchObject({ limit: 50 })
    h.calls.length = 0
    await run('meta-comments', { view: 'post', postId: POST })
    expect(h.calls.find((c) => c.path === `${POST}/comments`)?.query).toMatchObject({ order: 'reverse_chronological', summary: true })
  })
})

describe('only the chosen Page\'s forms, the chosen account\'s ads, the chosen Page\'s posts and Instagram media', () => {
  it('a form that is not one of the chosen Page\'s is refused after the Page\'s list only: nothing of the form, no lead', async () => {
    for (const [name, args] of [
      ['meta-lead-forms', { view: 'form', formId: '600000000000099' }], ['meta-leads', { view: 'form', formId: '600000000000099' }], ['meta-leads', { view: 'test', formId: '600000000000099' }],
    ] as Array<[string, Record<string, unknown>]>) {
      h.calls.length = 0
      expect((await run(name, args)).error, name).toMatch(/not one of the lead forms of the Facebook Page this business chose/)
      expect(h.calls.map((c) => c.path), name).toEqual([`${PAGE}/leadgen_forms`])
      expect(h.calls[0].query?.fields).toBe('id')
    }
  })
  it('review B7 — when Meta will not list the Page\'s forms, the form\'s own page_id decides (fail closed)', async () => {
    const refused = (req: Req) => (req.path === `${PAGE}/leadgen_forms` ? metaError('100', '(#100) Reading leadgen_forms is not supported') : undefined)
    // The form names the chosen Page: read, after one id + page_id read.
    h.reply = (req) => refused(req) ?? ownMeta(req)
    expect((await run('meta-leads', { view: 'form', formId: FORM })).ok).toBe(true)
    expect(h.calls.slice(0, 2).map((c) => [c.path, c.query?.fields])).toEqual([[`${PAGE}/leadgen_forms`, 'id'], [FORM, 'id,page_id']])
    // Another Page, or none: refused, nothing of the form and no lead read.
    for (const pageId of ['120000000000099', undefined]) {
      h.calls.length = 0
      h.reply = (req) => refused(req) ?? (req.path === FORM ? { id: FORM, ...(pageId ? { page_id: pageId } : {}), name: 'not asked' } : ownMeta(req))
      expect((await run('meta-leads', { view: 'form', formId: FORM })).error, String(pageId)).toMatch(/not one of the lead forms of the Facebook Page this business chose/)
      expect(h.calls.map((c) => c.path), String(pageId)).toEqual([`${PAGE}/leadgen_forms`, FORM])
    }
    // Meta refuses the form's own Page too: both of Meta's sentences, nothing read.
    h.reply = (req) => refused(req) ?? (req.path === FORM ? metaError('100', '(#100) Tried accessing nonexisting field (page_id)') : ownMeta(req))
    expect((await run('meta-lead-forms', { view: 'form', formId: FORM })).error).toMatch(/listed neither .*Reading leadgen_forms is not supported.*nonexisting field \(page_id\).*does not read it/)
    // A throttle is not a refusal: it ends the read as it is (no fallback).
    h.calls.length = 0
    h.reply = (req) => (req.path === `${PAGE}/leadgen_forms` ? metaError('17', 'User request limit reached', 'rate_limited') : ownMeta(req))
    expect((await run('meta-leads', { view: 'form', formId: FORM })).error).toMatch(/slow down/)
    expect(h.calls.map((c) => c.path)).toEqual([`${PAGE}/leadgen_forms`])
  })
  it('an ad of another ad account: its leads are never read', async () => {
    h.known = new Map()
    h.reply = (req) => (req.path === '120000000000999' ? { id: req.path, account_id: '999', adset_id: '1', creative: { id: '2' } } : ownMeta(req))
    expect((await run('meta-leads', { view: 'ad', adId: '120000000000999' })).error).toMatch(/does not belong to the ad account this business chose/)
    expect(h.calls.some((c) => /\/leads$/.test(c.path))).toBe(false)
  })
  it('one lead: its ids are read first; a lead of neither the chosen account\'s ads nor the Page\'s forms is refused with nothing of it read', async () => {
    h.known = new Map()
    h.reply = (req) => {
      if (req.path === LEAD) return { id: LEAD, ad_id: '120000000000999', form_id: '600000000000099', field_data: [{ name: 'email', values: ['person@example.com'] }] }
      if (req.path === '120000000000999') return { id: req.path, account_id: '999', adset_id: '1', creative: { id: '2' } }
      return ownMeta(req)
    }
    const res = await run('meta-leads', { view: 'lead', leadId: LEAD })
    expect(res.error).toMatch(/came neither from an ad of the ad account this business chose nor from a form of its chosen Page/)
    expect(JSON.stringify(res)).not.toContain('person@example.com')
    expect(h.calls.filter((c) => c.path === LEAD).map((c) => c.query?.fields)).toEqual(['id,ad_id,form_id'])
  })
  it('a lead whose ad is the chosen account\'s is read; so is an organic lead of the Page\'s own form', async () => {
    expect((await run('meta-leads', { view: 'lead', leadId: LEAD })).ok).toBe(true)
    h.known = new Map()
    h.reply = (req) => (req.path === LEAD && req.query?.fields === 'id,ad_id,form_id' ? { id: LEAD, form_id: FORM } : ownMeta(req))
    expect((await run('meta-leads', { view: 'lead', leadId: LEAD })).ok).toBe(true)
  })
  it('a post of another Page is refused before any call', async () => {
    expect((await run('meta-comments', { view: 'post', postId: '120000000000099_500000000000001' })).error).toMatch(/not on the Facebook Page this business chose/)
    expect((await run('meta-comments', { view: 'replies', commentId: COMMENT })).error).toMatch(/Name the comment's post too/)
    expect((await run('meta-comments', { view: 'engagement', postId: '120000000000099_500000000000001' })).error).toMatch(/not on the Facebook Page/)
    expect(() => facebookCommentId(PAGE, POST, '800000000000001')).toThrow(/not a Facebook comment id/)
    expect(facebookCommentId(PAGE, POST, COMMENT)).toMatchObject({ prefixMatches: true })
    expect(h.calls).toHaveLength(0)
  })
  it('review A1 — a comment is confirmed by Meta before its replies are listed; a reply of another post is dropped and counted', async () => {
    // Meta answers another comment for that id: nothing is listed.
    h.reply = (req) => (req.path === COMMENT && req.query?.fields === 'id' ? { id: '500000000000099_800000000000001' } : ownMeta(req))
    for (const view of ['replies', 'comment', 'engagement']) {
      h.calls.length = 0
      expect((await run('meta-comments', { view, postId: POST, commentId: COMMENT })).error, view).toMatch(/not on that post of the Facebook Page this business chose/)
      expect(h.calls.some((c) => c.path === `${COMMENT}/comments` || /reactions/.test(String(c.query?.fields)) || c.operation === 'comments.comment'), view).toBe(false)
    }
    // A reply that does not carry the post's id is not shown.
    h.reply = (req) => (req.path === `${COMMENT}/comments`
      ? { data: [{ id: '500000000000001_800000000000002', message: 'Same post' }, { id: '500000000000099_800000000000009', message: 'Another Page\'s reply', from: { id: '300000000000099', name: 'B Person' } }], summary: { total_count: 2 } }
      : ownMeta(req))
    const res = await run('meta-comments', { view: 'replies', postId: POST, commentId: COMMENT })
    expect(res.data).toMatchObject({ droppedNotOnPost: 1, items: [expect.objectContaining({ commentId: '500000000000001_800000000000002' })] })
    expect(JSON.stringify(res)).not.toMatch(/B Person|Another Page/)
    const order = h.calls.map((c) => c.operation)
    expect(order.indexOf('comments.commentCheck')).toBeLessThan(order.indexOf('comments.replies'))
  })
  it('review B5 — a comment of a photo or video post: Meta\'s object must be the post\'s own photo or video (fail closed)', async () => {
    const res = await run('meta-comments', { view: 'replies', postId: POST, commentId: PHOTO_COMMENT })
    expect(res.ok).toBe(true)
    expect(h.calls.filter((c) => c.path === POST || c.path === PHOTO_COMMENT).map((c) => c.query?.fields)).toEqual(['id', 'id,attachments{target{id}}', 'id,object{id}'])
    for (const [label, answer] of [
      ['another object', { id: PHOTO_COMMENT, object: { id: '210000000000099' } }], ['no object', { id: PHOTO_COMMENT }], ['another id', { id: '210000000000099_1', object: { id: PHOTO } }],
    ] as Array<[string, Row]>) {
      h.calls.length = 0
      h.reply = (req) => (req.path === PHOTO_COMMENT && req.query?.fields === 'id,object{id}' ? answer : ownMeta(req))
      expect((await run('meta-comments', { view: 'comment', postId: POST, commentId: PHOTO_COMMENT })).error, label).toMatch(/not on that post of the Facebook Page this business chose/)
      expect(h.calls.some((c) => c.operation === 'comments.comment'), label).toBe(false)
    }
    // A comment on another post entirely: refused after its object read alone.
    h.reply = ownMeta
    h.calls.length = 0
    expect((await run('meta-comments', { view: 'comment', postId: POST, commentId: '500000000000099_800000000000001' })).error).toMatch(/not on that post of the Facebook Page/)
    expect(h.calls.map((c) => [c.path, c.query?.fields])).toEqual([[POST, 'id'], [POST, 'id,attachments{target{id}}'], ['500000000000099_800000000000001', 'id,object{id}']])
  })
  it('an ad\'s post on another Page is refused; Meta answering another post\'s id returns nothing of it', async () => {
    h.reply = (req) => (req.operation === 'posts.adCreative' ? { id: AD, account_id: ACCOUNT, creative: { id: '1', account_id: ACCOUNT, effective_object_story_id: '120000000000099_500000000000001' } } : ownMeta(req))
    expect((await run('meta-comments', { view: 'post', adId: AD })).error).toMatch(/not on the Facebook Page this business chose/)
    h.reply = (req) => (req.operation === 'comments.postCheck' ? { id: '120000000000099_500000000000001' } : ownMeta(req))
    expect((await run('meta-comments', { view: 'post', postId: POST })).error).toMatch(/not on the Facebook Page this business chose/)
    expect(h.calls.some((c) => /\/comments$/.test(c.path))).toBe(false)
  })
  it('an Instagram comment on another account\'s media is refused after reading its media id only', async () => {
    h.reply = (req) => {
      if (req.path === IG_COMMENT) return { id: IG_COMMENT, media: { id: '180000000000099' }, text: 'not asked' }
      if (req.operation === 'instagram.mediaOwnerCheck') return { id: req.path, owner: { id: '170000000000099' } }
      return ownMeta(req)
    }
    for (const view of ['instagram-comment', 'instagram-replies']) {
      h.calls.length = 0
      expect((await run('meta-comments', { view, commentId: IG_COMMENT })).error, view).toMatch(/not the chosen Instagram account's/)
      expect(h.calls.map((c) => [c.path, c.query?.fields]), view).toEqual([[IG_COMMENT, 'id,media{id}'], ['180000000000099', 'id,owner,username,media_product_type']])
    }
  })
  it('a catalog-ad post not made from the chosen Page\'s post is refused', async () => {
    expect((await run('meta-comments', { view: 'dynamic-comments', postId: POST, dynamicPostId: '900000000000099' })).error).toMatch(/not made from that post of the chosen Page/)
    expect(h.calls.some((c) => c.path === '900000000000099/comments')).toBe(false)
  })
  it('the lead file is answered in words, with no call', async () => {
    expect((await run('meta-leads', { view: 'export' })).data).toMatchObject({ notRead: expect.stringMatching(/on www\.facebook\.com .*not on the Graph API/), instead: expect.stringMatching(/view form with formId, from and to/) })
    expect(h.calls).toHaveLength(0)
  })
  it('review B6 — Threads: only an ad of the chosen account, through its creative\'s threads_media_id; named keys only', async () => {
    const post = await run('meta-comments', { view: 'threads', adId: AD })
    expect(post.data).toMatchObject({ adId: AD, threadsMediaId: THREADS, post: { caption: 'New jacket', likes: 5, replies: 1, hidden: false, ownerVerified: false }, note: THREADS_NOTE })
    expect(h.calls.map((c) => [c.path, c.query?.fields])).toEqual([[AD, 'id,account_id,creative{id,threads_media_id}'], [THREADS, expect.stringMatching(/^id,caption,/)]])
    const replies = await run('meta-comments', { view: 'threads-replies', adId: AD })
    expect(replies.data).toMatchObject({ items: [{ threadsMediaId: '200000000000078', caption: 'Love it', username: 'fan_1', hidden: true }] })
    expect(JSON.stringify([post, replies])).not.toMatch(/"raw"|owner_profile_pic|extra/)
    expect(gatewayProblems()).toEqual([])
    // An ad of another account: nothing of Threads is read.
    h.known = new Map()
    h.calls.length = 0
    h.reply = (req) => (req.path === '120000000000999' ? { id: req.path, account_id: '999', adset_id: '1', creative: { id: '2' } } : ownMeta(req))
    expect((await run('meta-comments', { view: 'threads', adId: '120000000000999' })).error).toMatch(/does not belong to the ad account this business chose/)
    expect(h.calls.some((c) => c.path === THREADS || c.operation === 'comments.threadsCreative')).toBe(false)
    // No Threads post on the creative, or Meta refuses the field: said, nothing read.
    h.known = new Map([[AD, 'ad']])
    h.reply = (req) => (req.operation === 'comments.threadsCreative' ? { id: AD, account_id: ACCOUNT, creative: { id: '1' } } : ownMeta(req))
    expect((await run('meta-comments', { view: 'threads-replies', adId: AD })).error).toMatch(/names no Threads post on that ad's creative/)
    h.reply = (req) => (req.operation === 'comments.threadsCreative' ? metaError('100', '(#100) Tried accessing nonexisting field (threads_media_id)') : ownMeta(req))
    expect((await run('meta-comments', { view: 'threads', adId: AD })).error).toMatch(/did not answer which Threads post .*nonexisting field/)
    expect((await run('meta-comments', { view: 'threads' })).error).toMatch(/Name the ad/)
  })
})

describe('people\'s data: named keys only; Meta\'s refusals in plain words', () => {
  it('a lead keeps only its named keys: answers by question key, consent boxes exactly as Meta gives them', async () => {
    const res = await run('meta-leads', { view: 'form', formId: FORM })
    const lead = (res.data as { items: Array<Record<string, unknown>> }).items[0]
    expect(lead).toEqual(leadRow(OWN_LEAD))
    expect(Object.keys(lead).sort()).toEqual(['adId', 'adName', 'adSetId', 'adSetName', 'answers', 'campaignId', 'campaignName', 'catalogItemId', 'consent', 'createdTime', 'formId', 'leadId', 'organic', 'platform'])
    expect(lead).toMatchObject({
      answers: [{ question: 'full_name', values: ['A Person'] }, { question: 'email', values: ['person@example.com'] }],
      consent: [{ checkboxKey: 'optional_1', isChecked: '1' }, { checkboxKey: 'optional_2', isChecked: '' }],
      catalogItemId: 'SKU-1', organic: false,
    })
    expect(JSON.stringify(res)).not.toMatch(/Partner X|unknown_new_field|vehicle|home_listing/)
  })
  it('comments, shares, blocked people, reviews and mentions keep only their named keys', async () => {
    const post = (await run('meta-comments', { view: 'post', postId: POST })).data as Record<string, unknown>
    expect(post).toMatchObject({ totalCount: 12, items: [expect.objectContaining({ message: 'Great jacket', by: { id: '300000000000001', name: 'A Person' }, byThePage: false, replies: 1, canHide: true })] })
    expect(JSON.stringify(post)).not.toContain('admin_creator')
    const ig = (await run('meta-comments', { view: 'instagram', mediaId: MEDIA })).data as { items: Array<Record<string, unknown>> }
    expect(ig.items[0]).toEqual({ commentId: '190000000000002', createdTime: '2026-10-20T10:00:00+0000', text: 'Size?', byTheAccount: false, by: { id: '300000000000001', username: 'buyer_1' }, likes: 1, hidden: false, parentCommentId: null })
    const all = JSON.stringify(await Promise.all([
      run('meta-comments', { view: 'shares', postId: POST }), run('meta-comments', { view: 'blocked' }), run('meta-comments', { view: 'reviews' }),
    ]))
    expect(all).not.toMatch(/"privacy"|"pic"|"raw"/)
    expect(all).toContain('Blocked Person')
  })
  it('engagement is counts only: reactions in all and per type, comments, shares — nobody\'s reaction, no person\'s id', async () => {
    const res = (await run('meta-comments', { view: 'engagement', postId: POST })).data as Record<string, unknown>
    expect(res).toMatchObject({ reactions: 9, reactionsByType: { LIKE: 1, LOVE: 4, WOW: 1, HAHA: 1, SORRY: 1, ANGRY: 1 }, comments: 7, shares: 3 })
    expect(res).not.toHaveProperty('sorryAskedAs')
    expect(h.calls.filter((c) => /reactions/.test(String(c.query?.fields))).every((c) => /\.limit\(0\)\.summary\(total_count\)/.test(String(c.query?.fields)))).toBe(true)
    // Review B8 — every count read asks limit 0 (no comment or like is fetched).
    await run('meta-comments', { view: 'dynamic-posts', postId: POST })
    const counts = h.calls.filter((c) => /^comments\.(count|dynamicCommentCount|dynamicLikeCount)$/.test(c.operation))
    expect(counts.length).toBe(3)
    expect(counts.every((c) => c.query?.limit === 0)).toBe(true)
  })
  it('review B4 — Meta refusing SORRY (#100) is asked again as SAD (the SDK\'s name)', async () => {
    h.reply = (req) => (String(req.query?.fields).includes('type(SORRY)') ? metaError('100', '(#100) Param type must be one of {NONE, LIKE, LOVE, WOW, HAHA, SAD, ANGRY}') : String(req.query?.fields).includes('type(SAD)') ? { id: req.path, reactions: { summary: { total_count: 2 } } } : ownMeta(req))
    const res = (await run('meta-comments', { view: 'engagement', postId: POST })).data as Record<string, unknown>
    expect(res).toMatchObject({ reactionsByType: { SORRY: 2 }, sorryAskedAs: 'SAD' })
    expect(gatewayProblems()).toEqual([])
  })
  it('Meta refusing a lead read for the app\'s access says what it takes (D4) and where real leads are', async () => {
    h.reply = (req) => (/\/leads$/.test(req.path) ? metaError('200', '(#200) Requires leads_retrieval permission', 'forbidden') : ownMeta(req))
    const res = await run('meta-leads', { view: 'form', formId: FORM })
    expect(res.error).toContain('Requires leads_retrieval permission')
    expect(res.error).toContain(LEADS_ACCESS)
    expect(res.error).toMatch(/App Review .*leads_retrieval.*Business Verification.*Live.*Leads Center/)
  })
  it('a Page read Meta refuses for the token says the Page-token way; comment lists say an empty list may mean the token', async () => {
    h.reply = (req) => (/\/blocked$/.test(req.path) ? metaError('190', '(#190) This method must be called with a Page Access Token', 'auth_revoked') : ownMeta(req))
    const pageToken = (await run('meta-comments', { view: 'blocked' })).error
    expect(pageToken).toMatch(/only to the Page's own access token, not to the business's system-user token, which still works \(Meta's words: \(#190\) This method must be called with a Page Access Token\)/)
    expect(pageToken).toContain(PAGE_TOKEN_NOTE)
    expect(pageToken).not.toMatch(/Make a new token/)
    h.reply = ownMeta
    expect(((await run('meta-comments', { view: 'post', postId: POST })).data as { note: string }).note).toMatch(/empty list is not proof/)
  })
  it('review A5 — a token Meta no longer accepts keeps the lost-token sentence: no D4 or Page-token advice', async () => {
    const lost = metaError('190', '(#190) Error validating access token: The session has been invalidated', 'auth_revoked')
    h.reply = (req) => (/\/leads$/.test(req.path) || /\/blocked$/.test(req.path) ? lost : ownMeta(req))
    for (const [name, args] of [['meta-leads', { view: 'form', formId: FORM }], ['meta-comments', { view: 'blocked' }]] as Array<[string, Record<string, unknown>]>) {
      const error = (await run(name, args)).error
      expect(error, name).toBe(lost.message)
      expect(error, name).toMatch(/no longer accepts this business's system-user token.*Make a new token/)
      expect(error, name).not.toContain(LEADS_ACCESS)
      expect(error, name).not.toContain(PAGE_TOKEN_NOTE)
    }
  })
  it('review B3 — a form\'s intro, thank-you page and consent boxes come back by their own fields; a refused group is named', async () => {
    const res = await run('meta-lead-forms', { view: 'form', formId: FORM })
    expect(res.data).toMatchObject({ form: {
      formId: FORM, name: 'Fit check', questions: [{ key: 'email', type: 'EMAIL', label: 'Email' }],
      intro: { title: 'Find your size', style: 'PARAGRAPH_STYLE', content: ['Two questions'], buttonText: 'Start' },
      thankYouPage: { title: 'Thanks', body: 'We answer within a day', buttonType: 'VIEW_WEBSITE', buttonText: 'Shop', websiteUrl: 'https://shop.example.com/', businessPhoneNumber: '+000000000' },
      privacyPolicy: { url: 'https://shop.example.com/privacy', linkText: 'Privacy' },
      consentBoxes: { title: 'Consent', body: 'We may e-mail you', checkboxes: [{ key: 'optional_1', text: 'E-mail me', required: false, checkedByDefault: false }] },
    } })
    expect(JSON.stringify(res)).not.toMatch(/gated_file|"raw"/)
    expect(String(h.calls.find((c) => c.path === FORM)?.query?.fields)).toContain('context_card{title,style,content,button_text},thank_you_page{title,body,button_type,button_text,website_url,business_phone_number},legal_content{privacy_policy,custom_disclaimer}')
    expect(h.calls.map((c) => String(c.query?.fields)).join(',')).not.toContain('is_eligible_for_in_thread_forms')
    h.reply = (req) => (req.path !== FORM ? ownMeta(req)
      : String(req.query?.fields).includes('context_card') ? metaError('100', '(#100) Tried accessing nonexisting field (context_card)')
        : { id: FORM, name: 'Fit check', status: 'ACTIVE', questions: [], locale: 'IT_IT' })
    const partial = await run('meta-lead-forms', { view: 'form', formId: FORM })
    expect(partial.data).toMatchObject({ form: { formId: FORM, intro: null }, notRead: [{ part: 'setup' }] })
  })
  it('review B1 — messengerOnly asks Meta\'s in-thread list on its own read; its ids are the eligible forms; the plain list never asks it', async () => {
    const res = (await run('meta-lead-forms', { view: 'list', messengerOnly: true })).data as { items: Array<Record<string, unknown>> }
    expect(res.items).toEqual([expect.objectContaining({ formId: FORM, sendableInMessenger: true })])
    expect(h.calls.filter((c) => c.path === `${PAGE}/leadgen_forms`).map((c) => c.query?.fields)).toEqual(['id,name,status,locale,created_time,leads_count,expired_leads_count,organic_leads_count', 'id,is_eligible_for_in_thread_forms'])
    // A form Meta answers false for is not eligible.
    h.reply = (req) => (req.query?.fields === 'id,is_eligible_for_in_thread_forms' ? { data: [{ id: FORM, is_eligible_for_in_thread_forms: false }] } : ownMeta(req))
    expect(((await run('meta-lead-forms', { view: 'list', messengerOnly: true })).data as { items: unknown[] }).items).toEqual([])
    h.reply = ownMeta
    h.calls.length = 0
    const archived = (await run('meta-lead-forms', { view: 'list', statuses: ['ARCHIVED'] })).data as { items: Array<Record<string, unknown>> }
    expect(archived.items).toEqual([expect.objectContaining({ formId: '600000000000002', statusText: expect.stringMatching(/archived/) })])
    expect(archived.items[0]).not.toHaveProperty('sendableInMessenger')
    expect(h.calls).toHaveLength(1)
  })
  it('review B2 — tags: page on the cursor alone (an empty page is not the end), more while a cursor comes back; to is the next day\'s start', async () => {
    const res = (await run('meta-comments', { view: 'tags', from: '2026-10-01', to: '2026-10-20' })).data as Record<string, unknown>
    expect(res).toMatchObject({ items: [{ mediaId: '180000000000009', username: 'rider_1' }], more: false })
    const tagCalls = h.calls.filter((c) => c.operation === 'comments.tags')
    expect(tagCalls.map((c) => c.query?.after)).toEqual([undefined, 'c1'])
    expect(tagCalls[0].query).toMatchObject({ posted_after: '2026-10-01T00:00:00', posted_before: '2026-10-21T00:00:00' })
    // A cursor on every page: at most 10 pages, then more.
    h.calls.length = 0
    let n = 0
    h.reply = (req) => (/\/tags$/.test(req.path) ? { data: [], paging: { cursors: { after: `c${++n}` } } } : ownMeta(req))
    expect((await run('meta-comments', { view: 'tags' })).data).toMatchObject({ items: [], more: true })
    expect(h.calls.filter((c) => c.operation === 'comments.tags')).toHaveLength(10)
    expect(gatewayProblems()).toEqual([])
  })
  it('review A4 — only real calendar days are taken, before any call', async () => {
    expect(isRealDay('2026-10-21')).toBe(true)
    for (const day of ['2026-13-01', '2026-02-30', '2026-00-10', '2026-1-01']) {
      expect(isRealDay(day), day).toBe(false)
      expect(() => tool('meta-leads').input.parse({ view: 'form', formId: FORM, from: day }), day).toThrow()
      expect(() => tool('meta-comments').input.parse({ view: 'tags', to: day }), day).toThrow()
    }
    expect(() => leadTimeFilter('2026-02-30', null)).toThrow(/not a day/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('review A6 — through the one door: people\'s data needs customers.view, and never reaches the in-app chat', () => {
  const principal = (permissions: string[], via: 'claude' | 'app'): UserPrincipal => ({
    kind: 'user', userId: 'u-meta-14', label: 'step 14 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: null as never, via,
  })
  it('without customers.view meta-leads and meta-comments are forbidden (meta-lead-forms is not); in the app they do not exist', async () => {
    const adsOnly = principal(['ads.view'], 'claude')
    await expect(callTool(adsOnly, 'meta-leads', { view: 'export' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(callTool(adsOnly, 'meta-comments', { view: 'blocked' })).rejects.toMatchObject({ code: 'forbidden' })
    const both = principal(['ads.view', 'customers.view'], 'app')
    await expect(callTool(both, 'meta-leads', { view: 'export' })).rejects.toMatchObject({ code: 'unknown_tool' })
    await expect(callTool(both, 'meta-comments', { view: 'blocked' })).rejects.toMatchObject({ code: 'unknown_tool' })
    expect(h.calls).toHaveLength(0)
  })
})
