/**
 * Google Ads steps 1a and 1b — the query texts are golden: a field renamed by a Google Ads version shows up here first.
 * Every query that selects segments.date filters it; the change history is bounded (30 days, LIMIT ≤ 10,000). The
 * fields were checked against Google's v25 field reference (gaql.ts says where); four reads keep a safety-net twin
 * without one field, which differs from the first text by that field only.
 */
import { describe, expect, it } from 'vitest'
import * as gaql from './gaql.js'
import {
  ACCOUNT_NEGATIVE_LIST_LINKS_QUERY, AD_GROUPS_QUERY, AD_GROUP_KEYWORDS_QUERY, AD_POLICY_QUERY, ASSET_GROUPS_QUERY, AUTO_APPLY_QUERY, CAMPAIGNS_QUERY, CAMPAIGN_FLAGS_QUERY,
  CAMPAIGN_FLAGS_QUERY_WITHOUT_ASSET_AUTOMATION, CAMPAIGN_NEGATIVES_QUERY, CHANGE_EVENT_LIMIT, CUSTOMER_CLIENTS_QUERY, CUSTOMER_QUERY,
  NEGATIVE_LIST_ATTACHMENTS_QUERY, NEGATIVE_LIST_ATTACHMENTS_QUERY_WITHOUT_SET, NEGATIVE_LIST_KEYWORDS_QUERY, NEGATIVE_LIST_KEYWORDS_QUERY_WITHOUT_SET,
  RECOMMENDATIONS_QUERY, RECOMMENDATIONS_QUERY_WITHOUT_IMPACT, SHOPPING_PRODUCTS_QUERY, adGroupDailyMetricsQuery, assetGroupDailyMetricsQuery,
  campaignDailyMetricsQuery, changeEventsQuery, keywordDailyMetricsQuery, productDailyMetricsQuery, searchTermDailyMetricsQuery,
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

const M = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value'
const W = { from: '2026-09-29', to: '2026-10-12' }

describe('Google Ads step 1b queries (v25 field names)', () => {
  it('tier 2: campaign settings, and the safety-net twin without asset_automation_settings', () => {
    expect(CAMPAIGN_FLAGS_QUERY).toBe(
      'SELECT campaign.id, campaign.ai_max_setting.enable_ai_max, campaign.keyword_match_type, campaign.broad_match_migration_date_time, ' +
      'campaign.asset_automation_settings, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, ' +
      'campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, ' +
      "campaign.dynamic_search_ads_setting.domain_name FROM campaign WHERE campaign.status != 'REMOVED'",
    )
    expect(CAMPAIGN_FLAGS_QUERY_WITHOUT_ASSET_AUTOMATION).toBe(CAMPAIGN_FLAGS_QUERY.replace('campaign.asset_automation_settings, ', ''))
    // v25 has no url_expansion_opt_out.
    expect(CAMPAIGN_FLAGS_QUERY).not.toContain('url_expansion_opt_out')
  })

  it('tier 2: ad approvals and product status filter nothing on the approval or the product status (the mapper does)', () => {
    expect(AD_POLICY_QUERY).toBe(
      'SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ' +
      'ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ' +
      'ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad ' +
      "WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status != 'REMOVED'",
    )
    expect(AD_POLICY_QUERY).not.toMatch(/WHERE.*approval_status/)
    expect(SHOPPING_PRODUCTS_QUERY).toBe(
      'SELECT shopping_product.merchant_center_id, shopping_product.channel, shopping_product.language_code, ' +
      'shopping_product.feed_label, shopping_product.item_id, shopping_product.title, shopping_product.status, ' +
      'shopping_product.issues FROM shopping_product',
    )
    expect(AUTO_APPLY_QUERY).toBe(
      'SELECT recommendation_subscription.type, recommendation_subscription.status, recommendation_subscription.create_date_time, ' +
      'recommendation_subscription.modify_date_time FROM recommendation_subscription',
    )
  })

  it('tier 3: numbers per day, a finite window, both ends included', () => {
    expect(adGroupDailyMetricsQuery(W)).toBe(
      `SELECT campaign.id, ad_group.id, ad_group.name, segments.date, ${M} FROM ad_group WHERE segments.date BETWEEN '2026-09-29' AND '2026-10-12'`,
    )
    expect(keywordDailyMetricsQuery(W)).toBe(
      'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, segments.date, ' +
      `${M} FROM keyword_view WHERE segments.date BETWEEN '2026-09-29' AND '2026-10-12'`,
    )
    expect(assetGroupDailyMetricsQuery(W)).toBe(
      `SELECT campaign.id, asset_group.id, asset_group.name, segments.date, ${M} FROM asset_group WHERE segments.date BETWEEN '2026-09-29' AND '2026-10-12'`,
    )
    expect(productDailyMetricsQuery(W)).toBe(
      `SELECT campaign.id, segments.product_item_id, segments.product_title, segments.date, ${M} FROM shopping_performance_view ` +
      "WHERE segments.date BETWEEN '2026-09-29' AND '2026-10-12' AND metrics.impressions > 0",
    )
    expect(searchTermDailyMetricsQuery(W)).toBe(
      `SELECT campaign.id, campaign_search_term_view.search_term, segments.date, ${M} FROM campaign_search_term_view ` +
      "WHERE segments.date BETWEEN '2026-09-29' AND '2026-10-12' AND metrics.clicks > 0",
    )
    // The safety-net twin without the clicks filter: the mapper drops the terms without a click.
    expect(searchTermDailyMetricsQuery(W, false)).toBe(searchTermDailyMetricsQuery(W).replace(' AND metrics.clicks > 0', ''))
    for (const query of [adGroupDailyMetricsQuery, keywordDailyMetricsQuery, assetGroupDailyMetricsQuery, productDailyMetricsQuery, searchTermDailyMetricsQuery]) {
      expect(() => query({ from: '2026-10-13', to: '2026-10-12' })).toThrow('ends before it starts')
      expect(() => query({ from: "2026-10-01' OR '1'='1", to: '2026-10-12' })).toThrow('is not a day')
    }
  })

  it('tier 4: structure, removed ones left out', () => {
    expect(AD_GROUPS_QUERY).toBe(
      'SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ' +
      'ad_group.target_cpa_micros, ad_group.target_roas, ad_group.primary_status, ad_group.primary_status_reasons, ' +
      "ad_group.ai_max_ad_group_setting.disable_search_term_matching FROM ad_group WHERE ad_group.status != 'REMOVED' " +
      "AND campaign.status != 'REMOVED'",
    )
    expect(AD_GROUP_KEYWORDS_QUERY).toBe(
      'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.negative, ad_group_criterion.status, ' +
      'ad_group_criterion.type, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ' +
      'ad_group_criterion.quality_info.quality_score, ad_group_criterion.system_serving_status, ad_group_criterion.approval_status, ' +
      'ad_group_criterion.primary_status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros ' +
      "FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' " +
      "AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    )
    expect(CAMPAIGN_NEGATIVES_QUERY).toBe(
      'SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.negative, campaign_criterion.type, ' +
      'campaign_criterion.status, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, ' +
      'campaign_criterion.brand_list.shared_set FROM campaign_criterion WHERE campaign_criterion.negative = TRUE ' +
      "AND campaign_criterion.type IN ('KEYWORD', 'BRAND_LIST') AND campaign_criterion.status != 'REMOVED' " +
      "AND campaign.status != 'REMOVED'",
    )
    expect(ASSET_GROUPS_QUERY).toBe(
      'SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status, ' +
      'asset_group.primary_status_reasons, asset_group.ad_strength, asset_group.final_urls FROM asset_group ' +
      "WHERE asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    )
  })

  it('tier 5: negative keyword lists (with shared_set.*) and recommendations (with the impact), each with its safety-net twin', () => {
    const set = 'shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count'
    expect(NEGATIVE_LIST_KEYWORDS_QUERY).toBe(
      'SELECT shared_criterion.shared_set, shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text, ' +
      `shared_criterion.keyword.match_type, ${set} FROM shared_criterion WHERE shared_criterion.type = 'KEYWORD'`,
    )
    expect(NEGATIVE_LIST_KEYWORDS_QUERY_WITHOUT_SET).toBe(NEGATIVE_LIST_KEYWORDS_QUERY.replace(`, ${set}`, ''))
    expect(NEGATIVE_LIST_ATTACHMENTS_QUERY).toBe(
      `SELECT campaign_shared_set.campaign, campaign_shared_set.shared_set, campaign_shared_set.status, ${set} ` +
      "FROM campaign_shared_set WHERE campaign_shared_set.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    )
    expect(NEGATIVE_LIST_ATTACHMENTS_QUERY_WITHOUT_SET).toBe(NEGATIVE_LIST_ATTACHMENTS_QUERY.replace(`, ${set}`, ''))
    // The account-level list is in force only while a customer_negative_criterion points at it.
    expect(ACCOUNT_NEGATIVE_LIST_LINKS_QUERY).toBe(
      'SELECT customer_negative_criterion.negative_keyword_list.shared_set FROM customer_negative_criterion ' +
      "WHERE customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'",
    )
    // recommendation.impact is Selectable only whole: its leaves are not query fields (Google answers UNRECOGNIZED_FIELD).
    expect(RECOMMENDATIONS_QUERY).toBe(
      'SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.ad_group, ' +
      'recommendation.dismissed, recommendation.impact FROM recommendation',
    )
    expect(RECOMMENDATIONS_QUERY_WITHOUT_IMPACT).toBe(RECOMMENDATIONS_QUERY.replace(', recommendation.impact', ''))
  })

  /** Every text Nexus sends (the change history with a fixed window). */
  const allTexts = (): string[] => {
    const texts = Object.entries(gaql).flatMap(([name, value]) => {
      if (typeof value === 'string' && /_QUERY($|_)/.test(name)) return [value]
      if (typeof value === 'function' && name.endsWith('Query') && name !== 'changeEventsQuery') return [(value as (w: typeof W) => string)(W)]
      return []
    })
    texts.push(changeEventsQuery('2026-10-01 00:00:00', '2026-10-02 00:00:00'), searchTermDailyMetricsQuery(W, false))
    return texts
  }

  it('every query only reads: a SELECT, no page size, no change of anything', () => {
    const texts = allTexts()
    // Step 1a: 5 (with the change history); step 1b: 17 + 5 safety-net twins (one field or filter less each).
    expect(texts.length).toBe(27)
    for (const q of texts) {
      expect(q.startsWith('SELECT ')).toBe(true)
      expect(q).not.toMatch(/page_size|PARAMETERS|\bmutate\b/i)
      if (q.includes('segments.date')) expect(q).toMatch(/segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/)
    }
  })

  it('a message the v25 field reference lists as one field is selected whole, never by its leaves', () => {
    // Google answers UNRECOGNIZED_FIELD for a leaf it does not list (e.g. recommendation.impact.base_metrics.clicks).
    const wholeOnly = ['recommendation.impact', 'campaign.asset_automation_settings', 'ad_group_ad.policy_summary.policy_topic_entries',
      'shopping_product.issues', 'change_event.changed_fields', 'change_event.old_resource', 'change_event.new_resource']
    for (const q of allTexts()) {
      const selected = q.slice('SELECT '.length, q.indexOf(' FROM ')).split(', ')
      for (const field of selected) {
        for (const message of wholeOnly) expect(field.startsWith(`${message}.`), `${field} in: ${q}`).toBe(false)
      }
    }
  })
})
