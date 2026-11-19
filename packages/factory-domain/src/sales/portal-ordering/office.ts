import { ORDERING_LIMITS, type RequestStatus } from './rules'
import type { Problem } from './rules' // B-CP-075: each problem's part of the checklist
// B-CP-077: the accept's line map (a size run's shape, the order line's text limits).
import type { Issue } from '../../core/errors'
import { MAX_TEXT } from '../quotes/quotes'
import { lineShapeProblems } from './rules'
// B-CP-076: the customer's amount of a price (the price check's own rounding).
import { brandAmountOf } from '../brand-prices/match'

/**
 * The office's side of a portal order request (B-W2b-190, SAL-074 "portal orders arrive as requests"; design
 * home.approvals, sales.orders "the request waits there as Requested"). A SENT request waits in Home › Approvals for the
 * people who take orders for its company and customer (orders.manage); they decide it on its record:
 *
 *   accept as an ORDER   the sales orders' own manual create (prices again from the customer's list today, or the prices
 *                        the office types; the customer's terms, addresses and deposit), then ACCEPTED naming the order —
 *                        one command, so a request never names an order that was not made
 *   accept as a QUOTE    a new quote with the request's lines (the quotes' own copy: list prices today, sizes still
 *                        offered), then ACCEPTED naming the quote (quotes.manage too)
 *   refuse               REFUSED with the reason in words, which the customer reads
 *
 * Only a SENT request is decided, once; the customer may withdraw it before that. A DRAFT is the customer's to write (the
 * database refuses an office edit of it). B-CP-071 (customer page plan D10, K9 reversed): the office READS a draft from its
 * first save — per customer, read-only, its thread too — and decides nothing on it until it is sent; a draft is never in
 * Incoming, Home › Approvals or any count. `draftReadiness` is the draft's checklist (12 §2: seven parts) as the office's
 * Drafts view and the portal's page read it.
 */

export const ACCEPT_AS = ['ORDER', 'QUOTE'] as const
export type AcceptAs = (typeof ACCEPT_AS)[number]

/** Why a request cannot be decided now, in words (null: it can). */
export function decisionProblem(status: RequestStatus): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return "This is still the customer's draft: it is decided once they send it." // B-CP-071
  if (status === 'WITHDRAWN') return 'The customer withdrew this request.'
  return `This request was already ${status === 'ACCEPTED' ? 'accepted' : 'refused'}.`
}

/** Why the customer cannot withdraw it now (null: they can). */
export function withdrawProblem(status: RequestStatus): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return 'A draft is discarded, not withdrawn.'
  if (status === 'WITHDRAWN') return 'You already withdrew this request.'
  return 'The factory already decided this request: ask us if something should change.'
}

/** The refusal's words: 1 to 1000 characters after trimming. */
export function refuseReasonProblem(reason: string): string | null {
  const text = reason.trim()
  if (text.length === 0) return 'Say why the request is refused: the customer reads it.'
  if (text.length > ORDERING_LIMITS.reason) return `At most ${ORDERING_LIMITS.reason} characters.`
  return null
}

// ---- B-CP-071 (D10): a draft's checklist -----------------------------------------------------------------------------------

/** The seven parts of a draft order, in the page's order (customer page plan 12 §2). */
export const DRAFT_PARTS = ['NEED', 'LOGOS', 'REFERENCES', 'PEOPLE', 'DATE', 'PRICE', 'NOTES'] as const
export type DraftPart = (typeof DRAFT_PARTS)[number]

/** A part's state: Ready, Sending later, Missing (a required part left empty), Optional (an optional part left empty). */
export const DRAFT_PART_STATES = ['READY', 'LATER', 'MISSING', 'OPTIONAL'] as const
export type DraftPartState = (typeof DRAFT_PART_STATES)[number]

/** The parts the customer may mark "we send it later" (PortalOrderRequest.laterParts, B-CP-075). */
export const DRAFT_LATER_PARTS = ['LOGOS', 'REFERENCES', 'PEOPLE'] as const
export type DraftLaterPart = (typeof DRAFT_LATER_PARTS)[number]

export interface DraftFacts {
  readonly lines: number
  /** Lines that ask no piece yet (a line is ready with a size grid above zero). */
  readonly linesWithoutPieces: number
  readonly logos: number
  readonly references: number
  readonly requestedDate: boolean
  /** The header's own problems (a date that passed, an address no longer active): the date part is missing while one is left. */
  readonly headerProblems: number
  readonly note: boolean
  readonly later: readonly DraftLaterPart[]
  /**
   * Part 6 "Your price": null for a reader WITHOUT the price grain — the part is not counted for them at all (review B4: no
   * money fact reaches a no-price reader, not even "priced: yes"); else how many lines carry the customer's own price.
   */
  readonly pricedLines: number | null
  /** Every problem that holds the send (the header's and the lines'). */
  readonly problems: number
  /** B-CP-075: the problems by the part they are on (problemPartOf); a part with one is not READY. Absent: none counted per part. */
  readonly problemsByPart?: Partial<Record<DraftPart, number>> | undefined
}

export interface DraftReadiness {
  readonly parts: readonly { readonly part: DraftPart; readonly state: DraftPartState }[]
  /** Parts READY. */
  readonly done: number
  /** Parts counted: 7, or 6 for a reader without the price grain. */
  readonly of: number
  readonly problems: number
}

/** The draft's checklist: each part's state, how many are ready of how many, and the problems that hold the send. */
export function draftReadiness(facts: DraftFacts): DraftReadiness {
  const optional = (present: boolean, part: DraftLaterPart | null): DraftPartState => (present ? 'READY' : part !== null && facts.later.includes(part) ? 'LATER' : 'OPTIONAL')
  const held = (part: DraftPart): boolean => (facts.problemsByPart?.[part] ?? 0) > 0 // B-CP-075
  const people: DraftPartState = facts.lines > 0 && facts.linesWithoutPieces === 0 && !held('PEOPLE') ? 'READY' : facts.later.includes('PEOPLE') ? 'LATER' : 'MISSING'
  const parts: { part: DraftPart; state: DraftPartState }[] = [
    { part: 'NEED', state: facts.lines > 0 && !held('NEED') ? 'READY' : 'MISSING' },
    { part: 'LOGOS', state: optional(facts.logos > 0, 'LOGOS') },
    { part: 'REFERENCES', state: optional(facts.references > 0, 'REFERENCES') },
    { part: 'PEOPLE', state: people },
    { part: 'DATE', state: facts.headerProblems > 0 ? 'MISSING' : facts.requestedDate ? 'READY' : 'OPTIONAL' },
    ...(facts.pricedLines === null ? [] : [{ part: 'PRICE' as const, state: facts.lines > 0 && facts.pricedLines >= facts.lines ? ('READY' as const) : ('OPTIONAL' as const) }]),
    { part: 'NOTES', state: facts.note ? 'READY' : 'OPTIONAL' },
  ]
  return { parts, done: parts.filter((entry) => entry.state === 'READY').length, of: parts.length, problems: facts.problems }
}
// ---- end B-CP-071

// ---- B-CP-075 (customer page plan 12 §2: "send problems per part"): the part of the checklist a problem holds ----------------------
/** NEED: a line's own (what it is, its total, its sizes, a price changed); PEOPLE: a roster's (no one named, a person's size); DATE: the header's date and address. */
export function problemPartOf(problem: Pick<Problem, 'code' | 'personId'>): DraftPart {
  if (problem.code === 'DATE_PAST' || problem.code === 'SHIP_TO_ARCHIVED') return 'DATE'
  if (problem.code === 'NO_PEOPLE' || (problem.personId !== undefined && problem.personId !== null)) return 'PEOPLE'
  return 'NEED'
}

/** How many problems each part holds (for draftReadiness' `problemsByPart`). */
export function problemsByPartOf(problems: readonly Pick<Problem, 'code' | 'personId'>[]): Partial<Record<DraftPart, number>> {
  const out: Partial<Record<DraftPart, number>> = {}
  for (const entry of problems) {
    const part = problemPartOf(entry)
    out[part] = (out[part] ?? 0) + 1
  }
  return out
}
// ---- end B-CP-075

// ---- B-CP-077 (customer page plan C5, 12 §9 B-CP-062; lead notes 1–2; review E3): accept a described or made-to-measure request ----
/**
 * A sent request may hold lines in the customer's own words (DESCRIBED, MADE_TO_MEASURE) beside catalogue lines. The office
 * accepts it once each of those is MAPPED to the style line(s) it is made as (a style and colourway the company sells, its sizes,
 * maybe a typed price): one line may become several ("20 team jackets, red and blue" → two lines). The accept keeps ONE map,
 * request line → order (or quote) line(s), by id: catalogue lines 1 → 1 as they are, custom lines 1 → n as mapped — never by
 * place (seq), since a request line's place is not an order line's.
 *
 *   held       a described or made-to-measure line not mapped yet (409, in words, naming its place); a made-to-measure line
 *              accepted as an ORDER (409: while made-to-measure has not started — GATE-MTM — a made-to-measure request becomes
 *              a QUOTE first, today's rule; its people stay on the request, read there, linked from the quote)
 *   sizes      the ones the office names; else, for a line made into ONE style line, the request's own: its size rows, or the
 *              sizes of its people when every person has one. People measured by a sheet or "sending later" have none yet:
 *              the office names the sizes (400, in words). People are never mapped to measurement profiles here ("Saved
 *              measurements" comes later), so nobody confirms measures in this step (the MTM rule "nobody confirms measures
 *              they took" stays with the measurement review)
 *   the note   each mapped line names where it came from in its note (the request, the line, the customer's words, how many
 *              people — never their names: they stay on the request)
 *
 * Pure: apps/factory-api's modules/sales/portal-ordering/office.ts reads the facts and makes the order or quote from the plan.
 */

/** At most this many style lines one described or made-to-measure line is made into. */
export const ACCEPT_MAP_LIMITS = Object.freeze({ into: 20, note: 1000 })

/** The refusals and warnings of an accept, in the office's words (it names places, never another customer). */
export const ACCEPT_WORDS = Object.freeze({
  unmapped: (seqs: readonly number[]) =>
    `${seqs.length === 1 ? `Line ${seqs[0]} is` : `Lines ${seqs.join(', ')} are`} described or made to measure, not from the catalogue: map ${seqs.length === 1 ? 'it' : 'them'} to a style before making an order or a quote.`,
  madeToMeasureOrder: (seqs: readonly number[]) =>
    `${seqs.length === 1 ? `Line ${seqs[0]} is` : `Lines ${seqs.join(', ')} are`} made to measure: accept the request as a quote. While made-to-measure has not started (GATE-MTM), a made-to-measure request becomes a quote first; its people stay on the request.`,
  notALine: 'Not a line of this request.',
  fromCatalogue: (seq: number) => `Line ${seq} is from the catalogue: it becomes a line as it is (map only described or made-to-measure lines).`,
  mappedTwice: (seq: number) => `Line ${seq} is mapped twice: send it once.`,
  priceOnMap: (seq: number) => `Line ${seq} is described or made to measure: type its price on the style line it is made into.`,
  noInto: (seq: number) => `Name the style line ${seq} is made into.`,
  tooMany: (seq: number) => `Line ${seq} is made into at most ${ACCEPT_MAP_LIMITS.into} style lines.`,
  sizesOfEach: (seq: number) => `Name the sizes of each style line ${seq} is made into.`,
  sizesOfPeople: (seq: number, without: number, people: number) => `Name the sizes for line ${seq}: ${without} of its ${people} people have no size yet (a measurement sheet, or sending later).`,
  sizesInSheet: (seq: number) => `Name the sizes for line ${seq}: its people are in the measurement sheet on the request.`,
  sizesOfTotal: (seq: number, total: number) => `Name the sizes for line ${seq}: it asks ${total} pieces in all, not yet by size.`,
  pieces: (seq: number, asked: number, made: number, as: AcceptAs) => `Line ${seq} asked ${asked} pieces; the ${as === 'ORDER' ? 'order' : 'quote'} makes ${made}.`,
})

interface SizeRowLike {
  readonly size: string
  readonly quantity: number
}

/** A line of the request as the accept judges it. */
export interface AcceptLineFacts {
  readonly id: string
  readonly seq: number
  readonly kind: 'CATALOGUE' | 'DESCRIBED' | 'MADE_TO_MEASURE'
  /** A catalogue line's style and colourway (a custom line's own style, if it names one, is only a hint). */
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly sizes: readonly SizeRowLike[]
  /** A described line's total. */
  readonly quantity: number | null
  readonly byPerson: boolean
  /** By person: each person's size in roster order (null: measured by a sheet, or sending later). */
  readonly peopleSizes: readonly (string | null)[]
  readonly note: string | null
  /** The customer's own words: its description, else the garment type. */
  readonly ownWords: string | null
  readonly colourText: string | null
}

/** One style line a described or made-to-measure line is made into (the office's map). */
export interface AcceptInto {
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes?: readonly SizeRowLike[] | undefined
  /** ORDER: a unit price typed by the office (else the customer's list price today). */
  readonly unitPrice?: string | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface AcceptMapEntry {
  readonly lineId: string
  readonly into: readonly AcceptInto[]
}

/** A line of the order (or quote) to make, and the request line it is made from. */
export interface PlannedLine {
  readonly requestLineId: string
  readonly requestSeq: number
  readonly kind: AcceptLineFacts['kind']
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: readonly SizeRowLike[]
  readonly unitPrice: string | undefined
  readonly description: string | null
  readonly note: string | null
  /** Where its problems are said: `request/lines/<seq>` (a catalogue line) or `body/map/<i>/into/<j>` (the office's map). */
  readonly at: string
}

export type AcceptPlan =
  | { readonly kind: 'PLAN'; readonly lines: readonly PlannedLine[]; readonly warnings: readonly string[] }
  | { readonly kind: 'HELD' | 'INVALID'; readonly words: string; readonly issues: readonly Issue[] }

const trimmedOrNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The note of an order (or quote) line made from a described or made-to-measure line: where it came from, never a person's name. */
export function mappedLineNote(number: string | null, line: AcceptLineFacts): string {
  const head = `${number ? `Request ${number}` : 'The request'}, line ${line.seq} (${line.kind === 'MADE_TO_MEASURE' ? 'made to measure' : 'described'})`
  const parts = [line.ownWords ? `${head}: ${line.ownWords}` : head]
  if (line.colourText) parts.push(`Colours: ${line.colourText}`)
  if (line.byPerson) parts.push(line.peopleSizes.length > 0 ? `People: ${line.peopleSizes.length} on the request (their names stay there)` : 'People: in the measurement sheet on the request')
  if (line.note) parts.push(`Customer's note: ${line.note}`)
  const text = parts.join(' · ')
  return text.length <= ACCEPT_MAP_LIMITS.note ? text : `${text.slice(0, ACCEPT_MAP_LIMITS.note - 1)}…`
}

/** The pieces a request line asked (null: not known — people only in a measurement sheet). */
function askedPieces(line: AcceptLineFacts): number | null {
  if (line.byPerson) return line.peopleSizes.length > 0 ? line.peopleSizes.length : null
  if (line.kind === 'DESCRIBED' && line.quantity !== null) return line.quantity
  const sum = line.sizes.reduce((total, row) => total + row.quantity, 0)
  return sum > 0 ? sum : null
}

/** A by-person line's people grouped by size, in the order a size first appears (every person has one). */
function sizesOfPeople(sizes: readonly (string | null)[]): SizeRowLike[] {
  const counts = new Map<string, number>()
  for (const size of sizes) if (size !== null) counts.set(size, (counts.get(size) ?? 0) + 1)
  return [...counts.entries()].map(([size, quantity]) => ({ size, quantity }))
}

/**
 * The accept's plan: refused (INVALID, 400: what the office sent), held (HELD, 409: a line to map first, a made-to-measure line
 * as an order) or the lines to make, in the request's order, each naming its request line (the map), with what to check (pieces
 * asked and made differ). `prices`: the office's typed unit prices of catalogue lines (`body.lines`).
 */
export function acceptPlanOf(input: { readonly number: string | null; readonly as: AcceptAs; readonly lines: readonly AcceptLineFacts[]; readonly map: readonly AcceptMapEntry[]; readonly prices: readonly { readonly lineId: string; readonly unitPrice?: string | undefined }[] }): AcceptPlan {
  const issues: Issue[] = []
  const byId = new Map(input.lines.map((line) => [line.id, line]))
  const isCustom = (line: AcceptLineFacts): boolean => line.kind !== 'CATALOGUE'
  const mapped = new Map<string, { readonly entry: AcceptMapEntry; readonly index: number }>()
  input.map.forEach((entry, index) => {
    const at = `body/map/${index}`
    const line = byId.get(entry.lineId)
    if (!line) return void issues.push({ path: `${at}/lineId`, message: ACCEPT_WORDS.notALine })
    if (!isCustom(line)) return void issues.push({ path: `${at}/lineId`, message: ACCEPT_WORDS.fromCatalogue(line.seq) })
    if (mapped.has(line.id)) return void issues.push({ path: `${at}/lineId`, message: ACCEPT_WORDS.mappedTwice(line.seq) })
    mapped.set(line.id, { entry, index })
    if (entry.into.length === 0) issues.push({ path: `${at}/into`, message: ACCEPT_WORDS.noInto(line.seq) })
    if (entry.into.length > ACCEPT_MAP_LIMITS.into) issues.push({ path: `${at}/into`, message: ACCEPT_WORDS.tooMany(line.seq) })
    entry.into.forEach((into, place) => {
      if (into.sizes && into.sizes.length > 0) for (const message of lineShapeProblems({ styleId: into.styleId, colourwayId: into.colourwayId, sizes: into.sizes, note: null })) issues.push({ path: `${at}/into/${place}/sizes`, message })
      if (into.description && into.description.trim().length > MAX_TEXT.description) issues.push({ path: `${at}/into/${place}/description`, message: `At most ${MAX_TEXT.description} characters.` })
      if (into.note && into.note.trim().length > ACCEPT_MAP_LIMITS.note) issues.push({ path: `${at}/into/${place}/note`, message: `At most ${ACCEPT_MAP_LIMITS.note} characters.` })
    })
  })
  input.prices.forEach((entry, index) => {
    const line = byId.get(entry.lineId)
    if (!line) issues.push({ path: `body/lines/${index}/lineId`, message: ACCEPT_WORDS.notALine })
    else if (isCustom(line)) issues.push({ path: `body/lines/${index}/lineId`, message: ACCEPT_WORDS.priceOnMap(line.seq) })
  })
  if (issues.length > 0) return { kind: 'INVALID', words: issues[0]!.message, issues }

  const ordered = [...input.lines].sort((a, b) => a.seq - b.seq)
  // A made-to-measure line is a quote first (mapping it does not change that); then every custom line needs its map.
  const madeToMeasure = ordered.filter((line) => line.kind === 'MADE_TO_MEASURE').map((line) => line.seq)
  if (input.as === 'ORDER' && madeToMeasure.length > 0) {
    const words = ACCEPT_WORDS.madeToMeasureOrder(madeToMeasure)
    return { kind: 'HELD', words, issues: madeToMeasure.map((seq) => ({ path: `request/lines/${seq}`, message: words })) }
  }
  const unmapped = ordered.filter((line) => isCustom(line) && !mapped.has(line.id)).map((line) => line.seq)
  if (unmapped.length > 0) {
    const words = ACCEPT_WORDS.unmapped(unmapped)
    return { kind: 'HELD', words, issues: unmapped.map((seq) => ({ path: `request/lines/${seq}`, message: words })) }
  }

  const prices = new Map(input.prices.map((entry) => [entry.lineId, entry.unitPrice]))
  const planned: PlannedLine[] = []
  const warnings: string[] = []
  for (const line of ordered) {
    if (!isCustom(line)) {
      planned.push({ requestLineId: line.id, requestSeq: line.seq, kind: line.kind, styleId: line.styleId!, colourwayId: line.colourwayId!, sizes: line.sizes, unitPrice: prices.get(line.id), description: null, note: line.note, at: `request/lines/${line.seq}` })
      continue
    }
    const { entry, index } = mapped.get(line.id)!
    let made = 0
    entry.into.forEach((into, place) => {
      const at = `body/map/${index}/into/${place}`
      let sizes: readonly SizeRowLike[] | null = into.sizes && into.sizes.length > 0 ? into.sizes.map((row) => ({ size: row.size.trim(), quantity: row.quantity })) : null
      if (sizes === null) {
        if (entry.into.length > 1) issues.push({ path: `${at}/sizes`, message: ACCEPT_WORDS.sizesOfEach(line.seq) })
        else if (line.sizes.length > 0) sizes = line.sizes
        else if (line.byPerson) {
          const without = line.peopleSizes.filter((size) => size === null).length
          if (line.peopleSizes.length > 0 && without === 0) sizes = sizesOfPeople(line.peopleSizes)
          else issues.push({ path: `${at}/sizes`, message: line.peopleSizes.length === 0 ? ACCEPT_WORDS.sizesInSheet(line.seq) : ACCEPT_WORDS.sizesOfPeople(line.seq, without, line.peopleSizes.length) })
        } else issues.push({ path: `${at}/sizes`, message: ACCEPT_WORDS.sizesOfTotal(line.seq, line.quantity ?? 0) })
      }
      if (sizes === null) return
      made += sizes.reduce((total, row) => total + row.quantity, 0)
      planned.push({
        requestLineId: line.id,
        requestSeq: line.seq,
        kind: line.kind,
        styleId: into.styleId,
        colourwayId: into.colourwayId,
        sizes,
        unitPrice: into.unitPrice,
        description: trimmedOrNull(into.description),
        note: trimmedOrNull(into.note) ?? mappedLineNote(input.number, line),
        at,
      })
    })
    const asked = askedPieces(line)
    if (asked !== null && made > 0 && asked !== made) warnings.push(ACCEPT_WORDS.pieces(line.seq, asked, made, input.as))
  }
  if (issues.length > 0) return { kind: 'INVALID', words: issues[0]!.message, issues }
  return { kind: 'PLAN', lines: planned, warnings }
}

/** The accept's map as the answer and the audit keep it: each request line and the order (or quote) lines made from it (ids). */
export interface AcceptLineMapEntry {
  readonly requestLineId: string
  readonly requestSeq: number
  readonly into: readonly { readonly lineId: string; readonly seq: number }[]
}

/**
 * The map from the plan and the lines made, in the plan's order: `made` are the new order (or quote) lines in their own order;
 * `left` the plan's places a copy left out (a quote leaves out a style no longer sold), so the made lines pair with the rest.
 */
export function lineMapOf(plan: readonly Pick<PlannedLine, 'requestLineId' | 'requestSeq'>[], made: readonly { readonly id: string; readonly seq: number }[], left: ReadonlySet<number> = new Set()): AcceptLineMapEntry[] {
  const out = new Map<string, { requestLineId: string; requestSeq: number; into: { lineId: string; seq: number }[] }>()
  let next = 0
  plan.forEach((line, place) => {
    const entry = out.get(line.requestLineId) ?? { requestLineId: line.requestLineId, requestSeq: line.requestSeq, into: [] }
    out.set(line.requestLineId, entry)
    if (left.has(place)) return
    const row = made[next]
    next += 1
    if (row) entry.into.push({ lineId: row.id, seq: row.seq })
  })
  return [...out.values()]
}
// ---- end B-CP-077

// ---- B-CP-076 (customer page plan 11 §1.3 D3; review E3, B4): "Your price" in the draft and its carry on accept --------------
/**
 * The customer's own net unit price per draft line (PortalOrderRequestLine.brandUnitPrice, the price grain: typed by its Buyer or
 * Admin, never by a Designer; frozen at Send with the line). Two readings of it, pure:
 *
 *   the draft's value   `draftValueAmount` of the office's Drafts row (review B4: a money-looking name): each line at the price
 *                       we showed the customer, else the customer's own price, × its pieces, in minor units — null when a line
 *                       has neither (never a value that leaves a line out) or there is no line
 *   the carry           accept as an ORDER writes the customer's prices on the order (OrderBrandPrice, source PORTAL) by the
 *                       accept's line map, never by place: one request line made into one order line → a unit row; made into
 *                       several → its amount (its price × the pieces made from it) as a line total on the first of them, or — when
 *                       every request line has its price — one total row for the whole order (the price check then reads the
 *                       order as a whole and never a false "not equal" on one line). A QUOTE takes nothing (the order made later
 *                       offers the take-over).
 */

/** The draft's value at the prices on it, in minor units of its currency (see above); null: a line has no price, or no line. */
export function draftValueOf(lines: readonly { readonly priceShown: string | null; readonly brandUnitPrice: string | null; readonly pieces: number }[], currency: string): number | null {
  if (lines.length === 0) return null
  let sum = 0
  for (const line of lines) {
    const price = line.priceShown ?? line.brandUnitPrice
    const amount = price === null ? null : brandAmountOf({ unitPrice: price, netAmount: null }, line.pieces, currency)
    if (amount === null) return null
    sum += amount
  }
  return sum
}

/** A row of the customer's price the accept writes on the order: a line's unit price or line total, or the order's total (no line). */
export interface CarriedBrandPrice {
  readonly orderLineId: string | null
  readonly unitPrice: string | null
  readonly netAmount: number | null
  /** The request lines it comes from (the audit names them). */
  readonly requestLineIds: readonly string[]
}

/** The customer's prices of an accepted request as rows of the order made from it, by the accept's line map (see above). */
export function brandPricesOfAccept(input: {
  readonly currency: string
  readonly prices: readonly { readonly requestLineId: string; readonly brandUnitPrice: string | null }[]
  readonly map: readonly { readonly requestLineId: string; readonly into: readonly { readonly lineId: string; readonly pieces: number }[] }[]
}): CarriedBrandPrice[] {
  const priceOf = new Map(input.prices.map((entry) => [entry.requestLineId, entry.brandUnitPrice]))
  const made = input.map.filter((entry) => entry.into.length > 0)
  const priced = made.filter((entry) => (priceOf.get(entry.requestLineId) ?? null) !== null)
  if (priced.length === 0) return []
  const amountOf = (entry: (typeof made)[number]): number =>
    brandAmountOf({ unitPrice: priceOf.get(entry.requestLineId)!, netAmount: null }, entry.into.reduce((total, line) => total + line.pieces, 0), input.currency) ?? 0
  const units: CarriedBrandPrice[] = priced.filter((entry) => entry.into.length === 1).map((entry) => ({ orderLineId: entry.into[0]!.lineId, unitPrice: priceOf.get(entry.requestLineId)!, netAmount: null, requestLineIds: [entry.requestLineId] }))
  const split = priced.filter((entry) => entry.into.length > 1)
  if (split.length === 0) return units
  if (priced.length === made.length) return [...units, { orderLineId: null, unitPrice: null, netAmount: made.reduce((total, entry) => total + amountOf(entry), 0), requestLineIds: made.map((entry) => entry.requestLineId) }]
  return [...units, ...split.map((entry) => ({ orderLineId: entry.into[0]!.lineId, unitPrice: null, netAmount: amountOf(entry), requestLineIds: [entry.requestLineId] }))]
}
// ---- end B-CP-076
