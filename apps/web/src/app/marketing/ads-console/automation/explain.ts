/**
 * RC6.2 — plain-language explainers for the Library. Turns an AutomationDef into
 * "when it fires" + "what it changes" phrases derived from its real trigger and
 * default-built actions, plus a search blob so the catalogue is findable by what
 * it DOES (e.g. "pause", "budget", "acos", "schedule") not just its name.
 */

import { buildRule, type AutomationDef } from './automations'

// When it fires — friendly trigger clauses. Mirrors the Configurator's map so the
// Library and the configurator speak the same language.
const TRIGGER_PHRASE: Record<string, string> = {
  CAC_SPIKE: 'a campaign’s ACOS spikes',
  CAMPAIGN_PERFORMANCE_BUDGET: 'a campaign hits a performance or budget condition',
  AD_TARGET_UNDERPERFORMING: 'a target underperforms',
  AD_SPEND_PROFITABILITY_BREACH: 'ad spend overtakes true profit',
  CVR_DROP: 'conversion rate drops sharply',
  KEYWORD_LOW_CTR: 'a keyword’s click-through rate stays low',
  KEYWORD_WASTED_SPEND: 'a keyword burns spend without selling',
  KEYWORD_ZERO_IMPRESSIONS: 'a keyword gets (almost) no impressions',
  KEYWORD_HIGH_ACOS: 'a keyword converts but at a high ACOS',
  KEYWORD_SCALE_OPPORTUNITY: 'a keyword is a proven winner with headroom',
  KEYWORD_RISING_STAR: 'a keyword’s orders are accelerating',
  SEARCH_TERM_CONVERTING: 'a search term starts converting',
  SEARCH_TERM_WASTING: 'a search term wastes spend',
  AD_GROUP_UNDERPERFORMING: 'an ad group underperforms',
  NEW_TO_BRAND_WINNER: 'a campaign wins new-to-brand customers',
  CAMPAIGN_NO_SALES: 'a campaign spends with no sales',
  CAMPAIGN_ROAS_DECLINING: 'a campaign’s ROAS declines week-over-week',
  FBA_AGE_THRESHOLD_REACHED: 'stock nears long-term-storage age',
  FBA_AGE: 'stock nears long-term-storage age',
  SCHEDULE: 'it runs on a schedule',
}

// What it changes — action verbs. Same vocabulary the configurator preview uses.
const ACTION_PHRASE: Record<string, string> = {
  bid_down: 'lowers bids', bid_up: 'raises bids', lower_bid_to_floor: 'drops bids to the floor',
  adjust_ad_budget: 'adjusts the budget', set_daily_budget: 'sets the daily budget',
  set_campaign_target_acos: 'sets the target ACOS', pause_campaign: 'pauses the campaign',
  pause_ad_group: 'pauses the ad group', pause_all_campaigns: 'pauses every campaign',
  enable_campaign: 'enables the campaign', resume_campaign: 'resumes the campaign',
  archive_keyword: 'archives the keyword', add_negative_exact: 'adds a negative keyword',
  promote_to_exact: 'promotes it to an exact keyword', harvest_and_negate: 'harvests & negates search terms',
  retail_guard: 'pauses/resumes on stock & Buy Box', liquidate_aged_stock: 'liquidates aged stock',
  create_amazon_promotion: 'creates a promotion', set_placement_multiplier: 'tunes the placement multiplier',
  reroute_marketplace_budget: 'reroutes budget across marketplaces', sync_negatives_across_campaigns: 'syncs negatives across campaigns',
  raise_bids_for_rank_defense: 'raises bids to defend rank', scale_bids_for_price_change: 're-bids for the price change',
  bid_to_target_acos: 'optimises bids to target', alert_operator: 'alerts you', notify: 'notifies you',
}

const humanize = (s: string) => s.replace(/_/g, ' ').toLowerCase()

/** "when …" clause for the card + configurator parity. */
export function firesWhen(def: AutomationDef): string {
  return TRIGGER_PHRASE[def.trigger] ?? humanize(def.trigger)
}

/** Distinct action verbs from the default-built rule, real changes first, the
 *  notify/alert kept last (so "lowers bids · notifies you" reads naturally). */
export function whatItChanges(def: AutomationDef): string[] {
  let actions: Array<{ type?: unknown }> = []
  try { actions = buildRule(def).actions as Array<{ type?: unknown }> } catch { actions = [] }
  const phrases = actions.map((a) => ACTION_PHRASE[String(a.type)] ?? humanize(String(a.type)))
  const seen = new Set<string>()
  const uniq = phrases.filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
  const notifies = uniq.filter((p) => p === 'notifies you' || p === 'alerts you')
  const real = uniq.filter((p) => p !== 'notifies you' && p !== 'alerts you')
  return [...real, ...notifies]
}

/** Lower-cased search blob: name + desc + category + trigger (raw + friendly) +
 *  action verbs — so the catalogue is findable by behaviour, not just by name. */
export function searchBlob(def: AutomationDef): string {
  return [def.name, def.desc, def.category, def.trigger, firesWhen(def), ...whatItChanges(def)]
    .join(' ')
    .toLowerCase()
}
