/**
 * Meta ads, step 6 (2026-10-21) — the DETAILED live reads of the chosen ad account's campaigns, ad sets, ads, creatives,
 * labels and value rule sets (GET only, through the gateway). meta-ads-live (step 2) lists campaigns, ad sets and ads with a
 * short field set and numbers inline; these read every field of ONE object and the edges around it. Nothing here stores
 * anything, and nothing here reads another business's assets: every id a caller names is checked to be the chosen ad
 * account's own (Nexus's rows, else one live account_id read — live.ts objectInAccount), or found in the chosen account's
 * own list (labels, value rule sets, budget schedules, async creative jobs) before it is read.
 *
 * Fields are FIXED lists per node type (the lesson of steps 1–2: allow-lists only); a caller never names a Graph field or
 * path. Fields Meta's v26 reference does not list (seen only on a guide, a changelog or in Meta's SDK) are asked in their
 * own group: when Meta refuses the whole read, each group is read alone and the answer names what Meta refused, in Meta's
 * own words (readGroups / listGroups).
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md, and Meta's
 * Python Business SDK, facebook_business/adobjects/<node>.py on GitHub main):
 *   - ad-campaign-group (campaign): fields id … updated_time, edges ad_studies, adrules_governed, ads, adsets, copies;
 *     no `recommendations` and no `advantage_state_info` field (the latter only on marketing-api/advantage-campaigns:
 *     read-only, ADVANTAGE_PLUS_SALES / _APP / _LEADS or DISABLED + budget / audience / placement states); `updated_time`
 *     "will not automatically update" on spend_cap or budget edits; start_time / stop_time are read only on a campaign
 *     ("You can setup start_time at the ad set level"). Legacy Advantage+ shopping (smart_promotion_type
 *     AUTOMATED_SHOPPING_ADS) is read only since v25 (marketing-api-changelog/version25.0).
 *   - ad-campaign (ad set): fields incl. learning_stage_info, targeting_optimization_types, recommendations ("Otherwise,
 *     will not be included"), review_feedback (dynamic creative), bid_adjustments, value_rule_set_id; edges ad_studies,
 *     adrules_governed, asyncadrequests (statuses), budget_schedules (time_start, time_stop), copies (effective_status,
 *     is_completed), delivery_stats (bid_recommendation_type LOWEST_COST_TO_COST_CAP, groups), targeting_insights (no
 *     params), campaign_actions (no params; "Actionable Insights … Ad Proposals").
 *   - adgroup (ad): fields incl. ad_review_feedback (param review_feedback_breakdown), failed_delivery_checks, issues_info,
 *     recommendations, creative_asset_groups_spec; `preview_shareable_link` is a public link and is NEVER asked.
 *     graph-api/reference/adgroup/facebook_feedback: param dynamic_post, "feedback objects with a preview link and a list
 *     of related comments" — Nexus asks its id only (comments are people's words: the comments lane reads them).
 *   - ad-creative: fields incl. object_story_spec{whats_app_business_phone_number} (only when asked by that name),
 *     degrees_of_freedom_spec, format_transformation_spec, params thumbnail_width / _height; `destination_spec` (changelog
 *     v24.0) and `instagram_branded_content` are not on the v26 field list, wamo_whatsapp_identity_spec is gated (v26
 *     changelog) and threads_user_id (creative), contextual_bundling_spec (ad set), is_autobid (ad) are not in Meta's SDK
 *     v26: each its own group (review B F1, F2).
 *   - kinds: services/meta/meta-kinds.ts (the one table; live.ts objectInAccount reads it).
 *   - ad-label: fields id, created_time, name, updated_time; account edges campaignsbylabels / adsetsbylabels /
 *     adsbylabels / adcreativesbylabels (ad_label_ids, operator ALL | ANY; SDK adaccount.py); label edges adcreatives,
 *     ads, adsets, campaigns (no params).
 *   - high-demand-period: fields id, budget_value, budget_value_type, recurrence_type, time_start, time_end (SDK adds
 *     ad_object_id, weekly_schedule); budget_value "140 could be $140 or 140%" — its unit for ABSOLUTE is UNVERIFIED.
 *   - bidding/value-rules: GET act_<id>/value_rule_set?fields=name,rules{name,adjust_sign,adjust_value,status,criterias}
 *     (SDK: product_type AUDIENCE | LEADGEN_ADS | OMNI_CHANNEL, status ACTIVE | DELETED | DRAFT); ≤ 6 rule sets.
 *   - ad-account/insights: deduping_ratio, deduping_1st…3rd_source_ratio, auction_bid, auction_competitiveness,
 *     auction_max_competitor_bid, wish_bid, creative_fatigue_summary, creative_fatigued_ads, creative_diversity_*; NO
 *     quality / engagement-rate / conversion-rate ranking (asked in their own group; Meta's own answer decides).
 *   - ad-account/suggested_ads (Ad nodes), smart_suggested_ads (undocumented nodes), addrafts (AdDraft nodes),
 *     asyncadcreatives (is_completed), max_bid (SDK only: AdAccountMaxBid.max_bid), custom-audience/ads (there is no
 *     /{audience}/adsets edge), product-catalog/categories (categorization_criteria BRAND | CATEGORY | PRODUCT_TYPE),
 *     audiences/reference/targeting-search (type=adlocale, q).
 */
import { metaAdAccountId, metaObjectId, AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { graphSafe, metaChosenAccount, MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { AD_STATUSES_READ, ADSET_STATUSES_READ, CAMPAIGN_STATUSES_READ, purchasesOf } from './mappers.js'
import { decimalToMicros, metaUnitsToMicros, minorOf } from './money.js'
import { takenIds } from './taken.js'

type Row = Record<string, unknown>
export type ObjectKind = 'campaign' | 'adset' | 'ad' | 'creative'
const KIND_WORDS: Readonly<Record<ObjectKind, string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad', creative: 'creative' }

const act = (id: string) => `act_${id}`
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
/** A Graph list field: an array, or an edge `{ data: [...] }`. */
const rowsOf = (v: unknown): Row[] => {
  const list = Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]) : []
  return list.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r))
}
/** Meta's spec, as it sent it, without paging links or tokens (graphSafe). */
const spec = (v: unknown): unknown => (v === undefined || v === null ? null : graphSafe(v))
/** A Meta offset-unit amount (budget, bid, spend cap) → minor units of the account currency. */
const cents = (v: unknown, currency: string | null): number | null => minorOf(metaUnitsToMicros(v, currency), currency)
/** Meta writes this sentinel to mean "no cap" on spend caps (F1 X4). */
const NO_CAP = '922337203685478'
const capCents = (v: unknown, currency: string | null): number | null => (String(v ?? '') === NO_CAP ? null : cents(v, currency))

// ── statuses in words (master AD-008, CMP-001, AS-001) ──────────────────────────────────────────────────────────────

export const STATUS_WORDS: Readonly<Record<string, string>> = {
  ACTIVE: 'On (it delivers when its schedule, budget and review allow)',
  PAUSED: 'Paused',
  CAMPAIGN_PAUSED: 'Not delivering because its campaign is paused (its own status is unchanged)',
  ADSET_PAUSED: 'Not delivering because its ad set is paused (its own status is unchanged)',
  PENDING_REVIEW: 'In Meta\'s review (it goes back to the status it was given once approved)',
  DISAPPROVED: 'Rejected by Meta\'s review (see the review feedback)',
  PREAPPROVED: 'Approved before review finished',
  PENDING_BILLING_INFO: 'Waiting for a payment method on the ad account',
  IN_PROCESS: 'Being processed by Meta',
  WITH_ISSUES: 'Has a problem that stops delivery (see issues)',
  ARCHIVED: 'Archived (only its name can change; it can only be deleted)',
  DELETED: 'Deleted (final; readable by its own id only)',
}
const statusText = (v: unknown) => { const s = text(v); return s ? STATUS_WORDS[s] ?? s : null }

/** The statuses a list may be filtered by. DELETED never: Meta refuses a DELETED filter on an edge (F1 X3) — read it by id. */
export const CAMPAIGN_LIST_STATUSES = CAMPAIGN_STATUSES_READ
export const ADSET_LIST_STATUSES = ADSET_STATUSES_READ
export const AD_LIST_STATUSES = AD_STATUSES_READ

function statusFilter(asked: string[] | null | undefined, allowed: readonly string[], what: string): string[] {
  if (!asked?.length) return [...allowed]
  const upper = asked.map((s) => s.trim().toUpperCase())
  if (upper.includes('DELETED')) throw new MetaLiveRefusal(`Meta refuses a DELETED filter on a list (it errors): read a deleted ${what} by its own id.`)
  const unknown = upper.filter((s) => !allowed.includes(s))
  if (unknown.length) throw new MetaLiveRefusal(`${unknown.join(', ')} is not a status a ${what} list takes (${allowed.join(', ')}).`)
  return [...new Set(upper)]
}

// ── reads: one object in field groups, one list with paging ─────────────────────────────────────────────────────────

/** A group of fields, and the query keys that go only with it (the gateway lets them through only on a read naming its field). */
export interface FieldGroup { name: string; fields: string; query?: Record<string, MetaQueryValue> }
export interface MissingPart { part: string; sentence: string }

/**
 * Review fix A5 — Meta refused a FIELD it was asked: only then does asking for less help. Either a #100 ("nonexisting
 * field" and the like), or (re-review) a permission refusal FROM META (#3, #10, #200–#299) — a gated field (the WhatsApp
 * identity, learning stage, Instagram branded content) may be refused that way. Never on a lost token, a throttle, the
 * gateway, an object that is not there, a blocked account (#368), an account-wide insights refusal (100/3191001) or Meta
 * failing on its side (transient: no answer, a 5xx, a timeout). A refused core group still ends the read.
 */
export function fieldRefused(err: unknown): err is MetaReadError {
  if (!(err instanceof MetaReadError)) return false
  const f = err.failure
  if (f.origin !== 'meta' || f.authLost || f.throttled || f.notFound || f.transient || !f.code) return false
  if (f.permissionDenied) return /^(3|10|2\d\d)(\/|$)/.test(f.code)
  return /^100(\/|$)/.test(f.code)
}

/** A read of its own that adds to an answer (Advantage+ state, placements, …) failed: said in Meta's words, unless the token or a throttle ends the read. */
function partFailed(err: unknown): err is MetaReadError {
  return err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled
}

const groupQuery = (groups: FieldGroup[]) => Object.assign({}, ...groups.map((g) => g.query ?? {})) as Record<string, MetaQueryValue>

/**
 * One object, every group of fields in ONE call. When Meta refuses that call, each group is read alone: the first (the
 * object's own core) must answer, any other Meta refuses is named with Meta's sentence.
 */
export async function readGroups(connectionId: string, operation: string, path: string, groups: FieldGroup[], query: Record<string, MetaQueryValue> = {}): Promise<{ body: Row; missing: MissingPart[] }> {
  try {
    const read = await metaReadOne({ connectionId }, { operation, path, query: { ...query, ...groupQuery(groups), fields: groups.map((g) => g.fields).join(',') } })
    return { body: read.body as Row, missing: [] }
  } catch (err) {
    if (groups.length < 2 || !fieldRefused(err)) throw err
  }
  const body: Row = {}
  const missing: MissingPart[] = []
  for (const [i, group] of groups.entries()) {
    try {
      const read = await metaReadOne({ connectionId }, { operation: `${operation}.${group.name}`, path, query: { ...query, ...(group.query ?? {}), fields: group.fields } })
      Object.assign(body, read.body as Row)
    } catch (err) {
      if (i === 0 || !fieldRefused(err)) throw err
      missing.push({ part: group.name, sentence: err.failure.sentence })
    }
  }
  return { body, missing }
}

export const MAX_ROWS = 500

/**
 * A list, page by page (cursor `after`; Meta's next link carries the token and is never followed), with Meta's total.
 * `pageSize`: at most this many per call (step 14: Instagram answers at most 50 comments per call).
 */
export async function listPaged(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number, withTotal = false, pageSize = 100): Promise<{ rows: Row[]; more: boolean; totalCount: number | null }> {
  const max = Math.min(MAX_ROWS, Math.max(1, Math.trunc(maxRows)))
  const limit = Math.min(Math.max(1, Math.trunc(pageSize)), 100, max)
  const rows: Row[] = []
  let after: string | null = null
  let totalCount: number | null = null
  for (let page = 0; page < 50; page++) {
    const read = await metaReadOne<{ data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown }; summary?: { total_count?: unknown } }>({ connectionId }, {
      operation, path, query: { ...query, limit, ...(withTotal && !after ? { summary: 'total_count' } : {}), ...(after ? { after } : {}) },
    })
    if (page === 0) totalCount = num(read.body.summary?.total_count)
    rows.push(...rowsOf(read.body.data))
    const next = typeof read.body.paging?.cursors?.after === 'string' && read.body.paging?.next ? read.body.paging.cursors.after : null
    if (rows.length >= max || !next) return { rows: rows.slice(0, max), more: rows.length > max || (!!next && rows.length >= max), totalCount }
    after = next
  }
  return { rows: rows.slice(0, max), more: true, totalCount }
}

/** A list in field groups: when Meta refuses the full field list, the list is read with its core group only and says so. */
export async function listGroups(connectionId: string, operation: string, path: string, groups: FieldGroup[], query: Record<string, MetaQueryValue>, maxRows: number, withTotal = false) {
  try {
    return { ...(await listPaged(connectionId, operation, path, { ...query, fields: groups.map((g) => g.fields).join(',') }, maxRows, withTotal)), missing: [] as MissingPart[] }
  } catch (err) {
    if (groups.length < 2 || !fieldRefused(err)) throw err
    const sentence = err.failure.sentence
    const read = await listPaged(connectionId, `${operation}.core`, path, { ...query, fields: groups[0].fields }, maxRows, withTotal)
    return { ...read, missing: groups.slice(1).map((g) => ({ part: g.name, sentence: `Meta refused these details in a list (${sentence}); read one object for them.` })) }
  }
}

// ── ownership: only the chosen ad account's own objects ─────────────────────────────────────────────────────────────

/**
 * A campaign, ad set, ad or creative id from a caller, read only when it is the chosen account's own AND that kind (review
 * fix A1: live.ts objectInAccount, the one read-side check, on the one table of kinds — services/meta/meta-kinds.ts).
 */
export async function ownedId(account: MetaChosenAccount, id: string, kind: ObjectKind): Promise<string> {
  return objectInAccount(account, id, kind)
}

/** Pages and Instagram accounts an object names: ids only, each marked chosen here or another business's (never which). */
async function assetsOf(account: MetaChosenAccount, pageIds: unknown[], instagramIds: unknown[]) {
  const pages = [...new Set(pageIds.map(text).filter((id): id is string => !!id && /^\d+$/.test(id)))]
  const instagram = [...new Set(instagramIds.map(text).filter((id): id is string => !!id && /^\d+$/.test(id)))]
  const [takenPages, takenInstagram] = await Promise.all([takenIds('PAGE', pages), takenIds('INSTAGRAM', instagram)])
  return {
    pages: pages.map((id) => ({ pageId: id, chosenHere: id === account.pageId, takenByAnotherBusiness: takenPages.has(id) })),
    instagram: instagram.map((id) => ({ instagramId: id, chosenHere: id === account.instagramId, takenByAnotherBusiness: takenInstagram.has(id) })),
  }
}

// ── shared pieces of an answer ──────────────────────────────────────────────────────────────────────────────────────

const labelsOf = (v: unknown) => rowsOf(v).map((l) => ({ labelId: text(l.id), name: text(l.name) }))

/** issues_info (campaign, ad set, ad): Meta's code, words and `mid` (Meta's message id for a bug report: kept). */
const issuesOf = (v: unknown) => rowsOf(v).map((i) => ({
  level: text(i.level), errorCode: num(i.error_code), errorType: text(i.error_type), errorSummary: text(i.error_summary), errorMessage: text(i.error_message), mid: text(i.mid),
  // Since 2025-09-02 a flagged custom audience (2460003) or custom conversion (2460004) shows as a SOFT_ERROR: the flag
  // can only be appealed in Ads Manager / Events Manager.
  ...(num(i.error_code) === 2460003 || num(i.error_code) === 2460004 ? { note: 'A flagged custom audience or custom conversion: only an appeal in Ads Manager or Events Manager lifts it (no API).' } : {}),
}))

/** AdRecommendation (ad set and ad field; shape SDK-only): the words, and Meta's data under metaRaw (it may hold amounts). */
const recommendationsOf = (v: unknown) => rowsOf(v).map((r) => ({
  title: text(r.title), message: text(r.message), importance: text(r.importance), confidence: text(r.confidence), code: num(r.code), blameField: text(r.blame_field),
  metaRaw: spec({ recommendation_data: r.recommendation_data ?? null, value: r.value ?? null }),
}))

/** failed_delivery_checks: reading the field RUNS Meta's checks; an empty answer means every check passed. */
const checksOf = (v: unknown) => rowsOf(v).map((c) => ({ checkName: text(c.check_name), summary: text(c.summary), description: text(c.description) }))

const LEARNING_WORDS: Readonly<Record<string, string>> = {
  LEARNING: 'Still learning (results are less stable; a significant edit starts learning again)',
  SUCCESS: 'Out of learning',
  FAIL: 'Learning limited (not enough results to finish learning)',
}

// ── meta-campaigns ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Every field of the v26 campaign reference Nexus reads (CMP-002, CMP-003, CMP-030). */
export const CAMPAIGN_DETAIL_FIELDS = [
  'id', 'account_id', 'name', 'objective', 'buying_type', 'status', 'configured_status', 'effective_status',
  'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap', 'can_use_spend_cap', 'bid_strategy', 'pacing_type',
  'promoted_object', 'special_ad_categories', 'special_ad_category', 'special_ad_category_country', 'smart_promotion_type',
  'is_adset_budget_sharing_enabled', 'is_budget_schedule_enabled', 'last_budget_toggling_time', 'start_time', 'stop_time',
  'source_campaign_id', 'adlabels{id,name}', 'boosted_object_id', 'primary_attribution', 'topline_id', 'is_skadnetwork_attribution',
  'has_secondary_skadnetwork_reporting', 'is_reels_trending_ads_enabled', 'issues_info', 'created_time', 'updated_time',
].join(',')
/** CMP-004 — on the Advantage+ guide only (not the campaign reference): its own group. */
export const CAMPAIGN_ADVANTAGE_FIELDS = 'advantage_state_info'

/** Legacy Advantage+ shopping / app campaigns: read only since v25 (CMP-030). */
const LEGACY_SMART = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION'])

export function campaignOf(r: Row, currency: string | null) {
  const daily = cents(r.daily_budget, currency)
  const lifetime = cents(r.lifetime_budget, currency)
  const smart = text(r.smart_promotion_type)
  return {
    campaignId: text(r.id), name: text(r.name), objective: text(r.objective), buyingType: text(r.buying_type),
    status: text(r.status), configuredStatus: text(r.configured_status), effectiveStatus: text(r.effective_status), statusText: statusText(r.effective_status),
    budgetLevel: daily !== null || lifetime !== null ? 'campaign (Advantage+ campaign budget: Meta shares it across the ad sets)' : 'ad set (each ad set has its own budget)',
    dailyBudgetCents: daily, lifetimeBudgetCents: lifetime, budgetRemainingCents: cents(r.budget_remaining, currency), spendCapCents: capCents(r.spend_cap, currency),
    canUseSpendCap: bool(r.can_use_spend_cap), bidStrategy: text(r.bid_strategy), pacingType: spec(r.pacing_type), promotedObject: spec(r.promoted_object),
    specialAdCategories: spec(r.special_ad_categories), specialAdCategory: text(r.special_ad_category), specialAdCategoryCountry: spec(r.special_ad_category_country),
    smartPromotionType: smart, adSetBudgetSharing: bool(r.is_adset_budget_sharing_enabled), budgetScheduling: bool(r.is_budget_schedule_enabled),
    lastBudgetTogglingTime: text(r.last_budget_toggling_time), startTime: text(r.start_time), stopTime: text(r.stop_time),
    sourceCampaignId: text(r.source_campaign_id), labels: labelsOf(r.adlabels), boostedObjectId: text(r.boosted_object_id),
    primaryAttribution: text(r.primary_attribution), toplineId: text(r.topline_id), skadnetworkAttribution: bool(r.is_skadnetwork_attribution),
    secondarySkadnetworkReporting: bool(r.has_secondary_skadnetwork_reporting), reelsTrendingAds: bool(r.is_reels_trending_ads_enabled),
    issues: issuesOf(r.issues_info), createdTime: text(r.created_time), updatedTime: text(r.updated_time),
    ...(smart && LEGACY_SMART.has(smart) ? { legacy: 'A legacy Advantage+ shopping or app campaign: Meta refuses every edit, copy and creation of these since v25 (all versions since 2026-05-19); it keeps running as it is. Only Ads Manager\'s Duplicate (or Meta\'s migrate_to_advantage_plus for those Meta allows) makes a new-style one.' } : {}),
  }
}

const CAMPAIGN_NOTES = [
  'updatedTime does not move when a budget or spend cap changes (Meta): it is not a sign of what changed.',
  'A campaign\'s start and stop times are read only: Meta merges them from its ad sets — set them on the ad set.',
]

export async function campaignsList(input: { connectionId?: string | null; statuses?: string[] | null; completed?: boolean | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const read = await listGroups(account.connectionId, 'objects.campaigns', `${act(account.adAccountId)}/campaigns`, [{ name: 'core', fields: CAMPAIGN_DETAIL_FIELDS }], {
    effective_status: statusFilter(input.statuses, CAMPAIGN_LIST_STATUSES, 'campaign'), ...(typeof input.completed === 'boolean' ? { is_completed: input.completed } : {}),
  }, input.maxRows ?? 100, true)
  return { adAccountId: account.adAccountId, currency: account.currency, totalCount: read.totalCount, items: read.rows.map((r) => campaignOf(r, account.currency)), more: read.more, notes: CAMPAIGN_NOTES }
}

/** CMP-002, CMP-003, CMP-004, CMP-030, RC-006 (campaign): one campaign, its Advantage+ state and Meta's recommendations for it. */
export async function campaignDetail(input: { connectionId?: string | null; campaignId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.campaignId, 'campaign')
  const { body } = await readGroups(account.connectionId, 'objects.campaign', id, [{ name: 'core', fields: CAMPAIGN_DETAIL_FIELDS }])
  const campaign = campaignOf(body, account.currency)
  const promoted = obj(body.promoted_object)
  const assets = await assetsOf(account, [promoted?.page_id], [])
  // CMP-004 — read only, on the Advantage+ guide only: asked alone, so a refusal never costs the campaign's own read.
  let advantage: Row | null = null
  let advantageNote: string | null = null
  try {
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'objects.campaign.advantage', path: id, query: { fields: CAMPAIGN_ADVANTAGE_FIELDS } })
    const info = obj((read.body as Row).advantage_state_info)
    advantage = info ? {
      state: text(info.advantage_state), budget: text(info.advantage_budget_state), audience: text(info.advantage_audience_state), placement: text(info.advantage_placement_state),
      meaning: text(info.advantage_state) === 'DISABLED' ? 'Not an Advantage+ campaign: at least one of budget, audience or placement is not on Advantage+.' : 'An Advantage+ campaign (budget, audience and placements on Advantage+). An edit that breaks one of them turns Advantage+ off without a warning.',
    } : null
    if (!info) advantageNote = 'Meta sent no Advantage+ state for this campaign.'
  } catch (err) {
    if (!partFailed(err)) throw err
    advantageNote = `Meta did not answer the Advantage+ state: ${err.failure.sentence}`
  }
  // RC-006 — a campaign has no recommendations field on v26: the account's recommendations, filtered to this campaign.
  let recommendations: unknown[] | null = null
  let recommendationsNote: string | null = null
  try {
    const read = await listPaged(account.connectionId, 'objects.campaign.recommendations', `${act(account.adAccountId)}/recommendations`, {
      fields: 'recommendation_type,title,message,importance,blame_field,object_id,estimated_impact,recommendation_data',
      filtering: [{ field: 'object_id', operator: 'EQUAL', value: id }],
    }, 50)
    // Review B F4 — Meta's pages disagree on this read: the ad-recommendations webhook page queries these fields with an
    // object_id filter, as rows; Meta's SDK has the edge answer AdAccountRecommendations (a `recommendations` list per row)
    // and lists only recommendation_names / recommendation_stages as its parameters, no filtering. A row of either shape is
    // read; when Meta refuses the call, recommendationsNote says so (LIVE-PROBES RC-006, with GET /<campaign>?fields=recommendations).
    recommendations = read.rows.flatMap((r) => (Array.isArray(r.recommendations) ? rowsOf(r.recommendations) : [r])).filter((r) => text(r.object_id) === id).map((r) => ({
      type: text(r.recommendation_type), title: text(r.title), message: text(r.message), importance: text(r.importance), blameField: text(r.blame_field),
      metaRaw: spec({ estimated_impact: r.estimated_impact ?? null, recommendation_data: r.recommendation_data ?? null }),
    }))
  } catch (err) {
    if (!partFailed(err)) throw err
    recommendationsNote = `Meta did not answer recommendations for this campaign: ${err.failure.sentence}`
  }
  return {
    adAccountId: account.adAccountId, currency: account.currency, campaign, pages: assets.pages,
    advantage, ...(advantageNote ? { advantageNote } : {}),
    recommendations, ...(recommendationsNote ? { recommendationsNote } : {}),
    notes: [...CAMPAIGN_NOTES, 'Issues on a campaign hold for every ad set and ad under it; an ad set\'s own issues: meta-ad-sets view adset.'],
  }
}

/** CMP-007, AS-009 — the copies made from a campaign or an ad set (leftovers of a failed deep copy show here). */
export async function objectCopies(input: { connectionId?: string | null; kind: 'campaign' | 'adset'; id: string; statuses?: string[] | null; completed?: boolean | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const allowed = input.kind === 'campaign' ? CAMPAIGN_LIST_STATUSES : ADSET_LIST_STATUSES
  const fields = input.kind === 'campaign' ? 'id,name,status,effective_status,objective,source_campaign_id,created_time' : 'id,name,campaign_id,status,effective_status,source_adset_id,created_time'
  const read = await listPaged(account.connectionId, `objects.${input.kind}.copies`, `${id}/copies`, {
    fields, effective_status: statusFilter(input.statuses, allowed, KIND_WORDS[input.kind]), ...(typeof input.completed === 'boolean' ? { is_completed: input.completed } : {}),
  }, input.maxRows ?? 100)
  return {
    [input.kind === 'campaign' ? 'campaignId' : 'adSetId']: id,
    items: read.rows.map((r) => ({ id: text(r.id), name: text(r.name), campaignId: text(r.campaign_id), objective: text(r.objective), status: text(r.status), effectiveStatus: text(r.effective_status), statusText: statusText(r.effective_status), sourceId: text(r.source_campaign_id ?? r.source_adset_id), createdTime: text(r.created_time) })),
    more: read.more,
  }
}

/** CMP-008, AS-010 — the studies (A/B tests, lift studies) a campaign or ad set is in; the studies themselves: meta-experiments. */
export async function objectStudies(input: { connectionId?: string | null; kind: 'campaign' | 'adset'; id: string; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const read = await listPaged(account.connectionId, `objects.${input.kind}.studies`, `${id}/ad_studies`, { fields: 'id,name,type,start_time,end_time' }, input.maxRows ?? 100)
  return {
    id, kind: input.kind,
    items: read.rows.map((r) => ({ studyId: text(r.id), name: text(r.name), type: text(r.type), startTime: text(r.start_time), endTime: text(r.end_time) })),
    more: read.more, note: 'Each study\'s cells, objectives and results are read by the experiments tool (meta-experiments).',
  }
}

/** CMP-009, AS-011, AD-015 — Meta's automated rules that govern this object (by default: those that name it). */
export async function objectRules(input: { connectionId?: string | null; kind: 'campaign' | 'adset' | 'ad'; id: string; passEvaluation?: boolean | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const read = await listPaged(account.connectionId, `objects.${input.kind}.rules`, `${id}/adrules_governed`, {
    fields: 'id,name,status,created_time,updated_time', ...(typeof input.passEvaluation === 'boolean' ? { pass_evaluation: input.passEvaluation } : {}),
  }, input.maxRows ?? 100)
  return {
    id, kind: input.kind,
    items: read.rows.map((r) => ({ ruleId: text(r.id), name: text(r.name), status: text(r.status), createdTime: text(r.created_time), updatedTime: text(r.updated_time) })),
    more: read.more,
    note: 'By default Meta lists the rules that name this object by id or through its kind (entity_type); passEvaluation lists only those it currently passes (true) or fails (false). A rule\'s conditions and actions (they hold amounts): the rules tool (meta-ad-rules).',
  }
}

export const HDP_CORE = 'id,budget_value,budget_value_type,recurrence_type,time_start,time_end'
/** SDK-only fields of a high-demand period: their own group. */
const HDP_EXTRA = 'ad_object_id,weekly_schedule'
const HDP_NOTE = 'budgetValue is Meta\'s number as sent: an increase by an amount (ABSOLUTE; Meta does not document whether it is in whole currency units or the smallest unit — Nexus does not convert it) or by a multiplier (MULTIPLIER). Budget scheduling needs a daily budget, ≤ 50 periods, each ≥ 3 hours, at most 8× the daily budget. A schedule cannot be edited or deleted by API once made.'

const periodOf = (r: Row) => ({
  periodId: text(r.id), budgetValue: num(r.budget_value), budgetValueType: text(r.budget_value_type), recurrenceType: text(r.recurrence_type),
  timeStart: text(r.time_start), timeEnd: text(r.time_end), adObjectId: text(r.ad_object_id), weeklySchedule: spec(r.weekly_schedule),
})

/** CMP-014, AS-026 — the scheduled budget increases (high-demand periods) of a campaign or an ad set. */
export async function budgetSchedules(input: { connectionId?: string | null; kind: 'campaign' | 'adset'; id: string; from?: string | null; to?: string | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const window = { ...(input.from ? { time_start: input.from } : {}), ...(input.to ? { time_stop: input.to } : {}) }
  const read = await listGroups(account.connectionId, `objects.${input.kind}.budgetSchedules`, `${id}/budget_schedules`, [{ name: 'core', fields: HDP_CORE }, { name: 'sdk', fields: HDP_EXTRA }], window, input.maxRows ?? 100)
  return { id, kind: input.kind, items: read.rows.map(periodOf), more: read.more, missing: read.missing, note: HDP_NOTE }
}

/** CMP-015 — one high-demand period, read once it is found among its campaign's or ad set's own (ownership). */
export async function budgetSchedule(input: { connectionId?: string | null; kind: 'campaign' | 'adset'; id: string; periodId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const periodId = metaObjectId(input.periodId)
  if (!periodId) throw new MetaLiveRefusal(`"${input.periodId}" is not a Meta id (digits).`)
  const own = await listPaged(account.connectionId, `objects.${input.kind}.budgetSchedules`, `${id}/budget_schedules`, { fields: 'id' }, MAX_ROWS)
  if (!own.rows.some((r) => text(r.id) === periodId)) throw new MetaLiveRefusal(`That budget schedule is not one of this ${KIND_WORDS[input.kind]}'s, so it is not read.`)
  const { body, missing } = await readGroups(account.connectionId, 'objects.budgetSchedule', periodId, [{ name: 'core', fields: HDP_CORE }, { name: 'sdk', fields: HDP_EXTRA }])
  return { id, kind: input.kind, period: periodOf(body), missing, note: HDP_NOTE }
}

// ── meta-ad-sets ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every field of the v26 ad set reference Nexus reads (AS-002, AS-004, AS-099), in groups. */
export const ADSET_CORE_FIELDS = [
  'id', 'account_id', 'campaign_id', 'name', 'status', 'configured_status', 'effective_status', 'optimization_goal', 'optimization_sub_event',
  'billing_event', 'bid_strategy', 'bid_amount', 'bid_info', 'bid_constraints', 'bid_adjustments', 'daily_budget', 'lifetime_budget',
  'budget_remaining', 'daily_min_spend_target', 'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap', 'min_budget_spend_percentage',
  'recurring_budget_semantics', 'start_time', 'end_time', 'pacing_type', 'adset_schedule', 'frequency_control_specs', 'attribution_spec',
  'is_incremental_attribution_enabled', 'promoted_object', 'destination_type', 'targeting', 'targeting_optimization_types', 'dsa_payor',
  'dsa_beneficiary', 'regional_regulated_categories', 'regional_regulation_identities', 'ad_set_goal', 'is_dynamic_creative', 'creative_sequence',
  'time_based_ad_rotation_id_blocks', 'time_based_ad_rotation_intervals', 'asset_feed_id', 'instagram_user_id', 'value_rule_set_id',
  'rf_prediction_id', 'lifetime_imps', 'multi_optimization_goal_weight', 'campaign_attribution',
  'brand_safety_config', 'use_new_app_click', 'source_adset_id', 'adlabels{id,name}', 'issues_info', 'campaign_active_time', 'created_time', 'updated_time',
].join(',')
/** Review B F2 — on the v26 reference but not in Meta's SDK v26: its own group (LIVE-PROBES). */
const ADSET_BUNDLING_FIELDS = 'contextual_bundling_spec'
/** AS-003 — only for active ad sets, not dynamic creative; "Not all ad accounts are eligible": its own group. */
const ADSET_LEARNING_FIELDS = 'learning_stage_info'
/** AS-005, CR-439, RC-006 — review of a dynamic creative ad set's assets, and Meta's recommendations (only when present). */
const ADSET_REVIEW_FIELDS = 'review_feedback,recommendations'
/** TG-089 — where the ad set will really run: asked in a call of its own (it names targeting again). */
export const ADSET_PLACEMENT_FIELDS = 'targeting{effective_publisher_platforms,effective_facebook_positions,effective_instagram_positions,effective_messenger_positions,effective_threads_positions,effective_whatsapp_positions,effective_audience_network_positions,effective_device_platforms,effective_brand_safety_content_filter_levels}'

/** A short list row of an ad set (the list's own fields). */
export const ADSET_LIST_FIELDS = 'id,campaign_id,name,status,configured_status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,destination_type,is_dynamic_creative,value_rule_set_id,adlabels{id,name},issues_info,created_time,updated_time'

/**
 * Review B F5 — Meta writes a minimum-ROAS floor as ROAS × 10,000 (bid_constraints.roas_average_floor, range 100–10,000,000:
 * 0.01×–1000×; marketing-api/bidding/overview/bid-strategy). The ONE place it is read back as a plain ROAS (2.5 = 2.5×).
 */
export function roasFloorOf(bidConstraints: unknown): number | null {
  const n = num(obj(bidConstraints)?.roas_average_floor)
  return n === null ? null : n / 10_000
}

export function adSetOf(r: Row, currency: string | null) {
  const billing = text(r.billing_event)
  const bidInfo = obj(r.bid_info)
  return {
    adSetId: text(r.id), campaignId: text(r.campaign_id), name: text(r.name),
    status: text(r.status), configuredStatus: text(r.configured_status), effectiveStatus: text(r.effective_status), statusText: statusText(r.effective_status),
    optimizationGoal: text(r.optimization_goal), optimizationSubEvent: text(r.optimization_sub_event), billingEvent: billing, bidStrategy: text(r.bid_strategy),
    bidAmountCents: cents(r.bid_amount, currency),
    ...(r.bid_amount !== undefined ? { bidPer: billing === 'IMPRESSIONS' ? 'per 1,000 impressions (billing on impressions)' : 'per result (the optimisation goal)' } : {}),
    ...(bidInfo ? { bidInfoCents: Object.fromEntries(Object.entries(bidInfo).map(([k, v]) => [k, cents(v, currency)])) } : {}),
    bidConstraints: spec(r.bid_constraints), roasFloor: roasFloorOf(r.bid_constraints),
    dailyBudgetCents: cents(r.daily_budget, currency), lifetimeBudgetCents: cents(r.lifetime_budget, currency), budgetRemainingCents: cents(r.budget_remaining, currency),
    dailyMinSpendTargetCents: cents(r.daily_min_spend_target, currency), dailySpendCapCents: capCents(r.daily_spend_cap, currency),
    lifetimeMinSpendTargetCents: cents(r.lifetime_min_spend_target, currency), lifetimeSpendCapCents: capCents(r.lifetime_spend_cap, currency),
    minBudgetSpendPercentage: num(r.min_budget_spend_percentage), recurringBudgetSemantics: bool(r.recurring_budget_semantics),
    startTime: text(r.start_time), endTime: text(r.end_time), pacingType: spec(r.pacing_type), schedule: spec(r.adset_schedule),
    frequencyControl: spec(r.frequency_control_specs), attribution: spec(r.attribution_spec), incrementalAttribution: bool(r.is_incremental_attribution_enabled),
    promotedObject: spec(r.promoted_object), destinationType: text(r.destination_type), targeting: spec(r.targeting),
    dsaPayor: text(r.dsa_payor), dsaBeneficiary: text(r.dsa_beneficiary), regionalRegulatedCategories: spec(r.regional_regulated_categories),
    regionalRegulationIdentities: spec(r.regional_regulation_identities), goal: spec(r.ad_set_goal), dynamicCreative: bool(r.is_dynamic_creative),
    creativeSequence: spec(r.creative_sequence), adRotationIdBlocks: spec(r.time_based_ad_rotation_id_blocks), adRotationIntervals: spec(r.time_based_ad_rotation_intervals),
    assetFeedId: text(r.asset_feed_id), instagramUserId: text(r.instagram_user_id), valueRuleSetId: text(r.value_rule_set_id), reachFrequencyPredictionId: text(r.rf_prediction_id),
    lifetimeImpressions: num(r.lifetime_imps), multiOptimizationGoalWeight: text(r.multi_optimization_goal_weight), campaignAttribution: text(r.campaign_attribution),
    contextualBundling: spec(r.contextual_bundling_spec), brandSafety: spec(r.brand_safety_config), useNewAppClick: bool(r.use_new_app_click),
    sourceAdSetId: text(r.source_adset_id), labels: labelsOf(r.adlabels), issues: issuesOf(r.issues_info),
    campaignActiveTime: text(r.campaign_active_time), createdTime: text(r.created_time), updatedTime: text(r.updated_time),
  }
}

export async function adSetsList(input: { connectionId?: string | null; campaignId?: string | null; statuses?: string[] | null; completed?: boolean | null; changedSince?: number | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  // CMP-005 — one campaign's ad sets through Meta's own edge (checked to be the account's); never filtering on act_<id>/adsets.
  const campaignId = input.campaignId ? await ownedId(account, input.campaignId, 'campaign') : null
  if (campaignId && typeof input.changedSince === 'number') throw new MetaLiveRefusal('changedSince works on the ad account\'s whole list only (Meta documents updated_since there, not on a campaign\'s ad sets).')
  const read = await listGroups(account.connectionId, 'objects.adsets', campaignId ? `${campaignId}/adsets` : `${act(account.adAccountId)}/adsets`, [{ name: 'core', fields: ADSET_LIST_FIELDS }], {
    effective_status: statusFilter(input.statuses, ADSET_LIST_STATUSES, 'ad set'),
    ...(typeof input.completed === 'boolean' ? { is_completed: input.completed } : {}),
    ...(typeof input.changedSince === 'number' ? { updated_since: input.changedSince } : {}),
  }, input.maxRows ?? 100, true)
  return { adAccountId: account.adAccountId, currency: account.currency, campaignId, totalCount: read.totalCount, items: read.rows.map((r) => adSetOf(r, account.currency)), more: read.more }
}

/** AS-002, AS-003, AS-004, AS-005, AS-099, CR-439, RC-006, TG-089 — one ad set with every field, learning, review and placements. */
export async function adSetDetail(input: { connectionId?: string | null; adSetId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adSetId, 'adset')
  const { body, missing } = await readGroups(account.connectionId, 'objects.adset', id, [
    { name: 'core', fields: ADSET_CORE_FIELDS }, { name: 'learning', fields: ADSET_LEARNING_FIELDS }, { name: 'review', fields: ADSET_REVIEW_FIELDS },
    { name: 'contextualBundling', fields: ADSET_BUNDLING_FIELDS },
  ])
  let placements: Row | null = null
  try {
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'objects.adset.placements', path: id, query: { fields: ADSET_PLACEMENT_FIELDS } })
    const t = obj((read.body as Row).targeting)
    placements = t ? Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('effective_')).map(([k, v]) => [k.replace(/^effective_/, '').replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), spec(v)])) : null
  } catch (err) {
    if (!partFailed(err)) throw err
    missing.push({ part: 'placements', sentence: err.failure.sentence })
  }
  const learning = obj(body.learning_stage_info)
  const review = body.review_feedback
  const promoted = obj(body.promoted_object)
  const assets = await assetsOf(account, [promoted?.page_id], [body.instagram_user_id])
  return {
    adAccountId: account.adAccountId, currency: account.currency,
    adSet: adSetOf(body, account.currency),
    learning: learning ? { status: text(learning.status), statusText: LEARNING_WORDS[text(learning.status) ?? ''] ?? text(learning.status), conversions: num(learning.conversions), lastSignificantEditTime: text(learning.last_sig_edit_ts), detail: spec(learning) } : null,
    relaxedTargeting: rowsOf(body.targeting_optimization_types).map((kv) => ({ key: text(kv.key), relaxed: num(kv.value) === 1 })),
    placements,
    reviewFeedback: review === undefined ? null : spec(review),
    recommendations: recommendationsOf(body.recommendations),
    legacyBidMultipliers: spec(body.bid_adjustments),
    pages: assets.pages, instagram: assets.instagram,
    missing,
    notes: [
      'learning: Meta answers it only for an active ad set that is not dynamic creative, and not for every ad account. A significant edit (budget, bid, targeting, optimisation goal) starts learning again.',
      'relaxedTargeting: where Meta widened the targeting as a signal. Since v13 lookalike expansion stays on for value, conversion and app-event optimisation, and Meta enforces detailed-targeting expansion for many goals.',
      'reviewFeedback: per asset of a dynamic creative ad set; an empty list means it passed review. recommendations: Meta sends them only when it has some.',
      'legacyBidMultipliers: the old bid_adjustments (age, page types, user groups); value rules replace them (meta-value-rules, valueRuleSetId).',
      'placements: where the ad set will really run after Meta\'s own choices (effective positions).',
    ],
  }
}

/** AD-014, AS-012 (and CMP-010) — Ads Manager drafts (unpublished edits) of the account, a campaign, an ad set or an ad. */
export async function objectDrafts(input: { connectionId?: string | null; kind: 'account' | 'campaign' | 'adset' | 'ad'; id?: string | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  let path = `${act(account.adAccountId)}/addrafts`
  if (input.kind !== 'account') {
    if (!input.id) throw new MetaLiveRefusal(`Name the ${KIND_WORDS[input.kind]} whose drafts to read.`)
    path = `${await ownedId(account, input.id, input.kind)}/addrafts`
  }
  // AdDraft's fields are SDK-only (the edge pages list none): id and name first, the rest in their own group. No author
  // or creator id: those are people.
  const read = await listGroups(account.connectionId, `objects.${input.kind}.drafts`, path, [{ name: 'core', fields: 'id,name' }, { name: 'sdk', fields: 'state,publish_status,is_active,time_created,time_updated' }], {}, input.maxRows ?? 100)
  return {
    kind: input.kind, id: input.kind === 'account' ? account.adAccountId : metaObjectId(input.id),
    items: read.rows.map((r) => ({ draftId: text(r.id), name: text(r.name), state: text(r.state), publishStatus: text(r.publish_status), isActive: bool(r.is_active), timeCreated: text(r.time_created), timeUpdated: text(r.time_updated) })),
    more: read.more, missing: read.missing,
    note: 'Ads Manager drafts: edits a person started in Ads Manager and has not published. Meta lets an API read them, never make or publish them (Ads Manager only). A draft waiting on an object means someone may publish over Nexus\'s change.',
  }
}

/** AS-013 — the background (async) ad requests of an ad set. */
export const ASYNC_REQUEST_STATUSES = ['INITIAL', 'IN_PROGRESS', 'SUCCESS', 'ERROR', 'CANCELED', 'PENDING_DEPENDENCY', 'CANCELED_DEPENDENCY', 'ERROR_DEPENDENCY', 'ERROR_CONFLICTS', 'USER_CANCELED', 'USER_CANCELED_DEPENDENCY', 'PROCESS_BY_EVENT_PROCESSOR', 'PROCESS_BY_AD_ASYNC_ENGINE'] as const

export async function adSetAsyncRequests(input: { connectionId?: string | null; adSetId: string; statuses?: string[] | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adSetId, 'adset')
  const read = await listPaged(account.connectionId, 'objects.adset.asyncRequests', `${id}/asyncadrequests`, {
    fields: 'id,status,type,scope_object_id,created_time,updated_time,result', ...(input.statuses?.length ? { statuses: input.statuses } : {}),
  }, input.maxRows ?? 100)
  return { adSetId: id, items: read.rows.map((r) => ({ requestId: text(r.id), status: text(r.status), type: text(r.type), scopeObjectId: text(r.scope_object_id), createdTime: text(r.created_time), updatedTime: text(r.updated_time), result: spec(r.result) })), more: read.more }
}

/** SDK-only fields of AdCampaignDeliveryStats (the edge page lists none). */
const DELIVERY_STATS_FIELDS = 'learning_stage_info,learning_stage_exit_info,last_significant_edit_ts,unsupported_features,bid_recommendation,current_average_cost'

/** AS-015, RC-030 — Meta's delivery stats for an ad set, and its bid recommendation (switch lowest cost → cost cap). */
export async function adSetDeliveryStats(input: { connectionId?: string | null; adSetId: string; bidRecommendation?: boolean }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adSetId, 'adset')
  const query: Record<string, MetaQueryValue> = {
    groups: ['LEARNING_STAGE_COMMON_INFO', 'LEARNING_STAGE_EXIT', 'UNSUPPORTED_FEATURES', ...(input.bidRecommendation ? ['BIDDING_RECOMMENDATIONS'] : [])],
    ...(input.bidRecommendation ? { bid_recommendation_type: 'LOWEST_COST_TO_COST_CAP' } : {}),
  }
  let rows: Row[]
  let shape = 'named'
  try {
    rows = (await listPaged(account.connectionId, 'objects.adset.deliveryStats', `${id}/delivery_stats`, { ...query, fields: DELIVERY_STATS_FIELDS }, 10)).rows
  } catch (err) {
    if (!fieldRefused(err)) throw err
    // The fields are SDK-only: Meta's own default answer, as it is.
    rows = (await listPaged(account.connectionId, 'objects.adset.deliveryStats.default', `${id}/delivery_stats`, query, 10)).rows
    shape = 'meta-default'
  }
  return {
    adSetId: id, shape,
    items: rows.map((r) => (shape === 'named' ? {
      lastSignificantEditTime: text(r.last_significant_edit_ts), unsupportedFeatures: spec(r.unsupported_features),
      bidRecommendation: spec(r.bid_recommendation), currentAverageCost: spec(r.current_average_cost),
      // Review fix A6 — shapes known only from Meta's SDK (they may name amounts): under metaRaw.
      metaRaw: spec({ learning_stage_info: r.learning_stage_info ?? null, learning_stage_exit_info: r.learning_stage_exit_info ?? null }),
    } : { metaRaw: spec(r) })),
    note: 'Meta documents the request, not the answer (its fields are known only from Meta\'s SDK). bidRecommendation and currentAverageCost are Meta\'s amounts as sent (unit not documented). Acting on a bid recommendation is a bid change (it can spend more).',
  }
}

/** IN-088 — Meta's targeting insights for an ad set (content known only from Meta's SDK). */
export async function adSetTargetingInsights(input: { connectionId?: string | null; adSetId: string; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adSetId, 'adset')
  const read = await listGroups(account.connectionId, 'objects.adset.targetingInsights', `${id}/targeting_insights`, [
    { name: 'core', fields: 'id,name,type,description,audience_size,impressions,clicks,conversions' }, { name: 'money', fields: 'spend,revenue,conversion_cost' },
  ], {}, input.maxRows ?? 100)
  return {
    adSetId: id,
    items: read.rows.map((r) => ({
      id: text(r.id), name: text(r.name), type: text(r.type), description: text(r.description), audienceSize: num(r.audience_size),
      impressions: num(r.impressions), clicks: num(r.clicks), conversions: num(r.conversions),
      spendMeta: r.spend ?? null, revenueMeta: r.revenue ?? null, conversionCostMeta: r.conversion_cost ?? null,
    })),
    more: read.more, missing: read.missing,
    note: 'Meta does not document what this answers (fields from Meta\'s SDK). spendMeta, revenueMeta and conversionCostMeta are Meta\'s numbers as sent (unit not documented). Insights with breakdowns: the numbers tool (meta-ads-numbers) or meta-ads-live view insights.',
  }
}

/** RC-031 — Meta's "actionable insights" (ad proposals) for an ad set: undocumented, Meta's answer as it is. */
export async function adSetActionableInsights(input: { connectionId?: string | null; adSetId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adSetId, 'adset')
  const read = await listPaged(account.connectionId, 'objects.adset.campaignActions', `${id}/campaign_actions`, {}, 50)
  return { adSetId: id, items: read.rows.map((r) => ({ metaRaw: spec(r) })), more: read.more, note: 'Meta calls these "Actionable Insights … delivered in form of Ad Proposals" and documents nothing more: Meta\'s answer as it is (it may name amounts). Acting on one is a change tool\'s, with a person\'s approval.' }
}

/**
 * AS-021 (corrected by the re-check: there is NO /{audience}/adsets edge) — the ads that use a custom audience, grouped by
 * ad set. The audience must be the chosen account's own; an ad of another ad account is left out.
 */
export async function audienceAdSets(input: { connectionId?: string | null; audienceId: string; statuses?: string[] | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  // Review fix A1 — a custom audience of the chosen account (account_id and two fields only an audience has); an audience
  // shared from another ad account names that account, so it is refused here.
  const audienceId = await objectInAccount(account, input.audienceId, 'customaudience')
  const read = await listPaged(account.connectionId, 'objects.audience.ads', `${audienceId}/ads`, {
    fields: 'id,name,account_id,campaign_id,adset_id,effective_status,adset{id,name,effective_status}', effective_status: statusFilter(input.statuses, AD_LIST_STATUSES, 'ad'),
  }, input.maxRows ?? 500)
  const own = read.rows.filter((r) => metaAdAccountId(r.account_id) === account.adAccountId)
  const byAdSet = new Map<string, { adSetId: string; name: string | null; effectiveStatus: string | null; campaignId: string | null; ads: Array<{ adId: string | null; name: string | null; effectiveStatus: string | null }> }>()
  for (const r of own) {
    const adSet = obj(r.adset)
    const adSetId = text(r.adset_id) ?? text(adSet?.id) ?? 'unknown'
    const entry = byAdSet.get(adSetId) ?? { adSetId, name: text(adSet?.name), effectiveStatus: text(adSet?.effective_status), campaignId: text(r.campaign_id), ads: [] }
    entry.ads.push({ adId: text(r.id), name: text(r.name), effectiveStatus: text(r.effective_status) })
    byAdSet.set(adSetId, entry)
  }
  return {
    audienceId, adSets: [...byAdSet.values()], adsRead: own.length, more: read.more,
    note: 'Meta lists the ads that use an audience (not its ad sets): Nexus groups them by ad set. Deleting or unsharing the audience stops these ads for good.',
  }
}

/** AS-029 — the ad account's maximum bid (SDK only: Meta's docs have no page for it). */
export async function accountMaxBid(input: { connectionId?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const read = await listPaged(account.connectionId, 'objects.account.maxBid', `${act(account.adAccountId)}/max_bid`, { fields: 'max_bid' }, 5)
  return { adAccountId: account.adAccountId, currency: account.currency, maxBid: read.rows.length ? (read.rows[0].max_bid ?? null) : null, note: 'Meta\'s number as sent (known only from Meta\'s SDK; unit not documented, likely the currency\'s smallest unit like bid_amount). A bid above it is refused by Meta.' }
}

// ── meta-ad-details ─────────────────────────────────────────────────────────────────────────────────────────────────

/** An ad's creative, as far as a list or an ad needs it (CR-219, CR-429, CR-442). */
const AD_CREATIVE_NESTED = 'creative{id,name,status,object_type,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,media_sourcing_spec,asset_feed_spec}'
/** Every field of the v26 ad reference Nexus reads (AD-004, AD-006, AD-008); never preview_shareable_link (a public link). */
export const AD_CORE_FIELDS = [
  'id', 'account_id', 'campaign_id', 'adset_id', 'name', 'status', 'configured_status', 'effective_status', AD_CREATIVE_NESTED, 'adset{destination_type}',
  'ad_active_time', 'ad_schedule_start_time', 'ad_schedule_end_time', 'adlabels{id,name}', 'conversion_domain', 'tracking_specs', 'conversion_specs',
  'tracking_and_conversion_with_defaults', 'display_sequence', 'priority', 'engagement_audience', 'source_ad_id', 'last_updated_by_app_id',
  'special_ad_categories', 'targeting', 'bid_amount', 'bid_info', 'bid_type', 'issues_info', 'created_time', 'updated_time',
].join(',')
/**
 * AD-005 (review_feedback_breakdown=true goes only with ad_review_feedback: the gateway lets it through only there), AD-007
 * (reading runs the checks), AD-009, CR-431; is_autobid is on the v26 reference but not in Meta's SDK v26 (review B F2).
 */
const AD_GROUPS: FieldGroup[] = [
  { name: 'core', fields: AD_CORE_FIELDS }, { name: 'review', fields: 'ad_review_feedback', query: { review_feedback_breakdown: true } },
  { name: 'checks', fields: 'failed_delivery_checks' }, { name: 'recommendations', fields: 'recommendations' },
  { name: 'flexibleFormat', fields: 'creative_asset_groups_spec' }, { name: 'autobid', fields: 'is_autobid' },
]
export const AD_LIST_FIELDS = `id,account_id,campaign_id,adset_id,name,status,configured_status,effective_status,${AD_CREATIVE_NESTED.replace(',media_sourcing_spec,asset_feed_spec', '')},issues_info,adlabels{id,name},ad_active_time,source_ad_id,last_updated_by_app_id,created_time,updated_time`

function adOf(r: Row, currency: string | null) {
  const creative = obj(r.creative)
  return {
    adId: text(r.id), campaignId: text(r.campaign_id), adSetId: text(r.adset_id), name: text(r.name),
    status: text(r.status), configuredStatus: text(r.configured_status), effectiveStatus: text(r.effective_status), statusText: statusText(r.effective_status),
    creative: creative ? {
      creativeId: text(creative.id), name: text(creative.name), status: text(creative.status), objectType: text(creative.object_type),
      effectiveObjectStoryId: text(creative.effective_object_story_id), instagramMediaId: text(creative.effective_instagram_media_id), instagramPermalink: text(creative.instagram_permalink_url),
      ...(creative.media_sourcing_spec !== undefined ? { mediaSourcing: spec(creative.media_sourcing_spec) } : {}),
    } : null,
    issues: issuesOf(r.issues_info), labels: labelsOf(r.adlabels), activeTime: text(r.ad_active_time), scheduleStart: text(r.ad_schedule_start_time), scheduleEnd: text(r.ad_schedule_end_time),
    conversionDomain: text(r.conversion_domain), trackingSpecs: spec(r.tracking_specs), conversionSpecs: spec(r.conversion_specs), trackingWithDefaults: spec(r.tracking_and_conversion_with_defaults),
    displaySequence: num(r.display_sequence), priority: num(r.priority), engagementAudience: bool(r.engagement_audience), sourceAdId: text(r.source_ad_id),
    lastUpdatedByAppId: text(r.last_updated_by_app_id), specialAdCategories: spec(r.special_ad_categories), targeting: r.targeting === undefined ? undefined : spec(r.targeting),
    bidAmountCents: cents(r.bid_amount, currency), ...(obj(r.bid_info) ? { bidInfoCents: Object.fromEntries(Object.entries(obj(r.bid_info)!).map(([k, v]) => [k, cents(v, currency)])) } : {}),
    bidType: text(r.bid_type), autoBid: bool(r.is_autobid), createdTime: text(r.created_time), updatedTime: text(r.updated_time),
  }
}

/** AD-001, AD-002, AD-003, CR-007, CR-442 — the account's, a campaign's or an ad set's ads; or the ads that use one creative. */
export async function adsList(input: { connectionId?: string | null; campaignId?: string | null; adSetId?: string | null; creativeId?: string | null; statuses?: string[] | null; changedSince?: number | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const adSetId = input.adSetId ? await ownedId(account, input.adSetId, 'adset') : null
  const campaignId = !adSetId && input.campaignId ? await ownedId(account, input.campaignId, 'campaign') : null
  const creativeId = input.creativeId ? await ownedId(account, input.creativeId, 'creative') : null
  const path = adSetId ? `${adSetId}/ads` : campaignId ? `${campaignId}/ads` : `${act(account.adAccountId)}/ads`
  // CR-007 — Meta's filter `creative.id` on act_<id>/ads is on no docs page (the gateway sends no `filtering` there): the
  // ads are read and kept when they use the creative, and the answer says how many were looked at.
  const read = await listGroups(account.connectionId, 'objects.ads', path, [{ name: 'core', fields: AD_LIST_FIELDS }], {
    effective_status: statusFilter(input.statuses, AD_LIST_STATUSES, 'ad'), ...(typeof input.changedSince === 'number' ? { updated_since: input.changedSince } : {}),
  }, input.maxRows ?? (creativeId ? MAX_ROWS : 100), !creativeId)
  // Review fix A1 — only the chosen account's own ads, whatever an edge answers (AD_LIST_FIELDS asks account_id).
  const own = read.rows.filter((r) => metaAdAccountId(r.account_id) === account.adAccountId)
  const rows = creativeId ? own.filter((r) => text(obj(r.creative)?.id) === creativeId) : own
  return {
    adAccountId: account.adAccountId, currency: account.currency, campaignId, adSetId, creativeId, totalCount: creativeId ? null : read.totalCount,
    items: rows.map((r) => adOf(r, account.currency)), more: read.more,
    ...(creativeId ? { adsLookedAt: read.rows.length, note: read.more ? 'More ads exist than were looked at: name the campaign or ad set to look at all of them.' : 'Every ad of this list was looked at.' } : {}),
    notes: ['Archived ads are in the list by default (every status but DELETED); statuses narrows it. Deleted ads are never in a list (Meta refuses a DELETED filter) — read one by its id (view ad).', 'Numbers inline: meta-ads-live view ads.'],
  }
}

/** AD-004 … AD-009, CR-219, CR-429, CR-431, RC-006 — one ad with every field, review per platform, checks, issues, recommendations. */
export async function adDetail(input: { connectionId?: string | null; adId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adId, 'ad')
  const { body, missing } = await readGroups(account.connectionId, 'objects.ad', id, AD_GROUPS)
  const creative = obj(body.creative)
  const destination = text(obj(body.adset)?.destination_type)
  const feed = obj(creative?.asset_feed_spec)
  const checks = body.failed_delivery_checks
  return {
    adAccountId: account.adAccountId, currency: account.currency,
    ad: adOf(body, account.currency),
    review: body.ad_review_feedback === undefined ? null : spec(body.ad_review_feedback),
    failedDeliveryChecks: missing.some((m) => m.part === 'checks') ? null : checksOf(checks),
    recommendations: recommendationsOf(body.recommendations),
    flexibleFormatGroups: body.creative_asset_groups_spec === undefined ? null : spec(body.creative_asset_groups_spec),
    // CR-219 — both must hold: the ad set sends to a website (or names no destination) and the creative's asset feed has
    // message extensions.
    websiteToMessage: (!destination || destination === 'WEBSITE' || destination === 'UNDEFINED') && !!feed && feed.message_extensions !== undefined && feed.message_extensions !== null,
    adSetDestination: destination,
    missing,
    notes: [
      'review: Meta\'s reasons, overall (global) and per platform (placement_specific); Meta does not document the list of reasons, so its words are shown as they are.',
      'failedDeliveryChecks: reading them makes Meta run its checks now (Page, mobile, blocked link, custom audiences, logged-out); none listed means every check passed.',
      'statusText tells apart an ad paused by its campaign or ad set (its own status unchanged), in review, rejected and waiting for a payment method.',
      'A new ad is in review first and then takes the status it was given; a paused ad stays paused after review.',
    ],
  }
}

/** Creative fields of the v26 reference Nexus reads (CR-002, CR-220 apart, CR-248, CR-270, CR-306, CR-336, CR-402, CR-424, CR-437). */
export const CREATIVE_CORE_FIELDS = [
  'id', 'account_id', 'name', 'status', 'object_type', 'actor_id', 'instagram_user_id', 'object_story_spec', 'object_story_id',
  'effective_object_story_id', 'effective_instagram_media_id', 'source_instagram_media_id', 'source_facebook_post_id', 'instagram_permalink_url',
  'asset_feed_spec', 'degrees_of_freedom_spec', 'media_sourcing_spec', 'format_transformation_spec', 'contextual_multi_ads', 'creative_sourcing_spec',
  'generative_asset_spec', 'url_tags', 'call_to_action_type', 'call_to_action', 'body', 'title', 'link_url', 'object_url', 'image_hash', 'image_url',
  'video_id', 'thumbnail_url', 'authorization_category', 'effective_authorization_category', 'branded_content', 'branded_content_sponsor_page_id',
  'facebook_branded_content', 'platform_customizations', 'portrait_customizations', 'ad_disclaimer_spec', 'product_set_id', 'product_data',
  'messenger_sponsored_message', 'interactive_components_spec', 'page_welcome_message', 'template_url_spec',
  'recommender_settings', 'applink_treatment', 'categorization_criteria', 'place_page_set_id', 'adlabels{id,name}',
].join(',')
/** Not on the v26 creative field list: CR-269 (changelog v24) and CR-336 — their own groups. */
const CREATIVE_GROUPS: FieldGroup[] = [
  { name: 'core', fields: CREATIVE_CORE_FIELDS }, { name: 'destination', fields: 'destination_spec' }, { name: 'instagramBranded', fields: 'instagram_branded_content' },
  // Review B F1 — gated by Meta (v26 changelog: WhatsApp identity on creatives is for accounts Meta lets in), and B F2 —
  // threads_user_id is on the v26 reference but not in Meta's SDK v26: each its own group.
  { name: 'whatsAppIdentity', fields: 'wamo_whatsapp_identity_spec' }, { name: 'threads', fields: 'threads_user_id' },
]
/** CR-220 — Meta answers the WhatsApp number only when asked by this name (a call of its own: it names object_story_spec again). */
const CREATIVE_WHATSAPP_FIELDS = 'object_story_spec{whats_app_business_phone_number}'

export const CREATIVE_LIST_FIELDS = 'id,account_id,name,status,object_type,title,body,call_to_action_type,image_hash,video_id,thumbnail_url,actor_id,instagram_user_id,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,product_set_id,adlabels{id,name}'
/** CR-248 — gated (review B F1): a list asks it in its own group; never on an ad set's creatives (Meta does not answer it there). */
const CREATIVE_LIST_WHATSAPP: FieldGroup = { name: 'whatsAppIdentity', fields: 'wamo_whatsapp_identity_spec' }

function creativeOf(r: Row) {
  const story = obj(r.object_story_spec)
  return {
    creativeId: text(r.id), name: text(r.name), status: text(r.status), objectType: text(r.object_type),
    pageId: text(r.actor_id), instagramUserId: text(r.instagram_user_id), threadsUserId: text(r.threads_user_id),
    title: text(r.title), body: text(r.body), callToActionType: text(r.call_to_action_type), callToAction: spec(r.call_to_action), linkUrl: text(r.link_url), objectUrl: text(r.object_url),
    urlTags: text(r.url_tags), imageHash: text(r.image_hash), imageUrl: text(r.image_url), videoId: text(r.video_id),
    thumbnailUrl: text(r.thumbnail_url), objectStorySpec: story ? spec(story) : null, objectStoryId: text(r.object_story_id), effectiveObjectStoryId: text(r.effective_object_story_id),
    effectiveInstagramMediaId: text(r.effective_instagram_media_id), sourceInstagramMediaId: text(r.source_instagram_media_id), sourceFacebookPostId: text(r.source_facebook_post_id),
    instagramPermalink: text(r.instagram_permalink_url), assetFeedSpec: spec(r.asset_feed_spec), advantageFeatures: spec(r.degrees_of_freedom_spec),
    mediaSourcing: spec(r.media_sourcing_spec), formatTransformation: spec(r.format_transformation_spec), contextualMultiAds: spec(r.contextual_multi_ads),
    creativeSourcing: spec(r.creative_sourcing_spec), generativeAssets: spec(r.generative_asset_spec), authorizationCategory: text(r.authorization_category),
    effectiveAuthorizationCategory: text(r.effective_authorization_category), brandedContent: spec(r.branded_content), brandedContentSponsorPageId: text(r.branded_content_sponsor_page_id),
    facebookBrandedContent: spec(r.facebook_branded_content), instagramBrandedContent: r.instagram_branded_content === undefined ? undefined : spec(r.instagram_branded_content),
    platformCustomizations: spec(r.platform_customizations), portraitCustomizations: spec(r.portrait_customizations), disclaimer: spec(r.ad_disclaimer_spec),
    productSetId: text(r.product_set_id), productData: spec(r.product_data), messengerSponsoredMessage: text(r.messenger_sponsored_message),
    whatsAppIdentity: spec(r.wamo_whatsapp_identity_spec), interactiveComponents: spec(r.interactive_components_spec), pageWelcomeMessage: text(r.page_welcome_message),
    templateUrlSpec: spec(r.template_url_spec), recommenderSettings: spec(r.recommender_settings), applinkTreatment: text(r.applink_treatment),
    categorizationCriteria: text(r.categorization_criteria), placePageSetId: text(r.place_page_set_id), destinationSpec: r.destination_spec === undefined ? undefined : spec(r.destination_spec),
    labels: labelsOf(r.adlabels),
  }
}

/** CR-001, CR-004, CR-005, CR-006, CR-248, CR-442 — the creatives of the account, a campaign, an ad set or an ad. */
export async function creativesList(input: { connectionId?: string | null; campaignId?: string | null; adSetId?: string | null; adId?: string | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const owner = input.adId ? await ownedId(account, input.adId, 'ad') : input.adSetId ? await ownedId(account, input.adSetId, 'adset') : input.campaignId ? await ownedId(account, input.campaignId, 'campaign') : null
  const groups: FieldGroup[] = [{ name: 'core', fields: CREATIVE_LIST_FIELDS }, ...(input.adSetId && !input.adId ? [] : [CREATIVE_LIST_WHATSAPP])]
  const read = await listGroups(account.connectionId, 'objects.creatives', owner ? `${owner}/adcreatives` : `${act(account.adAccountId)}/adcreatives`, groups, {}, input.maxRows ?? 100)
  const own = read.rows.filter((r) => r.account_id === undefined || metaAdAccountId(r.account_id) === account.adAccountId)
  return {
    adAccountId: account.adAccountId, items: own.map((r) => creativeOf(r)), more: read.more, missing: read.missing,
    notes: ['Meta lists at most 50,000 creatives of an account (no paging past that).', 'whatsAppIdentity: only for accounts Meta lets use WhatsApp identities on creatives, and never on an ad set\'s creatives (Meta does not answer it there).', 'thumbnailUrl is a temporary link from Meta\'s CDN: show it, never keep it.'],
  }
}

/** CR-002, CR-003, CR-220, CR-269, CR-270, CR-306, CR-336, CR-402, CR-424, CR-437 — one creative with every field. */
export async function creativeDetail(input: { connectionId?: string | null; creativeId: string; thumbnailWidth?: number | null; thumbnailHeight?: number | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.creativeId, 'creative')
  const size = { ...(input.thumbnailWidth ? { thumbnail_width: input.thumbnailWidth } : {}), ...(input.thumbnailHeight ? { thumbnail_height: input.thumbnailHeight } : {}) }
  // The thumbnail size goes with the group that names thumbnail_url (the gateway lets it through only there).
  const { body, missing } = await readGroups(account.connectionId, 'objects.creative', id, CREATIVE_GROUPS.map((g) => (g.name === 'core' ? { ...g, query: size } : g)))
  if (body.account_id !== undefined && metaAdAccountId(body.account_id) !== account.adAccountId) throw new MetaLiveRefusal('That creative does not belong to the ad account this business chose, so it is not read.')
  let whatsAppNumber: string | null = null
  try {
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'objects.creative.whatsapp', path: id, query: { fields: CREATIVE_WHATSAPP_FIELDS } })
    whatsAppNumber = text(obj((read.body as Row).object_story_spec)?.whats_app_business_phone_number)
  } catch (err) {
    if (!partFailed(err)) throw err
    missing.push({ part: 'whatsAppNumber', sentence: err.failure.sentence })
  }
  const story = obj(body.object_story_spec)
  const assets = await assetsOf(account, [body.actor_id, body.branded_content_sponsor_page_id, story?.page_id], [body.instagram_user_id, story?.instagram_user_id])
  return {
    adAccountId: account.adAccountId,
    creative: creativeOf(body), whatsAppNumber, pages: assets.pages, instagram: assets.instagram, missing,
    notes: [
      'advantageFeatures (degrees_of_freedom_spec) is what Meta finally applied: Meta drops an AI feature it does not allow, and a feature not set to OPT_IN is not applied — this read is the truth after any change.',
      'effectiveAuthorizationCategory can differ from authorizationCategory when Meta classes the ad as political.',
      'thumbnailUrl is a temporary link from Meta\'s CDN (thumbnailWidth / thumbnailHeight set its size, default 64): show it, never keep it.',
      'A creative cannot be edited: a change is a new creative (and a new review).',
      'whatsAppNumber: the WhatsApp number marketing messages are sent from (null when none is set).',
    ],
  }
}

/**
 * Review fix A6 — the Page ad limits (ads running or in review, per Page): explicit fields only, the Page by id (never its
 * name), and a Page another business in Nexus uses is its id and the flag only; never the business portfolio a limit is
 * scoped to (ad_limit_scope_business… is not asked). Counts Meta's docs name, the rest from Meta's SDK in their own group.
 */
export async function pageAdLimits(account: MetaChosenAccount) {
  const read = await listGroups(account.connectionId, 'objects.problems.adsVolume', `${act(account.adAccountId)}/ads_volume`, [
    { name: 'core', fields: 'actor_id,ads_running_or_in_review_count,current_account_ads_running_or_in_review_count,limit_on_ads_running_or_in_review' },
    { name: 'sdk', fields: 'future_limit_on_ads_running_or_in_review,future_limit_activation_date,ad_limit_set_by_page_admin' },
  ], { show_breakdown_by_actor: true }, 50)
  const taken = await takenIds('PAGE', read.rows.map((r) => text(r.actor_id)).filter((id): id is string => !!id))
  const pages = read.rows.map((r) => {
    const pageId = text(r.actor_id)
    if (pageId && taken.has(pageId)) return { pageId, takenByAnotherBusiness: true }
    return {
      pageId, chosenHere: pageId ? pageId === account.pageId : null, takenByAnotherBusiness: false,
      adsRunningOrInReview: num(r.ads_running_or_in_review_count), thisAccountAdsRunningOrInReview: num(r.current_account_ads_running_or_in_review_count),
      limit: num(r.limit_on_ads_running_or_in_review), futureLimit: num(r.future_limit_on_ads_running_or_in_review), futureLimitFrom: text(r.future_limit_activation_date),
      // An unsigned int in Meta's SDK v26 (adaccountadvolume.py): the limit a Page admin set, a number.
      pageAdminLimit: num(r.ad_limit_set_by_page_admin),
    }
  })
  return { pages, missing: read.missing }
}

/** RC-029 — every problem that stops delivery, in one answer (like Meta's ads_get_errors, with the account's own state). */
export async function deliveryProblems(input: { connectionId?: string | null; includePausedByParent?: boolean; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const max = input.maxRows ?? 200
  const core = await metaReadOne({ connectionId }, { operation: 'objects.problems.account', path: act(adAccountId), query: { fields: 'account_status,disable_reason,failed_delivery_checks' } })
  const a = core.body as Row
  const status = num(a.account_status)
  const campaigns = await listPaged(connectionId, 'objects.problems.campaigns', `${act(adAccountId)}/campaigns`, { fields: 'id,name,effective_status,issues_info', effective_status: ['WITH_ISSUES'] }, max)
  const adSets = await listPaged(connectionId, 'objects.problems.adsets', `${act(adAccountId)}/adsets`, { fields: 'id,name,campaign_id,effective_status,issues_info', effective_status: ['WITH_ISSUES'] }, max)
  const adStatuses = ['WITH_ISSUES', 'DISAPPROVED', 'PENDING_BILLING_INFO', 'PENDING_REVIEW', 'IN_PROCESS', ...(input.includePausedByParent ? ['CAMPAIGN_PAUSED', 'ADSET_PAUSED'] : [])]
  const ads = await listGroups(connectionId, 'objects.problems.ads', `${act(adAccountId)}/ads`, [
    { name: 'core', fields: 'id,name,campaign_id,adset_id,effective_status,issues_info' }, { name: 'review', fields: 'ad_review_feedback' }, { name: 'checks', fields: 'failed_delivery_checks' },
  ], { effective_status: adStatuses }, max)
  let adsVolume: unknown = null
  let adsVolumeNote: string | null = null
  try {
    const limits = await pageAdLimits(account)
    adsVolume = limits.pages
    // Re-review — a refused group of SDK-only fields is said (LIVE-PROBES RC-029).
    if (limits.missing.length) adsVolumeNote = `Meta did not answer part of the Page ad limits (${limits.missing.map((m) => `${m.part}: ${m.sentence}`).join('; ')}).`
  } catch (err) {
    if (!partFailed(err)) throw err
    adsVolumeNote = `Meta did not answer the Page ad limits: ${err.failure.sentence}`
  }
  const problem = (level: string, r: Row) => ({
    level, id: text(r.id), name: text(r.name), campaignId: text(r.campaign_id), adSetId: text(r.adset_id), effectiveStatus: text(r.effective_status), statusText: statusText(r.effective_status),
    issues: issuesOf(r.issues_info), ...(r.ad_review_feedback !== undefined ? { review: spec(r.ad_review_feedback) } : {}), ...(r.failed_delivery_checks !== undefined ? { failedDeliveryChecks: checksOf(r.failed_delivery_checks) } : {}),
  })
  const waiting = new Set(['PENDING_REVIEW', 'IN_PROCESS', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'])
  const adRows = ads.rows.map((r) => problem('ad', r))
  return {
    adAccountId,
    account: { status, statusText: status === null ? null : AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}`, disableReason: num(a.disable_reason), failedDeliveryChecks: checksOf(a.failed_delivery_checks) },
    problems: [...campaigns.rows.map((r) => problem('campaign', r)), ...adSets.rows.map((r) => problem('adset', r)), ...adRows.filter((r) => !waiting.has(r.effectiveStatus ?? ''))],
    waiting: adRows.filter((r) => waiting.has(r.effectiveStatus ?? '')),
    adsVolume, ...(adsVolumeNote ? { adsVolumeNote } : {}),
    more: campaigns.more || adSets.more || ads.more, missing: ads.missing,
    notes: [
      'problems: what stops delivery now (issues, a rejection, a missing payment method); waiting: ads in review or being processed (and paused by their campaign or ad set when asked).',
      'A campaign\'s issue holds for everything under it. Meta also pushes these changes (webhooks with_issues_ad_objects, in_process_ad_objects) once Nexus receives them.',
      'adsVolume: ads running or in review against each Page\'s ad limit.',
    ],
  }
}

/** RC-032 … RC-037 — auction overlap, auction competition, creative fatigue and diversity, and (if Meta still answers) rankings. */
export const DIAGNOSTIC_GROUPS: FieldGroup[] = [
  { name: 'overlap', fields: 'deduping_ratio,deduping_1st_source_ratio,deduping_2nd_source_ratio,deduping_3rd_source_ratio' },
  { name: 'auction', fields: 'auction_bid,auction_competitiveness,auction_max_competitor_bid,wish_bid' },
  { name: 'fatigue', fields: 'creative_fatigue_summary,creative_fatigued_ads' },
  { name: 'diversity', fields: 'creative_diversity_score,creative_diversity_label,creative_diversity_data' },
  { name: 'rankings', fields: 'quality_ranking,engagement_rate_ranking,conversion_rate_ranking' },
]

/**
 * One insights row (the whole window) in field groups: every group in ONE call; when Meta refuses it, each group alone,
 * their rows merged, and each group Meta refused named with its sentence (here every group is optional).
 */
async function readInsightGroups(connectionId: string, operation: string, path: string, groups: FieldGroup[], query: Record<string, MetaQueryValue>): Promise<{ row: Row; missing: MissingPart[] }> {
  try {
    const read = await metaReadOne({ connectionId }, { operation, path, query: { ...query, fields: groups.map((g) => g.fields).join(',') } })
    return { row: rowsOf((read.body as Row).data)[0] ?? {}, missing: [] }
  } catch (err) {
    if (!fieldRefused(err)) throw err
  }
  const row: Row = {}
  const missing: MissingPart[] = []
  for (const group of groups) {
    try {
      const read = await metaReadOne({ connectionId }, { operation: `${operation}.${group.name}`, path, query: { ...query, fields: group.fields } })
      Object.assign(row, rowsOf((read.body as Row).data)[0] ?? {})
    } catch (err) {
      if (!fieldRefused(err)) throw err
      missing.push({ part: group.name, sentence: err.failure.sentence })
    }
  }
  return { row, missing }
}

export async function objectDiagnostics(input: { connectionId?: string | null; kind: 'campaign' | 'adset' | 'ad'; id: string; from: string; to: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const { row, missing } = await readInsightGroups(account.connectionId, `objects.${input.kind}.diagnostics`, `${id}/insights`, DIAGNOSTIC_GROUPS, { time_range: { since: input.from, until: input.to } })
  const pick = (names: string) => Object.fromEntries(names.split(',').map((n) => [n, spec(row[n])]))
  return {
    kind: input.kind, id, from: input.from, to: input.to,
    overlap: missing.some((m) => m.part === 'overlap') ? null : { dedupingRatio: spec(row.deduping_ratio), source1Ratio: spec(row.deduping_1st_source_ratio), source2Ratio: spec(row.deduping_2nd_source_ratio), source3Ratio: spec(row.deduping_3rd_source_ratio) },
    auction: missing.some((m) => m.part === 'auction') ? null : { auctionBid: spec(row.auction_bid), auctionCompetitiveness: spec(row.auction_competitiveness), auctionMaxCompetitorBid: spec(row.auction_max_competitor_bid), wishBid: spec(row.wish_bid) },
    // Review fix A6 — shapes Meta does not document (they may name ads and amounts): under metaRaw.
    fatigue: missing.some((m) => m.part === 'fatigue') ? null : { metaRaw: pick('creative_fatigue_summary,creative_fatigued_ads') },
    diversity: missing.some((m) => m.part === 'diversity') ? null : { metaRaw: pick('creative_diversity_score,creative_diversity_label,creative_diversity_data') },
    rankings: missing.some((m) => m.part === 'rankings') || ['quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'].every((n) => row[n] === undefined) ? null : pick('quality_ranking,engagement_rate_ranking,conversion_rate_ranking'),
    missing,
    notes: [
      'overlap: the share of auctions this ad set did not enter because its audience overlaps the account\'s other ad sets (an ad set\'s number; Meta does not say which ad sets).',
      'auction: Meta names these fields without describing them; auctionBid, auctionMaxCompetitorBid and wishBid are Meta\'s amounts as sent. They are not rankings.',
      'rankings: quality, engagement-rate and conversion-rate rankings are not in Meta\'s v26 insights reference; Nexus shows them only if Meta still answers them.',
      'Industry and auction benchmarks have no public Meta API (Meta\'s own MCP and Ads Manager only).',
    ],
  }
}

/** CR-438 — results per asset (text, image, video, call to action, link, format) of a dynamic creative / asset-customised ad. */
export const ASSET_BREAKDOWNS = ['body_asset', 'title_asset', 'description_asset', 'image_asset', 'video_asset', 'call_to_action_asset', 'link_url_asset', 'ad_format_asset'] as const

export async function assetResults(input: { connectionId?: string | null; kind: 'adset' | 'ad'; id: string; breakdown: typeof ASSET_BREAKDOWNS[number]; from: string; to: string; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.id, input.kind)
  const read = await listPaged(account.connectionId, `objects.${input.kind}.assetResults`, `${id}/insights`, {
    fields: 'impressions,clicks,spend,reach,actions,action_values', breakdowns: [input.breakdown], time_range: { since: input.from, until: input.to },
  }, input.maxRows ?? 200)
  return {
    kind: input.kind, id, breakdown: input.breakdown, from: input.from, to: input.to, currency: account.currency,
    items: read.rows.map((r) => {
      const purchases = purchasesOf(r.actions, r.action_values)
      return {
        asset: spec(r[input.breakdown]), impressions: num(r.impressions) ?? 0, clicks: num(r.clicks) ?? 0, reach: num(r.reach),
        spendCents: minorOf(decimalToMicros(r.spend) ?? 0n, account.currency), purchases: Number(purchases.count), purchaseValueCents: minorOf(purchases.valueMicros, account.currency),
      }
    }),
    more: read.more,
    note: 'Meta answers results per asset only (impressions, clicks, spend, reach, actions and their values); results per finished ad combination are in Ads Manager only ("By Dynamic Creative Asset"). Other numbers and breakdowns: meta-ads-live view insights and the numbers tool.',
  }
}

/** CR-034 — the account's async creative jobs, or one job's requests (its id must be among the account's jobs). */
export async function creativeJobs(input: { connectionId?: string | null; jobId?: string | null; completed?: boolean | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const path = `${act(account.adAccountId)}/asyncadcreatives`
  const fields = 'id,name,is_completed,total_count,initial_count,in_progress_count,success_count,error_count,canceled_count,created_time,updated_time'
  const jobOf = (r: Row) => ({ jobId: text(r.id), name: text(r.name), completed: bool(r.is_completed), total: num(r.total_count), waiting: num(r.initial_count), inProgress: num(r.in_progress_count), succeeded: num(r.success_count), failed: num(r.error_count), canceled: num(r.canceled_count), createdTime: text(r.created_time), updatedTime: text(r.updated_time) })
  if (!input.jobId) {
    const read = await listPaged(account.connectionId, 'objects.creativeJobs', path, { fields, ...(typeof input.completed === 'boolean' ? { is_completed: input.completed } : {}) }, input.maxRows ?? 100)
    return { adAccountId: account.adAccountId, items: read.rows.map(jobOf), more: read.more }
  }
  const jobId = metaObjectId(input.jobId)
  if (!jobId) throw new MetaLiveRefusal(`"${input.jobId}" is not a Meta job id (digits).`)
  const open = await listPaged(account.connectionId, 'objects.creativeJobs', path, { fields }, MAX_ROWS)
  let job = open.rows.find((r) => text(r.id) === jobId)
  if (!job) job = (await listPaged(account.connectionId, 'objects.creativeJobs.done', path, { fields, is_completed: true }, MAX_ROWS)).rows.find((r) => text(r.id) === jobId)
  if (!job) throw new MetaLiveRefusal('That job is not one of the chosen ad account\'s async creative jobs, so it is not read.')
  const requests = await listPaged(account.connectionId, 'objects.creativeJob.requests', `${jobId}/requests`, { fields: 'id,status,result,input' }, input.maxRows ?? 100)
  return { adAccountId: account.adAccountId, job: jobOf(job), requests: requests.rows.map((r) => ({ requestId: text(r.id), status: text(r.status), result: spec(r.result), input: spec(r.input) })), more: requests.more }
}

/** IN-085 — a creative's own insights edge (shape undocumented): Meta's answer as it is. */
export async function creativeInsights(input: { connectionId?: string | null; creativeId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.creativeId, 'creative')
  // Review B F6 — Meta's SDK names one field, aesthetics; when Meta refuses it, Meta's own default answer.
  let read
  try {
    read = await listPaged(account.connectionId, 'objects.creative.insights', `${id}/creative_insights`, { fields: 'aesthetics' }, 50)
  } catch (err) {
    if (!fieldRefused(err)) throw err
    read = await listPaged(account.connectionId, 'objects.creative.insights.default', `${id}/creative_insights`, {}, 50)
  }
  return { creativeId: id, items: read.rows.map((r) => ({ metaRaw: spec(r) })), more: read.more, note: 'Meta documents this edge but not its answer (its SDK names `aesthetics`): Meta\'s answer as it is (it may hold amounts). The creative\'s numbers per ad: meta-ads-live view insights at level ad.' }
}

export const SUGGESTED_USE_CASES = ['AD_STRATEGIES', 'AUTOMATED_APP_ADS', 'AUTOMATED_SHOPPING_ADS', 'AUTOMATED_SHOPPING_ADS_MDSA', 'LEAD_GEN_ASC_ADS', 'MANUAL_FLOW_APP_ADS', 'MANUAL_FLOW_SHOPS_ADS', 'MANUAL_FLOW_WEBSITE_ADS', 'MANUAL_FLOW_WEBSITE_AND_APP_ADS', 'SALES_WEB_APP_ADS'] as const

/** AD-021 — the ads Meta suggests for the account (Ad nodes; semantics undocumented). */
export async function suggestedAds(input: { connectionId?: string | null; useCase?: string | null; objective?: string | null; optimizationGoal?: string | null; optimizationEvent?: string | null; countries?: string[] | null; rankBy?: string | null; forChosenPage?: boolean; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  if (input.forChosenPage && !account.pageId) throw new MetaLiveRefusal('This business has no Facebook Page chosen for Meta yet (Settings › Channels › Meta).')
  const read = await listGroups(account.connectionId, 'objects.suggestedAds', `${act(account.adAccountId)}/suggested_ads`, [
    { name: 'core', fields: 'id,name' }, { name: 'creative', fields: 'creative{title,body,object_type,call_to_action_type,image_hash,video_id}' },
  ], {
    ...(input.useCase ? { use_case: input.useCase } : {}), ...(input.objective ? { objective: input.objective } : {}),
    ...(input.optimizationGoal ? { optimization_goal: input.optimizationGoal } : {}), ...(input.optimizationEvent ? { optimization_event: input.optimizationEvent } : {}),
    ...(input.countries?.length ? { countries: input.countries } : {}), ...(input.rankBy ? { rank_by: input.rankBy } : {}),
    ...(input.forChosenPage && account.pageId ? { promoted_object_page_id: account.pageId } : {}),
  }, input.maxRows ?? 20)
  return {
    adAccountId: account.adAccountId,
    items: read.rows.map((r) => ({ suggestionId: text(r.id), name: text(r.name), creative: spec(obj(r.creative)) })), more: read.more, missing: read.missing,
    note: 'Meta documents the parameters, not what a suggestion means. Making one into a real ad is a change (a person approves it). Suggestions for a pixel or product set wait for Nexus\'s pixel and catalog reads to check that they are this business\'s own.',
  }
}

/** AD-022 — Meta's "smart suggested ads" for a goal (node undocumented): Meta's answer as it is. */
export async function smartSuggestedAds(input: { connectionId?: string | null; objective?: string | null; optimizationGoal?: string | null; customEventType?: string | null; destinationType?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const read = await listPaged(account.connectionId, 'objects.smartSuggestedAds', `${act(account.adAccountId)}/smart_suggested_ads`, {
    ...(input.objective ? { objective: input.objective } : {}), ...(input.optimizationGoal ? { optimization_goal: input.optimizationGoal } : {}),
    ...(input.customEventType ? { custom_event_type: input.customEventType } : {}), ...(input.destinationType ? { destination_type: input.destinationType } : {}),
  }, 20)
  return { adAccountId: account.adAccountId, items: read.rows.map((r) => ({ metaRaw: spec(r) })), more: read.more, note: 'Meta documents the parameters, not the answer: Meta\'s answer as it is.' }
}

/**
 * AD-020 — the ad's Facebook feedback objects: their ids ONLY. Meta's page says each carries "a preview link and a list of
 * related comments"; a preview link opens for anyone and comments are people's words, so neither is asked here.
 */
export async function adFeedback(input: { connectionId?: string | null; adId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = await ownedId(account, input.adId, 'ad')
  const read = await listPaged(account.connectionId, 'objects.ad.feedback', `${id}/facebook_feedback`, { fields: 'id' }, 50)
  return {
    adId: id, feedbackIds: read.rows.map((r) => text(r.id)).filter(Boolean), more: read.more,
    note: 'Only the ids: the comments under an ad (people\'s names and words) are read by the comments tool, with its own checks; the preview link Meta adds is never asked (anyone with it can open it). For a dynamic creative ad Meta takes one generated post id (dynamic_post); Nexus does not send one yet (it cannot check that a post is this business\'s own until its post reads, step 10), so Meta answers the ad\'s own feedback.',
  }
}

/** CR-447 — Meta's locale keys for a language rule (numeric keys, e.g. 6 English (US)), searched by name. */
export async function adLocales(input: { connectionId?: string | null; search: string; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const read = await listPaged(account.connectionId, 'objects.adLocales', 'search', { type: 'adlocale', q: input.search }, input.maxRows ?? 50)
  return { items: read.rows.map((r) => ({ key: num(r.key), name: text(r.name) })), more: read.more, note: 'Locales are numeric keys, not codes. Other targeting searches: meta-targeting-search.' }
}

export const CATEGORY_CRITERIA = ['BRAND', 'CATEGORY', 'PRODUCT_TYPE'] as const

/** CR-459 — the catalog categories (top 1,000 by product count) of the catalog an ad set of the account promotes. */
export async function catalogCategories(input: { connectionId?: string | null; adSetId: string; criteria: typeof CATEGORY_CRITERIA[number]; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const adSetId = await ownedId(account, input.adSetId, 'adset')
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'objects.adset.promotedObject', path: adSetId, query: { fields: 'promoted_object' } })
  const catalogId = metaObjectId(obj((read.body as Row).promoted_object)?.product_catalog_id)
  if (!catalogId) throw new MetaLiveRefusal('This ad set promotes no product catalog (its promoted object names none), so there are no catalog categories to read for it.')
  // Review fix A7 — the catalog must be the chosen ad account's own business portfolio's (a catalog shared in from elsewhere
  // is not read here). Two Nexus businesses on one portfolio would both pass: step 12 adds CATALOG to
  // nexus_meta_links_taken (taken.ts) and re-checks catalogCategories against it.
  const owner = await metaReadOne({ connectionId: account.connectionId }, { operation: 'objects.catalog.ownerCheck', path: catalogId, query: { fields: 'business{id}' } })
  const ownerId = metaObjectId(obj((owner.body as Row).business)?.id)
  if (!ownerId || !account.businessId || ownerId !== account.businessId) {
    throw new MetaLiveRefusal('The catalog this ad set promotes is not owned by the chosen ad account\'s business portfolio, so its categories are not read here.')
  }
  const categories = await listPaged(account.connectionId, 'objects.catalog.categories', `${catalogId}/categories`, { categorization_criteria: input.criteria, fields: 'criteria_value,name,description,destination_uri,image_url' }, input.maxRows ?? 200)
  return {
    adSetId, catalogId, criteria: input.criteria,
    items: categories.rows.map((r) => ({ criteriaValue: text(r.criteria_value), name: text(r.name), description: text(r.description), destinationUri: text(r.destination_uri), imageUrl: text(r.image_url) })),
    more: categories.more,
    note: 'Meta answers the top 1,000 categories by product count. They belong to the catalog, so every category ad of that catalog shares them. The catalog itself: the catalog tools. Nexus checks the catalog belongs to the chosen account\'s business portfolio; which Nexus business uses a catalog is checked once the catalog reads arrive (step 12).',
  }
}

// ── meta-labels ─────────────────────────────────────────────────────────────────────────────────────────────────────

const labelOf = (r: Row) => ({ labelId: text(r.id), name: text(r.name), createdTime: text(r.created_time), updatedTime: text(r.updated_time) })

/** CMP-081 — the account's ad labels. */
export async function labelsList(input: { connectionId?: string | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const read = await listPaged(account.connectionId, 'objects.labels', `${act(account.adAccountId)}/adlabels`, { fields: 'id,name,created_time,updated_time' }, input.maxRows ?? 200, true)
  return { adAccountId: account.adAccountId, totalCount: read.totalCount, items: read.rows.map(labelOf), more: read.more, note: 'Up to 100,000 labels per account; at most 50 on one object.' }
}

/**
 * Are these labels the chosen account's own? Its list holds them (a label node names no account on v26). Review fix A2: the
 * account's labels are read ONCE (up to 500) and every id is checked against that set.
 */
async function ownedLabels(account: MetaChosenAccount, labelIds: string[]): Promise<string[]> {
  const ids = labelIds.map((labelId) => metaObjectId(labelId) ?? (() => { throw new MetaLiveRefusal(`"${labelId}" is not a Meta label id (digits).`) })())
  const own = await listPaged(account.connectionId, 'objects.labels.ownerCheck', `${act(account.adAccountId)}/adlabels`, { fields: 'id' }, MAX_ROWS)
  const mine = new Set(own.rows.map((r) => text(r.id)))
  const foreign = ids.filter((id) => !mine.has(id))
  if (foreign.length) {
    throw new MetaLiveRefusal(own.more
      ? `${foreign.join(', ')} is not among the first 500 labels of the chosen ad account, so it is not read.`
      : `${foreign.join(', ')} is not a label of the chosen ad account, so it is not read.`)
  }
  return [...new Set(ids)]
}

/** CMP-086 — one label. */
export async function labelDetail(input: { connectionId?: string | null; labelId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const [id] = await ownedLabels(account, [input.labelId])
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'objects.label', path: id, query: { fields: 'id,name,created_time,updated_time' } })
  return { adAccountId: account.adAccountId, label: labelOf(read.body as Row) }
}

export const LABEL_OBJECT_KINDS = ['campaigns', 'adsets', 'ads', 'creatives'] as const
type LabelObjectKind = typeof LABEL_OBJECT_KINDS[number]
const LABEL_EDGE: Readonly<Record<LabelObjectKind, string>> = { campaigns: 'campaigns', adsets: 'adsets', ads: 'ads', creatives: 'adcreatives' }
const LABEL_FIELDS: Readonly<Record<LabelObjectKind, string>> = {
  campaigns: 'id,account_id,name,status,effective_status,objective',
  adsets: 'id,account_id,campaign_id,name,status,effective_status',
  ads: 'id,account_id,campaign_id,adset_id,name,status,effective_status',
  creatives: 'id,account_id,name,status,object_type,title',
}

/**
 * CMP-013, CMP-085, AS-024, AD-012, CR-008 — the campaigns, ad sets, ads or creatives that carry a label: one label through
 * its own edge, several through the account's …bylabels edge with ALL or ANY (whole label ids; no partial match).
 */
export async function labelObjects(input: { connectionId?: string | null; labelIds: string[]; operator?: 'ALL' | 'ANY' | null; kind: LabelObjectKind; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const unique = await ownedLabels(account, input.labelIds)
  const fields = LABEL_FIELDS[input.kind]
  const read = unique.length === 1 && !input.operator
    ? await listPaged(account.connectionId, `objects.label.${input.kind}`, `${unique[0]}/${LABEL_EDGE[input.kind]}`, { fields }, input.maxRows ?? 200)
    : await listPaged(account.connectionId, `objects.labels.${input.kind}`, `${act(account.adAccountId)}/${LABEL_EDGE[input.kind]}bylabels`, { fields, ad_label_ids: unique, operator: input.operator ?? 'ANY' }, input.maxRows ?? 200)
  const own = read.rows.filter((r) => metaAdAccountId(r.account_id) === account.adAccountId)
  return {
    adAccountId: account.adAccountId, labelIds: unique, operator: unique.length === 1 && !input.operator ? null : input.operator ?? 'ANY', kind: input.kind,
    items: own.map((r) => ({ id: text(r.id), name: text(r.name), campaignId: text(r.campaign_id), adSetId: text(r.adset_id), status: text(r.status), effectiveStatus: text(r.effective_status), statusText: statusText(r.effective_status), objective: text(r.objective), objectType: text(r.object_type), title: text(r.title) })),
    more: read.more,
    note: 'Meta\'s label edges take no status filter and, like every Meta list, leave deleted objects out (and may leave archived ones out): read one by its id in meta-campaigns, meta-ad-sets or meta-ad-details.',
  }
}

// ── meta-value-rules ────────────────────────────────────────────────────────────────────────────────────────────────

export const VALUE_RULE_PRODUCT_TYPES = ['AUDIENCE', 'LEADGEN_ADS', 'OMNI_CHANNEL'] as const
export const VALUE_RULE_STATUSES = ['ACTIVE', 'DELETED', 'DRAFT'] as const
const VALUE_RULE_GROUPS: FieldGroup[] = [{ name: 'core', fields: 'id,name,status,rules{id,name,adjust_sign,adjust_value,status,criterias}' }, { name: 'sdk', fields: 'product_type,is_default_setting,last_attach_time' }]

const ruleSetOf = (r: Row) => ({
  ruleSetId: text(r.id), name: text(r.name), status: text(r.status), productType: text(r.product_type), isDefault: bool(r.is_default_setting), lastAttachTime: text(r.last_attach_time),
  rules: rowsOf(r.rules).map((rule) => ({
    ruleId: text(rule.id), name: text(rule.name), status: text(rule.status), adjust: text(rule.adjust_sign), adjustPercent: num(rule.adjust_value),
    criteria: rowsOf(rule.criterias).map((c) => ({ criteriaId: text(c.id), type: text(c.criteria_type), operator: text(c.operator), values: spec(c.criteria_values), valueTypes: spec(c.criteria_value_types) })),
  })),
})

/** AS-091 — the account's value rule sets with their rules. */
export async function valueRuleSets(input: { connectionId?: string | null; productType?: string | null; status?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const read = await listGroups(account.connectionId, 'objects.valueRuleSets', `${act(account.adAccountId)}/value_rule_set`, VALUE_RULE_GROUPS, {
    ...(input.productType ? { product_type: input.productType } : {}), ...(input.status ? { status: input.status } : {}),
  }, 50)
  return {
    adAccountId: account.adAccountId, items: read.rows.map(ruleSetOf), more: read.more, missing: read.missing,
    note: 'A rule raises (INCREASE, 1–1,000 %) or lowers (DECREASE, 1–90 %) the bid for people who match all its criteria (age, gender, location, OS, device, placement, audience label). Meta allows about 6 rule sets per account, 10 rules per set, 4 criteria per rule. An ad set uses one through its valueRuleSetId (meta-ad-sets view adset).',
  }
}

/** AS-092 — one value rule set and its rules (found among the account's own first). */
export async function valueRuleSet(input: { connectionId?: string | null; ruleSetId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  const id = metaObjectId(input.ruleSetId)
  if (!id) throw new MetaLiveRefusal(`"${input.ruleSetId}" is not a Meta value rule set id (digits).`)
  const own = await listPaged(account.connectionId, 'objects.valueRuleSets.ownerCheck', `${act(account.adAccountId)}/value_rule_set`, { fields: 'id' }, 100)
  if (!own.rows.some((r) => text(r.id) === id)) throw new MetaLiveRefusal('That value rule set is not one of the chosen ad account\'s, so it is not read.')
  const { body, missing } = await readGroups(account.connectionId, 'objects.valueRuleSet', id, VALUE_RULE_GROUPS)
  return { adAccountId: account.adAccountId, ruleSet: ruleSetOf(body), missing }
}
