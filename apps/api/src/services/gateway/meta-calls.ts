/**
 * Meta on the gateway (Meta ads M1, 2026-10-20) — what a Meta call may be, judged before the token or the network.
 *
 * A READ (M1) is a GET, with no body, to `https://graph.facebook.com/<the pinned version>/…`
 * (services/meta/api-version.ts); a GET that is not one is refused with its ledger row (`META_READ_ONLY`), whatever kind
 * the caller declared, and anything but a GET goes to the write allow-list (metaWriteVerdict, below). On top of the
 * method, the URL itself:
 *   - `method` / `_method` in the query (Graph's method override: a GET that acts as a POST or DELETE) — refused;
 *   - `batch` (a batch request carries its own methods) and the root path (the batch endpoint) — refused;
 *   - `oauth/revoke` (a GET that ends a token) — refused;
 *   - `oauth/access_token` only as the system-user token renewal Meta documents (grant_type=fb_exchange_token), with no
 *     account token on it (`auth: 'none'`): it hands out a new 60-day token and the old one keeps working until its own
 *     expiry (checked 2026-10-20: developers.facebook.com/docs/marketing-api/businessmanager/systemuser/
 *     install-apps-and-generate-tokens, "Refresh Access Token" and "Access Token Rotation");
 *   - `access_token`, `appsecret_proof` and `appsecret_time` are the gateway's own: a caller that names one is refused,
 *     so no call can carry a token the gateway did not choose;
 *   - ONE canonical parse of the URL (review 2): the path as written has no percent-encoding, no empty, `.` or `..`
 *     segment; a query key is lower-case snake_case and named once;
 *   - a read never brings a token back: `fields` is split on anything but letters, digits and `_`, and a name holding
 *     `token` (`access_token`, `page_access_token`, also nested or JSON-listed) is refused; `fields` must name a field;
 *     an `accounts` field (a person's or system user's Pages: Meta answers each Page's access_token by default) only with
 *     its own `{…}` list; an `accounts` edge or a bare object node (a Page node can carry its token) only with `fields`;
 *   - and the other side (defence in depth): every `access_token` key, secret query parameter and token shape in a Meta
 *     answer is removed before it leaves the gateway (scrubMetaAnswer), except in the renewal's own answer, and the
 *     ledger counts what it removed;
 *   - query keys are an ALLOW-list (review 3): fields, limit, after, before, summary, plus input_token on debug_token and
 *     business on an app's authorized_adaccounts; anything else (metadata, debug, pretty, …) is refused by name; every
 *     `{…}` in fields names a field;
 *   - the renewal must be exactly Meta's documented call: grant_type, client_id, client_secret and
 *     set_token_expires_in_60_days, each once, nothing else; the gateway fills fb_exchange_token from the connection's
 *     stored token (a caller that names one is refused); the verdict hands its client_id back and gateway.ts sends it
 *     only when that is the connection's own app;
 *   - a caller's own headers are refused (no method override or other header travels on a Meta call).
 * Step 36: the lead-form changes of the chosen Facebook Page (meta-lead-form-rules.ts), each with the Page's own token,
 * which the gateway alone reads (`auth: 'page'`, meta-page-token.ts).
 * Writes (step 17, 2026-10-21) are judged apart, by metaWriteVerdict below: an ALLOW-list of exact (method, path shape,
 * body keys and values) that Nexus's own change tools send — today a status change of one campaign, ad set or ad, and
 * Meta's check of it (validate_only, a campaign's only). Step 18 (2026-10-21) adds the settings changes of a campaign,
 * an ad set and a budget schedule (meta-settings-rules.ts: exact keys per kind of object, every value judged, the ids
 * inside a body named for the gateway's account check). Step 19 (2026-10-21) adds the creates of a campaign and an ad set
 * on the chosen ad account's own edges, the copies of a campaign, an ad set or an ad, a background copy (an async batch of
 * copies only) and the DELETE of a campaign, ad set or ad its undo sends (meta-create-rules.ts). Step 22 (2026-10-21) adds
 * remove-meta-ads-items' deletes: that same DELETE on a person's explicit ask, and a creative's, an image's or a video's of
 * the chosen ad account, a video's caption languages and an Instant Experience part's (meta-remove-rules.ts; a DELETE's
 * parameters go as its judged form body). Every other non-GET is refused; so is every other batch (metaBatchProblem).
 * Step 23 adds create-meta-media's uploads (meta-media-rules.ts): an image's
 * bytes, a video's public link, a video of the chosen Instagram account, Meta's video-ads upload — whose middle call goes
 * to Meta's resumable upload host `rupload.facebook.com` (its own exact judge: the link as Meta's `file_url` header, the
 * token in its `Authorization: OAuth` header, no body) — a folder of the portfolio and captions; its undo sends through
 * step 22's removal rules.
 * Step 7 adds the one POST that is a read: a report run of the chosen ad account's numbers (POST /act_<id>/insights —
 * Meta makes an AdReportRun and changes nothing on the account), declared a read, every key and value judged on the
 * insights lists, and its ad account checked to be the chosen one (gateway.ts 3b).
 * Step 39 adds the brand-safety changes (meta-brand-safety-rules.ts).
 * Step 26 adds create-meta-boost's and set-meta-partnership-access's (meta-boost-rules.ts), with the writes of Meta's
 * partnership REST host (metaRestWriteVerdict, its own exact judge).
 *
 * Every call with a token carries `appsecret_proof` = HMAC-SHA256(key = the app secret, message = `<token>|<time>`) and
 * `appsecret_time` = that time in seconds, as Meta's Login Security page asks today (checked 2026-10-20:
 * developers.facebook.com/documentation/facebook-login/security, "Secure Server-side Calls with appsecret_proof": a
 * time-stamped proof is valid 5 minutes, so it is made per call). The token travels as the `access_token` parameter,
 * the form every Graph example uses; the ledger and traces keep the path only (gateway.ts `safePath`).
 */
import { createHmac } from 'node:crypto'
import { META_GRAPH_HOST, metaGraphApiVersion } from '../meta/api-version.js'
import { META_AD_FORMATS, META_ORGANIC_METRICS } from '../meta/meta-media-lists.js'
import { META_ITEM_ERROR_TYPE_SET } from '../meta/meta-catalog-lists.js'
import { META_SETTINGS_WRITE_RULES } from './meta-settings-rules.js'
import { metaCreateWriteRules } from './meta-create-rules.js'
import { META_REMOVE_WRITE_RULES } from './meta-remove-rules.js'
import { metaLabelsWriteRules } from './meta-labels-rules.js'
import { META_OPTIMIZE_WRITE_RULES } from './meta-optimize-rules.js'
import { META_IMAGE_MAX_BODY, META_MEDIA_WRITE_RULES, metaRuploadVerdict } from './meta-media-rules.js'
import { META_CREATIVE_WRITE_RULES } from './meta-creative-rules.js'
import { metaAdRuleWriteRules } from './meta-ad-rule-rules.js'
import { MEMBERS_MAX_BODY, META_AUDIENCE_WRITE_RULES } from './meta-audience-rules.js'
import { INSIGHTS_KEY_CHECKS, MAX_REPORT_RUN_BODY, REPORT_BUILDER_KEY_CHECKS, reportRunProblem } from '../meta/meta-insights-lists.js'
import { META_BRAND_SAFETY_WRITE_RULES } from './meta-brand-safety-rules.js'
import { META_VALIDATE_ONLY } from './meta-write-check.js'
import { META_LEAD_FORM_WRITE_RULES } from './meta-lead-form-rules.js'
import { META_BOOST_WRITE_RULES, metaRestWriteVerdict } from './meta-boost-rules.js'
import { META_SIGNALS_WRITE_RULES, type MetaSignalsKind } from './meta-signals-rules.js'
import { META_AD_WRITE_RULES } from './meta-ad-rules.js'
import { META_WEBHOOK_WRITE_RULES } from './meta-webhook-rules.js'

/** Query keys only the gateway sets. */
const GATEWAY_OWNED_KEYS = new Set(['access_token', 'appsecret_proof', 'appsecret_time'])
/** Graph's method override and batch: a GET that is not a read. */
const NOT_A_READ_KEYS = /^(_?method|batch)$/i

export type MetaCallGroup = 'ads' | 'insights' | 'auth'

/**
 * A Graph URL as the gateway judges it — ONE canonical parse that every rule below and the renewal check read, so what is
 * judged is what Meta reads (review 2, 2026-10-20). The path as written must be plain: no percent-encoding (`%6Fauth`,
 * `me/%61ccounts`), no empty segment (`oauth//access_token`), no `.` or `..` segment, only letters, digits and `_` per
 * segment (the version `vNN.N` apart). Null when it is not a Graph URL at all; `{ problem }` when it is one the gateway
 * will not judge.
 */
interface GraphRoute { version: string | null; segments: string[]; route: string; search: URLSearchParams }

/**
 * Step 16 (2026-10-21) — the one Graph edge Meta spells with hyphens, allowed as exactly this segment and only as the
 * edge of a numeric id (`<digits>/<edge>`, nothing after it): `GET /{business-id}/partnership-ads-advertisable-content` (checked on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/partnership-ads/content-discovery-api.md).
 */
const GRAPH_HYPHEN_EDGES: ReadonlySet<string> = new Set(['partnership-ads-advertisable-content'])
/**
 * Step 3 — and the two hyphenated ROUTES of an ad account's insights feature settings, exactly as Meta writes them
 * (marketing-api/insights/breakdowns, "Insights feature settings": act_<id>/insights/feature-settings and
 * …/feature-settings/list-features). Every other segment stays letters, digits and _.
 */
const GRAPH_HYPHEN_ROUTES = /^act_\d+\/insights\/feature-settings(\/list-features)?$/

function graphRouteOf(url: string): GraphRoute | { problem: string } | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.hostname !== META_GRAPH_HOST || parsed.username || parsed.password || parsed.hash || parsed.port) return null
  // The path as written, before the URL parser folds "." and ".." segments away.
  const raw = url.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/'
  if (raw.includes('%') || parsed.pathname.includes('%')) return { problem: 'a Meta path is never percent-encoded' }
  const pieces = raw.split('/').slice(1)
  if (pieces.some((piece) => piece === '')) return { problem: 'a Meta path has no empty segment' }
  if (pieces.some((piece) => piece === '.' || piece === '..')) return { problem: 'a Meta path has no . or .. segment' }
  // Step 16 review A2 — the path judged is the path read: a backslash is a `/` to the URL parser (so `host\x/…` would be
  // judged as one path and sent as another), and nothing else may make the parsed path differ from the written one.
  if (url.includes('\\') || raw !== parsed.pathname) return { problem: 'a Meta URL is written plainly: no backslash, and the path as written is the path read' }
  const version = /^v\d+\.\d+$/.test(pieces[0]) ? pieces[0] : null
  const segments = version ? pieces.slice(1) : pieces
  // Step 16 review A6 — the hyphenated edge only as `<digits>/<edge>`: exactly two segments, the first a numeric id.
  const hyphenEdge = (piece: string, i: number) => i === 1 && segments.length === 2 && /^\d+$/.test(segments[0]) && GRAPH_HYPHEN_EDGES.has(piece)
  // Step 3 — or one of the exact feature-settings routes.
  const hyphenRoute = GRAPH_HYPHEN_ROUTES.test(segments.join('/'))
  if (segments.some((piece, i) => !/^[A-Za-z0-9_]+$/.test(piece) && !hyphenEdge(piece, i) && !hyphenRoute)) return { problem: 'a Meta path segment is letters, digits and _ only' }
  return { version, segments, route: segments.join('/').toLowerCase(), search: parsed.searchParams }
}

/**
 * The exact query keys a caller gives the system-user token renewal (Meta's "Refresh Access Token", system-user guide).
 * The fifth, `fb_exchange_token` (the token renewed), the gateway fills itself from the connection's stored token
 * (review 3): a caller can never exchange another token.
 */
export const META_RENEWAL_KEYS = ['client_id', 'client_secret', 'grant_type', 'set_token_expires_in_60_days'] as const

/**
 * Review 3 — the query keys a read may carry: an ALLOW-list, not a block-list. Every key Meta reads that is not here
 * (`metadata`, `debug`, `method`, `pretty`, …) is refused with its name. Each later step adds only the keys its own
 * reads need, with a test (meta.vitest.test.ts).
 *   - any read: fields, limit, after, before, summary;
 *   - debug_token: input_token (the token inspected);
 *   - <app>/authorized_adaccounts: business (the business portfolio asked about; meta-connection view app);
 *   - step 2, the ad account's lists act_<id>/campaigns | adsets | ads, and a campaign's or ad set's own
 *     <id>/adsets | ads (meta-ads-live, review B5: Meta documents these, not `filtering` on act_<id>/adsets | ads):
 *     effective_status;
 *   - step 2, a portfolio's <id>/owned_ad_accounts and <id>/client_ad_accounts: search_query (AA-002; pending has none);
 *   - step 2, insights (act_<id>/insights, <object>/insights): level, time_range, time_increment, filtering (each checked
 *     by value since step 7, review A F4) — never use_unified_attribution_setting or action_report_time (Meta ignores
 *     both since 2025-06-10, facts F2 T1);
 *   - step 2, act_<id>/async_requests: status, type (master ACC-028, SDK only: a refusal from Meta answers plainly;
 *     LIVE-PROBES.md).
 *   - step 6 (meta-campaigns, meta-ad-sets, meta-ad-details, meta-labels, meta-value-rules; checked on the v26 reference
 *     and Meta's SDK, live-objects.ts): is_completed on the account's campaigns / ad sets and a campaign's ad sets;
 *     updated_since on the account's ad sets / ads and a campaign's or ad set's ads; effective_status, is_completed on
 *     <id>/copies; review_feedback_breakdown, thumbnail_width, thumbnail_height on one object; pass_evaluation on
 *     <id>/adrules_governed; time_start, time_stop on <id>/budget_schedules; statuses on <id>/asyncadrequests;
 *     is_completed on act_<id>/asyncadcreatives; bid_recommendation_type, groups on <id>/delivery_stats; breakdowns on
 *     <object>/insights; ad_label_ids, operator on act_<id>/…bylabels; product_type, status on act_<id>/value_rule_set;
 *     filtering on act_<id>/recommendations (one campaign's: the ad-recommendations page); the suggested_ads and
 *     smart_suggested_ads parameters (never a pixel, product set, app or CMS id: not this step's to check); adlocale is
 *     one of step 9's META_SEARCH_TYPES; categorization_criteria on <catalog>/categories.
 *   - step 10 (media, posts, Instagram media, previews, Instant Experiences — marketing/meta-ads/live-media.ts), each
 *     only on its own edge: act_<id>/adimages hashes, name, minwidth, minheight; act_<id>/advideos title, minlength,
 *     maxlength; act_<id>/video_ads since, until; a portfolio's <id>/images | videos | creatives creative_folder_id;
 *     act_<id>/website_creative_assets | website_creative_info link_url; <campaign>/video_groups date_range;
 *     <page>/live_videos broadcast_status; <page>/feed | published_posts | visitor_posts include_hidden, show_expired;
 *     <page>/ads_posts include_inline_create, exclude_dynamic_ads, since, until; <Instagram account>/media since, until;
 *     <page | Instagram account | Instagram media>/insights metric, period, since, until, breakdown, metric_type,
 *     timeframe and <page>_<post>/insights metric, period, since, until, breakdown (organic insights);
 *     act_<id>/generatepreviews ad_format, creative, creative_feature, dynamic_asset_label, dynamic_customization,
 *     product_item_ids and <ad | creative>/previews the same without creative; <page>/canvases is_hidden, is_published.
 *     The organic-insight keys go only on a read with no field list whose metrics are all Nexus's organic ones, the
 *     preview keys only with an ad_format of the v26 enum (services/meta/meta-media-lists.ts, `when` below).
 *   - step 12 (catalogs, items, feeds, catalog health — marketing/meta-ads/live-catalog.ts), each only on its own edge:
 *     <catalog>/assigned_users business (required by Meta); <catalog>/data_sources ingestion_source_type;
 *     <catalog | feed>/products filter (a filter Nexus builds from typed args), error_priority, error_type (only one of
 *     Meta's item error types, services/meta/meta-catalog-lists.ts); <catalog>/dpa_eligible_ad_accounts search (only an
 *     ad account id: is the chosen account eligible);
 *     <catalog>/check_batch_request_status handle, load_ids_of_invalid_requests; <catalog>/product_sets_batch handle;
 *     <catalog>/diagnostics types, severities, affected_channels, affected_entities, affected_features;
 *     <catalog>/event_stats breakdowns; <pixel | app>/da_checks checks, connection_method; <upload>/errors
 *     error_priority; <item>/override_details keys, type; <portfolio>/collaborative_ads_collaboration_requests
 *     request_role; and override_country, override_language only on one item's read (its field list names
 *     META_ITEM_OVERRIDE_FIELD, `when` below).
 *   - step 3 (the account itself, its billing, who has access — marketing/meta-ads/live-account.ts), each only on its own
 *     edge: business on act_<id>/assigned_users and <Page | IG asset | catalog | pixel>/assigned_users; business_id on
 *     act_<id>/advertisable_applications and act_<id>/connected_instagram_accounts_with_iabp; bid_amount on
 *     act_<id>/minimum_budgets; app_id, optimization_goal, event_name on act_<id>/campaign_attribution_options;
 *     insights_feature on act_<id>/insights/feature-settings (with …/list-features: GRAPH_HYPHEN_ROUTES);
 *     since and until (Unix seconds) and category BUDGET (step 5: one of Meta's categories) on act_<id>/activities; start_date, end_date, issue_start_date, issue_end_date, invoice_id, type on
 *     <portfolio>/business_invoices; only_show_pending on <portfolio>/extendedcreditapplications.
 *   - step 5 (the change history — marketing/meta-ads/live-health.ts): category (Meta's enum) and uid on act_<id>/activities
 *     and <ad set>/activities; since, until and business_id on <ad set>/activities; oid and add_children on
 *     act_<id>/activities — each with the values Nexus sends only.
 *   - step 13 (product sets, commerce, Instagram product tags — marketing/meta-ads/live-commerce.ts), each only on its own
 *     edge: <catalog>/product_sets parent_id, ancestor_id, has_children, retailer_id; <catalog>/facets facets, filter (both
 *     built by Nexus from typed args); <Instagram account>/catalog_product_search catalog_id, q; <Instagram account>/
 *     product_appeal product_id. A set's items use the products edge's keys above.
 *   - step 7 (numbers, report runs, saved reports — marketing/meta-ads/live-insights.ts), each only with a value on
 *     services/meta/meta-insights-lists.ts: on act_<id>/insights and <object>/insights breakdowns, action_breakdowns,
 *     summary_action_breakdowns, action_attribution_windows (never 7d_view / 28d_view), date_preset, time_ranges, sort,
 *     default_summary, use_account_attribution_setting, product_id_limit; on act_<id>/reporting the Report Builder's
 *     metrics, dimensions, dates, comparison_time_range, attribution_windows, filtering, sorting, summaries, offset; a
 *     portfolio's custom_pivots (permission, saved_report_id), ads_custom_pivots_preview (one ad account id, dates,
 *     group_name), measurement_reports (report_type), third_party_partner_* (status, study_type; viewability start_ds,
 *     end_ds, platform, type). Still never use_unified_attribution_setting or action_report_time.
 */
const READ_KEYS = new Set(['fields', 'limit', 'after', 'before', 'summary'])
/**
 * Step 9 review fix A1 — the exact field list of the ONE read that carries a custom audience's special-ad-category
 * parameters (live-targeting.ts, check audience-special-category): those keys go on a bare object id only with it.
 */
export const META_AUDIENCE_SAC_FIELDS = 'id,name,is_eligible_for_sac_campaigns'
/** Step 12 — a field only a catalog item has: an item's country / language view (override_*) goes only on a read naming it. */
export const META_ITEM_OVERRIDE_FIELD = 'retailer_product_group_id'
/** Step 6 — does the read's `fields` name this field at its top level (not inside a `{…}` or `(…)`)? */
function fieldNamed(query: URLSearchParams, name: string): boolean {
  const fields = query.get('fields') ?? ''
  let depth = 0
  let top = ''
  for (const c of fields) {
    if (c === '{' || c === '(') depth++
    else if (c === '}' || c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) top += c
  }
  return top.split(',').some((f) => f.trim() === name)
}
/** Step 10 — an organic insights read (Page, post, Instagram): no field list, and every metric one Nexus names. */
function organicInsightRead(query: URLSearchParams): boolean {
  const metrics = (query.get('metric') ?? '').split(',')
  return !query.has('fields') && metrics.length > 0 && metrics.every((m) => META_ORGANIC_METRICS.has(m))
}
/** Step 13 review A7 — a JSON list of 1–20 field names ([a-z0-9_]), as Nexus sends a facets read. */
function jsonFieldNames(value: string | null): boolean {
  try {
    const list: unknown = JSON.parse(value ?? '')
    return Array.isArray(list) && list.length > 0 && list.length <= 20 && list.every((f) => typeof f === 'string' && /^[a-z0-9_]{1,64}$/.test(f))
  } catch { return false }
}
/**
 * Step 12 round 4 item 7 (the same check as step 13's facets `filter`) — a JSON object (an item filter rule Nexus
 * built), never a list, a string or a number.
 */
function jsonObject(value: string | null): boolean {
  try {
    const rule: unknown = JSON.parse(value ?? '')
    return !!rule && typeof rule === 'object' && !Array.isArray(rule)
  } catch { return false }
}
/** Step 10 — a preview read: one ad_format of the v26 enum. */
const previewRead = (query: URLSearchParams): boolean => META_AD_FORMATS.has(query.get('ad_format') ?? '')

/** Step 5 — AdActivity's categories (v26 ad-campaign/activities `category`; SDK adactivity.py Category), exact case. */
export const META_ACTIVITY_CATEGORIES = ['ACCOUNT', 'AD', 'AD_KEYWORDS', 'AD_SET', 'AUDIENCE', 'BID', 'BUDGET', 'CAMPAIGN', 'DATE', 'STATUS', 'TARGETING'] as const
/** A route's own keys; `when`: they go only on a read whose query also passes this (review fix A1, step 9). */
const ROUTE_KEYS: Array<{ route: RegExp; keys: ReadonlySet<string>; when?: (query: URLSearchParams) => boolean }> = [
  { route: /^debug_token$/, keys: new Set(['input_token']) },
  { route: /^\d+\/authorized_adaccounts$/, keys: new Set(['business']) },
  { route: /^act_\d+\/(campaigns|adsets|ads)$/, keys: new Set(['effective_status']) },
  { route: /^\d+\/(adsets|ads)$/, keys: new Set(['effective_status']) },
  { route: /^\d+\/(owned|client)_ad_accounts$/, keys: new Set(['search_query']) },
  // (Step 7 review A F4: insights' level, time_range, time_increment and filtering moved to step 7's entries below — the
  // same keys on the same routes, now each checked by value.)
  { route: /^act_\d+\/async_requests$/, keys: new Set(['status', 'type']) },
  // Step 9 (meta-targeting-search / meta-targeting-check, live-targeting.ts) — each key only on its own path:
  //   - Graph's targeting search /search (not an account path; `type` only from META_SEARCH_TYPES, below);
  //   - the chosen account's targeting edges and estimates, an ad set's delivery / message estimate and plain words;
  //   - a custom audience's special-ad-category eligibility (GET /<audience id>, audiences/special-ad-category).
  {
    route: /^search$/,
    keys: new Set([
      'type', 'q', 'class', 'location_types', 'country_code', 'region_id', 'match_country_code', 'locale', 'interest_list', 'interest_fbid_list',
      'countries', 'regions', 'cities', 'zips', 'country_groups', 'latitude', 'longitude', 'distance_unit', 'targeting_option_list',
    ]),
  },
  { route: /^act_\d+\/targetingsearch$/, keys: new Set(['q', 'limit_type', 'locale', 'objective', 'regulated_categories', 'allow_only_fat_head_interests']) },
  { route: /^act_\d+\/targetingsuggestions$/, keys: new Set(['targeting_list', 'limit_type', 'locale', 'regulated_categories']) },
  { route: /^act_\d+\/targetingbrowse$/, keys: new Set(['limit_type', 'locale', 'regulated_categories']) },
  { route: /^act_\d+\/targetingvalidation$/, keys: new Set(['targeting_list', 'id_list', 'name_list', 'is_exclusion', 'locale']) },
  { route: /^act_\d+\/broadtargetingcategories$/, keys: new Set(['custom_categories_only']) },
  { route: /^act_\d+\/deprecatedtargetingadsets$/, keys: new Set(['type']) },
  { route: /^act_\d+\/reachestimate$/, keys: new Set(['targeting_spec']) },
  { route: /^(act_)?\d+\/delivery_estimate$/, keys: new Set(['optimization_goal', 'targeting_spec', 'promoted_object']) },
  // Review fix B1 — both marketing-message estimates also take a daily budget and a direct send (SDK adaccount.py and
  // adset.py get_message_delivery_estimate).
  { route: /^(act_)?\d+\/message_delivery_estimate$/, keys: new Set(['targeting_spec', 'promoted_object', 'optimization_goal', 'bid_amount', 'lifetime_budget', 'lifetime_in_days', 'pacing_type', 'daily_budget', 'is_direct_send_campaign']) },
  { route: /^act_\d+\/targetingsentencelines$/, keys: new Set(['targeting_spec', 'hide_targeting_spec_from_return']) },
  // Review fix A1 — only on the audience-eligibility read itself (its exact field list), never on another object read.
  { route: /^\d+$/, keys: new Set(['ad_account_id', 'special_ad_categories', 'special_ad_category_countries']), when: (query) => query.get('fields') === META_AUDIENCE_SAC_FIELDS },
  // Step 6 — the detailed reads of campaigns, ad sets, ads, creatives, labels and value rules.
  { route: /^act_\d+\/(campaigns|adsets)$|^\d+\/adsets$/, keys: new Set(['is_completed']) },
  { route: /^act_\d+\/(adsets|ads)$|^\d+\/ads$/, keys: new Set(['updated_since']) },
  { route: /^\d+\/copies$/, keys: new Set(['effective_status', 'is_completed']) },
  // Only on the read that asks the field they shape (an ad's review feedback; a creative's thumbnail).
  { route: /^\d+$/, keys: new Set(['review_feedback_breakdown']), when: (query) => fieldNamed(query, 'ad_review_feedback') },
  { route: /^\d+$/, keys: new Set(['thumbnail_width', 'thumbnail_height']), when: (query) => fieldNamed(query, 'thumbnail_url') },
  { route: /^\d+\/adrules_governed$/, keys: new Set(['pass_evaluation']) },
  { route: /^\d+\/budget_schedules$/, keys: new Set(['time_start', 'time_stop']) },
  { route: /^\d+\/asyncadrequests$/, keys: new Set(['statuses']) },
  { route: /^act_\d+\/asyncadcreatives$/, keys: new Set(['is_completed']) },
  { route: /^\d+\/delivery_stats$/, keys: new Set(['bid_recommendation_type', 'groups']) },
  // (Step 7: `breakdowns` on <object>/insights moved to step 7's entries below — the same key, now value-checked on both
  // insights routes; step 6's asset breakdowns are on that list.)
  { route: /^act_\d+\/(campaigns|adsets|ads|adcreatives)bylabels$/, keys: new Set(['ad_label_ids', 'operator']) },
  { route: /^act_\d+\/value_rule_set$/, keys: new Set(['product_type', 'status']) },
  { route: /^act_\d+\/recommendations$/, keys: new Set(['filtering']) },
  { route: /^act_\d+\/suggested_ads$/, keys: new Set(['use_case', 'objective', 'optimization_goal', 'optimization_event', 'countries', 'rank_by', 'promoted_object_page_id']) },
  { route: /^act_\d+\/smart_suggested_ads$/, keys: new Set(['objective', 'optimization_goal', 'custom_event_type', 'destination_type']) },
  { route: /^\d+\/categories$/, keys: new Set(['categorization_criteria']) },
  // Review fix A6 — the Page ad limits per Page (problems view).
  { route: /^act_\d+\/ads_volume$/, keys: new Set(['show_breakdown_by_actor']) },
  // Step 10 — media, posts, Instagram media, previews, Instant Experiences (marketing/meta-ads/live-media.ts).
  { route: /^act_\d+\/adimages$/, keys: new Set(['hashes', 'name', 'minwidth', 'minheight']) },
  { route: /^act_\d+\/advideos$/, keys: new Set(['title', 'minlength', 'maxlength']) },
  { route: /^act_\d+\/video_ads$/, keys: new Set(['since', 'until']) },
  { route: /^\d+\/(images|videos|creatives)$/, keys: new Set(['creative_folder_id']) },
  { route: /^act_\d+\/(website_creative_assets|website_creative_info)$/, keys: new Set(['link_url']) },
  { route: /^\d+\/video_groups$/, keys: new Set(['date_range']) },
  { route: /^\d+\/live_videos$/, keys: new Set(['broadcast_status']) },
  { route: /^\d+\/(feed|published_posts|visitor_posts)$/, keys: new Set(['include_hidden', 'show_expired']) },
  { route: /^\d+\/ads_posts$/, keys: new Set(['include_inline_create', 'exclude_dynamic_ads', 'since', 'until']) },
  { route: /^\d+\/media$/, keys: new Set(['since', 'until']) },
  // Round 2 (c) — the organic-insight keys only on an organic read: no field list (an ads insights read always names its
  // fields) and every metric one of Nexus's organic lists (services/meta/meta-media-lists.ts); the preview keys only with
  // an ad_format of the v26 enum.
  { route: /^\d+\/insights$/, keys: new Set(['metric', 'period', 'since', 'until', 'breakdown', 'metric_type', 'timeframe']), when: organicInsightRead },
  { route: /^\d+_\d+\/insights$/, keys: new Set(['metric', 'period', 'since', 'until', 'breakdown']), when: organicInsightRead },
  { route: /^act_\d+\/generatepreviews$/, keys: new Set(['ad_format', 'creative', 'creative_feature', 'dynamic_asset_label', 'dynamic_customization', 'product_item_ids']), when: previewRead },
  { route: /^\d+\/previews$/, keys: new Set(['ad_format', 'creative_feature', 'dynamic_asset_label', 'dynamic_customization', 'product_item_ids']), when: previewRead },
  { route: /^\d+\/canvases$/, keys: new Set(['is_hidden', 'is_published']) },
  // Step 16 — partnership content, research, brand safety (marketing/meta-ads/live-partners.ts, live-safety.ts), each
  // only on its own route, with exactly the parameters Meta documents there (the pages are named in those files).
  { route: /^\d+\/partnership-ads-advertisable-content$/, keys: new Set(['fb_page_id', 'ig_user_id', 'ad_partner_ig_user_ids', 'ad_partner_page_ids', 'platform_types', 'media_types', 'post_types', 'content_types', 'ad_eligibilities', 'ad_usages', 'country_codes', 'start_date', 'end_date', 'search_key', 'sort_by', 'is_recommended', 'content_ids', 'permalinks', 'ad_codes']) },
  { route: /^\d+\/branded_content_ad_permissions$/, keys: new Set(['creator_username']) },
  { route: /^\d+\/branded_content_tag_approval$/, keys: new Set(['user_ids']) },
  { route: /^\d+\/creator_marketplace_creators$/, keys: new Set(['creator_countries', 'creator_states', 'creator_min_followers', 'creator_max_followers', 'creator_interests', 'creator_min_engaged_accounts', 'creator_max_engaged_accounts', 'major_audience_age_bucket', 'major_audience_gender', 'major_audience_countries', 'major_audience_states', 'major_audience_device_type', 'query', 'similar_to_creators', 'recommendation_type', 'username', 'custom_audience_id', 'platform', 'page_name', 'creator_language', 'creator_latest_post_activity', 'creator_follower_growth', 'verified_account', 'featured_in_paid_ads', 'has_portfolio', 'exclude_messaged_creators']) },
  { route: /^ads_archive$/, keys: new Set(['ad_reached_countries', 'search_terms', 'search_type', 'search_page_ids', 'ad_active_status', 'ad_delivery_date_min', 'ad_delivery_date_max', 'ad_type', 'languages', 'media_type', 'publisher_platforms']) },
  { route: /^ig_hashtag_search$/, keys: new Set(['user_id', 'q']) },
  { route: /^\d+\/(top_media|recent_media)$/, keys: new Set(['user_id']) },
  { route: /^\d+\/assigned_users$/, keys: new Set(['business_id']) },
  { route: /^\d+\/publisher_delivery_report$/, keys: new Set(['platform', 'position', 'sort_by', 'name_contains', 'publisher_status', 'start_date', 'end_date']) },
  { route: /^\d+\/(content_delivery_report|adjacent_content_delivery_report)$/, keys: new Set(['platform', 'position', 'datetime']) },
  { route: /^(publisher_delivery_report_date_ranges|content_delivery_report_date_ranges|adjacent_content_delivery_report_date_ranges)$/, keys: new Set(['platform', 'position']) },
  { route: /^brand_safety_publisher_list$/, keys: new Set(['platform', 'position', 'sort_by', 'search_query', 'start_date', 'end_date', 'blue_verified', 'follower_count', 'app_store_category_contains', 'include_summary']) },
  // Step 8 (meta-recommendations / meta-experiments / meta-ad-rules, live-optimize.ts) — each key only on its own path:
  // the account's recommendations (stages, names) and the portfolio's, asked about the chosen account only
  // (ad_account_ids; stages, names, locale — never scopes); the opportunity-score history window; a study objective's
  // result breakdowns and day (GET /<objective id>); a rule's and the account's rule history filters; a Page's video
  // tests window.
  { route: /^act_\d+\/recommendations$/, keys: new Set(['recommendation_stages', 'recommendation_names']) },
  { route: /^\d+\/recommendations$/, keys: new Set(['ad_account_ids', 'recommendation_stages', 'recommendation_names', 'locale']) },
  { route: /^act_\d+\/opportunity_score_history$/, keys: new Set(['from_date', 'to_date', 'get_reason']) },
  // Review fix A2 — only on the read that asks a study objective's `results` (never on another bare-id read).
  { route: /^\d+$/, keys: new Set(['breakdowns', 'ds']), when: (query) => fieldNamed(query, 'results') },
  { route: /^\d+\/history$/, keys: new Set(['object_id', 'action', 'hide_no_changes']) },
  { route: /^act_\d+\/adrules_history$/, keys: new Set(['object_id', 'action', 'hide_no_changes']) },
  { route: /^\d+\/ab_tests$/, keys: new Set(['since', 'until']) },
  // Step 14 — leads, lead forms and comments (marketing/meta-ads/live-engagement.ts), each only on its own edge: a form's or
  // an ad's leads take Meta's time filter in exactly its documented shape (leadTimeFiltering); a Facebook post's or
  // comment's comments take filter, order, since (SDK pagepost.py / comment.py get_comments); an Instagram account's tags
  // take posted_after, posted_before, media_type (ig-user/tags). Leads, comments and forms stay out of `fields`
  // (FIELD_DENIED): they are read only through these edges. Review fix A2 — each key only with a value Nexus sends.
  { route: /^\d+\/leads$/, keys: new Set(['filtering']), when: leadTimeFiltering },
  { route: /^\d+_\d+\/comments$/, keys: new Set(['filter']), when: valueIn('filter', ['toplevel', 'stream']) },
  { route: /^\d+_\d+\/comments$/, keys: new Set(['order']), when: valueIn('order', ['chronological', 'reverse_chronological']) },
  { route: /^\d+_\d+\/comments$/, keys: new Set(['since']), when: (query) => /^\d{1,12}$/.test(query.get('since') ?? '') },
  { route: /^\d+\/tags$/, keys: new Set(['posted_after']), when: (query) => isoDateTime(query.get('posted_after')) },
  { route: /^\d+\/tags$/, keys: new Set(['posted_before']), when: (query) => isoDateTime(query.get('posted_before')) },
  { route: /^\d+\/tags$/, keys: new Set(['media_type']), when: (query) => subsetOf(query.get('media_type'), ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']) },
  // Step 12 — catalogs, items, feeds, catalog health (marketing/meta-ads/live-catalog.ts), each key on its own edge.
  { route: /^\d+\/assigned_users$/, keys: new Set(['business']) },
  { route: /^\d+\/data_sources$/, keys: new Set(['ingestion_source_type']) },
  { route: /^\d+\/products$/, keys: new Set(['error_priority']) },
  // Round 4 item 7 — filter only in the shape Nexus sends (itemFilter, REJECTED): a JSON object.
  { route: /^\d+\/products$/, keys: new Set(['filter']), when: (query) => jsonObject(query.get('filter')) },
  // Fix B5 — error_type only with one of Meta's item error types; search on the eligible ad accounts only as one account id.
  { route: /^\d+\/products$/, keys: new Set(['error_type']), when: (query) => META_ITEM_ERROR_TYPE_SET.has(query.get('error_type') ?? '') },
  { route: /^\d+\/dpa_eligible_ad_accounts$/, keys: new Set(['search']), when: (query) => /^\d{1,25}$/.test(query.get('search') ?? '') },
  { route: /^\d+\/check_batch_request_status$/, keys: new Set(['handle', 'load_ids_of_invalid_requests']) },
  { route: /^\d+\/product_sets_batch$/, keys: new Set(['handle']) },
  { route: /^\d+\/diagnostics$/, keys: new Set(['types', 'severities', 'affected_channels', 'affected_entities', 'affected_features']) },
  { route: /^\d+\/event_stats$/, keys: new Set(['breakdowns']) },
  { route: /^\d+\/da_checks$/, keys: new Set(['checks', 'connection_method']) },
  { route: /^\d+\/errors$/, keys: new Set(['error_priority']) },
  { route: /^\d+\/override_details$/, keys: new Set(['keys', 'type']) },
  { route: /^\d+\/collaborative_ads_collaboration_requests$/, keys: new Set(['request_role']) },
  { route: /^\d+$/, keys: new Set(['override_country', 'override_language']), when: (query) => fieldNamed(query, META_ITEM_OVERRIDE_FIELD) },
  // Step 3 (meta-ad-account, meta-billing, meta-account-access — marketing/meta-ads/live-account.ts), each key only on its
  // own edge: the business on assigned users (the ad account's, and a Page's, Instagram asset's, catalog's or pixel's —
  // Meta requires it); the portfolio on an account's advertisable apps and Instagram accounts with IABP; a manual bid on
  // minimum budgets; an app's event and goal on attribution options; a feature on the insights feature settings; the days
  // of the activity log; an invoice query; pending credit applications.
  { route: /^act_\d+\/assigned_users$|^\d+\/assigned_users$/, keys: new Set(['business']) },
  { route: /^act_\d+\/(advertisable_applications|connected_instagram_accounts_with_iabp)$/, keys: new Set(['business_id']) },
  { route: /^act_\d+\/minimum_budgets$/, keys: new Set(['bid_amount']) },
  { route: /^act_\d+\/campaign_attribution_options$/, keys: new Set(['app_id', 'optimization_goal', 'event_name']) },
  { route: /^act_\d+\/insights\/feature-settings$/, keys: new Set(['insights_feature']) },
  // Step 3 review round 4 (step 5 review A4) — the days only as Unix seconds, as Nexus sends them.
  { route: /^act_\d+\/activities$/, keys: new Set(['since']), when: (query) => /^\d{1,12}$/.test(query.get('since') ?? '') },
  { route: /^act_\d+\/activities$/, keys: new Set(['until']), when: (query) => /^\d{1,12}$/.test(query.get('until') ?? '') },
  // Review B4, round 4 — the billing events' category BUDGET (reference/ad-activity files every billing event there): step 5's
  // entry below allows it among Meta's own categories (the change history filters by each of them).
  { route: /^\d+\/business_invoices$/, keys: new Set(['start_date', 'end_date', 'issue_start_date', 'issue_end_date', 'invoice_id', 'type']) },
  { route: /^\d+\/extendedcreditapplications$/, keys: new Set(['only_show_pending']) },
  // Step 5 (meta-activity-log — marketing/meta-ads/live-health.ts) — the change history, each key only with a value Nexus
  // sends: Meta's category (the v26 enum of the ad set's own edge, exact case) and the actor filter uid on the account's
  // log and an ad set's own (/{adset}/activities documents since, until, uid and business_id); the object filter oid and
  // add_children on the account's log (SDK adaccount.py get_activities only: LIVE-PROBES LG-001, LG-001b).
  { route: /^(act_)?\d+\/activities$/, keys: new Set(['category']), when: valueIn('category', META_ACTIVITY_CATEGORIES) },
  { route: /^(act_)?\d+\/activities$/, keys: new Set(['uid']), when: digitsIn('uid') },
  { route: /^\d+\/activities$/, keys: new Set(['since', 'until']), when: (query) => ['since', 'until'].every((key) => !query.has(key) || /^\d{1,12}$/.test(query.get(key) ?? '')) },
  { route: /^\d+\/activities$/, keys: new Set(['business_id']), when: digitsIn('business_id') },
  { route: /^act_\d+\/activities$/, keys: new Set(['oid']), when: digitsIn('oid') },
  { route: /^act_\d+\/activities$/, keys: new Set(['add_children']), when: valueIn('add_children', ['true', 'false']) },
  // Step 11 (meta-audiences / meta-datasets, live-audiences.ts and live-datasets.ts) — each key only on its own path:
  //   - audiences: the account's list (filtering for expiring ones, pixel_id), one audience as the chosen account sees it
  //     (ad_account_id, acting_account_id), its upload sessions, value data, recipients; the portfolio's sharing;
  //   - datasets: the portfolio's pixel search, a pixel's ad accounts / people (business), audiences and custom
  //     conversions of the chosen account (ad_account), stats (also a custom conversion's), Meta's Dataset Quality API
  //     (dataset_id, agent_name), the diagnostics edges and legacy offline uploads.
  { route: /^act_\d+\/customaudiences$/, keys: new Set(['filtering', 'pixel_id']) },
  // Only on the read of a shared-in audience as the chosen account sees it (the one read that asks its labels).
  { route: /^\d+$/, keys: new Set(['ad_account_id', 'acting_account_id']), when: (query) => fieldNamed(query, 'audience_labels') },
  { route: /^\d+\/sessions$/, keys: new Set(['session_id']) },
  { route: /^\d+\/health$/, keys: new Set(['calculated_date', 'processed_date']) },
  { route: /^\d+\/adaccounts$/, keys: new Set(['permissions']) },
  { route: /^\d+\/initiated_audience_sharing_requests$/, keys: new Set(['recipient_id', 'request_status']) },
  { route: /^\d+\/received_audience_sharing_requests$/, keys: new Set(['initiator_id', 'request_status']) },
  { route: /^\d+\/(shared|received)_audience_permissions$/, keys: new Set(['partner_id']) },
  { route: /^\d+\/adspixels$/, keys: new Set(['name_filter']) },
  { route: /^\d+\/(shared_accounts|assigned_users)$/, keys: new Set(['business']) },
  { route: /^\d+\/(audiences|customconversions)$/, keys: new Set(['ad_account']) },
  { route: /^\d+\/customconversions$/, keys: new Set(['include_archived']) },
  { route: /^\d+\/stats$/, keys: new Set(['aggregation', 'event', 'event_source', 'agent', 'start_time', 'end_time']) },
  { route: /^dataset_quality$/, keys: new Set(['dataset_id', 'agent_name']) },
  { route: /^\d+\/(setup_quality|integration_quality)$/, keys: new Set(['agent_name']) },
  { route: /^\d+\/ads_signal_diagnostic_issues$/, keys: new Set(['ad_account_id']) },
  { route: /^\d+\/(event_last_fired_time|recent_events|raw_fires)$/, keys: new Set(['event']) },
  { route: /^\d+\/domain_last_fired_time$/, keys: new Set(['domain_name_list']) },
  { route: /^\d+\/recent_events$/, keys: new Set(['lookback_window']) },
  { route: /^\d+\/real_time_event_log$/, keys: new Set(['start_time', 'end_time']) },
  { route: /^\d+\/raw_fires$/, keys: new Set(['filter_type', 'filter']) },
  { route: /^\d+\/cpas_events_debugging_info$/, keys: new Set(['action_source']) },
  { route: /^\d+\/extractors$/, keys: new Set(['current_domain']) },
  { route: /^\d+\/offline_event_uploads$/, keys: new Set(['start_time', 'end_time', 'sort_by', 'order', 'upload_tag']) },
  // Step 28 — who has a role on the chosen ad account (a study is shared only with them: meta-optimize-owner.ts); Meta's
  // ad-account/assigned_users requires the business it is asked in.
  { route: /^act_\d+\/assigned_users$/, keys: new Set(['business']) },
  // Step 13 — product sets, facets, Instagram product search and appeals (marketing/meta-ads/live-commerce.ts), each key on
  // its own edge (a set's items take the products edge's filter, error_priority, error_type above).
  { route: /^\d+\/product_sets$/, keys: new Set(['parent_id', 'ancestor_id', 'has_children', 'retailer_id']) },
  // Review A7 — and only in the shape Nexus sends: facets a JSON list of field names, filter a JSON object, ids digits.
  { route: /^\d+\/facets$/, keys: new Set(['facets']), when: (query) => jsonFieldNames(query.get('facets')) },
  { route: /^\d+\/facets$/, keys: new Set(['filter']), when: (query) => jsonObject(query.get('filter')) },
  { route: /^\d+\/catalog_product_search$/, keys: new Set(['catalog_id']), when: (query) => /^\d{1,25}$/.test(query.get('catalog_id') ?? '') },
  { route: /^\d+\/catalog_product_search$/, keys: new Set(['q']) },
  { route: /^\d+\/product_appeal$/, keys: new Set(['product_id']), when: (query) => /^\d{1,25}$/.test(query.get('product_id') ?? '') },
  // Step 7 — numbers, report runs and saved reports (marketing/meta-ads/live-insights.ts), each key only on its own route
  // and only with a value on services/meta/meta-insights-lists.ts (step 2's level, time_range, time_increment and filtering
  // too, for every reader of insights: meta-ads-live, the daily read, meta-ads-graph-read): the insights keys on act_<id>/insights and
  // <object>/insights (a report run's results, GET /<run>/insights, take none of them); the Report Builder's on
  // act_<id>/reporting; the portfolio's custom pivots, pivot preview, measurement reports and partner studies, each its own.
  ...Object.entries(INSIGHTS_KEY_CHECKS).map(([key, check]) => ({ route: /^(act_)?\d+\/insights$/, keys: new Set([key]), when: (query: URLSearchParams) => check(query.get(key)) })),
  ...Object.entries(REPORT_BUILDER_KEY_CHECKS).map(([key, check]) => ({ route: /^act_\d+\/reporting$/, keys: new Set([key]), when: (query: URLSearchParams) => check(query.get(key)) })),
  { route: /^\d+\/custom_pivots$/, keys: new Set(['permission']), when: valueIn('permission', ['private', 'shared']) },
  { route: /^\d+\/custom_pivots$/, keys: new Set(['saved_report_id']), when: (query) => /^\d{1,25}$/.test(query.get('saved_report_id') ?? '') },
  { route: /^\d+\/ads_custom_pivots_preview$/, keys: new Set(['ad_account_ids']), when: (query) => /^\["?\d{1,25}"?\]$/.test(query.get('ad_account_ids') ?? '') },
  { route: /^\d+\/ads_custom_pivots_preview$/, keys: new Set(['date_preset', 'time_range']), when: (query) => (!query.has('date_preset') || REPORT_BUILDER_KEY_CHECKS.date_preset(query.get('date_preset'))) && (!query.has('time_range') || REPORT_BUILDER_KEY_CHECKS.time_range(query.get('time_range'))) },
  { route: /^\d+\/ads_custom_pivots_preview$/, keys: new Set(['group_name']), when: (query) => /^[^\u0000-\u001f"\\]{1,100}$/.test(query.get('group_name') ?? '') },
  { route: /^\d+\/measurement_reports$/, keys: new Set(['report_type']), when: valueIn('report_type', ['third_party_mta_report', 'partner_lift_study_report', 'mmm_report_v2']) },
  { route: /^\d+\/third_party_partner_panel_requests$/, keys: new Set(['status']), when: (query) => jsonSubset(query.get('status'), ['CREATED', 'FAILURE', 'IN_PROGRESS', 'SCHEDULED', 'SUCCESS']) },
  { route: /^\d+\/third_party_partner_panel_recurring_requests$/, keys: new Set(['status']), when: (query) => jsonSubset(query.get('status'), ['CANCELLED', 'CREATED', 'FINISHED', 'ONGOING']) },
  { route: /^\d+\/(third_party_partner_panel_requests|third_party_partner_panel_recurring_requests)$/, keys: new Set(['study_type']), when: (query) => jsonSubset(query.get('study_type'), ['BRAND_LIFT', 'PANEL_SALES_ATTRIBUTION', 'REACH']) },
  { route: /^\d+\/third_party_partner_viewability_requests$/, keys: new Set(['start_ds', 'end_ds']), when: (query) => /^\d{4}-\d{2}-\d{2}$/.test(query.get('start_ds') ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(query.get('end_ds') ?? '') },
  { route: /^\d+\/third_party_partner_viewability_requests$/, keys: new Set(['platform']), when: valueIn('platform', ['AUDIENCE_NETWORK', 'FACEBOOK', 'INSTAGRAM']) },
  { route: /^\d+\/third_party_partner_viewability_requests$/, keys: new Set(['type']), when: valueIn('type', ['DISPLAY_EVENT', 'IMPRESSION', 'VIDEO_EVENT']) },
]
/** Step 5 — the key's value is a Meta id (digits). */
function digitsIn(key: string): (query: URLSearchParams) => boolean {
  return (query) => /^\d{1,25}$/.test(query.get(key) ?? '')
}
/** Step 7 — a JSON list of these values, each once, at least one (Meta's own array form, `["CREATED","SUCCESS"]`). */
function jsonSubset(raw: string | null, allowed: readonly string[]): boolean {
  let list: unknown
  try { list = JSON.parse(raw ?? '') } catch { return false }
  return Array.isArray(list) && list.length > 0 && list.every((v) => typeof v === 'string' && allowed.includes(v)) && new Set(list).size === list.length
}
/** Step 14 review A2 — the key's value is one of these. */
function valueIn(key: string, values: readonly string[]): (query: URLSearchParams) => boolean {
  return (query) => values.includes(query.get(key) ?? '')
}
/** Step 14 review A2 — an ISO date-time as Nexus sends it (`2026-10-21T00:00:00`, a real day and time). */
function isoDateTime(value: string | null): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value ?? '')
  if (!m) return false
  const d = new Date(`${value}Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === value
}
/** Step 14 review A2 — a comma list of these values, each once, at least one. */
function subsetOf(value: string | null, allowed: readonly string[]): boolean {
  const list = (value ?? '').split(',')
  return list.length > 0 && list.every((v) => allowed.includes(v)) && new Set(list).size === list.length
}
/**
 * Step 14 — a leads read's `filtering` is Meta's documented time filter and nothing else (lead-ads/retrieving.md,
 * "Filtering Leads"): one or two `{ field: "time_created", operator: LESS_THAN | GREATER_THAN | GREATER_THAN_OR_EQUAL,
 * value: <unix seconds> }`, no other key.
 */
function leadTimeFiltering(query: URLSearchParams): boolean {
  const raw = query.get('filtering')
  if (raw === null) return true
  let list: unknown
  try { list = JSON.parse(raw) } catch { return false }
  return Array.isArray(list) && list.length >= 1 && list.length <= 2 && list.every((f) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false
    const entry = f as Record<string, unknown>
    return Object.keys(entry).sort().join(',') === 'field,operator,value' && entry.field === 'time_created'
      && ['LESS_THAN', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL'].includes(entry.operator as string)
      && typeof entry.value === 'number' && Number.isInteger(entry.value) && entry.value >= 0
  })
}
/**
 * Step 9 — the `type` values a /search read may carry: targeting options only (targeting-search reference), never
 * people, Pages or places. live-targeting.ts SEARCH_TYPE_OF sends exactly these.
 */
export const META_SEARCH_TYPES: ReadonlySet<string> = new Set([
  'adgeolocation', 'adgeolocationmeta', 'adradiussuggestion', 'adinterest', 'adinterestsuggestion', 'adinterestvalid', 'adTargetingCategory',
  'adeducationschool', 'adeducationmajor', 'adworkemployer', 'adworkposition', 'adlocale', 'targetingoptionstatus',
])
/**
 * May a read of this route (the canonical one: lower case, no version), with this query, carry this key? Gateway only:
 * meta-ads-graph-read keeps its own, narrower list (graph-allow.ts GRAPH_EDGE_PARAMS, step 9 review fix A1).
 */
function keyAllowed(route: string, key: string, query: URLSearchParams): boolean {
  return READ_KEYS.has(key) || ROUTE_KEYS.some((r) => r.route.test(route) && r.keys.has(key) && (!r.when || r.when(query)))
}
/**
 * Step 19 (2026-10-21) — fields a Nexus read asks on ONE kind of node only: the ad account's WhatsApp marketing-messages
 * onboarding (`act_<id>?fields=marketing_messages_settings{whatsapp_activation_status}`, marketing-api/marketing-messages.md
 * "Check whether an ad account is onboarded"; create-meta-ad-set names Meta's silent WhatsApp placement with it).
 */
const NODE_FIELDS: ReadonlyArray<{ field: string; route: RegExp; where: string }> = [
  { field: 'marketing_messages_settings', route: /^act_\d+$/, where: 'the ad account itself (act_<id>)' },
]
/** Step 7 re-review 2 — is the key one Nexus sends on this route at all (its value aside)? Only for the refusal's words. */
function keyKnownHere(route: string, key: string): boolean {
  return READ_KEYS.has(key) || ROUTE_KEYS.some((r) => r.route.test(route) && r.keys.has(key))
}
/** At most this long, a `fields` value (the longest Nexus asks is far shorter). */
const MAX_FIELDS_LENGTH = 4000
/** A field name that is (or holds) a token: `access_token`, `page_access_token`, … — never asked for. */
const TOKEN_NAME = /token/i
/** `accounts` as a field (a person's or system user's Pages; Meta answers each Page's token by default). */
const ACCOUNTS_FIELD = /(?<![A-Za-z0-9_])accounts(?![A-Za-z0-9_])/gi
/** Field modifiers that may sit between a field and its own `{…}` list: `.limit(100)`, `.summary(true)`. */
const MODIFIERS = /^(?:\s*\.\s*[A-Za-z_]+\s*\([^(){}]*\))*\s*/

/**
 * Step 2 review A1 (defence in depth under meta-ads-graph-read's own guard): names no Nexus read asks inside `fields` —
 * other businesses' ad accounts and Pages, people, buyers' messages and lead-form answers. Nexus reads its own lists
 * through their edge (the path), never by expanding them into another object.
 */
const FIELD_DENIED = new Set([
  'owned_ad_accounts', 'client_ad_accounts', 'pending_owned_ad_accounts', 'pending_client_ad_accounts', 'owned_pages', 'client_pages',
  'users', 'assigned_users', 'system_users', 'business_users', 'agencies', 'leadgen_forms', 'leads', 'conversations', 'messages', 'comments',
  // Step 14 review A3 — people's lists Nexus reads only through their own edge (live-engagement.ts), never inside fields.
  'test_leads', 'ordered_comments', 'sharedposts', 'replies', 'blocked', 'ratings', 'likes', 'tags',
])

/**
 * Step 14 review A3 — `reactions` inside fields only as a COUNT: `reactions[.type(X)].limit(0).summary(total_count)`, so
 * no person who reacted is ever listed (Meta's own example on object/reactions).
 */
const REACTIONS_FIELD = /(?<![A-Za-z0-9_])reactions(?![A-Za-z0-9_])/gi
// Re-review 2 — the count ends the field: the next character is the end, a comma or a closing } or ) (never a space).
const REACTIONS_COUNT_ONLY = /^(?:\.type\([A-Z]{2,12}\))?\.limit\(0\)\.summary\(total_count\)(?=$|[,})])/

/** Review 2 — never inside an expansion (`{…}` or `.fields(…)`): another object's Instagram account, owner, ratings, feed. */
const NESTED_DENIED = new Set(['instagram_business_account', 'owner_business', 'ratings', 'feed', 'blocked'])

/** A real field name: a letter first. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Review 3 — does every `{…}` list, at any depth, name at least one field of its own (and are the braces balanced)?
 * Modifier arguments (`.limit(5)`) and modifier names (the word after a `.`) are not fields.
 */
function bracesProblem(value: string): string | null {
  // Each open list: how many field names it holds so far. A "(" is either a `.fields(` list (review 2: exactly like
  // `{…}`) or a modifier's argument (skipped, but balanced).
  const lists: number[] = []
  const parens: Array<'list' | 'argument'> = []
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    const inArgument = parens.length > 0 && parens[parens.length - 1] === 'argument'
    if (c === '(') {
      const isFields = !inArgument && /\.\s*fields\s*$/.test(value.slice(0, i))
      parens.push(isFields ? 'list' : 'argument')
      if (isFields) lists.push(0)
      continue
    }
    if (c === ')') {
      const kind = parens.pop()
      if (kind === undefined) return 'fields has a ) with no ('
      if (kind === 'list') {
        const named = lists.pop()
        if (!named) return 'every .fields(…) in fields names a field'
      }
      continue
    }
    if (inArgument) continue
    if (c === '{') { lists.push(0); continue }
    if (c === '}') {
      const named = lists.pop()
      if (named === undefined) return 'fields has a } with no {'
      if (named === 0) return 'every {…} in fields names a field'
      continue
    }
    const startsName = /[A-Za-z]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]))
    if (!startsName || /\.\s*$/.test(value.slice(0, i))) continue
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(value.slice(i))![0]
    if (lists.length > 0) {
      lists[lists.length - 1]++
      // Review 2 — inside any expansion, never another object's Instagram account, owner, ratings, feed or blocked list.
      if (NESTED_DENIED.has(name.toLowerCase())) return `a read never expands "${name}" inside another field`
    }
    i += name.length - 1
  }
  if (parens.length > 0) return 'fields has a ( with no )'
  return lists.length > 0 ? 'fields has a { with no }' : null
}

/** Why a `fields` value is refused, or null. Names are what is left when the value is split on anything but A–Z, 0–9, _. */
function fieldsProblem(value: string): string | null {
  if (value.length > MAX_FIELDS_LENGTH) return `fields is at most ${MAX_FIELDS_LENGTH} characters`
  if (value.includes('%')) return 'fields is never percent-encoded twice'
  // A field list is plain ASCII: no look-alike letter (а for a), no tab or other control character.
  if (!/^[\x20-\x7e]*$/.test(value)) return 'fields is plain ASCII letters, digits and punctuation'
  const names = value.split(/[^A-Za-z0-9_]+/).filter(Boolean)
  if (names.some((name) => TOKEN_NAME.test(name))) return 'a read never asks Meta for a token'
  // Step 14 review A3 — ratings and blocked are denied anywhere now; inside an expansion they keep step 2's own sentence.
  const braces = bracesProblem(value)
  if (braces && braces.endsWith('inside another field')) return braces
  const denied = names.find((name) => FIELD_DENIED.has(name.toLowerCase()))
  if (denied) return `a read never expands "${denied}" inside fields (another business's assets, people or messages)`
  if (!names.some((name) => FIELD_NAME.test(name))) return 'fields names no field'
  if (braces) return braces
  for (const match of value.matchAll(REACTIONS_FIELD)) {
    if (!REACTIONS_COUNT_ONLY.test(value.slice((match.index ?? 0) + match[0].length))) return 'reactions inside fields only as a count: reactions[.type(X)].limit(0).summary(total_count)'
  }
  for (const match of value.matchAll(ACCOUNTS_FIELD)) {
    const after = value.slice((match.index ?? 0) + match[0].length).replace(MODIFIERS, '')
    if (!after.startsWith('{')) return 'an accounts field names its own fields ({…}): Meta answers each Page\'s token by default'
  }
  return null
}

/**
 * The gateway's verdict on a Meta call: why it is refused (null: it may go), and the renewal's client_id when it is one.
 * `rest`: a read of Meta's REST host (api.facebook.com, step 16) — the token goes as a Bearer header, never on the URL.
 */
export interface MetaCallVerdict {
  problem: string | null
  renewalClientId: string | null
  rest?: true
  /**
   * Step 30 part 3 — the ONE read that goes with a Page's own token: the apps installed on a Page (`<page>/subscribed_apps`).
   * The gateway reads that token itself (meta-page-token.ts), only when `pageId` is the business's CHOSEN Page.
   */
  pageRead?: { pageId: string }
}

/** Step 30 part 3 — what the read of a Page's connected apps may name (reference/page/subscribed_apps: id, name, subscribed_fields). */
const PAGE_APPS_READ_KEYS: ReadonlySet<string> = new Set(['fields', 'limit', 'after'])
const PAGE_APPS_READ_FIELDS: ReadonlySet<string> = new Set(['id', 'name', 'subscribed_fields'])
/** Review A-F4 — Meta's paging cursor as Meta writes it (base64url-like: letters, digits, _, - and =). */
const PAGE_APPS_CURSOR = /^[A-Za-z0-9_=-]{1,512}$/

/**
 * The verdict on one Meta call, judged on the canonical parse. `auth` is how the caller asked the call to be authorised
 * (gateway.ts `GatewayRequest.auth`): only the token renewal goes without one. For a renewal the verdict also hands back
 * its client_id: the gateway sends it only when that is the connection's own Meta app (gateway.ts, step 1d).
 */
export function metaCallVerdict(input: { method: string; url: string; kind: string; body?: unknown; auth?: unknown; headers?: Record<string, string> }): MetaCallVerdict {
  const refuse = (problem: string): MetaCallVerdict => ({ problem, renewalClientId: null })
  const method = input.method.toUpperCase()
  if (method !== 'GET') return refuse(`this call is not a read (${method}): a Meta change goes only through the write allow-list`)
  if (input.kind !== 'read') return refuse('a GET of Meta is a read, and this call is not declared a read')
  if (input.body !== undefined && input.body !== null && input.body !== '') return refuse('a read of Meta carries no body')
  if (input.headers && Object.keys(input.headers).length > 0) return refuse('a Meta call carries no header of the caller\'s own')
  const rest = metaRestVerdict(input.url, input.auth)
  if (rest) return rest
  const graph = graphRouteOf(input.url)
  if (!graph) return refuse('Nexus calls Meta only at https://graph.facebook.com')
  if ('problem' in graph) return refuse(graph.problem)
  const pinned = metaGraphApiVersion()
  if (graph.version !== pinned) return refuse(`Nexus calls Meta only on API version ${pinned} (this call: ${graph.version ?? 'no version'})`)
  const { segments, route, search } = graph
  if (segments.length === 0) return refuse('the Graph root (batch requests) is not a read')
  const seen = new Set<string>()
  for (const key of search.keys()) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) return refuse(`the query key "${key}" is not one Meta reads (lower-case letters, digits and _)`)
    if (seen.has(key)) return refuse(`the query names "${key}" more than once`)
    seen.add(key)
    if (NOT_A_READ_KEYS.test(key)) return refuse(`the query names "${key}", which turns a GET into a change or a batch`)
    if (GATEWAY_OWNED_KEYS.has(key)) return refuse(`the query names "${key}", which only the gateway sets`)
  }
  if (route === 'oauth/revoke') return refuse('oauth/revoke ends a token: Nexus never sends it')
  if (segments[0].toLowerCase() === 'oauth') {
    if (seen.has('fb_exchange_token')) return refuse('a token renewal names no fb_exchange_token: the gateway fills it from the connection\'s own stored token')
    const keys = [...seen].sort()
    const exact = keys.length === META_RENEWAL_KEYS.length && keys.every((k, i) => k === META_RENEWAL_KEYS[i])
    if (route !== 'oauth/access_token' || !exact || search.get('grant_type') !== 'fb_exchange_token' || input.auth !== 'none') {
      return refuse('the only Meta sign-in call Nexus sends is the system-user token renewal, exactly as Meta documents it (grant_type=fb_exchange_token, client_id, client_secret, set_token_expires_in_60_days; the gateway adds fb_exchange_token)')
    }
    return { problem: null, renewalClientId: search.get('client_id') ?? '' }
  }
  for (const key of seen) {
    if (!keyAllowed(route, key, search)) {
      return refuse(keyKnownHere(route, key) ? `the value of "${key}" is not one Nexus sends here` : `the query key "${key}" is not one a Nexus read of Meta uses here`)
    }
  }
  // Step 9 — /search reads targeting options only (META_SEARCH_TYPES), never a person, a Page or a place.
  if (route === 'search' && !META_SEARCH_TYPES.has(search.get('type') ?? '')) return refuse('a Meta search reads targeting options only: its type is one Nexus names (META_SEARCH_TYPES)')
  const fields = search.get('fields')
  if (fields !== null) {
    const problem = fieldsProblem(fields)
    if (problem) return refuse(problem)
    // Step 19 — a field Nexus reads only on one kind of node (NODE_FIELDS).
    const names = new Set(fields.split(/[^A-Za-z0-9_]+/).filter(Boolean))
    const misplaced = NODE_FIELDS.find((f) => names.has(f.field) && !f.route.test(route))
    if (misplaced) return refuse(`${misplaced.field} is read only on ${misplaced.where}`)
  }
  if (segments.some((segment) => segment.toLowerCase() === 'accounts') && fields === null) {
    return refuse('a read of Pages (accounts) names its fields: Meta answers each Page\'s token by default')
  }
  if (segments.length === 1 && /^\d+$/.test(segments[0]) && fields === null) return refuse('a read of one object names its fields (a Page node can carry its token)')
  // Step 30 part 3 — a node's connected apps (`<id>/subscribed_apps`; an ad account's is `act_<id>/…`) is a Page's: Meta
  // answers it only to that Page's own access token (reference/page/subscribed_apps). It goes with the token the gateway
  // reads itself for the CHOSEN Page (gateway.ts), never at a caller's ask, and names only these keys and fields.
  const pageApps = /^(\d{1,25})\/subscribed_apps$/.exec(route)
  if (pageApps) {
    if (input.auth !== undefined && input.auth !== 'account') return refuse('a Page\'s connected apps are read with the chosen Page\'s own token, which the gateway reads itself: a caller asks for no token')
    const names = (fields ?? '').split(',')
    if (![...seen].every((k) => PAGE_APPS_READ_KEYS.has(k)) || fields === null || !names.every((n) => PAGE_APPS_READ_FIELDS.has(n))) {
      return refuse('a Page\'s connected apps are read with fields from id, name, subscribed_fields (and limit, after) only')
    }
    // Review A-F4 — and their values exactly: this read goes with a Page's token, so nothing may ride on limit or after.
    const limit = search.get('limit')
    if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) > 100)) return refuse('a Page\'s connected apps are read with a limit of digits only, at most 100')
    const after = search.get('after')
    if (after !== null && !PAGE_APPS_CURSOR.test(after)) return refuse('a Page\'s connected apps are read with after as Meta\'s own cursor only (letters, digits, _, - and =, at most 512)')
    return { problem: null, renewalClientId: null, pageRead: { pageId: pageApps[1] } }
  }
  return { problem: null, renewalClientId: null }
}

// ── Meta's REST host (step 16, 2026-10-21) ─────────────────────────────────────────────────────────────────────────

/**
 * Meta's partnership-ads REST endpoints live on a second host, `https://api.facebook.com`, take the token as
 * `Authorization: Bearer <token>` with `X-API-Version: 1.0.0`, and answer plain JSON (checked 2026-10-21 on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/guides/branded-content-permissions.md and
 * …/ad-creative/partnership-ads/fb-account-level-permissioning.md). Nexus READS four of them, GET only, for the
 * business's chosen Facebook Page (the caller's path names it; live-partners.ts checks it is the chosen one):
 *   partnership-ads/fb-account-level-permissions/{page_id}      status, partner_page_ids, permission_direction, offset, limit
 *   partnership-ads/fb-branded-content/{page_id}/brand-allowlist-status
 *   partnership-ads/fb-branded-content/{page_id}/brand-allowlisted-creators
 *   partnership-ads/fb-branded-content/{page_id}/branded-content-posts   start_date, end_date, creator_page_ids, limit, offset
 * Everything else on that host (the business-level adjacent-content file download among it) is refused here; step 39 adds
 * one PUT, the content-block-list CSV export (metaRestFileExportOf, below), and step 26 the writes of the chosen Page's
 * partnership permissions, allowlist and sponsor tags (meta-boost-rules.ts metaRestWriteVerdict, judged as writes). Meta
 * documents no appsecret_proof there, so none is
 * sent (LIVE-PROBES CR-347).
 */
export const META_REST_HOST = 'api.facebook.com'
export const META_REST_API_VERSION = '1.0.0'
const REST_READS: ReadonlyArray<{ route: RegExp; keys: ReadonlySet<string> }> = [
  { route: /^partnership-ads\/fb-account-level-permissions\/\d{1,25}$/, keys: new Set(['status', 'partner_page_ids', 'permission_direction', 'offset', 'limit']) },
  { route: /^partnership-ads\/fb-branded-content\/\d{1,25}\/(brand-allowlist-status|brand-allowlisted-creators)$/, keys: new Set() },
  { route: /^partnership-ads\/fb-branded-content\/\d{1,25}\/branded-content-posts$/, keys: new Set(['start_date', 'end_date', 'creator_page_ids', 'limit', 'offset']) },
]

/** Null when the URL is not on Meta's REST host; else the verdict on it (a read, with the account's own token only). */
function metaRestVerdict(url: string, auth: unknown): MetaCallVerdict | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== META_REST_HOST) return null
  const refuse = (problem: string): MetaCallVerdict => ({ problem, renewalClientId: null })
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port) return refuse(`Nexus calls Meta's REST host only as https://${META_REST_HOST}`)
  const raw = url.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/'
  if (raw.includes('%')) return refuse('a Meta path is never percent-encoded')
  // Review A2 — the path judged is the path read (a backslash is a `/` to the URL parser).
  if (url.includes('\\') || raw !== parsed.pathname) return refuse('a Meta URL is written plainly: no backslash, and the path as written is the path read')
  const pieces = raw.split('/').slice(1)
  if (pieces.some((piece) => !/^[a-z0-9-]+$/.test(piece))) return refuse(`a path on ${META_REST_HOST} is lower-case letters, digits and - only, with no empty segment`)
  const route = pieces.join('/')
  const rule = REST_READS.find((r) => r.route.test(route))
  if (!rule) return refuse(`Nexus reads only the partnership permissions and branded-content lists of the chosen Page at ${META_REST_HOST} (this path: /${route})`)
  if (auth !== undefined && auth !== 'account') return refuse(`a read of ${META_REST_HOST} goes only with the account's own system-user token`)
  const seen = new Set<string>()
  for (const key of parsed.searchParams.keys()) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) return refuse(`the query key "${key}" is not one Meta reads (lower-case letters, digits and _)`)
    if (seen.has(key)) return refuse(`the query names "${key}" more than once`)
    seen.add(key)
    if (NOT_A_READ_KEYS.test(key) || GATEWAY_OWNED_KEYS.has(key) || TOKEN_NAME.test(key)) return refuse(`the query names "${key}", which no Nexus read sends`)
    if (!rule.keys.has(key)) return refuse(`the query key "${key}" is not one a Nexus read of Meta uses here`)
  }
  return { problem: null, renewalClientId: null, rest: true }
}

/**
 * Step 39 (master BS-033) — the ONE call Nexus sends to Meta's REST host that is not a GET: the CSV export of a content
 * block list, `PUT https://api.facebook.com/content_block_lists/{content_block_list_id}/file_download` (content-block-lists.md:
 * "This endpoint is a PUT and not a GET, as every time this endpoint is called, a new file will be created and stored for
 * retrieval"; Bearer token, X-API-Version 1.0.0; it answers the file's name, size, counts and a download URL). It changes
 * no ad and no list, so it goes as a read (never retried by the caller: each call makes a file), with no query, no body
 * and the account's own token; the gateway first checks the list is the chosen portfolio's (meta-brand-safety-owner.ts).
 * Null when the call is not on that path; `{ problem }` when it is, but not exactly that call.
 */
export function metaRestFileExportOf(input: { method: string; url: string; kind: string; body?: unknown; auth?: unknown; headers?: Record<string, string> }): { contentBlockListId: string } | { problem: string } | null {
  let parsed: URL
  try { parsed = new URL(input.url) } catch { return null }
  if (parsed.hostname !== META_REST_HOST || input.method.toUpperCase() !== 'PUT') return null
  const match = /^\/content_block_lists\/(\d{1,20})\/file_download$/.exec(parsed.pathname)
  const raw = input.url.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/'
  if (!match || raw !== parsed.pathname || input.url.includes('\\') || raw.includes('%')) return null
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port || parsed.search) return { problem: `the content block list export is exactly PUT https://${META_REST_HOST}/content_block_lists/<id>/file_download, with no query` }
  if (input.kind !== 'read') return { problem: 'the content block list export changes no ad or list and goes as a read; this one is declared otherwise' }
  if (input.body !== undefined && input.body !== null && input.body !== '') return { problem: 'the content block list export carries no body' }
  if (input.headers && Object.keys(input.headers).length > 0) return { problem: 'a Meta call carries no header of the caller\'s own' }
  if (input.auth !== undefined && input.auth !== 'account') return { problem: `a call to ${META_REST_HOST} goes only with the account's own system-user token` }
  return { contentBlockListId: match[1] }
}

/**
 * Step 26 — the partnership ad codes a READ carries in its query (content discovery's `ad_codes` look-up): the gateway cuts
 * them out of Meta's answer too (the ledger keeps a read's path only).
 */
export function metaReadSecrets(url: string): string[] {
  try {
    const raw = new URL(url).searchParams.get('ad_codes')
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && s.length >= 4) : []
  } catch {
    return []
  }
}

/** Why the gateway refuses this Meta call, in words, or null when it may go (metaCallVerdict's problem). */
export function metaReadOnlyProblem(input: Parameters<typeof metaCallVerdict>[0]): string | null {
  return metaCallVerdict(input).problem
}

/** Is this the token renewal (the only sign-in call), and with which client_id? Null when it is not one (same parse). */
export function metaRenewalOf(url: string): { clientId: string } | null {
  const verdict = metaCallVerdict({ method: 'GET', url, kind: 'read', auth: 'none' })
  return verdict.renewalClientId === null ? null : { clientId: verdict.renewalClientId }
}

/** Query parameters that carry a secret, wherever a string names them (paging links, connection links, a message). */
const SECRET_NAMES = 'access_token|appsecret_proof|appsecret_time|client_secret|fb_exchange_token|input_token'
/** In a query string, with the separator before it. */
const SECRET_IN_QUERY = new RegExp(`([?&])(?:${SECRET_NAMES})=[^&#\\s"'<>]*`, 'gi')
/** Anywhere else in a string (`see access_token=…`, a form body `access_token=…&…`), with one `&` after it. */
const SECRET_BARE = new RegExp(`\\b(?:${SECRET_NAMES})=[^&#\\s"'<>]*&?`, 'gi')
/** Marks where a `?` stood before a dropped parameter, so the next parameter takes its place. */
const QUERY_START = '\u0000q'
/**
 * Token shapes, anywhere in a string (a value or a key): a user or system-user token (EAA…), an app token
 * (`<app id>|<app secret>`), also URL-encoded (`<app id>%7C<app secret>`).
 */
const TOKEN_SHAPES = /EAA[A-Za-z0-9]{20,}|\b\d{6,}(?:\||%7[Cc])[A-Za-z0-9_-]{16,}/g

/** A string with every secret parameter dropped and every token shape masked, and how many were removed. */
function scrubString(value: string): { text: string; removed: number } {
  let removed = 0
  const text = value
    // `?a=T&b` → `?b`, `?b&a=T&c` → `?b&c`, `?b&a=T` → `?b`, `?a=T` → `` (several in a row too).
    .replace(SECRET_IN_QUERY, (_m, lead: string) => { removed++; return lead === '?' ? QUERY_START : '' })
    .replace(new RegExp(`${QUERY_START}&`, 'g'), '?').replace(new RegExp(QUERY_START, 'g'), '')
    .replace(SECRET_BARE, () => { removed++; return '' })
    .replace(TOKEN_SHAPES, () => { removed++; return '[removed]' })
  return { text, removed }
}

/**
 * Defence in depth (review 2, widened in review 3): nothing that is or carries a token leaves the gateway in a Meta
 * answer — to the ledger, the caller or a tool — except the renewal's own answer, which IS the new token. The answer is
 * ALWAYS parsed (a JSON-escaped key like `access\u005ftoken` is read as Meta means it): every key named `access_token`
 * (any case, any depth) is dropped; in every string value the secret query parameters (access_token, appsecret_proof,
 * appsecret_time, client_secret, fb_exchange_token, input_token — `paging.next` / `previous` carry the token, an app-token
 * read carries `app id|app secret`) are dropped and token shapes masked. An answer that is not JSON is treated as one
 * string. Returns the text as it may travel and how many things were removed (the ledger counts them).
 */
export function scrubMetaAnswer(text: string): { text: string; scrubbed: number } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    const clean = scrubString(text)
    return { text: clean.text, scrubbed: clean.removed }
  }
  let scrubbed = 0
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 64) return null
    if (typeof value === 'string') {
      const clean = scrubString(value)
      scrubbed += clean.removed
      return clean.text
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
        if (rawKey.toLowerCase() === 'access_token') { scrubbed++; continue }
        // A key can carry a token too (an answer keyed by token): it is masked like a value, and kept apart if two clash.
        const masked = scrubString(rawKey)
        scrubbed += masked.removed
        let key = masked.text
        for (let n = 2; masked.removed && Object.prototype.hasOwnProperty.call(out, key); n++) key = `${masked.text}-${n}`
        // defineProperty: a key named "__proto__" stays an own key (an assignment would set the prototype and lose it).
        Object.defineProperty(out, key, { value: walk(child, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return out
    }
    return value
  }
  const clean = walk(parsed, 0)
  return scrubbed ? { text: JSON.stringify(clean), scrubbed } : { text, scrubbed: 0 }
}

/** Meta counts Business Use Case quotas per kind of call (ads management, insights) and the sign-in apart. */
export function metaCallGroup(url: string): MetaCallGroup {
  const graph = graphRouteOf(url)
  const route = graph && !('problem' in graph) ? graph.route : ''
  if (/^(oauth\/|debug_token$)/.test(route)) return 'auth'
  if (/(^|\/)insights$/.test(route)) return 'insights'
  return 'ads'
}

/** appsecret_proof for one call: HMAC-SHA256 of `<token>|<time>` keyed with the app secret, hex. */
export function metaAppSecretProof(token: string, appSecret: string, timeSec: number = Math.floor(Date.now() / 1000)): { appsecret_proof: string; appsecret_time: string } {
  const time = String(Math.floor(timeSec))
  return { appsecret_proof: createHmac('sha256', appSecret).update(`${token}|${time}`).digest('hex'), appsecret_time: time }
}

/** The URL as it is sent: the caller's URL with the token and its proof added (the ledger never sees this one). */
export function metaSendUrl(url: string, token: string, proof: { appsecret_proof: string; appsecret_time: string }): string {
  const parsed = new URL(url)
  parsed.searchParams.set('access_token', token)
  parsed.searchParams.set('appsecret_proof', proof.appsecret_proof)
  parsed.searchParams.set('appsecret_time', proof.appsecret_time)
  return parsed.toString()
}

// ── writes (step 17, 2026-10-21) ────────────────────────────────────────────────────────────────────────────────────

/**
 * The statuses a Nexus change writes on a campaign, ad set or ad (set-meta-status). Checked 2026-10-21 on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign-group.md ("Updating", `status`
 * enum ACTIVE, PAUSED, DELETED, ARCHIVED) and best-practices/manage-your-ad-object-status.md (ARCHIVED can only go to
 * DELETED; DELETED cannot change). DELETED is not one: deleting is its own tool (remove-meta-ads-items, step 22: an HTTP
 * DELETE on a person's explicit ask), so no Nexus change sends status=DELETED.
 */
export const META_WRITE_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export type MetaWriteStatus = typeof META_WRITE_STATUSES[number]

/**
 * What a change may read back in the same POST (read-after-write, master ACC-030: the campaign update "supports
 * read-after-write and will read the node to which you POSTed"; Meta's Python SDK sends `fields` on every api_update).
 */
export const META_READ_BACK_FIELDS: ReadonlySet<string> = new Set(['id', 'status', 'configured_status', 'effective_status', 'updated_time'])


/**
 * Review fix A2 (2026-10-21) — Meta documents validate_only on a campaign UPDATE (reference/ad-campaign-group.md
 * "Updating"), but Nexus has not seen it honoured live yet. Until LIVE-PROBE ST17-01 shows Meta checks an update and
 * changes nothing, Nexus asks Meta's check ONLY of a change to PAUSED: had Meta wrongly applied it, a pause is harmless
 * and undoable. A change to ACTIVE or ARCHIVED is then previewed without Meta's check ("Meta's check is not used for this
 * change yet"). THE LEADER FLIPS THIS TO true after ST17-01 (meta-writes.vitest.test.ts tests both states).
 */
export const META_UPDATE_CHECK_PROVEN = false

/** May Nexus ask Meta's check (validate_only) of a status change to `status`? (Both states: see META_UPDATE_CHECK_PROVEN.) */
export function metaCheckAllowed(status: string, proven: boolean = META_UPDATE_CHECK_PROVEN): boolean {
  return proven ? (META_WRITE_STATUSES as readonly string[]).includes(status) : status === 'PAUSED'
}

/**
 * One kind of Meta change Nexus sends: the method, the path's shape, the body keys it must and may carry and a judge of
 * their values. `budget`: it moves an ad set's daily or lifetime budget (Meta's 4-an-hour limit, meta-object-limits.ts).
 * Each later step adds only the rules its own tools send, with tests (meta.vitest.test.ts).
 */
export interface MetaWriteRule {
  name: string
  /** Step 30: PATCH (an alert subscription's status). */
  method: 'POST' | 'DELETE' | 'PATCH'
  /** The route, lower case, without the version (`120000000000001`). */
  path: RegExp
  required: readonly string[]
  optional: readonly string[]
  /** Why a value is refused, or null. */
  values: (params: ReadonlyMap<string, string>) => string | null
  /** Step 18: a function of the body when only some of its keys move an ad set's budget. */
  budget: boolean | ((params: ReadonlyMap<string, string>) => boolean)
  /**
   * Step 18 — the kinds of object the rule is for: it matches only a call that names one of them (the gateway then
   * confirms the kind). No list: any campaign, ad set or ad (the status rule).
   */
  kinds?: readonly MetaWriteKind[]
  /** Step 18 — at least one of these keys (a settings rule has no single required key). */
  anyOf?: readonly string[]
  /**
   * Step 18 — keys whose value may be text a person types (a name, the EU payer), each with its pattern
   * (meta-settings-rules.ts META_NAME_TEXT / META_STRICT_TEXT): every other value stays plain ASCII.
   */
  text?: Readonly<Record<string, RegExp>>
  /** Step 18 — the longest body of this rule (default MAX_WRITE_BODY). */
  maxBody?: number
  /** Step 18 — the ids inside the body, each checked to be of the chosen ad account by the gateway before anything goes. */
  ids?: (params: ReadonlyMap<string, string>) => MetaWriteBodyId[]
  /**
   * Step 23 — the media ids inside the body (an Instagram media, a video upload Nexus started, a media-library folder),
   * each checked by the gateway to be the business's own before anything goes (gateway.ts metaMediaAssetsProblem).
   */
  assets?: (params: ReadonlyMap<string, string>) => MetaWriteAsset[]
  /**
   * Step 23 — a call on an EDGE of the chosen ad account, its portfolio or a library video (an upload, a folder, captions):
   * it edits no object, so Meta's one-edit-per-object-every-30-s gap does not hold it (a hold Meta itself answers still does).
   */
  edgeCall?: boolean
  /** Step 23 — its body is bulky (an image's bytes): the ledger keeps its length only, never the body itself. */
  bulky?: boolean
  /**
   * Step 23 (review B1) — ONE file part the gateway encodes itself (Meta's `-F 'key=@file'`): the caller passes the file's
   * TEXT as form key `key` and its file name as `nameKey`; the gateway judges both (the name against `name`, at most
   * `maxBytes` UTF-8 bytes, `judge`) and sends a multipart body: `key` as a file part named by `nameKey`'s value with
   * `contentType`, every other judged key as a plain field (`nameKey` itself is never sent). No caller header, nothing of
   * the file stored or logged (with `bulky`). Used by MD-026's captions; lane C4 (step 39: a feed's CSV, a block list) can
   * reuse it.
   */
  file?: { key: string; nameKey: string; name: RegExp; contentType: string; maxBytes: number; judge: (text: string) => string | null }
  /**
   * Step 39 (Q7) — the body's `targeting` may change only these keys: every other key must be exactly the ad set's LIVE
   * targeting, which the gateway reads itself (with its owner and kind check) once the write holds its rate slot.
   */
  targeting?: ReadonlySet<string>
  /**
   * Step 36 (Q1) — 'page': the change goes with the business's CHOSEN Facebook Page's own token, which the gateway itself
   * reads for that one call (meta-page-token.ts) and never hands out. Step 30 — 'app': the change goes with the
   * connection's own Meta APP token (an app's webhook subscription, the app's removal from the chosen Page), which the
   * gateway reads the same way. Only a rule marked so; every other rule keeps the system-user token, and a rule's token
   * is never another's (no Page token on an app rule, nor the reverse). A caller can never ask for either (a caller's
   * `auth` other than the account's is refused).
   */
  auth?: 'page' | 'app'
  /**
   * Step 36 review A6 — what the ledger keeps of this change's body when it fails (default: the body, made safe): a test
   * lead keeps its questions' names, never the answers.
   */
  ledger?: (params: ReadonlyMap<string, string>) => Record<string, string>
  /** Step 29 — a POST with no body at all (a rule's run now, Meta's preview of a rule): no key, nothing judged but the path. */
  emptyBody?: true
  /** Step 29 — a POST that only reads (Meta's preview of a rule): it goes as a read, like Meta's check, and changes nothing. */
  readOnly?: true
  /** Step 31 — the body holds people's hashed data: the ledger keeps neither it nor Meta's answer to it. */
  personal?: boolean
  /**
   * Step 7 — a POST that changes nothing on the account (a report run: Meta makes an AdReportRun, a background read):
   * declared a read, never braked, held or retried like a change; the gateway checks the path's ad account is the chosen one.
   */
  reportRun?: true
  /**
   * Step 26 — the partnership ad codes the body carries (credential-like strings a creator shares; meta-boost-rules.ts): with
   * any, the ledger keeps the body's length only, and each is cut out of Meta's answer before it leaves the gateway.
   */
  secret?: (params: ReadonlyMap<string, string>) => string[]
  // ── step 30 (meta-webhook-rules.ts) ──
  /**
   * A DELETE whose parameters ride in the URL's query, as Meta's SDK sends a DELETE's (an app's webhook subscription:
   * `object`, `fields`), judged like a body; it takes no body. Every other call with a query is refused.
   */
  inQuery?: true
  /** The gateway adds `verify_token` (META_WEBHOOK_VERIFY_TOKEN) to the body it sends: never a caller's, never logged. */
  verifyToken?: true
  /** A check of the route with the judged keys (a callback that must be Nexus's own for the path's app). */
  routeCheck?: (route: string, params: ReadonlyMap<string, string>) => string | null
  /** The Meta app this change names (in its path or app_id): the gateway sends it only for the connection's own app. */
  appIdOf?: (route: string, params: ReadonlyMap<string, string>) => string | null
}

/** Step 18 — the kinds of object a change names: a campaign, ad set or ad, or a budget schedule of one (high-demand period). */
export type MetaWriteKind = 'campaign' | 'adset' | 'ad' | 'highdemandperiod' | 'adaccount' | MetaRemoveKind | MetaLabelsKind | MetaOptimizeKind | MetaMediaWriteKind
  // Step 29 — one of the chosen ad account's automated rules (its create names act_<id>, `adaccount`).
  | 'adrule'
  // Step 39 — what only the brand-safety tools name (MetaBrandSafetyKind, below).
  | MetaBrandSafetyKind
  // Step 31 — one of the chosen ad account's own custom audiences.
  | 'customaudience'
  // Step 36 — what only the lead-form tools name (MetaPageKind, below).
  | MetaPageKind
  // Step 26 — what only set-meta-partnership-access names (MetaBoostWriteKind, below; its Page is step 28's `page`).
  | MetaBoostWriteKind
/**
 * Step 26 — what a partnership-access change names: the chosen Instagram account itself (`<ig id>/branded_content_ad_permissions
 * | branded_content_tag_approval | collaboration_invites`) or a media of it (`<media id>/partnership_ad_code`). The chosen
 * Facebook Page on Meta's partnership REST host (`partnership-ads/…/<page id>…`, meta-boost-rules.ts) is step 28's `page`.
 */
export type MetaBoostWriteKind = 'iguser' | 'igmedia'
  // Step 32 — a dataset (pixel), its business portfolio, a custom conversion, an event source group, an Instagram account
  // (meta-signals-rules.ts MetaSignalsKind; its creates name step 19's `adaccount`, a Page dataset step 28's `page`).
  | MetaSignalsKind
  // Step 30 — the connection's own Meta app (MetaWebhookKind, below).
  | MetaWebhookKind
/** Step 28 — what only the recommendation and experiment tools name: a business portfolio (a new study), a study, a
 * Page, a Page video test (an apply names the chosen ad account itself, `adaccount`). */
export type MetaOptimizeKind = 'business' | 'adstudy' | 'page' | 'pagevideotest'
/** Step 22 — what only remove-meta-ads-items names: a creative, a video of the library, a part of an Instant Experience. */
export type MetaRemoveKind = 'creative' | 'video' | 'canvaselement'
/** Step 21 — what set-meta-labels and set-meta-value-rules change by its own id: a label, a value rule set of the chosen ad account. */
export type MetaLabelsKind = 'adlabel' | 'valueruleset'
/**
 * Step 23 — what only create-meta-media names: a video upload Nexus started (Meta's rupload host, a video-ads finish). An
 * upload on the ad account is step 19's `adaccount`, a video of the library (its captions) step 22's `video`, a folder's
 * business portfolio (`<business>/creative_folders`) step 28's `business`.
 */
export type MetaMediaWriteKind = 'startedvideo'
/** Step 23 — a media id inside a change's body, and what the gateway checks it is (meta-media-rules.ts). */
export interface MetaWriteAsset {
  id: string
  kind: 'instagrammedia' | 'startedvideo' | 'creativefolder'
    // Step 25 — the ids inside a creative (meta-creative-rules.ts; gateway.ts metaCreativeAssetProblem): the identity Page and
    // Instagram account (the chosen ones; a partnership ad's partner's when the chosen one is its sponsor — `with`), a
    // partner's Page or Instagram account, an image of the chosen account's library (its hash), a post of the chosen Page,
    // an Instant Experience of the chosen Page and an element of it (`with`: the experience), a lead form of the chosen
    // Page, an event of the chosen Page or of the chosen Instagram account. A library video and the chosen Page of a call to
    // action are step 22's `video` and step 19's `page` body ids.
    | 'identitypage' | 'identityinstagram' | 'partnerpage' | 'partnerinstagram' | 'adimage' | 'pagepost' | 'canvas' | 'canvaselement'
    | 'leadform' | 'pageevent' | 'igevent'
    // Step 26 (meta-boost-rules.ts, meta-creative-rules.ts): a creator's content Meta lists as advertisable for the brand
    // (content discovery); a creator's ad code (`with`: the media or platform it must unlock); a public link to the chosen
    // Instagram account's own media; a Collab invite the chosen account has pending; a branded-content post that tags the
    // chosen Page (its id as Meta's partnership host lists it). The chosen Page and Instagram account a boost names are step
    // 19's `page` and step 31's `instagram` body ids.
    | 'partnercontent' | 'adcode' | 'igpermalink' | 'collabinvite' | 'brandedpost'
  /** Step 25 — the id it goes with (a partner's sponsor, an element's Instant Experience). */
  with?: string
}
/**
 * Step 39 — what only the brand-safety tools name: an ad set's targeting (its brand-safety keys; the gateway reads the
 * ad set itself), a publisher block list, a content block list. They also name the chosen ad account (`adaccount`) and
 * its business portfolio (`business`): the gateway sends a brand-safety RULE's write to meta-brand-safety-owner.ts.
 */
export type MetaBrandSafetyKind = 'adsettargeting' | 'publisherblocklist' | 'contentblocklist'
/**
 * Step 36 — what only the lead-form tools name: a lead form of the chosen Facebook Page, a test lead Nexus made on such a
 * form. They also name the chosen Page itself (`page`, as step 28 does): the gateway sends a Page-token RULE's write
 * (`auth: 'page'`) to meta-page-owner.ts.
 */
export type MetaPageKind = 'leadform' | 'testlead'
/**
 * Step 30 — what only the webhook tools name: the connection's own Meta app (its webhook subscriptions). They also name
 * the chosen ad account itself (step 19's `adaccount`: its connected app, its alert subscriptions) and the chosen Page
 * (step 28's `page`: the app's removal from it); the gateway checks a webhook RULE's write in gateway.ts
 * metaWebhookOwnerProblem.
 */
export type MetaWebhookKind = 'app'
/** Step 18 — an id inside a change's body, and what it must be of the chosen ad account. */
export interface MetaWriteBodyId {
  id: string
  // Step 27 — `creative`: an existing creative a new ad (or a swap) shows, of the chosen ad account (metaOwnerProblem).
  kind: 'adset' | 'ad' | 'customaudience' | 'pixel' | 'catalog' | 'productset' | 'productitem' | 'campaign' | 'page' | 'customconversion' | 'video' | 'creative' | MetaLabelsBodyKind | MetaOptimizeBodyKind | MetaBrandSafetyBodyKind | MetaAudienceBodyKind | MetaPageBodyKind
  /**
   * Step 27 review A1 — a creative an ad shows while ACTIVE: its Advantage+ switches are read with its account_id and must
   * all say OPT_OUT (meta-ad-rules.ts metaActivationProblem) — `always` (a new ad created ACTIVE) or `if-ad-active` (a swap:
   * when the ad being changed is ACTIVE).
   */
  activation?: 'always' | 'if-ad-active'
}
/**
 * Step 31 — ids inside an audience's body only (meta-audience-rules.ts; gateway.ts metaBodyIdsProblem, audience-ids.ts): a
 * campaign or ad set a lookalike learns from, the chosen Instagram account, a lead form or Instant Experience of the chosen
 * Page, a source video (the chosen Page's or the library's: not step 22's `video`), an ad account a share goes to (an own
 * account that is NOT the chosen one: not step 28's `adaccount`). A Page is step 19's `page` (the chosen Page). Step 26 —
 * a boost's sponsor Instagram account and an Instagram app link's user id name the chosen Instagram account as `instagram` too.
 */
export type MetaAudienceBodyKind = 'campaignOrAdset' | 'instagram' | 'leadform' | 'canvas' | 'sourcevideo' | 'shareaccount'
/**
 * Step 28 — ids inside a recommendation's or a study's body only: an ad set or ad of a recommendation's selection, a lift
 * cell's ad account, a study's viewer, a Page video, a study's own cell (meta-optimize-owner.ts).
 */
export type MetaOptimizeBodyKind = 'adsetorad' | 'adaccount' | 'person' | 'pagevideo' | 'studycell'
/**
 * Step 21 — ids inside a body only: a label or a value rule set (the chosen ad account's own lists), a reach & frequency
 * prediction (the chosen account's own predictions), a prediction's destination (the chosen Page or Instagram account).
 */
export type MetaLabelsBodyKind = MetaLabelsKind | 'rfprediction' | 'destination'
/**
 * Step 39 — ids inside a brand-safety body only (meta-brand-safety-owner.ts checks them): the chosen ad account (digits,
 * `adaccount` above), its portfolio, a portfolio a list is shared with or unshared from (never one another business in
 * Nexus uses), a publisher block list, the draft this run made.
 */
export type MetaBrandSafetyBodyKind = 'business' | 'agency' | 'publisherblocklist' | 'blocklistdraft'
/** Step 36 — an id inside a lead form's body: a photo of the chosen Facebook Page (the form's intro photo). */
export type MetaPageBodyKind = 'pagephoto'

const fieldsValueProblem = (value: string): string | null => {
  const names = value.split(',')
  if (!names.length || names.length > META_READ_BACK_FIELDS.size) return 'fields names the fields a change reads back, each once'
  if (names.some((name) => !META_READ_BACK_FIELDS.has(name))) return `a change reads back only ${[...META_READ_BACK_FIELDS].join(', ')}`
  if (new Set(names).size !== names.length) return 'fields names each field once'
  return null
}

// Review fix A5 — exactly the string judged is the string sent: no other spelling of the same list.
const executionProblem = (value: string): string | null =>
  value === META_VALIDATE_ONLY ? null : `the only execution_options Nexus sends is exactly ${META_VALIDATE_ONLY} (Meta's check, which changes nothing)`

/** Step 17 — the write allow-list. */
const META_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // set-meta-status: POST /{campaign_id | ad_set_id | ad_id} status=ACTIVE|PAUSED|ARCHIVED, optionally Meta's check
    // (execution_options) or the read-back (fields).
    name: 'object.status',
    method: 'POST',
    path: /^\d{1,20}$/,
    required: ['status'],
    optional: ['execution_options', 'fields'],
    values: (params) => {
      const status = params.get('status') ?? ''
      if (status === 'DELETED') return 'Nexus deletes nothing by a status change: deleting is its own tool (remove-meta-ads-items, on a person\'s explicit ask)'
      if (!(META_WRITE_STATUSES as readonly string[]).includes(status)) return `status is ${META_WRITE_STATUSES.join(', ')}`
      if (params.has('execution_options')) {
        const problem = executionProblem(params.get('execution_options')!)
        if (problem) return problem
        if (params.has('fields')) return 'Meta\'s check (validate_only) changes nothing, so it reads nothing back (no fields)'
        if (!metaCheckAllowed(status)) return `Nexus does not use Meta's check for a change to ${status} yet (only for a pause, until a live probe shows Meta honours validate_only on updates)`
      }
      if (params.has('fields')) return fieldsValueProblem(params.get('fields')!)
      return null
    },
    budget: false,
  },
  {
    // Step 7 (meta-ads-report, master IN-067 / IN-070 / IN-071): POST /act_<id>/insights starts a report run of the chosen ad
    // account's numbers. Meta documents the POST on the account's, a campaign's and an ad set's insights edges
    // (reference/ad-account/insights, ad-campaign-group/insights, ad-campaign/insights "Creating"; best-practices "POST
    // <AD_OBJECT>/insights"): Nexus sends it only on the account's path — an object goes as a filter — so this ONE anchored
    // path is checked against the chosen account. Every key and value is judged on the insights lists
    // (services/meta/meta-insights-lists.ts reportRunProblem).
    name: 'insights.reportRun',
    method: 'POST',
    // Follow-up of the step 7 merge review — an account id has no leading zero (act_0… is no ad account's id).
    path: /^act_[1-9]\d{0,24}\/insights$/,
    required: ['level'],
    optional: ['fields', 'breakdowns', 'action_breakdowns', 'summary_action_breakdowns', 'action_attribution_windows', 'date_preset', 'time_range', 'time_ranges', 'time_increment', 'filtering', 'sort', 'default_summary', 'use_account_attribution_setting', 'product_id_limit', 'export_format', 'export_name'],
    values: (params) => reportRunProblem(params),
    budget: false,
    maxBody: MAX_REPORT_RUN_BODY,
    reportRun: true,
  },
]

/** The longest body a Nexus change sends (a status change is a few dozen characters). */
const MAX_WRITE_BODY = 2000

/** A Meta change the gateway may send, as it judged it. */
export interface MetaJudgedWrite {
  /** The allow-list entry it matched. */
  rule: string
  /** The object the change is for (the path's id): the gateway checks it is of the business's chosen ad account. */
  objectId: string
  /** Meta's check (validate_only): Meta changes nothing, so it goes as a read; else a write under the publish mode. */
  check: boolean
  /** The body as it is sent: the judged keys, written again in one order (what was judged is what goes). */
  body: string
  /** It moves an ad set's budget (Meta's 4-an-hour limit). */
  budget: boolean
  /** Step 18 — the kinds the rule is for (the call's named kind is one of them; the gateway confirms it). */
  kinds?: readonly MetaWriteKind[]
  /** Step 18 — the ids inside the body: each must be of the chosen ad account (the gateway checks them before sending). */
  ids?: MetaWriteBodyId[]
  /**
   * Step 18 — a DELETE (a budget schedule's; step 22: remove-meta-ads-items'); every other change is a POST. Step 26: a PUT
   * on Meta's partnership host. Step 30: a PATCH (an alert subscription's status).
   */
  method?: 'DELETE' | 'PUT' | 'PATCH'
  /** Step 29 — a POST that only reads (Meta's preview of a rule): no per-object hold is noted for it. */
  readOnly?: true
  /** Step 23 — the media ids inside the body (the gateway checks each). */
  assets?: MetaWriteAsset[]
  /** Step 23 — a call on an edge of the ad account or portfolio: no 30-s per-object gap (MetaWriteRule.edgeCall). */
  edgeCall?: true
  /** Step 23 — the ledger keeps the body's length only (an image's bytes). */
  bulky?: true
  /**
   * Step 23 — Meta's resumable upload host (rupload.facebook.com, meta-media-rules.ts): the token goes in its
   * `Authorization: OAuth` header (the gateway adds it), the judged `headers` with it, and no body.
   */
  host?: 'rupload' | 'rest'
  headers?: Record<string, string>
  /** Step 23 — a write with a file part (MetaWriteRule.file): the gateway sends this multipart body instead of `body`. */
  multipart?: { fields: Array<[string, string]>; file: { key: string; filename: string; contentType: string; text: string } }
  /** Step 31 — the body holds people's hashed data: the ledger keeps neither it nor Meta's answer (gateway.ts 9). */
  personal?: true
  /** Step 7 — a report run of the ad account `objectId` (digits): it changes nothing; the gateway checks the account is the chosen one. */
  reportRun?: true
  /** Step 39 — the targeting sent and the keys it may change (the gateway compares the rest with the live targeting). */
  targeting?: { sent: Record<string, unknown>; keys: ReadonlySet<string> }
  /**
   * Step 36 (Q1) — the rule's own auth: 'page' = the chosen Page's token, read by the gateway for this one call; step 30 —
   * 'app' = the connection's own app token, read the same way.
   */
  auth?: 'page' | 'app'
  /** Step 36 review A6 — the body as the ledger keeps it when the change fails (the rule's `ledger`). */
  ledgerBody?: string
  /** Step 26 — the partnership ad codes the body carries (MetaWriteRule.secret): never in the ledger or an answer. */
  secrets?: string[]
  /** Step 30 — the gateway adds the verify token to the body it sends. */
  verifyToken?: true
  /** Step 30 — the Meta app it names: sent only when it is the connection's own. */
  appId?: string
}

/** The gateway's verdict on a Meta call that is not a GET: why it is refused (and whether as a batch), or the judged write. */
export type MetaWriteVerdict = { problem: string; batch?: true } | { write: MetaJudgedWrite }

/**
 * Step 17 — the verdict on one Meta call that is not a GET, judged on the same canonical parse as a read (graphRouteOf):
 * the exact allow-list above, the declared kind equal to the body's (a check = read, a change = write), the account's own
 * token, no caller headers, no query string (a change carries its parameters in its body only, so the body judged is the
 * one sent; step 30: but a DELETE rule marked `inQuery`, whose query is judged as a body is), each key named once. Whether the object is of the business's chosen ad account is the gateway's next step
 * (it needs the database or one live read), and so are Meta's per-object limits.
 */
export function metaWriteVerdict(input: { method: string; url: string; kind: string; body?: unknown; auth?: unknown; headers?: Record<string, string>; objectKind?: string }): MetaWriteVerdict {
  const refuse = (problem: string): MetaWriteVerdict => ({ problem })
  const method = input.method.toUpperCase()
  if (input.headers && Object.keys(input.headers).length > 0) return refuse('a Meta call carries no header of the caller\'s own')
  if (input.auth !== undefined && input.auth !== 'account') return refuse('a Meta change goes only with the account\'s own system-user token')
  // Step 23 — Meta's resumable video upload host has its own exact judge (meta-media-rules.ts); null: not that host.
  const upload = metaRuploadVerdict(input)
  if (upload) return upload
  // Step 26 (review B1) — Meta's partnership REST host has its own exact judge (meta-boost-rules.ts); null: not that host.
  const rest = metaRestWriteVerdict(input)
  if (rest) return rest
  // The Graph root with its version (`…/v26.0/`, Meta's batch endpoint) is judged as the root, so a batch is named as one.
  const graph = graphRouteOf(input.url.replace(/^(https:\/\/graph\.facebook\.com\/v\d+\.\d+)\/(?=$|[?#])/i, '$1'))
  if (!graph) return refuse('Nexus calls Meta only at https://graph.facebook.com')
  if ('problem' in graph) return refuse(graph.problem)
  const pinned = metaGraphApiVersion()
  if (graph.version !== pinned) return refuse(`Nexus calls Meta only on API version ${pinned} (this call: ${graph.version ?? 'no version'})`)
  const queryKeys = [...graph.search.keys()]
  if (queryKeys.length > 0 && method !== 'DELETE') return refuse('a Meta change carries its parameters in its body, never in the URL')
  const batch = metaBatchProblem(method, graph.route, input.body)
  if (batch) return { problem: batch, batch: true }
  // Review A5 (step 31) — a DELETE body that is not form text (bytes, an object) is refused, never sent as an empty one.
  if (method === 'DELETE' && input.body !== undefined && input.body !== '' && typeof input.body !== 'string') return refuse('a Meta DELETE carries no body, or its fields as form text')
  // Step 18 — a DELETE goes only by a DELETE rule for the kind the call names (a budget schedule's), with no body. Step 22 —
  // a DELETE rule that names keys (an image's hash, a video's id; step 39: a share's agency, a list's posts) takes exactly those as its form body, judged like a POST's.
  const deleteRules = method === 'DELETE' ? writeRules().filter((r) => r.method === 'DELETE' && r.path.test(graph.route) && kindMatches(r, input.objectKind)) : []
  const noBody = input.body === undefined || input.body === ''
  // Step 30 — a DELETE rule marked `inQuery` (an app's webhook subscription, the app's link to the chosen ad account) takes
  // its keys in the URL's QUERY, as Meta's SDK sends a DELETE's parameters, judged like a body, and no body at all. No
  // other call carries a query (refused above for a POST, below for every other DELETE).
  const queryRule = deleteRules.find((r) => r.inQuery)
  if (queryRule) {
    if (!noBody) return refuse('this Meta DELETE carries its parameters in the URL\'s query, never in a body')
    if (input.kind !== 'write') return refuse('a Meta change goes as a write; this one is declared otherwise')
    const params = new Map(graph.search)
    if (queryKeys.length !== params.size) return refuse('a Meta change names each parameter once')
    const named = [...params.keys()]
    if (!queryRule.required.every((k) => params.has(k)) || !named.every((k) => queryRule.required.includes(k) || queryRule.optional.includes(k))) {
      return refuse(`this DELETE takes ${[...queryRule.required, ...queryRule.optional].join(', ') || 'no parameters'}; it names ${named.join(', ') || 'none'}`)
    }
    for (const [key, value] of params) if (!/^[\x20-\x7e]*$/.test(value)) return refuse(`the value of "${key}" is plain ASCII`)
    const problem = queryRule.values(params) ?? queryRule.routeCheck?.(graph.route, params) ?? null
    if (problem) return refuse(problem)
    const appId = queryRule.appIdOf?.(graph.route, params) ?? undefined
    return { write: { rule: queryRule.name, objectId: graph.segments[0], check: false, body: '', budget: false, kinds: queryRule.kinds, method: 'DELETE', ...(queryRule.auth ? { auth: queryRule.auth } : {}), ...(appId ? { appId } : {}) } }
  }
  if (queryKeys.length > 0) return refuse('a Meta change carries its parameters in its body, never in the URL')
  const bareDelete = deleteRules.find((r) => !r.required.length && !r.optional.length)
  // Step 26 — a DELETE on a partnership edge of the chosen Instagram account or of its media that matches none of
  // set-meta-partnership-access's rules, in its own words.
  if (method === 'DELETE' && /^\d+\/(branded_content_tag_approval|partnership_ad_code)$/.test(graph.route) && !(bareDelete && noBody) && !(deleteRules.some((r) => r.required.length || r.optional.length) && !noBody)) {
    return refuse('on the chosen Instagram account\'s partnership edges Nexus deletes only what set-meta-partnership-access sends: creators taken off its tag-approval list (user_ids) and the ad code of one of its media (no body)')
  }
  if (method === 'DELETE' && !(bareDelete && noBody) && !(deleteRules.some((r) => r.required.length || r.optional.length) && !noBody)) {
    return refuse('Nexus deletes on Meta only a scheduled budget increase of the chosen ad account (set-meta-budget-schedule), a concluded video test of the chosen Page (set-meta-experiment), a test lead Nexus made on a lead form of the chosen Page (set-meta-lead-form), one of its automated rules (remove-meta-ad-rule), the undo of a create or a copy, and what a person explicitly asked remove-meta-ads-items to delete: a campaign, ad set, ad or creative named with its kind (no body), an image or a video of the chosen ad account\'s library (its hash or video_id as the only body key) or a part of an Instant Experience of the chosen Page, and what the brand-safety tools name (a block list, its shares, people, posts and ad accounts: set-meta-block-list, remove-meta-block-list); and for audiences (step 31) one of the chosen ad account\'s own audiences (no body), the hashed people of one of its customer lists or of all of them (payload) or an audience\'s share with ad accounts (adaccounts) — remove-meta-audience, set-meta-audience-members, set-meta-audience-sharing; and for datasets (step 32) a dataset\'s link to the chosen ad account (account_id and business as the body: set-meta-dataset-access) and a custom conversion Nexus made (no body: remove-meta-signal-items); and for webhooks (step 30) an app\'s webhook subscription (object and fields in the URL\'s query), the app\'s link to the chosen ad account (app_id in the query) or to the chosen Page (set-meta-webhooks) and one of the chosen ad account\'s alert subscriptions (remove-meta-alert-subscription); it cancels no async batch')
  }
  if (bareDelete && noBody) {
    if (input.kind !== 'write') return refuse('a Meta change goes as a write; this one is declared otherwise')
    // Step 26 — a DELETE on an edge (an ad code of an Instagram media) edits no object: no 30-s gap (MetaWriteRule.edgeCall).
    return { write: { rule: bareDelete.name, objectId: graph.segments[0], check: false, body: '', budget: false, kinds: bareDelete.kinds, method: 'DELETE', ...(bareDelete.edgeCall ? { edgeCall: true as const } : {}), ...(bareDelete.auth ? { auth: bareDelete.auth } : {}) } }
  }
  if (method !== 'POST' && method !== 'DELETE' && method !== 'PATCH') return refuse(`Nexus sends Meta no ${method}`)
  // Step 29 — a POST with no body by a rule made for one (a rule's run now, or Meta's preview of it — that one goes as a
  // read): judged before step 21's empty-body POST, which never takes such a rule.
  if (method === 'POST' && noBody) {
    const bare = writeRules().find((r) => r.method === 'POST' && r.emptyBody && r.path.test(graph.route) && kindMatches(r, input.objectKind))
    if (bare) {
      const check = bare.readOnly === true
      if (input.kind !== (check ? 'read' : 'write')) return refuse(check ? 'this POST only reads and goes as a read; this one is declared otherwise' : 'a Meta change goes as a write; this one is declared otherwise')
      return { write: { rule: bare.name, objectId: graph.segments[0], check, body: '', budget: false, ...(bare.kinds ? { kinds: bare.kinds } : {}), ...(check ? { readOnly: true as const } : {}) } }
    }
  }
  // Step 21 — a POST Meta documents with an EMPTY body (a value rule set's delete_rule_set): only by a rule that names no key
  // for the kind the call names, with no body at all.
  const barePost = method === 'POST' && noBody ? writeRules().find((r) => r.method === 'POST' && !r.emptyBody && !r.required.length && !r.optional.length && !r.anyOf && r.path.test(graph.route) && kindMatches(r, input.objectKind)) : undefined
  if (barePost) {
    if (input.kind !== 'write') return refuse('a Meta change goes as a write; this one is declared otherwise')
    return { write: { rule: barePost.name, objectId: graph.segments[0], check: false, body: '', budget: false, kinds: barePost.kinds } }
  }
  const parsed = writeParams(input.body)
  if ('problem' in parsed) return refuse(parsed.problem)
  const keys = [...parsed.params.keys()]
  const rule = writeRules().find((r) => r.method === method && !r.inQuery && r.path.test(graph.route) && kindMatches(r, input.objectKind)
    && r.required.every((k) => parsed.params.has(k)) && keys.every((k) => r.required.includes(k) || r.optional.includes(k))
    && (!r.anyOf || r.anyOf.some((k) => parsed.params.has(k))))
  if (!rule) {
    // Step 26 — a call on a partnership edge of the chosen Instagram account, or a creative or video copy that names an
    // existing post's own keys, that matches none of create-meta-boost's or set-meta-partnership-access's rules, in its own words.
    if (/^\d+\/(branded_content_ad_permissions|branded_content_tag_approval|collaboration_invites|partnership_ad_code)$/.test(graph.route)
      || (/^act_\d+\/(adcreatives|asyncadcreatives|advideos)$/.test(graph.route) && keys.some((k) => BOOST_KEYS.has(k)))) {
      return refuse(`the only Meta change Nexus sends for a boost or a partnership is create-meta-boost's (an existing post as a creative, a creator's Instagram video copied with its ad code) or set-meta-partnership-access's (the chosen Instagram account's partnership permissions, tag approvals and Collab invites, an ad code's removal), each with its own keys; this one is ${method} /${graph.segments.join('/')} with ${keys.join(', ') || 'no parameters'}`)
    }
    // Step 23 — a POST on a media edge that matches none of create-meta-media's rules (nor step 22's), in its own words.
    if (method === 'POST' && /^act_\d+\/(adimages|advideos|video_ads)$|^\d+\/(creative_folders|captions)$/.test(graph.route)) {
      return refuse(`the only Meta change Nexus sends on a media edge is create-meta-media's upload, named with its kind (an image's bytes, a video's link or the chosen Instagram account's video, a video-ads upload, a portfolio folder, captions, a video's default caption), or a removal by remove-meta-ads-items' rules, each with its own keys; this one is ${method} /${graph.segments.join('/')} with ${keys.join(', ') || 'no parameters'}`)
    }
    // Step 25 — a call on a creative (its edges, or a creative named by its kind) that matches none of create-meta-creative's
    // or set-meta-creative's rules (nor step 22's delete), in its own words.
    if (/^act_\d+\/(adcreatives|asyncadcreatives)$/.test(graph.route) || input.objectKind === 'creative') {
      return refuse(`the only Meta change Nexus sends on a creative is create-meta-creative's (a creative of the chosen ad account, or its async job), set-meta-creative's (a creative's name, status or labels) or remove-meta-ads-items' delete, each with its own keys; this one is ${method} /${graph.segments.join('/')} with ${keys.join(', ') || 'no parameters'}`)
    }
    return refuse(`the only Meta change Nexus sends is a status change of one campaign, ad set or ad (POST /<id> with status), or a settings change of a campaign, an ad set or a budget schedule named with its kind (set-meta-campaign, set-meta-ad-set, set-meta-budget-schedule: each its own keys), or a create or a copy (create-meta-campaign, create-meta-ad-set, copy-meta-ads: each its own edge and keys), or a delete a person asked for (remove-meta-ads-items: each its own path and keys), or a label, value rule or reach & frequency change (set-meta-labels, set-meta-value-rules, create-meta-reach-frequency: each its own path and keys), or a change of one of the chosen ad account's automated rules (set-meta-ad-rule), or a report run of the chosen ad account's numbers (meta-ads-report: POST /act_<id>/insights, which changes nothing), or a brand-safety change named with its kind (set-meta-brand-safety, set-meta-block-list, remove-meta-block-list), or an audience change named with its kind (create-meta-audience, set-meta-audience, set-meta-audience-members, set-meta-audience-sharing: each its own path and keys), or a lead-form change of the chosen Facebook Page named with its kind (create-meta-lead-form, set-meta-lead-form), or a dataset or custom conversion change named with its kind (create-meta-dataset, set-meta-dataset, set-meta-dataset-access, set-meta-custom-conversion, remove-meta-signal-items: each its own path and keys), or a webhook or alert subscription (set-meta-webhooks, set-meta-alert-subscription); this one is ${method} /${graph.segments.join('/')} with ${keys.join(', ') || 'no parameters'}`)
  }
  // Step 18 — each rule's own length and text keys; every other value stays plain ASCII (as step 17 judged them all).
  const maxBody = rule.maxBody ?? MAX_WRITE_BODY
  if ((input.body as string).length > maxBody) return refuse(`a Meta change body is at most ${maxBody} characters`)
  for (const [key, value] of parsed.params) {
    // Step 23 — a file's text is judged as the file (rule.file, below), never as a field.
    if (rule.file?.key === key) continue
    const pattern = rule.text && Object.prototype.hasOwnProperty.call(rule.text, key) ? rule.text[key] : null
    if (pattern) {
      if (!pattern.test(value)) return refuse(`the value of "${key}" is printable text (no control or format characters)`)
    } else if (!/^[\x20-\x7e]*$/.test(value)) return refuse(`the value of "${key}" is plain ASCII`)
  }
  const problem = rule.values(parsed.params) ?? rule.routeCheck?.(graph.route, parsed.params) ?? null
  if (problem) return refuse(problem)
  // Step 23 — the file part: its name, its size and its own judge (the text is never quoted back).
  if (rule.file) {
    const text = parsed.params.get(rule.file.key) ?? ''
    const fileName = parsed.params.get(rule.file.nameKey) ?? ''
    if (!rule.file.name.test(fileName)) return refuse(`${rule.file.nameKey} is not a file name this change sends`)
    if (Buffer.byteLength(text, 'utf8') > rule.file.maxBytes) return refuse(`${rule.file.key} is at most ${rule.file.maxBytes.toLocaleString('en')} bytes`)
    const fileProblem = rule.file.judge(text)
    if (fileProblem) return refuse(fileProblem)
  }
  const check = parsed.params.has('execution_options')
  if (rule.reportRun) {
    if (input.kind !== 'read') return refuse('a report run changes nothing on Meta and goes as a read; this one is declared otherwise')
    // Review A F6 — the path exactly as Nexus writes it: act_<digits>/insights, lower case (no leading zero).
    if (!/^act_[1-9]\d{0,24}\/insights$/.test(graph.segments.join('/'))) return refuse('a report run is POST /act_<id>/insights, written in lower case')
    // Follow-up of the step 7 merge review — a report run is of the chosen ad account itself: a call that names an object
    // kind (a campaign, an ad set, an ad …) is no report run; an object goes as a filter in the body.
    if (input.objectKind) return refuse('a report run names no object: it is of the chosen ad account itself (a campaign, ad set or ad goes as a filter)')
  } else if (input.kind !== (check ? 'read' : 'write')) {
    return refuse(check ? 'Meta\'s check (validate_only) changes nothing and goes as a read; this one is declared otherwise' : 'a Meta change goes as a write; this one is declared otherwise')
  }
  const order = [...rule.required, ...rule.optional].filter((k) => parsed.params.has(k))
  const body = new URLSearchParams(order.map((k): [string, string] => [k, parsed.params.get(k)!])).toString()
  if (rule.reportRun) return { write: { rule: rule.name, objectId: graph.segments[0].replace(/^act_/i, ''), check: false, body, budget: false, reportRun: true } }
  const budget = typeof rule.budget === 'function' ? rule.budget(parsed.params) : rule.budget
  const ids = rule.ids?.(parsed.params) ?? []
  // Step 39 — the targeting as sent, for the gateway's comparison with the live one.
  const targeting = rule.targeting ? { sent: JSON.parse(parsed.params.get('targeting') ?? '{}') as Record<string, unknown>, keys: rule.targeting } : null
  // Step 23 — the media ids inside the body, an edge call, a bulky body, a file part.
  const assets = rule.assets?.(parsed.params) ?? []
  const multipart = rule.file
    ? { fields: order.filter((k) => k !== rule.file!.key && k !== rule.file!.nameKey).map((k): [string, string] => [k, parsed.params.get(k)!]), file: { key: rule.file.key, filename: parsed.params.get(rule.file.nameKey)!, contentType: rule.file.contentType, text: parsed.params.get(rule.file.key)! } }
    : null
  // Step 26 — the partnership ad codes in the body: the ledger never keeps them, and Meta's answer loses them.
  const secrets = rule.secret ? rule.secret(parsed.params).filter((s) => typeof s === 'string' && s.length >= 4) : []
  const media = { ...(assets.length ? { assets } : {}), ...(rule.edgeCall ? { edgeCall: true as const } : {}), ...(rule.bulky ? { bulky: true as const } : {}), ...(multipart ? { multipart } : {}), ...(secrets.length ? { secrets } : {}) }
  // Step 30 — the verify token the gateway adds, and the Meta app the change names (sent only for the connection's own).
  const appId = rule.appIdOf?.(graph.route, parsed.params) ?? undefined
  const webhook = { ...(rule.verifyToken ? { verifyToken: true as const } : {}), ...(appId ? { appId } : {}) }
  // A write with a file goes as its multipart body only (`body` stays empty: nothing else of it is ever sent).
  // Step 36 — the Page token mode (step 30: the app token mode), and what the ledger keeps of a failed test lead.
  return { write: { rule: rule.name, objectId: graph.segments[0], check, body: multipart ? '' : body, budget, ...(rule.kinds ? { kinds: rule.kinds } : {}), ...(ids.length ? { ids } : {}), ...(method === 'DELETE' ? { method: 'DELETE' as const } : method === 'PATCH' ? { method: 'PATCH' as const } : {}), ...media, ...(targeting ? { targeting } : {}), ...(rule.personal ? { personal: true as const } : {}), ...(rule.auth ? { auth: rule.auth } : {}), ...(rule.ledger ? { ledgerBody: new URLSearchParams(rule.ledger(parsed.params)).toString() } : {}), ...webhook } }
}

/** Step 26 — the keys only an existing post's creative or a creator's video copy carries (create-meta-boost). */
const BOOST_KEYS: ReadonlySet<string> = new Set(['source_instagram_media_id', 'instagram_permalink_url', 'object_id', 'partnership_ad_ad_code', 'is_partnership_ad'])
/** Step 18 — a rule with kinds matches only a call that names one of them; the status rule (no kinds) a campaign, ad set or ad. */
const kindMatches = (rule: MetaWriteRule, kind: string | undefined) => (rule.kinds
  ? !!kind && (rule.kinds as readonly string[]).includes(kind)
  : kind === undefined || kind === 'campaign' || kind === 'adset' || kind === 'ad')
/** Step 18 — the longest body any rule takes (each rule then holds its own, default MAX_WRITE_BODY). */
// Step 23 — an image upload's bytes (META_IMAGE_MAX_BODY) are the largest body; step 39: an ad set's whole targeting;
// step 31 — 10,000 hashed e-mails of an audience's people (MEMBERS_MAX_BODY).
const MAX_ANY_WRITE_BODY = Math.max(200_000, META_IMAGE_MAX_BODY, MEMBERS_MAX_BODY)
/** Step 17's status rule, then step 18's settings rules (meta-settings-rules.ts), step 19's, step 22's, step 21's (meta-labels-rules.ts) step 28's (meta-optimize-rules.ts) and step 29's rule changes (meta-ad-rule-rules.ts) — read when judged, never at load. */
// Step 23 — then create-meta-media's media rules (meta-media-rules.ts); step 25's creative rules (meta-creative-rules.ts);
// step 39's brand-safety rules; step 31's audience rules (meta-audience-rules.ts); step 26's boost and partnership-access
// rules (meta-boost-rules.ts); step 36's lead-form rules; step 32's dataset and custom conversion rules (meta-signals-rules.ts); step 27's ad rules (meta-ad-rules.ts);
// step 30's webhook and alert subscription rules (meta-webhook-rules.ts) last.
const writeRules = (): readonly MetaWriteRule[] => [...META_WRITE_RULES, ...META_SETTINGS_WRITE_RULES, ...metaCreateWriteRules(), ...META_REMOVE_WRITE_RULES, ...metaLabelsWriteRules(), ...META_OPTIMIZE_WRITE_RULES, ...META_MEDIA_WRITE_RULES, ...metaAdRuleWriteRules(), ...META_CREATIVE_WRITE_RULES, ...META_BRAND_SAFETY_WRITE_RULES, ...META_AUDIENCE_WRITE_RULES, ...META_BOOST_WRITE_RULES, ...META_LEAD_FORM_WRITE_RULES, ...META_SIGNALS_WRITE_RULES, ...META_AD_WRITE_RULES, ...META_WEBHOOK_WRITE_RULES]

/** A change's body, form-encoded (Meta's `-F` fields): each key lower snake_case, named once, never a gateway key. */
function writeParams(body: unknown): { params: Map<string, string> } | { problem: string } {
  if (typeof body !== 'string' || !body) return { problem: 'a Meta change carries its parameters as a form body' }
  if (body.length > MAX_ANY_WRITE_BODY) return { problem: `a Meta change body is at most ${MAX_WRITE_BODY} characters (${MAX_ANY_WRITE_BODY} for the largest changes: an image upload, the hashed people of an audience, an ad set's whole targeting)` }
  const params = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(body)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) return { problem: `the body key "${key.slice(0, 40)}" is not one Meta reads (lower-case letters, digits and _)` }
    if (params.has(key)) return { problem: `the body names "${key}" more than once` }
    if (GATEWAY_OWNED_KEYS.has(key) || NOT_A_READ_KEYS.test(key) || /token|secret|proof/.test(key)) return { problem: `the body names "${key}", which no Nexus change sends` }
    params.set(key, value)
  }
  return { params }
}

// ── batches (master ACC-022 / 023 / 025–027): the plumbing, nothing allowed through it yet ──────────────────────────

/**
 * Meta's two batch forms (checked 2026-10-21: developers.facebook.com/docs/graph-api/batch-requests and
 * documentation/ads-commerce/marketing-api/asyncrequests.md, reference/ad-account/async_batch_requests):
 *   graph-batch  POST https://graph.facebook.com/<version>/ with `batch` = JSON list of {method, relative_url, body,
 *                name} — at most 50, at most 10 ad creations; independent parts run in parallel; NOT all or nothing: each
 *                part answers on its own, and on a timeout the unfinished parts come back null
 *   async-batch  POST /act_<id>/async_batch_requests with `name` + `adbatch` = JSON list of {name, relative_url, body} —
 *                at most 1,000; read back per request (GET /<request set id>, /<request set id>/requests); rename
 *                (POST /<request set id> name, notification_*) and cancel (DELETE /<request id | set id>) before they run
 * Every part of a batch would be judged exactly like a call of its own (metaWriteVerdict, then the chosen-account check
 * per object), and a batch is never treated as atomic. Step 19 (2026-10-21) allows the async batch for ONE use: copy-meta-ads
 * in the background (master CMP-054), whose rule (meta-create-rules.ts copy.background) takes only parts that are copies of a
 * campaign or an ad set and judges each exactly like that copy, naming each part's object for the account check; every
 * other async batch matches no rule and is refused. A Graph batch stays refused (no Nexus change needs one).
 * The reads of an async request set are GETs (the read gate); its rename and cancel are refused by the write allow-list.
 */
export type MetaBatchKind = 'graph-batch' | 'async-batch'
export const META_BATCH_KINDS_ALLOWED: ReadonlySet<MetaBatchKind> = new Set<MetaBatchKind>(['async-batch'])
const MAX_BATCH_PARTS: Record<MetaBatchKind, number> = { 'graph-batch': 50, 'async-batch': 1000 }

/** Which batch form a call is, or null. */
export function metaBatchKindOf(method: string, route: string): MetaBatchKind | null {
  if (method.toUpperCase() !== 'POST') return null
  if (route === '') return 'graph-batch'
  if (/^act_\d+\/async_batch_requests$/.test(route)) return 'async-batch'
  return null
}

/**
 * Why a batch-shaped call is refused (null: it is not a batch). Each part is judged as a change of its own, so the
 * sentence names the first part Nexus would not send even one by one.
 */
export function metaBatchProblem(method: string, route: string, body: unknown): string | null {
  const kind = metaBatchKindOf(method, route)
  if (!kind) return null
  const parts = batchParts(kind, body)
  // Step 19 — an allowed kind: its shape is checked here, each part by the one rule that takes it (copy.background).
  if (META_BATCH_KINDS_ALLOWED.has(kind)) return 'problem' in parts ? `Nexus sends a Meta async batch only as a background copy (${parts.problem})` : null
  const detail = 'problem' in parts ? parts.problem : parts.problems[0] ?? null
  if (!META_BATCH_KINDS_ALLOWED.has(kind) || detail) {
    const why = kind === 'graph-batch'
      ? 'Nexus sends no Meta batch request yet: no Nexus change needs one, and Meta runs a batch\'s parts one by one (some can succeed while others fail; on a timeout the unfinished ones come back empty), so each change goes as its own request'
      : 'Nexus sends no Meta async batch yet: no Nexus change needs one, and Meta runs each of its requests on its own (not all or nothing), so each change goes as its own request'
    return detail ? `${why} (${detail})` : why
  }
  return null
}

/** The parts of a batch body, each judged as its own change (a write), or why the body is not one. */
function batchParts(kind: MetaBatchKind, body: unknown): { problems: string[] } | { problem: string } {
  if (typeof body !== 'string') return { problem: 'the batch has no form body' }
  const form = new URLSearchParams(body)
  const listKey = kind === 'graph-batch' ? 'batch' : 'adbatch'
  const raw = form.get(listKey)
  if (raw === null) return { problem: `it names no ${listKey}` }
  let list: unknown
  try { list = JSON.parse(raw) } catch { return { problem: `${listKey} is not JSON` } }
  if (!Array.isArray(list) || list.length === 0) return { problem: `${listKey} is not a list of requests` }
  if (list.length > MAX_BATCH_PARTS[kind]) return { problem: `Meta takes at most ${MAX_BATCH_PARTS[kind]} requests in one ${kind}` }
  const problems: string[] = []
  list.forEach((part, i) => {
    const p = (part && typeof part === 'object' ? part : {}) as Record<string, unknown>
    const where = `part ${i + 1}`
    const relative = typeof p.relative_url === 'string' ? p.relative_url : ''
    const partBody = typeof p.body === 'string' ? p.body : ''
    if (/\{result=/.test(relative) || /\{result=/.test(partBody)) { problems.push(`${where} depends on another part's result`); return }
    if (p.attached_files !== undefined) { problems.push(`${where} attaches a file`); return }
    const path = relative.replace(/^\/+/, '').replace(/^v\d+\.\d+\//, '')
    if (metaBatchKindOf('POST', path.split('?')[0].toLowerCase()) !== null) { problems.push(`${where} is a batch inside a batch`); return }
    const method = kind === 'async-batch' ? 'POST' : typeof p.method === 'string' ? p.method : 'GET'
    const verdict = metaWriteVerdict({ method, url: `https://${META_GRAPH_HOST}/${metaGraphApiVersion()}/${path}`, kind: 'write', body: partBody })
    if ('problem' in verdict) problems.push(`${where}: ${verdict.problem}`)
  })
  return { problems }
}
