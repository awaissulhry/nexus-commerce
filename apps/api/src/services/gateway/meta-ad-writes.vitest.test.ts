/**
 * Meta on the gateway, step 27 (create-meta-ad, set-meta-ad): an ad reaches Meta ONLY as one of its exact allow-list entries
 * (meta-ad-rules.ts) — the create on the business's CHOSEN ad account with exact keys (every value judged, JSON in one
 * spelling, an inline creative judged by step 25's ONE creative judge), its check only as validate_only WITH Meta's
 * synchronous integrity review (the only check widened past validate_only), an ad never ACTIVE at once with a feature
 * generated with AI, every id inside the body the business's own (the ad set, an existing creative, the pixels); an ad's
 * update with its own keys only (a creative by its id; the schedule set or cleared); labels added on its labels edge; a DELETE
 * of an ad only by its own rule. A "message us" footer only inline on a website ad, never on the creative edge. Made-up ids.
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { isJsonCreativeKey, judgeCreativeForm, META_CREATIVE_FEATURES, silentKeysToSend } from './meta-creative-rules.js'
import { META_ACTIVATE_FEATURES, META_AD_CHECK, META_AD_CHECK_WITH_RECOMMENDATIONS, META_AD_REFUSED, metaActivationProblem, trackingPixels } from './meta-ad-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const ADSET = '120000000000002'
const AD = '120000000000003'
const CREATIVE = '120000000000301'
const PIXEL = '120000000000777'

/** An inline creative with the silent keys step 25's builder sends for it. */
const sealed = (c: Record<string, unknown>): Record<string, any> => {
  const want = silentKeysToSend(c)
  return {
    ...c,
    degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }])) },
    contextual_multi_ads: { enroll_status: 'OPT_OUT' },
    ...(want.formats ? { format_transformation_spec: want.formats.map((format) => ({ format, data_source: ['none'] })) } : {}),
    ...(want.destination ? { destination_spec: { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' } } : {}),
    ...(want.productTags ? { interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }] } } : {}),
  }
}
const web = { link_data: { link: 'https://www.example.com/shoes', message: 'Scarpe nuove 🎉', image_hash: 'abc123', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://www.example.com/shoes' } } } }
const inline = (over: Record<string, unknown> = {}, feed: Record<string, unknown> = {}) => sealed({ name: 'Creative A', object_story_spec: { page_id: PAGE, ...web }, asset_feed_spec: { ...feed, audios: [] }, ...over })
const ad = (over: Record<string, string> = {}) => ({ name: 'Ad A', adset_id: ADSET, creative: JSON.stringify({ creative_id: CREATIVE }), status: 'PAUSED', ...over })
const form = (params: Record<string, string>) => new URLSearchParams(params).toString()
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/ads`, kind: 'write', objectKind: 'adaccount', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => {
  const v = verdict(input)
  return 'problem' in v ? v.problem : null
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const posts = () => h.calls.filter((c) => c.init.method === 'POST' || c.init.method === 'DELETE')

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  gatewayMetaPage['m-1'] = PAGE
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('a new ad: exact keys, every value judged', () => {
  it('from an existing creative, PAUSED or ACTIVE; its ids are handed to the gateway (the ad set, the creative, the pixels)', () => {
    const v = verdict({ body: form(ad({ tracking_specs: JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]) })) })
    expect('write' in v && v.write).toMatchObject({ rule: 'adaccount.ad.create', objectId: ACT, check: false, edgeCall: true, ids: [{ id: ADSET, kind: 'adset' }, { id: CREATIVE, kind: 'creative' }, { id: PIXEL, kind: 'pixel' }] })
    // Review A1 — created ACTIVE, an existing creative goes to the gateway's activation read (its switches with its account_id).
    const active = verdict({ body: form(ad({ status: 'ACTIVE' })) })
    expect('write' in active && active.write.ids).toEqual([{ id: ADSET, kind: 'adset' }, { id: CREATIVE, kind: 'creative', activation: 'always' }])
    expect(problem({ body: form(ad({ status: 'ARCHIVED' })) })).toMatch(/PAUSED .* or ACTIVE/)
    expect(problem({ body: form({ name: 'Ad A', adset_id: ADSET, status: 'PAUSED' }) })).toMatch(/only Meta change Nexus sends/)
    expect(problem({ body: form(ad({ creative: JSON.stringify({ creative_id: Number(CREATIVE) }) })) })).toMatch(/creative_id/)
    expect(problem({ body: form(ad({ creative: `{ "creative_id": "${CREATIVE}" }` })) })).toMatch(/one spelling/)
    expect(problem({ body: form(ad({ name: 'Ad \u202Eevil' })) })).toMatch(/printable text/)
  })

  it('Meta\'s check only with its synchronous integrity review (the only check widened past validate_only), as a read', () => {
    for (const options of [META_AD_CHECK, META_AD_CHECK_WITH_RECOMMENDATIONS]) {
      const v = verdict({ kind: 'read', body: form(ad({ execution_options: options })) })
      expect('write' in v && v.write.check).toBe(true)
    }
    expect(problem({ kind: 'read', body: form(ad({ execution_options: '["validate_only"]' })) })).toMatch(/only execution_options Nexus sends on a new ad/)
    expect(problem({ kind: 'read', body: form(ad({ execution_options: '["synchronous_ad_review"]' })) })).toMatch(/only execution_options/)
    expect(problem({ kind: 'write', body: form(ad({ execution_options: META_AD_CHECK })) })).toMatch(/goes as a read/)
    // Not widened anywhere else: an ad's update has no check.
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${AD}`, kind: 'read', objectKind: 'ad', body: form({ name: 'B', execution_options: META_AD_CHECK }) })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
  })

  it('keys Meta takes that Nexus answers in words: an inline ad set (AD-025), a bid, an audience id, a source ad, SDK-only keys', () => {
    for (const key of Object.keys(META_AD_REFUSED)) expect(problem({ body: form(ad({ [key]: key === 'adset_spec' ? '{}' : '1' })) }), key).toBe(`${key}: ${META_AD_REFUSED[key]}`)
    expect(problem({ body: form(ad({ adset_spec: '{}' })) })).toMatch(/build the ad set first/)
  })

  it('an inline creative is judged by step 25\'s ONE judge: silent features named, the creative spec itself (not wrapped)', () => {
    expect(problem({ body: form(ad({ creative: JSON.stringify(inline()) })) })).toBeNull()
    const missing = inline()
    delete missing.contextual_multi_ads
    expect(problem({ body: form(ad({ creative: JSON.stringify(missing) })) })).toMatch(/contextual_multi_ads/)
    expect(problem({ body: form(ad({ creative: JSON.stringify({ creative: inline() }) })) })).toMatch(/not wrapped/)
    expect(problem({ body: form(ad({ creative: JSON.stringify(inline({ authorization_category: 'POLITICAL' })) })) })).toMatch(/political/)
    const v = verdict({ body: form(ad({ creative: JSON.stringify(inline()) })) })
    expect('write' in v && v.write.assets).toEqual(expect.arrayContaining([{ id: PAGE, kind: 'identitypage' }, { id: 'abc123', kind: 'adimage' }]))
  })

  it('CR-211 / CR-464 / CR-471 (step 25b): an inline creative\'s product set goes to the gateway as a body id — step 18\'s catalog rule, one memo per call', () => {
    const template = { link: 'https://www.example.com/', message: '{{product.name}}', name: '{{product.name}}', call_to_action: { type: 'SHOP_NOW' } }
    const catalog = sealed({ name: 'Catalog A', object_story_spec: { page_id: PAGE, template_data: template }, product_set_id: '120000000000061', asset_feed_spec: { audios: [] } })
    const v = verdict({ body: form(ad({ creative: JSON.stringify(catalog) })) })
    expect('problem' in v ? v.problem : null).toBeNull()
    expect('write' in v && v.write.ids).toEqual(expect.arrayContaining([{ id: ADSET, kind: 'adset' }, { id: '120000000000061', kind: 'productset' }]))
    // Every format and the shop are opted out on a catalog creative (step 25b): one missing is refused.
    const bare = { ...catalog, format_transformation_spec: catalog.format_transformation_spec.slice(1) }
    expect(problem({ body: form(ad({ creative: JSON.stringify(bare) })) })).toMatch(/format_transformation_spec/)
  })

  it('CR-404, review A2: an inline creative is created ACTIVE only when it opts into NO Advantage+ feature (each one refused; fully off allowed)', () => {
    // product_extensions goes ON only beside a catalog's product set (step 25b's productExtensionsProblem refuses it first).
    for (const feature of META_ACTIVATE_FEATURES.filter((f) => f !== 'product_extensions')) {
      const one = inline()
      one.degrees_of_freedom_spec.creative_features_spec[feature] = { enroll_status: 'OPT_IN' }
      expect(problem({ body: form(ad({ creative: JSON.stringify(one), status: 'ACTIVE' })) }), feature).toMatch(new RegExp(`switches on ${feature}: create it PAUSED, preview it, then switch it on with set-meta-status`))
      expect(problem({ body: form(ad({ creative: JSON.stringify(one), status: 'PAUSED' })) }), feature).toBeNull()
    }
    expect(problem({ body: form(ad({ creative: JSON.stringify(inline()), status: 'ACTIVE' })) })).toBeNull()
    expect(metaActivationProblem({ degrees_of_freedom_spec: { creative_features_spec: { image_touchups: { enroll_status: 'OPT_OUT' } } } })).toMatch(/does not say OPT_OUT/)
    expect(metaActivationProblem({})).toMatch(/reads no Advantage\+ feature switches/)
    expect(metaActivationProblem({ degrees_of_freedom_spec: { creative_features_spec: { ...Object.fromEntries(META_ACTIVATE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }])), some_new_feature: { enroll_status: 'OPT_IN' } } } })).toMatch(/some_new_feature/)
    // Fail closed: any value but exactly OPT_OUT counts as on (lower case, a missing status, an odd word).
    const allOut = Object.fromEntries(META_ACTIVATE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }]))
    for (const odd of [{ enroll_status: 'opt_in' }, {}, { enroll_status: 'DEFAULT' }]) {
      expect(metaActivationProblem({ degrees_of_freedom_spec: { creative_features_spec: { ...allOut, some_sdk_feature: odd } } })).toMatch(/some_sdk_feature/)
    }
  })

  it('CR-218: a "message us" footer inline on a website ad only — never with a messaging button, never on the creative edge', () => {
    expect(problem({ body: form(ad({ creative: JSON.stringify(inline({}, { message_extensions: [{ type: 'whatsapp' }] })) })) })).toBeNull()
    expect(problem({ body: form(ad({ creative: JSON.stringify(inline({}, { message_extensions: [{ type: 'telegram' }] })) })) })).toMatch(/message_extensions/)
    const messaging = sealed({ name: 'B', object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', image_hash: 'abc123', call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } } } }, asset_feed_spec: { message_extensions: [{ type: 'messenger' }], audios: [] } })
    expect(problem({ body: form(ad({ creative: JSON.stringify(messaging) })) })).toMatch(/only on a website ad/)
    // The creative edge answers error 3 for one: Nexus never sends it there (nor as an async job).
    const creativeForm = new URLSearchParams(Object.fromEntries(Object.entries(inline({}, { message_extensions: [{ type: 'whatsapp' }] })).map(([k, v]) => [k, isJsonCreativeKey(k) ? JSON.stringify(v) : String(v)]))).toString()
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/adcreatives`, kind: 'write', objectKind: 'adaccount', body: creativeForm })).toMatchObject({ problem: expect.stringMatching(/only inline on a new ad/) })
    expect('problem' in judgeCreativeForm(new Map(new URLSearchParams(creativeForm)))).toBe(false)
  })

  it('CR-425 / CR-426 / CR-427: a multi-media ad — up to 10 media, each with its source and related-media switch said, no duplicates', () => {
    const image = (hash: string, extra: Record<string, unknown> = {}) => ({ hash, source: 'multi_media', opt_in_status: 'opt_out', ...extra })
    const multi = (media: Record<string, unknown>) => JSON.stringify(inline({ media_sourcing_spec: media }))
    expect(problem({ body: form(ad({ creative: multi({ images: [image('abc123'), image('def456', { text_customizations: { titles: [{ text: 'Estate' }] }, destination_customizations: [{ url: 'https://www.example.com/estate', display_url: 'example.com/estate' }], placement_customizations: [{ publisher_platform: 'instagram', placement_exclusions: ['story'] }], image_crops: [{ type: 'manual', crop_spec: { '100x100': [[0, 0], [100, 100]] } }], creative_audience_pairing_persona: { age_min: 18, age_max: 34, genders: [1] } })], titles: [{ text: 'Saldi' }] }) })) })).toBeNull()
    expect(problem({ body: form(ad({ creative: multi({ images: [{ hash: 'abc123', source: 'multi_media' }] }) })) })).toMatch(/opt_in_status/)
    expect(problem({ body: form(ad({ creative: multi({ images: [image('abc123'), image('abc123')] }) })) })).toMatch(/each image hash and each video once/)
    expect(problem({ body: form(ad({ creative: multi({ images: Array.from({ length: 11 }, (_, i) => image(`h${i}`)) }) })) })).toMatch(/0 to 10 entries/)
    expect(problem({ body: form(ad({ creative: multi({ related_media: { opt_in_status: 'OPT_OUT' }, images: [image('abc123')] }) })) })).toMatch(/related_media never goes beside/)
    expect(problem({ body: form(ad({ creative: multi({ images: [image('abc123', { creative_audience_pairing_persona: { age_min: 13 } })] }) })) })).toMatch(/18 to 65/)
    // Review B6 — the primary media is listed too; each video names its original and a thumbnail.
    expect(problem({ body: form(ad({ creative: multi({ images: [image('def456')] }) })) })).toMatch(/names the primary image abc123/)
    const video = { video_id: '120000000000444', original_video_id: '120000000000444', source: 'multi_media', opt_in_status: 'opt_out', thumbnail_source: 'generated_default' }
    expect(problem({ body: form(ad({ creative: multi({ images: [image('abc123')], videos: [video] }) })) })).toBeNull()
    expect(problem({ body: form(ad({ creative: multi({ images: [image('abc123')], videos: [{ ...video, original_video_id: undefined }] }) })) })).toMatch(/original_video_id/)
    expect(problem({ body: form(ad({ creative: multi({ images: [image('abc123')], videos: [{ ...video, thumbnail_source: undefined }] }) })) })).toMatch(/thumbnail_url or thumbnail_source/)
  })

  it('tracking, conversion domain, schedule, flexible groups, persona, sequence and priority each judged', () => {
    expect(trackingPixels(JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]))).toEqual({ pixels: [PIXEL] })
    expect(trackingPixels(JSON.stringify([{ 'action.type': ['app_install'], application: ['1'] }]))).toMatchObject({ problem: expect.stringMatching(/own pixels only/) })
    expect(trackingPixels(JSON.stringify([{ 'action.type': ['offsite_conversion'], dataset: [PIXEL] }]))).toMatchObject({ problem: expect.stringMatching(/dataset goes with leadgen_quality_conversion/) })
    expect(problem({ body: form(ad({ conversion_domain: 'www.example.com' })) })).toMatch(/first and second level/)
    expect(problem({ body: form(ad({ conversion_domain: 'example.com' })) })).toBeNull()
    expect(problem({ body: form(ad({ conversion_domain: 'shop.example.com' })) })).toMatch(/first and second level/)
    expect(problem({ body: form(ad({ ad_schedule_start_time: '1893477600', ad_schedule_end_time: '1893474000' })) })).toMatch(/after ad_schedule_start_time/)
    expect(problem({ body: form(ad({ ad_schedule_end_time: '' })) })).toMatch(/UTC Unix seconds/)
    const groups = { groups: [{ images: [{ hash: 'abc123' }], texts: [{ text_type: 'headline', text: 'Saldi' }], call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/' } } }] }
    const v = verdict({ body: form(ad({ creative_asset_groups_spec: JSON.stringify(groups) })) })
    expect('write' in v && v.write.assets).toEqual([{ id: 'abc123', kind: 'adimage' }])
    expect(problem({ body: form(ad({ creative_asset_groups_spec: JSON.stringify({ groups: [{ texts: [{ text_type: 'headline', text: 'x' }] }] }) })) })).toMatch(/at least one image or video/)
    expect(problem({ body: form(ad({ creative_asset_groups_spec: JSON.stringify({ groups: [{ ...groups.groups[0] }, { ...groups.groups[0], call_to_action: { type: 'LEARN_MORE', value: { link: 'https://www.example.com/' } } }] }) })) })).toMatch(/ONE type/)
    expect(problem({ body: form(ad({ creative_audience_pairing_persona: '{"age_min":40,"age_max":30}' })) })).toMatch(/age_min is at most age_max/)
    expect(problem({ body: form(ad({ display_sequence: '2', priority: '1', engagement_audience: 'true' })) })).toBeNull()
    expect(problem({ body: form(ad({ engagement_audience: 'false' })) })).toMatch(/engagement_audience is true/)
  })
})

describe('an ad\'s update, labels and delete', () => {
  const upd = (params: Record<string, string>, extra: Partial<Parameters<typeof metaWriteVerdict>[0]> = {}) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${AD}`, kind: 'write', objectKind: 'ad', body: form(params), ...extra })
  it('POST /<ad id>: name, a creative by its id, labels, its own schedule set or cleared — never status (set-meta-status), never an inline creative', () => {
    expect(upd({ name: 'Ad B', creative: JSON.stringify({ creative_id: CREATIVE }) })).toMatchObject({ write: { rule: 'ad.update', objectId: AD, ids: [{ id: CREATIVE, kind: 'creative' }] } })
    expect(upd({ ad_schedule_end_time: '' })).toMatchObject({ write: { rule: 'ad.update' } })
    expect(upd({ ad_schedule_start_time: '1893477600' })).toMatchObject({ write: { rule: 'ad.update' } })
    // Review A1 — a swap's creative is read with the ad's status: onto an ACTIVE ad only one fully opted out.
    expect(upd({ creative: JSON.stringify({ creative_id: CREATIVE }) })).toMatchObject({ write: { ids: [{ id: CREATIVE, kind: 'creative', activation: 'if-ad-active' }] } })
    // Review B2 — tracking, the conversion domain and the persona change (or clear) on an update too; the pixels are checked.
    expect(upd({ tracking_specs: JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]) })).toMatchObject({ write: { rule: 'ad.update', ids: [{ id: PIXEL, kind: 'pixel' }] } })
    expect(upd({ tracking_specs: '', conversion_domain: '', creative_audience_pairing_persona: '' })).toMatchObject({ write: { rule: 'ad.update' } })
    expect(upd({ creative_audience_pairing_persona: '{"age_min":25}', conversion_domain: 'example.com' })).toMatchObject({ write: { rule: 'ad.update' } })
    // Review A4 — the longest body set-meta-ad's own input makes is taken (a 400-letter name, 50 labels of 100 letters).
    const big = upd({ name: '€'.repeat(400), adlabels: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ name: `${i}`.padEnd(100, '€') }))) })
    expect('write' in big).toBe(true)
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${AD}/adlabels`, kind: 'write', objectKind: 'ad', body: form({ adlabels: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ name: `${i}`.padEnd(100, '€') }))) }) })).toMatchObject({ write: { rule: 'ad.adlabels' } })
    expect(upd({ creative: JSON.stringify({ name: 'Creative B', object_story_spec: { page_id: PAGE } }) })).toMatchObject({ problem: expect.stringMatching(/changes by its id only/) })
    expect(upd({ name: 'Ad B', status: 'PAUSED' })).toMatchObject({ problem: expect.stringMatching(/only Meta change Nexus sends/) })
    expect(upd({ adset_id: ADSET })).toMatchObject({ problem: expect.stringMatching(/only Meta change Nexus sends/) })
    expect(upd({ name: 'Ad B' }, { objectKind: 'campaign' })).not.toMatchObject({ write: { rule: 'ad.update' } })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${AD}/adlabels`, kind: 'write', objectKind: 'ad', body: form({ adlabels: '[{"name":"Estate"}]' }) })).toMatchObject({ write: { rule: 'ad.adlabels' } })
  })

  it('create-meta-ad\'s undo deletes an ad by step 19\'s object.delete rule (no body); step 27 adds no DELETE rule of its own', () => {
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${AD}`, kind: 'write', objectKind: 'ad' })).toMatchObject({ write: { rule: 'object.delete', method: 'DELETE', body: '' } })
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${AD}`, kind: 'write', objectKind: 'ad', body: 'x=1' })).toMatchObject({ problem: expect.stringMatching(/Nexus deletes on Meta only/) })
  })
})

describe('on the network: the chosen account and every id inside', () => {
  const send = (params: Record<string, string>, check = false) => metaWriteCall({ connectionId: 'm-1', operation: 'ad.create', objectId: ACT, objectKind: 'adaccount', edge: 'ads', params, check, ...(check ? { adReview: true } : {}) })

  it('the ad set and the creative are the chosen account\'s, the pixel one of its own: then the ad goes; the check carries the integrity review', async () => {
    h.answers.push(
      json({ id: ADSET, account_id: '1234567890', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS' }),
      json({ id: CREATIVE, account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE' }),
      json({ data: [{ id: PIXEL }] }),
      json({ success: true }),
    )
    await send({ name: 'Ad A', adset_id: ADSET, creative: JSON.stringify({ creative_id: CREATIVE }), status: 'PAUSED', tracking_specs: JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]) }, true)
    expect(posts()).toHaveLength(1)
    const body = new URLSearchParams(String(posts()[0].init.body))
    expect(body.get('execution_options')).toBe(META_AD_CHECK)
    expect(posts()[0].url).toContain(`/${ACT}/ads?`)
  })

  it('review A1 (P2): created ACTIVE with an existing creative — its switches are read with its account_id; any opt-in or a feature not said: nothing is sent', async () => {
    const adSetRow = json({ id: ADSET, account_id: '1234567890', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' })
    const creativeRow = (spec: unknown) => json({ id: CREATIVE, account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE', ...(spec ? { degrees_of_freedom_spec: spec } : {}) })
    const allOff = (on: string[] = []) => ({ creative_features_spec: Object.fromEntries(META_ACTIVATE_FEATURES.map((f) => [f, { enroll_status: on.includes(f) ? 'OPT_IN' : 'OPT_OUT' }])) })
    h.answers.push(adSetRow, creativeRow(allOff(['text_optimizations'])))
    await expect(send(ad({ status: 'ACTIVE' }))).rejects.toThrow(/an ACTIVE ad shows only a creative that switches on no Advantage\+ feature — creative 120000000000301 switches on text_optimizations/)
    h.answers.push(adSetRow, creativeRow({ creative_features_spec: { image_touchups: { enroll_status: 'OPT_OUT' } } }))
    await expect(send(ad({ status: 'ACTIVE' }))).rejects.toThrow(/does not say OPT_OUT/)
    h.answers.push(adSetRow, creativeRow(null))
    await expect(send(ad({ status: 'ACTIVE' }))).rejects.toThrow(/reads no Advantage\+ feature switches/)
    expect(posts()).toHaveLength(0)
    const read = h.calls.find((c) => c.url.includes(`/${CREATIVE}?`))!
    expect(new URL(read.url).searchParams.get('fields')).toBe('account_id,object_type,status,degrees_of_freedom_spec')
    h.answers.push(adSetRow, creativeRow(allOff()), json({ id: AD }))
    await send(ad({ status: 'ACTIVE' }))
    expect(posts()).toHaveLength(1)
  })

  it('review A1: a creative swap onto an ACTIVE ad is judged the same; onto a paused ad it is only checked to be the account\'s', async () => {
    const swap = () => metaWriteCall({ connectionId: 'm-1', operation: 'ad.update', objectId: AD, objectKind: 'ad', params: { creative: JSON.stringify({ creative_id: CREATIVE }) }, check: false })
    const adRow = json({ id: AD, account_id: '1234567890', adset_id: ADSET, creative: { id: '120000000000300' } })
    h.answers.push(adRow, json({ id: AD, status: 'ACTIVE' }), json({ id: CREATIVE, account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE', degrees_of_freedom_spec: { creative_features_spec: { image_uncrop: { enroll_status: 'OPT_IN' } } } }))
    await expect(swap()).rejects.toThrow(/switches on image_uncrop/)
    expect(posts()).toHaveLength(0)
    h.answers.push(adRow, json({ id: AD, status: 'PAUSED' }), json({ id: CREATIVE, account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE' }), json({ success: true }), json({ id: AD, status: 'PAUSED' }))
    await swap()
    expect(posts()).toHaveLength(1)
  })

  it('an ad set of another account, a creative Nexus cannot place, a pixel not of the account, another ad account: nothing is sent', async () => {
    h.answers.push(json({ id: ADSET, account_id: '9999999999', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' }))
    await expect(send(ad())).rejects.toThrow(/inside this change, object 120000000000002 is not of the Meta ad account/)
    h.answers.push(json({ id: ADSET, account_id: '1234567890', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' }), json({ error: { message: '(#100) Tried accessing nonexisting field (object_type)', code: 100 } }, 400))
    await expect(send(ad())).rejects.toThrow(/is not a creative Nexus can confirm/)
    h.answers.push(json({ id: ADSET, account_id: '1234567890', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' }), json({ id: CREATIVE, account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE' }), json({ data: [{ id: '120000000000111' }] }))
    await expect(send(ad({ tracking_specs: JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]) }))).rejects.toThrow(/pixel 120000000000777 is not one Nexus can confirm/)
    await expect(metaWriteCall({ connectionId: 'm-1', operation: 'ad.create', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'ads', params: ad(), check: false })).rejects.toThrow(/goes only to the Meta ad account this business chose/)
    expect(posts()).toHaveLength(0)
  })
})
