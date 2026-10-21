/**
 * Meta step 27 (2026-10-21) — the write allow-list entries of create-meta-ad and set-meta-ad: EXACT keys per edge, every
 * value judged, JSON in ONE spelling (exactly what JSON.stringify writes of what was judged), text only where a person types
 * it (a name, a label, a creative's text). A new ad's inline creative is judged by step 25's ONE creative judge
 * (meta-creative-rules.ts judgeCreativeSpec: every key at every depth, every silent feature named, every id handed to the
 * gateway); every id inside an ad's body is handed to the gateway too, which checks it before anything is sent (gateway.ts
 * metaBodyIdsProblem / metaMediaAssetsProblem): the ad set and an existing creative of the chosen ad account, the pixels of
 * its own pixel list, the images, videos, Page, Instagram account, Instant Experience … of an inline creative.
 *
 *   adaccount.ad.create   POST /act_<id>/ads        a new ad of the chosen ad account (and Meta's check of it: validate_only
 *                                                   WITH synchronous_ad_review, optionally include_recommendations — the
 *                                                   only check documented with more than validate_only; AD-026 … AD-028)
 *   ad.update             POST /<ad id>             name, the creative by its id (a swap), labels (the whole list), the
 *                                                   ad's own start / end time, its tracking, conversion domain and persona
 *                                                   (each also cleared: Meta's "update the value to empty")
 *   ad.adlabels           POST /<ad id>/adlabels    labels added
 *   ad.remove             DELETE /<ad id>           ONLY create-meta-ad's undo of an ad THAT change made (change-ads.ts
 *                                                   adUndoDraft is the one draft that builds it, from the change's own
 *                                                   record; lane C1's step 22 owns the general delete and may widen it)
 *
 * Checked 2026-10-21 (curl ≥ 4 s apart; .md pages under developers.facebook.com/documentation/ads-commerce/marketing-api/;
 * Meta's Python Business SDK main, facebook_business/adobjects/adaccount.py create_ad and ad.py api_update / create_ad_label):
 *   - reference/ad-account/ads.md "Creating": ad_schedule_end_time / ad_schedule_start_time (datetime; "only available for
 *     sales and app promotion campaigns"), adlabels, adset_id ("required on creation"), adset_spec ("The ad set spec for
 *     this ad" — no shape: AD-025, refused below), audience_id ("The ID of the audience"), bid_amount ("Deprecated"),
 *     conversion_domain ("only the first and second level domains"), creative ({"creative_id": …} or a creative spec),
 *     creative_asset_groups_spec, date_format, display_sequence ("The sequence of the ad within the same campaign"),
 *     engagement_audience, execution_options list<enum{validate_only, synchronous_ad_review, include_recommendations}>
 *     ("synchronous_ad_review … should always be specified with validate_only"; include_recommendations "cannot be used by
 *     itself"), include_demolink_hashes, name [required], priority ("Priority" — AD-034: no explained effect), source_ad_id,
 *     status ("Only ACTIVE and PAUSED are valid during creation"), tracking_specs. Return {id, success}; read-after-write.
 *     SDK create_ad adds creative_audience_pairing_persona (map), creative_automation_spec, dataset_split_specs,
 *     draft_adgroup_id — the last three are on no v26 page: refused in words.
 *   - reference/adgroup.md "Updating": "Only update fields that were used during ad creation can be updated"; adset_id can
 *     never change; ARCHIVED → only name and status (to DELETED); DELETED → only name; "You can remove values for any
 *     optional fields by updating the value to empty"; no update parameter table (Meta documents no validate_only there).
 *     "Deleting": DELETE /{ad_id}; "You cannot delete ads in ad set with creative_sequence settings".
 *   - reference/ad-label.md ("Updating": an object's labels; the adgroup/adlabels page is a 404): POST /<ad id>/adlabels
 *     with adlabels (SDK ad.py create_ad_label).
 *
 * Review round 1 (A1, A2) — THE activation rule, here for the tool and the gateway alike (metaActivationProblem): an ad is
 * made ACTIVE, or a creative goes onto an ACTIVE ad, only when that creative reads an explicit OPT_OUT for EVERY Advantage+
 * creative feature Meta documents (step 25's META_CREATIVE_FEATURES and the deprecated standard_enhancements bundle) — any
 * opt-in, any feature not said, or switches Nexus cannot read: create it PAUSED, preview it, then switch it on with
 * set-meta-status. The gateway reads an existing creative's switches in the same read as its account_id
 * (gateway.ts metaCreativeActivationProblem; `activation` on the body id).
 *   - ad-creative/messaging-ads/website-ads-click-to-message.md: the "message us" footer is passed INLINE on POST /ads, the
 *     creative spec itself as `creative` (Meta's guides; the reference also shows {"creative": {…}} — LIVE-PROBES AD-024i).
 *   - ad-creative/multi-media-ads.md, flexible-ad-format.md, out-of-cycle-changes/occ-2026.md (2026-10-19, creative audience
 *     pairing on POST /act_{id}/ads and POST /{ad-id}), tracking-specs.md.
 */
import type { MetaWriteAsset, MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import {
  adCodesIn, judgeAdPersona, judgeAssetGroups, judgeCreativeSpec, labelsJudge, META_AI_GENERATED_FEATURES, META_CREATIVE_FEATURES, META_CREATIVE_MAX_BODY, metaCreativeTextProblem,
} from './meta-creative-rules.js'
import { META_MEDIA_TEXT_PATTERN } from './meta-media-rules.js'

type Params = ReadonlyMap<string, string>

/** An ad's name: Meta's reference names no limit; Nexus holds the ad set's (≤ 400, emoji). */
export const META_AD_NAME_MAX = 400
/** The two checks a new ad's preview sends: Meta's validation with its synchronous integrity review, optionally its recommendations. */
export const META_AD_CHECK = '["validate_only","synchronous_ad_review"]'
export const META_AD_CHECK_WITH_RECOMMENDATIONS = '["validate_only","synchronous_ad_review","include_recommendations"]'
/** Pixels an ad's tracking names (Meta lists no limit; the chosen account's own pixels — and one change stays small). */
export const META_AD_TRACKING_MAX = 10
/** The tracking actions Nexus writes on an ad (tracking-specs.md): pixel conversions and down-funnel lead quality. */
export const META_AD_TRACKING_ACTIONS = ['offsite_conversion', 'leadgen_quality_conversion'] as const

/**
 * Keys Meta takes on POST /act_<id>/ads that Nexus answers in words (the rule lists them so that its judge says why).
 */
export const META_AD_REFUSED: Readonly<Record<string, string>> = {
  // Master AD-025 (RECHECK STILL-UNVERIFIED): the shape of adset_spec is on no page.
  adset_spec: 'Meta documents no shape for an ad set made inside an ad (adset_spec): build the ad set first (create-meta-ad-set, born PAUSED) and name it (adset_id)',
  bid_amount: 'Meta no longer takes a bid on an ad ("Deprecated … set bid_amount for the ad set"): set-meta-ad-set changes the ad set\'s bid',
  audience_id: 'Meta documents audience_id only as "The ID of the audience" with no effect: an ad\'s audience is its ad set\'s targeting, and Nexus sends none here',
  source_ad_id: 'an ad copied from another ad is copy-meta-ads (Meta\'s own copies edge), not a new ad naming its source',
  include_demolink_hashes: 'Meta documents no use of demo-link hashes for an advertiser\'s ad: Nexus sends none',
  date_format: 'Meta removes date_format from every API version from 2026-10-27 (it then answers a parameter error)',
  creative_automation_spec: 'creative_automation_spec is in Meta\'s SDK only (no v26 page): it could switch on an automation Nexus cannot say, so Nexus sends none',
  dataset_split_specs: 'dataset_split_specs is in Meta\'s SDK only (no v26 page): Nexus sends none',
  draft_adgroup_id: 'Ads Manager drafts are published in Ads Manager (draft_adgroup_id is in Meta\'s SDK only)',
}

const isDigits = (value: string | undefined, max = 20) => !!value && new RegExp(`^\\d{1,${max}}$`).test(value)
const UNIX_SECONDS = /^\d{10}$/
/**
 * A domain as Meta wants it on conversion_domain: "only the first and second level domains", e.g. example.com — review B6:
 * exactly two levels (shop.example.com is refused).
 */
export const META_CONVERSION_DOMAIN = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The ad's `creative`: an existing creative by its id, or (a new ad only) an inline creative judged by step 25's judge. */
export type JudgedAdCreative = { creativeId: string } | { creative: Record<string, unknown>; assets: MetaWriteAsset[] } | { problem: string }
export function judgeAdCreative(raw: string | undefined, inline: boolean): JudgedAdCreative {
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '') } catch { return { problem: 'creative is JSON' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: 'creative is a JSON object' }
  const keys = Object.keys(parsed)
  if (keys.includes('creative_id')) {
    const id = (parsed as { creative_id?: unknown }).creative_id
    if (keys.length !== 1 || typeof id !== 'string' || !isDigits(id)) return { problem: 'creative names an existing creative as {"creative_id":"<digits>"} and nothing else' }
    return JSON.stringify({ creative_id: id }) === raw ? { creativeId: id } : { problem: 'creative is written in one spelling (as JSON.stringify writes it)' }
  }
  if (!inline) return { problem: 'an ad\'s creative changes by its id only ({"creative_id":"<id>"}): a creative cannot change once made, so a new look is a new creative (create-meta-creative) swapped onto the ad' }
  if (keys.length === 1 && keys[0] === 'creative') return { problem: 'Nexus sends an inline creative as Meta\'s guides do: the creative spec itself as creative, not wrapped in {"creative": …}' }
  const judged = judgeCreativeSpec(raw, 'creative')
  return 'problem' in judged ? judged : { creative: judged.creative, assets: judged.assets }
}

/** Every Advantage+ creative feature Meta documents, and the deprecated bundle by its own name: an ACTIVE ad's creative says OPT_OUT for each. */
export const META_ACTIVATE_FEATURES: readonly string[] = [...new Set([...META_CREATIVE_FEATURES, 'standard_enhancements'])].sort()
/** What a person reads when an ad may not be (or show a creative while it is) ACTIVE. */
export const META_ACTIVATE_RULE = 'create it PAUSED, preview it, then switch it on with set-meta-status (Meta\'s rule for AI features)'

/**
 * Review round 1 (A1, A2) — may an ad be ACTIVE with this creative? Only when the creative reads an explicit OPT_OUT for every
 * feature of META_ACTIVATE_FEATURES and switches on none at all (an unknown name too): fail-closed — a creative made outside
 * Nexus, with a feature not said or switches Nexus cannot read, is refused the same way. Why not, or null.
 */
export function metaActivationProblem(creative: Record<string, unknown> | null | undefined, what = 'the creative'): string | null {
  const dof = creative && typeof creative === 'object' ? (creative as { degrees_of_freedom_spec?: { creative_features_spec?: unknown } }).degrees_of_freedom_spec : undefined
  const spec = dof && typeof dof === 'object' ? dof.creative_features_spec : undefined
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return `${what} reads no Advantage+ feature switches (made outside Nexus, or Nexus cannot read them), so a feature generated with AI cannot be ruled out: ${META_ACTIVATE_RULE}`
  const features = spec as Record<string, { enroll_status?: unknown } | undefined>
  const on = Object.keys(features).filter((f) => features[f]?.enroll_status === 'OPT_IN').sort()
  if (on.length) return `${what} switches on ${on.join(', ')}: ${META_ACTIVATE_RULE}`
  const unsaid = META_ACTIVATE_FEATURES.filter((f) => features[f]?.enroll_status !== 'OPT_OUT')
  if (unsaid.length) return `${what} does not say OPT_OUT for ${unsaid.slice(0, 5).join(', ')}${unsaid.length > 5 ? ` and ${unsaid.length - 5} more` : ''} (Meta may switch such a feature on by itself): ${META_ACTIVATE_RULE}`
  return null
}

/** The Advantage+ creative features generated with AI that an inline creative switches ON (CR-404: never ACTIVE at once). */
export function aiFeaturesOn(creative: Record<string, unknown>): string[] {
  const spec = (creative.degrees_of_freedom_spec as { creative_features_spec?: Record<string, { enroll_status?: unknown }> } | undefined)?.creative_features_spec ?? {}
  return Object.entries(spec).filter(([feature, v]) => v?.enroll_status === 'OPT_IN' && META_AI_GENERATED_FEATURES.has(feature)).map(([f]) => f).sort()
}

/**
 * tracking_specs (AD-029; tracking-specs.md): a JSON list of 1 to 10 specs, each ONE action of META_AD_TRACKING_ACTIONS on
 * ONE pixel (`fb_pixel`) — or, for lead quality, one dataset (`dataset`: a dataset is a pixel of the account in v26) — every
 * value as a one-entry list, as Meta's own examples write them. Returns the pixel ids, or why not.
 */
export function trackingPixels(raw: string | undefined): { pixels: string[] } | { problem: string } {
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '') } catch { return { problem: 'tracking_specs is JSON' } }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > META_AD_TRACKING_MAX) return { problem: `tracking_specs is a JSON list of 1 to ${META_AD_TRACKING_MAX} specs` }
  const pixels: string[] = []
  for (const [i, spec] of parsed.entries()) {
    const s = (spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null) as Record<string, unknown> | null
    const keys = s ? Object.keys(s) : []
    const target = keys.find((k) => k === 'fb_pixel' || k === 'dataset')
    const action = Array.isArray(s?.['action.type']) && (s!['action.type'] as unknown[]).length === 1 ? (s!['action.type'] as unknown[])[0] : null
    const id = target && Array.isArray(s![target]) && (s![target] as unknown[]).length === 1 ? (s![target] as unknown[])[0] : null
    if (!s || keys.length !== 2 || !target || typeof action !== 'string' || !(META_AD_TRACKING_ACTIONS as readonly string[]).includes(action) || typeof id !== 'string' || !isDigits(id)) {
      return { problem: `tracking_specs[${i}] is {"action.type":["offsite_conversion" | "leadgen_quality_conversion"],"fb_pixel":["<pixel id>"]} (or "dataset" for lead quality): Nexus tracks the chosen account's own pixels only (app, page and post specs are Meta's defaults per objective)` }
    }
    if (target === 'dataset' && action !== 'leadgen_quality_conversion') return { problem: `tracking_specs[${i}]: a dataset goes with leadgen_quality_conversion only (tracking-specs.md)` }
    pixels.push(id)
  }
  const canonical = JSON.stringify(parsed.map((s) => {
    const spec = s as Record<string, unknown>
    const target = 'fb_pixel' in spec ? 'fb_pixel' : 'dataset'
    return { 'action.type': spec['action.type'], [target]: spec[target] }
  }))
  if (canonical !== raw) return { problem: 'tracking_specs is written in one spelling ({"action.type":[…],"fb_pixel":[…]}, as JSON.stringify writes it)' }
  if (new Set(parsed.map((s) => JSON.stringify(s))).size !== parsed.length) return { problem: 'tracking_specs names each spec once' }
  return { pixels: [...new Set(pixels)] }
}

/** One value of the ad's own schedule: UTC Unix seconds (as every Nexus time is sent); `clear`: empty clears it (AD-044). */
const timeProblem = (value: string, key: string, clear: boolean): string | null => {
  if (clear && value === '') return null
  return UNIX_SECONDS.test(value) ? null : `${key} is a time in UTC Unix seconds${clear ? ' (or empty: cleared, the ad follows its campaign\'s schedule)' : ''}`
}

/** Every value of an ad's create (the whole body) or update. */
function adValues(params: Params, create: boolean): string | null {
  for (const key of Object.keys(META_AD_REFUSED)) if (params.has(key)) return `${key}: ${META_AD_REFUSED[key]}`
  if (params.has('name')) {
    const p = metaCreativeTextProblem(params.get('name')!, META_AD_NAME_MAX, 'name')
    if (p) return p
  }
  if (create) {
    if (!isDigits(params.get('adset_id'))) return 'adset_id is a Meta id (digits only)'
    const status = params.get('status')
    if (status !== 'PAUSED' && status !== 'ACTIVE') return 'status is PAUSED (a new ad is born paused) or ACTIVE (asked, SPENDS MONEY): Meta takes only those two on a create'
    if (params.has('execution_options') && ![META_AD_CHECK, META_AD_CHECK_WITH_RECOMMENDATIONS].includes(params.get('execution_options')!)) {
      return `the only execution_options Nexus sends on a new ad is exactly ${META_AD_CHECK} or ${META_AD_CHECK_WITH_RECOMMENDATIONS} (Meta's check with its integrity review, which changes nothing)`
    }
  }
  if (params.has('creative')) {
    const creative = judgeAdCreative(params.get('creative'), create)
    if ('problem' in creative) return creative.problem
    // CR-404 (creative/generative-ai-features.md, get-started.md) and review round 1 (A2) — an ACTIVE ad's inline creative
    // says OPT_OUT for every Advantage+ feature; an existing creative's switches are read by the gateway (`activation`).
    if ('creative' in creative && params.get('status') === 'ACTIVE') {
      const p = metaActivationProblem(creative.creative, 'the new ad\'s creative')
      if (p) return `a new ad is created ACTIVE only with a creative that switches on no Advantage+ feature — ${p}`
    }
  }
  if (params.has('adlabels')) { const p = labelsJudge(params.get('adlabels')!); if (p) return p }
  // Review B2 — on an update, tracking, the conversion domain and the persona may also be cleared (an empty value).
  const cleared = (key: string) => !create && params.get(key) === ''
  if (params.has('tracking_specs') && !cleared('tracking_specs')) { const t = trackingPixels(params.get('tracking_specs')); if ('problem' in t) return t.problem }
  if (params.has('conversion_domain') && !cleared('conversion_domain') && !META_CONVERSION_DOMAIN.test(params.get('conversion_domain')!)) return 'conversion_domain is a domain as Meta wants it: the first and second level only, e.g. example.com (no https://, path or sub-domain)'
  for (const key of ['ad_schedule_start_time', 'ad_schedule_end_time']) {
    if (params.has(key)) { const p = timeProblem(params.get(key)!, key, !create); if (p) return p }
  }
  const start = Number(params.get('ad_schedule_start_time') || NaN)
  const end = Number(params.get('ad_schedule_end_time') || NaN)
  if (Number.isFinite(start) && Number.isFinite(end) && end <= start) return 'ad_schedule_end_time is after ad_schedule_start_time'
  if (params.has('engagement_audience') && params.get('engagement_audience') !== 'true') return 'engagement_audience is true (Meta builds no audience without it: leave it out)'
  for (const key of ['display_sequence', 'priority']) if (params.has(key) && !/^\d{1,9}$/.test(params.get(key)!)) return `${key} is a whole number (0 or more)`
  if (params.has('creative_asset_groups_spec')) { const g = judgeAssetGroups(params.get('creative_asset_groups_spec')); if ('problem' in g) return g.problem }
  if (params.has('creative_audience_pairing_persona') && !cleared('creative_audience_pairing_persona')) { const p = judgeAdPersona(params.get('creative_audience_pairing_persona')); if ('problem' in p) return p.problem }
  return null
}

/** The ids inside an ad's body (the gateway checks each is of the chosen ad account, of its kind). */
function adIds(params: Params, create: boolean): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  if (create && isDigits(params.get('adset_id'))) out.push({ id: params.get('adset_id')!, kind: 'adset' })
  const creative = params.has('creative') ? judgeAdCreative(params.get('creative'), create) : null
  // Review A1 — an existing creative an ad shows while ACTIVE: the gateway reads its switches with its account_id (a new ad
  // created ACTIVE: always; a swap: when the ad it goes onto is ACTIVE).
  if (creative && 'creativeId' in creative) {
    const activation = create ? (params.get('status') === 'ACTIVE' ? 'always' as const : null) : 'if-ad-active' as const
    out.push({ id: creative.creativeId, kind: 'creative', ...(activation ? { activation } : {}) })
  }
  const tracking = params.has('tracking_specs') && params.get('tracking_specs') !== '' ? trackingPixels(params.get('tracking_specs')) : null
  if (tracking && 'pixels' in tracking) out.push(...tracking.pixels.map((id) => ({ id, kind: 'pixel' as const })))
  return out
}

/** The media ids inside a new ad's body: its inline creative's, and its flexible-format groups' images and videos. */
function adAssets(params: Params): MetaWriteAsset[] {
  const creative = params.has('creative') ? judgeAdCreative(params.get('creative'), true) : null
  const groups = params.has('creative_asset_groups_spec') ? judgeAssetGroups(params.get('creative_asset_groups_spec')) : null
  return [...(creative && 'assets' in creative ? creative.assets : []), ...(groups && 'assets' in groups ? groups.assets : [])]
}

const ACCOUNT = ['adaccount'] as const
const AD = ['ad'] as const
/** Keys whose values a person types (text with any letters, emoji; JSON of a creative or of groups' texts). */
const AD_TEXT: Readonly<Record<string, RegExp>> = { name: META_MEDIA_TEXT_PATTERN, creative: META_MEDIA_TEXT_PATTERN, adlabels: META_MEDIA_TEXT_PATTERN, creative_asset_groups_spec: META_MEDIA_TEXT_PATTERN }
/**
 * The keys set-meta-ad changes on POST /<ad id> (AD-031, AD-038, AD-042, AD-043, AD-044; review B2: AD-029 tracking, AD-030
 * the conversion domain — "Required to create or update an ad" — and CR-427 the persona, OCC 2026-10-19 "POST /{ad-id}").
 */
export const META_AD_UPDATE_KEYS = ['name', 'creative', 'adlabels', 'ad_schedule_start_time', 'ad_schedule_end_time', 'tracking_specs', 'conversion_domain', 'creative_audience_pairing_persona'] as const
/**
 * Review A4 — the longest update body set-meta-ad's own input can make: a 400-unit name and 50 labels of 100 units, each
 * unit at most 9 form-encoded characters (a 3-byte letter, %XX%XX%XX), plus the JSON around them and the other keys. The
 * preview never promises a body the gateway would refuse.
 */
export const META_AD_UPDATE_MAX_BODY = 64_000

/** Step 27 — create-meta-ad's and set-meta-ad's entries of the write allow-list (meta-calls.ts writeRules). */
export const META_AD_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // M6-01, M6-09 (master AD-023 … AD-034, CR-211 … CR-434): a new ad of the chosen ad account, and Meta's check of it.
    name: 'adaccount.ad.create', method: 'POST', path: /^act_\d{1,20}\/ads$/, kinds: ACCOUNT,
    required: ['name', 'adset_id', 'creative', 'status'],
    optional: [
      'adlabels', 'tracking_specs', 'conversion_domain', 'ad_schedule_start_time', 'ad_schedule_end_time', 'engagement_audience', 'display_sequence', 'priority',
      'creative_asset_groups_spec', 'creative_audience_pairing_persona', 'execution_options', ...Object.keys(META_AD_REFUSED),
    ],
    // A creator's ad code inside an inline creative (step 26's rule): never in the ledger, cut out of Meta's answer.
    secret: (params) => adCodesIn(params.get('creative'), true),
    text: AD_TEXT, maxBody: META_CREATIVE_MAX_BODY, edgeCall: true, budget: false, check: true,
    values: (params) => adValues(params, true),
    ids: (params) => adIds(params, true),
    assets: adAssets,
  },
  {
    // M6-04, M6-05 (master AD-031, AD-038, AD-042, AD-043, AD-044, CR-436): what set-meta-ad changes on the ad itself.
    name: 'ad.update', method: 'POST', path: /^\d{1,20}$/, kinds: AD,
    required: [], optional: [...META_AD_UPDATE_KEYS], anyOf: [...META_AD_UPDATE_KEYS],
    text: { name: META_MEDIA_TEXT_PATTERN, adlabels: META_MEDIA_TEXT_PATTERN }, maxBody: META_AD_UPDATE_MAX_BODY, budget: false,
    values: (params) => adValues(params, false),
    ids: (params) => adIds(params, false),
  },
  {
    // Master AD-043: labels added to an ad (a name alone makes the label in the chosen account).
    name: 'ad.adlabels', method: 'POST', path: /^\d{1,20}\/adlabels$/, kinds: AD,
    required: ['adlabels'], optional: [], text: { adlabels: META_MEDIA_TEXT_PATTERN }, maxBody: META_AD_UPDATE_MAX_BODY, budget: false,
    values: (params) => labelsJudge(params.get('adlabels')!),
  },
  {
    // M6-08: create-meta-ad's undo of an ad its change made, never spent (no body). Lane C1's step 22 owns the general delete.
    name: 'ad.remove', method: 'DELETE', path: /^\d{1,20}$/, kinds: AD,
    required: [], optional: [], budget: false,
    values: () => null,
  },
]
