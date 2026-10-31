import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_RECEIVE } from '@nexus/factory-domain/inventory/permissions'
import { ddtCorrectionProblems, ddtCorrectionStateProblem, ddtCorrectionValues } from '@nexus/factory-domain/inventory/receipts/ddt-correction'
import { command, type CommandCaller } from '../../../core/command'
import { receiptDetail, visibleReceipt } from './read'
import { RECEIPT_COLUMNS } from './store'

/**
 * Correcting the supplier's DDT number and date on a posted goods receipt (B-W2b-14; B-W2a-31's follow-up Z1:02; SCM-115;
 * design warehouse.receipts rec "Documents check" — the supplier DDT number/date). Office only, inventory.receive (who
 * records a receipt types its DDT) at the receipt's company and site.
 *
 *   POST /inventory/receipts/:receiptId/supplier-ddt {version, supplierDdtNumber, supplierDdtDate, reason}
 *
 * ONE command on the receipt's version (command()'s record check): the receipt read again, POSTED only (409 in words for
 * an open, reversed or cancelled one), the domain's problems (400: a reason, a real change, a date not after today in
 * Rome, a date only with its number), then ONE UPDATE of the number and date with the correction's when (the command's
 * time: later than any earlier correction), who and why — the W2b factory_goods_receipt_guard refuses a change without
 * them, and them without a change. The audit row keeps the before and the after (every correction, while the receipt
 * keeps the latest); `inventory.receipt_ddt_corrected` refreshes the receipt's screens. No move, no lot, no value changes.
 */

export interface DdtCorrectionBody {
  readonly version: number
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: string | null
  readonly reason: string
}

const day = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))

/** POST /inventory/receipts/:receiptId/supplier-ddt */
export async function correctSupplierDdt(caller: CommandCaller, receiptId: string, body: DdtCorrectionBody, idempotencyKey?: string) {
  const { receipt: seen } = await visibleReceipt(caller, receiptId, INVENTORY_RECEIVE)
  const { result } = await command(
    caller,
    { name: 'inventory.correctSupplierDdt', idempotencyKey, input: { receiptId, ...body }, record: { type: 'GoodsReceipt', id: seen.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const receipt = (await tx.goodsReceipt.findUnique({ where: { id: seen.id }, select: RECEIPT_COLUMNS }))!
      const state = ddtCorrectionStateProblem({ number: receipt.number, status: receipt.status })
      if (state) throw new InvalidStateError(state)
      const facts = { number: receipt.number, status: receipt.status, supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: day(receipt.supplierDdtDate) }
      const input = { supplierDdtNumber: body.supplierDdtNumber, supplierDdtDate: body.supplierDdtDate, reason: body.reason }
      const problems = ddtCorrectionProblems(facts, input, businessDate(now))
      if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The correction is not complete.', problems)
      const values = ddtCorrectionValues(input)
      const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
      await tx.goodsReceipt.update({
        where: { id: receipt.id },
        data: {
          supplierDdtNumber: values.supplierDdtNumber,
          supplierDdtDate: values.supplierDdtDate ? new Date(`${values.supplierDdtDate}T00:00:00.000Z`) : null,
          supplierDdtCorrectedAt: now,
          supplierDdtCorrectedById: actorId,
          supplierDdtCorrectionReason: values.reason,
        },
        select: { id: true },
      })
      tools.audit({
        action: 'inventory.supplierDdtCorrected',
        recordType: 'GoodsReceipt',
        recordId: receipt.id,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        reason: values.reason,
        before: { supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: facts.supplierDdtDate },
        after: { supplierDdtNumber: values.supplierDdtNumber, supplierDdtDate: values.supplierDdtDate },
      })
      tools.emit({
        type: 'inventory.receipt_ddt_corrected',
        subject: receipt.id,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        payload: { receiptId: receipt.id, number: receipt.number, supplierDdtNumber: values.supplierDdtNumber, supplierDdtDate: values.supplierDdtDate },
      })
      return { id: receipt.id }
    },
  )
  const { context, receipt } = await visibleReceipt(caller, result.id)
  return { receipt: await caller.withClient((client) => receiptDetail(client, context, receipt)) }
}
