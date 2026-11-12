import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { planVersionWords } from '@nexus/factory-domain/insights/words'
import { QUALITY_PLANS_VIEW } from '@nexus/factory-domain/quality/plans/permissions'
import { editorsOf, submittedDrafts, submittedOf } from '../../quality/plans/store'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * Inspection plan versions submitted for approval (B-W2b-307, follow-up AW2:03; B-W2b-92's gap "no notification to approvers
 * on submit"; design home.approvals "every request that needs my yes", quality.plans "Approve version N"). A DRAFT version
 * whose "Submit for approval" still stands (the submit's audit row names the row version the draft still has:
 * modules/quality/plans store `submittedDrafts`), of a plan the viewer sees (quality.plans.view). It is theirs when they
 * approve plans for its company (quality.plans.approve) and neither wrote nor saved it (separation of duties, as the plans
 * module refuses: AUTHOR, EDITOR — notBy). The row opens the plan's record, whose band approves the version after the
 * step-up. Oldest ask first.
 */

const PLAN_SCOPE = { company: 'companyId' } as const

export const planVersion: Source = async ({ caller, viewer }) => {
  const plans = scopeWhere(viewer.actor, QUALITY_PLANS_VIEW, PLAN_SCOPE) as Prisma.InspectionPlanWhereInput
  return caller.withClient(async (db) => {
    const drafts = await db.inspectionPlanVersion.findMany({
      where: { status: 'DRAFT', plan: plans },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT * 2,
      select: { id: true, number: true, version: true, authorId: true, plan: { select: { id: true, code: true, companyId: true } } },
    })
    const asked = await submittedDrafts(db, drafts)
    const waiting = drafts.filter((row) => asked.has(row.id))
    const { rows, complete } = capped(waiting, SOURCE_LIMIT)
    const editors = await editorsOf(db, rows.map((row) => row.id))
    const candidates: AttentionCandidate[] = []
    for (const row of rows) {
      // When it was asked (the ask still standing): its age in the inbox.
      const ask = await submittedOf(db, row)
      if (!ask) continue
      candidates.push({
        kind: 'PLAN_VERSION',
        state: 'SUBMITTED',
        severity: 'MEDIUM',
        record: { type: 'InspectionPlan', id: row.plan.id, label: row.plan.code },
        scope: { companyId: row.plan.companyId, siteId: null, partyId: null },
        ...planVersionWords({ code: row.plan.code, number: row.number }),
        due: null,
        since: ask.at,
        // One row per version (a plan has at most one draft; the key stays the version's).
        subKey: row.id,
        notBy: [...new Set([row.authorId, ask.by, ...(editors.get(row.id) ?? [])])],
      })
    }
    candidates.sort((a, b) => a.since.getTime() - b.since.getTime())
    return { kind: 'PLAN_VERSION', candidates, complete: complete && drafts.length < SOURCE_LIMIT * 2 }
  })
}
