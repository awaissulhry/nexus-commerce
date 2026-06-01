/**
 * Automation catalogue — the Ads Console's library of ready-to-enable
 * automations. Every template maps to a trigger/condition/action vocabulary the
 * backend engine actually evaluates (see automation-templates.ts +
 * automation-rule.service.ts), so enabling one creates a real, working rule
 * (POST /advertising/automation-rules) — always seeded enabled:false + dryRun:true.
 * Helpers expand the high-value patterns across sensible thresholds so operators
 * get presets for every aggressiveness level, plus the custom builder for the rest.
 */

export interface AutoTemplate {
  id: string
  name: string
  desc: string
  category: string
  icon: string
  trigger: string
  conditions: Array<{ field: string; op: string; value: number }>
  actions: Array<Record<string, unknown>>
  maxExecutionsPerDay?: number
  maxValueCentsEur?: number | null
  maxDailyAdSpendCentsEur?: number | null
  marquee?: boolean
}

const notify = (message: string) => ({ type: 'notify', target: 'operator', message })

// ── builders for the high-value families ──────────────────────────────────
const bidDown = (acosPct: number, pct: number): AutoTemplate => ({
  id: `bid-down-${acosPct}-${pct}`, category: 'Bidding', icon: '📉', trigger: 'CAC_SPIKE',
  name: `Cut bids when ACOS > ${acosPct}%`,
  desc: `When a campaign's ACOS exceeds ${acosPct}% with meaningful spend, lower the ad-group bid by ${pct}% (floor €0.05). Stops the bleed on keywords that turned unprofitable.`,
  conditions: [{ field: 'campaign.acos', op: 'gte', value: acosPct / 100 }],
  actions: [{ type: 'bid_down', target: 'ad_group', percent: pct, reason: `ACOS > ${acosPct}% — bid −${pct}%` }, notify(`Bid −${pct}% — ACOS over ${acosPct}%`)],
  maxExecutionsPerDay: 50,
})
const prune = (eur: number, maxOrders: number): AutoTemplate => ({
  id: `prune-${eur}-${maxOrders}`, category: 'Pruning', icon: '✂️', trigger: 'AD_TARGET_UNDERPERFORMING',
  name: maxOrders === 0 ? `Pause targets: €${eur} spent, 0 sales` : `Pause targets: €${eur} spent, ≤${maxOrders} orders`,
  desc: `When a keyword/ASIN target has spent €${eur}+ with ${maxOrders === 0 ? 'zero sales' : `${maxOrders} or fewer orders`}, pause its ad group. Kills wasted spend on proven losers.`,
  conditions: [{ field: 'adTarget.spendCents', op: 'gte', value: eur * 100 }, { field: 'adTarget.salesCents', op: maxOrders === 0 ? 'eq' : 'lte', value: maxOrders === 0 ? 0 : 1 }],
  actions: [{ type: 'pause_ad_group', reason: `Underperformer — €${eur} spent, no return` }, notify(`Ad group paused — target wasted €${eur}`)],
  maxExecutionsPerDay: 50,
})
const scale = (roas: number, pct: number): AutoTemplate => ({
  id: `scale-${roas}-${pct}`, category: 'Scaling', icon: '🚀', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  name: `Scale winners: ROAS ≥ ${roas}, budget +${pct}%`,
  desc: `When a campaign's 7-day ROAS ≥ ${roas} and it's spending ≥ 85% of its daily budget (capped), raise the daily budget +${pct}% within guardrails. Pours fuel on what's working.`,
  conditions: [{ field: 'campaign.roas', op: 'gte', value: roas }, { field: 'campaign.budgetUtilization', op: 'gte', value: 0.85 }],
  actions: [{ type: 'adjust_ad_budget', percent: pct, reason: `ROAS ≥ ${roas} & capped — budget +${pct}%` }, notify(`Budget +${pct}% on a capped ROAS-${roas} winner`)],
  maxExecutionsPerDay: 10, maxValueCentsEur: 50000, maxDailyAdSpendCentsEur: 20000,
})
const trim = (acosPct: number, pct: number): AutoTemplate => ({
  id: `trim-${acosPct}-${pct}`, category: 'Budget', icon: '🩹', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  name: `Trim budget: ACOS ≥ ${acosPct}%, −${pct}%`,
  desc: `When a campaign's 7-day ACOS ≥ ${acosPct}% with real spend, lower the daily budget −${pct}% to stem the bleed without fully pausing.`,
  conditions: [{ field: 'campaign.acos', op: 'gte', value: acosPct / 100 }, { field: 'campaign.spendCents', op: 'gte', value: 5000 }],
  actions: [{ type: 'adjust_ad_budget', percent: -pct, reason: `ACOS ≥ ${acosPct}% — budget −${pct}%` }, notify(`Budget −${pct}% — ACOS ${acosPct}%+`)],
  maxExecutionsPerDay: 10, maxValueCentsEur: 50000,
})
const harvest = (windowDays: number, minOrders: number, minSpendEur: number): AutoTemplate => ({
  id: `harvest-${windowDays}-${minOrders}-${minSpendEur}`, category: 'Harvesting', icon: '🌾', trigger: 'SCHEDULE',
  name: `Harvest & negate (${windowDays}d, ${minOrders}+ orders / €${minSpendEur} waste)`,
  desc: `Each run over a ${windowDays}-day window: promote search terms with ${minOrders}+ orders to exact-match keywords (recover free-converting traffic) and negate terms that spent €${minSpendEur}+ with zero orders (kill waste). The #1 PPC automation.`,
  conditions: [],
  actions: [{ type: 'harvest_and_negate', windowDays, minSpendCents: minSpendEur * 100, minOrders, graduationBidEur: 0.5 }, notify('Harvest & negate ran — see execution log')],
  maxExecutionsPerDay: 3,
})
const monthlyCap = (eur: number): AutoTemplate => ({
  id: `cap-${eur}`, category: 'Budget', icon: '⛔', trigger: 'SCHEDULE',
  name: `Monthly spend cap — €${eur.toLocaleString()}`,
  desc: `The instant your month-to-date ad spend hits €${eur.toLocaleString()}, pause ALL enabled campaigns. Guaranteed never-overspend failsafe. Resumes next month.`,
  conditions: [{ field: 'budget.monthlySpendCents', op: 'gte', value: eur * 100 }],
  actions: [{ type: 'pause_all_campaigns', reason: `Monthly cap €${eur} reached` }, notify(`⛔ Monthly cap €${eur} hit — all campaigns paused`)],
  maxExecutionsPerDay: 96,
})
const agedStock = (days: number): AutoTemplate => ({
  id: `aged-${days}`, category: 'Inventory defense', icon: '📦', trigger: 'FBA_AGE_THRESHOLD_REACHED',
  name: `Liquidate aged stock (≤${days}d to LTS)`,
  desc: `When an FBA SKU is within ${days} days of the long-term-storage band, pause the fresh-product ad group and spin up a 15%-off promo for 14 days — cut ad waste, accelerate clearance.`,
  conditions: [{ field: 'fbaAge.daysToLtsThreshold', op: 'lte', value: days }],
  actions: [{ type: 'pause_ad_group', reason: 'Aged-stock liquidation' }, { type: 'create_amazon_promotion', discountPct: 15, durationDays: 14, reason: 'Auto-promo for aged stock' }, notify(`Aged-stock play fired (≤${days}d to LTS)`)],
  maxExecutionsPerDay: 20, maxValueCentsEur: 50000, maxDailyAdSpendCentsEur: 10000,
})

// ── marquee headline automations ──────────────────────────────────────────
const MARQUEE: AutoTemplate[] = [
  {
    id: 'profit-bidding', category: 'Bidding', icon: '🎯', trigger: 'SCHEDULE', marquee: true,
    name: 'Profit-native bid optimisation',
    desc: 'Runs daily: nudges every keyword bid toward each product\'s true-profit ACOS target, with Bayesian smoothing for low-data keywords. Raises winners, cuts losers. This is the €500+/mo feature other tools sell — built in.',
    conditions: [],
    actions: [{ type: 'bid_to_target_acos', profitMode: true, bayesian: true, acosMode: 'profit' }, notify('Profit bid optimisation ran — see execution log')],
    maxExecutionsPerDay: 2,
  },
  {
    id: 'target-acos-bidding', category: 'Bidding', icon: '🎯', trigger: 'SCHEDULE', marquee: true,
    name: 'Target-ACOS bid optimisation',
    desc: 'Daily bid tuning toward a fixed ACOS target (not profit-based) with Bayesian smoothing — for when you manage to a revenue/ACOS goal rather than margin.',
    conditions: [],
    actions: [{ type: 'bid_to_target_acos', profitMode: false, bayesian: true, acosMode: 'fixed' }, notify('Target-ACOS bid optimisation ran')],
    maxExecutionsPerDay: 2,
  },
  {
    id: 'retail-guard', category: 'Retail defense', icon: '🛡', trigger: 'SCHEDULE', marquee: true,
    name: 'Retail guard (out-of-stock / Buy Box)',
    desc: 'Every 15 min: auto-pause campaigns advertising out-of-stock products or products that lost the Buy Box — never pay for traffic you can\'t convert — and resume when they\'re sellable again.',
    conditions: [],
    actions: [{ type: 'retail_guard' }, notify('Retail guard adjusted campaigns — see log')],
    maxExecutionsPerDay: 96,
  },
  harvest(60, 2, 10),
  monthlyCap(2000),
  {
    id: 'negative-margin-alert', category: 'Alerts', icon: '🚨', trigger: 'AD_SPEND_PROFITABILITY_BREACH', marquee: true,
    name: 'Alert: ad spend beat true profit',
    desc: 'Notifies you when a campaign\'s 30-day ad spend exceeds the true profit of the products it advertises. Notify-only — you choose the fix.',
    conditions: [{ field: 'profit.netCents', op: 'lt', value: 0 }],
    actions: [notify('Ad spend > true profit (30d) — review this campaign')],
    maxExecutionsPerDay: 10,
  },
  {
    id: 'negative-margin-defend', category: 'Profit guard', icon: '🛟', trigger: 'AD_SPEND_PROFITABILITY_BREACH',
    name: 'Defend margin: bid down on profit breach',
    desc: 'When a campaign\'s ad spend exceeds the true profit it generates, auto bid-down −20% to pull it back toward profitability (not just an alert).',
    conditions: [{ field: 'profit.netCents', op: 'lt', value: 0 }],
    actions: [{ type: 'bid_down', target: 'ad_group', percent: 20, reason: 'Negative ad margin — bid −20%' }, notify('Bid −20% — campaign was margin-negative')],
    maxExecutionsPerDay: 20,
  },
]

export const CATALOG: AutoTemplate[] = [
  ...MARQUEE,
  // Bidding — ACOS-defensive presets
  bidDown(35, 10), bidDown(45, 15), bidDown(55, 15), bidDown(65, 20), bidDown(80, 25), bidDown(100, 30),
  // Pruning — wasted-spend presets
  prune(10, 0), prune(15, 0), prune(20, 0), prune(30, 0), prune(50, 0), prune(75, 0), prune(25, 1), prune(50, 1),
  // Scaling — winner presets
  scale(3, 10), scale(3, 15), scale(4, 15), scale(4, 20), scale(5, 20), scale(5, 25),
  // Budget — trim presets
  trim(30, 10), trim(40, 15), trim(50, 20),
  // Budget — caps
  monthlyCap(500), monthlyCap(1000), monthlyCap(5000), monthlyCap(10000),
  // Harvesting — window/threshold presets
  harvest(30, 1, 5), harvest(30, 2, 10), harvest(90, 3, 15), harvest(14, 1, 8),
  // Inventory defense
  agedStock(7), agedStock(14), agedStock(21),
]

export const CATEGORIES = ['All', ...Array.from(new Set(CATALOG.map((t) => t.category)))]
export const CATALOG_COUNT = CATALOG.length
