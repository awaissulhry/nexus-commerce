/**
 * Meta ads M1 — Meta's rows → Nexus's (types.ts). Pure. Every field name was checked 2026-10-20 on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/reference: ad-account (fields), ad-campaign-group
 * (the campaign), ad-campaign (the ad set), adgroup (the ad) and ad-account/insights. Money: money.ts.
 */
import { decimalToMicros, metaUnitsToMicros } from './money.js'
import { dayToDate } from './dates.js'
import type { MetaAdAccountData, MetaAdData, MetaAdSetData, MetaAdsEntityType, MetaCampaignData, MetaDailyMetricData } from './types.js'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'

/** The fields the daily read asks for (one place, so the read and its tests agree). */
export const ACCOUNT_CORE_FIELDS = 'account_id,name,currency,timezone_name,timezone_offset_hours_utc,account_status,disable_reason,business{id,name}'
export const ACCOUNT_MONEY_FIELDS = 'amount_spent,spend_cap,balance,min_daily_budget,min_campaign_group_spend_cap,is_prepay_account,funding_source_details'
export const ACCOUNT_SETTINGS_FIELDS = 'capabilities,created_time,age,tos_accepted,offsite_pixels_tos_accepted,failed_delivery_checks,brand_safety_content_filter_levels,opportunity_score,is_notifications_enabled'
export const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,spend_cap,start_time,stop_time,created_time,updated_time'
export const ADSET_FIELDS = 'id,campaign_id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,budget_remaining,destination_type,start_time,end_time,targeting'
export const AD_FIELDS = 'id,campaign_id,adset_id,name,status,effective_status,creative{id,name,title,body,object_type,thumbnail_url},issues_info,created_time,updated_time'
/** Every status but DELETED (Meta leaves deleted and archived objects out unless asked; archived ones are kept). */
export const CAMPAIGN_STATUSES_READ = ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'ARCHIVED']
export const ADSET_STATUSES_READ = [...CAMPAIGN_STATUSES_READ, 'CAMPAIGN_PAUSED']
export const AD_STATUSES_READ = [...ADSET_STATUSES_READ, 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO']

const INSIGHT_BASE_FIELDS = ['impressions', 'reach', 'clicks', 'inline_link_clicks', 'spend', 'frequency', 'actions', 'action_values']
export function insightFields(level: MetaAdsEntityType): string {
  const ids = level === 'CAMPAIGN' ? ['campaign_id', 'campaign_name'] : level === 'ADSET' ? ['campaign_id', 'adset_id', 'adset_name'] : ['campaign_id', 'adset_id', 'ad_id', 'ad_name']
  return [...ids, ...INSIGHT_BASE_FIELDS].join(',')
}

/** Meta's purchase action types, the aggregate first (Ads Manager's "Purchases" is omni_purchase where Meta has it). */
export const PURCHASE_ACTION_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase']

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const int = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.round(n) : null
}
const float = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}
const time = (value: unknown): Date | null => {
  const t = text(value)
  if (!t) return null
  const at = new Date(t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(at.getTime()) ? null : at
}
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)

/** The account's core and money fields (two reads merged); null when Meta sent no usable account. */
export function mapAccount(core: Record<string, unknown>, money: Record<string, unknown> | null, settings: Record<string, unknown>): MetaAdAccountData | null {
  const adAccountId = metaAdAccountId(core.account_id ?? core.id)
  const currency = text(core.currency)
  const timeZone = text(core.timezone_name)
  if (!adAccountId || !currency || !timeZone) return null
  const business = obj(core.business)
  const funding = obj(money?.funding_source_details)
  return {
    adAccountId,
    name: text(core.name),
    currencyCode: currency.toUpperCase(),
    timeZone,
    timezoneOffsetHoursUtc: float(core.timezone_offset_hours_utc),
    accountStatus: int(core.account_status),
    disableReason: int(core.disable_reason),
    businessId: business?.id == null ? null : String(business.id),
    businessName: text(business?.name),
    amountSpentMicros: metaUnitsToMicros(money?.amount_spent, currency),
    spendCapMicros: metaUnitsToMicros(money?.spend_cap, currency),
    balanceMicros: metaUnitsToMicros(money?.balance, currency),
    minDailyBudgetMicros: metaUnitsToMicros(money?.min_daily_budget, currency),
    isPrepayAccount: typeof money?.is_prepay_account === 'boolean' ? money.is_prepay_account : null,
    // The payment method's kind only (TYPE) — never its display string (a card's digits).
    settings: { ...settings, ...(funding ? { fundingSourceType: funding.TYPE ?? funding.type ?? null } : {}), ...(money?.min_campaign_group_spend_cap !== undefined ? { minCampaignSpendCapUnits: money.min_campaign_group_spend_cap } : {}) },
  }
}

export function mapCampaign(row: Record<string, unknown>, ctx: { adAccountId: string; currencyCode: string }): MetaCampaignData | null {
  const campaignId = metaObjectId(row.id)
  if (!campaignId) return null
  return {
    adAccountId: ctx.adAccountId,
    campaignId,
    name: text(row.name) ?? `Campaign ${campaignId}`,
    status: text(row.status) ?? 'UNKNOWN',
    effectiveStatus: text(row.effective_status),
    objective: text(row.objective),
    buyingType: text(row.buying_type),
    bidStrategy: text(row.bid_strategy),
    dailyBudgetMicros: metaUnitsToMicros(row.daily_budget, ctx.currencyCode),
    lifetimeBudgetMicros: metaUnitsToMicros(row.lifetime_budget, ctx.currencyCode),
    budgetRemainingMicros: metaUnitsToMicros(row.budget_remaining, ctx.currencyCode),
    spendCapMicros: metaUnitsToMicros(row.spend_cap, ctx.currencyCode),
    startTime: time(row.start_time),
    stopTime: time(row.stop_time),
    createdTimeMeta: time(row.created_time),
    updatedTimeMeta: time(row.updated_time),
    currencyCode: ctx.currencyCode,
  }
}

export function mapAdSet(row: Record<string, unknown>, ctx: { adAccountId: string; currencyCode: string }): MetaAdSetData | null {
  const adSetId = metaObjectId(row.id)
  const campaignId = metaObjectId(row.campaign_id)
  if (!adSetId || !campaignId) return null
  return {
    adAccountId: ctx.adAccountId,
    campaignId,
    adSetId,
    name: text(row.name) ?? `Ad set ${adSetId}`,
    status: text(row.status) ?? 'UNKNOWN',
    effectiveStatus: text(row.effective_status),
    optimizationGoal: text(row.optimization_goal),
    billingEvent: text(row.billing_event),
    bidStrategy: text(row.bid_strategy),
    bidAmountMicros: metaUnitsToMicros(row.bid_amount, ctx.currencyCode),
    dailyBudgetMicros: metaUnitsToMicros(row.daily_budget, ctx.currencyCode),
    lifetimeBudgetMicros: metaUnitsToMicros(row.lifetime_budget, ctx.currencyCode),
    budgetRemainingMicros: metaUnitsToMicros(row.budget_remaining, ctx.currencyCode),
    destinationType: text(row.destination_type),
    startTime: time(row.start_time),
    endTime: time(row.end_time),
    targeting: obj(row.targeting),
    currencyCode: ctx.currencyCode,
  }
}

export function mapAd(row: Record<string, unknown>, ctx: { adAccountId: string }): MetaAdData | null {
  const adId = metaObjectId(row.id)
  const adSetId = metaObjectId(row.adset_id)
  const campaignId = metaObjectId(row.campaign_id)
  if (!adId || !adSetId || !campaignId) return null
  const creative = obj(row.creative)
  return {
    adAccountId: ctx.adAccountId,
    campaignId,
    adSetId,
    adId,
    name: text(row.name) ?? `Ad ${adId}`,
    status: text(row.status) ?? 'UNKNOWN',
    effectiveStatus: text(row.effective_status),
    creativeId: metaObjectId(creative?.id),
    creative: creative ? { name: text(creative.name), title: text(creative.title), body: text(creative.body), objectType: text(creative.object_type), thumbnailUrl: text(creative.thumbnail_url) } : null,
    issues: Array.isArray(row.issues_info) && row.issues_info.length ? { issuesInfo: row.issues_info } : null,
    createdTimeMeta: time(row.created_time),
    updatedTimeMeta: time(row.updated_time),
  }
}

/** The first purchase action type Meta reported in `actions`, and its count and value. */
export function purchasesOf(actions: unknown, values: unknown): { type: string | null; count: string; valueMicros: bigint } {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object') : [])
  const counts = list(actions)
  const amounts = list(values)
  for (const type of PURCHASE_ACTION_TYPES) {
    const hit = counts.find((a) => a.action_type === type)
    if (!hit) continue
    const n = float(hit.value) ?? 0
    const value = amounts.find((a) => a.action_type === type)
    return { type, count: (Math.round(n * 10_000) / 10_000).toFixed(4), valueMicros: decimalToMicros(value?.value) ?? 0n }
  }
  return { type: null, count: '0.0000', valueMicros: 0n }
}

/** One insights row (one entity, one day) → a daily metric; null when it names no day or entity. */
export function mapInsightDay(row: Record<string, unknown>, ctx: { adAccountId: string; currencyCode: string; level: MetaAdsEntityType }): MetaDailyMetricData | null {
  const day = text(row.date_start)
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || text(row.date_stop) !== day) return null
  const campaignId = metaObjectId(row.campaign_id)
  const adSetId = metaObjectId(row.adset_id)
  const entityId = ctx.level === 'CAMPAIGN' ? campaignId : ctx.level === 'ADSET' ? adSetId : metaObjectId(row.ad_id)
  if (!campaignId || !entityId) return null
  const purchases = purchasesOf(row.actions, row.action_values)
  const frequency = float(row.frequency)
  return {
    adAccountId: ctx.adAccountId,
    date: dayToDate(day),
    entityType: ctx.level,
    entityId,
    campaignId,
    adSetId: ctx.level === 'CAMPAIGN' ? null : adSetId,
    label: text(ctx.level === 'CAMPAIGN' ? row.campaign_name : ctx.level === 'ADSET' ? row.adset_name : row.ad_name),
    impressions: int(row.impressions) ?? 0,
    reach: int(row.reach),
    clicks: int(row.clicks) ?? 0,
    linkClicks: int(row.inline_link_clicks),
    spendMicros: decimalToMicros(row.spend) ?? 0n,
    purchases: purchases.count,
    purchaseValueMicros: purchases.valueMicros,
    currencyCode: ctx.currencyCode,
    extra: { purchaseActionType: purchases.type, ...(frequency !== null ? { frequency } : {}) },
  }
}
