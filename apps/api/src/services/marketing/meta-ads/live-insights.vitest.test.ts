/**
 * Meta ads step 7 — the insights lists and the pure parts of the numbers read: nothing of Meta's v26 enums is left out
 * without a reason (every breakdown, action breakdown, window and preset is asked or refused in words); the combinations
 * follow Meta's "Combining breakdowns"; every metric Nexus may ask passes the gateway; rows map money once, in minor units
 * of the account currency (JPY too), and a CSV is a CSV. Pure: no Meta, no database.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

import {
  ATTRIBUTION_WINDOWS, BREAKDOWNS_NOT_OFFERED, breakdownCombinationProblem, DATE_PRESETS, DEAD_WINDOWS, filteringProblem, INSIGHTS_KEY_CHECKS,
  META_ACTION_BREAKDOWNS, META_INSIGHT_BREAKDOWNS, META_INSIGHT_METRICS, METRIC_GROUPS, MONEY_KINDS, reportRunProblem, sortProblem, WINDOWS_NOT_OFFERED,
} from '../../meta/meta-insights-lists.js'
import { changesOf, comparisonPeriod, mapInsightRow, monthsBefore, rowsCsv, type MappedRow } from './live-insights.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`

/** Meta's v26 enums, as reference/ad-account/insights lists them (checked 2026-10-21). */
const V26_BREAKDOWNS = `ad_extension_domain ad_extension_url ad_format_asset age app_id body_asset breakdown_ad_objective breakdown_reporting_ad_id call_to_action_asset
  coarse_conversion_value comscore_market country creative_automation_asset_id creative_relaxation_asset_type crm_advertiser_l12_territory_ids
  crm_advertiser_subvertical_id crm_advertiser_vertical_id crm_ult_advertiser_id description_asset fidelity_type flexible_format_asset_type gen_ai_asset_type
  gender hsid image_asset impression_device instagram_ads_follow_type instagram_ads_instagram_media_product_type instagram_ads_time_since_creation_bucket
  internal_campaign_id is_auto_advance is_conversion_id_modeled is_rendered_as_delayed_skip_ad landing_destination link_url_asset mdsa_landing_destination
  media_asset_url media_creator media_destination_url media_format media_origin_url media_text_content media_type pa_creator_ig_handle postback_sequence_index
  product_brand_breakdown product_category_breakdown product_custom_label_0_breakdown product_custom_label_1_breakdown product_custom_label_2_breakdown
  product_custom_label_3_breakdown product_custom_label_4_breakdown product_group_content_id_breakdown product_id redownload region rta_ugc_topic skan_campaign_id
  skan_conversion_id skan_version sot_attribution_model_type sot_attribution_window sot_channel sot_event_type sot_source title_asset user_persona_id
  user_persona_name video_asset zip rule_set_id rule_set_name dma frequency_value overlap_segment hourly_stats_aggregated_by_advertiser_time_zone
  hourly_stats_aggregated_by_audience_time_zone mmm place_page_id publisher_platform platform_position device_platform standard_event_content_type
  conversion_destination signal_source_bucket reels_trending_topic marketing_messages_btn_name impression_view_time_advertiser_hour_v2`.split(/\s+/)
const V26_ACTION_BREAKDOWNS = 'action_device conversion_destination matched_persona_id matched_persona_name signal_source_bucket standard_event_content_type action_canvas_component_name action_carousel_card_id action_carousel_card_name action_destination action_reaction action_target_id action_type action_video_sound action_video_type is_business_ai_assisted'.split(' ')
const V26_WINDOWS = '1d_view 7d_view 28d_view 1d_click 7d_click 28d_click 1d_ev dda default 7d_view_first_conversion 28d_view_first_conversion 7d_view_all_conversions 28d_view_all_conversions skan_view skan_click skan_click_second_postback skan_view_second_postback skan_click_third_postback skan_view_third_postback incrementality custom 1d_sequenced 7d_sequenced 28d_sequenced'.split(' ')
const V26_PRESETS = 'today yesterday this_month last_month this_quarter maximum data_maximum last_3d last_7d last_14d last_28d last_30d last_90d last_week_mon_sun last_week_sun_sat last_quarter last_year this_week_mon_today this_week_sun_today this_year'.split(' ')

describe('nothing of Meta\'s v26 enums is left out without a reason', () => {
  it('every breakdown is asked, or refused with its reason — never both', () => {
    for (const name of V26_BREAKDOWNS) {
      const asked = name in META_INSIGHT_BREAKDOWNS
      const refused = name in BREAKDOWNS_NOT_OFFERED
      expect([name, asked !== refused]).toEqual([name, true])
    }
    // user_segment_key is on the Breakdowns guide (Advantage+ sales: new vs existing customers), not in the reference enum.
    expect(Object.keys(META_INSIGHT_BREAKDOWNS).filter((n) => !V26_BREAKDOWNS.includes(n))).toEqual(['user_segment_key'])
  })
  it('every action breakdown is asked; every window answers, is dead since 2026-01-12, or is not offered; every preset is offered', () => {
    expect([...META_ACTION_BREAKDOWNS].sort()).toEqual([...V26_ACTION_BREAKDOWNS].sort())
    expect([...ATTRIBUTION_WINDOWS, ...DEAD_WINDOWS, ...WINDOWS_NOT_OFFERED].sort()).toEqual([...V26_WINDOWS].sort())
    expect([...DATE_PRESETS].sort()).toEqual([...V26_PRESETS].sort())
    expect(ATTRIBUTION_WINDOWS).not.toContain('7d_view')
  })
  it('every metric belongs to a group, and every metric of every group passes the gateway (no token, a short enough list)', () => {
    for (const group of METRIC_GROUPS) {
      const names = Object.entries(META_INSIGHT_METRICS).filter(([, s]) => s.group === group).map(([n]) => n)
      expect(names.length, group).toBeGreaterThan(0)
      expect(metaReadOnlyProblem({ method: 'GET', url: `${BASE}/act_1234567890/insights?fields=${names.join(',')}`, kind: 'read' }), group).toBeNull()
    }
    expect(Object.keys(META_INSIGHT_METRICS).filter((n) => /token|secret|password/.test(n))).toEqual([])
  })
})

describe('Meta\'s "Combining breakdowns" (IN-047)', () => {
  it.each([
    [['age', 'gender'], []], [['publisher_platform', 'platform_position'], ['action_type']], [['publisher_platform', 'platform_position', 'impression_device'], []],
    [['publisher_platform', 'impression_device'], ['action_target_id']], [['country'], ['action_destination']], [['hourly_stats_aggregated_by_advertiser_time_zone'], ['action_type']],
    [[], ['action_device']], [['impression_device'], ['action_device']], [['publisher_platform', 'platform_position'], ['action_device', 'action_type']],
    [[], ['action_reaction', 'action_type']], [['age', 'gender'], ['action_carousel_card_id']], [['country'], ['action_carousel_card_name']],
    [['body_asset', 'age'], []], [['image_asset', 'age', 'gender'], ['action_type']], [['device_platform'], []], [['user_segment_key'], ['action_type']],
    [[], ['action_video_type', 'action_type']], [['mmm'], []],
  ])('%j with %j goes', (breakdowns, actions) => {
    expect(breakdownCombinationProblem(breakdowns, actions)).toBeNull()
  })
  it.each([
    [['country', 'age'], [], /does not combine/], [['impression_device'], [], /never takes impression_device alone/], [['mmm', 'age'], [], /mmm with no other/],
    [['age'], ['action_reaction'], /action_reaction alone/], [['country'], ['action_device'], /action_device only with/], [['age'], ['action_device', 'action_reaction'], /action_reaction alone/],
    [['publisher_platform'], ['action_carousel_card_id'], /carousel card only with/], [[], ['action_carousel_card_id', 'action_type'], /goes alone/],
    [['age'], ['action_video_sound'], /documents no combination/], [['device_platform'], ['action_destination'], /only to the breakdowns its list marks/],
    [['body_asset', 'title_asset'], [], /does not combine/], [['body_asset', 'age'], ['action_destination'], /asset breakdown goes with action_type only/],
  ])('%j with %j is refused', (breakdowns, actions, words) => {
    expect(breakdownCombinationProblem(breakdowns as string[], actions as string[])).toMatch(words as RegExp)
  })
})

describe('the value checks the gateway and a report run share', () => {
  it('windows, sort, filters', () => {
    expect(INSIGHTS_KEY_CHECKS.action_attribution_windows('["1d_click","incrementality"]')).toBe(true)
    expect(INSIGHTS_KEY_CHECKS.action_attribution_windows('["7d_view"]')).toBe(false)
    expect(INSIGHTS_KEY_CHECKS.action_attribution_windows('["1d_click","1d_click"]')).toBe(false)
    expect(sortProblem('spend_descending')).toBeNull()
    expect(sortProblem('actions:omni_purchase_ascending')).toBeNull()
    expect(sortProblem('actions:anything_ascending')).toMatch(/action types/)
    expect(sortProblem('actions_descending')).toMatch(/not a number/)
    expect(filteringProblem(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: ['120000000000101'] }]))).toBeNull()
    expect(filteringProblem(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: ['120000000000101'], extra: 1 }]))).toMatch(/exactly/)
    expect(filteringProblem(JSON.stringify([{ field: 'campaign.spend', operator: 'GREATER_THAN', value: 12 }]))).toMatch(/an amount/)
    expect(filteringProblem(JSON.stringify([{ field: 'country', operator: 'IN', value: ['it'] }]))).toMatch(/two-letter/)
    expect(filteringProblem(JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: 'IT' }]), true)).toBeNull()
    expect(filteringProblem(JSON.stringify([{ field: 'campaign.name', operator: 'EQUAL', value: 'IT' }]), true)).toMatch(/mmm export takes only/)
  })
  it('a report run body: only the read\'s keys, each from the lists', () => {
    const p = (o: Record<string, string>) => reportRunProblem(new Map(Object.entries(o)))
    expect(p({ level: 'ad', fields: 'ad_id,spend', breakdowns: '["age","gender"]', time_increment: '1', date_preset: 'last_7d' })).toBeNull()
    expect(p({ level: 'ad', fields: 'ad_id,spend', time_increment: '91' })).toMatch(/1–90/)
    expect(p({ level: 'ad', time_range: '{"since":"2026-10-07","until":"2026-10-01"}' })).toMatch(/time_range/)
    expect(p({ level: 'ad', fields: 'spend,spend' })).toMatch(/each metric once/)
  })
})

describe('days', () => {
  it('months back stay inside the month; a comparison is the period just before, or the same days a year before', () => {
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28')
    expect(monthsBefore('2028-03-31', 1)).toBe('2028-02-29')
    expect(monthsBefore('2026-10-21', 37)).toBe('2023-09-21')
    expect(comparisonPeriod('2026-10-08', '2026-10-14', 'previous-period')).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(comparisonPeriod('2028-02-29', '2028-03-01', 'previous-year')).toEqual({ from: '2027-02-28', to: '2027-03-01' })
  })
})

describe('rows', () => {
  it('money once, in minor units of the account currency (EUR cents, JPY yen); units Meta does not name under money.asMeta', () => {
    const left = new Set<string>()
    const eur = mapInsightRow({ spend: '0.4938', cpc: '0.015', impressions: '12', date_start: '2026-10-01', date_stop: '2026-10-01', catalog_segment_value_in_catalog_currency: [{ action_type: 'x', value: '9' }], objective: 'OUTCOME_SALES', weird: 1 }, { currency: 'EUR' }, [], left)
    expect(eur).toMatchObject({ numbers: { impressions: 12 }, money: { spend: 49, cpc: 2, asMeta: { catalog_segment_value_in_catalog_currency: [{ action_type: 'x', value: '9' }] } }, info: { objective: 'OUTCOME_SALES' } })
    expect([...left]).toEqual(['weird'])
    const jpy = mapInsightRow({ spend: '1234', action_values: [{ action_type: 'omni_purchase', value: '5600.4' }] }, { currency: 'JPY' }, [], new Set())
    expect(jpy.money).toEqual({ spend: 1234, action_values: [{ actionType: 'omni_purchase', value: 5600 }] })
    // An action broken down: its breakdown values beside its type, windows apart.
    const split = mapInsightRow({ actions: [{ action_type: 'omni_purchase', action_device: 'iphone', value: '2', '1d_click': '1' }] }, { currency: 'EUR' }, [], new Set())
    expect(split.numbers.actions).toEqual([{ actionType: 'omni_purchase', value: 2, windows: { '1d_click': 1 }, breakdown: { action_device: 'iphone' } }])
    expect(Object.entries(META_INSIGHT_METRICS).filter(([, s]) => MONEY_KINDS.has(s.kind)).map(([n]) => n)).toEqual(expect.arrayContaining(['spend', 'cpc', 'cpm', 'cpp', 'action_values', 'purchase_roas', 'cost_per_result', 'total_action_value']))
  })
  it('a CSV is a CSV: quotes and commas escaped, amounts only in the file with money', () => {
    const rows: MappedRow[] = [{ dateStart: '2026-10-01', dateStop: '2026-10-01', campaignName: 'Shop "A", spring', numbers: { impressions: 10, actions: [{ actionType: 'omni_purchase', value: 2 }] }, money: { spend: 123 } }]
    expect(rowsCsv(rows, false)).toBe('date_start,date_stop,campaign_name,impressions,actions:omni_purchase\n2026-10-01,2026-10-01,"Shop ""A"", spring",10,2')
    expect(rowsCsv(rows, true).split('\n')[0]).toMatch(/spend \(cents\)$/)
  })
  it('a change with a side missing says so, and no percentage from zero', () => {
    const r = (period: string, impressions: number): MappedRow => ({ dateStart: null, dateStop: null, period, campaignId: '1', numbers: { impressions }, money: {} })
    const [only] = changesOf([r('current', 5)])
    expect(only).toMatchObject({ inCurrent: true, inEarlier: false, numbers: { impressions: { current: 5, earlier: null, change: null, changePct: null } } })
    const [zero] = changesOf([r('current', 5), r('earlier', 0)])
    expect(zero.numbers.impressions).toEqual({ current: 5, earlier: 0, change: 5, changePct: null })
  })
})
