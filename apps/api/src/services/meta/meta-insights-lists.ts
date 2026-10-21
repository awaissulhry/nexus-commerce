/**
 * Meta ads step 7 (2026-10-21) — the FIXED lists of what Nexus may ask Meta's insights for: every metric (field), breakdown,
 * action breakdown, attribution window, date preset, level, filter field and sort Nexus sends, and the rules that join
 * them. ONE place, read by the numbers builder (marketing/meta-ads/live-insights.ts) and by the gateway
 * (gateway/meta-calls.ts: the value of each insights query key, and the whole body of a report run
 * `POST /act_<id>/insights`), so what the builder may send is exactly what the gateway lets through. A caller never names
 * a raw Graph field: a name not here is refused before any call (the lesson of steps 1–2: allow-lists only).
 *
 * Checked 2026-10-21 on developers.facebook.com/documentation/ads-commerce/marketing-api/… (`.md` pages):
 *   - reference/ad-account/insights (INS): the v26 field list with types (numeric string, list<AdsActionStats>,
 *     list<AdsInsightsResult>, list<AdsHistogramStats>, asset objects) and each field's "This metric is estimated" /
 *     "This metric is in development" label; the GET parameters (action_attribution_windows enum, action_breakdowns,
 *     breakdowns enum, date_preset, default_summary, filtering operators, level, product_id_limit, sort "no more than one
 *     element", summary_action_breakdowns, time_increment 1–90 | monthly | all_days, time_range, time_ranges,
 *     use_account_attribution_setting, use_unified_attribution_setting); the POST ("an AdReportRun will be created",
 *     only on /act_{ad_account_id}/insights; adds export_format csv | xls, export_name, export_columns, graph_cache
 *     "internal use only"); errors 3018 (start beyond 37 months), 2642 (cursor), 105 (too many parameters);
 *   - insights/breakdowns (BRK): Type 1 / Type 2 off-Meta rules, "Combining breakdowns" (the permutations below, the
 *     ones marked * may add action_type, action_target_id, action_destination), Dynamic Creative asset breakdowns with
 *     impressions, clicks, spend, reach, actions, action_values only, image_asset / video_asset not at account level,
 *     frequency_value with reach only, video_* not with hourly breakdowns, video_avg_time_watched_actions and
 *     video_p25…p100 not with region, app_id / skan_conversion_id not filterable, impression_device never alone,
 *     action metrics kept under restricted breakdowns with 1d_click,7d_click,1d_view,incrementality, the feature
 *     settings (comscore, impression_device, time_of_day_viewer_tz, frequency_value);
 *   - insights/best-practices (INSBP): reach left out of sync reads with breakdowns older than 13 months, filtering in DOT
 *     notation (`ad.impressions` GREATER_THAN 0), STARTS_WITH / CONTAIN do not change the summary (use IN), async jobs,
 *     the export_report convenience endpoint, use_unified_attribution_setting and action_report_time disregarded since
 *     2025-06-10;
 *   - insights/marketing-mix-modeling (MMM): breakdowns=mmm only with export_format=csv, level adset, impressions and
 *     spend, time_increment 1 or all, no other breakdown or action breakdown, and the ONLY filters it takes (below);
 *   - out-of-cycle-changes occ-2025 / occ-2026: 7d_view / 28d_view return no data since 2026-01-12; unique-count fields
 *     with any breakdown and hourly breakdowns 13 months, frequency_value 6 months; instagram_profile_visits on the
 *     campaign, ad set and ad insights edges (not on the v26 field list); dma gone since 2026-06-22 (comscore_market);
 *     impression_device, audience-time-zone hourly and frequency_value empty without enablement since 2026-08-06;
 *   - Meta's Python Business SDK (facebook/facebook-python-business-sdk, adobjects/adsinsights.py, adreportrun.py) where a
 *     page is silent.
 */

/** How Meta sends a field's value, and so how Nexus answers it. Money kinds go only to the answer's restricted keys. */
export type MetricKind =
  | 'info' // a name, id, date or setting (text)
  | 'count' // a numeric string, a whole count
  | 'ratio' // a numeric string, a rate, a percentage, an average, a score
  | 'money' // a decimal string in the account currency → minor units
  | 'actions' // list<AdsActionStats> of counts, per action type (and per window)
  | 'actionsMoney' // list<AdsActionStats> of amounts in the account currency → minor units
  | 'actionsRatio' // list<AdsActionStats> of rates (CTR per action type)
  | 'roas' // list<AdsActionStats> of returns on ad spend (money: restricted)
  | 'results' // list<AdsInsightsResult> of counts or rates
  | 'resultsMoney' // list<AdsInsightsResult> of costs → minor units
  | 'histogram' // list<AdsHistogramStats> (video retention curves)
  | 'raw' // an object Meta does not describe in units (an asset, a string list): as Meta sent it
  | 'rawMoney' // an amount whose unit or currency Meta does not name: as Meta sent it, restricted

export const METRIC_GROUPS = [
  'identity', 'delivery', 'clicks', 'formats', 'results', 'conversions', 'standard-events', 'video', 'catalog', 'assets',
  'messaging', 'research', 'instagram', 'recall', 'other',
] as const
export type MetricGroup = typeof METRIC_GROUPS[number]

export interface MetricSpec {
  group: MetricGroup
  kind: MetricKind
  /** Meta: "This metric is estimated". */
  estimated?: true
  /** Meta: "This metric is in development". */
  inDevelopment?: true
  /** Named on another Meta page but NOT on the v26 field list: asked in a group of its own; when Meta refuses it, the rows come without it. */
  extra?: true
  /** Not on the ad account's own read (OCC 2025: campaign, ad set and ad edges only). */
  notAtAccount?: true
  /** Not on the ad's own insights edge (adgroup/insights lacks it). */
  notOnAd?: true
  /** Never with a breakdown (BRK). */
  noBreakdowns?: true
  /** Never with the region breakdown (BRK). */
  notWithRegion?: true
  /** A unique (deduplicated) count: 13 months with a breakdown, and none by hour (OCC 2025, BRK). */
  unique?: true
  /** Zero by hour (BRK: hourly breakdowns return reach and frequency as 0). */
  zeroByHour?: true
}

const spec = (group: MetricGroup, kind: MetricKind, flags = ''): MetricSpec => ({
  group, kind,
  ...(flags.includes('e') ? { estimated: true } : {}),
  ...(flags.includes('d') ? { inDevelopment: true } : {}),
  ...(flags.includes('x') ? { extra: true } : {}),
  ...(flags.includes('A') ? { notAtAccount: true } : {}),
  ...(flags.includes('D') ? { notOnAd: true } : {}),
  ...(flags.includes('B') ? { noBreakdowns: true } : {}),
  ...(flags.includes('R') ? { notWithRegion: true } : {}),
  ...(flags.includes('U') ? { unique: true } : {}),
  ...(flags.includes('H') ? { zeroByHour: true } : {}),
})
const many = (names: string, group: MetricGroup, kind: MetricKind, flags = ''): Array<[string, MetricSpec]> =>
  names.trim().split(/\s+/).map((name) => [name, spec(group, kind, flags)])

/**
 * Every field Nexus may ask on an insights read (master IN-010 … IN-025, RC-007). Not here on purpose: the auction,
 * overlap, fatigue and diversity fields (meta-ad-details view diagnostics, step 6), quality / engagement / conversion
 * rankings (not on v26), comparison_node (the insights edge takes no comparison period: IN-026), the app-only SKAdNetwork
 * fields, and the breakdown values themselves (they come back with their breakdown).
 */
export const META_INSIGHT_METRICS: Readonly<Record<string, MetricSpec>> = Object.fromEntries([
  // IN-010 — identity and setup columns.
  ...many(`account_currency account_id account_name campaign_id campaign_name campaign_start campaign_end adset_id adset_name adset_start
    adset_end ad_id ad_name objective optimization_goal buying_type attribution_setting anchor_event_attribution_setting
    multi_event_conversion_attribution_setting rule_set_id rule_set_name date_start date_stop created_time updated_time activity_recency`, 'identity', 'info'),
  // IN-011 — delivery and cost.
  ['spend', spec('delivery', 'money', 'e')], ['today_spend', spec('delivery', 'money', 'e')], ['social_spend', spec('delivery', 'money')],
  ...many('impressions impressions_gross impressions_auto_refresh full_view_impressions full_view_reach', 'delivery', 'count'),
  ['reach', spec('delivery', 'count', 'eH')], ['unique_impressions', spec('delivery', 'count', 'U')], ['frequency', spec('delivery', 'ratio', 'eH')],
  ['cpm', spec('delivery', 'money')], ['cpp', spec('delivery', 'money', 'eH')],
  // IN-012 — clicks and traffic.
  ...many('clicks inline_link_clicks website_clicks deeplink_clicks call_to_action_clicks inline_post_engagement', 'clicks', 'count'),
  ...many('ctr inline_link_click_ctr landing_page_view_per_link_click', 'clicks', 'ratio'),
  ...many('cpc cost_per_inline_link_click cost_per_inline_post_engagement', 'clicks', 'money'),
  ['cost_per_unique_inline_link_click', spec('clicks', 'money', 'eU')], ['cost_per_unique_click', spec('clicks', 'money', 'eU')],
  ['outbound_clicks', spec('clicks', 'actions')], ['outbound_clicks_ctr', spec('clicks', 'actionsRatio')], ['website_ctr', spec('clicks', 'actionsRatio')],
  ['cost_per_outbound_click', spec('clicks', 'actionsMoney')], ['cost_per_unique_outbound_click', spec('clicks', 'actionsMoney', 'eU')],
  ['app_store_clicks', spec('clicks', 'count', 'B')], ['newsfeed_clicks', spec('clicks', 'count', 'B')], ['newsfeed_impressions', spec('clicks', 'count', 'B')],
  ['newsfeed_avg_position', spec('clicks', 'ratio', 'B')],
  // IN-025 — named elsewhere, missing from the v26 list: asked apart, never a hard failure.
  ['unique_clicks', spec('clicks', 'count', 'eUx')], ['unique_inline_link_clicks', spec('clicks', 'count', 'Ux')],
  ['unique_ctr', spec('clicks', 'ratio', 'Ux')], ['unique_link_clicks_ctr', spec('clicks', 'ratio', 'Ux')], ['unique_outbound_clicks', spec('clicks', 'actions', 'Ux')],
  // IN-013 — special formats (Instant Experience, carousel, dwell, attention).
  ...many('instant_experience_clicks_to_open instant_experience_clicks_to_start total_card_view product_views thumb_stops dwell_3_sec dwell_5_sec dwell_7_sec', 'formats', 'count'),
  ['card_views', spec('formats', 'count', 'd')],
  ...many('canvas_avg_view_percent canvas_avg_view_time dwell_rate attention_events_per_impression attention_events_unq_per_reach', 'formats', 'ratio'),
  ...many('cost_per_dwell cost_per_dwell_3_sec cost_per_dwell_5_sec cost_per_dwell_7_sec', 'formats', 'money'),
  ...many(`instant_experience_outbound_clicks interactive_component_tap ad_click_actions ad_impression_actions conditional_time_spent_ms_over_2s_actions
    conditional_time_spent_ms_over_3s_actions conditional_time_spent_ms_over_6s_actions conditional_time_spent_ms_over_10s_actions
    conditional_time_spent_ms_over_15s_actions`, 'formats', 'actions'),
  ...many('cost_per_ad_click cost_per_one_thousand_ad_impression', 'formats', 'actionsMoney'),
  ['is_auto_advance', spec('formats', 'info')],
  // IN-014 — results by the campaign's own goal.
  ...many('results result_rate objective_results objective_result_rate', 'results', 'results'),
  ...many('cost_per_result cost_per_objective_result', 'results', 'resultsMoney'),
  ['actions_results', spec('results', 'actions')], ['cost_per_action_result', spec('results', 'actionsMoney')],
  ...many('performance_indicator result_values_performance_indicator anchor_events_performance_indicator', 'results', 'info'),
  // IN-015 — conversions, values, ROAS.
  ...many('actions conversions configurable_attribution_action', 'conversions', 'actions'),
  ...many('action_values conversion_values cost_per_action_type cost_per_conversion configurable_attribution_actionvalue', 'conversions', 'actionsMoney'),
  ['cost_per_unique_action_type', spec('conversions', 'actionsMoney', 'eU')], ['cost_per_unique_conversion', spec('conversions', 'actionsMoney', 'U')],
  ...many('total_actions adjusted_offline_purchase private_attribution_conversions shops_assisted_purchases dda_countby_convs', 'conversions', 'count'),
  ['total_unique_actions', spec('conversions', 'count', 'eU')],
  ...many('total_action_value cost_per_total_action cost_per_dda_countby_convs', 'conversions', 'money'),
  ...many('actions_per_impression purchase_per_landing_page_view', 'conversions', 'ratio'),
  ...many('purchase_roas website_purchase_roas mobile_app_purchase_roas', 'conversions', 'roas'),
  ['promoted_product_set_result', spec('conversions', 'raw')], ['dda_results', spec('conversions', 'rawMoney')],
  ['unique_actions', spec('conversions', 'actions', 'eUx')],
  // IN-016 — standard-event families.
  ...many(`contact_actions customize_product_actions donate_actions find_location_actions schedule_actions start_trial_actions
    submit_application_actions subscribe_actions recurring_subscription_payment_actions cancel_subscription_actions`, 'standard-events', 'actions'),
  ...many(`contact_value customize_product_value donate_value find_location_value schedule_value start_trial_value submit_application_value
    subscribe_value cost_per_contact cost_per_customize_product cost_per_donate cost_per_find_location cost_per_schedule cost_per_start_trial
    cost_per_submit_application cost_per_subscribe`, 'standard-events', 'actionsMoney'),
  // IN-018 — video.
  ...many(`video_continuous_2_sec_watched_actions video_6_sec_watched_actions video_30_sec_watched_actions video_time_watched_actions
    video_complete_watched_actions video_completed_view_or_15s_passed_actions`, 'video', 'actions'),
  ['video_play_actions', spec('video', 'actions', 'd')],
  ...many('video_p25_watched_actions video_p50_watched_actions video_p75_watched_actions video_p95_watched_actions video_p100_watched_actions video_avg_time_watched_actions', 'video', 'actions', 'R'),
  ...many('video_play_curve_actions video_play_retention_0_to_15s_actions video_play_retention_20_to_60s_actions video_play_retention_graph_actions', 'video', 'histogram'),
  ['cost_per_thruplay', spec('video', 'actionsMoney', 'd')],
  ...many('cost_per_15_sec_video_view cost_per_2_sec_continuous_video_view cost_per_completed_video_view', 'video', 'actionsMoney'),
  ['video_thruplay_watched_actions', spec('video', 'actions', 'x')],
  // IN-019 — catalog / products.
  ...many(`product_id product_name product_brand product_category product_content_id product_retailer_id product_group_content_id
    product_group_retailer_id product_vendor_id product_custom_label_0 product_custom_label_1 product_custom_label_2 product_custom_label_3
    product_custom_label_4 product_custom_number_0 product_custom_number_1 product_custom_number_2 product_custom_number_3 product_custom_number_4
    product_set_id_breakdown product_vendor_id_breakdown`, 'catalog', 'info'),
  ...many(`catalog_segment_actions converted_product_quantity converted_product_omni_purchase converted_product_website_pixel_purchase
    converted_product_offline_purchase converted_product_app_custom_event_fb_mobile_purchase`, 'catalog', 'actions'),
  ...many(`catalog_segment_value converted_product_value converted_product_omni_purchase_values converted_product_website_pixel_purchase_value
    converted_product_offline_purchase_value converted_product_app_custom_event_fb_mobile_purchase_value`, 'catalog', 'actionsMoney'),
  ...many('catalog_segment_value_mobile_purchase_roas catalog_segment_value_omni_purchase_roas catalog_segment_value_website_purchase_roas', 'catalog', 'roas'),
  // In the CATALOG's currency, which the row does not name: as Meta sent it.
  ['catalog_segment_value_in_catalog_currency', spec('catalog', 'rawMoney')],
  ...many(`converted_promoted_product_quantity converted_promoted_product_omni_purchase converted_promoted_product_website_pixel_purchase
    converted_promoted_product_offline_purchase converted_promoted_product_app_custom_event_fb_mobile_purchase`, 'catalog', 'actions', 'xA'),
  ...many(`converted_promoted_product_value converted_promoted_product_omni_purchase_values converted_promoted_product_website_pixel_purchase_value
    converted_promoted_product_offline_purchase_value converted_promoted_product_app_custom_event_fb_mobile_purchase_value`, 'catalog', 'actionsMoney', 'xA'),
  // IN-020 — creative-asset columns (meaningful with their breakdown).
  ...many('body_asset title_asset description_asset image_asset video_asset media_asset ad_format_asset rule_asset creative_automation_asset_id', 'assets', 'raw'),
  ...many('creative_relaxation_asset_type gen_ai_asset_type flexible_format_asset_type', 'assets', 'info'),
  // IN-021 — messaging.
  ['marketing_messages_delivered', spec('messaging', 'count', 'e')], ['instagram_upcoming_event_reminders_set', spec('messaging', 'count')],
  ...many('marketing_messages_delivery_rate qualifying_question_qualify_answer_rate', 'messaging', 'ratio'),
  ['marketing_messages_read_rate_benchmark', spec('messaging', 'info')],
  ['messages_delivered', spec('messaging', 'count', 'D')], ['messages_delivered_ctr', spec('messaging', 'ratio', 'D')], ['read_rate', spec('messaging', 'ratio', 'D')],
  ['cost_per_message_delivered', spec('messaging', 'money', 'D')],
  // IN-022 — reach-by-frequency and audience-overlap research fields (names only on Meta's page).
  ['configurable_reachbyfrequency_action', spec('research', 'actions')],
  ...many('configurable_reachbyfrequency_converters_count configurable_reachbyfrequency_impressions_count configurable_reachbyfrequency_reach configurable_audience_overlap_reach', 'research', 'count'),
  ['configurable_reachbyfrequency_impressions_cost', spec('research', 'rawMoney')],
  // IN-024 — Instagram profile visits (OCC 2025: campaign, ad set and ad edges; not on the v26 list).
  ['instagram_profile_visits', spec('instagram', 'count', 'xA')],
  // IN-025 — ad recall (Breakdowns guide; not on the v26 list).
  ['estimated_ad_recall_rate', spec('recall', 'ratio', 'x')], ['estimated_ad_recallers', spec('recall', 'count', 'x')],
  // RC-007 — the opportunity-score figure per row (name only on Meta's page).
  ['opportunity_score_l4', spec('other', 'ratio')],
])

/** What a read asks when the caller names no metric (Ads Manager's first columns; Meta's own default is impressions and spend). */
export const DEFAULT_METRICS = ['spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm', 'actions', 'action_values', 'purchase_roas', 'results', 'cost_per_result'] as const

/** The identity columns each level adds on its own (the row says what it is about). */
export const LEVEL_IDENTITY: Readonly<Record<InsightLevel, readonly string[]>> = {
  account: ['account_id', 'account_name'],
  campaign: ['campaign_id', 'campaign_name'],
  adset: ['campaign_id', 'adset_id', 'adset_name'],
  ad: ['campaign_id', 'adset_id', 'ad_id', 'ad_name'],
}

export const INSIGHT_LEVELS = ['account', 'campaign', 'adset', 'ad'] as const
export type InsightLevel = typeof INSIGHT_LEVELS[number]

export const MONEY_KINDS: ReadonlySet<MetricKind> = new Set(['money', 'actionsMoney', 'roas', 'resultsMoney', 'rawMoney'])

// ── breakdowns ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type BreakdownFamily =
  | 'demographic' | 'place' | 'placement' | 'hour' | 'frequency' | 'product' | 'asset' | 'automation' | 'audience' | 'destination'
  | 'signal' | 'instagram' | 'reporting'

export interface BreakdownSpec {
  family: BreakdownFamily
  /** Empty, without an error, until the account switches it on (OCC 2026, BRK feature settings): the feature's name. */
  feature?: string
  /** Type 1 (BRK): off-Meta action metrics are not returned with it. */
  type1?: true
  /** Type 2 (BRK): off-Meta web metrics come back without the breakdown value; mobile metrics not at all. */
  type2?: true
  /** Not at the ad account's level (BRK / INS notes). */
  notAtAccount?: true
  /** May join action_type, action_target_id, action_destination (BRK's * rows, used alone). */
  star?: true
  /** Data kept only this many months (OCC 2025). */
  months?: number
  /** Only its name is on Meta's page: Meta's own answer decides what it returns. */
  namesOnly?: true
}
const b = (family: BreakdownFamily, more: Omit<BreakdownSpec, 'family'> = {}): BreakdownSpec => ({ family, ...more })

/** Every breakdown a numbers read may ask (master IN-030 … IN-043, IN-086, IN-087, CR-242). */
export const META_INSIGHT_BREAKDOWNS: Readonly<Record<string, BreakdownSpec>> = {
  age: b('demographic', { star: true }), gender: b('demographic', { star: true }),
  country: b('place', { star: true }), region: b('place', { star: true, type1: true }),
  comscore_market: b('place', { feature: 'comscore' }), zip: b('place', { namesOnly: true }), place_page_id: b('place', { notAtAccount: true }),
  publisher_platform: b('placement', { star: true }), platform_position: b('placement'), device_platform: b('placement'),
  impression_device: b('placement', { feature: 'impression_device' }),
  hourly_stats_aggregated_by_advertiser_time_zone: b('hour', { star: true, type1: true, months: 13 }),
  hourly_stats_aggregated_by_audience_time_zone: b('hour', { star: true, type1: true, months: 13, feature: 'time_of_day_viewer_tz' }),
  impression_view_time_advertiser_hour_v2: b('hour', { namesOnly: true, months: 13 }),
  frequency_value: b('frequency', { feature: 'frequency_value', months: 6 }),
  product_id: b('product', { star: true, type2: true, notAtAccount: true }),
  product_brand_breakdown: b('product'), product_category_breakdown: b('product'), product_group_content_id_breakdown: b('product'),
  product_custom_label_0_breakdown: b('product'), product_custom_label_1_breakdown: b('product'), product_custom_label_2_breakdown: b('product'),
  product_custom_label_3_breakdown: b('product'), product_custom_label_4_breakdown: b('product'),
  body_asset: b('asset'), title_asset: b('asset'), description_asset: b('asset'), link_url_asset: b('asset'), call_to_action_asset: b('asset'),
  ad_format_asset: b('asset'), image_asset: b('asset', { notAtAccount: true }), video_asset: b('asset', { notAtAccount: true }),
  creative_automation_asset_id: b('automation'), gen_ai_asset_type: b('automation', { namesOnly: true }), flexible_format_asset_type: b('automation', { namesOnly: true }),
  creative_relaxation_asset_type: b('automation', { namesOnly: true }), is_auto_advance: b('automation', { namesOnly: true }),
  media_asset_url: b('automation', { namesOnly: true }), media_creator: b('automation', { namesOnly: true }), media_destination_url: b('automation', { namesOnly: true }),
  media_format: b('automation', { namesOnly: true }), media_origin_url: b('automation', { namesOnly: true }), media_text_content: b('automation', { namesOnly: true }),
  media_type: b('automation', { namesOnly: true }),
  // On the Breakdowns guide ("User segment (ex: new, existing) of Advantage+ Shopping Campaigns"), not in the reference enum.
  user_segment_key: b('audience'), user_persona_id: b('audience', { namesOnly: true }), user_persona_name: b('audience', { namesOnly: true }), overlap_segment: b('audience', { namesOnly: true }),
  landing_destination: b('destination', { namesOnly: true }), mdsa_landing_destination: b('destination', { namesOnly: true }), conversion_destination: b('destination', { namesOnly: true }),
  ad_extension_domain: b('destination', { namesOnly: true }), ad_extension_url: b('destination', { namesOnly: true }), marketing_messages_btn_name: b('destination', { namesOnly: true }),
  signal_source_bucket: b('signal', { namesOnly: true }), standard_event_content_type: b('signal', { namesOnly: true }),
  pa_creator_ig_handle: b('instagram', { namesOnly: true }), instagram_ads_follow_type: b('instagram', { namesOnly: true }),
  instagram_ads_instagram_media_product_type: b('instagram', { namesOnly: true }), instagram_ads_time_since_creation_bucket: b('instagram', { namesOnly: true }),
  reels_trending_topic: b('instagram', { namesOnly: true }), rta_ugc_topic: b('instagram', { namesOnly: true }), is_rendered_as_delayed_skip_ad: b('instagram', { namesOnly: true }),
  breakdown_ad_objective: b('reporting', { namesOnly: true }), breakdown_reporting_ad_id: b('reporting', { namesOnly: true }),
  rule_set_id: b('reporting', { namesOnly: true }), rule_set_name: b('reporting', { namesOnly: true }),
}

/** The breakdown only a report run takes (MMM: an async CSV export, never with another breakdown). */
export const MMM_BREAKDOWN = 'mmm'

/** Breakdowns in Meta's v26 enum that Nexus does not send, each with the reason said to the person. */
export const BREAKDOWNS_NOT_OFFERED: Readonly<Record<string, string>> = {
  dma: 'Meta no longer supports dma since 2026-06-22 (out-of-cycle changes 2026): use comscore_market',
  mmm: 'Meta answers mmm only as a background CSV export: meta-ads-report action start with kind mmm',
  app_id: 'app-install ads (SKAdNetwork) only: Nexus does not ask it', skan_campaign_id: 'app-install ads (SKAdNetwork) only: Nexus does not ask it',
  skan_conversion_id: 'app-install ads (SKAdNetwork) only: Nexus does not ask it', skan_version: 'app-install ads (SKAdNetwork) only: Nexus does not ask it',
  coarse_conversion_value: 'app-install ads (SKAdNetwork) only: Nexus does not ask it', postback_sequence_index: 'app-install ads (SKAdNetwork) only: Nexus does not ask it',
  redownload: 'app-install ads only: Nexus does not ask it', fidelity_type: 'app-install ads (SKAdNetwork) only: Nexus does not ask it',
  is_conversion_id_modeled: 'app-install ads (SKAdNetwork) only: Nexus does not ask it', hsid: 'Meta documents nothing about it: Nexus does not ask it',
  crm_advertiser_l12_territory_ids: 'a Meta-internal sales (CRM) name with no meaning documented: Nexus does not ask it',
  crm_advertiser_subvertical_id: 'a Meta-internal sales (CRM) name with no meaning documented: Nexus does not ask it',
  crm_advertiser_vertical_id: 'a Meta-internal sales (CRM) name with no meaning documented: Nexus does not ask it',
  crm_ult_advertiser_id: 'a Meta-internal sales (CRM) name with no meaning documented: Nexus does not ask it',
  internal_campaign_id: 'a Meta-internal name: Nexus does not ask it',
  sot_attribution_model_type: 'a name only, no meaning documented (master IN-044, out of scope)', sot_attribution_window: 'a name only, no meaning documented (master IN-044, out of scope)',
  sot_channel: 'a name only, no meaning documented (master IN-044, out of scope)', sot_event_type: 'a name only, no meaning documented (master IN-044, out of scope)',
  sot_source: 'a name only, no meaning documented (master IN-044, out of scope)',
}

/** The Dynamic Creative asset breakdowns and the only metrics Meta answers with them (BRK). */
export const DC_ASSET_BREAKDOWNS = ['body_asset', 'title_asset', 'description_asset', 'image_asset', 'video_asset', 'link_url_asset', 'call_to_action_asset', 'ad_format_asset'] as const
export const DC_ASSET_METRICS: ReadonlySet<string> = new Set(['impressions', 'clicks', 'spend', 'reach', 'actions', 'action_values'])

/** The action breakdowns of Meta's v26 enum (all of them; `action_converted_product_id` is Collaborative Ads only: not sent). */
export const META_ACTION_BREAKDOWNS = [
  'action_type', 'action_target_id', 'action_destination', 'action_device', 'action_reaction', 'action_video_sound', 'action_video_type',
  'action_carousel_card_id', 'action_carousel_card_name', 'action_canvas_component_name', 'conversion_destination', 'signal_source_bucket',
  'standard_event_content_type', 'matched_persona_id', 'matched_persona_name', 'is_business_ai_assisted',
] as const
/** BRK: the action breakdowns any `*` permutation may add. */
const STAR_ACTIONS: ReadonlySet<string> = new Set(['action_type', 'action_target_id', 'action_destination'])
/** BRK Type 2 action breakdowns (off-Meta web metrics without the value, no mobile metrics). */
export const TYPE2_ACTION_BREAKDOWNS: ReadonlySet<string> = new Set(['action_device', 'action_destination', 'action_target_id', 'action_carousel_card_id', 'action_carousel_card_name', 'action_canvas_component_name'])

const key = (list: readonly string[]) => [...new Set(list)].sort().join('+')
/** BRK "Combining breakdowns": the multi-breakdown permutations Meta keeps (each marked * may add the star action breakdowns). */
const MULTI_STAR: ReadonlySet<string> = new Set([
  key(['age', 'gender']), key(['publisher_platform', 'impression_device']), key(['publisher_platform', 'platform_position']),
  key(['publisher_platform', 'platform_position', 'impression_device']),
])
/** BRK: with action_device, these (and none) — each may add the star action breakdowns. */
const WITH_ACTION_DEVICE: ReadonlySet<string> = new Set([
  key([]), key(['impression_device']), key(['publisher_platform']), key(['publisher_platform', 'impression_device']),
  key(['publisher_platform', 'platform_position']), key(['publisher_platform', 'platform_position', 'impression_device']),
])
/** BRK: with a carousel card (id or name), these (and none) — no other action breakdown. */
const WITH_CAROUSEL: ReadonlySet<string> = new Set([key([]), key(['impression_device']), key(['country']), key(['age']), key(['gender']), key(['age', 'gender'])])

/**
 * Master IN-047 — why Meta would refuse this combination of breakdowns and action breakdowns (its 2/1504041 "Invalid
 * Breakdowns"), or null. Only Meta's documented permutations go together; a breakdown whose combinations Meta does not
 * document goes alone (with action_type, the implicit default).
 */
export function breakdownCombinationProblem(breakdowns: readonly string[], actionBreakdowns: readonly string[]): string | null {
  const bds = [...new Set(breakdowns)]
  const acts = [...new Set(actionBreakdowns)]
  if (bds.includes(MMM_BREAKDOWN)) return bds.length > 1 || acts.length ? 'Meta takes mmm with no other breakdown or action breakdown (marketing-mix-modeling page)' : null
  const k = key(bds)
  const carousel = acts.filter((a) => a === 'action_carousel_card_id' || a === 'action_carousel_card_name')
  if (carousel.length) {
    if (carousel.length > 1 || acts.length > 1) return 'a carousel card breakdown goes alone among action breakdowns (Meta\'s list of combinations)'
    return WITH_CAROUSEL.has(k) ? null : 'Meta combines a carousel card only with impression_device, country, age, gender or age and gender (its list of combinations)'
  }
  if (acts.includes('action_reaction')) {
    if (bds.length || acts.some((a) => a !== 'action_reaction' && a !== 'action_type')) return 'Meta takes action_reaction alone or with action_type only, and with no breakdown (its list of combinations)'
    return null
  }
  if (acts.includes('action_device')) {
    if (acts.some((a) => a !== 'action_device' && !STAR_ACTIONS.has(a))) return 'with action_device Meta adds only action_type, action_target_id or action_destination (its list of combinations)'
    return WITH_ACTION_DEVICE.has(k) ? null : 'Meta combines action_device only with impression_device, publisher_platform, publisher_platform and platform_position, each with or without impression_device (its list of combinations)'
  }
  const others = acts.filter((a) => !STAR_ACTIONS.has(a))
  if (others.length) {
    if (others.length > 1 || bds.length || acts.some((a) => a !== others[0] && a !== 'action_type')) return `Meta documents no combination for ${others.join(', ')}: Nexus asks it alone (with action_type at most, and no breakdown)`
    return null
  }
  const starAdds = acts.some((a) => a !== 'action_type')
  if (bds.length === 0) return null
  if (bds.includes('impression_device') && bds.length === 1) return 'Meta never takes impression_device alone: add publisher_platform (or action_device)'
  if (bds.length === 1) {
    const one = META_INSIGHT_BREAKDOWNS[bds[0]]
    if (starAdds && !one?.star) return `Meta adds action_target_id or action_destination only to the breakdowns its list marks (${bds[0]} is not one): ask without them`
    return null
  }
  if (MULTI_STAR.has(k)) return null
  // AFSINS — a Dynamic Creative asset with age, gender or both.
  const assets = bds.filter((x) => (DC_ASSET_BREAKDOWNS as readonly string[]).includes(x))
  const rest = bds.filter((x) => !(DC_ASSET_BREAKDOWNS as readonly string[]).includes(x))
  if (assets.length === 1 && rest.length && [key(['age']), key(['gender']), key(['age', 'gender'])].includes(key(rest))) {
    return starAdds ? 'an asset breakdown goes with action_type only' : null
  }
  return `Meta does not combine ${bds.join(', ')} (its list of combinations: age with gender; publisher_platform with platform_position and / or impression_device; an asset with age and / or gender); ask them one at a time`
}

// ── attribution, dates, levels ──────────────────────────────────────────────────────────────────────────────────────

/** Master IN-052 / IN-056 — the windows that still answer in 2026 (`default` = 7-day click and 1-day view). */
export const ATTRIBUTION_WINDOWS = ['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev', 'dda', 'incrementality', 'default'] as const
/** In the enum, refused with the reason (OCC 2025: no data since 2026-01-12; the variants follow them). */
export const DEAD_WINDOWS: ReadonlySet<string> = new Set(['7d_view', '28d_view', '7d_view_first_conversion', '28d_view_first_conversion', '7d_view_all_conversions', '28d_view_all_conversions'])
/** In the enum, not offered: app-install postbacks, and windows Meta does not document. */
export const WINDOWS_NOT_OFFERED: ReadonlySet<string> = new Set([
  'skan_view', 'skan_click', 'skan_click_second_postback', 'skan_view_second_postback', 'skan_click_third_postback', 'skan_view_third_postback',
  'custom', '1d_sequenced', '7d_sequenced', '28d_sequenced',
])

/** Master IN-058 — Meta's presets (`lifetime` is gone: `maximum` = 37 months). */
export const DATE_PRESETS = [
  'today', 'yesterday', 'this_month', 'last_month', 'this_quarter', 'maximum', 'data_maximum', 'last_3d', 'last_7d', 'last_14d', 'last_28d',
  'last_30d', 'last_90d', 'last_week_mon_sun', 'last_week_sun_sat', 'last_quarter', 'last_year', 'this_week_mon_today', 'this_week_sun_today', 'this_year',
] as const

/** Meta keeps insights 37 months (INS: error 3018 "beyond 37 months"). */
export const MAX_MONTHS_BACK = 37
/** At most this many periods in one read (time_ranges: one result set each). */
export const MAX_PERIODS = 12

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type FilterValue = 'ids' | 'text' | 'statuses' | 'count' | 'money' | 'enum' | 'pattern' | 'country' | 'actionTypes'
export interface FilterSpec {
  operators: readonly string[]
  value: FilterValue
  /** ids: the kind of object each id must be (the chosen account's own). */
  kind?: 'campaign' | 'adset' | 'ad'
  values?: readonly string[]
  /** Only DOT-notation examples or the MMM page document it: Meta's own answer decides. */
  unverified?: true
}
const LIST_OPS = ['IN', 'NOT_IN'] as const
const ID_OPS = ['IN', 'NOT_IN', 'EQUAL', 'NOT_EQUAL'] as const
const TEXT_OPS = ['CONTAIN', 'NOT_CONTAIN', 'EQUAL', 'NOT_EQUAL', 'STARTS_WITH', 'ENDS_WITH'] as const
const NUMBER_OPS = ['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'EQUAL'] as const

/** Every status an insights filter may name (DELETED too: insights of deleted objects are kept, F1 X3). */
export const FILTER_STATUSES = ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'ARCHIVED', 'DELETED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO'] as const
export const PUBLISHER_PLATFORMS = ['facebook', 'instagram', 'messenger', 'audience_network', 'threads'] as const
export const DEVICE_PLATFORMS = ['mobile_app', 'mobile_web', 'desktop'] as const

/**
 * Master IN-017 — the action types a filter or a sort may name (Meta's AdsActionStats types a shop uses; every other type
 * Meta reports still comes back in the rows). `omni_*` = website + app + offline together: pick one family per question.
 */
export const ACTION_TYPES = [
  'omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase', 'onsite_conversion.purchase',
  'omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'onsite_web_add_to_cart',
  'omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'onsite_web_initiate_checkout',
  'omni_view_content', 'view_content', 'offsite_conversion.fb_pixel_view_content', 'onsite_web_view_content',
  'omni_search', 'search', 'offsite_conversion.fb_pixel_search', 'omni_add_payment_info', 'add_payment_info', 'offsite_conversion.fb_pixel_add_payment_info',
  'omni_complete_registration', 'complete_registration', 'offsite_conversion.fb_pixel_complete_registration', 'omni_add_to_wishlist',
  'add_to_wishlist', 'offsite_conversion.fb_pixel_add_to_wishlist', 'lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped',
  'leadgen_grouped', 'offsite_conversion.fb_pixel_custom', 'landing_page_view', 'link_click', 'outbound_click', 'post_engagement',
  'page_engagement', 'post_reaction', 'comment', 'post', 'like', 'onsite_conversion.post_save', 'video_view', 'photo_view',
  'onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.messaging_first_reply', 'onsite_conversion.total_messaging_connection',
] as const

const LEVEL_PREFIXES = ['campaign', 'adset', 'ad'] as const
/** Master IN-063 — the filter fields Nexus sends (DOT notation), each with its operators and the value it takes. */
export const FILTER_FIELDS: Readonly<Record<string, FilterSpec>> = Object.fromEntries([
  ...LEVEL_PREFIXES.flatMap((p): Array<[string, FilterSpec]> => [
    [`${p}.id`, { operators: ID_OPS, value: 'ids', kind: p }],
    [`${p}.name`, { operators: TEXT_OPS, value: 'text' }],
    [`${p}.effective_status`, { operators: LIST_OPS, value: 'statuses', values: FILTER_STATUSES }],
    [`${p}.impressions`, { operators: NUMBER_OPS, value: 'count' }],
    [`${p}.spend`, { operators: NUMBER_OPS, value: 'money', unverified: true }],
  ]),
  ['publisher_platform', { operators: LIST_OPS, value: 'enum', values: PUBLISHER_PLATFORMS }],
  ['device_platform', { operators: LIST_OPS, value: 'enum', values: DEVICE_PLATFORMS }],
  ['platform_position', { operators: LIST_OPS, value: 'pattern' }],
  ['country', { operators: LIST_OPS, value: 'country' }],
  ['region', { operators: LIST_OPS, value: 'pattern' }],
  ['action_type', { operators: LIST_OPS, value: 'actionTypes', values: ACTION_TYPES, unverified: true }],
])

/** MMM page — the ONLY filters an mmm export takes, each with its operators. */
export const MMM_FILTERS: Readonly<Record<string, readonly string[]>> = {
  'campaign.id': ['IN', 'NOT_IN'], 'campaign.name': ['CONTAIN', 'NOT_CONTAIN'], 'adset.id': ['IN', 'NOT_IN'], 'adset.name': ['CONTAIN', 'NOT_CONTAIN'],
  country: ['IN'], region: ['IN'], device_platform: ['IN'], publisher_platform: ['IN'], platform_position: ['IN'],
}

export const MAX_FILTERS = 20
export const MAX_FILTER_VALUES = 50
/** A breakdown value as a filter takes it (placements, regions): lower-case words, digits, spaces, _ and -. */
const PATTERN_VALUE = /^[A-Za-z0-9 _.'-]{1,60}$/
const TEXT_VALUE = /^[^\u0000-\u001f"\\]{1,100}$/

/** Why a filter value is refused, or null (`money` arrives as Meta's decimal of the currency, e.g. "12.5"). */
export function filterValueProblem(field: string, operator: string, value: unknown): string | null {
  const f = FILTER_FIELDS[field]
  if (!f) return `"${field}" is not a filter Nexus sends (${Object.keys(FILTER_FIELDS).join(', ')})`
  if (!f.operators.includes(operator)) return `${field} takes ${f.operators.join(', ')}`
  const list = operator === 'IN' || operator === 'NOT_IN'
  const items = list ? value : [value]
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_FILTER_VALUES) return `${field} ${operator} takes ${list ? `a list of 1–${MAX_FILTER_VALUES} values` : 'one value'}`
  for (const item of items) {
    switch (f.value) {
      case 'ids': if (typeof item !== 'string' || !/^\d{1,25}$/.test(item)) return `${field} takes Meta ids (digits)`; break
      case 'text': if (typeof item !== 'string' || !TEXT_VALUE.test(item)) return `${field} takes a plain text of 1–100 characters`; break
      case 'statuses': case 'enum': case 'actionTypes': if (typeof item !== 'string' || !f.values!.includes(item)) return `${field} takes ${f.values!.join(', ')}`; break
      case 'pattern': if (typeof item !== 'string' || !PATTERN_VALUE.test(item)) return `${field} takes Meta's own values (letters, digits, _ and -)`; break
      case 'country': if (typeof item !== 'string' || !/^[A-Z]{2}$/.test(item)) return `${field} takes two-letter country codes (IT, DE)`; break
      case 'count': if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) return `${field} takes a whole number`; break
      case 'money': if (typeof item !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(item)) return `${field} takes an amount`; break
    }
  }
  return null
}

/** The `filtering` JSON a read or a report run sends: a list of at most MAX_FILTERS valid filters, each key once. */
export function filteringProblem(raw: string, mmm = false): string | null {
  let list: unknown
  try { list = JSON.parse(raw) } catch { return 'filtering is a JSON list' }
  if (!Array.isArray(list) || list.length > MAX_FILTERS) return `filtering is a list of at most ${MAX_FILTERS} filters`
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'each filter is {field, operator, value}'
    const e = entry as Record<string, unknown>
    if (Object.keys(e).sort().join(',') !== 'field,operator,value') return 'each filter is exactly {field, operator, value}'
    if (typeof e.field !== 'string' || typeof e.operator !== 'string') return 'each filter names its field and operator'
    if (mmm) {
      const ops = MMM_FILTERS[e.field]
      if (!ops || !ops.includes(e.operator)) return `an mmm export takes only these filters (marketing-mix-modeling page): ${Object.entries(MMM_FILTERS).map(([f, o]) => `${f} ${o.join('/')}`).join(', ')}`
    }
    const problem = filterValueProblem(e.field, e.operator, e.value)
    if (problem) return problem
  }
  return null
}

// ── sort ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Scalar metrics a read may sort by (INS: one element, `<field>_ascending|_descending`). */
export const SORTABLE_KINDS: ReadonlySet<MetricKind> = new Set(['count', 'ratio', 'money'])
/** The one sort string, or null when it is not one Nexus sends: a scalar metric of the list, or `actions:<an ACTION_TYPES type>`. */
export function sortProblem(value: string): string | null {
  const m = /^(.+)_(ascending|descending)$/.exec(value)
  if (!m) return 'a sort ends in _ascending or _descending'
  const field = m[1]
  if (field.startsWith('actions:')) return (ACTION_TYPES as readonly string[]).includes(field.slice(8)) ? null : 'a sort by actions names one of Nexus\'s action types'
  const s = META_INSIGHT_METRICS[field]
  return s && SORTABLE_KINDS.has(s.kind) ? null : `"${field}" is not a number a read sorts by`
}

// ── one check per query key (the gateway reads these; the builder sends only values they accept) ────────────────────

const jsonList = (raw: string | null): unknown[] | null => {
  if (raw === null) return null
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null } catch { return null }
}
const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
const range = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return Object.keys(r).sort().join(',') === 'since,until' && day(r.since) && day(r.until) && String(r.since) <= String(r.until)
}
const subsetList = (raw: string | null, allowed: ReadonlySet<string> | readonly string[], max: number) => {
  const list = jsonList(raw)
  const has = (x: string) => (Array.isArray(allowed) ? (allowed as readonly string[]).includes(x) : (allowed as ReadonlySet<string>).has(x))
  return !!list && list.length >= 1 && list.length <= max && list.every((x) => typeof x === 'string' && has(x)) && new Set(list).size === list.length
}

const OFFERED_BREAKDOWNS: ReadonlySet<string> = new Set(Object.keys(META_INSIGHT_BREAKDOWNS))
const REPORT_BREAKDOWNS: ReadonlySet<string> = new Set([...OFFERED_BREAKDOWNS, MMM_BREAKDOWN])

/** The value checks of the insights query keys step 7 adds (a GET of `act_<id>/insights` or `<object>/insights`). */
export const INSIGHTS_KEY_CHECKS: Readonly<Record<string, (raw: string | null) => boolean>> = {
  breakdowns: (raw) => subsetList(raw, OFFERED_BREAKDOWNS, 4),
  action_breakdowns: (raw) => subsetList(raw, META_ACTION_BREAKDOWNS, 4),
  summary_action_breakdowns: (raw) => subsetList(raw, META_ACTION_BREAKDOWNS, 4),
  action_attribution_windows: (raw) => subsetList(raw, ATTRIBUTION_WINDOWS, ATTRIBUTION_WINDOWS.length),
  date_preset: (raw) => (DATE_PRESETS as readonly string[]).includes(raw ?? ''),
  time_ranges: (raw) => { const list = jsonList(raw); return !!list && list.length >= 1 && list.length <= MAX_PERIODS && list.every(range) },
  sort: (raw) => { const list = jsonList(raw); return !!list && list.length === 1 && typeof list[0] === 'string' && sortProblem(list[0]) === null },
  default_summary: (raw) => raw === 'true',
  use_account_attribution_setting: (raw) => raw === 'true' || raw === 'false',
  product_id_limit: (raw) => /^\d{1,4}$/.test(raw ?? '') && Number(raw) >= 1 && Number(raw) <= 1000,
}

/** A `fields` value made only of names on the metric list (a report run's body: judged in full, not only for tokens). */
export function fieldsListProblem(raw: string): string | null {
  const names = raw.split(',')
  if (!names.length || names.length > 300 || names.some((n) => !META_INSIGHT_METRICS[n])) return 'fields names only metrics on Nexus\'s insights list'
  return new Set(names).size === names.length ? null : 'fields names each metric once'
}

/** The longest body of a report run Nexus sends (its field list and filters). */
export const MAX_REPORT_RUN_BODY = 8000

/**
 * The body of a report run `POST /act_<id>/insights` (an AdReportRun: it changes nothing on the account), judged key by
 * key: the same lists as a read, plus export_format / export_name; an mmm export exactly as Meta's page takes it. Why it
 * is refused, or null.
 */
export function reportRunProblem(params: ReadonlyMap<string, string>): string | null {
  const allowed = new Set(['level', 'fields', 'breakdowns', 'action_breakdowns', 'summary_action_breakdowns', 'action_attribution_windows', 'date_preset', 'time_range', 'time_ranges', 'time_increment', 'filtering', 'sort', 'default_summary', 'use_account_attribution_setting', 'product_id_limit', 'export_format', 'export_name'])
  for (const k of params.keys()) if (!allowed.has(k)) return `a report run never carries ${k}`
  const level = params.get('level')
  if (!(INSIGHT_LEVELS as readonly string[]).includes(level ?? '')) return 'a report run names its level (account, campaign, adset or ad)'
  const raw = (k: string) => params.get(k) ?? null
  const fields = raw('fields')
  if (fields !== null) { const p = fieldsListProblem(fields); if (p) return p }
  const breakdowns = raw('breakdowns')
  if (breakdowns !== null && !subsetList(breakdowns, REPORT_BREAKDOWNS, 4)) return 'breakdowns are breakdowns on Nexus\'s list (or mmm alone)'
  for (const k of ['action_breakdowns', 'summary_action_breakdowns', 'action_attribution_windows', 'date_preset', 'time_ranges', 'sort', 'default_summary', 'use_account_attribution_setting', 'product_id_limit']) {
    if (params.has(k) && !INSIGHTS_KEY_CHECKS[k](raw(k))) return `${k} is not a value Nexus sends`
  }
  if (params.has('time_range')) { let r: unknown; try { r = JSON.parse(raw('time_range')!) } catch { r = null } if (!range(r)) return 'time_range is {since, until}, two days' }
  const inc = raw('time_increment')
  if (inc !== null && !(inc === 'all_days' || inc === 'monthly' || (/^\d{1,2}$/.test(inc) && Number(inc) >= 1 && Number(inc) <= 90))) return 'time_increment is 1–90, monthly or all_days'
  const format = raw('export_format')
  if (format !== null && format !== 'csv' && format !== 'xls') return 'export_format is csv or xls'
  const name = raw('export_name')
  if (name !== null && (format === null || !/^[A-Za-z0-9 _.-]{1,60}$/.test(name))) return 'export_name is a plain file name (with an export_format)'
  const mmm = (jsonList(breakdowns) ?? []).includes(MMM_BREAKDOWN)
  const filtering = raw('filtering')
  if (filtering !== null) { const p = filteringProblem(filtering, mmm); if (p) return p }
  if (mmm) {
    if (format !== 'csv' || level !== 'adset') return 'an mmm export is level adset with export_format csv (marketing-mix-modeling page)'
    if (params.has('action_breakdowns') || params.has('summary_action_breakdowns') || params.has('sort') || params.has('default_summary') || params.has('time_ranges')) return 'an mmm export takes no action breakdown, sort, total or several periods'
    if (fields !== null && fields.split(',').some((n) => n !== 'impressions' && n !== 'spend')) return 'an mmm export reads impressions and spend only'
    if (inc !== null && inc !== '1' && inc !== 'all_days') return 'an mmm export is by day (1) or for the whole period'
  } else if (breakdowns !== null || params.has('action_breakdowns')) {
    const problem = breakdownCombinationProblem(jsonList(breakdowns) as string[] ?? [], jsonList(raw('action_breakdowns')) as string[] ?? [])
    if (problem) return problem
  }
  return null
}

// ── the Report Builder edge (GET /act_<id>/reporting, meta-ads-saved-reports view report-builder) ────────────────────

/**
 * Master IN-075 — Meta lists the edge's parameters but not the metric or dimension names it takes (UNVERIFIED: LIVE-PROBES
 * IN-075). Nexus sends only these: the scalar insights metrics, and the dimensions Ads Manager's reports show; a name Meta
 * does not know is refused by Meta in its own words.
 */
export const REPORT_BUILDER_DIMENSIONS = [
  'account_id', 'account_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'objective', 'optimization_goal',
  'age', 'gender', 'country', 'region', 'publisher_platform', 'platform_position', 'device_platform', 'impression_device',
] as const
export const REPORT_BUILDER_METRICS: readonly string[] = Object.entries(META_INSIGHT_METRICS).filter(([, s]) => SORTABLE_KINDS.has(s.kind) && !s.extra).map(([name]) => name)
/** The edge's attribution_windows enum, the windows that still answer (no incrementality on this edge). */
export const REPORT_BUILDER_WINDOWS = ['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev', 'dda', 'default'] as const

const sortingOk = (raw: string | null) => {
  const list = jsonList(raw)
  const names = new Set<string>([...REPORT_BUILDER_METRICS, ...REPORT_BUILDER_DIMENSIONS])
  return !!list && list.length >= 1 && list.length <= 3 && list.every((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false
    const e = s as Record<string, unknown>
    return Object.keys(e).sort().join(',') === 'direction,field' && typeof e.field === 'string' && names.has(e.field) && (e.direction === 'asc' || e.direction === 'desc')
  })
}

/** The value checks of the Report Builder keys (each key only with a value Nexus sends). */
export const REPORT_BUILDER_KEY_CHECKS: Readonly<Record<string, (raw: string | null) => boolean>> = {
  metrics: (raw) => subsetList(raw, REPORT_BUILDER_METRICS, 30),
  dimensions: (raw) => subsetList(raw, REPORT_BUILDER_DIMENSIONS, 4),
  attribution_windows: (raw) => subsetList(raw, REPORT_BUILDER_WINDOWS, REPORT_BUILDER_WINDOWS.length),
  date_preset: (raw) => (DATE_PRESETS as readonly string[]).includes(raw ?? ''),
  time_range: (raw) => { try { return range(JSON.parse(raw ?? '')) } catch { return false } },
  comparison_time_range: (raw) => { try { return range(JSON.parse(raw ?? '')) } catch { return false } },
  filtering: (raw) => raw !== null && filteringProblem(raw) === null,
  sorting: sortingOk,
  default_summary: (raw) => raw === 'true' || raw === 'false',
  summary_count: (raw) => raw === 'true' || raw === 'false',
  offset: (raw) => /^\d{1,6}$/.test(raw ?? ''),
}
