import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { addressUseProblem } from '@nexus/factory-domain/parties/address-approval'
import { planSplit, ORDERS_DEPTH_LIMITS, type SplitLineInput, type SplitPlan } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { MAX_TEXT, priceBasisOf, priceText, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { shipToSnapshot } from '@nexus/factory-domain/sales/quotes/send'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { amendInCommand } from '../orders/amend'
import { officeContextOf } from '../orders/access'
import { officeOrder, recordAfter } from '../orders/moves'
import { priceLines, scaledCost, type LineDraft } from '../orders/pricing'
import { makeScheduleInCommand } from '../orders/schedule'
import { asDay, hasOrderSeries, lockOrder, readLines, readOrder, type LineRecord } from '../orders/store'
import { treatmentOfStored } from '../quotes/store'

/**
 * Several orders from one quote (B-W2b-303; SAL-201 "splitting one quote into several orders"; plan "Several orders from one
 * accepted version, each with its lines, deliveries and ship-to"). The acceptance makes ONE order of the accepted version
 * (W1, unchanged); the office splits parts of it off into orders of their own — same customer, quote version, terms, prices,
 * Incoterm, season and priority — each with its own delivery address, PO number and dates. ONE command (orders.manage):
 *
 *   1. the order's row at the version read; its lines planned (factory-domain planSplit: whole lines or some sizes; a line
 *      with a delivery schedule or options moves whole; fee lines, made-to-measure units and lines closed short stay; the
 *      order keeps at least one piece)
 *   2. each part: a new order numbered from the company's SALES_ORDER series, CONFIRMED, quoteVersionId the same, its lines
 *      at the order's unit and size prices with their waterfalls (priced on the order's basis and VAT, each line its cost per
 *      piece), a whole line's delivery schedule copied (the days still ahead), its payment schedule from the terms (no deposit:
 *      the accepted version's deposit stays with the first order), audit and sales_order.created
 *   3. the order keeps the rest: W2a's amendment (orders/amend.ts amendInCommand, its next revision with both snapshots, its
 *      totals, its OPEN payment steps made again; a line left with nothing is removed only when nothing refers to it), without
 *      a re-acceptance (the customer's whole stays the same), then sales_order.split
 */

export interface SplitPartBody {
  readonly lines: readonly SplitLineInput[]
  readonly shipToAddressId?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly promiseDate?: BusinessDate | null | undefined
}

export interface SplitBody {
  readonly version: number
  readonly reason?: string | null | undefined
  readonly parts: readonly SplitPartBody[]
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())
const invalid = (issues: Issue[]) => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The order cannot be split like this.', issues)
const priceOf = (value: { toString(): string } | null): string | null => (value === null ? null : priceText(value.toString()))

const HEADER_COLUMNS = {
  incoterm: true,
  incotermPlace: true,
  shipComplete: true,
  priorityLevel: true,
  urgentReason: true,
  seasonId: true,
} as const satisfies Prisma.SalesOrderSelect

/** The delivery address a part names: an ACTIVE address of the customer we approved, as a snapshot. */
async function shipToOf(tools: CommandTools, partyId: string, addressId: string, at: string): Promise<unknown> {
  const row = await tools.tx.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, status: true, approvalStatus: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true } })
  if (!row || row.partyId !== partyId || row.status !== 'ACTIVE') throw invalid([{ path: at, message: 'Not an active delivery address of this customer.' }])
  const problem = addressUseProblem(row.approvalStatus)
  if (problem) throw invalid([{ path: at, message: problem }])
  return shipToSnapshot({ name: row.name, line1: row.line1, line2: row.line2, postalCode: row.postalCode, city: row.city, province: row.province, country: row.country, contactName: row.contactName, phone: row.phone })
}

/** The source's lines as the plan reads them (deliveries and options by line). */
async function sourceOf(tools: CommandTools, lines: readonly LineRecord[]) {
  const ids = lines.map((line) => line.id)
  const deliveries = ids.length === 0 ? [] : await tools.tx.salesOrderLineDelivery.findMany({ where: { lineId: { in: ids } }, select: { lineId: true, deliveryDate: true, sizeQuantities: true, quantity: true, note: true }, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
  const options = ids.length === 0 ? [] : await tools.tx.salesOrderLineOption.findMany({ where: { lineId: { in: ids } }, select: { lineId: true } })
  const steps = new Map((ids.length === 0 ? [] : await tools.tx.salesOrderLine.findMany({ where: { id: { in: ids } }, select: { id: true, priceSteps: true } })).map((row) => [row.id, row.priceSteps]))
  return { deliveries, options: new Set(options.map((row) => row.lineId)), steps }
}

/** POST /sales/orders/:orderId/split (see the module's head). */
export async function splitOrder(caller: CommandCaller, orderId: string, body: SplitBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const reason = blank(body.reason)
  if (reason !== null && reason.length > ORDERS_DEPTH_LIMITS.splitReason) throw invalid([{ path: 'body/reason', message: `At most ${ORDERS_DEPTH_LIMITS.splitReason} characters.` }])
  for (const [index, part] of body.parts.entries()) {
    if (part.customerRef && part.customerRef.trim().length > MAX_TEXT.customerRef) throw invalid([{ path: `body/parts/${index}/customerRef`, message: `At most ${MAX_TEXT.customerRef} characters.` }])
  }
  const { result } = await command(caller, { name: 'orders.split', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const locked = await lockOrder(tx, order.id, body.version)
    if (!['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(locked.status)) throw new ConflictError(`${order.number} is ${locked.status}: an order is split while it is confirmed, in production or ready.`)
    if (!(await hasOrderSeries(tx, order.companyId))) throw new ConflictError('The company has no active SALES_ORDER number series: an administrator adds one under Numbering, then the order can be split.')
    const fresh = (await readOrder(tx, order.id))!
    const header = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: HEADER_COLUMNS })
    const lines = await readLines(tx, order.id)
    const facts = await sourceOf(tools, lines)
    const plan = planSplit(
      lines.map((line) => ({ id: line.id, seq: line.seq, kind: line.kind, closedShort: line.closedShortQuantity !== null, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })), hasDeliveries: facts.deliveries.some((row) => row.lineId === line.id), hasOptions: facts.options.has(line.id) })),
      body.parts.map((part) => ({ lines: part.lines })),
    )
    if (Array.isArray(plan)) throw invalid(plan)
    for (const [index, part] of body.parts.entries()) {
      if (part.promiseDate && part.promiseDate < today) throw invalid([{ path: `body/parts/${index}/promiseDate`, message: 'The promise date is today or later.' }])
      if (part.requestedDate && part.requestedDate < today) throw invalid([{ path: `body/parts/${index}/requestedDate`, message: 'The requested date is today or later.' }])
    }
    const byId = new Map(lines.map((line) => [line.id, line]))
    const treatment = treatmentOfStored(lines[0]!)
    const actorId = actorIdOf(tools)
    const stamp = { createdAt: now, updatedAt: now, createdById: actorId }
    const made: { id: string; number: string }[] = []

    // 2. the new orders.
    for (const [index, part] of body.parts.entries()) {
      const planned = (plan as SplitPlan).parts[index]!
      const drafts: LineDraft[] = planned.map((entry) => {
        const line = byId.get(entry.lineId)!
        const own = new Map(line.sizes.map((size) => [size.size, priceOf(size.unitPrice)]))
        const sizes: SizeRow[] = entry.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: own.get(size.size) ?? null }))
        const pieces = entry.sizes.reduce((sum, size) => sum + size.quantity, 0)
        const unitCost = priceOf(line.unitCost)
        return {
          id: null,
          seq: line.seq,
          kind: 'SIZE_GRID',
          styleId: line.styleId,
          styleRevisionId: line.styleRevisionId,
          colourwayId: line.colourwayId,
          measurementProfileId: null,
          baseSize: line.baseSize,
          description: line.description,
          note: line.note,
          unitPrice: priceText(line.unitPrice.toString()),
          sizes,
          unitCost,
          costAmount: entry.whole ? line.costAmount : scaledCost(unitCost, pieces, fresh.currency),
          changed: true,
        }
      })
      const priced = priceLines(priceBasisOf(fresh.taxMode), fresh.currency, treatment, drafts)
      const id = newId()
      const number = await allocateNumber(tools, { companyId: fresh.companyId, kind: 'SALES_ORDER' }, { type: 'SalesOrder', id, date: today })
      const shipTo = part.shipToAddressId ? await shipToOf(tools, fresh.partyId, part.shipToAddressId, `body/parts/${index}/shipToAddressId`) : fresh.shipTo
      const promise = part.promiseDate === undefined ? fresh.promiseDate : part.promiseDate === null ? null : asDay(part.promiseDate)
      await tx.salesOrder.create({
        data: {
          id,
          companyId: fresh.companyId,
          partyId: fresh.partyId,
          number: number.formatted,
          quoteVersionId: fresh.quoteVersionId,
          customerRef: part.customerRef === undefined ? fresh.customerRef : blank(part.customerRef),
          status: 'CONFIRMED',
          orderDate: asDay(today),
          currency: fresh.currency,
          language: fresh.language,
          taxMode: fresh.taxMode,
          billTo: fresh.billTo as Prisma.InputJsonValue,
          shipTo: shipTo as Prisma.InputJsonValue,
          incoterm: header.incoterm,
          incotermPlace: header.incotermPlace,
          shipComplete: header.shipComplete,
          paymentTerms: fresh.paymentTerms,
          paymentTermsId: fresh.paymentTermsId,
          requestedDate: part.requestedDate === undefined ? fresh.requestedDate : part.requestedDate === null ? null : asDay(part.requestedDate),
          promiseDate: promise,
          originalPromiseDate: promise,
          priority: fresh.priority,
          priorityLevel: header.priorityLevel,
          urgentReason: header.urgentReason,
          seasonId: header.seasonId,
          noWithdrawal: fresh.noWithdrawal,
          depositRequired: false,
          netAmount: priced.netAmount,
          vatAmount: priced.vatAmount,
          grossAmount: priced.grossAmount,
          costAmount: priced.costAmount,
          internalNote: `Split from ${fresh.number}.${reason ? ` ${reason}` : ''}`.slice(0, MAX_TEXT.internalNote),
          ...stamp,
        },
        select: { id: true },
      })
      for (const [lineIndex, line] of priced.lines.entries()) {
        const source = byId.get(planned[lineIndex]!.lineId)!
        const lineId = newId()
        const steps = facts.steps.get(source.id)
        await tx.salesOrderLine.create({
          data: {
            id: lineId,
            companyId: fresh.companyId,
            orderId: id,
            partyId: fresh.partyId,
            seq: line.seq,
            kind: 'SIZE_GRID',
            quoteLineId: source.quoteLineId,
            styleId: line.styleId,
            styleRevisionId: line.styleRevisionId,
            colourwayId: line.colourwayId,
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
            // B-W2b-330: the waterfall goes with the same unit price.
            ...(Array.isArray(steps) ? { priceSteps: steps as Prisma.InputJsonValue } : {}),
            ...stamp,
          },
          select: { id: true },
        })
        await tx.salesOrderLineSize.createMany({ data: line.sizes.map((size) => ({ id: newId(), lineId, partyId: fresh.partyId, size: size.size, quantity: size.quantity, unitPrice: size.unitPrice, ...stamp })) })
        // A whole line's delivery schedule goes with it (the days still ahead: B-W2b-294's carry).
        if (planned[lineIndex]!.whole) {
          for (const delivery of facts.deliveries.filter((row) => row.lineId === source.id && row.deliveryDate.toISOString().slice(0, 10) >= today)) {
            await tx.salesOrderLineDelivery.create({ data: { id: newId(), lineId, partyId: fresh.partyId, deliveryDate: delivery.deliveryDate, ...(delivery.sizeQuantities === null ? {} : { sizeQuantities: delivery.sizeQuantities as Prisma.InputJsonValue }), quantity: delivery.quantity, note: delivery.note, createdById: actorId }, select: { id: true } })
          }
        }
      }
      const steps = await makeScheduleInCommand(tools, { id, number: number.formatted, companyId: fresh.companyId, partyId: fresh.partyId, currency: fresh.currency, grossAmount: priced.grossAmount, promiseDate: promise, paymentTermsId: fresh.paymentTermsId }, null)
      tools.audit({
        action: 'orders.splitOff',
        recordType: 'SalesOrder',
        recordId: id,
        companyId: fresh.companyId,
        after: { number: number.formatted, splitFrom: fresh.id, splitFromNumber: fresh.number, quoteVersionId: fresh.quoteVersionId, status: 'CONFIRMED', lines: priced.lines.length, pieces: priced.lines.reduce((sum, line) => sum + line.quantity, 0), netAmount: markMoney('price', priced.netAmount), grossAmount: markMoney('price', priced.grossAmount), costAmount: markMoney('cost', priced.costAmount), milestoneIds: steps },
      })
      const quoteId = fresh.quoteVersionId ? ((await tx.quoteVersion.findUnique({ where: { id: fresh.quoteVersionId }, select: { quoteId: true } }))?.quoteId ?? null) : null
      tools.emit({ type: 'sales_order.created', subject: id, companyId: fresh.companyId, payload: { orderId: id, number: number.formatted, quoteId, versionId: fresh.quoteVersionId, partyId: fresh.partyId, depositRequestIds: [] } })
      made.push({ id, number: number.formatted })
    }

    // 3. the order keeps the rest (W2a's amendment, no re-acceptance).
    const remaining = (plan as SplitPlan).remaining
    const touched = new Set((plan as SplitPlan).parts.flatMap((part) => part.map((entry) => entry.lineId)))
    const amendment = await amendInCommand(
      tools,
      context.tenantId,
      fresh,
      {
        version: locked.version,
        reason: reason ?? `Split: parts moved to ${made.map((entry) => entry.number).join(', ')}.`,
        // A line no part names stays as it is; a line some sizes left keeps the rest.
        lines: lines.filter((line) => remaining.has(line.id)).map((line) => (touched.has(line.id) ? { id: line.id, sizes: remaining.get(line.id)!.map((size) => ({ size: size.size, quantity: size.quantity })) } : { id: line.id })),
      },
      { reacceptance: false },
    )
    const revision = (await tx.salesOrderAmendment.findUniqueOrThrow({ where: { id: amendment.amendmentId }, select: { revision: true } })).revision
    tools.emit({ type: 'sales_order.split', subject: fresh.id, companyId: fresh.companyId, payload: { orderId: fresh.id, number: fresh.number, newOrderIds: made.map((entry) => entry.id), newNumbers: made.map((entry) => entry.number), amendmentId: amendment.amendmentId, revision } })
    return { orderId: fresh.id, amendmentId: amendment.amendmentId, revision, made }
  })
  const view = await recordAfter(caller, result.orderId)
  if (!view) throw new NotFoundError('Sales order not found.')
  return { order: view, amendment: { id: result.amendmentId, revision: result.revision }, orders: result.made }
}
