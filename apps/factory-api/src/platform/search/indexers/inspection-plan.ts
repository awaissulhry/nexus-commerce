import { STAGE_WORDS, type PlanStage } from '@nexus/factory-domain/quality/plans/rules'
import { defineIndexer, idWhere } from '../indexer'

/**
 * Inspection plans (modules/quality/plans, B-W2b-92; quality.plans.view; opens in Quality › Inspection plans & AQL): by
 * code and name, with its stage in words and the version in force ("FIN-JACKET · Final · v3"). Scope as the Plans grid: the
 * plan's company. Status: APPROVED when a version is in force, DRAFT when only drafts exist, RETIRED when none is left.
 * Never a check's words, never a person. A plan made or changed, a version drafted, saved, sent, approved or retired
 * re-reads it.
 */
export default defineIndexer({
  recordType: 'InspectionPlan',
  area: 'quality',
  viewPermission: 'quality.plans.view',
  on: {
    'inspection_plan.changed': 'subject',
    'inspection_plan.version_approved': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.inspectionPlan.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, stage: true, versions: { select: { number: true, status: true }, orderBy: { number: 'desc' } } },
    })
    return rows.map((row) => {
      const approved = row.versions.find((version) => version.status === 'APPROVED')
      const draft = row.versions.find((version) => version.status === 'DRAFT')
      const stage = STAGE_WORDS[row.stage as PlanStage]
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: null,
        partyId: null,
        number: row.code,
        title: row.name,
        subtitle: [stage.en, approved ? `v${approved.number}` : draft ? `v${draft.number}` : null].filter(Boolean).join(' · '),
        status: approved ? 'APPROVED' : draft ? 'DRAFT' : 'RETIRED',
        words: [stage.it, stage.en],
      }
    })
  },
})
