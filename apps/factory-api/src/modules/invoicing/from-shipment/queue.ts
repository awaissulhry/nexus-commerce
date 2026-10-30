import type { Prisma } from '@nexus/factory-db'
import { toMinorUnits } from '@nexus/factory-domain/core/money'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { chooseInvoiceType, immediateDeadline, presetDeadline } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { notInvoiced } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { monthOf } from '@nexus/factory-domain/invoicing/fatturapa/format'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { lineAmount } from '@nexus/factory-domain/tax/vat-summary'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../store'
import { freightBilledOf, invoicedOf, orderPrices, presetsOf, readDdts, shippedOf } from './store'

/**
 * Shipped, not invoiced (B-W1-51; FIN-054, FIN-116; A2 SCR-080 "Shipped, not invoiced"): every live DDT of a SHIPPED or
 * DELIVERED shipment with goods no issued invoice bills, grouped by customer (and company), with what each DDT carried
 * per order line and size, what is invoiced and what sits in a draft, its value at the order's prices (price grain),
 * the deposits paid on its orders, and the legal deadlines in words: the DDT's own (TD01, 12 days) and the month's
 * (TD24, the 15th of the next month), with the type the rule suggests for the month's DDTs of the customer. The 500
 * oldest DDTs at most (W1).
 *
 * B-W2a-54: the customer's preset (Party.invoiceTiming: per shipment TD01, monthly TD24) is the suggestion whenever the
 * law allows it, and each DDT carries its own deadline by it (`deadline`, the one the date timers count down to:
 * deadlines.ts); each DDT says its shipment's freight (price grain) and whether an invoice or a draft bills it already.
 */

export interface QueueQuery {
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
}

export async function shippedNotInvoiced(caller: CommandCaller, query: QueueQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.DdtWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.DdtWhereInput,
      { cancellations: { none: {} }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } },
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
    ],
  }
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const ddts = await readDdts(client, where, 500)
    const rows = notInvoiced(await shippedOf(client, ddts), await invoicedOf(client, ddts.map((ddt) => ddt.id)))
    const open = rows.filter((row) => row.notInvoiced.gt(0))
    const prices = await orderPrices(client, open.map((row) => row.salesOrderLineId))
    const openDdts = ddts.filter((ddt) => open.some((row) => row.ddtId === ddt.id))
    const parties = await client.party.findMany({ where: { id: { in: [...new Set(openDdts.map((ddt) => ddt.partyId))] } }, select: { id: true, code: true, legalName: true } })
    const orderIds = [...new Set([...prices.values()].map((price) => price.orderId))]
    const paid = orderIds.length > 0 ? await client.paymentAllocation.findMany({ where: { depositRequest: { orderId: { in: orderIds } } }, select: { amount: true, depositRequest: { select: { orderId: true } } } }) : []
    const presets = await presetsOf(client, openDdts.map((ddt) => ddt.partyId))
    const freightTaken = await freightBilledOf(client, openDdts.map((ddt) => ddt.id))

    const ddtViews = openDdts.map((ddt) => {
      const lines = open
        .filter((row) => row.ddtId === ddt.id)
        .map((row) => {
          const price = prices.get(row.salesOrderLineId)
          const unit = price ? (price.sizePrices[row.size] ?? price.unitPrice) : null
          const currency = price?.currency ?? 'EUR'
          return {
            salesOrderLineId: row.salesOrderLineId,
            orderId: price?.orderId ?? null,
            orderNumber: price?.orderNumber ?? null,
            description: price?.description ?? null,
            size: row.size,
            shipped: row.shipped.toString(),
            invoiced: row.invoiced.toString(),
            inDraft: row.inDraft.toString(),
            notInvoiced: row.notInvoiced.toString(),
            unitPrice: asMoney('price', unit),
            netAmount: asMoney('price', unit === null ? null : toMinorUnits(lineAmount(new Dec(unit), row.notInvoiced), currency)),
            drafts: row.invoices.filter((invoice) => invoice.draft).map((invoice) => invoice.invoiceId),
          }
        })
      const orders = [...new Map(lines.flatMap((line) => (line.orderId ? [[line.orderId, { id: line.orderId, number: line.orderNumber! }] as const] : []))).values()]
      return {
        ddtId: ddt.id,
        number: ddt.number,
        date: ddt.date,
        companyId: ddt.companyId,
        partyId: ddt.partyId,
        shipmentId: ddt.shipmentId,
        shipmentNumber: ddt.shipmentNumber,
        orders,
        lines,
        valueAmount: asMoney('price', lines.reduce((sum, line) => sum + (line.netAmount ?? 0), 0)),
        depositPaidAmount: asMoney('price', paid.filter((row) => orders.some((order) => order.id === row.depositRequest?.orderId)).reduce((sum, row) => sum + row.amount, 0)),
        drafts: [...new Set(lines.flatMap((line) => line.drafts))],
        immediate: immediateDeadline({ number: ddt.number, date: ddt.date }, today),
        deadline: presetDeadline({ number: ddt.number, date: ddt.date }, presets.get(ddt.partyId)?.preset ?? 'TD01', today),
        freight: { amount: asMoney('price', ddt.freightCharge), currency: ddt.orderCurrency, billed: freightTaken.some((row) => row.ddtId === ddt.id) },
      }
    })

    const groups = new Map<string, typeof ddtViews>()
    for (const view of ddtViews) {
      const key = `${view.partyId}|${view.companyId}`
      groups.set(key, [...(groups.get(key) ?? []), view])
    }
    const customers = [...groups.values()].map((views) => {
      const party = parties.find((entry) => entry.id === views[0]!.partyId)
      const preset = presets.get(views[0]!.partyId) ?? { timing: 'PER_SHIPMENT' as const, preset: 'TD01' as const }
      const months = [...new Set(views.map((view) => monthOf(view.date)))].sort().map((month) => {
        const inMonth = views.filter((view) => monthOf(view.date) === month)
        const choice = chooseInvoiceType(inMonth.map((view) => ({ number: view.number, date: view.date })), today, undefined, 'body/docType', preset.preset)
        return { month, ddtIds: inMonth.map((view) => view.ddtId), suggested: choice.suggested, allowed: [...choice.allowed], deadline: choice.deadline ?? choice.deferred, words: choice.words }
      })
      return {
        partyId: views[0]!.partyId,
        companyId: views[0]!.companyId,
        code: party?.code ?? '',
        legalName: party?.legalName ?? '',
        invoiceTiming: preset.timing,
        preset: preset.preset,
        valueAmount: asMoney('price', views.reduce((sum, view) => sum + view.valueAmount, 0)),
        oldestDate: views[0]!.date,
        months,
        ddts: views,
      }
    })
    customers.sort((a, b) => a.oldestDate.localeCompare(b.oldestDate) || a.legalName.localeCompare(b.legalName))
    return { asOf: today, customers }
  })
}
