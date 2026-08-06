/**
 * NAF.E — E3: Part 7's demotion machine and the server-side AUTO gate.
 *
 * "Demotion is automatic and immediate on: any rollback, acceptance rate
 * below 40% over 10 decisions, a critic block verdict twice in a week,
 * or a schema-validation failure rate above 5%."
 *
 * The three triggers computable today are LIVE; rollback is checked but
 * structurally inert until Phase F executes something. One rung down per
 * night, floor OFF — an agent misbehaving in OBSERVE stops burning money
 * entirely. First matching trigger wins (they're ordered by severity);
 * the operator re-promotes by hand once the cause is understood.
 */
import prisma from '../../db.js'
import { bustCharterCache, FLEET_CHARTERS } from './charter-registry.js'

const VALIDATION_RATE_LIMIT = 0.05
const CRITIC_BLOCKS_PER_WEEK = 2
const ACCEPTANCE_FLOOR = 0.4
const ACCEPTANCE_MIN_DECISIONS = 10

const DAY = 24 * 3600_000

export function demoteLevel(level: string): string {
  if (level === 'AUTO') return 'PROPOSE'
  if (level === 'PROPOSE') return 'OBSERVE'
  return 'OFF'
}

export interface Demotion {
  charterKey: string
  from: string
  to: string
  trigger: 'rollback' | 'validation_failures' | 'critic_double_block' | 'low_acceptance'
  detail: string
}

export async function evaluateDemotions(now: Date = new Date()): Promise<Demotion[]> {
  const charters = await prisma.agentCharter.findMany({
    select: { key: true, enabled: true, autonomyLevel: true },
  })
  const demotions: Demotion[] = []

  for (const c of charters) {
    if (c.autonomyLevel === 'OFF') continue
    const def = FLEET_CHARTERS[c.key]
    if (!def) continue

    const runs = await prisma.agentRun.findMany({
      where: { agentKey: c.key, createdAt: { gte: new Date(now.getTime() - 14 * DAY) } },
      select: { id: true },
    })
    const runIds = runs.map((r) => r.id)

    let trigger: Demotion['trigger'] | null = null
    let detail = ''

    // 1 — rollback (armed; inert until Phase F mints 'rolled_back').
    if (runIds.length) {
      const rolledBack = await prisma.agentApproval.findMany({
        where: { agentRunId: { in: runIds }, status: 'rolled_back' },
        select: { id: true },
        take: 1,
      })
      if (rolledBack.length > 0) {
        trigger = 'rollback'
        detail = `approval ${rolledBack[0]!.id} was rolled back`
      }
    }

    // 2 — schema-validation failure rate above 5% (14d).
    if (!trigger && runIds.length) {
      const steps = await prisma.agentStep.findMany({
        where: { agentRunId: { in: runIds }, type: 'validation' },
        select: { ok: true },
      })
      if (steps.length > 0) {
        const rate = steps.filter((s) => !s.ok).length / steps.length
        if (rate > VALIDATION_RATE_LIMIT) {
          trigger = 'validation_failures'
          detail = `validation failure rate ${(rate * 100).toFixed(1)}% over ${steps.length} validations (limit ${VALIDATION_RATE_LIMIT * 100}%)`
        }
      }
    }

    // 3 — a critic block twice in a week (directors own their plans).
    if (!trigger && def.tier === 'director') {
      const blocks = await prisma.agentPlan.count({
        where: {
          charterKey: c.key,
          criticVerdict: 'block',
          createdAt: { gte: new Date(now.getTime() - 7 * DAY) },
        },
      })
      if (blocks >= CRITIC_BLOCKS_PER_WEEK) {
        trigger = 'critic_double_block'
        detail = `${blocks} plans blocked by the critic in 7 days`
      }
    }

    // 4 — acceptance below 40% over at least 10 decisions (30d… but the
    // run window above is 14d; decisions attach to runs, so the window
    // follows the runs we loaded).
    if (!trigger && runIds.length) {
      const approvals = await prisma.agentApproval.findMany({
        where: { agentRunId: { in: runIds } },
        select: { status: true },
      })
      const approved = approvals.filter((a) => a.status === 'approved').length
      const rejected = approvals.filter((a) => a.status === 'rejected').length
      const decided = approved + rejected
      if (decided >= ACCEPTANCE_MIN_DECISIONS && approved / decided < ACCEPTANCE_FLOOR) {
        trigger = 'low_acceptance'
        detail = `acceptance ${approved}/${decided} = ${((approved / decided) * 100).toFixed(0)}% over ${decided} decisions`
      }
    }

    if (trigger) {
      const to = demoteLevel(c.autonomyLevel)
      await prisma.agentCharter.updateMany({
        where: { key: c.key },
        data: { autonomyLevel: to },
      })
      demotions.push({ charterKey: c.key, from: c.autonomyLevel, to, trigger, detail })
    }
  }

  if (demotions.length > 0) bustCharterCache()
  return demotions
}

/** The E acceptance: AUTO is impossible via the API unless the latest
 *  scorecard says the agent has earned it. No scorecard = no evidence =
 *  no AUTO. (The operator sign-off is the PATCH request itself.) */
export async function isAutoPromotionAllowed(charterKey: string): Promise<boolean> {
  const latest = await prisma.agentScorecard.findMany({
    where: { charterKey },
    orderBy: { periodEnd: 'desc' },
    take: 1,
    select: { promotionEligible: true },
  })
  return latest[0]?.promotionEligible === true
}
