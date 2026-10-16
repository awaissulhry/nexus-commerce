/**
 * Google Ads programme 2, G14a (2026-10-16) — the live reads custom conversion goals and new audiences stand on: the
 * account's custom goals, custom audiences (with their members), reusable audiences (Audience: segments, demographics,
 * exclusions), user lists (with their rules), and where an audience is used (campaign and ad group criteria, asset group
 * signals). Every read of a change goes through write-client.ts `liveRows` (one operation per query, on the change
 * allowance); a read Google refuses fails the change.
 *
 * Checked 2026-10-16 with curl against Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/…):
 *   custom_conversion_goal  id, name, status (ENABLED | REMOVED), conversion_actions (repeated RESOURCE_NAME) — all
 *                           selectable and filterable.
 *   custom_audience         id, name, description, type (AUTO | INTEREST | PURCHASE_INTENT | SEARCH), status (ENABLED |
 *                           REMOVED) — selectable and filterable; members (repeated MESSAGE) selectable, not filterable.
 *   audience                id, name, description, status, scope (CUSTOMER | ASSET_GROUP), asset_group — selectable and
 *                           filterable; dimensions (repeated MESSAGE) and exclusion_dimension (MESSAGE) selectable only.
 *   user_list               id, name, description, type, membership_status (OPEN | CLOSED), membership_life_span,
 *                           read_only, access_reason, eligible_for_search, eligible_for_display, size_range_for_search,
 *                           size_range_for_display, rule_based_user_list.prepopulation_status,
 *                           rule_based_user_list.flexible_rule_user_list.inclusive_rule_operator — selectable and
 *                           filterable; …inclusive_operands, …exclusive_operands, logical_user_list.rules,
 *                           basic_user_list.actions (repeated MESSAGE) selectable only; lookalike_user_list.seed_user_list_ids,
 *                           .expansion_level, .country_codes selectable.
 *   campaign_criterion      type (CriterionType has USER_LIST, CUSTOM_AUDIENCE, AUDIENCE), negative, status,
 *                           user_list.user_list, custom_audience.custom_audience — selectable and filterable (there is no
 *                           campaign_criterion.audience: an Audience is targeted at the ad group, docs/remarketing/audiences).
 *   ad_group_criterion      the same, and audience.audience.
 *   asset_group_signal      audience.audience — selectable (G10's read uses it with campaign and asset_group fields).
 *   detailed_demographic    id, name — selectable and filterable (resource customers/{c}/detailedDemographics/{id}).
 */
import { liveRows } from './write-client.js'
import { gaqlId, idOf } from './live.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const arr = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : [])
const sorted = (values: string[]) => [...values].sort()

// ── custom conversion goals ──────────────────────────────────────────────────────────────────────────────────────

export const CUSTOM_GOALS_QUERY =
  'SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions ' +
  "FROM custom_conversion_goal WHERE custom_conversion_goal.status != 'REMOVED'"

export interface LiveCustomGoal { customGoalId: string; name: string | null; status: string | null; conversionActionIds: string[] }

export const customGoalOf = (row: Json): LiveCustomGoal => {
  const g = row.customConversionGoal ?? {}
  return {
    customGoalId: str(g.id) ?? '',
    name: str(g.name),
    status: str(g.status),
    conversionActionIds: sorted((Array.isArray(g.conversionActions) ? g.conversionActions : []).map((n: unknown) => idOf(n) ?? '').filter(Boolean)),
  }
}

/** The account's custom conversion goals that are not removed. */
export async function liveCustomGoals(target: GoogleAdsTarget): Promise<LiveCustomGoal[]> {
  return (await liveRows<Json>(target, CUSTOM_GOALS_QUERY, 'ads.search.live.custom-goals')).map(customGoalOf).filter((g) => g.customGoalId)
}

// ── custom audiences ─────────────────────────────────────────────────────────────────────────────────────────────

/** CustomAudienceMemberType (v25): KEYWORD, URL, APP (an Android package name), PLACE_CATEGORY (Google's id). */
export const MEMBER_TYPES = ['KEYWORD', 'URL', 'APP', 'PLACE_CATEGORY'] as const
export type MemberType = typeof MEMBER_TYPES[number]
export interface AudienceMember { type: MemberType; value: string }
export const memberKey = (m: AudienceMember) => `${m.type}:${m.type === 'URL' || m.type === 'PLACE_CATEGORY' ? m.value.trim() : m.value.trim().toLowerCase()}`

export const CUSTOM_AUDIENCES_QUERY =
  'SELECT custom_audience.id, custom_audience.name, custom_audience.description, custom_audience.type, custom_audience.status, custom_audience.members ' +
  "FROM custom_audience WHERE custom_audience.status = 'ENABLED'"

export interface LiveCustomAudience { customAudienceId: string; name: string | null; description: string | null; type: string | null; members: AudienceMember[] }

export function memberOf(m: Json): AudienceMember | null {
  switch (m.memberType) {
    case 'KEYWORD': return str(m.keyword) ? { type: 'KEYWORD', value: String(m.keyword) } : null
    case 'URL': return str(m.url) ? { type: 'URL', value: String(m.url) } : null
    case 'APP': return str(m.app) ? { type: 'APP', value: String(m.app) } : null
    case 'PLACE_CATEGORY': return str(m.placeCategory) ? { type: 'PLACE_CATEGORY', value: String(m.placeCategory) } : null
    default: return null
  }
}

/** A member as Google's JSON takes it (CustomAudienceMember: member_type and its one value; place_category an int64 string). */
export function memberJson(m: AudienceMember): Json {
  const field = m.type === 'KEYWORD' ? 'keyword' : m.type === 'URL' ? 'url' : m.type === 'APP' ? 'app' : 'placeCategory'
  return { memberType: m.type, [field]: m.value.trim() }
}

export const customAudienceOf = (row: Json): LiveCustomAudience => {
  const a = row.customAudience ?? {}
  return {
    customAudienceId: str(a.id) ?? '',
    name: str(a.name),
    description: str(a.description),
    type: str(a.type),
    members: arr(a.members).map(memberOf).filter((m): m is AudienceMember => !!m),
  }
}

export async function liveCustomAudiences(target: GoogleAdsTarget): Promise<LiveCustomAudience[]> {
  return (await liveRows<Json>(target, CUSTOM_AUDIENCES_QUERY, 'ads.search.live.custom-audiences')).map(customAudienceOf).filter((a) => a.customAudienceId)
}

// ── reusable audiences (Audience) ────────────────────────────────────────────────────────────────────────────────

/** The segments an Audience is made of (AudienceSegment v25) and the collection of each one's resource name. */
export const SEGMENT_KINDS = ['USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'LIFE_EVENT', 'DETAILED_DEMOGRAPHIC'] as const
export type SegmentKind = typeof SEGMENT_KINDS[number]
export const SEGMENT_JSON: Record<SegmentKind, { key: string; field: string; collection: string }> = {
  USER_LIST: { key: 'userList', field: 'userList', collection: 'userLists' },
  USER_INTEREST: { key: 'userInterest', field: 'userInterestCategory', collection: 'userInterests' },
  CUSTOM_AUDIENCE: { key: 'customAudience', field: 'customAudience', collection: 'customAudiences' },
  LIFE_EVENT: { key: 'lifeEvent', field: 'lifeEvent', collection: 'lifeEvents' },
  DETAILED_DEMOGRAPHIC: { key: 'detailedDemographic', field: 'detailedDemographic', collection: 'detailedDemographics' },
}
export interface SegmentRef { kind: SegmentKind; id: string }
export const segmentKey = (s: SegmentRef) => `${s.kind}|${s.id}`

/** AgeSegment (v25): min 18, 25, 35, 45, 55 or 65; max (optional, above min) 24, 34, 44, 54 or 64. */
export interface AgeRange { min: number; max: number | null }
export interface DemographicPart<T extends string> { values: T[]; includeUndetermined: boolean }
export const GENDERS = ['MALE', 'FEMALE'] as const
export const INCOMES = ['INCOME_RANGE_0_50', 'INCOME_RANGE_50_60', 'INCOME_RANGE_60_70', 'INCOME_RANGE_70_80', 'INCOME_RANGE_80_90', 'INCOME_RANGE_90_UP'] as const
export const PARENTAL = ['PARENT', 'NOT_A_PARENT'] as const

/** An Audience's composition, as Nexus reads and writes it (each part null = that dimension is not there). */
export interface AudienceDefinition {
  segments: SegmentRef[]
  ages: { ranges: AgeRange[]; includeUndetermined: boolean } | null
  genders: DemographicPart<typeof GENDERS[number]> | null
  incomes: DemographicPart<typeof INCOMES[number]> | null
  parental: DemographicPart<typeof PARENTAL[number]> | null
  /** User lists left out of it (exclusion_dimension: only user list segments, docs/remarketing/audiences). */
  excludeUserLists: string[]
  /** Dimensions Nexus does not know, kept as Google sent them (so a change never drops one). */
  other: Json[]
}

export const LIVE_REUSABLE_AUDIENCES_QUERY =
  'SELECT audience.id, audience.name, audience.description, audience.status, audience.scope, audience.asset_group, audience.dimensions, ' +
  "audience.exclusion_dimension FROM audience WHERE audience.status = 'ENABLED'"

export interface LiveReusableAudience {
  audienceId: string
  name: string | null
  description: string | null
  scope: string | null
  assetGroupId: string | null
  definition: AudienceDefinition
}

function segmentOf(s: Json): SegmentRef | null {
  for (const kind of SEGMENT_KINDS) {
    const j = SEGMENT_JSON[kind]
    const id = idOf(s?.[j.key]?.[j.field])
    if (id) return { kind, id }
  }
  return null
}

export function definitionOf(dimensions: unknown, exclusion: unknown): AudienceDefinition {
  const d: AudienceDefinition = { segments: [], ages: null, genders: null, incomes: null, parental: null, excludeUserLists: [], other: [] }
  for (const dim of arr(dimensions)) {
    if (dim.audienceSegments) d.segments.push(...arr(dim.audienceSegments.segments).map(segmentOf).filter((s): s is SegmentRef => !!s))
    else if (dim.age) {
      d.ages = {
        ranges: arr(dim.age.ageRanges).map((r) => ({ min: num(r.minAge) ?? 18, max: num(r.maxAge) })).sort((a, b) => a.min - b.min),
        includeUndetermined: dim.age.includeUndetermined === true,
      }
    } else if (dim.gender) d.genders = { values: sorted((dim.gender.genders ?? []).map(String)) as never, includeUndetermined: dim.gender.includeUndetermined === true }
    else if (dim.householdIncome) d.incomes = { values: sorted((dim.householdIncome.incomeRanges ?? []).map(String)) as never, includeUndetermined: dim.householdIncome.includeUndetermined === true }
    else if (dim.parentalStatus) d.parental = { values: sorted((dim.parentalStatus.parentalStatuses ?? []).map(String)) as never, includeUndetermined: dim.parentalStatus.includeUndetermined === true }
    else d.other.push(dim)
  }
  const ex = exclusion && typeof exclusion === 'object' ? (exclusion as Json) : {}
  d.excludeUserLists = sorted(arr(ex.exclusions).map((e) => idOf(e?.userList?.userList)).filter((id): id is string => !!id))
  d.segments.sort((a, b) => segmentKey(a).localeCompare(segmentKey(b)))
  return d
}

/** The dimensions and exclusion of a definition as Google's JSON takes them (one dimension of each type). */
export function definitionJson(customer: string, d: AudienceDefinition): { dimensions: Json[]; exclusionDimension: Json } {
  const dimensions: Json[] = []
  if (d.segments.length) {
    dimensions.push({ audienceSegments: { segments: d.segments.map((s) => {
      const j = SEGMENT_JSON[s.kind]
      return { [j.key]: { [j.field]: `${customer}/${j.collection}/${s.id}` } }
    }) } })
  }
  if (d.ages) dimensions.push({ age: { ageRanges: d.ages.ranges.map((r) => ({ minAge: r.min, ...(r.max !== null ? { maxAge: r.max } : {}) })), includeUndetermined: d.ages.includeUndetermined } })
  if (d.genders) dimensions.push({ gender: { genders: d.genders.values, includeUndetermined: d.genders.includeUndetermined } })
  if (d.incomes) dimensions.push({ householdIncome: { incomeRanges: d.incomes.values, includeUndetermined: d.incomes.includeUndetermined } })
  if (d.parental) dimensions.push({ parentalStatus: { parentalStatuses: d.parental.values, includeUndetermined: d.parental.includeUndetermined } })
  dimensions.push(...d.other)
  return { dimensions, exclusionDimension: { exclusions: d.excludeUserLists.map((id) => ({ userList: { userList: `${customer}/userLists/${id}` } })) } }
}

export const reusableAudienceOf = (row: Json): LiveReusableAudience => {
  const a = row.audience ?? {}
  return {
    audienceId: str(a.id) ?? '',
    name: str(a.name),
    description: str(a.description),
    scope: str(a.scope),
    assetGroupId: idOf(a.assetGroup),
    definition: definitionOf(a.dimensions, a.exclusionDimension),
  }
}

export async function liveReusableAudiences(target: GoogleAdsTarget): Promise<LiveReusableAudience[]> {
  return (await liveRows<Json>(target, LIVE_REUSABLE_AUDIENCES_QUERY, 'ads.search.live.reusable-audiences')).map(reusableAudienceOf).filter((a) => a.audienceId)
}

export const detailedDemographicsQuery = (ids: string[]): string =>
  `SELECT detailed_demographic.id, detailed_demographic.name FROM detailed_demographic WHERE detailed_demographic.id IN (${[...new Set(ids)].map((id) => gaqlId(id, 'The detailed demographic')).join(', ')})`

/** The names of detailed demographics by id (a missing one is unknown to Google). */
export async function liveDetailedDemographicNames(target: GoogleAdsTarget, ids: string[]): Promise<Record<string, string | null>> {
  if (!ids.length) return {}
  const out: Record<string, string | null> = {}
  for (const r of await liveRows<Json>(target, detailedDemographicsQuery(ids), 'ads.search.live.detailed-demographics')) {
    const id = str(r.detailedDemographic?.id)
    if (id) out[id] = str(r.detailedDemographic?.name)
  }
  return out
}

// ── user lists ───────────────────────────────────────────────────────────────────────────────────────────────────

/** UserListStringRuleItemOperator, UserListNumberRuleItemOperator, UserListDateRuleItemOperator (v25). */
export const STRING_OPERATORS = ['CONTAINS', 'EQUALS', 'STARTS_WITH', 'ENDS_WITH', 'NOT_EQUALS', 'NOT_CONTAINS', 'NOT_STARTS_WITH', 'NOT_ENDS_WITH'] as const
export const NUMBER_OPERATORS = ['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'EQUALS', 'NOT_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUAL'] as const
export const DATE_OPERATORS = ['EQUALS', 'NOT_EQUALS', 'BEFORE', 'AFTER'] as const

/** One rule item: a tag parameter (url__ = the page's URL, ref_url__ = the referrer) compared with a text, a number or a date. */
export interface RuleItem {
  parameter: string
  operator: string
  text?: string
  number?: number
  /** YYYY-MM-DD, in the account's time zone. */
  date?: string
  /** A date relative to today, in days (Google's offset_in_days). */
  offsetDays?: number
}
/** One operand: rule item groups ORed, the items of a group ANDed (UserListRuleInfo: "OR of ANDs"), over a lookback window. */
export interface RuleOperand { anyOf: Array<{ allOf: RuleItem[] }>; lookbackDays: number | null }
/** A flexible rule list: the inclusive operands joined by AND or OR, minus anyone in an exclusive operand. */
export interface VisitorRules { operator: 'AND' | 'OR'; include: RuleOperand[]; exclude: RuleOperand[] }

export interface LiveUserList {
  userListId: string
  name: string | null
  description: string | null
  type: string | null
  membershipStatus: string | null
  membershipDays: number | null
  readOnly: boolean
  accessReason: string | null
  eligibleForSearch: boolean | null
  eligibleForDisplay: boolean | null
  sizeForSearch: string | null
  sizeForDisplay: string | null
  /** RULE_BASED: its flexible rule (null when it has none Nexus reads). */
  visitors: VisitorRules | null
  prepopulation: string | null
  /** LOGICAL: rules ANDed, each ALL / ANY / NONE of user lists. */
  combination: Array<{ operator: string; userListIds: string[] }> | null
  /** REMARKETING (basic): the conversion actions (and remarketing actions) whose people it holds. */
  actions: { conversionActionIds: string[]; remarketingActionIds: string[] } | null
  lookalike: { seedUserListIds: string[]; expansion: string | null; countries: string[] } | null
}

export const LIVE_USER_LISTS_QUERY =
  'SELECT user_list.id, user_list.name, user_list.description, user_list.type, user_list.membership_status, user_list.membership_life_span, ' +
  'user_list.read_only, user_list.access_reason, user_list.eligible_for_search, user_list.eligible_for_display, user_list.size_range_for_search, ' +
  'user_list.size_range_for_display, user_list.rule_based_user_list.prepopulation_status, ' +
  'user_list.rule_based_user_list.flexible_rule_user_list.inclusive_rule_operator, ' +
  'user_list.rule_based_user_list.flexible_rule_user_list.inclusive_operands, user_list.rule_based_user_list.flexible_rule_user_list.exclusive_operands, ' +
  'user_list.logical_user_list.rules, user_list.basic_user_list.actions, user_list.lookalike_user_list.seed_user_list_ids, ' +
  'user_list.lookalike_user_list.expansion_level, user_list.lookalike_user_list.country_codes FROM user_list'

export function ruleItemOf(item: Json): RuleItem {
  const out: RuleItem = { parameter: str(item.name) ?? '', operator: '' }
  if (item.stringRuleItem) { out.operator = str(item.stringRuleItem.operator) ?? ''; out.text = typeof item.stringRuleItem.value === 'string' ? item.stringRuleItem.value : '' }
  else if (item.numberRuleItem) { out.operator = str(item.numberRuleItem.operator) ?? ''; out.number = num(item.numberRuleItem.value) ?? 0 }
  else if (item.dateRuleItem) {
    out.operator = str(item.dateRuleItem.operator) ?? ''
    if (str(item.dateRuleItem.value)) out.date = String(item.dateRuleItem.value)
    if (num(item.dateRuleItem.offsetInDays) !== null) out.offsetDays = num(item.dateRuleItem.offsetInDays)!
  }
  return out
}

const operandOf = (o: Json): RuleOperand => ({
  anyOf: arr(o.rule?.ruleItemGroups).map((g) => ({ allOf: arr(g.ruleItems).map(ruleItemOf) })),
  lookbackDays: num(o.lookbackWindowDays),
})

/** A rule item as Google's JSON takes it (UserListRuleItemInfo: name and ONE of the three items). */
export function ruleItemJson(i: RuleItem): Json {
  if (i.number !== undefined) return { name: i.parameter, numberRuleItem: { operator: i.operator, value: i.number } }
  if (i.date !== undefined || i.offsetDays !== undefined) {
    return { name: i.parameter, dateRuleItem: { operator: i.operator, ...(i.date !== undefined ? { value: i.date } : {}), ...(i.offsetDays !== undefined ? { offsetInDays: String(i.offsetDays) } : {}) } }
  }
  return { name: i.parameter, stringRuleItem: { operator: i.operator, value: i.text ?? '' } }
}

const operandJson = (o: RuleOperand): Json => ({
  rule: { ruleItemGroups: o.anyOf.map((g) => ({ ruleItems: g.allOf.map(ruleItemJson) })) },
  ...(o.lookbackDays !== null ? { lookbackWindowDays: String(o.lookbackDays) } : {}),
})

/** The flexible rule of a rule-based list as Google's JSON takes it (FlexibleRuleUserListInfo). */
export function visitorRulesJson(v: VisitorRules): Json {
  return {
    inclusiveRuleOperator: v.operator,
    inclusiveOperands: v.include.map(operandJson),
    ...(v.exclude.length ? { exclusiveOperands: v.exclude.map(operandJson) } : {}),
  }
}

export function userListOf(row: Json): LiveUserList {
  const u = row.userList ?? {}
  const flexible = u.ruleBasedUserList?.flexibleRuleUserList
  const logical = u.logicalUserList
  const basic = u.basicUserList
  const lookalike = u.lookalikeUserList
  return {
    userListId: str(u.id) ?? '',
    name: str(u.name),
    description: str(u.description),
    type: str(u.type),
    membershipStatus: str(u.membershipStatus),
    membershipDays: num(u.membershipLifeSpan),
    readOnly: u.readOnly === true,
    accessReason: str(u.accessReason),
    eligibleForSearch: typeof u.eligibleForSearch === 'boolean' ? u.eligibleForSearch : null,
    eligibleForDisplay: typeof u.eligibleForDisplay === 'boolean' ? u.eligibleForDisplay : null,
    sizeForSearch: str(u.sizeRangeForSearch),
    sizeForDisplay: str(u.sizeRangeForDisplay),
    visitors: flexible ? {
      operator: flexible.inclusiveRuleOperator === 'OR' ? 'OR' : 'AND',
      include: arr(flexible.inclusiveOperands).map(operandOf),
      exclude: arr(flexible.exclusiveOperands).map(operandOf),
    } : null,
    prepopulation: str(u.ruleBasedUserList?.prepopulationStatus),
    combination: logical ? arr(logical.rules).map((r) => ({ operator: str(r.operator) ?? '', userListIds: arr(r.ruleOperands).map((o) => idOf(o.userList) ?? '').filter(Boolean) })) : null,
    actions: basic ? {
      conversionActionIds: sorted(arr(basic.actions).map((a) => idOf(a.conversionAction)).filter((id): id is string => !!id)),
      remarketingActionIds: sorted(arr(basic.actions).map((a) => idOf(a.remarketingAction)).filter((id): id is string => !!id)),
    } : null,
    lookalike: lookalike ? {
      seedUserListIds: sorted((Array.isArray(lookalike.seedUserListIds) ? lookalike.seedUserListIds : []).map(String)),
      expansion: str(lookalike.expansionLevel),
      countries: sorted((Array.isArray(lookalike.countryCodes) ? lookalike.countryCodes : []).map(String)),
    } : null,
  }
}

/** Every user list the account can see (its own, shared, Google's), with their rules. */
export async function liveUserLists(target: GoogleAdsTarget): Promise<LiveUserList[]> {
  return (await liveRows<Json>(target, LIVE_USER_LISTS_QUERY, 'ads.search.live.user-lists')).map(userListOf).filter((u) => u.userListId)
}

// ── where an audience is used ────────────────────────────────────────────────────────────────────────────────────

export type UsedKind = 'USER_LIST' | 'CUSTOM_AUDIENCE' | 'AUDIENCE'

/** One place an audience is used: a campaign or ad group criterion (targeted, observed or excluded), or an asset group signal. */
export interface AudienceUse {
  kind: UsedKind
  id: string
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  channel: string | null
  level: 'campaign' | 'ad-group' | 'asset-group'
  /** The ad group's or asset group's status (null at the campaign). */
  levelStatus: string | null
  /** The criterion's own status (ENABLED | PAUSED; null for a signal). */
  status: string | null
  negative: boolean
  /** G14a review: what the audience is used through (a reusable audience, a combination, a lookalike); none = directly. */
  via?: string
}

export const USES_CAMPAIGN_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_criterion.type, campaign_criterion.negative, ' +
  'campaign_criterion.status, campaign_criterion.user_list.user_list, campaign_criterion.custom_audience.custom_audience FROM campaign_criterion ' +
  "WHERE campaign_criterion.type IN ('USER_LIST', 'CUSTOM_AUDIENCE') AND campaign.status != 'REMOVED' AND campaign_criterion.status != 'REMOVED'"

export const USES_AD_GROUP_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.id, ad_group.status, ad_group_criterion.type, ' +
  'ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.user_list.user_list, ad_group_criterion.custom_audience.custom_audience, ' +
  "ad_group_criterion.audience.audience FROM ad_group_criterion WHERE ad_group_criterion.type IN ('USER_LIST', 'CUSTOM_AUDIENCE', 'AUDIENCE') " +
  "AND campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND ad_group_criterion.status != 'REMOVED'"

export const USES_SIGNAL_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, asset_group.id, asset_group.status, ' +
  "asset_group_signal.audience.audience FROM asset_group_signal WHERE campaign.status != 'REMOVED' AND asset_group.status != 'REMOVED'"

const campaignPart = (r: Json) => ({
  campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status), channel: str(r.campaign?.advertisingChannelType),
})

export function usesOf(rows: { campaign: Json[]; adGroup: Json[]; signal: Json[] }): AudienceUse[] {
  const out: AudienceUse[] = []
  const criterion = (c: Json): { kind: UsedKind; id: string } | null => {
    const userList = idOf(c?.userList?.userList)
    if (userList) return { kind: 'USER_LIST', id: userList }
    const custom = idOf(c?.customAudience?.customAudience)
    if (custom) return { kind: 'CUSTOM_AUDIENCE', id: custom }
    const audience = idOf(c?.audience?.audience)
    return audience ? { kind: 'AUDIENCE', id: audience } : null
  }
  for (const r of rows.campaign) {
    const c = criterion(r.campaignCriterion)
    if (c) out.push({ ...c, ...campaignPart(r), level: 'campaign', levelStatus: null, status: str(r.campaignCriterion?.status), negative: r.campaignCriterion?.negative === true })
  }
  for (const r of rows.adGroup) {
    const c = criterion(r.adGroupCriterion)
    if (c) out.push({ ...c, ...campaignPart(r), level: 'ad-group', levelStatus: str(r.adGroup?.status), status: str(r.adGroupCriterion?.status), negative: r.adGroupCriterion?.negative === true })
  }
  for (const r of rows.signal) {
    const id = idOf(r.assetGroupSignal?.audience?.audience)
    if (id) out.push({ kind: 'AUDIENCE', id, ...campaignPart(r), level: 'asset-group', levelStatus: str(r.assetGroup?.status), status: null, negative: false })
  }
  return out
}

/** Where the account's user lists, custom audiences and reusable audiences are used (three reads). */
export async function liveAudienceUses(target: GoogleAdsTarget): Promise<AudienceUse[]> {
  const campaign = await liveRows<Json>(target, USES_CAMPAIGN_QUERY, 'ads.search.live.audience-uses')
  const adGroup = await liveRows<Json>(target, USES_AD_GROUP_QUERY, 'ads.search.live.audience-uses')
  const signal = await liveRows<Json>(target, USES_SIGNAL_QUERY, 'ads.search.live.audience-uses')
  return usesOf({ campaign, adGroup, signal })
}
