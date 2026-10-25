/**
 * Meta step 24 on the gateway — organic posts of the chosen Facebook Page and Instagram account:
 *   - the post rules are an exact ALLOW-list: keys per edge and kind, every value judged (published always said, booleans
 *     as true / false, JSON in one spelling at every depth, https public links, text only where a person types it, Meta's
 *     limits — 2–5 cards / 10 when reordered, 10 photos, 10 min – 30 days ahead, ≤ 2,200-character captions with 30 hashtags,
 *     ≤ 3 collaborators, ≤ 2 sponsors, 2–20 carousel items), the local calls to action linking to the Page itself;
 *   - every rule goes AS the chosen Page (the gateway reads the Page's own token for that one call, never hands it out);
 *   - the owner check per kind — the chosen Page / Instagram account itself, a post the Page wrote, a post or media Nexus
 *     made — and every id inside a body (a photo or container made in the same run, a library image by its hash, a brand's
 *     Page or account that is not another Nexus business's, a place), each refused before anything is sent.
 * Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE_TOKEN = 'pagetoken0123456789abcdefghijKLMN'
const SYSTEM_TOKEN = 'meta-system-user-token'
const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response>,
}))
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
vi.mock('../../utils/otel-setup.js', () => ({ withSpan: vi.fn(async (_n: string, _a: Record<string, unknown>, fn: (span: null) => Promise<unknown>) => fn(null)) }))

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage, gatewayMetaPostsMade, gatewayMetaTakenLinks } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteRuleAuth, metaWriteVerdict } from './meta-calls.js'
import { META_IG_CONTAINER_JUDGES, META_IG_CONTAINER_KEYS, META_POST_LIMITS, isMetaPostBodyKind, metaVideoPostIdOf } from './meta-post-rules.js'
import { __postOwnerTest, metaPostOwnerProblem } from './meta-post-owner.js'
import { readFileSync } from 'node:fs'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'
import { metaSendChange } from '../marketing/meta-ads/write-client.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const VIDEO_BASE = `https://graph-video.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000099'
const POST = `${PAGE}_500000000000001`
const PHOTO = '140000000000001'
const IG = '170000000000010'
const OTHER_IG = '170000000000099'
const CONTAINER = '180000000000001'
const MEDIA = '180000000000501'
const BRAND_PAGE = '130000000000001'
const BRAND_IG = '170000000000201'

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const tokenAnswer = () => json({ id: PAGE, access_token: PAGE_TOKEN })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body })
const paths = () => h.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname.replace(`/${META_DEFAULT_GRAPH_API_VERSION}`, '')}`)
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const later = (sec: number) => String(Math.floor(Date.now() / 1000) + sec)
const verdict = (path: string, objectKind: string, params: Record<string, string>, method = 'POST') => metaWriteVerdict({ method, url: `${BASE}/${path}`, kind: 'write', objectKind, body: method === 'DELETE' && !Object.keys(params).length ? undefined : form(params) })
const problem = (path: string, objectKind: string, params: Record<string, string>, method = 'POST') => { const v = verdict(path, objectKind, params, method); return 'problem' in v ? v.problem : null }
const feed = (params: Record<string, string>) => verdict(`${PAGE}/feed`, 'postpage', params)
const feedProblem = (params: Record<string, string>) => problem(`${PAGE}/feed`, 'postpage', params)
const container = (params: Record<string, string>) => verdict(`${IG}/media`, 'postig', params)
const containerProblem = (params: Record<string, string>) => problem(`${IG}/media`, 'postig', params)

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  __postOwnerTest.reset()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const store of [gatewayMetaPage, gatewayMetaInstagram, gatewayMetaChosen]) for (const key of Object.keys(store)) delete store[key]
  gatewayMetaPostsMade.clear(); gatewayMetaTakenLinks.clear()
  gatewayMetaPage['m-1'] = PAGE
  gatewayMetaInstagram['m-1'] = IG
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('Facebook posts: an exact allow-list', () => {
  it('a text post: message and published (always said), as the Page, on the Page\'s edge with no 30-s gap', () => {
    expect(feed({ message: 'Nuova collezione!\nA presto 🏍️', published: 'false' })).toMatchObject({ write: { rule: 'pagepost.feed', objectId: PAGE, auth: 'page', edgeCall: true, body: form({ published: 'false', message: 'Nuova collezione!\nA presto 🏍️' }) } })
    expect(metaWriteRuleAuth('POST', `${PAGE}/feed`, 'postpage')).toBe('page')
    // Never public by an omission: no rule takes a post without published.
    expect(feedProblem({ message: 'x' })).toMatch(/only Meta change Nexus sends for an organic post/)
    expect(feedProblem({ message: 'x', published: '1' })).toMatch(/published is true or false/)
    expect(feedProblem({ published: 'true' })).toMatch(/message, link or attached_media/)
    // Text a person types: no control or format character, no Page tag.
    expect(feedProblem({ message: 'Ciao‮olleh', published: 'true' })).toMatch(/printable text/)
    expect(feedProblem({ message: 'Ciao @[120000000000099] grazie', published: 'true' })).toMatch(/tags no Page/)
    expect(feedProblem({ message: 'x'.repeat(META_POST_LIMITS.message + 1), published: 'true' })).toMatch(/1 to 10000 characters/)
    // Keys Nexus never sends: people's tags, a place, a backdate, a privacy, the gateway's own.
    for (const key of ['tags', 'backdated_time', 'privacy', 'actions', 'object_attachment', 'thumbnail', 'sponsor_id']) expect(feedProblem({ message: 'x', published: 'true', [key]: '1' }), key).toMatch(/only Meta change/)
    // A place: a Page id, checked by the owner check (never another Nexus business's Page).
    expect(feed({ message: 'x', published: 'true', place: '110000000000001' })).toMatchObject({ write: { ids: [{ id: '110000000000001', kind: 'postplace' }] } })
    expect(feedProblem({ message: 'x', published: 'true', place: 'Milano' })).toMatch(/place's Facebook Page id/)
    expect(feedProblem({ message: 'x', published: 'true', access_token: 'x' })).toMatch(/no Nexus change sends/)
    expect(feedProblem({ message: 'x', published: 'true', fields: 'id' })).toMatch(/only Meta change/)
    // The kind is the post kind: the Page's own `page` kind takes no post.
    expect(problem(`${PAGE}/feed`, 'page', { message: 'x', published: 'true' })).toMatch(/only Meta change Nexus sends for an organic post/)
    expect(problem(`${PAGE}/feed`, 'pagepostedit', { message: 'x', published: 'true' })).toMatch(/only Meta change Nexus sends for an organic post/)
  })
  it('a link post: its preview, an https public link, one image, a call to action in Nexus\'s one spelling', () => {
    const cta = JSON.stringify({ type: 'SHOP_NOW', value: { link: 'https://example-shop.com/p/1' } })
    expect(feed({ link: 'https://example-shop.com/p/1', name: 'Giacca', description: 'Nuova', picture: 'https://cdn.example-shop.com/a.jpg', call_to_action: cta, published: 'false' })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feed({ link: 'https://example-shop.com/p/1', image_hash: 'abc123', published: 'false' })).toMatchObject({ write: { ids: [{ id: 'abc123', kind: 'postimagehash' }] } })
    expect(feedProblem({ link: 'https://example-shop.com/p/1', picture: 'https://cdn.example-shop.com/a.jpg', image_hash: 'abc123', published: 'false' })).toMatch(/one image/)
    expect(feedProblem({ name: 'Giacca', message: 'x', published: 'false' })).toMatch(/name goes only with link/)
    expect(feedProblem({ link: 'http://example-shop.com/p/1', published: 'false' })).toMatch(/https:\/\/ link/)
    expect(feedProblem({ link: 'https://localhost/p/1', published: 'false' })).toMatch(/public host/)
    expect(feedProblem({ link: 'https://example-shop.com/p/1?token=x', published: 'false' })).toMatch(/no key, signature or sign-in/)
    // A call to action: a listed type, its link, one spelling; app buttons refused in words.
    const ctaProblem = (value: string) => feedProblem({ link: 'https://example-shop.com/p/1', call_to_action: value, published: 'false' })
    expect(ctaProblem(JSON.stringify({ type: 'INSTALL_APP', value: { link: 'https://example-shop.com/' } }))).toMatch(/does not send INSTALL_APP \(it installs an app, and the business has no app\)/)
    expect(ctaProblem(JSON.stringify({ type: 'SHOP_NOW', value: { link: 'https://example-shop.com/', link_format: 'VIDEO_LPP' } }))).toMatch(/value has link only/)
    expect(ctaProblem(JSON.stringify({ type: 'SHOP_NOW', value: { link: 'https://example-shop.com/' }, extra: 1 }))).toMatch(/only type and value/)
    expect(ctaProblem('{ "type": "SHOP_NOW", "value": { "link": "https://example-shop.com" } }')).toMatch(/JSON object, as Nexus writes it/)
    expect(ctaProblem(JSON.stringify({ type: 'NO_BUTTON', value: { link: 'https://example-shop.com/' } }))).toMatch(/NO_BUTTON carries no value/)
    // Review B-F7 — a link button goes to the post's own link.
    expect(ctaProblem(JSON.stringify({ type: 'SHOP_NOW', value: { link: 'https://example-shop.com/other' } }))).toMatch(/is the post's own link/)
  })
  it('the local calls to action (CR-256): the post links to the Page itself; tel:+digits; fbgeo with a real place; MESSAGE_PAGE with no value', () => {
    const pageUrl = `https://www.facebook.com/${PAGE}`
    const call = JSON.stringify({ type: 'CALL_NOW', value: { link: 'tel:+390212345678' } })
    expect(feed({ message: 'Vieni a trovarci', link: pageUrl, call_to_action: call, published: 'false' })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem({ link: 'https://example-shop.com/', call_to_action: call, published: 'false' })).toMatch(/the post's link is the Page's own URL/)
    // Another Page's URL is never the one of the Page the post goes on.
    expect(feedProblem({ link: `https://www.facebook.com/${OTHER_PAGE}`, call_to_action: call, published: 'false' })).toMatch(/Page's own URL/)
    expect(feedProblem({ link: pageUrl, call_to_action: JSON.stringify({ type: 'CALL_NOW', value: { link: 'tel:02 1234' } }), published: 'false' })).toMatch(/tel:\+<country code><number>/)
    const geo = (link: string) => JSON.stringify({ type: 'GET_DIRECTIONS', value: { link } })
    expect(feed({ link: pageUrl, call_to_action: geo('fbgeo://45.4642, 9.19, "Via Roma 1, Milano"'), published: 'false' })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem({ link: pageUrl, call_to_action: geo('fbgeo://95.1, 9.19, "Via Roma 1"'), published: 'false' })).toMatch(/real latitude/)
    expect(feedProblem({ link: pageUrl, call_to_action: geo('https://maps.example.com'), published: 'false' })).toMatch(/fbgeo:\/\//)
    expect(feed({ link: pageUrl, call_to_action: JSON.stringify({ type: 'MESSAGE_PAGE' }), published: 'false' })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem({ link: pageUrl, call_to_action: JSON.stringify({ type: 'MESSAGE_PAGE', value: { link: pageUrl } }), published: 'false' })).toMatch(/carries no value/)
    // Review B-F6 — a local call to action only on a dark post (never public, never scheduled).
    expect(feedProblem({ link: pageUrl, call_to_action: call, published: 'true' })).toMatch(/unpublished \(dark\) post only/)
    expect(feedProblem({ link: pageUrl, call_to_action: call, published: 'false', scheduled_publish_time: later(3600) })).toMatch(/unpublished \(dark\) post only/)
  })
  it('a carousel: 2–5 cards (10 only when Meta may reorder them, which is always said), each a link and ONE image', () => {
    const card = (i: number, image: Record<string, string> = { picture: `https://cdn.example-shop.com/${i}.jpg` }) => ({ link: `https://example-shop.com/p/${i}`, name: `Card ${i}`, ...image })
    const cards = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => card(i + 1)))
    const carousel = (extra: Record<string, string>) => ({ link: 'https://example-shop.com/', published: 'false', ...extra })
    expect(feed(carousel({ child_attachments: cards(3), multi_share_optimized: 'false', multi_share_end_card: 'true' }))).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem(carousel({ child_attachments: cards(3) }))).toMatch(/says multi_share_optimized/)
    expect(feedProblem(carousel({ child_attachments: cards(6), multi_share_optimized: 'false' }))).toMatch(/2 to 5 cards/)
    expect(feed(carousel({ child_attachments: cards(10), multi_share_optimized: 'true' }))).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem(carousel({ child_attachments: cards(11), multi_share_optimized: 'true' }))).toMatch(/2 to 10 cards/)
    expect(feedProblem(carousel({ child_attachments: cards(1), multi_share_optimized: 'false' }))).toMatch(/2 to 5 cards/)
    expect(feedProblem(carousel({ child_attachments: JSON.stringify([card(1, { picture: 'https://cdn.example-shop.com/1.jpg', image_hash: 'abc' }), card(2)]), multi_share_optimized: 'false' }))).toMatch(/one image/)
    expect(feedProblem(carousel({ child_attachments: JSON.stringify([{ ...card(1), call_to_action: 'x' }, card(2)]), multi_share_optimized: 'false' }))).toMatch(/has no key "call_to_action"/)
    expect(feedProblem({ message: 'x', published: 'false', multi_share_optimized: 'false' })).toMatch(/goes only with child_attachments/)
    // A card's library image goes to the owner check by its hash.
    const hashed = feed(carousel({ child_attachments: JSON.stringify([card(1, { image_hash: 'aaa111' }), card(2, { image_hash: 'bbb222' })]), multi_share_optimized: 'false' }))
    expect(hashed).toMatchObject({ write: { ids: [{ id: 'aaa111', kind: 'postimagehash' }, { id: 'bbb222', kind: 'postimagehash' }] } })
  })
  it('a photo post: unpublished photos (never public by themselves), then attached_media — a scheduled one says SCHEDULED', () => {
    expect(verdict(`${PAGE}/photos`, 'postpage', { url: 'https://cdn.example-shop.com/a.jpg', published: 'false', alt_text_custom: 'Giacca nera' })).toMatchObject({ write: { rule: 'pagepost.photo', auth: 'page', edgeCall: true } })
    expect(problem(`${PAGE}/photos`, 'postpage', { url: 'https://cdn.example-shop.com/a.jpg', published: 'true' })).toMatch(/published=false/)
    expect(problem(`${PAGE}/photos`, 'postpage', { url: 'https://cdn.example-shop.com/a.jpg', published: 'false', temporary: 'false' })).toMatch(/temporary is true/)
    expect(problem(`${PAGE}/photos`, 'postpage', { url: 'https://cdn.example-shop.com/a.jpg', published: 'false', message: 'x' })).toMatch(/only Meta change/)
    const media = JSON.stringify([{ media_fbid: PHOTO }, { media_fbid: '140000000000002' }])
    expect(feed({ message: 'Due foto', attached_media: media, published: 'true' })).toMatchObject({ write: { ids: [{ id: PHOTO, kind: 'postphoto' }, { id: '140000000000002', kind: 'postphoto' }] } })
    expect(feedProblem({ attached_media: media, link: 'https://example-shop.com/', published: 'true' })).toMatch(/no link or child_attachments/)
    // Review B-F5 — an unpublished, unscheduled photo post waits for LIVE-PROBES PG24-03.
    expect(feedProblem({ attached_media: media, published: 'false' })).toMatch(/waits for a live check \(LIVE-PROBES PG24-03\)/)
    expect(feedProblem({ attached_media: JSON.stringify([{ media_fbid: PHOTO }, { media_fbid: PHOTO }]), published: 'true' })).toMatch(/each photo once/)
    expect(feedProblem({ attached_media: JSON.stringify([{ media_fbid: PHOTO, extra: 1 }]), published: 'true' })).toMatch(/nothing else/)
    expect(feedProblem({ attached_media: JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ media_fbid: String(140000000000001 + i) }))), published: 'true' })).toMatch(/1 to 10 photos/)
    // Scheduled: published=false, a time 10 minutes to 30 days ahead, and (a photo post) SCHEDULED.
    expect(feedProblem({ attached_media: media, published: 'false', scheduled_publish_time: later(3600) })).toMatch(/must be included/)
    expect(feed({ attached_media: media, published: 'false', scheduled_publish_time: later(3600), unpublished_content_type: 'SCHEDULED' })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem({ message: 'x', published: 'true', scheduled_publish_time: later(3600) })).toMatch(/only with published=false/)
    expect(feedProblem({ message: 'x', published: 'false', scheduled_publish_time: later(300) })).toMatch(/at least 10 minutes ahead/)
    expect(feedProblem({ message: 'x', published: 'false', scheduled_publish_time: later(31 * 86_400) })).toMatch(/at most 30 days ahead/)
    expect(feedProblem({ message: 'x', published: 'false', scheduled_publish_time: later(3600), unpublished_content_type: 'SCHEDULED' })).toMatch(/on a scheduled photo post only/)
    expect(feedProblem({ message: 'x', published: 'false', scheduled_publish_time: '+2 weeks' })).toMatch(/Unix seconds/)
  })
  it('who sees it: targeting (countries, age_min of Meta\'s enum) and feed_targeting (countries, ages 13–65) — those keys only', () => {
    expect(feed({ message: 'x', published: 'true', targeting: JSON.stringify({ geo_locations: { countries: ['IT', 'DE'] }, age_min: 18 }) })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem({ message: 'x', published: 'true', targeting: JSON.stringify({ age_min: 16 }) })).toMatch(/one of 13, 15, 18, 21, 25/)
    expect(feedProblem({ message: 'x', published: 'true', targeting: JSON.stringify({ geo_locations: { countries: ['IT'], cities: [{ key: '1' }] } }) })).toMatch(/countries only/)
    expect(feedProblem({ message: 'x', published: 'true', targeting: JSON.stringify({ geo_locations: { countries: ['it'] } }) })).toMatch(/two-letter country codes/)
    expect(feedProblem({ message: 'x', published: 'true', targeting: JSON.stringify({ interests: [1] }) })).toMatch(/geo_locations \(countries\) and \/ or age_min only/)
    expect(feed({ message: 'x', published: 'true', feed_targeting: JSON.stringify({ geo_locations: { countries: ['IT'] }, age_min: 25, age_max: 45 }) })).toMatchObject({ write: { rule: 'pagepost.feed' } })
    expect(feedProblem({ message: 'x', published: 'true', feed_targeting: JSON.stringify({ age_min: 50, age_max: 30 }) })).toMatch(/age_min is at most age_max/)
  })
  it('a video post: Meta fetches file_url; dark = ADS_POST, scheduled = SCHEDULED; only GET_DIRECTIONS with VIDEO_LPP on a dark one', () => {
    const onVideoHost = (params: Record<string, string>) => metaWriteVerdict({ method: 'POST', url: `${VIDEO_BASE}/${PAGE}/videos`, kind: 'write', objectKind: 'postpage', body: form(params) })
    const video = onVideoHost
    const videoProblem = (params: Record<string, string>) => { const v = onVideoHost(params); return 'problem' in v ? v.problem : null }
    const url = 'https://cdn.example-shop.com/v.mp4'
    expect(video({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', title: 'Prova', description: 'Riga uno\nRiga due' })).toMatchObject({ write: { rule: 'pagepost.video', auth: 'page', edgeCall: true } })
    expect(videoProblem({ file_url: url, published: 'false' })).toMatch(/ADS_POST/)
    expect(video({ file_url: url, published: 'false', scheduled_publish_time: later(7200), unpublished_content_type: 'SCHEDULED' })).toMatchObject({ write: { rule: 'pagepost.video' } })
    expect(videoProblem({ file_url: url, published: 'true', unpublished_content_type: 'ADS_POST' })).toMatch(/published video post has no/)
    const geo = JSON.stringify({ type: 'GET_DIRECTIONS', value: { link: 'fbgeo://45.4642, 9.19, "Via Roma 1, Milano"', link_format: 'VIDEO_LPP' } })
    expect(video({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', call_to_action: geo })).toMatchObject({ write: { rule: 'pagepost.video' } })
    expect(videoProblem({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', call_to_action: JSON.stringify({ type: 'SHOP_NOW', value: { link: 'https://example-shop.com/' } }) })).toMatch(/takes only GET_DIRECTIONS/)
    expect(videoProblem({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', call_to_action: JSON.stringify({ type: 'GET_DIRECTIONS', value: { link: 'fbgeo://45.4642, 9.19, "Via Roma 1"' } }) })).toMatch(/VIDEO_LPP/)
    expect(videoProblem({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', title: 'é'.repeat(130) })).toMatch(/at most 254 bytes/)
    expect(videoProblem({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', source: 'x' })).toMatch(/only Meta change/)
    expect(videoProblem({ file_url: url, published: 'false', unpublished_content_type: 'ADS_POST', upload_phase: 'start' })).toMatch(/only Meta change/)
    // Review B-F1 — a Page's video post goes to Meta's video host, and only it goes there.
    expect(problem(`${PAGE}/videos`, 'postpage', { file_url: url, published: 'false', unpublished_content_type: 'ADS_POST' })).toMatch(/goes to Meta's video host https:\/\/graph-video\.facebook\.com/)
    const elsewhere = (path: string, kind: string, params: Record<string, string>) => metaWriteVerdict({ method: 'POST', url: `${VIDEO_BASE}/${path}`, kind: 'write', objectKind: kind, body: form(params) })
    expect(elsewhere(`${PAGE}/feed`, 'postpage', { message: 'x', published: 'true' })).toMatchObject({ problem: expect.stringMatching(/only a Page's video post .* https:\/\/graph\.facebook\.com/) })
    expect(elsewhere(`${PAGE}/photos`, 'postpage', { url: 'https://cdn.example-shop.com/a.jpg', published: 'false' })).toMatchObject({ problem: expect.stringMatching(/only a Page's video post/) })
    expect(elsewhere('120000000000001', 'campaign', { status: 'PAUSED' })).toMatchObject({ problem: expect.stringMatching(/graph\.facebook\.com/) })
    expect(metaWriteVerdict({ method: 'DELETE', url: `${VIDEO_BASE}/${PAGE}/videos`, kind: 'write', objectKind: 'postpage' })).toMatchObject({ problem: expect.stringMatching(/only a Page's video post/) })
  })
  it('an edit of a post: its own kind; publish now is true only; a sponsor goes to the owner check; the delete has no body and its own kind', () => {
    const edit = (params: Record<string, string>) => verdict(POST, 'pagepostedit', params)
    const editProblem = (params: Record<string, string>) => problem(POST, 'pagepostedit', params)
    expect(edit({ message: 'Testo nuovo', is_hidden: 'true' })).toMatchObject({ write: { rule: 'pagepost.update', objectId: POST, auth: 'page' } })
    expect(edit({ sponsor_id: BRAND_PAGE, direct_share_status: '1' })).toMatchObject({ write: { ids: [{ id: BRAND_PAGE, kind: 'postsponsorpage' }] } })
    expect(editProblem({ is_published: 'false' })).toMatch(/is_published is true only/)
    expect(editProblem({ is_published: 'true', scheduled_publish_time: later(3600) })).toMatch(/no scheduled_publish_time/)
    expect(editProblem({ timeline_visibility: 'forced_allow' })).toMatch(/hidden or normal/)
    expect(editProblem({ direct_share_status: '1' })).toMatch(/goes with sponsor_id/)
    expect(editProblem({ sponsor_id: '0130000000000001' })).toMatch(/Facebook Page id/)
    for (const key of ['privacy', 'attached_media', 'tags', 'place', 'sponsor_relationship', 'is_pinned']) expect(editProblem({ message: 'x', [key]: '1' }), key).toMatch(/only Meta change/)
    // The step-37 kinds and the status rule never take a post edit.
    expect(problem(POST, 'fbpost', { message: 'x' })).toMatch(/only Meta change/)
    expect(problem(POST, 'pagepostmade', { message: 'x' })).toMatch(/only Meta change/)
    // The delete: a post Nexus made (its own kind), no body.
    expect(verdict(POST, 'pagepostmade', {}, 'DELETE')).toMatchObject({ write: { rule: 'pagepost.delete', method: 'DELETE', auth: 'page' } })
    expect(problem(POST, 'pagepostedit', {}, 'DELETE')).toMatch(/Nexus deletes on Meta only/)
    expect(problem(POST, 'pagepostmade', { message: 'x' }, 'DELETE')).toMatch(/Nexus deletes on Meta only/)
  })
})

describe('Instagram posts: an exact allow-list per kind of container', () => {
  it('a feed image: its keys only, sponsors and the place as body ids', () => {
    const image = {
      image_url: 'https://cdn.example-shop.com/a.jpg', caption: 'Nuovo! #moto #giacca\nScopri di più', alt_text: 'Una giacca nera',
      collaborators: JSON.stringify(['shop_b', 'rider.one']), user_tags: JSON.stringify([{ username: 'rider.one', x: 0.5, y: 0.8 }]),
      location_id: '110000000000001', branded_content_sponsor_ids: `[${BRAND_IG}]`, is_paid_partnership: 'true', is_ai_generated: 'false',
    }
    expect(container(image)).toMatchObject({ write: { rule: 'igmedia.container', objectId: IG, auth: 'page', edgeCall: true, ids: [{ id: BRAND_IG, kind: 'igsponsor' }, { id: '110000000000001', kind: 'postplace' }] } })
    expect(containerProblem({ ...image, share_to_feed: 'true' })).toMatch(/share_to_feed is not a key of a image/)
    expect(containerProblem({ ...image, user_tags: JSON.stringify([{ username: 'rider.one' }]) })).toMatch(/required for images/)
    expect(containerProblem({ ...image, collaborators: JSON.stringify(['a', 'b', 'c', 'd']) })).toMatch(/1 to 3 Instagram usernames/)
    expect(containerProblem({ ...image, branded_content_sponsor_ids: `[${BRAND_IG},170000000000202,170000000000203]` })).toMatch(/1 to 2 Instagram account ids/)
    expect(containerProblem({ ...image, branded_content_sponsor_ids: `["${BRAND_IG}"]` })).toMatch(/1 to 2 Instagram account ids/)
    expect(containerProblem({ ...image, is_paid_partnership: 'false' })).toMatch(/cannot be false with branded_content_sponsor_ids/)
    expect(containerProblem({ ...image, caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') })).toMatch(/at most 30 hashtags/)
    expect(containerProblem({ ...image, caption: Array.from({ length: 21 }, (_, i) => `@user${i}`).join(' ') })).toMatch(/at most 20 @ tags/)
    expect(containerProblem({ ...image, caption: 'x'.repeat(META_POST_LIMITS.caption + 1) })).toMatch(/1 to 2200 characters/)
    // Product tags are step 35's (it adds them to META_IG_CONTAINER_KEYS and its judges in its own hunk).
    expect(containerProblem({ ...image, product_tags: JSON.stringify([{ product_id: '1', x: 0.5, y: 0.5 }]) })).toMatch(/only Meta change Nexus sends for an organic post/)
    expect(Object.values(META_IG_CONTAINER_KEYS).flat().every((k) => k in META_IG_CONTAINER_JUDGES)).toBe(true)
    // Never a resumable upload (Meta fetches the public link), never a caption add-on yet.
    for (const key of ['upload_type', 'poll_attachment', 'is_comment_prompt_used']) expect(containerProblem({ ...image, [key]: 'x' }), key).toMatch(/only Meta change/)
  })
  it('a reel, a story, carousel items and a carousel: each its own keys', () => {
    const reel = { media_type: 'REELS', video_url: 'https://cdn.example-shop.com/r.mp4', caption: 'Reel', share_to_feed: 'true', cover_url: 'https://cdn.example-shop.com/c.jpg', audio_name: 'Suono originale', thumb_offset: '1500', trial_params: '{"graduation_strategy":"MANUAL"}', user_tags: JSON.stringify([{ username: 'rider.one' }]) }
    expect(container(reel)).toMatchObject({ write: { rule: 'igmedia.container' } })
    expect(containerProblem({ ...reel, alt_text: 'x' })).toMatch(/alt_text is not a key of a reel/)
    expect(containerProblem({ ...reel, user_tags: JSON.stringify([{ username: 'rider.one', x: 0.1, y: 0.1 }]) })).toMatch(/no place on a picture/)
    expect(containerProblem({ ...reel, trial_params: '{"graduation_strategy": "MANUAL"}' })).toMatch(/graduation_strategy/)
    expect(containerProblem({ ...reel, image_url: 'https://cdn.example-shop.com/a.jpg' })).toMatch(/an Instagram container is/)
    expect(container({ media_type: 'STORIES', image_url: 'https://cdn.example-shop.com/s.jpg', user_tags: JSON.stringify([{ username: 'rider.one' }]) })).toMatchObject({ write: { rule: 'igmedia.container' } })
    expect(containerProblem({ media_type: 'STORIES', image_url: 'https://cdn.example-shop.com/s.jpg', caption: 'x' })).toMatch(/caption is not a key of a story/)
    expect(containerProblem({ media_type: 'STORIES', video_url: 'https://cdn.example-shop.com/s.mp4', collaborators: '["a"]' })).toMatch(/not a key of a story/)
    expect(container({ image_url: 'https://cdn.example-shop.com/1.jpg', is_carousel_item: 'true', alt_text: 'Uno' })).toMatchObject({ write: { rule: 'igmedia.container' } })
    expect(containerProblem({ image_url: 'https://cdn.example-shop.com/1.jpg', is_carousel_item: 'true', caption: 'x' })).toMatch(/caption is not a key of a carousel item/)
    expect(container({ media_type: 'VIDEO', video_url: 'https://cdn.example-shop.com/2.mp4', is_carousel_item: 'true' })).toMatchObject({ write: { rule: 'igmedia.container' } })
    expect(containerProblem({ media_type: 'VIDEO', video_url: 'https://cdn.example-shop.com/2.mp4' })).toMatch(/an Instagram container is/)
    const children = `${CONTAINER},180000000000002,180000000000003`
    expect(container({ media_type: 'CAROUSEL', children, caption: 'Tre foto' })).toMatchObject({ write: { ids: [CONTAINER, '180000000000002', '180000000000003'].map((id) => ({ id, kind: 'igcontainer' })) } })
    expect(containerProblem({ media_type: 'CAROUSEL', children: CONTAINER })).toMatch(/comma list of 2 to 20/)
    expect(containerProblem({ media_type: 'CAROUSEL', children: `${CONTAINER},${CONTAINER}` })).toMatch(/each once/)
    expect(containerProblem({ media_type: 'CAROUSEL', children: JSON.stringify([CONTAINER, '180000000000002']) })).toMatch(/comma list/)
    expect(containerProblem({ media_type: 'CAROUSEL', caption: 'x' })).toMatch(/names its children/)
    expect(containerProblem({ media_type: 'CAROUSEL', children, alt_text: 'x' })).toMatch(/alt_text is not a key of a carousel/)
  })
  it('the publish: creation_id only, a container id to check; an event: Meta\'s notification rules; the delete: a media Nexus made', () => {
    expect(verdict(`${IG}/media_publish`, 'postig', { creation_id: CONTAINER })).toMatchObject({ write: { rule: 'igmedia.publish', ids: [{ id: CONTAINER, kind: 'igcontainer' }] } })
    expect(problem(`${IG}/media_publish`, 'postig', { creation_id: CONTAINER, caption: 'x' })).toMatch(/only Meta change/)
    expect(problem(`${IG}/media_publish`, 'postig', { creation_id: 'abc' })).toMatch(/media container id/)
    const iso = (sec: number) => `${new Date(Date.now() + sec * 1000).toISOString().slice(0, 19)}+0000`
    const event = (params: Record<string, string>) => problem(`${IG}/upcoming_events`, 'postig', params)
    expect(verdict(`${IG}/upcoming_events`, 'postig', { title: 'Saldi d\'autunno', start_time: iso(86_400), end_time: iso(90_000), notification_subtypes: '["EVENT_START","BEFORE_EVENT_1DAY","BEFORE_EVENT_15MIN"]' })).toMatchObject({ write: { rule: 'iguser.upcomingEvent' } })
    expect(event({ title: 'x', start_time: iso(-60) })).toMatch(/in the future/)
    expect(event({ title: 'x', start_time: '2026-13-01T00:00:00+0000' })).toMatch(/UTC time as Meta writes it/)
    expect(event({ title: 'x', start_time: iso(86_400), end_time: iso(3600) })).toMatch(/after start_time/)
    expect(event({ title: 'x', start_time: iso(86_400), notification_target_time: 'EVENT_END', notification_subtypes: '["BEFORE_EVENT_2DAY","BEFORE_EVENT_1DAY","BEFORE_EVENT_1HOUR"]', end_time: iso(90_000) })).toMatch(/no end_time/)
    expect(event({ title: 'x', start_time: iso(86_400), notification_target_time: 'EVENT_END', notification_subtypes: '["EVENT_START","BEFORE_EVENT_1DAY","BEFORE_EVENT_15MIN"]' })).toMatch(/exactly BEFORE_EVENT_2DAY/)
    expect(event({ title: 'x', start_time: iso(86_400), notification_subtypes: '["BEFORE_EVENT_15MIN","AFTER_EVENT_1DAY","AFTER_EVENT_2DAY"]' })).toMatch(/EVENT_START, BEFORE_EVENT_1DAY and one/)
    expect(event({ title: 'x', start_time: iso(86_400), notification_target_time: 'EVENT_END' })).toMatch(/notifications are named/)
    expect(verdict(MEDIA, 'igmediamade', {}, 'DELETE')).toMatchObject({ write: { rule: 'igmedia.delete', method: 'DELETE', auth: 'page' } })
    expect(problem(MEDIA, 'igmedia', {}, 'DELETE')).toMatch(/Nexus deletes on Meta only/)
  })
})

describe('the owner check, then the Page token', () => {
  it('a post on the chosen Page: no read, the Page\'s token, then the post — never another Page, never with no Page chosen', async () => {
    h.answers.push(tokenAnswer(), json({ id: POST }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'false', message: 'Ciao' }, check: false })
    expect(res.ok).toBe(true)
    expect(paths()).toEqual([`GET /${PAGE}`, `POST /${PAGE}/feed`])
    expect(sent(0).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    expect(sent(1).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(sent(1).body).toBe(form({ published: 'false', message: 'Ciao' }))
    // The Page's token never reaches the answer or the ledger.
    expect(res.text).not.toContain(PAGE_TOKEN)
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
    h.calls = []
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: OTHER_PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'false', message: 'Ciao' }, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    delete gatewayMetaPage['m-2']
    expect(await metaWriteCall({ connectionId: 'm-2', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'false', message: 'Ciao' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
  it('a photo post: a photo made in the SAME run needs no read; another one must be the Page\'s (`from`), else nothing is sent', async () => {
    h.answers.push(tokenAnswer(), json({ id: PHOTO, post_id: `${PAGE}_${PHOTO}` }))
    await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.photo', objectId: PAGE, objectKind: 'postpage', edge: 'photos', params: { url: 'https://cdn.example-shop.com/a.jpg', published: 'false' }, check: false, run: 'run-1' })
    h.calls = []
    const attached = { published: 'true', attached_media: JSON.stringify([{ media_fbid: PHOTO }]) }
    h.answers.push(tokenAnswer(), json({ id: `${PAGE}_500000000000002` }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: attached, check: false, run: 'run-1' })).ok).toBe(true)
    expect(paths()).toEqual([`GET /${PAGE}`, `POST /${PAGE}/feed`])
    h.calls = []
    // Another run (or none): one read of the photo; another Page's photo is refused before the token is read.
    h.answers.push(json({ id: PHOTO, from: { id: OTHER_PAGE } }))
    const theirs = await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: attached, check: false, run: 'run-2' }).catch((e) => e)
    expect(theirs).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/not one of the Facebook Page this business chose/) })
    expect(theirs.message).not.toContain(OTHER_PAGE)
    expect(paths()).toEqual([`GET /${PHOTO}`])
    expect(sent(0).url.searchParams.get('fields')).toBe('id,from{id}')
    h.calls = []
    h.answers.push(json({ id: PHOTO, from: { id: PAGE } }), tokenAnswer(), json({ id: `${PAGE}_500000000000003` }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: attached, check: false })).ok).toBe(true)
    // A failed photo upload is never remembered as made.
    __postOwnerTest.reset(); h.calls = []
    h.answers.push(tokenAnswer(), json({ error: { code: 324, message: 'Missing or invalid image file' } }, 400))
    await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.photo', objectId: PAGE, objectKind: 'postpage', edge: 'photos', params: { url: 'https://cdn.example-shop.com/b.jpg', published: 'false' }, check: false, run: 'run-3' })
    h.answers.push(json({ error: { code: 100, message: 'Unsupported get request' } }, 400))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'true', attached_media: JSON.stringify([{ media_fbid: '140000000000009' }]) }, check: false, run: 'run-3' }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_UNCONFIRMED' })
  })
  it('a library image by its hash: one read of the chosen ad account\'s images; a hash not there is refused', async () => {
    h.answers.push(json({ data: [{ hash: 'abc123' }] }), tokenAnswer(), json({ id: POST }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'false', link: 'https://example-shop.com/', image_hash: 'abc123' }, check: false })).ok).toBe(true)
    expect(paths()[0]).toBe('GET /act_1234567890/adimages')
    expect(sent(0).url.searchParams.get('hashes')).toBe('["abc123"]')
    h.calls = []
    h.answers.push(json({ data: [] }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'false', link: 'https://example-shop.com/', image_hash: 'zzz999' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/image library/) })
    expect(h.calls).toHaveLength(1)
  })
  it('an edit: a post the chosen Page WROTE; a visitor\'s post, another Page\'s, a sponsor of another business or the Page itself: refused', async () => {
    const edit = (params: Record<string, string>, objectId = POST) => metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.update', objectId, objectKind: 'pagepostedit', params, check: false }).catch((e) => e)
    h.answers.push(json({ id: POST, from: { id: PAGE } }), tokenAnswer(), json({ success: true }))
    expect((await edit({ message: 'Nuovo testo' })).ok).toBe(true)
    expect(paths()).toEqual([`GET /${POST}`, `GET /${PAGE}`, `POST /${POST}`])
    expect(sent(2).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    h.calls = []; __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ id: POST, from: { id: '300000000000001' } }))
    expect(await edit({ is_hidden: 'true' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/visitor's post/) })
    expect(await edit({ is_hidden: 'true' }, `${OTHER_PAGE}_500000000000001`)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    h.calls = []
    gatewayMetaTakenLinks.add(`PAGE:${BRAND_PAGE}`)
    h.answers.push(json({ id: POST, from: { id: PAGE } }))
    const taken = await edit({ sponsor_id: BRAND_PAGE })
    expect(taken).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/another business in Nexus uses/) })
    h.answers.push(json({ id: POST, from: { id: PAGE } }))
    expect(await edit({ sponsor_id: PAGE })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/the chosen Page itself/) })
    expect(h.calls.every((c) => c.init.method === 'GET' && new URL(c.url).searchParams.get('access_token') === SYSTEM_TOKEN)).toBe(true)
  })
  it('a delete: only a post or media Nexus made (its change records); nothing is read or sent for any other', async () => {
    const remove = (objectId: string, objectKind: 'pagepostmade' | 'igmediamade', connectionId = 'm-1') => metaWriteCall({ connectionId, operation: objectKind === 'pagepostmade' ? 'pagepost.delete' : 'igmedia.delete', objectId, objectKind, method: 'DELETE', params: {}, check: false }).catch((e) => e)
    expect(await remove(POST, 'pagepostmade')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    expect(await remove(MEDIA, 'igmediamade')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not an Instagram media Nexus published/) })
    expect(h.calls).toHaveLength(0)
    gatewayMetaPostsMade.add(`pagepost:${POST}:${PAGE}`)
    gatewayMetaPostsMade.add(`igmedia:${MEDIA}:${IG}`)
    // Recorded for ANOTHER Instagram account: never this one's.
    gatewayMetaInstagram['m-5'] = OTHER_IG
    expect(await remove(MEDIA, 'igmediamade', 'm-5')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    h.answers.push(tokenAnswer(), json({ success: true }))
    expect((await remove(POST, 'pagepostmade')).ok).toBe(true)
    h.answers.push(tokenAnswer(), json({ success: true, deleted_id: MEDIA }))
    expect((await remove(MEDIA, 'igmediamade')).ok).toBe(true)
    expect(paths()).toEqual([`GET /${PAGE}`, `DELETE /${POST}`, `GET /${PAGE}`, `DELETE /${MEDIA}`])
    expect(sent(3).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
  })
  it('Instagram: the chosen account only; a carousel names containers of the same run or ones Nexus recorded; sponsors and places of other businesses refused', async () => {
    const post = (objectId: string, edge: 'media' | 'media_publish', params: Record<string, string>, run?: string, connectionId = 'm-1') => metaWriteCall({ connectionId, operation: edge === 'media' ? 'igmedia.container' : 'igmedia.publish', objectId, objectKind: 'postig', edge, params, check: false, ...(run ? { run } : {}) }).catch((e) => e)
    expect(await post(OTHER_IG, 'media', { image_url: 'https://cdn.example-shop.com/a.jpg' })).toMatchObject({ code: 'META_INSTAGRAM_NOT_CHOSEN' })
    delete gatewayMetaInstagram['m-6']
    gatewayMetaPage['m-6'] = PAGE
    expect(await post(IG, 'media', { image_url: 'https://cdn.example-shop.com/a.jpg' }, undefined, 'm-6')).toMatchObject({ code: 'META_INSTAGRAM_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    // Two items made in run-1, then the carousel from them, then its publish.
    for (const id of ['180000000000011', '180000000000012']) {
      h.answers.push(tokenAnswer(), json({ id }))
      expect((await post(IG, 'media', { image_url: 'https://cdn.example-shop.com/a.jpg', is_carousel_item: 'true' }, 'run-1')).ok).toBe(true)
    }
    h.answers.push(tokenAnswer(), json({ id: CONTAINER }))
    expect((await post(IG, 'media', { media_type: 'CAROUSEL', children: '180000000000011,180000000000012' }, 'run-1')).ok).toBe(true)
    h.answers.push(tokenAnswer(), json({ id: MEDIA }))
    expect((await post(IG, 'media_publish', { creation_id: CONTAINER }, 'run-1')).ok).toBe(true)
    expect(h.calls.filter((c) => c.init.method === 'POST').every((c) => new URL(c.url).searchParams.get('access_token') === PAGE_TOKEN)).toBe(true)
    h.calls = []
    // Another run: not made there, not recorded — refused; recorded by an earlier change of this business — published.
    expect(await post(IG, 'media_publish', { creation_id: CONTAINER }, 'run-2')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/a container has no owner Meta can name/) })
    gatewayMetaPostsMade.add(`igcontainer:${CONTAINER}:${IG}`)
    h.answers.push(tokenAnswer(), json({ id: MEDIA }))
    expect((await post(IG, 'media_publish', { creation_id: CONTAINER }, 'run-2')).ok).toBe(true)
    h.calls = []
    // Sponsors and places: never the chosen account, never another Nexus business's.
    expect(await post(IG, 'media', { image_url: 'https://cdn.example-shop.com/a.jpg', branded_content_sponsor_ids: `[${IG}]` })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Cannot tag yourself as sponsor/) })
    gatewayMetaTakenLinks.add(`INSTAGRAM:${BRAND_IG}`)
    expect(await post(IG, 'media', { image_url: 'https://cdn.example-shop.com/a.jpg', branded_content_sponsor_ids: `[${BRAND_IG}]` })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/another business in Nexus uses/) })
    gatewayMetaTakenLinks.add('PAGE:110000000000001')
    expect(await post(IG, 'media', { image_url: 'https://cdn.example-shop.com/a.jpg', location_id: '110000000000001' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/another business in Nexus uses/) })
    expect(h.calls).toHaveLength(0)
  })
  it('a refused post change names the Page\'s tasks and the posting permissions (Facebook) or the publishing ones (Instagram)', async () => {
    h.answers.push(tokenAnswer(), json({ error: { code: 200, message: 'Permissions error' } }, 403))
    const err = await metaSendChange({ connectionId: 'm-1', adAccountId: '1234567890' }, { objectId: PAGE, kind: 'postpage', edge: 'feed', operation: 'pagepost.feed', params: { published: 'false', message: 'x' } }).catch((e) => e)
    expect(err.message).toMatch(/CREATE_CONTENT task .* pages_manage_posts/)
    h.answers.push(tokenAnswer(), json({ error: { code: 10, message: 'Application does not have permission for this action' } }, 403))
    const ig = await metaSendChange({ connectionId: 'm-1', adAccountId: '1234567890' }, { objectId: IG, kind: 'postig', edge: 'media', operation: 'igmedia.container', params: { image_url: 'https://cdn.example-shop.com/a.jpg' } }).catch((e) => e)
    expect(ig.message).toMatch(/instagram_content_publish/)
  })
  it('with Meta changes switched off, nothing is read or sent', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.feed', objectId: PAGE, objectKind: 'postpage', edge: 'feed', params: { published: 'true', message: 'x' }, check: false }).catch((e) => e)
    expect(res).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('review fixes — guards no rule reaches today, and a video post Nexus made', () => {
  it('M20 — a post kind names only its own body ids (an edit with a photo id is refused before any read)', async () => {
    const read = vi.fn()
    const write = { rule: 'pagepost.update', objectId: POST, check: false, body: '', budget: false, kinds: ['pagepostedit' as const], auth: 'page' as const, ids: [{ id: PHOTO, kind: 'postphoto' as const }] }
    expect(await metaPostOwnerProblem('m-1', write, 'pagepostedit', read)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', sentence: expect.stringMatching(/names an id inside its body that Nexus does not check/) })
    expect(await metaPostOwnerProblem('m-1', { ...write, kinds: ['postig'], ids: [{ id: CONTAINER, kind: 'postsponsorpage' as const }] }, 'postig', read)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await metaPostOwnerProblem('m-1', { ...write, ids: [] }, 'page', read)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(read).not.toHaveBeenCalled()
  })
  it('M22 — a post\'s body ids are refused on every rule that is not a post rule (gateway.ts metaBodyIdsProblem)', () => {
    for (const kind of ['postphoto', 'postimagehash', 'postsponsorpage', 'igcontainer', 'igsponsor', 'postplace']) expect(isMetaPostBodyKind(kind), kind).toBe(true)
    expect(isMetaPostBodyKind('pagephoto')).toBe(false)
    const gateway = readFileSync(new URL('./gateway.ts', import.meta.url), 'utf8')
    const start = gateway.indexOf('async function metaBodyIdsProblem')
    const body = gateway.slice(start, gateway.indexOf('\n}\n', start))
    // The refusal sits BEFORE the generic owner check of a body id (which would otherwise judge it as some other kind).
    const guard = body.indexOf('if (isMetaPostBodyKind(inner.kind)) return { code: \'META_WRITE_NOT_ALLOWED\'')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(body.indexOf('const problem = await metaOwnerProblem(connectionId, { ...write, objectId: inner.id'))
  })
  it('B-F2 / N4 — a video post whose record names only its video: the delete names that video, ONE read of it, its post_id (the Page\'s own video) must be the post deleted', async () => {
    const VIDEO = '160000000000001'
    const remove = (video: string | null = VIDEO) => metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.delete', objectId: POST, objectKind: 'pagepostmade', method: 'DELETE', params: {}, check: false, ...(video ? { parent: { kind: 'pagevideo' as const, id: video } } : {}) }).catch((e) => e)
    gatewayMetaPostsMade.add(`pagevideo:${VIDEO}:${PAGE}`)
    // No video named, or one no record of this business names: refused, no video read at all (no scan of other videos).
    expect(await remove(null)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    expect(await remove('160000000000009')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
    // Another Page's video, or one whose post is another: refused, nothing deleted.
    h.answers.push(json({ id: VIDEO, post_id: '500000000000001', from: { id: OTHER_PAGE } }))
    expect(await remove()).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not one Nexus made/) })
    h.answers.push(json({ id: VIDEO, post_id: '500000000000009', from: { id: PAGE } }))
    expect(await remove()).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
    h.calls = []
    h.answers.push(json({ id: VIDEO, post_id: '500000000000001', from: { id: PAGE } }), tokenAnswer(), json({ success: true }))
    expect((await remove()).ok).toBe(true)
    expect(paths()).toEqual([`GET /${VIDEO}`, `GET /${PAGE}`, `DELETE /${POST}`])
    expect(sent(0).url.searchParams.get('fields')).toBe('id,post_id,from{id}')
  })
  it('N2 — a video\'s post_id: the chosen Page\'s post as given or by its digits; another Page\'s post or no post is none', () => {
    expect(metaVideoPostIdOf(`${PAGE}_500000000000001`, PAGE)).toBe(`${PAGE}_500000000000001`)
    expect(metaVideoPostIdOf('500000000000001', PAGE)).toBe(`${PAGE}_500000000000001`)
    expect(metaVideoPostIdOf(`${OTHER_PAGE}_500000000000001`, PAGE)).toBeNull()
    expect(metaVideoPostIdOf(undefined, PAGE)).toBeNull()
    expect(metaVideoPostIdOf('', PAGE)).toBeNull()
  })
  it('B-F1 — a video post is sent to Meta\'s video host, as the Page', async () => {
    h.answers.push(tokenAnswer(), json({ id: '160000000000001' }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'pagepost.video', objectId: PAGE, objectKind: 'postpage', edge: 'videos', videoHost: true, params: { file_url: 'https://cdn.example-shop.com/v.mp4', published: 'false', unpublished_content_type: 'ADS_POST' }, check: false })
    expect(res.ok).toBe(true)
    expect(new URL(h.calls[1].url).host).toBe('graph-video.facebook.com')
    expect(sent(1).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
  })
})
