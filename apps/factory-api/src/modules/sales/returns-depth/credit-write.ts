import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { CREDIT_WITHOUT_RETURN_STATUSES } from '@nexus/factory-domain/sales/returns-depth/rules'
import type { ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandTools } from '../../../core/command'
import { touchReturn } from '../returns/rma'
import { LINE_COLUMNS, LINE_RECORD, readRma } from '../returns/store'

/**
 * The write of a credit without the goods (B-W2b-341; SAL-342), inside a command: the office's own (no approval rule
 * asked a yes) or the approver's yes (platform/approvals/kinds/credit-without-return.ts onApproved). The line is
 * CREDIT_ONLY, credited without a return, decided with when and by whom (the person who asked: the approver's yes is on the
 * request), with its credit; the RMA's version moves on; W2a's `return.credit_due` (the credit note's worker listens) and
 * `return.credited_without_return`. Checked again here, as the …_service_safety_w2b_guards trigger will: nothing of the
 * line arrived and it is not decided, the RMA is open to it.
 */
export async function creditWithoutReturnInCommand(tools: CommandTools, input: { readonly lineId: string; readonly creditAmount: number; readonly decidedById: string; readonly taskId: string | null }): Promise<void> {
  const { tx, now } = tools
  const line = await tx.returnLine.findUnique({ where: { id: input.lineId }, select: LINE_COLUMNS })
  if (!line) throw new NotFoundError('Return line not found.')
  const rma = await readRma(tx, line.returnId)
  if (!rma) throw new NotFoundError('Return not found.')
  if (!CREDIT_WITHOUT_RETURN_STATUSES.includes(rma.status as ReturnStatus)) throw new DomainError('invalid_state', `Return ${rma.number} is ${rma.status.toLowerCase()}: nothing more is credited on it.`)
  if (line.disposition !== null || line.receivedQuantity > 0) throw new DomainError('conflict', `Line ${line.seq} of ${rma.number} is ${line.disposition !== null ? 'decided already' : 'partly back with us'}: it is not credited without the goods.`)
  if (!Number.isSafeInteger(input.creditAmount) || input.creditAmount <= 0) throw new DomainError('conflict', 'A credit without the goods is above 0.')
  await tx.returnLine.update({
    where: { id: line.id },
    data: { creditWithoutReturn: true, disposition: 'CREDIT_ONLY', decidedAt: now, decidedById: input.decidedById, creditAmount: input.creditAmount, updatedAt: now, version: { increment: 1 } },
    select: { id: true },
  })
  await touchReturn(tools, rma)
  tools.audit({
    action: 'returnsDepth.creditWithoutReturn',
    recordType: LINE_RECORD,
    recordId: line.id,
    companyId: rma.companyId,
    siteId: rma.siteId,
    before: { disposition: null, creditWithoutReturn: false },
    after: { disposition: 'CREDIT_ONLY', creditWithoutReturn: true, creditAmount: markMoney('price', input.creditAmount), decidedById: input.decidedById, approvalTaskId: input.taskId },
  })
  tools.emit({ type: 'return.credited_without_return', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, partyId: rma.partyId, lineIds: [line.id], approvalTaskId: input.taskId } })
  tools.emit({ type: 'return.credit_due', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, partyId: rma.partyId, lineIds: [line.id] } })
}
