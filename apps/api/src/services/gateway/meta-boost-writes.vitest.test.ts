/**
 * Meta on the gateway, step 26 (create-meta-boost, set-meta-partnership-access): a boost reaches Meta ONLY through step 25's
 * one creative judge — exactly one existing-post source, every silent key, the business's own post / media / link, or a
 * creator's content that Meta's content discovery lists for the brand and no other Nexus business owns (the chosen Page and
 * Instagram account as its sponsors) — and a creator's ad code never reaches the ledger. The chosen Instagram account's
 * partnership calls go only to the chosen account (its media for an ad code), each creator never the chosen account and never
 * another Nexus business's, a Collab answer only for an invite it has pending. Review B1 (round 1): the chosen Page's
 * partnership permissions, branded-content allowlist and sponsor tags go to Meta's partnership host (api.facebook.com) with the
 * system-user token as Bearer, exactly as judged. Made-up ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
// Step 28's Page check (meta-optimize-owner.ts, kind `page`: the partnership host's writes) reads the PAGE link itself.
// Step 31's body-id rule (audience-ids.ts audienceIdProblem) judges a boost's `instagram` ids, with the test connection's
// chosen Page and Instagram account in place of its live connection read.
vi.mock('../marketing/meta-ads/audience-ids.js', async (importActual) => {
  const actual = await importActual<typeof import('../marketing/meta-ads/audience-ids.js')>()
  const stubs = await import('../../test-support/gateway-stubs.js')
  return {
    ...actual,
    metaAudienceIdProblem: async (connectionId: string, inner: Parameters<typeof actual.audienceIdProblem>[1]) =>
      actual.audienceIdProblem({ connectionId, adAccountId: '1234567890', pageId: stubs.gatewayMetaPage[connectionId] ?? null, instagramId: stubs.gatewayMetaInstagram[connectionId] ?? null } as never, inner),
  }
})
vi.mock('../../db.js', () => import('../../test-support/gateway-stubs.js').then((m) => ({
  default: { metaAccountLink: { findFirst: async ({ where }: { where: { connectionId: string; product: string } }) => (where.product === 'PAGE' && m.gatewayMetaPage[where.connectionId] ? { externalId: m.gatewayMetaPage[where.connectionId] } : null) } },
})))
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage, gatewayMetaPortfolio, gatewayMetaTakenLinks } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaRestWriteCall, metaWriteCall } from './meta.js'
import { metaSecretForms } from './gateway.js'
import { metaCallVerdict, metaWriteVerdict } from './meta-calls.js'
import { isExistingPostCreative, isJsonCreativeKey, judgeCreativeForm, META_CREATIVE_FEATURES, META_NON_CATALOG_FORMATS, silentKeysFor, silentKeysToSend } from './meta-creative-rules.js'
import { META_BOOST_WRITE_RULES, META_PARTNERSHIP_REST_HOST, metaPermissionBodyOf, metaRestWriteVerdict, metaUserIdsProblem } from './meta-boost-rules.js'
import { META_REST_HOST } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const IG = '17841400000000001'
const MEDIA = '17900000000000001'
const CREATOR_IG = '17841400000000099'
const CREATOR_PAGE = '120000000000555'
const CODE = 'AbC123xyz_Code-9'
const PORTFOLIO = '9876543210'

/** A creative with the silent keys the tool sends for it (step 25's silentKeysToSend). */
const sealed = (c: Record<string, unknown>): Record<string, any> => {
  const want = silentKeysToSend(c)
  return {
    degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, { enroll_status: 'OPT_OUT' }])) },
    contextual_multi_ads: { enroll_status: 'OPT_OUT' },
    ...(want.formats ? { format_transformation_spec: want.formats.map((format) => ({ format, data_source: ['none'] })) } : {}),
    ...(want.audios ? { asset_feed_spec: { audios: [] as unknown[] } } : {}),
    ...(want.destination ? { destination_spec: { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' } } : {}),
    ...(want.productTags ? { interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }] } } : {}),
    ...c,
  }
}
const ownPost = (over: Record<string, unknown> = {}) => sealed({ name: 'Boost A', object_story_id: `${PAGE}_500000000000001`, instagram_user_id: IG, ...over })
const ownMedia = (over: Record<string, unknown> = {}) => sealed({ name: 'Boost A', object_id: PAGE, instagram_user_id: IG, source_instagram_media_id: MEDIA, ...over })
const sponsors = { facebook_branded_content: { sponsor_page_id: PAGE }, instagram_branded_content: { sponsor_id: IG } }
const creatorMedia = (over: Record<string, unknown> = {}) => sealed({ name: 'Boost A', object_id: PAGE, source_instagram_media_id: MEDIA, ...sponsors, branded_content: { ad_format: 1 }, ...over })
const creatorCode = (over: Record<string, unknown> = {}) => sealed({ name: 'Boost A', object_id: PAGE, ...sponsors, branded_content: { instagram_boost_post_access_token: CODE, ad_format: 1 }, ...over })
const form = (c: Record<string, unknown>) => new URLSearchParams(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, isJsonCreativeKey(k) ? JSON.stringify(v) : String(v)]))).toString()
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/adcreatives`, kind: 'write', objectKind: 'adaccount', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => {
  const v = verdict(input)
  return 'problem' in v ? v.problem : null
}
const judged = (c: Record<string, unknown>) => judgeCreativeForm(new Map(Object.entries(Object.fromEntries(new URLSearchParams(form(c))))))
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const sendCreative = (c: Record<string, unknown>) => metaWriteCall({ connectionId: 'm-1', operation: 'creative.create', objectId: ACT, objectKind: 'adaccount', edge: 'adcreatives', params: Object.fromEntries(new URLSearchParams(form(c))) })
const posts = () => h.calls.filter((c) => c.init.method === 'POST' || c.init.method === 'DELETE')
/** Meta's content discovery answering one content of the creator. */
const discovery = (author: Record<string, string>, contentId = MEDIA, platform = 'INSTAGRAM') => json({ data: [{ content_id: contentId, platform, author }] })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  // Step 19 / 21 / 39's stubs: the chosen Page, Instagram account and portfolio of the test connection.
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  for (const key of Object.keys(gatewayMetaInstagram)) delete gatewayMetaInstagram[key]
  for (const key of Object.keys(gatewayMetaPortfolio)) delete gatewayMetaPortfolio[key]
  gatewayMetaPage['m-1'] = PAGE
  gatewayMetaInstagram['m-1'] = IG
  gatewayMetaPortfolio['m-1'] = PORTFOLIO
  gatewayMetaTakenLinks.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('a boost goes through step 25\'s ONE creative judge', () => {
  it('every existing-post source is an existing post: no music key needed, the shop and format opt-outs sent', () => {
    for (const c of [ownPost(), ownMedia(), creatorMedia(), creatorCode(), sealed({ name: 'B', object_id: PAGE, instagram_user_id: IG, instagram_permalink_url: 'https://www.instagram.com/p/AbCdEf12345/' })]) {
      expect(isExistingPostCreative(c)).toBe(true)
      expect(silentKeysFor(c).audios).toBe(false)
      expect(silentKeysToSend(c)).toMatchObject({ formats: META_NON_CATALOG_FORMATS, destination: true })
      expect(problem({ body: form(c) })).toBeNull()
    }
  })

  it('names exactly ONE source, and object_id only beside an Instagram source', () => {
    expect(problem({ body: form(ownMedia({ object_story_id: `${PAGE}_500000000000001` })) })).toMatch(/ONE source/)
    expect(problem({ body: form(Object.fromEntries(Object.entries(ownMedia()).filter(([k]) => k !== 'object_id'))) })).toMatch(/names object_id/)
    expect(problem({ body: form(ownPost({ object_id: PAGE })) })).toMatch(/object_id goes only with/)
    expect(problem({ body: form(Object.fromEntries(Object.entries(ownMedia()).filter(([k]) => k !== 'instagram_user_id'))) })).toMatch(/names instagram_user_id/)
    expect(problem({ body: form(ownMedia({ source_instagram_media_id: '17x' })) })).toMatch(/Meta id/)
    expect(problem({ body: form(sealed({ name: 'B', object_id: PAGE, instagram_user_id: IG, instagram_permalink_url: 'https://www.instagram.com/p/AbCdEf12345' })) })).toMatch(/Instagram post link as Meta writes it/)
    expect(problem({ body: form(sealed({ name: 'B', object_id: PAGE, instagram_user_id: IG, instagram_permalink_url: 'https://evil.example.org/p/AbCdEf12345/' })) })).toMatch(/Instagram post link/)
    // A partner on the business's own Instagram media is not a shape Meta documents for a boost.
    expect(problem({ body: form(ownMedia({ facebook_branded_content: { sponsor_page_id: CREATOR_PAGE } })) })).toMatch(/document no partner/)
  })

  it('an existing post\'s asset feed: music asked, or Meta\'s messaging / profile-visit destinations with music named', () => {
    expect(problem({ body: form(ownPost({ asset_feed_spec: { audios: [] } })) })).toMatch(/only for music asked/)
    expect(problem({ body: form(ownPost({ asset_feed_spec: { audios: [{ type: 'random' }] } })) })).toBeNull()
    expect(problem({ body: form(ownPost({ call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }, asset_feed_spec: { optimization_type: 'DOF_MESSAGING_DESTINATION', audios: [] } })) })).toBeNull()
    expect(problem({ body: form(ownPost({ asset_feed_spec: { optimization_type: 'DOF_MESSAGING_DESTINATION' } })) })).toMatch(/only for music asked/)
    expect(problem({ body: form(ownPost({ asset_feed_spec: { optimization_type: 'DOF_MESSAGING_DESTINATION', audios: [], bodies: [{ text: 'x' }] } })) })).toMatch(/only for music asked/)
    expect(problem({ body: form(ownPost({ asset_feed_spec: { optimization_type: 'REGULAR', audios: [{ type: 'random' }] } })) })).toMatch(/only for music asked/)
    const unified = ownMedia({ asset_feed_spec: { optimization_type: 'UNIFIED_PROFILE_VISIT_DESTINATION', audios: [], call_to_actions: [
      { type: 'VIEW_INSTAGRAM_PROFILE', value: { link: 'https://www.instagram.com/shop_a', app_link: 'instagram://user?username=shop_a' } },
      { type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${PAGE}` } },
    ] } })
    expect(problem({ body: form(unified) })).toBeNull()
  })

  it('a creator\'s content: the chosen Page and Instagram account are its sponsors, ad_format named, no instagram_user_id', () => {
    const c = judged(creatorMedia())
    expect('problem' in c ? c.problem : null).toBeNull()
    expect((c as { assets: Array<{ id: string; kind: string }> }).assets).toEqual(expect.arrayContaining([{ id: MEDIA, kind: 'partnercontent' }]))
    // The chosen Page (object_id, the sponsor Page) and Instagram account (the sponsor) are step 19's `page` and step 31's
    // `instagram` body ids.
    expect((c as { ids: Array<{ id: string; kind: string }> }).ids).toEqual([{ id: PAGE, kind: 'page' }, { id: IG, kind: 'instagram' }])
    expect(problem({ body: form(creatorMedia({ instagram_user_id: IG })) })).toMatch(/names no instagram_user_id/)
    expect(problem({ body: form(Object.fromEntries(Object.entries(creatorMedia()).filter(([k]) => !k.endsWith('_branded_content')))) })).toMatch(/business as its sponsor/)
    expect(problem({ body: form(creatorMedia({ branded_content: { ad_format: 4 } })) })).toMatch(/whole number from 1 to 3/)
    expect(problem({ body: form(creatorMedia({ branded_content: { ad_format: '1' } })) })).toMatch(/whole number/)
    // A creator's Facebook post by its id: the post is the creator's content (never "a post of the chosen Page").
    const fb = judged(sealed({ name: 'B', object_story_id: `${CREATOR_PAGE}_500000000000002`, ...sponsors, branded_content: { ad_format: 2 } }))
    expect((fb as { assets: Array<{ kind: string }> }).assets.map((a) => a.kind)).toEqual(['partnercontent'])
    expect((fb as { ids: Array<{ kind: string }> }).ids.map((a) => a.kind)).toEqual(['page', 'instagram'])
    // ad_format with new media is create-meta-creative's partner, not a boost.
    expect(problem({ body: form(sealed({ name: 'B', object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/', message: 'x' } }, ...sponsors, branded_content: { ad_format: 1 } })) })).toMatch(/ad_format goes with a creator's existing content/)
    // A creator's content by link is refused (only by id or ad code).
    expect(problem({ body: form(sealed({ name: 'B', object_id: PAGE, instagram_permalink_url: 'https://www.instagram.com/p/AbCdEf12345/', ...sponsors, branded_content: { ad_format: 1 } })) })).toMatch(/not by a link/)
  })

  it('a creator\'s ad code: with ad_format, one code, never quoted — and the body is marked secret for the ledger', () => {
    const v = verdict({ body: form(creatorCode()) })
    expect('write' in v && v.write.secrets).toEqual([CODE])
    expect('write' in v && v.write.assets).toEqual(expect.arrayContaining([{ id: CODE, kind: 'adcode', with: 'INSTAGRAM' }]))
    const fbCode = sealed({ name: 'B', ...sponsors, branded_content: { facebook_boost_post_access_token: CODE, ad_format: 1 } })
    expect(problem({ body: form(fbCode) })).toBeNull()
    expect(problem({ body: form({ ...fbCode, object_id: PAGE }) })).toMatch(/object_id goes only with/)
    expect(problem({ body: form(creatorCode({ branded_content: { instagram_boost_post_access_token: CODE } })) })).toMatch(/goes with branded_content.ad_format/)
    expect(problem({ body: form(creatorCode({ branded_content: { instagram_boost_post_access_token: CODE, facebook_boost_post_access_token: CODE, ad_format: 1 } })) })).toMatch(/ONE ad code/)
    const bad = problem({ body: form(creatorCode({ branded_content: { instagram_boost_post_access_token: 'secret code!', ad_format: 1 } })) })
    expect(bad).toMatch(/partnership ad code as the creator shared it/)
    expect(bad).not.toMatch(/secret code/)
    // A creative with no code is not secret.
    const plain = verdict({ body: form(ownPost()) })
    expect('write' in plain && plain.write.secrets).toBeFalsy()
    // An async job carrying a code is secret too.
    const job = metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/asyncadcreatives`, kind: 'write', objectKind: 'adaccount', body: new URLSearchParams({ name: 'Job A', creative_spec: JSON.stringify(creatorCode()) }).toString() })
    expect('write' in job && job.write.secrets).toEqual([CODE])
  })

  it('answers in words what is not a boost: a catalog intro card (lane C2\'s catalog follow-up), several partners', () => {
    expect(problem({ body: form(creatorMedia({ branded_content: { ad_format: 1, parent_source_instagram_media_id: MEDIA } })) })).toMatch(/catalog creative: it comes with lane C2's catalog follow-up/)
    expect(problem({ body: form(creatorMedia({ branded_content: { ad_format: 1, partners: [] } })) })).toMatch(/ONE partner/)
    expect(problem({ body: form(ownPost({ source_facebook_post_id: '500000000000001' })) })).toMatch(/create-meta-boost/)
  })
})

describe('a boost\'s ids are checked before anything is sent', () => {
  it('the business\'s own Instagram media: its owner is the chosen account, then the creative goes', async () => {
    h.answers.push(json({ id: MEDIA, owner: { id: IG } }), json({ id: '120000000000302' }))
    await sendCreative(ownMedia())
    expect(posts()).toHaveLength(1)
    h.calls = []
    h.answers.push(json({ id: MEDIA, owner: { id: '17841400000000777' } }))
    await expect(sendCreative(ownMedia())).rejects.toThrow(/Instagram media .* is not one Nexus can confirm/)
    expect(posts()).toHaveLength(0)
  })

  it('a creator\'s media: listed by Meta\'s content discovery for the chosen Page and Instagram account, by a creator no Nexus business uses', async () => {
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }), json({ id: '120000000000303' }))
    await sendCreative(creatorMedia())
    const lookup = new URL(h.calls[0].url)
    expect(lookup.pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${PORTFOLIO}/partnership-ads-advertisable-content`)
    expect(lookup.searchParams.get('content_ids')).toBe(JSON.stringify([MEDIA]))
    expect(lookup.searchParams.get('fb_page_id')).toBe(PAGE)
    expect(lookup.searchParams.get('ig_user_id')).toBe(IG)
    expect(posts()).toHaveLength(1)
    // The business's own content is not a creator's.
    h.calls = []
    h.answers.push(discovery({ ig_user_id: IG }))
    await expect(sendCreative(creatorMedia())).rejects.toThrow(/is the business's own/)
    // Another Nexus business's creator account: nothing sent.
    h.calls = []
    gatewayMetaTakenLinks.add(`INSTAGRAM:${CREATOR_IG}`)
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }))
    await expect(sendCreative(creatorMedia())).rejects.toThrow(/another business in Nexus uses/)
    // Not listed, or no author: nothing sent.
    gatewayMetaTakenLinks.clear()
    h.calls = []
    h.answers.push(json({ data: [] }))
    await expect(sendCreative(creatorMedia())).rejects.toThrow(/does not list content/)
    h.answers.push(json({ data: [{ content_id: MEDIA, platform: 'INSTAGRAM' }] }))
    await expect(sendCreative(creatorMedia())).rejects.toThrow(/names no author/)
    expect(posts()).toHaveLength(0)
    // The sponsors must be the chosen ones.
    await expect(sendCreative(creatorMedia({ facebook_branded_content: { sponsor_page_id: CREATOR_PAGE } }))).rejects.toThrow(/Page 120000000000555 is not the Facebook Page this business chose/)
  })

  it('a creator\'s Facebook post: its own Page part counts as its author too', async () => {
    const post = `${CREATOR_PAGE}_500000000000002`
    const c = sealed({ name: 'B', object_story_id: post, ...sponsors, branded_content: { ad_format: 1 } })
    gatewayMetaTakenLinks.add(`PAGE:${CREATOR_PAGE}`)
    h.answers.push(json({ data: [{ content_id: '500000000000002', platform: 'FACEBOOK', author: {} }] }))
    await expect(sendCreative(c)).rejects.toThrow(/by a Page another business in Nexus uses/)
    gatewayMetaTakenLinks.clear()
    h.answers.push(json({ data: [{ content_id: post, platform: 'FACEBOOK', author: { fb_page_id: CREATOR_PAGE } }] }), json({ id: '120000000000304' }))
    await sendCreative(c)
    expect(posts()).toHaveLength(1)
  })

  it('a creator\'s ad code: looked up once, never in a sentence, never in the ledger (not even on a failure)', async () => {
    h.answers.push(json({ data: [] }))
    const refused = await sendCreative(creatorCode()).catch((err: Error) => err.message)
    expect(refused).toMatch(/does not list the creator's ad code/)
    expect(refused).not.toContain(CODE)
    const lookup = new URL(h.calls[0].url)
    expect(lookup.searchParams.get('ad_codes')).toBe(JSON.stringify([CODE]))
    // The look-up reaches the ledger as its path only.
    expect(JSON.stringify(gatewayLedger)).not.toContain(CODE)
    // The wrong platform: refused.
    h.answers.push(discovery({ fb_page_id: CREATOR_PAGE }, '500000000000003', 'FACEBOOK'))
    await expect(sendCreative(creatorCode())).rejects.toThrow(/ad code is for Facebook content/)
    // Meta refuses the creative itself: the ledger keeps the body's length, never the body.
    gatewayLedger.length = 0
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }), json({ error: { message: 'Invalid parameter', code: 100 } }, 400))
    const answer = await sendCreative(creatorCode())
    expect(answer.ok).toBe(false)
    expect(JSON.stringify(gatewayLedger)).not.toContain(CODE)
    const row = gatewayLedger.find((r) => (r as { requestPayload?: unknown }).requestPayload) as { requestPayload?: Record<string, unknown> } | undefined
    expect(row?.requestPayload).toMatchObject({ __omitted: expect.stringMatching(/partnership ad code is never kept/) })
    // Meta's own words never carry it on: an answer that echoes the code (a look-up's or the change's) loses it.
    gatewayLedger.length = 0
    h.answers.push(json({ error: { message: `Invalid ad code ${CODE}`, code: 100 } }, 400))
    const echoed = await sendCreative(creatorCode()).catch((err: Error) => err.message)
    expect(String(echoed)).not.toContain(CODE)
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }), json({ error: { message: `The code ${CODE} expired`, code: 100 } }, 400))
    const failed = await sendCreative(creatorCode())
    expect(failed.text).not.toContain(CODE)
    expect(failed.verdict?.channelMessage ?? '').not.toContain(CODE)
    expect(JSON.stringify(gatewayLedger)).not.toContain(CODE)
  })

  it('a post link: only one of the chosen Instagram account\'s own media (its permalink)', async () => {
    const link = 'https://www.instagram.com/p/AbCdEf12345/'
    const c = sealed({ name: 'B', object_id: PAGE, instagram_user_id: IG, instagram_permalink_url: link })
    h.answers.push(json({ data: [{ id: MEDIA, permalink: link }] }), json({ id: '120000000000305' }))
    await sendCreative(c)
    expect(new URL(h.calls[0].url).pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${IG}/media`)
    expect(posts()).toHaveLength(1)
    h.calls = []
    h.answers.push(json({ data: [{ id: MEDIA, permalink: 'https://www.instagram.com/p/Other123456/' }] }))
    await expect(sendCreative(c)).rejects.toThrow(/is not a link to one of the chosen Instagram account's own media/)
    expect(posts()).toHaveLength(0)
  })
})

describe('round 1 — product tags, the app link\'s user id, every spelling of an ad code', () => {
  it('review B4 — every boost names the product-tag opt-out (Meta tags an existing post\'s images by itself); the gateway requires it', () => {
    for (const c of [ownPost(), ownMedia(), creatorMedia(), creatorCode()]) {
      expect(silentKeysFor(c).productTags).toBe(true)
      expect(c.interactive_components_spec).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_out' }] })
      const without = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'interactive_components_spec'))
      expect(problem({ body: form(without) })).toMatch(/product_tag enroll_status/)
    }
  })

  it('review B5 — the profile visit\'s app link names the chosen Instagram account\'s id (checked)', async () => {
    const both = (userid: string) => ownMedia({ asset_feed_spec: { optimization_type: 'UNIFIED_PROFILE_VISIT_DESTINATION', audios: [], call_to_actions: [
      { type: 'VIEW_INSTAGRAM_PROFILE', value: { link: 'https://www.instagram.com/shop_a', app_link: `instagram://user?username=shop_a&userid=${userid}` } },
      { type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${PAGE}` } },
    ] } })
    const judgedBoth = judged(both(IG))
    expect((judgedBoth as { ids: Array<{ id: string; kind: string }> }).ids).toEqual(expect.arrayContaining([{ id: IG, kind: 'instagram' }]))
    expect(problem({ body: form(both('17x')) })).toMatch(/instagram:\/\/user\?username/)
    h.answers.push(json({ id: MEDIA, owner: { id: IG } }))
    await expect(sendCreative(both('17841400000000777'))).rejects.toThrow(/Instagram account 17841400000000777 is not the Instagram account this business chose/)
  })

  it('review A4 — an ad code with / + = is cut out of Meta\'s answer in every spelling (as is, JSON-escaped, \\/, %-encoded)', async () => {
    const code = 'Ab/Cd+Ef=1234'
    const c = creatorCode({ branded_content: { instagram_boost_post_access_token: code, ad_format: 1 } })
    const echoes = [code, JSON.stringify(code).slice(1, -1).replace(/\//g, '\\/'), encodeURIComponent(code), new URLSearchParams({ s: code }).toString().slice(2)]
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }), () => new Response(`{"error":{"message":"bad ${echoes.join(' and ')}","code":100}}`, { status: 400 }))
    const answer = await sendCreative(c)
    expect(answer.ok).toBe(false)
    for (const e of echoes) expect(answer.text).not.toContain(e)
    expect(answer.text).toContain('[removed]')
    expect(JSON.stringify(gatewayLedger)).not.toContain('Cd+Ef')
    expect(JSON.stringify(gatewayLedger)).not.toContain('Cd%2BEf')
  })
})

describe('round 2 — no leading 0 in an id; no post without its creator; every spelling of a code', () => {
  it('an id never starts with 0 (`0<id>` is the same id to Meta): refused in every judge of this step', () => {
    const z = (id: string) => `0${id}`
    // The Page in the path, a partner in the body, a creator in a query.
    const perm = (page: string, partner: string) => metaRestWriteVerdict({ method: 'POST', url: `https://api.facebook.com/partnership-ads/fb-account-level-permissions/${page}`, kind: 'write', objectKind: 'page', body: metaPermissionBodyOf([{ pageId: partner, action: 'send-request' }]) })
    expect(perm(z(PAGE), CREATOR_PAGE)).toMatchObject({ problem: expect.stringMatching(/Nexus changes only/) })
    expect(perm(PAGE, z(PAGE))).toMatchObject({ problem: expect.stringMatching(/one spelling/) })
    expect(perm(PAGE, '0')).toMatchObject({ problem: expect.stringMatching(/one spelling/) })
    expect(metaRestWriteVerdict({ method: 'DELETE', url: `https://api.facebook.com/partnership-ads/fb-branded-content/${PAGE}/brand-allowlisted-creators?creator_page_ids=[${z(CREATOR_PAGE)}]`, kind: 'write', objectKind: 'page' })).toMatchObject({ problem: expect.any(String) })
    expect(metaUserIdsProblem(z(CREATOR_IG))).toMatch(/comma-separated/)
    expect(problem({ url: `${BASE}/${z(IG)}/branded_content_ad_permissions`, objectKind: 'iguser' as never, body: `creator_instagram_account=${CREATOR_IG}` })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${IG}/branded_content_ad_permissions`, objectKind: 'iguser' as never, body: `creator_instagram_account=${z(IG)}` })).toMatch(/Instagram account id/)
    // Inside a creative: a sponsor, a post, a media.
    expect(problem({ body: form(creatorMedia({ facebook_branded_content: { sponsor_page_id: z(PAGE) } })) })).toMatch(/sponsor_page_id is a Meta id/)
    expect(problem({ body: form(ownPost({ object_story_id: `${z(PAGE)}_500000000000001` })) })).toMatch(/post id/)
    expect(problem({ body: form(ownMedia({ source_instagram_media_id: z(MEDIA) })) })).toMatch(/Meta id/)
  })

  it('a branded-content post whose creator Page Meta does not name is not untagged', async () => {
    h.answers.push(json([{ fb_post_id: 500000000000099 }]))
    await expect(metaRestWriteCall({ connectionId: 'm-1', operation: 'partnership.test', path: `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`, method: 'DELETE', query: { post_ids: '[500000000000099]' } })).rejects.toThrow(/names no creator Page/)
    expect(h.calls.filter((c) => c.init.method === 'DELETE')).toHaveLength(0)
  })

  it('a code is cut out in lower-case %-encoding and escaped twice too', async () => {
    const code = 'Ab/Cd+Ef=1234'
    const forms = metaSecretForms(code)
    expect(forms).toEqual(expect.arrayContaining([code, 'Ab\\/Cd+Ef=1234', 'Ab\\\\/Cd+Ef=1234', 'Ab\\\\\\/Cd+Ef=1234', 'Ab%2FCd%2BEf%3D1234', 'Ab%2fCd%2bEf%3d1234']))
    const echoes = ['Ab%2fCd%2bEf%3d1234', JSON.stringify(JSON.stringify(code).slice(1, -1).replace(/\//g, '\\/')).slice(1, -1)]
    // The echoes as Meta's answer would carry them (each already a valid JSON string spelling).
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }), () => new Response(`{"error":{"message":"bad ${echoes.join(' and ')}","code":100}}`, { status: 400 }))
    const answer = await sendCreative(creatorCode({ branded_content: { instagram_boost_post_access_token: code, ad_format: 1 } }))
    for (const e of echoes) expect(answer.text).not.toContain(e)
    expect(answer.text).not.toContain('Cd')
  })
})

describe('set-meta-partnership-access on the gateway', () => {
  const ig = (edge: string, method: 'POST' | 'DELETE' = 'POST', params: Record<string, string> = {}, objectId = IG) =>
    metaWriteCall({ connectionId: 'm-1', operation: 'partnership.test', objectId, objectKind: edge === 'partnership_ad_code' ? 'igmedia' : 'iguser', edge: edge as never, method, params })
  const judge = (url: string, body: string | undefined, objectKind: 'iguser' | 'igmedia', method = 'POST') => {
    const v = metaWriteVerdict({ method, url: `${BASE}/${url}`, kind: 'write', objectKind, body })
    return 'problem' in v ? v.problem : null
  }

  it('the rules are exact: a creator by id (revoke only true), user_ids Meta\'s comma list, an ad code with no body, a Collab answer true or false', () => {
    expect(judge(`${IG}/branded_content_ad_permissions`, 'creator_instagram_account=17841400000000099', 'iguser')).toBeNull()
    expect(judge(`${IG}/branded_content_ad_permissions`, 'creator_instagram_account=17841400000000099&revoke=true', 'iguser')).toBeNull()
    expect(judge(`${IG}/branded_content_ad_permissions`, 'creator_instagram_account=17841400000000099&revoke=false', 'iguser')).toMatch(/revoke is true/)
    expect(judge(`${IG}/branded_content_ad_permissions`, 'creator_instagram_username=someone', 'iguser')).toMatch(/only Meta change/)
    expect(judge(`${IG}/branded_content_ad_permissions`, 'creator_instagram_account=17841400000000099', 'igmedia')).toMatch(/only Meta change/)
    expect(metaUserIdsProblem('17841400000000099,17841400000000098')).toBeNull()
    expect(metaUserIdsProblem('17841400000000099, 17841400000000098')).toMatch(/comma-separated/)
    expect(metaUserIdsProblem('17841400000000099,17841400000000099')).toMatch(/once/)
    expect(metaUserIdsProblem(Array.from({ length: 26 }, (_, i) => `178414000000001${String(i).padStart(2, '0')}`).join(','))).toMatch(/1 to 25/)
    expect(judge(`${IG}/branded_content_tag_approval`, 'user_ids=17841400000000099', 'iguser', 'DELETE')).toBeNull()
    // Review A2 — Nexus makes no ad code (nobody could read it): no POST to partnership_ad_code at all; its DELETE only.
    expect(judge(`${MEDIA}/partnership_ad_code`, undefined, 'igmedia')).toMatch(/form body/)
    expect(judge(`${MEDIA}/partnership_ad_code`, 'fields=ad_code', 'igmedia')).toMatch(/only Meta change/)
    expect(judge(`${MEDIA}/partnership_ad_code`, undefined, 'igmedia', 'DELETE')).toBeNull()
    expect(judge(`${IG}/collaboration_invites`, `media_id=${MEDIA}&accept=true`, 'iguser')).toBeNull()
    expect(judge(`${IG}/collaboration_invites`, `media_id=${MEDIA}&accept=yes`, 'iguser')).toMatch(/accept is true or false/)
    // Meta has no check on these edges: validate_only is refused (no rule takes execution_options).
    expect(judge(`${IG}/collaboration_invites`, `media_id=${MEDIA}&accept=true&execution_options=${encodeURIComponent('["validate_only"]')}`, 'iguser')).toMatch(/only Meta change/)
    // Every rule is on the chosen Instagram account or its media (no other kind).
    for (const rule of META_BOOST_WRITE_RULES) expect(rule.kinds?.every((k) => ['adaccount', 'iguser', 'igmedia'].includes(k))).toBe(true)
  })

  it('only the chosen Instagram account; each creator neither the chosen account nor another Nexus business\'s', async () => {
    await ig('branded_content_ad_permissions', 'POST', { creator_instagram_account: CREATOR_IG })
    expect(posts()).toHaveLength(1)
    expect(new URLSearchParams(posts()[0].init.body as string).get('creator_instagram_account')).toBe(CREATOR_IG)
    h.calls = []
    await expect(ig('branded_content_ad_permissions', 'POST', { creator_instagram_account: CREATOR_IG }, '17841400000000777')).rejects.toThrow(/not the one this business chose/)
    await expect(ig('branded_content_ad_permissions', 'POST', { creator_instagram_account: IG })).rejects.toThrow(/business's own chosen Instagram account/)
    gatewayMetaTakenLinks.add(`INSTAGRAM:${CREATOR_IG}`)
    await expect(ig('branded_content_tag_approval', 'POST', { user_ids: `17841400000000098,${CREATOR_IG}` })).rejects.toThrow(/another business in Nexus uses/)
    await expect(ig('branded_content_tag_approval', 'DELETE', { user_ids: CREATOR_IG })).rejects.toThrow(/another business in Nexus uses/)
    expect(posts()).toHaveLength(0)
    delete gatewayMetaInstagram['m-1']
    await expect(ig('branded_content_tag_approval', 'POST', { user_ids: '17841400000000098' })).rejects.toThrow(/no Instagram account chosen/)
  })

  it('an ad code is deleted only from a media the chosen account owns (a DELETE with no body); none is made', async () => {
    h.answers.push(json({ id: MEDIA, owner: { id: '17841400000000777' } }))
    await expect(ig('partnership_ad_code', 'DELETE', {}, MEDIA)).rejects.toThrow(/not one Nexus can confirm as the chosen Instagram account's/)
    h.answers.push(json({ id: MEDIA, owner: { id: IG } }), json({ success: true }))
    await ig('partnership_ad_code', 'DELETE', {}, MEDIA)
    expect(posts().map((c) => [c.init.method, new URL(c.url).pathname, c.init.body ?? ''])).toEqual([['DELETE', `/${META_DEFAULT_GRAPH_API_VERSION}/${MEDIA}/partnership_ad_code`, '']])
    await expect(ig('partnership_ad_code', 'POST', {}, MEDIA)).rejects.toThrow(/form body/)
  })

  it('a Collab answer only for an invite the chosen account has pending', async () => {
    h.answers.push(json({ data: [{ media_id: MEDIA }] }), json({ success: true }))
    await ig('collaboration_invites', 'POST', { media_id: MEDIA, accept: 'true' })
    expect(posts()).toHaveLength(1)
    h.calls = []
    h.answers.push(json({ data: [{ media_id: '17900000000000002' }] }))
    await expect(ig('collaboration_invites', 'POST', { media_id: MEDIA, accept: 'false' })).rejects.toThrow(/not among the Collab invites/)
    expect(posts()).toHaveLength(0)
  })

  it('MD-138 — a creator\'s video copied with the creator\'s ad code: the code must unlock exactly that media; never in the ledger', async () => {
    const params = { source_instagram_media_id: MEDIA, partnership_ad_ad_code: CODE, is_partnership_ad: 'true' }
    const copy = () => metaWriteCall({ connectionId: 'm-1', operation: 'media.videoUpload', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params })
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }), json({ id: '120000000000401' }))
    await copy()
    expect(posts()).toHaveLength(1)
    h.calls = []
    h.answers.push(discovery({ ig_user_id: CREATOR_IG }, '17900000000000002'))
    const refused = await copy().catch((err: Error) => err.message)
    expect(refused).toMatch(/unlocks other content than media/)
    expect(refused).not.toContain(CODE)
    expect(posts()).toHaveLength(0)
    expect(problem({ url: `${BASE}/${ACT}/advideos`, body: new URLSearchParams({ ...params, is_partnership_ad: 'false' }).toString() })).toMatch(/is_partnership_ad is true/)
    expect(JSON.stringify(gatewayLedger)).not.toContain(CODE)
  })

  it('review B1 — the Facebook side on Meta\'s partnership host: exact routes, methods, queries and JSON bodies, the chosen Page only', () => {
    expect(META_PARTNERSHIP_REST_HOST).toBe(META_REST_HOST)
    const rest = (method: string, path: string, body?: string, objectKind = 'page') => {
      const v = metaWriteVerdict({ method, url: `https://api.facebook.com/${path}`, kind: 'write', objectKind, body })
      return 'problem' in v ? v.problem : v.write
    }
    const perm = `partnership-ads/fb-account-level-permissions/${PAGE}`
    const body = metaPermissionBodyOf([{ pageId: CREATOR_PAGE, action: 'send-request' }, { pageId: '120000000000556', action: 'revoke-permission' }])
    expect(body).toBe(`[{"partner_page_id":${CREATOR_PAGE},"action":"send-request"},{"partner_page_id":120000000000556,"action":"revoke-permission"}]`)
    expect(rest('POST', perm, body)).toMatchObject({ rule: 'page.fbPermissions', objectId: PAGE, host: 'rest', kinds: ['page'], assets: [{ id: CREATOR_PAGE, kind: 'partnerpage' }, { id: '120000000000556', kind: 'partnerpage' }] })
    expect(rest('POST', perm, body.replace('send-request', 'remove-permission'))).toMatch(/one spelling/)
    expect(rest('POST', perm, body.replace('"action"', ' "action"'))).toMatch(/one spelling/)
    expect(rest('POST', perm, `[{"partner_page_id":${CREATOR_PAGE},"action":"send-request","note":"x"}]`)).toMatch(/one spelling/)
    expect(rest('POST', perm, metaPermissionBodyOf([{ pageId: CREATOR_PAGE, action: 'send-request' }, { pageId: CREATOR_PAGE, action: 'cancel-request' }]))).toMatch(/each once/)
    expect(rest('POST', perm, metaPermissionBodyOf(Array.from({ length: 11 }, (_, i) => ({ pageId: `1200000000006${String(i).padStart(2, '0')}`, action: 'send-request' }))))).toMatch(/1 to 10/)
    expect(rest('POST', `${perm}?status=1`, body)).toMatch(/carries no query/)
    expect(rest('PUT', perm, body)).toMatch(/Nexus changes only/)
    expect(rest('POST', perm, body, 'adaccount')).toMatch(/kind page/)
    const allow = `partnership-ads/fb-branded-content/${PAGE}/brand-allowlist-status`
    expect(rest('PUT', `${allow}?is_enabled=true`)).toMatchObject({ rule: 'page.fbAllowlistStatus', method: 'PUT', body: '' })
    expect(rest('PUT', `${allow}?is_enabled=yes`)).toMatch(/is_enabled=true or false/)
    expect(rest('PUT', `${allow}?is_enabled=true&x=1`)).toMatch(/is_enabled=true or false/)
    expect(rest('PUT', `${allow}?is_enabled=true`, '{"a":1}')).toMatch(/no body/)
    const creators = `partnership-ads/fb-branded-content/${PAGE}/brand-allowlisted-creators`
    expect(rest('POST', creators, `{"creator_page_ids":[${CREATOR_PAGE}]}`)).toMatchObject({ rule: 'page.fbAllowCreators', assets: [{ id: CREATOR_PAGE, kind: 'partnerpage' }] })
    expect(rest('POST', `${creators}?creator_page_ids=[${CREATOR_PAGE}]`)).toMatch(/carries no query/)
    expect(rest('POST', creators, `{"creator_page_ids":[${CREATOR_PAGE}, 1]}`)).toMatch(/no space/)
    expect(rest('DELETE', `${creators}?creator_page_ids=${encodeURIComponent(`[${CREATOR_PAGE}]`)}`)).toMatchObject({ rule: 'page.fbDisallowCreators', method: 'DELETE' })
    expect(rest('DELETE', creators, `{"creator_page_ids":[${CREATOR_PAGE}]}`)).toMatch(/no body/)
    const posts = `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`
    expect(rest('DELETE', `${posts}?post_ids=${encodeURIComponent('[500000000000099]')}`)).toMatchObject({ rule: 'page.fbUntagPosts', assets: [{ id: '500000000000099', kind: 'brandedpost' }] })
    expect(rest('DELETE', `${posts}?post_ids=500000000000099`)).toMatch(/post_ids=\[/)
    // Nothing else on that host; never a read declared otherwise; never the caller's headers or another token.
    expect(rest('POST', `partnership-ads/fb-branded-content/${PAGE}/content-block-list`, '{}')).toMatch(/Nexus changes only/)
    expect(metaRestWriteVerdict({ method: 'POST', url: `https://api.facebook.com/${perm}`, kind: 'read', objectKind: 'page', body })).toMatchObject({ problem: expect.stringMatching(/as a write/) })
    expect('problem' in metaWriteVerdict({ method: 'POST', url: `https://api.facebook.com/${perm}`, kind: 'write', objectKind: 'page', body, headers: { 'X-API-Version': '2' } })).toBe(true)
    expect('problem' in metaWriteVerdict({ method: 'POST', url: `https://api.facebook.com/${perm}`, kind: 'write', objectKind: 'page', body, auth: 'none' })).toBe(true)
    expect(rest('POST', `partnership-ads/fb-account-level-permissions/${PAGE}%2F1`, body)).toMatch(/written plainly/)
  })

  it('review B1 — sent with the system-user token as Bearer and X-API-Version, a JSON body; only the chosen Page; partners and posts checked', async () => {
    const send = (method: 'POST' | 'PUT' | 'DELETE', path: string, opts: { body?: string; query?: Record<string, string> } = {}) =>
      metaRestWriteCall({ connectionId: 'm-1', operation: 'partnership.test', path, method, ...opts })
    h.answers.push(json([{ partner_page_id: Number(CREATOR_PAGE), alp_permission_id: 9, alp_permission_status: 1, status: 'success' }]))
    const answer = await send('POST', `partnership-ads/fb-account-level-permissions/${PAGE}`, { body: metaPermissionBodyOf([{ pageId: CREATOR_PAGE, action: 'send-request' }]) })
    expect(answer.ok).toBe(true)
    const sent = h.calls[0]
    const url = new URL(sent.url)
    expect(url.host).toBe('api.facebook.com')
    expect([...url.searchParams.keys()]).toEqual([])
    const headers = sent.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer meta-system-user-token')
    expect(headers['X-API-Version']).toBe('1.0.0')
    expect(headers['Content-Type']).toBe('application/json')
    expect(sent.init.body).toBe(`[{"partner_page_id":${CREATOR_PAGE},"action":"send-request"}]`)
    // Another Page in the path, the chosen Page as partner, another Nexus business's Page: nothing sent.
    h.calls = []
    await expect(send('POST', `partnership-ads/fb-account-level-permissions/120000000000099`, { body: metaPermissionBodyOf([{ pageId: CREATOR_PAGE, action: 'send-request' }]) })).rejects.toThrow(/120000000000099 is not the Facebook Page this business chose/)
    await expect(send('POST', `partnership-ads/fb-account-level-permissions/${PAGE}`, { body: metaPermissionBodyOf([{ pageId: PAGE, action: 'send-request' }]) })).rejects.toThrow(/business's own chosen Page/)
    gatewayMetaTakenLinks.add(`PAGE:${CREATOR_PAGE}`)
    await expect(send('POST', `partnership-ads/fb-branded-content/${PAGE}/brand-allowlisted-creators`, { body: `{"creator_page_ids":[${CREATOR_PAGE}]}` })).rejects.toThrow(/another business in Nexus uses/)
    gatewayMetaTakenLinks.clear()
    expect(h.calls).toHaveLength(0)
    // The allowlist switch: a PUT with its query, no body.
    h.answers.push(json({ allowlist_status: 'ENABLED' }))
    await send('PUT', `partnership-ads/fb-branded-content/${PAGE}/brand-allowlist-status`, { query: { is_enabled: 'true' } })
    expect(h.calls[0].init.method).toBe('PUT')
    expect(new URL(h.calls[0].url).searchParams.get('is_enabled')).toBe('true')
    expect(h.calls[0].init.body).toBeUndefined()
    // An untag: each post must be among the branded-content posts that tag the chosen Page, by no other business's Page.
    h.calls = []
    h.answers.push(json([{ fb_post_id: 500000000000099, creator_page_id: Number(CREATOR_PAGE) }]), json([{ fb_post_id: 500000000000099, status_code: 200 }]))
    await send('DELETE', `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`, { query: { post_ids: '[500000000000099]' } })
    expect(new URL(h.calls[0].url).pathname).toBe(`/partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`)
    expect(h.calls[0].init.method).toBe('GET')
    expect(h.calls[1].init.method).toBe('DELETE')
    h.calls = []
    h.answers.push(json([{ fb_post_id: 500000000000098, creator_page_id: Number(CREATOR_PAGE) }]))
    await expect(send('DELETE', `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`, { query: { post_ids: '[500000000000099]' } })).rejects.toThrow(/not one Nexus can confirm among the branded-content posts/)
    gatewayMetaTakenLinks.add(`PAGE:${CREATOR_PAGE}`)
    h.answers.push(json([{ fb_post_id: 500000000000099, creator_page_id: Number(CREATOR_PAGE) }]))
    await expect(send('DELETE', `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`, { query: { post_ids: '[500000000000099]' } })).rejects.toThrow(/by a Page another business in Nexus uses/)
    expect(h.calls.filter((c) => c.init.method === 'DELETE')).toHaveLength(0)
  })
})
