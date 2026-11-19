import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { priceCheckOf, type PriceCheck } from '@nexus/factory-domain/sales/brand-prices/match'
import type { CommandTools } from '../../../core/command'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import type { Reader } from '../orders/store'

/**
 * The customer's own prices of an order (customer page plan C3, B-CP-017; factory-db sales-brand-prices.prisma OrderBrandPrice):
 * the reads and the writes every command of the money API shares, so each one writes, audits and announces a row the same way.
 *
 *   history   every write is audited under recordType `OrderBrandPrice` with the ORDER as its record id (one history per order:
 *             "History ›" on the order's price check reads GET /audit/OrderBrandPrice/<orderId>), NEVER under the order's own
 *             record type: the order's thread timeline and dock read the order's rows (platform/threads timeline.ts), so a
 *             customer's price, a removal or a dispute never shows there (review B3). Every price, the line total and the note are
 *             marked money (markMoney 'price'): a reader without the price grain is never sent them, and since B-CP-025 does not
 *             read these rows at all (platform/audit read.ts).
 *   event     `sales_order.brand_price_changed` once per order and command (factory-domain brand-prices/events.ts): ids only.
 *   the wall  the database's guard (…_customer_page_guards factory_order_brand_price_guard) is the last word: a PORTAL row has no
 *             enteredById; the office writes PORTAL only as a carry (an insert from the customer's own request, a split's copy,
 *             a move with its line); an office change of a PORTAL row makes it the factory's (CUSTOMER_PO or OFFICE with who typed
 *             it); nothing is written while the order is CLOSED or CANCELLED.
 *
 * Other batches call these (B-CP-076 the accept's carry, B-CP-019 the portal): keep their shape.
 */

/** The audit record type of the customer's prices (B-CP-025 hides it from people without the price grain). */
export const BRAND_PRICE_RECORD = 'OrderBrandPrice' as const

export const BRAND_PRICE_COLUMNS = {
  id: true,
  salesOrderId: true,
  salesOrderLineId: true,
  unitPrice: true,
  netAmount: true,
  currency: true,
  source: true,
  sourceFileId: true,
  note: true,
  enteredById: true,
  enteredAt: true,
  version: true,
} as const satisfies Prisma.OrderBrandPriceSelect
export type BrandPriceRecord = Prisma.OrderBrandPriceGetPayload<{ select: typeof BRAND_PRICE_COLUMNS }>
export type BrandPriceSource = BrandPriceRecord['source']

/** The order a row is of, as the commands read it (its company and customer: the audit's company, the event's party). */
export interface PricedOrder {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
}

/** The rows of some orders (a line row per line, at most one total row per order). */
export async function brandPriceRowsOf(db: Reader, orderIds: readonly string[]): Promise<BrandPriceRecord[]> {
  if (orderIds.length === 0) return []
  return db.orderBrandPrice.findMany({ where: { salesOrderId: { in: [...orderIds] } }, select: BRAND_PRICE_COLUMNS, orderBy: [{ salesOrderId: 'asc' }, { id: 'asc' }] })
}

/**
 * The check of one order from its lines and rows (factory-domain priceCheckOf): a line's pieces and our line net, the order's net
 * and currency. One reading for the order's check, the list's columns and the customer's summary.
 */
export function checkOfOrder(order: { readonly currency: string; readonly netAmount: number }, lines: readonly { readonly id: string; readonly quantity: number; readonly netAmount: number }[], rows: readonly Pick<BrandPriceRecord, 'salesOrderLineId' | 'unitPrice' | 'netAmount' | 'currency'>[]): PriceCheck {
  return priceCheckOf({
    currency: order.currency,
    ourNet: order.netAmount,
    lines: lines.map((line) => ({ lineId: line.id, pieces: line.quantity, ourNet: line.netAmount })),
    brand: rows.map((row) => ({ lineId: row.salesOrderLineId, unitPrice: row.unitPrice === null ? null : row.unitPrice.toString(), netAmount: row.netAmount, currency: row.currency })),
  })
}

/** A row as a command has it (its unit price stored, or as typed). */
export interface BrandPriceFacts {
  readonly id: string
  readonly salesOrderLineId: string | null
  readonly unitPrice: { toString(): string } | null
  readonly netAmount: number | null
  readonly currency: string
  readonly source: BrandPriceSource
  readonly sourceFileId: string | null
  readonly note: string | null
  readonly enteredById: string | null
  readonly enteredAt: Date
  readonly version: number
}

/** A row as its audit keeps it: every price, the line total and the note marked money (the price grain). */
export function brandPriceAuditView(row: BrandPriceFacts) {
  return {
    rowId: row.id,
    lineId: row.salesOrderLineId,
    unitPrice: markMoney('price', row.unitPrice === null ? null : priceText(row.unitPrice.toString())),
    netAmount: markMoney('price', row.netAmount),
    currency: row.currency,
    source: row.source,
    sourceFileId: row.sourceFileId,
    note: markMoney('price', row.note),
    enteredById: row.enteredById,
    enteredAt: toUtcIso(row.enteredAt),
    version: row.version,
  }
}

/** One audit row of an order's customer's prices (see the module head: the order is its record id, never its record type). */
export function auditBrandPrice(tools: Pick<CommandTools, 'audit'>, order: PricedOrder, entry: { readonly action: string; readonly before?: unknown; readonly after?: unknown; readonly reason?: string }): void {
  tools.audit({ action: entry.action, recordType: BRAND_PRICE_RECORD, recordId: order.id, companyId: order.companyId, before: entry.before, after: entry.after, ...(entry.reason ? { reason: entry.reason } : {}) })
}

/** The one event of a command that changed an order's customer's prices (ids only: the money wall). */
export function announceBrandPrices(tools: Pick<CommandTools, 'emit'>, order: PricedOrder): void {
  tools.emit({ type: 'sales_order.brand_price_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId } })
}

// ── B-CP-017 (lead addition 1: the priced-file lock is cp-1b's; this command marks the PO it was typed from) ──
/**
 * The customer's POs a price was typed from (files of this order the command checked) marked priced — StoredFile.priced, the lock
 * of platform/files (a person without the price grain no longer opens them) — each once, audited on the file. Never unmarked here.
 */
export async function markSourceFilesPriced(tools: CommandTools, order: PricedOrder, fileIds: readonly string[]): Promise<void> {
  if (fileIds.length === 0) return
  const unmarked = await tools.tx.storedFile.findMany({ where: { id: { in: [...fileIds] }, priced: false }, select: { id: true }, orderBy: { id: 'asc' } })
  for (const file of unmarked) {
    await tools.tx.storedFile.updateMany({ where: { id: file.id, priced: false }, data: { priced: true, version: { increment: 1 }, updatedAt: tools.now } }) // B-CP-017: the one marked write of StoredFile.priced
    tools.audit({ action: 'files.markPriced', recordType: 'StoredFile', recordId: file.id, companyId: order.companyId, before: { lock: null }, after: { lock: 'PRICED', why: 'brandPrices.save', salesOrderId: order.id } })
  }
}
// ── end B-CP-017 ──
