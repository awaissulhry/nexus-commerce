/**
 * Meta on the gateway, step 25 (create-meta-creative, set-meta-creative): a creative reaches Meta ONLY as one of its exact
 * allow-list entries (meta-creative-rules.ts) — every key of every JSON spec judged at every depth, in ONE spelling, with
 * every silent feature named (every Advantage+ creative feature Meta documents, multi-advertiser ads, music, format
 * automation, shop routing) — on the business's CHOSEN ad account (the act_<id> in the path), and every id inside it the
 * business's own (the chosen Page and Instagram account, a partner only beside them and never another Nexus business's, an
 * image of the account's library, a post / Instant Experience / lead form of the chosen Page). Meta's check (validate_only)
 * goes for the creative create only. A creative's name, labels and status change on the creative itself (its kind
 * confirmed); a creative is deleted only by its own DELETE rule. Made-up ids only.
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

import { GATEWAY_META_PAGE, gatewayLedger, gatewayMetaChosen, gatewayMetaMedia, gatewayMetaTakenLinks } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import {
  creativeTypeOf, isJsonCreativeKey, judgeCreativeForm, META_AI_GENERATED_FEATURES, META_CREATIVE_FEATURES, META_FEATURES_GUIDE, META_FEATURES_OTHER, META_FEATURES_SPEC_REFERENCE,
  META_FORMAT_AUTOMATION_FORMATS, META_NON_CATALOG_FORMATS, metaCreativeTextProblem, partsOptIns, silentKeysFor,
} from './meta-creative-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PAGE = GATEWAY_META_PAGE
const IG = '17841400000000001'
const HASH = 'abc123def456'
const CREATIVE = '120000000000301'

/**
 * A creative with every silent key it must name, OFF — computed by the gateway's own rule (silentKeysFor) from what the
 * creative does; a key the creative already names is kept (so a test can leave one out or change it).
 */
const complete = (c: Record<string, unknown>): Record<string, any> => {
  const want = silentKeysFor(c)
  const story = c.object_story_spec as { link_data?: Record<string, unknown> } | undefined
  const cards = Array.isArray(story?.link_data?.child_attachments) && !('multi_share_optimized' in story!.link_data!)
  return {
    degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }])) },
    contextual_multi_ads: { enroll_status: 'OPT_OUT' },
    ...(want.formats ? { format_transformation_spec: want.formats.map((format) => ({ format, data_source: ['none'] })) } : {}),
    ...(want.audios ? { asset_feed_spec: { audios: [] as unknown[] } } : {}),
    ...(want.destination ? { destination_spec: { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' } } : {}),
    ...(want.productTags ? { interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }] } } : {}),
    ...c,
    ...(cards ? { object_story_spec: { ...story, link_data: { ...story!.link_data, multi_share_optimized: false } } } : {}),
  }
}
/** A creative of the chosen Page with this story (and its silent keys). */
const withStory = (story: Record<string, unknown>, over: Record<string, unknown> = {}) => complete({ name: 'Creative A', object_story_spec: { page_id: PAGE, ...story }, ...over })
/** The silent keys a creative of an existing post with no website link names. */
// Step 26 (review B4) — the gateway requires the product-tag opt-out on every existing post too.
const postSilent = () => ({ degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }])) }, contextual_multi_ads: { enroll_status: 'OPT_OUT' }, interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }] } })
/** A full image creative, as decoded keys. */
const creative = (over: Record<string, unknown> = {}) => complete({
  name: 'Creative A',
  object_story_spec: { page_id: PAGE, instagram_user_id: IG, link_data: { link: 'https://www.example.com/shoes', message: 'Scarpe nuove — 20 € 🎉\nSolo oggi', name: 'Nuove scarpe', image_hash: HASH, call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/shoes' } } } },
  ...over,
})
const JSON_KEYS = { has: (k: string) => isJsonCreativeKey(k) }
const form = (c: Record<string, unknown>, extra: Record<string, string> = {}) => new URLSearchParams({ ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, JSON_KEYS.has(k) ? JSON.stringify(v) : String(v)])), ...extra }).toString()
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/adcreatives`, kind: 'write', objectKind: 'adaccount', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => {
  const v = verdict(input)
  return 'problem' in v ? v.problem : null
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body as string | undefined })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaMedia)) delete gatewayMetaMedia[key]
  gatewayMetaTakenLinks.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the silent features (binding lane rule)', () => {
  it('ONE list covers every key the features-spec reference, the Advantage+ guide and Meta\'s other pages name', () => {
    for (const key of [...META_FEATURES_SPEC_REFERENCE, ...META_FEATURES_GUIDE, ...META_FEATURES_OTHER]) expect(META_CREATIVE_FEATURES, key).toContain(key)
    expect(META_FEATURES_SPEC_REFERENCE).toHaveLength(46)
    expect(META_FEATURES_GUIDE).toHaveLength(23)
    expect(new Set(META_CREATIVE_FEATURES).size).toBe(META_CREATIVE_FEATURES.length)
    for (const key of META_AI_GENERATED_FEATURES) expect(META_CREATIVE_FEATURES, key).toContain(key)
    // The guide's own example spelling is not a feature (its table says image_templates).
    expect(META_CREATIVE_FEATURES).not.toContain('image_template')
  })

  it('a creative without every silent key named is refused: no feature, multi-advertiser, music, format or shop default slips through', () => {
    const c = creative()
    expect(problem({ body: form(c) })).toBeNull()
    const lessFeatures = creative({ degrees_of_freedom_spec: { creative_features_spec: { inline_comment: { enroll_status: 'OPT_OUT' } } } })
    expect(problem({ body: form(lessFeatures) })).toMatch(/enroll_status for every Advantage\+ creative feature/)
    const noMulti = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'contextual_multi_ads'))
    expect(problem({ body: form(noMulti) })).toMatch(/only Meta change/)
    expect(problem({ body: form(creative({ format_transformation_spec: [{ format: 'carousel', data_source: ['none'] }] })) })).toMatch(/format_transformation_spec for each/)
    expect(problem({ body: form(creative({ asset_feed_spec: {} })) })).toMatch(/asset_feed_spec.audios/)
    // An opt-in is allowed (the tool names it in the preview).
    const optIn = creative()
    ;(optIn.degrees_of_freedom_spec.creative_features_spec as Record<string, unknown>).image_templates = { enroll_status: 'OPT_IN' }
    expect(problem({ body: form(optIn) })).toBeNull()
  })
})

describe('the creative allow-list, at every depth', () => {
  it('takes every language, accents, € and emoji, line breaks in a message — and refuses bidi controls and invisible text', () => {
    expect(metaCreativeTextProblem('Größe: 42 — 19,90 € 👟', 255, 'name')).toBeNull()
    expect(metaCreativeTextProblem('Riga uno\nRiga due', 255, 'message', { lines: true })).toBeNull()
    expect(metaCreativeTextProblem('Riga uno\nRiga due', 255, 'name')).toMatch(/control or format/)
    expect(metaCreativeTextProblem('abc‮def', 255, 'name')).toMatch(/bidirectional/)
    expect(metaCreativeTextProblem('​​', 255, 'name')).toMatch(/control or format|visible/)
    expect(metaCreativeTextProblem('   ', 255, 'name')).toMatch(/visible/)
  })

  it('refuses a key not named at its depth, a duplicate member, another spelling, non-JSON and oversize', () => {
    const extra = creative()
    ;(extra.object_story_spec.link_data as Record<string, unknown>).secret_field = 'x'
    expect(problem({ body: form(extra) })).toMatch(/link_data.secret_field is not a key/)
    const c = creative()
    const raw = JSON.stringify(c.object_story_spec)
    const dup = raw.replace('"page_id":', `"page_id":"${PAGE}","page_id":`)
    expect(problem({ body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form(c))), object_story_spec: dup }).toString() })).toMatch(/one spelling/)
    const spaced = JSON.stringify(c.object_story_spec, null, 1)
    expect(problem({ body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form(c))), object_story_spec: spaced }).toString() })).toMatch(/one spelling|printable text/)
    const blank = JSON.stringify(c.object_story_spec).replace('{"page_id"', '{ "page_id"')
    expect(problem({ body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form(c))), object_story_spec: blank }).toString() })).toMatch(/one spelling/)
    const escaped = raw.replace('"page_id"', '"page\\u005fid"')
    expect(problem({ body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form(c))), object_story_spec: escaped }).toString() })).toMatch(/one spelling/)
    expect(problem({ body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form(c))), object_story_spec: '{not json' }).toString() })).toMatch(/JSON/)
    const big = creative()
    ;(big.object_story_spec.link_data as Record<string, unknown>).message = 'x'.repeat(5000)
    expect(problem({ body: form(big) })).toMatch(/1 to 4096 characters/)
    const proto = raw.replace('{"page_id"', '{"__proto__":{"x":1},"page_id"')
    expect(problem({ body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form(c))), object_story_spec: proto }).toString() })).toMatch(/__proto__ is not a key/)
  })

  it('refuses links that are not public https, or carry a key or signature; takes tel: only for a call button', () => {
    const at = (link: string) => creative({ object_story_spec: { page_id: PAGE, link_data: { link, image_hash: HASH } } })
    expect(problem({ body: form(at('http://www.example.com/')) })).toMatch(/https/)
    expect(problem({ body: form(at('https://www.example.com/?access_token=abc')) })).toMatch(/no key, signature or sign-in/)
    expect(problem({ body: form(at('https://localhost/x')) })).toMatch(/public host/)
    expect(problem({ body: form(at('https://192.168.0.1/x')) })).toMatch(/public host/)
    const call = withStory({ link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'CALL_NOW', value: { link: 'tel:+15555550100' } } } })
    expect(problem({ body: form(call) })).toBeNull()
    expect(problem({ body: form(at('tel:+15555550100')) })).toMatch(/https/)
    // MD-005: a picture Meta fetches — a public link of the business's own host, never one of Meta's CDN links.
    const pic = (picture: string) => creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', picture } } })
    expect(problem({ body: form(pic('https://cdn.example.com/a.jpg')) })).toBeNull()
    expect(problem({ body: form(pic('https://scontent.xx.fbcdn.net/a.jpg')) })).toMatch(/host the image on your own servers/)
    const judged = judgeCreativeForm(new URLSearchParams(form(pic('https://cdn.example.com/a.jpg'))) as unknown as Map<string, string>)
    expect('warnings' in judged && (judged as { warnings: string[] }).warnings.join(' ')).toMatch(/Meta fetches a picture link itself/)
  })

  it('answers in words: political ads, WhatsApp identities, Threads ids, app links, catalog ids (step 18), polls, instagram_actor_id, page-less ads', () => {
    expect(problem({ body: form(creative({ authorization_category: 'POLITICAL' })) })).toMatch(/banned in the EU/)
    expect(problem({ body: form(creative({ wamo_whatsapp_identity_spec: 'x' })) })).toMatch(/do not run in the EU/)
    expect(problem({ body: form(creative({ threads_user_id: '123' })) })).toMatch(/Threads ads on the Instagram account/)
    expect(problem({ body: form(creative({ applink_treatment: 'web_only' })) })).toMatch(/no app/)
    expect(problem({ body: form(creative({ product_set_id: '123' })) })).toMatch(/catalog rule \(step 18\)/)
    expect(problem({ body: form(creative({ title: 'x' })) })).toMatch(/without a Page/)
    expect(problem({ body: form(creative({ interactive_components_spec: { components: [{ type: 'poll' }] } })) })).toMatch(/removed polls/)
    expect(problem({ body: form(creative({ interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }] } })) })).toBeNull()
    const actor = creative({ object_story_spec: { page_id: PAGE, instagram_actor_id: IG, link_data: { link: 'https://www.example.com/', image_hash: HASH } } })
    expect(problem({ body: form(actor) })).toMatch(/instagram_user_id/)
  })

  it('takes the formats Meta documents: carousel 2–10 cards, Dynamic Creative, language rules, messaging welcome, collection', () => {
    const card = (n: number) => ({ link: `https://www.example.com/p${n}`, name: `Card ${n}`, image_hash: HASH })
    const carousel = (n: number) => creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', message: 'Tutti', child_attachments: Array.from({ length: n }, (_, i) => card(i)) } } })
    expect(problem({ body: form(carousel(2)) })).toBeNull()
    expect(problem({ body: form(carousel(10)) })).toBeNull()
    expect(problem({ body: form(carousel(1)) })).toMatch(/2 to 10/)
    expect(problem({ body: form(carousel(11)) })).toMatch(/2 to 10/)
    const dco = creative({
      object_story_spec: { page_id: PAGE, instagram_user_id: IG },
      asset_feed_spec: { images: [{ hash: HASH }], bodies: [{ text: 'Uno' }, { text: 'Due' }], titles: [{ text: 'T' }], link_urls: [{ website_url: 'https://www.example.com/' }], call_to_action_types: ['SHOP_NOW'], ad_formats: ['SINGLE_IMAGE'], audios: [] },
    })
    expect(problem({ body: form(dco) })).toBeNull()
    const welcome = withStory({ link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }, page_welcome_message: { type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text', text_format: { customer_action_type: 'ice_breakers', message: { text: 'Ciao {{user_first_name}}!', ice_breakers: [{ title: 'Taglie?', response: 'Dalla S alla XXL' }], quick_replies: [] } }, user_edit: false, surface: 'visual_editor_new' } } })
    expect(problem({ body: form(welcome) })).toBeNull()
    const collection = withStory({ link_data: { link: 'https://fb.com/canvas_doc/120000000000901', message: 'Scopri', image_hash: HASH, collection_thumbnails: ['1', '2', '3', '4'].map((n) => ({ element_id: `12000000000099${n}`, element_crops: { '100x100': [[0, 0], [100, 100]] } })) } })
    expect(problem({ body: form(collection) })).toBeNull()
    const three = creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://fb.com/canvas_doc/120000000000901', image_hash: HASH, collection_thumbnails: ['1', '2', '3'].map((n) => ({ element_id: `12000000000099${n}` })) } } })
    expect(problem({ body: form(three) })).toMatch(/4 to 4/)
  })

  it('collects every id inside for the gateway\'s check (identity, images, videos, canvas and its elements, forms)', () => {
    const c = withStory({ instagram_user_id: IG, link_data: { link: 'https://fb.com/canvas_doc/120000000000901', image_hash: HASH, collection_thumbnails: ['1', '2', '3', '4'].map((n) => ({ element_id: `12000000000099${n}` })), call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '120000000000777' } } } })
    const judged = judgeCreativeForm(new URLSearchParams(form(c)) as unknown as Map<string, string>)
    expect('assets' in judged).toBe(true)
    const kinds = (judged as { assets: Array<{ kind: string; id: string; with?: string }> }).assets
    expect(kinds).toEqual(expect.arrayContaining([
      { id: PAGE, kind: 'identitypage' }, { id: IG, kind: 'identityinstagram' }, { id: HASH, kind: 'adimage' },
      { id: '120000000000901', kind: 'canvas' }, { id: '120000000000991', kind: 'canvaselement', with: '120000000000901' }, { id: '120000000000777', kind: 'leadform' },
    ]))
  })

  it('Meta\'s check (validate_only) goes for the creative create only, exactly in Nexus\'s spelling, declared a read', () => {
    const body = form(creative(), { execution_options: '["validate_only"]' })
    const v = verdict({ body, kind: 'read' })
    expect('write' in v && v.write).toMatchObject({ rule: 'adaccount.creative.create', check: true, checkable: true })
    expect(problem({ body, kind: 'write' })).toMatch(/goes as a read/)
    expect(problem({ body: form(creative(), { execution_options: '["validate_only","include_recommendations"]' }), kind: 'read' })).toMatch(/only execution_options/)
    // The creative update and its labels have no check (not documented): refused.
    expect(problem({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative', body: new URLSearchParams({ name: 'B', execution_options: '["validate_only"]' }).toString(), kind: 'read' })).toMatch(/only Meta change/)
  })
})

describe('a creative on the gateway', () => {
  it('a check of a creative of the chosen account: the image is read in its library, then validate_only goes (a read)', async () => {
    h.answers.push(json({ data: [{ hash: HASH, status: 'ACTIVE' }] }), json({ success: true }))
    const answer = await metaWriteCall({ connectionId: 'm-1', operation: 'creative.create.check', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(creative()))), check: true })
    expect(answer.ok).toBe(true)
    expect(h.calls).toHaveLength(2)
    expect(sent(0).method).toBe('GET')
    expect(sent(0).url.pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${ACT}/adimages`)
    expect(sent(0).url.searchParams.get('hashes')).toBe(JSON.stringify([HASH]))
    expect(sent(1).method).toBe('POST')
    expect(sent(1).url.pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${ACT}/adcreatives`)
    expect(new URLSearchParams(sent(1).body!).get('execution_options')).toBe('["validate_only"]')
  })

  it('nothing is sent when the identity Page is not the chosen one, an image is not in the library, or the act is another account', async () => {
    const other = creative({ object_story_spec: { page_id: '120000000000099', link_data: { link: 'https://www.example.com/', image_hash: HASH } } })
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(other))) })).rejects.toThrow(/Page 120000000000099 is not the one this business chose/)
    h.answers.push(json({ data: [] }))
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(creative()))) })).rejects.toThrow(/image abc123def456 is not one Nexus can confirm/)
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(creative()))) })).rejects.toThrow(/not the one this business chose/)
    expect(h.calls.filter((c) => c.init.method === 'POST')).toHaveLength(0)
  })

  it('a partnership ad: the partner beside the chosen Page; never the chosen Page itself, never another Nexus business\'s', async () => {
    const brand = (sponsor: string) => creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', message: 'Insieme' } }, facebook_branded_content: { sponsor_page_id: sponsor } })
    await metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(brand('120000000000555')))) })
    expect(h.calls.at(-1)!.init.method).toBe('POST')
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(brand(PAGE)))) })).rejects.toThrow(/business's own chosen Page/)
    gatewayMetaTakenLinks.add('PAGE:120000000000555')
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(brand('120000000000555')))) })).rejects.toThrow(/another business in Nexus uses/)
    // The creator as main identity: the creator's Page runs it only with the chosen Page as its sponsor.
    gatewayMetaTakenLinks.clear()
    const creator = creative({ object_story_spec: { page_id: '120000000000555', link_data: { link: 'https://www.example.com/', message: 'Insieme' } }, facebook_branded_content: { sponsor_page_id: PAGE } })
    await metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(creator))) })
    expect(h.calls.at(-1)!.init.method).toBe('POST')
    const noSponsor = creative({ object_story_spec: { page_id: '120000000000555', link_data: { link: 'https://www.example.com/', message: 'Insieme' } }, facebook_branded_content: { sponsor_page_id: '120000000000556' } })
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(noSponsor))) })).rejects.toThrow(/runs a partnership ad only with the chosen one as its sponsor/)
  })

  it('a post, an Instant Experience and a lead form must be the chosen Page\'s', async () => {
    const post = (id: string) => ({ ...postSilent(), name: 'From a post', object_story_id: id })
    await metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(post(`${PAGE}_500000000000001`)))) })
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(post('120000000000099_500000000000001')))) })).rejects.toThrow(/not a post of the Page this business chose/)
    const form1 = withStory({ link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '120000000000777' } } } })
    h.calls = []
    h.answers.push(json({ data: [{ hash: HASH }] }), json({ id: '120000000000777', page: { id: '120000000000099' } }))
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(form1))) })).rejects.toThrow(/lead form 120000000000777 is not one Nexus can confirm/)
    expect(h.calls.filter((c) => c.init.method === 'POST')).toHaveLength(0)
  })

  it('a creative\'s name, labels and status change on the creative itself — its kind and account confirmed first; a delete by its own rule', async () => {
    h.answers.push(json({ account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE' }), json({ success: true }))
    await metaWriteCall({ connectionId: 'm-1', operation: 'creative.update', objectId: CREATIVE, objectKind: 'creative', params: { name: 'Creativo B — €', adlabels: JSON.stringify([{ name: 'Primavera' }]) } })
    expect(sent(0).url.searchParams.get('fields')).toBe('account_id,object_type,status')
    expect(sent(1).method).toBe('POST')
    expect(new URLSearchParams(sent(1).body!).get('name')).toBe('Creativo B — €')
    expect(problem({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative', body: new URLSearchParams({ status: 'DELETED' }).toString() })).toMatch(/DELETED is a delete/)
    expect(problem({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative', body: new URLSearchParams({ object_story_spec: '{}' }).toString() })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative', body: new URLSearchParams({ adlabels: '[{"name":"a"} ]' }).toString() })).toMatch(/one spelling/)
    // Another account's creative: nothing sent.
    h.calls = []
    h.answers.push(json({ account_id: '5555555555', object_type: 'SHARE', status: 'ACTIVE' }))
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.update', objectId: CREATIVE, objectKind: 'creative', params: { name: 'X' } })).rejects.toThrow(/not of the Meta ad account/)
    expect(h.calls).toHaveLength(1)
    // The delete: no body, the creative's kind confirmed.
    h.calls = []
    h.answers.push(json({ account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE' }), json({ success: true }))
    await metaWriteCall({ connectionId: 'm-1', operation: 'creative.remove', objectId: '120000000000302', objectKind: 'creative', params: {}, method: 'DELETE' })
    expect(sent(1).method).toBe('DELETE')
    expect(sent(1).body || '').toBe('')
    const del = metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${CREATIVE}`, kind: 'write', objectKind: 'creative', body: 'name=x' })
    expect('problem' in del).toBe(true)
    // A campaign named as a creative is not one (kind confirmed by Meta's own fields).
    h.calls = []
    h.answers.push(json({ error: { message: '(#100) Tried accessing nonexisting field (object_type)', code: 100 } }, 400))
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.remove', objectId: '120000000000303', objectKind: 'creative', params: {}, method: 'DELETE' })).rejects.toThrow(/not a creative Nexus can confirm/)
  })

  it('the async job: the same creative judged inside creative_spec, notification OFF only, no address to call back', () => {
    const spec = JSON.stringify(creative())
    expect(problem({ url: `${BASE}/${ACT}/asyncadcreatives`, body: new URLSearchParams({ name: 'Job A', creative_spec: spec, notification_mode: 'OFF' }).toString() })).toBeNull()
    expect(problem({ url: `${BASE}/${ACT}/asyncadcreatives`, body: new URLSearchParams({ name: 'Job A', creative_spec: spec, notification_uri: 'https://www.example.com/hook' }).toString() })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/asyncadcreatives`, body: new URLSearchParams({ name: 'Job A', creative_spec: spec, notification_mode: 'ON_COMPLETE' }).toString() })).toMatch(/OFF/)
    const bad = JSON.stringify(creative({ authorization_category: 'POLITICAL' }))
    expect(problem({ url: `${BASE}/${ACT}/asyncadcreatives`, body: new URLSearchParams({ name: 'Job A', creative_spec: bad }).toString() })).toMatch(/creative_spec.authorization_category/)
    expect(problem({ url: `${BASE}/${ACT}/asyncadcreatives`, body: new URLSearchParams({ name: 'Job A', creative_spec: spec, execution_options: '["validate_only"]' }).toString(), kind: 'read' })).toMatch(/only Meta change/)
  })

  it('an upload is still never checked (step 23 unchanged)', async () => {
    gatewayMetaChosen['m-1'] = '1234567890'
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'media.imageUpload', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }, check: true })).rejects.toThrow(/only Meta change|no check/)
  })
})

describe('review round 1', () => {
  it('A2 — one Instagram account: the story\'s and the top level\'s must be the same (adcreatives and the async job)', () => {
    const two = creative({ instagram_user_id: '17841499999999999' })
    expect(problem({ body: form(two) })).toMatch(/ONE Instagram account/)
    expect(problem({ body: form(creative({ instagram_user_id: IG })) })).toBeNull()
    expect(problem({ url: `${BASE}/${ACT}/asyncadcreatives`, body: new URLSearchParams({ name: 'Job A', creative_spec: JSON.stringify(two) }).toString() })).toMatch(/ONE Instagram account/)
  })

  it('A5 — an Instant Experience link only in Meta\'s one form', () => {
    const at = (link: string) => withStory({ link_data: { link, image_hash: HASH } })
    expect(problem({ body: form(at('https://fb.com/canvas_doc/120000000000901')) })).toBeNull()
    for (const link of ['https://fb.com/canvas_doc/120000000000901/', 'https://www.facebook.com/canvas_doc/120000000000901', 'https://fb.com/canvas_doc/120000000000901?x=1', 'https://www.fb.com/canvas_doc/120000000000901', 'https://fb.com/xcanvas_doc/120000000000901']) {
      expect(problem({ body: form(at(link)) }), link).toMatch(/exactly https:\/\/fb\.com\/canvas_doc/)
    }
    // A canvas link in any link key is checked as the creative's Instant Experience.
    const cta = withStory({ link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'LEARN_MORE', value: { link: 'https://fb.com/canvas_doc/120000000000902' } } } })
    const judged = judgeCreativeForm(new URLSearchParams(form(cta)) as unknown as Map<string, string>)
    expect((judged as { assets: Array<{ kind: string; id: string }> }).assets).toEqual(expect.arrayContaining([{ id: '120000000000902', kind: 'canvas' }]))
  })

  it('B1 — promo codes: the sources always named (never Meta\'s automatic ones), one manual code, no offer text', () => {
    const promo = (p: unknown) => creative({ asset_feed_spec: { audios: [], promotional_metadata: p } })
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['SPRING_10'] })) })).toBeNull()
    expect(problem({ body: form(promo({ manual_coupon_codes: ['SPRING_10'] })) })).toMatch(/promotional_metadata names allowed_coupon_code_sources/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['manual'] })) })).toMatch(/AD_CREATIVE_PRIMARY_TEXT/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['A', 'B'] })) })).toMatch(/1 to 1 entries/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['X'] })) })).toMatch(/2 to 50 letters/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['10% OFF'] })) })).toMatch(/2 to 50 letters/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_PRIMARY_TEXT'], offer_details: 'x' })) })).toMatch(/offer_details/)
  })

  it('B3 / B4 — feature customizations only where Meta documents them; values with no Meta source are refused', () => {
    const tuned = creative()
    ;(tuned.degrees_of_freedom_spec.creative_features_spec as Record<string, unknown>).adapt_to_placement = { enroll_status: 'OPT_IN', customizations: { aspect_ratio_config: { ar_9_16: { adapt: { enroll_status: 'OPT_OUT' } } } } }
    expect(problem({ body: form(tuned) })).toBeNull()
    const video = creative()
    ;(video.degrees_of_freedom_spec.creative_features_spec as Record<string, unknown>).media_type_automation = { enroll_status: 'OPT_IN', customizations: { video_crop_style: 'AUTO' } }
    expect(problem({ body: form(video) })).toMatch(/media_type_automation.customizations is not a key/)
    const meta = creative()
    ;(meta.degrees_of_freedom_spec.creative_features_spec as Record<string, unknown>).product_extensions = { enroll_status: 'OPT_IN', action_metadata: { type: 'MANUAL' } }
    expect(problem({ body: form(meta) })).toMatch(/product_extensions.action_metadata is not a key/)
    expect(problem({ body: form(creative({ contextual_multi_ads: { enroll_status: 'OPT_OUT', action_metadata: { type: 'DEFAULT' } } })) })).toMatch(/action_metadata is not a key/)
    const cta = (type: string) => creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type, value: { link: 'https://www.example.com/' } } } } })
    expect(problem({ body: form(cta('BUY_ACTIVITY_TICKETS')) })).toMatch(/is one of/)
    expect(problem({ body: form(cta('STREAM_NOW')) })).toMatch(/is one of/)
    expect(problem({ body: form(withStory({ photo_data: { image_hash: HASH, branded_content_sponsor_relationship: 'x' } })) })).toMatch(/branded_content_sponsor_relationship is not a key/)
  })

  it('B5 / B6 — a shop destination and a Threads id are answered in Meta\'s own terms', () => {
    expect(problem({ body: form(creative({ destination_spec: { destination_type: 'WEBSITE_AND_SHOP' } })) })).toMatch(/WEBSITE_AND_SHOP_OPT_OUT/)
    expect(problem({ body: form(creative({ asset_feed_spec: { audios: [], onsite_destinations: [{ storefront_shop_id: '1' }] } })) })).toMatch(/cannot confirm a Facebook or Instagram shop/)
    expect(problem({ body: form(creative({ threads_user_id: '123' })) })).toMatch(/Threads ads on the Instagram account/)
  })
})

describe('review round 2', () => {
  const web = { link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/' } } } }
  /** The creative WITHOUT the website keys (destination_spec, format_transformation_spec) — what the probes sent. */
  const bare = (c: Record<string, any>) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'destination_spec' && k !== 'format_transformation_spec'))

  it('1 — a website destination anywhere needs the website keys, whatever other markers say; a contradicting marker is refused', () => {
    const cases: Array<[string, Record<string, any>]> = [
      ['control', withStory(web)],
      ['object_type EVENT', withStory(web, { object_type: 'EVENT' })],
      ['WhatsApp number', withStory({ ...web, whats_app_business_phone_number: '+15555550100' })],
      ['marketing message', withStory(web, { marketing_message_structured_spec: { language: 'it_IT' } })],
      ['message extensions', withStory(web, { asset_feed_spec: { audios: [], message_extensions: [{ type: 'MESSAGE_PAGE' }] } })],
      ['welcome message', withStory({ link_data: { ...web.link_data, page_welcome_message: 'Ciao' } })],
      ['layer CALL_NOW', withStory({ link_data: { ...web.link_data, image_layer_specs: [{ layer_type: 'text_overlay', content: { type: 'CALL_NOW' } }] } })],
      ['layer VISIT_PROFILE', withStory({ link_data: { ...web.link_data, image_layer_specs: [{ layer_type: 'text_overlay', content: { type: 'VISIT_PROFILE' } }] } })],
      ['card CALL_NOW', withStory({ link_data: { link: 'https://www.example.com/', child_attachments: [{ link: 'https://www.example.com/1', image_hash: HASH }, { link: 'https://www.example.com/2', image_hash: HASH, call_to_action: { type: 'CALL_NOW', value: { link: 'tel:+15555550100' } } }] } })],
      ['video product_link only', withStory({ video_data: { video_id: '120000000000444', image_hash: HASH, call_to_action: { type: 'SHOP_NOW', value: { product_link: 'https://www.example.com/p1' } } } })],
    ]
    for (const [label, c] of cases) {
      expect(silentKeysFor(c).destination, label).toBe(true)
      expect(problem({ body: form(bare(c)) }), label).not.toBeNull()
    }
    // The stray markers of another type are refused even with the website keys; the plain ones pass with them.
    for (const label of ['object_type EVENT', 'WhatsApp number', 'marketing message', 'message extensions', 'welcome message', 'card CALL_NOW']) {
      expect(problem({ body: form(cases.find(([l]) => l === label)![1]) }), label).toMatch(/main button makes it a standard creative/)
    }
    for (const label of ['control', 'layer CALL_NOW', 'layer VISIT_PROFILE', 'video product_link only']) {
      expect(problem({ body: form(cases.find(([l]) => l === label)![1]) }), label).toBeNull()
    }
    // The type comes from the main button and the feed's optimization_type only.
    expect(creativeTypeOf(withStory({ link_data: { ...web.link_data, page_welcome_message: 'Ciao' } }))).toBe('standard')
    expect(creativeTypeOf(withStory({ link_data: { link: 'https://www.example.com/', call_to_action: { type: 'LEARN_MORE', value: { app_destination: 'MESSENGER' } } } }))).toBe('messaging')
    // A messaging creative with an https link carries the website keys too (asking for more fails safe: Meta checks first).
    const ctm = withStory({ link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }, page_welcome_message: 'Ciao' } })
    expect(problem({ body: form(ctm) })).toBeNull()
    expect(problem({ body: form(bare(ctm)) })).not.toBeNull()
    // A catalog marker needs all six formats.
    const catalog = withStory({ template_data: { message: '{{product.name}}', link: 'https://www.example.com/' } })
    expect(silentKeysFor(catalog).formats).toEqual(META_FORMAT_AUTOMATION_FORMATS)
    expect(problem({ body: form(catalog) })).toBeNull()
    expect(problem({ body: form({ ...catalog, format_transformation_spec: META_NON_CATALOG_FORMATS.map((format) => ({ format, data_source: ['none'] })) }) })).toMatch(/each of da_collection/)
    // No website destination, no catalog part: no format or shop key (an Instant Experience, a photo post).
    const ix = withStory({ link_data: { link: 'https://fb.com/canvas_doc/120000000000901', image_hash: HASH } })
    expect(silentKeysFor(ix)).toMatchObject({ formats: null, destination: false })
    // Round 3 — an extra opt-out is accepted anywhere.
    expect(problem({ body: form({ ...ix, destination_spec: { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' } }) })).toBeNull()
    // An existing post: no asset feed unless music; with a website button, the website keys.
    const post = { ...postSilent(), name: 'From a post', object_story_id: `${PAGE}_500000000000001` }
    expect(problem({ body: form(post) })).toBeNull()
    expect(problem({ body: form({ ...post, asset_feed_spec: { audios: [] } }) })).toMatch(/only for music asked/)
    const postWeb = { ...post, call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/' } } }
    expect(problem({ body: form(postWeb) })).toMatch(/website destination or a catalog part names format_transformation_spec|names format_transformation_spec/)
    expect(problem({ body: form(complete(postWeb)) })).toBeNull()
  })

  it('2 — product tags said on every image creative (single, carousel, feed images); card order said on every carousel', () => {
    const carousel = withStory({ link_data: { link: 'https://www.example.com/', child_attachments: [{ link: 'https://www.example.com/1', image_hash: HASH }, { link: 'https://www.example.com/2', image_hash: HASH }] } })
    expect(silentKeysFor(carousel).productTags).toBe(true)
    expect(problem({ body: form(carousel) })).toBeNull()
    expect(problem({ body: form(Object.fromEntries(Object.entries(carousel).filter(([k]) => k !== 'interactive_components_spec'))) })).toMatch(/product_tag enroll_status/)
    const unordered = { ...carousel, object_story_spec: { ...carousel.object_story_spec, link_data: Object.fromEntries(Object.entries(carousel.object_story_spec.link_data).filter(([k]) => k !== 'multi_share_optimized')) } }
    expect(problem({ body: form(unordered) })).toMatch(/multi_share_optimized/)
    const feedImages = creative({ object_story_spec: { page_id: PAGE }, asset_feed_spec: { audios: [], images: [{ hash: HASH }], bodies: [{ text: 'Uno' }], link_urls: [{ website_url: 'https://www.example.com/' }], call_to_action_types: ['SHOP_NOW'], ad_formats: ['SINGLE_IMAGE'] } })
    expect(silentKeysFor(feedImages).productTags).toBe(true)
    expect(problem({ body: form(Object.fromEntries(Object.entries(feedImages).filter(([k]) => k !== 'interactive_components_spec'))) })).toMatch(/product_tag enroll_status/)
    expect(problem({ body: form({ ...feedImages, asset_feed_spec: { ...feedImages.asset_feed_spec, carousels: [{ child_attachments: [{ image_label: { name: 'a' } }, { image_label: { name: 'b' } }] }] } }) })).toMatch(/every asset-feed carousel names multi_share_optimized/)
    // An explicit opt-in is said too; a component without its enroll_status is refused.
    expect(problem({ body: form({ ...carousel, interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_in' }] } }) })).toBeNull()
    expect(problem({ body: form({ ...carousel, interactive_components_spec: { components: [{ type: 'product_tag' }] } }) })).toMatch(/names enroll_status/)
    // Round 3 — fail-safe: a video's thumbnail counts as an image too.
    expect(silentKeysFor(withStory({ video_data: { video_id: '120000000000444', image_hash: HASH } })).productTags).toBe(true)
  })

  it('4 — every OPT_IN inside the parts is named; a customization under a feature switched off is refused', () => {
    const layers = withStory({ template_data: { message: 'x', link: 'https://www.example.com/', image_layer_specs: [{ layer_type: 'frame_overlay', frame_auto_show_enroll_status: 'OPT_IN', content: { type: 'price', auto_show_enroll_status: 'OPT_IN' } }] } }, { media_sourcing_spec: { related_media: { opt_in_status: 'OPT_IN' } } })
    const named = partsOptIns(layers).join(' | ')
    expect(named).toMatch(/object_story_spec\.template_data\.image_layer_specs\[0\]\.frame_auto_show_enroll_status OPT_IN/)
    expect(named).toMatch(/image_layer_specs\[0\]\.content\.auto_show_enroll_status OPT_IN/)
    expect(named).toMatch(/media_sourcing_spec\.related_media\.opt_in_status OPT_IN/)
    const tuned = creative()
    ;(tuned.degrees_of_freedom_spec.creative_features_spec as Record<string, unknown>).text_optimizations = { enroll_status: 'OPT_IN', customizations: { text_extraction: { enroll_status: 'OPT_IN' } } }
    expect(partsOptIns(tuned).join(' ')).toMatch(/text_optimizations\.customizations\.text_extraction\.enroll_status OPT_IN/)
    expect(partsOptIns(tuned).join(' ')).not.toMatch(/creative_features_spec\.text_optimizations\.enroll_status/)
    const off = creative()
    ;(off.degrees_of_freedom_spec.creative_features_spec as Record<string, unknown>).adapt_to_placement = { enroll_status: 'OPT_OUT', customizations: { aspect_ratio_config: { ar_9_16: { adapt: { enroll_status: 'OPT_IN' } } } } }
    expect(problem({ body: form(off) })).toMatch(/customizations go only with adapt_to_placement switched on/)
  })

  it('5 — a %-encoded fb.com / facebook.com link is refused (it could hide a canvas_doc path)', () => {
    for (const link of ['https://fb.com/%63anvas_doc/120000000000901', 'https://www.facebook.com/c%61nvas_doc/120000000000901', 'https://www.facebook.com/shop%2Fa']) {
      expect(problem({ body: form(withStory({ link_data: { link, image_hash: HASH } })) }), link).toMatch(/without %-encoding/)
    }
  })

  it('6 — promo codes: two letters at least, each source once, the manual source with its code and only then', () => {
    const promo = (p: unknown) => creative({ asset_feed_spec: { audios: [], promotional_metadata: p } })
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['10'] })) })).toMatch(/at least two letters/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['_-'] })) })).toMatch(/at least two letters/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_PRIMARY_TEXT', 'AD_CREATIVE_PRIMARY_TEXT'] })) })).toMatch(/each source once/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_MANUAL_COUPON_CODES'] })) })).toMatch(/goes with its code/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_PRIMARY_TEXT'], manual_coupon_codes: ['SPRING10'] })) })).toMatch(/goes only with the source AD_CREATIVE_MANUAL_COUPON_CODES/)
    expect(problem({ body: form(promo({ allowed_coupon_code_sources: ['AD_CREATIVE_PRIMARY_TEXT', 'AD_CREATIVE_MANUAL_COUPON_CODES'], manual_coupon_codes: ['SPRING10'] })) })).toBeNull()
  })
})

describe('review round 3', () => {
  const FORMATS_NONE = (formats: readonly string[]) => formats.map((format) => ({ format, data_source: ['none'] }))
  const SHOP_OFF = { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' }

  it('1 — the gateway requires the minimum and accepts every extra opt-out; a format switched on only where documented', () => {
    expect(problem({ body: form(creative({ format_transformation_spec: FORMATS_NONE(META_FORMAT_AUTOMATION_FORMATS) })) })).toBeNull()
    const post = { ...postSilent(), name: 'From a post', object_story_id: `${PAGE}_500000000000001` }
    expect(problem({ body: form({ ...post, format_transformation_spec: FORMATS_NONE(META_NON_CATALOG_FORMATS), destination_spec: SHOP_OFF }) })).toBeNull()
    expect(problem({ body: form(withStory({ photo_data: { image_hash: HASH } }, { destination_spec: SHOP_OFF, format_transformation_spec: FORMATS_NONE(META_NON_CATALOG_FORMATS) })) })).toBeNull()
    // Still required where it is the minimum; a catalog format switched ON on a website creative is not documented there.
    expect(problem({ body: form(creative({ format_transformation_spec: FORMATS_NONE(['carousel']) })) })).toMatch(/missing: sa_collection/)
    expect(problem({ body: form(creative({ format_transformation_spec: [...FORMATS_NONE(META_NON_CATALOG_FORMATS), { format: 'da_collection', data_source: ['catalog'] }] })) })).toMatch(/da_collection is switched on only where Meta documents it/)
    expect(problem({ body: form(creative({ format_transformation_spec: [...FORMATS_NONE(META_NON_CATALOG_FORMATS), { format: 'carousel', data_source: ['none'] }] })) })).toMatch(/each format once/)
  })

  it('2 — product tags required wherever an image can show: any image key at any depth, or any link_data', () => {
    const rules = withStory({ video_data: { video_id: '120000000000444', image_hash: HASH, call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/' } }, customization_rules_spec: [{ customization_spec: { language: 'it_IT' }, image_hash: HASH }] } })
    expect(silentKeysFor(rules).productTags).toBe(true)
    expect(problem({ body: form(Object.fromEntries(Object.entries(rules).filter(([k]) => k !== 'interactive_components_spec'))) })).toMatch(/product_tag enroll_status/)
    const noImage = withStory({ link_data: { link: 'https://www.example.com/', message: 'Senza immagine' } })
    expect(silentKeysFor(noImage).productTags).toBe(true)
    expect(problem({ body: form(noImage) })).toBeNull()
    expect(problem({ body: form(Object.fromEntries(Object.entries(noImage).filter(([k]) => k !== 'interactive_components_spec'))) })).toMatch(/product_tag enroll_status/)
  })

  it('3 — exactly one product_tag component', () => {
    expect(problem({ body: form(creative({ interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }, { type: 'product_tag', enroll_status: 'opt_in' }] } })) })).toMatch(/ONE product_tag component/)
  })

  it('4 — a reminder ad as Meta\'s guide writes it passes; Meta\'s own destinations are not website destinations', () => {
    // instagram/marketing-api/guides/reminder-ads.md: LEARN_MORE, the dummy link https://fb.com/, upcoming_events.
    const reminder = withStory({ instagram_user_id: IG, link_data: { call_to_action: { type: 'LEARN_MORE' }, image_hash: HASH, link: 'https://fb.com/' } }, { asset_feed_spec: { audios: [], upcoming_events: [{ event_id: '17900000000000001', event_title: 'Season Premiere', start_time: '2026-11-05T16:00:00+0000' }] } })
    expect(creativeTypeOf(reminder)).toBe('standard')
    expect(silentKeysFor(reminder)).toMatchObject({ formats: null, destination: false, productTags: true })
    expect(problem({ body: form(reminder) })).toBeNull()
    expect(problem({ body: form({ ...reminder, asset_feed_spec: { audios: [], upcoming_events: [{ event_id: '17900000000000001', start_time: 1762358400 }] } }) })).toMatch(/a time as Meta writes it/)
    for (const link of ['https://fb.com/messenger_doc/', 'https://m.me/shop_a', 'https://www.instagram.com/shop_a', 'https://wa.me/15555550100', 'https://api.whatsapp.com/send', 'https://www.facebook.com/shop_a']) {
      expect(silentKeysFor(withStory({ link_data: { link, image_hash: HASH } })).destination, link).toBe(false)
    }
    expect(silentKeysFor(withStory({ link_data: { link: 'https://www.example.com/', image_hash: HASH } })).destination).toBe(true)
  })
})

describe('step 25 review round 4 — Meta\'s link-redirect pages are websites, and refused as links', () => {
  const redirects = [
    'https://l.facebook.com/l.php?u=https://www.example.com/',
    'https://lm.facebook.com/l.php?u=https://www.example.com/',
    'https://www.facebook.com/l.php?u=https://www.example.com/',
    'https://www.facebook.com/flx/warn/?u=https://www.example.com/',
    'https://l.instagram.com/?u=https://www.example.com/',
    'https://l.messenger.com/l.php?u=https://www.example.com/',
    'https://www.facebook.com/shop_a?next=www.example.com',
  ]
  it('counts each as a website destination (the opt-outs are then required)', () => {
    for (const link of redirects) expect(silentKeysFor(withStory({ link_data: { link, image_hash: HASH } })).destination, link).toBe(true)
  })
  it('refuses each as a creative link', () => {
    for (const link of redirects) expect(problem({ body: form(withStory({ link_data: { link, image_hash: HASH } })) }), link).toMatch(/name the website itself/)
  })
})
