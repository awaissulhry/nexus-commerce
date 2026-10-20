/**
 * Phase S2 (RBAC engine) — restricted financial field registry.
 *
 * Field-level security = server-side response filtering (master prompt §3.3):
 * money fields are STRIPPED from API responses for callers without the
 * matching `financials.*` permission — the data never reaches the browser.
 * Not a hidden column: absent data.
 *
 * This is the curated set of DISTINCTIVE restricted field NAMES (from
 * docs/security/S0-ENUMERATION-FINANCIAL-FIELDS.md §3a), each mapped to the
 * financial sub-permission that unlocks it. `financials.view` grants all
 * (expanded in the resolver). We deliberately include only unambiguous
 * names (…Cents / …Micros / …Pct / …USD suffixes + distinctive words like
 * costPrice, minMargin, acos, estimatedFbaFee) and NOT generic ones
 * (price, amount, total, sales-without-suffix) that also name operational
 * values — those OPERATIONAL fields (Order.totalPrice, OrderItem.price)
 * stay visible per the S0 borderline rulings.
 *
 * Generic-named pure-financial fields that can't be safely matched by name
 * (SettlementReport.totalAmount) are gated at the ROUTE level instead — see
 * FINANCIAL_ONLY_ROUTE_PREFIXES below.
 */

import { FIELDS } from '@nexus/shared/permissions'

// field name → the permission that reveals it.
export const RESTRICTED_FIELDS: Record<string, string> = {}
const add = (perm: string, names: string[]) => {
  for (const n of names) RESTRICTED_FIELDS[n] = perm
}

// ── Costs / COGS / landed / valuation ──────────────────────────────
add(FIELDS.financialsCostsView, [
  'costPrice', 'weightedAvgCostCents', 'orderingCostCents', 'carryingCostPctYear',
  'unitCost', 'unitCostCents', 'unitCostVatExcluded', 'unitCostCurrency',
  'freightCents', 'dutyCents', 'insuranceCents', 'exchangeRateOnReceive',
  'cogsCents', 'computedCostCents', 'lastLandedCostCents', 'landedCostPerUnitCents',
  'freightCostPerUnitCents', 'costVarianceCents', 'costImpactCents', 'targetCostCents',
  'quotedCostCents', 'shippingCostCents', 'customsCostCents', 'dutiesCostCents',
  'insuranceCostCents', 'totalValueEurCents', 'fxRateUsed', 'totalCostDeltaCents',
  'totalCostCentsCreated', 'declinedCostCeiling', 'autoTriggerMaxCostCentsPerPo',
  'costPerCbmCents', 'costPerKgCents',
])

// ── Margins / profit ───────────────────────────────────────────────
add(FIELDS.financialsMarginsView, [
  'minMargin', 'minMarginPercent', 'maxMarginPercent', 'trueProfitMarginPct',
  'marginAtObservation', 'marginCentsPerUnit', 'estimatedLostMargin',
])

// ── Marketplace fees ───────────────────────────────────────────────
add(FIELDS.financialsFeesView, [
  'estimatedFbaFee', 'referralFeePercent', 'referralFeesCents', 'fbaFulfillmentFeesCents',
  'fbaStorageFeesCents', 'otherFeesCents', 'amazonFee', 'fbaFee', 'paymentServicesFee',
  'ebayFee', 'paypalFee', 'otherFees', 'projectedLtsFee30dCents', 'projectedLtsFee60dCents',
  'projectedLtsFee90dCents', 'currentStorageFeeCents', 'restockingFeePct',
])

// ── Payouts / settlements / reimbursements ─────────────────────────
add(FIELDS.financialsPayoutsView, [
  'amountPerUnitCents', 'totalAmountCents', 'depositDate', 'rawBody',
])

// ── Revenue aggregates / P&L ───────────────────────────────────────
add(FIELDS.financialsRevenueView, [
  'grossRevenue', 'grossRevenueCents', 'netRevenue', 'averageSellingPrice',
  'totalSpentCents', 'trueProfitCents', 'estimatedLostRevenue',
])

// ── Ad spend / bids / budgets / ad performance ─────────────────────
add(FIELDS.financialsAdspendView, [
  'acos', 'roas', 'acos7d', 'roas7d', 'spendCents', 'salesCents', 'costMicros',
  'costEurCents', 'sales1dCents', 'sales7dCents', 'sales14dCents', 'sales30dCents',
  'ntbSalesCents14d', 'defaultBidCents', 'bidCents', 'baseBidFromCents',
  'suppressedFromBidCents', 'budgetAmount', 'dailyBudget', 'totalDailyBudgetCents',
  'totalDailyCents', 'minDailyBudgetCents', 'maxDailyBudgetCents', 'maxDailyAdSpendCentsEur',
  'maxHourlySpendCentsEur', 'bidPercentage', 'budgetCents', 'acosCapPct', 'maxCpcCents',
  'bidValueCents', 'bidDeltaPct', 'familyDailyBudgetCents', 'familyAcosCapPct',
  'monthlyBudgetCents', 'totalBudgetCents', 'totalShiftCents', 'targetSharePct',
  // Google Ads step 1a — the Google Ads tab's reads (routes/google-ads-read.routes.ts) and Claude's Google ad reads:
  // conversion value, average cost per click, cost per conversion (spendCents and roas are above; a campaign's
  // dailyBudgetCents is stripped by those routes' own hook and by the ad tools' AD_MONEY).
  'conversionValueCents', 'avgCpcCents', 'costPerConversionCents',
  // Meta ads step 2 — Ads › Meta's reads (routes/meta-ads-read.routes.ts) and Claude's Meta reads: purchase value, cost
  // per 1,000 impressions and per purchase, and the ad account's amount spent, spending limit and balance (cpcCents and
  // the budgets, which other answers name too, are stripped by those routes' own hook and by the tools' money lists).
  'purchaseValueCents', 'cpmCents', 'costPerPurchaseCents', 'amountSpentCents', 'spendCapCents', 'balanceCents',
])

// ── Suppliers / B2B pricing ────────────────────────────────────────
// `b2bPrice` (Product) is read and written by no code since Amazon Business step 7a, but the column stays until its
// drop and a full-row product read still returns it, so it stays stripped.
add(FIELDS.financialsSuppliersView, [
  'b2bPrice', 'paymentTerms', 'costCents',
])

// ── AI / internal opex ─────────────────────────────────────────────
add(FIELDS.financialsAdspendView, ['costUSD', 'dailyBudgetUSD'])

/** Distinct set of field names that are restricted (any perm). */
export const RESTRICTED_FIELD_NAMES = new Set(Object.keys(RESTRICTED_FIELDS))

/**
 * Route prefixes whose responses are financial top-to-bottom and carry
 * generic-named money fields (SettlementReport.totalAmount)
 * that a name-based strip can't safely target. Under enforce, a caller
 * without `financials.view` is blocked from these entirely. Tracked as the
 * companion to the field-name strip.
 */
export const FINANCIAL_ONLY_ROUTE_PREFIXES: string[] = [
  '/api/insights/profit',
  '/api/insights/fiscal',
  '/api/amazon/economics',
  '/api/amazon-economics',
  '/api/settlements',
  '/api/amazon/settlements',
  '/api/fba/reimbursements',
  '/api/products/costs', // S1 (F4) — the cost grid's real path (`/api/product-costs` has no route)
]
