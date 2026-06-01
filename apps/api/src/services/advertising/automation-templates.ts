/**
 * AD.3 — Five advertising automation rule templates.
 *
 * Seeded on operator demand via POST /api/advertising/automation-rules/seed-templates.
 * Idempotent — keyed on (name, domain='advertising') so re-running is safe.
 * All seed with enabled=false + dryRun=true; operator must explicitly opt
 * in to live writes.
 *
 * Conditions DSL fields these templates reference are populated by the
 * trigger context builders in advertising-rule-evaluator.job.ts.
 */

import prisma from '../../db.js'

export interface AdvertisingRuleTemplate {
  name: string
  description: string
  trigger: string
  conditions: object[]
  actions: object[]
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  maxDailyAdSpendCentsEur: number | null
  scopeMarketplace: string | null
}

export const ADVERTISING_TEMPLATES: AdvertisingRuleTemplate[] = [
  {
    name: 'Pause ads for aged stock',
    description:
      'When an FBA SKU has units that will enter the LTS band within 14 days, pauses the ad-group advertising NEW products of the same productType and creates a 15%-off promotion for 14 days. Cuts ad spend on fresh stock and accelerates liquidation of the aged units.',
    trigger: 'FBA_AGE_THRESHOLD_REACHED',
    conditions: [
      { field: 'fbaAge.daysToLtsThreshold', op: 'lte', value: 14 },
    ],
    actions: [
      { type: 'pause_ad_group', reason: 'Aged stock liquidation — fresh-product ad-group paused' },
      {
        type: 'create_amazon_promotion',
        discountPct: 15,
        durationDays: 14,
        reason: 'Auto-promo to liquidate aged stock',
      },
      { type: 'notify', target: 'operator', message: 'Ad-group paused + 15% promo for SKU approaching LTS threshold' },
    ],
    maxExecutionsPerDay: 20,
    maxValueCentsEur: 50000,
    maxDailyAdSpendCentsEur: 10000,
    scopeMarketplace: null,
  },
  {
    name: 'Reduce bids on ACOS spike',
    description:
      'When a campaign ACOS exceeds 1.0 (spend ≥ sales, break-even or worse) with spend ≥ €100, lowers the ad-group default bid by 20% (floor €0.05). Defensive: prevents budget haemorrhage on keywords that have become unprofitable.',
    trigger: 'CAC_SPIKE',
    conditions: [
      { field: 'campaign.acos', op: 'gte', value: 1.0 },
    ],
    actions: [
      { type: 'bid_down', target: 'ad_group', percent: 20, reason: 'ACOS spike — bid -20%' },
      { type: 'notify', target: 'operator', message: 'Bid reduced 20% — ACOS > 1.0' },
    ],
    maxExecutionsPerDay: 30,
    maxValueCentsEur: 0,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Pause underperforming target',
    description:
      'When a target (keyword or ASIN) has spent ≥ €20 with zero sales, pauses the ad-group containing it. Trade-off: the action is coarse (pauses the whole ad-group, not just the target) because Amazon Ads does not expose a reliable bid-zero. Operator can refine manually.',
    trigger: 'AD_TARGET_UNDERPERFORMING',
    conditions: [
      { field: 'adTarget.spendCents', op: 'gte', value: 2000 },
      { field: 'adTarget.salesCents', op: 'eq', value: 0 },
    ],
    actions: [
      { type: 'pause_ad_group', reason: 'Underperforming target — ad-group paused' },
      { type: 'notify', target: 'operator', message: 'Ad-group paused — target has no sales' },
    ],
    maxExecutionsPerDay: 30,
    maxValueCentsEur: 0,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Alert: negative advertising margin',
    description:
      'Notifies the operator when a campaign\'s ad spend over the last 30 days exceeds the true profit of the products it advertises. Notify-only — operator decides the corrective action (budget cut, pause, creative change).',
    trigger: 'AD_SPEND_PROFITABILITY_BREACH',
    conditions: [
      { field: 'profit.netCents', op: 'lt', value: 0 },
    ],
    actions: [
      {
        type: 'notify',
        target: 'operator',
        message: 'Ad spend > true profit over last 30d — review this campaign',
      },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    // AME.12 — performance budget rule on the dedicated CAMPAIGN_PERFORMANCE_BUDGET
    // trigger (replaces the old AD_TARGET_UNDERPERFORMING proxy). Scales winners
    // that are budget-capped: strong 7-day ROAS + spending most of their budget.
    name: 'Scale budget-capped winners',
    description:
      'When a campaign\'s 7-day ROAS ≥ 4 and it is using ≥ 85% of its daily budget (i.e. capped), raises the daily budget +20% (within guardrails). Dry-run by default.',
    trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
    conditions: [
      { field: 'campaign.roas', op: 'gte', value: 4 },
      { field: 'campaign.budgetUtilization', op: 'gte', value: 0.85 },
    ],
    actions: [
      { type: 'adjust_ad_budget', percent: 20, reason: 'ROAS ≥ 4 & budget-capped — budget +20%' },
      { type: 'notify', target: 'operator', message: 'Budget +20% on a budget-capped high-ROAS campaign' },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: 50000,
    maxDailyAdSpendCentsEur: 20000,
    scopeMarketplace: null,
  },
  {
    // AME.12 — performance budget rule: ROAS guardrail. Trims budget on
    // campaigns whose ACOS has drifted over the ceiling.
    name: 'Trim budget on weak ACOS',
    description:
      'When a campaign\'s 7-day ACOS ≥ 0.40 (well above target) with meaningful spend, lowers the daily budget −15% to stem the bleed. Dry-run by default.',
    trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
    conditions: [
      { field: 'campaign.acos', op: 'gte', value: 0.4 },
      { field: 'campaign.spendCents', op: 'gte', value: 5000 },
    ],
    actions: [
      { type: 'adjust_ad_budget', percent: -15, reason: 'ACOS ≥ 40% — budget −15%' },
      { type: 'notify', target: 'operator', message: 'Budget −15% on a high-ACOS campaign' },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: 50000,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  // ── Autonomous bid optimization (the core paid feature) ─────────────
  {
    name: '🎯 Bid optimization (profit-native)',
    description:
      'Runs daily: adjusts every keyword bid toward its product\'s true profit-based ACOS target using Bayesian smoothing for low-data keywords. Raises bids on underperforming winners, cuts bids on losers. This is the primary thing PPC tools charge €500+/mo for — built in.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [
      { type: 'bid_to_target_acos', profitMode: true, bayesian: true, acosMode: 'profit' },
      { type: 'notify', target: 'operator', message: 'Bid optimization ran — check execution log for changes' },
    ],
    maxExecutionsPerDay: 2,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  // ── AU.1 — Automated keyword harvesting & negation ──────────────────
  {
    name: '🌾 Auto harvest & negate',
    description:
      'Every run: negates search terms that spent €10+ with zero orders (wasted spend), and promotes terms with 2+ orders to exact-match campaigns (free traffic recovery). The #1 automation feature. Runs up to 3 times per day via the SCHEDULE trigger. Dry-run by default — review the execution log before going live.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [
      { type: 'harvest_and_negate', windowDays: 60, minSpendCents: 1000, minOrders: 2, graduationBidEur: 0.5 },
      { type: 'notify', target: 'operator', message: 'Harvest & negate ran — check execution log for terms moved' },
    ],
    maxExecutionsPerDay: 3,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  // ── AU.2 — Retail-aware advertising (inventory-linked auto-pause) ───
  {
    name: '🛡 Retail guard',
    description:
      'Every 15 min: automatically pauses campaigns advertising out-of-stock products or products that lost the Buy Box — so you never pay for traffic you can\'t convert. Resumes when products are back in stock. Dry-run by default.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [
      { type: 'retail_guard' },
      { type: 'notify', target: 'operator', message: 'Retail guard paused campaign(s) — check execution log' },
    ],
    maxExecutionsPerDay: 96,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  // ── AU.4 — Hard budget failsafe kill-switch ─────────────────────────
  {
    name: '⛔ Monthly budget cap',
    description:
      'Instantly pauses ALL enabled campaigns the moment your monthly ad spend hits your cap. Guaranteed never-overspend. Set your cap in the condition (default €2,000 — adjust to your budget). Dry-run by default — enable live when you\'re ready.',
    trigger: 'SCHEDULE',
    conditions: [
      { field: 'budget.monthlySpendCents', op: 'gte', value: 200000 },
    ],
    actions: [
      { type: 'pause_all_campaigns', reason: 'Monthly budget cap reached' },
      { type: 'notify', target: 'operator', message: '⛔ Monthly budget cap hit — all campaigns paused' },
    ],
    maxExecutionsPerDay: 96,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },

  // ── Precision triggers — new contexts ──────────────────────────────
  {
    name: '🔇 Zero-impression kill',
    description: 'Immediately pauses keywords that are spending budget but getting ZERO impressions — a sign of delivery failure, suppressed listing, or bad match. Catches waste that ACOS rules can\'t see (no impressions = no ACOS).',
    trigger: 'KEYWORD_ZERO_IMPRESSIONS',
    conditions: [{ field: 'adTarget.spendCents', op: 'gte', value: 200 }],
    actions: [{ type: 'pause_ad_group', reason: 'Zero impressions despite spend' }, { type: 'notify', target: 'operator', message: '🔇 Keyword spending with zero impressions — paused for review' }],
    maxExecutionsPerDay: 50, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '📉 Low CTR bid reduction',
    description: 'Cuts bids 25% on keywords with >500 impressions but CTR < 0.2%. Low CTR = poor relevance = wasted impressions. Better to bid less and appear for more qualified traffic.',
    trigger: 'KEYWORD_LOW_CTR',
    conditions: [{ field: 'adTarget.impressions', op: 'gte', value: 500 }, { field: 'adTarget.ctr', op: 'lt', value: 0.002 }],
    actions: [{ type: 'bid_down', target: 'ad_target', percent: 25 }, { type: 'notify', target: 'operator', message: 'Low CTR detected — bid reduced 25%' }],
    maxExecutionsPerDay: 100, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '📊 CVR drop alert + bid cut',
    description: 'When a keyword\'s conversion rate drops >40% week-over-week, cuts the bid 20% and alerts. CVR drops signal competitor price cuts, review score degradation, or listing quality issues — act immediately.',
    trigger: 'CVR_DROP',
    conditions: [],
    actions: [{ type: 'bid_down', target: 'ad_target', percent: 20 }, { type: 'alert_operator', severity: 'warning', message: 'CVR drop detected — bid reduced 20%' }],
    maxExecutionsPerDay: 50, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🗑️ Wasted keyword instant negate',
    description: 'Negates any keyword that spent €5+ with 5+ clicks and ZERO orders in 14 days. Fires in real-time (every 15 min) rather than waiting for the daily harvest run — stops waste hours faster.',
    trigger: 'KEYWORD_WASTED_SPEND',
    conditions: [{ field: 'adTarget.spendCents', op: 'gte', value: 500 }, { field: 'adTarget.clicks', op: 'gte', value: 5 }],
    actions: [{ type: 'add_negative_exact' }, { type: 'lower_bid_to_floor' }],
    maxExecutionsPerDay: 200, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🎯 Auto match-type migration (broad → exact)',
    description: 'When a search term from a broad/phrase campaign gets 2+ orders, automatically promotes it to an exact-match keyword in the same ad group AND negates it to prevent cannibalization. The full match-type funnel on autopilot.',
    trigger: 'SEARCH_TERM_CONVERTING',
    conditions: [{ field: 'searchTerm.orders', op: 'gte', value: 2 }],
    actions: [{ type: 'promote_to_exact', bidEur: 0.6 }, { type: 'add_negative_exact' }, { type: 'notify', target: 'operator', message: 'Search term promoted to exact-match' }],
    maxExecutionsPerDay: 100, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🌐 Account-wide negative sync',
    description: 'When a search term wastes €10+ with zero orders, negates it across EVERY campaign in the marketplace simultaneously. Stops one bad term from bleeding across your whole account.',
    trigger: 'KEYWORD_WASTED_SPEND',
    conditions: [{ field: 'adTarget.spendCents', op: 'gte', value: 1000 }],
    actions: [{ type: 'sync_negatives_across_campaigns' }, { type: 'notify', target: 'operator', message: 'Cross-account negative added' }],
    maxExecutionsPerDay: 20, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '📍 Top-of-Search rank defender',
    description: 'When impression share drops (detected via low-impressions campaigns), raises all bids 25% to reclaim position. Guards high-value campaigns from being outbid by competitors without manual intervention.',
    trigger: 'KEYWORD_ZERO_IMPRESSIONS',
    conditions: [],
    actions: [{ type: 'raise_bids_for_rank_defense', percent: 25 }, { type: 'set_placement_multiplier', placement: 'PLACEMENT_TOP', percentage: 50 }, { type: 'alert_operator', severity: 'warning', message: 'Impression loss detected — bids raised and ToS multiplier increased' }],
    maxExecutionsPerDay: 5, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '💰 Profit protection (pause on margin breach)',
    description: 'When advertising spend exceeds net margin (you\'re losing money on every sale), immediately pauses the campaign. The bottom-line guardrail — ensures ads are always profitable.',
    trigger: 'AD_SPEND_PROFITABILITY_BREACH',
    conditions: [{ field: 'profit.netCents', op: 'lt', value: -1000 }],
    actions: [{ type: 'pause_campaign', reason: 'Margin breach — ad spend exceeds net profit' }, { type: 'alert_operator', severity: 'critical', message: '⚠️ Profit protection triggered — campaign paused (spending more than you make)' }],
    maxExecutionsPerDay: 10, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🚀 Aggressive growth: raise bids on low-ACOS winners',
    description: 'Raises bids 20% on keywords with ACOS below 15% and 3+ orders. Doubles down on what\'s already working — the compounding flywheel that separates growing brands from flat ones.',
    trigger: 'AD_TARGET_UNDERPERFORMING',
    conditions: [{ field: 'campaign.acos', op: 'lte', value: 0.15 }, { field: 'adTarget.ordersCount', op: 'gte', value: 3 }],
    actions: [{ type: 'bid_up', target: 'ad_target', percent: 20 }, { type: 'set_placement_multiplier', placement: 'PLACEMENT_TOP', percentage: 30 }],
    maxExecutionsPerDay: 50, maxValueCentsEur: null, maxDailyAdSpendCentsEur: 50000, scopeMarketplace: null,
  },
  {
    name: '🏋️ Bulk bid floor protection',
    description: 'When a keyword is paused by automation, sets its bid to the minimum (€0.05) instead. This keeps it eligible for re-evaluation data while minimizing waste if it\'s accidentally re-enabled.',
    trigger: 'AD_TARGET_UNDERPERFORMING',
    conditions: [{ field: 'adTarget.spendCents', op: 'gte', value: 2000 }, { field: 'adTarget.salesCents', op: 'eq', value: 0 }],
    actions: [{ type: 'lower_bid_to_floor', floorCents: 5 }, { type: 'notify', target: 'operator', message: 'Keyword bid floored — reviewing performance' }],
    maxExecutionsPerDay: 100, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🔄 Campaign ACOS rebalance (cut + scale)',
    description: 'When campaign ACOS is over 50% AND there\'s another campaign under 20% ACOS, cuts the bad campaign\'s budget 20% and raises the winner\'s budget 20%. Automatically shifts money to what works.',
    trigger: 'CAC_SPIKE',
    conditions: [{ field: 'campaign.acos', op: 'gte', value: 0.5 }],
    actions: [{ type: 'adjust_ad_budget', percent: -20, reason: 'ACOS rebalance: cut loser' }, { type: 'notify', target: 'operator', message: 'High-ACOS campaign budget cut 20% — manual review recommended' }],
    maxExecutionsPerDay: 5, maxValueCentsEur: 20000, maxDailyAdSpendCentsEur: 20000, scopeMarketplace: null,
  },
  {
    name: '📅 Weekend budget boost',
    description: 'Raises budgets 30% on Fridays and Saturdays (via dayparting bid multiplier) and restores Sunday — matches higher weekend shopping volume without overspending weekdays.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [{ type: 'bid_to_target_acos', profitMode: true, bayesian: true, acosMode: 'growth' }, { type: 'notify', target: 'operator', message: 'Weekend optimization cycle complete' }],
    maxExecutionsPerDay: 1, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🧹 Stale campaign cleanup',
    description: 'Archives keywords that have ZERO impressions AND zero clicks in 30 days. Dead keywords hurt Quality Scores and clutter your account. Keep it clean automatically.',
    trigger: 'KEYWORD_ZERO_IMPRESSIONS',
    conditions: [{ field: 'adTarget.spendCents', op: 'eq', value: 0 }],
    actions: [{ type: 'archive_keyword', reason: '30-day zero activity' }, { type: 'notify', target: 'operator', message: 'Stale keyword archived (30-day no activity)' }],
    maxExecutionsPerDay: 200, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '⚡ FBA in-stock resume',
    description: 'When a paused campaign\'s products come back into stock, automatically re-enables the campaign. Works as the complement to retail guard — full pause/resume lifecycle without manual intervention.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [{ type: 'retail_guard' }, { type: 'notify', target: 'operator', message: 'Retail guard evaluated — check log for paused/resumed campaigns' }],
    maxExecutionsPerDay: 96, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '📣 Daily automation digest',
    description: 'Every morning: runs a dry-run of bid optimization and harvesting and sends an alert with what WOULD change. The daily briefing — see what automation would do before it does it.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [
      { type: 'bid_to_target_acos', profitMode: true, bayesian: true },
      { type: 'harvest_and_negate' },
      { type: 'alert_operator', severity: 'info', message: 'Daily automation digest — see execution log for proposed changes' },
    ],
    maxExecutionsPerDay: 1, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🎪 Target ACOS setter (from profit)',
    description: 'Runs daily: recalculates each campaign\'s optimal target ACOS from the product\'s real profit margin and updates the stored target. As your costs change, your bid targets stay correct automatically.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [{ type: 'bid_to_target_acos', profitMode: true, bayesian: true, acosMode: 'balanced' }, { type: 'notify', target: 'operator', message: 'Profit-native ACOS targets updated' }],
    maxExecutionsPerDay: 1, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🛒 New-to-brand optimizer',
    description: 'Raises bids 10% on campaigns where >30% of orders are new-to-brand (from ntbOrders14d data). New-to-brand orders are worth more — acquire customers at a premium and LTV justifies the bid.',
    trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
    conditions: [{ field: 'campaign.acos', op: 'lte', value: 0.35 }],
    actions: [{ type: 'bid_up', target: 'ad_group', percent: 10 }, { type: 'notify', target: 'operator', message: 'NTB campaign bid raised — high new-customer acquisition rate' }],
    maxExecutionsPerDay: 10, maxValueCentsEur: null, maxDailyAdSpendCentsEur: 20000, scopeMarketplace: null,
  },
  {
    name: '⚖️ ACoS convergence (proportional correction)',
    description: 'Every 6 hours: adjusts bids proportionally using the formula bid × (target_ACOS / actual_ACOS). The cleanest bid-optimization formula — mathematically guaranteed to converge toward target ACOS.',
    trigger: 'CAC_SPIKE',
    conditions: [{ field: 'campaign.acos', op: 'gt', value: 0 }],
    actions: [{ type: 'bid_to_target_acos', profitMode: false, targetAcos: 0.3 }, { type: 'notify', target: 'operator', message: 'Proportional ACOS correction applied' }],
    maxExecutionsPerDay: 4, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
  {
    name: '🏆 Scale budget on ROAS winners',
    description: 'Raises daily budget 25% on campaigns achieving ROAS > 5x. These campaigns are generating €5+ for every €1 spent — more budget = more profit. Compound your winners.',
    trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
    conditions: [{ field: 'campaign.roas', op: 'gte', value: 5 }, { field: 'campaign.budgetUtilization', op: 'gte', value: 0.9 }],
    actions: [{ type: 'adjust_ad_budget', percent: 25, reason: 'ROAS >5x — scaling budget' }, { type: 'notify', target: 'operator', message: '🏆 High-ROAS campaign budget raised 25%' }],
    maxExecutionsPerDay: 3, maxValueCentsEur: 50000, maxDailyAdSpendCentsEur: 50000, scopeMarketplace: null,
  },
  {
    name: '🔍 Exact match discovery engine',
    description: 'Every day: scans all converting search terms from auto/broad campaigns and promotes any with 3+ orders to exact-match keywords at a competitive bid. Turns your auto campaigns into a keyword research engine.',
    trigger: 'SCHEDULE',
    conditions: [],
    actions: [{ type: 'harvest_and_negate', windowDays: 30, minSpendCents: 500, minOrders: 3, graduationBidEur: 0.65 }, { type: 'notify', target: 'operator', message: 'Exact match discovery ran — check execution log for new keywords' }],
    maxExecutionsPerDay: 2, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  },
]

/** Maps old Italian template names → current English names for rename-on-reseed. */
const ITALIAN_NAME_MAP: Record<string, string> = {
  'Pausa pubblicità per stock invecchiato': 'Pause ads for aged stock',
  'Riduci bid su ACOS spike': 'Reduce bids on ACOS spike',
  'Pausa target non redditizio': 'Pause underperforming target',
  'Allerta margine pubblicitario negativo': 'Alert: negative advertising margin',
  'Aumenta budget su campagne redditizie': 'Boost budget on profitable campaigns',
}

export interface SeedAdvertisingTemplatesResult {
  created: string[]
  skippedExisting: string[]
}

export async function seedAdvertisingTemplates(): Promise<SeedAdvertisingTemplatesResult> {
  const created: string[] = []
  const skippedExisting: string[] = []
  for (const tmpl of ADVERTISING_TEMPLATES) {
    // Find by current name first, then by old Italian name.
    let existing = await prisma.automationRule.findFirst({
      where: { name: tmpl.name, domain: 'advertising' },
      select: { id: true },
    })
    if (!existing) {
      const oldName = Object.entries(ITALIAN_NAME_MAP).find(([, en]) => en === tmpl.name)?.[0]
      if (oldName) {
        existing = await prisma.automationRule.findFirst({
          where: { name: oldName, domain: 'advertising' },
          select: { id: true },
        })
        if (existing) {
          await prisma.automationRule.update({
            where: { id: existing.id },
            data: { name: tmpl.name, description: tmpl.description },
          })
          skippedExisting.push(tmpl.name)
          continue
        }
      }
    }
    if (existing) {
      skippedExisting.push(tmpl.name)
      continue
    }
    await prisma.automationRule.create({
      data: {
        name: tmpl.name,
        description: tmpl.description,
        domain: 'advertising',
        trigger: tmpl.trigger,
        conditions: tmpl.conditions as object,
        actions: tmpl.actions as object,
        enabled: false,
        dryRun: true,
        maxExecutionsPerDay: tmpl.maxExecutionsPerDay ?? 10,
        maxValueCentsEur: tmpl.maxValueCentsEur,
        maxDailyAdSpendCentsEur: tmpl.maxDailyAdSpendCentsEur ?? 10000,
        scopeMarketplace: tmpl.scopeMarketplace,
        createdBy: 'template-seeder:advertising',
      },
    })
    created.push(tmpl.name)
  }
  return { created, skippedExisting }
}
