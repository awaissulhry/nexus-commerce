import type { FactoryClient } from '@nexus/factory-db'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { supplyRulesFor } from '@nexus/factory-domain/planning/buy'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { purchaseQuantityOf, sendChecks, type PurchaseOrderStatus, type SendCheck } from '@nexus/factory-domain/purchasing/orders'
import type { RequestContext } from '../../core/context'
import { companyLegalOf } from '../../platform/documents/documents'
import { confirmLinksOf } from './confirm-links'
import {
  CONTACT_COLUMNS,
  dayOf,
  decimal,
  ITEM_COLUMNS,
  PARTY_COLUMNS,
  quantityText,
  readLines,
  SITE_COLUMNS,
  unitsOf,
  type ContactRow,
  type ItemRow,
  type LineRow,
  type OrderRow,
  type PartyRow,
  type Reader,
  type SiteRow,
} from './store'

/**
 * The purchase order as the office reads it (A2 SCR-059: band, Lines, Totals, the send dialog's checklist, the confirm
 * links): the header with its supplier, contact and site; each line with its material and colour, quantities in its unit
 * and the base unit, the leather specs, the Cr VI flag, the supplier's confirmation and the plan lines it buys; what a
 * send would check now; the confirm links (their state, never a token). Purchase prices and amounts are costs, marked
 * money.cost: the API drops them for a caller without the cost grain (planner, warehouse).
 */

export interface OrderFacts {
  readonly order: OrderRow
  readonly lines: LineRow[]
  readonly items: Map<string, ItemRow>
  readonly colours: Map<string, { readonly id: string; readonly code: string; readonly name: string; readonly supplierColourCode: string | null }>
  readonly party: PartyRow
  readonly contact: ContactRow | null
  readonly site: SiteRow
  readonly plan: Map<string, { readonly requirementId: string; readonly runId: string; readonly runStatus: string; readonly decision: string }[]>
}

/** The site's delivery address as printed, when it has one. */
export function siteAddressOf(site: Pick<SiteRow, 'address' | 'name'>): { name: string; line1: string; line2: string | null; postalCode: string; city: string; province: string | null; country: string } | null {
  const value = site.address as Record<string, unknown> | null
  const text = (key: string): string | null => (typeof value?.[key] === 'string' && (value[key] as string).trim() !== '' ? (value[key] as string).trim() : null)
  const line1 = text('line1')
  const postalCode = text('postalCode')
  const city = text('city')
  const country = text('country')
  if (!line1 || !postalCode || !city || !country) return null
  return { name: site.name, line1, line2: text('line2'), postalCode, city, province: text('province'), country }
}

/** Everything the record and the send read, in one scope. */
export async function readFacts(db: Reader, order: OrderRow): Promise<OrderFacts> {
  const lines = await readLines(db, order.id)
  const itemIds = [...new Set(lines.map((line) => line.itemId))]
  const colourIds = [...new Set(lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: ITEM_COLUMNS })
  const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true, supplierColourCode: true } })
  const party = await db.party.findUniqueOrThrow({ where: { id: order.partyId }, select: PARTY_COLUMNS })
  const contact = order.contactId ? await db.partyContact.findUnique({ where: { id: order.contactId }, select: CONTACT_COLUMNS }) : null
  const site = await db.site.findUniqueOrThrow({ where: { id: order.siteId }, select: SITE_COLUMNS })
  const requirements =
    lines.length === 0
      ? []
      : await db.materialRequirement.findMany({
          where: { purchaseOrderLineId: { in: lines.map((line) => line.id) } },
          select: { id: true, runId: true, purchaseOrderLineId: true, decision: true, run: { select: { status: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
  const plan = new Map<string, { requirementId: string; runId: string; runStatus: string; decision: string }[]>()
  for (const row of requirements) {
    const entry = { requirementId: row.id, runId: row.runId, runStatus: row.run.status, decision: row.decision }
    plan.set(row.purchaseOrderLineId!, [...(plan.get(row.purchaseOrderLineId!) ?? []), entry])
  }
  return { order, lines, items: new Map(items.map((item) => [item.id, item])), colours: new Map(colours.map((colour) => [colour.id, colour])), party, contact, site, plan }
}

/** The company's letterhead problems, read in this scope (a command's transaction or a client). */
export async function letterheadProblems(db: Reader, context: RequestContext, companyId: string): Promise<Issue[]> {
  const caller = { factoryContext: context, withClient: <T>(work: (client: FactoryClient) => Promise<T>) => work(db as FactoryClient) }
  return legalProblems(await companyLegalOf(caller, companyId))
}

/** What a send would check now (factory-domain purchasing/orders sendChecks). */
export function checksOf(facts: OrderFacts, today: string, companyLegal: readonly Issue[]): { ready: boolean; checks: SendCheck[] } {
  const { order, party, contact } = facts
  return sendChecks({
    status: order.status as PurchaseOrderStatus,
    today,
    supplier: { name: party.legalName, status: party.status, roles: party.roles },
    contact: contact && contact.partyId === order.partyId ? { name: contact.name, email: contact.email, roles: contact.roles, active: contact.status === 'ACTIVE' } : null,
    companyLegal,
    deliveryAddress: siteAddressOf(facts.site) !== null,
    requestedDate: dayOf(order.requestedDate),
    lines: facts.lines.map((line) => {
      const item = facts.items.get(line.itemId)!
      const units = unitsOf(item)
      const rules = supplyRulesFor(
        { defaultSupplierId: item.defaultSupplierId, leadTimeDays: item.leadTimeDays, minOrderQty: decimal(item.minOrderQty), orderMultiple: decimal(item.orderMultiple) },
        { id: party.id, leadTimeDays: party.leadTimeDays },
      )
      return {
        seq: line.seq,
        itemCode: item.code,
        unitPrice: line.unitPrice.toString(),
        needDate: dayOf(line.needDate)!,
        purchaseQuantity: purchaseQuantityOf(line.quantity.toString(), line.uom, units),
        purchaseUom: item.purchaseUom,
        minOrderQuantity: rules.minOrderQuantity,
        orderMultiple: rules.orderMultiple,
        leadTimeDays: rules.leadTimeDays,
      }
    }),
  })
}

function lineView(facts: OrderFacts, line: LineRow, received: ReadonlyMap<string, string>) {
  const item = facts.items.get(line.itemId)!
  const colour = line.itemColourId ? (facts.colours.get(line.itemColourId) ?? null) : null
  return {
    id: line.id,
    seq: line.seq,
    itemId: line.itemId,
    item: { code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom, purchaseUom: item.purchaseUom },
    itemColourId: line.itemColourId,
    colour: colour ? { code: colour.code, name: colour.name } : null,
    description: line.description,
    supplierArticleCode: line.supplierArticleCode,
    supplierColourCode: line.supplierColourCode,
    quantity: quantityText(line.quantity),
    uom: line.uom,
    baseQuantity: quantityText(line.baseQuantity),
    baseUom: item.baseUom,
    unitPrice: asMoney('cost', line.unitPrice.toFixed(6)),
    netAmount: asMoney('cost', line.netAmount),
    needDate: dayOf(line.needDate)!,
    grade: line.grade,
    thicknessMinMm: decimal(line.thicknessMinMm),
    thicknessMaxMm: decimal(line.thicknessMaxMm),
    oneDyeBatch: line.oneDyeBatch,
    areaTolerancePct: decimal(line.areaTolerancePct),
    estimatedHides: line.estimatedHides,
    requiresCrViTest: line.requiresCrViTest,
    note: line.note,
    confirmedQuantity: line.confirmedQuantity === null ? null : quantityText(line.confirmedQuantity),
    confirmedDate: dayOf(line.confirmedDate),
    /** What every posted goods receipt brought against this line, in the material's base unit (reversed ones count no more). */
    receivedBaseQuantity: received.get(line.id) ?? '0.0000',
    plan: facts.plan.get(line.id) ?? [],
    version: line.version,
  }
}

export type LineView = ReturnType<typeof lineView>

/** The record (the answer of every read and write route). */
export async function orderDetail(db: Reader, context: RequestContext, order: OrderRow, now: Date) {
  const facts = await readFacts(db, order)
  const { party, contact, site } = facts
  const needDates = facts.lines.map((line) => dayOf(line.needDate)!).sort()
  const send = order.status === 'DRAFT' ? checksOf(facts, businessDate(now), await letterheadProblems(db, context, order.companyId)) : null
  const receivedRows =
    facts.lines.length === 0
      ? []
      : await db.goodsReceiptLine.groupBy({ by: ['purchaseOrderLineId'], where: { purchaseOrderLineId: { in: facts.lines.map((line) => line.id) }, receipt: { status: 'POSTED' } }, _sum: { baseQuantity: true } })
  const received = new Map(receivedRows.flatMap((row) => (row.purchaseOrderLineId && row._sum.baseQuantity ? [[row.purchaseOrderLineId, quantityText(row._sum.baseQuantity)] as const] : [])))
  return {
    id: order.id,
    number: order.number,
    documentNumber: purchaseOrderDocumentNumber(order.number, order.revision),
    companyId: order.companyId,
    siteId: order.siteId,
    site: { code: site.code, name: site.name },
    partyId: order.partyId,
    supplier: { code: party.code, name: party.legalName, status: party.status },
    contactId: order.contactId,
    contact: contact ? { name: contact.name, email: contact.email, roles: contact.roles } : null,
    status: order.status,
    revision: order.revision,
    currency: order.currency,
    orderDate: dayOf(order.orderDate)!,
    requestedDate: dayOf(order.requestedDate),
    incoterms: order.incoterms,
    paymentTerms: order.paymentTerms,
    note: order.note,
    internalNote: order.internalNote,
    netAmount: asMoney('cost', order.netAmount),
    lineCount: facts.lines.length,
    earliestNeedDate: needDates[0] ?? null,
    sentAt: order.sentAt === null ? null : toUtcIso(order.sentAt),
    sentById: order.sentById,
    confirmedAt: order.confirmedAt === null ? null : toUtcIso(order.confirmedAt),
    confirmedVia: order.confirmedVia,
    confirmedByName: order.confirmedByName,
    supplierRef: order.supplierRef,
    confirmNote: order.confirmNote,
    declinedAt: order.declinedAt === null ? null : toUtcIso(order.declinedAt),
    declineReason: order.declineReason,
    closedAt: order.closedAt === null ? null : toUtcIso(order.closedAt),
    cancelledAt: order.cancelledAt === null ? null : toUtcIso(order.cancelledAt),
    cancelReason: order.cancelReason,
    version: order.version,
    createdAt: toUtcIso(order.createdAt),
    updatedAt: toUtcIso(order.updatedAt),
    createdById: order.createdById,
    lines: facts.lines.map((line) => lineView(facts, line, received)),
    send,
    confirmLinks: await confirmLinksOf(db, order.id, now),
  }
}

export type OrderDetail = Awaited<ReturnType<typeof orderDetail>>
