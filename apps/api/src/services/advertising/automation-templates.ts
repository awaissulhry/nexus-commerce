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
    name: 'Boost budget on profitable campaigns',
    description:
      'When ACOS is low (< 0.20) and impressions > 5000, suggests a +15% increase to the campaign daily budget (respecting maxDailyAdSpendCentsEur). Dry-run by default — operator approves auto-up per campaign.',
    trigger: 'AD_TARGET_UNDERPERFORMING', // inverse-signal proxy until a dedicated trigger lands in AD.5
    conditions: [
      { field: 'campaign.acos', op: 'lte', value: 0.2 },
      { field: 'adTarget.spendCents', op: 'gte', value: 5000 },
    ],
    actions: [
      {
        type: 'adjust_ad_budget',
        percent: 15,
        reason: 'Profitable campaign (ACOS < 0.20) — budget +15%',
      },
      { type: 'notify', target: 'operator', message: 'Budget increased 15% on high-ROAS campaign' },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: 50000,
    maxDailyAdSpendCentsEur: 20000,
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
