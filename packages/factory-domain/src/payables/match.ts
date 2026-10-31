import { minorPlaces, toMinorUnits } from '../core/money'
import { Dec, type Decimal } from '../tax/decimal'

/**
 * The three-way match (B-W2a-62; FIN-137; SCM-130, SCM-131, SCM-133; design finance.payables, record tab Match
 * "Ordered, received, invoiced": "We pay only for what we ordered at the agreed price and what really arrived.
 * Differences go to the buyer before payment."). Pure: the API reads the facts and writes one SupplierInvoiceMatch row
 * per mapped goods or subcontract line.
 *
 * Per line mapped to a purchase order line (GOODS):
 *   ordered      the order line's quantity and unit price (per the order line's unit)
 *   received     what POSTED receipts brought against the order line (the receipt lines' quantity, the order line's unit)
 *   billed       what the supplier's OTHER live invoices already bill on the order line (their credit notes take off)
 *   available    received − billed: what this invoice may still bill
 *   invoiced     the line's quantity (read in the order line's unit), at its effective unit price (net ÷ quantity)
 * Per line mapped to a subcontract order (SUBCONTRACT, terzista): pieces instead, received = the pieces back GOOD (the
 * fee is owed on those, B-W2a-25), the price = the order's fee per piece (weighted when it has several operations).
 *
 * The verdict (each within its tolerance, percent):
 *   quantity  invoiced ≤ available × (1 + quantity tolerance)
 *   price     net ≤ invoiced × ordered price × (1 + price tolerance), one minor unit of rounding allowed
 * An invoice that asks LESS (fewer units, a lower price) is within; the words still say how it differs. Outside the
 * quantity tolerance while the order line still waits for goods (received below ordered, the line not ended) and the
 * invoice bills no more than was ordered: WAITING (the goods invoiced have not all arrived yet).
 * differenceAmount = net − the value of what was received for it at the order's price: what the invoice asks beyond (or
 * below) what we owe.
 *
 * The billing basis (SCM-131: bill on received or on ordered) and the tolerances are settings the accountant and the
 * buyer agree: B-W2b-21 reads them from the company's payables settings (./settings matchSettingsOf); with none set,
 * MATCH_SETTINGS says what applies and that it is not decided: received, and an exact match. An order line that names its
 * own area tolerance (leather, PurchaseOrderLine.areaTolerancePct) brings it for the quantity: that was agreed with the
 * supplier on the order. A difference up to the settings' amount tolerance (minor units) is within whatever the
 * percentages say (rounding on a long invoice).
 */

export const MATCH_BASES = ['RECEIVED', 'ORDERED'] as const
export type MatchBasis = (typeof MATCH_BASES)[number]

export interface MatchSettings {
  readonly basis: MatchBasis
  readonly quantityTolerancePct: string
  readonly priceTolerancePct: string
  /** False until the accountant and the buyer agree the figures (the payables settings hold them). */
  readonly decided: boolean
  /** B-W2b-21: a difference (what the line asks beyond what is owed) up to this many minor units is within; 0 or absent: none. */
  readonly differenceToleranceAmount?: number | undefined
  readonly words: { readonly en: string; readonly it: string }
}

export const MATCH_SETTINGS: MatchSettings = Object.freeze({
  basis: 'RECEIVED',
  quantityTolerancePct: '0',
  priceTolerancePct: '0',
  decided: false,
  words: Object.freeze({
    en: 'Not agreed with the accountant yet: an invoice is paid on what was received, at the price ordered, with no tolerance (an order line that names an area tolerance keeps it for the quantity).',
    it: "Non ancora concordato con il commercialista: si paga quanto ricevuto, al prezzo d'ordine, senza tolleranza (una riga d'ordine con una tolleranza sulla superficie la mantiene per la quantità).",
  }),
})

export interface GoodsFacts {
  readonly kind: 'GOODS'
  readonly orderedQuantity: string
  readonly orderedUnitPrice: string
  readonly orderUom: string
  readonly received: string
  /** What the supplier's other live invoices bill on the order line (credit notes subtracted). */
  readonly billedElsewhere: string
  /** The order line no longer expects goods (cancelled, closed short, or the order closed or cancelled). */
  readonly ended: boolean
  /** The order line's own quantity tolerance (an agreed area tolerance), percent; null: the settings'. */
  readonly lineTolerancePct: string | null
}

export interface SubcontractFacts {
  readonly kind: 'SUBCONTRACT'
  readonly orderedPieces: number
  readonly piecesBackGood: number
  /** Σ pieces × fee per piece, as a decimal in major units (the order's agreed value of all its pieces). */
  readonly orderedValue: string
  /** Σ pieces back good × their fee, decimal in major units. */
  readonly goodValue: string
  readonly billedElsewhere: string
  readonly ended: boolean
}

export interface InvoicedLine {
  readonly quantity: string | null
  readonly uom: string | null
  readonly netAmount: number
}

export type MatchVerdict = 'WITHIN' | 'DIFFERENCE' | 'WAITING'

export interface LineMatch {
  readonly invoicedQuantity: string
  readonly receivedQuantity: string
  readonly orderedQuantity: string
  readonly orderedUnitPrice: string
  readonly invoicedUnitPrice: string
  readonly differenceAmount: number
  readonly quantityTolerancePct: string
  readonly priceTolerancePct: string
  readonly withinTolerance: boolean
  readonly verdict: MatchVerdict
  /** How it differs, per part. */
  readonly quantity: 'SAME' | 'MORE' | 'LESS'
  readonly price: 'SAME' | 'HIGHER' | 'LOWER'
  /** The invoice's unit is not the order line's (the quantity is read as the order line's unit). */
  readonly unitDiffers: boolean
}

const dec = (value: string | number): Decimal => new Dec(value)
const q4 = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
const p6 = (value: Decimal): string => value.toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)
const pct = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
const clampPct = (value: Decimal): Decimal => Dec.max(0, Dec.min(100, value))

/** The order's units are codes (FT2, M2, PCS); a supplier writes MQ, m², PZ, NR … — the same unit only when equal once tidied. */
const UNIT_SYNONYMS: Readonly<Record<string, string>> = Object.freeze({ MQ: 'M2', 'M²': 'M2', MT: 'M', MTR: 'M', PZ: 'PCS', NR: 'PCS', N: 'PCS', PEZZI: 'PCS', PC: 'PCS', PCE: 'PCS', SQFT: 'FT2', 'FT²': 'FT2', PQ: 'FT2', KGM: 'KG' })
export function sameUnit(invoiced: string | null, ordered: string): boolean {
  if (invoiced === null) return true
  const tidy = (value: string) => {
    const code = value.replace(/[\s.]/g, '').toUpperCase()
    return UNIT_SYNONYMS[code] ?? code
  }
  return tidy(invoiced) === tidy(ordered)
}

/** The minor units of a decimal value in major units. */
const minorOf = (value: Decimal, currency: string): number => toMinorUnits(value.toDecimalPlaces(minorPlaces(currency), Dec.ROUND_HALF_UP), currency)

/** One mapped line against its order and what arrived. */
export function matchLine(line: InvoicedLine, facts: GoodsFacts | SubcontractFacts, currency: string, settings: MatchSettings = MATCH_SETTINGS): LineMatch {
  const goods = facts.kind === 'GOODS'
  const ordered = goods ? dec(facts.orderedQuantity) : dec(facts.orderedPieces)
  const received = goods ? dec(facts.received) : dec(facts.piecesBackGood)
  const orderedPrice = goods ? dec(facts.orderedUnitPrice) : facts.orderedPieces > 0 ? dec(facts.orderedValue).dividedBy(facts.orderedPieces) : dec(0)
  const billed = dec(facts.billedElsewhere)
  const basisQuantity = settings.basis === 'ORDERED' ? ordered : received
  const available = Dec.max(0, basisQuantity.minus(billed))
  const invoiced = line.quantity !== null ? dec(line.quantity) : available
  const net = dec(line.netAmount)
  const invoicedPrice = invoiced.greaterThan(0) ? Dec.max(0, net.dividedBy(dec(10).pow(minorPlaces(currency))).dividedBy(invoiced)) : dec(0)
  const quantityTolerance = clampPct(dec(goods && facts.lineTolerancePct !== null ? facts.lineTolerancePct : settings.quantityTolerancePct))
  const priceTolerance = clampPct(dec(settings.priceTolerancePct))

  const quantityOk = invoiced.lessThanOrEqualTo(available.times(dec(1).plus(quantityTolerance.dividedBy(100))))
  const allowedNet = minorOf(invoiced.times(orderedPrice).times(dec(1).plus(priceTolerance.dividedBy(100))), currency)
  const priceOk = line.netAmount <= allowedNet + 1
  const atOrderPrice = minorOf(invoiced.times(orderedPrice), currency)
  // What we owe for it: the part of it that arrived (and is not billed elsewhere), at the order's price. A subcontract
  // order owes the fee of the pieces back good.
  const owed = goods
    ? minorOf(Dec.min(invoiced, available).times(orderedPrice), currency)
    : facts.piecesBackGood > 0
      ? minorOf(dec(facts.goodValue).dividedBy(facts.piecesBackGood).times(Dec.min(invoiced, available)), currency)
      : 0
  const differenceAmount = line.netAmount - owed
  const amountTolerance = Math.max(0, settings.differenceToleranceAmount ?? 0)
  const within = (quantityOk && priceOk) || (amountTolerance > 0 && differenceAmount <= amountTolerance)
  const stillComing = !facts.ended && received.lessThan(ordered) && invoiced.lessThanOrEqualTo(Dec.max(0, ordered.minus(billed)).times(dec(1).plus(quantityTolerance.dividedBy(100))))
  return {
    invoicedQuantity: q4(invoiced),
    receivedQuantity: q4(available),
    orderedQuantity: q4(ordered),
    orderedUnitPrice: p6(orderedPrice),
    invoicedUnitPrice: p6(invoicedPrice),
    differenceAmount,
    quantityTolerancePct: pct(quantityTolerance),
    priceTolerancePct: pct(priceTolerance),
    withinTolerance: within,
    verdict: within ? 'WITHIN' : !quantityOk && priceOk && stillComing ? 'WAITING' : 'DIFFERENCE',
    quantity: invoiced.equals(available) ? 'SAME' : invoiced.greaterThan(available) ? 'MORE' : 'LESS',
    price: Math.abs(line.netAmount - atOrderPrice) <= 1 ? 'SAME' : line.netAmount > atOrderPrice ? 'HIGHER' : 'LOWER',
    unitDiffers: goods ? !sameUnit(line.uom, facts.orderUom) : false,
  }
}

export const MATCH_STATUSES = ['PENDING', 'MATCHED', 'DIFFERENCES', 'NO_PO', 'WAITING_GOODS'] as const
export type MatchStatus = (typeof MATCH_STATUSES)[number]

export const LINE_KINDS = ['GOODS', 'SUBCONTRACT', 'SERVICE', 'CHARGE'] as const
export type LineKind = (typeof LINE_KINDS)[number]

export interface LineState {
  readonly kind: LineKind
  readonly mapped: boolean
}

export interface MatchRowState {
  readonly withinTolerance: boolean
  readonly verdict: MatchVerdict
  readonly accepted: boolean
}

/**
 * The invoice's match (the grid's "match" column): PENDING while a goods or subcontract line is not mapped to an order
 * (the office maps it, or marks it a service: an invoice without PO); NO_PO when no line is on an order (a service, a
 * utility) or for a credit note (it is not matched against receipts: it takes off what its order lines' invoices bill);
 * WAITING_GOODS while an unaccepted line waits for its goods; DIFFERENCES when any line is outside the tolerance (accepted
 * or not); MATCHED when every mapped line is within it.
 */
export function matchStatusOf(kind: 'INVOICE' | 'CREDIT_NOTE', lines: readonly LineState[], rows: readonly MatchRowState[]): MatchStatus {
  if (lines.some((line) => (line.kind === 'GOODS' || line.kind === 'SUBCONTRACT') && !line.mapped)) return kind === 'CREDIT_NOTE' ? 'NO_PO' : 'PENDING'
  if (kind === 'CREDIT_NOTE' || rows.length === 0) return 'NO_PO'
  if (rows.some((row) => row.verdict === 'WAITING' && !row.accepted)) return 'WAITING_GOODS'
  if (rows.some((row) => !row.withinTolerance)) return 'DIFFERENCES'
  return 'MATCHED'
}

/** A match whose facts are the same as an accepted one keeps the acceptance when the match is redone. */
export function sameFacts(
  a: Pick<LineMatch, 'invoicedQuantity' | 'receivedQuantity' | 'orderedUnitPrice' | 'invoicedUnitPrice' | 'differenceAmount' | 'withinTolerance'>,
  b: Pick<LineMatch, 'invoicedQuantity' | 'receivedQuantity' | 'orderedUnitPrice' | 'invoicedUnitPrice' | 'differenceAmount' | 'withinTolerance'>,
): boolean {
  return (
    dec(a.invoicedQuantity).equals(dec(b.invoicedQuantity)) &&
    dec(a.receivedQuantity).equals(dec(b.receivedQuantity)) &&
    dec(a.orderedUnitPrice).equals(dec(b.orderedUnitPrice)) &&
    dec(a.invoicedUnitPrice).equals(dec(b.invoicedUnitPrice)) &&
    a.differenceAmount === b.differenceAmount &&
    a.withinTolerance === b.withinTolerance
  )
}

/** The result in words, as the Match tab shows it ("Matched · Price differs +0.20/FT2 · Quantity differs −12 FT2"). */
export function matchWords(row: Pick<LineMatch, 'invoicedQuantity' | 'receivedQuantity' | 'orderedUnitPrice' | 'invoicedUnitPrice' | 'withinTolerance' | 'verdict' | 'quantity' | 'price' | 'unitDiffers'>, unit: string, options: { readonly prices: boolean }): { en: string; it: string } {
  const en: string[] = []
  const it: string[] = []
  const quantityDiff = dec(row.invoicedQuantity).minus(dec(row.receivedQuantity))
  const priceDiff = dec(row.invoicedUnitPrice).minus(dec(row.orderedUnitPrice))
  const signed = (value: Decimal, places: number) => `${value.isNegative() ? '−' : '+'}${value.abs().toDecimalPlaces(places, Dec.ROUND_HALF_UP).toFixed(places)}`
  if (row.verdict === 'WAITING') {
    en.push(`Waiting for goods: ${row.receivedQuantity} ${unit} received and not billed yet`)
    it.push(`In attesa della merce: ${row.receivedQuantity} ${unit} ricevuti e non ancora fatturati`)
  } else if (row.quantity !== 'SAME') {
    en.push(`Quantity differs ${signed(quantityDiff, 4)} ${unit}`)
    it.push(`Quantità diversa ${signed(quantityDiff, 4)} ${unit}`)
  }
  if (row.price !== 'SAME') {
    en.push(options.prices ? `Price differs ${signed(priceDiff, 6)}/${unit}` : row.price === 'HIGHER' ? 'Price above the order’s' : 'Price below the order’s')
    it.push(options.prices ? `Prezzo diverso ${signed(priceDiff, 6)}/${unit}` : row.price === 'HIGHER' ? "Prezzo sopra quello d'ordine" : "Prezzo sotto quello d'ordine")
  }
  if (row.unitDiffers) {
    en.push(`the invoice's unit is read as ${unit}`)
    it.push(`l'unità della fattura è letta come ${unit}`)
  }
  if (en.length === 0) return { en: 'Matched', it: 'Corrisponde' }
  const head = row.withinTolerance ? { en: 'Within the tolerance', it: 'Entro la tolleranza' } : null
  return { en: [head?.en, ...en].filter(Boolean).join(' · '), it: [head?.it, ...it].filter(Boolean).join(' · ') }
}
