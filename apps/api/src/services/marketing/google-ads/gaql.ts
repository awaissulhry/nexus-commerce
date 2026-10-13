/**
 * Google Ads steps 1a and 1b — every Google Ads Query Language text Nexus sends, in one place. Step 1a (PLAN.md L10):
 * customer, customer_client, campaign + campaign_budget, daily campaign numbers, change history. Step 1b
 * (plan-1b-backend §1–§2), by tier: 2 safety (campaign settings, ad approvals, product status, auto-apply), 3 numbers
 * (ad group, keyword, asset group, product and search term days), 4 structure (ad groups, keywords + ad-group
 * negatives, campaign negatives + brand lists, asset groups), 5 slow (negative keyword lists and their attachments,
 * recommendations).
 *
 * NOT VERIFIED against a live account (plan-1b-backend §1): campaign.asset_automation_settings, shared_set.* through
 * campaign_shared_set / shared_criterion, recommendation.impact.*, `metrics.clicks > 0` on campaign_search_term_view.
 * Each has a `…_WITHOUT_…` twin that the sync sends once when Google refuses the first text; what the twin leaves out
 * is then "not read", never a default.
 *
 * Field names checked against the v25 field reference (developers.google.com/google-ads/api/fields/v25/…,
 * 2026-10-13). v25 has no `campaign.start_date` / `campaign.end_date`: they are `campaign.start_date_time` /
 * `campaign.end_date_time` ("yyyy-MM-dd HH:mm:ss", the account's time zone).
 *
 * Every query that selects `segments.date` filters it to a finite window; the change history is bounded to the last
 * 30 days and LIMITed to at most 10,000 rows, as Google requires. Only `search` is used (bounded pages); a page size
 * is never sent (Google answers PAGE_SIZE_NOT_SUPPORTED).
 */
import type { DayWindow } from './dates.js'

/** The account itself: name, currency, time zone, manager or not, test or not. */
export const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, ' +
  'customer.test_account, customer.status FROM customer'

/** A manager's own row (level 0) and its direct clients (level 1); asked on demand, during account discovery. */
export const CUSTOMER_CLIENTS_QUERY =
  'SELECT customer_client.client_customer, customer_client.id, customer_client.level, customer_client.manager, ' +
  'customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, ' +
  'customer_client.test_account FROM customer_client WHERE customer_client.level <= 1'

/** Every campaign that is not removed, with its budget. A campaign no longer returned is marked removed by the store. */
export const CAMPAIGNS_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, ' +
  'campaign.primary_status_reasons, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, ' +
  'campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.target_cpa.target_cpa_micros, ' +
  'campaign.target_roas.target_roas, campaign.maximize_conversions.target_cpa_micros, ' +
  'campaign.maximize_conversion_value.target_roas, campaign.start_date_time, campaign.end_date_time, ' +
  'campaign.shopping_setting.merchant_id, campaign.shopping_setting.feed_label, campaign_budget.id, ' +
  'campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.period, ' +
  "campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'"

/** The numbers every daily metrics query reads (ratios are computed by Nexus, never stored). */
export const METRIC_FIELDS = [
  'metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions', 'metrics.conversions_value',
  'metrics.all_conversions', 'metrics.all_conversions_value',
] as const

/** Google's change history keeps 30 days and answers at most 10,000 rows per query. */
export const CHANGE_EVENT_LIMIT = 10_000

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function day(value: string): string {
  if (!DAY.test(value)) throw new Error(`gaql: "${value}" is not a day (YYYY-MM-DD). Nothing was sent.`)
  return value
}

/**
 * One row per campaign and account day in the window (both ends included). The campaign's name rides along, so the
 * numbers of a campaign removed before Nexus first read the account still have a name.
 */
export function campaignDailyMetricsQuery(window: DayWindow): string {
  const from = day(window.from)
  const to = day(window.to)
  if (from > to) throw new Error(`gaql: the window ${from} … ${to} ends before it starts. Nothing was sent.`)
  return `SELECT campaign.id, campaign.name, segments.date, ${METRIC_FIELDS.join(', ')} FROM campaign ` +
    `WHERE segments.date BETWEEN '${from}' AND '${to}'`
}

/**
 * The change history between two instants, written as "YYYY-MM-DD HH:MM:SS" in the account's time zone (dates.ts
 * `changeHistoryWindow` makes them), oldest first so a read that hits the LIMIT continues after its last row.
 */
export function changeEventsQuery(start: string, end: string, limit: number = CHANGE_EVENT_LIMIT): string {
  for (const value of [start, end]) {
    if (!DATE_TIME.test(value)) throw new Error(`gaql: "${value}" is not a date and time (YYYY-MM-DD HH:MM:SS). Nothing was sent.`)
  }
  if (start > end) throw new Error(`gaql: the change history window ${start} … ${end} ends before it starts. Nothing was sent.`)
  const rows = Math.floor(limit)
  if (!(rows >= 1 && rows <= CHANGE_EVENT_LIMIT)) throw new Error(`gaql: the change history LIMIT must be 1 … ${CHANGE_EVENT_LIMIT}. Nothing was sent.`)
  return 'SELECT change_event.resource_name, change_event.change_date_time, change_event.change_resource_type, ' +
    'change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields, ' +
    'change_event.client_type, change_event.user_email, change_event.campaign, change_event.ad_group, ' +
    'change_event.old_resource, change_event.new_resource FROM change_event ' +
    `WHERE change_event.change_date_time >= '${start}' AND change_event.change_date_time <= '${end}' ` +
    `ORDER BY change_event.change_date_time ASC LIMIT ${rows}`
}

// ── Step 1b ──────────────────────────────────────────────────────────────────────────────────────────────────────

function windowClause(window: DayWindow): string {
  const from = day(window.from)
  const to = day(window.to)
  if (from > to) throw new Error(`gaql: the window ${from} … ${to} ends before it starts. Nothing was sent.`)
  return `segments.date BETWEEN '${from}' AND '${to}'`
}

// Tier 2 — safety.

const CAMPAIGN_FLAG_FIELDS = [
  'campaign.id', 'campaign.ai_max_setting.enable_ai_max', 'campaign.keyword_match_type', 'campaign.broad_match_migration_date_time',
  'campaign.asset_automation_settings', 'campaign.network_settings.target_google_search', 'campaign.network_settings.target_search_network',
  'campaign.network_settings.target_content_network', 'campaign.network_settings.target_partner_search_network',
  'campaign.dynamic_search_ads_setting.domain_name',
] as const

/** The settings by which Google acts on its own: AI Max, campaign-level broad match, asset automation, networks, DSA. */
export const CAMPAIGN_FLAGS_QUERY = `SELECT ${CAMPAIGN_FLAG_FIELDS.join(', ')} FROM campaign WHERE campaign.status != 'REMOVED'`

/** The same without asset_automation_settings (NOT VERIFIED as selectable): Final URL expansion and text customization are then not read. */
export const CAMPAIGN_FLAGS_QUERY_WITHOUT_ASSET_AUTOMATION =
  `SELECT ${CAMPAIGN_FLAG_FIELDS.filter((f) => f !== 'campaign.asset_automation_settings').join(', ')} FROM campaign WHERE campaign.status != 'REMOVED'`

/**
 * Every ad that can show (the ad and its ad group enabled, the campaign not removed) with its approval; the mapper keeps
 * the disapproved and limited ones (no filter on the approval). A paused ad is left out: it does not show anyway, so it
 * must not raise "disapproved, it does not show"; when it is paused, its open issue is resolved by the next read.
 */
export const AD_POLICY_QUERY =
  'SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ' +
  'ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ' +
  'ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad ' +
  "WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status != 'REMOVED'"

/** Every product of the linked Merchant Center accounts with its status and issues; the mapper keeps the not eligible and limited ones. */
export const SHOPPING_PRODUCTS_QUERY =
  'SELECT shopping_product.merchant_center_id, shopping_product.channel, shopping_product.language_code, ' +
  'shopping_product.feed_label, shopping_product.item_id, shopping_product.title, shopping_product.status, ' +
  'shopping_product.issues FROM shopping_product'

/** Google's auto-apply settings: which recommendation types Google applies by itself. */
export const AUTO_APPLY_QUERY =
  'SELECT recommendation_subscription.type, recommendation_subscription.status, recommendation_subscription.create_date_time, ' +
  'recommendation_subscription.modify_date_time FROM recommendation_subscription'

// Tier 3 — numbers per day (the same metrics as the campaign's; a finite window, never today).

const M = METRIC_FIELDS.join(', ')

export function adGroupDailyMetricsQuery(window: DayWindow): string {
  return `SELECT campaign.id, ad_group.id, ad_group.name, segments.date, ${M} FROM ad_group WHERE ${windowClause(window)}`
}

export function keywordDailyMetricsQuery(window: DayWindow): string {
  return 'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, segments.date, ' +
    `${M} FROM keyword_view WHERE ${windowClause(window)}`
}

export function assetGroupDailyMetricsQuery(window: DayWindow): string {
  return `SELECT campaign.id, asset_group.id, asset_group.name, segments.date, ${M} FROM asset_group WHERE ${windowClause(window)}`
}

/** Products with at least one impression (Shopping and Performance Max). */
export function productDailyMetricsQuery(window: DayWindow): string {
  return `SELECT campaign.id, segments.product_item_id, segments.product_title, segments.date, ${M} FROM shopping_performance_view ` +
    `WHERE ${windowClause(window)} AND metrics.impressions > 0`
}

/**
 * Search terms per campaign (Search, Shopping and Performance Max), only terms with at least one click. Without
 * `withClicksFilter` the filter is left out (NOT VERIFIED on this view) and the mapper drops the terms without a click.
 */
export function searchTermDailyMetricsQuery(window: DayWindow, withClicksFilter = true): string {
  return `SELECT campaign.id, campaign_search_term_view.search_term, segments.date, ${M} FROM campaign_search_term_view ` +
    `WHERE ${windowClause(window)}${withClicksFilter ? ' AND metrics.clicks > 0' : ''}`
}

// Tier 4 — structure (what is not removed; the store marks what a full read no longer returns).

export const AD_GROUPS_QUERY =
  'SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ' +
  'ad_group.target_cpa_micros, ad_group.target_roas, ad_group.primary_status, ad_group.primary_status_reasons, ' +
  "ad_group.ai_max_ad_group_setting.disable_search_term_matching FROM ad_group WHERE ad_group.status != 'REMOVED' " +
  "AND campaign.status != 'REMOVED'"

/** The ad groups' keywords and their negative keywords (ad_group_criterion.negative tells them apart). */
export const AD_GROUP_KEYWORDS_QUERY =
  'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.negative, ad_group_criterion.status, ' +
  'ad_group_criterion.type, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ' +
  'ad_group_criterion.quality_info.quality_score, ad_group_criterion.system_serving_status, ad_group_criterion.approval_status, ' +
  'ad_group_criterion.primary_status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros ' +
  "FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' " +
  "AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'"

/** The campaigns' negative keywords and brand exclusions (a Performance Max brand list is a BRAND_LIST criterion). */
export const CAMPAIGN_NEGATIVES_QUERY =
  'SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.negative, campaign_criterion.type, ' +
  'campaign_criterion.status, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, ' +
  'campaign_criterion.brand_list.shared_set FROM campaign_criterion WHERE campaign_criterion.negative = TRUE ' +
  "AND campaign_criterion.type IN ('KEYWORD', 'BRAND_LIST') AND campaign_criterion.status != 'REMOVED' " +
  "AND campaign.status != 'REMOVED'"

export const ASSET_GROUPS_QUERY =
  'SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status, ' +
  'asset_group.primary_status_reasons, asset_group.ad_strength, asset_group.final_urls FROM asset_group ' +
  "WHERE asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'"

// Tier 5 — slow-moving.

const SHARED_SET_FIELDS = 'shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count'

/** The keywords of the negative keyword lists, with their list (shared_set.* NOT VERIFIED through shared_criterion). */
export const NEGATIVE_LIST_KEYWORDS_QUERY =
  'SELECT shared_criterion.shared_set, shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text, ' +
  `shared_criterion.keyword.match_type, ${SHARED_SET_FIELDS} FROM shared_criterion WHERE shared_criterion.type = 'KEYWORD'`

/** The same without the list's details: names and sizes are then not read by this query. */
export const NEGATIVE_LIST_KEYWORDS_QUERY_WITHOUT_SET =
  'SELECT shared_criterion.shared_set, shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text, ' +
  "shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_criterion.type = 'KEYWORD'"

/** Which campaigns each list is attached to, with the list (shared_set.* NOT VERIFIED through campaign_shared_set). */
export const NEGATIVE_LIST_ATTACHMENTS_QUERY =
  `SELECT campaign_shared_set.campaign, campaign_shared_set.shared_set, campaign_shared_set.status, ${SHARED_SET_FIELDS} ` +
  "FROM campaign_shared_set WHERE campaign_shared_set.status != 'REMOVED' AND campaign.status != 'REMOVED'"

/** The same without the list's details: an attachment then counts only for a list known as a negative keyword list. */
export const NEGATIVE_LIST_ATTACHMENTS_QUERY_WITHOUT_SET =
  'SELECT campaign_shared_set.campaign, campaign_shared_set.shared_set, campaign_shared_set.status FROM campaign_shared_set ' +
  "WHERE campaign_shared_set.status != 'REMOVED' AND campaign.status != 'REMOVED'"

const IMPACT_METRICS = ['impressions', 'clicks', 'cost_micros', 'conversions', 'conversions_value'] as const
const IMPACT_FIELDS = (['base_metrics', 'potential_metrics'] as const)
  .flatMap((side) => IMPACT_METRICS.map((metric) => `recommendation.impact.${side}.${metric}`))

/** Google's recommendations, read only (step 1b never applies or dismisses one). */
export const RECOMMENDATIONS_QUERY =
  'SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.ad_group, ' +
  `recommendation.dismissed, ${IMPACT_FIELDS.join(', ')} FROM recommendation`

/** The same without the impact (recommendation.impact.* NOT VERIFIED): the impact is then not read. */
export const RECOMMENDATIONS_QUERY_WITHOUT_IMPACT =
  'SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.ad_group, ' +
  'recommendation.dismissed FROM recommendation'
