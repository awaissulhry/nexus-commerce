import type { BusinessDate } from '../core/time'
import { decimalOf, decimalText, dimensionOf, UNITS, type DecimalInput, type Uom } from '../product/units/units'
import type { OrderBy, Suggestion } from './buy'

/**
 * "Why this number" (design 02 "What to buy & make": the Why cell, the Why drawer and its Bridge; PLN-064), pure. Every
 * shortage is said as a sentence and as a ladder of numbers anyone can follow to each lot, order and purchase line.
 * Never money: the sentence and the Bridge carry quantities and dates only (a line's cost is a separate, grained field).
 *
 *   why       one line for the grid:      Need 420 − usable 120 − on order 100 = short 200 ft²
 *   bridge    the ladder:                 need → − usable stock → − on order → = short → + rounding → = buy
 *   sentence  the drawer's first words:   We need 420 ft² for 2 orders. 120 ft² in stock can be used. …
 */

const n = (value: DecimalInput): string => decimalText(value)

/** A quantity with its unit in English words: a measure with its symbol (420 ft², 22.68 m), a count with its name (4 hides, 24 pieces). */
export function quantityWords(value: DecimalInput, uom: Uom): string {
  const dimension = dimensionOf(uom)
  if (dimension !== 'COUNT' && dimension !== 'ITEM') return `${n(value)} ${UNITS[uom].symbol}`
  const name = UNITS[uom].name.en
  const one = decimalOf(value).eq(1)
  return `${n(value)} ${one ? name : name.endsWith('x') ? `${name}es` : `${name}s`}`
}

/** The numbers of one requirement, as stored (base unit, four decimals). */
export interface LineNumbers {
  readonly action: 'BUY' | 'MAKE'
  readonly uom: Uom
  readonly grossQuantity: string
  readonly usableStock: string
  readonly heldStock: string
  readonly onOrder: string
  readonly netQuantity: string
  readonly needDate: BusinessDate
}

/** The grid's one line. */
export function whyLine(line: LineNumbers): string {
  return `Need ${n(line.grossQuantity)} − usable ${n(line.usableStock)} − on order ${n(line.onOrder)} = short ${quantityWords(line.netQuantity, line.uom)}`
}

export const BRIDGE_STEPS = ['NEED', 'USABLE', 'ON_ORDER', 'SHORT', 'ROUNDING', 'BUY'] as const
export type BridgeStepKind = (typeof BRIDGE_STEPS)[number]

export interface BridgeStep {
  readonly step: BridgeStepKind
  readonly label: string
  /** Signed for the steps that take off (usable, on order) or add (rounding); base unit, four decimals. */
  readonly quantity: string
  readonly uom: Uom
}

/** The ladder: need, less usable stock, less on order, = short (never below 0), + rounding, = what the suggestion brings. */
export function bridgeOf(line: LineNumbers, suggestion: Pick<Suggestion, 'baseQuantity' | 'roundingBase'>): BridgeStep[] {
  const step = (kind: BridgeStepKind, label: string, value: DecimalInput): BridgeStep => ({ step: kind, label, quantity: decimalOf(value).toFixed(4), uom: line.uom })
  return [
    step('NEED', 'What the orders still need', line.grossQuantity),
    step('USABLE', 'Stock we may use', decimalOf(line.usableStock).negated()),
    step('ON_ORDER', 'Already ordered, arriving in time', decimalOf(line.onOrder).negated()),
    step('SHORT', 'Short', line.netQuantity),
    step('ROUNDING', line.action === 'BUY' ? 'Rounded up to what the supplier sells' : 'Rounded up to whole units', suggestion.roundingBase),
    step('BUY', line.action === 'BUY' ? 'To buy' : 'To make', suggestion.baseQuantity),
  ]
}

/** What the sentence says beyond the stored numbers (live detail of the explanation). */
export interface SentenceFacts {
  /** How many distinct orders the sources name. */
  readonly orders: number
  /** Already issued to the orders' open work orders (base unit). */
  readonly issued: DecimalInput
  /** Stock of the material in other colours (base unit). */
  readonly otherColours: DecimalInput
  /** Stock that is rejected (base unit): listed, never held, never counted. */
  readonly rejected: DecimalInput
  /** Open purchase quantity that arrives after it is needed (base unit). */
  readonly tooLate: DecimalInput
  readonly suggestion: Suggestion
  /** About how many hides the suggestion is; null: no hide factor. */
  readonly hides: number | null
  readonly orderBy: OrderBy
}

/** The Why drawer's sentence (no money). */
export function sentenceOf(line: LineNumbers, facts: SentenceFacts): string {
  const w = (value: DecimalInput): string => quantityWords(value, line.uom)
  const parts: string[] = []
  const issued = decimalOf(facts.issued)
  const orders = facts.orders === 1 ? '1 order' : `${facts.orders} orders`
  parts.push(`We need ${w(line.grossQuantity)} for ${orders}${issued.gt(0) ? ` (${w(issued)} are already issued to their work orders)` : ''}.`)
  parts.push(`${w(line.usableStock)} in stock can be used.`)
  if (decimalOf(line.heldStock).gt(0)) parts.push(`${w(line.heldStock)} more are held (quality hold, chromium VI test or blocked) and not counted.`)
  if (decimalOf(facts.rejected).gt(0)) parts.push(`${w(facts.rejected)} are rejected and not counted.`)
  if (decimalOf(facts.otherColours).gt(0)) parts.push(`${w(facts.otherColours)} are in another colour and not counted.`)
  if (decimalOf(line.onOrder).gt(0)) parts.push(`${w(line.onOrder)} are already ordered and arrive in time.`)
  if (decimalOf(facts.tooLate).gt(0)) parts.push(`${w(facts.tooLate)} more on order arrive after they are needed and are not counted.`)
  if (decimalOf(line.netQuantity).lte(0)) {
    parts.push('Nothing is short: usable stock and goods on order cover it.')
    return parts.join(' ')
  }
  parts.push(`We are ${w(line.netQuantity)} short.`)
  const suggestion = facts.suggestion
  const brings = suggestion.uom === line.uom ? '' : ` (about ${w(suggestion.baseQuantity)})`
  const hides = facts.hides !== null && suggestion.uom !== 'HIDE' ? `, about ${quantityWords(String(facts.hides), 'HIDE')}` : ''
  if (line.action === 'MAKE') {
    parts.push(`Make ${quantityWords(suggestion.quantity, suggestion.uom)}, needed by ${line.needDate}.`)
    return parts.join(' ')
  }
  parts.push(`Buy ${quantityWords(suggestion.quantity, suggestion.uom)}${brings}${hides}.`)
  parts.push(
    facts.orderBy.leadTimeDays === null
      ? `No lead time is on record: order by ${facts.orderBy.date}, the day it is needed.`
      : `Order by ${facts.orderBy.date} to have it by ${line.needDate} (${facts.orderBy.leadTimeDays} days' lead time).`,
  )
  return parts.join(' ')
}
