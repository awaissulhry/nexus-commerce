/**
 * Google Ads changes, programme 2 G2 (2026-10-15) — the live reads targeting stands on, beyond live.ts: a campaign's
 * criteria with devices, radius (proximity), demographics and every kind of audience segment; its ad groups with their
 * targeting setting; their audience and demographic criteria; their device bid adjustments. One GAQL query each, on the
 * account's change allowance (write-client.ts `liveRows`).
 *
 * Checked 2026-10-15 with curl in the v25 field reference (developers.google.com/google-ads/api/fields/v25/<resource>):
 * - campaign_criterion: criterion_id, type, status, negative, bid_modifier, display_name, device.type,
 *   proximity.geo_point.{latitude,longitude}_in_micro_degrees, proximity.radius, proximity.radius_units,
 *   proximity.address.{street_address, city_name, postal_code, country_code}, age_range.type, gender.type,
 *   parental_status.type, income_range.type, user_list.user_list, user_interest.user_interest_category,
 *   custom_audience.custom_audience, combined_audience.combined_audience, life_event.life_event_id — all selectable and
 *   filterable; campaign is an attributed resource. (location, language, ad_schedule and keyword: live.ts, checked there.)
 * - ad_group_criterion: the same audience and demographic fields, criterion_id, type, status, negative, bid_modifier,
 *   display_name; ad_group and campaign are attributed resources.
 * - ad_group_bid_modifier: criterion_id, bid_modifier, device.type; ad_group and campaign are attributed resources.
 * - ad_group: id, name, status, targeting_setting.target_restrictions (selectable, NOT filterable).
 * - The segments' own names (the preview names each new one; an id Google does not know is refused): user_list.{id, name,
 *   membership_status}, custom_audience.{id, name, status}, combined_audience.{id, name, status}, user_interest.{
 *   user_interest_id, name}, life_event.{id, name} — selectable and filterable. Enums (rpc/v25): CustomAudienceStatus and
 *   CombinedAudienceStatus ENABLED / REMOVED, UserListMembershipStatus OPEN / CLOSED.
 * Every field of another resource named in a WHERE is in the SELECT too (Google refused a WHERE on campaign.status
 * without it, #639). Enum values (rpc/v25): CriterionType, Device, AgeRangeType, GenderType, ParentalStatusType,
 * IncomeRangeType, ProximityRadiusUnits, TargetingDimension.
 */
import { liveRows } from './write-client.js'
import { gaqlId, idOf, liveCriterionOf, type LiveCriterion, INCLUDE_DRAFTS, noteCampaignRow } from './live.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
/**
 * A bid adjustment as Google sends it, rounded to 4 decimals: campaign_criterion.bid_modifier is a FLOAT (32 bit) in
 * v25, so ×1.2 can come back as 1.2000000476837158 — rounded, it compares equal to what was asked.
 */
export const factorOf = (value: unknown): number | null => {
  const n = num(value)
  return n === null ? null : Math.round(n * 10_000) / 10_000
}

// ── what Google names ──────────────────────────────────────────────────────────────────────────────────────────

/** Devices a campaign or ad group can adjust bids for (DeviceEnum.Device, v25; OTHER cannot be targeted). */
export const DEVICES = ['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV'] as const
export type Device = typeof DEVICES[number]

/**
 * Audience segments of a Search or Standard Shopping campaign (criteria guide, v25): user lists (your data: website
 * visitors, customer lists), user interests (affinity, in-market), custom audiences, combined audiences, life events.
 * Google's AUDIENCE targeting dimension covers them.
 */
export const AUDIENCE_KINDS = ['USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT'] as const
export type AudienceKind = typeof AUDIENCE_KINDS[number]

/** Demographic dimensions and their values (AgeRangeType, GenderType, ParentalStatusType, IncomeRangeType, v25). */
export const DEMOGRAPHIC_VALUES = {
  AGE_RANGE: ['AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54', 'AGE_RANGE_55_64', 'AGE_RANGE_65_UP', 'AGE_RANGE_UNDETERMINED'],
  GENDER: ['FEMALE', 'MALE', 'UNDETERMINED'],
  PARENTAL_STATUS: ['PARENT', 'NOT_A_PARENT', 'UNDETERMINED'],
  INCOME_RANGE: ['INCOME_RANGE_0_50', 'INCOME_RANGE_50_60', 'INCOME_RANGE_60_70', 'INCOME_RANGE_70_80', 'INCOME_RANGE_80_90', 'INCOME_RANGE_90_UP', 'INCOME_RANGE_UNDETERMINED'],
} as const
export type DemographicDimension = keyof typeof DEMOGRAPHIC_VALUES
export const DEMOGRAPHIC_DIMENSIONS = Object.keys(DEMOGRAPHIC_VALUES) as DemographicDimension[]

/** The JSON key of each kind inside a criterion (REST, camelCase) and the resource collection its id lives in. */
export const AUDIENCE_FIELD: Record<AudienceKind, { key: string; inner: string; collection: string | null }> = {
  USER_LIST: { key: 'userList', inner: 'userList', collection: 'userLists' },
  USER_INTEREST: { key: 'userInterest', inner: 'userInterestCategory', collection: 'userInterests' },
  CUSTOM_AUDIENCE: { key: 'customAudience', inner: 'customAudience', collection: 'customAudiences' },
  COMBINED_AUDIENCE: { key: 'combinedAudience', inner: 'combinedAudience', collection: 'combinedAudiences' },
  // LifeEventInfo holds the life event's id itself (life_event_id, int64), not a resource name.
  LIFE_EVENT: { key: 'lifeEvent', inner: 'lifeEventId', collection: null },
}
export const DEMOGRAPHIC_FIELD: Record<DemographicDimension, string> = { AGE_RANGE: 'ageRange', GENDER: 'gender', PARENTAL_STATUS: 'parentalStatus', INCOME_RANGE: 'incomeRange' }

/** The criterion body of an audience segment, as Google's JSON takes it. */
export function audienceCriterion(customer: string, kind: AudienceKind, id: string): Record<string, unknown> {
  const f = AUDIENCE_FIELD[kind]
  return { [f.key]: { [f.inner]: f.collection ? `${customer}/${f.collection}/${id}` : id } }
}

// ── one criterion's parts ──────────────────────────────────────────────────────────────────────────────────────

export interface CriterionParts {
  device?: string | null
  proximity?: { latitudeMicro: number | null; longitudeMicro: number | null; radius: number | null; units: string | null; address: string | null }
  demographic?: { dimension: DemographicDimension; value: string | null }
  /** An audience segment: its kind and Google's id (the end of its resource name, or the life event's id). */
  segment?: { kind: AudienceKind; id: string }
}

/** The device, radius, demographic or audience part of a campaign or ad group criterion (Google's JSON). */
export function criterionParts(c: Json): CriterionParts {
  const out: CriterionParts = {}
  if (c.device) out.device = str(c.device.type)
  if (c.proximity) {
    const a = c.proximity.address ?? {}
    const address = [str(a.streetAddress), str(a.postalCode), str(a.cityName), str(a.countryCode)].filter(Boolean).join(', ')
    out.proximity = {
      latitudeMicro: num(c.proximity.geoPoint?.latitudeInMicroDegrees),
      longitudeMicro: num(c.proximity.geoPoint?.longitudeInMicroDegrees),
      radius: num(c.proximity.radius),
      // Google leaves a field at its default out of the answer: KILOMETERS (ProximityInfo.radius_units).
      units: str(c.proximity.radiusUnits) ?? 'KILOMETERS',
      address: address || null,
    }
  }
  for (const dimension of DEMOGRAPHIC_DIMENSIONS) {
    const part = c[DEMOGRAPHIC_FIELD[dimension]]
    if (part) out.demographic = { dimension, value: str(part.type) }
  }
  for (const kind of AUDIENCE_KINDS) {
    const f = AUDIENCE_FIELD[kind]
    const part = c[f.key]
    if (!part) continue
    const id = f.collection ? idOf(part[f.inner]) : str(part[f.inner])
    if (id) out.segment = { kind, id }
  }
  return out
}

// ── a campaign's criteria ──────────────────────────────────────────────────────────────────────────────────────

export type TargetingCriterion = LiveCriterion & CriterionParts

const AUDIENCE_PARTS = (p: string) => [
  `${p}.user_list.user_list`, `${p}.user_interest.user_interest_category`, `${p}.custom_audience.custom_audience`,
  `${p}.combined_audience.combined_audience`, `${p}.life_event.life_event_id`,
  `${p}.age_range.type`, `${p}.gender.type`, `${p}.parental_status.type`, `${p}.income_range.type`,
]
const inTypes = (types: readonly string[]) => types.map((t) => `'${t}'`).join(', ')

export const CAMPAIGN_TARGETING_TYPES = [
  'LOCATION', 'PROXIMITY', 'LANGUAGE', 'AD_SCHEDULE', 'DEVICE', ...AUDIENCE_KINDS, ...DEMOGRAPHIC_DIMENSIONS,
] as const

/** A campaign's targeting criteria that are not removed (no keywords: negatives are set-google-negatives). */
export const liveTargetingCriteriaQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.name, campaign.experiment_type, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, ' +
  'campaign_criterion.status, campaign_criterion.bid_modifier, campaign_criterion.display_name, ' +
  'campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, ' +
  'campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, ' +
  'campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, ' +
  'campaign_criterion.ad_schedule.end_minute, campaign_criterion.device.type, ' +
  'campaign_criterion.proximity.geo_point.latitude_in_micro_degrees, campaign_criterion.proximity.geo_point.longitude_in_micro_degrees, ' +
  'campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, ' +
  'campaign_criterion.proximity.address.street_address, campaign_criterion.proximity.address.city_name, ' +
  'campaign_criterion.proximity.address.postal_code, campaign_criterion.proximity.address.country_code, ' +
  `${AUDIENCE_PARTS('campaign_criterion').join(', ')} FROM campaign_criterion ` +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_criterion.status != 'REMOVED' ` +
  `AND campaign_criterion.type IN (${inTypes(CAMPAIGN_TARGETING_TYPES)})${INCLUDE_DRAFTS}`

export function targetingCriterionOf(row: Json): TargetingCriterion {
  const base = liveCriterionOf(row)
  return { ...base, bidModifier: factorOf(base.bidModifier), ...criterionParts(row.campaignCriterion ?? {}) }
}

export async function liveTargetingCriteria(target: GoogleAdsTarget, campaignId: string): Promise<TargetingCriterion[]> {
  return (await liveRows<Json>(target, liveTargetingCriteriaQuery(campaignId), 'ads.search.live.targeting')).map((r) => (noteCampaignRow(r), targetingCriterionOf(r)))
}

// ── a campaign's ad groups, their criteria and device adjustments ──────────────────────────────────────────────

export interface AudienceRestriction { dimension: string | null; observationOnly: boolean }

export interface TargetingAdGroup {
  adGroupId: string
  name: string
  status: string | null
  /** Its own targeting setting (empty when it has none: the campaign's, or Google's default, applies). */
  audienceMode: AudienceRestriction[]
}

export const liveTargetingAdGroupsQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.name, campaign.experiment_type, ad_group.id, ad_group.name, ad_group.status, ad_group.targeting_setting.target_restrictions ' +
  `FROM ad_group WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group.status != 'REMOVED'${INCLUDE_DRAFTS}`

export const restrictionsOf = (setting: Json | undefined): AudienceRestriction[] =>
  (Array.isArray(setting?.targetRestrictions) ? setting!.targetRestrictions : [])
    .map((t: Json) => ({ dimension: str(t.targetingDimension), observationOnly: t.bidOnly === true }))

export async function liveTargetingAdGroups(target: GoogleAdsTarget, campaignId: string): Promise<TargetingAdGroup[]> {
  return (await liveRows<Json>(target, liveTargetingAdGroupsQuery(campaignId), 'ads.search.live.targeting-ad-groups')).map((r) => ({
    ...(noteCampaignRow(r), {}),
    adGroupId: str(r.adGroup?.id) ?? '', name: str(r.adGroup?.name) ?? '', status: str(r.adGroup?.status), audienceMode: restrictionsOf(r.adGroup?.targetingSetting),
  }))
}

export interface AdGroupTargetingCriterion extends CriterionParts {
  adGroupId: string
  criterionId: string
  type: string | null
  negative: boolean
  name: string | null
  bidModifier: number | null
}

export const AD_GROUP_TARGETING_TYPES = [...AUDIENCE_KINDS, ...DEMOGRAPHIC_DIMENSIONS] as const

/** The audience and demographic criteria of a campaign's ad groups (not removed). */
export const liveAdGroupTargetingQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.name, campaign.experiment_type, ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.type, ' +
  'ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.bid_modifier, ad_group_criterion.display_name, ' +
  `${AUDIENCE_PARTS('ad_group_criterion').join(', ')} FROM ad_group_criterion ` +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group.status != 'REMOVED' ` +
  `AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.type IN (${inTypes(AD_GROUP_TARGETING_TYPES)})${INCLUDE_DRAFTS}`

export function adGroupTargetingCriterionOf(row: Json): AdGroupTargetingCriterion {
  const c = row.adGroupCriterion ?? {}
  return {
    adGroupId: str(row.adGroup?.id) ?? '',
    criterionId: str(c.criterionId) ?? '',
    type: str(c.type),
    negative: c.negative === true,
    name: str(c.displayName),
    bidModifier: factorOf(c.bidModifier),
    ...criterionParts(c),
  }
}

export async function liveAdGroupTargeting(target: GoogleAdsTarget, campaignId: string): Promise<AdGroupTargetingCriterion[]> {
  return (await liveRows<Json>(target, liveAdGroupTargetingQuery(campaignId), 'ads.search.live.targeting-ad-group-criteria')).map((r) => (noteCampaignRow(r), adGroupTargetingCriterionOf(r)))
}

export interface AdGroupDeviceModifier { adGroupId: string; criterionId: string; device: string | null; bidModifier: number | null }

/** The device bid adjustments of a campaign's ad groups (AdGroupBidModifier; other kinds are hotel-only). */
export const liveAdGroupDevicesQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.name, campaign.experiment_type, ad_group.id, ad_group.status, ad_group_bid_modifier.criterion_id, ad_group_bid_modifier.bid_modifier, ' +
  `ad_group_bid_modifier.device.type FROM ad_group_bid_modifier WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  `AND ad_group.status != 'REMOVED'${INCLUDE_DRAFTS}`

export async function liveAdGroupDevices(target: GoogleAdsTarget, campaignId: string): Promise<AdGroupDeviceModifier[]> {
  return (await liveRows<Json>(target, liveAdGroupDevicesQuery(campaignId), 'ads.search.live.targeting-ad-group-devices'))
    .map((r) => (noteCampaignRow(r), {
      adGroupId: str(r.adGroup?.id) ?? '',
      criterionId: str(r.adGroupBidModifier?.criterionId) ?? '',
      device: str(r.adGroupBidModifier?.device?.type),
      bidModifier: factorOf(r.adGroupBidModifier?.bidModifier),
    }))
    .filter((m) => m.device)
}

/** Everything the audience and demographic changes stand on: the ad groups, their criteria (two queries). */
export async function liveAdGroupTargetingState(target: GoogleAdsTarget, campaignId: string): Promise<{ adGroups: TargetingAdGroup[]; adGroupCriteria: AdGroupTargetingCriterion[] }> {
  const adGroups = await liveTargetingAdGroups(target, campaignId)
  const adGroupCriteria = adGroups.length ? await liveAdGroupTargeting(target, campaignId) : []
  return { adGroups, adGroupCriteria }
}

// ── words ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A bid adjustment as a person reads it: ×1.2 → "+20 %", ×0 → "−100 % (excluded)", none → "none". */
export function adjustmentWords(factor: number | null | undefined): string {
  if (factor === null || factor === undefined || factor === 1) return 'none'
  if (factor === 0) return '−100 % (excluded)'
  const pct = Math.round((factor - 1) * 1000) / 10
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`
}

/** Bidding strategies that do not use manual bid adjustments (Google Ads Help 2732132, "Automated bidding"). */
export const SMART_BIDDING = new Set(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'])

/**
 * What Google does with a campaign's bid adjustments under Smart Bidding (Google Ads Help 2732132): location, schedule,
 * audience and demographic adjustments are not used; a device adjustment is used as −100 % (opt out) only — except with
 * a CPA target (Target CPA, or Maximize conversions with a target CPA), where it changes the CPA target for that device.
 * Null when the campaign does not use Smart Bidding.
 */
export function smartBiddingWords(campaign: { name: string; bidding: string | null; targetCpaCents?: number | null }, kind: 'device' | 'other'): string | null {
  if (!campaign.bidding || !SMART_BIDDING.has(campaign.bidding)) return null
  const cpaTarget = campaign.bidding === 'TARGET_CPA' || (campaign.bidding === 'MAXIMIZE_CONVERSIONS' && (campaign.targetCpaCents ?? null) !== null)
  if (kind === 'device') {
    return cpaTarget
      ? `"${campaign.name}" bids with ${campaign.bidding} and a CPA target: Google applies a device bid adjustment to the CPA target for that device, not to the bids (−100 % still opts out).`
      : `"${campaign.name}" bids with ${campaign.bidding}: Google's Smart Bidding uses a device bid adjustment only as −100 % (opt out); other device adjustments are not used.`
  }
  return `"${campaign.name}" bids with ${campaign.bidding}: Google's Smart Bidding does not use these bid adjustments (exclusions and targeting still apply).`
}

// ── the segments' own names ────────────────────────────────────────────────────────────────────────────────────

export interface SegmentName { name: string | null; status: string | null }

const SEGMENT_QUERY: Record<AudienceKind, (ids: string) => string> = {
  USER_LIST: (ids) => `SELECT user_list.id, user_list.name, user_list.membership_status FROM user_list WHERE user_list.id IN (${ids})`,
  USER_INTEREST: (ids) => `SELECT user_interest.user_interest_id, user_interest.name FROM user_interest WHERE user_interest.user_interest_id IN (${ids})`,
  CUSTOM_AUDIENCE: (ids) => `SELECT custom_audience.id, custom_audience.name, custom_audience.status FROM custom_audience WHERE custom_audience.id IN (${ids})`,
  COMBINED_AUDIENCE: (ids) => `SELECT combined_audience.id, combined_audience.name, combined_audience.status FROM combined_audience WHERE combined_audience.id IN (${ids})`,
  LIFE_EVENT: (ids) => `SELECT life_event.id, life_event.name FROM life_event WHERE life_event.id IN (${ids})`,
}

export const liveSegmentNamesQuery = (kind: AudienceKind, ids: string[]): string =>
  SEGMENT_QUERY[kind]([...new Set(ids)].map((id) => gaqlId(id, 'The segment')).join(', '))

/** The names of audience segments by `KIND|id` (one query per kind asked); a segment Google does not return is missing. */
export async function liveSegmentNames(target: GoogleAdsTarget, refs: Array<{ kind: AudienceKind; id: string }>): Promise<Record<string, SegmentName>> {
  const out: Record<string, SegmentName> = {}
  for (const kind of AUDIENCE_KINDS) {
    const ids = refs.filter((r) => r.kind === kind).map((r) => r.id)
    if (!ids.length) continue
    for (const r of await liveRows<Json>(target, liveSegmentNamesQuery(kind, ids), 'ads.search.live.segment-names')) {
      const row = kind === 'USER_LIST' ? r.userList : kind === 'USER_INTEREST' ? r.userInterest : kind === 'CUSTOM_AUDIENCE' ? r.customAudience : kind === 'COMBINED_AUDIENCE' ? r.combinedAudience : r.lifeEvent
      const id = str(kind === 'USER_INTEREST' ? row?.userInterestId : row?.id)
      if (id) out[`${kind}|${id}`] = { name: str(row?.name), status: str(row?.membershipStatus ?? row?.status) }
    }
  }
  return out
}
