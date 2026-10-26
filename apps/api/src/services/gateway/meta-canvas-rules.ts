/**
 * Meta step 27b (2026-10-21) — the write allow-list entries of create-meta-instant-experience and
 * set-meta-instant-experience (Instant Experiences, once called "canvases"): EXACT keys, every value judged — enums by
 * list, booleans as `true` / `false`, JSON values in ONE spelling (the string judged is the string sent:
 * `JSON.stringify(JSON.parse(v)) === v`) with every key at every depth on a list, text only where a person types it,
 * links https only. Every rule here is `auth: 'page'` (step 36's Page token mode, the ONE mode): it goes with the
 * business's CHOSEN Facebook Page's own token, which the gateway reads for that one call (meta-page-token.ts), and only for
 * an object the gateway confirmed is that Page or an Instant Experience of it (meta-page-owner.ts), with every id inside
 * the body checked there too.
 *
 * Checked 2026-10-21 (curl ≥3 s apart; Meta's Python Business SDK main as the fallback):
 *   - documentation/ads-commerce/marketing-api/guides/instant-experiences.md: permissions pages_manage_ads,
 *     pages_read_engagement, pages_show_list and the Page's ADVERTISE task; "You can only update an unpublished Instant
 *     Experience"; "available for Instagram on a limited basis"; not for Facebook Stories; create
 *     `POST /{page_id}/canvases` (background_color, body_element_ids, is_hidden, is_published, name); publish
 *     `POST /{canvas_id}` is_published; "Delete an element": `DELETE /{canvas_element_id}` (step 22's rule); the five
 *     templates (AR only in Ads Manager); Instagram limits per element (store locator not supported; a button cannot link to
 *     another Instant Experience or the App Store; a carousel photo's link to one is not clickable; no RTL text; no 360
 *     video).
 *   - docs/graph-api/reference/page/canvas_elements/ (v26.0): Creating — ONE of canvas_button, canvas_carousel,
 *     canvas_existing_post, canvas_footer, canvas_header, canvas_lead_form, canvas_photo, canvas_product_list,
 *     canvas_product_set, canvas_store_locator, canvas_template_video, canvas_text, canvas_video per call, each an Object
 *     whose keys are listed there (they are the judges below); return {id}, read-after-write; errors 100, 368, 200, 80001
 *     ("too many calls to this Page account"), 190, 283; Updating and Deleting: "You can't perform this operation on this
 *     endpoint".
 *   - docs/graph-api/reference/page/canvases/ (v26.0): Creating needs "A Page access token" and pages_show_list,
 *     pages_manage_posts, pages_read_user_content; params background_color (default FFFFFFFF), body_element_ids,
 *     enable_swipe_to_open, hero_asset_facebook_post_id, hero_asset_instagram_media_id, is_hidden, is_published (default
 *     false), name (default "Untitled Canvas"), source_template_id; return {id}; errors 105, 100, 200.
 *   - docs/graph-api/reference/canvas/ (v26.0): Updating `POST /{canvas_id}` with the same nine params ("is_hidden: Field
 *     used to hide a (published) canvas"), return {success}; Deleting: "You can't perform this operation on this
 *     endpoint" (and SDK canvas.py has no api_delete) — so Nexus deletes no Instant Experience: LIVE-PROBES IX27b-03.
 *   - docs/graph-api/reference/canvas-button, canvas-text, canvas-photo, canvas-product-set, canvas-rich-text
 *     (block_type, inline_styles, plain_text), canvas-open-url-action (url).
 *   - documentation/ads-commerce/marketing-api/creative/collection-ads.md: the worked element calls — rich_text
 *     {"plain_text": …}, open_url_action {"url": …}, canvas_product_set with show_in_feed, image_overlay_spec in lower case,
 *     storefront_setting {enable_sections, customized_section_titles [{title_id, customized_title}], product_set_layout
 *     {layout_type GRID_2COL | GRID_3COL | CAROUSEL | HSCROLL_LIST}}, canvas_template_video's template_video_spec
 *     {customization {text_color, text_background_color, name_template, body_template}}, a footer's child_elements.
 *   - documentation/ads-commerce/marketing-api/ad-creative/partnership-ads/ads-creation/supported-configurations/
 *     advantage-catalog-ads.md: canvas_existing_post {source_instagram_media_id | source_facebook_post_id} and the canvas's
 *     hero_asset_* (an existing Facebook or Instagram media, photo or video).
 *   - SDK page.py create_canvas_element (13 Object params, no enums) and create_canvase (body_element_ids list<string>,
 *     the booleans bool, the hero ids and source_template_id string); canvas.py api_update (the same nine).
 * Left out on purpose (each answers in words, here and in the tool): deep_link (an app link: Nexus has no app),
 * destination_set_id (review B-3: the collection-ads guide's "Including destination catalogs" puts it on canvas_photo — it
 * names a set of a travel destination catalog, which Nexus has none of and cannot check), retailer_item_ids (the
 * advertiser's own product ids, which the catalog rule cannot check — step 25's choice), image_overlay_spec.text_template_tags
 * (review B-7: array<string> on the reference, not offered yet — no guide shows a value), rich-text styles block_type /
 * inline_styles (not documented for writing), and a delete of an Instant Experience (Meta documents none).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-write-text.js'
import { metaPublicLinkProblem } from './meta-media-rules.js'
import { META_OWNED_HOST, metaCreativeTextProblem } from './meta-creative-rules.js'
// Gap 46b — the five template ids live in the leaf list (the gateway's Page-token read of a template names them too).
import { META_IX_TEMPLATE_IDS as IX_TEMPLATE_IDS } from '../meta/meta-media-lists.js'

type Params = ReadonlyMap<string, string>
type Row = Record<string, unknown>
/** Why a value is not one Nexus sends, or null; the ids inside it are collected for the gateway's owner check. */
type Judge = (value: unknown, where: string, ids: MetaWriteBodyId[]) => string | null

/** The parts Meta's canvas_elements edge makes, one per call (reference "Creating"). */
export const META_CANVAS_ELEMENT_KEYS = [
  'canvas_button', 'canvas_carousel', 'canvas_existing_post', 'canvas_footer', 'canvas_header', 'canvas_lead_form', 'canvas_photo',
  'canvas_product_list', 'canvas_product_set', 'canvas_store_locator', 'canvas_template_video', 'canvas_text', 'canvas_video',
] as const
export type MetaCanvasElementKey = typeof META_CANVAS_ELEMENT_KEYS[number]

/**
 * The template ids the instant-experiences guide names (step 10's IX_TEMPLATES holds the same five by name: a test keeps
 * them equal). The AR template is Ads Manager only. Gap 46b: one list, services/meta/meta-media-lists.ts.
 */
export const META_IX_TEMPLATE_IDS: readonly string[] = IX_TEMPLATE_IDS

export const META_CANVAS_BUTTON_STYLES = ['BUTTON_OUTLINE', 'BUTTON_FILLED'] as const
export const META_CANVAS_ALIGNMENTS = ['LEFT', 'CENTER', 'RIGHT'] as const
export const META_CANVAS_PHOTO_STYLES = ['FIT_TO_WIDTH', 'FIT_TO_WIDTH_EXPANDABLE', 'FIT_TO_HEIGHT'] as const
export const META_CANVAS_MEDIA_STYLES = ['FIT_TO_WIDTH', 'FIT_TO_HEIGHT'] as const
export const META_CANVAS_LAYOUTS = ['GRID_2COL', 'GRID_3COL', 'CAROUSEL', 'HSCROLL_LIST'] as const
/** customized_section_titles[].title_id (collection-ads guide). */
export const META_CANVAS_SECTION_TITLES = [
  'keep_shopping', 'take_another_look', 'you_may_also_like', 'related_products', 'trending', 'popular', 'top_items', 'favorites', 'most_viewed',
  'top_picks_for_you', 'suggested_for_you', 'featured_favorites', 'just_for_you', 'explore_more', 'shop_by_category',
] as const
/**
 * image_overlay_spec on a product set part: the canvas_elements reference lists these values in UPPER case, the
 * collection-ads guide's worked call (and AdCreativeLinkDataImageOverlaySpec, step 25's list) in lower case — Nexus sends
 * the guide's lower case; LIVE-PROBES IX27b-05 settles it.
 */
export const META_CANVAS_OVERLAY = {
  overlay_template: ['pill_with_text', 'circle_with_text', 'triangle_with_text'],
  text_type: ['price', 'strikethrough_price', 'percentage_off', 'custom', 'from_price', 'disclaimer', 'guest_rating', 'star_rating', 'sustainable', 'automated_personalize'],
  text_font: ['droid_serif_regular', 'lato_regular', 'nunito_sans_bold', 'open_sans_bold', 'open_sans_condensed_bold', 'pt_serif_bold', 'roboto_medium', 'roboto_condensed_regular', 'noto_sans_regular', 'dynads_hybrid_bold'],
  position: ['top_left', 'top_right', 'bottom_left', 'bottom_right'],
  theme_color: [
    'background_e50900_text_ffffff', 'background_f78400_text_ffffff', 'background_00af4c_text_ffffff', 'background_0090ff_text_ffffff',
    'background_755dde_text_ffffff', 'background_f23474_text_ffffff', 'background_595959_text_ffffff', 'background_000000_text_ffffff',
    'background_ffffff_text_c91b00', 'background_ffffff_text_f78400', 'background_ffffff_text_009c2a', 'background_ffffff_text_007ad0',
    'background_ffffff_text_755dde', 'background_ffffff_text_f23474', 'background_ffffff_text_646464', 'background_ffffff_text_000000',
  ],
  custom_text_type: ['free_shipping', 'popular', 'sale'],
} as const
/** The keys of template_video_spec.customization the collection-ads guide shows (the reference: "JSON object {string : string}"). */
export const META_CANVAS_TEMPLATE_VIDEO_KEYS = ['text_color', 'text_background_color', 'name_template', 'body_template'] as const

/**
 * Nexus's own caps (Meta documents none of these): far above a real Instant Experience, they keep a body bounded. One change
 * makes at most `elementsPerChange` parts: each is its own call made AS the Page, which Meta counts against the Page's own
 * rate limit (80001), and Meta has no all-or-nothing request.
 */
export const META_CANVAS_LIMITS = {
  name: 200, text: 2000, buttonText: 200, token: 200, font: 64, children: 10, productIds: 20, sectionTitles: 15, sectionTitle: 100,
  bodyElements: 50, elementsPerChange: 20, maxItems: 50, padding: 500, fontSizeMin: 6, fontSizeMax: 72, lineHeightMin: 0.5, lineHeightMax: 5, link: 1000,
} as const
/** The longest body of one part or of an Instant Experience's create or edit. */
export const META_CANVAS_MAX_BODY = 20_000

/** An Instant Experience's link (`https://fb.com/canvas_doc/<id>`, collection-ads guide; step 25's one form; review A-5: no leading zero). */
export const META_CANVAS_LINK = /^https:\/\/fb\.com\/canvas_doc\/([1-9]\d{0,19})$/

const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const DIGITS = /^[1-9]\d{0,24}$/

// ── judges ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const text = (max: number, lines = false): Judge => (v, where) => (typeof v !== 'string' ? `${where} is text` : metaCreativeTextProblem(v, max, where, { lines }))
const oneOf = (values: readonly string[]): Judge => (v, where) => (typeof v === 'string' && values.includes(v) ? null : `${where} is one of ${values.join(', ')}`)
const boolean: Judge = (v, where) => (typeof v === 'boolean' ? null : `${where} is true or false`)
/** A colour as Meta writes it: RRGGBB or AARRGGBB, upper case (its defaults: FFFFFFFF, FF777777). */
export const META_CANVAS_COLOR = /^[0-9A-F]{6}([0-9A-F]{2})?$/
const color: Judge = (v, where) => (typeof v === 'string' && META_CANVAS_COLOR.test(v) ? null : `${where} is a colour as Meta writes it (RRGGBB or AARRGGBB, upper case)`)
/**
 * Review B-6 — the same colour? Meta writes 8 hex digits (AARRGGBB: its default FFFFFFFF) while its guide sends 6 (RRGGBB):
 * a 6-digit value is FF (opaque) + the 6 digits. Case aside; anything that is not a colour is never the same.
 */
export function metaCanvasColorSame(a: unknown, b: unknown): boolean {
  const full = (v: unknown) => {
    const upper = typeof v === 'string' ? v.toUpperCase() : ''
    return META_CANVAS_COLOR.test(upper) ? (upper.length === 6 ? `FF${upper}` : upper) : null
  }
  const x = full(a)
  return x !== null && x === full(b)
}
/** A font as Meta names one (`sans-serif`, `HelveticaNeue-Light`). */
export const META_CANVAS_FONT = /^[A-Za-z][A-Za-z0-9 -]{0,63}$/
const font: Judge = (v, where) => (typeof v === 'string' && META_CANVAS_FONT.test(v) ? null : `${where} is a font name (letters, digits, space and -; at most ${META_CANVAS_LIMITS.font})`)
const number = (min: number, max: number, integer = false): Judge => (v, where) => (
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)) ? null : `${where} is a${integer ? ' whole' : ''} number from ${min} to ${max}`)
const padding = number(0, META_CANVAS_LIMITS.padding)
const refuse = (why: string): Judge => (_v, where) => `${where}: ${why}`

/** An id of this kind, collected for the gateway's owner check (meta-page-owner.ts). */
const id = (kind: MetaWriteBodyId['kind'], shape: RegExp = DIGITS): Judge => (v, where, ids) => {
  if (typeof v !== 'string' || !shape.test(v)) return `${where} is a Meta id (digits, as text)`
  ids.push({ id: v, kind })
  return null
}
/** A Facebook post or media of the chosen Page: `<page id>_<post id>`, or a photo's or video's own id (digits; LIVE-PROBES IX27b-04). */
const POST_ID = /^[1-9]\d{0,24}(_[1-9]\d{0,24})?$/
const postId = id('pagepost', POST_ID)

/** A link a part opens: a public https website (step 23's link rule), or exactly another Instant Experience of the chosen Page. */
const link: Judge = (v, where, ids) => {
  if (typeof v !== 'string') return `${where} is an https link`
  let url: URL | null = null
  try { url = new URL(v) } catch { url = null }
  if (url && META_OWNED_HOST.test(url.hostname)) {
    const canvas = META_CANVAS_LINK.exec(v)
    if (!canvas) return `${where}: a link to one of Meta's own sites is exactly another Instant Experience of the chosen Page (https://fb.com/canvas_doc/<id>); name the website itself otherwise`
    ids.push({ id: canvas[1], kind: 'canvas' })
    return null
  }
  return metaPublicLinkProblem(v, where, META_CANVAS_LIMITS.link)
}
/** A picture or video Meta fetches into the part: a public https link, never one of Meta's own (they host the file themselves). */
const fetched: Judge = (v, where) => {
  if (typeof v !== 'string') return `${where} is an https link`
  const problem = metaPublicLinkProblem(v, where, META_CANVAS_LIMITS.link)
  if (problem) return problem
  return /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com)$/.test(new URL(v).hostname) || META_OWNED_HOST.test(new URL(v).hostname)
    ? `${where}: Meta says not to use links it returned ("host the image on your own servers"): name a photo or video already on the chosen Page instead`
    : null
}

/** The object has only these keys, and the required ones; each judged. A key Nexus answers in words says so. */
function shape(o: unknown, where: string, ids: MetaWriteBodyId[], judges: Readonly<Record<string, Judge>>, required: readonly string[] = []): string | null {
  if (!isObj(o)) return `${where} is an object`
  for (const k of Object.keys(o)) if (!Object.prototype.hasOwnProperty.call(judges, k)) return `${where} has no key "${k.slice(0, 40)}" Nexus sends`
  for (const k of required) if (!(k in o)) return `${where} names ${k}`
  for (const [k, v] of Object.entries(o)) {
    const problem = judges[k](v, `${where}.${k}`, ids)
    if (problem) return problem
  }
  return null
}
const obj = (judges: Readonly<Record<string, Judge>>, required: readonly string[] = []): Judge => (v, where, ids) => shape(v, where, ids, judges, required)
/** A list of 1..max items, each judged; `unique`: no item twice. */
const list = (max: number, item: Judge, unique = false): Judge => (v, where, ids) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return `${where} is a list of 1 to ${max}`
  if (unique && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return `${where} names each one once`
  for (const [i, x] of v.entries()) {
    const problem = item(x, `${where}[${i}]`, ids)
    if (problem) return problem
  }
  return null
}
/** Exactly one of these keys is present. */
const oneKeyOf = (o: unknown, keys: readonly string[], where: string): string | null =>
  isObj(o) && keys.filter((k) => k in o).length === 1 ? null : `${where} names exactly one of ${keys.join(', ')}`

const NO_APP = 'Nexus sells online and has no app of its own, so it sends no app link (deep_link)'
// Review B-3 — collection-ads guide, "Including destination catalogs": destination_set_id on canvas_photo.
const NO_DESTINATION_SET = 'destination_set_id names a set of a travel destination catalog (Meta\'s collection-ads guide, "Including destination catalogs": destination and hotel images), which this business has none of and Nexus cannot check, so it sends none'
const NO_RETAILER_IDS = 'Meta takes retailer_item_ids as the advertiser\'s own product ids, and Nexus cannot check a retailer id against the catalog rule: the product set (product_set_id) names the products'
// Review B-7 — image_overlay_spec.text_template_tags (array<string> on the reference): no guide shows a value.
const NO_TEMPLATE_TAGS = 'Nexus does not offer an overlay\'s text_template_tags yet (Meta\'s reference types it array<string>; no guide shows a value Nexus could check)'
/** The fields Meta takes that Nexus leaves out on purpose, each with why (the tool refuses them in the same words). */
export const META_CANVAS_LEFT_OUT: Readonly<Record<'deep_link' | 'destination_set_id' | 'retailer_item_ids' | 'text_template_tags', string>> = {
  deep_link: NO_APP, destination_set_id: NO_DESTINATION_SET, retailer_item_ids: NO_RETAILER_IDS, text_template_tags: NO_TEMPLATE_TAGS,
}
const PADDINGS = { top_padding: padding, bottom_padding: padding }
const RICH_TEXT = (max: number, lines: boolean) => obj({ plain_text: text(max, lines) }, ['plain_text'])
const OPEN_URL = obj({ url: link }, ['url'])
const CHILDREN = list(META_CANVAS_LIMITS.children, id('canvaselement'), true)

// ── the parts (reference page/canvas_elements, Creating) ──────────────────────────────────────────────────────────

const STYLED_TEXT = {
  text_alignment: oneOf(META_CANVAS_ALIGNMENTS), text_color: color, font_size: number(META_CANVAS_LIMITS.fontSizeMin, META_CANVAS_LIMITS.fontSizeMax, true),
  font_family: font, line_height: number(META_CANVAS_LIMITS.lineHeightMin, META_CANVAS_LIMITS.lineHeightMax), background_color: color, ...PADDINGS,
}

const PHOTO: Judge = (v, where, ids) => oneKeyOf(v, ['photo_id', 'photo_url'], where) ?? shape(v, where, ids, {
  name: text(META_CANVAS_LIMITS.name), photo_id: id('pagephoto'), photo_url: fetched, open_url_action: OPEN_URL, style: oneOf(META_CANVAS_PHOTO_STYLES),
  // Review B-4 — the canvas-photo reference: "x and y greater than zero and less than 1".
  product_tags: list(META_CANVAS_LIMITS.productIds, obj({ product_id: id('productitem'), coordinates: (c, w) => (Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && n > 0 && n < 1) ? null : `${w} is [x, y], each greater than 0 and less than 1`) }, ['product_id', 'coordinates']), true),
  hide_product_prices: boolean, deep_link: refuse(NO_APP), destination_set_id: refuse(NO_DESTINATION_SET), ...PADDINGS,
})

const VIDEO: Judge = (v, where, ids) => oneKeyOf(v, ['video_id', 'video_url'], where) ?? shape(v, where, ids, {
  name: text(META_CANVAS_LIMITS.name), video_id: id('canvasvideo'), video_url: fetched, style: oneOf(META_CANVAS_MEDIA_STYLES), ...PADDINGS,
})

const PRODUCT_SET: Judge = obj({
  name: text(META_CANVAS_LIMITS.name), product_set_id: id('productset'), max_items: number(1, META_CANVAS_LIMITS.maxItems, true), show_in_feed: boolean,
  item_headline: text(META_CANVAS_LIMITS.token), item_description: text(META_CANVAS_LIMITS.token),
  image_overlay_spec: obj({
    overlay_template: oneOf(META_CANVAS_OVERLAY.overlay_template), text_type: oneOf(META_CANVAS_OVERLAY.text_type), text_font: oneOf(META_CANVAS_OVERLAY.text_font),
    position: oneOf(META_CANVAS_OVERLAY.position), theme_color: oneOf(META_CANVAS_OVERLAY.theme_color), float_with_margin: boolean,
    custom_text_type: oneOf(META_CANVAS_OVERLAY.custom_text_type), text_template_tags: refuse(NO_TEMPLATE_TAGS),
  }, ['overlay_template', 'text_type', 'text_font', 'position', 'theme_color']),
  storefront_setting: (v, where, ids) => {
    const problem = shape(v, where, ids, {
      enable_sections: boolean,
      customized_section_titles: list(META_CANVAS_LIMITS.sectionTitles, obj({ title_id: oneOf(META_CANVAS_SECTION_TITLES), customized_title: text(META_CANVAS_LIMITS.sectionTitle) }, ['title_id', 'customized_title']), true),
      product_set_layout: obj({ layout_type: oneOf(META_CANVAS_LAYOUTS) }, ['layout_type']),
    })
    if (problem) return problem
    // collection-ads guide: "In order to use customized_section_titles, the enable_sections parameter must be set to true".
    return (v as Row).customized_section_titles !== undefined && (v as Row).enable_sections !== true ? `${where}: customized_section_titles go with enable_sections true (Meta's guide)` : null
  },
  retailer_item_ids: refuse(NO_RETAILER_IDS), ...PADDINGS,
}, ['product_set_id'])

/** One judge per part (the element's JSON object). */
export const META_CANVAS_ELEMENT_JUDGES: Readonly<Record<MetaCanvasElementKey, Judge>> = {
  canvas_button: obj({
    name: text(META_CANVAS_LIMITS.name), rich_text: RICH_TEXT(META_CANVAS_LIMITS.buttonText, false), button_style: oneOf(META_CANVAS_BUTTON_STYLES),
    open_url_action: OPEN_URL, button_color: color, deep_link: refuse(NO_APP), ...STYLED_TEXT,
  }, ['rich_text', 'button_style']),
  canvas_carousel: obj({ name: text(META_CANVAS_LIMITS.name), child_elements: CHILDREN, style: oneOf(META_CANVAS_MEDIA_STYLES), ...PADDINGS }, ['child_elements']),
  canvas_existing_post: (v, where, ids) => oneKeyOf(v, ['source_instagram_media_id', 'source_facebook_post_id'], where)
    ?? shape(v, where, ids, { source_instagram_media_id: id('instagrammedia'), source_facebook_post_id: postId }),
  canvas_footer: obj({ name: text(META_CANVAS_LIMITS.name), child_elements: CHILDREN, background_color: color }, ['child_elements']),
  canvas_header: obj({ name: text(META_CANVAS_LIMITS.name), child_elements: CHILDREN, background_color: color }, ['child_elements']),
  canvas_lead_form: obj({ name: text(META_CANVAS_LIMITS.name), leadgen_data_id: id('leadform'), ...PADDINGS }, ['leadgen_data_id']),
  canvas_photo: PHOTO,
  canvas_product_list: obj({
    name: text(META_CANVAS_LIMITS.name), product_id_list: list(META_CANVAS_LIMITS.productIds, id('productitem'), true),
    item_headline: text(META_CANVAS_LIMITS.token), item_description: text(META_CANVAS_LIMITS.token), ...PADDINGS,
  }, ['product_id_list']),
  canvas_product_set: PRODUCT_SET,
  canvas_store_locator: obj({ name: text(META_CANVAS_LIMITS.name), typeface: font, header_background_color: color }),
  canvas_template_video: obj({
    name: text(META_CANVAS_LIMITS.name), product_set_id: id('productset'),
    template_video_spec: obj({
      customization: obj({ text_color: color, text_background_color: color, name_template: text(META_CANVAS_LIMITS.token), body_template: text(META_CANVAS_LIMITS.token) }),
    }, ['customization']),
    ...PADDINGS,
  }, ['product_set_id', 'template_video_spec']),
  canvas_text: obj({ name: text(META_CANVAS_LIMITS.name), rich_text: RICH_TEXT(META_CANVAS_LIMITS.text, true), ...STYLED_TEXT }, ['rich_text']),
  canvas_video: VIDEO,
}

/** A form value as JSON in exactly Nexus's spelling (the string judged is the string sent), or why not. */
function json(value: string, where: string): { value: unknown } | { problem: string } {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return { problem: `${where} is JSON` } }
  if (JSON.stringify(parsed) !== value) return { problem: `${where} is JSON in one spelling only (no spaces, no escapes Nexus does not write)` }
  return { value: parsed }
}

/** One part's create (POST /{page_id}/canvas_elements): its key, its object and the ids inside it, or why it is refused. */
export function metaCanvasElementOf(params: Params): { key: MetaCanvasElementKey; value: Row; ids: MetaWriteBodyId[] } | { problem: string } {
  const keys = [...params.keys()]
  if (keys.length !== 1 || !(META_CANVAS_ELEMENT_KEYS as readonly string[]).includes(keys[0])) return { problem: `a part of an Instant Experience is made one per call: exactly one of ${META_CANVAS_ELEMENT_KEYS.join(', ')}` }
  const key = keys[0] as MetaCanvasElementKey
  const parsed = json(params.get(key)!, key)
  if ('problem' in parsed) return parsed
  const ids: MetaWriteBodyId[] = []
  const problem = META_CANVAS_ELEMENT_JUDGES[key](parsed.value, key, ids)
  return problem ? { problem } : { key, value: parsed.value as Row, ids }
}

// ── the Instant Experience itself (page/canvases, canvas) ──────────────────────────────────────────────────────────

const CANVAS_BOOLEANS = ['enable_swipe_to_open', 'is_hidden'] as const

/** The values of a canvas create or edit, or why one is refused; `ids` collects the ids inside. */
function canvasFieldsProblem(params: Params, ids: MetaWriteBodyId[]): string | null {
  if (params.has('name')) {
    const problem = text(META_CANVAS_LIMITS.name)(params.get('name'), 'name', ids)
    if (problem) return problem
  }
  if (params.has('background_color')) {
    const problem = color(params.get('background_color'), 'background_color', ids)
    if (problem) return problem
  }
  for (const k of CANVAS_BOOLEANS) if (params.has(k) && !['true', 'false'].includes(params.get(k)!)) return `${k} is true or false`
  if (params.has('body_element_ids')) {
    const parsed = json(params.get('body_element_ids')!, 'body_element_ids')
    if ('problem' in parsed) return parsed.problem
    const problem = list(META_CANVAS_LIMITS.bodyElements, id('canvaselement'), true)(parsed.value, 'body_element_ids', ids)
    if (problem) return problem
  }
  if (params.has('hero_asset_facebook_post_id') && params.has('hero_asset_instagram_media_id')) return 'an Instant Experience has one hero asset: a Facebook post or an Instagram media, not both'
  if (params.has('hero_asset_facebook_post_id')) {
    const problem = postId(params.get('hero_asset_facebook_post_id'), 'hero_asset_facebook_post_id', ids)
    if (problem) return problem
  }
  if (params.has('hero_asset_instagram_media_id')) {
    const problem = id('instagrammedia')(params.get('hero_asset_instagram_media_id'), 'hero_asset_instagram_media_id', ids)
    if (problem) return problem
  }
  if (params.has('source_template_id') && !META_IX_TEMPLATE_IDS.includes(params.get('source_template_id')!)) {
    return `source_template_id is one of the templates Meta's guide names (${META_IX_TEMPLATE_IDS.join(', ')}); the AR template is Ads Manager only`
  }
  return null
}

/** The values of a canvas create (POST /{page_id}/canvases), or why one is refused. */
export function metaCanvasCreateProblem(params: Params): string | null {
  if (params.get('is_published') !== 'false') return 'Nexus makes an Instant Experience UNPUBLISHED (is_published=false): publishing is its own change (set-meta-instant-experience action publish), because a published one can never be edited'
  return canvasFieldsProblem(params, [])
}
/** The values of a canvas edit (POST /{canvas_id}, unpublished only), or why one is refused. */
export const metaCanvasUpdateProblem = (params: Params): string | null => canvasFieldsProblem(params, [])

const canvasIds = (params: Params): MetaWriteBodyId[] => {
  const ids: MetaWriteBodyId[] = []
  return canvasFieldsProblem(params, ids) ? [] : ids
}
const elementIds = (params: Params): MetaWriteBodyId[] => {
  const element = metaCanvasElementOf(params)
  return 'problem' in element ? [] : element.ids
}

/** The keys of a part's create whose value holds text a person types (the JSON string; the judges check each text inside). */
const ELEMENT_TEXT: Readonly<Record<string, RegExp>> = Object.fromEntries(META_CANVAS_ELEMENT_KEYS.map((k) => [k, META_NAME_TEXT]))
/** The canvas fields of an edit (never is_published / is_hidden: those are their own changes). */
export const META_CANVAS_EDIT_KEYS = ['name', 'background_color', 'body_element_ids', 'enable_swipe_to_open', 'hero_asset_facebook_post_id', 'hero_asset_instagram_media_id', 'source_template_id'] as const

/** Step 27b — the Instant Experience rules (gateway meta-calls.ts writeRules). Every one goes with the chosen Page's token. */
export const META_CANVAS_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // create-meta-instant-experience / set-meta-instant-experience edit: ONE part on the chosen Page (CR-473 … CR-485).
    name: 'canvas.element.create',
    method: 'POST',
    path: /^\d{1,25}\/canvas_elements$/,
    kinds: ['page'],
    auth: 'page',
    required: [],
    optional: [...META_CANVAS_ELEMENT_KEYS],
    anyOf: [...META_CANVAS_ELEMENT_KEYS],
    text: ELEMENT_TEXT,
    maxBody: META_CANVAS_MAX_BODY,
    values: (params) => { const element = metaCanvasElementOf(params); return 'problem' in element ? element.problem : null },
    ids: elementIds,
    // A new part on the Page's edge edits no object: no 30-s per-object gap (step 23's edgeCall).
    edgeCall: true,
    budget: false,
  },
  {
    // create-meta-instant-experience: the Instant Experience itself, UNPUBLISHED, from the parts this change made (CR-488).
    name: 'canvas.create',
    method: 'POST',
    path: /^\d{1,25}\/canvases$/,
    kinds: ['page'],
    auth: 'page',
    required: ['name', 'body_element_ids', 'is_published'],
    optional: ['background_color', 'enable_swipe_to_open', 'is_hidden', 'hero_asset_facebook_post_id', 'hero_asset_instagram_media_id', 'source_template_id'],
    text: { name: META_NAME_TEXT },
    maxBody: META_CANVAS_MAX_BODY,
    values: metaCanvasCreateProblem,
    ids: canvasIds,
    edgeCall: true,
    budget: false,
  },
  {
    // set-meta-instant-experience edit: an unpublished Instant Experience of the chosen Page (CR-491).
    name: 'canvas.update',
    method: 'POST',
    path: /^\d{1,25}$/,
    kinds: ['canvas'],
    auth: 'page',
    required: [],
    optional: [...META_CANVAS_EDIT_KEYS],
    anyOf: [...META_CANVAS_EDIT_KEYS],
    text: { name: META_NAME_TEXT },
    maxBody: META_CANVAS_MAX_BODY,
    values: metaCanvasUpdateProblem,
    ids: canvasIds,
    budget: false,
  },
  {
    // set-meta-instant-experience publish: ONE way (CR-492) — its own change, with its own approval.
    name: 'canvas.publish',
    method: 'POST',
    path: /^\d{1,25}$/,
    kinds: ['canvas'],
    auth: 'page',
    required: ['is_published'],
    optional: [],
    values: (params) => (params.get('is_published') === 'true' ? null : 'a publish sends is_published=true only (Nexus never un-publishes: Meta documents no way back)'),
    budget: false,
  },
  {
    // set-meta-instant-experience hide / show again (CR-493; no delete exists).
    name: 'canvas.hidden',
    method: 'POST',
    path: /^\d{1,25}$/,
    kinds: ['canvas'],
    auth: 'page',
    required: ['is_hidden'],
    optional: [],
    values: (params) => (['true', 'false'].includes(params.get('is_hidden') ?? '') ? null : 'is_hidden is true or false'),
    budget: false,
  },
]
