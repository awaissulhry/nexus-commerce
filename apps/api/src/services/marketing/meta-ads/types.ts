/**
 * Meta ads M1 — the shapes the daily read passes between its parts (read client → mappers → store). Meta's own field
 * names are in the mappers; these are Nexus's.
 */

/** One Meta ad account a business reads, through its META connection. Ids digits only (no `act_`). */
export interface MetaAdsTarget {
  connectionId: string
  adAccountId: string
}

/** ACCOUNT: the account's own daily totals (level=account; entityId = the ad account id, campaignId ''). */
export type MetaAdsEntityType = 'ACCOUNT' | 'CAMPAIGN' | 'ADSET' | 'AD'

/** The steps of a read whose state is kept in MetaAdsReadState (the campaign days stay on MetaAdAccount). */
export type MetaAdsReadResource = 'ACCOUNT' | 'CAMPAIGNS' | 'ADSETS' | 'ADS' | 'ACCOUNT_DAYS' | 'ADSET_DAYS' | 'AD_DAYS'

/** How a read ended (MetaAdAccount.lastSyncStatus). */
export type MetaAdsSyncStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'AUTH_LOST' | 'THROTTLED'

export interface MetaAdAccountData {
  adAccountId: string
  name: string | null
  currencyCode: string
  timeZone: string
  timezoneOffsetHoursUtc: number | null
  accountStatus: number | null
  disableReason: number | null
  businessId: string | null
  businessName: string | null
  amountSpentMicros: bigint | null
  spendCapMicros: bigint | null
  balanceMicros: bigint | null
  minDailyBudgetMicros: bigint | null
  isPrepayAccount: boolean | null
  settings: Record<string, unknown>
}

export interface MetaCampaignData {
  adAccountId: string
  campaignId: string
  name: string
  status: string
  effectiveStatus: string | null
  objective: string | null
  buyingType: string | null
  bidStrategy: string | null
  dailyBudgetMicros: bigint | null
  lifetimeBudgetMicros: bigint | null
  budgetRemainingMicros: bigint | null
  spendCapMicros: bigint | null
  startTime: Date | null
  stopTime: Date | null
  createdTimeMeta: Date | null
  updatedTimeMeta: Date | null
  currencyCode: string
}

export interface MetaAdSetData {
  adAccountId: string
  campaignId: string
  adSetId: string
  name: string
  status: string
  effectiveStatus: string | null
  optimizationGoal: string | null
  billingEvent: string | null
  bidStrategy: string | null
  bidAmountMicros: bigint | null
  dailyBudgetMicros: bigint | null
  lifetimeBudgetMicros: bigint | null
  budgetRemainingMicros: bigint | null
  destinationType: string | null
  startTime: Date | null
  endTime: Date | null
  targeting: Record<string, unknown> | null
  currencyCode: string
}

export interface MetaAdData {
  adAccountId: string
  campaignId: string
  adSetId: string
  adId: string
  name: string
  status: string
  effectiveStatus: string | null
  creativeId: string | null
  creative: Record<string, unknown> | null
  issues: Record<string, unknown> | null
  createdTimeMeta: Date | null
  updatedTimeMeta: Date | null
}

export interface MetaDailyMetricData {
  adAccountId: string
  date: Date
  entityType: MetaAdsEntityType
  entityId: string
  campaignId: string
  adSetId: string | null
  label: string | null
  impressions: number
  reach: number | null
  clicks: number
  linkClicks: number | null
  spendMicros: bigint
  /** Purchases as a decimal string with at most 4 decimals (the column is Decimal(14,4)). */
  purchases: string
  purchaseValueMicros: bigint
  currencyCode: string
  extra: Record<string, unknown> | null
}
