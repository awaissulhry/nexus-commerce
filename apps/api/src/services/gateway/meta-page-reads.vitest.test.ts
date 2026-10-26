/**
 * Meta step 15 on the gateway — the chosen Page's conversations, inbox and messaging setup are read with the chosen Page's
 * OWN token (step 36's Page token mode), on an exact ALLOW-list (meta-page-reads.ts): only these routes, only their keys,
 * `fields` only their items, limit and after only as Meta writes them; a conversation id only in Meta's own two forms (a
 * positive pattern); the Page in the path only the CHOSEN Page (another: refused, no token read, nothing sent — a
 * Page-shaped template read too); a conversation's node and messages with the chosen Page's token; a WhatsApp account's
 * templates an ordinary read with the system-user token; the Page's token never in an answer or the ledger.
 * Fix round 1 (A1–A3): Page-token calls (the token's read too) take the `page` bucket and WhatsApp-account reads the
 * `whatsapp` one, never the ad account's; Meta's own limit of that Page / Instagram / LeadGen / Messenger (80001, 80002,
 * 80005, 80006) or WhatsApp account (80008) holds THAT bucket only; any other throttle holds the ads bucket as before; and
 * the same codes on a system-user read still hold the ads bucket. Made-up ids only.
 * Live-probe fixes (2026-10-26): the chosen Page's feed, published and ad posts, a post's catalog-ad posts, Page and post
 * insights and the Instant Experience list go with the Page's token too (exact keys, values and fields); another Page's
 * feed stays a system-user read; a campaign's or Instagram account's insights are no Page read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest, bucketKey, HOLD_LUA, META_BUCKETS, observeRate, takeToken, type RedisLike } from './rate.js'
import { metaCall, metaWriteCall } from './meta.js'
import { metaCallVerdict, metaReadOnlyProblem } from './meta-calls.js'
import { META_PAGE_READ_RULES, META_THREAD_ID, metaPageReadOf, metaWhatsAppRead, topLevelFieldItems } from './meta-page-reads.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'
import { META_IX_TEMPLATE_IDS, META_IX_TEMPLATE_READ } from '../meta/meta-media-lists.js'
import { META_IX_TEMPLATE_IDS as CANVAS_TEMPLATE_IDS } from './meta-canvas-rules.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000011'
const WABA = '500000000000001'
const CONV = 't_400000000000001'
const IG_CONV = 'aWdfZAG06MTpJR01lc3N3Njkz'
const PERSON = '300000000000001'
const PAGE_TOKEN = 'EAAPageTokenForStep15Tests1234567890'
const pageToken = () => new Response(JSON.stringify({ id: PAGE, access_token: PAGE_TOKEN }), { status: 200 })
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const verdict = (path: string, auth?: unknown) => metaCallVerdict({ method: 'GET', url: `${BASE}/${path}`, kind: 'read', auth })
const tokenOf = (i: number) => new URL(h.calls[i].url).searchParams.get('access_token')

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ data: [] }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

/** Every read live-messaging.ts sends with the Page's token, as it sends it. */
const PAGE_READS: Array<[string, string | null]> = [
  [`${PAGE}/conversations?platform=messenger&fields=id,updated_time,participants,message_count,unread_count,snippet,can_reply,link,is_owner&limit=100`, PAGE],
  [`${PAGE}/conversations?platform=instagram&folder=partnership&user_id=${PERSON}&fields=id,participants&limit=5`, PAGE],
  [`${CONV}?fields=id,participants`, null],
  [`${IG_CONV}?fields=id,participants`, null],
  [`${CONV}/messages?fields=id,created_time,from,to,message,attachments{id,name,file_url,image_data,video_data},shares{id,name,description,type,url},story,is_unsupported,reply_to&limit=20&after=QVFIUmxtX0Z6dGFCLTNnVXc9`, null],
  [`${IG_CONV}/messages?fields=id,created_time,from,to,message&limit=20`, null],
  [`${PAGE}/custom_labels?fields=id,page_label_name&limit=100`, PAGE],
  [`${PAGE}/thread_owner?recipient=${PERSON}&fields=thread_owner`, PAGE],
  [`${PAGE}/messenger_call_permissions?psid=${PERSON}&fields=permission,actions`, PAGE],
  [`${PAGE}/custom_user_settings?psid=${PERSON}&fields=page_level_persistent_menu,user_level_persistent_menu`, PAGE],
  [`${PAGE}/messenger_profile?platform=instagram&fields=get_started,ice_breakers,persistent_menu,whitelisted_domains,greeting,account_linking_url,commands,subject_to_new_eu_privacy_rules`, PAGE],
  [`${PAGE}/personas?fields=id,name,profile_picture_url&limit=100`, PAGE],
  [`${PAGE}/welcome_message_flows?flow_id=520000000000001&fields=id,name,eligible_platforms,last_update_time,is_used_in_ad,welcome_message,welcome_message_flow,welcome_message_sequence,is_ig_only_flow,compatible_platforms&limit=100`, PAGE],
  [`${PAGE}/chat_plugin?fields=theme_color,welcome_screen_greeting`, PAGE],
  [`${PAGE}/messaging_feature_review?fields=feature,status&limit=100`, PAGE],
  [`${PAGE}/messenger_call_settings?fields=audio_enabled,video_enabled,icon_enabled,call_hours,call_routing`, PAGE],
  [`${PAGE}/message_templates?name=order_update&name_or_content=ordine&language=it,de_DE&status=APPROVED&fields=id,name,category,language,status,components,parameter_format,library_template_name,rejected_reason,rejection_reasons,specific_rejection_reasons,creation_time,last_updated_time&limit=100`, PAGE],
  [`${PAGE}/messenger_lead_forms?fields=id,privacy_url,reminder_text,stop_question_message,first_step_id,fblead_form{id}&limit=100`, PAGE],
  [`${PAGE}/ctx_optimization_eligibility?fields=ctm`, PAGE],
]

describe('the allow-list: which reads go with the Page\'s token', () => {
  it('each of the Page\'s own reads, exactly as live-messaging sends it, goes with the token of the Page in its path (a conversation: the chosen Page\'s)', () => {
    for (const [path, pageId] of PAGE_READS) {
      expect(verdict(path), path).toEqual({ problem: null, renewalClientId: null, pageRead: { pageId } })
    }
    // Step 38 (review B-F5) — the creator lookup on the chosen Instagram account (its id in instagramId, the Page's token).
    expect(verdict('170000000000010/creator_marketplace_creators?username=creator.a&fields=id,page_id,messaging_id')).toEqual({ problem: null, renewalClientId: null, pageRead: { pageId: null, instagramId: '170000000000010' } })
    expect(verdict('170000000000010/creator_marketplace_creators?username=creator.a&fields=id,username').pageRead).toBeUndefined()
    // Gap 46b — and Meta's Instant Experience templates, a Page video's thumbnails, a post of the chosen Page by its id and the
    // owner read of a Page photo or video (their describes below).
    // Re-review: one exact rule per Page photo / video field list (4 lists).
    expect(META_PAGE_READ_RULES).toHaveLength(32)
  })
  it('every other read stays a system-user read: the Page node, its other edges, a WhatsApp account, an ad account, a post', () => {
    for (const path of [
      `${PAGE}?fields=id,instagram_business_account`, `${PAGE}?fields=id,messaging_feature_status`, `${PAGE}/live_videos?fields=id`,
      `${PAGE}/canvas_elements?fields=element`,
      'act_1234567890/connected_instagram_accounts_with_iabp?fields=id,iabp_id&business_id=9876543210',
      '170000000000001/connected_threads_user?fields=threads_user_id', `${PAGE}_500000000000001/comments?fields=id`, '540000000000001/steps?fields=id,message&limit=100',
    ]) {
      const v = verdict(path)
      expect(v.problem, path).toBeNull()
      expect([v.pageRead, v.whatsappRead], path).toEqual([undefined, undefined])
    }
    // The WhatsApp account's reads: system-user token, the `whatsapp` bucket. Its template reads name `summary` on every page
    // (live-messaging.ts), so they are never Page-shaped.
    for (const path of [
      '9876543210/owned_whatsapp_business_accounts?fields=id,name&limit=50', `${WABA}/phone_numbers?fields=id,display_phone_number&limit=100`,
      `${WABA}/message_templates?fields=id,name,category,language,status,components,parameter_format,sub_category,quality_score&summary=total_count&limit=100`,
      `${WABA}/message_templates?fields=id,name,category,language,status,components&summary=total_count&limit=100&after=QVFIUmxtX0Z6dGFCLTNnVXc9`,
      `${WABA}/message_templates?fields=id,name&category=UTILITY&quality_score=GREEN&since=1759276800&summary=total_count&limit=100`,
      `${WABA}/template_groups?fields=id,name&limit=100`, `510000000000001?fields=${encodeURIComponent('id,whatsapp_business_account{id}')}`,
      `${WABA}?fields=${encodeURIComponent('id,pricing_analytics.start(1759276800).end(1760918400).granularity(DAILY)')}`,
    ]) {
      const v = verdict(path)
      expect([v.problem, v.pageRead, v.whatsappRead], path).toEqual([null, undefined, true])
    }
    expect(metaWhatsAppRead(`${PAGE}/message_templates`, new URLSearchParams('fields=id'), true)).toBe(false)
    // The Page's connected apps keep step 30 part 3's own rule.
    expect(verdict(`${PAGE}/subscribed_apps?fields=id,subscribed_fields`).pageRead).toEqual({ pageId: PAGE })
  })
  it('review fix A4 — a conversation id is one of Meta\'s two forms (a positive pattern): t_<digits>, or aWdf + letters and digits', () => {
    for (const id of [CONV, IG_CONV, 't_1', `aWdf${'Z9'.repeat(6)}`]) {
      expect(META_THREAD_ID.test(id), id).toBe(true)
      expect(verdict(`${id}?fields=id,participants`).pageRead, id).toEqual({ pageId: null })
      expect(verdict(`${id}/messages?fields=id,message`).pageRead, id).toEqual({ pageId: null })
    }
    // Anything else is no conversation: digits alone (any node), a post id, an ad account, Meta's root edges, a message id,
    // the Instagram form in another case or with _, too short, too long, letters-and-digits of any other shape.
    for (const id of ['120000000000001', `${PAGE}_500000000000001`, 'act_1234567890', 'message_template_library', 'me', 't_abc', 't_1_2',
      'm_AG5Hz2Uq7tuwNEhXfYYKj8', 'AbCdEfGh12345678', 'awdfZAG06MTpJR01lc3N3Njkz', 'aWdfZAG06_MTpJR01lc3N3', 'aWdf123', `aWdf${'a'.repeat(197)}`]) {
      expect(META_THREAD_ID.test(id), id).toBe(false)
      // Gap 46b — a post id is the post rule's (never a conversation's): `participants` is no field of a post, so its read is
      // refused for the chosen Page (otherPages problem), never sent as a conversation read.
      if (id === `${PAGE}_500000000000001`) expect(verdict(`${id}?fields=id,participants`).pageRead, id).toMatchObject({ pageId: PAGE, otherPages: { problem: expect.stringMatching(/a post of the chosen Page are read with fields from/) } })
      else expect(verdict(`${id}?fields=id,participants`).pageRead, id).toBeUndefined()
      expect(verdict(`${id}/messages?fields=id,message`).pageRead, id).toBeUndefined()
    }
  })
  it('on these routes: exactly their keys, their fields (each once, as written), limit 1–100, after Meta\'s cursor, no token asked', () => {
    for (const [path, words] of [
      [`${PAGE}/conversations?platform=messenger&fields=id,name`, /the Page's conversations are read with fields from id, updated_time, participants/],
      [`${PAGE}/conversations?platform=messenger&fields=id,participants{email}`, /are read with fields from/],
      [`${PAGE}/conversations?fields=id,id`, /each once/],
      [`${PAGE}/conversations?platform=messenger`, /are read with fields from/],
      [`${PAGE}/conversations?fields=id&summary=total_count`, /are read with fields, limit, after, platform, user_id, folder only \(not "summary"\)/],
      [`${CONV}?fields=id,participants&limit=5`, /a conversation are read with fields only \(not "limit"\)/],
      [`${CONV}?fields=id,updated_time`, /a conversation are read with fields from id, participants only/],
      [`${CONV}/messages?fields=id,message,attachments{id,file_url}`, /messages are read with fields from/],
      [`${CONV}/messages?fields=id,message,attachments`, /messages are read with fields from/],
      [`${PAGE}/messenger_profile?fields=get_started,target_audience`, /Messenger profile are read with fields from/],
      [`${PAGE}/personas?fields=id&before=QVFI`, /not "before"/],
      [`${PAGE}/custom_labels?fields=id&limit=0`, /a limit of digits only, 1 to 100/],
      [`${PAGE}/custom_labels?fields=id&limit=101`, /a limit of digits only, 1 to 100/],
      [`${PAGE}/custom_labels?fields=id&limit=1.fields(access_token)`, /./],
      [`${PAGE}/custom_labels?fields=id&after=QVFI.fields(id)`, /after as Meta's own cursor only/],
      [`${PAGE}/custom_labels?fields=id&after=${'Q'.repeat(513)}`, /after as Meta's own cursor only/],
      [`${PAGE}/message_templates?fields=id,access_token`, /token/],
    ] as Array<[string, RegExp]>) {
      expect(verdict(path).problem, path).toMatch(words)
    }
    expect(verdict(`${PAGE}/custom_labels?fields=id`, 'app').problem).toMatch(/a caller asks for no token/)
    expect(verdict(`${PAGE}/custom_labels?fields=id`, { token: 'x' }).problem).toMatch(/a caller asks for no token/)
    expect(verdict(`${PAGE}/custom_labels?fields=id`, 'account').problem).toBeNull()
  })
  it('message_templates: the Messenger read of a Page with its own keys and fields; with a WhatsApp key or field, an ordinary read', () => {
    expect(metaPageReadOf('120000000000010/message_templates', [PAGE, 'message_templates'], new URLSearchParams('fields=id,name&status=APPROVED'), undefined)).toEqual({ pageId: PAGE })
    expect(metaPageReadOf('500000000000001/message_templates', [WABA, 'message_templates'], new URLSearchParams('fields=id,name&summary=total_count'), undefined)).toBeNull()
    expect(metaPageReadOf('500000000000001/message_templates', [WABA, 'message_templates'], new URLSearchParams('fields=id,name&quality_score=GREEN'), undefined)).toBeNull()
    expect(metaPageReadOf('500000000000001/message_templates', [WABA, 'message_templates'], new URLSearchParams('fields=id,sub_category'), undefined)).toBeNull()
  })
  it('the fields split keeps a {…} or (…) list with its item, and refuses an unbalanced one', () => {
    expect(topLevelFieldItems('id,attachments{id,name},whatsapp_business_templates.limit(100){id,name}')).toEqual(['id', 'attachments{id,name}', 'whatsapp_business_templates.limit(100){id,name}'])
    for (const bad of ['id,a{b', 'id}', 'a(b']) expect(topLevelFieldItems(bad), bad).toBeNull()
  })
})

/** Live-probe fixes — every read of these edges as live-media.ts (and live-engagement.ts, live-partners.ts) sends it. */
const POST_FIELDS = 'id,message,story,created_time,updated_time,permalink_url,status_type,is_published,is_hidden,is_expired,is_eligible_for_promotion,promotable_id,scheduled_publish_time,full_picture,is_instagram_eligible,from{id}'
const POST = `${PAGE}_500000000000001`
const PROBE_READS: Array<[string, Record<string, unknown>]> = [
  [`${PAGE}/feed?fields=${POST_FIELDS},is_inline_created&include_hidden=true&show_expired=true&limit=50`, { pageId: PAGE, otherPages: { problem: null } }],
  [`${PAGE}/feed?fields=id,message,created_time,permalink_url,status_type&limit=25&after=QVFIUmxtX0Z6dGFCLTNnVXc9`, { pageId: PAGE, otherPages: { problem: null } }],
  [`${PAGE}/published_posts?fields=${POST_FIELDS}&limit=50`, { pageId: PAGE }],
  [`${PAGE}/ads_posts?include_inline_create=true&exclude_dynamic_ads=true&since=2026-10-01&until=2026-10-20&fields=${POST_FIELDS},is_inline_created&limit=50`, { pageId: PAGE }],
  [`${POST}/dynamic_posts?fields=id,title,message,description,link,image_url,product_id,created&limit=50`, { pageId: PAGE }],
  [`${POST}/dynamic_posts?fields=id,owner_id,product_id,title,created&limit=10`, { pageId: PAGE }],
  [`${PAGE}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements,page_follows,page_daily_follows_unique&period=day&since=2026-10-01&until=2026-10-20&breakdown=is_from_ads`, { pageId: PAGE }],
  [`${POST}/insights?metric=post_media_view,post_clicks&period=lifetime&breakdown=is_from_followers`, { pageId: PAGE }],
  [`${PAGE}/canvases?fields=id,name,is_published,is_hidden,canvas_link,update_time,background_color&is_published=true&is_hidden=false&limit=50`, { pageId: PAGE }],
]

describe('live-probe fixes — the chosen Page\'s posts, insights and Instant Experience list go with its token', () => {
  it('each read exactly as Nexus sends it goes with the token of the Page in its path (a post\'s: the Page its id names)', () => {
    for (const [path, pageRead] of PROBE_READS) expect(verdict(path), path).toEqual({ problem: null, renewalClientId: null, pageRead })
    // Another Page's feed (meta-ad-library page-posts) is judged too, but stays an ordinary read (gateway.ts, below).
    expect(verdict(`${OTHER_PAGE}/feed?fields=id,message,created_time,permalink_url,status_type&limit=25`).pageRead).toEqual({ pageId: OTHER_PAGE, otherPages: { problem: null } })
  })
  it('insights are the Page\'s only when every metric is a Page (or post) metric: a campaign\'s, an Instagram account\'s or media\'s are ordinary reads', () => {
    for (const path of [
      '120000000000101/insights?fields=spend,impressions&level=campaign', '170000000000001/insights?metric=reach,views&period=day&metric_type=total_value',
      '180000000000001/insights?metric=views,reach,likes', `${PAGE}/insights?metric=page_follows,reach`,
    ]) {
      const v = verdict(path)
      expect([v.problem, v.pageRead], path).toEqual([null, undefined])
    }
  })
  it('on these routes: only their keys, values (booleans, days, Meta\'s periods and breakdowns) and fields, each once; no token asked', () => {
    for (const [path, words] of [
      [`${PAGE}/published_posts?fields=id&include_hidden=yes`, /published posts are read with include_hidden only as Nexus sends it/],
      [`${PAGE}/published_posts?fields=id,admin_creator`, /published posts are read with fields from/],
      [`${PAGE}/published_posts?fields=id,from`, /are read with fields from/],
      [`${PAGE}/ads_posts?fields=id&since=1759276800`, /ad posts are read with since only as Nexus sends it/],
      [`${PAGE}/ads_posts?fields=id&summary=total_count`, /ad posts are read with fields, limit, after, include_inline_create, exclude_dynamic_ads, since, until only \(not "summary"\)/],
      [`${POST}/dynamic_posts?fields=id,owner_id&limit=101`, /a limit of digits only, 1 to 100/],
      [`${POST}/dynamic_posts?fields=id,story`, /catalog-ad posts are read with fields from/],
      [`${PAGE}/insights?metric=page_follows,page_follows`, /each metric once/],
      [`${PAGE}/insights?metric=page_follows&period=hour`, /are read with period only as Nexus sends it/],
      [`${PAGE}/insights?metric=page_follows&breakdown=age`, /are read with breakdown only as Nexus sends it/],
      [`${POST}/insights?metric=post_clicks&until=yesterday`, /a post's insights are read with until only as Nexus sends it/],
      [`${PAGE}/canvases?fields=id,last_editor`, /Instant Experiences are read with fields from/],
      [`${PAGE}/canvases?fields=id&is_hidden=1`, /are read with is_hidden only as Nexus sends it/],
    ] as Array<[string, RegExp]>) {
      expect(verdict(path).problem, path).toMatch(words)
    }
    expect(verdict(`${PAGE}/canvases?fields=id`, 'app').problem).toMatch(/a caller asks for no token/)
    // The feed's problem is carried for the gateway to judge once it knows the chosen Page.
    expect(verdict(`${PAGE}/feed?fields=id,from`).pageRead).toEqual({ pageId: PAGE, otherPages: { problem: expect.stringMatching(/the Page's own posts are read with fields from/) } })
    expect(verdict(`${PAGE}/feed?fields=id`, 'app').pageRead?.otherPages?.problem).toMatch(/a caller asks for no token/)
  })
  it('no visitor_posts: Meta does not answer it on the New Pages Experience, so the gateway no longer carries its keys (EN-926)', () => {
    expect(verdict(`${PAGE}/visitor_posts?fields=id&include_hidden=true`).problem).toMatch(/"include_hidden" is not one a Nexus read of Meta uses here/)
  })
})

describe('gap 46b (CR-489) — Meta\'s Instant Experience templates go with the chosen Page\'s token, on ONE exact read', () => {
  const TEMPLATE = '133471657203838'
  const fields = (f: string) => `fields=${encodeURIComponent(f)}`
  it('each of the five template nodes, read exactly so, is a Page-token read of the CHOSEN Page (no Page in its path)', () => {
    expect(META_IX_TEMPLATE_IDS).toHaveLength(5)
    expect([...CANVAS_TEMPLATE_IDS]).toEqual([...META_IX_TEMPLATE_IDS])
    for (const id of META_IX_TEMPLATE_IDS) expect(verdict(`${id}?${fields(META_IX_TEMPLATE_READ)}`), id).toEqual({ problem: null, renewalClientId: null, pageRead: { pageId: null } })
    // A subset of its items is the same read; each item exactly as written.
    expect(verdict(`${TEMPLATE}?fields=id`)).toMatchObject({ problem: null, pageRead: { pageId: null } })
  })
  it('on a template node: only fields, only its items (the document expanded exactly so), each once; no token asked', () => {
    for (const f of ['id,document', 'id,document{id,body_elements}', 'id,document{id,name,body_elements,owner}', 'id,name,document{id,name,body_elements}', 'id,document{id,name,body_elements},id', 'id,snapshot_photo']) {
      expect(verdict(`${TEMPLATE}?${fields(f)}`).problem, f).toMatch(/Meta's Instant Experience templates are read with fields from/)
    }
    expect(verdict(`${TEMPLATE}?${fields(META_IX_TEMPLATE_READ)}&limit=5`).problem).toBeTruthy()
    expect(verdict(`${TEMPLATE}?${fields(META_IX_TEMPLATE_READ)}`, 'page').problem).toMatch(/a caller asks for no token/)
  })
  it('no other node takes the rule: a document id, a template-like id, a Page, a canvas are not template reads', () => {
    for (const id of ['397246414010297', '1334716572038380', '33471657203838', PAGE]) {
      expect(metaPageReadOf(id, [id], new URLSearchParams({ fields: META_IX_TEMPLATE_READ }), undefined), id).toBeNull()
    }
    // A conversation's rule shares the route's shape only for Meta's thread ids (META_THREAD_ID): a template id is none.
    // (The media owner rule matches any node by its route, then only the exact read id,from{id}: never a template read.)
    expect(META_PAGE_READ_RULES.filter((r) => r.route.test(TEMPLATE) && (r.page !== 'thread' || META_THREAD_ID.test(TEMPLATE)) && !r.exactFields).map((r) => r.what)).toEqual(['Meta\'s Instant Experience templates'])
  })
  it('through the gateway: with the chosen Page\'s own token (read first with the system-user token); no Page chosen: nothing read or sent', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, json({ id: TEMPLATE, document: { id: '397000000000001', name: 'Get New Customers', body_elements: [] } }))
    const read = await metaCall({ connectionId: 'm-1', operation: 'ix.template', path: TEMPLATE, query: { fields: META_IX_TEMPLATE_READ } })
    expect(read.ok).toBe(true)
    expect([new URL(h.calls[1].url).pathname, new URL(h.calls[1].url).searchParams.get('fields'), tokenOf(1)]).toEqual([`/${META_DEFAULT_GRAPH_API_VERSION}/${TEMPLATE}`, META_IX_TEMPLATE_READ, PAGE_TOKEN])
    expect(read.text).not.toContain(PAGE_TOKEN)
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
    h.calls = []
    await expect(metaCall({ connectionId: 'm-2', operation: 'ix.template', path: TEMPLATE, query: { fields: META_IX_TEMPLATE_READ } })).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('gap 46b review N7 — a Page video\'s thumbnails go with the chosen Page\'s token, only for a video that Page posted', () => {
  const VIDEO = '120000000000601'
  const THUMBS = (q: string) => `${VIDEO}/thumbnails?${q}`
  it('exactly create-meta-media\'s read (id, uri, is_preferred; limit) is a Page-token read of the video; any other read of the edge stays ordinary', () => {
    expect(verdict(THUMBS('fields=id,uri,is_preferred&limit=50'))).toEqual({ problem: null, renewalClientId: null, pageRead: { pageId: null, videoId: VIDEO } })
    // meta-media-library view video's own read (width, height, scale too) is unchanged: the system-user token, as before.
    expect(verdict(THUMBS('fields=id,uri,width,height,scale,is_preferred&limit=50')).pageRead).toBeUndefined()
    expect(verdict(THUMBS('fields=id,uri,is_preferred&limit=500')).problem).toMatch(/limit of digits only, 1 to 100/)
    expect(verdict(THUMBS('fields=id,uri,is_preferred&limit=50'), 'page').problem).toMatch(/a caller asks for no token/)
  })
  it('through the gateway: ONE owner read of the video (Meta\'s id and `from` the chosen Page), the Page\'s token, then the read; another Page\'s video: nothing read with a token', async () => {
    gatewayMetaPage['m-1'] = PAGE
    // The owner read is itself a Page-token read (the media owner rule): token, video, token, thumbnails.
    h.answers.push(pageToken, json({ id: VIDEO, from: { id: PAGE } }), pageToken, json({ data: [{ id: '700000000000001', uri: 'https://scontent.example.com/t1.jpg', is_preferred: true }] }))
    const read = await metaCall({ connectionId: 'm-1', operation: 'media.pageVideoThumbnails', path: `${VIDEO}/thumbnails`, query: { fields: 'id,uri,is_preferred', limit: 50 } })
    expect(read.ok).toBe(true)
    expect([new URL(h.calls[1].url).pathname, new URL(h.calls[1].url).searchParams.get('fields'), tokenOf(1)]).toEqual([`/${META_DEFAULT_GRAPH_API_VERSION}/${VIDEO}`, 'id,from{id}', PAGE_TOKEN])
    expect([new URL(h.calls[3].url).pathname, tokenOf(3)]).toEqual([`/${META_DEFAULT_GRAPH_API_VERSION}/${VIDEO}/thumbnails`, PAGE_TOKEN])
    for (const owner of [json({ id: VIDEO, from: { id: OTHER_PAGE } }), json({ id: '120000000000602', from: { id: PAGE } }), json({ error: { message: 'Unsupported get request.', code: 100 } }, 400)]) {
      h.calls = []
      h.answers.push(pageToken, owner)
      await expect(metaCall({ connectionId: 'm-1', operation: 'x', path: `${VIDEO}/thumbnails`, query: { fields: 'id,uri,is_preferred', limit: 50 } })).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/the thumbnails of a video it posted/) })
      // Only the owner read (with the Page's token) went: no read of the thumbnails.
      expect(h.calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual([PAGE, VIDEO])
    }
  })
})

describe('gap 46b, the live read of 2026-10-26 — a post of the chosen Page and the owner read of its media go with the Page\'s token', () => {
  const POST = `${PAGE}_500000000000001`
  const VIEW_POST = 'id,message,story,created_time,updated_time,permalink_url,status_type,is_published,is_hidden,is_expired,is_eligible_for_promotion,promotable_id,scheduled_publish_time,full_picture,is_instagram_eligible,from{id},instagram_eligibility,video_buying_eligibility,attachments{media_type,type,title,description,url,unshimmed_url,media,target,subattachments},is_inline_created,allowed_advertising_objects,promotion_status'
  const STATE = 'id,message,is_hidden,is_published,scheduled_publish_time,timeline_visibility,permalink_url,from{id}'
  const f = (fields: string) => `fields=${encodeURIComponent(fields)}`
  it('the chosen Page\'s post by its id — every read Nexus makes of one — is a Page-token read of that Page', () => {
    const ENGAGEMENT = ['id,reactions.limit(0).summary(total_count),shares', ...['LIKE', 'LOVE', 'WOW', 'HAHA', 'SAD', 'SORRY', 'ANGRY'].map((t) => `id,reactions.type(${t}).limit(0).summary(total_count)`)]
    for (const fields of [VIEW_POST, STATE, 'id,from{id}', 'id', 'id,created_time', 'id,is_eligible_for_promotion,promotable_id,is_instagram_eligible', 'id,attachments{target{id}}', 'id,from{id},created_time', 'id,created_time,can_reply_privately', ...ENGAGEMENT]) {
      expect(verdict(`${POST}?${f(fields)}`), fields).toMatchObject({ problem: null, pageRead: { pageId: PAGE, otherPages: { problem: null } } })
    }
  })
  it('re-review FIX 1 / NIT 1 — a read of a post asking anything else names its problem (refused for the chosen Page, gateway.ts); another Page\'s or a comment id stays ordinary', () => {
    for (const query of [f('id,privacy'), f('id,from{id,name}'), `${f('id,from{id}')}&limit=5`, f('id,from{id}.as(x)'), f('id,attachments{target}')]) {
      const v = verdict(`${POST}?${query}`)
      expect(v.problem ?? v.pageRead?.otherPages?.problem, query).toMatch(/a post of the chosen Page are read with|fields|limit|not one a Nexus read/)
      expect(metaReadOnlyProblem({ method: 'GET', url: `${BASE}/${POST}?${query}`, kind: 'read' }, PAGE), query).toBeTruthy()
    }
    // Another Page's post, or a comment `<object>_<comment>`: the gateway sends it as an ordinary read.
    expect(metaReadOnlyProblem({ method: 'GET', url: `${BASE}/${OTHER_PAGE}_500000000000001?${f('id,privacy')}`, kind: 'read' }, PAGE)).toBeNull()
    expect(metaReadOnlyProblem({ method: 'GET', url: `${BASE}/500000000000001_800000000000001?${f('id,message,from{id,name}')}`, kind: 'read' }, PAGE)).toBeNull()
  })
  it('a Page photo or video by its own id: each of its four exact lists is a Page-token read (the chosen Page\'s); anything else stays ordinary', () => {
    for (const fields of ['id,from{id}', 'from{id},id', 'id,from{id},width,height', 'id,post_id,from{id}', 'id,post_id,published', 'id,title,published,from{id}']) {
      expect(verdict(`500000000000003?${f(fields)}`), fields).toEqual({ problem: null, renewalClientId: null, pageRead: { pageId: null } })
    }
    for (const query of [f('id'), f('from{id}'), f('id,from{id},length'), f('id,owner,username'), f('id,from{id},id'), f('id,from{id,name}'), f('id,from{id}.as(x)'), `${f('id,from{id}')}&limit=5`, f('id,from{id},width'), f('id,title,from{id}')]) {
      expect(verdict(`500000000000003?${query}`).pageRead, query).toBeUndefined()
    }
    expect(verdict(`500000000000003?${f('id,from{id}')}`, 'page').problem).toMatch(/a caller asks for no token/)
  })
  it('through the gateway: the owner read goes with the chosen Page\'s token (never the system user\'s); with no Page chosen nothing is read', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, json({ id: POST, from: { id: PAGE } }))
    const read = await metaCall({ connectionId: 'm-1', operation: 'write.ownerCheck', path: POST, query: { fields: 'id,from{id}' } })
    expect(read.ok).toBe(true)
    expect([new URL(h.calls[0].url).searchParams.get('fields'), tokenOf(0), new URL(h.calls[1].url).pathname, tokenOf(1)]).toEqual(['access_token', 'meta-system-user-token', `/${META_DEFAULT_GRAPH_API_VERSION}/${POST}`, PAGE_TOKEN])
    h.calls = []
    h.answers.push(pageToken, json({ id: '500000000000003', from: { id: PAGE } }))
    await metaCall({ connectionId: 'm-1', operation: 'write.ownerCheck', path: '500000000000003', query: { fields: 'id,from{id}' } })
    expect(tokenOf(1)).toBe(PAGE_TOKEN)
    // Another Page's post stays an ordinary read (system-user token), as before.
    h.calls = []
    await metaCall({ connectionId: 'm-1', operation: 'x', path: `${OTHER_PAGE}_500000000000001`, query: { fields: 'id,from{id}' } })
    expect(h.calls.map((_c, i) => tokenOf(i))).toEqual(['meta-system-user-token'])
    h.calls = []
    await expect(metaCall({ connectionId: 'm-2', operation: 'x', path: '500000000000003', query: { fields: 'id,from{id}' } })).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('through the gateway', () => {
  it('live-probe fixes — the chosen Page\'s feed, post insights and Instant Experiences go with its token; another Page\'s feed with the system-user token; a campaign\'s insights too', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, json({ data: [{ id: POST, from: { id: PAGE }, echo: PAGE_TOKEN }] }))
    const feed = await metaCall({ connectionId: 'm-1', operation: 'posts.feed', path: `${PAGE}/feed`, query: { fields: POST_FIELDS, limit: 50 } })
    expect(feed.ok).toBe(true)
    expect([tokenOf(0), new URL(h.calls[1].url).pathname, tokenOf(1)]).toEqual(['meta-system-user-token', `/${META_DEFAULT_GRAPH_API_VERSION}/${PAGE}/feed`, PAGE_TOKEN])
    expect(feed.text).not.toContain(PAGE_TOKEN)
    h.calls = []
    h.answers.push(pageToken, json({ data: [] }), pageToken, json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'posts.postInsights', path: `${POST}/insights`, query: { metric: 'post_clicks', period: 'lifetime' } })).ok).toBe(true)
    expect((await metaCall({ connectionId: 'm-1', operation: 'ix.canvases', path: `${PAGE}/canvases`, query: { fields: 'id,name', limit: 50 } })).ok).toBe(true)
    expect([tokenOf(1), tokenOf(3)]).toEqual([PAGE_TOKEN, PAGE_TOKEN])
    // Another Page's public feed (meta-ad-library page-posts): the system-user token, no Page token read — as before.
    h.calls = []
    h.answers.push(json({ data: [] }), json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'library.pagePosts', path: `${OTHER_PAGE}/feed`, query: { fields: 'id,message,created_time,permalink_url,status_type', limit: 25 } })).ok).toBe(true)
    expect((await metaCall({ connectionId: 'm-1', operation: 'objects.insights', path: '120000000000101/insights', query: { fields: 'spend' } })).ok).toBe(true)
    expect(h.calls.map((_c, i) => tokenOf(i))).toEqual(['meta-system-user-token', 'meta-system-user-token'])
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
  })
  it('live-probe fixes — the chosen Page\'s feed off its list is refused (nothing sent); another Page\'s post insights, ad posts or Instant Experiences are refused before any token is read', async () => {
    gatewayMetaPage['m-1'] = PAGE
    await expect(metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/feed`, query: { fields: 'id,from' } })).rejects.toMatchObject({ code: 'META_READ_ONLY', message: expect.stringMatching(/Nothing was sent to Meta: the Page's own posts are read with fields from/) })
    for (const [path, query] of [
      [`${OTHER_PAGE}_500000000000001/insights`, { metric: 'post_clicks' }], [`${OTHER_PAGE}/ads_posts`, { fields: 'id' }], [`${OTHER_PAGE}/canvases`, { fields: 'id' }],
      [`${OTHER_PAGE}/insights`, { metric: 'page_follows' }], [`${OTHER_PAGE}_500000000000001/dynamic_posts`, { fields: 'id' }], [`${OTHER_PAGE}/published_posts`, { fields: 'id' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(metaCall({ connectionId: 'm-1', operation: 'x', path, query }), path).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/posts, insights, Instant Experiences/) })
    }
    // With no Page chosen, the Page's own reads are refused; another Page's feed is still an ordinary read.
    await expect(metaCall({ connectionId: 'm-2', operation: 'x', path: `${PAGE}/canvases`, query: { fields: 'id' } })).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-2', operation: 'x', path: `${OTHER_PAGE}/feed`, query: { fields: 'id', limit: 25 } })).ok).toBe(true)
    expect(h.calls.map((_c, i) => tokenOf(i))).toEqual(['meta-system-user-token'])
  })
  it('the chosen Page\'s read goes with the Page\'s own token (read first with the system-user token); the token never in the answer or the ledger', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, json({ data: [{ id: CONV, participants: { data: [{ id: PAGE }] }, echo: PAGE_TOKEN }] }))
    const read = await metaCall({ connectionId: 'm-1', operation: 'messaging.messenger', path: `${PAGE}/conversations`, query: { platform: 'messenger', fields: 'id,participants', limit: 100 } })
    expect(read.ok).toBe(true)
    expect([new URL(h.calls[0].url).pathname, new URL(h.calls[0].url).searchParams.get('fields'), tokenOf(0)]).toEqual([`/${META_DEFAULT_GRAPH_API_VERSION}/${PAGE}`, 'access_token', 'meta-system-user-token'])
    expect([new URL(h.calls[1].url).pathname, tokenOf(1)]).toEqual([`/${META_DEFAULT_GRAPH_API_VERSION}/${PAGE}/conversations`, PAGE_TOKEN])
    expect(read.text).not.toContain(PAGE_TOKEN)
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
    // A person's id rides in the query only: the ledger keeps the path.
    h.calls = []
    h.answers.push(pageToken, json({ data: [] }))
    await metaCall({ connectionId: 'm-1', operation: 'messaging.threadOwner', path: `${PAGE}/thread_owner`, query: { recipient: PERSON, fields: 'thread_owner' } })
    expect(JSON.stringify(gatewayLedger)).not.toContain(PERSON)
  })
  it('a conversation\'s node and messages go with the chosen Page\'s token; with no Page chosen, nothing is read or sent', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, json({ id: CONV, participants: { data: [] } }), pageToken, json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: CONV, query: { fields: 'id,participants' } })).ok).toBe(true)
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${IG_CONV}/messages`, query: { fields: 'id,message', limit: 20 } })).ok).toBe(true)
    expect([tokenOf(1), tokenOf(3)]).toEqual([PAGE_TOKEN, PAGE_TOKEN])
    h.calls = []
    await expect(metaCall({ connectionId: 'm-2', operation: 'x', path: CONV, query: { fields: 'id,participants' } })).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/this business has chosen no Page/) })
    expect(h.calls).toHaveLength(0)
  })
  it('another Page is refused before any token is read (a Page-shaped template read too, review fix A5); a WhatsApp account\'s templates go with the system-user token', async () => {
    gatewayMetaPage['m-1'] = PAGE
    for (const path of [`${OTHER_PAGE}/conversations`, `${OTHER_PAGE}/custom_labels`, `${PERSON}/custom_labels`, `${OTHER_PAGE}/messenger_profile`, `${OTHER_PAGE}/message_templates`, `${WABA}/message_templates`]) {
      await expect(metaCall({ connectionId: 'm-1', operation: 'x', path, query: { fields: path.endsWith('profile') ? 'greeting' : 'id' } }), path).rejects.toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    }
    expect(h.calls).toHaveLength(0)
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${WABA}/message_templates`, query: { fields: 'id,name,quality_score', summary: 'total_count', limit: 100 } })).ok).toBe(true)
    expect(h.calls.map((_c, i) => tokenOf(i))).toEqual(['meta-system-user-token'])
    h.calls = []
    h.answers.push(pageToken, json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/message_templates`, query: { fields: 'id,name', status: 'APPROVED' } })).ok).toBe(true)
    expect(tokenOf(1)).toBe(PAGE_TOKEN)
  })
  it('with Meta changes switched off no Page token is read, so these reads wait too (nothing sent)', async () => {
    gatewayMetaPage['m-1'] = PAGE
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    await expect(metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/personas`, query: { fields: 'id,name' } })).rejects.toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })
  it('review fix A1 — a Page-token read and the read of its token take the `page` bucket, a WhatsApp-account read the `whatsapp` one: the ads bucket pays nothing', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(pageToken, json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/personas`, query: { fields: 'id,name' } })).ok).toBe(true)
    h.answers.push(json({ data: [] }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${WABA}/template_groups`, query: { fields: 'id' } })).ok).toBe(true)
    const left = async (group: string) => (await takeToken('META', bucketKey('META', 'm-1', group), 0)).tokensLeft
    expect(Math.round(await left('ads'))).toBe(META_BUCKETS.ads.capacity - 1)
    expect(Math.round(await left('page'))).toBe(META_BUCKETS.page.capacity - 3)
    expect(Math.round(await left('whatsapp'))).toBe(META_BUCKETS.whatsapp.capacity - 2)
  })
  /** One throttled call, then: is the ads bucket held (a campaigns read refused locally)? the Page's? the WhatsApp one's? */
  async function heldAfter(code: number, call: 'page' | 'whatsapp' | 'system') {
    __rateTest.useMemory()
    gatewayMetaPage['m-1'] = PAGE
    h.calls = []
    const error = json({ error: { code, message: 'There have been too many calls. Wait a bit and try again.' } }, 400)
    if (call === 'page') h.answers.push(pageToken, error)
    else h.answers.push(error)
    const throttled = call === 'page' ? await metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/conversations`, query: { platform: 'messenger', fields: 'id' } })
      : call === 'whatsapp' ? await metaCall({ connectionId: 'm-1', operation: 'x', path: `${WABA}/template_groups`, query: { fields: 'id' } })
        : await metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}?fields=id,messaging_feature_status`, query: {} })
    expect(throttled.verdict, `${code} ${call}`).toMatchObject({ errorClass: 'rate_limited', channelCode: String(code) })
    const before = h.calls.length
    const held = (path: string) => metaCall({ connectionId: 'm-1', operation: 'x', path, query: { fields: 'id' } }).then(() => false, (e) => e?.code === 'RATE_LIMITED_LOCAL')
    // One after the other (each answers Meta's default, or is refused locally).
    const ads = await held('act_1234567890/campaigns')
    const page = await held(`${PAGE}/personas`)
    const whatsapp = await held(`${WABA}/phone_numbers`)
    return { ads, page, whatsapp, sentAfter: h.calls.length - before }
  }
  it('review fix A1/A3/B1 — Meta\'s own limit of the Page, Instagram, LeadGen or Messenger on a Page-token read holds the `page` bucket only', async () => {
    for (const code of [80001, 80002, 80005, 80006]) {
      expect(await heldAfter(code, 'page'), String(code)).toMatchObject({ ads: false, page: true, whatsapp: false })
    }
  })
  it('review fix A2 — any other throttle on a Page-token read (80004, 80000, 4, 17) still holds the ads bucket (and the page one)', async () => {
    for (const code of [80004, 80000, 4, 17]) {
      expect(await heldAfter(code, 'page'), String(code)).toMatchObject({ ads: true, page: true, whatsapp: false })
    }
  })
  it('review fix A2 — 80001, 80002, 80005, 80006 and 80008 on a system-user read still hold the ads bucket', async () => {
    for (const code of [80001, 80002, 80005, 80006, 80008]) {
      expect(await heldAfter(code, 'system'), String(code)).toMatchObject({ ads: true, page: false, whatsapp: false })
    }
  })
  it('review fix A1 — WhatsApp\'s 80008 on a WhatsApp-account read holds the `whatsapp` bucket only; any other throttle there the ads bucket too', async () => {
    expect(await heldAfter(80008, 'whatsapp')).toMatchObject({ ads: false, page: false, whatsapp: true })
    for (const code of [80004, 4]) expect(await heldAfter(code, 'whatsapp'), String(code)).toMatchObject({ ads: true, page: false, whatsapp: true })
  })
})

describe('re-review round (N1–N3)', () => {
  it('N1 — on Redis a hold keeps the LATER end, as the memory store does: a 300 s hold never cuts Meta\'s hour', async () => {
    const rows = new Map<string, Record<string, string>>()
    const scripts: string[] = []
    const fake: RedisLike = {
      status: 'ready',
      // HOLD_LUA, run as Redis would: keep the later of the old and new end, tokens 0, ts now.
      eval: async (script: string, _n: number, key: string | number, ...args: Array<string | number>) => {
        scripts.push(script)
        if (script !== HOLD_LUA) return [1, '10', 0]
        const row = rows.get(String(key)) ?? {}
        const hold = Math.max(Number(row.hold ?? 0), Number(args[0]))
        rows.set(String(key), { ...row, hold: String(hold), tokens: '0', ts: String(args[1]) })
        return hold
      },
      hset: async () => 1, hgetall: async (key: string) => rows.get(key) ?? {}, pexpire: async () => 1,
    }
    __rateTest.useRedis(fake)
    const key = bucketKey('META', 'm-1', 'ads')
    const t0 = Date.now()
    await observeRate('META', key, { retryAfterSec: 1800 })
    await observeRate('META', key, { retryAfterSec: 300 })
    const kept = Number(rows.get(`gw:bucket:${key}`)!.hold)
    expect(kept).toBeGreaterThanOrEqual(t0 + 1_800_000)
    // A longer one still extends it (Meta's hour: the gateway's longest hold).
    await observeRate('META', key, { retryAfterSec: 3600 })
    expect(Number(rows.get(`gw:bucket:${key}`)!.hold)).toBeGreaterThan(kept)
    expect(scripts.filter((x) => x === HOLD_LUA)).toHaveLength(3)
    // The script itself compares before it writes (one atomic step) and never shortens the key's life below the hold.
    expect(HOLD_LUA).toMatch(/if untilMs > hold then hold = untilMs end/)
    expect(HOLD_LUA).toMatch(/math\.max\(3600000, hold - now\)/)
    // The memory store did the same already.
    __rateTest.useMemory()
    await observeRate('META', key, { retryAfterSec: 3600 })
    await observeRate('META', key, { retryAfterSec: 300 })
    expect((await takeToken('META', key, 0)).waitMs).toBeGreaterThan(3_500_000)
  })
  it('N2 — a non-own throttle on a Page read holds the ads bucket for the wait Meta named, else 300 s', async () => {
    gatewayMetaPage['m-1'] = PAGE
    const usage = JSON.stringify({ [PAGE]: [{ type: 'pages', call_count: 100, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 60 }] })
    h.answers.push(pageToken, () => new Response(JSON.stringify({ error: { code: 4, message: 'Application request limit reached' } }), { status: 400, headers: { 'x-business-use-case-usage': usage } }))
    expect((await metaCall({ connectionId: 'm-1', operation: 'x', path: `${PAGE}/conversations`, query: { platform: 'messenger', fields: 'id' } })).verdict).toMatchObject({ errorClass: 'rate_limited', channelCode: '4' })
    expect((await takeToken('META', bucketKey('META', 'm-1', 'ads'), 0)).waitMs).toBeGreaterThan(3_500_000)
  })
  it('N3 / step 38 review S1 — a change made as the Page takes its slot of the PAGE bucket BEFORE its token is read: during a Page hold nothing is read or sent, an ads hold does not stop it; one slot, not two', async () => {
    gatewayMetaPage['m-1'] = PAGE
    const install = () => metaWriteCall({ connectionId: 'm-1', operation: 'webhooks.installPage', objectId: PAGE, objectKind: 'page', edge: 'subscribed_apps', params: { subscribed_fields: 'leadgen' }, check: false })
    await observeRate('META', bucketKey('META', 'm-1', 'page'), { retryAfterSec: 300 })
    await expect(install()).rejects.toMatchObject({ code: 'RATE_LIMITED_LOCAL' })
    expect(h.calls).toHaveLength(0)
    __rateTest.useMemory()
    await observeRate('META', bucketKey('META', 'm-1', 'ads'), { retryAfterSec: 300 })
    h.answers.push(pageToken, json({ success: true }))
    expect((await install()).ok).toBe(true)
    expect(h.calls.map((c) => tokenOf(h.calls.indexOf(c)))).toEqual(['meta-system-user-token', PAGE_TOKEN])
    __rateTest.useMemory()
    h.calls = []
    h.answers.push(pageToken, json({ success: true }))
    expect((await install()).ok).toBe(true)
    // The write took 3 of the page bucket once, the token read 1 more; the ads bucket nothing (each probe takes 1 itself).
    expect(Math.round((await takeToken('META', bucketKey('META', 'm-1', 'ads'), 0)).tokensLeft)).toBe(META_BUCKETS.ads.capacity - 1)
    expect(Math.round((await takeToken('META', bucketKey('META', 'm-1', 'page'), 0)).tokensLeft)).toBe(META_BUCKETS.page.capacity - 3 - 1 - 1)
  })
})
