/**
 * Google Ads step 1a — the query texts are golden: a field renamed by a Google Ads version shows up here first.
 * Every query that selects segments.date filters it; the change history is bounded (30 days, LIMIT ≤ 10,000).
 */
import { describe, expect, it } from 'vitest'
import {
  CAMPAIGNS_QUERY, CHANGE_EVENT_LIMIT, CUSTOMER_CLIENTS_QUERY, CUSTOMER_QUERY, campaignDailyMetricsQuery, changeEventsQuery,
} from './gaql.js'
import { changeHistoryWindow } from './dates.js'

describe('Google Ads queries (v25 field names)', () => {
  it('the account and a manager\'s clients', () => {
    expect(CUSTOMER_QUERY).toBe(
      'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, ' +
      'customer.test_account, customer.status FROM customer',
    )
    expect(CUSTOMER_CLIENTS_QUERY).toBe(
      'SELECT customer_client.client_customer, customer_client.id, customer_client.level, customer_client.manager, ' +
      'customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, ' +
      'customer_client.test_account FROM customer_client WHERE customer_client.level <= 1',
    )
  })

  it('campaigns with their budgets, removed ones left out; v25 start_date_time / end_date_time', () => {
    expect(CAMPAIGNS_QUERY).toBe(
      'SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, ' +
      'campaign.primary_status_reasons, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, ' +
      'campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.target_cpa.target_cpa_micros, ' +
      'campaign.target_roas.target_roas, campaign.maximize_conversions.target_cpa_micros, ' +
      'campaign.maximize_conversion_value.target_roas, campaign.start_date_time, campaign.end_date_time, ' +
      'campaign.shopping_setting.merchant_id, campaign.shopping_setting.feed_label, campaign_budget.id, ' +
      'campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.period, ' +
      "campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'",
    )
    // v25 has no campaign.start_date / campaign.end_date (Google answers UNRECOGNIZED_FIELD).
    expect(CAMPAIGNS_QUERY).not.toMatch(/campaign\.(start|end)_date[,\s]/)
  })

  it('daily campaign numbers: a finite window, both ends included, no derived ratio', () => {
    expect(campaignDailyMetricsQuery({ from: '2026-09-29', to: '2026-10-12' })).toBe(
      'SELECT campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
      'metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM campaign ' +
      "WHERE segments.date BETWEEN '2026-09-29' AND '2026-10-12'",
    )
    expect(campaignDailyMetricsQuery({ from: '2026-10-12', to: '2026-10-12' })).toContain("BETWEEN '2026-10-12' AND '2026-10-12'")
    expect(() => campaignDailyMetricsQuery({ from: '2026-10-13', to: '2026-10-12' })).toThrow('ends before it starts')
    expect(() => campaignDailyMetricsQuery({ from: "2026-10-01' OR '1'='1", to: '2026-10-12' })).toThrow('is not a day')
  })

  it('change history: oldest first, a date-time window, LIMIT at most 10,000', () => {
    expect(changeEventsQuery('2026-09-14 00:00:00', '2026-10-13 08:25:00')).toBe(
      'SELECT change_event.resource_name, change_event.change_date_time, change_event.change_resource_type, ' +
      'change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields, ' +
      'change_event.client_type, change_event.user_email, change_event.campaign, change_event.ad_group, ' +
      'change_event.old_resource, change_event.new_resource FROM change_event ' +
      "WHERE change_event.change_date_time >= '2026-09-14 00:00:00' AND change_event.change_date_time <= '2026-10-13 08:25:00' " +
      'ORDER BY change_event.change_date_time ASC LIMIT 10000',
    )
    expect(CHANGE_EVENT_LIMIT).toBe(10_000)
    expect(changeEventsQuery('2026-10-01 00:00:00', '2026-10-02 00:00:00', 500)).toMatch(/ LIMIT 500$/)
    expect(() => changeEventsQuery('2026-10-01 00:00:00', '2026-10-02 00:00:00', 10_001)).toThrow('LIMIT')
    expect(() => changeEventsQuery('2026-10-01 00:00:00', '2026-10-02 00:00:00', 0)).toThrow('LIMIT')
    expect(() => changeEventsQuery('2026-10-02 00:00:00', '2026-10-01 00:00:00')).toThrow('ends before it starts')
    expect(() => changeEventsQuery('2026-10-01', '2026-10-02 00:00:00')).toThrow('is not a date and time')
  })

  it('the change history window the dates give is always inside Google\'s 30 days', () => {
    const now = new Date('2026-10-13T06:25:00Z')
    const fresh = changeHistoryWindow('Europe/Rome', now, null)
    const query = changeEventsQuery(fresh.startLiteral, fresh.endLiteral)
    expect(query).toContain("change_event.change_date_time >= '2026-09-14 00:00:00'")
    expect(query).toContain("change_event.change_date_time <= '2026-10-13 08:25:00'")
    expect(now.getTime() - fresh.start.getTime()).toBeLessThan(30 * 86_400_000)
  })

  it('no query asks for a page size or streams', () => {
    for (const q of [CUSTOMER_QUERY, CUSTOMER_CLIENTS_QUERY, CAMPAIGNS_QUERY, campaignDailyMetricsQuery({ from: '2026-10-01', to: '2026-10-02' }),
      changeEventsQuery('2026-10-01 00:00:00', '2026-10-02 00:00:00')]) {
      expect(q).not.toMatch(/page_size|PARAMETERS/i)
      expect(q.startsWith('SELECT ')).toBe(true)
    }
  })
})
