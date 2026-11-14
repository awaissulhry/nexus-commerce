import { minorPlaces, toMinorUnits } from '../../core/money'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * A subcontractor's invoice matched to the operations done and the quantities returned (B-W2b-403; FIN-138; follow-up
 * PQ1:03 "a subcontractor invoice line is matched to its cost entries (a FEE entry)"; B-W2b-331's cost: the workshop's fee
 * is on the work order already, by W2a's earned fee at the order's price for the pieces back good, or by a FEE entry at
 * another price), pure. Per invoice line mapped to a subcontract order:
 *
 *   returned   per operation of the order: pieces sent, back good, defective, scrapped, good ones still waiting for their
 *              incoming inspection (they earn nothing yet); owed = back good − waiting
 *   invoiced   the line's pieces and its effective price (net ÷ pieces); with what the workshop's other live invoices bill
 *              on the order (credit notes take off)
 *   cost       what the work order holds for the order: W2a's earned fee at the order's price for the pieces no FEE entry
 *              books, the FEE entries (pieces at their own price) and the charges (transport, material, other)
 *   verdict    MORE_THAN_RETURNED  the workshop bills more pieces than came back good (the rest are not owed yet)
 *              BOOK_FEE            the price differs from the order's and the FEE entries at the invoiced price do not cover the
 *                                  pieces billed: book them at the invoiced price (the suggestion, per operation, never more than
 *                                  can be booked), so the work order carries what we pay
 *              MATCHED             the pieces are owed and the cost entries carry them at the invoiced price (the order's
 *                                  price through the earned fee, or FEE entries at the invoice's)
 *              NO_QUANTITY         the line names no pieces: it is read against the order as a whole (W2a's match)
 * The cost entries are never written here: a FEE entry is purchasing's command (POST …/costs), asked from the match by a
 * person who may book workshop charges.
 */

export const SUBCONTRACT_VERDICTS = ['MATCHED', 'BOOK_FEE', 'MORE_THAN_RETURNED', 'NO_QUANTITY'] as const
export type SubcontractVerdict = (typeof SUBCONTRACT_VERDICTS)[number]

export interface OperationFacts {
  readonly id: string
  readonly seq: number
  /** Decimal string, the order's currency, major units. */
  readonly pricePerPiece: string
  readonly pieces: number
  readonly piecesBackGood: number
  readonly piecesDefective: number
  readonly piecesScrapped: number
  /** Good pieces of receipts still waiting for their incoming inspection. */
  readonly waiting: number
  /** Pieces a live FEE entry books. */
  readonly bookedByFee: number
  /** Pieces a FEE entry may still book (back good − waiting − booked). */
  readonly bookable: number
  /** W2a's earned fee for the pieces no FEE entry books, minor units. */
  readonly earned: number
}

export interface CostEntryFacts {
  readonly id: string
  readonly kind: 'FEE' | 'TRANSPORT' | 'MATERIAL' | 'OTHER'
  readonly subcontractOperationId: string | null
  readonly quantity: string
  readonly unitPrice: string
  /** Minor units (a reversal's negative). */
  readonly amount: number
  readonly reversalOfId: string | null
}

export interface SubcontractLineFacts {
  /** The line's pieces; null: none named. */
  readonly invoicedPieces: DecimalInput | null
  /** The line's net, minor units of the invoice's currency (the order's). */
  readonly net: number
  readonly currency: string
  /** Pieces the workshop's other live invoices bill on the order. */
  readonly billedElsewhere: DecimalInput
  readonly operations: readonly OperationFacts[]
  readonly entries: readonly CostEntryFacts[]
}

export interface FeeSuggestion {
  readonly subcontractOperationId: string
  readonly seq: number
  readonly quantity: number
  /** The invoiced price, six places. */
  readonly unitPrice: string
}

export interface SubcontractLineMatch {
  readonly verdict: SubcontractVerdict
  readonly invoicedPieces: string | null
  readonly invoicedTotal: string | null
  readonly invoicedUnitPrice: string | null
  /** The order's fee per piece, weighted by the pieces of its operations. */
  readonly orderUnitPrice: string
  readonly price: 'SAME' | 'HIGHER' | 'LOWER' | null
  readonly piecesOwed: number
  readonly piecesWaiting: number
  readonly piecesDefective: number
  readonly piecesScrapped: number
  /** Pieces carried at the invoiced price: FEE entries at that price, and the earned fee when it is the order's price. */
  readonly piecesAtInvoicedPrice: number
  /** The cost the work order holds for the order, minor units: earned fee + FEE entries + charges. */
  readonly cost: { readonly earnedFee: number; readonly fees: number; readonly charges: number; readonly total: number }
  /** The live FEE entries at the invoiced price (the line's cost entries). */
  readonly matchedEntryIds: readonly string[]
  readonly suggestions: readonly FeeSuggestion[]
}

const d = (value: DecimalInput): Decimal => new Dec(value.toString())
const p6 = (value: Decimal): string => value.toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)
/** Pieces are whole: a decimal count as an integer (rounded half up, as a FEE entry's pieces are read). */
const wholePieces = (value: Decimal): number => Number.parseInt(value.toFixed(0, Dec.ROUND_HALF_UP), 10)

/** The entries that stand: neither a reversal nor taken back by one. */
export function liveEntries(entries: readonly CostEntryFacts[]): CostEntryFacts[] {
  const reversed = new Set(entries.flatMap((entry) => (entry.reversalOfId ? [entry.reversalOfId] : [])))
  return entries.filter((entry) => entry.reversalOfId === null && !reversed.has(entry.id))
}

/** Two prices the same to one minor unit per piece (a supplier rounds its unit price on the XML). */
function samePrice(a: Decimal, b: Decimal, currency: string): boolean {
  const unit = new Dec(1).dividedBy(new Dec(10).pow(minorPlaces(currency)))
  return a.minus(b).abs().lessThanOrEqualTo(unit)
}

/** The line's match (see the module comment). */
export function subcontractLineMatch(facts: SubcontractLineFacts): SubcontractLineMatch {
  const live = liveEntries(facts.entries)
  const fees = live.filter((entry) => entry.kind === 'FEE')
  const charges = live.filter((entry) => entry.kind !== 'FEE')
  const earnedFee = facts.operations.reduce((sum, operation) => sum + operation.earned, 0)
  const feeAmount = fees.reduce((sum, entry) => sum + entry.amount, 0)
  const chargeAmount = charges.reduce((sum, entry) => sum + entry.amount, 0)
  const cost = { earnedFee, fees: feeAmount, charges: chargeAmount, total: earnedFee + feeAmount + chargeAmount }
  const piecesOwed = facts.operations.reduce((sum, operation) => sum + Math.max(0, operation.piecesBackGood - operation.waiting), 0)
  const piecesWaiting = facts.operations.reduce((sum, operation) => sum + operation.waiting, 0)
  const piecesDefective = facts.operations.reduce((sum, operation) => sum + operation.piecesDefective, 0)
  const piecesScrapped = facts.operations.reduce((sum, operation) => sum + operation.piecesScrapped, 0)
  const orderedPieces = facts.operations.reduce((sum, operation) => sum + operation.pieces, 0)
  const orderValue = facts.operations.reduce<Decimal>((sum, operation) => sum.plus(d(operation.pricePerPiece).times(operation.pieces)), ZERO)
  const orderUnitPrice = orderedPieces > 0 ? orderValue.dividedBy(orderedPieces) : ZERO
  const base = { orderUnitPrice: p6(orderUnitPrice), piecesOwed, piecesWaiting, piecesDefective, piecesScrapped, cost }
  if (facts.invoicedPieces === null || !d(facts.invoicedPieces).greaterThan(0)) {
    return { ...base, verdict: 'NO_QUANTITY', invoicedPieces: null, invoicedTotal: null, invoicedUnitPrice: null, price: null, piecesAtInvoicedPrice: 0, matchedEntryIds: [], suggestions: [] }
  }
  const pieces = d(facts.invoicedPieces)
  const total = pieces.plus(Dec.max(ZERO, d(facts.billedElsewhere)))
  const unitPrice = new Dec(facts.net).dividedBy(new Dec(10).pow(minorPlaces(facts.currency))).dividedBy(pieces)
  const price: 'SAME' | 'HIGHER' | 'LOWER' = samePrice(unitPrice, orderUnitPrice, facts.currency) ? 'SAME' : unitPrice.greaterThan(orderUnitPrice) ? 'HIGHER' : 'LOWER'
  const atPrice = fees.filter((entry) => samePrice(d(entry.unitPrice), unitPrice, facts.currency))
  const earnedPieces = facts.operations.reduce((sum, operation) => sum + Math.max(0, operation.piecesBackGood - operation.waiting - operation.bookedByFee), 0)
  const feePiecesAtPrice = atPrice.reduce<Decimal>((sum, entry) => sum.plus(d(entry.quantity)), ZERO)
  const piecesAtInvoicedPrice = feePiecesAtPrice.plus(price === 'SAME' ? earnedPieces : 0)
  const head = { ...base, invoicedPieces: pieces.toFixed(4), invoicedTotal: total.toFixed(4), invoicedUnitPrice: p6(unitPrice), price, piecesAtInvoicedPrice: wholePieces(piecesAtInvoicedPrice), matchedEntryIds: atPrice.map((entry) => entry.id) }
  if (total.greaterThan(piecesOwed)) return { ...head, verdict: 'MORE_THAN_RETURNED', suggestions: [] }
  const missing = pieces.minus(piecesAtInvoicedPrice)
  if (!missing.greaterThan(0)) return { ...head, verdict: 'MATCHED', suggestions: [] }
  // Book the missing pieces at the invoiced price, operation by operation, never more than each may still book.
  let left = wholePieces(missing.toDecimalPlaces(0, Dec.ROUND_CEIL))
  const suggestions: FeeSuggestion[] = []
  for (const operation of [...facts.operations].sort((a, b) => a.seq - b.seq)) {
    if (left <= 0) break
    const take = Math.min(left, operation.bookable)
    if (take > 0) suggestions.push({ subcontractOperationId: operation.id, seq: operation.seq, quantity: take, unitPrice: p6(unitPrice) })
    left -= take
  }
  return { ...head, verdict: 'BOOK_FEE', suggestions }
}

/** The fee a suggestion books, minor units (as the cost entry rounds it: quantity × price once). */
export const suggestionAmount = (suggestion: FeeSuggestion, currency: string): number => toMinorUnits(new Dec(suggestion.unitPrice).times(suggestion.quantity).toDecimalPlaces(minorPlaces(currency), Dec.ROUND_HALF_UP), currency)

/** The verdict in words (it/en); `prices`: the reader holds the cost grain. */
export function subcontractMatchWords(match: SubcontractLineMatch, options: { readonly prices: boolean }): { readonly en: string; readonly it: string } {
  const owed = { en: `${match.piecesOwed} pieces back good${match.piecesWaiting > 0 ? ` (${match.piecesWaiting} more wait for inspection)` : ''}`, it: `${match.piecesOwed} pezzi rientrati buoni${match.piecesWaiting > 0 ? ` (altri ${match.piecesWaiting} attendono il controllo)` : ''}` }
  switch (match.verdict) {
    case 'NO_QUANTITY':
      return { en: `The line names no pieces: it is checked against the order as a whole; ${owed.en}.`, it: `La riga non indica i pezzi: si controlla sull'ordine intero; ${owed.it}.` }
    case 'MORE_THAN_RETURNED':
      return { en: `Billed ${trim(match.invoicedTotal!)} pieces in all, ${owed.en}: the rest is not owed yet.`, it: `Fatturati ${trim(match.invoicedTotal!)} pezzi in tutto, ${owed.it}: il resto non è ancora dovuto.` }
    case 'BOOK_FEE': {
      const pieces = match.suggestions.reduce((sum, suggestion) => sum + suggestion.quantity, 0)
      const at = options.prices ? ` at ${match.invoicedUnitPrice}` : ''
      const atIt = options.prices ? ` a ${match.invoicedUnitPrice}` : ''
      if (pieces === 0) return { en: `The price differs from the order's and no piece can be booked${at} any more: take back the FEE entries at another price first.`, it: `Il prezzo è diverso da quello dell'ordine e nessun pezzo si può più registrare${atIt}: storna prima le voci FEE a un altro prezzo.` }
      return { en: `The price differs from the order's: book ${pieces} pieces${at} on the work order so its cost carries what is paid (${owed.en}).`, it: `Il prezzo è diverso da quello dell'ordine: registra ${pieces} pezzi${atIt} sull'ordine di lavoro perché il suo costo porti quanto si paga (${owed.it}).` }
    }
    default:
      return { en: `Matched: ${trim(match.invoicedPieces!)} pieces billed, ${owed.en}, carried on the work order at the invoiced price.`, it: `Corrisponde: ${trim(match.invoicedPieces!)} pezzi fatturati, ${owed.it}, portati sull'ordine di lavoro al prezzo fatturato.` }
  }
}

const trim = (value: string): string => new Dec(value).toString()
