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
  judgeCreativeForm, META_AI_GENERATED_FEATURES, META_CREATIVE_FEATURES, META_FEATURES_GUIDE, META_FEATURES_OTHER, META_FEATURES_SPEC_REFERENCE,
  META_FORMAT_AUTOMATION_FORMATS, metaCreativeTextProblem,
} from './meta-creative-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PAGE = GATEWAY_META_PAGE
const IG = '17841400000000001'
const HASH = 'abc123def456'
const CREATIVE = '120000000000301'

/** Every silent key a creative must name, OFF. */
const silent = () => ({
  degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }])) },
  contextual_multi_ads: { enroll_status: 'OPT_OUT' },
  format_transformation_spec: META_FORMAT_AUTOMATION_FORMATS.map((format) => ({ format, data_source: ['none'] })),
  asset_feed_spec: { audios: [] as unknown[] },
  destination_spec: { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' },
})
/** A full image creative, as decoded keys. */
const creative = (over: Record<string, unknown> = {}) => ({
  name: 'Creative A',
  object_story_spec: { page_id: PAGE, instagram_user_id: IG, link_data: { link: 'https://www.example.com/shoes', message: 'Scarpe nuove — 20 € 🎉\nSolo oggi', name: 'Nuove scarpe', image_hash: HASH, call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/shoes' } } } },
  ...silent(),
  ...over,
})
const JSON_KEYS = new Set(['object_story_spec', 'asset_feed_spec', 'degrees_of_freedom_spec', 'contextual_multi_ads', 'format_transformation_spec', 'destination_spec', 'adlabels', 'call_to_action', 'facebook_branded_content', 'instagram_branded_content', 'interactive_components_spec', 'creative_sourcing_spec', 'branded_content', 'ad_disclaimer_spec', 'portrait_customizations', 'platform_customizations'])
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
    const call = creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'CALL_NOW', value: { link: 'tel:+15555550100' } } } } })
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
    expect(problem({ body: form(creative({ threads_user_id: '123' })) })).toMatch(/Threads ad runs through the business's Instagram/)
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
    const welcome = creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }, page_welcome_message: { type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text', text_format: { customer_action_type: 'ice_breakers', message: { text: 'Ciao {{user_first_name}}!', ice_breakers: [{ title: 'Taglie?', response: 'Dalla S alla XXL' }], quick_replies: [] } }, user_edit: false, surface: 'visual_editor_new' } } } })
    expect(problem({ body: form(welcome) })).toBeNull()
    const collection = creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://fb.com/canvas_doc/120000000000901', message: 'Scopri', image_hash: HASH, collection_thumbnails: ['1', '2', '3', '4'].map((n) => ({ element_id: `12000000000099${n}`, element_crops: { '100x100': [[0, 0], [100, 100]] } })) } } })
    expect(problem({ body: form(collection) })).toBeNull()
    const three = creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://fb.com/canvas_doc/120000000000901', image_hash: HASH, collection_thumbnails: ['1', '2', '3'].map((n) => ({ element_id: `12000000000099${n}` })) } } })
    expect(problem({ body: form(three) })).toMatch(/4 to 4/)
  })

  it('collects every id inside for the gateway\'s check (identity, images, videos, canvas and its elements, forms)', () => {
    const c = creative({ object_story_spec: { page_id: PAGE, instagram_user_id: IG, link_data: { link: 'https://fb.com/canvas_doc/120000000000901', image_hash: HASH, collection_thumbnails: ['1', '2', '3', '4'].map((n) => ({ element_id: `12000000000099${n}` })), call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '120000000000777' } } } } })
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
    const post = (id: string) => ({ ...silent(), name: 'From a post', object_story_id: id })
    await metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(post(`${PAGE}_500000000000001`)))) })
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(post('120000000000099_500000000000001')))) })).rejects.toThrow(/not a post of the Page this business chose/)
    const form1 = creative({ object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', image_hash: HASH, call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '120000000000777' } } } } })
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
