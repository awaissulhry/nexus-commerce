/**
 * Meta step 2, review 2 (lead decision) — what meta-ads-graph-read may read, as an ALLOW-LIST only. Deny-lists kept
 * leaking (an edge, a Page, another business always slipped through a new spelling), so nothing is read that is not
 * named here:
 *
 *   - paths: the chosen ad account `act_<id>` and its own read edges; a campaign, ad set, ad or creative Nexus has read
 *     for that account, and that object's own edges. No Page, Instagram account, Business, person, pixel, audience,
 *     lead form, feed or rating — meta-ads-live serves Pages and Instagram accounts (masked), later steps add their own
 *     reads with their own checks;
 *   - fields: per node type, the fields Nexus's own reads use (mappers.ts) and Meta's documented read-only numbers;
 *   - nesting (`{…}` and the `.fields(…)` modifier alike): only under insights, creative, adcreatives and targeting, and
 *     the names inside come from THAT node type's list;
 *   - modifiers: .limit(n), .date_preset(…), .time_increment(…), .time_range(…) only (the gateway reads each).
 * Anything else is refused by name with one plain sentence, before any call.
 */

export type GraphNode =
  | 'AdAccount' | 'Campaign' | 'AdSet' | 'Ad' | 'AdCreative' | 'AdsInsights' | 'Targeting'
  | 'AdImage' | 'AdVideo' | 'AdsVolume' | 'MinimumBudget' | 'AsyncRequest'

const list = (...names: string[]) => new Set(names)

/** Fields per node type: what the step-2 mappers read, and Meta's documented read-only numbers. Never another asset. */
export const GRAPH_FIELDS: Readonly<Record<GraphNode, ReadonlySet<string>>> = {
  AdAccount: list(
    'id', 'account_id', 'name', 'currency', 'timezone_name', 'timezone_offset_hours_utc', 'account_status', 'disable_reason',
    'amount_spent', 'spend_cap', 'balance', 'min_daily_budget', 'min_campaign_group_spend_cap', 'is_prepay_account',
    'capabilities', 'created_time', 'age', 'tos_accepted', 'offsite_pixels_tos_accepted', 'failed_delivery_checks',
    'brand_safety_content_filter_levels', 'opportunity_score', 'is_notifications_enabled', 'insights',
  ),
  Campaign: list(
    'id', 'account_id', 'name', 'status', 'configured_status', 'effective_status', 'objective', 'buying_type', 'bid_strategy',
    'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap', 'start_time', 'stop_time', 'created_time', 'updated_time', 'insights',
  ),
  AdSet: list(
    'id', 'account_id', 'campaign_id', 'name', 'status', 'configured_status', 'effective_status', 'optimization_goal', 'billing_event',
    'bid_strategy', 'bid_amount', 'daily_budget', 'lifetime_budget', 'budget_remaining', 'destination_type', 'start_time', 'end_time',
    'created_time', 'updated_time', 'targeting', 'insights',
  ),
  Ad: list(
    'id', 'account_id', 'campaign_id', 'adset_id', 'name', 'status', 'configured_status', 'effective_status', 'creative',
    'issues_info', 'created_time', 'updated_time', 'insights',
  ),
  AdCreative: list('id', 'account_id', 'name', 'title', 'body', 'object_type', 'thumbnail_url', 'image_url', 'image_hash', 'video_id', 'call_to_action_type', 'status'),
  AdsInsights: list(
    'account_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'date_start', 'date_stop',
    'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks', 'spend', 'ctr', 'cpc', 'cpm', 'cpp',
    'actions', 'action_values', 'cost_per_action_type', 'purchase_roas', 'website_purchase_roas', 'outbound_clicks',
    'conversions', 'conversion_values', 'objective', 'optimization_goal', 'attribution_setting', 'account_currency',
  ),
  Targeting: list(
    'geo_locations', 'excluded_geo_locations', 'age_min', 'age_max', 'genders', 'locales', 'publisher_platforms',
    'facebook_positions', 'instagram_positions', 'audience_network_positions', 'messenger_positions', 'device_platforms', 'targeting_automation',
  ),
  AdImage: list('id', 'account_id', 'hash', 'name', 'url', 'url_128', 'width', 'height', 'status', 'created_time', 'updated_time'),
  AdVideo: list('id', 'title', 'length', 'picture', 'created_time', 'updated_time'),
  AdsVolume: list('ads_running_or_in_review_count', 'current_account_ads_running_or_in_review_count', 'limit_on_ads_running_or_in_review'),
  MinimumBudget: list('currency', 'min_daily_budget_imp', 'min_daily_budget_video_views', 'min_daily_budget_high_freq', 'min_daily_budget_low_freq'),
  AsyncRequest: list('id', 'status', 'scope_object_id', 'result'),
}

/** Asked when a read names no fields (Meta's default answer is never taken: it is not ours to vet). */
export const GRAPH_DEFAULT_FIELDS: Readonly<Record<GraphNode, string>> = {
  AdAccount: 'id,name,account_status', Campaign: 'id,name,status', AdSet: 'id,name,status', Ad: 'id,name,status', AdCreative: 'id,name',
  AdsInsights: 'impressions,clicks,spend', Targeting: 'geo_locations', AdImage: 'id,hash,name', AdVideo: 'id,title', AdsVolume: 'ads_running_or_in_review_count',
  MinimumBudget: 'currency,min_daily_budget_imp', AsyncRequest: 'id,status',
}

/** Which names may carry a nested list, and the node type of that list. */
const NESTED: Readonly<Record<string, GraphNode>> = { insights: 'AdsInsights', creative: 'AdCreative', adcreatives: 'AdCreative', targeting: 'Targeting' }

/** The chosen account's edges graph-read may read, and the node type of their rows. */
export const ACCOUNT_EDGES: Readonly<Record<string, GraphNode>> = {
  campaigns: 'Campaign', adsets: 'AdSet', ads: 'Ad', adcreatives: 'AdCreative', insights: 'AdsInsights', ads_volume: 'AdsVolume',
  minimum_budgets: 'MinimumBudget', async_requests: 'AsyncRequest', adimages: 'AdImage', advideos: 'AdVideo',
}

/** An object of the chosen account (known from Nexus's own read), and its own edges. */
export type GraphObjectKind = 'campaign' | 'adset' | 'ad' | 'creative'
export const OBJECT_NODE: Readonly<Record<GraphObjectKind, GraphNode>> = { campaign: 'Campaign', adset: 'AdSet', ad: 'Ad', creative: 'AdCreative' }
export const OBJECT_EDGES: Readonly<Record<GraphObjectKind, Readonly<Record<string, GraphNode>>>> = {
  campaign: { adsets: 'AdSet', ads: 'Ad', insights: 'AdsInsights' },
  adset: { ads: 'Ad', insights: 'AdsInsights' },
  ad: { insights: 'AdsInsights', adcreatives: 'AdCreative' },
  creative: {},
}

/**
 * Step 9 review fix A1 — graph-read's OWN query parameters, per list it reads (the node type of the edge's rows): exactly
 * what step 2 allowed — effective_status on campaign, ad set and ad lists; level, time_range, time_increment and
 * filtering on insights; status and type on async requests. Nothing on an object itself. The gateway's combined key list
 * (meta-calls.ts ROUTE_KEYS) grows with every later step; graph-read never follows it.
 */
export const GRAPH_EDGE_PARAMS: Readonly<Partial<Record<GraphNode, ReadonlySet<string>>>> = {
  Campaign: list('effective_status'), AdSet: list('effective_status'), Ad: list('effective_status'),
  AdsInsights: list('level', 'time_range', 'time_increment', 'filtering'),
  AsyncRequest: list('status', 'type'),
}

/** May graph-read send this parameter on a read of an edge whose rows are `edgeNode` (null: an object itself)? */
export function graphParamAllowed(edgeNode: GraphNode | null, key: string): boolean {
  return !!edgeNode && !!GRAPH_EDGE_PARAMS[edgeNode]?.has(key)
}

/** Modifiers a field may carry, each with what its argument may be. */
const MODIFIERS: Readonly<Record<string, RegExp>> = {
  limit: /^\d{1,4}$/,
  date_preset: /^[a-z0-9_]{1,30}$/,
  time_increment: /^(\d{1,2}|all_days|monthly)$/,
  time_range: /^\{\s*["']since["']\s*:\s*["']\d{4}-\d{2}-\d{2}["']\s*,\s*["']until["']\s*:\s*["']\d{4}-\d{2}-\d{2}["']\s*\}$/,
}

class FieldsRefusal extends Error {}

/**
 * Why `fields` is refused for a read of this node type, or null. A proper parse of Graph's field syntax: a list of
 * `name[.modifier(arg)]*[{list}]`, where `.fields(list)` is a list too.
 */
export function graphFieldsProblem(fields: string, node: GraphNode = 'AdAccount'): string | null {
  const s = fields
  let i = 0
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
  const name = (): string => {
    ws()
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
    if (!m) throw new FieldsRefusal(`fields is not a list Nexus can read (at "${s.slice(i, i + 20) || 'the end'}").`)
    i += m[0].length
    return m[0]
  }
  /** The text up to the ")" that closes the "(" just read (balanced). */
  const argument = (): string => {
    let depth = 1
    const start = i
    while (i < s.length && depth > 0) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
      if (depth > 0) i++
    }
    if (depth !== 0) throw new FieldsRefusal('fields has a ( with no ).')
    const arg = s.slice(start, i)
    i++ // the ")"
    return arg
  }
  const parseList = (type: GraphNode, inside: string | null, until: string | null): void => {
    for (;;) {
      const field = name()
      const where = inside ? ` inside ${inside}` : ''
      if (field !== field.toLowerCase() || !GRAPH_FIELDS[type].has(field)) {
        throw new FieldsRefusal(`"${field}"${where} is not a field meta-ads-graph-read reads on ${type === 'AdsInsights' ? 'insights' : `a ${type}`} (it reads only the ad account's own campaigns, ad sets, ads, creatives and numbers).`)
      }
      let nested = false
      for (;;) {
        ws()
        if (s[i] === '.') {
          i++
          const modifier = name()
          ws()
          if (s[i] !== '(') throw new FieldsRefusal(`".${modifier}" needs its ( … ).`)
          i++
          if (modifier === 'fields') {
            if (!NESTED[field]) throw new FieldsRefusal(`"${field}"${where} cannot be expanded; only ${Object.keys(NESTED).join(', ')} can.`)
            parseList(NESTED[field], inside ? `${inside} › ${field}` : field, ')')
            nested = true
            continue
          }
          const arg = argument()
          if (!MODIFIERS[modifier]) throw new FieldsRefusal(`".${modifier}(…)" is not a modifier meta-ads-graph-read sends (only .limit, .date_preset, .time_increment, .time_range).`)
          if (!MODIFIERS[modifier].test(arg.trim())) throw new FieldsRefusal(`".${modifier}(${arg.slice(0, 40)})" is not a value Nexus sends.`)
          continue
        }
        if (s[i] === '{') {
          if (nested || !NESTED[field]) throw new FieldsRefusal(`"${field}"${where} cannot be expanded; only ${Object.keys(NESTED).join(', ')} can.`)
          i++
          parseList(NESTED[field], inside ? `${inside} › ${field}` : field, '}')
          nested = true
          continue
        }
        break
      }
      ws()
      if (s[i] === ',') { i++; continue }
      if (until) {
        if (s[i] !== until) throw new FieldsRefusal(`fields has a ${until === '}' ? '{' : '('} with no ${until}.`)
        i++
        return
      }
      if (i < s.length) throw new FieldsRefusal(`fields is not a list Nexus can read (at "${s.slice(i, i + 20)}").`)
      return
    }
  }
  try {
    if (!s.trim()) return null
    parseList(node, null, null)
    return null
  } catch (err) {
    if (err instanceof FieldsRefusal) return err.message
    throw err
  }
}
