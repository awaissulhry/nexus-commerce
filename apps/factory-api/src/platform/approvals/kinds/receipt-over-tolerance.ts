import type { Prisma } from '@nexus/factory-db'
import type { ApprovalField } from '@nexus/factory-domain/approvals/rules'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { eventFor } from '@nexus/factory-domain/events/define'
import { expectedBaseOf } from '@nexus/factory-domain/inventory/receipts/rules'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { events as followupEvents } from '@nexus/factory-domain/buying-followups/events'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * RECEIPT_OVER_TOLERANCE (B-W2b-377; follow-up XF5:03; SCM-061): a goods receipt line beyond its delivery tolerance, held
 * (`GoodsReceiptLine.heldForApprovalAt`) until a yes. modules/inventory/receiving/tolerance-hold.ts asks it in the receipt's
 * command (a switched-on rule names who decides; else the office role that decides purchase orders) and posts the receipt
 * after the last yes. This file reads only the database (no engine import: the registry loads it).
 *
 *   facts      how far over the order line it goes (percent, with what came before), the material's code and kind, the
 *              supplier's code, the site's code
 *   snapshot   the line as received (quantity, unit, base quantity, its order line) and its receipt's state: a change, or the
 *              receipt posted or cancelled meanwhile, makes it STALE
 *   yes        the line's hold cleared; the receipt's last one emits inventory.receipt_released (the worker posts it)
 *   no         the line stays held: the receipt is cancelled and received again within the tolerance
 */

export const KIND = 'RECEIPT_OVER_TOLERANCE' as const
const [, releasedEvent] = followupEvents

export const HOLD_WORDS = Object.freeze({
  held: (count: number) => `${count === 1 ? 'A line waits' : `${count} lines wait`} for a yes: the receipt is posted once ${count === 1 ? 'it is' : 'they are'} approved, or cancel it and receive within the tolerance.`,
  notOpen: 'This receipt is not waiting any more: it was posted or cancelled.',
  notHeld: 'This line is not held for a yes.',
  noDecider: 'Nobody decides a receipt beyond its tolerance: give an office role purchasing.manage and approvals.decide, or switch on an approval rule for it.',
  noBody: 'This receipt was not held for a yes: it is posted as it is recorded.',
  refused: 'A yes was refused for a line of this receipt: cancel it and receive within the tolerance.',
})

const LINE_SELECT = {
  id: true,
  seq: true,
  receiptId: true,
  purchaseOrderLineId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  heldForApprovalAt: true,
  version: true,
  item: { select: { code: true, name: true, kind: true } },
  receipt: { select: { id: true, number: true, status: true, companyId: true, siteId: true, purchaseOrderId: true, supplierId: true } },
} as const satisfies Prisma.GoodsReceiptLineSelect

/** How far beyond what the order line expects the line takes it, in percent (two places), with what came before it. */
async function overPctOf(client: Reader, line: { readonly id: string; readonly purchaseOrderLineId: string | null; readonly baseQuantity: { toString(): string } }): Promise<string | null> {
  if (!line.purchaseOrderLineId) return null
  const orderLine = await client.purchaseOrderLine.findUnique({ where: { id: line.purchaseOrderLineId }, select: { quantity: true, baseQuantity: true, confirmedQuantity: true } })
  if (!orderLine) return null
  const expected = expectedBaseOf({ quantity: orderLine.quantity.toString(), baseQuantity: orderLine.baseQuantity.toString(), confirmedQuantity: orderLine.confirmedQuantity?.toString() ?? null })
  if (expected.isZero()) return null
  const before = await client.goodsReceiptLine.findMany({ where: { purchaseOrderLineId: line.purchaseOrderLineId, receipt: { status: 'POSTED' } }, select: { baseQuantity: true } })
  const total = before.reduce((sum, row) => sum.plus(row.baseQuantity.toString()), new Dec(line.baseQuantity.toString()))
  return total.minus(expected).div(expected).times(100).toDecimalPlaces(2).toString()
}

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const line = isUuid(recordId) ? await client.goodsReceiptLine.findUnique({ where: { id: recordId }, select: LINE_SELECT }) : null
  if (!line) return null
  const [supplier, site] = await Promise.all([
    line.receipt.supplierId ? client.party.findUnique({ where: { id: line.receipt.supplierId }, select: { code: true } }) : Promise.resolve(null),
    client.site.findUnique({ where: { id: line.receipt.siteId }, select: { code: true } }),
  ])
  const over = await overPctOf(client, line)
  const held = line.receipt.status !== 'OPEN' ? HOLD_WORDS.notOpen : line.heldForApprovalAt === null ? HOLD_WORDS.notHeld : null
  return {
    companyId: line.receipt.companyId,
    siteId: line.receipt.siteId,
    // B-W2b-383 (B-W2b-382's gap): codes only, in no language ("GR-2026-0001/10 · SEED-PRO-300": the receipt, its line, the
    // material), as the web shows it inside its own words; the summary stays the API's (the web words the request from its facts).
    label: `${line.receipt.number}/${line.seq} · ${line.item.code}`.slice(0, 200),
    summary: `${line.receipt.number} line ${line.seq} (${line.item.code}): more than its delivery tolerance${over === null ? '' : ` (+${over} %)`}, to be posted`.slice(0, 500),
    facts: { overPct: over, itemCode: line.item.code, itemKind: line.item.kind, supplierCode: supplier?.code ?? null, siteCode: site?.code ?? null },
    // What is received is what the yes covers: a changed quantity or a receipt posted or cancelled meanwhile makes it STALE.
    snapshot: { lineId: line.id, receiptId: line.receiptId, purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity.toString(), uom: line.uom, baseQuantity: line.baseQuantity.toString(), receipt: line.receipt.status },
    changes: [{ field: 'status', from: 'OPEN', to: 'POSTED' }],
    held,
  }
}

/** On the yes: the line's hold cleared; the receipt's last one releases it (the worker posts it for the receiver). */
async function approved(tools: CommandTools, task: TaskRef): Promise<void> {
  const line = await tools.tx.goodsReceiptLine.findUnique({ where: { id: task.recordId }, select: LINE_SELECT })
  if (!line || line.receipt.status !== 'OPEN' || line.heldForApprovalAt === null) return
  await tools.tx.goodsReceiptLine.update({ where: { id: line.id }, data: { heldForApprovalAt: null, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'inventory.receiptLineApproved', recordType: 'GoodsReceipt', recordId: line.receiptId, companyId: line.receipt.companyId, siteId: line.receipt.siteId, after: { lineId: line.id, seq: line.seq, taskId: task.id, decidedById: task.decidedById } })
  const stillHeld = await tools.tx.goodsReceiptLine.count({ where: { receiptId: line.receiptId, heldForApprovalAt: { not: null } } })
  if (stillHeld === 0 && line.receipt.purchaseOrderId) {
    tools.emit(eventFor(releasedEvent, { subject: line.receiptId, companyId: line.receipt.companyId, siteId: line.receipt.siteId, payload: { receiptId: line.receiptId, number: line.receipt.number, purchaseOrderId: line.receipt.purchaseOrderId } }))
  }
}

/** On the no: the line stays held (the receipt is not posted); the audit says so. */
async function refused(tools: CommandTools, task: TaskRef): Promise<void> {
  const line = await tools.tx.goodsReceiptLine.findUnique({ where: { id: task.recordId }, select: LINE_SELECT })
  if (!line) return
  tools.audit({ action: 'inventory.receiptLineRefused', recordType: 'GoodsReceipt', recordId: line.receiptId, companyId: line.receipt.companyId, siteId: line.receipt.siteId, after: { lineId: line.id, seq: line.seq, taskId: task.id, decidedById: task.decidedById } })
}

export const RECEIPT_OVER_TOLERANCE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: KIND,
  recordType: 'GoodsReceiptLine',
  label: { en: 'Receipt beyond its tolerance', it: 'Ricevimento oltre la tolleranza' },
  view: INVENTORY_STOCK_VIEW,
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'overPct', label: { en: 'over the order', it: "oltre l'ordine" }, kind: 'number', unit: '%', min: 0 },
    { id: 'itemCode', label: { en: 'material code', it: 'codice materiale' }, kind: 'text' },
    { id: 'itemKind', label: { en: 'kind of material', it: 'tipo di materiale' }, kind: 'text' },
    { id: 'supplierCode', label: { en: 'supplier code', it: 'codice fornitore' }, kind: 'text' },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT r.id FROM "GoodsReceipt" r JOIN "GoodsReceiptLine" l ON l."receiptId" = r.id AND l."tenantId" = r."tenantId" WHERE l.id = ${recordId}::uuid FOR UPDATE OF r`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.goodsReceiptLine.findMany({ where: { purchaseOrderLineId: { not: null }, ...(companyId ? { receipt: { companyId } } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: approved,
  onRejected: refused,
  // The receipt opens (its lines show the hold).
  async parent(client: Reader, recordId: string) {
    const line = await client.goodsReceiptLine.findUnique({ where: { id: recordId }, select: { receiptId: true } })
    return line ? { type: 'GoodsReceipt', id: line.receiptId } : null
  },
})
