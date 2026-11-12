import type { Issue } from '../../core/errors'
import { Dec, parseDecimal } from '../../tax/decimal'

/**
 * Goods without a purchase order (B-W2b-300; SCM-122; design floor.receive › "Goods without a PO", Rule 1: deliveries arrive
 * every day; an unplanned one waits on a desk today), the pure rules. The table is factory-db GoodsReceipt with kind UNPLANNED
 * (B-W2b-277, wave 36): made without a purchase order, its goods in a holding place of the site, OPEN with its lines and NO stock
 * move, so nothing of it is used until a buyer names the purchase order (then it posts as every receipt posts) or sends the goods
 * back (CANCELLED). The database refuses posting it earlier, whatever the path.
 *
 *   on the floor   the supplier, each material with its colour and quantity (a leather's hides counted), the supplier's
 *                  delivery note (number, date, photo), into the holding place: ONE receipt, OPEN.
 *   the buyer      a task on the receipt asks for the purchase order or a return (platform/tasks; who: the person who last
 *                  ordered from that supplier for the company, else the first buyer by name).
 *   named          each line of the receipt goes to one open line of that order, of the same material and colour; posted into
 *                  the holding place (its lots, hides and RECEIPT moves as W1 posts them), the buyer's task done.
 *   sent back      the receipt CANCELLED with why; the buyer's task done.
 */

export const UNPLANNED_LIMITS = Object.freeze({ lines: 20, text: 500, code: 60, hides: 999, suppliers: 50, items: 30 })

/** Where goods without a PO stand, from their receipt's status. */
export const UNPLANNED_STATES = ['WAITING', 'ORDER_NAMED', 'SENT_BACK'] as const
export type UnplannedState = (typeof UNPLANNED_STATES)[number]

export function unplannedStateOf(status: 'OPEN' | 'POSTED' | 'REVERSED' | 'CANCELLED'): UnplannedState {
  return status === 'OPEN' ? 'WAITING' : status === 'CANCELLED' ? 'SENT_BACK' : 'ORDER_NAMED'
}

/** What happened to goods without a PO (the event's `change`). */
export const UNPLANNED_CHANGES = ['RECEIVED', 'BUYER_ASKED', 'ORDER_NAMED', 'SENT_BACK'] as const
export type UnplannedChange = (typeof UNPLANNED_CHANGES)[number]

/** Why the floor cannot take goods without a PO in now (the screen words each code). */
export const UNPLANNED_HELD = ['NO_HOLDING_PLACE', 'OFFLINE'] as const
export type UnplannedHeld = (typeof UNPLANNED_HELD)[number]

const QUANTITY = /^\d{1,12}(?:\.\d{1,4})?$/

/** A quantity as typed: a decimal above 0 with at most 4 decimals; null when it is not one. */
export function quantityOf(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  if (!QUANTITY.test(text)) return null
  const parsed = parseDecimal(text)
  return parsed && parsed.greaterThan(0) ? parsed.toFixed(4) : null
}

export interface UnplannedLineInput {
  readonly itemId: string
  readonly quantity: string
  readonly hideCount?: number | null | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with one line the floor typed (paths relative to the line), against its material's tracking. */
export function unplannedLineProblems(line: UnplannedLineInput, item: { readonly code: string; readonly tracking: 'NONE' | 'LOT' | 'HIDE' }): Issue[] {
  const problems: Issue[] = []
  if (quantityOf(line.quantity) === null) problems.push({ path: 'quantity', message: `${item.code}: a quantity above 0, at most 4 decimals.` })
  if (line.hideCount !== undefined && line.hideCount !== null) {
    if (item.tracking !== 'HIDE') problems.push({ path: 'hideCount', message: `${item.code} is not leather: it has no hides to count.` })
    else if (!Number.isInteger(line.hideCount) || line.hideCount < 1 || line.hideCount > UNPLANNED_LIMITS.hides) problems.push({ path: 'hideCount', message: `1 to ${UNPLANNED_LIMITS.hides} hides.` })
  }
  if ((line.note ?? '').trim().length > UNPLANNED_LIMITS.text) problems.push({ path: 'note', message: `At most ${UNPLANNED_LIMITS.text} characters.` })
  return problems
}

/** The kinds of place goods without a PO never wait in (the database refuses the first three; the rest hold no incoming material). */
export const NOT_HOLDING_KINDS: readonly string[] = Object.freeze(['SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT', 'SHIPPING', 'PRODUCTION', 'FINISHED_GOODS'])

/** The holding place the goods go into: a place of the site that takes stock and is no workshop's, customer's or transit place. */
export function holdingProblem(place: { readonly code: string; readonly status: string; readonly kind: string } | null): string | null {
  if (!place) return 'That is no place of this site: scan the label of the holding place.'
  if (place.status !== 'ACTIVE') return `${place.code} is archived: goods without a PO wait in a place that takes stock.`
  if (NOT_HOLDING_KINDS.includes(place.kind)) return `${place.code} is no place for goods without a PO: put them in the holding place (a bin, a rack or the goods-in area).`
  return null
}

// ---- the buyer names the purchase order ---------------------------------------------------------------------------------------

export interface WaitingLine {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  /** "Line 10 (SEED-LIN-100 GRY)". */
  readonly label: string
}

export interface OrderLineFacts {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  /** Cancelled or closed short: it takes no goods. */
  readonly ended: boolean
}

export interface NamedLine {
  readonly receiptLineId: string
  readonly purchaseOrderLineId: string
}

/** The open lines of the order each waiting line could go to: the same material and colour, not ended. */
export function candidateLines(waiting: readonly WaitingLine[], orderLines: readonly OrderLineFacts[]): Map<string, string[]> {
  return new Map(waiting.map((line) => [line.id, orderLines.filter((entry) => !entry.ended && entry.itemId === line.itemId && entry.itemColourId === line.itemColourId).map((entry) => entry.id)]))
}

/**
 * What is wrong with the buyer's naming (paths `lines/<i>/…` of the body): every waiting line named exactly once, each to a line
 * of THIS order of its material and colour that still takes goods, an order line taking one receipt line.
 */
export function namingProblems(waiting: readonly WaitingLine[], orderLines: readonly OrderLineFacts[], named: readonly NamedLine[]): Issue[] {
  const problems: Issue[] = []
  const seenReceipt = new Set<string>()
  const seenOrder = new Set<string>()
  named.forEach((entry, index) => {
    const at = `lines/${index}`
    const line = waiting.find((row) => row.id === entry.receiptLineId)
    if (!line) return void problems.push({ path: `${at}/receiptLineId`, message: 'Not a line of this receipt.' })
    if (seenReceipt.has(line.id)) return void problems.push({ path: `${at}/receiptLineId`, message: `${line.label} is named twice: name one order line for it.` })
    seenReceipt.add(line.id)
    const orderLine = orderLines.find((row) => row.id === entry.purchaseOrderLineId)
    if (!orderLine) return void problems.push({ path: `${at}/purchaseOrderLineId`, message: `${line.label}: not a line of this purchase order.` })
    if (orderLine.itemId !== line.itemId || orderLine.itemColourId !== line.itemColourId) return void problems.push({ path: `${at}/purchaseOrderLineId`, message: `${line.label}: order line ${orderLine.seq} is of another material or colour.` })
    if (orderLine.ended) return void problems.push({ path: `${at}/purchaseOrderLineId`, message: `${line.label}: order line ${orderLine.seq} was cancelled or closed short and takes no goods.` })
    if (seenOrder.has(orderLine.id)) return void problems.push({ path: `${at}/purchaseOrderLineId`, message: `Order line ${orderLine.seq} takes one line of the receipt: put the goods of one material on one line.` })
    seenOrder.add(orderLine.id)
  })
  const missing = waiting.filter((line) => !seenReceipt.has(line.id))
  if (missing.length > 0) problems.push({ path: 'lines', message: `Name an order line for ${missing.map((line) => line.label).join(', ')}: every line of the goods goes to the order.` })
  return problems
}

/** Why goods are sent back: words, 1 to 500 characters; null when fine. */
export function sendBackProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? '').trim()
  if (text.length === 0) return 'Say why the goods go back (the supplier and the buyer read it).'
  if (text.length > UNPLANNED_LIMITS.text) return `At most ${UNPLANNED_LIMITS.text} characters.`
  return null
}

/** The note a receipt keeps when its goods go back: the reason after a fixed lead, so the list says it in a word. */
export const SENT_BACK_NOTE = 'Sent back to the supplier (goods without a PO):'
export const sentBackNote = (reason: string): string => `${SENT_BACK_NOTE} ${reason.trim()}`

/** Each hide's area of a leather line the buyer types: decimals above 0 (comma or dot), separated by spaces, semicolons or new lines. */
export function hideAreasOf(text: string): { readonly areas: string[]; readonly problem: string | null } {
  const parts = text.split(/[\s;]+/).map((part) => part.trim().replace(',', '.')).filter(Boolean)
  const areas: string[] = []
  for (const part of parts) {
    const area = quantityOf(part)
    if (area === null) return { areas: [], problem: `"${part}" is no area: one decimal above 0 per hide.` }
    areas.push(area)
  }
  if (areas.length === 0) return { areas, problem: 'Give each hide’s area: leather posts hide by hide.' }
  if (areas.length > UNPLANNED_LIMITS.hides) return { areas: [], problem: `At most ${UNPLANNED_LIMITS.hides} hides.` }
  return { areas, problem: null }
}

/** The sum of decimal strings (4 decimals). */
export const totalOf = (values: readonly string[]): string => values.reduce((sum, value) => sum.plus(new Dec(value)), new Dec(0)).toFixed(4)

// ---- the buyer's task ---------------------------------------------------------------------------------------------------------

export interface BuyerTaskFacts {
  readonly number: string
  readonly supplier: string
  readonly place: string
  readonly lines: number
}

/** The buyer's task, in the buyer's language (the task keeps its words as made). */
export function buyerTaskWords(locale: string | null | undefined, facts: BuyerTaskFacts): { readonly title: string; readonly description: string } {
  if ((locale ?? '').toLowerCase().startsWith('en')) {
    return {
      title: `Goods without a PO: ${facts.number} from ${facts.supplier}`,
      description: `${facts.lines === 1 ? 'One line' : `${facts.lines} lines`} of ${facts.supplier} came without a purchase order and wait in ${facts.place}. Nothing of it is used until an order names them: name the purchase order on the receipt, or send the goods back with the reason.`,
    }
  }
  return {
    title: `Merce senza ordine: ${facts.number} da ${facts.supplier}`,
    description: `${facts.lines === 1 ? 'Una riga' : `${facts.lines} righe`} di ${facts.supplier} sono arrivate senza ordine d'acquisto e aspettano in ${facts.place}. Non si usa nulla finché un ordine non le nomina: indica l'ordine d'acquisto sul ricevimento, oppure rimanda la merce con il motivo.`,
  }
}
