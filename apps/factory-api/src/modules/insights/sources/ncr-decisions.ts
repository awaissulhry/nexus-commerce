import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { ncrDecisionWords } from '@nexus/factory-domain/insights/words'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * NCR decisions waiting for an approval (B-W2b-17; B-W2a-47's gap "no Home › Approvals source"; design home.approvals
 * "One inbox for every request that needs my yes", quality.ncr ncr-disposition "Approve (four eyes)"). A decision of an
 * open NCR (OPEN or CONTAINED: decisions change only then) whose disposition code asked for an approval, not approved
 * yet and not carried out. It is the viewer's when they approve NCR decisions at the NCR's site (quality.ncr.approve:
 * insights/attention's act) and they did not decide it (four eyes: the decider never approves — notBy). The row opens
 * the NCR's record, where the Disposition tab approves it. Oldest decision first; its severity follows the NCR's.
 */

export const ncrDecision: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, QUALITY_NCR_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.NonconformanceWhereInput
  return caller.withClient(async (db) => {
    const found = await db.ncrDispositionLine.findMany({
      where: { approvalRequired: true, approvedAt: null, doneAt: null, ncr: { AND: [scope, { stage: { in: ['OPEN', 'CONTAINED'] } }] } },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: {
        id: true,
        ncrId: true,
        quantity: true,
        decidedAt: true,
        decidedById: true,
        dispositionCodeId: true,
        ncr: { select: { id: true, number: true, companyId: true, siteId: true, severity: true, uom: true } },
      },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const codes = new Map(
      (rows.length > 0 ? await db.dispositionCode.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.dispositionCodeId))] } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]),
    )
    const candidates: AttentionCandidate[] = rows.map((row) => {
      const quantity = `${new Dec(row.quantity.toString()).toDecimalPlaces(4).toString()} ${row.ncr.uom}`
      return {
        kind: 'NCR_DECISION',
        state: 'WAITING_APPROVAL',
        severity: row.ncr.severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        record: { type: 'Nonconformance', id: row.ncr.id, label: row.ncr.number },
        scope: { companyId: row.ncr.companyId, siteId: row.ncr.siteId, partyId: null },
        ...ncrDecisionWords({ number: row.ncr.number, code: codes.get(row.dispositionCodeId) ?? 'a disposition', quantity }),
        due: null,
        since: row.decidedAt,
        // One row per decision (an NCR may wait for several approvals).
        subKey: row.id,
        notBy: row.decidedById ? [row.decidedById] : [],
      }
    })
    return { kind: 'NCR_DECISION', candidates, complete }
  })
}
