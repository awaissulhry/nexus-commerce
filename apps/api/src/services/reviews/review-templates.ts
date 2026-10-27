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
      'Tells the team when the spike check finds complaints about one theme rising fast for a product in one market. You can narrow it to a theme, or to how fast complaints must rise.',
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
      'When complaints about one theme rise fast, the AI drafts five new bullet points that answer them. A person reads them and applies them; nothing changes on a channel by itself. Out of trial run, it also saves them as an A+ draft in Nexus.',
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
      'When complaints about one theme rise 2.5 times faster than usual or more, the AI drafts an A+ module that answers them and saves it as an A+ draft in Nexus. A person approves it before anything is published.',
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
