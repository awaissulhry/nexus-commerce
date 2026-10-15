/**
 * Google Ads programme 2, G8a (2026-10-15) — the live reads the conversion changes stand on: conversion actions (G1's
 * query and mapper, live-account.ts), the tag snippets of tag-based actions, conversion value rules and rule sets, and
 * which enabled campaigns bid with Smart Bidding (what a conversion change can make spend more). Goals and the
 * account's conversion settings are G1's reads (live-account.ts `liveConversions`, `liveAccountSettings`). Every read
 * of a change goes through write-client.ts `liveRows` (one operation per query, on the change allowance); a read Google
 * refuses fails the change (no `notRead` here: a change never stands on a part it did not read).
 *
 * Checked 2026-10-15 against Google's v25 field reference (https://developers.google.com/google-ads/api/fields/v25/
 * conversion_action, …/conversion_value_rule, …/conversion_value_rule_set, fetched with curl and parsed): every selected
 * field is Selectable; every WHERE field is Filterable (conversion_action.id, conversion_value_rule.status,
 * conversion_value_rule_set.status); conversion_action.tag_snippets is Selectable, not Filterable (selected only).
 * conversion_value_rule_set.conversion_action_categories is Selectable, not Filterable (selected only). Enum values are
 * from the same pages: conversion_value_rule.status ENABLED | PAUSED | REMOVED; conversion_value_rule_set.status ENABLED |
 * PAUSED | REMOVED (read only: derived from its rules).
 */
import { liveRows } from './write-client.js'
import { gaqlId, idOf, liveCampaigns, type LiveCampaign } from './live.js'
import { CONVERSION_ACTIONS_QUERY, conversionActionOf, type LiveConversionAction } from './live-account.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const num = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ── conversion actions ───────────────────────────────────────────────────────────────────────────────────────────

/** Every conversion action that is not removed (G1's query: CONVERSION_ACTIONS_QUERY). */
export async function liveConversionActions(target: GoogleAdsTarget): Promise<LiveConversionAction[]> {
  return (await liveRows<Json>(target, CONVERSION_ACTIONS_QUERY, 'ads.search.live.conversion-actions')).map(conversionActionOf)
}

export interface TagSnippet {
  /** WEBPAGE | WEBPAGE_ONCLICK | CLICK_TO_CALL | WEBSITE_CALL (TrackingCodeType). */
  type: string | null
  /** HTML | AMP (TrackingCodePageFormat). */
  pageFormat: string | null
  /** The site tag (on every page). */
  globalSiteTag: string | null
  /** The event snippet (on the page of the action, e.g. the order confirmation). */
  eventSnippet: string | null
}

export const tagSnippetsQuery = (ids: string[]): string =>
  `SELECT conversion_action.id, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.id IN (${ids.map((id) => gaqlId(id, 'The conversion action')).join(', ')})`

/** The tag snippets Google gives for tag-based conversion actions (what the Owner pastes in the shop), by action id. */
export async function liveTagSnippets(target: GoogleAdsTarget, ids: string[]): Promise<Map<string, TagSnippet[]>> {
  const out = new Map<string, TagSnippet[]>()
  if (!ids.length) return out
  for (const row of await liveRows<Json>(target, tagSnippetsQuery(ids), 'ads.search.live.conversion-tags')) {
    const id = str(row.conversionAction?.id)
    if (!id) continue
    const snippets = Array.isArray(row.conversionAction?.tagSnippets) ? row.conversionAction.tagSnippets : []
    out.set(id, snippets.map((s: Json) => ({ type: str(s.type), pageFormat: str(s.pageFormat), globalSiteTag: str(s.globalSiteTag), eventSnippet: str(s.eventSnippet) })))
  }
  return out
}

// ── Smart Bidding ────────────────────────────────────────────────────────────────────────────────────────────────

/** Bidding that chases conversions (Smart Bidding): a conversion change changes what it bids for. */
export const CONVERSION_BIDDING = new Set(['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE'])
/** Bidding that chases conversion VALUE: a value change (default value, value rules) changes what it bids for. */
export const VALUE_BIDDING = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE'])

export interface SmartBiddingCampaign { campaignId: string; name: string; status: string | null; bidding: string | null }

/** Every campaign that is not removed, with its bidding (campaign.bidding_strategy_type: a portfolio's type too). */
export async function liveBiddingCampaigns(target: GoogleAdsTarget): Promise<SmartBiddingCampaign[]> {
  return (await liveCampaigns(target)).map((c: LiveCampaign) => ({ campaignId: c.campaignId, name: c.name, status: c.status, bidding: c.bidding }))
}

// ── conversion value rules and rule sets ─────────────────────────────────────────────────────────────────────────

export const VALUE_RULES_QUERY =
  'SELECT conversion_value_rule.id, conversion_value_rule.status, conversion_value_rule.action.operation, conversion_value_rule.action.value, ' +
  'conversion_value_rule.device_condition.device_types, conversion_value_rule.geo_location_condition.geo_target_constants, ' +
  'conversion_value_rule.geo_location_condition.geo_match_type, conversion_value_rule.geo_location_condition.excluded_geo_target_constants, ' +
  'conversion_value_rule.geo_location_condition.excluded_geo_match_type, conversion_value_rule.audience_condition.user_lists, ' +
  'conversion_value_rule.audience_condition.user_interests, conversion_value_rule.owner_customer ' +
  "FROM conversion_value_rule WHERE conversion_value_rule.status != 'REMOVED'"

export const VALUE_RULE_SETS_QUERY =
  'SELECT conversion_value_rule_set.id, conversion_value_rule_set.status, conversion_value_rule_set.attachment_type, ' +
  'conversion_value_rule_set.campaign, conversion_value_rule_set.conversion_value_rules, conversion_value_rule_set.dimensions, ' +
  'conversion_value_rule_set.conversion_action_categories, conversion_value_rule_set.owner_customer ' +
  "FROM conversion_value_rule_set WHERE conversion_value_rule_set.status != 'REMOVED'"

export type ValueRuleOperation = 'ADD' | 'MULTIPLY' | 'SET'
export type ValueRuleDimension = 'DEVICE' | 'GEO_LOCATION' | 'AUDIENCE' | 'ITINERARY' | 'NO_CONDITION'

export interface LiveValueRule {
  valueRuleId: string
  status: 'ENABLED' | 'PAUSED' | null
  operation: ValueRuleOperation | null
  /** ADD / SET: an amount of the account's currency (Google's double); MULTIPLY: the factor. */
  value: number | null
  devices: string[]
  locations: { include: string[]; exclude: string[]; matchType: string | null; excludeMatchType: string | null } | null
  audiences: { userLists: string[]; userInterests: string[] } | null
  /** The dimensions its conditions use (the rule set must name them). */
  dimensions: ValueRuleDimension[]
  ownerCustomerId: string | null
}

export interface LiveValueRuleSet {
  ruleSetId: string
  status: string | null
  attachment: 'CUSTOMER' | 'CAMPAIGN' | null
  campaignId: string | null
  /** The ids of its rules, in Google's order (the first rule that matches applies). */
  ruleIds: string[]
  dimensions: ValueRuleDimension[]
  categories: string[]
  ownerCustomerId: string | null
}

export function valueRuleOf(row: Json): LiveValueRule {
  const r = row.conversionValueRule ?? {}
  const geo = r.geoLocationCondition
  const audience = r.audienceCondition
  const devices = list(r.deviceCondition?.deviceTypes)
  const locations = geo && (list(geo.geoTargetConstants).length || list(geo.excludedGeoTargetConstants).length)
    ? { include: list(geo.geoTargetConstants).map((n) => idOf(n) ?? n), exclude: list(geo.excludedGeoTargetConstants).map((n) => idOf(n) ?? n), matchType: str(geo.geoMatchType), excludeMatchType: str(geo.excludedGeoMatchType) }
    : null
  const audiences = audience && (list(audience.userLists).length || list(audience.userInterests).length)
    ? { userLists: list(audience.userLists).map((n) => idOf(n) ?? n), userInterests: list(audience.userInterests).map((n) => idOf(n) ?? n) }
    : null
  const dimensions: ValueRuleDimension[] = [
    ...(devices.length ? ['DEVICE' as const] : []),
    ...(locations ? ['GEO_LOCATION' as const] : []),
    ...(audiences ? ['AUDIENCE' as const] : []),
  ]
  const status = str(r.status)
  const operation = str(r.action?.operation)
  return {
    valueRuleId: str(r.id) ?? '',
    status: status === 'ENABLED' || status === 'PAUSED' ? status : null,
    operation: operation === 'ADD' || operation === 'MULTIPLY' || operation === 'SET' ? operation : null,
    value: num(r.action?.value),
    devices,
    locations,
    audiences,
    dimensions,
    ownerCustomerId: idOf(r.ownerCustomer),
  }
}

export function valueRuleSetOf(row: Json): LiveValueRuleSet {
  const s = row.conversionValueRuleSet ?? {}
  const attachment = str(s.attachmentType)
  return {
    ruleSetId: str(s.id) ?? '',
    status: str(s.status),
    attachment: attachment === 'CUSTOMER' || attachment === 'CAMPAIGN' ? attachment : null,
    campaignId: idOf(s.campaign),
    ruleIds: list(s.conversionValueRules).map((n) => idOf(n) ?? n),
    dimensions: list(s.dimensions) as ValueRuleDimension[],
    categories: list(s.conversionActionCategories),
    ownerCustomerId: idOf(s.ownerCustomer),
  }
}

export interface LiveValueRules { rules: LiveValueRule[]; sets: LiveValueRuleSet[] }

/** The account's conversion value rules and rule sets that are not removed (two queries). */
export async function liveValueRules(target: GoogleAdsTarget): Promise<LiveValueRules> {
  const rules = (await liveRows<Json>(target, VALUE_RULES_QUERY, 'ads.search.live.value-rules')).map(valueRuleOf)
  const sets = (await liveRows<Json>(target, VALUE_RULE_SETS_QUERY, 'ads.search.live.value-rule-sets')).map(valueRuleSetOf)
  return { rules, sets }
}
