import type { Prisma } from '@nexus/factory-db'
import { toMinorUnits } from '@nexus/factory-domain/core/money'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { chooseInvoiceType } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { notInvoiced, type NotInvoicedRow } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { INVOICES_MANAGE } from '@nexus/factory-domain/invoicing/permissions'
import { monthOf } from '@nexus/factory-domain/invoicing/fatturapa/format'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { lineAmount } from '@nexus/factory-domain/tax/vat-summary'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../store'
import type { CANDIDATE_HELD_REASONS } from './contract'
import { invoicedOf, orderPrices, presetsOf, readDdts, shippedOf, type DdtRow } from './store'
// B-OP-045 (order page N6, lines-derived): an order's shipments through their lines.
import { orderIdsOfShipments, shipmentsOfOrdersWhere } from '../../shipping/shipments/orders-of'

/**
 * B-TH-062 (threads plan TH-4, N21; features SHEET.overall-F07 "Invoice shipped goods (finance)", O-SAL-ORD-REC.body-F08):
 * Finance picks orders on the orders list and asks what invoicing their shipped goods makes. A read only — it never makes
 * or issues an invoice: Finance's From-DDTs dialog opens with each answer's `body` and makes the draft through
 * POST /invoicing/invoices/from-ddts (draft.ts), which checks everything again under the DDTs' locks.
 *
 *   - The orders the reader may invoice (invoices.manage over their company and customer, scopeWhere): an order outside the
 *     reader's companies or customers is left out, never named (W27).
 *   - Their live DDTs (not cancelled) of shipments that left (SHIPPED or DELIVERED), and per DDT, order line and size what a
 *     new draft takes: shipped less what issued invoices and other drafts hold (shipped/notInvoiced `toInvoice`).
 *   - One draft per customer and company, as the From-DDTs route makes it; split by the DDTs' calendar month (one deferred
 *     invoice, TD24, covers one month: DPR 633/1972 art. 21 c.4 lett. a) and by currency (an invoice has one). Each with
 *     its orders and DDTs, the garments and their value at the orders' prices (price grain), and the type the rule
 *     suggests (deadlines/chooseInvoiceType, the customer's preset as in the shipped-not-invoiced list) with its words.
 *   - An order with nothing to invoice from a DDT is held with why: nothing left with a DDT yet, left without a DDT (its
 *     shipment is invoiced on its own, POST /invoicing/invoices/from-shipment), what is left sits in a draft already (the
 *     drafts named), or everything shipped is invoiced.
 *
 * B-OP-045 (order page N6, lines-derived): a DDT may carry the goods of several orders of one customer (its shipment's lines'
 * orders); only the chosen orders' lines are read, so a chosen order's DDT never brings an unchosen order's goods into the
 * draft, and each draft lists one row per (DDT, order). While N6 is held off a DDT carries one order.
 */

type HeldReason = (typeof CANDIDATE_HELD_REASONS)[number]

const LEFT = ['SHIPPED', 'DELIVERED'] as const

const HELD_WORDS: Readonly<Record<HeldReason, (number: string) => string>> = {
  NOTHING_SHIPPED: (number) => `Nothing of ${number} has left with a DDT yet: there is nothing to invoice.`,
  SHIPPED_WITHOUT_DDT: (number) => `${number} left without a DDT: invoice its shipment on its own (immediate invoice).`,
  IN_DRAFT: (number) => `What is left of ${number} to invoice is in a draft invoice already: open the draft.`,
  INVOICED: (number) => `Everything ${number} shipped is invoiced.`,
}

interface Ready {
  readonly row: NotInvoicedRow
  readonly ddt: DdtRow
}

export async function fromDdtsCandidates(caller: CommandCaller, orderIds: readonly string[]) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), INVOICES_MANAGE, { company: 'companyId', party: 'partyId' })
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const orders = await client.salesOrder.findMany({
      where: { AND: [scope as Prisma.SalesOrderWhereInput, { id: { in: [...orderIds] } }] },
      select: { id: true, number: true, partyId: true, companyId: true },
    })
    const visible = orders.map((order) => order.id)
    const ddts =
      visible.length === 0
        ? []
        : await readDdts(client, { AND: [scope as Prisma.DdtWhereInput, { cancellations: { none: {} }, shipment: { status: { in: [...LEFT] }, ...shipmentsOfOrdersWhere(visible) } }] }, 500)
    // B-OP-045: the chosen orders' lines only.
    const rows = notInvoiced(await shippedOf(client, ddts, visible), await invoicedOf(client, ddts.map((ddt) => ddt.id)))
    const ddtOf = new Map(ddts.map((ddt) => [ddt.id, ddt]))
    const ready: Ready[] = rows.filter((row) => row.toInvoice.gt(0)).map((row) => ({ row, ddt: ddtOf.get(row.ddtId)! }))
    const prices = await orderPrices(client, ready.map((entry) => entry.row.salesOrderLineId))
    // B-OP-045: each row's order is its line's (a shared DDT carries several).
    const linePrices = await orderPrices(client, rows.map((row) => row.salesOrderLineId))
    const orderOfRow = (row: NotInvoicedRow): string | null => linePrices.get(row.salesOrderLineId)?.orderId ?? null
    const partyIds = [...new Set(ready.map((entry) => entry.ddt.partyId))]
    const parties = new Map((await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
    const presets = await presetsOf(client, partyIds)
    const numberOf = new Map(orders.map((order) => [order.id, order.number]))

    // One draft per customer, company, month and currency.
    const groups = new Map<string, Ready[]>()
    for (const entry of ready) {
      const currency = prices.get(entry.row.salesOrderLineId)?.currency ?? entry.ddt.orderCurrency
      const key = [entry.ddt.partyId, entry.ddt.companyId, monthOf(entry.ddt.date), currency].join('|')
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    const drafts = [...groups.entries()].map(([key, entries]) => {
      const [partyId, companyId, month, currency] = key.split('|') as [string, string, string, string]
      const party = parties.get(partyId)
      const groupDdts = [...new Map(entries.map((entry) => [entry.ddt.id, entry.ddt])).values()].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
      const garmentsOf = (list: readonly Ready[]) => list.reduce((sum, entry) => sum.plus(entry.row.toInvoice), new Dec(0))
      const value = entries.reduce((sum, entry) => {
        const price = prices.get(entry.row.salesOrderLineId)
        const unit = price ? (price.sizePrices[entry.row.size] ?? price.unitPrice) : null
        return unit === null ? sum : sum + toMinorUnits(lineAmount(new Dec(unit), entry.row.toInvoice), currency)
      }, 0)
      const choice = chooseInvoiceType(groupDdts.map((ddt) => ({ number: ddt.number, date: ddt.date })), today, undefined, 'body/docType', presets.get(partyId)?.preset ?? 'TD01')
      // B-OP-045: the orders of the group's own lines, and one row per (DDT, order).
      const orderIdsOf = [...new Set(entries.flatMap((entry) => (orderOfRow(entry.row) ? [orderOfRow(entry.row)!] : [])))]
      const pairs = groupDdts.flatMap((ddt) => [...new Set(entries.filter((entry) => entry.ddt.id === ddt.id).flatMap((entry) => (orderOfRow(entry.row) ? [orderOfRow(entry.row)!] : [])))].map((orderId) => ({ ddt, orderId })))
      return {
        partyId,
        companyId,
        code: party?.code ?? '',
        legalName: party?.legalName ?? '',
        month,
        currency,
        orders: orderIdsOf.map((id) => ({ id, number: numberOf.get(id) ?? '' })).sort((a, b) => a.number.localeCompare(b.number)),
        ddts: pairs.map(({ ddt, orderId }) => ({
          ddtId: ddt.id,
          number: ddt.number,
          date: ddt.date,
          shipmentNumber: ddt.shipmentNumber,
          orderNumber: numberOf.get(orderId) ?? '',
          garments: garmentsOf(entries.filter((entry) => entry.ddt.id === ddt.id && orderOfRow(entry.row) === orderId)).toString(),
        })),
        garments: garmentsOf(entries).toString(),
        valueAmount: asMoney('price', value),
        choice: { suggested: choice.suggested, allowed: [...choice.allowed], deadline: choice.deadline ?? choice.deferred, words: choice.words },
        body: { ddtIds: groupDdts.map((ddt) => ddt.id) },
      }
    })
    drafts.sort((a, b) => a.legalName.localeCompare(b.legalName) || a.month.localeCompare(b.month) || a.companyId.localeCompare(b.companyId))

    // The chosen orders with nothing a new draft takes, and why.
    const readyOrders = new Set(ready.flatMap((entry) => (orderOfRow(entry.row) ? [orderOfRow(entry.row)!] : [])))
    const waiting = orders.filter((order) => !readyOrders.has(order.id))
    // B-OP-045: a waiting order's shipments that left without a DDT — made for it or carrying its garments.
    const leftWithout = waiting.length === 0 ? [] : await client.shipment.findMany({ where: { ...shipmentsOfOrdersWhere(waiting.map((order) => order.id)), status: { in: [...LEFT] }, ddts: { none: {} } }, select: { id: true, salesOrderId: true } })
    const carriedWithout = await orderIdsOfShipments(client, leftWithout)
    const withoutDdt = new Set(leftWithout.flatMap((shipment) => carriedWithout.get(shipment.id) ?? [shipment.salesOrderId]))
    const held = waiting
      .map((order) => {
        const mine = rows.filter((row) => orderOfRow(row) === order.id)
        const inDraft = mine.filter((row) => row.notInvoiced.gt(0) && row.inDraft.gt(0))
        const reason: HeldReason = mine.length === 0 ? (withoutDdt.has(order.id) ? 'SHIPPED_WITHOUT_DDT' : 'NOTHING_SHIPPED') : inDraft.length > 0 ? 'IN_DRAFT' : 'INVOICED'
        const drafts = [...new Set(inDraft.flatMap((row) => row.invoices.filter((invoice) => invoice.draft).map((invoice) => invoice.invoiceId)))]
        return { orderId: order.id, number: order.number, reason, words: HELD_WORDS[reason](order.number), drafts }
      })
      .sort((a, b) => a.number.localeCompare(b.number))
    return { asOf: today, drafts, held }
  })
}
