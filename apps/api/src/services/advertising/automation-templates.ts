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
