/**
 * Google Ads programme 2, G1 (2026-10-15) — numbers read LIVE from Google (google-ads-numbers): impressions, clicks,
 * cost, conversions, conversion value, CTR, average CPC and, where Google gives it, impression share, for a window of
 * account days that may include TODAY, at one level (campaign, ad group, keyword, ad, asset, product, search term,
 * location, age, gender, audience), optionally split by day, hour, day of week, device or network. Read only: one GAQL
 * query on the account's change allowance (write-client.ts `liveRows`), two for locations and products (their names).
 *
 * Checked on 2026-10-15 against Google's v25 field reference (https://developers.google.com/google-ads/api/fields/v25/
 * <resource>, fetched with curl and parsed): every FROM resource below exists; every selected field is Selectable and
 * usable with its FROM resource — a segment or metric only when the FROM resource's own page marks it usable "when
 * <resource> is specified in the FROM clause" (the page's filter; a metric's own "Selectable with" list is not enough),
 * a resource field when it is on that page or on one of its attributed or segmenting resources; every WHERE field is
 * Filterable; every ORDER BY field is Sortable; and each segment's "Selectable with" list names every metric and
 * segment selected with it. Facts the levels below stand on, from those pages:
 *   - segments.hour is usable only with FROM campaign and FROM ad_group (not keyword_view, ad_group_ad, the asset
 *     views, shopping_performance_view, campaign_search_term_view, geographic_view, age_range_view, gender_view or the
 *     audience views).
 *   - impression share (metrics.search_impression_share, …_top_…, …_absolute_top_…, …_budget_lost_…, …_rank_lost_…):
 *     campaign has all five; ad_group and keyword_view all but search_budget_lost_impression_share (their FROM marker is
 *     empty); shopping_performance_view all but search_top_impression_share; gender_view only search_impression_share;
 *     the other views none. segments.product_title cannot be selected with
 *     any impression share (its "Selectable with" names none; product_item_id and product_brand can): a product read
 *     selects item id and brand with the shares, and a second query (item id + title only) names the products.
 *   - campaign (and ad_group) are SEGMENTING resources of campaign_asset, ad_group_asset, shopping_performance_view,
 *     campaign_search_term_view and geographic_view. Google's rule (docs/reporting/segmentation, "Rules for segments in
 *     the WHERE clause"): a segment in WHERE must also be in SELECT — the reason Google refused campaign.status in the
 *     assets query on 2026-10-15. So every field filtered on is selected here (campaign.id always; ad_group.id when an
 *     ad group narrows the read). The core date segment segments.date is the documented exception: it is filtered
 *     without being selected unless the numbers are split by day.
 *   - segments.date (and segments.hour) reach back at most 37 months (same page): a window starts at most 1,095 days
 *     before the account's today. Days are the account's (customer.time_zone).
 *   - metrics.cost_micros and metrics.average_cpc are micros (→ cents: / 10,000); metrics.conversions_value is in
 *     currency units (→ cents: × 100); metrics.ctr and the impression shares are fractions (→ percent). Google reports a
 *     share under 10% as 0.0999 and a lost share over 90% as 0.9001.
 */
import { liveRows } from './write-client.js'
import { gaqlId } from './live.js'
import { accountToday, addDays } from './dates.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

export const NUMBER_LEVELS = [
  'campaign', 'ad-group', 'keyword', 'ad', 'asset', 'ad-group-asset', 'asset-group-asset', 'product', 'search-term',
  'location', 'age', 'gender', 'audience', 'ad-group-audience',
] as const
export type NumberLevel = typeof NUMBER_LEVELS[number]

export const NUMBER_SEGMENTS = ['day', 'hour', 'day-of-week', 'device', 'network'] as const
export type NumberSegment = typeof NUMBER_SEGMENTS[number]

export const NUMBER_ORDERS = ['cost', 'clicks', 'impressions', 'conversions', 'conversion-value'] as const
export type NumberOrder = typeof NUMBER_ORDERS[number]

export const MAX_NUMBER_ROWS = 1000
/** Google keeps day (and hour) numbers for 37 months; 1,095 days always fits inside. */
export const MAX_LOOKBACK_DAYS = 1095

const SEGMENT_FIELD: Record<NumberSegment, string> = {
  day: 'segments.date', hour: 'segments.hour', 'day-of-week': 'segments.day_of_week', device: 'segments.device', network: 'segments.ad_network_type',
}
const ORDER_FIELD: Record<NumberOrder, string> = {
  cost: 'metrics.cost_micros', clicks: 'metrics.clicks', impressions: 'metrics.impressions', conversions: 'metrics.conversions', 'conversion-value': 'metrics.conversions_value',
}

export const NUMBER_METRICS = [
  'metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions', 'metrics.conversions_value', 'metrics.ctr', 'metrics.average_cpc',
] as const

const IS = {
  search: 'metrics.search_impression_share',
  top: 'metrics.search_top_impression_share',
  absoluteTop: 'metrics.search_absolute_top_impression_share',
  lostToBudget: 'metrics.search_budget_lost_impression_share',
  lostToRank: 'metrics.search_rank_lost_impression_share',
} as const
const IS_ALL = Object.values(IS)

const ASSET_FIELDS = [
  'asset.id', 'asset.type', 'asset.name', 'asset.text_asset.text', 'asset.sitelink_asset.link_text', 'asset.callout_asset.callout_text',
  'asset.structured_snippet_asset.header',
]
const ALL_SEGMENTS = NUMBER_SEGMENTS
const NO_HOUR: readonly NumberSegment[] = ['day', 'day-of-week', 'device', 'network']

interface LevelSpec {
  from: string
  /** Plain words for the answer. */
  what: string
  /** What names a row; campaign.id is always among them, so every level can be narrowed to one campaign. */
  fields: readonly string[]
  /** Whether the level has ad groups: always selected, selected only when an ad group narrows the read, or none. */
  adGroup: 'always' | 'when-filtered' | null
  segments: readonly NumberSegment[]
  impressionShare: readonly string[]
  /**
   * One impression can count in several rows (an ad shows with several assets; a person is in several audiences; a
   * place and the place around it): the rows are not summed.
   */
  overlapping?: true
}

const CAMPAIGN = ['campaign.id', 'campaign.name']
const AD_GROUP = ['ad_group.id', 'ad_group.name']

export const NUMBER_LEVEL_SPECS: Record<NumberLevel, LevelSpec> = {
  campaign: {
    from: 'campaign', what: 'campaigns', fields: [...CAMPAIGN, 'campaign.status', 'campaign.advertising_channel_type'],
    adGroup: null, segments: ALL_SEGMENTS, impressionShare: IS_ALL,
  },
  'ad-group': {
    from: 'ad_group', what: 'ad groups', fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group.status'],
    adGroup: 'always', segments: ALL_SEGMENTS, impressionShare: [IS.search, IS.top, IS.absoluteTop, IS.lostToRank],
  },
  keyword: {
    from: 'keyword_view', what: 'keywords',
    fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group_criterion.criterion_id', 'ad_group_criterion.keyword.text', 'ad_group_criterion.keyword.match_type', 'ad_group_criterion.status'],
    adGroup: 'always', segments: NO_HOUR, impressionShare: [IS.search, IS.top, IS.absoluteTop, IS.lostToRank],
  },
  ad: {
    from: 'ad_group_ad', what: 'ads', fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group_ad.ad.id', 'ad_group_ad.ad.type', 'ad_group_ad.status'],
    adGroup: 'always', segments: NO_HOUR, impressionShare: [],
  },
  asset: {
    from: 'campaign_asset', what: 'assets linked to campaigns', fields: [...CAMPAIGN, 'campaign_asset.field_type', 'campaign_asset.status', ...ASSET_FIELDS],
    adGroup: null, segments: NO_HOUR, impressionShare: [], overlapping: true,
  },
  'ad-group-asset': {
    from: 'ad_group_asset', what: 'assets linked to ad groups', fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group_asset.field_type', 'ad_group_asset.status', ...ASSET_FIELDS],
    adGroup: 'always', segments: NO_HOUR, impressionShare: [], overlapping: true,
  },
  'asset-group-asset': {
    from: 'asset_group_asset', what: 'assets of Performance Max asset groups',
    fields: [...CAMPAIGN, 'asset_group.id', 'asset_group.name', 'asset_group_asset.field_type', 'asset_group_asset.status', ...ASSET_FIELDS],
    adGroup: null, segments: NO_HOUR, impressionShare: [], overlapping: true,
  },
  product: {
    from: 'shopping_performance_view', what: 'products (Shopping and Performance Max)',
    fields: [...CAMPAIGN, 'segments.product_item_id', 'segments.product_brand'],
    adGroup: 'when-filtered', segments: NO_HOUR, impressionShare: [IS.search, IS.absoluteTop, IS.lostToBudget, IS.lostToRank],
  },
  'search-term': {
    from: 'campaign_search_term_view', what: 'search terms', fields: [...CAMPAIGN, 'campaign_search_term_view.search_term'],
    adGroup: 'when-filtered', segments: NO_HOUR, impressionShare: [],
  },
  location: {
    from: 'geographic_view', what: 'locations (where people were, or the place they searched for)',
    fields: [...CAMPAIGN, 'geographic_view.country_criterion_id', 'geographic_view.location_type', 'segments.geo_target_most_specific_location'],
    adGroup: 'when-filtered', segments: NO_HOUR, impressionShare: [], overlapping: true,
  },
  age: {
    from: 'age_range_view', what: 'age ranges', fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group_criterion.criterion_id', 'ad_group_criterion.age_range.type'],
    adGroup: 'always', segments: NO_HOUR, impressionShare: [],
  },
  gender: {
    from: 'gender_view', what: 'genders', fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group_criterion.criterion_id', 'ad_group_criterion.gender.type'],
    adGroup: 'always', segments: NO_HOUR, impressionShare: [IS.search],
  },
  audience: {
    from: 'campaign_audience_view', what: 'audiences set on campaigns',
    fields: [...CAMPAIGN, 'campaign_criterion.criterion_id', 'campaign_criterion.type', 'campaign_criterion.display_name', 'campaign_criterion.bid_modifier'],
    adGroup: null, segments: NO_HOUR, impressionShare: [], overlapping: true,
  },
  'ad-group-audience': {
    from: 'ad_group_audience_view', what: 'audiences set on ad groups',
    fields: [...CAMPAIGN, ...AD_GROUP, 'ad_group_criterion.criterion_id', 'ad_group_criterion.type', 'ad_group_criterion.display_name', 'ad_group_criterion.bid_modifier'],
    adGroup: 'always', segments: NO_HOUR, impressionShare: [], overlapping: true,
  },
}

// ── the window ───────────────────────────────────────────────────────────────────────────────────────────────────

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar day "YYYY-MM-DD" (2026-02-30 is not one). */
export function isDay(value: string): boolean {
  const m = DAY.exec(value)
  if (!m) return false
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return at.toISOString().slice(0, 10) === value
}

export interface NumbersWindow {
  from: string
  to: string
  /** The account's today (its time zone). */
  today: string
  includesToday: boolean
}

/**
 * The account days to read: `to` defaults to the account's today, `from` to `to`. Refused: a day that is not one, a
 * window that ends before it starts, a day after the account's today (Google has no numbers yet), a day more than 1,095
 * days back (Google keeps day numbers for 37 months).
 */
export function numbersWindow(timeZone: string, ask: { from?: string | null; to?: string | null }, now: Date = new Date()): NumbersWindow | { refusal: string } {
  const today = accountToday(timeZone, now)
  const to = ask.to?.trim() || today
  const from = ask.from?.trim() || to
  for (const day of [from, to]) {
    if (!isDay(day)) return { refusal: `"${day}" is not a day (YYYY-MM-DD). Nothing was sent.` }
  }
  if (to > today) return { refusal: `${to} is after the account's today (${today}, ${timeZone}): Google has no numbers for it yet. Nothing was sent.` }
  if (from > to) return { refusal: `The window ${from} … ${to} ends before it starts. Nothing was sent.` }
  const earliest = addDays(today, -MAX_LOOKBACK_DAYS)
  if (from < earliest) return { refusal: `${from} is more than ${MAX_LOOKBACK_DAYS} days back (Google keeps day numbers for 37 months): start on ${earliest} or later. Nothing was sent.` }
  return { from, to, today, includesToday: to === today }
}

// ── the query ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NumbersRequest {
  level: NumberLevel
  window: { from: string; to: string }
  segments?: readonly NumberSegment[]
  campaignId?: string | null
  adGroupId?: string | null
  orderBy?: NumberOrder
  limit?: number
}

/** The GAQL text of one numbers read; throws (nothing sent) on a request Google would refuse or that names no Google id. */
export function numbersQuery(request: NumbersRequest): string {
  const spec = NUMBER_LEVEL_SPECS[request.level]
  if (!spec) throw new Error(`"${String(request.level)}" is not a level. Nothing was sent.`)
  const { from, to } = request.window
  if (!isDay(from) || !isDay(to) || from > to) throw new Error(`The window ${from} … ${to} is not a window of days. Nothing was sent.`)
  const segments = [...new Set(request.segments ?? [])]
  for (const s of segments) {
    if (!SEGMENT_FIELD[s]) throw new Error(`"${String(s)}" is not a split. Nothing was sent.`)
    if (!spec.segments.includes(s)) {
      throw new Error(`Google cannot split ${spec.what} by ${s} (only campaigns and ad groups have numbers per hour). Nothing was sent.`)
    }
  }
  const campaignId = request.campaignId ? gaqlId(request.campaignId, 'The campaign') : null
  const adGroupId = request.adGroupId ? gaqlId(request.adGroupId, 'The ad group') : null
  if (adGroupId && !spec.adGroup) throw new Error(`${spec.what[0].toUpperCase()}${spec.what.slice(1)} are not read per ad group: leave adGroupId out (campaignId narrows it). Nothing was sent.`)
  const limit = Math.floor(request.limit ?? 100)
  if (!(limit >= 1 && limit <= MAX_NUMBER_ROWS)) throw new Error(`The LIMIT must be 1 … ${MAX_NUMBER_ROWS}. Nothing was sent.`)

  const select = [...spec.fields]
  // A filtered field is always selected (Google's rule for segmenting resources; harmless for attributed ones).
  if (spec.adGroup === 'always' || (spec.adGroup === 'when-filtered' && adGroupId)) {
    for (const f of AD_GROUP) if (!select.includes(f)) select.push(f)
  }
  for (const s of segments) select.push(SEGMENT_FIELD[s])
  select.push(...NUMBER_METRICS, ...spec.impressionShare)

  const where = [`segments.date BETWEEN '${from}' AND '${to}'`, 'metrics.impressions > 0']
  if (campaignId) where.push(`campaign.id = ${campaignId}`)
  if (adGroupId) where.push(`ad_group.id = ${adGroupId}`)
  const order = ORDER_FIELD[request.orderBy ?? 'cost'] ?? ORDER_FIELD.cost
  const tie = order === 'metrics.impressions' ? '' : ', metrics.impressions DESC'
  return `SELECT ${select.join(', ')} FROM ${spec.from} WHERE ${where.join(' AND ')} ORDER BY ${order} DESC${tie} LIMIT ${limit}`
}

/** Characters of a Merchant Center item id that may go into a GAQL literal here (others are not asked for). */
const ITEM_ID = /^[A-Za-z0-9_\-.:/ ]{1,150}$/

/**
 * The titles of products a product read returned: the same view and window, item id and title only (title cannot be
 * selected with impression share). Ids with other characters are left out (never quoted into the query).
 */
export function productTitlesQuery(window: { from: string; to: string }, itemIds: readonly string[]): string {
  const { from, to } = window
  if (!isDay(from) || !isDay(to) || from > to) throw new Error(`The window ${from} … ${to} is not a window of days. Nothing was sent.`)
  const ids = [...new Set(itemIds)].filter((id) => ITEM_ID.test(id))
  if (!ids.length) throw new Error('No product to name. Nothing was sent.')
  return 'SELECT segments.product_item_id, segments.product_title, metrics.impressions FROM shopping_performance_view ' +
    `WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0 ` +
    `AND segments.product_item_id IN (${ids.map((id) => `'${id}'`).join(', ')}) LIMIT ${Math.min(10_000, ids.length * 20)}`
}

/** Google's names of geo targets (location numbers carry only ids). */
export function geoNamesQuery(ids: readonly string[]): string {
  const list = [...new Set(ids)].map((id) => gaqlId(id, 'The location'))
  if (!list.length) throw new Error('No location to name. Nothing was sent.')
  return 'SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type ' +
    `FROM geo_target_constant WHERE geo_target_constant.id IN (${list.join(', ')})`
}

// ── the rows ─────────────────────────────────────────────────────────────────────────────────────────────────────

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}
const opt = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places
/** Micros (an int64 string or a double) → cents. */
const centsOfMicros = (value: unknown): number | null => {
  const n = opt(value)
  return n === null ? null : Math.round(n / 10_000)
}
/** Currency units (a double) → cents. */
const centsOfUnits = (value: unknown): number | null => {
  const n = opt(value)
  return n === null ? null : Math.round(n * 100)
}
/** A fraction → percent, two decimals. */
const pctOf = (value: unknown): number | null => {
  const n = opt(value)
  return n === null ? null : round(n * 100, 2)
}
const tail = (resourceName: unknown): string | null => {
  const s = str(resourceName)
  return s ? s.slice(s.lastIndexOf('/') + 1) : null
}

export interface NumbersRow {
  campaignId: string | null
  campaignName: string | null
  adGroupId?: string | null
  adGroupName?: string | null
  /** What the row is about (the keyword, the ad, the asset, the product, the search term, the place, …). */
  item: Record<string, string | number | null>
  /** Present when the numbers are split: the row's day, hour (0–23), day of week, device or network. */
  segments?: Partial<{ date: string | null; hour: number | null; dayOfWeek: string | null; device: string | null; network: string | null }>
  impressions: number
  clicks: number
  ctrPct: number | null
  spendCents: number | null
  avgCpcCents: number | null
  conversions: number
  conversionValueCents: number | null
  /** Search impression share and what lost it, in percent; only where Google gives it. */
  impressionShare?: Partial<Record<keyof typeof IS, number | null>>
}

function assetItem(row: Json, link: Json): Record<string, string | number | null> {
  const a = row.asset ?? {}
  return {
    assetId: str(a.id),
    assetType: str(a.type),
    fieldType: str(link.fieldType),
    linkStatus: str(link.status),
    text: str(a.sitelinkAsset?.linkText) ?? str(a.calloutAsset?.calloutText) ?? str(a.textAsset?.text) ?? str(a.structuredSnippetAsset?.header) ?? str(a.name),
  }
}

function itemOf(level: NumberLevel, row: Json): Record<string, string | number | null> {
  const agc = row.adGroupCriterion ?? {}
  const cc = row.campaignCriterion ?? {}
  const ag = str(row.adGroup?.id)
  switch (level) {
    case 'campaign': return { status: str(row.campaign?.status), type: str(row.campaign?.advertisingChannelType) }
    case 'ad-group': return { status: str(row.adGroup?.status) }
    case 'keyword': {
      const id = str(agc.criterionId)
      return { keywordId: ag && id ? `${ag}~${id}` : id, text: str(agc.keyword?.text), matchType: str(agc.keyword?.matchType), status: str(agc.status) }
    }
    case 'ad': {
      const id = str(row.adGroupAd?.ad?.id)
      return { adId: ag && id ? `${ag}~${id}` : id, type: str(row.adGroupAd?.ad?.type), status: str(row.adGroupAd?.status) }
    }
    case 'asset': return assetItem(row, row.campaignAsset ?? {})
    case 'ad-group-asset': return assetItem(row, row.adGroupAsset ?? {})
    case 'asset-group-asset': return { assetGroupId: str(row.assetGroup?.id), assetGroupName: str(row.assetGroup?.name), ...assetItem(row, row.assetGroupAsset ?? {}) }
    case 'product': return { itemId: str(row.segments?.productItemId), title: null, brand: str(row.segments?.productBrand) }
    case 'search-term': return { searchTerm: str(row.campaignSearchTermView?.searchTerm) }
    case 'location': return {
      locationId: tail(row.segments?.geoTargetMostSpecificLocation),
      countryId: str(row.geographicView?.countryCriterionId),
      locationType: str(row.geographicView?.locationType),
    }
    case 'age': return { criterionId: str(agc.criterionId), ageRange: str(agc.ageRange?.type) }
    case 'gender': return { criterionId: str(agc.criterionId), gender: str(agc.gender?.type) }
    case 'audience': return { criterionId: str(cc.criterionId), type: str(cc.type), name: str(cc.displayName), bidModifier: opt(cc.bidModifier) }
    case 'ad-group-audience': return { criterionId: str(agc.criterionId), type: str(agc.type), name: str(agc.displayName), bidModifier: opt(agc.bidModifier) }
  }
}

/** One of Google's rows → its numbers in cents and percent, with what it is about and its split. */
export function numbersRowOf(level: NumberLevel, row: Json, segments: readonly NumberSegment[] = []): NumbersRow {
  const spec = NUMBER_LEVEL_SPECS[level]
  const m = row.metrics ?? {}
  const out: NumbersRow = {
    campaignId: str(row.campaign?.id),
    campaignName: str(row.campaign?.name),
    item: itemOf(level, row),
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    ctrPct: pctOf(m.ctr),
    spendCents: centsOfMicros(m.costMicros) ?? 0,
    avgCpcCents: centsOfMicros(m.averageCpc),
    conversions: round(num(m.conversions), 2),
    conversionValueCents: centsOfUnits(m.conversionsValue) ?? 0,
  }
  if (row.adGroup) { out.adGroupId = str(row.adGroup.id); out.adGroupName = str(row.adGroup.name) }
  if (segments.length) {
    const s = row.segments ?? {}
    const seg: NonNullable<NumbersRow['segments']> = {}
    for (const k of segments) {
      if (k === 'day') seg.date = str(s.date)
      if (k === 'hour') seg.hour = opt(s.hour) ?? 0
      if (k === 'day-of-week') seg.dayOfWeek = str(s.dayOfWeek)
      if (k === 'device') seg.device = str(s.device)
      if (k === 'network') seg.network = str(s.adNetworkType)
    }
    out.segments = seg
  }
  if (spec.impressionShare.length) {
    const share: NonNullable<NumbersRow['impressionShare']> = {}
    const json: Record<keyof typeof IS, string> = {
      search: 'searchImpressionShare', top: 'searchTopImpressionShare', absoluteTop: 'searchAbsoluteTopImpressionShare',
      lostToBudget: 'searchBudgetLostImpressionShare', lostToRank: 'searchRankLostImpressionShare',
    }
    for (const [key, field] of Object.entries(IS) as Array<[keyof typeof IS, string]>) {
      if (spec.impressionShare.includes(field)) share[key] = pctOf(m[json[key]])
    }
    out.impressionShare = share
  }
  return out
}

export interface NumbersTotals {
  rows: number
  impressions: number
  clicks: number
  ctrPct: number | null
  spendCents: number
  avgCpcCents: number | null
  conversions: number
  conversionValueCents: number
  costPerConversionCents: number | null
  /** Conversion value / cost (2 = value twice the cost). */
  roas: number | null
}

/** The rows summed (ratios from the sums). */
export function numbersTotals(rows: readonly NumbersRow[]): NumbersTotals {
  const t = rows.reduce((a, r) => ({
    impressions: a.impressions + r.impressions,
    clicks: a.clicks + r.clicks,
    spendCents: a.spendCents + (r.spendCents ?? 0),
    conversions: a.conversions + r.conversions,
    conversionValueCents: a.conversionValueCents + (r.conversionValueCents ?? 0),
  }), { impressions: 0, clicks: 0, spendCents: 0, conversions: 0, conversionValueCents: 0 })
  return {
    rows: rows.length,
    ...t,
    conversions: round(t.conversions, 2),
    ctrPct: t.impressions ? round((t.clicks / t.impressions) * 100, 2) : null,
    avgCpcCents: t.clicks ? Math.round(t.spendCents / t.clicks) : null,
    costPerConversionCents: t.conversions ? Math.round(t.spendCents / t.conversions) : null,
    roas: t.spendCents ? round(t.conversionValueCents / t.spendCents, 2) : null,
  }
}

export interface LiveNumbers {
  query: string
  rows: NumbersRow[]
  /** The read hit its LIMIT: there may be more rows (the totals cover the rows shown). */
  truncated: boolean
  /** A part Google refused (the names of locations or products), the rest still answered. */
  notRead: Array<{ part: string; why: string }>
}

/** One numbers read, live: the query, then for locations and products one more query for their names. */
export async function liveNumbers(target: GoogleAdsTarget, request: NumbersRequest): Promise<LiveNumbers> {
  const query = numbersQuery(request)
  const segments = [...new Set(request.segments ?? [])]
  const raw = await liveRows<Json>(target, query, 'ads.search.live.numbers')
  const rows = raw.map((r) => numbersRowOf(request.level, r, segments))
  const notRead: LiveNumbers['notRead'] = []
  if (request.level === 'location' && rows.length) {
    const ids = rows.flatMap((r) => [r.item.locationId, r.item.countryId]).filter((id): id is string => typeof id === 'string' && /^\d{1,20}$/.test(id))
    if (ids.length) {
      try {
        const names = new Map<string, string | null>()
        for (const g of await liveRows<Json>(target, geoNamesQuery(ids), 'ads.search.live.geo-names')) {
          const c = g.geoTargetConstant ?? {}
          if (str(c.id)) names.set(str(c.id)!, str(c.canonicalName) ?? str(c.name))
        }
        for (const r of rows) {
          r.item.locationName = names.get(String(r.item.locationId)) ?? null
          r.item.countryName = names.get(String(r.item.countryId)) ?? null
        }
      } catch (err) {
        notRead.push({ part: 'location names', why: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  if (request.level === 'product' && rows.length) {
    const ids = rows.map((r) => r.item.itemId).filter((id): id is string => typeof id === 'string' && ITEM_ID.test(id))
    if (ids.length) {
      try {
        const titles = new Map<string, string | null>()
        for (const p of await liveRows<Json>(target, productTitlesQuery(request.window, ids), 'ads.search.live.product-titles')) {
          const id = str(p.segments?.productItemId)
          if (id && !titles.get(id)) titles.set(id, str(p.segments?.productTitle))
        }
        for (const r of rows) r.item.title = titles.get(String(r.item.itemId)) ?? null
      } catch (err) {
        notRead.push({ part: 'product titles', why: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { query, rows, truncated: raw.length >= Math.floor(request.limit ?? 100), notRead }
}
