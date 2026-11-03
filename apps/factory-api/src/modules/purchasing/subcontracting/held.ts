import { receiptLineClientId } from '@nexus/factory-domain/production/scans/outside'
import type { Reader } from '../store'

/**
 * Goods back from a workshop held by their incoming inspection (B-W2b-111; QHS-036; design floor.kits "Finish receipt:
 * goods go to inspection before stock and before the workshop is paid"): the reads every holder shares, kept free of
 * the commands that post (costing reads it through cost-source.ts, payables through its match), so no import goes round.
 *
 *   held      the good pieces of a receipt whose incoming inspection is OPEN earn no fee (cost-source.ts) and are not
 *             counted good in the supplier invoice's match (payables/matching.ts) until it is decided;
 *   decided   the decision's rejected lines (bundles) are written on the receipt's own audit row
 *             (RECEIPT_INSPECTED_ACTION, inspection.ts): their good pieces moved to defective, never reported at the
 *             operation from the receipt line (production/scans outside.ts asks `receiptLineHold`);
 *   close     an order is not closed while one of its receipts waits for its inspection (orders.ts).
 */

/** The receipt's audit row the decision of its incoming inspection writes (inspection.ts). */
export const RECEIPT_INSPECTED_ACTION = 'purchasing.subcontract.receiptInspected'

/** The good pieces held per subcontract operation of these orders: the lines of receipts with an OPEN incoming inspection. */
export async function heldGoodByOperation(db: Reader, orderIds: readonly string[]): Promise<Map<string, number>> {
  const held = new Map<string, number>()
  if (orderIds.length === 0) return held
  const receipts = await db.subcontractReceipt.findMany({ where: { subcontractOrderId: { in: [...orderIds] }, incomingInspections: { some: { status: 'OPEN' } } }, select: { id: true } })
  if (receipts.length === 0) return held
  const lines = await db.subcontractReceiptLine.findMany({ where: { receiptId: { in: receipts.map((receipt) => receipt.id) } }, select: { subcontractOperationId: true, goodQuantity: true } })
  for (const line of lines) held.set(line.subcontractOperationId, (held.get(line.subcontractOperationId) ?? 0) + line.goodQuantity)
  return held
}

/** The OPEN incoming inspections of an order's receipts, by number (an order is not closed while one is open). */
export async function openInspectionsOfOrder(db: Reader, orderId: string): Promise<string[]> {
  const rows = await db.incomingInspection.findMany({ where: { status: 'OPEN', subcontractReceipt: { subcontractOrderId: orderId } }, select: { number: true }, orderBy: { number: 'asc' } })
  return rows.map((row) => row.number)
}

/** The lines a decided inspection of the receipt rejected (its audit row), by line id; empty: none rejected or not decided. */
export async function rejectedLinesOf(db: Reader, receiptId: string): Promise<{ number: string | null; lineIds: Set<string> }> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'SubcontractReceipt', recordId: receiptId, action: RECEIPT_INSPECTED_ACTION }, select: { after: true }, orderBy: { at: 'desc' } })
  const after = (row?.after ?? null) as { number?: unknown; rejectedLines?: unknown } | null
  const lineIds = new Set(Array.isArray(after?.rejectedLines) ? (after.rejectedLines as unknown[]).filter((id): id is string => typeof id === 'string') : [])
  return { number: typeof after?.number === 'string' ? after.number : null, lineIds }
}

/**
 * Why a receipt line may not be reported at its outside operation from the receipt now (null: it may): its receipt
 * waits for its incoming inspection, or the inspection rejected the line (its pieces are defective now: rework or the
 * workshop, not the next operation).
 */
export async function receiptLineHold(db: Reader, line: { readonly id: string; readonly receiptId: string }): Promise<string | null> {
  const open = await db.incomingInspection.findFirst({ where: { subcontractReceiptId: line.receiptId, status: 'OPEN' }, select: { number: true } })
  if (open) return `The goods of this receipt wait for incoming inspection ${open.number}: they are reported at the operation when it is decided.`
  const rejected = await rejectedLinesOf(db, line.receiptId)
  if (rejected.lineIds.has(line.id)) return `Incoming inspection ${rejected.number ?? ''} rejected this line: its pieces are not reported good at the operation (rework them or send them back to the workshop).`.replace('  ', ' ')
  return null
}

/** The lines of these receipts already reported at their operation from the receipt (a scan with the line's client id). */
export async function reportedLines(db: Reader, workOrderId: string, lineIds: readonly string[]): Promise<Map<string, string>> {
  if (lineIds.length === 0) return new Map()
  const byClient = new Map(lineIds.map((id) => [receiptLineClientId(id), id]))
  const scans = await db.operationScan.findMany({ where: { workOrderId, deviceId: null, clientScanId: { in: [...byClient.keys()] } }, select: { id: true, clientScanId: true }, orderBy: { serverTime: 'asc' } })
  const found = new Map<string, string>()
  for (const scan of scans) {
    const lineId = scan.clientScanId ? byClient.get(scan.clientScanId) : undefined
    if (lineId && !found.has(lineId)) found.set(lineId, scan.id)
  }
  return found
}
