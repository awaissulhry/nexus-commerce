import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, type Money } from '@nexus/factory-domain/money/marked'
import { atRiskOf, openUnitsOf, orderMoneyOf, riskDaysFor, type AtRisk } from '@nexus/factory-domain/sales/orders/later-columns'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { PRIORITY_WORDS, type SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import { cutCountsOf } from '../../production/cutting/views'
import { scanProgressOf } from '../../production/scans/progress'
import { orderCustomerUrgency, type CustomerUrgency } from './customer-urgency'
import type { Reader } from './store'
import { riskRulesOf } from './view-facts'

/**
 * The later columns of a Sales › Orders row (B-TH-059; threads plan TH-4; features O-SAL-ORD-LIST.grid-F16 Progress,
 * -F17 Paid and balance, -F18 the order note and priority, O-SAL-ORD-LIST.tiles-F05 At risk; gaps N23, ORD-G08; wall W27),
 * read for one page of rows, one query per kind. Every row is an order the reader's orders.view already reaches (the list's
 * scopeWhere), and every figure is that order's own — no other customer's record is read into it.
 *
 *   openUnits        the pieces it still owes (factory-domain later-columns openUnitsOf: open orders, less closed short and
 *                    shipped), the overall view's "Open pcs" door sums exactly these
 *   progress         only when the list asks (`progress=true`: the column is shown, the file writes it — it reads the floor's
 *                    records of every work order of the page): the cells of its lines in work orders past DRAFT (not REPAIR,
 *                    not cancelled) — `inWork` their pieces, `cut` from the cutting log, `sewn` and `finished` from the
 *                    floor's scans, the same counts as the work order record (cutCountsOf, scanProgressOf), summed over every
 *                    work order and site; a step no cell counts stays null ("—"), never a made-up 0; null: no work order
 *                    past DRAFT yet. Totals only: never a person's or a station's output (Statuto dei Lavoratori art. 4).
 *   paid, balance    money.price (factory-domain orderMoneyOf): read only for a reader holding the price grain, dropped by
 *                    the grain filter for everyone else (absent, not empty)
 *   sites            the sites that make it: its lines' sites and those of its work orders (not cancelled), each once
 *   internalNote     the order note (office only: the partner role can neither read nor write it)
 *   priority         the office's own level, number and urgent reason (SalesOrder.priorityLevel, priority, urgentReason)
 *   atRisk           the ORDER_LATE_RISK rule's own reading for the order's company (factory-domain atRiskOf, riskDaysFor):
 *                    days left and the rule's threshold; null: not at risk, or no enabled rule
 *   customerUrgency  the customer's own mark, read-only (./customer-urgency: the production lane's reader; null until then)
 */

export interface LaterOrder {
  readonly id: string
  readonly companyId: string
  readonly status: SalesOrderStatus
  readonly promiseDate: BusinessDate | null
  readonly grossAmount: number
  readonly priority: number
  readonly priorityLevel: SalesOrderPriorityLevel
  readonly urgentReason: string | null
  readonly internalNote: string | null
}

export interface RowProgress {
  readonly inWork: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly finished: number | null
}

export interface LaterColumns {
  readonly openUnits: number
  readonly progress?: RowProgress | null
  readonly paid: Money<'price', number>
  readonly balance: Money<'price', number>
  readonly sites: { readonly id: string; readonly code: string; readonly name: string }[]
  readonly internalNote: string | null
  readonly priority: { readonly level: SalesOrderPriorityLevel; readonly words: { readonly en: string; readonly it: string }; readonly number: number; readonly urgentReason: string | null }
  readonly atRisk: AtRisk | null
  readonly customerUrgency: CustomerUrgency | null
}

export interface LaterOptions {
  readonly today: BusinessDate
  /** Count the progress (the Progress column is shown or written). */
  readonly progress: boolean
}

const GOODS_BILLS = ['TD01', 'TD24', 'TD05'] as const
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]
const sumOf = <T>(rows: readonly T[], value: (row: T) => number): number => rows.reduce((total, row) => total + value(row), 0)
/** A sum that stays null when nothing counts the step. */
function sumOrNull(values: Iterable<number | null>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null) total = (total ?? 0) + value
  return total
}

/** The later columns of each order of the page, by order id; `shipped`: the pieces that left, as the row counts them. */
export async function orderLaterColumns(client: Reader, actor: Actor, orders: readonly LaterOrder[], shipped: ReadonlyMap<string, number>, options: LaterOptions): Promise<Map<string, LaterColumns>> {
  const out = new Map<string, LaterColumns>()
  if (orders.length === 0) return out
  const orderIds = orders.map((order) => order.id)

  const lines = await client.salesOrderLine.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true, kind: true, quantity: true, closedShortQuantity: true, feeCreditedAt: true, netAmount: true, vatAmount: true, siteId: true },
  })
  const orderOfLine = new Map(lines.map((line) => [line.id, line.orderId]))
  const lineIds = lines.map((line) => line.id)

  // ---- work orders: sites and progress ------------------------------------------------------------------------------------
  const cells = lineIds.length > 0
    ? await client.workOrderSize.findMany({
        where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } },
        select: { id: true, salesOrderLineId: true, quantity: true, workOrder: { select: { id: true, siteId: true, styleId: true, status: true, heldFromStatus: true } } },
      })
    : []
  const counting = cells.filter((cell) => cell.workOrder.status !== 'DRAFT' && !(cell.workOrder.status === 'ON_HOLD' && cell.workOrder.heldFromStatus === 'DRAFT'))
  const siteIds = unique([...lines.flatMap((line) => (line.siteId ? [line.siteId] : [])), ...cells.map((cell) => cell.workOrder.siteId)])
  const siteOf = new Map(siteIds.length > 0 ? (await client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true } })).map((site) => [site.id, site]) : [])
  const progressOf = new Map<string, { cut: number | null; sewn: number | null; finished: number | null }>()
  if (options.progress) {
    const workOrders = new Map(counting.map((cell) => [cell.workOrder.id, cell.workOrder]))
    for (const workOrder of [...workOrders.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const cut = await cutCountsOf(client, workOrder.id, workOrder.styleId)
      const scanned = await scanProgressOf(client, { id: workOrder.id, siteId: workOrder.siteId })
      for (const cell of counting.filter((entry) => entry.workOrder.id === workOrder.id)) {
        const figures = scanned.get(cell.id)
        progressOf.set(cell.id, { cut: cut.get(cell.id) ?? null, sewn: figures?.sewn ?? null, finished: figures?.finished ?? null })
      }
    }
  }

  // ---- paid and balance (the price grain only) ----------------------------------------------------------------------------
  const money = heldGrains(actor).has('price') ? await moneyFacts(client, orderIds, lines, orderOfLine) : null

  // ---- at risk, customer urgency ------------------------------------------------------------------------------------------
  const rules = await riskRulesOf(client)
  const urgency = await orderCustomerUrgency(client, orderIds)

  for (const order of orders) {
    const own = lines.filter((line) => line.orderId === order.id)
    const ownCells = cells.filter((cell) => cell.salesOrderLineId !== null && orderOfLine.get(cell.salesOrderLineId) === order.id)
    const ownCounting = counting.filter((cell) => cell.salesOrderLineId !== null && orderOfLine.get(cell.salesOrderLineId) === order.id)
    const ordered = sumOf(own, (line) => line.quantity)
    const closedShort = sumOf(own, (line) => line.closedShortQuantity ?? 0)
    const sites = unique([...own.flatMap((line) => (line.siteId ? [line.siteId] : [])), ...ownCells.map((cell) => cell.workOrder.siteId)])
      .flatMap((id) => (siteOf.has(id) ? [siteOf.get(id)!] : []))
      .sort((a, b) => a.code.localeCompare(b.code))
    const progress: RowProgress | null =
      ownCounting.length === 0
        ? null
        : {
            inWork: sumOf(ownCounting, (cell) => cell.quantity),
            cut: sumOrNull(ownCounting.map((cell) => progressOf.get(cell.id)?.cut ?? null)),
            sewn: sumOrNull(ownCounting.map((cell) => progressOf.get(cell.id)?.sewn ?? null)),
            finished: sumOrNull(ownCounting.map((cell) => progressOf.get(cell.id)?.finished ?? null)),
          }
    const answer = money
      ? orderMoneyOf({
          grossAmount: order.grossAmount,
          lines: own.map((line) => ({ quantity: line.quantity, closedShortQuantity: line.closedShortQuantity, netAmount: line.netAmount, vatAmount: line.vatAmount, feeCredited: line.kind === 'FEE' && line.feeCreditedAt !== null })),
          depositPlaced: money.depositPlaced.get(order.id) ?? 0,
          depositRefunded: money.depositRefunded.get(order.id) ?? 0,
          invoices: money.invoicesOf(order.id),
        })
      : { paid: 0, balance: 0 }
    out.set(order.id, {
      openUnits: openUnitsOf(order.status, ordered, closedShort, shipped.get(order.id) ?? 0),
      ...(options.progress ? { progress } : {}),
      paid: asMoney('price', answer.paid),
      balance: asMoney('price', answer.balance),
      sites,
      internalNote: order.internalNote,
      priority: { level: order.priorityLevel, words: PRIORITY_WORDS[order.priorityLevel], number: order.priority, urgentReason: order.urgentReason },
      atRisk: atRiskOf(order.status, order.promiseDate, options.today, riskDaysFor(rules, order.companyId)),
      customerUrgency: urgency.get(order.id) ?? null,
    })
  }
  return out
}

/**
 * The money facts of the page's orders (factory-domain orderMoneyOf's inputs), read once for the page: what is placed on
 * their deposit requests; the issued TD01/TD24/TD05 that bill them (by the order, or by a line of it) with what is placed on
 * each, the net of every order line each bills (the share of each order) and its credit notes' gross; the PAID refunds of
 * those credit notes and of the deposit invoices' credit notes.
 */
async function moneyFacts(client: Reader, orderIds: readonly string[], lines: readonly { readonly id: string; readonly orderId: string }[], orderOfLine: ReadonlyMap<string, string>) {
  const lineIds = lines.map((line) => line.id)
  const requests = await client.depositRequest.findMany({ where: { orderId: { in: [...orderIds] } }, select: { id: true, orderId: true } })
  const orderOfRequest = new Map(requests.flatMap((request) => (request.orderId ? [[request.id, request.orderId] as const] : [])))
  const requestIds = [...orderOfRequest.keys()]
  const onRequests = requestIds.length > 0 ? await client.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requestIds } }, _sum: { amount: true } }) : []
  const invoices = await client.invoice.findMany({
    where: { docType: { in: [...GOODS_BILLS] }, status: { not: 'DRAFT' }, OR: [{ salesOrderId: { in: [...orderIds] } }, ...(lineIds.length > 0 ? [{ lines: { some: { salesOrderLineId: { in: lineIds } } } }] : [])] },
    select: { id: true, salesOrderId: true },
  })
  const invoiceIds = invoices.map((invoice) => invoice.id)
  const billing = invoiceIds.length > 0 ? await client.invoiceLine.findMany({ where: { invoiceId: { in: invoiceIds }, salesOrderLineId: { not: null } }, select: { invoiceId: true, salesOrderLineId: true, netAmount: true } }) : []
  const onInvoices = invoiceIds.length > 0 ? await client.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoiceIds } }, _sum: { amount: true } }) : []
  const depositInvoices = requestIds.length > 0 ? await client.invoice.findMany({ where: { docType: 'TD02', status: { not: 'DRAFT' }, depositRequestId: { in: requestIds } }, select: { id: true, depositRequestId: true } }) : []
  const credited = [...invoiceIds, ...depositInvoices.map((invoice) => invoice.id)]
  const credits = credited.length > 0 ? await client.invoice.findMany({ where: { docType: 'TD04', status: { not: 'DRAFT' }, creditOfId: { in: credited } }, select: { id: true, creditOfId: true, grossTotal: true } }) : []
  const refunds = credits.length > 0 ? await client.refund.groupBy({ by: ['creditNoteId'], where: { status: 'PAID', creditNoteId: { in: credits.map((credit) => credit.id) } }, _sum: { amount: true } }) : []
  const refundOf = new Map(refunds.flatMap((row) => (row.creditNoteId ? [[row.creditNoteId, row._sum.amount ?? 0] as const] : [])))
  const placedOn = new Map(onInvoices.flatMap((row) => (row.invoiceId ? [[row.invoiceId, row._sum.amount ?? 0] as const] : [])))
  const creditsOf = (invoiceId: string) => credits.filter((credit) => credit.creditOfId === invoiceId)

  const depositPlaced = new Map<string, number>()
  for (const row of onRequests) {
    const orderId = row.depositRequestId ? orderOfRequest.get(row.depositRequestId) : undefined
    if (orderId) depositPlaced.set(orderId, (depositPlaced.get(orderId) ?? 0) + (row._sum.amount ?? 0))
  }
  const depositRefunded = new Map<string, number>()
  for (const invoice of depositInvoices) {
    const orderId = invoice.depositRequestId ? orderOfRequest.get(invoice.depositRequestId) : undefined
    if (!orderId) continue
    depositRefunded.set(orderId, (depositRefunded.get(orderId) ?? 0) + sumOf(creditsOf(invoice.id), (credit) => refundOf.get(credit.id) ?? 0))
  }
  const perInvoice = invoices.map((invoice) => {
    const own = billing.filter((line) => line.invoiceId === invoice.id)
    const whole = sumOf(own, (line) => line.netAmount)
    const partOf = new Map<string, number>()
    for (const line of own) {
      const orderId = line.salesOrderLineId ? orderOfLine.get(line.salesOrderLineId) : undefined
      if (orderId) partOf.set(orderId, (partOf.get(orderId) ?? 0) + line.netAmount)
    }
    const theirs = creditsOf(invoice.id)
    return { id: invoice.id, salesOrderId: invoice.salesOrderId, whole, partOf, placed: placedOn.get(invoice.id) ?? 0, creditedGross: sumOf(theirs, (credit) => credit.grossTotal), refunded: sumOf(theirs, (credit) => refundOf.get(credit.id) ?? 0) }
  })
  return {
    depositPlaced,
    depositRefunded,
    /** The invoices that bill an order, with its share: its lines' net over every order line's (none names a line: its own order's whole). */
    invoicesOf(orderId: string) {
      return perInvoice.flatMap((invoice) => {
        const share = invoice.whole !== 0 ? { part: invoice.partOf.get(orderId) ?? 0, whole: invoice.whole } : { part: invoice.salesOrderId === orderId ? 1 : 0, whole: 1 }
        return share.part === 0 ? [] : [{ placed: invoice.placed, creditedGross: invoice.creditedGross, refunded: invoice.refunded, ...share }]
      })
    },
  }
}
