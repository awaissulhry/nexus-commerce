import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CurrencyCode } from '@nexus/factory-domain/core/money'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { subcontractLineMatch, subcontractMatchWords, type CostEntryFacts, type OperationFacts, type SubcontractLineMatch } from '@nexus/factory-domain/payables/subcontract-match/rules'
import { bookablePieces, bookedPiecesOf, COSTED_STATUSES } from '@nexus/factory-domain/purchasing/subcontract-depth/cost'
import { PURCHASING_SUBCONTRACT_COST } from '@nexus/factory-domain/purchasing/subcontract-depth/permissions'
import { earnedAmount, type SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { bookCost } from '../../purchasing/subcontract-depth/cost'
import { heldGoodByOperation } from '../../purchasing/subcontracting/held'
import { readOperations } from '../../purchasing/subcontracting/store'
import { RefusedError } from '../invoices'
import { officeInvoice, seesCost, type InvoiceRow, type Reader } from '../store'

/**
 * A subcontractor's invoice matched to the operations done, the quantities returned and its cost entries (B-W2b-403;
 * FIN-138; PQ1:03; factory-domain payables/subcontract-match). Office only; prices and amounts with the cost grain.
 *
 *   GET  /payables/invoices/:invoiceId/subcontract-match                  payables.view: per line mapped to a subcontract
 *        order, the operations (sent, back good, defective, scrapped, waiting for inspection, booked by a FEE entry, still
 *        bookable, the fee earned for the rest), the order's cost entries (each FEE at the invoiced price marked as the line's),
 *        the cost the work order holds, the verdict in words and the FEE entries suggested
 *   POST /payables/invoices/:invoiceId/subcontract-match/:lineId/fee      purchasing.subcontract.cost + the cost grain over
 *        the order (purchasing's own command, POST /purchasing/subcontracting/orders/:id/costs, at the order's version): a FEE
 *        entry for the pieces of one operation at the invoiced price, naming the invoice and its line in its words; the work
 *        order's cost follows in the same command (W2a's earned fee less those pieces, the entry's amount). The invoice and its
 *        W2a match are not changed.
 */

const ENTRY_COLUMNS = { id: true, kind: true, subcontractOperationId: true, quantity: true, unitPrice: true, amount: true, reversalOfId: true, receiptId: true, occurredAt: true, reason: true } as const

interface OrderFacts {
  readonly order: { readonly id: string; readonly number: string; readonly status: string; readonly currency: string; readonly version: number; readonly workOrderId: string; readonly companyId: string; readonly siteId: string; readonly partyId: string }
  readonly operations: (OperationFacts & { readonly code: string; readonly name: string })[]
  readonly entries: (CostEntryFacts & { readonly occurredAt: Date; readonly reason: string | null })[]
}

async function orderFacts(db: Reader, orderId: string): Promise<OrderFacts | null> {
  const order = await db.subcontractOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, status: true, currency: true, version: true, workOrderId: true, companyId: true, siteId: true, partyId: true } })
  if (!order) return null
  const operations = await readOperations(db, orderId)
  const steps = new Map((await db.workOrderOperation.findMany({ where: { id: { in: operations.map((row) => row.workOrderOperationId) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const held = await heldGoodByOperation(db, [orderId])
  const rows = await db.subcontractCostEntry.findMany({ where: { subcontractOrderId: orderId }, select: ENTRY_COLUMNS, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
  const entries = rows.map((row) => ({ id: row.id, kind: row.kind as CostEntryFacts['kind'], subcontractOperationId: row.subcontractOperationId, quantity: row.quantity.toString(), unitPrice: row.unitPrice.toString(), amount: row.amount, reversalOfId: row.reversalOfId, occurredAt: row.occurredAt, reason: row.reason }))
  const booked = bookedPiecesOf(entries)
  return {
    order,
    entries,
    operations: operations.map((row) => {
      const waiting = held.get(row.id) ?? 0
      const bookedByFee = booked.get(row.id) ?? 0
      const step = steps.get(row.workOrderOperationId)
      return {
        id: row.id,
        seq: row.seq,
        code: step?.code ?? '',
        name: step?.name ?? '',
        pricePerPiece: row.pricePerPiece.toFixed(6),
        pieces: row.pieces,
        piecesBackGood: row.piecesBackGood,
        piecesDefective: row.piecesBackDefective,
        piecesScrapped: row.piecesScrapped,
        waiting,
        bookedByFee,
        bookable: bookablePieces({ piecesBackGood: row.piecesBackGood, held: waiting, booked: bookedByFee }),
        earned: earnedAmount(Math.max(0, row.piecesBackGood - waiting - bookedByFee), row.pricePerPiece.toFixed(6), order.currency as CurrencyCode),
      }
    }),
  }
}

/** Pieces the workshop's OTHER live invoices bill on the order (credit notes take off). */
async function billedElsewhere(db: Reader, invoiceId: string, orderId: string): Promise<string> {
  const lines = await db.supplierInvoiceLine.findMany({ where: { subcontractOrderId: orderId, invoiceId: { not: invoiceId }, invoice: { status: { not: 'VOIDED' } } }, select: { quantity: true, invoice: { select: { kind: true } } } })
  let total = new Dec(0)
  for (const line of lines) if (line.quantity !== null) total = line.invoice.kind === 'CREDIT_NOTE' ? total.minus(line.quantity.toString()) : total.plus(line.quantity.toString())
  return Dec.max(0, total).toFixed(4)
}

interface MatchedLine {
  readonly line: { readonly id: string; readonly seq: number; readonly description: string; readonly quantity: string | null; readonly netAmount: number }
  readonly facts: OrderFacts
  readonly match: SubcontractLineMatch
}

async function matchedLines(db: Reader, invoice: InvoiceRow): Promise<MatchedLine[]> {
  const lines = await db.supplierInvoiceLine.findMany({ where: { invoiceId: invoice.id, kind: 'SUBCONTRACT', subcontractOrderId: { not: null } }, select: { id: true, seq: true, description: true, quantity: true, netAmount: true, subcontractOrderId: true }, orderBy: { seq: 'asc' } })
  const out: MatchedLine[] = []
  for (const line of lines) {
    const facts = await orderFacts(db, line.subcontractOrderId!)
    if (!facts) continue
    const match = subcontractLineMatch({
      invoicedPieces: line.quantity === null ? null : line.quantity.toString(),
      net: invoice.kind === 'CREDIT_NOTE' ? -line.netAmount : line.netAmount,
      currency: facts.order.currency,
      billedElsewhere: await billedElsewhere(db, invoice.id, facts.order.id),
      operations: facts.operations,
      entries: facts.entries,
    })
    out.push({ line: { id: line.id, seq: line.seq, description: line.description, quantity: line.quantity === null ? null : line.quantity.toFixed(4), netAmount: line.netAmount }, facts, match })
  }
  return out
}

/** Why a FEE entry may not be booked from this invoice (null: it may); `forbidden`: the person lacks a right. */
function bookHeld(context: OfficeContext, facts: OrderFacts, invoice: InvoiceRow): { readonly forbidden: boolean; readonly words: string } | null {
  if (!can(actorOf(context), PURCHASING_SUBCONTRACT_COST, { companyId: facts.order.companyId, siteId: facts.order.siteId, partyId: facts.order.partyId })) return { forbidden: true, words: 'Booking a workshop fee needs purchasing.subcontract.cost.' }
  if (!seesCost(context)) return { forbidden: true, words: 'Booking a workshop fee needs the cost grain (money.cost).' }
  if (invoice.kind !== 'INVOICE') return { forbidden: false, words: 'A credit note books no fee.' }
  if (invoice.status === 'VOIDED') return { forbidden: false, words: 'The invoice is voided.' }
  if (!COSTED_STATUSES.includes(facts.order.status as SubcontractOrderStatus)) return { forbidden: false, words: `Subcontract order ${facts.order.number} is not issued: its work costs nothing yet.` }
  return null
}

/** GET /payables/invoices/:invoiceId/subcontract-match */
export async function invoiceSubcontractMatch(caller: CommandCaller, invoiceId: string) {
  const { context, invoice } = await officeInvoice(caller, invoiceId)
  const prices = seesCost(context)
  return caller.withClient(async (client) => {
    const lines = await matchedLines(client, invoice)
    return {
      invoiceId: invoice.id,
      currency: invoice.currency,
      lines: lines.map(({ line, facts, match }) => {
        const matched = new Set(match.matchedEntryIds)
        const reversed = new Set(facts.entries.flatMap((entry) => (entry.reversalOfId ? [entry.reversalOfId] : [])))
        return {
          lineId: line.id,
          seq: line.seq,
          description: line.description,
          quantity: line.quantity,
          netAmount: asMoney('cost', line.netAmount),
          order: { id: facts.order.id, number: facts.order.number, status: facts.order.status, currency: facts.order.currency, version: facts.order.version, workOrderId: facts.order.workOrderId },
          operations: facts.operations.map((operation) => ({
            id: operation.id,
            seq: operation.seq,
            code: operation.code,
            name: operation.name,
            pricePerPiece: asMoney('cost', operation.pricePerPiece),
            pieces: operation.pieces,
            piecesBackGood: operation.piecesBackGood,
            piecesDefective: operation.piecesDefective,
            piecesScrapped: operation.piecesScrapped,
            waitingForInspection: operation.waiting,
            bookedByFee: operation.bookedByFee,
            bookable: operation.bookable,
            earnedFee: asMoney('cost', operation.earned),
          })),
          entries: facts.entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            operationId: entry.subcontractOperationId,
            quantity: new Dec(entry.quantity).toFixed(4),
            unitPrice: asMoney('cost', new Dec(entry.unitPrice).toFixed(6)),
            amount: asMoney('cost', entry.amount),
            occurredAt: toUtcIso(entry.occurredAt),
            reason: entry.reason,
            reversalOfId: entry.reversalOfId,
            reversed: reversed.has(entry.id),
            ofThisLine: matched.has(entry.id),
          })),
          match: {
            verdict: match.verdict,
            invoicedPieces: match.invoicedPieces,
            invoicedTotal: match.invoicedTotal,
            invoicedUnitPrice: asMoney('cost', match.invoicedUnitPrice),
            orderUnitPrice: asMoney('cost', match.orderUnitPrice),
            price: match.price,
            piecesOwed: match.piecesOwed,
            piecesWaiting: match.piecesWaiting,
            piecesDefective: match.piecesDefective,
            piecesScrapped: match.piecesScrapped,
            piecesAtInvoicedPrice: match.piecesAtInvoicedPrice,
            onWorkOrder: { earnedFee: asMoney('cost', match.cost.earnedFee), fees: asMoney('cost', match.cost.fees), charges: asMoney('cost', match.cost.charges), sum: asMoney('cost', match.cost.total) },
            suggestions: match.suggestions.map((suggestion) => ({ subcontractOperationId: suggestion.subcontractOperationId, seq: suggestion.seq, quantity: suggestion.quantity, unitPrice: asMoney('cost', suggestion.unitPrice) })),
          },
          words: subcontractMatchWords(match, { prices }),
          book: { held: match.suggestions.length === 0 ? (match.verdict === 'BOOK_FEE' ? 'No piece can be booked at the invoiced price any more.' : 'Nothing to book: the cost entries carry the line.') : (bookHeld(context, facts, invoice)?.words ?? null) },
        }
      }),
    }
  })
}

export interface BookFeeInput {
  /** The subcontract order's version, as the match read it. */
  readonly orderVersion: number
  readonly subcontractOperationId: string
  readonly quantity: number
}

/** POST /payables/invoices/:invoiceId/subcontract-match/:lineId/fee */
export async function bookInvoiceFee(caller: CommandCaller, invoiceId: string, lineId: string, input: BookFeeInput, idempotencyKey?: string) {
  const { context, invoice } = await officeInvoice(caller, invoiceId)
  const found = isUuid(lineId) ? (await caller.withClient((client) => matchedLines(client, invoice))).find((row) => row.line.id === lineId) : undefined
  if (!found) throw new NotFoundError('No subcontract line of this invoice has that id.')
  const held = bookHeld(context, found.facts, invoice)
  if (held?.forbidden) throw new ForbiddenError(held.words)
  if (held) throw new RefusedError([{ code: 'NOT_BOOKABLE', message: held.words }])
  if (found.match.invoicedUnitPrice === null) throw new RefusedError([{ code: 'NO_QUANTITY', message: 'The line names no pieces: its price per piece is not known.' }])
  const operation = found.facts.operations.find((row) => row.id === input.subcontractOperationId)
  if (!operation) throw new RefusedError([{ code: 'OPERATION', message: `Not an operation of subcontract order ${found.facts.order.number}.` }])
  const reason = `Supplier invoice ${invoice.number} line ${found.line.seq}: ${input.quantity} pieces at the invoiced price.`
  const booked = await bookCost(caller, found.facts.order.id, { version: input.orderVersion, kind: 'FEE', subcontractOperationId: operation.id, quantity: String(input.quantity), unitPrice: found.match.invoicedUnitPrice, reason }, idempotencyKey)
  return { entryId: booked.entryId, ledger: booked.ledger, match: await invoiceSubcontractMatch(caller, invoiceId) }
}
