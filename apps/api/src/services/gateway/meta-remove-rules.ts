/**
 * Meta step 22 (2026-10-21) — the write allow-list entries of remove-meta-ads-items beyond step 19's `object.delete` (a
 * campaign, ad set or ad: DELETE /{id}, no body — reused as it is): a creative, an image of the chosen ad account's library
 * (by its hash), a video of that library, caption languages of such a video, and a part of an Instant Experience of the
 * chosen Page. EXACT keys, every value judged; the object of every rule is confirmed by the gateway before anything is sent
 * (gateway.ts metaOwnerProblem): a creative by its account_id and two fields only a creative has; a video by the chosen ad
 * account's own library (act_<id>/advideos); an Instant Experience part by the chosen Page's own parts
 * (<page id>/canvas_elements). An image needs no id check: its DELETE names the chosen ad account itself (`act_<id>`, kind
 * adaccount — the gateway sends it only to that one), and Meta takes the hash out of THAT account's library only.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages, curl ≥ 3 s apart):
 *   - reference/ad-creative.md "Deleting": DELETE /{creative_id}, no parameters, {success}; errors 100, 200, 80004.
 *     ads-ai-connectors/ads-cli/ad-creatives.md: "You cannot delete ad creatives that active ads use. Pause or delete the
 *     associated ads first."
 *   - reference/ad-account/adimages.md "Deleting": DELETE /act_{id}/adimages, `hash` [required], `image_id` (optional:
 *     never sent), {success}; errors 100, 80004. reference/ad-image.md: "You can only delete ad images not currently being
 *     used in an ad creative."
 *   - reference/ad-account/advideos.md "Deleting": DELETE /act_{id}/advideos, `video_id` ("Ad account library video ID")
 *     [required] — Meta "dissociates" the video from the ad account; {success}; errors 613, 100.
 *   - docs/graph-api/reference/video/captions: POST /{video_id}/captions with `locales_to_delete` (list<string>) — the only
 *     way to delete caption languages (the edge has no DELETE); "advertiser access on account that owns the video" may
 *     change them; {success}; errors 100, 387, 482.
 *   - guides/instant-experiences.md "Delete an element": DELETE /{canvas_element_id} (its own curl sends the token as a
 *     form body: `curl -X DELETE -d 'access_token=…'` — Graph reads a DELETE's form body). Whether the system user's token
 *     is enough (the guide names the Page's ADVERTISE task): LIVE-PROBES CR-487.
 * A DELETE's parameters go as its form body, like a POST's (the gateway judges the body it sends and puts nothing in the
 * URL). Meta's Instant Experience guide sends a DELETE form body; Meta's Python SDK (facebook_business/api.py) puts a
 * DELETE's parameters on the query string instead — whether Meta reads `hash` / `video_id` from the body is LIVE-PROBES
 * MD-007 (if not, Meta answers 100 and nothing is deleted).
 */
import type { MetaWriteRule } from './meta-calls.js'

/** An image hash as Meta writes it (step 10's media reads take the same). */
export const META_IMAGE_HASH = /^[A-Za-z0-9]{1,64}$/
/** A caption language as Meta names it (`en_US`, `it_IT`: the SRT file name's locale). */
export const META_CAPTION_LOCALE = /^[a-z]{2,3}_[A-Z]{2}$/
/** The most caption languages one request deletes. */
export const MAX_CAPTION_LOCALES = 50

/** `locales_to_delete`: a JSON list of 1–50 locales, each once, in one spelling (as Nexus writes it). */
function localesProblem(value: string): string | null {
  let list: unknown
  try { list = JSON.parse(value) } catch { list = undefined }
  if (list === undefined || JSON.stringify(list) !== value) return 'locales_to_delete is JSON in one spelling only (as Nexus writes it: no spaces)'
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CAPTION_LOCALES) return `locales_to_delete lists 1 to ${MAX_CAPTION_LOCALES} caption languages`
  if (!list.every((l) => typeof l === 'string' && META_CAPTION_LOCALE.test(l))) return 'locales_to_delete lists caption languages as Meta names them (en_US, it_IT)'
  return new Set(list).size === list.length ? null : 'locales_to_delete names each language once'
}

/** Step 22's rules on the write allow-list (meta-calls.ts writeRules). */
export const META_REMOVE_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // DELETE /{creative_id}, no body: a creative of the chosen ad account (the gateway confirms its kind and account).
    name: 'creative.delete',
    method: 'DELETE',
    path: /^\d{1,20}$/,
    kinds: ['creative'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // DELETE /act_{chosen}/adimages hash=…: one image out of the chosen ad account's library.
    name: 'image.delete',
    method: 'DELETE',
    path: /^act_\d{1,25}\/adimages$/,
    kinds: ['adaccount'],
    required: ['hash'],
    optional: [],
    maxBody: 200,
    values: (params) => (META_IMAGE_HASH.test(params.get('hash') ?? '') ? null : 'hash is an image hash of the ad account\'s library (letters and digits)'),
    budget: false,
  },
  {
    // DELETE /act_{chosen}/advideos video_id=…: one video out of the chosen ad account's library (its id checked to be there).
    name: 'video.remove',
    method: 'DELETE',
    path: /^act_\d{1,25}\/advideos$/,
    kinds: ['adaccount'],
    required: ['video_id'],
    optional: [],
    maxBody: 200,
    values: (params) => (/^\d{1,20}$/.test(params.get('video_id') ?? '') ? null : 'video_id is a Meta id (digits only)'),
    budget: false,
    ids: (params) => (/^\d{1,20}$/.test(params.get('video_id') ?? '') ? [{ id: params.get('video_id')!, kind: 'video' }] : []),
  },
  {
    // POST /{video_id}/captions locales_to_delete=[…]: caption languages of a video of the chosen ad account's library.
    name: 'captions.delete',
    method: 'POST',
    path: /^\d{1,20}\/captions$/,
    kinds: ['video'],
    required: ['locales_to_delete'],
    optional: [],
    maxBody: 2000,
    values: (params) => localesProblem(params.get('locales_to_delete') ?? ''),
    budget: false,
  },
  {
    // DELETE /{canvas_element_id}, no body: a part of an Instant Experience of the chosen Page (the gateway confirms it).
    name: 'canvaselement.delete',
    method: 'DELETE',
    path: /^\d{1,20}$/,
    kinds: ['canvaselement'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
