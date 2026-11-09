import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'

/**
 * The change order that holds a style's draft revision (B-W2b-226): the live one proposing it that waits for approval or is
 * approved. product/lifecycle's edit rule reads it (DRAFT_UNDER_CHANGE_ORDER): what the approver approves does not change
 * under them. A DRAFT change order does not hold its draft: the redlines are written then. Kept apart from the change
 * order commands so the edit rule imports no command of this module.
 */
export async function draftHolderOf(db: Pick<CommandTx, 'changeOrder'> | FactoryClient, revisionId: string): Promise<{ number: string; status: 'SUBMITTED' | 'APPROVED' } | null> {
  const order = await db.changeOrder.findFirst({ where: { toRevisionId: revisionId, status: { in: ['SUBMITTED', 'APPROVED'] } }, select: { number: true, status: true } })
  return order ? { number: order.number, status: order.status === 'SUBMITTED' ? 'SUBMITTED' : 'APPROVED' } : null
}
