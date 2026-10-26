/**
 * Meta step 27b on the gateway — Instant Experiences of the chosen Page, made AS the Page (step 36's Page token mode):
 *   - the rules are an exact ALLOW-list: one part per call, every key at every depth of its JSON on a list, one spelling
 *     only, text printable, links https (a Meta link only as an Instant Experience link), no app link, no undocumented id;
 *     the experience made UNPUBLISHED only, an edit never publishes or hides, a publish is true only;
 *   - the owner check: the chosen Page (another business's Page: refused, no token read), an Instant Experience of it
 *     (Nexus-made: no read; else ONE read of id,owner,is_published), and every id inside a part — a photo, post, video,
 *     Instagram media, lead form of the Page / chosen accounts, a product set or catalog item through the catalog rule, a
 *     part made in the SAME run or listed on the Page.
 * Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE_TOKEN = 'pagetoken0123456789abcdefghijKLMN'
const SYSTEM_TOKEN = 'meta-system-user-token'
const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response>,
  catalog: vi.fn(async (): Promise<string | null> => null),
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
// Step 18's catalog rule reads Meta and the database: its verdict stands in here (catalog-rule.vitest.test.ts tests it).
vi.mock('../marketing/meta-ads/catalog-rule.js', () => ({ metaCatalogProblem: h.catalog, newCatalogRuleMemo: () => ({ portfolios: new Map(), catalogs: new Map(), verdicts: new Map() }) }))

import { gatewayLedger, gatewayMetaInstagram, gatewayMetaNexusMade, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall } from './gateway.js'
import { metaWriteCall } from './meta.js'
import { metaCallVerdict, metaWriteVerdict } from './meta-calls.js'
import { META_CANVAS_ELEMENT_KEYS, META_CANVAS_LINK, META_CANVAS_WRITE_RULES, META_IX_TEMPLATE_IDS, metaCanvasColorSame, metaCanvasElementOf } from './meta-canvas-rules.js'
import { __pageOwnerTest } from './meta-page-owner.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { IX_TEMPLATES } from '../marketing/meta-ads/live-media.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000099'
const IG = '17841400000000001'
const CANVAS = '120000000000701'
const OTHER_CANVAS = '120000000000799'
const PART = '120000000000711'
const PART_2 = '120000000000712'
const PHOTO = '800000000000001'
const VIDEO = '800000000000002'
const FORM = '600000000000001'
const SET = '120000000000061'
const ITEM = '120000000000071'
const MEDIA = '17900000000000001'

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const tokenAnswer = () => json({ id: PAGE, access_token: PAGE_TOKEN })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: String(h.calls[i].init.body ?? '') })
const part = (key: string, value: unknown) => ({ [key]: JSON.stringify(value) })
const form = (params: Record<string, string>) => new URLSearchParams(params).toString()
const verdict = (route: string, params: Record<string, string>, objectKind = 'page') => metaWriteVerdict({ method: 'POST', url: `${BASE}/${route}`, kind: 'write', objectKind, body: form(params) })
const problemOf = (route: string, params: Record<string, string>, objectKind = 'page') => { const v = verdict(route, params, objectKind); return 'problem' in v ? v.problem : null }
const elementProblem = (key: string, value: unknown) => problemOf(`${PAGE}/canvas_elements`, part(key, value))
const elementIds = (key: string, value: unknown) => { const e = metaCanvasElementOf(new Map(Object.entries(part(key, value)))); return 'problem' in e ? e.problem : e.ids }
const make = (params: Record<string, string>, run?: string) => metaWriteCall({ connectionId: 'm-1', operation: 'canvas.element.create', objectId: PAGE, objectKind: 'page', edge: 'canvas_elements', params, check: false, ...(run ? { run } : {}) }).catch((e) => e)
const canvasCreate = (params: Record<string, string>, run?: string) => metaWriteCall({ connectionId: 'm-1', operation: 'canvas.create', objectId: PAGE, objectKind: 'page', edge: 'canvases', params, check: false, ...(run ? { run } : {}) }).catch((e) => e)
const canvasPost = (params: Record<string, string>, id = CANVAS) => metaWriteCall({ connectionId: 'm-1', operation: 'canvas.update', objectId: id, objectKind: 'canvas', params, check: false }).catch((e) => e)

/** Every part a create may hold, one of each, as Nexus writes it. */
const EVERY_PART: Record<string, unknown> = {
  canvas_button: { name: 'Buy', rich_text: { plain_text: 'Jetzt kaufen — 20 %' }, button_style: 'BUTTON_FILLED', open_url_action: { url: 'https://www.example.com/shop' }, button_color: 'FF000000', text_alignment: 'CENTER', text_color: 'FFFFFF', font_size: 15, font_family: 'sans-serif', line_height: 1.2, background_color: 'FFFFFFFF', top_padding: 0, bottom_padding: 12 },
  canvas_carousel: { name: 'Gallery', child_elements: [PART, PART_2], style: 'FIT_TO_HEIGHT', top_padding: 4 },
  canvas_existing_post: { source_instagram_media_id: MEDIA },
  canvas_footer: { name: 'Footer', child_elements: [PART], background_color: 'FFFFFF' },
  canvas_header: { name: 'Header', child_elements: [PART], background_color: '000000' },
  canvas_lead_form: { name: 'Form', leadgen_data_id: FORM, bottom_padding: 8 },
  canvas_photo: { name: 'Cover', photo_id: PHOTO, style: 'FIT_TO_WIDTH_EXPANDABLE', open_url_action: { url: 'https://www.example.com/' }, product_tags: [{ product_id: ITEM, coordinates: [0.5, 0.25] }], hide_product_prices: false },
  canvas_product_list: { name: 'Picks', product_id_list: [ITEM], item_headline: '{{product.name}}', item_description: '{{product.current_price}}' },
  canvas_product_set: {
    name: 'Shop', product_set_id: SET, max_items: 24, show_in_feed: true, item_headline: '{{product.name}}', item_description: '{{product.current_price}}',
    image_overlay_spec: { overlay_template: 'pill_with_text', text_type: 'price', text_font: 'dynads_hybrid_bold', position: 'top_left', theme_color: 'background_e50900_text_ffffff', float_with_margin: true },
    storefront_setting: { enable_sections: true, customized_section_titles: [{ title_id: 'popular', customized_title: 'Più venduti' }], product_set_layout: { layout_type: 'GRID_3COL' } },
  },
  canvas_store_locator: { name: 'Stores', typeface: 'HelveticaNeue-Light', header_background_color: 'FF000000' },
  canvas_template_video: { name: 'Video', product_set_id: SET, template_video_spec: { customization: { text_color: 'FFFFFF', text_background_color: '000000', name_template: '{{product.name}}', body_template: '{{product.current_price strip_zeros}}' } } },
  canvas_text: { name: 'Intro', rich_text: { plain_text: 'Zeile eins\nZeile zwei 🏍️' }, text_alignment: 'LEFT', font_size: 18 },
  canvas_video: { name: 'Clip', video_id: VIDEO, style: 'FIT_TO_WIDTH' },
}

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  __pageOwnerTest.reset()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  h.catalog.mockReset(); h.catalog.mockResolvedValue(null)
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  for (const key of Object.keys(gatewayMetaInstagram)) delete gatewayMetaInstagram[key]
  gatewayMetaPage['m-1'] = PAGE
  gatewayMetaInstagram['m-1'] = IG
  gatewayMetaNexusMade.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ id: PART }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the Instant Experience rules are an exact allow-list', () => {
  it('every part of the reference passes in Nexus\'s one spelling, made as the Page on its edge, its ids named for the owner check', () => {
    expect(Object.keys(EVERY_PART).sort()).toEqual([...META_CANVAS_ELEMENT_KEYS].sort())
    for (const [key, value] of Object.entries(EVERY_PART)) {
      const v = verdict(`${PAGE}/canvas_elements`, part(key, value))
      expect(v, key).toMatchObject({ write: { rule: 'canvas.element.create', objectId: PAGE, kinds: ['page'], auth: 'page', edgeCall: true, check: false } })
    }
    expect(elementIds('canvas_photo', EVERY_PART.canvas_photo)).toEqual([{ id: PHOTO, kind: 'pagephoto' }, { id: ITEM, kind: 'productitem' }])
    expect(elementIds('canvas_carousel', EVERY_PART.canvas_carousel)).toEqual([{ id: PART, kind: 'canvaselement' }, { id: PART_2, kind: 'canvaselement' }])
    expect(elementIds('canvas_existing_post', EVERY_PART.canvas_existing_post)).toEqual([{ id: MEDIA, kind: 'instagrammedia' }])
    expect(elementIds('canvas_existing_post', { source_facebook_post_id: `${PAGE}_500000000000001` })).toEqual([{ id: `${PAGE}_500000000000001`, kind: 'pagepost' }])
    expect(elementIds('canvas_lead_form', EVERY_PART.canvas_lead_form)).toEqual([{ id: FORM, kind: 'leadform' }])
    expect(elementIds('canvas_product_set', EVERY_PART.canvas_product_set)).toEqual([{ id: SET, kind: 'productset' }])
    expect(elementIds('canvas_template_video', EVERY_PART.canvas_template_video)).toEqual([{ id: SET, kind: 'productset' }])
    expect(elementIds('canvas_video', EVERY_PART.canvas_video)).toEqual([{ id: VIDEO, kind: 'canvasvideo' }])
    expect(elementIds('canvas_button', { rich_text: { plain_text: 'More' }, button_style: 'BUTTON_OUTLINE', open_url_action: { url: `https://fb.com/canvas_doc/${OTHER_CANVAS}` } })).toEqual([{ id: OTHER_CANVAS, kind: 'canvas' }])
    expect(elementIds('canvas_store_locator', EVERY_PART.canvas_store_locator)).toEqual([])
  })
  it('one part per call, each key once, nothing else in the body; one spelling only', () => {
    expect(problemOf(`${PAGE}/canvas_elements`, { ...part('canvas_text', EVERY_PART.canvas_text), ...part('canvas_button', EVERY_PART.canvas_button) })).toMatch(/one per call/)
    expect(problemOf(`${PAGE}/canvas_elements`, { ...part('canvas_text', EVERY_PART.canvas_text), name: 'x' })).toMatch(/only Meta change Nexus sends on an Instant Experience/)
    expect(problemOf(`${PAGE}/canvas_elements`, { canvas_text: JSON.stringify(EVERY_PART.canvas_text).replace('":', '": ') })).toMatch(/one spelling only/)
    expect(problemOf(`${PAGE}/canvas_elements`, { canvas_text: '{"rich_text":' })).toMatch(/is JSON/)
    expect(problemOf(`${PAGE}/canvas_elements`, { canvas_text: JSON.stringify(EVERY_PART.canvas_text), execution_options: '["validate_only"]' })).not.toBeNull()
  })
  it('refuses, in words, every key and value Nexus does not send, at every depth', () => {
    expect(elementProblem('canvas_text', { rich_text: { plain_text: 'x', block_type: 'H1' } })).toMatch(/no key "block_type"/)
    expect(elementProblem('canvas_button', { rich_text: { plain_text: 'x' }, button_style: 'BUTTON_FILLED', deep_link: 'app://x' })).toMatch(/no app of its own/)
    expect(elementProblem('canvas_photo', { photo_id: PHOTO, destination_set_id: '1' })).toMatch(/destination_set_id/)
    expect(elementProblem('canvas_product_set', { product_set_id: SET, retailer_item_ids: ['sku-1'] })).toMatch(/retailer_item_ids/)
    expect(elementProblem('canvas_photo', { photo_id: PHOTO, photo_url: 'https://www.example.com/a.jpg' })).toMatch(/exactly one of photo_id, photo_url/)
    expect(elementProblem('canvas_video', {})).toMatch(/exactly one of video_id, video_url/)
    expect(elementProblem('canvas_existing_post', { source_instagram_media_id: MEDIA, source_facebook_post_id: `${PAGE}_1` })).toMatch(/exactly one/)
    expect(elementProblem('canvas_button', { rich_text: { plain_text: 'x' } })).toMatch(/names button_style/)
    expect(elementProblem('canvas_button', { rich_text: { plain_text: 'x' }, button_style: 'BUTTON_GHOST' })).toMatch(/one of BUTTON_OUTLINE, BUTTON_FILLED/)
    expect(elementProblem('canvas_carousel', { child_elements: [] })).toMatch(/list of 1 to 10/)
    expect(elementProblem('canvas_carousel', { child_elements: [PART, PART] })).toMatch(/each one once/)
    expect(elementProblem('canvas_carousel', { child_elements: [Number(PART)] })).toMatch(/Meta id \(digits, as text\)/)
    expect(elementProblem('canvas_product_list', { product_id_list: Array.from({ length: 21 }, (_, i) => String(120000000000100 + i)) })).toMatch(/list of 1 to 20/)
    expect(elementProblem('canvas_product_set', { product_set_id: SET, max_items: 51 })).toMatch(/from 1 to 50/)
    expect(elementProblem('canvas_product_set', { product_set_id: SET, storefront_setting: { customized_section_titles: [{ title_id: 'popular', customized_title: 'x' }] } })).toMatch(/go with enable_sections true/)
    expect(elementProblem('canvas_product_set', { product_set_id: SET, image_overlay_spec: { overlay_template: 'pill_with_text' } })).toMatch(/names text_type/)
    expect(elementProblem('canvas_template_video', { product_set_id: SET, template_video_spec: { customization: { font: 'x' } } })).toMatch(/no key "font"/)
    expect(elementProblem('canvas_text', { rich_text: { plain_text: 'x' }, text_color: '#fff' })).toMatch(/RRGGBB/)
    expect(elementProblem('canvas_text', { rich_text: { plain_text: 'x' }, font_size: 200 })).toMatch(/from 6 to 72/)
    expect(elementProblem('canvas_text', { rich_text: { plain_text: 'x' }, top_padding: -1 })).toMatch(/from 0 to 500/)
    // Review B-4 — the canvas-photo reference: "greater than zero and less than 1" (both ends left out).
    for (const coordinates of [[2, 0.5], [0, 0.5], [0.5, 1], [1, 1]]) {
      expect(elementProblem('canvas_photo', { photo_id: PHOTO, product_tags: [{ product_id: ITEM, coordinates }] }), JSON.stringify(coordinates)).toMatch(/each greater than 0 and less than 1/)
    }
    expect(elementProblem('canvas_photo', { photo_id: PHOTO, product_tags: [{ product_id: ITEM, coordinates: [0.01, 0.99] }] })).toBeNull()
  })
  it('review B-3 / B-7 — the fields left out on purpose say why: a travel destination set, an overlay\'s template tags', () => {
    expect(elementProblem('canvas_photo', { photo_id: PHOTO, destination_set_id: '120000000000090' })).toMatch(/set of a travel destination catalog .*Including destination catalogs/)
    expect(elementProblem('canvas_product_set', { product_set_id: SET, image_overlay_spec: { overlay_template: 'pill_with_text', text_type: 'price', text_font: 'dynads_hybrid_bold', position: 'top_left', theme_color: 'background_e50900_text_ffffff', text_template_tags: ['x'] } })).toMatch(/text_template_tags yet/)
  })
  it('review A-5 — an Instant Experience link names its id with no leading zero', () => {
    const button = (url: string) => elementProblem('canvas_button', { rich_text: { plain_text: 'Go' }, button_style: 'BUTTON_FILLED', open_url_action: { url } })
    expect(button(`https://fb.com/canvas_doc/0${OTHER_CANVAS}`)).toMatch(/exactly another Instant Experience/)
    expect(button('https://fb.com/canvas_doc/0')).toMatch(/exactly another Instant Experience/)
    expect(META_CANVAS_LINK.test(`https://fb.com/canvas_doc/0${OTHER_CANVAS}`)).toBe(false)
    expect(META_CANVAS_LINK.exec(`https://fb.com/canvas_doc/${OTHER_CANVAS}`)?.[1]).toBe(OTHER_CANVAS)
    expect(META_CANVAS_LINK.test(`https://fb.com/canvas_doc/1${'0'.repeat(20)}`)).toBe(false)
  })
  it('review B-6 — a colour Meta writes as AARRGGBB is the RRGGBB sent when it is FF + those six digits', () => {
    expect(metaCanvasColorSame('FFFFFFFF', 'FFFFFF')).toBe(true)
    expect(metaCanvasColorSame('FF000000', '000000')).toBe(true)
    expect(metaCanvasColorSame('000000', 'FF000000')).toBe(true)
    expect(metaCanvasColorSame('ff1a2b3c', '1A2B3C')).toBe(true)
    expect(metaCanvasColorSame('80000000', '000000')).toBe(false)
    expect(metaCanvasColorSame('FFFFFF', 'FFFFFF')).toBe(true)
    expect(metaCanvasColorSame('FFFFFF', null)).toBe(false)
    expect(metaCanvasColorSame('#FFFFFF', 'FFFFFF')).toBe(false)
  })
  it('text a person types: printable, a line break only in a text block, no format characters', () => {
    expect(elementProblem('canvas_text', { rich_text: { plain_text: 'one\ntwo' } })).toBeNull()
    expect(elementProblem('canvas_button', { rich_text: { plain_text: 'one\ntwo' }, button_style: 'BUTTON_FILLED' })).toMatch(/no control or format character/)
    expect(elementProblem('canvas_text', { rich_text: { plain_text: 'evil‮text' } })).toMatch(/bidirectional|control or format/)
    expect(elementProblem('canvas_text', { name: 'a​b', rich_text: { plain_text: 'x' } })).toMatch(/control or format/)
    expect(elementProblem('canvas_button', { rich_text: { plain_text: 'x'.repeat(201) }, button_style: 'BUTTON_FILLED' })).toMatch(/1 to 200 characters/)
  })
  it('links: a public https website; a Meta link only as another Instant Experience; a picture or video never one of Meta\'s own links', () => {
    const button = (url: string) => elementProblem('canvas_button', { rich_text: { plain_text: 'Go' }, button_style: 'BUTTON_FILLED', open_url_action: { url } })
    expect(button('https://www.example.com/a?ref=ix')).toBeNull()
    expect(button(`https://fb.com/canvas_doc/${OTHER_CANVAS}`)).toBeNull()
    for (const bad of ['http://www.example.com/', 'https://localhost/x', 'https://www.example.com/?token=abc', 'https://www.facebook.com/somepage', `https://www.fb.com/canvas_doc/${OTHER_CANVAS}`, `https://fb.com/canvas_doc/${OTHER_CANVAS}/`, 'https://l.facebook.com/l.php?u=https%3A%2F%2Fx.com']) {
      expect(button(bad), bad).not.toBeNull()
    }
    expect(elementProblem('canvas_photo', { photo_url: 'https://www.example.com/cover.jpg' })).toBeNull()
    expect(elementProblem('canvas_photo', { photo_url: 'https://scontent.xx.fbcdn.net/v/a.jpg' })).toMatch(/links it returned/)
    expect(elementProblem('canvas_video', { video_url: 'https://www.facebook.com/watch/1' })).toMatch(/links it returned/)
  })
  it('the experience: made UNPUBLISHED only, from a list of parts each named once, one hero asset, a template of the guide\'s five', () => {
    const create = (extra: Record<string, string> = {}) => problemOf(`${PAGE}/canvases`, { name: 'Experience A', body_element_ids: JSON.stringify([PART, PART_2]), is_published: 'false', ...extra })
    expect(create()).toBeNull()
    expect(verdict(`${PAGE}/canvases`, { name: 'Experience A', body_element_ids: JSON.stringify([PART]), is_published: 'false' })).toMatchObject({ write: { rule: 'canvas.create', auth: 'page', kinds: ['page'], edgeCall: true, ids: [{ id: PART, kind: 'canvaselement' }] } })
    expect(create({ background_color: 'FFFFFFFF', enable_swipe_to_open: 'true', is_hidden: 'false', hero_asset_instagram_media_id: MEDIA, source_template_id: META_IX_TEMPLATE_IDS[4] })).toBeNull()
    expect(create({ is_published: 'true' })).toMatch(/UNPUBLISHED/)
    expect(create({ hero_asset_instagram_media_id: MEDIA, hero_asset_facebook_post_id: `${PAGE}_1` })).toMatch(/one hero asset/)
    expect(create({ source_template_id: '1' })).toMatch(/templates Meta's guide names/)
    expect(create({ body_element_ids: JSON.stringify([PART, PART]) })).toMatch(/each one once/)
    expect(create({ body_element_ids: JSON.stringify([]) })).toMatch(/list of 1 to 50/)
    expect(create({ body_element_ids: JSON.stringify([Number(PART)]) })).toMatch(/Meta id/)
    expect(create({ enable_swipe_to_open: '1' })).toMatch(/true or false/)
    expect(create({ name: 'a‮b' })).toMatch(/printable|control or format|bidirectional/)
    const { name: _n, ...noName } = { name: 'x', body_element_ids: JSON.stringify([PART]), is_published: 'false' }
    expect(problemOf(`${PAGE}/canvases`, noName)).toMatch(/only Meta change Nexus sends on an Instant Experience/)
  })
  it('edit, publish, hide: each its own rule on an Instant Experience; an edit never publishes or hides; a publish is one way', () => {
    expect(verdict(CANVAS, { name: 'B', body_element_ids: JSON.stringify([PART]) }, 'canvas')).toMatchObject({ write: { rule: 'canvas.update', objectId: CANVAS, auth: 'page', kinds: ['canvas'] } })
    expect(verdict(CANVAS, { is_published: 'true' }, 'canvas')).toMatchObject({ write: { rule: 'canvas.publish', auth: 'page' } })
    expect(problemOf(CANVAS, { is_published: 'false' }, 'canvas')).toMatch(/Nexus never un-publishes/)
    expect(verdict(CANVAS, { is_hidden: 'true' }, 'canvas')).toMatchObject({ write: { rule: 'canvas.hidden' } })
    expect(problemOf(CANVAS, { name: 'B', is_published: 'true' }, 'canvas')).toMatch(/only Meta change Nexus sends on an Instant Experience/)
    expect(problemOf(CANVAS, { name: 'B', is_hidden: 'true' }, 'canvas')).toMatch(/only Meta change Nexus sends on an Instant Experience/)
    // The canvas rules only for a call that names an Instant Experience; a campaign's status rule is untouched.
    expect(problemOf(CANVAS, { body_element_ids: JSON.stringify([PART]) }, 'campaign')).not.toBeNull()
    expect(verdict(CANVAS, { status: 'PAUSED' }, 'campaign')).toMatchObject({ write: { rule: 'object.status' } })
    expect(problemOf(CANVAS, { status: 'PAUSED' }, 'canvas')).toMatch(/only Meta change Nexus sends on an Instant Experience/)
    // No delete of an Instant Experience (Meta documents none).
    const del = metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${CANVAS}`, kind: 'write', objectKind: 'canvas' })
    expect('problem' in del ? del.problem : null).toMatch(/Nexus deletes on Meta only/)
    expect(META_CANVAS_WRITE_RULES.every((r) => r.auth === 'page')).toBe(true)
  })
  it('review B-1 — the read of an Instant Experience may ask fb_body_elements (and the parts\' element{id}): the read gate takes them', () => {
    const read = (fields: string) => metaCallVerdict({ method: 'GET', url: `${BASE}/${CANVAS}?fields=${encodeURIComponent(fields)}`, kind: 'read' }).problem
    expect(read('id,name,is_published,is_hidden,background_color,body_elements,hero_asset_facebook_post_id,hero_asset_instagram_media_id,source_template{id},canvas_link,fb_body_elements')).toBeNull()
    expect(read('id,body_elements{element{id}},fb_body_elements{element{id}}')).toBeNull()
    // Still never a token, nor people, inside it.
    expect(read('id,fb_body_elements,access_token')).toMatch(/never asks Meta for a token/)
  })
  it('the template ids are step 10\'s five (one list per side, kept equal)', () => {
    expect([...META_IX_TEMPLATE_IDS].sort()).toEqual(Object.values(IX_TEMPLATES).sort())
  })
})

describe('made as the chosen Page, with every id checked', () => {
  it('a part on the chosen Page: the Page\'s token read for that call, the part sent with it, no 30-s gap between parts', async () => {
    h.answers.push(tokenAnswer(), json({ id: PART }), tokenAnswer(), json({ id: PART_2 }))
    expect((await make(part('canvas_text', EVERY_PART.canvas_text))).ok).toBe(true)
    expect((await make(part('canvas_store_locator', EVERY_PART.canvas_store_locator))).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([
      ['GET', `/v26.0/${PAGE}`], ['POST', `/v26.0/${PAGE}/canvas_elements`], ['GET', `/v26.0/${PAGE}`], ['POST', `/v26.0/${PAGE}/canvas_elements`],
    ])
    expect(sent(1).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(sent(0).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
  })
  it('another Page (another business\'s too): refused, no token read, nothing sent', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'canvas.element.create', objectId: OTHER_PAGE, objectKind: 'page', edge: 'canvas_elements', params: part('canvas_text', EVERY_PART.canvas_text), check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    delete gatewayMetaPage['m-1']
    expect(await make(part('canvas_text', EVERY_PART.canvas_text))).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
  it('the experience from parts made in the SAME run: no list read; a part of another run must be listed on the Page', async () => {
    h.answers.push(tokenAnswer(), json({ id: PART }), tokenAnswer(), json({ id: PART_2 }))
    await make(part('canvas_text', EVERY_PART.canvas_text), 'run-1')
    await make(part('canvas_store_locator', EVERY_PART.canvas_store_locator), 'run-1')
    h.calls = []
    h.answers.push(tokenAnswer(), json({ id: CANVAS }))
    const made = await canvasCreate({ name: 'Experience A', body_element_ids: JSON.stringify([PART, PART_2]), is_published: 'false' }, 'run-1')
    expect(made.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${PAGE}`], ['POST', `/v26.0/${PAGE}/canvases`]])
    expect(new URLSearchParams(sent(1).body).get('body_element_ids')).toBe(JSON.stringify([PART, PART_2]))
    // Another run: the parts must be on the Page's list (first 500) — one read, then nothing when one is missing.
    h.calls = []
    h.answers.push(json({ data: [{ id: PART }] }))
    const other = await canvasCreate({ name: 'Experience B', body_element_ids: JSON.stringify([PART, PART_2]), is_published: 'false' }, 'run-2')
    expect(other).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/part 120000000000712 is not one made in this same change nor one of the chosen Page's/) })
    expect(sent(0).url.pathname).toBe(`/v26.0/${PAGE}/canvas_elements`)
    expect(sent(0).url.searchParams.get('fields')).toBe('id')
    expect(h.calls).toHaveLength(1)
    // Listed: sent.
    h.calls = []
    h.answers.push(json({ data: [{ id: PART }, { id: PART_2 }] }), tokenAnswer(), json({ id: CANVAS }))
    expect((await canvasCreate({ name: 'Experience C', body_element_ids: JSON.stringify([PART, PART_2]), is_published: 'false' })).ok).toBe(true)
    // The list unreadable: unconfirmed, nothing sent.
    h.calls = []
    h.answers.push(json({ error: { code: 200, message: 'Permissions error' } }, 403))
    expect(await canvasCreate({ name: 'Experience D', body_element_ids: JSON.stringify([PART]), is_published: 'false' })).toMatchObject({ code: 'META_PAGE_UNCONFIRMED' })
    expect(h.calls).toHaveLength(1)
  })
  it('a part made without a run id (not a Nexus change\'s run) is not remembered', async () => {
    h.answers.push(tokenAnswer(), json({ id: PART }))
    await make(part('canvas_text', EVERY_PART.canvas_text))
    h.calls = []
    h.answers.push(json({ data: [] }))
    expect(await make(part('canvas_footer', { child_elements: [PART] }), 'run-1')).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
  })
  it('an Instant Experience Nexus made on the Page: no read; any other: ONE read of id,owner,is_published — another Page\'s, or another kind of node: refused', async () => {
    gatewayMetaNexusMade.add(`canvas:${CANVAS}:${PAGE}`)
    h.answers.push(tokenAnswer(), json({ success: true }))
    expect((await canvasPost({ is_hidden: 'true' })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${PAGE}`], ['POST', `/v26.0/${CANVAS}`]])
    expect(sent(1).body).toBe('is_hidden=true')
    __metaObjectLimitsTest.useMemory()
    h.calls = []
    h.answers.push(json({ id: OTHER_CANVAS, owner: { id: PAGE }, is_published: false }), tokenAnswer(), json({ success: true }))
    expect((await canvasPost({ is_published: 'true' }, OTHER_CANVAS)).ok).toBe(true)
    expect(sent(0).url.searchParams.get('fields')).toBe('id,owner,is_published')
    h.calls = []
    h.answers.push(json({ id: '120000000000798', owner: { id: OTHER_PAGE }, is_published: false }))
    const neighbour = await canvasPost({ name: 'X' }, '120000000000798')
    expect(neighbour).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(neighbour.message).not.toContain(OTHER_PAGE)
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (is_published) on node type (Event)' } }, 400))
    expect(await canvasPost({ name: 'X' }, '120000000000797')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not an Instant Experience/) })
    h.answers.push(json({ id: '120000000000796', owner: { id: PAGE } }))
    expect(await canvasPost({ name: 'X' }, '120000000000796')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    // Only reads went out after the first two changes: no token read, no change.
    expect(h.calls.every((c) => c.init.method === 'GET' && new URL(c.url).searchParams.get('fields') === 'id,owner,is_published')).toBe(true)
  })
  it('ids inside a part: a photo, a post, a video, an Instagram media, a lead form of the business\'s own; anything else refused before the token', async () => {
    const one = async (params: Record<string, string>, answers: Array<() => Response>) => {
      __metaObjectLimitsTest.useMemory()
      __rateTest.useMemory()
      h.calls = []
      h.answers.push(...answers)
      return make(params)
    }
    // A photo of the chosen Page (from, width, height).
    expect((await one(part('canvas_photo', { photo_id: PHOTO }), [json({ id: PHOTO, from: { id: PAGE }, width: 1080, height: 1080 }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect(await one(part('canvas_photo', { photo_id: PHOTO }), [json({ id: PHOTO, from: { id: OTHER_PAGE }, width: 1080, height: 1080 })])).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    // A post: <page>_<post> of the chosen Page by its id alone; a photo or video it posted by `from`.
    expect((await one(part('canvas_existing_post', { source_facebook_post_id: `${PAGE}_500000000000001` }), [tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect(await one(part('canvas_existing_post', { source_facebook_post_id: `${OTHER_PAGE}_500000000000001` }), [])).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    // Gap 46b (the live read of 2026-10-26) — the owner read id,from{id} goes with the chosen Page's own token (token first).
    expect((await one(part('canvas_existing_post', { source_facebook_post_id: PHOTO }), [tokenAnswer(), json({ id: PHOTO, from: { id: PAGE } }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect(new URL(h.calls[1].url).searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(await one(part('canvas_existing_post', { source_facebook_post_id: PHOTO }), [tokenAnswer(), json({ id: PHOTO, from: { id: OTHER_PAGE } })])).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    // An Instagram media of the chosen account: its owner, else its username against the account's own.
    expect((await one(part('canvas_existing_post', { source_instagram_media_id: MEDIA }), [json({ id: MEDIA, owner: { id: IG } }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect((await one(part('canvas_existing_post', { source_instagram_media_id: MEDIA }), [json({ id: MEDIA, username: 'shop_a' }), json({ id: IG, username: 'Shop_A' }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect(await one(part('canvas_existing_post', { source_instagram_media_id: MEDIA }), [json({ id: MEDIA, owner: { id: '17841400000000099' } })])).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    // A video the Page posted, else one of the chosen ad account's library.
    expect((await one(part('canvas_video', { video_id: VIDEO }), [tokenAnswer(), json({ id: VIDEO, from: { id: PAGE } }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect((await one(part('canvas_video', { video_id: VIDEO }), [tokenAnswer(), json({ id: VIDEO }), json({ data: [{ id: VIDEO }] }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect(sent(2).url.pathname).toBe('/v26.0/act_1234567890/advideos')
    expect(await one(part('canvas_video', { video_id: VIDEO }), [tokenAnswer(), json({ id: VIDEO, from: { id: OTHER_PAGE } }), json({ data: [] })])).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    // A lead form of the chosen Page.
    expect((await one(part('canvas_lead_form', { leadgen_data_id: FORM }), [json({ id: FORM, page_id: PAGE, questions: [{ type: 'EMAIL' }] }), tokenAnswer(), json({ id: PART })])).ok).toBe(true)
    expect(await one(part('canvas_lead_form', { leadgen_data_id: FORM }), [json({ id: FORM, page_id: OTHER_PAGE, questions: [{ type: 'EMAIL' }] })])).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    // Another Instant Experience a button links to: of the chosen Page.
    const linked = part('canvas_button', { rich_text: { plain_text: 'More' }, button_style: 'BUTTON_FILLED', open_url_action: { url: `https://fb.com/canvas_doc/${OTHER_CANVAS}` } })
    expect(await one(linked, [json({ id: OTHER_CANVAS, owner: { id: OTHER_PAGE }, is_published: true })])).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/inside this change/) })
    // No Instagram account chosen: no media is named.
    delete gatewayMetaInstagram['m-1']
    expect(await one(part('canvas_existing_post', { source_instagram_media_id: MEDIA }), [])).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
  })
  it('a product set or catalog item: step 18\'s ONE catalog rule (one memo per call); its refusal sends nothing', async () => {
    h.answers.push(tokenAnswer(), json({ id: PART }))
    expect((await make(part('canvas_product_set', EVERY_PART.canvas_product_set))).ok).toBe(true)
    expect(h.catalog).toHaveBeenCalledWith({ connectionId: 'm-1', adAccountId: '1234567890' }, { productSetId: SET }, expect.any(Object))
    h.catalog.mockClear()
    __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ id: PHOTO, from: { id: PAGE }, width: 10, height: 10 }), tokenAnswer(), json({ id: PART }))
    expect((await make(part('canvas_photo', EVERY_PART.canvas_photo))).ok).toBe(true)
    expect(h.catalog).toHaveBeenCalledWith({ connectionId: 'm-1', adAccountId: '1234567890' }, { productItemId: ITEM }, expect.any(Object))
    h.calls = []
    h.catalog.mockResolvedValueOnce('That catalog belongs to a business portfolio another business in Nexus uses, so it is not read here.')
    expect(await make(part('canvas_product_list', EVERY_PART.canvas_product_list))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, That catalog belongs to a business portfolio another business/) })
    expect(h.calls).toHaveLength(0)
  })
  it('review A-1 — a Page\'s own limit (80001, step 36\'s 80005) on a change made as the Page holds nothing of the ad account: a pause still goes; a real throttle holds', async () => {
    gatewayMetaStored['120000000000001'] = { adAccountId: '1234567890', kind: 'campaign' }
    const pause = () => metaWriteCall({ connectionId: 'm-1', operation: 'status.change', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: false }).catch((e) => e)
    for (const code of [80001, 80005]) {
      // Each round its own: Meta's one change of an object every 30 s (the pause of the round before) is not what is tested,
      // nor the Page's own bucket the round before held (step 38 review S1: a change made as the Page pays the `page` bucket).
      __metaObjectLimitsTest.useMemory()
      __rateTest.useMemory()
      h.calls = []
      h.answers.push(tokenAnswer(), json({ error: { code, message: 'There have been too many calls to this Page account. Wait a bit and try again.' } }, 400))
      const refused = await make(part('canvas_text', EVERY_PART.canvas_text))
      expect(refused.ok, String(code)).toBe(false)
      expect(refused.verdict, String(code)).toMatchObject({ errorClass: 'rate_limited', channelCode: String(code) })
      // The business's other Meta changes go on at once — a pause above all.
      h.answers.push(json({ success: true }))
      expect((await pause()).ok, String(code)).toBe(true)
      expect(h.calls.map((c) => c.init.method), String(code)).toEqual(['GET', 'POST', 'POST'])
    }
    // A real throttle on a change made as the Page (code 4, the app's own limit) still holds the bucket: the pause is not sent.
    __metaObjectLimitsTest.useMemory()
    __rateTest.useMemory()
    h.calls = []
    h.answers.push(tokenAnswer(), json({ error: { code: 4, message: 'Application request limit reached' } }, 400))
    expect((await make(part('canvas_text', EVERY_PART.canvas_text))).ok).toBe(false)
    expect(await pause()).toMatchObject({ code: 'RATE_LIMITED_LOCAL' })
    expect(h.calls).toHaveLength(2)
    delete gatewayMetaStored['120000000000001']
  })
  it('the gateway\'s refusal for a canvas route of another kind names the Instant Experience tools', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/${PAGE}/canvases`, method: 'POST', body: form({ name: 'X', body_element_ids: JSON.stringify([PART]), is_published: 'false' }), metaObjectKind: 'campaign' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/create-meta-instant-experience/) })
    expect(h.calls).toHaveLength(0)
  })
})
