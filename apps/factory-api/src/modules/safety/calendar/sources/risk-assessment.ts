import type { Prisma } from '@nexus/factory-db'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf } from '../source'

/**
 * The risk assessment's next review (B-W2b-120 reading factory-db RiskAssessment.nextReviewOn, B-W2b-87; the DVR itself is
 * B-W2b-122's): an ACTIVE assessment of a site whose review falls in the window. Kept on Plant › Risk assessment.
 */
export default defineCalendarSource({
  kind: 'DVR_REVIEW',
  async read(client, _context, window, scope) {
    const rows = await client.riskAssessment.findMany({
      where: { AND: [scope.site as Prisma.RiskAssessmentWhereInput, { status: 'ACTIVE', nextReviewOn: { gte: dateOfDay(window.openFrom), lte: dateOfDay(window.to) } }] },
      orderBy: [{ nextReviewOn: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, companyId: true, siteId: true, name: true, nextReviewOn: true },
    })
    return rows.map((row) => ({
      key: `DVR_REVIEW:${row.id}`,
      kind: 'DVR_REVIEW',
      recordType: 'RiskAssessment',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      dueOn: dayOfDate(row.nextReviewOn!),
      count: null,
      params: { assessment: row.name },
      ownerId: null,
      evidence: null,
      // The review's rule in the schema's words (art. 29 c.3: after a significant change, an injury, or as the assessment says).
      law: 'D.Lgs. 81/2008 art. 29 c.3',
      source: sourceOf('plant.risk', 'RiskAssessment', row.id),
      editable: false,
    }))
  },
})
