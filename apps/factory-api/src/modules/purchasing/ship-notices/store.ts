import type { Prisma, Uom } from '@nexus/factory-db'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { expectedBaseOf } from '@nexus/factory-domain/inventory/receipts/rules'
import {
  checkShipNotice,
  differingLines,
  noticeStateOf,
  NOTICE_STATE_WORDS,
  VERDICT_WORDS,
  type NoticeHideFacts,
  type NoticeLineFacts,
  type OrderLineFacts,
  type PackingCheck,
} from '@nexus/factory-domain/purchasing/ship-notices/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { documentsOf } from '../../../platform/files/required/check'
import { readColours, readItems, readOrderLines } from '../../inventory/receipts/store'
import { dayOf, type Reader } from '../store'

/**
 * Ship notices' reads (B-W2b-182), shared by the portal (modules/purchasing/ship-notices/portal.ts), the office's dock
 * (modules/inventory/receiving/from-ship-notice.ts) and the inbound board (./inbound.ts). Two readers, as every supplier page:
 *
 *   the session's own scope    the notice, its lines and hides, the order and its lines (the partner role's grants: no price,
 *                              no internal note, no office person; another party's notice is as unknown as a wrong id)
 *   the tenant's system scope  for THIS notice's order only, what the partner role may not read but the checks need: the
 *                              material (code, name, kept by hide), the colour's name, what our receipts took of each line
 *                              (quantities) and in which dye batches, the supplier's other sent notices, and whether a Cr VI
 *                              test report is on file (the notice's or the supplier's documents)
 */

const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
const qty = (value: Decimal): string => value.toFixed(4)

/** The columns a partner may read of a notice (never internalNote or createdById: the partner role's grants hide them). */
export const NOTICE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  purchaseOrderId: true,
  number: true,
  status: true,
  supplierRef: true,
  ddtNumber: true,
  ddtDate: true,
  shipDate: true,
  expectedDate: true,
  carrier: true,
  trackingNumber: true,
  parcels: true,
  note: true,
  sentAt: true,
  receivedAt: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ShipNoticeSelect
export type NoticeRow = Prisma.ShipNoticeGetPayload<{ select: typeof NOTICE_COLUMNS }>

export const LINE_COLUMNS = { id: true, seq: true, purchaseOrderLineId: true, quantity: true, uom: true, supplierLot: true, dyeBatch: true, note: true, receivedQuantity: true, version: true } as const satisfies Prisma.ShipNoticeLineSelect
export type NoticeLineRow = Prisma.ShipNoticeLineGetPayload<{ select: typeof LINE_COLUMNS }>
export const HIDE_COLUMNS = { id: true, shipNoticeLineId: true, seq: true, hideNumber: true, area: true, areaUom: true, grade: true, thicknessMm: true, dyeBatch: true, note: true } as const satisfies Prisma.ShipNoticeHideSelect
export type NoticeHideRow = Prisma.ShipNoticeHideGetPayload<{ select: typeof HIDE_COLUMNS }>

export async function readNotice(db: Reader, noticeId: string): Promise<NoticeRow | null> {
  return db.shipNotice.findUnique({ where: { id: noticeId }, select: NOTICE_COLUMNS })
}

export async function readNoticeLines(db: Reader, noticeId: string): Promise<{ lines: NoticeLineRow[]; hides: NoticeHideRow[] }> {
  const lines = await db.shipNoticeLine.findMany({ where: { shipNoticeId: noticeId }, orderBy: { seq: 'asc' }, select: LINE_COLUMNS })
  const hides = await db.shipNoticeHide.findMany({ where: { shipNoticeId: noticeId }, orderBy: [{ shipNoticeLineId: 'asc' }, { seq: 'asc' }], select: HIDE_COLUMNS })
  return { lines, hides }
}

/** An order line as the supplier and the checks read it (the material read in the system scope; never a price). */
export interface OrderLineView {
  readonly id: string
  readonly seq: number
  readonly uom: Uom
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly leather: boolean; readonly tracking: string }
  readonly colour: { readonly id: string; readonly name: string } | null
  readonly supplierArticleCode: string | null
  readonly needDate: BusinessDate
  readonly confirmedDate: BusinessDate | null
  readonly ended: boolean
  readonly facts: OrderLineFacts
}

/**
 * The order's lines with what the checks need (system scope, ONE order): the material, what our posted receipts took and
 * in which dye batches, what the supplier's other SENT notices carry. Quantities in each line's own unit.
 */
export async function orderLinesOf(system: Reader, orderId: string, exceptNoticeId: string | null): Promise<OrderLineView[]> {
  const { lines, received } = await readOrderLines(system, orderId)
  const items = await readItems(system, lines.map((line) => line.itemId))
  const colours = await readColours(system, lines.map((line) => line.itemColourId))
  const articles = new Map((await system.purchaseOrderLine.findMany({ where: { purchaseOrderId: orderId }, select: { id: true, supplierArticleCode: true } })).map((row) => [row.id, row.supplierArticleCode]))
  const lineIds = lines.map((line) => line.id)
  const transit = await system.shipNoticeLine.groupBy({
    by: ['purchaseOrderLineId'],
    where: { purchaseOrderLineId: { in: lineIds }, shipNotice: { status: 'SENT', ...(exceptNoticeId ? { id: { not: exceptNoticeId } } : {}) } },
    _sum: { quantity: true },
  })
  const inTransit = new Map(transit.map((row) => [row.purchaseOrderLineId, new Dec(row._sum.quantity?.toString() ?? '0')]))
  const lots = lineIds.length === 0 ? [] : await system.lot.findMany({ where: { receiptLine: { purchaseOrderLineId: { in: lineIds }, receipt: { status: 'POSTED' } }, dyeBatch: { not: null } }, select: { dyeBatch: true, receiptLine: { select: { purchaseOrderLineId: true } } } })
  const batches = new Map<string, Set<string>>()
  for (const lot of lots) {
    const lineId = lot.receiptLine?.purchaseOrderLineId
    if (!lineId || !lot.dyeBatch) continue
    batches.set(lineId, (batches.get(lineId) ?? new Set()).add(lot.dyeBatch))
  }
  return lines.map((line) => {
    const item = items.get(line.itemId)!
    const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
    const quantity = new Dec(line.quantity.toString())
    const base = new Dec(line.baseQuantity.toString())
    // In the line's unit: what is expected (the confirmation, else the order) and what our receipts took.
    const expected = line.confirmedQuantity === null ? quantity : new Dec(line.confirmedQuantity.toString())
    const receivedBase = received.get(line.id) ?? ZERO
    const receivedQty = base.isZero() ? ZERO : receivedBase.times(quantity).dividedBy(base)
    const facts: OrderLineFacts = {
      id: line.id,
      seq: line.seq,
      uom: line.uom,
      leather: item.tracking === 'HIDE',
      expected: qty(expected),
      received: qty(receivedQty),
      inTransit: qty(inTransit.get(line.id) ?? ZERO),
      tolerancePct: line.areaTolerancePct === null ? null : line.areaTolerancePct.toString(),
      grade: line.grade,
      thicknessMinMm: line.thicknessMinMm === null ? null : line.thicknessMinMm.toString(),
      thicknessMaxMm: line.thicknessMaxMm === null ? null : line.thicknessMaxMm.toString(),
      oneDyeBatch: line.oneDyeBatch,
      estimatedHides: line.estimatedHides,
      requiresCrViTest: line.requiresCrViTest,
      earlierDyeBatches: [...(batches.get(line.id) ?? [])].sort(),
    }
    return {
      id: line.id,
      seq: line.seq,
      uom: line.uom,
      item: { id: item.id, code: item.code, name: item.name, leather: item.tracking === 'HIDE', tracking: item.tracking },
      colour: colour ? { id: colour.id, name: colour.name } : null,
      supplierArticleCode: articles.get(line.id) ?? null,
      needDate: dayOf(line.needDate)!,
      confirmedDate: dayOf(line.confirmedDate),
      ended: line.cancelledAt !== null || line.closedShortAt !== null || (line.confirmedQuantity !== null && line.confirmedQuantity.isZero()),
      facts,
    }
  })
}

/** What stays open of an order line for the supplier to ship: expected − received − on other sent notices (never below 0). */
export const openOf = (facts: OrderLineFacts): Decimal => Dec.max(ZERO, new Dec(facts.expected).minus(facts.received).minus(facts.inTransit))

/** Whether the base the order expects is complete (W1's tolerance); a line that is complete takes no notice. */
export const expectedBase = (line: { quantity: { toString(): string }; baseQuantity: { toString(): string }; confirmedQuantity: { toString(): string } | null }): Decimal =>
  expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null })

/** A current Cr VI test report on file: a TEST_REPORT of the notice or of the supplier, not expired (B-W2b-177's documents). */
export async function crViEvidenceOf(system: Reader, noticeId: string, partyId: string, today: BusinessDate): Promise<boolean> {
  const documents = await documentsOf(system as Parameters<typeof documentsOf>[0], 'ShipNotice', noticeId, partyId)
  return documents.some((file) => file.category === 'TEST_REPORT' && (file.expiresOn === null || dayOf(file.expiresOn)! >= today))
}

/** The checks of a notice's lines and packing list against its order. */
export function checkOf(order: readonly OrderLineView[], lines: readonly NoticeLineRow[], hides: readonly NoticeHideRow[], crViEvidence: boolean): PackingCheck {
  const noticeLines: NoticeLineFacts[] = lines.map((line) => ({ id: line.id, seq: line.seq, purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity.toString(), uom: line.uom, dyeBatch: line.dyeBatch }))
  const noticeHides: NoticeHideFacts[] = hides.map((hide) => ({
    lineId: hide.shipNoticeLineId,
    seq: hide.seq,
    hideNumber: hide.hideNumber,
    area: hide.area.toString(),
    areaUom: hide.areaUom,
    grade: hide.grade,
    thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toString(),
    dyeBatch: hide.dyeBatch,
  }))
  return checkShipNotice({ orderLines: order.map((line) => line.facts), lines: noticeLines, hides: noticeHides, crViEvidence })
}

/** A notice as both the portal and the office show it (no price, no office person; the office adds its dock note). */
export function noticeView(notice: NoticeRow, lines: readonly NoticeLineRow[], hides: readonly NoticeHideRow[], order: readonly OrderLineView[], check: PackingCheck, orderNumber: string, today: BusinessDate) {
  const orderLines = new Map(order.map((line) => [line.id, line]))
  const verdicts = new Map(check.lines.map((line) => [line.lineId, line]))
  const hideVerdicts = new Map(check.hides.map((row) => [`${row.lineId}:${row.seq}`, row]))
  const stateLines = lines.map((line) => ({ quantity: line.quantity.toString(), receivedQuantity: line.receivedQuantity === null ? null : line.receivedQuantity.toString() }))
  const state = noticeStateOf({ status: notice.status, shipDate: dayOf(notice.shipDate), lines: stateLines }, today)
  return {
    id: notice.id,
    number: notice.number,
    status: notice.status,
    state,
    words: NOTICE_STATE_WORDS[state],
    purchaseOrder: { id: notice.purchaseOrderId, number: orderNumber },
    siteId: notice.siteId,
    supplierRef: notice.supplierRef,
    ddtNumber: notice.ddtNumber,
    ddtDate: dayOf(notice.ddtDate),
    shipDate: dayOf(notice.shipDate),
    expectedDate: dayOf(notice.expectedDate),
    carrier: notice.carrier,
    trackingNumber: notice.trackingNumber,
    parcels: notice.parcels,
    note: notice.note,
    sentAt: iso(notice.sentAt),
    receivedAt: iso(notice.receivedAt),
    cancelledAt: iso(notice.cancelledAt),
    cancelReason: notice.cancelReason,
    version: notice.version,
    verdict: check.verdict,
    verdictWords: VERDICT_WORDS[check.verdict],
    counts: check.counts,
    differing: differingLines(lines.map((line) => ({ id: line.id, quantity: line.quantity.toString(), receivedQuantity: line.receivedQuantity === null ? null : line.receivedQuantity.toString() }))).map((line) => line.id),
    lines: lines.map((line) => {
      const orderLine = orderLines.get(line.purchaseOrderLineId)
      const verdict = verdicts.get(line.id)
      return {
        id: line.id,
        seq: line.seq,
        purchaseOrderLineId: line.purchaseOrderLineId,
        orderSeq: orderLine?.seq ?? null,
        item: orderLine ? { code: orderLine.item.code, name: orderLine.item.name, leather: orderLine.item.leather } : null,
        supplierArticleCode: orderLine?.supplierArticleCode ?? null,
        colour: orderLine?.colour?.name ?? null,
        quantity: qty(new Dec(line.quantity.toString())),
        uom: line.uom,
        supplierLot: line.supplierLot,
        dyeBatch: line.dyeBatch,
        note: line.note,
        receivedQuantity: line.receivedQuantity === null ? null : qty(new Dec(line.receivedQuantity.toString())),
        verdict: verdict?.verdict ?? 'OK',
        reasons: [...(verdict?.reasons ?? [])],
        figures: verdict ? { hides: verdict.hides, area: verdict.area, expected: verdict.expected, before: verdict.before, upTo: verdict.upTo, openAfter: verdict.openAfter } : null,
        hides: hides
          .filter((hide) => hide.shipNoticeLineId === line.id)
          .map((hide) => {
            const row = hideVerdicts.get(`${line.id}:${hide.seq}`)
            return {
              id: hide.id,
              seq: hide.seq,
              hideNumber: hide.hideNumber,
              area: qty(new Dec(hide.area.toString())),
              areaUom: hide.areaUom,
              grade: hide.grade,
              thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toString(),
              dyeBatch: hide.dyeBatch,
              note: hide.note,
              verdict: row?.verdict ?? 'OK',
              reasons: [...(row?.reasons ?? [])],
            }
          }),
      }
    }),
  }
}
export type NoticeView = ReturnType<typeof noticeView>

/** Today in the business calendar. */
export const todayOf = (now: Date): BusinessDate => businessDate(now)
