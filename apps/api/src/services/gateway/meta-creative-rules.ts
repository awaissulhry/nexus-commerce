/**
 * Meta step 25 (2026-10-21) — the write allow-list entries of create-meta-creative and set-meta-creative, and THE one judge
 * of a creative's parameters (the tool builds with it, the gateway judges with it: one implementation, never a copy).
 *
 *   adaccount.creative.create   POST /act_<id>/adcreatives        a creative of the chosen ad account (and Meta's check of
 *                                                                 it: validate_only IS documented on this edge)
 *   adaccount.creative.async    POST /act_<id>/asyncadcreatives   the same creative as Meta's asynchronous job (M5-33)
 *   creative.update             POST /<creative id>               name, status, adlabels — all Meta lets change (CR-010/011)
 *   creative.adlabels           POST /<creative id>/adlabels      labels added (CR-009)
 * create-meta-creative's undo (DELETE /<creative id> of a creative it made NEW) goes by step 22's `creative.delete` rule
 * (meta-remove-rules.ts), the same DELETE a person's explicit remove-meta-ads-items sends.
 *
 * Every JSON spec is an ALLOW-list at every depth (CREATIVE_KEYS below): a key not named at its depth is refused, a value
 * is judged by its own judge (a person's text — any language, accents, €, emoji, but no bidirectional control and at least
 * one visible character; a link — https, a public host, no key or signature in it; an id — digits; an enum — Meta's own
 * list), a JSON value is written in ONE spelling (exactly as JSON.stringify writes what was judged: no duplicate member, no
 * other number form, no escape Nexus would not write). Each id inside a creative is handed to the gateway as an asset, which
 * checks it before anything is sent (gateway.ts metaMediaAssetsProblem): the identity Page and Instagram account are the
 * business's CHOSEN ones (a partnership ad's partner only beside the chosen one, never another Nexus business's), an image
 * hash is in the chosen account's library, a video in its video library, a post / Instant Experience / lead form / event is
 * the chosen Page's (an upcoming event the chosen Instagram account's). A product set (product_set_id, a template's
 * boosted_product_set_id, product extensions' associated_product_set_id) and a catalog item (a product tag's product_id,
 * product_data's product_id) go to the gateway as body ids (`productset`, `productitem`): step 18's ONE catalog rule
 * (marketing/meta-ads/catalog-rule.ts metaCatalogProblem, step 12's read rule) — the tool asks it before the preview, the
 * gateway again before it sends (metaBodyIdsProblem).
 *
 * The silent features (lane prompt, binding): every creative Nexus sends carries an explicit `enroll_status` for EVERY
 * Advantage+ creative feature Meta names (META_CREATIVE_FEATURES) and `contextual_multi_ads`; the other silent keys by
 * what the creative DOES, fail-safe (review round 2, silentKeysFor): `asset_feed_spec.audios` beside a story,
 * `format_transformation_spec` and `destination_spec` wherever any website destination or catalog part is, the product-tag
 * enroll_status wherever images are, `multi_share_optimized` on every carousel — the gateway refuses a creative without
 * one of them; its type comes from its main button only, and markers of another type are refused (creativeTypeProblem).
 *
 * Step 26 (2026-10-21) — the SAME judge takes a creative of an EXISTING post (create-meta-boost): exactly one source — a story,
 * a post (object_story_id), an Instagram media (source_instagram_media_id + object_id), an Instagram post link
 * (instagram_permalink_url + object_id) or a creator's partnership ad code (branded_content.instagram_boost_post_access_token +
 * object_id, or facebook_boost_post_access_token) — each source's ids handed to the gateway (sourceAssets): the business's
 * own post / media / link, or a CREATOR's content (branded_content.ad_format named: Meta's "boost existing post" guides put
 * the brand's chosen Page and Instagram account as the SPONSORS then) that Meta's content discovery lists for the brand and
 * that no other Nexus business owns. An ad code is never quoted in a sentence, and its body never reaches the ledger
 * (`secret`). The silent keys follow step 25's rules for an existing post (silentKeysFor / silentKeysToSend /
 * silentFeaturesProblem: isExistingPostCreative); its asset feed carries only music asked or Meta's messaging / profile-visit
 * destinations (DOF_MESSAGING_DESTINATION, UNIFIED_PROFILE_VISIT_DESTINATION, with their call_to_actions). Checked
 * 2026-10-21: ad-creative/partnership-ads/ads-creation/boost-existing-post.md and boost-existing-fb-post.md (object_id,
 * source_instagram_media_id, facebook_branded_content.sponsor_page_id = the brand's Page, instagram_branded_content.sponsor_id =
 * the brand's Instagram account, branded_content {instagram_boost_post_access_token | facebook_boost_post_access_token,
 * ad_format 1 | 2 | 3}), …/supported-configurations/click-to-message-destinations.md (branded_content.promoted_page_id),
 * instagram/ads-api/guides/use-posts-as-ads.md, ad-creative/profile-visit-ads/*.md, threads-ads/creation/use-posts-as-ads.md,
 * reference/ad-account/adcreatives.md (instagram_permalink_url "URL for a post on Instagram you want to run as an ad";
 * branded_content ad_format enum {0, 1, 2, 3}); SDK adcreativebrandedcontentads.py (ad_format int, promoted_page_id string).
 *
 * Step 27 (2026-10-21) — the SAME judge takes a new ad's INLINE creative (create-meta-ad: judgeCreativeSpec, the creative as
 * one JSON object). Only there may a website ad carry a "message us" footer (asset_feed_spec.message_extensions: whatsapp,
 * messenger or instagram_message, beside a website link and button — the creative edge and the async job refuse it, Meta
 * answers error 3: ad-creative/messaging-ads/website-ads-click-to-message.md). media_sourcing_spec also takes a multi-media
 * ad (ad-creative/multi-media-ads.md: up to 10 images and videos, each with its source and opt_in_status said, per-media
 * text, landing page, placement exclusions, crops and persona — out-of-cycle-changes/occ-2026.md 2026-10-19; SDK
 * adcreativemediasourcingspec.py). judgeAssetGroups (flexible-ad-format.md) and judgeAdPersona judge an ad's own JSON parts.
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
import type { MetaWriteAsset, MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { BIDI_CONTROLS, META_MEDIA_TEXT_PATTERN, metaPublicLinkProblem, VISIBLE } from './meta-media-rules.js'
// Step 39's import rule: META_VALIDATE_ONLY from the leaf meta-write-check.ts, never a value from meta-calls.ts (only types).
import { META_VALIDATE_ONLY } from './meta-write-check.js'

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
/** `ids`: the body ids other steps already check (step 22's library `video`, step 19's chosen `page`). */
export interface CreativeWalk { assets: MetaWriteAsset[]; ids: MetaWriteBodyId[]; warnings: string[]; nodes: number; instagram: boolean }
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
/**
 * An Instant Experience's link (`https://fb.com/canvas_doc/<id>`, collection-ads guide): its id goes to the gateway's check.
 * Step 27b re-review #4 — no leading zero, as meta-canvas-rules.ts META_CANVAS_LINK.
 */
const CANVAS_LINK = /^https:\/\/fb\.com\/canvas_doc\/([1-9]\d{0,19})$/
/**
 * A link a creative names: https, a public host, no key or signature (step 23's rule). Review A5 — a link to an Instant
 * Experience is taken in Meta's ONE documented form only (`https://fb.com/canvas_doc/<id>`: no www, facebook.com, slash,
 * query or other path), and its id goes to the gateway's check wherever the link appears.
 */
const link: Judge = (value, path, walk) => {
  if (typeof value !== 'string') return no(`${path} is an https link`)
  const problem = metaPublicLinkProblem(value, path, LINK_MAX)
  if (problem) return no(problem)
  const url = new URL(value)
  // Review round 2 — a link to fb.com / facebook.com is written plainly: %-encoding could hide a canvas_doc path.
  if (/(^|\.)(fb|facebook)\.com$/.test(url.hostname) && /%/.test(`${url.pathname}${url.search}`)) return no(`${path}: a link to ${url.hostname} is written without %-encoding`)
  // Review round 4 — Meta's link-redirect pages (l.facebook.com/l.php?u=…, flx/warn, l.instagram.com) hide the real website.
  if (metaRedirectLink(url)) return no(`${path}: name the website itself, not Meta's redirect page (${url.hostname}${url.pathname})`)
  // Catalog review — a collection's Instant Experience may hold a canvas_product_set (collection-ads.md step 2: a product
  // set with show_in_feed true). Here the experience is checked as the chosen Page's; its product set is the Instant
  // Experience tools' to check against the catalog rule when they come (after #714): LIVE-PROBES CR-471c.
  if (/(^|\.)(fb|facebook)\.com$/.test(url.hostname) && /canvas/i.test(`${url.pathname}${url.search}`)) {
    const canvas = CANVAS_LINK.exec(value)
    if (!canvas) return no(`${path}: an Instant Experience link is exactly https://fb.com/canvas_doc/<id> (Meta's collection-ads guide), nothing else`)
    walk.assets.push({ id: canvas[1], kind: 'canvas' })
  }
  return ok(value)
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
  if (/(^|\.)(fbcdn\.net|cdninstagram\.com|facebook\.com|fb\.com|fbsbx\.com)$/.test(new URL(String(value)).hostname)) return no(`${path}: Meta says not to use image links it returned ("host the image on your own servers"): upload it with create-meta-media and use its hash`)
  warn(walk, 'Meta fetches a picture link itself (a JPG or PNG of at most 8 MB; error 3858258 when the site\'s robots.txt blocks it) and copies it into the ad account\'s library: Nexus fetches nothing.')
  return out
}
/** The call-to-action link: an https link, or `tel:+<digits>` for a call ad (CALL_NOW, master CR-250). */
const ctaLink: Judge = (value, path, walk) => (typeof value === 'string' && /^tel:\+\d{6,15}$/.test(value) ? ok(value) : link(value, path, walk))
/** A display link (`caption`, `display_url`: "must be an actual URL"): an https link or a bare host with a path. */
const displayLink: Judge = (value, path, walk) => (typeof value === 'string' && /^(?!https?:)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[A-Za-z0-9._~\-/]*)?$/.test(value) && value.length <= LINK_MAX ? ok(value) : link(value, path, walk))
/**
 * An Instagram app link for the unified profile visit (master CR-225). Step 26 (review B5) — multidestination-profile-visit.md writes it `instagram://user?username=<IG_USERNAME>&userid=<IG_USER_ID>`:
 * the user id, when named, goes to the gateway's check as step 31's `instagram` body id (the chosen Instagram account).
 */
const instagramAppLink: Judge = (value, path, walk) => {
  const m = typeof value === 'string' ? /^instagram:\/\/user\?username=[A-Za-z0-9._]{1,30}(?:&userid=([1-9]\d{0,24}))?$/.exec(value) : null
  if (!m) return no(`${path} is instagram://user?username=<the Instagram username>[&userid=<its id>] (Nexus has no app of its own)`)
  if (m[1]) walk.ids.push({ id: m[1], kind: 'instagram' })
  return ok(value)
}
// Review round 2 (step 26) — a Meta id never starts with 0 (`0<id>` would slip past a "not the chosen one" compare).
const digits = (value: unknown) => (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null)
/** A Meta id (digits, written as a string), handed to the gateway's check as this kind of asset. */
const id = (kind: MetaWriteAsset['kind']): Judge => (value, path, walk) => {
  const v = digits(value)
  if (!v) return no(`${path} is a Meta id (digits, as a string)`)
  walk.assets.push({ id: v, kind })
  return ok(v)
}
/**
 * A Meta id checked by the gateway's body-id check of another step (metaBodyIdsProblem): a video of the chosen ad
 * account's library (step 22's `video`), the chosen Page (step 19's `page`), a product set or a catalog item (step 18's
 * catalog rule: `productset`, `productitem`).
 */
const bodyId = (kind: 'video' | 'page' | 'productset' | 'productitem'): Judge => (value, path, walk) => {
  const v = digits(value)
  if (!v) return no(`${path} is a Meta id (digits, as a string)`)
  walk.ids.push({ id: v, kind })
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
/** A position on the media, as a share of its width or height (0 to 1). */
const share: Judge = (value, path) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? ok(value) : no(`${path} is a position from 0 to 1`))
const hex: Judge = (value, path) => (typeof value === 'string' && /^#?[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value) ? ok(value) : no(`${path} is a colour as hex (#RRGGBB)`))
/** A phone number in international form (+<digits>): Meta checks it is the business's own WhatsApp number. */
const phone: Judge = (value, path) => (typeof value === 'string' && /^\+?\d{6,15}$/.test(value) ? ok(value) : no(`${path} is a phone number in international form (+<digits>)`))
/** A locale as Meta writes it in language specs (it_IT, fr_XX). */
const locale: Judge = (value, path) => (typeof value === 'string' && /^[a-z]{2}_[A-Z]{2}$/.test(value) ? ok(value) : no(`${path} is a locale (it_IT, fr_XX)`))
const country: Judge = (value, path) => (typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? ok(value) : no(`${path} is a country code (IT)`))
/** A key Meta takes that Nexus answers in words instead. */
const refuse = (why: string): Judge => (_value, path) => no(`${path}: ${why}`)

/**
 * Master CR-018, CR-471 — the link-data reference documents retailer_item_ids as list<string>, "product IDs provided by the
 * advertiser for Collections": the advertiser's own retailer ids, not Meta ids the catalog rule can check.
 */
const RETAILER_ITEMS = 'Meta takes retailer_item_ids as the advertiser\'s own product ids for a collection, and Nexus cannot check a retailer id against the catalog rule: it names a catalog ad\'s products by its product set (product_set_id), and products shown under an ad by product_data'
/** Review B1 (promo codes) — the two code sources Nexus names; no catalog promotion or Meta offer is a source. */
const PROMO_SOURCES = 'Nexus takes promo codes only from the creative\'s text and its own code (the two sources it names): no catalog promotion or Meta offer is a code source'
const NO_APP = 'Nexus sells online and has no app of its own, so it sends no app link, store link, playable or app id'
const BOOST = 'a creative made from an existing post (the chosen Page\'s post, the chosen Instagram account\'s media, or a creator\'s content or ad code) is made with create-meta-boost'
/**
 * Gap 46b (master CR-331) — a partnership Advantage+ catalog ad (carousel or collection) with an EXISTING post as its intro
 * card: `branded_content.parent_source_instagram_media_id` or `parent_source_facebook_post_id`. Checked 2026-10-26 (curl ≥ 3 s
 * apart): documentation/ads-commerce/marketing-api/ad-creative/partnership-ads/ads-creation/supported-configurations/
 * advantage-catalog-ads.md, "Create an ad creative with an existing post as the parent source" — "Specifies the Instagram
 * media [the Facebook post] to use as the parent source media shown as the intro card", on POST /act_<id>/adcreatives beside
 * the catalog creative's other parameters ("Whether the format is a collection or a carousel depends on other parameters");
 * Meta's Python Business SDK adcreativebrandedcontentads.py: both are strings. ONE of them, and only on a creative that IS a
 * partnership Advantage+ catalog creative (introCardProblem). The post goes to the gateway as an `introsource` asset (`with`:
 * its platform): the business's own (the chosen Page's post, the chosen Instagram account's media), else a partner's that
 * Meta's content discovery lists for the brand, by a partner this creative names (gateway.ts metaIntroCardProblem).
 */
const introPost = (platform: 'INSTAGRAM' | 'FACEBOOK'): Judge => (value, path, walk) => {
  const v = platform === 'INSTAGRAM' ? digits(value) : (typeof value === 'string' && /^[1-9]\d{0,24}_[1-9]\d{0,24}$/.test(value) ? value : null)
  if (!v) return no(platform === 'INSTAGRAM' ? `${path} is an Instagram media id (digits, as a string)` : `${path} is a Facebook post id (<Page id>_<post id>, as a string)`)
  walk.assets.push({ id: v, kind: 'introsource', with: platform })
  return ok(v)
}
/** Gap 46b — the two intro-card keys of branded_content (Meta's partnership catalog-ads guide). */
export const META_INTRO_CARD_KEYS = ['parent_source_instagram_media_id', 'parent_source_facebook_post_id'] as const

/**
 * Step 26 — a creator's partnership ad code (Meta's boost-existing-post guides; master CR-323, CR-325, MD-138): letters,
 * digits and _ = + / - (step 16's look-up takes the same; Meta shows no format, its troubleshooting note calls it "numerical"). A credential-like string: a
 * sentence never quotes it, and a body that carries one never reaches the ledger.
 */
export const META_AD_CODE = /^[A-Za-z0-9_=+/-]{4,200}$/
const adCode: Judge = (value, path) => (typeof value === 'string' && META_AD_CODE.test(value) ? ok(value) : no(`${path} is a partnership ad code as the creator shared it (letters, digits and _ = + / -; Nexus never repeats it)`))
/**
 * Step 26 — master CR-304: a public link to an Instagram post, exactly as Meta's media `permalink` writes it
 * (https://www.instagram.com/p|reel|tv/<shortcode>/); the gateway confirms it is the chosen Instagram account's own media.
 */
export const META_IG_PERMALINK = /^https:\/\/www\.instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]{5,40}\/$/
const igPermalink: Judge = (value, path) => (typeof value === 'string' && META_IG_PERMALINK.test(value) ? ok(value) : no(`${path} is an Instagram post link as Meta writes it (https://www.instagram.com/p/<code>/)`))
/**
 * Review B6 — the reference lists threads_user_id with no description of what it takes; Meta's Threads guide has a Threads
 * ad use the Instagram account ("that Instagram account needs to be used").
 */
const THREADS = 'Meta\'s reference names a Threads id without saying what it takes, and its Threads guide runs Threads ads on the Instagram account ("that Instagram account needs to be used"): Nexus sends no Threads id; Threads delivery comes with the chosen Instagram account and the ad set\'s Threads placement'
/**
 * Review B5 — shop routing sends people to the Page's Facebook or Instagram shop (onsite_destinations, shops_bundle name
 * one). Step 46 — the Owner's rule (2026-10-23): every Meta ad sends people to the business's own shop, on the product's
 * page, so shop routing is never sent (master CR-265 / CR-267: out of scope).
 */
const SHOP = 'every Meta ad sends people to the business\'s own shop, on the product\'s page, never to a Facebook or Instagram shop Meta picks (the Owner\'s rule of 2026-10-23), so Nexus sends no shop routing'

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
      const before = { assets: walk.assets.length, ids: walk.ids.length, warnings: walk.warnings.length }
      const judged = judge(value, path, walk)
      if ('value' in judged) return judged
      walk.assets.length = before.assets
      walk.ids.length = before.ids
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
  'INSTAGRAM_MESSAGE', 'VIEW_INSTAGRAM_PROFILE', 'VISIT_PROFILE', 'GET_EVENT_TICKETS', 'SAVE', 'GET_MOBILE_APP',
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

/** Step 27 (master CR-218) — the channels of a website ad's "message us" footer (asset_feed_spec.message_extensions). */
export const META_MESSAGE_FOOTERS = ['whatsapp', 'messenger', 'instagram_message'] as const

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
  page: bodyId('page'),
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
  video_id: bodyId('video'),
  picture,
  image_hash: hash,
}, ['customization_spec'])

const childAttachment = obj({
  link: link,
  name: text(META_CREATIVE_TEXT.headline),
  description: text(META_CREATIVE_TEXT.description, { lines: true }),
  caption: displayLink,
  image_hash: hash,
  picture,
  video_id: bodyId('video'),
  call_to_action: callToAction,
  image_crops: crops(),
  static_card: bool,
  ig_media_id: refuse(BOOST),
  android_url: refuse(NO_APP),
  ios_url: refuse(NO_APP),
})

/** link_data, and template_data (the same AdCreativeLinkData, with the catalog template keys). */
const linkData = obj({
  link: link,
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
  // Advantage+ catalog template parts (master CR-448…463, CT-106: customization_rules_spec; the product set is the creative's
  // product_set_id, through step 18's catalog rule).
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
  retailer_item_ids: refuse(RETAILER_ITEMS),
  boosted_product_set_id: bodyId('productset'),
})
const photoData = obj({
  image_hash: hash,
  url: picture,
  caption: text(META_CREATIVE_TEXT.message, { lines: true }),
  page_welcome_message: pageWelcome,
  branded_content_sponsor_page_id: sponsorPage,
  branded_content_shared_to_sponsor_status: token,
  image_crops: refuse('Meta takes no crop on a photo post ("Facebook typically renders images from photo posts in full"): use link_data for a cropped image'),
})
const videoData = obj({
  video_id: bodyId('video'),
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
  retailer_item_ids: refuse(RETAILER_ITEMS),
}, ['video_id'])

/**
 * Master CR-041 / CR-211 — catalog items shown under the ad (product extensions; click-to-messenger.md "Add Product
 * Extensions", in object_story_spec and at the creative's top level): [{product_id, product_source MANUAL, product_decision
 * ACCEPT}], each item through step 18's catalog rule.
 */
const productData = list(obj({ product_id: bodyId('productitem'), product_source: enumOf(['MANUAL']), product_decision: enumOf(['ACCEPT']) }, ['product_id', 'product_source', 'product_decision']), 10, 1)

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
  threads_user_id: refuse(THREADS),
  product_data: productData,
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
  videos: list(obj({ video_id: bodyId('video'), thumbnail_url: picture, thumbnail_hash: hash, url_tags: urlTags, adlabels: assetLabels }, ['video_id']), 49),
  bodies: list(textAsset(META_CREATIVE_TEXT.message, { lines: true }), 49),
  titles: list(textAsset(META_CREATIVE_TEXT.headline), 49),
  descriptions: list(textAsset(META_CREATIVE_TEXT.description, { lines: true, blank: true }), 49),
  link_urls: list(obj({ website_url: link, display_url: displayLink, carousel_see_more_url: link, url_tags: urlTags, adlabels: assetLabels, deeplink_url: refuse(NO_APP), android_url: refuse(NO_APP), ios_url: refuse(NO_APP), object_store_urls: refuse(NO_APP), omnichannel_link_spec: refuse(NO_APP) }), 49),
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
  // Review round 3 — instagram/marketing-api/guides/reminder-ads.md: link_data with a LEARN_MORE button and the dummy link
  // https://fb.com/, upcoming_events [{event_id, event_title, start_time "2024-05-11T16:00:00+0000"}] (an ISO time, not seconds).
  upcoming_events: list(obj({ event_id: id('igevent'), event_title: text(META_CREATIVE_TEXT.headline), start_time: (value, path) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/.test(value) && Number.isFinite(Date.parse(value.replace('+0000', 'Z'))) ? ok(value) : no(`${path} is a time as Meta writes it (2026-11-05T16:00:00+0000)`)) }, ['event_id']), 1),
  // Master CR-440: promo codes (review B1, checked on docs/marketing-api/reference/ad-asset-promotional-metadata/): the code
  // sources are always named — only the creative's text and Nexus's own code, never Meta's automatic sources — and at most
  // ONE manual code (2+ characters: letters, digits, - and _). offer_details is not sent; neither is a catalog.
  // Review round 2 — a code holds at least two letters (Meta); each source once; the manual source with its one code, a code
  // only with the manual source.
  promotional_metadata: (value, path, walk) => {
    const judged = obj({
      allowed_coupon_code_sources: list(enumOf(['AD_CREATIVE_PRIMARY_TEXT', 'AD_CREATIVE_MANUAL_COUPON_CODES']), 2, 1),
      manual_coupon_codes: list((code, at) => (typeof code === 'string' && /^(?=(?:[^A-Za-z]*[A-Za-z]){2})[A-Za-z0-9_-]{2,50}$/.test(code) ? ok(code) : no(`${at} is a promo code of 2 to 50 letters, digits, - or _, with at least two letters`)), 1, 1),
      is_auto_update_allowed: enumOfBool(false),
      offer_details: refuse('Meta\'s promotional metadata reference has no offer text Nexus sends: say the offer in the ad\'s text and its disclaimer (ad_disclaimer_spec OFFER_DETAILS)'),
      product_catalog_id: refuse(PROMO_SOURCES),
      allowed_promo_offer_ids: refuse(PROMO_SOURCES),
    }, ['allowed_coupon_code_sources'])(value, path, walk)
    if ('problem' in judged) return judged
    const promo = judged.value as { allowed_coupon_code_sources: string[]; manual_coupon_codes?: string[] }
    if (new Set(promo.allowed_coupon_code_sources).size !== promo.allowed_coupon_code_sources.length) return no(`${path}.allowed_coupon_code_sources names each source once`)
    const manual = promo.allowed_coupon_code_sources.includes('AD_CREATIVE_MANUAL_COUPON_CODES')
    if (manual && !promo.manual_coupon_codes?.length) return no(`${path}: the source AD_CREATIVE_MANUAL_COUPON_CODES goes with its code (manual_coupon_codes)`)
    if (!manual && promo.manual_coupon_codes?.length) return no(`${path}: a manual_coupon_codes code goes only with the source AD_CREATIVE_MANUAL_COUPON_CODES`)
    return judged
  },
  // Step 27 (master CR-218, ad-creative/messaging-ads/website-ads-click-to-message.md) — the "message us" footer of a website
  // ad: ONE channel, Meta's own three words. Only inline on a new ad (create-meta-ad): the creative edge answers error 3.
  message_extensions: list(obj({ type: enumOf(META_MESSAGE_FOOTERS) }, ['type']), 1, 1),
  onsite_destinations: refuse(SHOP),
  shops_bundle: refuse(SHOP),
  app_product_page_id: refuse(NO_APP),
})
/**
 * Step 27 (master CR-427; out-of-cycle-changes/occ-2026.md, 2026-10-19 "Creative audience pairing") — an age and gender
 * persona paired with the whole ad or one image or video: {age_min, age_max, genders}. Nexus's markets are in the EU, where
 * Meta targets nobody under 18 (F1 M6): 18 to 65.
 */
const persona: Judge = (value, path, walk) => {
  const judged = obj({ age_min: int(18, 65), age_max: int(18, 65), genders: list(int(1, 2), 2, 1) })(value, path, walk)
  if ('problem' in judged) return judged
  const p = judged.value as { age_min?: number; age_max?: number; genders?: number[] }
  if (!Object.keys(p).length) return no(`${path} names an age range or genders`)
  if (p.age_min !== undefined && p.age_max !== undefined && p.age_min > p.age_max) return no(`${path}.age_min is at most age_max`)
  if (p.genders && new Set(p.genders).size !== p.genders.length) return no(`${path}.genders names each gender once (1 men, 2 women)`)
  return judged
}

/**
 * Step 27 (master CR-425, CR-426; ad-creative/multi-media-ads.md, SDK adcreativemediasourcingspec.py) — a multi-media ad: up
 * to 10 images and videos, each with its source and its related-media switch said explicitly (opt_in only when asked: the
 * preview names it), per-media text, landing page, placement exclusions, crops and persona; global titles, bodies and
 * descriptions. related_media never beside explicit images or videos; no hash or video twice.
 */
const mediaTextKeys = {
  titles: list(obj({ text: text(META_CREATIVE_TEXT.headline) }, ['text']), 5),
  bodies: list(obj({ text: text(META_CREATIVE_TEXT.message, { lines: true }) }, ['text']), 5),
  descriptions: list(obj({ text: text(META_CREATIVE_TEXT.description, { lines: true }) }, ['text']), 5),
}
const mediaText = obj(mediaTextKeys)
const mediaCommon = {
  source: enumOf(['multi_media']),
  opt_in_status: enumOf(['opt_in', 'opt_out']),
  text_customizations: mediaText,
  destination_customizations: list(obj({ url: link, display_url: displayLink }, ['url']), 1),
  placement_customizations: list(obj({
    publisher_platform: enumOf(['facebook', 'instagram', 'audience_network', 'messenger', 'whatsapp', 'threads']),
    placement_exclusions: list(token, 20, 1),
  }, ['publisher_platform', 'placement_exclusions']), 6),
  creative_audience_pairing_persona: persona,
}
const mediaSourcingSpec: Judge = (value, path, walk) => {
  const judged = obj({
    related_media: obj({ opt_in_status: enumOf(['OPT_IN', 'OPT_OUT']) }, ['opt_in_status']),
    images: list(obj({ hash, url: picture, image_crops: list(obj({ type: enumOf(['manual', 'auto_crop', 'smart_crop', 'super_crop']), crop_spec: crops() }, ['type']), 4), ...mediaCommon }, ['source', 'opt_in_status']), 10),
    // Review B6 — each video names its original video and a thumbnail (its link or how Meta makes it), as the guide asks.
    videos: list(obj({ video_id: bodyId('video'), original_video_id: bodyId('video'), thumbnail_url: picture, thumbnail_source: token, ...mediaCommon }, ['video_id', 'original_video_id', 'source', 'opt_in_status']), 10),
    ...mediaTextKeys,
  })(value, path, walk)
  if ('problem' in judged) return judged
  const m = judged.value as { related_media?: unknown; images?: Array<{ hash?: string; url?: string }>; videos?: Array<{ video_id: string }> }
  const images = m.images ?? []
  const videos = m.videos ?? []
  if (m.related_media && (images.length || videos.length)) return no(`${path}: related_media never goes beside explicit images or videos (Meta's multi-media guide)`)
  if (images.length + videos.length > 10) return no(`${path} holds at most 10 images and videos together`)
  if (images.some((i) => !i.hash === !i.url)) return no(`${path}.images: each image names its hash or its url, one of them`)
  if ((m.videos as Array<{ thumbnail_url?: string; thumbnail_source?: string }> | undefined ?? []).some((v) => !v.thumbnail_url && !v.thumbnail_source)) return no(`${path}.videos: each video names thumbnail_url or thumbnail_source (Meta's multi-media guide)`)
  const hashes = images.map((i) => i.hash).filter(Boolean)
  if (new Set(hashes).size !== hashes.length || new Set(videos.map((v) => v.video_id)).size !== videos.length) return no(`${path} names each image hash and each video once (Meta refuses duplicates)`)
  return judged
}

/** A boolean that may only be this value (Meta's automatic promo-code updates stay off). */
function enumOfBool(only: boolean): Judge {
  return (value, path) => (value === only ? ok(value) : no(`${path} is ${only} (Nexus lets Meta change no promo code by itself)`))
}

/**
 * degrees_of_freedom_spec: only creative_features_spec, each feature's enroll_status, and the customizations Meta documents
 * for that feature (review B3): adapt_to_placement — aspect_ratio_config {ar_4_5 | ar_9_16: {adapt: {enroll_status}}}
 * (reference ad-creative-feature-customizations-aspect-ratios-config → -aspect-ratio-config → -enroll-status),
 * image_crop_style (an enum whose values Meta does not list: passed as Meta's word, Meta's check answers — LIVE-PROBES
 * CR-405) and showcase_card_display NONE | AUTO (catalog, master CR-405); text_optimizations and enhance_cta —
 * text_extraction {enroll_status} (the Advantage+ guide's table). No other feature takes a customization here.
 */
const status = enumOf(['OPT_IN', 'OPT_OUT'])
const enrolled = obj({ enroll_status: status }, ['enroll_status'])
const ratio = obj({ adapt: enrolled }, ['adapt'])
const FEATURE_CUSTOMIZATIONS: Readonly<Record<string, Judge>> = {
  adapt_to_placement: obj({ aspect_ratio_config: obj({ ar_4_5: ratio, ar_9_16: ratio }), image_crop_style: token, showcase_card_display: enumOf(['NONE', 'AUTO']) }),
  text_optimizations: obj({ text_extraction: enrolled }),
  enhance_cta: obj({ text_extraction: enrolled }),
}
/**
 * Master CR-330 / CR-414 — product extensions as Meta's examples send them (advantage-catalog-ads/product-extensions.md, on
 * /adcreatives and /ads; partnership-ads advantage-creative.md): {enroll_status: OPT_IN, action_metadata: {type: MANUAL}}
 * beside creative_sourcing_spec.associated_product_set_id (productExtensionsProblem).
 */
const FEATURE_ACTION_METADATA: Readonly<Record<string, Judge>> = {
  product_extensions: obj({ type: enumOf(['MANUAL']) }, ['type']),
}
const featureDetails = (feature: string): Judge => (value, path, walk) => {
  const judged = obj({
    enroll_status: status,
    ...(FEATURE_CUSTOMIZATIONS[feature] ? { customizations: FEATURE_CUSTOMIZATIONS[feature] } : {}),
    ...(FEATURE_ACTION_METADATA[feature] ? { action_metadata: FEATURE_ACTION_METADATA[feature] } : {}),
  }, ['enroll_status'])(value, path, walk)
  // Review round 2 — a customization (an aspect ratio adapted, text extraction) goes only with its feature switched on.
  if ('value' in judged && (judged.value as { enroll_status?: unknown; customizations?: unknown }).enroll_status === 'OPT_OUT' && (judged.value as { customizations?: unknown }).customizations !== undefined) {
    return no(`${path}.customizations go only with ${feature} switched on (OPT_IN)`)
  }
  if ('value' in judged && (judged.value as { enroll_status?: unknown }).enroll_status === 'OPT_OUT' && (judged.value as { action_metadata?: unknown }).action_metadata !== undefined) {
    return no(`${path}.action_metadata goes only with ${feature} switched on (OPT_IN)`)
  }
  return judged
}
const featuresSpec = obj(Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, featureDetails(f)])))
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
  // Step 26 — its id goes to the gateway from sourceAssets: the chosen Page's post, or a creator's (partnership boost).
  object_story_id: { judge: (value, path) => {
    if (typeof value !== 'string' || !/^[1-9]\d{0,24}_[1-9]\d{0,24}$/.test(value)) return no(`${path} is a post id (<Page id>_<post id>)`)
    return ok(value)
  }, json: false },
  // Step 26 (create-meta-boost) — an Instagram media or post link run as an ad, with the Page (object_id) it runs under.
  object_id: { judge: digitsOnly, json: false },
  source_instagram_media_id: { judge: digitsOnly, json: false },
  instagram_permalink_url: { judge: igPermalink, json: false },
  instagram_user_id: { judge: digitsOnly, json: false },
  asset_feed_spec: { judge: assetFeedSpec, json: true },
  degrees_of_freedom_spec: { judge: degreesOfFreedom, json: true },
  // Master CR-432: enroll_status only (review round 2: Nexus sends no action_metadata).
  contextual_multi_ads: { judge: obj({ enroll_status: enumOf(['OPT_IN', 'OPT_OUT']) }, ['enroll_status']), json: true },
  format_transformation_spec: { judge: formatTransformation, json: true },
  // Master CR-266: the opt-out only (review B5: shop routing names a shop Nexus cannot confirm — SHOP).
  destination_spec: { judge: obj({ destination_type: enumOf(['WEBSITE_AND_SHOP_OPT_OUT']) }, ['destination_type']), json: true },
  url_tags: { judge: urlTags, json: false },
  adlabels: { judge: labels, json: true },
  call_to_action: { judge: callToAction, json: true },
  ad_disclaimer_spec: { judge: obj({ title: enumOf(['DISCLAIMER', 'HEALTH_DISCLAIMER', 'IMPORTANT_SAFETY_INFORMATION', 'MEDICATION_GUIDE', 'OFFER_DETAILS', 'PRESCRIBING_INFORMATION', 'TERMS_AND_CONDITIONS']), text: text(1000, { lines: true }), url: link }, ['title']), json: true },
  portrait_customizations: { judge: obj({ carousel_delivery_mode: enumOf(['fixed_num_cards']), specifications: list(obj({ background_color: obj({ top_color: hex, bottom_color: hex }, ['top_color', 'bottom_color']) }), 10) }), json: true },
  platform_customizations: { judge: obj({ instagram: obj({ image_url: picture, image_hash: hash, image_crops: crops(), video_id: bodyId('video') }) }, ['instagram']), json: true },
  interactive_components_spec: { judge: obj({
    components: list((value, path, walk) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && ((value as Record<string, unknown>).type === 'poll' || 'poll_spec' in (value as object))) return no(`${path}: Meta removed polls from creatives in v26 (all versions from 2026-10-27)`)
      // Master CR-313 (instagram/ads-api/guides/add-interactive-elements.md): a product tagged by hand — product_tag_spec
      // {product_id} (a catalog item, through step 18's catalog rule) and position_spec {x, y} (0 to 1; Meta requires them on
      // images, Nexus always sends them). "You cannot set enroll_status and product_tag_spec at the same time".
      if (value && typeof value === 'object' && !Array.isArray(value) && 'product_tag_spec' in (value as object)) {
        if ('enroll_status' in (value as object)) return no(`${path}: a product tag names its product (product_tag_spec) or Meta's automatic tagging (enroll_status), not both (Meta answers an error)`)
        return obj({ type: enumOf(['product_tag']), product_tag_spec: obj({ product_id: bodyId('productitem') }, ['product_id']), position_spec: obj({ x: share, y: share }, ['x', 'y']) }, ['type', 'product_tag_spec', 'position_spec'])(value, path, walk)
      }
      // Master CR-314: the automatic product tags, said explicitly (opt_out unless the request asks: then opt_in — LIVE-PROBES CR-314).
      return obj({ type: enumOf(['product_tag']), enroll_status: enumOf(['opt_out', 'opt_in']) }, ['type', 'enroll_status'])(value, path, walk)
    }, 10),
  }), json: true },
  // Step 26 — a creator's content (create-meta-boost): the identities the ad shows (ad_format 1 both, 2 the first, 3 Meta
  // picks — Instagram only; SDK: int), the creator's ad code, the Page a partnership messaging ad opens (the chosen one).
  branded_content: { judge: obj({
    testimonial: text(500, { lines: true }), testimonial_locale: locale,
    ad_format: int(1, 3),
    instagram_boost_post_access_token: adCode,
    facebook_boost_post_access_token: adCode,
    promoted_page_id: bodyId('page'),
    // Gap 46b (master CR-331) — an existing post as a partnership catalog ad's intro card (introCardProblem says where).
    parent_source_instagram_media_id: introPost('INSTAGRAM'), parent_source_facebook_post_id: introPost('FACEBOOK'),
    partners: refuse('Nexus names ONE partner: create-meta-creative partner (new media) or create-meta-boost (a creator\'s content)'),
  }), json: true },
  facebook_branded_content: { judge: obj({ sponsor_page_id: digitsOnly, shared_to_sponsor_status: token, sponsor_relationship: token }, ['sponsor_page_id']), json: true },
  instagram_branded_content: { judge: obj({ sponsor_id: digitsOnly }, ['sponsor_id']), json: true },
  creative_sourcing_spec: { judge: obj({
    site_links_spec: list(obj({ site_link_title: text(META_CREATIVE_TEXT.headline), site_link_url: link, site_link_image_hash: hash, site_link_image_url: picture }, ['site_link_title', 'site_link_url']), 10),
    // Master CR-330 / CR-414 — product extensions: the product set shown under the ad (step 18's catalog rule).
    associated_product_set_id: bodyId('productset'),
  }), json: true },
  // Step 27 — related media, or a multi-media ad's images and videos (CR-425 … CR-427: mediaSourcingSpec).
  media_sourcing_spec: { judge: mediaSourcingSpec, json: true },
  marketing_message_structured_spec: { judge: obj({ language: locale, conversation_template_id: scopedId, footer: text(60), greeting: text(META_CREATIVE_TEXT.greeting, { lines: true }), is_optimized_text: bool }), json: true },
  recommender_settings: { judge: obj({ preferred_events: list(enumOf(['ViewContent', 'Search', 'AddToCart', 'AddToWishlist', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Subscribe', 'RecurringSubscriptionPayment', 'Lead', 'CompleteRegistration', 'CustomConversion', 'AggregateCustomConversion', 'Other']), 14), product_sales_channel: enumOf(['ONLINE', 'IN_STORE', 'OMNI']) }), json: true },
  template_url_spec: { judge: templateUrl, json: true },
  categorization_criteria: { judge: enumOf(['brand', 'category', 'product_type']), json: false },
  category_media_source: { judge: enumOf(['CATEGORY', 'MIXED', 'PRODUCTS_COLLAGE', 'PRODUCTS_SLIDESHOW']), json: false },
  object_type: { judge: enumOf(['SHARE', 'VIDEO', 'EVENT', 'PHOTO', 'STATUS']), json: false },
  // Master CR-234, CR-263, CR-448…465 — the Advantage+ catalog creative's product set (step 18's catalog rule).
  product_set_id: { judge: bodyId('productset'), json: false },
  // Master CR-041 / CR-211 — catalog items under the ad (product extensions), at the creative's top level.
  product_data: { judge: productData, json: true },
}

/**
 * Keys Meta takes on the creative edge that Nexus answers in words (CREATIVE_KEYS refuses every other one by name too).
 * The sentences are the tool's and the gateway's.
 */
export const META_CREATIVE_REFUSED: Readonly<Record<string, string>> = {
  authorization_category: 'Nexus never declares a political or social-issue ad: they are banned in the EU since 2025-10-06 (Meta\'s TTPA rules), Nexus\'s markets',
  wamo_whatsapp_identity_spec: 'WhatsApp Status ads with a WhatsApp identity do not run in the EU, Nexus\'s markets (Meta\'s ads-in-whatsapp-status guide)',
  regional_regulation_disclaimer_spec: 'the regional finance disclaimers are for Taiwan, Australia, India and Singapore, not Nexus\'s EU markets',
  threads_user_id: THREADS,
  applink_treatment: NO_APP, object_store_url: NO_APP, playable_asset_id: NO_APP, enable_direct_install: NO_APP, enable_launch_instant_app: NO_APP,
  use_page_actor_override: NO_APP, omnichannel_link_spec: NO_APP,
  place_page_set_id: 'Nexus sells online and keeps no store-location pages (a place page set), so it makes no dynamic local ad',
  dynamic_ad_voice: 'Nexus sells online and keeps no store-location pages (a place page set), so it makes no dynamic local ad',
  source_facebook_post_id: BOOST,
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
export const newCreativeWalk = (instagram = false): CreativeWalk => ({ assets: [], ids: [], warnings: [], nodes: 0, instagram })

/** One key of a creative, decoded (a JSON key as its object), judged; the cleaned value or why not. */
export function judgeCreativeKey(key: string, value: unknown, walk: CreativeWalk): Out {
  if (Object.prototype.hasOwnProperty.call(META_CREATIVE_REFUSED, key)) return no(`${key}: ${META_CREATIVE_REFUSED[key]}`)
  if (!Object.prototype.hasOwnProperty.call(CREATIVE_KEYS, key)) return no(`${key.slice(0, 60)} is not a key Nexus sends on a creative`)
  return CREATIVE_KEYS[key].judge(value, key, walk)
}
export const isJsonCreativeKey = (key: string) => Object.prototype.hasOwnProperty.call(CREATIVE_KEYS, key) && CREATIVE_KEYS[key].json

// ── the silent keys a creative carries (review B, made fail-safe in review round 2) ─────────────────────────────────

/** Does any member named `key`, at any depth, pass `pred`? */
function anyMember(value: unknown, key: string, pred: (v: unknown) => boolean = () => true, depth = 0): boolean {
  if (depth > 12 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => anyMember(v, key, pred, depth + 1))
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => (k === key && pred(v)) || anyMember(v, key, pred, depth + 1))
}
/** Every value under `key`, at any depth. */
function membersOf(value: unknown, key: string, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > 12 || !value || typeof value !== 'object') return out
  if (Array.isArray(value)) { for (const v of value) membersOf(v, key, out, depth + 1); return out }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) { if (k === key) out.push(v); membersOf(v, key, out, depth + 1) }
  return out
}
const MESSAGING_CTAS = new Set(['MESSAGE_PAGE', 'WHATSAPP_MESSAGE', 'INSTAGRAM_MESSAGE'])
const PROFILE_CTAS = new Set(['VIEW_INSTAGRAM_PROFILE', 'VISIT_PROFILE'])
const EVENT_CTAS = new Set(['EVENT_RSVP', 'BUY_TICKETS', 'GET_EVENT_TICKETS'])

/**
 * Review round 2 — the TYPE of a creative is read ONLY from its main call to action (the story's link / video / template
 * data, the top-level one of an existing post, or the asset feed's first) and the asset feed's optimization_type — never
 * from a key anywhere in the body (one stray key must not change what the creative is). `standard`: a shop, website or
 * other button.
 */
export type CreativeType = 'messaging' | 'call' | 'profile' | 'lead' | 'event' | 'standard'
export function creativeTypeOf(creative: Record<string, unknown>): CreativeType {
  const story = (creative.object_story_spec ?? {}) as Record<string, { call_to_action?: { type?: unknown; value?: Record<string, unknown> } } | undefined>
  const feed = (creative.asset_feed_spec ?? {}) as { optimization_type?: unknown; call_to_action_types?: unknown[]; call_to_actions?: Array<{ type?: unknown; value?: Record<string, unknown> }> }
  const main = story.link_data?.call_to_action ?? story.video_data?.call_to_action ?? story.template_data?.call_to_action
    ?? (creative.call_to_action as { type?: unknown; value?: Record<string, unknown> } | undefined) ?? feed.call_to_actions?.[0]
    ?? (feed.call_to_action_types?.length ? { type: feed.call_to_action_types[0] } : undefined)
  const type = typeof main?.type === 'string' ? main.type : ''
  if (feed.optimization_type === 'DOF_MESSAGING_DESTINATION' || MESSAGING_CTAS.has(type) || !!main?.value?.app_destination) return 'messaging'
  if (feed.optimization_type === 'UNIFIED_PROFILE_VISIT_DESTINATION' || PROFILE_CTAS.has(type)) return 'profile'
  if (type === 'CALL_NOW') return 'call'
  if (main?.value?.lead_gen_form_id) return 'lead'
  if (EVENT_CTAS.has(type)) return 'event'
  return 'standard'
}

/**
 * Review round 2 — the markers in a body and the type each needs: a body whose markers contradict its type is refused
 * (a stray messaging, call, profile, lead or event part under a shop button). Returns why, or null.
 */
export function creativeTypeProblem(creative: Record<string, unknown>): string | null {
  const type = creativeTypeOf(creative)
  const ctaTypes = [
    ...membersOf(creative, 'call_to_action').map((c) => (c && typeof c === 'object' ? (c as { type?: unknown }).type : null)),
    ...membersOf(creative, 'call_to_actions').flatMap((l) => (Array.isArray(l) ? l.map((c) => (c as { type?: unknown } | null)?.type) : [])),
    ...membersOf(creative, 'call_to_action_types').flatMap((l) => (Array.isArray(l) ? l : [])),
  ].filter((t): t is string => typeof t === 'string')
  const markers: Array<[CreativeType, boolean, string]> = [
    ['messaging', anyMember(creative, 'app_destination') || anyMember(creative, 'page_welcome_message') || anyMember(creative, 'partner_app_welcome_message_flow_id')
      || anyMember(creative, 'whats_app_business_phone_number') || !!creative.marketing_message_structured_spec
      || ctaTypes.some((t) => MESSAGING_CTAS.has(t)), 'a messaging part (a messaging destination, a welcome message, a WhatsApp number or message)'],
    ['call', anyMember(creative, 'call_ads_configuration') || anyMember(creative, 'link', (v) => typeof v === 'string' && v.startsWith('tel:')) || ctaTypes.includes('CALL_NOW'), 'a call part (CALL_NOW, a tel: link, call_ads_configuration)'],
    ['profile', ctaTypes.some((t) => PROFILE_CTAS.has(t)), 'a profile-visit button'],
    ['lead', anyMember(creative, 'lead_gen_form_id'), 'a lead form'],
    // Review round 3 — an asset feed's upcoming_events (a reminder ad, CR-261: Meta's guide uses LEARN_MORE) are not an event ad.
    ['event', creative.object_type === 'EVENT' || anyMember(creative.object_story_spec, 'event_id') || anyMember(creative.call_to_action, 'event_id')
      || anyMember((creative.asset_feed_spec as { call_to_actions?: unknown } | undefined)?.call_to_actions, 'event_id') || ctaTypes.some((t) => EVENT_CTAS.has(t)), 'an event part (object_type EVENT, an event id, an event button)'],
  ]
  for (const [needs, present, what] of markers) {
    // A multi-destination feed's buttons are all messaging ones, a unified profile visit's all profile ones (CR-217, CR-225).
    if (present && needs !== type) {
      return `the creative's main button makes it a ${type} creative, and it carries ${what}, which goes only with a ${needs} creative: name one kind of creative`
    }
  }
  // Step 27 (master CR-218) — a "message us" footer goes only on a WEBSITE ad with a website button: Meta's guide names
  // LEARN_MORE "or other website CTAs" and says messaging buttons are "not compatible" (website-ads-click-to-message.md).
  if (anyMember(creative, 'message_extensions') && (type !== 'standard' || !hasWebsiteDestination(creative))) {
    return 'a "message us" footer (asset_feed_spec.message_extensions) goes only on a website ad: a website link and a website button such as LEARN_MORE, never a messaging button'
  }
  return null
}

/**
 * Step 27 (master CR-218) — what only an ad's inline creative may carry: Meta answers error 3 for a creative made on its own
 * with a "message us" footer ("Creating a standalone creative via POST /adcreatives with message_extensions is not
 * supported", website-ads-click-to-message.md). Why not on the creative edge, or null.
 */
export function inlineOnlyProblem(creative: Record<string, unknown>): string | null {
  return anyMember(creative.asset_feed_spec, 'message_extensions')
    ? 'a "message us" footer (asset_feed_spec.message_extensions) is made only inline on a new ad (create-meta-ad messageFooter): Meta answers error 3 for a creative made on its own with one'
    : null
}

/** Format automation formats Meta documents for catalog creatives only (format-automation; master CR-420, CR-421). */
export const META_CATALOG_FORMATS: readonly string[] = ['da_collection', 'catalog_single_media']
/** The rest: a single image or video, or a carousel (master CR-422, CR-423). */
export const META_NON_CATALOG_FORMATS: readonly string[] = META_FORMAT_AUTOMATION_FORMATS.filter((f) => !META_CATALOG_FORMATS.includes(f))

/**
 * The keys whose https value is a WEBSITE destination. Review round 3 — Meta's own destinations are not: an Instant
 * Experience, Messenger (fb.com/messenger_doc, m.me), a Facebook Page, Instagram, WhatsApp (wa.me, api.whatsapp.com); nor tel:.
 */
const DESTINATION_KEYS = ['link', 'product_link', 'website_url', 'carousel_see_more_url', 'site_link_url']
// Step 27b — exported: an Instant Experience part's links follow the same rule (meta-canvas-rules.ts).
export const META_OWNED_HOST = /(^|\.)(fb\.com|facebook\.com|m\.me|messenger\.com|instagram\.com|wa\.me|whatsapp\.com|threads\.net)$/
/**
 * Review round 4 — a Meta link that carries another site: a redirect host (`l.` / `lm.`), a redirect path (`/l.php`, `/l/`,
 * `/flx/`), or a query value that is itself a web address. The link judge refuses it; isWebsite counts it as a website
 * (fail safe: the opt-outs are then required).
 */
function metaRedirectLink(url: URL): boolean {
  if (!META_OWNED_HOST.test(url.hostname)) return false
  if (/^(l|lm)\./.test(url.hostname)) return true
  if (/^\/(l\.php|l\/|flx\/)/i.test(url.pathname)) return true
  return [...url.searchParams.values()].some((v) => /^(https?:|\/\/|www\.)/i.test(v.trim()) || /:\/\//.test(v))
}
const isWebsite = (v: unknown) => {
  if (typeof v !== 'string' || !v.startsWith('https://')) return false
  try {
    const url = new URL(v)
    return !META_OWNED_HOST.test(url.hostname) || metaRedirectLink(url)
  } catch { return false }
}
/** Does the body name an https website destination anywhere (a link, a card's link, a button's link, a feed link, a template URL)? */
export function hasWebsiteDestination(creative: Record<string, unknown>): boolean {
  return DESTINATION_KEYS.some((k) => anyMember(creative, k, isWebsite)) || anyMember(creative.template_url_spec, 'url', isWebsite)
}
/**
 * Catalog markers (master CR-448 …; catalog review of step 25) — EVERY catalog part, at any depth, fail safe: a template,
 * a product set (the creative's, a template's boosted one, product extensions' associated one), product data, a product
 * tagged by hand, recommender or category settings, a template URL. Meta's format-automation guide turns single media into
 * a carousel or sa_collection from the catalog, and catalog single media is "enabled by default for eligible ads", so a
 * creative with ANY of them carries every format opt-out and the shop opt-out (silentKeysFor).
 */
const CATALOG_MARKERS = ['template_data', 'product_set_id', 'boosted_product_set_id', 'associated_product_set_id', 'product_data', 'product_tag_spec', 'recommender_settings', 'categorization_criteria', 'category_media_source', 'template_url_spec']
export function hasCatalogMarker(creative: Record<string, unknown>): boolean {
  return CATALOG_MARKERS.some((k) => anyMember(creative, k))
}
/**
 * Can the creative show an image Meta may tag? Review round 3, fail-safe: an image hash, a picture or an image link at ANY
 * depth (a video's thumbnail and its per-language rules included), asset-feed images, a photo post, or any link_data (a link
 * ad with no image of its own shows the linked page's image).
 */
const IMAGE_KEYS = ['image_hash', 'picture', 'image_url', 'thumbnail_hash', 'thumbnail_url', 'site_link_image_hash', 'site_link_image_url', 'frame_image_hash']
export function hasImages(creative: Record<string, unknown>): boolean {
  const story = (creative.object_story_spec ?? {}) as Record<string, unknown>
  const feed = (creative.asset_feed_spec ?? {}) as { images?: unknown[] }
  return IMAGE_KEYS.some((k) => anyMember(creative, k)) || !!story.link_data || !!story.photo_data || (Array.isArray(feed.images) && feed.images.length > 0)
}

/**
 * Review B, made fail-safe in review round 2 — the silent keys a creative MUST carry, read from what it does, never from a
 * stray key: every Advantage+ feature and contextual_multi_ads always; asset_feed_spec.audios beside an object_story_spec
 * (never on an existing post: Meta's music is an asset-feed opt-in, and the post keeps its own media — LIVE-PROBES CR-416p);
 * format_transformation_spec — all six formats when any catalog marker is there, else the non-catalog ones whenever ANY https
 * website destination is there; destination_spec WEBSITE_AND_SHOP_OPT_OUT whenever a website destination or a catalog
 * marker is there; the product_tag opt-out (or an explicit opt-in) whenever there are images (Meta's guide: automatic
 * tagging covers "single images or carousel images" and is "enabled by default"); multi_share_optimized on every carousel.
 * Asking for too much fails safe: Meta's validate_only answers before anything is made.
 */
export function silentKeysFor(creative: Record<string, unknown>): { audios: boolean; formats: readonly string[] | null; destination: boolean; productTags: boolean } {
  const website = hasWebsiteDestination(creative)
  const catalog = hasCatalogMarker(creative)
  return {
    // Step 26 — every existing-post source (a post, an Instagram media or link, a creator's ad code) keeps its own media.
    audios: !isExistingPostCreative(creative),
    formats: catalog ? META_FORMAT_AUTOMATION_FORMATS : website ? META_NON_CATALOG_FORMATS : null,
    destination: website || catalog,
    // Step 26 (review B4) — an existing post may show images Meta tags by itself: the product-tag opt-out is required there.
    productTags: hasImages(creative) || isExistingPostCreative(creative),
  }
}

/**
 * Review round 3 — what the tool SENDS: the minimum the gateway requires (silentKeysFor), and on an existing post (whose
 * own link is not in the body: it may lead to a website) the shop and non-catalog format opt-outs too — fail-safe; the
 * gateway accepts every extra opt-out, and Meta's validate_only answers first (LIVE-PROBES CR-416q).
 */
export function silentKeysToSend(creative: Record<string, unknown>): ReturnType<typeof silentKeysFor> {
  const min = silentKeysFor(creative)
  // Review (step 26 B4) — an existing post may be an image or an image carousel, which Meta tags automatically ("enabled by
  // default"): the product-tag opt-out goes too (fail safe; LIVE-PROBE CR-416q). Step 26 — every existing-post source
  // (create-meta-boost: an Instagram media or link, a creator's ad code) gets the same opt-outs as a post of the chosen Page.
  return isExistingPostCreative(creative) ? { ...min, formats: min.formats ?? META_NON_CATALOG_FORMATS, destination: true, productTags: true } : min
}

/**
 * Step 26 — a creative of an EXISTING post: a post (object_story_id), an Instagram media (source_instagram_media_id), an
 * Instagram post link (instagram_permalink_url) or a creator's partnership ad code. It shows the post's own media.
 */
export function isExistingPostCreative(creative: Record<string, unknown>): boolean {
  return !!creative.object_story_id || !!creative.source_instagram_media_id || !!creative.instagram_permalink_url || !!adCodeOf(creative)
}

/** Step 26 — the creator's partnership ad code a creative carries, and for which platform, or null. Never put in a sentence. */
export function adCodeOf(creative: Record<string, unknown>): { platform: 'INSTAGRAM' | 'FACEBOOK'; code: string } | null {
  const branded = (creative.branded_content ?? {}) as { instagram_boost_post_access_token?: unknown; facebook_boost_post_access_token?: unknown }
  if (typeof branded.instagram_boost_post_access_token === 'string') return { platform: 'INSTAGRAM', code: branded.instagram_boost_post_access_token }
  if (typeof branded.facebook_boost_post_access_token === 'string') return { platform: 'FACEBOOK', code: branded.facebook_boost_post_access_token }
  return null
}

/**
 * Step 26 — the asset feed an existing post may carry: music asked (audios random), or Meta's destinations for it — several
 * messaging apps (DOF_MESSAGING_DESTINATION: use-posts-as-ads.md "Click to multidestination", and its trap for a Facebook post
 * with an Instagram account) or a unified profile visit (UNIFIED_PROFILE_VISIT_DESTINATION: multidestination-profile-visit.md
 * "Creating ad creatives using Instagram content") with their call_to_actions; music then named explicitly (audios).
 */
const EXISTING_POST_FEED_KEYS = new Set(['audios', 'optimization_type', 'call_to_actions'])
const EXISTING_POST_DESTINATIONS = new Set(['DOF_MESSAGING_DESTINATION', 'UNIFIED_PROFILE_VISIT_DESTINATION'])

/** The silent features a creative must carry explicitly (the binding lane rule; review B, round 2): why not, or null. */
export function silentFeaturesProblem(creative: Record<string, unknown>): string | null {
  const dof = creative.degrees_of_freedom_spec as { creative_features_spec?: Record<string, { enroll_status?: unknown }> } | undefined
  const features = dof?.creative_features_spec ?? {}
  const missing = META_CREATIVE_FEATURES.filter((f) => !features[f]?.enroll_status)
  if (missing.length) return `a creative names an enroll_status for every Advantage+ creative feature Meta documents (missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}): Nexus switches none on silently`
  if (!(creative.contextual_multi_ads as { enroll_status?: unknown } | undefined)?.enroll_status) return 'a creative names contextual_multi_ads.enroll_status (Meta opts a creative into multi-advertiser ads when it is missing)'
  const want = silentKeysFor(creative)
  // Review round 3 — the gateway REQUIRES the minimum and ACCEPTS every extra opt-out (data_source none); it never refuses an
  // opt-out. A format switched on (another data source) goes only where the minimum names that format.
  const entries = Array.isArray(creative.format_transformation_spec) ? (creative.format_transformation_spec as Array<{ format?: unknown; data_source?: unknown }>) : []
  const sent = entries.map((f) => String(f.format))
  if (new Set(sent).size !== sent.length) return 'format_transformation_spec names each format once'
  if (want.formats) {
    const missing = want.formats.filter((f) => !sent.includes(f))
    if (missing.length) return `a creative with ${want.formats.length === 6 ? 'a catalog part' : 'a website destination'} names format_transformation_spec for each of ${want.formats.join(', ')} (missing: ${missing.join(', ')}; Meta transforms the format by itself when one is missing)`
  }
  const optedIn = entries.filter((f) => !(Array.isArray(f.data_source) && f.data_source.length === 1 && f.data_source[0] === 'none')).map((f) => String(f.format))
  const misplaced = optedIn.filter((f) => !want.formats?.includes(f))
  if (misplaced.length) return `format automation ${misplaced.join(', ')} is switched on only where Meta documents it for this creative (${want.formats?.join(', ') || 'no format here'}); an opt-out (data_source none) goes anywhere`
  const feed = creative.asset_feed_spec as Record<string, unknown> | undefined
  if (want.audios) {
    if (!feed || !Array.isArray(feed.audios)) return 'a creative names asset_feed_spec.audios (empty: no music; Meta\'s guide opts out of music that way)'
  } else if (feed) {
    // Step 26 — or for Meta's messaging / profile-visit destinations of an existing post (create-meta-boost).
    const destinations = typeof feed.optimization_type === 'string' && EXISTING_POST_DESTINATIONS.has(feed.optimization_type)
    if (Object.keys(feed).some((k) => !EXISTING_POST_FEED_KEYS.has(k)) || !Array.isArray(feed.audios) || (!destinations && (Object.keys(feed).length !== 1 || !feed.audios.length))
      || (!destinations && feed.optimization_type !== undefined) || (feed.call_to_actions !== undefined && !destinations)) {
      return 'a creative of an existing post takes an asset_feed_spec only for music asked (audios random), or for Meta\'s messaging or profile-visit destinations (optimization_type DOF_MESSAGING_DESTINATION or UNIFIED_PROFILE_VISIT_DESTINATION, with audios named)'
    }
  }
  const destination = (creative.destination_spec as { destination_type?: unknown } | undefined)?.destination_type
  // (destination_spec takes only WEBSITE_AND_SHOP_OPT_OUT: an extra one is an opt-out, accepted anywhere — review round 3.)
  if (want.destination && !destination) return 'a creative with a website destination or a catalog part names destination_spec.destination_type (v26 sends an eligible creative to the shop by itself when it is missing)'
  // Review round 3 — EXACTLY one product_tag component (an opt-out and an opt-in side by side would leave Meta to choose),
  // or products tagged by hand (CR-313: "the automated tagging feature will be disabled for the ad to respect product tags
  // that are specified by you"), never both.
  const tags = ((creative.interactive_components_spec as { components?: Array<{ type?: unknown; enroll_status?: unknown; product_tag_spec?: unknown }> } | undefined)?.components ?? []).filter((c) => c?.type === 'product_tag')
  const byHand = tags.filter((c) => c.product_tag_spec !== undefined)
  if (byHand.length) {
    if (byHand.length !== tags.length) return 'interactive_components_spec names products tagged by hand (product_tag_spec) or ONE automatic-tagging component (enroll_status), not both: tags by hand switch Meta\'s automatic tagging off'
  } else {
    if (tags.length > 1) return 'interactive_components_spec names ONE product_tag component'
    if (want.productTags && !tags[0]?.enroll_status) return 'a creative with images names interactive_components_spec product_tag enroll_status (Meta tags catalog products on single and carousel images by itself otherwise)'
  }
  const story = (creative.object_story_spec ?? {}) as { link_data?: Record<string, unknown>; template_data?: Record<string, unknown> }
  if (Array.isArray(story.link_data?.child_attachments) && typeof story.link_data!.multi_share_optimized !== 'boolean') return 'a carousel names link_data.multi_share_optimized (Meta reorders the cards by itself otherwise)'
  // Master CR-450 (catalog review) — a catalog template's own cards (static cards "appear either before or after all
  // Advantage+ catalog ads": no doc says their order is kept): fail safe, the order is said too.
  if (Array.isArray(story.template_data?.child_attachments) && typeof story.template_data!.multi_share_optimized !== 'boolean') return 'a catalog template with its own cards names template_data.multi_share_optimized (Meta may reorder the cards by itself otherwise)'
  const carousels = (feed?.carousels ?? []) as Array<Record<string, unknown>>
  if (Array.isArray(carousels) && carousels.some((c) => typeof c?.multi_share_optimized !== 'boolean')) return 'every asset-feed carousel names multi_share_optimized (Meta reorders the cards by itself otherwise)'
  return null
}

/**
 * The identity of a creative, after the walk: the Page and Instagram account it runs as, each the chosen one, or a
 * partner's beside the chosen one as its sponsor (partnership ads: master CR-320 brand as main identity, CR-321 creator as
 * main identity) — handed to the gateway as identity assets (`with`: the sponsor named). A legacy sponsor Page and every
 * sponsor named while the chosen Page is the identity are partner assets. Review A2 — an Instagram account named both in
 * the story and at the top level must be the SAME one (each is checked otherwise one would go unseen): two are refused.
 */
export function identityAssets(creative: Record<string, unknown>): MetaWriteAsset[] | { problem: string } {
  const story = creative.object_story_spec as { page_id?: string; instagram_user_id?: string } | undefined
  const sponsorPage = (creative.facebook_branded_content as { sponsor_page_id?: string } | undefined)?.sponsor_page_id
  const sponsorIg = (creative.instagram_branded_content as { sponsor_id?: string } | undefined)?.sponsor_id
  const out: MetaWriteAsset[] = []
  if (story?.page_id) out.push({ id: story.page_id, kind: 'identitypage', ...(sponsorPage ? { with: sponsorPage } : {}) })
  else if (sponsorPage) out.push({ id: sponsorPage, kind: 'partnerpage' })
  const igs = [...new Set([story?.instagram_user_id, typeof creative.instagram_user_id === 'string' ? creative.instagram_user_id : undefined].filter((v): v is string => !!v))]
  if (igs.length > 1) return { problem: 'a creative names ONE Instagram account: object_story_spec.instagram_user_id and instagram_user_id differ' }
  if (igs.length) out.push({ id: igs[0], kind: 'identityinstagram', ...(sponsorIg ? { with: sponsorIg } : {}) })
  else if (sponsorIg) out.push({ id: sponsorIg, kind: 'partnerinstagram' })
  return out
}

/**
 * Step 26 — the SOURCE of a creative, exactly one: a story; a post (object_story_id: the chosen Page's — or a creator's in a
 * partnership boost); an Instagram media (source_instagram_media_id) or post link (instagram_permalink_url), each under a Page
 * (object_id: the chosen one) and as the chosen Instagram account (instagram_user_id) — or a creator's media; a creator's ad
 * code (branded_content.instagram_boost_post_access_token, with object_id, or facebook_boost_post_access_token). A creator's
 * content names branded_content.ad_format (Nexus always says which identities the ad shows) and, as Meta's boost-existing-post
 * guides write it, the business's chosen Page and Instagram account as its SPONSORS (facebook_branded_content.sponsor_page_id,
 * instagram_branded_content.sponsor_id); it names no instagram_user_id (the creator's own account runs it). Answers the ids
 * the gateway checks (each its kind; the chosen Page and Instagram account as step 19's `page` and step 31's `instagram` body
 * ids), and whether it is a creator's content (then identityAssets does not apply).
 */
export function sourceAssets(creative: Record<string, unknown>): { assets: MetaWriteAsset[]; ids: MetaWriteBodyId[]; creator: boolean } | { problem: string } {
  const code = adCodeOf(creative)
  const branded = (creative.branded_content ?? {}) as { instagram_boost_post_access_token?: unknown; facebook_boost_post_access_token?: unknown; ad_format?: unknown }
  if (branded.instagram_boost_post_access_token !== undefined && branded.facebook_boost_post_access_token !== undefined) return { problem: 'a creative names ONE ad code (Instagram or Facebook)' }
  const post = typeof creative.object_story_id === 'string' ? creative.object_story_id : null
  const media = typeof creative.source_instagram_media_id === 'string' ? creative.source_instagram_media_id : null
  const link = typeof creative.instagram_permalink_url === 'string' ? creative.instagram_permalink_url : null
  const sources = [creative.object_story_spec ? 'object_story_spec' : null, post ? 'object_story_id' : null, media ? 'source_instagram_media_id' : null, link ? 'instagram_permalink_url' : null, code ? 'an ad code' : null].filter(Boolean)
  if (sources.length !== 1) return { problem: `a creative names ONE source (object_story_spec, object_story_id, source_instagram_media_id, instagram_permalink_url or a creator's ad code), not ${sources.join(' and ')}` }
  const underPage = !!media || !!link || code?.platform === 'INSTAGRAM'
  if (underPage && typeof creative.object_id !== 'string') return { problem: 'an Instagram media, post link or ad code runs under the chosen Page: the creative names object_id (Nexus fills it)' }
  if (!underPage && creative.object_id !== undefined) return { problem: 'object_id goes only with an Instagram media, an Instagram post link or an Instagram ad code' }
  const assets: MetaWriteAsset[] = []
  const ids: MetaWriteBodyId[] = underPage ? [{ id: String(creative.object_id), kind: 'page' }] : []
  const sponsorPage = (creative.facebook_branded_content as { sponsor_page_id?: string } | undefined)?.sponsor_page_id
  const sponsorIg = (creative.instagram_branded_content as { sponsor_id?: string } | undefined)?.sponsor_id
  const creator = branded.ad_format !== undefined
  if (creator) {
    if (creative.object_story_spec) return { problem: 'branded_content.ad_format goes with a creator\'s existing content (create-meta-boost); a partnership ad with new media names its partner (create-meta-creative partner)' }
    if (link) return { problem: 'a creator\'s content is named by its media id, its post id or its ad code, not by a link' }
    if (creative.instagram_user_id !== undefined) return { problem: 'a creator\'s content runs as the creator\'s own account: the creative names no instagram_user_id (the business\'s chosen Page and Instagram account are its sponsors)' }
    if (!sponsorPage && !sponsorIg) return { problem: 'a creator\'s content names the business as its sponsor (facebook_branded_content.sponsor_page_id and/or instagram_branded_content.sponsor_id)' }
    if (sponsorPage) ids.push({ id: sponsorPage, kind: 'page' })
    if (sponsorIg) ids.push({ id: sponsorIg, kind: 'instagram' })
    if (post) assets.push({ id: post, kind: 'partnercontent' })
    if (media) assets.push({ id: media, kind: 'partnercontent' })
    if (code) assets.push({ id: code.code, kind: 'adcode', with: code.platform })
    return { assets, ids, creator: true }
  }
  if (code) return { problem: 'a creator\'s ad code goes with branded_content.ad_format (Nexus always says which identities the ad shows)' }
  if (media || link) {
    if (typeof creative.instagram_user_id !== 'string') return { problem: 'the business\'s own Instagram media runs as the chosen Instagram account: the creative names instagram_user_id (Nexus fills it)' }
    if (sponsorPage || sponsorIg) return { problem: 'Meta\'s guides document no partner on a boost of the business\'s own Instagram media: a partnership ad with new media is create-meta-creative partner' }
    assets.push(media ? { id: media, kind: 'instagrammedia' } : { id: link!, kind: 'igpermalink' })
  }
  // A post of the chosen Page (step 25's rule); its sponsors, if any, are partners (identityAssets).
  if (post) assets.push({ id: post, kind: 'pagepost' })
  return { assets, ids, creator: false }
}

/**
 * Review A6, widened in round 2 — the opt-ins a creative carries in its own parts (beside the arguments the preview names
 * already: the Advantage+ features switched on, multi-advertiser ads, the product tags): EVERY `…enroll_status` or
 * `…opt_in_status` that reads OPT_IN at any depth (feature customizations, catalog image layers, related media, …) by its
 * path, and the boolean opt-ins (optimized WhatsApp text, automatic product tags in a template, format automation).
 */
export function partsOptIns(creative: Record<string, unknown>): string[] {
  const out: string[] = []
  const named = /^(degrees_of_freedom_spec\.creative_features_spec\.[a-z0-9_]+\.enroll_status|contextual_multi_ads\.enroll_status|interactive_components_spec\.components\[\d+\]\.enroll_status)$/
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 14 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const at = path ? `${path}.${k}` : k
      if (/(enroll_status|opt_in_status)$/.test(k) && typeof v === 'string' && /^opt_in$/i.test(v) && !named.test(at)) out.push(`${at} ${v}`)
      walk(v, at, depth + 1)
    }
  }
  walk(creative, '', 0)
  if ((creative.marketing_message_structured_spec as { is_optimized_text?: unknown } | undefined)?.is_optimized_text === true) out.push('marketing_message_structured_spec.is_optimized_text (Meta rewrites the WhatsApp message text)')
  if (anyMember(creative, 'automated_product_tags', (v) => v === true)) out.push('automated_product_tags (Meta tags catalog products by itself)')
  if ((creative.asset_feed_spec as { optimization_type?: unknown } | undefined)?.optimization_type === 'FORMAT_AUTOMATION') out.push('asset_feed_spec.optimization_type FORMAT_AUTOMATION (Meta picks carousel or collection by itself)')
  return out
}

/** The ids inside a creative, deduplicated, at most this many (a creative of 49 assets per kind stays far below). */
export const META_CREATIVE_MAX_ASSETS = 150
/**
 * Catalog review of step 25 — the product sets and catalog items one creative may name. Each costs live reads on the
 * Limited-tier ads read bucket (45 reads, one back every 12.5 s): the item or set itself, and — once per catalog per check —
 * the catalog's owner and, for a client catalog, the portfolio's client list; the ad account's portfolio is read once per
 * check. A creative is checked three times (the tool's preview, Meta's check, the create): five keep one check at most 16
 * reads (1 + 5 × 3), about 48 over the three (plus a client catalog's list pages): the account's ads bucket (45, refilled one
 * per 12.5 s) makes the last ones wait a little, never refuses them — and five cover Meta's examples (one product set; two items).
 */
export const META_CREATIVE_MAX_CATALOG_IDS = 5

/**
 * Master CR-330 / CR-414 (catalog review) — product extensions show catalog items under the ad: Meta picks them from the
 * associated product set, so the feature goes ON only beside creative_sourcing_spec.associated_product_set_id (a set the
 * catalog rule checks), with action_metadata MANUAL only then; without the set Meta would pick products from a catalog
 * the rule never saw.
 */
export function productExtensionsProblem(creative: Record<string, unknown>): string | null {
  const feature = (creative.degrees_of_freedom_spec as { creative_features_spec?: Record<string, { enroll_status?: unknown; action_metadata?: unknown }> } | undefined)?.creative_features_spec?.product_extensions
  const set = (creative.creative_sourcing_spec as { associated_product_set_id?: unknown } | undefined)?.associated_product_set_id
  if (feature?.enroll_status === 'OPT_IN' && !set) return 'product_extensions goes ON only beside creative_sourcing_spec.associated_product_set_id (a product set of the business\'s catalog): without one Meta would pick products from a catalog Nexus never checked'
  if (feature?.action_metadata !== undefined && !set) return 'product_extensions.action_metadata goes only beside creative_sourcing_spec.associated_product_set_id'
  return null
}

/**
 * THE judge of a creative's form parameters as the gateway receives them (a JSON key as its JSON text): every key on the
 * allow-list, each JSON key in ONE spelling (exactly what JSON.stringify writes of what was judged), every value judged, the
 * silent features all present. Returns the decoded creative and its ids, or why not.
 */
export function judgeCreativeForm(params: ReadonlyMap<string, string>, skip: readonly string[] = []): { creative: Record<string, unknown>; assets: MetaWriteAsset[]; ids: MetaWriteBodyId[] } | { problem: string } {
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

/**
 * Step 27 review B6 — a multi-media ad (ad-creative/multi-media-ads.md "Limitations"): "The primary media in
 * object_story_spec must also appear in media_sourcing_spec" — its image hash (or picture link) among the images, its video
 * among the videos. Why not, or null.
 */
export function multiMediaProblem(creative: Record<string, unknown>): string | null {
  const media = creative.media_sourcing_spec as { images?: Array<{ hash?: string; url?: string }>; videos?: Array<{ video_id?: string }> } | undefined
  if (!media || !(media.images?.length || media.videos?.length)) return null
  const story = (creative.object_story_spec ?? {}) as { link_data?: { image_hash?: string; picture?: string }; video_data?: { video_id?: string }; photo_data?: { image_hash?: string; url?: string } }
  const video = story.video_data?.video_id
  if (video) return (media.videos ?? []).some((v) => v.video_id === video) ? null : `media_sourcing_spec.videos names the primary video ${video} of object_story_spec too (Meta's multi-media rule)`
  const hash = story.link_data?.image_hash ?? story.photo_data?.image_hash
  const url = story.link_data?.picture ?? story.photo_data?.url
  if (hash) return (media.images ?? []).some((i) => i.hash === hash) ? null : `media_sourcing_spec.images names the primary image ${hash} of object_story_spec too (Meta's multi-media rule)`
  if (url) return (media.images ?? []).some((i) => i.url === url) ? null : 'media_sourcing_spec.images names the primary picture link of object_story_spec too (Meta\'s multi-media rule)'
  return 'a multi-media ad names its primary image or video in object_story_spec (link_data image_hash or picture, or video_data video_id), and lists it in media_sourcing_spec too'
}

/** Gap 46b (master CR-331) — the intro card a creative names (its key and the post), or null. */
export function introCardOf(creative: Record<string, unknown>): { key: typeof META_INTRO_CARD_KEYS[number]; id: string } | null {
  const branded = creative.branded_content
  if (!branded || typeof branded !== 'object' || Array.isArray(branded)) return null
  const key = META_INTRO_CARD_KEYS.find((k) => (branded as Record<string, unknown>)[k] !== undefined)
  return key ? { key, id: String((branded as Record<string, unknown>)[key]) } : null
}

/**
 * Gap 46b (master CR-331) — why an intro card may not go on this creative, or null: ONE parent source, on an Advantage+
 * catalog creative (object_story_spec.template_data with the creative's own product_set_id — Meta's guide: carousel or
 * collection, "depends on other parameters"), and a partnership ad (a sponsor named: facebook_branded_content.sponsor_page_id
 * or instagram_branded_content.sponsor_id, as create-meta-creative partner writes it for either main identity).
 */
export function introCardProblem(creative: Record<string, unknown>): string | null {
  const branded = (creative.branded_content ?? {}) as Record<string, unknown>
  const named = META_INTRO_CARD_KEYS.filter((k) => branded[k] !== undefined)
  if (!named.length) return null
  if (named.length > 1) return 'a catalog ad shows ONE existing post as its intro card: branded_content.parent_source_instagram_media_id or parent_source_facebook_post_id, not both'
  const story = creative.object_story_spec as { template_data?: unknown } | undefined
  if (!story?.template_data || typeof creative.product_set_id !== 'string') return 'an existing post as the intro card (branded_content.parent_source_…) goes only on an Advantage+ catalog creative: object_story_spec.template_data with the creative\'s own product_set_id (Meta\'s partnership catalog-ads guide; create-meta-creative introPost)'
  const sponsorPage = (creative.facebook_branded_content as { sponsor_page_id?: unknown } | undefined)?.sponsor_page_id
  const sponsorIg = (creative.instagram_branded_content as { sponsor_id?: unknown } | undefined)?.sponsor_id
  if (!sponsorPage && !sponsorIg) return 'an existing post as the intro card goes only on a partnership ad: the creative names its partner (facebook_branded_content.sponsor_page_id or instagram_branded_content.sponsor_id — create-meta-creative partner)'
  return null
}

/** After a creative's keys were judged: the silent features, the identity, the ids (deduplicated and bounded). */
export function finishCreative(creative: Record<string, unknown>, walk: CreativeWalk): { creative: Record<string, unknown>; assets: MetaWriteAsset[]; ids: MetaWriteBodyId[]; warnings: string[] } | { problem: string } {
  if (!creative.object_story_spec && !isExistingPostCreative(creative)) return { problem: 'a creative names object_story_spec (Nexus fills the chosen Page) or object_story_id (a post of the chosen Page) — or, made by create-meta-boost, an Instagram media, an Instagram post link or a creator\'s ad code' }
  if (creative.object_story_spec && creative.object_story_id) return { problem: 'a creative names object_story_spec or object_story_id, not both' }
  // Gap 46b (master CR-331) — an intro card only on a partnership Advantage+ catalog creative; its catalog parts then OWNED.
  const intro = introCardProblem(creative)
  if (intro) return { problem: intro }
  const owned = introCardOf(creative) !== null
  const contradiction = creativeTypeProblem(creative)
  if (contradiction) return { problem: contradiction }
  const multi = multiMediaProblem(creative)
  if (multi) return { problem: multi }
  const silent = silentFeaturesProblem(creative)
  if (silent) return { problem: silent }
  const extensions = productExtensionsProblem(creative)
  if (extensions) return { problem: extensions }
  // Step 26 — the source of an existing post (create-meta-boost) and, for a creator's content, its sponsors (the chosen ones).
  const source = sourceAssets(creative)
  if ('problem' in source) return source
  const identity = source.creator ? [] : identityAssets(creative)
  if ('problem' in identity) return identity
  const seen = new Set<string>()
  const assets = [...identity, ...source.assets, ...walk.assets].filter((a) => {
    const key = `${a.kind}:${a.id}:${a.with ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const ids = [...source.ids, ...walk.ids].filter((a) => {
    const key = `id:${a.kind}:${a.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((a) => (owned && (a.kind === 'productset' || a.kind === 'productitem') ? { ...a, owned: true as const } : a))
  if (assets.length + ids.length > META_CREATIVE_MAX_ASSETS) return { problem: `a creative names at most ${META_CREATIVE_MAX_ASSETS} ids` }
  const catalogIds = ids.filter((i) => i.kind === 'productset' || i.kind === 'productitem').length
  if (catalogIds > META_CREATIVE_MAX_CATALOG_IDS) return { problem: `a creative names at most ${META_CREATIVE_MAX_CATALOG_IDS} product sets and catalog items (this one names ${catalogIds}): each is checked live against the catalog rule, on Meta's small ads read budget` }
  // An element of an Instant Experience is checked against the creative's own experience (its canvas_doc link).
  const canvases = assets.filter((a) => a.kind === 'canvas')
  for (const a of assets) {
    if (a.kind !== 'canvaselement') continue
    if (canvases.length !== 1) return { problem: 'collection_thumbnails go with exactly one Instant Experience link (https://fb.com/canvas_doc/<id>)' }
    a.with = canvases[0].id
  }
  return { creative, assets, ids, warnings: walk.warnings }
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A creative of 49 assets per kind in several languages form-encodes letters outside ASCII at up to 12 characters each. */
export const META_CREATIVE_MAX_BODY = 600_000
const CREATIVE_JSON_TEXT: Record<string, RegExp> = Object.fromEntries(Object.keys(CREATIVE_KEYS).map((k) => [k, META_MEDIA_TEXT_PATTERN]))
const ACCOUNT = ['adaccount'] as const
const CREATIVE = ['creative'] as const

const createJudge = (params: ReadonlyMap<string, string>): string | null => {
  if (params.has('execution_options') && params.get('execution_options') !== META_VALIDATE_ONLY) return `the only execution_options Nexus sends is exactly ${META_VALIDATE_ONLY} (Meta's check, which changes nothing)`
  const judged = judgeCreativeForm(params, ['execution_options'])
  // Step 27 — a "message us" footer is made only inline on a new ad.
  return 'problem' in judged ? judged.problem : inlineOnlyProblem(judged.creative)
}
const createAssets = (params: ReadonlyMap<string, string>): MetaWriteAsset[] => {
  const judged = judgeCreativeForm(params, ['execution_options'])
  return 'problem' in judged ? [] : judged.assets
}
const createIds = (params: ReadonlyMap<string, string>): MetaWriteBodyId[] => {
  const judged = judgeCreativeForm(params, ['execution_options'])
  return 'problem' in judged ? [] : judged.ids
}
/**
 * A creative as ONE JSON object (its parts as objects, not as JSON text): the async job's creative_spec (step 25) and, step
 * 27, a new ad's inline `creative` (create-meta-ad) — `label` names it in the sentence. Every key judged, ONE spelling.
 */
export function judgeCreativeSpec(raw: string | undefined, label = 'creative_spec'): { creative: Record<string, unknown>; assets: MetaWriteAsset[]; ids: MetaWriteBodyId[]; warnings: string[] } | { problem: string } {
  let spec: unknown
  try { spec = JSON.parse(raw ?? '') } catch { return { problem: `${label} is JSON` } }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { problem: `${label} is a JSON object` }
  const story = (spec as { object_story_spec?: { instagram_user_id?: unknown } }).object_story_spec
  const walk = newCreativeWalk(typeof (spec as { instagram_user_id?: unknown }).instagram_user_id === 'string' || typeof story?.instagram_user_id === 'string')
  const creative: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec as Record<string, unknown>)) {
    const judged = judgeCreativeKey(key, value, walk)
    if ('problem' in judged) return { problem: `${label}.${judged.problem}` }
    creative[key] = judged.value
  }
  if (JSON.stringify(creative) !== raw) return { problem: `${label} is written in one spelling (as JSON.stringify writes it)` }
  if (typeof creative.name !== 'string') return { problem: `${label} names the creative (name)` }
  return finishCreative(creative, walk)
}
const asyncSpec = (raw: string | undefined) => {
  const judged = judgeCreativeSpec(raw)
  if ('problem' in judged) return judged
  // Step 27 — a "message us" footer is made only inline on a new ad (the async job makes a creative on its own).
  const inline = inlineOnlyProblem(judged.creative)
  return inline ? { problem: inline } : judged
}
/** A label list in ONE spelling (step 27: an ad's labels too). */
export const labelsJudge = (value: string): string | null => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return 'adlabels is JSON' }
  const judged = labels(parsed, 'adlabels', newCreativeWalk())
  if ('problem' in judged) return judged.problem
  return JSON.stringify(judged.value) === value ? null : 'adlabels is written in one spelling (as JSON.stringify writes it)'
}

/** Step 26 — the creator's ad codes in a creative's branded_content (or an async job's creative_spec), as text. */
export function adCodesIn(raw: string | undefined, spec: boolean): string[] {
  if (!raw || !/_boost_post_access_token/.test(raw)) return []
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const branded = (spec ? parsed?.branded_content : parsed) as Record<string, unknown> | undefined
    return [branded?.instagram_boost_post_access_token, branded?.facebook_boost_post_access_token].filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** Step 25 — create-meta-creative's and set-meta-creative's entries of the write allow-list (meta-calls.ts writeRules). */
export const META_CREATIVE_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // M5-11 … M5-24, M5-29 … M5-31 (master CR-013 …): a creative of the chosen ad account, and Meta's check of it.
    name: 'adaccount.creative.create', method: 'POST', path: /^act_\d{1,20}\/adcreatives$/, kinds: ACCOUNT,
    // The silent keys every creative carries; the ones Meta documents per kind are judged by silentFeaturesProblem (review B).
    required: ['name', 'degrees_of_freedom_spec', 'contextual_multi_ads'],
    // The keys Nexus answers in words (META_CREATIVE_REFUSED) match the rule so that its judge says why; it refuses each.
    optional: [...Object.keys(CREATIVE_KEYS).filter((k) => !['name', 'degrees_of_freedom_spec', 'contextual_multi_ads'].includes(k)), ...Object.keys(META_CREATIVE_REFUSED), 'execution_options'],
    // Step 26 — or an existing post's other sources (create-meta-boost): an Instagram media or link, a creator's ad code.
    anyOf: ['object_story_spec', 'object_story_id', 'source_instagram_media_id', 'instagram_permalink_url', 'branded_content'],
    // Step 26 — a creator's ad code in the body: never in the ledger, cut out of Meta's answer.
    secret: (params) => adCodesIn(params.get('branded_content'), false),
    text: CREATIVE_JSON_TEXT, maxBody: META_CREATIVE_MAX_BODY, edgeCall: true, budget: false,
    values: createJudge, assets: createAssets, ids: createIds,
  },
  {
    // M5-33 (master CR-033): the same creative as Meta's asynchronous job — notification_mode OFF only (Nexus gives Meta no
    // address to call back; it reads the job itself).
    name: 'adaccount.creative.async', method: 'POST', path: /^act_\d{1,20}\/asyncadcreatives$/, kinds: ACCOUNT,
    required: ['name', 'creative_spec'], optional: ['notification_mode'],
    secret: (params) => adCodesIn(params.get('creative_spec'), true),
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
    ids: (params) => {
      const judged = asyncSpec(params.get('creative_spec'))
      return 'problem' in judged ? [] : judged.ids
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
      // Step 22's wording for a delete by status (meta-calls.ts object.status): a creative's delete is its own explicit step.
      if (params.get('status') === 'DELETED') return 'Nexus deletes nothing by a status change: deleting a creative is its own tool (remove-meta-ads-items, on a person\'s explicit ask, or create-meta-creative\'s undo)'
      if (params.has('status') && params.get('status') !== 'ACTIVE') return 'status is ACTIVE (IN_PROCESS and WITH_ISSUES are Meta\'s own review states)'
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
]

// ── step 27: the JSON parts of a new ad that are not its creative, judged with the same judges ──────────────────────

/** One JSON form value judged by `judge`, in ONE spelling; its ids for the gateway's check. */
function judgedJson(raw: string | undefined, label: string, judge: Judge): { value: unknown; assets: MetaWriteAsset[]; ids: MetaWriteBodyId[]; warnings: string[] } | { problem: string } {
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '') } catch { return { problem: `${label} is JSON` } }
  const walk = newCreativeWalk()
  const judged = judge(parsed, label, walk)
  if ('problem' in judged) return judged
  if (JSON.stringify(judged.value) !== raw) return { problem: `${label} is written in one spelling (as JSON.stringify writes it)` }
  return { value: judged.value, assets: walk.assets, ids: walk.ids, warnings: walk.warnings }
}

/** The text types of a flexible-format group (flexible-ad-format.md: primary_text, headline, …; the creative's own three). */
export const META_ASSET_GROUP_TEXT_TYPES = ['primary_text', 'headline', 'description'] as const
const TEXT_MAX: Readonly<Record<string, number>> = { primary_text: META_CREATIVE_TEXT.message, headline: META_CREATIVE_TEXT.headline, description: META_CREATIVE_TEXT.description }

/**
 * Step 27 (master CR-430, F1 M5-20; flexible-ad-format.md, checked 2026-10-21) — `creative_asset_groups_spec` on a new ad:
 * {"groups":[{images[{hash}], videos[{video_id}], texts[{text, text_type}], call_to_action{type, value{link}}}]} — each group
 * at least one image or video, at most 5 texts of a text type, every call to action of ONE type. Images of the chosen
 * account's library, videos of its video library (the gateway checks each).
 */
export function judgeAssetGroups(raw: string | undefined): { value: unknown; assets: MetaWriteAsset[]; ids: MetaWriteBodyId[]; warnings: string[] } | { problem: string } {
  const group = obj({
    images: list(obj({ hash }, ['hash']), 10),
    videos: list(obj({ video_id: bodyId('video') }, ['video_id']), 10),
    texts: list((value, path, walk) => {
      const judged = obj({ text_type: enumOf(META_ASSET_GROUP_TEXT_TYPES), text: (v, p) => (typeof v === 'string' ? ok(v) : no(`${p} is text`)) }, ['text', 'text_type'])(value, path, walk)
      if ('problem' in judged) return judged
      const t = judged.value as { text: string; text_type: string }
      const problem = metaCreativeTextProblem(t.text, TEXT_MAX[t.text_type], `${path}.text`, { lines: t.text_type !== 'headline' })
      return problem ? no(problem) : judged
    }, 15),
    call_to_action: obj({ type: enumOf(META_CTA_TYPES), value: obj({ link }, ['link']) }, ['type']),
  })
  const judged = judgedJson(raw, 'creative_asset_groups_spec', obj({ groups: list(group, 10, 1) }, ['groups']))
  if ('problem' in judged) return judged
  const groups = (judged.value as { groups: Array<{ images?: unknown[]; videos?: unknown[]; texts?: Array<{ text_type: string }>; call_to_action?: { type: string } }> }).groups
  for (const [i, g] of groups.entries()) {
    if (!(g.images?.length || g.videos?.length)) return { problem: `creative_asset_groups_spec.groups[${i}] holds at least one image or video` }
    for (const type of META_ASSET_GROUP_TEXT_TYPES) if ((g.texts ?? []).filter((t) => t.text_type === type).length > 5) return { problem: `creative_asset_groups_spec.groups[${i}] holds at most 5 texts of type ${type}` }
  }
  const ctas = new Set(groups.map((g) => g.call_to_action?.type).filter(Boolean))
  if (ctas.size > 1) return { problem: 'every call to action of creative_asset_groups_spec is of ONE type (Meta\'s flexible-format rule)' }
  return judged
}

/** Step 27 (master CR-427) — `creative_audience_pairing_persona` on a new ad (the whole ad's persona). */
export function judgeAdPersona(raw: string | undefined): { value: unknown } | { problem: string } {
  return judgedJson(raw, 'creative_audience_pairing_persona', persona)
}
