import type { Issue } from '../../core/errors'
import { fitsDecimal, toMinorUnits, UNIT_PRICE, type CurrencyCode, type MinorUnits } from '../../core/money'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import type { SubcontractOrderStatus } from '../subcontracting/rules'

/**
 * The workshop's cost on the work order (B-W2b-331; SCM-146; design purchasing.subcontracting record tab "Cost": "Fee per
 * piece plus material plus transport, booked to the work order", bridge "fee 120 × 4.50 + transport 35 = 575 → WO-0221";
 * factory-db buying-depth.prisma SubcontractCostEntry, B-W2b-285). Pure; every price and amount is a cost (money.cost,
 * office only).
 *
 *   earned fee   per operation: the fee per piece × the pieces back good (W2a's cost source posts it at receipt, once the
 *                incoming inspection, when there is one, released them), less the pieces a FEE entry books
 *   FEE          the fee for an operation's pieces back good at the workshop's price (its invoice, an agreed price): the
 *                pieces it books leave the earned fee, so a piece is never paid twice; at most the pieces back good, not
 *                waiting for inspection, not booked yet
 *   TRANSPORT    to or from the workshop; MATERIAL the workshop supplied and charges; OTHER anything else, in words
 *   reversal     an entry taken back whole with its reason (once; never a reversal itself)
 *
 * amount = quantity × unit price, rounded once (half up) to the order's currency's minor units. Each entry goes onto the
 * work order's cost ledger as a SUBCONTRACT entry in the same act (the API's cost source); an order in another currency
 * than the work order's waits, in words (there are no exchange rates).
 */

export const COST_KINDS = ['FEE', 'TRANSPORT', 'MATERIAL', 'OTHER'] as const
export type CostKind = (typeof COST_KINDS)[number]

export const REASON_MAX = 2000

const KIND_WORDS: Readonly<Record<CostKind, string>> = { FEE: 'fee', TRANSPORT: 'transport', MATERIAL: 'material', OTHER: 'charge' }
export const costKindWords = (kind: CostKind): string => KIND_WORDS[kind]

/** The order's work costs nothing while it is a draft or cancelled (the database's). */
export const COSTED_STATUSES: readonly SubcontractOrderStatus[] = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED']

/** quantity × unit price, rounded once to the currency's minor units. */
export const entryAmount = (quantity: string, unitPrice: string, currency: CurrencyCode): MinorUnits => toMinorUnits(decimalOf(quantity, 'quantity').times(decimalOf(unitPrice, 'unitPrice')), currency)

export interface EntryFacts {
  readonly id: string
  readonly kind: CostKind
  readonly subcontractOperationId: string | null
  readonly quantity: string
  readonly amount: number
  readonly reversalOfId: string | null
}

/** The pieces FEE entries book per operation (taken back ones out). */
export function bookedPiecesOf(entries: readonly EntryFacts[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== 'FEE' || entry.subcontractOperationId === null) continue
    const pieces = Number.parseInt(decimalOf(entry.quantity).toFixed(0), 10)
    out.set(entry.subcontractOperationId, (out.get(entry.subcontractOperationId) ?? 0) + (entry.reversalOfId === null ? pieces : -pieces))
  }
  return out
}

/** The entries taken back (by a reversal). */
export const reversedIdsOf = (entries: readonly EntryFacts[]): Set<string> => new Set(entries.flatMap((entry) => (entry.reversalOfId ? [entry.reversalOfId] : [])))

/** The pieces of an operation a FEE entry may still book: back good, not waiting for inspection, not booked. */
export const bookablePieces = (operation: { readonly piecesBackGood: number; readonly held: number; readonly booked: number }): number => Math.max(0, operation.piecesBackGood - operation.held - operation.booked)

export interface BookInput {
  readonly kind: CostKind
  readonly subcontractOperationId?: string | null | undefined
  readonly quantity: string
  readonly unitPrice: string
  readonly occurredAt: Date
  readonly reason?: string | null | undefined
}

export interface BookFacts {
  readonly status: SubcontractOrderStatus
  readonly now: Date
  /** The operations of the order, with what a FEE may book. */
  readonly operations: readonly { readonly id: string; readonly seq: number; readonly bookable: number }[]
}

const words = (value: string | null | undefined): boolean => value !== null && value !== undefined && value.trim().length >= 1 && value.trim().length <= REASON_MAX

/** Why the entry may not be booked (paths `body/…`). */
export function bookProblems(input: BookInput, facts: BookFacts): Issue[] {
  if (!COSTED_STATUSES.includes(facts.status)) return [{ path: 'body/version', message: `The order is ${facts.status === 'DRAFT' ? 'a draft' : 'cancelled'}: its work costs nothing (issue it first).` }]
  const problems: Issue[] = []
  const quantity = decimalOf(input.quantity, 'body/quantity')
  const price = decimalOf(input.unitPrice, 'body/unitPrice')
  if (!quantity.greaterThan(0) || quantity.decimalPlaces() > QUANTITY_SCALE) problems.push({ path: 'body/quantity', message: `A quantity above 0, at most ${QUANTITY_SCALE} decimals.` })
  if (price.lessThan(0) || !fitsDecimal(input.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale)) problems.push({ path: 'body/unitPrice', message: 'A price of 0 or more, at most 6 decimals.' })
  if (input.occurredAt.getTime() > facts.now.getTime() + 10 * 60_000) problems.push({ path: 'body/occurredAt', message: 'The cost was incurred now or before, not later.' })
  if (input.reason !== null && input.reason !== undefined && !words(input.reason)) problems.push({ path: 'body/reason', message: `The reason is 1 to ${REASON_MAX} characters.` })
  if (input.kind === 'OTHER' && !words(input.reason)) problems.push({ path: 'body/reason', message: 'Say what the charge is for.' })
  if (input.kind === 'FEE') {
    const operation = facts.operations.find((row) => row.id === input.subcontractOperationId)
    if (!operation) problems.push({ path: 'body/subcontractOperationId', message: 'A fee names the operation of this order whose pieces it pays.' })
    else if (!quantity.isInteger()) problems.push({ path: 'body/quantity', message: 'A fee pays whole pieces.' })
    else if (quantity.greaterThan(operation.bookable)) {
      problems.push({ path: 'body/quantity', message: `Line ${operation.seq} has ${operation.bookable} piece(s) back good whose fee is not booked yet (pieces waiting for inspection are not).` })
    }
  } else if (input.subcontractOperationId !== null && input.subcontractOperationId !== undefined) {
    problems.push({ path: 'body/subcontractOperationId', message: `A ${costKindWords(input.kind)} names no operation (only a fee does).` })
  }
  return problems
}

/** Why the entry may not be taken back. */
export function reverseProblems(entry: EntryFacts | null, reversed: ReadonlySet<string>, reason: string): Issue[] {
  if (!entry) return [{ path: 'params/entryId', message: 'Not a cost entry of this order.' }]
  if (entry.reversalOfId !== null) return [{ path: 'params/entryId', message: 'This entry takes another back: it is not taken back in turn (book the cost again).' }]
  if (reversed.has(entry.id)) return [{ path: 'params/entryId', message: 'This entry was taken back already.' }]
  return words(reason) ? [] : [{ path: 'body/reason', message: `Say why it is taken back (1 to ${REASON_MAX} characters).` }]
}

export interface BridgeEntry {
  readonly kind: CostKind
  readonly amount: number
}

/** The cost bridge's sums per kind (minor units, taken back ones netted) and the order's whole cost with the earned fee. */
export function bridgeOf(earnedFee: number, entries: readonly BridgeEntry[]): { readonly earnedFee: number; readonly fee: number; readonly transport: number; readonly material: number; readonly other: number; readonly sum: number } {
  const of = (kind: CostKind) => entries.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.amount, 0)
  const fee = of('FEE')
  const transport = of('TRANSPORT')
  const material = of('MATERIAL')
  const other = of('OTHER')
  return { earnedFee, fee, transport, material, other, sum: earnedFee + fee + transport + material + other }
}

/** The pieces of a FEE entry in its words (a whole number). */
export const piecesText = (quantity: string): string => new Dec(decimalOf(quantity).toFixed(0)).toFixed(0)
