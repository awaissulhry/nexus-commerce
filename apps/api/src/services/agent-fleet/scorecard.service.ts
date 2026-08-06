/**
 * NAF.E — E1: nightly per-charter scorecards (spec Part 7 / model
 * AgentScorecard). Deterministic — no model calls, $0 — and honest about
 * what OBSERVE/PROPOSE evidence can and cannot prove:
 *
 *  - computable now: findings minted, findings promoted into plans,
 *    approvals decided (attributed to the charter whose RUN queued them —
 *    the director), shadow agreement, cost, validation-failure rate.
 *  - execution-dependent, NULL until Phase F: calibrationError and
 *    realisedImpactCents (a plan nobody executed has no realised outcome —
 *    unknown is not zero, the ACR 0.5 lesson). `executed`/`rolledBack`
 *    are factual zeros, not unknowns.
 *
 * Two sliding windows per charter per night (14d and 30d), upserted on the
 * (charterKey, periodStart, periodEnd) unique — re-running a night is
 * idempotent. 14d carries the OBSERVE→PROPOSE backtest grade; 30d carries
 * the PROPOSE→AUTO acceptance evidence.
 *
 * Grade policy v1 (code is the policy; change = commit):
 *   no evidence → null · validation failures > 5% → F (the demotion line)
 *   else shadow agreement ≥0.80 A · ≥0.60 B · ≥0.40 C · <0.40 D
 *   · findings but nothing graded → C (unproven, not excellent)
 */
import prisma from '../../db.js'
import { FLEET_CHARTERS } from './charter-registry.js'

export const SCORECARD_WINDOWS = [14, 30] as const

const DEMOTION_VALIDATION_RATE = 0.05
const OBSERVE_TRACK_DAYS = 14
const AUTO_TRACK_DAYS = 30
const AUTO_ACCEPTANCE_FLOOR = 0.7
const AUTO_CALIBRATION_CEILING = 0.15

export interface GradeInputs {
  findings: number
  runs: number
  validationFailureRate: number | null
  shadowAgreement: number | null
}

export function gradeScorecard(g: GradeInputs): string | null {
  if (g.findings === 0 && g.runs === 0) return null
  if (g.validationFailureRate != null && g.validationFailureRate > DEMOTION_VALIDATION_RATE) {
    return 'F'
  }
  if (g.shadowAgreement == null) return 'C'
  if (g.shadowAgreement >= 0.8) return 'A'
  if (g.shadowAgreement >= 0.6) return 'B'
  if (g.shadowAgreement >= 0.4) return 'C'
  return 'D'
}

export interface EligibilityInputs {
  grade: string | null
  validationFailureRate: number | null
  trackDays: number
  acceptanceRate: number | null
  calibrationError: number | null
  rolledBack: number
}

/** Part 7's ladder, restricted to the rungs computable pre-F. AUTO also
 *  needs explicit operator sign-off — eligibility is necessary, not
 *  sufficient; E3's PATCH-route refusal enforces the necessary half. */
export function isPromotionEligible(
  currentLevel: string,
  e: EligibilityInputs,
): boolean {
  const cleanValidation =
    e.validationFailureRate == null || e.validationFailureRate <= DEMOTION_VALIDATION_RATE
  if (currentLevel === 'OBSERVE') {
    return (
      e.trackDays >= OBSERVE_TRACK_DAYS &&
      (e.grade === 'A' || e.grade === 'B') &&
      cleanValidation
    )
  }
  if (currentLevel === 'PROPOSE') {
    // calibrationError is null until Phase F executes something — and an
    // agent without calibration evidence has not EARNED auto, whatever
    // its acceptance rate says.
    return (
      e.trackDays >= AUTO_TRACK_DAYS &&
      e.acceptanceRate != null &&
      e.acceptanceRate >= AUTO_ACCEPTANCE_FLOOR &&
      e.calibrationError != null &&
      e.calibrationError <= AUTO_CALIBRATION_CEILING &&
      e.rolledBack === 0 &&
      cleanValidation
    )
  }
  return false // OFF has no evidence to promote on; AUTO has nowhere to go
}

export interface OutcomeAttribution {
  executed: number
  rolledBack: number
  realisedImpactCents: number | null
  calibrationError: number | null
  note: string
}

/**
 * The null-honest attribution reader. Phase F will join executed
 * approvals to ads-changes and post-change metric windows; until an
 * execution exists there is NOTHING to attribute — impact is unknown,
 * never zero. The shape is stable so E-consumers don't change at F.
 */
export async function readOutcomeAttribution(
  charterKey: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<OutcomeAttribution> {
  const runs = await prisma.agentRun.findMany({
    where: { agentKey: charterKey, createdAt: { gte: periodStart, lt: periodEnd } },
    select: { id: true },
  })
  const executed = await prisma.agentApproval.findMany({
    where: {
      agentRunId: { in: runs.map((r) => r.id) },
      status: 'executed',
    },
    select: { id: true },
  })
  if (executed.length === 0) {
    return {
      executed: 0,
      rolledBack: 0,
      realisedImpactCents: null,
      calibrationError: null,
      note: 'no executed actions in window — impact and calibration unknown until Phase F',
    }
  }
  // Phase F: ads-changes join + post-change windows land here.
  return {
    executed: executed.length,
    rolledBack: 0,
    realisedImpactCents: null,
    calibrationError: null,
    note: `${executed.length} executed action(s); attribution comparator arrives in Phase F`,
  }
}

export async function computeScorecards(
  periodEnd: Date = utcMidnight(new Date()),
): Promise<{ upserted: number }> {
  const charterLevels = new Map(
    (
      await prisma.agentCharter.findMany({
        select: { key: true, autonomyLevel: true },
      })
    ).map((c) => [c.key, c.autonomyLevel]),
  )

  let upserted = 0
  for (const charterKey of Object.keys(FLEET_CHARTERS)) {
    for (const windowDays of SCORECARD_WINDOWS) {
      const periodStart = new Date(periodEnd.getTime() - windowDays * 24 * 3600_000)

      const runs = await prisma.agentRun.findMany({
        where: {
          agentKey: charterKey,
          createdAt: { gte: periodStart, lt: periodEnd },
        },
        select: { id: true, costUSD: true },
      })
      const runIds = runs.map((r) => r.id)
      const costUSD = runs.reduce((s, r) => s + Number(r.costUSD ?? 0), 0)

      const findings = await prisma.agentFinding.findMany({
        where: { charterKey, createdAt: { gte: periodStart, lt: periodEnd } },
        select: { id: true },
        take: 5000,
      })
      const findingIds = new Set(findings.map((f) => f.id))

      // promoted = this charter's findings that a director carried into a
      // plan item during the window.
      const plans = await prisma.agentPlan.findMany({
        where: { createdAt: { gte: periodStart, lt: periodEnd } },
        select: { items: true },
        take: 500,
      })
      const promotedIds = new Set<string>()
      for (const p of plans) {
        for (const it of (p.items as Array<{ findingId?: string }> | null) ?? []) {
          if (it.findingId && findingIds.has(it.findingId)) promotedIds.add(it.findingId)
        }
      }

      // Approvals attribute to the charter whose RUN queued them (the
      // director) — analysts earn shadow agreement, directors earn
      // acceptance. 'pending' is undecided and counts toward neither.
      const approvals = runIds.length
        ? await prisma.agentApproval.findMany({
            where: { agentRunId: { in: runIds } },
            select: { status: true },
          })
        : []
      const approved = approvals.filter((a) => a.status === 'approved').length
      const rejected = approvals.filter((a) => a.status === 'rejected').length
      const decided = approved + rejected
      const acceptanceRate = decided > 0 ? approved / decided : null

      const grades = findingIds.size
        ? await prisma.agentShadowGrade.findMany({
            where: { findingId: { in: [...findingIds] } },
            select: { findingId: true, agrees: true },
          })
        : []
      const shadowAgreement =
        grades.length > 0 ? grades.filter((g) => g.agrees).length / grades.length : null

      const validationSteps = runIds.length
        ? await prisma.agentStep.findMany({
            where: { agentRunId: { in: runIds }, type: 'validation' },
            select: { ok: true },
          })
        : []
      const validationFailureRate =
        validationSteps.length > 0
          ? validationSteps.filter((s) => !s.ok).length / validationSteps.length
          : null

      const attribution = await readOutcomeAttribution(charterKey, periodStart, periodEnd)

      const grade = gradeScorecard({
        findings: findings.length,
        runs: runs.length,
        validationFailureRate,
        shadowAgreement,
      })

      // Track length: the charter's whole history, not just this window —
      // "14 days in OBSERVE" is about tenure, and the window would cap it.
      const firstRun = await prisma.agentRun.findMany({
        where: { agentKey: charterKey },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { createdAt: true },
      })
      const firstCreated = firstRun[0]?.createdAt
      const trackDays = firstCreated
        ? Math.floor((periodEnd.getTime() - firstCreated.getTime()) / (24 * 3600_000))
        : 0

      const promotionEligible =
        windowDays === OBSERVE_TRACK_DAYS || windowDays === AUTO_TRACK_DAYS
          ? isPromotionEligible(charterLevels.get(charterKey) ?? 'OFF', {
              grade,
              validationFailureRate,
              trackDays,
              acceptanceRate,
              calibrationError: attribution.calibrationError,
              rolledBack: attribution.rolledBack,
            })
          : false

      const row = {
        charterKey,
        periodStart,
        periodEnd,
        findings: findings.length,
        promoted: promotedIds.size,
        approved,
        rejected,
        executed: attribution.executed,
        rolledBack: attribution.rolledBack,
        // plain numbers — Prisma coerces to the Decimal columns on write
        acceptanceRate,
        calibrationError: attribution.calibrationError,
        realisedImpactCents: attribution.realisedImpactCents,
        shadowAgreement,
        costUSD,
        costPerAcceptedAction: approved > 0 ? costUSD / approved : null,
        grade,
        promotionEligible,
      }
      await prisma.agentScorecard.upsert({
        where: {
          charterKey_periodStart_periodEnd: { charterKey, periodStart, periodEnd },
        },
        create: row,
        update: row,
      })
      upserted++
    }
  }
  return { upserted }
}

export function utcMidnight(d: Date): Date {
  const out = new Date(d)
  out.setUTCHours(0, 0, 0, 0)
  return out
}
