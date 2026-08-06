/**
 * NAF.E — the auditor's evidence: a deterministic digest of the fleet's
 * trailing day — sweep outcomes, council verdicts, per-charter 14d
 * scorecards, demotions-relevant signals, cost against the ceiling. All
 * reads; the auditor turns this into the operator brief, it never
 * computes fresh math the code hasn't already done (L1).
 */
import prisma from '../../../db.js'
import { getFleetState } from '../fleet-state.service.js'
import { getSweepReport } from '../sweep-report.service.js'
import type { ObservationBuilder } from '../observation-builder.js'

const DAY = 24 * 3600_000

export const fleetHealthBuilder: ObservationBuilder = {
  key: 'fleet-health',
  ttlMinutes: 30,
  async build() {
    const now = new Date()
    const dayAgo = new Date(now.getTime() - DAY)
    const weekAgo = new Date(now.getTime() - 7 * DAY)

    const [state, sweepReport, plans, scorecards, approvals, runs24h] =
      await Promise.all([
        getFleetState(),
        getSweepReport(3),
        prisma.agentPlan.findMany({
          where: { createdAt: { gte: weekAgo } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            headline: true,
            status: true,
            criticVerdict: true,
            createdAt: true,
          },
        }),
        // newest 14d-window scorecard per charter: rows land nightly, so
        // the most recent periodEnd per charter is last night's.
        prisma.agentScorecard.findMany({
          orderBy: { periodEnd: 'desc' },
          take: 40,
          select: {
            charterKey: true,
            periodStart: true,
            periodEnd: true,
            findings: true,
            promoted: true,
            approved: true,
            rejected: true,
            shadowAgreement: true,
            grade: true,
            promotionEligible: true,
            costUSD: true,
          },
        }),
        prisma.agentApproval.findMany({
          where: { status: 'pending' },
          take: 50,
          select: { toolName: true, requestedAt: true },
        }),
        prisma.agentRun.findMany({
          where: { mode: { not: null }, createdAt: { gte: dayAgo } },
          select: {
            agentKey: true,
            ok: true,
            costUSD: true,
            haltedReason: true,
            errorMessage: true,
          },
        }),
      ])

    const newestPerCharter = new Map<string, (typeof scorecards)[number]>()
    for (const s of scorecards) {
      const windowDays = Math.round(
        (s.periodEnd.getTime() - s.periodStart.getTime()) / DAY,
      )
      if (windowDays !== 14) continue
      if (!newestPerCharter.has(s.charterKey)) newestPerCharter.set(s.charterKey, s)
    }

    const cost24h = runs24h.reduce((sum, r) => sum + Number(r.costUSD ?? 0), 0)

    return {
      payload: {
        generatedAt: now.toISOString(),
        fleet: {
          halted: state.halted,
          haltReason: state.haltReason,
          dailyCeilingUSD: Number(state.dailyCeilingUSD),
          cost24hUSD: Math.round(cost24h * 10_000) / 10_000,
        },
        runs24h: runs24h.map((r) => ({
          agentKey: r.agentKey,
          ok: r.ok,
          costUSD: Number(r.costUSD ?? 0),
          haltedReason: r.haltedReason,
          error: r.errorMessage?.slice(0, 200) ?? null,
        })),
        recentSweeps: sweepReport.sweeps,
        agreement: sweepReport.agreement,
        plans7d: plans.map((p) => ({
          headline: p.headline,
          status: p.status,
          criticVerdict: p.criticVerdict,
          createdAt: p.createdAt.toISOString(),
        })),
        scorecards14d: [...newestPerCharter.values()].map((s) => ({
          charterKey: s.charterKey,
          findings: s.findings,
          promoted: s.promoted,
          approved: s.approved,
          rejected: s.rejected,
          shadowAgreement: s.shadowAgreement == null ? null : Number(s.shadowAgreement),
          grade: s.grade,
          promotionEligible: s.promotionEligible,
          costUSD: Number(s.costUSD),
        })),
        pendingApprovals: approvals.length,
      },
      dataVintage: now,
    }
  },
}
