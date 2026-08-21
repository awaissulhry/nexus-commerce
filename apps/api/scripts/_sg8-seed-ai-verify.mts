/**
 * SG.8 — seed the verification fixtures for the A.I. Bids VERBS. Twin: `_sg8-clean-ai-verify.mts`
 * (run it when verification is done — these are delete-me rows on the prod DB).
 *
 * Plan A (`sg8-verify-plan-off`) — INERT, the sg4 shape (enabled:false, autonomy:'OFF'): the
 * conductor never evaluates it. Verifies: list rendering, dismiss → restore (status-only
 * writes), and approve's "plan is disabled" refusal.
 *
 * Plan B (`sg8-verify-plan-on`) — ENABLED so approve reaches the real engine, but structurally
 * harmless to prod:
 *   · campaignIds [] and EVERY module explicitly off — `moduleOn` defaults ON, so an empty
 *     modules object would let the prod tick provision harvest/negate rules for this plan.
 *   · its decisions point at a campaign id that DOES NOT EXIST, so no engine path can touch a
 *     real campaign: budget → update throws → "did not complete" (row stays proposed);
 *     bid → optimizer finds no targets → honest SKIPPED settle; safety → module refusal.
 * ⚠ The prod ad-autopilot tick (every 15 min) deletes PROPOSED rows on ENABLED plans — plan
 * B's rows can vanish mid-verification. Re-run this script to re-seed; ids are stable.
 */
import prisma from '../src/db.js'

await prisma.autopilotPlan.upsert({
  where: { id: 'sg8-verify-plan-off' },
  update: { enabled: false, autonomy: 'OFF' },
  create: { id: 'sg8-verify-plan-off', name: 'SG.8 verify OFF (delete me)', marketplace: 'DE', enabled: false, autonomy: 'OFF' },
})
const MODULES_ALL_OFF = {
  bid: { on: false }, budget: { on: false }, placement: { on: false },
  dayparting: { on: false }, rank: { on: false }, harvest: { on: false }, negate: { on: false },
}
await prisma.autopilotPlan.upsert({
  where: { id: 'sg8-verify-plan-on' },
  update: { enabled: true, autonomy: 'SUGGEST', campaignIds: [], modules: MODULES_ALL_OFF },
  create: {
    id: 'sg8-verify-plan-on', name: 'SG.8 verify ON (delete me)', marketplace: 'DE',
    enabled: true, autonomy: 'SUGGEST', campaignIds: [], modules: MODULES_ALL_OFF,
  },
})

await prisma.autopilotDecision.deleteMany({ where: { planId: { in: ['sg8-verify-plan-off', 'sg8-verify-plan-on'] } } })
await prisma.autopilotDecision.createMany({
  data: [
    {
      id: 'sg8-d-off-bid', planId: 'sg8-verify-plan-off', cycle: 'slow', module: 'bid',
      campaignId: 'sg8-no-such-campaign', action: 'BID_RAISE',
      before: { cents: 42 }, after: { cents: 51 },
      reason: 'SG.8 verify — approve must refuse: the plan is disabled', status: 'PROPOSED',
    },
    {
      id: 'sg8-d-off-bud', planId: 'sg8-verify-plan-off', cycle: 'fast', module: 'budget',
      campaignId: 'sg8-no-such-campaign', action: 'BUDGET_UP',
      before: { cents: 500 }, after: { cents: 650 },
      reason: 'SG.8 verify — dismiss/restore target', status: 'PROPOSED',
    },
    {
      id: 'sg8-d-on-bud', planId: 'sg8-verify-plan-on', cycle: 'fast', module: 'budget',
      campaignId: 'sg8-no-such-campaign', action: 'BUDGET_UP',
      before: { cents: 500 }, after: { cents: 650 },
      reason: 'SG.8 verify — budget apply on a nonexistent campaign must NOT settle', status: 'PROPOSED',
    },
    {
      id: 'sg8-d-on-bid', planId: 'sg8-verify-plan-on', cycle: 'fast', module: 'bid',
      campaignId: 'sg8-no-such-campaign', action: 'BID_RAISE',
      before: { cents: 42 }, after: { cents: 51 },
      reason: 'SG.8 verify — bid apply with no targets settles SKIPPED', status: 'PROPOSED',
    },
    {
      id: 'sg8-d-on-safety', planId: 'sg8-verify-plan-on', cycle: 'event', module: 'safety',
      campaignId: 'sg8-no-such-campaign', action: 'SUPPRESS',
      before: null, after: null,
      reason: 'SG.8 verify — an unapplyable module must refuse', status: 'PROPOSED',
    },
  ],
})
const n = await prisma.autopilotDecision.count({ where: { planId: { in: ['sg8-verify-plan-off', 'sg8-verify-plan-on'] } } })
console.log('seeded 2 plans +', n, 'decisions')
await prisma.$disconnect()
