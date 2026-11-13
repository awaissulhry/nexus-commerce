import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { orderDocumentOf } from '../line-checks/documents'
import { runLineChecks, type LineCheckLine } from '../line-checks/index'
import { LINE_WRITE_CHECKS } from '../line-checks/refuse'
import type { Reader } from '../orders/store'

/**
 * Order lines refuse a colourway or size outside the released scope (B-W2b-303; follow-up SO1:02 "Order lines refuse a
 * colourway or size outside the released scope (the quotes' line check)"), and another customer's private-label style: the
 * two BLOCKS rules of modules/sales/line-checks that keep a line out (./refuse.ts LINE_WRITE_CHECKS), run where order lines
 * are written from somewhere else than the office's typed order (which runs every rule since B-W2b-325/-294):
 *
 *   refuseOrderLineRules(db, orderId, now)    the office's order of an accepted quote (orders/make.ts, POST /sales/orders):
 *                                             409 in the rule's words. The acceptance itself makes the order the customer
 *                                             accepted (its send checks held the same rules then).
 *   amendedLineProblems(db, order, lines)     an amendment's new and changed lines (orders/amend.ts planAmendment): the
 *                                             problems in words (path body/lines).
 */

export async function refuseOrderLineRules(db: Reader, orderId: string, now: Date): Promise<void> {
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true, currency: true, quoteVersionId: true } })
  if (!order) return
  const lines = await db.salesOrderLine.findMany({ where: { orderId }, select: { id: true, seq: true, kind: true, styleId: true, colourwayId: true, styleRevisionId: true, quantity: true }, orderBy: { seq: 'asc' } })
  const findings = await runLineChecks(db, await orderDocumentOf(db, order, lines, now), LINE_WRITE_CHECKS)
  const blocks = findings.filter((finding) => finding.severity === 'BLOCKS')
  if (blocks.length === 0) return
  throw new DomainError('conflict', blocks[0]!.message, blocks.map((finding) => ({ path: `line-rule/${finding.code}`, message: finding.message })))
}

export interface AmendedLine {
  readonly id: string | null
  readonly seq: number
  readonly kind: string
  readonly styleId: string
  readonly colourwayId: string
  readonly styleRevisionId: string | null
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

export async function amendedLineProblems(db: Reader, order: { readonly companyId: string; readonly partyId: string; readonly currency: string; readonly shipTo: unknown }, lines: readonly AmendedLine[]): Promise<Issue[]> {
  const goods: LineCheckLine[] = lines
    .filter((line) => line.kind === 'SIZE_GRID')
    .map((line) => ({ id: line.id, seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: line.styleRevisionId, quantity: line.sizes.reduce((sum, size) => sum + size.quantity, 0), optionItemIds: [], sizes: line.sizes.filter((size) => size.quantity > 0).map((size) => size.size) }))
  if (goods.length === 0) return []
  const country = order.shipTo && typeof order.shipTo === 'object' && !Array.isArray(order.shipTo) ? (order.shipTo as { country?: unknown }).country : null
  const findings = await runLineChecks(db, { kind: 'ORDER', companyId: order.companyId, priceListId: null, currency: order.currency, partyId: order.partyId, shipToCountry: typeof country === 'string' ? country.toUpperCase() : null, lines: goods }, LINE_WRITE_CHECKS)
  return findings.filter((finding) => finding.severity === 'BLOCKS').map((finding) => ({ path: 'body/lines', message: finding.message }))
}
