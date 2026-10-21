/**
 * Meta step 25 (2026-10-21) — the write allow-list entries of create-meta-creative and set-meta-creative, and THE one judge
 * of a creative's parameters (the tool builds with it, the gateway judges with it: one implementation, never a copy).
 *
 *   adaccount.creative.create   POST /act_<id>/adcreatives        a creative of the chosen ad account (and Meta's check of
 *                                                                 it: validate_only IS documented on this edge)
 *   adaccount.creative.async    POST /act_<id>/asyncadcreatives   the same creative as Meta's asynchronous job (M5-33)
 *   creative.update             POST /<creative id>               name, status, adlabels — all Meta lets change (CR-010/011)
 *   creative.adlabels           POST /<creative id>/adlabels      labels added (CR-009)
 *   creative.remove             DELETE /<creative id>             create-meta-creative's undo of a creative it made NEW
 *                                                                 (lane C1's step 22 reuses it for an explicit delete)
 *
 * Every JSON spec is an ALLOW-list at every depth (CREATIVE_KEYS below): a key not named at its depth is refused, a value
 * is judged by its own judge (a person's text — any language, accents, €, emoji, but no bidirectional control and at least
 * one visible character; a link — https, a public host, no key or signature in it; an id — digits; an enum — Meta's own
 * list), a JSON value is written in ONE spelling (exactly as JSON.stringify writes what was judged: no duplicate member, no
 * other number form, no escape Nexus would not write). Each id inside a creative is handed to the gateway as an asset, which
 * checks it before anything is sent (gateway.ts metaMediaAssetsProblem): the identity Page and Instagram account are the
 * business's CHOSEN ones (a partnership ad's partner only beside the chosen one, never another Nexus business's), an image
 * hash is in the chosen account's library, a video in its video library, a post / Instant Experience / lead form / event is
 * the chosen Page's (an upcoming event the chosen Instagram account's). Catalog and product-set ids are refused in words
 * until lane C1's catalog rule (step 18) is on this base: C2-REBASE-18.
 *
 * The silent features (lane prompt, binding): every creative Nexus sends carries an explicit `enroll_status` for EVERY
 * Advantage+ creative feature Meta names (META_CREATIVE_FEATURES), `contextual_multi_ads`, `format_transformation_spec` for
 * every format, `asset_feed_spec.audios` and `destination_spec` — the gateway refuses a creative without one of them.
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart; .md pages under developers.facebook.com/documentation/ads-commerce/marketing-api/):
 *   - reference/ad-account/adcreatives.md "Creating": the parameter table (actor_id … wamo_whatsapp_identity_spec);
 *     execution_options list<enum{validate_only}>; "if the object_story_id being used is already in use by an existing
 *     creative, then the API will return the value of the existing creative_id".
 *   - reference/ad-creative.md: the read fields (NO created_time on an AdCreative: "was it new?" is read from the creative's
 *     own unpublished post, change-creatives.ts); "Updating" name / adlabels / status / account_id; "Deleting" DELETE
 *     /<creative id> → {success}; "If you try to add an creative that isn't unique, we do not generate it and return the
 *     creative ID of the existing ad creative".
 *   - creative/advantage-creative/get-started.md: the Features table (23 keys), "Default is opt-in" (adapt_to_placement),
 *     ineligible opt-ins "automatically removed", "To confirm the final configuration, use a GET", music "pass the
 *     assest_feed_spec.audios parameter in as empty" to opt out, AI features "you must create the ad with a PAUSED status",
 *     standard enhancements "opt-in and preview functionality … deprecated" since v22.
 *   - creative/generative-ai-features.md: `text_generation` (with `message` in object_story_spec), image_uncrop,
 *     image_background_gen.
 *   - docs/marketing-api/reference/ad-creative-features-spec/ (HTML): the 46 feature keys of META_FEATURES_SPEC_REFERENCE.
 *   - ad-creative/messaging-ads/click-to-messenger.md: page_welcome_message as text, a VISUAL_EDITOR object (ice breakers ≤ 80 /
 *     300 characters, message ≤ 300) or a list of up to 5 templates (Click to Subscribe); partner flows by
 *     asset_feed_spec.additional_data.partner_app_welcome_message_flow_id.
 *   - ad-creative/threads-ads/creation.md: a Threads ad runs through the business's Instagram account ("that Instagram
 *     account needs to be used"): Nexus sends no threads_user_id.
 *   - Meta's Python Business SDK main (facebook_business/adobjects): adcreative.py, adcreativeobjectstoryspec.py,
 *     adcreativelinkdata.py (+ child attachment, call to action, image overlay / layer specs), adcreativephotodata.py,
 *     adcreativevideodata.py, adassetfeedspec.py (+ its parts), adcreativefeaturesspec.py, adcreativefeaturedetails.py,
 *     adcreativesourcingspec.py, adcreativesitelinksspec.py, adcreativedestinationspec.py, adcustomizationrulespec.py,
 *     adasyncrequestset.py, adaccount.py create_async_ad_creative (creative_spec, name, notification_mode,
 *     notification_uri) — the keys and enums below.
 */
import type { MetaWriteAsset, MetaWriteRule } from './meta-calls.js'
import { BIDI_CONTROLS, META_MEDIA_TEXT_PATTERN, metaPublicLinkProblem, VISIBLE } from './meta-media-rules.js'

// ── the silent features ─────────────────────────────────────────────────────────────────────────────────────────────

/** Read 2026-10-21 at https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/ (46 keys). */
export const META_FEATURES_SPEC_REFERENCE = [
  'adapt_to_placement', 'add_text_overlay', 'ads_with_benefits', 'biz_ai', 'creative_stickers', 'customize_product_recommendation',
  'description_automation', 'fb_feed_tag', 'fb_reels_tag', 'fb_story_tag', 'generate_cta', 'hide_price', 'ig_feed_tag', 'ig_reels_tag',
  'ig_stream_tag', 'image_animation', 'image_background_gen', 'image_templates', 'image_touchups', 'inline_comment', 'local_store_extension',
  'media_order', 'media_type_automation', 'multi_photo_to_video', 'music_generation', 'pac_relaxation', 'product_extensions', 'profile_card',
  'profile_extension', 'replace_media_text', 'reveal_details_over_time', 'show_destination_blurbs', 'show_summary', 'site_extensions',
  'standard_enhancements', 'standard_enhancements_catalog', 'text_extraction_for_headline', 'text_extraction_for_tap_target',
  'text_optimizations', 'text_overlay_translation', 'text_translation', 'translate_voiceover', 'video_highlights', 'video_to_image',
  'wa_mm_image_filtering', 'wa_mm_text_truncation_length',
] as const
/**
 * Read 2026-10-21 at https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/advantage-creative/get-started.md,
 * its "Features" table (23 keys; the guide's own example still writes `image_template`, its table `image_templates`).
 */
export const META_FEATURES_GUIDE = [
  'adapt_to_placement', 'add_text_overlay', 'creative_stickers', 'description_automation', 'enhance_cta', 'image_animation',
  'image_background_gen', 'image_brightness_and_contrast', 'image_templates', 'image_text_translation', 'image_touchups', 'image_uncrop',
  'inline_comment', 'media_type_automation', 'pac_relaxation', 'product_extensions', 'reveal_details_over_time', 'text_optimizations',
  'text_translation', 'translate_voiceover', 'video_auto_crop', 'video_filtering', 'video_uncrop',
] as const
/**
 * The other names Meta documents: the adcreatives edge's creative_feature enum (master CR-400), text_generation
 * (creative/generative-ai-features.md) and dynamic_partner_content (master CR-413, Advantage+ catalog guide).
 */
export const META_FEATURES_OTHER = [
  'ig_video_native_subtitle', 'product_browsing', 'product_metadata_automation', 'text_generation', 'dynamic_partner_content',
] as const

/**
 * EVERY Advantage+ creative feature Meta documents (the three lists above): each is sent with an explicit enroll_status
 * (OPT_OUT unless the request opts it in). Meta's SDK names ~30 more (adcreativefeaturesspec.py: advantage_plus_creative,
 * audio, carousel_to_video, image_auto_crop, …) that no v26 page documents: they are not sent (an unknown key could make
 * Meta refuse every creative); the run reads the creative back and says any feature Meta switched on that Nexus did not
 * ask (LIVE-PROBES CR-418).
 */
export const META_CREATIVE_FEATURES: readonly string[] = [...new Set<string>([...META_FEATURES_SPEC_REFERENCE, ...META_FEATURES_GUIDE, ...META_FEATURES_OTHER])].sort()

/**
 * The features Meta marks "generated with AI" (the guide's table; generative-ai-features.md; stickers per master CR-410;
 * music_generation by its name): an ad using one must be created PAUSED and previewed before it is switched on (step 27
 * enforces it on the ad; the preview here says so).
 */
export const META_AI_GENERATED_FEATURES: ReadonlySet<string> = new Set([
  'image_animation', 'image_background_gen', 'image_templates', 'image_uncrop', 'video_uncrop', 'translate_voiceover', 'text_generation',
  'creative_stickers', 'music_generation',
])

/** format_transformation_spec formats (creative/format-automation; master CR-419…423): each sent, data_source none unless asked. */
export const META_FORMAT_AUTOMATION_FORMATS = ['da_collection', 'sa_collection', 'single_media', 'catalog_single_media', 'carousel', 'video_slideshow'] as const
export const META_FORMAT_DATA_SOURCES = ['none', 'catalog', 'manual_uploads', 'app_information', 'site_links'] as const

// ── value judges ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A walk's findings: the ids inside (checked by the gateway), sentences a person reads, and a guard on size. */
export interface CreativeWalk { assets: MetaWriteAsset[]; warnings: string[]; nodes: number; instagram: boolean }
type Out = { value: unknown } | { problem: string }
type Judge = (value: unknown, path: string, walk: CreativeWalk) => Out
const ok = (value: unknown): Out => ({ value })
const no = (problem: string): Out => ({ problem })
const warn = (walk: CreativeWalk, sentence: string) => { if (!walk.warnings.includes(sentence)) walk.warnings.push(sentence) }

/**
 * A creative's text a person reads (a message, a headline, a description, a greeting): 1 to `max` characters (`blank`: a
 * single space too — Meta's per-language description), at least one visible character, no bidirectional control, no
 * control or format character but a line break (`lines`) and a joiner between two emoji (step 23's pattern).
 */
export function metaCreativeTextProblem(value: string, max: number, what: string, opts: { lines?: boolean; blank?: boolean } = {}): string | null {
  const length = [...value].length
  if (length < 1 || length > max) return `${what} is 1 to ${max} characters`
  if (opts.blank && value === ' ') return null
  if (BIDI_CONTROLS.test(value)) return `${what} carries no bidirectional control character (they can reorder what a person reads)`
  const plain = opts.lines ? value.replace(/\n/g, ' ') : value
  if (!META_MEDIA_TEXT_PATTERN.test(plain)) return `${what} carries no control or format character${opts.lines ? ' but a line break' : ''} (a zero-width joiner only between two emoji)`
  if (!VISIBLE.test(value)) return `${what} has at least one visible character`
  return null
}

const text = (max: number, opts: { lines?: boolean; blank?: boolean } = {}): Judge => (value, path) => {
  if (typeof value !== 'string') return no(`${path} is text`)
  const problem = metaCreativeTextProblem(value, max, path, opts)
  return problem ? no(problem) : ok(value)
}
/** Meta: a creative's URL "≤1000" characters (reference/ad-creative Limits). */
const LINK_MAX = 1000
const link: Judge = (value, path) => {
  if (typeof value !== 'string') return no(`${path} is an https link`)
  const problem = metaPublicLinkProblem(value, path, LINK_MAX)
  return problem ? no(problem) : ok(value)
}
/**
 * A picture Meta fetches into the library (master MD-005: link_data.picture, photo_data.url, video_data.image_url,
 * asset_feed_spec images[].url, platform_customizations.instagram.image_url): a public https link — never one of Meta's own
 * CDN links ("Do not use image URLs returned by Facebook. Instead you should host the image on your own servers",
 * reference/ad-image). Meta's cap is 8 MB (F1 M5-01); Meta fetches it, Nexus does not.
 */
const picture: Judge = (value, path, walk) => {
  const out = link(value, path, walk)
  if ('problem' in out) return out
  if (/(^|\.)(fbcdn\.net|cdninstagram\.com|facebook\.com|fbsbx\.com)$/.test(new URL(String(value)).hostname)) return no(`${path}: Meta says not to use image links it returned ("host the image on your own servers"): upload it with create-meta-media and use its hash`)
  warn(walk, 'Meta fetches a picture link itself (a JPG or PNG of at most 8 MB; error 3858258 when the site\'s robots.txt blocks it) and copies it into the ad account\'s library: Nexus fetches nothing.')
  return out
}
/** The call-to-action link: an https link, or `tel:+<digits>` for a call ad (CALL_NOW, master CR-250). */
const ctaLink: Judge = (value, path, walk) => (typeof value === 'string' && /^tel:\+\d{6,15}$/.test(value) ? ok(value) : canvasAware(value, path, walk))
/** A display link (`caption`, `display_url`: "must be an actual URL"): an https link or a bare host with a path. */
const displayLink: Judge = (value, path, walk) => (typeof value === 'string' && /^(?!https?:)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[A-Za-z0-9._~\-/]*)?$/.test(value) && value.length <= LINK_MAX ? ok(value) : link(value, path, walk))
/** An Instant Experience's link (`https://fb.com/canvas_doc/<id>`, collection-ads guide): its id goes to the gateway's check. */
const CANVAS_LINK = /^https:\/\/fb\.com\/canvas_doc\/(\d{1,20})$/
const canvasAware: Judge = (value, path, walk) => {
  const out = link(value, path, walk)
  if ('value' in out) {
    const canvas = CANVAS_LINK.exec(String(value))
    if (canvas) walk.assets.push({ id: canvas[1], kind: 'canvas' })
  }
  return out
}
/** An Instagram app link for the unified profile visit (master CR-225): instagram://user?username=<name>. */
const instagramAppLink: Judge = (value, path) => (typeof value === 'string' && /^instagram:\/\/user\?username=[A-Za-z0-9._]{1,30}$/.test(value) ? ok(value) : no(`${path} is instagram://user?username=<the Instagram username> (Nexus has no app of its own)`))
const digits = (value: unknown) => (typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null)
/** A Meta id (digits, written as a string), handed to the gateway's check as this kind of asset. */
const id = (kind: MetaWriteAsset['kind']): Judge => (value, path, walk) => {
  const v = digits(value)
  if (!v) return no(`${path} is a Meta id (digits, as a string)`)
  walk.assets.push({ id: v, kind })
  return ok(v)
}
/** An id Meta scopes to the promoted Page or WhatsApp account itself (a flow, a conversation template): digits. */
const scopedId: Judge = (value, path) => (digits(value) ? ok(value) : no(`${path} is a Meta id (digits, as a string)`))
/** An image of the chosen account's library, by its hash. */
const hash: Judge = (value, path, walk) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(value)) return no(`${path} is an image hash (letters and digits: create-meta-media answers it)`)
  walk.assets.push({ id: value, kind: 'adimage' })
  return ok(value)
}
const enumOf = (values: readonly string[]): Judge => (value, path) => (typeof value === 'string' && values.includes(value) ? ok(value) : no(`${path} is one of ${values.length > 12 ? `Meta's ${values.length} values (e.g. ${values.slice(0, 6).join(', ')})` : values.join(', ')}`))
/** A word Meta names (an UPPER or lower token Nexus passes on as is: Meta's own validation answers an unknown one). */
const token: Judge = (value, path) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(value) ? ok(value) : no(`${path} is one of Meta's words (letters, digits, _)`))
const bool: Judge = (value, path) => (typeof value === 'boolean' ? ok(value) : no(`${path} is true or false`))
const int = (min: number, max: number): Judge => (value, path) => (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? ok(value) : no(`${path} is a whole number from ${min} to ${max}`))
const hex: Judge = (value, path) => (typeof value === 'string' && /^#?[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value) ? ok(value) : no(`${path} is a colour as hex (#RRGGBB)`))
/** A phone number in international form (+<digits>): Meta checks it is the business's own WhatsApp number. */
const phone: Judge = (value, path) => (typeof value === 'string' && /^\+?\d{6,15}$/.test(value) ? ok(value) : no(`${path} is a phone number in international form (+<digits>)`))
/** A locale as Meta writes it in language specs (it_IT, fr_XX). */
const locale: Judge = (value, path) => (typeof value === 'string' && /^[a-z]{2}_[A-Z]{2}$/.test(value) ? ok(value) : no(`${path} is a locale (it_IT, fr_XX)`))
const country: Judge = (value, path) => (typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? ok(value) : no(`${path} is a country code (IT)`))
/** A key Meta takes that Nexus answers in words instead. */
const refuse = (why: string): Judge => (_value, path) => no(`${path}: ${why}`)

const CATALOG = 'catalog and product-set ids come with lane C1\'s catalog rule (step 18), which checks each is the business\'s chosen catalog: Nexus sends none before it' // C2-REBASE-18: wire metaCatalogProblem here
const NO_APP = 'Nexus sells online and has no app of its own, so it sends no app link, store link, playable or app id'
const BOOST = 'a creative made from an existing Instagram or Facebook post of someone else comes with create-meta-boost (step 26)'

/** A JSON object of exactly these keys (each optional; `need`: these must be there). */
function obj(keys: Record<string, Judge>, need: readonly string[] = []): Judge {
  return (value, path, walk) => {
    if (++walk.nodes > 20_000) return no('the creative is too large to judge')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return no(`${path} is a JSON object`)
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(keys, key)) return no(`${path}.${key.slice(0, 60)} is not a key Nexus sends there`)
      const judged = keys[key](child, `${path}.${key}`, walk)
      if ('problem' in judged) return judged
      Object.defineProperty(out, key, { value: judged.value, enumerable: true, writable: true, configurable: true })
    }
    const missing = need.find((k) => !(k in out))
    return missing ? no(`${path} names ${missing}`) : ok(out)
  }
}
/** A JSON list of `min` to `max` entries, each judged. */
function list(of: Judge, max: number, min = 0): Judge {
  return (value, path, walk) => {
    if (!Array.isArray(value)) return no(`${path} is a JSON list`)
    if (value.length < min || value.length > max) return no(`${path} holds ${min} to ${max} entries`)
    const out: unknown[] = []
    for (const [i, child] of value.entries()) {
      const judged = of(child, `${path}[${i}]`, walk)
      if ('problem' in judged) return judged
      out.push(judged.value)
    }
    return ok(out)
  }
}
/** The first judge that takes the value (a welcome message is text, an object or a list). */
function oneOf(...judges: Judge[]): Judge {
  return (value, path, walk) => {
    let first: Out | null = null
    for (const judge of judges) {
      const before = { assets: walk.assets.length, warnings: walk.warnings.length }
      const judged = judge(value, path, walk)
      if ('value' in judged) return judged
      walk.assets.length = before.assets
      walk.warnings.length = before.warnings
      first ??= judged
    }
    return first!
  }
}

/** image_crops (image-crops; master CR-015): `{"<ratio>": [[x1, y1], [x2, y2]]}`; 191x100 is being retired (2490085). */
const CROP_KEYS = ['100x100', '191x100', '400x150', '600x360', '400x500', '90x160', '300x400', '100x72'] as const
const point = list(int(0, 100_000), 2, 2)
const crops = (only?: readonly string[]): Judge => (value, path, walk) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return no(`${path} is a JSON object of crops`)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!(only ?? CROP_KEYS).includes(key)) return no(`${path}.${key.slice(0, 20)} is not a crop key Meta takes${only ? ` here (only ${only.join(', ')})` : ''}`)
    const judged = list(point, 2, 2)(child, `${path}.${key}`, walk)
    if ('problem' in judged) return judged
    if (key === '191x100') warn(walk, 'The crop key 191x100 is being retired by Meta (error 2490085): use 100x100 for the same placements.')
    out[key] = judged.value
  }
  return ok(out)
}

// ── Meta's enums (SDK main, checked 2026-10-21) ─────────────────────────────────────────────────────────────────────

/** call_to_action.type: SDK adcreativelinkdatacalltoaction.py Type (102) and the CTAs Meta's guides use beside them. */
export const META_CTA_TYPES: readonly string[] = [
  'ADD_TO_CART', 'APPLY_NOW', 'ASK_ABOUT_SERVICES', 'ASK_A_QUESTION', 'ASK_FOR_MORE_INFO', 'ASK_US', 'AUDIO_CALL', 'BOOK_A_CONSULTATION', 'BOOK_NOW',
  'BOOK_TRAVEL', 'BROWSE_SHOP', 'BUY', 'BUY_NOW', 'BUY_TICKETS', 'BUY_VIA_MESSAGE', 'CALL', 'CALL_ME', 'CALL_NOW', 'CHAT_NOW', 'CHAT_WITH_US', 'CONFIRM',
  'CONTACT', 'CONTACT_US', 'DONATE', 'DONATE_NOW', 'DOWNLOAD', 'EVENT_RSVP', 'FIND_A_GROUP', 'FIND_OUT_MORE', 'FIND_YOUR_GROUPS',
  'FOLLOW_NEWS_STORYLINE', 'FOLLOW_PAGE', 'FOLLOW_USER', 'GET_A_QUOTE', 'GET_DETAILS', 'GET_DIRECTIONS', 'GET_IN_TOUCH', 'GET_OFFER',
  'GET_OFFER_VIEW', 'GET_PROMOTIONS', 'GET_QUOTE', 'GET_SHOWTIMES', 'GET_STARTED', 'INQUIRE_NOW', 'INSTALL_APP', 'INSTALL_MOBILE_APP',
  'JOIN_CHANNEL', 'JOIN_LIVE_VIDEO', 'LEARN_MORE', 'LIKE_PAGE', 'LISTEN_MUSIC', 'LISTEN_NOW', 'MAKE_AN_APPOINTMENT', 'MESSAGE_PAGE',
  'MOBILE_DOWNLOAD', 'NO_BUTTON', 'OPEN_INSTANT_APP', 'OPEN_LINK', 'ORDER_NOW', 'PAY_TO_ACCESS', 'PLAY_GAME', 'PLAY_GAME_ON_FACEBOOK',
  'PURCHASE_GIFT_CARDS', 'RAISE_MONEY', 'RECORD_NOW', 'REFER_FRIENDS', 'REQUEST_TIME', 'SAY_THANKS', 'SEE_MORE', 'SEE_SHOP', 'SELL_NOW',
  'SEND_A_GIFT', 'SEND_GIFT_MONEY', 'SEND_UPDATES', 'SHARE', 'SHOP_NOW', 'SHOP_WITH_AI', 'SIGN_UP', 'SOTTO_SUBSCRIBE', 'START_A_CHAT',
  'START_ORDER', 'SUBSCRIBE', 'SWIPE_UP_PRODUCT', 'SWIPE_UP_SHOP', 'TRY_DEMO', 'TRY_ON_WITH_AI', 'UPDATE_APP', 'USE_APP', 'USE_MOBILE_APP',
  'VIDEO_ANNOTATION', 'VIDEO_CALL', 'VIEW_CART', 'VIEW_CHANNEL', 'VIEW_IN_CART', 'VIEW_PRODUCT', 'VISIT_PAGES_FEED', 'VISIT_WEBSITE',
  'WATCH_LIVE_VIDEO', 'WATCH_MORE', 'WATCH_VIDEO', 'WHATSAPP_MESSAGE', 'WOODHENGE_SUPPORT',
  // Guides: click-to-instagram / multi-destination (INSTAGRAM_MESSAGE), profile visits (VIEW_INSTAGRAM_PROFILE, VISIT_PROFILE),
  // event tickets (GET_EVENT_TICKETS), and the creative edge's own extra values (F1 M5-11).
  'INSTAGRAM_MESSAGE', 'VIEW_INSTAGRAM_PROFILE', 'VISIT_PROFILE', 'GET_EVENT_TICKETS', 'SAVE', 'GET_MOBILE_APP', 'BUY_ACTIVITY_TICKETS', 'STREAM_NOW',
]
/** Messaging destinations a call to action names (click-to-messenger / -whatsapp / -instagram guides). */
const APP_DESTINATIONS = ['MESSENGER', 'WHATSAPP', 'INSTAGRAM_DIRECT', 'MESSENGER_AND_WHATSAPP'] as const
const FORMAT_OPTIONS = ['carousel_ar_effects', 'carousel_images_multi_items', 'carousel_images_single_item', 'carousel_slideshows', 'collection_video', 'single_image', 'single_video'] as const
const OVERLAY = {
  overlay_template: enumOf(['circle_with_text', 'pill_with_text', 'triangle_with_text']),
  text_type: enumOf(['automated_personalize', 'custom', 'disclaimer', 'from_price', 'guest_rating', 'percentage_off', 'price', 'star_rating', 'strikethrough_price', 'sustainable']),
  custom_text_type: enumOf(['free_shipping', 'popular', 'sale']),
  position: enumOf(['bottom_left', 'bottom_right', 'top_left', 'top_right']),
  theme_color: enumOf(['background_000000_text_ffffff', 'background_0090ff_text_ffffff', 'background_00af4c_text_ffffff', 'background_595959_text_ffffff', 'background_755dde_text_ffffff', 'background_e50900_text_ffffff', 'background_f23474_text_ffffff', 'background_f78400_text_ffffff', 'background_ffffff_text_000000', 'background_ffffff_text_007ad0', 'background_ffffff_text_009c2a', 'background_ffffff_text_646464', 'background_ffffff_text_755dde', 'background_ffffff_text_c91b00', 'background_ffffff_text_f23474', 'background_ffffff_text_f78400']),
  text_font: enumOf(['droid_serif_regular', 'dynads_hybrid_bold', 'lato_regular', 'noto_sans_regular', 'nunito_sans_bold', 'open_sans_bold', 'open_sans_condensed_bold', 'pt_serif_bold', 'roboto_condensed_regular', 'roboto_medium']),
  float_with_margin: bool,
  text_template_tags: list(text(100), 10),
}
const LAYER = {
  layer_type: enumOf(['frame_overlay', 'image', 'text_overlay']),
  image_source: enumOf(['catalog']),
  frame_image_hash: hash,
  frame_source: enumOf(['custom']),
  blending_mode: enumOf(['lighten', 'multiply', 'normal']),
  opacity: int(0, 100),
  overlay_position: enumOf(['bottom', 'bottom_left', 'bottom_right', 'center', 'left', 'right', 'top', 'top_left', 'top_right']),
  overlay_shape: enumOf(['circle', 'none', 'pill', 'rectangle', 'triangle']),
  shape_color: hex,
  text_color: hex,
  text_font: enumOf(['droid_serif_regular', 'lato_regular', 'noto_sans_regular', 'nunito_sans_bold', 'open_sans_bold', 'open_sans_condensed_bold', 'pt_serif_bold', 'roboto_condensed_regular', 'roboto_medium']),
  scale: int(10, 100),
  content: obj({ type: token, auto_show_enroll_status: enumOf(['OPT_IN', 'OPT_OUT']) }),
  frame_auto_show_enroll_status: enumOf(['OPT_IN', 'OPT_OUT']),
}

// ── the parts of a creative ─────────────────────────────────────────────────────────────────────────────────────────

/** Text limits Nexus holds, Meta's own (asset-feed-spec, multi-language ads: title 255, body 4,096, description 10,000). */
export const META_CREATIVE_TEXT = { message: 4096, headline: 255, description: 10_000, greeting: 300, iceTitle: 80, quickReply: 20, label: 100, name: 100 } as const

const ctaValue = obj({
  link: ctaLink,
  link_caption: text(255),
  link_title: text(META_CREATIVE_TEXT.headline),
  link_description: text(META_CREATIVE_TEXT.description, { lines: true }),
  link_format: token,
  app_destination: enumOf(APP_DESTINATIONS),
  app_link: instagramAppLink,
  page: id('chosenpage'),
  lead_gen_form_id: id('leadform'),
  whatsapp_number: phone,
  product_link: link,
  event_id: id('pageevent'),
  application: refuse(NO_APP),
  object_store_urls: refuse(NO_APP),
})
const callToAction = obj({ type: enumOf(META_CTA_TYPES), value: ctaValue }, ['type'])
const sponsorPage = id('partnerpage')

/** page_welcome_message (click-to-messenger / -whatsapp / -instagram guides; master CR-200…205, CR-215). */
const quickReply = obj({ content_type: enumOf(['text', 'user_phone_number', 'user_email']), title: text(META_CREATIVE_TEXT.quickReply), payload: text(1000) })
const welcomeMessage = obj({
  text: text(META_CREATIVE_TEXT.greeting, { lines: true }),
  ice_breakers: list(obj({ title: text(META_CREATIVE_TEXT.iceTitle), response: text(META_CREATIVE_TEXT.greeting, { lines: true }) }, ['title']), 4),
  quick_replies: list(quickReply, 13),
  autofill_message: obj({ content: text(META_CREATIVE_TEXT.greeting, { lines: true }) }),
  call_prompt_data: obj({ call_prompt_message: text(META_CREATIVE_TEXT.greeting, { lines: true }) }),
  automated_greeting_message_cta: obj({
    type: enumOf(['call', 'website', 'catalog', 'flow']),
    title: text(60),
    phone_number: phone,
    website_url: link,
    flow_data: obj({ flow_id: scopedId, call_to_action: text(30), flow_message_version: token, flow_action: token, navigate_screen: token }),
  }),
  attachment: obj({
    type: enumOf(['template']),
    payload: obj({
      template_type: enumOf(['notification_messages', 'button', 'generic']),
      text: text(640, { lines: true }),
      elements: list(obj({
        title: text(80), subtitle: text(80), image_url: link,
        buttons: list(obj({ type: enumOf(['postback', 'web_url']), title: text(20), payload: text(1000), url: link }), 3),
      }), 10),
      buttons: list(obj({ type: enumOf(['postback', 'web_url']), title: text(20), payload: text(1000), url: link }), 3),
    }),
  }),
})
const visualEditor = obj({
  type: enumOf(['VISUAL_EDITOR']),
  version: int(1, 10),
  landing_screen_type: enumOf(['welcome_message', 'call_prompt', 'ctwa_call_prompt', 'marketing_messages', 'ctwa_flows']),
  media_type: enumOf(['text', 'image', 'video']),
  text_format: obj({ customer_action_type: token, message: welcomeMessage }),
  image_format: obj({ customer_action_type: token, message: welcomeMessage }),
  user_edit: bool,
  surface: token,
})
const pageWelcome = oneOf(text(META_CREATIVE_TEXT.greeting, { lines: true }), visualEditor, list(obj({ message: welcomeMessage }), 5, 1))

const postClick = obj({ post_click_item_headline: text(META_CREATIVE_TEXT.headline), post_click_item_description: text(META_CREATIVE_TEXT.description, { lines: true }) })
const collectionThumbnails = (value: unknown, path: string, walk: CreativeWalk): Out => {
  const judged = list(obj({ element_id: digitsOnly, element_child_index: int(0, 1000), element_crops: crops(['100x100']) }, ['element_id']), 4, 4)(value, path, walk)
  // collection-ads: "Four thumbnails are required"; each element must be of the creative's own Instant Experience.
  if ('value' in judged) for (const t of judged.value as Array<{ element_id: string }>) walk.assets.push({ id: t.element_id, kind: 'canvaselement' })
  return judged
}
const digitsOnly: Judge = (value, path) => (digits(value) ? ok(value) : no(`${path} is a Meta id (digits, as a string)`))
const templateUrl = obj({ web: obj({ url: link, should_fallback: bool }), ios: refuse(NO_APP), iphone: refuse(NO_APP), ipad: refuse(NO_APP), android: refuse(NO_APP), windows_phone: refuse(NO_APP), config: refuse(NO_APP) })
const customizationRule = obj({
  customization_spec: obj({ language: locale, country }),
  message: text(META_CREATIVE_TEXT.message, { lines: true }),
  link,
  name: text(META_CREATIVE_TEXT.headline),
  description: text(META_CREATIVE_TEXT.description, { lines: true }),
  caption: displayLink,
  template_url_spec: templateUrl,
  video_id: id('libraryvideo'),
  picture,
  image_hash: hash,
}, ['customization_spec'])

const childAttachment = obj({
  link: canvasAware,
  name: text(META_CREATIVE_TEXT.headline),
  description: text(META_CREATIVE_TEXT.description, { lines: true }),
  caption: displayLink,
  image_hash: hash,
  picture,
  video_id: id('libraryvideo'),
  call_to_action: callToAction,
  image_crops: crops(),
  static_card: bool,
  ig_media_id: refuse(BOOST),
  android_url: refuse(NO_APP),
  ios_url: refuse(NO_APP),
})

/** link_data, and template_data (the same AdCreativeLinkData, with the catalog template keys). */
const linkData = obj({
  link: canvasAware,
  message: text(META_CREATIVE_TEXT.message, { lines: true }),
  name: text(META_CREATIVE_TEXT.headline),
  description: text(META_CREATIVE_TEXT.description, { lines: true }),
  caption: displayLink,
  image_hash: hash,
  picture,
  image_crops: crops(),
  call_to_action: callToAction,
  use_flexible_image_aspect_ratio: bool,
  child_attachments: (value, path, walk) => {
    // M5-14: 2 to 10 cards (Meta's guides disagree: 2–5 with multi_share_optimized up to 10); Instagram shows the first 5.
    const judged = list(childAttachment, 10, 2)(value, path, walk)
    if ('value' in judged && (judged.value as unknown[]).length > 5 && walk.instagram) warn(walk, 'Instagram shows only the first 5 cards of a carousel; the others run on Facebook only.')
    return judged
  },
  multi_share_optimized: bool,
  multi_share_end_card: bool,
  format_option: enumOf(FORMAT_OPTIONS),
  page_welcome_message: pageWelcome,
  post_click_configuration: postClick,
  collection_thumbnails: collectionThumbnails,
  event_id: id('pageevent'),
  attachment_style: enumOf(['link', 'default']),
  branded_content_sponsor_page_id: sponsorPage,
  branded_content_shared_to_sponsor_status: token,
  // Advantage+ catalog template parts (master CR-448…463; the product set itself is refused until step 18).
  force_single_link: bool,
  show_multiple_images: bool,
  automated_product_tags: bool,
  image_overlay_spec: obj(OVERLAY),
  image_layer_specs: list(obj(LAYER), 10),
  preferred_image_tags: list(text(200), 10),
  preferred_video_tags: list(text(200), 10),
  customization_rules_spec: list(customizationRule, 20),
  additional_image_index: int(0, 100),
  app_link_spec: refuse(NO_APP),
  offer_id: refuse('Meta offers are not a Nexus feature: a discount runs as the shop\'s own offer, named in the text and the disclaimer (ad_disclaimer_spec OFFER_DETAILS)'),
  retailer_item_ids: refuse(CATALOG),
  boosted_product_set_id: refuse(CATALOG),
})
const photoData = obj({
  image_hash: hash,
  url: picture,
  caption: text(META_CREATIVE_TEXT.message, { lines: true }),
  page_welcome_message: pageWelcome,
  branded_content_sponsor_page_id: sponsorPage,
  branded_content_shared_to_sponsor_status: token,
  branded_content_sponsor_relationship: token,
  image_crops: refuse('Meta takes no crop on a photo post ("Facebook typically renders images from photo posts in full"): use link_data for a cropped image'),
})
const videoData = obj({
  video_id: id('libraryvideo'),
  image_hash: hash,
  image_url: picture,
  message: text(META_CREATIVE_TEXT.message, { lines: true }),
  title: text(META_CREATIVE_TEXT.headline),
  link_description: text(META_CREATIVE_TEXT.description, { lines: true }),
  call_to_action: callToAction,
  page_welcome_message: pageWelcome,
  post_click_configuration: postClick,
  collection_thumbnails: collectionThumbnails,
  customization_rules_spec: list(customizationRule, 20),
  additional_image_index: int(0, 100),
  branded_content_sponsor_page_id: sponsorPage,
  branded_content_shared_to_sponsor_status: token,
  targeting: refuse('who sees an ad is the ad set\'s targeting (set-meta-ad-set), never a creative\'s'),
  caption_ids: refuse('Nexus adds captions to a library video itself (create-meta-media kind captions); a creative names none'),
  offer_id: refuse('Meta offers are not a Nexus feature'),
  retailer_item_ids: refuse(CATALOG),
}, ['video_id'])

const objectStorySpec = obj({
  page_id: digitsOnly,
  instagram_user_id: digitsOnly,
  link_data: linkData,
  photo_data: photoData,
  video_data: videoData,
  text_data: obj({ message: text(META_CREATIVE_TEXT.message, { lines: true }) }, ['message']),
  template_data: linkData,
  whats_app_business_phone_number: phone,
  instagram_actor_id: refuse('Meta takes the Instagram account as instagram_user_id (instagram_actor_id is gone, errors 2238055 / 2446149): Nexus fills the chosen one'),
  threads_user_id: refuse('a Threads ad runs through the business\'s Instagram account (Meta\'s Threads guide: "that Instagram account needs to be used"), so Nexus sends no Threads id'),
  product_data: refuse(CATALOG),
}, ['page_id'])

const labels = list(obj({ name: text(META_CREATIVE_TEXT.label) }, ['name']), 50)
const urlTags: Judge = (value, path) => {
  // A plain query string ("key1=val1&key2=val2"), Meta's {{…}} macros allowed; never a key, signature or sign-in.
  if (typeof value !== 'string' || value.length < 1 || value.length > 1000 || !/^[\x21-\x7e]+$/.test(value)) return no(`${path} is a query string (key=value&…) of at most 1000 characters`)
  for (const part of value.split('&')) {
    const [key, ...rest] = part.split('=')
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key) || rest.length !== 1) return no(`${path} is key=value pairs joined by &`)
    if (/token|secret|signature|sig$|^sig|key|password|passwd|auth|credential|session|expires/i.test(key)) return no(`${path} carries no key, signature or sign-in ("${key.slice(0, 40)}")`)
  }
  return ok(value)
}
const assetLabel = obj({ name: text(META_CREATIVE_TEXT.label) }, ['name'])
const assetLabels = list(assetLabel, 10)
const positions = (removed: Record<string, string>): Judge => (value, path, walk) => {
  const judged = list(token, 20)(value, path, walk)
  if ('problem' in judged) return judged
  for (const p of judged.value as string[]) if (removed[p]) return no(`${path}: ${removed[p]}`)
  return judged
}
const customizationSpec = obj({
  publisher_platforms: list(enumOf(['facebook', 'instagram', 'messenger', 'audience_network', 'threads', 'whatsapp']), 6),
  facebook_positions: positions({ video_feeds: 'Meta removed the Facebook video feeds placement in v24 (use facebook_reels)' }),
  instagram_positions: positions({ explore: 'Meta removed the Instagram Explore feed placement in v26 (explore_home stays)' }),
  messenger_positions: positions({ story: 'Meta removed Messenger Stories in 2026' }),
  audience_network_positions: positions({}),
  threads_positions: positions({}),
  locales: list(int(1, 100_000), 50),
  age_min: int(13, 65),
  age_max: int(13, 65),
  device_platforms: list(enumOf(['mobile', 'desktop']), 2),
  // Master CR-443 (segment asset customization): its guide is 404 — built from the reference; Meta's answer decides.
  geo_locations: obj({ countries: list(country, 50) }),
})
const ruleLabel = assetLabel
const assetCustomizationRule = obj({
  customization_spec: customizationSpec,
  image_label: ruleLabel, video_label: ruleLabel, body_label: ruleLabel, title_label: ruleLabel, description_label: ruleLabel,
  link_url_label: ruleLabel, carousel_label: ruleLabel, call_to_action_label: ruleLabel, caption_label: ruleLabel,
  is_default: bool,
  priority: int(1, 100),
}, ['customization_spec'])
const textAsset = (max: number, opts: { lines?: boolean; blank?: boolean } = {}) => obj({ text: text(max, opts), url_tags: urlTags, adlabels: assetLabels }, ['text'])

const assetFeedSpec = obj({
  images: list(obj({ hash, url: picture, image_crops: crops(), url_tags: urlTags, adlabels: assetLabels }), 49),
  videos: list(obj({ video_id: id('libraryvideo'), thumbnail_url: picture, thumbnail_hash: hash, url_tags: urlTags, adlabels: assetLabels }, ['video_id']), 49),
  bodies: list(textAsset(META_CREATIVE_TEXT.message, { lines: true }), 49),
  titles: list(textAsset(META_CREATIVE_TEXT.headline), 49),
  descriptions: list(textAsset(META_CREATIVE_TEXT.description, { lines: true, blank: true }), 49),
  link_urls: list(obj({ website_url: canvasAware, display_url: displayLink, carousel_see_more_url: link, url_tags: urlTags, adlabels: assetLabels, deeplink_url: refuse(NO_APP), android_url: refuse(NO_APP), ios_url: refuse(NO_APP), object_store_urls: refuse(NO_APP), omnichannel_link_spec: refuse(NO_APP) }), 49),
  call_to_action_types: list(enumOf(META_CTA_TYPES), 5),
  call_to_actions: list(obj({ type: enumOf(META_CTA_TYPES), value: ctaValue, adlabels: assetLabels }, ['type']), 5),
  ad_formats: list(enumOf(['SINGLE_IMAGE', 'CAROUSEL', 'SINGLE_VIDEO', 'AUTOMATIC_FORMAT', 'COLLECTION']), 2, 1),
  carousels: list(obj({
    adlabels: assetLabels,
    child_attachments: list(obj({ image_label: ruleLabel, video_label: ruleLabel, title_label: ruleLabel, description_label: ruleLabel, link_url_label: ruleLabel, static_card: bool }), 10, 2),
    multi_share_end_card: bool,
    multi_share_optimized: bool,
  }), 10),
  asset_customization_rules: list(assetCustomizationRule, 50),
  optimization_type: enumOf(['REGULAR', 'PLACEMENT', 'LANGUAGE', 'ASSET_CUSTOMIZATION', 'DOF_MESSAGING_DESTINATION', 'UNIFIED_PROFILE_VISIT_DESTINATION', 'FORMAT_AUTOMATION']),
  autotranslate: list(locale, 40),
  audios: list(obj({ type: enumOf(['random']) }, ['type']), 1),
  additional_data: obj({
    partner_app_welcome_message_flow_id: scopedId,
    page_welcome_message: pageWelcome,
    is_click_to_message: bool,
    multi_share_end_card: bool,
    automated_product_tags: bool,
  }),
  // Master CR-251 (callback form) and CR-253 (Messenger / WhatsApp calling: reference only — Meta's answer decides).
  call_ads_configuration: obj({ callback_type: enumOf(['FORM']), call_destination_type: enumOf(['PHONE', 'MESSENGER', 'MESSENGER_AND_PHONE', 'WEBSITE_AND_CALL', 'WHATSAPP', 'WHATSAPP_ORGANIC']), phone_number: phone }),
  // Master CR-261: an upcoming event of the chosen Instagram account (the reminder button).
  upcoming_events: list(obj({ event_id: id('igevent'), event_title: text(META_CREATIVE_TEXT.headline), start_time: int(1_000_000_000, 4_000_000_000) }, ['event_id']), 1),
  // Master CR-440: promo codes — only codes Nexus writes (manual), never Meta's automatic sources or a catalog.
  promotional_metadata: obj({
    manual_coupon_codes: list(text(50), 10),
    allowed_coupon_code_sources: list(enumOf(['manual']), 1),
    offer_details: text(500, { lines: true }),
    is_auto_update_allowed: enumOfBool(false),
    product_catalog_id: refuse(CATALOG),
    allowed_promo_offer_ids: refuse(CATALOG),
  }),
  message_extensions: list(obj({ type: token }, ['type']), 5),
  onsite_destinations: refuse(CATALOG),
  shops_bundle: refuse(CATALOG),
  app_product_page_id: refuse(NO_APP),
})
/** A boolean that may only be this value (Meta's automatic promo-code updates stay off). */
function enumOfBool(only: boolean): Judge {
  return (value, path) => (value === only ? ok(value) : no(`${path} is ${only} (Nexus lets Meta change no promo code by itself)`))
}

/** degrees_of_freedom_spec: only creative_features_spec, each feature's enroll_status (+ the customizations Meta documents). */
const featureDetails = obj({
  enroll_status: enumOf(['OPT_IN', 'OPT_OUT']),
  customizations: obj({
    text_extraction: obj({ enroll_status: enumOf(['OPT_IN', 'OPT_OUT']) }, ['enroll_status']),
    video_crop_style: enumOf(['AUTO', 'NONE']),
    showcase_card_display: enumOf(['NONE', 'AUTO']),
  }),
  action_metadata: obj({ type: enumOf(['MANUAL']) }, ['type']),
}, ['enroll_status'])
const featuresSpec = obj(Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, featureDetails])))
const degreesOfFreedom = obj({ creative_features_spec: featuresSpec }, ['creative_features_spec'])
const formatTransformation = list(obj({ format: enumOf(META_FORMAT_AUTOMATION_FORMATS), data_source: list(enumOf(META_FORMAT_DATA_SOURCES), 5, 1) }, ['format', 'data_source']), META_FORMAT_AUTOMATION_FORMATS.length, 1)

/**
 * Every key of a creative Nexus sends (POST /act_<id>/adcreatives, and inside an async job's creative_spec), each with its
 * judge — an ALLOW-list: what is not here is refused. `json`: sent as a JSON form field (F1 M5 "All creative specs are
 * JSON-encoded form fields"); the others are plain strings.
 */
const CREATIVE_KEYS: Readonly<Record<string, { judge: Judge; json: boolean }>> = {
  name: { judge: text(META_CREATIVE_TEXT.name), json: false },
  object_story_spec: { judge: objectStorySpec, json: true },
  object_story_id: { judge: (value, path, walk) => {
    if (typeof value !== 'string' || !/^\d{1,25}_\d{1,25}$/.test(value)) return no(`${path} is a post id (<Page id>_<post id>)`)
    walk.assets.push({ id: value, kind: 'pagepost' })
    return ok(value)
  }, json: false },
  instagram_user_id: { judge: digitsOnly, json: false },
  asset_feed_spec: { judge: assetFeedSpec, json: true },
  degrees_of_freedom_spec: { judge: degreesOfFreedom, json: true },
  contextual_multi_ads: { judge: obj({ enroll_status: enumOf(['OPT_IN', 'OPT_OUT']) }, ['enroll_status']), json: true },
  format_transformation_spec: { judge: formatTransformation, json: true },
  destination_spec: { judge: obj({ destination_type: enumOf(['WEBSITE_AND_SHOP', 'WEBSITE_AND_SHOP_OPT_OUT']) }, ['destination_type']), json: true },
  url_tags: { judge: urlTags, json: false },
  adlabels: { judge: labels, json: true },
  call_to_action: { judge: callToAction, json: true },
  ad_disclaimer_spec: { judge: obj({ title: enumOf(['DISCLAIMER', 'HEALTH_DISCLAIMER', 'IMPORTANT_SAFETY_INFORMATION', 'MEDICATION_GUIDE', 'OFFER_DETAILS', 'PRESCRIBING_INFORMATION', 'TERMS_AND_CONDITIONS']), text: text(1000, { lines: true }), url: link }, ['title']), json: true },
  portrait_customizations: { judge: obj({ carousel_delivery_mode: enumOf(['fixed_num_cards']), specifications: list(obj({ background_color: obj({ top_color: hex, bottom_color: hex }, ['top_color', 'bottom_color']) }), 10) }), json: true },
  platform_customizations: { judge: obj({ instagram: obj({ image_url: picture, image_hash: hash, image_crops: crops(), video_id: id('libraryvideo') }) }, ['instagram']), json: true },
  interactive_components_spec: { judge: obj({
    components: list((value, path, walk) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && ((value as Record<string, unknown>).type === 'poll' || 'poll_spec' in (value as object))) return no(`${path}: Meta removed polls from creatives in v26 (all versions from 2026-10-27)`)
      return obj({ type: enumOf(['product_tag']), enroll_status: enumOf(['opt_out']), product_tag_spec: refuse(CATALOG), position_spec: refuse(CATALOG) }, ['type'])(value, path, walk)
    }, 10),
  }), json: true },
  branded_content: { judge: obj({ testimonial: text(500, { lines: true }), testimonial_locale: locale, parent_source_instagram_media_id: refuse(BOOST), parent_source_facebook_post_id: refuse(BOOST), partners: refuse(BOOST) }), json: true },
  facebook_branded_content: { judge: obj({ sponsor_page_id: digitsOnly, shared_to_sponsor_status: token, sponsor_relationship: token }, ['sponsor_page_id']), json: true },
  instagram_branded_content: { judge: obj({ sponsor_id: digitsOnly }, ['sponsor_id']), json: true },
  creative_sourcing_spec: { judge: obj({
    site_links_spec: list(obj({ site_link_title: text(META_CREATIVE_TEXT.headline), site_link_url: link, site_link_image_hash: hash, site_link_image_url: picture }, ['site_link_title', 'site_link_url']), 10),
    associated_product_set_id: refuse(CATALOG),
  }), json: true },
  media_sourcing_spec: { judge: obj({ related_media: obj({ opt_in_status: enumOf(['OPT_IN', 'OPT_OUT']) }, ['opt_in_status']) }), json: true },
  marketing_message_structured_spec: { judge: obj({ language: locale, conversation_template_id: scopedId, footer: text(60), greeting: text(META_CREATIVE_TEXT.greeting, { lines: true }), is_optimized_text: bool }), json: true },
  recommender_settings: { judge: obj({ preferred_events: list(enumOf(['ViewContent', 'Search', 'AddToCart', 'AddToWishlist', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Subscribe', 'RecurringSubscriptionPayment', 'Lead', 'CompleteRegistration', 'CustomConversion', 'AggregateCustomConversion', 'Other']), 14), product_sales_channel: enumOf(['ONLINE', 'IN_STORE', 'OMNI']) }), json: true },
  template_url_spec: { judge: templateUrl, json: true },
  categorization_criteria: { judge: enumOf(['brand', 'category', 'product_type']), json: false },
  category_media_source: { judge: enumOf(['CATEGORY', 'MIXED', 'PRODUCTS_COLLAGE', 'PRODUCTS_SLIDESHOW']), json: false },
  object_type: { judge: enumOf(['SHARE', 'VIDEO', 'EVENT', 'PHOTO', 'STATUS']), json: false },
  product_set_id: { judge: refuse(CATALOG), json: false },
}

/**
 * Keys Meta takes on the creative edge that Nexus answers in words (CREATIVE_KEYS refuses every other one by name too).
 * The sentences are the tool's and the gateway's.
 */
export const META_CREATIVE_REFUSED: Readonly<Record<string, string>> = {
  authorization_category: 'Nexus never declares a political or social-issue ad: they are banned in the EU since 2025-10-06 (Meta\'s TTPA rules), Nexus\'s markets',
  wamo_whatsapp_identity_spec: 'WhatsApp Status ads with a WhatsApp identity do not run in the EU, Nexus\'s markets (Meta\'s ads-in-whatsapp-status guide)',
  regional_regulation_disclaimer_spec: 'the regional finance disclaimers are for Taiwan, Australia, India and Singapore, not Nexus\'s EU markets',
  threads_user_id: 'a Threads ad runs through the business\'s Instagram account (Meta\'s Threads guide), so Nexus sends no Threads id',
  applink_treatment: NO_APP, object_store_url: NO_APP, playable_asset_id: NO_APP, enable_direct_install: NO_APP, enable_launch_instant_app: NO_APP,
  use_page_actor_override: NO_APP, omnichannel_link_spec: NO_APP,
  place_page_set_id: 'Nexus sells online and keeps no store-location pages (a place page set), so it makes no dynamic local ad',
  dynamic_ad_voice: 'Nexus sells online and keeps no store-location pages (a place page set), so it makes no dynamic local ad',
  source_instagram_media_id: BOOST, object_id: BOOST, source_facebook_post_id: BOOST,
  image_file: 'Meta allows no link ad without a Page since 2017 (1885833): Nexus builds every creative from the chosen Page (object_story_spec)',
  title: 'Meta allows no link ad without a Page since 2017 (1885833): the headline goes in object_story_spec',
  body: 'Meta allows no link ad without a Page since 2017 (1885833): the text goes in object_story_spec',
  object_url: 'Meta allows no link ad without a Page since 2017 (1885833): the link goes in object_story_spec',
  link_url: 'Meta allows no link ad without a Page since 2017 (1885833): the link goes in object_story_spec',
  image_hash: 'Meta allows no link ad without a Page since 2017 (1885833): the image goes in object_story_spec',
  image_url: 'Meta allows no link ad without a Page since 2017 (1885833): the image goes in object_story_spec (link_data.picture, photo_data.url, video_data.image_url)',
  actor_id: 'the advertiser is the chosen Page (object_story_spec.page_id, which Nexus fills)',
  branded_content_advertisable_medias: 'Meta removes it on 2026-12-01; partnership media go through create-meta-boost (step 26)',
  page_welcome_message: 'a welcome message goes in object_story_spec (link_data, photo_data or video_data) or asset_feed_spec.additional_data',
}

// ── the judge ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A walk's new start. `instagram`: the creative names an Instagram account (Instagram's limits are said). */
export const newCreativeWalk = (instagram = false): CreativeWalk => ({ assets: [], warnings: [], nodes: 0, instagram })

/** One key of a creative, decoded (a JSON key as its object), judged; the cleaned value or why not. */
export function judgeCreativeKey(key: string, value: unknown, walk: CreativeWalk): Out {
  if (Object.prototype.hasOwnProperty.call(META_CREATIVE_REFUSED, key)) return no(`${key}: ${META_CREATIVE_REFUSED[key]}`)
  if (!Object.prototype.hasOwnProperty.call(CREATIVE_KEYS, key)) return no(`${key.slice(0, 60)} is not a key Nexus sends on a creative`)
  return CREATIVE_KEYS[key].judge(value, key, walk)
}
export const isJsonCreativeKey = (key: string) => Object.prototype.hasOwnProperty.call(CREATIVE_KEYS, key) && CREATIVE_KEYS[key].json

/** The silent features a creative must carry explicitly (the binding lane rule): why not, or null. */
export function silentFeaturesProblem(creative: Record<string, unknown>): string | null {
  const dof = creative.degrees_of_freedom_spec as { creative_features_spec?: Record<string, { enroll_status?: unknown }> } | undefined
  const features = dof?.creative_features_spec ?? {}
  const missing = META_CREATIVE_FEATURES.filter((f) => !features[f]?.enroll_status)
  if (missing.length) return `a creative names an enroll_status for every Advantage+ creative feature Meta documents (missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}): Nexus switches none on silently`
  if (!(creative.contextual_multi_ads as { enroll_status?: unknown } | undefined)?.enroll_status) return 'a creative names contextual_multi_ads.enroll_status (Meta opts a creative into multi-advertiser ads when it is missing)'
  const formats = Array.isArray(creative.format_transformation_spec) ? (creative.format_transformation_spec as Array<{ format?: unknown }>).map((f) => f.format) : []
  if (META_FORMAT_AUTOMATION_FORMATS.some((f) => formats.filter((x) => x === f).length !== 1)) return `a creative names format_transformation_spec for each of ${META_FORMAT_AUTOMATION_FORMATS.join(', ')} once (Meta transforms the format by itself when one is missing)`
  const feed = creative.asset_feed_spec as { audios?: unknown } | undefined
  if (!feed || !Array.isArray(feed.audios)) return 'a creative names asset_feed_spec.audios (empty: no music; Meta\'s guide opts out of music that way)'
  if (!(creative.destination_spec as { destination_type?: unknown } | undefined)?.destination_type) return 'a creative names destination_spec.destination_type (v26 sends an eligible creative to the shop by itself when it is missing)'
  return null
}

/**
 * The identity of a creative, after the walk: the Page and Instagram account it runs as, each the chosen one, or a
 * partner's beside the chosen one as its sponsor (partnership ads: master CR-320 brand as main identity, CR-321 creator as
 * main identity) — handed to the gateway as identity assets (`with`: the sponsor named). A legacy sponsor Page and every
 * sponsor named while the chosen Page is the identity are partner assets.
 */
export function identityAssets(creative: Record<string, unknown>): MetaWriteAsset[] {
  const story = creative.object_story_spec as { page_id?: string; instagram_user_id?: string } | undefined
  const sponsorPage = (creative.facebook_branded_content as { sponsor_page_id?: string } | undefined)?.sponsor_page_id
  const sponsorIg = (creative.instagram_branded_content as { sponsor_id?: string } | undefined)?.sponsor_id
  const out: MetaWriteAsset[] = []
  if (story?.page_id) out.push({ id: story.page_id, kind: 'identitypage', ...(sponsorPage ? { with: sponsorPage } : {}) })
  else if (sponsorPage) out.push({ id: sponsorPage, kind: 'partnerpage' })
  const ig = story?.instagram_user_id ?? (typeof creative.instagram_user_id === 'string' ? creative.instagram_user_id : undefined)
  if (ig) out.push({ id: ig, kind: 'identityinstagram', ...(sponsorIg ? { with: sponsorIg } : {}) })
  else if (sponsorIg) out.push({ id: sponsorIg, kind: 'partnerinstagram' })
  return out
}

/** The ids inside a creative, deduplicated, at most this many (a creative of 49 assets per kind stays far below). */
export const META_CREATIVE_MAX_ASSETS = 150

/**
 * THE judge of a creative's form parameters as the gateway receives them (a JSON key as its JSON text): every key on the
 * allow-list, each JSON key in ONE spelling (exactly what JSON.stringify writes of what was judged), every value judged, the
 * silent features all present. Returns the decoded creative and its ids, or why not.
 */
export function judgeCreativeForm(params: ReadonlyMap<string, string>, skip: readonly string[] = []): { creative: Record<string, unknown>; assets: MetaWriteAsset[] } | { problem: string } {
  const creative: Record<string, unknown> = {}
  const story = params.get('object_story_spec')
  const walk = newCreativeWalk(!!params.get('instagram_user_id') || (!!story && /"instagram_user_id"/.test(story)))
  for (const [key, raw] of params) {
    if (skip.includes(key)) continue
    let value: unknown = raw
    if (isJsonCreativeKey(key)) {
      try { value = JSON.parse(raw) } catch { return { problem: `${key} is JSON` } }
    }
    const judged = judgeCreativeKey(key, value, walk)
    if ('problem' in judged) return judged
    if (isJsonCreativeKey(key) && JSON.stringify(judged.value) !== raw) return { problem: `${key} is written in one spelling (as JSON.stringify writes it: no duplicate member, no other number or escape form, no spaces)` }
    creative[key] = judged.value
  }
  return finishCreative(creative, walk)
}

/** After a creative's keys were judged: the silent features, the identity, the ids (deduplicated and bounded). */
export function finishCreative(creative: Record<string, unknown>, walk: CreativeWalk): { creative: Record<string, unknown>; assets: MetaWriteAsset[]; warnings: string[] } | { problem: string } {
  if (!creative.object_story_spec && !creative.object_story_id) return { problem: 'a creative names object_story_spec (Nexus fills the chosen Page) or object_story_id (a post of the chosen Page)' }
  if (creative.object_story_spec && creative.object_story_id) return { problem: 'a creative names object_story_spec or object_story_id, not both' }
  const silent = silentFeaturesProblem(creative)
  if (silent) return { problem: silent }
  const seen = new Set<string>()
  const assets = [...identityAssets(creative), ...walk.assets].filter((a) => {
    const key = `${a.kind}:${a.id}:${a.with ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (assets.length > META_CREATIVE_MAX_ASSETS) return { problem: `a creative names at most ${META_CREATIVE_MAX_ASSETS} ids` }
  // An element of an Instant Experience is checked against the creative's own experience (its canvas_doc link).
  const canvases = assets.filter((a) => a.kind === 'canvas')
  for (const a of assets) {
    if (a.kind !== 'canvaselement') continue
    if (canvases.length !== 1) return { problem: 'collection_thumbnails go with exactly one Instant Experience link (https://fb.com/canvas_doc/<id>)' }
    a.with = canvases[0].id
  }
  return { creative, assets, warnings: walk.warnings }
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A creative of 49 assets per kind in several languages form-encodes letters outside ASCII at up to 12 characters each. */
export const META_CREATIVE_MAX_BODY = 600_000
const VALIDATE_ONLY = '["validate_only"]'
const CREATIVE_JSON_TEXT: Record<string, RegExp> = Object.fromEntries(Object.keys(CREATIVE_KEYS).map((k) => [k, META_MEDIA_TEXT_PATTERN]))
const ACCOUNT = ['adaccount'] as const
const CREATIVE = ['creative'] as const

const createJudge = (params: ReadonlyMap<string, string>): string | null => {
  if (params.has('execution_options') && params.get('execution_options') !== VALIDATE_ONLY) return `the only execution_options Nexus sends is exactly ${VALIDATE_ONLY} (Meta's check, which changes nothing)`
  const judged = judgeCreativeForm(params, ['execution_options'])
  return 'problem' in judged ? judged.problem : null
}
const createAssets = (params: ReadonlyMap<string, string>): MetaWriteAsset[] => {
  const judged = judgeCreativeForm(params, ['execution_options'])
  return 'problem' in judged ? [] : judged.assets
}
/** The async job's creative_spec: the same creative as one JSON object (its parts as objects, not as JSON text). */
function asyncSpec(raw: string | undefined): { creative: Record<string, unknown>; assets: MetaWriteAsset[] } | { problem: string } {
  let spec: unknown
  try { spec = JSON.parse(raw ?? '') } catch { return { problem: 'creative_spec is JSON' } }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { problem: 'creative_spec is a JSON object' }
  const walk = newCreativeWalk()
  const creative: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec as Record<string, unknown>)) {
    const judged = judgeCreativeKey(key, value, walk)
    if ('problem' in judged) return { problem: `creative_spec.${judged.problem}` }
    creative[key] = judged.value
  }
  if (JSON.stringify(creative) !== raw) return { problem: 'creative_spec is written in one spelling (as JSON.stringify writes it)' }
  if (typeof creative.name !== 'string') return { problem: 'creative_spec names the creative (name)' }
  return finishCreative(creative, walk)
}
const labelsJudge = (value: string): string | null => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return 'adlabels is JSON' }
  const judged = labels(parsed, 'adlabels', newCreativeWalk())
  if ('problem' in judged) return judged.problem
  return JSON.stringify(judged.value) === value ? null : 'adlabels is written in one spelling (as JSON.stringify writes it)'
}

/** Step 25 — create-meta-creative's and set-meta-creative's entries of the write allow-list (meta-calls.ts writeRules). */
export const META_CREATIVE_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // M5-11 … M5-24, M5-29 … M5-31 (master CR-013 …): a creative of the chosen ad account, and Meta's check of it.
    name: 'adaccount.creative.create', method: 'POST', path: /^act_\d{1,20}\/adcreatives$/, kinds: ACCOUNT,
    required: ['name', 'degrees_of_freedom_spec', 'contextual_multi_ads', 'format_transformation_spec', 'asset_feed_spec', 'destination_spec'],
    // The keys Nexus answers in words (META_CREATIVE_REFUSED) match the rule so that its judge says why; it refuses each.
    optional: [...Object.keys(CREATIVE_KEYS).filter((k) => !['name', 'degrees_of_freedom_spec', 'contextual_multi_ads', 'format_transformation_spec', 'asset_feed_spec', 'destination_spec'].includes(k)), ...Object.keys(META_CREATIVE_REFUSED), 'execution_options'],
    anyOf: ['object_story_spec', 'object_story_id'],
    text: CREATIVE_JSON_TEXT, maxBody: META_CREATIVE_MAX_BODY, edgeCall: true, budget: false, check: true,
    values: createJudge, assets: createAssets,
  },
  {
    // M5-33 (master CR-033): the same creative as Meta's asynchronous job — notification_mode OFF only (Nexus gives Meta no
    // address to call back; it reads the job itself).
    name: 'adaccount.creative.async', method: 'POST', path: /^act_\d{1,20}\/asyncadcreatives$/, kinds: ACCOUNT,
    required: ['name', 'creative_spec'], optional: ['notification_mode'],
    text: { name: META_MEDIA_TEXT_PATTERN, creative_spec: META_MEDIA_TEXT_PATTERN }, maxBody: META_CREATIVE_MAX_BODY, edgeCall: true, budget: false,
    values: (params) => {
      const name = metaCreativeTextProblem(params.get('name') ?? '', META_CREATIVE_TEXT.name, 'name')
      if (name) return name
      if (params.has('notification_mode') && params.get('notification_mode') !== 'OFF') return 'notification_mode is OFF (Nexus gives Meta no address to call back)'
      const judged = asyncSpec(params.get('creative_spec'))
      return 'problem' in judged ? judged.problem : null
    },
    assets: (params) => {
      const judged = asyncSpec(params.get('creative_spec'))
      return 'problem' in judged ? [] : judged.assets
    },
  },
  {
    // M5-31 (master CR-010, CR-011): all Meta lets change on a creative — its name, its labels (the whole list), its status
    // (ACTIVE: DELETED is the delete, its own explicit step; IN_PROCESS and WITH_ISSUES are Meta's own review states).
    name: 'creative.update', method: 'POST', path: /^\d{1,20}$/, kinds: CREATIVE,
    required: [], optional: ['name', 'status', 'adlabels'], anyOf: ['name', 'status', 'adlabels'],
    text: { name: META_MEDIA_TEXT_PATTERN, adlabels: META_MEDIA_TEXT_PATTERN }, budget: false,
    values: (params) => {
      if (params.has('name')) { const p = metaCreativeTextProblem(params.get('name')!, META_CREATIVE_TEXT.name, 'name'); if (p) return p }
      if (params.has('status') && params.get('status') !== 'ACTIVE') return 'status is ACTIVE (DELETED is a delete, asked on its own; IN_PROCESS and WITH_ISSUES are Meta\'s own review states)'
      if (params.has('adlabels')) return labelsJudge(params.get('adlabels')!)
      return null
    },
  },
  {
    // M5-31 (master CR-009): labels added to a creative (a name alone makes the label in the chosen account).
    name: 'creative.adlabels', method: 'POST', path: /^\d{1,20}\/adlabels$/, kinds: CREATIVE,
    required: ['adlabels'], optional: [], text: { adlabels: META_MEDIA_TEXT_PATTERN }, budget: false,
    values: (params) => labelsJudge(params.get('adlabels')!),
  },
  {
    // M5-32: create-meta-creative's undo of a creative it made NEW (no body). Lane C1's step 22 (remove-meta-ads-items)
    // reuses it for a delete a person asks for.
    name: 'creative.remove', method: 'DELETE', path: /^\d{1,20}$/, kinds: CREATIVE,
    required: [], optional: [], budget: false,
    values: () => null,
  },
]
