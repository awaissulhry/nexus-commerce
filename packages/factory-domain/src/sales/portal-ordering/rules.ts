import type { BusinessDate } from '../../core/time'
import type { PpeCategory } from '../../product/styles/rules'
import { Dec, type Decimal } from '../../tax/decimal'
import { listPriceText } from '../pricelists/pricelists'
import { MAX_QUOTE_LINES, MAX_SIZE_QUANTITY, MAX_TEXT } from '../quotes/quotes'

/**
 * Portal ordering's rules (B-W2b-190; SAL-071, SAL-072, SAL-073, SAL-074; design portal.customer.catalogue and
 * portal.customer.neworder). Pure: the API reads the facts (the customer's catalogue in the tenant's scope, its own draft
 * in its party's), these say what the customer may buy, what is wrong with a draft and what it adds up to.
 *
 *   catalogue   a style this customer may buy: ACTIVE, of the portal's company (or every company), the open range (no
 *               brand) or its own private label (brand = the customer, never another customer's), and priced for it
 *               by its price list chain (its list in force, the lists it falls back to, the company's base list); a
 *               colourway is ACTIVE and offers at least one size (an ACTIVE variant); sizes in the style's range order
 *   a line      one style in one colourway with its size run; each size offered, 1 to 99 999 pieces, each size once
 *   problems    what holds the send, each with a code, the line it is on and the words: a style no longer sold, a colour
 *               discontinued, a size not offered, a line without sizes, a price that changed since it was shown, no
 *               lines, a requested date in the past, a delivery address archived; the send is held until none is left
 *   totals      lines, pieces and (price grain only) the net total of the prices shown
 */

export interface Words {
  readonly it: string
  readonly en: string
}

export const ORDERING_LIMITS = Object.freeze({
  lines: MAX_QUOTE_LINES,
  sizesPerLine: 60,
  quantity: MAX_SIZE_QUANTITY,
  size: 40,
  customerRef: MAX_TEXT.customerRef,
  note: 4000,
  lineNote: 1000,
  reason: MAX_TEXT.reason,
})

// ---- the catalogue -----------------------------------------------------------------------------------------------------

export interface StyleFacts {
  readonly status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  readonly companyId: string | null
  readonly brandPartyId: string | null
}

/** A style this customer may be offered (before its price: a style no list prices is not in its catalogue). */
export function mayOffer(style: StyleFacts, partyId: string, companyId: string): boolean {
  return style.status === 'ACTIVE' && (style.companyId === null || style.companyId === companyId) && (style.brandPartyId === null || style.brandPartyId === partyId)
}

/** The sizes of a colourway in the style's range order: those its ACTIVE variants offer. */
export const offeredSizes = (range: readonly string[], offered: Iterable<string>): string[] => {
  const set = new Set(offered)
  return range.filter((size) => set.has(size))
}

/** "48–56" (one size: "52"; none: ""). */
export const rangeLabel = (sizes: readonly string[]): string => (sizes.length === 0 ? '' : sizes.length === 1 ? sizes[0]! : `${sizes[0]}–${sizes[sizes.length - 1]}`)

/** A price as the customer reads it: the list's rounding, at least two decimals ("189.00", "12.345"). */
export function priceShown(value: string): string {
  const text = listPriceText(value)
  const [whole, fraction = ''] = text.split('.')
  return fraction.length >= 2 ? text : `${whole}.${fraction.padEnd(2, '0')}`
}

/** The lowest of the prices ("from 189.00"), or null. */
export function lowestPrice(prices: readonly (string | null)[]): string | null {
  let low: Decimal | null = null
  for (const price of prices) {
    if (price === null) continue
    const value = new Dec(price)
    if (low === null || value.lt(low)) low = value
  }
  return low === null ? null : priceShown(low.toString())
}

/** The catalogue's filters (design portal.customer.catalogue filters): category, season, certificate class, own label. */
export const RANGE_FILTERS = ['ALL', 'OWN_LABEL', 'OPEN_RANGE'] as const
export type RangeFilter = (typeof RANGE_FILTERS)[number]

/** A style's PPE category in words, keyed by the stored code (Style.ppeCategory; B-W2b-F17: was NONE / CAT_I …, never found). */
export const PPE_WORDS: Readonly<Record<PpeCategory, Words>> = Object.freeze({
  NOT_PPE: { it: 'Non DPI', en: 'Not PPE' },
  CATEGORY_I: { it: 'DPI categoria I', en: 'PPE category I' },
  CATEGORY_II: { it: 'DPI categoria II', en: 'PPE category II' },
  CATEGORY_III: { it: 'DPI categoria III', en: 'PPE category III' },
})

// ---- a line ------------------------------------------------------------------------------------------------------------

export interface SizeAsk {
  readonly size: string
  readonly quantity: number
}

export interface LineInput {
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: readonly SizeAsk[]
  readonly note?: string | null | undefined
}

/** The facts of a line's style and colourway as the customer's catalogue holds them today (null: not in it). */
export interface LineFacts {
  readonly styleCode: string
  /** In the customer's catalogue today (see `mayOffer`, and priced). */
  readonly sold: boolean
  readonly colourwayName: string
  readonly colourwayActive: boolean
  /** The sizes the colourway offers today, in range order. */
  readonly offered: readonly string[]
  /** The customer's net price today; null: no list prices it. */
  readonly priceNow: string | null
}

export const PROBLEM_CODES = ['NO_LINES', 'TOO_MANY_LINES', 'DATE_PAST', 'SHIP_TO_ARCHIVED', 'STYLE_NOT_SOLD', 'COLOUR_DISCONTINUED', 'SIZE_NOT_OFFERED', 'NO_SIZES', 'PRICE_CHANGED'] as const
export type ProblemCode = (typeof PROBLEM_CODES)[number]

export interface Problem {
  readonly code: ProblemCode
  /** The line it is on (null: the request's). */
  readonly lineId: string | null
  /** A size it is on, when it is one size's. */
  readonly size: string | null
  readonly words: Words
}

const problem = (code: ProblemCode, words: Words, lineId: string | null = null, size: string | null = null): Problem => ({ code, lineId, size, words })

/** The problems of a line's own shape (before it is written): sizes, quantities, note. Messages in words, for 400 issues. */
export function lineShapeProblems(line: LineInput): string[] {
  const out: string[] = []
  if (line.sizes.length === 0) out.push('A line asks at least one size.')
  if (line.sizes.length > ORDERING_LIMITS.sizesPerLine) out.push(`A line asks at most ${ORDERING_LIMITS.sizesPerLine} sizes.`)
  const seen = new Set<string>()
  for (const ask of line.sizes) {
    const size = ask.size.trim()
    if (size === '' || size.length > ORDERING_LIMITS.size) out.push('A size is 1 to 40 characters.')
    if (seen.has(size)) out.push(`Size ${size} is asked twice on the line.`)
    seen.add(size)
    if (!Number.isInteger(ask.quantity) || ask.quantity < 1 || ask.quantity > ORDERING_LIMITS.quantity) out.push(`Size ${size}: 1 to ${ORDERING_LIMITS.quantity} pieces.`)
  }
  if (line.note && line.note.trim().length > ORDERING_LIMITS.lineNote) out.push(`A line's note is at most ${ORDERING_LIMITS.lineNote} characters.`)
  return out
}

/** The problems of a line against the catalogue today (the price only for a person who sees prices). */
export function lineProblems(line: { readonly id: string; readonly sizes: readonly SizeAsk[]; readonly unitPriceShown: string | null }, facts: LineFacts | null, seesPrices: boolean): Problem[] {
  if (facts === null || !facts.sold) {
    const code = facts?.styleCode ?? 'This style'
    return [problem('STYLE_NOT_SOLD', { it: `${code} non è più in vendita per voi: togliete la riga.`, en: `${code} is no longer sold to you: remove the line.` }, line.id)]
  }
  const out: Problem[] = []
  if (!facts.colourwayActive) out.push(problem('COLOUR_DISCONTINUED', { it: `Il colore ${facts.colourwayName} non è più disponibile: sceglietene un altro.`, en: `${facts.colourwayName} is discontinued: choose another colour.` }, line.id))
  if (line.sizes.length === 0) out.push(problem('NO_SIZES', { it: 'La riga non chiede nessuna taglia.', en: 'The line asks no size.' }, line.id))
  if (facts.colourwayActive) {
    for (const ask of line.sizes) {
      if (!facts.offered.includes(ask.size)) out.push(problem('SIZE_NOT_OFFERED', { it: `La taglia ${ask.size} non è offerta per ${facts.styleCode}.`, en: `Size ${ask.size} is not offered for ${facts.styleCode}.` }, line.id, ask.size))
    }
  }
  if (seesPrices && facts.priceNow !== null && (line.unitPriceShown === null || !samePrice(line.unitPriceShown, facts.priceNow))) {
    out.push(
      problem(
        'PRICE_CHANGED',
        line.unitPriceShown === null
          ? { it: `Prezzo ora ${priceShown(facts.priceNow)}: confermatelo.`, en: `Price now ${priceShown(facts.priceNow)}: confirm it.` }
          : { it: `Prezzo ora ${priceShown(facts.priceNow)} (era ${priceShown(line.unitPriceShown)}).`, en: `Price now ${priceShown(facts.priceNow)} (was ${priceShown(line.unitPriceShown)}).` },
        line.id,
      ),
    )
  }
  return out
}

export const samePrice = (a: string, b: string): boolean => new Dec(a).eq(new Dec(b))

export interface DraftHeaderFacts {
  readonly requestedDate: BusinessDate | null
  /** The address asked is still an ACTIVE delivery address of the party (null: none asked). */
  readonly shipToActive: boolean | null
  readonly lineCount: number
}

/** The request's own problems (its lines' come from `lineProblems`). */
export function headerProblems(facts: DraftHeaderFacts, today: BusinessDate): Problem[] {
  const out: Problem[] = []
  if (facts.lineCount === 0) out.push(problem('NO_LINES', { it: 'Aggiungete almeno una riga.', en: 'Add at least one line.' }))
  if (facts.lineCount > ORDERING_LIMITS.lines) out.push(problem('TOO_MANY_LINES', { it: `Al massimo ${ORDERING_LIMITS.lines} righe per richiesta.`, en: `At most ${ORDERING_LIMITS.lines} lines per request.` }))
  if (facts.requestedDate !== null && facts.requestedDate < today) out.push(problem('DATE_PAST', { it: 'La data di consegna richiesta è passata: sceglietene una da oggi in poi.', en: 'The requested delivery date has passed: choose one from today on.' }))
  if (facts.shipToActive === false) out.push(problem('SHIP_TO_ARCHIVED', { it: "L'indirizzo di consegna non è più attivo: sceglietene un altro.", en: 'The delivery address is no longer active: choose another one.' }))
  return out
}

/** "2 problems — Show me": the send's held reason in words. */
export function heldWords(count: number): Words | null {
  if (count === 0) return null
  return count === 1 ? { it: '1 problema da risolvere', en: '1 problem to fix' } : { it: `${count} problemi da risolvere`, en: `${count} problems to fix` }
}

// ---- totals ------------------------------------------------------------------------------------------------------------

export const piecesOfSizes = (sizes: readonly SizeAsk[]): number => sizes.reduce((sum, row) => sum + row.quantity, 0)

/** Lines, pieces and the net total of the prices shown (null when a line has no price shown, or for a person without prices). */
export function draftTotals(lines: readonly { readonly sizes: readonly SizeAsk[]; readonly unitPriceShown: string | null }[], seesPrices: boolean): { lines: number; pieces: number; net: string | null } {
  let pieces = 0
  let net: Decimal | null = seesPrices ? new Dec(0) : null
  for (const line of lines) {
    const count = piecesOfSizes(line.sizes)
    pieces += count
    if (net !== null) net = line.unitPriceShown === null ? null : net.plus(new Dec(line.unitPriceShown).times(count))
  }
  return { lines: lines.length, pieces, net: net === null ? null : net.toDecimalPlaces(2).toFixed(2) }
}

/** A line's amount at the price shown (price grain), or null. */
export const lineAmount = (unitPriceShown: string | null, pieces: number): string | null => (unitPriceShown === null ? null : new Dec(unitPriceShown).times(pieces).toDecimalPlaces(2).toFixed(2))

// ---- the request's states in the customer's words --------------------------------------------------------------------

export const REQUEST_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const REQUEST_STATUS_WORDS: Readonly<Record<RequestStatus, Words>> = Object.freeze({
  DRAFT: { it: 'Bozza', en: 'Draft' },
  SENT: { it: 'Richiesta inviata', en: 'Request sent' },
  ACCEPTED: { it: 'Confermata', en: 'Confirmed' },
  REFUSED: { it: 'Non accettata', en: 'Not accepted' },
  WITHDRAWN: { it: 'Ritirata', en: 'Withdrawn' },
})

/** The design's summary line (SAL-074): what happens after the send. */
export const REQUEST_NOTICE: Words = Object.freeze({
  it: 'Questa è una richiesta. Confermiamo prezzo, quantità e data entro 1 giorno lavorativo; la vedrete negli Ordini.',
  en: 'This is a request. We confirm price, quantities and date within 1 working day; you will see it under Orders.',
})

export const SOURCES = ['PICKER', 'REORDER', 'UPLOAD'] as const
export type RequestSource = (typeof SOURCES)[number]
