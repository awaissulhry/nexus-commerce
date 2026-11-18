import type { CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { CHANGE_COLUMNS, type ChangeRow } from './read'

/**
 * B-SA-041: a WorkOrderChange decided — APPLIED (./apply.ts), DECLINED with words ("Left as is", ./apply.ts), or STALE: what it
 * carried out was put back (an amendment put back: sales/order-changes changes.ts) or a newer change of the same lines replaced
 * it (B-SA-042: ./propose.ts proposeGapsInCommand). The status, when, by whom (an office person; a STALE change of the system
 * names none), the words, the work order an applied MAKE_MORE made; lastError cleared. Audited; work_order_change.<status>.
 */

/** The decision written (the second version step of this command: the record guard took the first). */
export async function decideInCommand(tools: CommandTools, context: OfficeContext | null, row: ChangeRow, status: 'APPLIED' | 'DECLINED' | 'STALE', extra: { readonly note?: string; readonly madeWorkOrderId?: string } = {}): Promise<void> {
  const { tx, now } = tools
  await tx.workOrderChange.update({
    where: { id: row.id },
    data: { status, decidedAt: now, decidedById: context?.actorId ?? null, decisionNote: extra.note ?? null, madeWorkOrderId: extra.madeWorkOrderId ?? null, lastError: null, version: { increment: 1 } },
    select: { id: true },
  })
  tools.audit({
    action: status === 'APPLIED' ? 'workorders.applyChange' : status === 'DECLINED' ? 'workorders.declineChange' : 'workorders.staleChange',
    recordType: 'WorkOrderChange',
    recordId: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    before: { status: 'PROPOSED' },
    after: { status, madeWorkOrderId: extra.madeWorkOrderId ?? null, decidedById: context?.actorId ?? null },
    ...(extra.note ? { reason: extra.note } : {}),
  })
  const type = status === 'APPLIED' ? 'work_order_change.applied' : status === 'DECLINED' ? 'work_order_change.declined' : 'work_order_change.stale'
  const payload = { changeId: row.id, salesOrderId: row.salesOrderId, workOrderId: row.workOrderId, partyId: row.partyId, kind: row.kind }
  tools.emit({ type, subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: status === 'APPLIED' ? { ...payload, madeWorkOrderId: extra.madeWorkOrderId ?? null } : payload })
}

/**
 * The PROPOSED changes of an amendment put back made STALE inside that command (the office person who put it back named). How
 * many. B-SA-041: a request withdrawn or refused never has one — a change names only an ACCEPTED request (./propose.ts).
 */
export async function staleChangesInCommand(tools: CommandTools, of: { readonly requestId: string } | { readonly amendmentId: string }): Promise<number> {
  const rows = await tools.tx.workOrderChange.findMany({ where: { ...of, status: 'PROPOSED' }, select: CHANGE_COLUMNS })
  const office = tools.context.audience === 'office' ? (tools.context as OfficeContext) : null
  for (const row of rows) await decideInCommand(tools, office, row, 'STALE')
  return rows.length
}
