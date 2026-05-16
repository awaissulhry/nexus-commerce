/**
 * SR.3 — Three advertising-domain review automation rule templates.
 *
 * Seeded via POST /api/reviews/automation-rules/seed-templates.
 * Idempotent — keyed on (name, domain='reviews'). All seed with
 * enabled=false + dryRun=true.
 */

import prisma from '../../db.js'

export interface ReviewRuleTemplate {
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

export const REVIEW_TEMPLATES: ReviewRuleTemplate[] = [
  {
    name: 'Alert team on negative review spike',
    description:
      'Notifies the operator whenever a negative review spike is detected for any product × marketplace × category combination. Fires on any spike; customize conditions to filter by category or spike multiplier.',
    trigger: 'REVIEW_SPIKE_DETECTED',
    conditions: [],
    actions: [
      {
        type: 'notify',
        target: 'operator',
        message: 'Negative review spike detected — check the Spikes feed for details',
      },
    ],
    maxExecutionsPerDay: 50,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Auto-update bullets on quality spike',
    description:
      'When a review spike is detected, uses AI (Claude Haiku) to draft 5 improved product bullet points that address the spike category. Output is stored in the execution log — operator reviews and applies manually. In live mode, also creates an A+ Content DRAFT record.',
    trigger: 'REVIEW_SPIKE_DETECTED',
    conditions: [],
    actions: [
      {
        type: 'update_product_bullets_from_review',
        reason: 'Review spike — regenerate bullets to address customer concern',
      },
      {
        type: 'notify',
        target: 'operator',
        message: 'AI bullet suggestions generated from review spike — review execution log',
      },
    ],
    maxExecutionsPerDay: 20,
    maxValueCentsEur: 0,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Create A+ module from review spike',
    description:
      'When a significant review spike is detected (multiplier ≥ 2.5×), uses AI (Claude Haiku) to draft an A+ content module that proactively addresses the spike category. Stored as an A+ Content DRAFT in live mode. Operators approve before publishing.',
    trigger: 'REVIEW_SPIKE_DETECTED',
    conditions: [
      { field: 'spike.spikeMultiplier', op: 'gte', value: 2.5 },
    ],
    actions: [
      {
        type: 'create_aplus_module_from_review',
        reason: 'High-multiplier spike — generate A+ content response',
      },
      {
        type: 'notify',
        target: 'operator',
        message: 'A+ module draft generated from review spike — review execution log',
      },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: 0,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
]

export interface SeedReviewTemplatesResult {
  created: string[]
  skippedExisting: string[]
}

export async function seedReviewTemplates(): Promise<SeedReviewTemplatesResult> {
  const created: string[] = []
  const skippedExisting: string[] = []
  for (const tmpl of REVIEW_TEMPLATES) {
    const existing = await prisma.automationRule.findFirst({
      where: { name: tmpl.name, domain: 'reviews' },
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
        domain: 'reviews',
        trigger: tmpl.trigger,
        conditions: tmpl.conditions as object,
        actions: tmpl.actions as object,
        enabled: false,
        dryRun: true,
        maxExecutionsPerDay: tmpl.maxExecutionsPerDay ?? 20,
        maxValueCentsEur: tmpl.maxValueCentsEur,
        maxDailyAdSpendCentsEur: tmpl.maxDailyAdSpendCentsEur,
        scopeMarketplace: tmpl.scopeMarketplace,
        createdBy: 'template-seeder:reviews',
      },
    })
    created.push(tmpl.name)
  }
  return { created, skippedExisting }
}
