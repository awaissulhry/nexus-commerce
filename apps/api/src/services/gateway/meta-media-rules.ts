/**
 * Meta step 23 (2026-10-21) — the write allow-list entries of create-meta-media: an image's bytes, a video by a public
 * link or from the chosen Instagram account, Meta's resumable video-ads upload (start, the file's link on Meta's upload
 * host, finish), a folder in the business portfolio's media library, and the undo of an upload (an image by its hash, a
 * video by its id). EXACT keys per edge and every value judged: the image bytes strict Base64 of a JPG or PNG of at most
 * 8 MB, a link https only to a public host with no key or signature on it, ids digits only, JSON in one spelling, text
 * only where a person types it (a name, a title, a description). Step 22 (lane C1, remove-meta-ads-items) reuses the two
 * DELETE rules below for an explicit delete of an image or a video.
 *
 * The object a call names (its kind) and every id in its body are checked by the gateway before anything is sent
 * (gateway.ts metaMediaOwnerProblem / metaMediaAssetsProblem): `act_<id>` IS the business's chosen ad account; the
 * portfolio IS the chosen ad account's own and is not shared with another Nexus business; an Instagram media is the chosen
 * Instagram account's; a folder is the portfolio's; a video on the upload host or in a finish is one THIS connection
 * started on the chosen ad account (noteMetaVideoStarted, below).
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart, developers.facebook.com/documentation/ads-commerce/marketing-api/…`.md`, and
 * Meta's Python Business SDK main, facebook_business/adobjects/*.py):
 *   - reference/ad-account/adimages.md + reference/ad-image.md: POST `bytes` (Base64 UTF-8 string) or `copy_from`
 *     {source_account_id, hash}; the answer is `images: {<name>: {hash, url, …}}` (read-after-write); "You must include a
 *     filename extension" (multipart only); DELETE `hash` (required), `image_id`; "You can only delete ad images not
 *     currently being used in an ad creative" (F1 M5-03). SDK adaccount.py create_ad_image: bytes, copy_from only.
 *     An 8 MB cap is Meta's for image_file / image_url on the creative edge (F1 M5-01); Meta states none for `bytes`, so
 *     Nexus holds the same 8 MB. Meta's ads guide takes JPG and PNG.
 *   - reference/ad-account/advideos.md: POST `file_url`, `name`, `title` (< 255 characters), `description`,
 *     `source_instagram_media_id` ("Cannot be used with upload_phase"), `selected_audio_spec` {audio_asset_id}; Host
 *     graph.facebook.com (no graph-video host on the v26 reference, so the gateway names none); DELETE `video_id`
 *     (required). out-of-cycle-changes/occ-2026.md (2026-06-01): `source_instagram_media_id` + `selected_audio_spec` swap a
 *     Reel's music, polled with `replace_audio_status` on GET /<ad video id>.
 *   - guides/videoads/fbvideoads.md: POST /act_<id>/video_ads upload_phase=start → {video_id, upload_url
 *     "https://rupload.facebook.com/video-ads-upload/v26.0/<VIDEO_ID>"}; POST to that upload_url with headers
 *     `Authorization: OAuth <token>` and `file_url` ("urls requiring authentication are not currently supported");
 *     GET /<VIDEO_ID>?fields=status; POST /act_<id>/video_ads upload_phase=finish, video_id. Its finish example names the
 *     host `graph.facebook.com/video-ads-upload/…` while its table says `/v26.0/act_<id>/video_ads`: Nexus sends the table
 *     form (master MD-017; LIVE-PROBES). Meta's Python SDK settles the conflict the same way: adaccount.py create_video_ad
 *     POSTs to the ad account's `/video_ads` edge on the Graph host (FacebookRequest node act_<id>, endpoint '/video_ads').
 *     Its params: description, is_ai_generated, privacy, title, upload_phase, video_id, video_state — Nexus sends only what
 *     the guide shows (so no title on this path: the tool refuses one).
 *   - docs/graph-api/reference/video/captions (MD-026): POST /<video_id>/captions with `captions_file` (an SRT file, "File
 *     name must be in the format filename.locale.srt", "The file size limit for video captions is 200K"), `default_locale`
 *     (a locale or 'none') and `locales_to_delete` (list<string>); permission "User has advertiser access on account that
 *     owns the video"; Deleting: "You can't perform this operation" — a caption is taken back by `locales_to_delete` on the
 *     same edge. Errors 482 (a locale already on the video), 386 (file name), 385 (format), 387 (upload problem).
 *   - reference/business/creative_folders.md: the Creating section is EMPTY (RECHECK BM-058); SDK business.py
 *     create_creative_folder: name, description, parent_folder_id. Updating and deleting: "You can't perform this
 *     operation on this endpoint" — a folder Nexus makes stays (no undo). Built from the SDK; Meta's answer decides
 *     (LIVE-PROBES BM-058).
 */
import type { MetaWriteKind, MetaWriteRule, MetaWriteVerdict } from './meta-calls.js'
import { metaGraphApiVersion } from '../meta/api-version.js'

/** Meta's resumable upload host (guides/videoads/fbvideoads.md, step 2). */
export const META_RUPLOAD_HOST = 'rupload.facebook.com'
/** The most bytes an image Nexus sends may have (Meta's creative-edge cap, F1 M5-01). */
export const META_IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** Its Base64 length. */
export const META_IMAGE_BASE64_MAX = 4 * Math.ceil(META_IMAGE_MAX_BYTES / 3)
/** The form body of an image upload at most: form-encoding writes `+` and `/` as `%2B` / `%2F` (three times, at worst). */
export const META_IMAGE_MAX_BODY = 3 * META_IMAGE_BASE64_MAX + 100
/**
 * Text limits Nexus holds (Meta: a title "less than 255 characters. Special characters may count as more than 1
 * character" — so a title is counted in UTF-8 BYTES, at most 254, which no special character can exceed; an AdImage name
 * at most 100). The other limits are Nexus's own, counted in characters.
 */
export const META_MEDIA_TEXT = { name: 100, title: 254, description: 2000, folderName: 100, folderDescription: 500 } as const
/**
 * Review A5 — how many entries a media list check reads at most (a portfolio's folders, a library's videos), in the
 * gateway (gateway.ts) and in the tool (change-media.ts) alike; an id past them is not confirmed (fail closed).
 */
export const META_MEDIA_LIST_MAX = 500
/** Meta's caption file cap ("The file size limit for video captions is 200K"). */
export const META_CAPTIONS_MAX_BYTES = 200_000
/** A locale as Meta's caption file names carry it (`filename.en_US.srt`, error 386). */
export const META_LOCALE = /^[a-z]{2}_[A-Z]{2}$/
/** A caption file's name: `<name>.<locale>.srt` (Meta: "File name must be in the format filename.locale.srt"). */
export const META_CAPTIONS_FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}\.[a-z]{2}_[A-Z]{2}\.srt$/

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

const isDigits = (v: string, max = 20) => new RegExp(`^\\d{1,${max}}$`).test(v)

/** A JPG or PNG, by the file's own first bytes (Meta's ads guide: JPG or PNG). */
function imageTypeOf(head: Buffer): 'image/jpeg' | 'image/png' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  return null
}

/**
 * Why an image's `bytes` value is refused, or null: strict Base64 (the 64 letters, `=` padding only at the end, a length
 * that is a multiple of 4), at most the Base64 of 8 MB, and a JPG or PNG by its own first bytes. The value is never quoted.
 */
export function metaImageBytesProblem(value: string): string | null {
  if (!value) return 'bytes is an image, as Base64'
  if (value.length > META_IMAGE_BASE64_MAX) return `bytes is an image of at most ${META_IMAGE_MAX_BYTES / 1024 / 1024} MB`
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return 'bytes is strict Base64 (A–Z, a–z, 0–9, +, /, and = only at the end)'
  // The exact byte count (Base64's last group may carry one or two padding bytes): never a byte past 8 MB.
  if ((value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) > META_IMAGE_MAX_BYTES) return `bytes is an image of at most ${META_IMAGE_MAX_BYTES / 1024 / 1024} MB`
  if (!imageTypeOf(Buffer.from(value.slice(0, 16), 'base64'))) return 'bytes is a JPG or PNG image (Meta\'s ads take JPG and PNG)'
  return null
}

/** Query keys that carry a key, a signature or a sign-in: a link with one is not a public address (and is never stored). */
const SECRET_QUERY_KEY = /token|secret|signature|sig$|^sig|key|password|passwd|auth|credential|session|expires/i

/**
 * Review A3 — why a link Nexus records or hands on is refused for carrying a key, a signature or a sign-in in its query
 * (an image link Nexus fetches, a video link Meta fetches: the same rule), or null.
 */
export function metaLinkSecretProblem(url: URL): string | null {
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key)) return `carries no key, signature or sign-in in its address ("${key.slice(0, 40)}"): only public links are used, and Nexus keeps no secret`
  }
  return null
}

/**
 * Why a link Meta is asked to fetch is refused, or null. One spelling only (as the URL parser writes it), https, a public
 * DNS name (no address, no `localhost`, no local or internal suffix), no user, password, port or fragment, no key or
 * signature in its query (Meta: "urls requiring authentication are not currently supported"), at most 2,000 characters.
 * Nexus never fetches it: Meta does.
 */
export function metaFileUrlProblem(value: string): string | null {
  if (!value || value.length > 2000) return 'file_url is a link of at most 2000 characters'
  if (!/^[\x21-\x7e]+$/.test(value)) return 'file_url is a plain link (no spaces, letters outside ASCII written %-encoded)'
  let url: URL
  try { url = new URL(value) } catch { return 'file_url is not a link' }
  if (url.href !== value) return 'file_url is written as the URL parser writes it (one spelling only)'
  if (url.protocol !== 'https:') return 'file_url is an https:// link'
  if (url.username || url.password || url.port || url.hash) return 'file_url carries no user, password, port or #fragment'
  const host = url.hostname
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || /^[\d.]+$/.test(host)) return 'file_url names a public host by its name (no address)'
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion)$/.test(host)) return 'file_url names a public host (not a local or internal one)'
  const secret = metaLinkSecretProblem(url)
  return secret ? `file_url ${secret}` : null
}

/** Review A6 — bidirectional controls (embeddings, overrides, isolates, marks): text a person reads never carries them. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u
/**
 * Step 23's text pattern for the gateway's text check (MetaWriteRule.text): no control, format or surrogate character, but
 * U+200D (zero-width joiner) BETWEEN two emoji, as a family emoji is written — the same rule as step 18's META_NAME_TEXT.
 */
export const META_MEDIA_TEXT_PATTERN = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]|(?<=\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic}))*$/u
/**
 * Review round 2 — at least one character a person sees: not a space, a separator, a control or a format (zero-width)
 * character, not a Hangul or braille blank (U+115F, U+1160, U+3164, U+FFA0, U+2800), and not a combining mark alone (a mark
 * counts only on a visible base, which is then the visible character).
 */
const VISIBLE = /[^\p{White_Space}\p{Z}\p{Cc}\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/u

/**
 * Review A6 — why step 23's own text (a name, a title, a description) is refused, or null: 1 to `max` characters (a
 * title: UTF-8 bytes, see META_MEDIA_TEXT), at least one visible character, no bidirectional control, no control or format
 * character but a joiner between emoji (META_MEDIA_TEXT_PATTERN).
 */
export function metaMediaTextProblem(value: string, max: number, what: string, unit: 'characters' | 'bytes' = 'characters'): string | null {
  const length = unit === 'bytes' ? Buffer.byteLength(value, 'utf8') : [...value].length
  if (!value.trim() || length > max) return `${what} is 1 to ${max} ${unit === 'bytes' ? 'bytes (UTF-8; Meta counts some characters as more than one)' : 'characters'}`
  if (BIDI_CONTROLS.test(value)) return `${what} carries no bidirectional control character (they can reorder what a person reads)`
  if (!META_MEDIA_TEXT_PATTERN.test(value)) return `${what} carries no control or format character (a zero-width joiner only between two emoji)`
  if (!VISIBLE.test(value)) return `${what} has at least one visible character`
  return null
}

const textOf = (max: number, what: string, unit: 'characters' | 'bytes' = 'characters'): Judge => (value) => metaMediaTextProblem(value, max, what, unit)

/**
 * MD-026 — why a caption file's text is refused, or null: UTF-8 of at most 200,000 bytes (Meta's "200K"), no control
 * character (C0 or C1) but a line break or a tab, and SubRip's shape: blocks apart by a blank line, each a number, a time line
 * (`00:00:01,000 --> 00:00:04,000`) and at least one line of text. The text is never quoted.
 */
export function metaSrtProblem(text: string): string | null {
  if (!text.trim()) return 'the caption file is SubRip text (.srt) and is empty'
  if (Buffer.byteLength(text, 'utf8') > META_CAPTIONS_MAX_BYTES) return `the caption file is at most ${META_CAPTIONS_MAX_BYTES.toLocaleString('en')} bytes (Meta's 200K limit)`
  // Review round 2 — every control character (\p{Cc}: C0 and C1, U+0080–U+009F) but tab, line feed and carriage return.
  if (/(?![\t\n\r])\p{Cc}|[\u2028\u2029\uFFFD]/u.test(text)) return 'the caption file is plain text (no control character but line breaks and tabs)'
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n+/)
  for (const [i, block] of blocks.entries()) {
    const lines = block.split('\n')
    if (lines.length < 3 || !/^\d{1,6}$/.test(lines[0].trim()) || !/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}( .*)?$/.test(lines[1].trim()) || !lines.slice(2).some((l) => l.trim())) {
      return `the caption file is SubRip (.srt): block ${i + 1} is not a number, a time line (00:00:01,000 --> 00:00:04,000) and its text`
    }
  }
  return null
}

/** Each key's judge; every key of a rule has one. */
function judged(judges: Record<string, Judge>, also?: (params: Params) => string | null) {
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = judges[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value, params)
      if (problem) return problem
    }
    return also ? also(params) : null
  }
}

const digits = (what: string, max = 20): Judge => (value) => (isDigits(value, max) ? null : `${what} is a Meta id (digits only)`)
const exactly = (wanted: string, what: string): Judge => (value) => (value === wanted ? null : `${what} is ${wanted}`)

/** `selected_audio_spec` in Nexus's one spelling: `{"audio_asset_id":"<digits>"}` and nothing else (OCC 2026-06-01). */
const audioSpec: Judge = (value) => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (JSON.stringify(parsed) !== value || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    const keys = Object.keys(parsed)
    const id = (parsed as { audio_asset_id?: unknown }).audio_asset_id
    if (keys.length !== 1 || keys[0] !== 'audio_asset_id' || typeof id !== 'string' || !isDigits(id)) throw new Error('shape')
    return null
  } catch {
    return 'selected_audio_spec is exactly {"audio_asset_id":"<a Meta Sound Collection audio id>"}'
  }
}

/** An image hash as Meta writes it (hex letters and digits; step 10's reads take the same). */
const hashJudge: Judge = (value) => (/^[A-Za-z0-9]{1,64}$/.test(value) ? null : 'hash is an image hash (letters and digits)')

// Step 19's `adaccount` (the chosen ad account itself), and step 23's portfolio and library video.
const ACCOUNT: readonly MetaWriteKind[] = ['adaccount']
const PORTFOLIO: readonly MetaWriteKind[] = ['portfolio']
const LIBRARY_VIDEO: readonly MetaWriteKind[] = ['libraryvideo']
const VIDEO_TEXT = { name: META_MEDIA_TEXT_PATTERN, title: META_MEDIA_TEXT_PATTERN, description: META_MEDIA_TEXT_PATTERN }
const videoText = { name: textOf(META_MEDIA_TEXT.name, 'name'), title: textOf(META_MEDIA_TEXT.title, 'title', 'bytes'), description: textOf(META_MEDIA_TEXT.description, 'description') }
/** `default_locale`: a locale, or `none` (no default caption). */
const defaultLocale: Judge = (value) => (value === 'none' || META_LOCALE.test(value) ? null : 'default_locale is a locale (it_IT) or none')
/** `locales_to_delete` in Nexus's one spelling: a JSON list of 1 to 5 locales, each once. */
const localesToDelete: Judge = (value) => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (JSON.stringify(parsed) !== value || !Array.isArray(parsed) || !parsed.length || parsed.length > 5) throw new Error('shape')
    if (!parsed.every((l) => typeof l === 'string' && META_LOCALE.test(l)) || new Set(parsed).size !== parsed.length) throw new Error('shape')
    return null
  } catch {
    return 'locales_to_delete is a JSON list of 1 to 5 locales, each once (["it_IT"])'
  }
}

/** Step 23 — create-meta-media's entries of the write allow-list (meta-calls.ts writeRules). */
export const META_MEDIA_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // MD-003 (MD-004's multipart upload gives the same AdImage on the same edge: covered by this one).
    name: 'adaccount.image.upload', method: 'POST', path: /^act_\d{1,20}\/adimages$/, kinds: ACCOUNT,
    required: ['bytes'], optional: [], maxBody: META_IMAGE_MAX_BODY, bulky: true, edgeCall: true, budget: false,
    values: judged({ bytes: (value) => metaImageBytesProblem(value) }),
  },
  {
    // MD-010: Meta fetches the video from a public link (D3 B, step 1).
    name: 'adaccount.video.link', method: 'POST', path: /^act_\d{1,20}\/advideos$/, kinds: ACCOUNT,
    required: ['file_url'], optional: ['name', 'title', 'description'], text: VIDEO_TEXT, edgeCall: true, budget: false,
    values: judged({ file_url: (value) => metaFileUrlProblem(value), ...videoText }),
  },
  {
    // MD-020 / MD-021: a video of the chosen Instagram account into the ad library, optionally with its music swapped.
    name: 'adaccount.video.instagram', method: 'POST', path: /^act_\d{1,20}\/advideos$/, kinds: ACCOUNT,
    required: ['source_instagram_media_id'], optional: ['name', 'title', 'description', 'selected_audio_spec'], text: VIDEO_TEXT, edgeCall: true, budget: false,
    values: judged({ source_instagram_media_id: digits('source_instagram_media_id', 25), selected_audio_spec: audioSpec, ...videoText }),
    assets: (params) => [{ id: params.get('source_instagram_media_id')!, kind: 'instagrammedia' }],
  },
  {
    // MD-015: Meta's video-ads upload session, started on the chosen ad account.
    name: 'adaccount.video_ads.start', method: 'POST', path: /^act_\d{1,20}\/video_ads$/, kinds: ACCOUNT,
    required: ['upload_phase'], optional: [], edgeCall: true, budget: false,
    values: judged({ upload_phase: exactly('start', 'upload_phase') }),
  },
  {
    // MD-017: the upload published to the chosen ad account — only a video THIS connection started there.
    name: 'adaccount.video_ads.finish', method: 'POST', path: /^act_\d{1,20}\/video_ads$/, kinds: ACCOUNT,
    required: ['upload_phase', 'video_id'], optional: [], edgeCall: true, budget: false,
    values: judged({ upload_phase: exactly('finish', 'upload_phase'), video_id: digits('video_id') }),
    assets: (params) => [{ id: params.get('video_id')!, kind: 'startedvideo' }],
  },
  {
    // BM-058: a folder in the business portfolio's media library (SDK only; Meta has no update or delete for it).
    name: 'portfolio.folder.create', method: 'POST', path: /^\d{1,20}\/creative_folders$/, kinds: PORTFOLIO,
    required: ['name'], optional: ['description', 'parent_folder_id'], text: { name: META_MEDIA_TEXT_PATTERN, description: META_MEDIA_TEXT_PATTERN }, edgeCall: true, budget: false,
    values: judged({ name: textOf(META_MEDIA_TEXT.folderName, 'name'), description: textOf(META_MEDIA_TEXT.folderDescription, 'description'), parent_folder_id: digits('parent_folder_id') }),
    assets: (params) => (params.has('parent_folder_id') ? [{ id: params.get('parent_folder_id')!, kind: 'creativefolder' }] : []),
  },
  {
    // M5-03 / MD-007: an image out of the chosen ad account's library (create-meta-media's undo; step 22 reuses it).
    name: 'adaccount.image.remove', method: 'DELETE', path: /^act_\d{1,20}\/adimages$/, kinds: ACCOUNT,
    required: ['hash'], optional: [], edgeCall: true, budget: false,
    values: judged({ hash: hashJudge }),
  },
  {
    // M5-09 / MD-019: a video out of the chosen ad account's library (create-meta-media's undo; step 22 reuses it). Review
    // A2 — the video_id must be in the chosen account's library (the gateway reads it): step 22 has only this guard.
    name: 'adaccount.video.remove', method: 'DELETE', path: /^act_\d{1,20}\/advideos$/, kinds: ACCOUNT,
    required: ['video_id'], optional: [], edgeCall: true, budget: false,
    values: judged({ video_id: digits('video_id') }),
    assets: (params) => [{ id: params.get('video_id')!, kind: 'libraryvideo' }],
  },
  {
    // MD-026: an SRT caption file onto a video of the chosen account's library. The gateway itself sends `captions_file` as
    // a multipart file part named by `captions_file_name` (MetaWriteRule.file); every other key is a plain field. Lane C4
    // (step 39, Q8: a feed's CSV, a block list) can reuse the same `file` field for its own rule.
    name: 'video.captions.upload', method: 'POST', path: /^\d{1,20}\/captions$/, kinds: LIBRARY_VIDEO,
    required: ['captions_file', 'captions_file_name'], optional: ['default_locale'], maxBody: 3 * META_CAPTIONS_MAX_BYTES + 500, bulky: true, edgeCall: true, budget: false,
    file: { key: 'captions_file', nameKey: 'captions_file_name', name: META_CAPTIONS_FILE_NAME, contentType: 'application/x-subrip', maxBytes: META_CAPTIONS_MAX_BYTES, judge: metaSrtProblem },
    values: judged({
      captions_file: () => null, // judged as the file (MetaWriteRule.file.judge)
      captions_file_name: (value) => (META_CAPTIONS_FILE_NAME.test(value) ? null : 'captions_file_name is <name>.<locale>.srt (e.g. spot.it_IT.srt)'),
      default_locale: defaultLocale,
    }),
  },
  {
    // MD-027 (the undo of MD-026): a caption locale taken off a video of the chosen account's library — Meta has no DELETE
    // on the captions edge; `locales_to_delete` on the same POST is its way (and `default_locale` puts a default back).
    name: 'video.captions.remove', method: 'POST', path: /^\d{1,20}\/captions$/, kinds: LIBRARY_VIDEO,
    required: ['locales_to_delete'], optional: ['default_locale'], edgeCall: true, budget: false,
    values: judged({ locales_to_delete: localesToDelete, default_locale: defaultLocale }),
  },
]

// ── a file part the gateway encodes (MetaWriteRule.file) ──────────────────────────────────────────────────────────

/** The multipart body of a judged write with a file (never stored or logged: the ledger keeps its length only). */
export function metaMultipartBody(multipart: { fields: Array<[string, string]>; file: { key: string; filename: string; contentType: string; text: string } }): FormData {
  const form = new FormData()
  for (const [key, value] of multipart.fields) form.append(key, value)
  form.append(multipart.file.key, new Blob([multipart.file.text], { type: multipart.file.contentType }), multipart.file.filename)
  return form
}

// ── Meta's resumable upload host (MD-016) ─────────────────────────────────────────────────────────────────────────

/** The one address Nexus sends a video's link to: `https://rupload.facebook.com/video-ads-upload/<version>/<video id>`. */
export function metaRuploadUrl(videoId: string): string {
  return `https://${META_RUPLOAD_HOST}/video-ads-upload/${metaGraphApiVersion()}/${videoId}`
}

/** The address as it is sent: the appsecret proof on it (the token travels in the Authorization header, never here). */
export function metaRuploadSendUrl(url: string, proof: { appsecret_proof: string; appsecret_time: string }): string {
  const parsed = new URL(url)
  parsed.searchParams.set('appsecret_proof', proof.appsecret_proof)
  parsed.searchParams.set('appsecret_time', proof.appsecret_time)
  return parsed.toString()
}

/**
 * The verdict on a call to Meta's upload host, or null when the call is not for that host. Exactly POST
 * `https://rupload.facebook.com/video-ads-upload/<pinned version>/<video id>` with nothing else on the address, declared
 * a write of kind `video` with the account's own token, no header of the caller's own, and a form body of ONE key,
 * `file_url` (judged like advideos' link): the gateway sends it as Meta's `file_url` header, adds `Authorization: OAuth
 * <token>` itself and sends no body — no video byte travels through Nexus. The video must be one THIS connection started on
 * the chosen ad account (the gateway checks it before anything is sent).
 */
export function metaRuploadVerdict(input: { method: string; url: string; kind: string; body?: unknown; objectKind?: string }): MetaWriteVerdict | null {
  let parsed: URL
  try { parsed = new URL(input.url) } catch { return null }
  if (parsed.hostname !== META_RUPLOAD_HOST) return null
  const refuse = (problem: string): MetaWriteVerdict => ({ problem })
  const route = new RegExp(`^https://rupload\\.facebook\\.com/video-ads-upload/${metaGraphApiVersion().replace('.', '\\.')}/(\\d{1,20})$`).exec(input.url)
  if (!route) return refuse(`Nexus sends Meta's upload host only https://${META_RUPLOAD_HOST}/video-ads-upload/${metaGraphApiVersion()}/<video id>, with nothing else on the address`)
  if (input.method.toUpperCase() !== 'POST') return refuse('Meta\'s upload host takes a POST only from Nexus')
  if (input.kind !== 'write') return refuse('a Meta change goes as a write; this one is declared otherwise')
  if (input.objectKind !== 'video') return refuse('a call to Meta\'s upload host names the video upload it is for (kind video)')
  if (typeof input.body !== 'string' || !input.body) return refuse('a call to Meta\'s upload host carries the video\'s link as file_url')
  const params = [...new URLSearchParams(input.body)]
  if (params.length !== 1 || params[0][0] !== 'file_url') return refuse('a call to Meta\'s upload host carries exactly one key, file_url: Nexus sends no video bytes')
  const problem = metaFileUrlProblem(params[0][1])
  if (problem) return refuse(problem)
  return { write: { rule: 'video.rupload', objectId: route[1], check: false, body: '', budget: false, kinds: ['video'], edgeCall: true, host: 'rupload', headers: { file_url: params[0][1] } } }
}

// ── the video uploads THIS connection started (MD-015 → MD-016 / MD-017) ────────────────────────────────────────────

/** A started upload expires on Meta's side; Nexus keeps the note this long (one change's run is minutes). */
const STARTED_KEEP_MS = 6 * 60 * 60_000
const started = new Map<string, { adAccountId: string; at: number }>()

/** The gateway saw Meta answer a video-ads start on this connection's chosen ad account with this video id. */
export function noteMetaVideoStarted(connectionId: string, adAccountId: string, videoId: string, now: number = Date.now()): void {
  for (const [key, row] of started) if (now - row.at > STARTED_KEEP_MS) started.delete(key)
  started.set(`${connectionId}:${videoId}`, { adAccountId, at: now })
}

/** The ad account (digits) this connection started this video upload on, or null (never, or too long ago). */
export function metaVideoStartedOn(connectionId: string, videoId: string, now: number = Date.now()): string | null {
  const row = started.get(`${connectionId}:${videoId}`)
  return row && now - row.at <= STARTED_KEEP_MS ? row.adAccountId : null
}

/** A video-ads start's answer: its video id, when it is one (digits) — and the upload address Meta named, if any. */
export function metaStartedVideoOf(text: string): { videoId: string; uploadUrl: string | null } | null {
  try {
    const body = JSON.parse(text) as { video_id?: unknown; upload_url?: unknown }
    const id = typeof body.video_id === 'string' || typeof body.video_id === 'number' ? String(body.video_id) : ''
    return isDigits(id) ? { videoId: id, uploadUrl: typeof body.upload_url === 'string' ? body.upload_url : null } : null
  } catch {
    return null
  }
}

/** Tests: forget every started upload. */
export const __metaMediaRulesTest = { reset() { started.clear() } }

