/**
 * Google Ads step 1a — every Google Ads Query Language text Nexus sends, in one place (PLAN.md L10: customer,
 * customer_client, campaign + campaign_budget, daily campaign numbers, change history). Ad groups, keywords,
 * search terms, asset groups and products come with step 1b.
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
