import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { orderFromVersion, type AcceptedLine } from '@nexus/factory-domain/sales/orders/orders'
import type { CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { asDay, dayOrNull, hasOrderSeries } from './store'

/**
 * The order of an accepted quote version (B-W1-25; SAL-200 "quote to order in one step", SAL-203; Owner answer S1: made
 * at acceptance), inside a command of the office or the system that holds the version's row lock (quotes/after-acceptance
 * `afterAccept`, the same command and key as the deposit request; or the office's POST /sales/orders): ONE order per
 * version (the lock serialises the makers; a second run finds the first's order and makes nothing).
 *
 *   number     the company's SALES_ORDER series (allocateNumber, the acceptance's day): without an active series no order
 *              is made, and the answer says the order waits (`waits`): the deposit request still follows the acceptance,
 *              and the office makes the order once the series exists
 *   copy       factory-domain sales/orders `orderFromVersion`: lines and size grids, unit prices on the version's basis,
 *              VAT, costs, tax mode, currency, language, buyer and delivery address, payment terms, the promise date
 *              (also the first promise, never overwritten), the deposit gate (the version asked a deposit)
 *   deposits   the version's deposit requests that name no order yet are given this one (named once: the trigger)
 */

export type OrderWait = 'NO_SALES_ORDER_SERIES'

export interface MadeOrder {
  readonly order: { readonly id: string; readonly number: string } | null
  readonly created: boolean
  /** Why no order was made (no series yet); null when one exists. */
  readonly waits: OrderWait | null
  /** The deposit requests that were given the order now. */
  readonly linkedDepositRequestIds: string[]
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The version's deposit requests without an order are given it (once: the …_sales_guards trigger). */
async function linkDeposits(tools: CommandTools, order: { id: string; companyId: string }, versionId: string): Promise<string[]> {
  const open = await tools.tx.depositRequest.findMany({ where: { quoteVersionId: versionId, orderId: null }, select: { id: true }, orderBy: { id: 'asc' } })
  const linked: string[] = []
  for (const request of open) {
    const { count } = await tools.tx.depositRequest.updateMany({ where: { id: request.id, orderId: null }, data: { orderId: order.id, updatedAt: tools.now, version: { increment: 1 } } })
    if (count !== 1) continue
    linked.push(request.id)
    tools.audit({ action: 'orders.linkDeposit', recordType: 'DepositRequest', recordId: request.id, companyId: order.companyId, before: { orderId: null }, after: { orderId: order.id } })
  }
  return linked
}

export async function makeOrderInCommand(tools: CommandTools, versionId: string): Promise<MadeOrder> {
  const { tx, now } = tools
  const existing = await tx.salesOrder.findFirst({ where: { quoteVersionId: versionId }, select: { id: true, number: true, companyId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (existing) return { order: { id: existing.id, number: existing.number }, created: false, waits: null, linkedDepositRequestIds: await linkDeposits(tools, existing, versionId) }

  const version = await tx.quoteVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      quoteId: true,
      partyId: true,
      status: true,
      currency: true,
      language: true,
      taxMode: true,
      billTo: true,
      shipTo: true,
      paymentTerms: true,
      promiseDate: true,
      noWithdrawal: true,
      depositAmount: true,
      netAmount: true,
      vatAmount: true,
      grossAmount: true,
      costAmount: true,
    },
  })
  if (!version) throw new NotFoundError('Quote version not found.')
  if (version.status !== 'ACCEPTED') throw new InvalidStateError(`The quote version is ${version.status}; an order is made only from an ACCEPTED version.`)
  const quote = await tx.quote.findUniqueOrThrow({ where: { id: version.quoteId }, select: { id: true, companyId: true, customerRef: true } })
  if (!(await hasOrderSeries(tx, quote.companyId))) return { order: null, created: false, waits: 'NO_SALES_ORDER_SERIES', linkedDepositRequestIds: [] }

  const acceptance = await tx.quoteAcceptance.findFirst({ where: { versionId }, select: { acceptedAt: true }, orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }] })
  const acceptedOn = businessDate(acceptance?.acceptedAt ?? now)
  const quoteLines = await tx.quoteLine.findMany({
    where: { versionId },
    select: {
      id: true,
      seq: true,
      kind: true,
      styleId: true,
      styleRevisionId: true,
      colourwayId: true,
      measurementProfileId: true,
      baseSize: true,
      description: true,
      note: true,
      quantity: true,
      unitPrice: true,
      netAmount: true,
      vatRatePct: true,
      vatNature: true,
      vatAmount: true,
      unitCost: true,
      costAmount: true,
    },
    orderBy: { seq: 'asc' },
  })
  if (quoteLines.length === 0) throw new InvalidStateError('The accepted version has no lines: there is nothing to order.')
  const sizes = await tx.quoteLineSize.findMany({ where: { lineId: { in: quoteLines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true }, orderBy: [{ lineId: 'asc' }, { size: 'asc' }] })
  const revisionIds = [...new Set(quoteLines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
  const released = new Set(revisionIds.length > 0 ? (await tx.styleRevision.findMany({ where: { id: { in: revisionIds }, status: 'RELEASED' }, select: { id: true } })).map((row) => row.id) : [])

  const lines: AcceptedLine[] = quoteLines.map((line) => ({
    id: line.id,
    seq: line.seq,
    kind: line.kind,
    styleId: line.styleId,
    styleRevisionId: line.styleRevisionId,
    revisionReleased: line.styleRevisionId !== null && released.has(line.styleRevisionId),
    colourwayId: line.colourwayId,
    measurementProfileId: line.measurementProfileId,
    baseSize: line.baseSize,
    description: line.description,
    note: line.note,
    quantity: line.quantity,
    unitPrice: line.unitPrice.toString(),
    netAmount: line.netAmount,
    vatRatePct: line.vatRatePct.toString(),
    vatNature: line.vatNature,
    vatAmount: line.vatAmount,
    unitCost: line.unitCost === null ? null : line.unitCost.toString(),
    costAmount: line.costAmount,
    sizes: sizes.filter((row) => row.lineId === line.id).map((row) => ({ size: row.size, quantity: row.quantity, unitPrice: row.unitPrice === null ? null : row.unitPrice.toString() })),
  }))
  const draft = orderFromVersion(
    {
      taxMode: version.taxMode,
      currency: version.currency,
      language: version.language,
      billTo: version.billTo ?? {},
      shipTo: version.shipTo ?? {},
      paymentTerms: version.paymentTerms,
      promiseDate: dayOrNull(version.promiseDate),
      noWithdrawal: version.noWithdrawal,
      depositAmount: version.depositAmount,
      netAmount: version.netAmount,
      vatAmount: version.vatAmount,
      grossAmount: version.grossAmount,
      costAmount: version.costAmount,
      customerRef: quote.customerRef,
      acceptedOn,
    },
    lines,
  )

  const id = newId()
  const number = await allocateNumber(tools, { companyId: quote.companyId, kind: 'SALES_ORDER' }, { type: 'SalesOrder', id, date: acceptedOn })
  const stamp = { createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }
  const { header } = draft
  await tx.salesOrder.create({
    data: {
      id,
      companyId: quote.companyId,
      partyId: version.partyId,
      number: number.formatted,
      quoteVersionId: version.id,
      customerRef: header.customerRef,
      status: header.status,
      orderDate: asDay(header.orderDate),
      currency: header.currency,
      language: header.language,
      taxMode: header.taxMode,
      billTo: header.billTo as Prisma.InputJsonValue,
      shipTo: header.shipTo as Prisma.InputJsonValue,
      paymentTerms: header.paymentTerms,
      promiseDate: header.promiseDate === null ? null : asDay(header.promiseDate),
      originalPromiseDate: header.originalPromiseDate === null ? null : asDay(header.originalPromiseDate),
      priority: header.priority,
      noWithdrawal: header.noWithdrawal,
      depositRequired: header.depositRequired,
      netAmount: header.netAmount,
      vatAmount: header.vatAmount,
      grossAmount: header.grossAmount,
      costAmount: header.costAmount,
      ...stamp,
    },
    select: { id: true },
  })
  for (const line of draft.lines) {
    const lineId = newId()
    await tx.salesOrderLine.create({
      data: {
        id: lineId,
        companyId: quote.companyId,
        orderId: id,
        partyId: version.partyId,
        seq: line.seq,
        kind: line.kind,
        quoteLineId: line.quoteLineId,
        styleId: line.styleId,
        styleRevisionId: line.styleRevisionId,
        colourwayId: line.colourwayId,
        measurementProfileId: line.measurementProfileId,
        baseSize: line.baseSize,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        netAmount: line.netAmount,
        vatRatePct: line.vatRatePct,
        vatNature: line.vatNature,
        vatAmount: line.vatAmount,
        unitCost: line.unitCost,
        costAmount: line.costAmount,
        ...stamp,
      },
      select: { id: true },
    })
    if (line.sizes.length > 0) {
      await tx.salesOrderLineSize.createMany({ data: line.sizes.map((size) => ({ id: newId(), lineId, partyId: version.partyId, size: size.size, quantity: size.quantity, unitPrice: size.unitPrice, ...stamp })) })
    }
  }
  const linked = await linkDeposits(tools, { id, companyId: quote.companyId }, version.id)
  tools.audit({
    action: 'orders.make',
    recordType: 'SalesOrder',
    recordId: id,
    companyId: quote.companyId,
    after: {
      number: number.formatted,
      quoteId: quote.id,
      quoteVersionId: version.id,
      status: header.status,
      orderDate: header.orderDate,
      taxMode: header.taxMode,
      currency: header.currency,
      promiseDate: header.promiseDate,
      originalPromiseDate: header.originalPromiseDate,
      depositRequired: header.depositRequired,
      lines: draft.lines.length,
      pieces: draft.lines.reduce((total, line) => total + line.quantity, 0),
      netAmount: markMoney('price', header.netAmount),
      vatAmount: markMoney('price', header.vatAmount),
      grossAmount: markMoney('price', header.grossAmount),
      costAmount: markMoney('cost', header.costAmount),
      depositRequestIds: linked,
    },
  })
  tools.emit({
    type: 'sales_order.created',
    subject: id,
    companyId: quote.companyId,
    payload: { orderId: id, number: number.formatted, quoteId: quote.id, versionId: version.id, partyId: version.partyId, depositRequestIds: linked },
  })
  return { order: { id, number: number.formatted }, created: true, waits: null, linkedDepositRequestIds: linked }
}
