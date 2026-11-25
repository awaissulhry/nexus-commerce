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

export const PROBLEM_CODES = [
  'NO_LINES',
  'TOO_MANY_LINES',
  'DATE_PAST',
  'SHIP_TO_ARCHIVED',
  'STYLE_NOT_SOLD',
  'COLOUR_DISCONTINUED',
  'SIZE_NOT_OFFERED',
  'NO_SIZES',
  'PRICE_CHANGED',
  // B-CP-075: a described or made-to-measure line's own problems (customLineProblems).
  'NO_TOTAL',
  'SIZES_NOT_TOTAL',
  'NO_PEOPLE',
  'MTM_CLOSED',
  'GARMENT_TYPE_GONE',
] as const
export type ProblemCode = (typeof PROBLEM_CODES)[number]

export interface Problem {
  readonly code: ProblemCode
  /** The line it is on (null: the request's). */
  readonly lineId: string | null
  /** A size it is on, when it is one size's. */
  readonly size: string | null
  readonly words: Words
  /** B-CP-075: the person of the line's roster it is on (null or absent: the line's own). */
  readonly personId?: string | null
}

const problem = (code: ProblemCode, words: Words, lineId: string | null = null, size: string | null = null, personId: string | null = null): Problem => ({ code, lineId, size, words, personId })

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

/**
 * od-s s.4 (order start; the Owner's change of 2026-11-25 10:12, addendum R1: "we should not keep any requirements at all"): whether a
 * problem holds the Send. Only an INVALID value does (a date in the past, an archived address, a style no longer sold, a colour
 * discontinued, a size not offered, sizes that do not add up to the total, made to measure switched off, a garment type gone, too
 * many lines, a price shown that is no longer today's — the customer takes today's price first: what is sent is what was shown); a
 * MISSING one never does (no line, no sizes, no total, no people — the office's Confirm window asks them).
 */
export const SEND_HOLDING: Readonly<Record<ProblemCode, boolean>> = Object.freeze({
  NO_LINES: false,
  TOO_MANY_LINES: true,
  DATE_PAST: true,
  SHIP_TO_ARCHIVED: true,
  STYLE_NOT_SOLD: true,
  COLOUR_DISCONTINUED: true,
  SIZE_NOT_OFFERED: true,
  NO_SIZES: false,
  PRICE_CHANGED: true,
  NO_TOTAL: false,
  SIZES_NOT_TOTAL: true,
  NO_PEOPLE: false,
  MTM_CLOSED: true,
  GARMENT_TYPE_GONE: true,
})
export const holdsSend = (code: ProblemCode): boolean => SEND_HOLDING[code]

/** "2 problems — Show me": the send's held reason in words. */
export function heldWords(count: number): Words | null {
  if (count === 0) return null
  return count === 1 ? { it: '1 problema da risolvere', en: '1 problem to fix' } : { it: `${count} problemi da risolvere`, en: `${count} problems to fix` }
}

// ---- totals ------------------------------------------------------------------------------------------------------------

export const piecesOfSizes = (sizes: readonly SizeAsk[]): number => sizes.reduce((sum, row) => sum + row.quantity, 0)

/**
 * Lines, pieces and the net total of the prices shown (null when a line has no price shown, or for a person without prices).
 * B-CP-075: `pieces`, when given, is the line's own count by its kind (linePieces: a described total, a roster); else its sizes.
 */
export function draftTotals(lines: readonly { readonly sizes: readonly SizeAsk[]; readonly unitPriceShown: string | null; readonly pieces?: number | undefined }[], seesPrices: boolean): { lines: number; pieces: number; net: string | null } {
  let pieces = 0
  let net: Decimal | null = seesPrices ? new Dec(0) : null
  for (const line of lines) {
    const count = line.pieces ?? piecesOfSizes(line.sizes)
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

/**
 * The design's summary line (SAL-074): what happens after the send. B-TH-041 (Owner decision 3, threads plan): no answer-time
 * promise on either door — the words say what we confirm, never by when (the office's own 1-day alert on a request that waits
 * stays, inside).
 */
export const REQUEST_NOTICE: Words = Object.freeze({
  it: 'Questa è una richiesta. Vi confermiamo prezzo, quantità e data; la vedrete negli Ordini.',
  en: 'This is a request. We confirm price, quantities and date with you; you will see it under Orders.',
})

export const SOURCES = ['PICKER', 'REORDER', 'UPLOAD'] as const
export type RequestSource = (typeof SOURCES)[number]

// ---- B-CP-075 (customer page plan C5; 12 §2 parts 1 and 4; review A5, F1, F2): every kind of draft line -----------------------
/**
 * A draft holds lines of three kinds (PortalOrderRequestLine.kind; the …_customer_page_guards trigger holds the same shapes):
 *
 *   CATALOGUE        a style of the customer's catalogue in one of its colourways, its size grid (the rules above)
 *   DESCRIBED        the customer's own words (1 to 2000), colours in words, maybe its own private-label style; it needs a TOTAL
 *                    of pieces to be sent — the split by size may follow after Send (review A5: one rule) — or, by person, its
 *                    people
 *   MADE_TO_MEASURE  a garment type (an ACTIVE measurement template's code: the API checks it), maybe a style of its catalogue;
 *                    always by person. Open for every customer by default (PortalSettings.mtmDraftsOn, lead pick); a customer
 *                    the office switched off keeps no made-to-measure line ("ask us in the messages"). Drafts only: a quote or
 *                    an order made to measure still follows GATE-MTM.
 *
 * A by-person line takes its pieces from its people (./people.ts: a size, a measurement sheet, or "sending later"); a measurement
 * sheet on the line stands for its roster ("People: in the attached sheet", review A5), so a team with one sheet for twelve
 * riders sends without typing twelve names.
 */
export const LINE_KINDS = ['CATALOGUE', 'DESCRIBED', 'MADE_TO_MEASURE'] as const
export type LineKind = (typeof LINE_KINDS)[number]
/** The kinds in the customer's own words: no size grid of the catalogue (the draft's `customLines`). */
export const CUSTOM_LINE_KINDS = ['DESCRIBED', 'MADE_TO_MEASURE'] as const
export type CustomLineKind = (typeof CUSTOM_LINE_KINDS)[number]

export const CUSTOM_LINE_LIMITS = Object.freeze({ description: 2000, colourText: 200, garmentType: 40, total: 100_000 })

/**
 * What a described or made-to-measure line holds (a new one, or one as it would be after a change). od-s s.4 (addendum R3, the
 * products table): every cell is optional — the words, the garment type, the colour; `sizing` (null: not decided yet) says the
 * kind (custom size = MADE_TO_MEASURE); the row's open `choices` (names only, ./choices.ts).
 */
export interface CustomLineInput {
  readonly kind: CustomLineKind
  readonly sizing?: 'STANDARD' | 'MADE_TO_MEASURE' | null | undefined
  readonly choices?: readonly { readonly topic: string; readonly options: readonly string[]; readonly picked: string | null }[] | null | undefined
  readonly description?: string | null | undefined
  readonly colourText?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly garmentType?: string | null | undefined
  readonly quantity?: number | null | undefined
  readonly byPerson?: boolean | undefined
  readonly sizes?: readonly SizeAsk[] | undefined
  readonly note?: string | null | undefined
}

const filled = (value: string | null | undefined): boolean => value !== undefined && value !== null && value.trim() !== ''

/** The problems of a described or made-to-measure line's own shape (before it is written), in words for 400 issues. */
export function customLineShapeProblems(line: CustomLineInput): string[] {
  const out: string[] = []
  const sizes = line.sizes ?? []
  const byPerson = line.kind === 'MADE_TO_MEASURE' ? true : line.byPerson === true
  // od-s s.4 (addendum R3): a described row may have no words yet; a made-to-measure row no garment type yet. od-fx4: left out
  // (absent or null) is "not decided yet"; given but blank is refused (one way to say "none": null).
  if (line.description !== undefined && line.description !== null && line.description.trim() === '') out.push('Say in your words what you need (1 to 2000 characters), or leave the words out for now.')
  if (filled(line.description) && line.description!.trim().length > CUSTOM_LINE_LIMITS.description) out.push(`A description is at most ${CUSTOM_LINE_LIMITS.description} characters.`)
  if (filled(line.colourText) && line.colourText!.trim().length > CUSTOM_LINE_LIMITS.colourText) out.push(`The colours in words are at most ${CUSTOM_LINE_LIMITS.colourText} characters.`)
  if (line.kind === 'MADE_TO_MEASURE') {
    if (filled(line.garmentType) && line.garmentType!.trim().length > CUSTOM_LINE_LIMITS.garmentType) out.push(`A garment type is at most ${CUSTOM_LINE_LIMITS.garmentType} characters.`)
    if (line.garmentType !== undefined && line.garmentType !== null && line.garmentType.trim() === '') out.push('Choose the garment type to make to measure, or leave it out for now.') // od-fx4
    if (line.byPerson === false) out.push('A made-to-measure line is always by person.')
    if (line.quantity !== undefined && line.quantity !== null) out.push('A made-to-measure line counts its people, not a total.')
  } else if (line.quantity !== undefined && line.quantity !== null && (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > CUSTOM_LINE_LIMITS.total)) {
    out.push(`A total is 1 to ${CUSTOM_LINE_LIMITS.total} pieces.`)
  }
  if (filled(line.colourwayId) && !filled(line.styleId)) out.push('A colour of ours goes with its style.')
  if (byPerson && (sizes.length > 0 || (line.quantity !== undefined && line.quantity !== null))) out.push('A line by person takes its pieces from its people: no total and no sizes.')
  if (sizes.length > 0) out.push(...lineShapeProblems({ styleId: '', colourwayId: '', sizes, note: null }))
  if (line.note && line.note.trim().length > ORDERING_LIMITS.lineNote) out.push(`A line's note is at most ${ORDERING_LIMITS.lineNote} characters.`)
  return [...new Set(out)]
}

/** A line's pieces by its kind: by person its people; a described line its total (else its sizes); a catalogue line its sizes. */
export function linePieces(line: { readonly kind: LineKind; readonly quantity: number | null; readonly sizes: readonly SizeAsk[]; readonly byPerson: boolean; readonly people: number }): number {
  if (line.byPerson) return line.people
  if (line.kind === 'DESCRIBED' && line.quantity !== null) return line.quantity
  return piecesOfSizes(line.sizes)
}

/**
 * Send's rule of a line's pieces, as the database holds it: size rows; a described line's total; a by-person line's people, or a
 * measurement sheet on the line that stands for them ("People: in the attached sheet").
 */
export function lineHasPieces(line: { readonly kind: LineKind; readonly quantity: number | null; readonly sizes: readonly SizeAsk[]; readonly byPerson: boolean; readonly people: number; readonly sheetOnLine: boolean }): boolean {
  return line.sizes.length > 0 || (line.kind === 'DESCRIBED' && line.quantity !== null) || (line.byPerson && (line.people > 0 || line.sheetOnLine))
}

/** The facts of a described or made-to-measure line as the draft and the catalogue hold them today. */
export interface CustomLineFacts {
  readonly id: string
  readonly kind: CustomLineKind
  readonly quantity: number | null
  readonly sizes: readonly SizeAsk[]
  readonly byPerson: boolean
  /** Its people (a person measured by a size names it). */
  readonly people: readonly { readonly id: string; readonly size: string | null }[]
  /** A measurement sheet sits on the line: it stands for the roster. */
  readonly sheetOnLine: boolean
  /** The style it names, as the customer's catalogue holds it today (null: none named). */
  readonly style: { readonly code: string; readonly sold: boolean; readonly range: readonly string[] } | null
  /** The colour of ours it names (null: none named). */
  readonly colourway: { readonly name: string; readonly active: boolean } | null
  /** MADE_TO_MEASURE: the customer may keep made-to-measure lines (PortalSettings.mtmDraftsOn). */
  readonly mtmOpen: boolean
  /** MADE_TO_MEASURE: its garment type, and whether an ACTIVE measurement template has that code today. */
  readonly garmentType: { readonly code: string; readonly active: boolean } | null
}

/** The portal's words when made to measure is switched off for the customer ("voi"). */
export const MTM_CLOSED_WORDS: Words = Object.freeze({ it: 'Il su misura non è ancora aperto per voi: chiedeteci nei messaggi.', en: 'Made to measure is not open for you yet: ask us in the messages.' })

/** What holds the send of a described or made-to-measure line (named whenever the draft is read; the send is held until none is left). */
export function customLineProblems(line: CustomLineFacts): Problem[] {
  const out: Problem[] = []
  if (line.kind === 'MADE_TO_MEASURE') {
    if (!line.mtmOpen) out.push(problem('MTM_CLOSED', MTM_CLOSED_WORDS, line.id))
    else if (line.garmentType !== null && !line.garmentType.active) {
      const code = line.garmentType.code
      out.push(problem('GARMENT_TYPE_GONE', { it: `Il su misura ${code} non è più offerto: scegliete un altro tipo di capo.`, en: `Made to measure ${code} is no longer offered: choose another garment type.` }, line.id))
    }
  }
  if (line.style !== null && !line.style.sold) {
    const code = line.style.code
    out.push(problem('STYLE_NOT_SOLD', { it: `${code} non è più in vendita per voi: toglietelo dalla riga.`, en: `${code} is no longer sold to you: take it off the line.` }, line.id))
  }
  if (line.colourway !== null && !line.colourway.active) out.push(problem('COLOUR_DISCONTINUED', { it: `Il colore ${line.colourway.name} non è più disponibile: sceglietene un altro.`, en: `${line.colourway.name} is discontinued: choose another colour.` }, line.id))
  if (line.byPerson) {
    if (line.people.length === 0 && !line.sheetOnLine) out.push(problem('NO_PEOPLE', { it: 'Indicate le persone, o allegate la loro scheda misure.', en: 'Name the people, or attach their measurement sheet.' }, line.id))
  } else if (line.kind === 'DESCRIBED') {
    const sum = piecesOfSizes(line.sizes)
    if (line.quantity === null) out.push(problem('NO_TOTAL', { it: 'Indicate quanti pezzi in tutto (le taglie possono seguire).', en: 'Say how many pieces in all (the sizes may follow).' }, line.id))
    else if (line.sizes.length > 0 && sum !== line.quantity) out.push(problem('SIZES_NOT_TOTAL', { it: `Le taglie fanno ${sum} pezzi, il totale dice ${line.quantity}.`, en: `The sizes add up to ${sum} pieces, the total says ${line.quantity}.` }, line.id))
  }
  // A size a style does not have: on the line (a described one's split) or on a person (its size).
  if (line.style !== null && line.style.sold && line.style.range.length > 0) {
    const code = line.style.code
    const words = (size: string): Words => ({ it: `La taglia ${size} non è nella scala di ${code}.`, en: `Size ${size} is not in the range of ${code}.` })
    for (const ask of line.sizes) if (!line.style.range.includes(ask.size)) out.push(problem('SIZE_NOT_OFFERED', words(ask.size), line.id, ask.size))
    for (const person of line.people) if (person.size !== null && !line.style.range.includes(person.size)) out.push(problem('SIZE_NOT_OFFERED', words(person.size), line.id, person.size, person.id))
  }
  return out
}

/**
 * B-CP-075: the 409 of a draft a colleague changed meanwhile — it names them (the party's own person; never an office name).
 * od-s s.2 (W2): `factory` — an office person saved it last: "the factory", never a worker's name.
 */
export function draftStaleWords(input: { readonly name: string | null; readonly self: boolean; readonly version: number; readonly factory?: boolean | undefined }): Words {
  if (input.self) return { it: `Avete modificato questa bozza in un'altra finestra (ora versione ${input.version}): rileggetela.`, en: `You changed this draft in another window (now version ${input.version}): read it again.` }
  if (input.factory === true) return { it: `La fabbrica ha modificato questa bozza dopo che l'avete letta (ora versione ${input.version}): rileggetela.`, en: `The factory changed this draft since you read it (now version ${input.version}): read it again.` }
  if (input.name !== null) return { it: `${input.name} ha modificato questa bozza dopo che l'avete letta (ora versione ${input.version}): rileggetela.`, en: `${input.name} changed this draft since you read it (now version ${input.version}): read it again.` }
  return { it: `Questa bozza è cambiata dopo che l'avete letta (ora versione ${input.version}): rileggetela.`, en: `This draft changed since you read it (now version ${input.version}): read it again.` }
}
// ---- end B-CP-075

// ---- od-s s.2 (order start, 13-backend § 2; Owner yes 1a): the office writes a customer's draft --------------------------------
/** The office's 409 of a draft changed meanwhile (the office voice, "tu"): it names whoever saved it (the customer's person or a colleague). */
export function officeDraftStaleWords(input: { readonly name: string | null; readonly self: boolean; readonly version: number }): Words {
  if (input.self) return { it: `Hai modificato questa bozza in un'altra finestra (ora versione ${input.version}): rileggila.`, en: `You changed this draft in another window (now version ${input.version}): read it again.` }
  if (input.name !== null) return { it: `${input.name} ha modificato questa bozza dopo che l'hai letta (ora versione ${input.version}): rileggila.`, en: `${input.name} changed this draft since you read it (now version ${input.version}): read it again.` }
  return { it: `Questa bozza è cambiata dopo che l'hai letta (ora versione ${input.version}): rileggila.`, en: `This draft changed since you read it (now version ${input.version}): read it again.` }
}

/** The office's refusals on a customer's draft, in words (the API sends the English; the office page has both). */
export const OFFICE_DRAFT_WORDS = Object.freeze({
  /** A sent request: the customer reads it only; a late detail goes in the Confirm window or on the order. */
  SENT: { it: 'Questa richiesta è stata inviata: scrivi un dettaglio tardivo nella finestra di conferma o sull’ordine.', en: 'This request was sent: type a late detail in the Confirm window or on the order.' },
  /** Files on a draft that is no longer one. */
  FILES_CLOSED: { it: 'Questa richiesta non è più una bozza: i file vanno sull’ordine.', en: 'This request is no longer a draft: files go on the order.' },
  /** No files.upload over the customer. */
  NO_UPLOAD: { it: 'Caricare file per questo cliente richiede il permesso sui file.', en: 'Uploading files for this customer needs the files right.' },
  /** Discard: only a draft an office person started (Owner yes 1a). */
  DISCARD_HELD: { it: 'Qui elimini solo una bozza iniziata in ufficio; il cliente elimina le proprie.', en: 'Only a draft started in the office is discarded here; the customer discards its own.' },
  /** A measurement sheet named without sales.measurements.view (body data). */
  SHEET_HELD: { it: 'Indicare una scheda misure richiede il permesso sulle misure.', en: 'Naming a measurement sheet needs the measurements right.' },
  /** The customer's own price ("Your price") typed from the office (money wall: the customer types it). */
  OWN_PRICE: { it: 'Il prezzo del cliente lo scrive il cliente.', en: "The customer's own price is typed by the customer." },
  /** od-ts t.6: a measurement sheet is not moved to the logos or the references (the office voice). */
  SHEET_STAYS: { it: 'Una scheda misure resta una scheda misure: toglila e aggiungi di nuovo il file come logo o riferimento.', en: 'A measurement sheet stays a measurement sheet: remove it and add the file again as a logo or a reference.' },
})
// ---- end od-s s.2

// ---- od-s s.3 (L5): "Make style draft" on a draft order (409 refusal/<CODE>, in words) ----------------------------------------
export const STYLE_DRAFT_WORDS = Object.freeze({
  CLOSED: { it: 'Questa richiesta è già decisa: una bozza di modello si crea mentre è una bozza o è inviata.', en: 'This request is already decided: a style draft is made while it is a draft or sent.' },
  STYLE_DRAFTS_FULL: { it: 'Questa richiesta indica già 50 bozze di modello, il massimo per una richiesta.', en: 'This request already names 50 style drafts, the most one request names.' },
})
// ---- end od-s s.3
