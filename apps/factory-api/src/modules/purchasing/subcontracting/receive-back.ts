import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { REASON_CODE } from '@nexus/factory-domain/production/scans/reasons'
import type { CommandTools } from '../../../core/command'
import { reportOutsideInCommand, type OutsideReport } from '../../production/scans/outside'
import { scanWorkOrderLock } from '../../production/scans/store'
import { tenantOf } from '../../shipping/cells'
import { dayOf, type Reader } from '../store'
import type { OperationRow, OrderRow } from './store'

/**
 * Goods back from a workshop as records (B-W2b-10; the follow-up of B-W2a-25 and B-W2a-76 on B-W2b-01's tables): the
 * receive command (receive.ts, the office's and the floor's kit task's one body) writes each visit as a SubcontractReceipt
 * with one SubcontractReceiptLine per operation and bundle, and reports each bundle that came back at its outside
 * operation (modules/production/scans outside.ts: the scan names the receipt line, never a worker or station); the kit
 * send (kit.ts) writes one SubcontractBundle per bundle that goes out. The record's "Received back" and the floor's kit
 * view read these tables (receipts recorded before W2b are read from their audit rows, views.ts).
 *
 *   receipt  seq = the order's receipts + 1; the workshop's DDT number and date; the TRANSFER moves of the material back;
 *            the note; the floor device it came in on (null: the office); createdById the office user (null: the floor's
 *            system caller, whose audit row names the tablet and its worker inside the one record).
 *   lines    seq 10, 20 …; the counts; the reason: a code of the tenant's REWORK list is kept as reasonCode (the floor
 *            sends the code it picked, B-W2a-76), other words as reasonNote.
 *   locks    the work order's scan lock (SHARED) is taken before the stock moves when a line names a bundle, so the order
 *            of locks is the scans' and the issues' (work order → stock), never the other way round.
 */

export interface ReceiptLineDraft {
  readonly operationId: string
  readonly bundleId: string | null
  readonly good: number
  readonly defective: number
  readonly scrapped: number
  readonly reason: string | null
}

export interface ReceiptDraft {
  readonly receiptId: string
  readonly receivedAt: Date
  readonly lines: readonly ReceiptLineDraft[]
  readonly returnMoveIds: readonly string[]
  readonly supplierDdt: { readonly number: string; readonly date?: string | null | undefined } | null
  readonly note: string | null
  readonly deviceId: string | null
}

export interface RecordedReceipt {
  readonly id: string
  readonly seq: number
  readonly lines: readonly { readonly id: string; readonly seq: number; readonly operationId: string; readonly bundleId: string | null; readonly good: number; readonly defective: number; readonly scrapped: number; readonly reasonCode: string | null }[]
}

/** The receive command's first step when bundles come back: the work order's scan lock, before any stock move. */
export async function lockForOutsideReports(tools: CommandTools, order: Pick<OrderRow, 'workOrderId'>, lines: readonly { readonly bundleId?: string | null | undefined }[]): Promise<void> {
  if (!lines.some((line) => line.bundleId)) return
  await scanWorkOrderLock(tools.tx, tenantOf(tools.context), order.workOrderId)
}

/** Writes the receipt and its lines inside the receive command (after the moves, the counts and the order's status). */
export async function recordReceiptInCommand(tools: CommandTools, order: Pick<OrderRow, 'id' | 'siteId' | 'workOrderId'>, draft: ReceiptDraft): Promise<RecordedReceipt> {
  const { tx } = tools
  const person = tools.context.audience === 'office' ? tools.context.actorId : null
  const seq = (await tx.subcontractReceipt.count({ where: { subcontractOrderId: order.id } })) + 1
  // The floor device it came in on, when it is a device of the order's site on record (the audit row names it anyway).
  const device = draft.deviceId ? await tx.device.findFirst({ where: { id: draft.deviceId, siteId: order.siteId }, select: { id: true } }) : null
  await tx.subcontractReceipt.create({
    data: {
      id: draft.receiptId,
      siteId: order.siteId,
      workOrderId: order.workOrderId,
      subcontractOrderId: order.id,
      seq,
      receivedAt: draft.receivedAt,
      workshopDdtNumber: draft.supplierDdt ? draft.supplierDdt.number.trim() : null,
      workshopDdtDate: draft.supplierDdt?.date ? new Date(`${draft.supplierDdt.date}T00:00:00.000Z`) : null,
      returnMoveIds: [...draft.returnMoveIds],
      note: draft.note,
      deviceId: device?.id ?? null,
      createdAt: tools.now,
      createdById: person,
    },
    select: { id: true },
  })
  const asked = [...new Set(draft.lines.map((line) => line.reason).filter((reason): reason is string => reason !== null && REASON_CODE.test(reason)))]
  const reworkCodes = asked.length > 0 ? new Set((await tx.scrapReason.findMany({ where: { kind: 'REWORK', code: { in: asked } }, select: { code: true } })).map((row) => row.code)) : new Set<string>()
  const lines = draft.lines.map((line, index) => {
    const code = line.reason !== null && reworkCodes.has(line.reason) ? line.reason : null
    return { id: newId(), seq: (index + 1) * 10, operationId: line.operationId, bundleId: line.bundleId, good: line.good, defective: line.defective, scrapped: line.scrapped, reasonCode: code, reasonNote: code === null ? line.reason : null }
  })
  if (lines.length > 0) {
    await tx.subcontractReceiptLine.createMany({
      data: lines.map((line) => ({
        id: line.id,
        siteId: order.siteId,
        workOrderId: order.workOrderId,
        receiptId: draft.receiptId,
        seq: line.seq,
        subcontractOperationId: line.operationId,
        bundleId: line.bundleId,
        goodQuantity: line.good,
        defectiveQuantity: line.defective,
        scrappedQuantity: line.scrapped,
        reasonCode: line.reasonCode,
        reasonNote: line.reasonNote,
        createdAt: tools.now,
        createdById: person,
      })),
    })
  }
  return { id: draft.receiptId, seq, lines }
}

/** Reports the bundles that came back at their outside operations (the scans module), after the receipt is written. */
export async function reportReceiptInCommand(tools: CommandTools, order: Pick<OrderRow, 'workOrderId' | 'number'>, operations: readonly Pick<OperationRow, 'id' | 'workOrderOperationId'>[], receipt: RecordedReceipt): Promise<OutsideReport[]> {
  const stepOf = new Map(operations.map((operation) => [operation.id, operation.workOrderOperationId]))
  return reportOutsideInCommand(
    tools,
    { workOrderId: order.workOrderId, number: order.number },
    receipt.lines.map((line) => ({ lineId: line.id, receiptSeq: receipt.seq, bundleId: line.bundleId, workOrderOperationId: stepOf.get(line.operationId)!, good: line.good, defective: line.defective, scrapped: line.scrapped, reasonCode: line.reasonCode })),
  )
}

/**
 * The kit send's bundles as SubcontractBundle rows (one per order and bundle, the garments it carried as cut, as the kit
 * counts the pieces out), inside the send command; a bundle that went out with the order already is refused in words.
 */
export async function recordBundlesSentInCommand(tools: CommandTools, order: Pick<OrderRow, 'id' | 'siteId' | 'workOrderId'>, bundles: readonly { readonly id: string; readonly code: string; readonly quantity: number }[]): Promise<void> {
  if (bundles.length === 0) return
  const out = await bundlesSentOf(tools.tx, order.id)
  const again = bundles.findIndex((bundle) => out.has(bundle.id))
  if (again >= 0) throw new ValidationError(`Bundle ${bundles[again]!.code} went out with this order already.`, [{ path: `body/bundles/${again}/bundleId`, message: `Bundle ${bundles[again]!.code} went out with this order already.` }])
  await tools.tx.subcontractBundle.createMany({
    data: bundles.map((bundle) => ({
      id: newId(),
      siteId: order.siteId,
      workOrderId: order.workOrderId,
      subcontractOrderId: order.id,
      bundleId: bundle.id,
      quantity: bundle.quantity,
      sentAt: tools.now,
      createdAt: tools.now,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    })),
  })
}

/** The bundles the order sent out (SubcontractBundle), each once. */
export async function bundlesSentOf(db: Reader, orderId: string): Promise<Set<string>> {
  return new Set((await db.subcontractBundle.findMany({ where: { subcontractOrderId: orderId }, select: { bundleId: true } })).map((row) => row.bundleId))
}

/** A receipt as the record reads it (views.ts StoredReceipt with when and by whom it was recorded). */
export interface TableReceipt {
  readonly receiptId: string
  readonly receivedAt: string
  readonly lines: readonly { readonly operationId: string; readonly seq: number; readonly code: string; readonly bundleId: string | null; readonly good: number; readonly defective: number; readonly scrapped: number; readonly reason: string | null }[]
  readonly returns: readonly { readonly moveId: string; readonly itemId: string; readonly itemColourId: string | null; readonly lotId: string | null; readonly hideId: string | null; readonly quantity: string; readonly uom: string; readonly toLocationId: string }[]
  readonly supplierDdt: { readonly number: string; readonly date: string | null } | null
  readonly note: string | null
  readonly recordedAt: Date
  readonly byId: string | null
}

/** The order's receipts from their tables, oldest first (the lines per operation and bundle, the material back). */
export async function receiptsOfOrder(db: Reader, orderId: string): Promise<TableReceipt[]> {
  const receipts = await db.subcontractReceipt.findMany({
    where: { subcontractOrderId: orderId },
    select: { id: true, seq: true, receivedAt: true, workshopDdtNumber: true, workshopDdtDate: true, returnMoveIds: true, note: true, createdAt: true, createdById: true },
    orderBy: { seq: 'asc' },
  })
  if (receipts.length === 0) return []
  const lines = await db.subcontractReceiptLine.findMany({
    where: { receiptId: { in: receipts.map((receipt) => receipt.id) } },
    select: { receiptId: true, seq: true, subcontractOperationId: true, bundleId: true, goodQuantity: true, defectiveQuantity: true, scrappedQuantity: true, reasonCode: true, reasonNote: true },
    orderBy: [{ receiptId: 'asc' }, { seq: 'asc' }],
  })
  const operations = await db.subcontractOperation.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.subcontractOperationId))] } }, select: { id: true, seq: true, workOrderOperationId: true } })
  const steps = new Map((await db.workOrderOperation.findMany({ where: { id: { in: operations.map((row) => row.workOrderOperationId) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const operationOf = new Map(operations.map((row) => [row.id, row]))
  const moves = new Map(
    (
      await db.stockMove.findMany({
        where: { id: { in: receipts.flatMap((receipt) => receipt.returnMoveIds) } },
        select: { id: true, itemId: true, itemColourId: true, lotId: true, hideId: true, quantity: true, uom: true, toLocationId: true },
      })
    ).map((row) => [row.id, row]),
  )
  return receipts.map((receipt) => ({
    receiptId: receipt.id,
    receivedAt: toUtcIso(receipt.receivedAt),
    lines: lines
      .filter((line) => line.receiptId === receipt.id)
      .map((line) => {
        const operation = operationOf.get(line.subcontractOperationId)
        return {
          operationId: line.subcontractOperationId,
          seq: operation?.seq ?? 0,
          code: operation ? (steps.get(operation.workOrderOperationId) ?? '') : '',
          bundleId: line.bundleId,
          good: line.goodQuantity,
          defective: line.defectiveQuantity,
          scrapped: line.scrappedQuantity,
          reason: line.reasonCode ?? line.reasonNote,
        }
      }),
    returns: receipt.returnMoveIds.flatMap((id) => {
      const move = moves.get(id)
      return move
        ? [{ moveId: move.id, itemId: move.itemId, itemColourId: move.itemColourId, lotId: move.lotId, hideId: move.hideId, quantity: move.quantity.toString(), uom: move.uom, toLocationId: move.toLocationId ?? '' }]
        : []
    }),
    supplierDdt: receipt.workshopDdtNumber ? { number: receipt.workshopDdtNumber, date: dayOf(receipt.workshopDdtDate) } : null,
    note: receipt.note,
    recordedAt: receipt.createdAt,
    byId: receipt.createdById,
  }))
}
