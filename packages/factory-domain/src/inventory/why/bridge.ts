import type { BusinessDate } from '../../core/time'
import { UNITS, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { REASON_SIDES, STOCK_MOVE_REASONS, quantityText, type StockMoveReason } from '../ledger/moves'
import { numberText, type Language } from '../rolls/rolls'

/**
 * "Why is it 84.20 m²?" — the balance bridge of one stock figure (B-W2b-314; SCM-191; design warehouse.stock st-why,
 * warehouse.moves mv-why "BalanceBridge: start → each reason → on hand"), pure.
 *
 * A stock key (a site's stock of an item, narrowed by colour, lot, hide and location) over a period of posting days: the
 * balance at the start of the first day, then one step per reason of move with what it brought in and took out, then the
 * balance at the end of the last day. The steps add up to the end balance (they always should: the end is read apart from
 * the steps, so a gap is a bug, and the answer says so in words). Each step names its reason's moves (the caller gives it
 * the link to them, and the move itself when it is the only one).
 *
 * The order is the formula's: receipts + returns − issues − scrap ± adjustments ± counts ± transfers (the design's words),
 * every reason of the ledger in it, so no reason a later wave adds can leave a gap where there is none.
 */

/** Every reason, in the bridge's order; a test keeps it complete. */
export const BRIDGE_ORDER: readonly StockMoveReason[] = Object.freeze([
  'OPENING',
  'RECEIPT',
  'PRODUCTION_RECEIPT',
  'RETURN',
  'REMNANT',
  'CUSTOMER_RETURN',
  'ISSUE',
  'SHIPMENT',
  'SUPPLIER_RETURN',
  'SCRAP',
  'ADJUSTMENT',
  'COUNT',
  'TRANSFER',
  'TRANSFER_OUT',
  'TRANSFER_IN',
] satisfies StockMoveReason[])

if (BRIDGE_ORDER.length !== STOCK_MOVE_REASONS.length || STOCK_MOVE_REASONS.some((reason) => !BRIDGE_ORDER.includes(reason))) {
  throw new Error('BRIDGE_ORDER must list every stock move reason once')
}

/** A reason's sign in the formula: + brings stock in, − takes it out, ± either (a correction, a transfer at a location). */
export type BridgeSign = '+' | '−' | '±'
export const signOf = (reason: StockMoveReason): BridgeSign => {
  const sides = REASON_SIDES[reason]
  return sides === 'IN' ? '+' : sides === 'OUT' ? '−' : '±'
}

/** The reasons in words (the web's stock.json `reason` carries the same; the sentence below uses these). */
export const REASON_WORDS: Readonly<Record<StockMoveReason, Readonly<Record<Language, string>>>> = Object.freeze({
  OPENING: { en: 'opening stock', it: 'giacenza iniziale' },
  RECEIPT: { en: 'receipts', it: 'ricevimenti' },
  PRODUCTION_RECEIPT: { en: 'finished goods', it: 'carichi di prodotto finito' },
  RETURN: { en: 'returns from work orders', it: 'resi da ordini' },
  REMNANT: { en: 'offcuts', it: 'ritagli' },
  CUSTOMER_RETURN: { en: 'customer returns', it: 'resi da clienti' },
  ISSUE: { en: 'issues', it: 'prelievi' },
  SHIPMENT: { en: 'shipments', it: 'spedizioni' },
  SUPPLIER_RETURN: { en: 'returns to suppliers', it: 'resi a fornitori' },
  SCRAP: { en: 'scrap', it: 'scarti' },
  ADJUSTMENT: { en: 'adjustments', it: 'rettifiche' },
  COUNT: { en: 'count differences', it: 'differenze inventario' },
  TRANSFER: { en: 'transfers', it: 'trasferimenti' },
  TRANSFER_OUT: { en: 'sent to another site', it: 'inviati ad altro stabilimento' },
  TRANSFER_IN: { en: 'received from another site', it: 'ricevuti da altro stabilimento' },
})

/** One reason's moves in the period, as the ledger sums them for the key (base unit). */
export interface ReasonSum {
  readonly reason: StockMoveReason
  /** What its moves brought into the key's location(s). */
  readonly in: DecimalInput
  /** What they took out of them. */
  readonly out: DecimalInput
  /** How many moves. */
  readonly moves: number
}

export interface BridgeStep {
  readonly reason: StockMoveReason
  readonly sign: BridgeSign
  readonly in: string
  readonly out: string
  readonly net: string
  readonly moves: number
  /** The balance before and after this step (the chart's bar from → to). */
  readonly before: string
  readonly after: string
}

export interface Bridge {
  readonly start: string
  readonly steps: readonly BridgeStep[]
  /** start + every step. */
  readonly sum: string
  /** The end balance as read apart from the steps. */
  readonly end: string
  readonly addsUp: boolean
  /** end − sum (0 when it adds up). */
  readonly gap: string
  readonly moves: number
}

/** The bridge from the start balance through each reason (in BRIDGE_ORDER; reasons without moves left out) to the end. */
export function bridgeOf(input: { readonly start: DecimalInput; readonly sums: readonly ReasonSum[]; readonly end: DecimalInput }): Bridge {
  const start = new Dec(input.start.toString())
  let running: Decimal = start
  let moves = 0
  const steps: BridgeStep[] = []
  for (const reason of BRIDGE_ORDER) {
    const rows = input.sums.filter((row) => row.reason === reason && row.moves > 0)
    if (rows.length === 0) continue
    const into = rows.reduce<Decimal>((total, row) => total.plus(row.in.toString()), ZERO)
    const out = rows.reduce<Decimal>((total, row) => total.plus(row.out.toString()), ZERO)
    const count = rows.reduce((total, row) => total + row.moves, 0)
    const net = into.minus(out)
    const before = running
    running = running.plus(net)
    moves += count
    steps.push({ reason, sign: signOf(reason), in: quantityText(into), out: quantityText(out), net: quantityText(net), moves: count, before: quantityText(before), after: quantityText(running) })
  }
  const end = new Dec(input.end.toString())
  const gap = end.minus(running)
  return { start: quantityText(start), steps, sum: quantityText(running), end: quantityText(end), addsUp: gap.isZero(), gap: quantityText(gap), moves }
}

const amountWords = (value: DecimalInput, uom: Uom, language: Language) => `${numberText(value, language)} ${UNITS[uom].symbol}`

const MONTHS: Readonly<Record<Language, readonly string[]>> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
}
/** "1 Oct 2026" (it "1 ott 2026"). */
export const dayText = (day: BusinessDate, language: Language): string => `${Number(day.slice(8, 10))} ${MONTHS[language][Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`

/**
 * The bridge in one sentence: "80 m² on 1 Oct 2026 + 10 m² receipts − 5.8 m² issues = 84.2 m² on 12 Nov 2026 ✓" (it
 * "80 m² al 1 Oct 2026 …"), or the gap: "… does not add up by 0.2 m²: reported". Numbers to two decimals, as the screens
 * write them; the steps carry all four.
 */
export function bridgeWords(bridge: Bridge, period: { readonly from: BusinessDate | null; readonly to: BusinessDate }, uom: Uom, language: Language): string {
  const at = language === 'it' ? 'al' : 'on'
  const startLabel = period.from === null ? (language === 'it' ? 'all\'inizio' : 'at the start') : `${at} ${dayText(period.from, language)}`
  const parts = [`${amountWords(bridge.start, uom, language)} ${startLabel}`]
  for (const step of bridge.steps) {
    const net = new Dec(step.net)
    const sign = net.isNegative() ? '−' : '+'
    parts.push(`${sign} ${amountWords(net.abs(), uom, language)} ${REASON_WORDS[step.reason][language]}`)
  }
  const end = `${amountWords(bridge.end, uom, language)} ${at} ${dayText(period.to, language)}`
  if (bridge.addsUp) return `${parts.join(' ')} = ${end} ✓`
  const gap = amountWords(new Dec(bridge.gap).abs(), uom, language)
  return language === 'it' ? `${parts.join(' ')} non fa ${end}: manca ${gap} (segnalato)` : `${parts.join(' ')} does not add up to ${end} by ${gap}: reported`
}

/** The formula in words, the same for every figure (the popover's first line). */
export const FORMULA_WORDS: Readonly<Record<Language, string>> = Object.freeze({
  en: 'receipts + returns − issues − scrap ± adjustments ± counts ± transfers',
  it: 'ricevimenti + resi − prelievi − scarti ± rettifiche ± inventari ± trasferimenti',
})
