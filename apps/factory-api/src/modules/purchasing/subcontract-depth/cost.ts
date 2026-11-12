import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CurrencyCode } from '@nexus/factory-domain/core/money'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import {
  bookablePieces,
  bookedPiecesOf,
  bookProblems,
  bridgeOf,
  COSTED_STATUSES,
  costKindWords,
  entryAmount,
  reversedIdsOf,
  reverseProblems,
  type CostKind,
  type EntryFacts,
} from '@nexus/factory-domain/purchasing/subcontract-depth/cost'
import { PURCHASING_SUBCONTRACT_COST } from '@nexus/factory-domain/purchasing/subcontract-depth/permissions'
import { earnedAmount, type SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { postCostsInCommand } from '../../costing/actual/post'
import { readWorkOrder } from '../../costing/actual/store'
import { seesCost, type Reader } from '../store'
import { heldGoodByOperation } from '../subcontracting/held'
import { officeOrder, readOperations, readOrder, type OrderRow } from '../subcontracting/store'
import { workshopEntryKey } from './cost-source'
import { inWords } from './guarded'

/**
 * The workshop's cost on the work order (B-W2b-331; SCM-146; design purchasing.subcontracting record tab "Cost": the bridge
 * "fee 120 × 4.50 + transport 35 = 575 → WO-0221" and the supplier invoice match; factory-db SubcontractCostEntry, B-W2b-285).
 * Office only; every price and amount is money.cost (dropped for a caller without the cost grain, as the design says).
 *
 *   read     GET …/orders/:id/cost (purchasing.view): per operation the fee per piece, the pieces back good, waiting for
 *            inspection, booked by a FEE entry, still bookable, and the earned fee W2a posts for the rest; the order's own
 *            entries (with the receipt they came with, what took them back, whether the work order holds them); the bridge
 *            (earned fee + fees at the workshop's price + transport + material + other = the order's cost) beside what the
 *            work order's ledger holds of it and what waits, in words; the subcontractor's invoice lines that bill the order
 *            (with payables.view)
 *   book     POST …/orders/:id/costs (purchasing.subcontract.cost + the cost grain): ONE command on the order (its version
 *            bump holds the row): the entry (amount = quantity × price, rounded once) then the work order's ledger posted in
 *            the same command (costing's postCostsInCommand: the entry's SUBCONTRACT line, and for a FEE W2a's earned fee less
 *            the pieces it now pays)
 *   reverse  POST …/orders/:id/costs/:entryId/reverse (the same): the entry taken back whole with its reason, and its
 *            opposite posted on the work order
 */

const ENTRY_COLUMNS = {
  id: true,
  kind: true,
  subcontractOperationId: true,
  receiptId: true,
  quantity: true,
  unitPrice: true,
  amount: true,
  currency: true,
  occurredAt: true,
  reversalOfId: true,
  reason: true,
  createdAt: true,
  createdById: true,
} as const

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The charge is not valid as it stands.', problems)
const factsOfEntry = (row: { id: string; kind: string; subcontractOperationId: string | null; quantity: { toString(): string }; amount: number; reversalOfId: string | null }): EntryFacts => ({
  id: row.id,
  kind: row.kind as CostKind,
  subcontractOperationId: row.subcontractOperationId,
  quantity: row.quantity.toString(),
  amount: row.amount,
  reversalOfId: row.reversalOfId,
})

/** Per operation: the fee, the pieces back good, waiting, booked, still bookable, and the earned fee for the rest. */
async function operationFacts(db: Reader, order: OrderRow) {
  const operations = await readOperations(db, order.id)
  const steps = new Map((await db.workOrderOperation.findMany({ where: { id: { in: operations.map((row) => row.workOrderOperationId) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const held = await heldGoodByOperation(db, [order.id])
  const entries = await db.subcontractCostEntry.findMany({ where: { subcontractOrderId: order.id }, select: ENTRY_COLUMNS, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
  const booked = bookedPiecesOf(entries.map(factsOfEntry))
  return {
    entries,
    operations: operations.map((row) => {
      const facts = { piecesBackGood: row.piecesBackGood, held: held.get(row.id) ?? 0, booked: booked.get(row.id) ?? 0 }
      const step = steps.get(row.workOrderOperationId)
      return {
        id: row.id,
        seq: row.seq,
        code: step?.code ?? '',
        name: step?.name ?? '',
        pricePerPiece: row.pricePerPiece.toFixed(6),
        ...facts,
        bookable: bookablePieces(facts),
        earned: earnedAmount(Math.max(0, facts.piecesBackGood - facts.held - facts.booked), row.pricePerPiece.toFixed(6), order.currency as CurrencyCode),
      }
    }),
  }
}

function heldToBook(context: OfficeContext, order: OrderRow): string | null {
  if (!can(actorOf(context), PURCHASING_SUBCONTRACT_COST, { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId })) return 'Booking a workshop charge needs purchasing.subcontract.cost.'
  if (!seesCost(context)) return 'Booking a workshop charge needs the cost grain (money.cost).'
  if (!COSTED_STATUSES.includes(order.status as SubcontractOrderStatus)) return `The order is ${order.status === 'DRAFT' ? 'a draft' : 'cancelled'}: its work costs nothing (issue it first).`
  return null
}

/** The Cost tab of the order. */
export async function costView(db: Reader, context: OfficeContext, order: OrderRow) {
  const { entries, operations } = await operationFacts(db, order)
  const workOrder = await readWorkOrder(db, order.workOrderId)
  const receipts = new Map((await db.subcontractReceipt.findMany({ where: { subcontractOrderId: order.id }, select: { id: true, seq: true } })).map((row) => [row.id, row.seq]))
  const ledger = await db.workOrderCostEntry.findMany({ where: { subcontractOrderId: order.id, kind: 'SUBCONTRACT' }, select: { id: true, amount: true, sourceType: true, sourceId: true, idempotencyKey: true } })
  const postedKeys = new Set(ledger.map((row) => row.idempotencyKey))
  const reversedBy = new Map(entries.flatMap((entry) => (entry.reversalOfId ? [[entry.reversalOfId, entry.id] as const] : [])))
  const seqOf = new Map(operations.map((operation) => [operation.id, operation.seq]))
  const bridge = bridgeOf(
    operations.reduce((sum, operation) => sum + operation.earned, 0),
    entries.map((entry) => ({ kind: entry.kind as CostKind, amount: entry.amount })),
  )
  const posted = ledger.reduce((sum, row) => sum + row.amount, 0)
  const currencyWait = workOrder && workOrder.currency !== order.currency ? `Subcontract order ${order.number} is in ${order.currency}; the work order's cost is kept in ${workOrder.currency} (no exchange rates): nothing posts there yet.` : null
  const seesInvoices = can(actorOf(context), PAYABLES_VIEW, { companyId: order.companyId, partyId: order.partyId })
  const lines = seesInvoices
    ? await db.supplierInvoiceLine.findMany({ where: { subcontractOrderId: order.id }, select: { id: true, invoiceId: true, seq: true, description: true, netAmount: true }, orderBy: [{ invoiceId: 'asc' }, { seq: 'asc' }] })
    : []
  const invoices = new Map((await db.supplierInvoice.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.invoiceId))] } }, select: { id: true, number: true, status: true, matchStatus: true, currency: true } })).map((row) => [row.id, row]))
  const held = heldToBook(context, order)
  return {
    order: { id: order.id, number: order.number, status: order.status, currency: order.currency, workOrder: { id: order.workOrderId, number: workOrder?.number ?? '', currency: workOrder?.currency ?? order.currency } },
    operations: operations.map((operation) => ({
      id: operation.id,
      seq: operation.seq,
      code: operation.code,
      name: operation.name,
      pricePerPiece: asMoney('cost', operation.pricePerPiece),
      piecesBackGood: operation.piecesBackGood,
      waitingForInspection: operation.held,
      bookedByFee: operation.booked,
      bookable: operation.bookable,
      earnedFee: asMoney('cost', operation.earned),
    })),
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind as CostKind,
      words: costKindWords(entry.kind as CostKind),
      operation: entry.subcontractOperationId ? { id: entry.subcontractOperationId, seq: seqOf.get(entry.subcontractOperationId) ?? 0 } : null,
      receipt: entry.receiptId ? { id: entry.receiptId, seq: receipts.get(entry.receiptId) ?? 0 } : null,
      quantity: entry.quantity.toFixed(4),
      unitPrice: asMoney('cost', entry.unitPrice.toFixed(6)),
      amount: asMoney('cost', entry.amount),
      currency: entry.currency,
      occurredAt: toUtcIso(entry.occurredAt),
      reason: entry.reason,
      reversalOfId: entry.reversalOfId,
      reversedById: reversedBy.get(entry.id) ?? null,
      onWorkOrder: postedKeys.has(workshopEntryKey(entry.id)),
      createdAt: toUtcIso(entry.createdAt),
    })),
    bridge: {
      earnedFee: asMoney('cost', bridge.earnedFee),
      feeAtWorkshopPrice: asMoney('cost', bridge.fee),
      transport: asMoney('cost', bridge.transport),
      material: asMoney('cost', bridge.material),
      other: asMoney('cost', bridge.other),
      orderCost: asMoney('cost', bridge.sum),
      currency: order.currency,
    },
    workOrder: { onLedger: asMoney('cost', posted), entries: ledger.length, waiting: currencyWait ? [currencyWait] : [] },
    invoices: seesInvoices
      ? lines.map((line) => {
          const invoice = invoices.get(line.invoiceId)
          return { invoiceId: line.invoiceId, number: invoice?.number ?? '', status: invoice?.status ?? '', matchStatus: invoice?.matchStatus ?? '', currency: invoice?.currency ?? order.currency, seq: line.seq, description: line.description, netAmount: asMoney('cost', line.netAmount) }
        })
      : null,
    actions: { book: held, reverse: held },
  }
}

/** GET /purchasing/subcontracting/orders/:subcontractOrderId/cost */
export async function orderCost(caller: CommandCaller, orderId: string) {
  const { context, order } = await officeOrder(caller, orderId)
  return caller.withClient((client) => costView(client, context, order))
}

export interface BookCostInput {
  readonly version: number
  readonly kind: CostKind
  readonly subcontractOperationId?: string | null | undefined
  readonly receiptId?: string | null | undefined
  readonly quantity?: string | undefined
  readonly unitPrice?: string | undefined
  readonly occurredAt?: string | undefined
  readonly reason?: string | null | undefined
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** POST /purchasing/subcontracting/orders/:subcontractOrderId/costs — a workshop charge, onto the work order's cost. */
export async function bookCost(caller: CommandCaller, orderId: string, input: BookCostInput, idempotencyKey?: string) {
  const { context, order: seen } = await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_COST)
  if (!seesCost(context)) throw new ForbiddenError('Booking a workshop charge needs the cost grain (money.cost).')
  const entryId = newId()
  const { result } = await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.cost.book', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } }, async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      const { operations } = await operationFacts(tools.tx, order)
      const operation = input.subcontractOperationId ? operations.find((row) => row.id === input.subcontractOperationId) : undefined
      const unitPrice = input.unitPrice ?? (input.kind === 'FEE' && operation ? operation.pricePerPiece : undefined)
      if (unitPrice === undefined) throw refuse([{ path: 'body/unitPrice', message: `Say the ${costKindWords(input.kind)}'s price.` }])
      const quantity = input.quantity ?? '1'
      const occurredAt = input.occurredAt ? parseInstant(input.occurredAt)! : tools.now
      const problems = bookProblems(
        { kind: input.kind, subcontractOperationId: input.subcontractOperationId ?? null, quantity, unitPrice, occurredAt, reason: input.reason },
        { status: order.status as SubcontractOrderStatus, now: tools.now, operations: operations.map((row) => ({ id: row.id, seq: row.seq, bookable: row.bookable })) },
      )
      if (input.receiptId) {
        const receipt = isUuid(input.receiptId) ? await tools.tx.subcontractReceipt.findUnique({ where: { id: input.receiptId }, select: { subcontractOrderId: true } }) : null
        if (receipt?.subcontractOrderId !== orderId) problems.push({ path: 'body/receiptId', message: 'Not a receipt of this order.' })
      }
      if (problems.length > 0) throw refuse(problems)
      const amount = entryAmount(quantity, unitPrice, order.currency as CurrencyCode)
      await tools.tx.subcontractCostEntry.create({
        data: {
          id: entryId,
          siteId: order.siteId,
          workOrderId: order.workOrderId,
          subcontractOrderId: order.id,
          kind: input.kind,
          subcontractOperationId: input.kind === 'FEE' ? (input.subcontractOperationId ?? null) : null,
          receiptId: input.receiptId ?? null,
          quantity,
          unitPrice,
          amount,
          currency: order.currency,
          occurredAt: occurredAt.getTime() > tools.now.getTime() ? tools.now : occurredAt,
          reason: blankToNull(input.reason),
          createdAt: tools.now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      const cost = await postCostsInCommand(tools, order.workOrderId, { subcontractOrderIds: [order.id] })
      const onWorkOrder = cost.posted.some((entry) => entry.idempotencyKey === workshopEntryKey(entryId))
      tools.audit({
        action: 'purchasing.subcontract.cost.book',
        recordType: 'SubcontractOrder',
        recordId: order.id,
        companyId: order.companyId,
        siteId: order.siteId,
        after: { entryId, kind: input.kind, subcontractOperationId: input.subcontractOperationId ?? null, receiptId: input.receiptId ?? null, quantity, unitPrice: markMoney('cost', unitPrice), amount: markMoney('cost', amount), currency: order.currency, onWorkOrder },
      })
      tools.emit({
        type: 'subcontract_order.cost_booked',
        subject: order.id,
        companyId: order.companyId,
        siteId: order.siteId,
        payload: { subcontractOrderId: order.id, number: order.number, status: order.status as SubcontractOrderStatus, partyId: order.partyId, entryId, kind: input.kind, reversalOfId: null, posted: onWorkOrder },
      })
      return { posted: cost.posted.filter((entry) => entry.kind === 'SUBCONTRACT').length, waiting: cost.waiting.filter((entry) => entry.sourceType === 'SubcontractOrder').map((entry) => entry.words) }
    }),
  )
  return { entryId, ledger: result, view: await caller.withClient(async (client) => costView(client, context, (await readOrder(client, seen.id))!)) }
}

export interface ReverseCostInput {
  readonly version: number
  readonly reason: string
}

/** POST /purchasing/subcontracting/orders/:subcontractOrderId/costs/:entryId/reverse — taken back whole, with why. */
export async function reverseCost(caller: CommandCaller, orderId: string, entryId: string, input: ReverseCostInput, idempotencyKey?: string) {
  const { context, order: seen } = await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_COST)
  if (!seesCost(context)) throw new ForbiddenError('Taking back a workshop charge needs the cost grain (money.cost).')
  const reversalId = newId()
  const { result } = await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.cost.reverse', idempotencyKey, input: { orderId, entryId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } }, async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      const entries = await tools.tx.subcontractCostEntry.findMany({ where: { subcontractOrderId: order.id }, select: ENTRY_COLUMNS })
      const entry = entries.find((row) => row.id === entryId) ?? null
      const problems = reverseProblems(entry ? factsOfEntry(entry) : null, reversedIdsOf(entries.map(factsOfEntry)), input.reason)
      if (problems.length > 0) throw refuse(problems)
      await tools.tx.subcontractCostEntry.create({
        data: {
          id: reversalId,
          siteId: order.siteId,
          workOrderId: order.workOrderId,
          subcontractOrderId: order.id,
          kind: entry!.kind,
          subcontractOperationId: entry!.subcontractOperationId,
          receiptId: entry!.receiptId,
          quantity: entry!.quantity,
          unitPrice: entry!.unitPrice,
          amount: -entry!.amount,
          currency: entry!.currency,
          occurredAt: tools.now,
          reversalOfId: entry!.id,
          reason: input.reason.trim(),
          createdAt: tools.now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      const cost = await postCostsInCommand(tools, order.workOrderId, { subcontractOrderIds: [order.id] })
      const onWorkOrder = cost.posted.some((posted) => posted.idempotencyKey === workshopEntryKey(reversalId))
      tools.audit({
        action: 'purchasing.subcontract.cost.reverse',
        recordType: 'SubcontractOrder',
        recordId: order.id,
        companyId: order.companyId,
        siteId: order.siteId,
        after: { entryId: reversalId, reversalOfId: entry!.id, kind: entry!.kind, amount: markMoney('cost', -entry!.amount), onWorkOrder },
        reason: input.reason.trim(),
      })
      tools.emit({
        type: 'subcontract_order.cost_booked',
        subject: order.id,
        companyId: order.companyId,
        siteId: order.siteId,
        payload: { subcontractOrderId: order.id, number: order.number, status: order.status as SubcontractOrderStatus, partyId: order.partyId, entryId: reversalId, kind: entry!.kind as CostKind, reversalOfId: entry!.id, posted: onWorkOrder },
      })
      return { posted: cost.posted.filter((posted) => posted.kind === 'SUBCONTRACT').length, waiting: cost.waiting.filter((posted) => posted.sourceType === 'SubcontractOrder').map((posted) => posted.words) }
    }),
  )
  return { entryId: reversalId, ledger: result, view: await caller.withClient(async (client) => costView(client, context, (await readOrder(client, seen.id))!)) }
}
