import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { fromMinorUnits, toMinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { chargeVat } from '@nexus/factory-domain/invoicing/charges/charges'
import { withoutDdtDeadline } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { planDeductions, type DeductionPlan } from '@nexus/factory-domain/invoicing/from-shipment/deductions'
import { draftGoodsLines, notInvoiced, placeWithoutDdt, type NotInvoicedRow, type ShipmentWithoutDdt } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { invoiceCurrencyOf } from '@nexus/factory-domain/invoicing/language-currency/language-currency'
import { computeInvoiceTotals, MAX_CAUSALE, MAX_INVOICE_LINES } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { lineAmount } from '@nexus/factory-domain/tax/vat-summary'
import { treatmentKey } from '@nexus/factory-domain/tax/vat-treatment'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { decidedVat, insertDraft, type PaymentInput, type PreparedLine } from '../drafts'
import { assertMay, invoiceDetail, officeContextOf, readInvoice, type InvoiceDetail, type Reader } from '../store'
import { orderTermsSource } from '../terms'
import { draftPlanOf, vatFor } from './draft'
import { changeFeeLinesFor } from './fees'
import { lockInvoicing } from './locks'
import { depositInvoicesOf, orderPrices } from './store'
// B-W2b-330 (SAL-181): the orders' fees, invoiced once.
import { feeLinesFor } from '../../sales/price-waterfall/fee-invoicing'

/**
 * Goods shipped WITHOUT a DDT (B-W2b-GB02, G148; B-W1-51's gap "a shipment shipped without a DDT is not in the list"):
 * a shipment whose `ddtRequired` is false leaves with its immediate invoice instead of a DDT (DPR 633/1972 art. 21 c.4).
 * Its invoice lines name the order line and size and no DDT (an invoice line names no shipment), so what is invoiced of
 * such shipments is placed on them in the order they left (factory-domain from-shipment/shipped `placeWithoutDdt`): the
 * issued invoices first, then the drafts.
 *
 *   the list        shippedNotInvoiced's `shipments` (queue.ts): every SHIPPED or DELIVERED shipment without a DDT with
 *                   goods no issued invoice bills, its lines as the DDTs' are, its value at the order's prices (price
 *                   grain) and the deadline of its immediate invoice (12 days after it left; deadlines withoutDdtDeadline).
 *                   Home's "Invoices to issue" counts it too (insights/sources/invoicing.ts).
 *   the draft       POST /invoicing/invoices/from-shipment {shipmentId}: ONE command under the orders' 'shipment' locks:
 *                   a TD01 of what is left of the shipment (any shipment without a DDT not cancelled or returned: the
 *                   invoice may be made before the goods leave, as it travels with them), priced from the order and taxed
 *                   for the customer today, its freight once (when no invoice bills goods of it yet), the orders' fees
 *                   and the issued deposit invoices deducted, as the DDT draft does (draft.ts). Nothing left → 409 in words.
 */

const LIVE = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED'] as const
const LEFT = ['SHIPPED', 'DELIVERED'] as const
const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export interface ShipmentRow {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly shippedOn: BusinessDate | null
  readonly companyId: string
  readonly partyId: string
  readonly salesOrderId: string
  readonly freightCharge: number | null
  readonly currency: string
  readonly order: string
  readonly lines: readonly { readonly salesOrderLineId: string; readonly size: string; readonly quantity: number }[]
}

/** The shipments without a DDT these conditions find (cancelled and returned ones never), oldest first. */
export async function shipmentsWithoutDdt(db: Reader, where: Prisma.ShipmentWhereInput, take = 500): Promise<ShipmentRow[]> {
  const rows = await db.shipment.findMany({
    where: { AND: [where, { ddtRequired: false, status: { in: [...LIVE] } }] },
    take,
    orderBy: [{ shippedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      number: true,
      status: true,
      shippedAt: true,
      createdAt: true,
      companyId: true,
      partyId: true,
      salesOrderId: true,
      freightCharge: true,
      salesOrder: { select: { currency: true } },
      lines: { select: { salesOrderLineId: true, size: true, quantity: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    shippedOn: row.shippedAt ? day(row.shippedAt) : null,
    companyId: row.companyId,
    partyId: row.partyId,
    salesOrderId: row.salesOrderId,
    freightCharge: row.freightCharge,
    currency: row.salesOrder.currency,
    // Shipped ones first, by the moment they left; then the ones still in the house, by when they were made.
    order: `${row.shippedAt ? `0|${row.shippedAt.toISOString()}` : `1|${row.createdAt.toISOString()}`}|${row.number}`,
    lines: row.lines,
  }))
}

/**
 * What is left to invoice of these shipments (rows keyed as DDTs' with `ddtId` = the shipment's id): every shipment
 * without a DDT of the same order lines and every invoice line without a DDT of them are read, so the placing follows
 * the order the goods left in.
 */
export async function leftWithoutDdt(db: Reader, shipments: readonly ShipmentRow[], except: string | null = null): Promise<NotInvoicedRow[]> {
  const lineIds = [...new Set(shipments.flatMap((shipment) => shipment.lines.map((line) => line.salesOrderLineId)))]
  if (lineIds.length === 0) return []
  const all = await shipmentsWithoutDdt(db, { lines: { some: { salesOrderLineId: { in: lineIds } } } }, 5000)
  const billed = await db.invoiceLine.findMany({
    where: { ddtId: null, kind: 'GOODS', milestoneId: null, salesOrderLineId: { in: lineIds }, size: { not: null }, invoice: { docType: { in: ['TD01', 'TD24'] }, ...(except ? { id: { not: except } } : {}) } },
    select: { invoiceId: true, salesOrderLineId: true, size: true, quantity: true, invoice: { select: { number: true, status: true } } },
  })
  const placed = placeWithoutDdt(
    all.map((shipment): ShipmentWithoutDdt => ({ shipmentId: shipment.id, order: shipment.order, lines: shipment.lines })),
    billed.map((line) => ({ invoiceId: line.invoiceId, number: line.invoice.number, draft: line.invoice.status === 'DRAFT', salesOrderLineId: line.salesOrderLineId!, size: line.size!, quantity: line.quantity.toFixed(4) })),
  )
  const asked = new Set(shipments.map((shipment) => shipment.id))
  return notInvoiced(placed.shipped, placed.invoiced).filter((row) => asked.has(row.ddtId))
}

/** shippedNotInvoiced's shipments without a DDT (queue.ts), per shipment, in the reader's scope (`where`). */
export async function queueWithoutDdt(db: Reader, where: Prisma.ShipmentWhereInput, today: BusinessDate) {
  const shipments = await shipmentsWithoutDdt(db, { AND: [where, { status: { in: [...LEFT] } }] })
  const rows = (await leftWithoutDdt(db, shipments)).filter((row) => row.notInvoiced.gt(0))
  if (rows.length === 0) return []
  const prices = await orderPrices(db, rows.map((row) => row.salesOrderLineId))
  const open = shipments.filter((shipment) => rows.some((row) => row.ddtId === shipment.id))
  const orderIds = [...new Set(open.map((shipment) => shipment.salesOrderId))]
  const paid = orderIds.length > 0 ? await db.paymentAllocation.findMany({ where: { depositRequest: { orderId: { in: orderIds } } }, select: { amount: true, depositRequest: { select: { orderId: true } } } }) : []
  const orders = new Map((await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })).map((order) => [order.id, order]))
  return open.map((shipment) => {
    const lines = rows
      .filter((row) => row.ddtId === shipment.id)
      .map((row) => {
        const price = prices.get(row.salesOrderLineId)
        const unit = price ? (price.sizePrices[row.size] ?? price.unitPrice) : null
        const currency = price?.currency ?? shipment.currency
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
    const order = orders.get(shipment.salesOrderId)
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      shippedOn: shipment.shippedOn!,
      companyId: shipment.companyId,
      partyId: shipment.partyId,
      orders: order ? [{ id: order.id, number: order.number }] : [],
      lines,
      valueAmount: asMoney('price', lines.reduce((sum, line) => sum + (line.netAmount ?? 0), 0)),
      depositPaidAmount: asMoney('price', paid.filter((row) => row.depositRequest?.orderId === shipment.salesOrderId).reduce((sum, row) => sum + row.amount, 0)),
      drafts: [...new Set(lines.flatMap((line) => line.drafts))],
      deadline: withoutDdtDeadline({ number: shipment.number, date: shipment.shippedOn! }, today),
      freight: { amount: asMoney('price', shipment.freightCharge), currency: shipment.currency },
    }
  })
}

// ---- the draft --------------------------------------------------------------------------------------------------------

export interface FromShipmentInput {
  readonly shipmentId: string
  readonly causale?: string | null | undefined
  readonly payment?: PaymentInput | null | undefined
  readonly internalNote?: string | null | undefined
}

export interface FromShipmentAnswer {
  readonly invoice: InvoiceDetail
  readonly deductions: DeductionPlan['skipped'][number][]
  readonly freight: { readonly reason: string }[]
}

const words = (issues: readonly Issue[], fallback: string): string => (issues.length === 1 ? issues[0]!.message : fallback)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** invoices.manage: a TD01 draft of what is left of a shipment that leaves without a DDT (its immediate invoice). */
export async function createFromShipment(caller: CommandCaller, body: FromShipmentInput, idempotencyKey?: string): Promise<FromShipmentAnswer> {
  const context = officeContextOf(caller)
  if (!isUuid(body.shipmentId)) throw new ValidationError('Choose the shipment to invoice.', [{ path: 'body/shipmentId', message: 'Expected a shipment id.' }])
  const first = await caller.withClient((client) => client.shipment.findUnique({ where: { id: body.shipmentId }, select: { companyId: true, partyId: true } }))
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, first ? { companyId: first.companyId, partyId: first.partyId } : null, 'Shipment')
  const scope = { companyId: first!.companyId, partyId: first!.partyId }
  const plan = await draftPlanOf(caller, scope)
  const { result } = await command(caller, { name: 'invoices.createFromShipment', idempotencyKey, input: body }, async (tools): Promise<FromShipmentAnswer> => draftInCommand(tools, body, scope, plan))
  return result
}

async function draftInCommand(tools: CommandTools, body: FromShipmentInput, scope: { companyId: string; partyId: string }, plan: Awaited<ReturnType<typeof draftPlanOf>>): Promise<FromShipmentAnswer> {
  const { tx } = tools
  const head = await tx.shipment.findUnique({ where: { id: body.shipmentId }, select: { number: true, status: true, ddtRequired: true, salesOrderId: true } })
  if (!head) throw new NotFoundError('Shipment not found.')
  if (head.ddtRequired) throw new ConflictError(`Shipment ${head.number} travels with a DDT: invoice its DDT (Invoice shipped goods).`)
  if (head.status === 'CANCELLED' || head.status === 'RETURNED') throw new ConflictError(`Shipment ${head.number} is ${head.status === 'CANCELLED' ? 'cancelled' : 'returned'}: there is nothing to invoice.`)
  // The goods of an order shipped without a DDT are placed in the order they left: one command at a time per order.
  await lockInvoicing(tx, tools.context, 'shipment', [head.salesOrderId])
  const [shipment] = await shipmentsWithoutDdt(tx, { id: body.shipmentId })
  const all = await leftWithoutDdt(tx, [shipment!])
  const left = all.filter((row) => row.toInvoice.gt(0))
  if (left.length === 0) {
    const holders = [...new Map(all.flatMap((row) => row.invoices).map((invoice) => [invoice.invoiceId, invoice])).values()]
    const issued = holders.filter((invoice) => !invoice.draft).map((invoice) => invoice.number)
    throw new ConflictError(
      holders.some((invoice) => invoice.draft)
        ? `The goods of shipment ${shipment!.number} are in a draft invoice already: issue or delete it.`
        : issued.length > 0
          ? `Shipment ${shipment!.number} is invoiced already (${issued.join(', ')}): goods are invoiced once; a correction is a credit note.`
          : `Shipment ${shipment!.number} carries nothing to invoice yet: pack its garments first.`,
    )
  }
  const placedAny = all.some((row) => row.invoiced.gt(0) || row.inDraft.gt(0))

  // The goods lines, priced from the order and taxed for the customer today (the DDT draft's builder, no DDT named).
  const prices = await orderPrices(tx, left.map((row) => row.salesOrderLineId))
  const date = shipment!.shippedOn ?? businessDate(tools.now)
  const goods = draftGoodsLines(left.map((row) => ({ ddtId: shipment!.id, ddtNumber: shipment!.number, ddtDate: date, salesOrderLineId: row.salesOrderLineId, size: row.size, quantity: row.toInvoice })), prices, vatFor(plan.profile))
  if (goods.problems.length > 0) throw new ConflictError(words(goods.problems, 'The goods cannot be priced from their order.'))
  const billing = invoiceCurrencyOf([...prices.values()].map((price) => price.currency), plan.currency)
  if ('problem' in billing) throw new ConflictError(billing.problem)
  const currency = billing.currency
  const goodsVat = chargeVat(goods.lines.map((line) => line.core.vat), decidedVat(plan.profile, 'GOODS', 'party/taxIdentity'))

  // Its freight, once: only while no invoice bills goods of it yet.
  const freightLines: PreparedLine[] = []
  const freightLeft: FromShipmentAnswer['freight'] = []
  const amount = shipment!.freightCharge
  if (amount !== null && amount > 0) {
    if (placedAny) freightLeft.push({ reason: `Another invoice bills goods of shipment ${shipment!.number} already: add its freight there, or type it here.` })
    else if ('path' in goodsVat) freightLeft.push({ reason: goodsVat.message })
    else if (shipment!.currency !== currency) freightLeft.push({ reason: `The freight of shipment ${shipment!.number} is in ${shipment!.currency}, the invoice in ${currency}: type the line.` })
    else
      freightLines.push({
        core: { kind: 'CHARGE', description: `Spese di trasporto spedizione ${shipment!.number}`, itemCode: null, quantity: '1.0000', uom: null, unitPrice: fromMinorUnits(amount, currency).toFixed(6), discountPct: null, vat: goodsVat },
        salesOrderLineId: null,
        size: null,
        ddtId: null,
        chargeKind: 'FREIGHT',
      })
  }

  // The orders' fees and priced changes, and the issued deposit invoices deducted once (as the DDT draft does).
  const orderIds = [...new Set([...prices.values()].map((price) => price.orderId))]
  const fees = await feeLinesFor(tx, tools.context, orderIds, vatFor(plan.profile))
  if (fees.problems.length > 0) throw new ConflictError(words(fees.problems, "The orders' fees cannot be invoiced now."))
  const changeFees = await changeFeeLinesFor(tx, tools.context, orderIds, goodsVat, currency)
  if (changeFees.problems.length > 0) throw new ConflictError(words(changeFees.problems, "The orders' change fees cannot be invoiced now."))
  const goodsTotals = computeInvoiceTotals(goods.lines.map((line) => line.core), 'NET', currency)
  const goodsNet = new Map<string, number>()
  goods.lines.forEach((line, index) => goodsNet.set(treatmentKey(line.core.vat), (goodsNet.get(treatmentKey(line.core.vat)) ?? 0) + goodsTotals.lines[index]!.netAmount))
  const deposits = await depositInvoicesOf(tx, { orderIds }, { deductions: 'all', except: null })
  const deductions = planDeductions(deposits.filter((deposit) => deposit.companyId === scope.companyId), goodsNet, currency)

  const lines: PreparedLine[] = [
    ...goods.lines.map((line) => ({ core: line.core, salesOrderLineId: line.salesOrderLineId, size: line.size, ddtId: null })),
    ...freightLines,
    ...fees.lines,
    ...changeFees.lines,
    ...deductions.lines.map((line) => ({ core: line.core, salesOrderLineId: null, size: null, ddtId: null, depositInvoiceId: line.depositInvoiceId })),
  ]
  if (lines.length > MAX_INVOICE_LINES) throw new ConflictError(`This shipment makes ${lines.length} invoice lines; one invoice holds at most ${MAX_INVOICE_LINES}. Type the invoice in parts.`)
  const refs = [...new Set([...prices.values()].flatMap((price) => (price.customerRef ? [price.customerRef.trim().slice(0, 20)] : [])))].slice(0, 20)
  const id = newId()
  const salesOrderId = orderIds.length === 1 ? orderIds[0]! : null
  await insertDraft(
    tools,
    {
      id,
      companyId: scope.companyId,
      buyerPartyId: scope.partyId,
      docType: 'TD01',
      priceBasis: 'NET',
      currency,
      salesOrderId,
      depositRequestId: null,
      causale: (body.causale === undefined ? `Fattura immediata: merce spedita senza DDT (spedizione ${shipment!.number})` : blankToNull(body.causale))?.slice(0, MAX_CAUSALE) ?? null,
      documentRefs: refs.length > 0 ? (refs.map((number) => ({ kind: 'PURCHASE_ORDER', number })) as Prisma.InputJsonValue) : null,
      payment: body.payment ?? null,
      termsSource: body.payment ? null : await orderTermsSource(tx, { salesOrderId, partyId: scope.partyId }),
      internalNote: blankToNull(body.internalNote),
    },
    lines,
  )
  tools.audit({
    action: 'invoices.fromShipment',
    recordType: 'Invoice',
    recordId: id,
    companyId: scope.companyId,
    after: {
      shipment: shipment!.number,
      docType: 'TD01',
      dueBy: shipment!.shippedOn ? withoutDdtDeadline({ number: shipment!.number, date: shipment!.shippedOn }, businessDate(tools.now)).dueBy : null,
      pieces: left.reduce((sum, row) => sum.plus(row.toInvoice), new Dec(0)).toString(),
      freight: freightLines.length > 0,
      fees: fees.lines.map((line) => line.salesOrderLineId),
      deducted: deductions.lines.map((line) => line.depositInvoiceId),
      notDeducted: deductions.skipped.map((entry) => entry.depositInvoiceId),
    },
  })
  return { invoice: await invoiceDetail(tx, (await readInvoice(tx, id))!), deductions: [...deductions.skipped], freight: freightLeft }
}
