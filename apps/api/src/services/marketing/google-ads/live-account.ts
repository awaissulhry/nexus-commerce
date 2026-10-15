/**
 * Google Ads programme 2, G1 (2026-10-15) — the account-wide live reads google-ads-live shows: account settings,
 * conversion actions and goals, labels (and where one is used), experiments, user access, billing, product and data
 * links, and Google's ids of the account's user lists, custom audiences and combined audiences (the targeting tools take
 * them). Read only: GAQL through the gateway (write-client.ts `liveRows`, one operation per query). A view of several
 * queries answers what Google gave and names a part it refused in `notRead` (never a default).
 *
 * Checked on 2026-10-15 against Google's v25 field reference (https://developers.google.com/google-ads/api/fields/v25/
 * <resource>, fetched with curl and parsed): every FROM resource exists; every selected field is Selectable on it (or
 * on one of its attributed resources); every WHERE field is Filterable, and every field of another resource filtered on
 * is selected too (Google refused a filter on an unselected campaign.status on 2026-10-15). Enum values used in a WHERE
 * are from the same pages: conversion_action.status ENABLED | HIDDEN | REMOVED; label.status ENABLED | REMOVED;
 * experiment.status … REMOVED …; custom_audience.status and combined_audience.status ENABLED | REMOVED;
 * user_list.account_user_list_status ENABLED | DISABLED.
 *
 * Access: Google's Explorer access level blocks the user-management and billing SERVICES (CustomerUserAccessService,
 * CustomerUserAccessInvitationService, BillingSetupService, AccountBudgetProposalService, PaymentsAccountService,
 * InvoiceService — developers.google.com/google-ads/api/docs/api-policy/access-levels); reading customer_user_access,
 * billing_setup and account_budget goes through GoogleAdsService.Search, which that page does not restrict. If Google
 * refuses one anyway, the view says so (notRead).
 *
 * Not in the Google Ads API at all (v25): a Google Analytics 4 link (product_link.type has ADVERTISING_PARTNER,
 * DATA_PARTNER, GOOGLE_ADS, HOTEL_CENTER, MERCHANT_CENTER — no Analytics; GA4 links live in the Analytics Admin API),
 * so the links view shows the GA4 properties the account's GA4 conversion actions come from
 * (conversion_action.google_analytics_4_settings); a payment card (no resource reads or adds one).
 */
import { liveRows } from './write-client.js'
import { gaqlId } from './live.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const bool = (value: unknown): boolean => value === true
const opt = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const centsOfMicros = (value: unknown): number | null => {
  const n = opt(value)
  return n === null ? null : Math.round(n / 10_000)
}
const tail = (resourceName: unknown): string | null => {
  const s = str(resourceName)
  return s ? s.slice(s.lastIndexOf('/') + 1) : null
}
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

export interface NotRead { part: string; why: string }

/** Runs one part of a view; a part Google refuses is named in `notRead`, the others still answer. */
async function part<T>(target: GoogleAdsTarget, notRead: NotRead[], name: string, query: string, map: (row: Json) => T): Promise<T[]> {
  try {
    return (await liveRows<Json>(target, query, `ads.search.live.${name}`)).map(map)
  } catch (err) {
    notRead.push({ part: name, why: err instanceof Error ? err.message : String(err) })
    return []
  }
}

// ── account settings ─────────────────────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_SETTINGS_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, ' +
  'customer.test_account, customer.auto_tagging_enabled, customer.tracking_url_template, customer.final_url_suffix, ' +
  'customer.optimization_score, customer.contains_eu_political_advertising, customer.pay_per_conversion_eligibility_failure_reasons, ' +
  'customer.conversion_tracking_setting.conversion_tracking_id, customer.conversion_tracking_setting.conversion_tracking_status, ' +
  'customer.conversion_tracking_setting.cross_account_conversion_tracking_id, ' +
  'customer.conversion_tracking_setting.google_ads_conversion_customer, ' +
  'customer.conversion_tracking_setting.accepted_customer_data_terms, ' +
  'customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled FROM customer'

export interface LiveAccountSettings {
  customerId: string | null
  name: string | null
  currency: string | null
  timeZone: string | null
  status: string | null
  manager: boolean
  testAccount: boolean
  autoTagging: boolean
  trackingTemplate: string | null
  finalUrlSuffix: string | null
  /** Google's optimization score, in percent. */
  optimizationScorePct: number | null
  euPoliticalAds: string | null
  conversionTracking: {
    id: string | null
    status: string | null
    crossAccountId: string | null
    /** The account that owns the conversion actions (a manager when cross-account tracking is on). */
    conversionCustomerId: string | null
    acceptedCustomerDataTerms: boolean
    enhancedConversionsForLeads: boolean
  }
}

export function accountSettingsOf(row: Json): LiveAccountSettings {
  const c = row.customer ?? {}
  const t = c.conversionTrackingSetting ?? {}
  const score = opt(c.optimizationScore)
  return {
    customerId: str(c.id),
    name: str(c.descriptiveName),
    currency: str(c.currencyCode),
    timeZone: str(c.timeZone),
    status: str(c.status),
    manager: bool(c.manager),
    testAccount: bool(c.testAccount),
    autoTagging: bool(c.autoTaggingEnabled),
    trackingTemplate: str(c.trackingUrlTemplate),
    finalUrlSuffix: str(c.finalUrlSuffix),
    optimizationScorePct: score === null ? null : Math.round(score * 1000) / 10,
    euPoliticalAds: str(c.containsEuPoliticalAdvertising),
    conversionTracking: {
      id: str(t.conversionTrackingId),
      status: str(t.conversionTrackingStatus),
      crossAccountId: str(t.crossAccountConversionTrackingId),
      conversionCustomerId: tail(t.googleAdsConversionCustomer),
      acceptedCustomerDataTerms: bool(t.acceptedCustomerDataTerms),
      enhancedConversionsForLeads: bool(t.enhancedConversionsForLeadsEnabled),
    },
  }
}

export async function liveAccountSettings(target: GoogleAdsTarget): Promise<LiveAccountSettings | null> {
  const rows = await liveRows<Json>(target, ACCOUNT_SETTINGS_QUERY, 'ads.search.live.account')
  return rows[0] ? accountSettingsOf(rows[0]) : null
}

// ── conversion actions and goals ─────────────────────────────────────────────────────────────────────────────────

export const CONVERSION_ACTIONS_QUERY =
  'SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, ' +
  'conversion_action.origin, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, ' +
  'conversion_action.counting_type, conversion_action.click_through_lookback_window_days, ' +
  'conversion_action.view_through_lookback_window_days, conversion_action.value_settings.default_value, ' +
  'conversion_action.value_settings.default_currency_code, conversion_action.value_settings.always_use_default_value, ' +
  'conversion_action.attribution_model_settings.attribution_model, conversion_action.attribution_model_settings.data_driven_model_status, ' +
  'conversion_action.owner_customer, conversion_action.google_analytics_4_settings.property_id, ' +
  'conversion_action.google_analytics_4_settings.property_name, conversion_action.google_analytics_4_settings.event_name ' +
  "FROM conversion_action WHERE conversion_action.status != 'REMOVED'"

export const CUSTOMER_GOALS_QUERY =
  'SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal'

export const CAMPAIGN_GOALS_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign_conversion_goal.category, campaign_conversion_goal.origin, ' +
  "campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.status != 'REMOVED'"

export const CAMPAIGN_GOAL_CONFIG_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, conversion_goal_campaign_config.goal_config_level, ' +
  "conversion_goal_campaign_config.custom_conversion_goal FROM conversion_goal_campaign_config WHERE campaign.status != 'REMOVED'"

export interface LiveConversionAction {
  conversionActionId: string | null
  name: string | null
  status: string | null
  type: string | null
  category: string | null
  origin: string | null
  /** Primary: counts in "Conversions" and bidding; secondary: observation only. */
  primary: boolean
  includeInConversions: boolean
  counting: string | null
  clickWindowDays: number | null
  viewWindowDays: number | null
  /** The value a conversion gets when the tag sends none, in cents of `defaultValueCurrency`. */
  defaultValueCents: number | null
  defaultValueCurrency: string | null
  alwaysUseDefaultValue: boolean
  attribution: string | null
  dataDrivenStatus: string | null
  ownerCustomerId: string | null
  ga4: { propertyId: string | null; propertyName: string | null; eventName: string | null } | null
}

export function conversionActionOf(row: Json): LiveConversionAction {
  const a = row.conversionAction ?? {}
  const v = a.valueSettings ?? {}
  const ga4 = a.googleAnalytics4Settings
  const value = opt(v.defaultValue)
  return {
    conversionActionId: str(a.id),
    name: str(a.name),
    status: str(a.status),
    type: str(a.type),
    category: str(a.category),
    origin: str(a.origin),
    primary: bool(a.primaryForGoal),
    includeInConversions: bool(a.includeInConversionsMetric),
    counting: str(a.countingType),
    clickWindowDays: opt(a.clickThroughLookbackWindowDays),
    viewWindowDays: opt(a.viewThroughLookbackWindowDays),
    defaultValueCents: value === null ? null : Math.round(value * 100),
    defaultValueCurrency: str(v.defaultCurrencyCode),
    alwaysUseDefaultValue: bool(v.alwaysUseDefaultValue),
    attribution: str(a.attributionModelSettings?.attributionModel),
    dataDrivenStatus: str(a.attributionModelSettings?.dataDrivenModelStatus),
    ownerCustomerId: tail(a.ownerCustomer),
    ga4: ga4 && (ga4.propertyId || ga4.propertyName) ? { propertyId: str(ga4.propertyId), propertyName: str(ga4.propertyName), eventName: str(ga4.eventName) } : null,
  }
}

const goalKey = (g: Json) => `${str(g.category) ?? '?'}/${str(g.origin) ?? '?'}`

export interface LiveConversions {
  actions: LiveConversionAction[]
  /** The account's goals: a category from an origin (PURCHASE/WEBSITE); biddable = campaigns that use account goals bid for it. */
  accountGoals: Array<{ goal: string; category: string | null; origin: string | null; biddable: boolean }>
  /** Each campaign's own goal setting: whether it follows the account's goals and which goals it bids for. */
  campaigns: Array<{ campaignId: string | null; name: string | null; status: string | null; goalsFrom: string | null; customGoalId: string | null; biddableGoals: string[]; differsFromAccount: boolean }>
  notRead: NotRead[]
}

/** Conversion actions, the account's goals and each campaign's goals (four queries). */
export async function liveConversions(target: GoogleAdsTarget): Promise<LiveConversions> {
  const notRead: NotRead[] = []
  const actions = await part(target, notRead, 'conversion-actions', CONVERSION_ACTIONS_QUERY, conversionActionOf)
  const accountGoals = await part(target, notRead, 'account-goals', CUSTOMER_GOALS_QUERY, (r) => {
    const g = r.customerConversionGoal ?? {}
    return { goal: goalKey(g), category: str(g.category), origin: str(g.origin), biddable: bool(g.biddable) }
  })
  const campaignGoals = await part(target, notRead, 'campaign-goals', CAMPAIGN_GOALS_QUERY, (r) => ({
    campaignId: str(r.campaign?.id), name: str(r.campaign?.name), status: str(r.campaign?.status),
    goal: goalKey(r.campaignConversionGoal ?? {}), biddable: bool(r.campaignConversionGoal?.biddable),
  }))
  const configs = await part(target, notRead, 'campaign-goal-settings', CAMPAIGN_GOAL_CONFIG_QUERY, (r) => ({
    campaignId: str(r.campaign?.id), name: str(r.campaign?.name), status: str(r.campaign?.status),
    goalsFrom: str(r.conversionGoalCampaignConfig?.goalConfigLevel), customGoalId: tail(r.conversionGoalCampaignConfig?.customConversionGoal),
  }))
  const accountBiddable = accountGoals.filter((g) => g.biddable).map((g) => g.goal).sort()
  const ids = [...new Set([...configs.map((c) => c.campaignId), ...campaignGoals.map((g) => g.campaignId)])]
  const campaigns = ids.map((id) => {
    const config = configs.find((c) => c.campaignId === id)
    const goals = campaignGoals.filter((g) => g.campaignId === id)
    const biddableGoals = goals.filter((g) => g.biddable).map((g) => g.goal).sort()
    const first = config ?? goals[0]
    return {
      campaignId: id,
      name: first?.name ?? null,
      status: first?.status ?? null,
      goalsFrom: config?.goalsFrom ?? null,
      customGoalId: config?.customGoalId ?? null,
      biddableGoals,
      differsFromAccount: config?.goalsFrom === 'CAMPAIGN' || biddableGoals.join(',') !== accountBiddable.join(','),
    }
  })
  return { actions, accountGoals, campaigns, notRead }
}

// ── labels ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const LABELS_QUERY =
  'SELECT label.id, label.name, label.status, label.text_label.background_color, label.text_label.description FROM label ' +
  "WHERE label.status = 'ENABLED'"

/** Where one label is used: campaigns, ad groups, ads, keywords (one query each). */
export function labelUsesQueries(labelId: string): Record<'campaigns' | 'adGroups' | 'ads' | 'keywords', string> {
  const id = gaqlId(labelId, 'The label')
  return {
    campaigns: 'SELECT label.id, campaign.id, campaign.name, campaign.status FROM campaign_label ' +
      `WHERE label.id = ${id} AND campaign.status != 'REMOVED'`,
    adGroups: 'SELECT label.id, campaign.id, ad_group.id, ad_group.name, ad_group.status FROM ad_group_label ' +
      `WHERE label.id = ${id} AND ad_group.status != 'REMOVED'`,
    ads: 'SELECT label.id, campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status FROM ad_group_ad_label ' +
      `WHERE label.id = ${id} AND ad_group_ad.status != 'REMOVED'`,
    keywords: 'SELECT label.id, campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ' +
      'ad_group_criterion.keyword.match_type, ad_group_criterion.status FROM ad_group_criterion_label ' +
      `WHERE label.id = ${id} AND ad_group_criterion.status != 'REMOVED'`,
  }
}

export interface LiveLabel { labelId: string | null; name: string | null; status: string | null; color: string | null; description: string | null }

export const labelOf = (row: Json): LiveLabel => {
  const l = row.label ?? {}
  return { labelId: str(l.id), name: str(l.name), status: str(l.status), color: str(l.textLabel?.backgroundColor), description: str(l.textLabel?.description) }
}

export interface LiveLabels {
  labels: LiveLabel[]
  /** Only when one label was asked for. */
  usedOn?: {
    campaigns: Array<{ campaignId: string | null; name: string | null; status: string | null }>
    adGroups: Array<{ campaignId: string | null; adGroupId: string | null; name: string | null; status: string | null }>
    ads: Array<{ campaignId: string | null; adId: string | null; type: string | null; status: string | null }>
    keywords: Array<{ campaignId: string | null; keywordId: string | null; text: string | null; matchType: string | null; status: string | null }>
  }
  notRead: NotRead[]
}

export async function liveLabels(target: GoogleAdsTarget, labelId?: string | null): Promise<LiveLabels> {
  const notRead: NotRead[] = []
  const labels = await part(target, notRead, 'labels', LABELS_QUERY, labelOf)
  if (!labelId) return { labels, notRead }
  const q = labelUsesQueries(labelId)
  const pair = (r: Json, child: unknown) => (str(r.adGroup?.id) && str(child) ? `${str(r.adGroup?.id)}~${str(child)}` : str(child))
  const usedOn = {
    campaigns: await part(target, notRead, 'label-campaigns', q.campaigns, (r) => ({ campaignId: str(r.campaign?.id), name: str(r.campaign?.name), status: str(r.campaign?.status) })),
    adGroups: await part(target, notRead, 'label-ad-groups', q.adGroups, (r) => ({ campaignId: str(r.campaign?.id), adGroupId: str(r.adGroup?.id), name: str(r.adGroup?.name), status: str(r.adGroup?.status) })),
    ads: await part(target, notRead, 'label-ads', q.ads, (r) => ({ campaignId: str(r.campaign?.id), adId: pair(r, r.adGroupAd?.ad?.id), type: str(r.adGroupAd?.ad?.type), status: str(r.adGroupAd?.status) })),
    keywords: await part(target, notRead, 'label-keywords', q.keywords, (r) => ({
      campaignId: str(r.campaign?.id), keywordId: pair(r, r.adGroupCriterion?.criterionId), text: str(r.adGroupCriterion?.keyword?.text),
      matchType: str(r.adGroupCriterion?.keyword?.matchType), status: str(r.adGroupCriterion?.status),
    })),
  }
  return { labels, usedOn, notRead }
}

// ── experiments ──────────────────────────────────────────────────────────────────────────────────────────────────

export const EXPERIMENTS_QUERY =
  'SELECT experiment.experiment_id, experiment.name, experiment.description, experiment.type, experiment.status, ' +
  'experiment.start_date, experiment.end_date, experiment.suffix, experiment.promote_status FROM experiment ' +
  "WHERE experiment.status != 'REMOVED'"

export const EXPERIMENT_ARMS_QUERY =
  'SELECT experiment_arm.experiment, experiment_arm.name, experiment_arm.control, experiment_arm.traffic_split, ' +
  'experiment_arm.campaigns, experiment_arm.in_design_campaigns FROM experiment_arm'

export interface LiveExperiment {
  experimentId: string | null
  name: string | null
  description: string | null
  type: string | null
  status: string | null
  start: string | null
  end: string | null
  suffix: string | null
  promoteStatus: string | null
  arms: Array<{ name: string | null; control: boolean; trafficSplitPct: number | null; campaignIds: string[]; inDesignCampaignIds: string[] }>
}

export async function liveExperiments(target: GoogleAdsTarget): Promise<{ experiments: LiveExperiment[]; notRead: NotRead[] }> {
  const notRead: NotRead[] = []
  const experiments = await part(target, notRead, 'experiments', EXPERIMENTS_QUERY, (r): LiveExperiment => {
    const e = r.experiment ?? {}
    return {
      experimentId: str(e.experimentId), name: str(e.name), description: str(e.description), type: str(e.type), status: str(e.status),
      start: str(e.startDate), end: str(e.endDate), suffix: str(e.suffix), promoteStatus: str(e.promoteStatus), arms: [],
    }
  })
  if (experiments.length) {
    const arms = await part(target, notRead, 'experiment-arms', EXPERIMENT_ARMS_QUERY, (r) => {
      const a = r.experimentArm ?? {}
      return {
        experimentId: tail(a.experiment),
        arm: {
          name: str(a.name), control: bool(a.control), trafficSplitPct: opt(a.trafficSplit),
          campaignIds: list(a.campaigns).map((c) => tail(c) ?? c), inDesignCampaignIds: list(a.inDesignCampaigns).map((c) => tail(c) ?? c),
        },
      }
    })
    for (const e of experiments) e.arms = arms.filter((a) => a.experimentId === e.experimentId).map((a) => a.arm)
  }
  return { experiments, notRead }
}

// ── user access ──────────────────────────────────────────────────────────────────────────────────────────────────

export const USER_ACCESS_QUERY =
  'SELECT customer_user_access.user_id, customer_user_access.email_address, customer_user_access.access_role, ' +
  'customer_user_access.access_creation_date_time, customer_user_access.inviter_user_email_address FROM customer_user_access'

export const USER_INVITATIONS_QUERY =
  'SELECT customer_user_access_invitation.invitation_id, customer_user_access_invitation.email_address, ' +
  'customer_user_access_invitation.access_role, customer_user_access_invitation.creation_date_time, ' +
  'customer_user_access_invitation.invitation_status FROM customer_user_access_invitation'

export interface LiveUsers {
  users: Array<{ userId: string | null; email: string | null; role: string | null; since: string | null; invitedBy: string | null }>
  invitations: Array<{ invitationId: string | null; email: string | null; role: string | null; sentAt: string | null; status: string | null }>
  notRead: NotRead[]
}

export async function liveUsers(target: GoogleAdsTarget): Promise<LiveUsers> {
  const notRead: NotRead[] = []
  const users = await part(target, notRead, 'users', USER_ACCESS_QUERY, (r) => {
    const u = r.customerUserAccess ?? {}
    return { userId: str(u.userId), email: str(u.emailAddress), role: str(u.accessRole), since: str(u.accessCreationDateTime), invitedBy: str(u.inviterUserEmailAddress) }
  })
  const invitations = await part(target, notRead, 'invitations', USER_INVITATIONS_QUERY, (r) => {
    const i = r.customerUserAccessInvitation ?? {}
    return { invitationId: str(i.invitationId), email: str(i.emailAddress), role: str(i.accessRole), sentAt: str(i.creationDateTime), status: str(i.invitationStatus) }
  })
  return { users, invitations, notRead }
}

// ── billing ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const BILLING_SETUPS_QUERY =
  'SELECT billing_setup.id, billing_setup.status, billing_setup.payments_account, billing_setup.payments_account_info.payments_account_id, ' +
  'billing_setup.payments_account_info.payments_account_name, billing_setup.payments_account_info.payments_profile_id, ' +
  'billing_setup.payments_account_info.payments_profile_name, billing_setup.start_date_time, billing_setup.end_date_time FROM billing_setup'

export const ACCOUNT_BUDGETS_QUERY =
  'SELECT account_budget.id, account_budget.name, account_budget.status, account_budget.billing_setup, ' +
  'account_budget.approved_start_date_time, account_budget.approved_end_date_time, account_budget.approved_end_time_type, ' +
  'account_budget.approved_spending_limit_micros, account_budget.approved_spending_limit_type, ' +
  'account_budget.adjusted_spending_limit_micros, account_budget.amount_served_micros, account_budget.total_adjustments_micros, ' +
  'account_budget.pending_proposal.proposal_type, account_budget.pending_proposal.spending_limit_micros, ' +
  'account_budget.pending_proposal.creation_date_time FROM account_budget'

export interface LiveBilling {
  setups: Array<{ billingSetupId: string | null; status: string | null; paymentsAccountId: string | null; paymentsAccountName: string | null; paymentsProfileId: string | null; paymentsProfileName: string | null; start: string | null; end: string | null }>
  accountBudgets: Array<{
    accountBudgetId: string | null; name: string | null; status: string | null; billingSetupId: string | null
    start: string | null; end: string | null; endType: string | null
    /** null with spendingLimitType INFINITE: no limit. */
    spendingLimitCents: number | null; spendingLimitType: string | null; adjustedSpendingLimitCents: number | null
    amountServedCents: number | null; adjustmentsCents: number | null
    pending: { type: string | null; spendingLimitCents: number | null; createdAt: string | null } | null
  }>
  notRead: NotRead[]
}

export async function liveBilling(target: GoogleAdsTarget): Promise<LiveBilling> {
  const notRead: NotRead[] = []
  const setups = await part(target, notRead, 'billing-setups', BILLING_SETUPS_QUERY, (r) => {
    const b = r.billingSetup ?? {}
    const p = b.paymentsAccountInfo ?? {}
    return {
      billingSetupId: str(b.id), status: str(b.status), paymentsAccountId: str(p.paymentsAccountId) ?? tail(b.paymentsAccount),
      paymentsAccountName: str(p.paymentsAccountName), paymentsProfileId: str(p.paymentsProfileId), paymentsProfileName: str(p.paymentsProfileName),
      start: str(b.startDateTime), end: str(b.endDateTime),
    }
  })
  const accountBudgets = await part(target, notRead, 'account-budgets', ACCOUNT_BUDGETS_QUERY, (r) => {
    const a = r.accountBudget ?? {}
    const p = a.pendingProposal
    return {
      accountBudgetId: str(a.id), name: str(a.name), status: str(a.status), billingSetupId: tail(a.billingSetup),
      start: str(a.approvedStartDateTime), end: str(a.approvedEndDateTime), endType: str(a.approvedEndTimeType),
      spendingLimitCents: centsOfMicros(a.approvedSpendingLimitMicros), spendingLimitType: str(a.approvedSpendingLimitType),
      adjustedSpendingLimitCents: centsOfMicros(a.adjustedSpendingLimitMicros),
      amountServedCents: centsOfMicros(a.amountServedMicros), adjustmentsCents: centsOfMicros(a.totalAdjustmentsMicros),
      pending: p ? { type: str(p.proposalType), spendingLimitCents: centsOfMicros(p.spendingLimitMicros), createdAt: str(p.creationDateTime) } : null,
    }
  })
  return { setups, accountBudgets, notRead }
}

// ── links ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PRODUCT_LINKS_QUERY =
  'SELECT product_link.product_link_id, product_link.type, product_link.merchant_center.merchant_center_id, ' +
  'product_link.google_ads.customer, product_link.data_partner.data_partner_id, product_link.advertising_partner.customer FROM product_link'

export const PRODUCT_LINK_INVITATIONS_QUERY =
  'SELECT product_link_invitation.product_link_invitation_id, product_link_invitation.type, product_link_invitation.status, ' +
  'product_link_invitation.merchant_center.merchant_center_id, product_link_invitation.hotel_center.hotel_center_id, ' +
  'product_link_invitation.advertising_partner.customer FROM product_link_invitation'

export const DATA_LINKS_QUERY =
  'SELECT data_link.data_link_id, data_link.product_link_id, data_link.type, data_link.status, data_link.youtube_video.channel_id, ' +
  'data_link.youtube_video.video_id FROM data_link'

export interface LiveLinks {
  /** Merchant Center accounts, other Google Ads accounts, data and advertising partners linked to this account. */
  productLinks: Array<{ linkId: string | null; type: string | null; merchantCenterId: string | null; googleAdsCustomerId: string | null; dataPartnerId: string | null; advertisingPartnerCustomerId: string | null }>
  /** Link requests still open or answered (a Merchant Center link waiting for approval, …). */
  invitations: Array<{ invitationId: string | null; type: string | null; status: string | null; merchantCenterId: string | null; hotelCenterId: string | null; advertisingPartnerCustomerId: string | null }>
  /** YouTube video links (data_link type VIDEO). */
  youtube: Array<{ dataLinkId: string | null; productLinkId: string | null; status: string | null; channelId: string | null; videoId: string | null }>
  /** GA4: not readable as a link in the Google Ads API; the properties the account's GA4 conversion actions come from. */
  ga4Properties: Array<{ propertyId: string | null; propertyName: string | null; conversionActions: string[] }>
  notRead: NotRead[]
}

export async function liveLinks(target: GoogleAdsTarget): Promise<LiveLinks> {
  const notRead: NotRead[] = []
  const productLinks = await part(target, notRead, 'product-links', PRODUCT_LINKS_QUERY, (r) => {
    const l = r.productLink ?? {}
    return {
      linkId: str(l.productLinkId), type: str(l.type), merchantCenterId: str(l.merchantCenter?.merchantCenterId),
      googleAdsCustomerId: tail(l.googleAds?.customer), dataPartnerId: str(l.dataPartner?.dataPartnerId), advertisingPartnerCustomerId: tail(l.advertisingPartner?.customer),
    }
  })
  const invitations = await part(target, notRead, 'link-invitations', PRODUCT_LINK_INVITATIONS_QUERY, (r) => {
    const i = r.productLinkInvitation ?? {}
    return {
      invitationId: str(i.productLinkInvitationId), type: str(i.type), status: str(i.status), merchantCenterId: str(i.merchantCenter?.merchantCenterId),
      hotelCenterId: str(i.hotelCenter?.hotelCenterId), advertisingPartnerCustomerId: tail(i.advertisingPartner?.customer),
    }
  })
  const youtube = await part(target, notRead, 'data-links', DATA_LINKS_QUERY, (r) => {
    const d = r.dataLink ?? {}
    return { dataLinkId: str(d.dataLinkId), productLinkId: str(d.productLinkId), status: str(d.status), channelId: str(d.youtubeVideo?.channelId), videoId: str(d.youtubeVideo?.videoId) }
  })
  const actions = await part(target, notRead, 'ga4-conversion-actions', CONVERSION_ACTIONS_QUERY, conversionActionOf)
  const byProperty = new Map<string, LiveLinks['ga4Properties'][number]>()
  for (const a of actions) {
    if (!a.ga4) continue
    const key = a.ga4.propertyId ?? a.ga4.propertyName ?? '?'
    const entry = byProperty.get(key) ?? { propertyId: a.ga4.propertyId, propertyName: a.ga4.propertyName, conversionActions: [] }
    if (a.name) entry.conversionActions.push(a.name)
    byProperty.set(key, entry)
  }
  return { productLinks, invitations, youtube, ga4Properties: [...byProperty.values()], notRead }
}

// ── lookups: the account's own audiences ─────────────────────────────────────────────────────────────────────────

export type AccountLookupKind = 'user-lists' | 'custom-audiences' | 'combined-audiences'
export const ACCOUNT_LOOKUP_LIMIT = 200

/** A GAQL LIKE literal for a word of a name: quotes and backslashes dropped, LIKE's own wildcards taken out. */
function nameLike(field: string, search?: string | null): string {
  const cleaned = (search ?? '').trim().slice(0, 80).replace(/[\\'"]/g, ' ').replace(/[%_[\]]/g, ' ').trim()
  return cleaned ? ` AND ${field} LIKE '%${cleaned}%'` : ''
}

/** The account's user lists, custom audiences or combined audiences (enabled), optionally those whose name holds `search`. */
export function accountLookupQuery(kind: AccountLookupKind, search?: string | null): string {
  switch (kind) {
    case 'user-lists':
      return 'SELECT user_list.id, user_list.name, user_list.type, user_list.description, user_list.membership_status, ' +
        'user_list.account_user_list_status, user_list.size_range_for_search, user_list.size_range_for_display, ' +
        'user_list.eligible_for_search, user_list.eligible_for_display, user_list.membership_life_span FROM user_list ' +
        `WHERE user_list.account_user_list_status = 'ENABLED'${nameLike('user_list.name', search)} ORDER BY user_list.name LIMIT ${ACCOUNT_LOOKUP_LIMIT}`
    case 'custom-audiences':
      return 'SELECT custom_audience.id, custom_audience.name, custom_audience.type, custom_audience.status, custom_audience.description ' +
        `FROM custom_audience WHERE custom_audience.status = 'ENABLED'${nameLike('custom_audience.name', search)} ORDER BY custom_audience.name LIMIT ${ACCOUNT_LOOKUP_LIMIT}`
    case 'combined-audiences':
      return 'SELECT combined_audience.id, combined_audience.name, combined_audience.status, combined_audience.description ' +
        `FROM combined_audience WHERE combined_audience.status = 'ENABLED'${nameLike('combined_audience.name', search)} ORDER BY combined_audience.name LIMIT ${ACCOUNT_LOOKUP_LIMIT}`
  }
}

export interface AccountLookupRow {
  id: string | null
  name: string | null
  type: string | null
  description: string | null
  /** User lists: how big Google says the list is and whether it can serve on Search / Display. */
  sizeForSearch?: string | null
  sizeForDisplay?: string | null
  eligibleForSearch?: boolean
  eligibleForDisplay?: boolean
  membershipStatus?: string | null
  membershipDays?: number | null
}

export function accountLookupRowOf(kind: AccountLookupKind, row: Json): AccountLookupRow {
  if (kind === 'user-lists') {
    const u = row.userList ?? {}
    return {
      id: str(u.id), name: str(u.name), type: str(u.type), description: str(u.description),
      sizeForSearch: str(u.sizeRangeForSearch), sizeForDisplay: str(u.sizeRangeForDisplay),
      eligibleForSearch: bool(u.eligibleForSearch), eligibleForDisplay: bool(u.eligibleForDisplay),
      membershipStatus: str(u.membershipStatus), membershipDays: opt(u.membershipLifeSpan),
    }
  }
  const a = kind === 'custom-audiences' ? row.customAudience ?? {} : row.combinedAudience ?? {}
  return { id: str(a.id), name: str(a.name), type: kind === 'custom-audiences' ? str(a.type) : 'COMBINED', description: str(a.description) }
}

export async function liveAccountLookup(target: GoogleAdsTarget, kind: AccountLookupKind, search?: string | null): Promise<AccountLookupRow[]> {
  return (await liveRows<Json>(target, accountLookupQuery(kind, search), 'ads.search.live.lookup')).map((r) => accountLookupRowOf(kind, r))
}
