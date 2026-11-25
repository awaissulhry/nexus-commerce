import type { BusinessDate } from '../../core/time'
import type { DraftChoice } from './choices'
import type { LineKind, SizeAsk, Words } from './rules'

/**
 * od-s s.4 (order start, 13-backend § 3 as the Owner's change of 2026-11-25 10:12 (addendum R1–R3) has it): "Still open" — what of a
 * draft order is not decided yet, per product row and for the whole draft. INFORMATION only: nothing is required to start or to Send
 * (the customer may send a draft with nothing in it); it says what the factory still asks before it confirms.
 *
 *   per row   PRODUCT (a style picked) · SIZING (standard sizes or custom size) · COLOUR (a colour of ours) · PIECES (pieces by
 *             size: a size run, or every person of a by-person row with a size) · each CHOICE (picked, or "Not decided yet")
 *   the draft DATE (a requested delivery date) · SHIP_TO (a delivery address in use: the draft's, active, or the customer's default)
 *
 * Each item is DECIDED or NOT_DECIDED; `confirmNeeds` marks what the ORDER needs (a style, a colour, pieces by size per row; an
 * address in use). The draft's read never says MISSING: the office's Confirm window types what is open, so an item is MISSING only
 * when the Confirm's body still leaves it open (`typed`, the Confirm's own check: 409 in words). No price item, ever (money wall).
 * (LATER stays in the states for the earlier "sending later" toggles; nothing is marked so now.)
 */

export const STILL_OPEN_KINDS = ['PRODUCT', 'SIZING', 'COLOUR', 'PIECES', 'CHOICE', 'DATE', 'SHIP_TO'] as const
export type StillOpenKind = (typeof STILL_OPEN_KINDS)[number]
export const STILL_OPEN_STATES = ['DECIDED', 'NOT_DECIDED', 'LATER', 'MISSING'] as const
export type StillOpenState = (typeof STILL_OPEN_STATES)[number]

export const DRAFT_SIZINGS = ['STANDARD', 'MADE_TO_MEASURE'] as const
export type DraftSizing = (typeof DRAFT_SIZINGS)[number]

export interface StillOpenItem {
  readonly kind: StillOpenKind
  /** The product row it is on (PRODUCT, SIZING, COLOUR, PIECES, CHOICE); null: the draft's. */
  readonly lineId: string | null
  readonly seq: number | null
  /** CHOICE: its topic. */
  readonly topic: string | null
  readonly state: StillOpenState
  /** The order needs it at Confirm (a style, a colour, pieces by size per row; an address in use). */
  readonly confirmNeeds: boolean
}

export interface StillOpen {
  /** A list of its own (the contracts' output arrays are mutable). */
  readonly items: StillOpenItem[]
  /** Items not DECIDED. */
  readonly openCount: number
  /** An item the order needs is open (the office card says the Confirm window asks it; it never holds Send). */
  readonly confirmHeld: boolean
}

/** A product row as Still open reads it. */
export interface StillOpenLine {
  readonly id: string
  readonly seq: number
  readonly kind: LineKind
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly sizing: DraftSizing | null
  readonly sizes: readonly SizeAsk[]
  readonly byPerson: boolean
  /** A by-person row: each person's size in roster order (null: measured by a sheet, or later). */
  readonly peopleSizes: readonly (string | null)[]
  readonly choices: readonly DraftChoice[] | null
}

export interface StillOpenFacts {
  readonly lines: readonly StillOpenLine[]
  readonly requestedDate: BusinessDate | null
  readonly today: BusinessDate
  /** The draft's delivery address is active, or it names none and the customer has a default one. */
  readonly shipToInUse: boolean
}

/** What a Confirm body types for a row (the office's map: its style and colour, its sizes). */
export interface ConfirmTyped {
  readonly style: boolean
  readonly colour: boolean
  readonly pieces: boolean
}

/** A row's pieces are known by size: its size run, or every person of a by-person row has a size. */
export const piecesBySize = (line: Pick<StillOpenLine, 'sizes' | 'byPerson' | 'peopleSizes'>): boolean =>
  line.sizes.length > 0 || (line.byPerson && line.peopleSizes.length > 0 && line.peopleSizes.every((size) => size !== null))

/**
 * The draft's Still open list, rows by place then the draft's. `typed` (the Confirm only): what its body types per row id — an item
 * the order needs that is still open after it is MISSING; without `typed` (the draft's read) nothing is MISSING.
 */
export function stillOpenOf(facts: StillOpenFacts, typed?: ReadonlyMap<string, ConfirmTyped>): StillOpen {
  const items: StillOpenItem[] = []
  const state = (decided: boolean, needs: boolean, byBody: boolean): StillOpenState => (decided || byBody ? 'DECIDED' : needs && typed !== undefined ? 'MISSING' : 'NOT_DECIDED')
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    const body = typed?.get(line.id)
    const row = (kind: StillOpenKind, decided: boolean, needs: boolean, byBody = false, topic: string | null = null): void => void items.push({ kind, lineId: line.id, seq: line.seq, topic, state: state(decided, needs, byBody), confirmNeeds: needs })
    row('PRODUCT', line.styleId !== null, true, body?.style ?? false)
    row('SIZING', line.sizing !== null, false)
    row('COLOUR', line.colourwayId !== null, true, body?.colour ?? false)
    row('PIECES', piecesBySize(line), true, body?.pieces ?? false)
    for (const choice of line.choices ?? []) row('CHOICE', choice.picked !== null, false, false, choice.topic)
  }
  items.push({ kind: 'DATE', lineId: null, seq: null, topic: null, state: facts.requestedDate !== null && facts.requestedDate >= facts.today ? 'DECIDED' : 'NOT_DECIDED', confirmNeeds: false })
  items.push({ kind: 'SHIP_TO', lineId: null, seq: null, topic: null, state: state(facts.shipToInUse, true, false), confirmNeeds: true })
  return { items, openCount: items.filter((item) => item.state !== 'DECIDED').length, confirmHeld: items.some((item) => item.confirmNeeds && item.state !== 'DECIDED') }
}

/** The Confirm's 409 in words: what the order still needs after its body (the office types it in the Confirm window), or null. */
export function confirmHeldWords(open: StillOpen, lineCount: number): Words | null {
  if (lineCount === 0) return { it: 'Aggiungi almeno un prodotto prima di confermare.', en: 'Add at least one product before it is confirmed.' }
  const missing = open.items.filter((item) => item.state === 'MISSING')
  if (missing.length === 0) return null
  const rows = new Map<number, StillOpenKind[]>()
  for (const item of missing) if (item.seq !== null) rows.set(item.seq, [...(rows.get(item.seq) ?? []), item.kind])
  const en: Record<string, string> = { PRODUCT: 'its style', COLOUR: 'its colour', PIECES: 'its pieces by size' }
  const it: Record<string, string> = { PRODUCT: 'il modello', COLOUR: 'il colore', PIECES: 'i pezzi per taglia' }
  const parts = (words: Record<string, string>, line: string, and: string) => [...rows.entries()].sort(([a], [b]) => a - b).map(([seq, kinds]) => `${line} ${seq} ${kinds.map((kind) => words[kind]).join(` ${and} `)}`)
  const address = missing.some((item) => item.kind === 'SHIP_TO')
  const enParts = [...parts(en, 'line', 'and'), ...(address ? ['a delivery address (on the draft, or the customer\'s default)'] : [])]
  const itParts = [...parts(it, 'riga', 'e'), ...(address ? ['un indirizzo di consegna (sulla bozza, o quello predefinito del cliente)'] : [])]
  return { it: `Prima di confermare serve ancora: ${itParts.join('; ')}.`, en: `Before it is confirmed, the order still needs: ${enParts.join('; ')}.` }
}
