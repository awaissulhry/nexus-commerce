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
 * A DDT carries the goods of one order only (the database's rule: a shipment line ships a line of the shipment's order), so a
 * chosen order's DDT never brings an unchosen order's goods into the draft.
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
        : await readDdts(client, { AND: [scope as Prisma.DdtWhereInput, { cancellations: { none: {} }, shipment: { status: { in: [...LEFT] }, salesOrderId: { in: visible } } }] }, 500)
    const rows = notInvoiced(await shippedOf(client, ddts), await invoicedOf(client, ddts.map((ddt) => ddt.id)))
    const ddtOf = new Map(ddts.map((ddt) => [ddt.id, ddt]))
    const ready: Ready[] = rows.filter((row) => row.toInvoice.gt(0)).map((row) => ({ row, ddt: ddtOf.get(row.ddtId)! }))
    const prices = await orderPrices(client, ready.map((entry) => entry.row.salesOrderLineId))
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
      const orderIdsOf = [...new Set(groupDdts.map((ddt) => ddt.salesOrderId))]
      return {
        partyId,
        companyId,
        code: party?.code ?? '',
        legalName: party?.legalName ?? '',
        month,
        currency,
        orders: orderIdsOf.map((id) => ({ id, number: numberOf.get(id) ?? '' })).sort((a, b) => a.number.localeCompare(b.number)),
        ddts: groupDdts.map((ddt) => ({
          ddtId: ddt.id,
          number: ddt.number,
          date: ddt.date,
          shipmentNumber: ddt.shipmentNumber,
          orderNumber: numberOf.get(ddt.salesOrderId) ?? '',
          garments: garmentsOf(entries.filter((entry) => entry.ddt.id === ddt.id)).toString(),
        })),
        garments: garmentsOf(entries).toString(),
        valueAmount: asMoney('price', value),
        choice: { suggested: choice.suggested, allowed: [...choice.allowed], deadline: choice.deadline ?? choice.deferred, words: choice.words },
        body: { ddtIds: groupDdts.map((ddt) => ddt.id) },
      }
    })
    drafts.sort((a, b) => a.legalName.localeCompare(b.legalName) || a.month.localeCompare(b.month) || a.companyId.localeCompare(b.companyId))

    // The chosen orders with nothing a new draft takes, and why.
    const readyOrders = new Set(ready.map((entry) => entry.ddt.salesOrderId))
    const waiting = orders.filter((order) => !readyOrders.has(order.id))
    const withoutDdt =
      waiting.length === 0
        ? new Set<string>()
        : new Set(
            (await client.shipment.findMany({ where: { salesOrderId: { in: waiting.map((order) => order.id) }, status: { in: [...LEFT] }, ddts: { none: {} } }, select: { salesOrderId: true } })).map((shipment) => shipment.salesOrderId),
          )
    const held = waiting
      .map((order) => {
        const mine = rows.filter((row) => ddtOf.get(row.ddtId)?.salesOrderId === order.id)
        const inDraft = mine.filter((row) => row.notInvoiced.gt(0) && row.inDraft.gt(0))
        const reason: HeldReason = mine.length === 0 ? (withoutDdt.has(order.id) ? 'SHIPPED_WITHOUT_DDT' : 'NOTHING_SHIPPED') : inDraft.length > 0 ? 'IN_DRAFT' : 'INVOICED'
        const drafts = [...new Set(inDraft.flatMap((row) => row.invoices.filter((invoice) => invoice.draft).map((invoice) => invoice.invoiceId)))]
        return { orderId: order.id, number: order.number, reason, words: HELD_WORDS[reason](order.number), drafts }
      })
      .sort((a, b) => a.number.localeCompare(b.number))
    return { asOf: today, drafts, held }
  })
}
