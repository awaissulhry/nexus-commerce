/**
 * R9 (MCP full control, part 06 §4) — the fields each trigger hands a rule: every dotted path a condition can read.
 *
 * Read off the context builders of jobs/advertising-rule-evaluator.job.ts (traced 2026-10-01, every builder of the 21
 * passes, SCHEDULE built inline) and jobs/marketing-rule-evaluator.job.ts. A condition on any other path reads
 * undefined and never matches — memory reference_four_inert_ads_rules — so the rule guard refuses it at save.
 *
 * Some fields are absent when they cannot be measured (`measured()`: a ratio with no denominator); a condition on one
 * is still valid, it simply does not match that context. Units: `acos`, `ctr`, `cvr`, `budgetUtilization`, `sovPct`,
 * `topSharePct`, `currentCvr`, `previousCvr` are FRACTIONS (0.3 = 30 %); `declinePct` and `growthPct` are whole
 * percents; `…Cents` are cents; `roas` is a plain ratio.
 *
 * Keep in step with the builders: a field added to a context is added here, or a rule on it is refused.
 */
export const ADS_TRIGGER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  FBA_AGE_THRESHOLD_REACHED: ['trigger', 'marketplace', 'product.id', 'product.sku', 'product.asin', 'product.productType', 'fbaAge.daysToLtsThreshold', 'fbaAge.quantityInAge0_90', 'fbaAge.quantityInAge91_180', 'fbaAge.quantityInAge181_270', 'fbaAge.quantityInAge271_365', 'fbaAge.quantityInAge365Plus', 'fbaAge.projectedLtsFee30dCents', 'fbaAge.projectedLtsFee60dCents', 'fbaAge.projectedLtsFee90dCents'],
  AD_SPEND_PROFITABILITY_BREACH: ['trigger', 'marketplace', 'campaign.id', 'campaign.externalCampaignId', 'campaign.name', 'campaign.spendCents', 'campaign.salesCents', 'campaign.acos', 'campaign.trueProfitCents', 'profit.trueProfitCents30d', 'profit.netCents'],
  CAC_SPIKE: ['trigger', 'marketplace', 'campaign.id', 'campaign.externalCampaignId', 'campaign.name', 'campaign.spendCents', 'campaign.salesCents', 'campaign.acos'],
  AD_TARGET_UNDERPERFORMING: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.externalTargetId', 'adTarget.kind', 'adTarget.expressionValue', 'adTarget.bidCents', 'adTarget.spendCents', 'adTarget.salesCents', 'adGroup.id', 'adGroup.name', 'campaign.id', 'campaign.name', 'evidence.targetKey', 'evidence.metric', 'evidence.observed', 'evidence.threshold', 'evidence.windowDays', 'evidence.sampleUnit', 'evidence.sampleSize'],
  CAMPAIGN_PERFORMANCE_BUDGET: ['trigger', 'marketplace', 'campaign.id', 'campaign.externalCampaignId', 'campaign.name', 'campaign.dailyBudgetCents', 'campaign.spendCents', 'campaign.salesCents', 'campaign.impressions', 'campaign.clicks', 'campaign.orders', 'campaign.avgDailySpendCents', 'campaign.acos', 'campaign.roas', 'campaign.ctr', 'campaign.cvr', 'campaign.cpcCents', 'campaign.budgetUtilization', 'placement.tos.impressions', 'placement.tos.clicks', 'placement.tos.orders', 'placement.tos.spendCents', 'placement.tos.salesCents', 'placement.tos.acos', 'placement.tos.roas', 'placement.tos.ctr', 'placement.tos.cvr', 'placement.tos.cpcCents', 'placement.pdp.impressions', 'placement.pdp.clicks', 'placement.pdp.orders', 'placement.pdp.spendCents', 'placement.pdp.salesCents', 'placement.pdp.acos', 'placement.pdp.roas', 'placement.pdp.ctr', 'placement.pdp.cvr', 'placement.pdp.cpcCents', 'placement.ros.impressions', 'placement.ros.clicks', 'placement.ros.orders', 'placement.ros.spendCents', 'placement.ros.salesCents', 'placement.ros.acos', 'placement.ros.roas', 'placement.ros.ctr', 'placement.ros.cvr', 'placement.ros.cpcCents'],
  SCHEDULE: ['trigger', 'marketplace', 'budget.monthlySpendCents'],
  CVR_DROP: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.currentCvr', 'adTarget.previousCvr', 'adTarget.clicks'],
  KEYWORD_LOW_CTR: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.impressions', 'adTarget.clicks', 'adTarget.ctr', 'adTarget.spendCents'],
  KEYWORD_WASTED_SPEND: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.spendCents', 'adTarget.orders', 'adTarget.clicks'],
  KEYWORD_ZERO_IMPRESSIONS: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.spendCents', 'adTarget.impressions'],
  SEARCH_TERM_CONVERTING: ['trigger', 'marketplace', 'searchTerm.query', 'searchTerm.externalCampaignId', 'searchTerm.externalAdGroupId', 'searchTerm.orders', 'searchTerm.clicks', 'searchTerm.impressions', 'searchTerm.spendCents', 'searchTerm.salesCents', 'searchTerm.acos', 'searchTerm.roas', 'searchTerm.ctr', 'searchTerm.cvr', 'searchTerm.cpcCents'],
  KEYWORD_HIGH_ACOS: ['trigger', 'marketplace', 'campaign.id', 'adGroup.id', 'adTarget.id', 'adTarget.spendCents', 'adTarget.salesCents', 'adTarget.orders', 'adTarget.acos', 'adTarget.clicks', 'adTarget.impressions', 'adTarget.roas', 'adTarget.ctr', 'adTarget.cvr', 'adTarget.cpcCents', 'adTarget.bidCents'],
  // 4f — builder Bid rules. `acos` is absent on a target with no sales (`measured()`).
  TARGET_PERFORMANCE: ['trigger', 'marketplace', 'campaign.id', 'campaign.name', 'adGroup.id', 'adGroup.name', 'adTarget.id', 'adTarget.kind', 'adTarget.expressionType', 'adTarget.expressionValue', 'adTarget.bidCents', 'adTarget.spendCents', 'adTarget.salesCents', 'adTarget.orders', 'adTarget.clicks', 'adTarget.impressions', 'adTarget.acos', 'adTarget.roas', 'adTarget.ctr', 'adTarget.cvr', 'adTarget.cpcCents'],
  KEYWORD_SCALE_OPPORTUNITY: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.spendCents', 'adTarget.salesCents', 'adTarget.orders', 'adTarget.roas', 'adTarget.clicks'],
  AD_GROUP_UNDERPERFORMING: ['trigger', 'marketplace', 'adGroup.id', 'adGroup.spendCents', 'adGroup.salesCents', 'adGroup.orders', 'adGroup.acos'],
  NEW_TO_BRAND_WINNER: ['trigger', 'marketplace', 'campaign.id', 'campaign.externalCampaignId', 'campaign.name', 'campaign.ntbOrders', 'campaign.ntbSalesCents', 'campaign.spendCents'],
  CAMPAIGN_NO_SALES: ['trigger', 'marketplace', 'campaign.id', 'campaign.externalCampaignId', 'campaign.name', 'campaign.spendCents', 'campaign.salesCents'],
  SEARCH_TERM_WASTING: ['trigger', 'marketplace', 'searchTerm.query', 'searchTerm.externalCampaignId', 'searchTerm.externalAdGroupId', 'searchTerm.orders', 'searchTerm.clicks', 'searchTerm.impressions', 'searchTerm.spendCents', 'searchTerm.salesCents', 'searchTerm.acos', 'searchTerm.roas', 'searchTerm.ctr', 'searchTerm.cvr', 'searchTerm.cpcCents'],
  CAMPAIGN_ROAS_DECLINING: ['trigger', 'marketplace', 'campaign.id', 'campaign.externalCampaignId', 'campaign.name', 'campaign.roas', 'campaign.previousRoas', 'campaign.spendCents', 'campaign.declinePct'],
  KEYWORD_RISING_STAR: ['trigger', 'marketplace', 'adTarget.id', 'adTarget.orders', 'adTarget.previousOrders', 'adTarget.spendCents', 'adTarget.salesCents', 'adTarget.roas', 'adTarget.growthPct'],
  SOV_BID: ['trigger', 'marketplace', 'campaign.id', 'adGroup.id', 'adTarget.id', 'adTarget.sovPct', 'adTarget.topSharePct', 'adTarget.spendCents', 'adTarget.salesCents', 'adTarget.orders', 'adTarget.clicks', 'adTarget.impressions', 'adTarget.acos', 'adTarget.roas', 'adTarget.ctr', 'adTarget.cvr', 'adTarget.cpcCents'],
  // Keyword Tracker. `searchVolume` (searches per Brand Analytics week) is filled by the keyword-rank-feed cron;
  // `organicRank`, `sponsoredRank` and `rankDelta` have no automatic source and exist only after a hand import
  // (services/advertising/keyword-rank-feed.service.ts) — a rule on them alone is valid and matches nothing.
  KEYWORD_RANK_BID: ['trigger', 'marketplace', 'campaign.id', 'adGroup.id', 'adTarget.id', 'adTarget.organicRank', 'adTarget.sponsoredRank', 'adTarget.searchVolume', 'adTarget.rankDelta', 'adTarget.spendCents', 'adTarget.salesCents', 'adTarget.orders', 'adTarget.clicks', 'adTarget.impressions', 'adTarget.acos', 'adTarget.roas', 'adTarget.ctr', 'adTarget.cvr', 'adTarget.cpcCents'],
}

/** The marketing evaluator's contexts (jobs/marketing-rule-evaluator.job.ts: toCtx, and the tick context). */
const MKT_CAMPAIGN = ['marketplace', 'campaignId', 'campaign.id', 'campaign.name', 'campaign.channel', 'campaign.status', 'campaign.acos', 'campaign.roas', 'campaign.spendCents', 'campaign.salesCents', 'campaign.budgetCents']
export const MARKETING_TRIGGER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  MKT_ACOS_BREACH: MKT_CAMPAIGN,
  MKT_UNDERPACING: MKT_CAMPAIGN,
  MKT_CRON_TICK: ['marketplace', 'ts'],
}

/** Ratio fields stored as fractions, with the largest believable value (budgetUtilization and ACOS can pass 1). */
export const FRACTION_MAX: Readonly<Record<string, number>> = {
  acos: 5, budgetUtilization: 5, ctr: 1, cvr: 1, currentCvr: 1, previousCvr: 1, sovPct: 1, topSharePct: 1,
}
