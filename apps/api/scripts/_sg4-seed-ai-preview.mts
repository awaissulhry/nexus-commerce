/**
 * SG.4 — seed ONE preview AutopilotPlan + two PROPOSED decisions so the A.I. Bids tab's grid
 * can be verified against real prod data. INERT BY CONSTRUCTION: the plan is `enabled: false,
 * autonomy: 'OFF'`, which excludes it from ad-autopilot.job.ts's `findMany({ enabled: true,
 * autonomy: { not: 'OFF' } })` — no cron will ever evaluate it, and the tab renders no verbs.
 * Twin: `_sg4-clean-ai-preview.mts`. Delete before the batch push.
 */
import prisma from '../src/db.js'

const camp = await prisma.campaign.findFirst({
  where: { status: 'ENABLED', marketplace: 'DE' },
  select: { id: true, name: true },
})

const plan = await prisma.autopilotPlan.upsert({
  where: { id: 'sg4-preview-plan' },
  update: {},
  create: {
    id: 'sg4-preview-plan',
    name: 'SG.4 preview (delete me)',
    marketplace: 'DE',
    enabled: false,
    autonomy: 'OFF',
  },
})

await prisma.autopilotDecision.deleteMany({ where: { planId: plan.id } })
await prisma.autopilotDecision.createMany({
  data: [
    {
      id: 'sg4-preview-d1', planId: plan.id, cycle: 'slow', module: 'bid',
      campaignId: camp?.id ?? null, action: 'BID_RAISE',
      before: { bidCents: 42 }, after: { bidCents: 51 },
      reason: 'Below target ACoS with headroom — raising toward the plan ceiling', status: 'PROPOSED',
    },
    {
      id: 'sg4-preview-d2', planId: plan.id, cycle: 'fast', module: 'budget',
      campaignId: camp?.id ?? null, action: 'BUDGET_UP',
      before: { dailyBudgetEur: 5 }, after: { dailyBudgetEur: 6.5 },
      reason: 'Out of budget before 14:00 on 5 of the last 7 days', status: 'PROPOSED',
    },
  ],
})
console.log('seeded plan', plan.id, 'campaign:', camp?.name ?? '(none found)')
await prisma.$disconnect()
