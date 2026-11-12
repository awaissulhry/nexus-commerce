import { toUtcIso } from '@nexus/factory-domain/core/time'
import { backTotal, bundleStateOf, type BundleBack } from '@nexus/factory-domain/purchasing/subcontract-depth/bundles'
import type { CommandCaller } from '../../../core/command'
import type { Reader } from '../store'
import { officeOrder, readOperations, sizesOf, type OrderRow } from '../subcontracting/store'
import { storedReceipts } from '../subcontracting/views'

/**
 * Partial returns by bundle (B-W2b-331; SCM-145; design floor.kits "Receive back": "Rows per bundle and size: out / back /
 * rejected"; factory-db SubcontractBundle, SubcontractReceiptLine). Office only; no money.
 *
 *   out      the bundles that went out with the order: its SubcontractBundle rows (B-W2b-10: the garments each carried as
 *            cut), and before them the kit send's audit rows (`purchasing.subcontract.sendKit`, after.bundles)
 *   read     GET …/orders/:id/bundles (purchasing.view): per bundle its cell, part and garments out; per operation of the
 *            order that sends its cell what came back good, defective and scrapped over every receipt and what is still
 *            out; its state (OUT, PARTLY_BACK, BACK) and the receipts it came back in; bundles that came back without a
 *            send on record; the counts
 *   receive  ../subcontracting/receive.ts asks `bundlesOutOf` (the bundles hook): once the order's bundles are on record a
 *            receipt names only those, and never more of one than it carried out (factory-domain subcontract-depth/bundles)
 */

const SEND_ACTION = 'purchasing.subcontract.sendKit'
const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]

export interface BundlesOut {
  /** The order's bundles out are on record (some went out with it): a receipt names only those. */
  readonly onRecord: boolean
  /** Per bundle: the garments it carried out, and when. */
  readonly out: ReadonlyMap<string, { readonly garments: number; readonly sentAt: Date | null }>
}

/** The bundles that went out with the order (SubcontractBundle rows; before them the send's audit rows). */
export async function bundlesOutOf(db: Reader, orderId: string): Promise<BundlesOut> {
  const out = new Map<string, { garments: number; sentAt: Date | null }>()
  for (const row of await db.subcontractBundle.findMany({ where: { subcontractOrderId: orderId }, select: { bundleId: true, quantity: true, sentAt: true }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }] })) {
    out.set(row.bundleId, { garments: row.quantity, sentAt: row.sentAt })
  }
  const sends = await db.auditLog.findMany({ where: { recordType: 'SubcontractOrder', recordId: orderId, action: SEND_ACTION }, select: { at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  for (const send of sends) {
    const after = send.after as { bundles?: unknown } | null
    for (const entry of Array.isArray(after?.bundles) ? after.bundles : []) {
      const row = entry as { bundleId?: unknown; quantity?: unknown } | null
      if (typeof row?.bundleId === 'string' && !out.has(row.bundleId)) out.set(row.bundleId, { garments: typeof row.quantity === 'number' ? row.quantity : 0, sentAt: send.at })
    }
  }
  return { onRecord: out.size > 0, out }
}

/** The Bundles view of the order. */
export async function bundlesView(db: Reader, order: OrderRow) {
  const { onRecord, out } = await bundlesOutOf(db, order.id)
  const operations = await readOperations(db, order.id)
  const steps = new Map((await db.workOrderOperation.findMany({ where: { id: { in: operations.map((row) => row.workOrderOperationId) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const receipts = await storedReceipts(db, order.id)
  const tables = new Map((await db.subcontractReceipt.findMany({ where: { subcontractOrderId: order.id }, select: { id: true, seq: true } })).map((row) => [row.id, row.seq]))
  const back = new Map<string, Map<string, BundleBack>>()
  const cameIn = new Map<string, { id: string; seq: number; receivedAt: string }[]>()
  for (const [index, receipt] of receipts.entries()) {
    for (const line of receipt.lines) {
      if (!line.bundleId) continue
      const perOperation = back.get(line.bundleId) ?? new Map<string, BundleBack>()
      const was = perOperation.get(line.operationId) ?? { good: 0, defective: 0, scrapped: 0 }
      perOperation.set(line.operationId, { good: was.good + line.good, defective: was.defective + line.defective, scrapped: was.scrapped + line.scrapped })
      back.set(line.bundleId, perOperation)
      const seen = cameIn.get(line.bundleId) ?? []
      if (!seen.some((entry) => entry.id === receipt.receiptId)) seen.push({ id: receipt.receiptId, seq: tables.get(receipt.receiptId) ?? index + 1, receivedAt: receipt.receivedAt })
      cameIn.set(line.bundleId, seen)
    }
  }
  const ids = unique([...out.keys(), ...back.keys()])
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, workOrderSizeId: true, quantity: true, part: true } })).map((row) => [row.id, row]))
  const cells = await db.workOrderSize.findMany({ where: { id: { in: unique([...bundles.values()].map((row) => row.workOrderSizeId)) } }, select: { id: true, size: true, colourwayId: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const cellOf = new Map(cells.map((cell) => [cell.id, { colourway: colourways.get(cell.colourwayId) ?? '', size: cell.size }]))
  // The operations of the order a bundle goes through: those that send its cell (an operation without sizes sends every cell).
  const through = (workOrderSizeId: string) => operations.filter((operation) => {
    const sizes = sizesOf(operation.sizes)
    return sizes.length === 0 || sizes.some((size) => size.workOrderSizeId === workOrderSizeId)
  })
  const rowOf = (bundleId: string) => {
    const bundle = bundles.get(bundleId)
    const sent = out.get(bundleId)
    const garments = sent?.garments || bundle?.quantity || 0
    const cell = bundle ? cellOf.get(bundle.workOrderSizeId) : undefined
    const perOperation = (bundle ? through(bundle.workOrderSizeId) : operations).map((operation) => {
      const came = back.get(bundleId)?.get(operation.id) ?? { good: 0, defective: 0, scrapped: 0 }
      return { operationId: operation.id, seq: operation.seq, code: steps.get(operation.workOrderOperationId) ?? '', ...came, back: backTotal(came), stillOut: Math.max(0, garments - backTotal(came)) }
    })
    return {
      bundle: { id: bundleId, code: bundle?.code ?? '', part: bundle?.part ?? null, workOrderSizeId: bundle?.workOrderSizeId ?? null, colourway: cell?.colourway ?? '', size: cell?.size ?? '' },
      garments,
      sentAt: sent?.sentAt ? toUtcIso(sent.sentAt) : null,
      operations: perOperation,
      state: bundleStateOf(garments, perOperation),
      receipts: cameIn.get(bundleId) ?? [],
    }
  }
  const rows = [...out.keys()].map(rowOf).sort((a, b) => (a.bundle.code < b.bundle.code ? -1 : a.bundle.code > b.bundle.code ? 1 : 0))
  return {
    order: { id: order.id, number: order.number, status: order.status, version: order.version },
    onRecord,
    bundles: rows,
    backWithoutSend: [...back.keys()].filter((id) => !out.has(id)).map(rowOf),
    counts: { out: rows.filter((row) => row.state === 'OUT').length, partlyBack: rows.filter((row) => row.state === 'PARTLY_BACK').length, back: rows.filter((row) => row.state === 'BACK').length },
  }
}

/** GET /purchasing/subcontracting/orders/:subcontractOrderId/bundles */
export async function orderBundles(caller: CommandCaller, orderId: string) {
  const { order } = await officeOrder(caller, orderId)
  return caller.withClient((client) => bundlesView(client, order))
}
