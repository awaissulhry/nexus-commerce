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
 * Each item is DECIDED or NOT_DECIDED by what the row holds in the customer's terms (od-fx7, walk W-04): PRODUCT a style OR its
 * own words; SIZING its sizing; COLOUR a colour of ours OR colours in words; PIECES a size run, a total OR its people (or a sheet).
 * Apart from it, `confirmNeeds` marks what the ORDER needs (a style, a colour of ours, pieces by size per row; an address in use)
 * and `confirmReady` whether the row has it already — so a row decided in words still tells the Confirm card what the order asks.
 * The draft's read never says MISSING: the office's Confirm window types what is open, so an item is MISSING only when the
 * Confirm's body still leaves what the order needs open (`typed`, the Confirm's own check: 409 in words). No price item, ever.
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
  /** od-fx7: what the order needs is there already (always true where it needs nothing); the Confirm card asks the rest. */
  readonly confirmReady: boolean
}

export interface StillOpen {
  /** A list of its own (the contracts' output arrays are mutable). */
  readonly items: StillOpenItem[]
  /** Items not DECIDED. */
  readonly openCount: number
  /** What the order needs is not there yet on some item (the office card says the Confirm window asks it; it never holds Send). */
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
  // ---- od-fx7 (walk W-04): what the row holds in the customer's own terms (absent: none).
  /** Its own words (a description, else a garment type). */
  readonly ownWords?: string | null | undefined
  /** Its colours in words. */
  readonly colourText?: string | null | undefined
  /** A described row's total. */
  readonly quantity?: number | null | undefined
  /** A measurement sheet on the row stands for its roster. */
  readonly sheetOnLine?: boolean | undefined
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
  const words = (value: string | null | undefined): boolean => value !== undefined && value !== null && value.trim() !== ''
  /**
   * One item: `decided` in the customer's terms; `needs` — the order needs it; `orderHas` — the order's need is met by the row;
   * `byBody` — the Confirm's body types it. With a Confirm body, what the order needs and still lacks is MISSING.
   */
  const item = (kind: StillOpenKind, line: StillOpenLine | null, decided: boolean, needs: boolean, orderHas: boolean, byBody = false, topic: string | null = null): void => {
    const confirmReady = !needs || orderHas || byBody
    const state: StillOpenState = typed !== undefined && !confirmReady ? 'MISSING' : decided || (typed !== undefined && byBody) ? 'DECIDED' : 'NOT_DECIDED'
    items.push({ kind, lineId: line?.id ?? null, seq: line?.seq ?? null, topic, state, confirmNeeds: needs, confirmReady })
  }
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    const body = typed?.get(line.id)
    const hasPeople = line.byPerson && (line.peopleSizes.length > 0 || line.sheetOnLine === true)
    item('PRODUCT', line, line.styleId !== null || words(line.ownWords), true, line.styleId !== null, body?.style ?? false)
    item('SIZING', line, line.sizing !== null, false, true)
    item('COLOUR', line, line.colourwayId !== null || words(line.colourText), true, line.colourwayId !== null, body?.colour ?? false)
    item('PIECES', line, line.sizes.length > 0 || (line.quantity !== undefined && line.quantity !== null) || hasPeople, true, piecesBySize(line), body?.pieces ?? false)
    for (const choice of line.choices ?? []) item('CHOICE', line, choice.picked !== null, false, true, false, choice.topic)
  }
  item('DATE', null, facts.requestedDate !== null && facts.requestedDate >= facts.today, false, true)
  item('SHIP_TO', null, facts.shipToInUse, true, facts.shipToInUse)
  return { items, openCount: items.filter((entry) => entry.state !== 'DECIDED').length, confirmHeld: items.some((entry) => entry.confirmNeeds && !entry.confirmReady) }
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
