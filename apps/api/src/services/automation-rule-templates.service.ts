/**
 * W4.4 — Pre-built automation rule templates.
 *
 * Eight rules covering the most-requested replenishment automations.
 * All seed as enabled=false + dryRun=true so the operator reviews
 * each one in the rule builder before activating. Idempotent — keyed
 * on (name, domain) so re-running the seeder is safe.
 *
 * Categories:
 *   1. AUTO-APPROVE small orders                — replaces R.6's env vars
 *   2. AUTO-GENERATE PO from approved           — frees R.7 transition
 *   3. STOCKOUT EMERGENCY RESPONSE              — speed > cost when empty
 *   4. DEMAND SPIKE DETECTION                   — flag for human review
 *   5. OVERSTOCK PROTECTION                     — pause auto-reorder
 *   6. AUTO-REBALANCE across locations          — cross-warehouse hint
 *   7. AUTO-MARKDOWN slow movers                — handoff to /pricing
 *   8. AUTO-DISPOSAL dead stock                 — write-off candidate
 *
 * The conditions DSL references trigger-payload fields the evaluator
 * is expected to populate (e.g. context.recommendation.totalCents).
 * Evaluator-side population is W4.6+; today these templates are
 * structurally complete and pass schema validation.
 */

import prisma from '../db.js'

export interface AutomationRuleTemplate {
  name: string
  description: string
  domain: string
  trigger: string
  conditions: object[]
  actions: object[]
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
}

export const TEMPLATES: AutomationRuleTemplate[] = [
  {
    name: 'Auto-approve small orders',
    description:
      'Recommendation under €500 from a trusted supplier (>1y, >95% on-time) and SKU has >180d order history. Replaces R.6 env-var ceilings with operator-tunable rule.',
    domain: 'replenishment',
    trigger: 'recommendation_generated',
    conditions: [
      { field: 'recommendation.totalCents', op: 'lt', value: 50000 },
      { field: 'supplier.onTimeRate', op: 'gte', value: 0.95 },
      { field: 'supplier.relationshipMonths', op: 'gte', value: 12 },
      { field: 'product.daysOfHistory', op: 'gte', value: 180 },
    ],
    actions: [
      { type: 'auto_approve_recommendation' },
      { type: 'notify', target: 'operator', message: 'Auto-approved small recommendation' },
    ],
    maxExecutionsPerDay: 50,
    maxValueCentsEur: 100000, // €1,000/day cap as a safety net
  },
  {
    name: 'Auto-generate PO from auto-approved recommendations',
    description:
      'After a recommendation has been auto-approved (status=ACTED via rule 1) and the supplier has autoTriggerEnabled, create a one-line DRAFT PO. Lands in /fulfillment/purchase-orders for R.7 review/approve/submit. Standalone PO per rule firing — no batch grouping with other recs.',
    domain: 'replenishment',
    trigger: 'recommendation_generated',
    conditions: [
      { field: 'recommendation.totalCents', op: 'lt', value: 50000 },
      { field: 'supplier.autoTriggerEnabled', op: 'eq', value: true },
      { field: 'product.abcClass', op: 'in', value: ['A', 'B'] },
    ],
    actions: [
      { type: 'create_po_from_recommendation' },
      {
        type: 'notify',
        target: 'operator',
        message: 'Auto-generated DRAFT PO from rule trigger',
      },
    ],
    maxExecutionsPerDay: 100,
    maxValueCentsEur: 2000000, // €20K/day matches R.6 default ceiling
  },
  {
    name: 'Stockout emergency response',
    description:
      'A-class SKU stockout imminent (<3d cover) with a backup supplier available. Premium price acceptable to keep revenue flowing.',
    domain: 'replenishment',
    trigger: 'stockout_imminent',
    conditions: [
      { field: 'recommendation.urgency', op: 'in', value: ['CRITICAL'] },
      { field: 'product.abcClass', op: 'eq', value: 'A' },
      { field: 'product.daysOfStockLeft', op: 'lt', value: 3 },
      { field: 'supplier.backupAvailable', op: 'eq', value: true },
    ],
    actions: [
      { type: 'create_po', supplierStrategy: 'fastest' },
      { type: 'notify', target: 'operator', message: 'Emergency PO triggered for A-class stockout risk' },
    ],
    maxExecutionsPerDay: 20,
    maxValueCentsEur: 500000, // €5K/day per emergency
  },
  {
    name: 'Demand spike detection',
    description:
      '7-day velocity >2x trailing baseline with confidence interval excluding baseline. Alert only — operator decides whether to adjust the forecast or stock up.',
    domain: 'replenishment',
    trigger: 'demand_spike_detected',
    conditions: [
      { field: 'spike.velocityRatio', op: 'gte', value: 2.0 },
      { field: 'spike.confidenceExcludesBaseline', op: 'eq', value: true },
    ],
    actions: [
      {
        type: 'notify',
        target: 'operator',
        message: 'Demand spike detected — review forecast for adjustment',
      },
    ],
    maxExecutionsPerDay: 50,
    maxValueCentsEur: null,
  },
  {
    name: 'Overstock protection',
    description:
      'Days of inventory >180 with declining trend pauses auto-reorder for that SKU and suggests review. Prevents working capital from getting trapped on slow movers.',
    domain: 'replenishment',
    trigger: 'recommendation_generated',
    conditions: [
      { field: 'product.daysOfStockLeft', op: 'gt', value: 180 },
      { field: 'product.velocityTrend', op: 'lt', value: 0 },
    ],
    actions: [
      { type: 'log_only', tag: 'OVERSTOCK_PAUSE' },
      { type: 'notify', target: 'operator', message: 'Overstock detected — auto-reorder paused' },
    ],
    maxExecutionsPerDay: 100,
    maxValueCentsEur: null,
  },
  {
    name: 'Auto-rebalance across locations',
    description:
      'Stock imbalance >50% across active locations triggers a transfer recommendation. Avoids stockout in one warehouse while another has surplus.',
    domain: 'replenishment',
    trigger: 'imbalance_detected',
    conditions: [
      { field: 'imbalance.ratio', op: 'gte', value: 0.5 },
      { field: 'imbalance.surplusLocation', op: 'exists' },
      { field: 'imbalance.shortageLocation', op: 'exists' },
    ],
    actions: [
      { type: 'log_only', tag: 'TRANSFER_SUGGESTED' },
      { type: 'notify', target: 'operator', message: 'Cross-location transfer recommended' },
    ],
    maxExecutionsPerDay: 30,
    maxValueCentsEur: null,
  },
  {
    name: 'Auto-markdown slow movers',
    description:
      'Days of inventory >120 with declining velocity suggests a 10% markdown to /pricing. Hand-off only; pricing rules engine decides whether to apply.',
    domain: 'replenishment',
    trigger: 'cron_tick',
    conditions: [
      { field: 'product.daysOfStockLeft', op: 'gt', value: 120 },
      { field: 'product.velocityTrend', op: 'lt', value: 0 },
      { field: 'product.abcClass', op: 'in', value: ['B', 'C'] },
    ],
    actions: [
      { type: 'log_only', tag: 'MARKDOWN_SUGGESTED', percentDiscount: 10 },
      { type: 'notify', target: 'operator', message: 'Slow-mover markdown suggested (10%)' },
    ],
    maxExecutionsPerDay: 50,
    maxValueCentsEur: null,
  },
  {
    name: 'Auto-disposal dead stock',
    description:
      'No movement in 365 days with no future demand suggests a write-off. Surfaces to /reports → tax/inventory write-off workflow. Never executes — operator confirms.',
    domain: 'replenishment',
    trigger: 'cron_tick',
    conditions: [
      { field: 'product.daysSinceLastMovement', op: 'gte', value: 365 },
      { field: 'product.forecastedDemand90d', op: 'eq', value: 0 },
      { field: 'product.abcClass', op: 'eq', value: 'D' },
    ],
    actions: [
      { type: 'log_only', tag: 'DISPOSAL_CANDIDATE' },
      { type: 'notify', target: 'operator', message: 'Dead-stock disposal candidate' },
    ],
    maxExecutionsPerDay: 20,
    maxValueCentsEur: null,
  },
]

export interface SeedTemplatesResult {
  created: string[]
  skippedExisting: string[]
}

/**
 * Idempotent seeder. For each template, looks up by (name, domain)
 * and creates if missing. Existing rules are NEVER modified — the
 * operator may have customised them, and the seeder shouldn't
 * trample local edits. Use the explicit 'reset to template' button
 * (W4.5) to re-apply a template's defaults.
 */
export async function seedAutomationRuleTemplates(): Promise<SeedTemplatesResult> {
  const created: string[] = []
  const skippedExisting: string[] = []

  for (const tmpl of TEMPLATES) {
    const existing = await prisma.automationRule.findFirst({
      where: { name: tmpl.name, domain: tmpl.domain },
      select: { id: true },
    })
    if (existing) {
      skippedExisting.push(tmpl.name)
      continue
    }
    await prisma.automationRule.create({
      data: {
        name: tmpl.name,
        description: tmpl.description,
        domain: tmpl.domain,
        trigger: tmpl.trigger,
        conditions: tmpl.conditions as object,
        actions: tmpl.actions as object,
        enabled: false, // operator must opt in
        dryRun: true, // opt in to side effects
        maxExecutionsPerDay: tmpl.maxExecutionsPerDay,
        maxValueCentsEur: tmpl.maxValueCentsEur,
        createdBy: 'template-seeder',
      },
    })
    created.push(tmpl.name)
  }

  return { created, skippedExisting }
}
