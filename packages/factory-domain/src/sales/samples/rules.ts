import type { Issue } from '../../core/errors'

/**
 * Sample rounds (B-W2b-246; SAL-311 sample orders, SAL-316 sample shipments, MES-018 sample and prototype work orders; design
 * products.samples SCR-110: the rounds board, "New sample request", "Move to…", the round's Request, Sample and Shipments
 * tabs), pure. factory-db samples.prisma (B-W2b-212) holds the rows and the …_changes_samples_w2b_guards triggers repeat every
 * rule below for every login; this file says each refusal FIRST, in words, so a person never meets the database's message.
 *
 * A round asks for samples of one style made from a pinned revision: what kind (proto, fit, salesman, pre-production, a CE
 * test sample, a sample the brand asked for), which round of that kind ("Fit · round 2"), for whom (the brand or customer; none:
 * internal), the colourways, sizes and quantities, by when, and what the customer is charged (a price). It sits on the board
 * in one of four manual stages, moved in any order; it is DECIDED only with its decision (B-W2b-252: the office, or the brand by
 * link or portal) and CANCELLED with why. Both are final:
 *
 *   REQUESTED ⇄ IN_MAKING ⇄ SENT ⇄ UNDER_REVIEW   (any order, by hand: "Move to…")
 *        └────────── cancel (why) ──────────▶ CANCELLED          decision (B-W2b-252) ──▶ DECIDED
 *
 * The revision changes only while REQUESTED. A sample work order (WorkOrderKind SAMPLE) makes it on the floor like any other
 * work order (W1's release, cutting, bundles, scans and the W2b-1 pay rules); making one moves a REQUESTED round to IN_MAKING.
 * A sample shipment goes to a party (OUTBOUND: the brand, a notified body, an agent) or comes back (RETURN), with its courier
 * and tracking; sent and received are set once each, received only after sent; an outbound shipment sent moves the round to
 * SENT (from REQUESTED or IN_MAKING), received moves it to UNDER_REVIEW (from SENT). Never backwards on its own.
 */

export const SAMPLE_KINDS = ['PROTO', 'FIT', 'SALESMAN', 'PRE_PRODUCTION', 'CERTIFICATION', 'BRAND'] as const
export type SampleKind = (typeof SAMPLE_KINDS)[number]

export const SAMPLE_STAGES = ['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW', 'DECIDED', 'CANCELLED'] as const
export type SampleStage = (typeof SAMPLE_STAGES)[number]
/** The stages a person moves a round between, in any order ("Move to…", a drag on the board). */
export const MANUAL_STAGES = ['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW'] as const satisfies readonly SampleStage[]
export type ManualStage = (typeof MANUAL_STAGES)[number]
/** The board's lanes (SCR-110), in order: a cancelled round is off the board (the list shows it). */
export const BOARD_LANES = ['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW', 'DECIDED'] as const satisfies readonly SampleStage[]
export const CLOSED_STAGES = ['DECIDED', 'CANCELLED'] as const satisfies readonly SampleStage[]
export const isOpenStage = (stage: SampleStage): boolean => !(CLOSED_STAGES as readonly string[]).includes(stage)
export const isManualStage = (stage: string): stage is ManualStage => (MANUAL_STAGES as readonly string[]).includes(stage)

export const SAMPLE_DECISIONS = ['APPROVED', 'APPROVED_WITH_COMMENTS', 'REJECTED'] as const
export type SampleDecision = (typeof SAMPLE_DECISIONS)[number]
export const SAMPLE_DECISION_VIAS = ['OFFICE', 'PORTAL', 'LINK'] as const
export const SAMPLE_TEST_RESULTS = ['PASSED', 'FAILED'] as const
export const SHIPMENT_DIRECTIONS = ['OUTBOUND', 'RETURN'] as const
export type ShipmentDirection = (typeof SHIPMENT_DIRECTIONS)[number]

type Words = { readonly it: string; readonly en: string }

/** What each kind is called on a card ("Fit · round 2"); the design's type list. */
export const KIND_WORDS: Readonly<Record<SampleKind, Words>> = Object.freeze({
  PROTO: { it: 'Prototipo', en: 'Proto' },
  FIT: { it: 'Fit', en: 'Fit' },
  SALESMAN: { it: 'Campionario vendita', en: 'Salesman' },
  PRE_PRODUCTION: { it: 'Pre-produzione', en: 'Pre-production' },
  CERTIFICATION: { it: 'Campione per prova CE', en: 'CE test sample' },
  BRAND: { it: 'Campione del brand', en: 'Brand sample' },
})

export const STAGE_WORDS: Readonly<Record<SampleStage, Words>> = Object.freeze({
  REQUESTED: { it: 'Richiesto', en: 'Requested' },
  IN_MAKING: { it: 'In lavorazione', en: 'In making' },
  SENT: { it: 'Spedito', en: 'Sent' },
  UNDER_REVIEW: { it: 'In valutazione', en: 'Under review' },
  DECIDED: { it: 'Deciso', en: 'Decided' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
})

/** "Fit · round 2" / "Fit · giro 2". */
export const roundLabel = (kind: SampleKind, roundNo: number, locale: 'it' | 'en' = 'en'): string =>
  `${KIND_WORDS[kind][locale]} · ${locale === 'it' ? 'giro' : 'round'} ${roundNo}`

/** The database's limits (…_changes_samples_w2b_guards), said first. */
export const SAMPLE_LIMITS = Object.freeze({
  cells: 200,
  cellQuantity: 1000,
  size: 40,
  roundNo: 999,
  instructions: 4000,
  testZones: 1000,
  cancelReason: 1000,
  /** chargeAmountMinor: an int column. */
  chargeMinor: 2_147_483_647,
  carrierName: 100,
  trackingNumber: 100,
  trackingUrl: 2000,
  shipmentNote: 1000,
  list: 200,
})

/** Every refusal of the module, a code with its words (a 409 whose issue is `refusal/<CODE>`). */
export const SAMPLE_REFUSALS = [
  'ROUND_CLOSED',
  'SAME_STAGE',
  'DECIDED_BY_DECISION',
  'CANCEL_WITH_REASON',
  'REVISION_FROZEN',
  'REVISION_OBSOLETE',
  'NO_REVISION',
  'STYLE_CLOSED',
  'CHARGE_INTERNAL',
  'CERTIFICATION_ONLY',
  'SHIPMENT_ROUND_CANCELLED',
  'SHIPMENT_SENT',
  'SENT_ONCE',
  'RECEIVED_ONCE',
  'RECEIVED_BEFORE_SENT',
  'RETURN_NO_ADDRESS',
  'NO_WORK_ORDER',
  'LINE_OF_ANOTHER_PARTY',
  // B-W2b-284: a sample work order without an order line is for an internal or uncharged proto, fit or salesman round only.
  'ORDER_LINE_NEEDED',
] as const
export type SampleRefusalCode = (typeof SAMPLE_REFUSALS)[number]
export interface SampleRefusal {
  readonly code: SampleRefusalCode
  readonly message: string
}
const refusal = (code: SampleRefusalCode, message: string): SampleRefusal => ({ code, message })

export interface RoundFacts {
  readonly number: string
  readonly stage: SampleStage
}

const closedWords = (round: RoundFacts): string => `Sample round ${round.number} is ${round.stage === 'DECIDED' ? 'decided' : 'cancelled'}`

/** Why the round's stage cannot move to `to` by hand (null: it can). */
export function stageMoveRefusal(round: RoundFacts, to: SampleStage): SampleRefusal | null {
  if (!isOpenStage(round.stage)) return refusal('ROUND_CLOSED', `${closedWords(round)}: its stage no longer moves.`)
  if (to === 'DECIDED') return refusal('DECIDED_BY_DECISION', `A round is decided by recording its decision (Decide on the sample), not by moving it.`)
  if (to === 'CANCELLED') return refusal('CANCEL_WITH_REASON', `Cancel sample round ${round.number} with why (Cancel round), not by moving it.`)
  if (to === round.stage) return refusal('SAME_STAGE', `Sample round ${round.number} is already ${STAGE_WORDS[to].en.toLowerCase()}.`)
  return null
}

/** Why the round's request cannot change these fields (null: it can). The revision only while REQUESTED. */
export function roundEditRefusal(round: RoundFacts & { readonly revision: number }, fields: readonly string[]): SampleRefusal | null {
  if (!isOpenStage(round.stage)) return refusal('ROUND_CLOSED', `${closedWords(round)}: its request no longer changes.`)
  if (fields.includes('revisionId') && round.stage !== 'REQUESTED') {
    return refusal('REVISION_FROZEN', `Sample round ${round.number} is ${STAGE_WORDS[round.stage].en.toLowerCase()}: it is made from revision ${round.revision} (pinned). The revision changes only while it is requested.`)
  }
  return null
}

export function cancelRefusal(round: RoundFacts): SampleRefusal | null {
  return isOpenStage(round.stage) ? null : refusal('ROUND_CLOSED', `${closedWords(round)}: it is not cancelled again.`)
}

/** A revision a round is made from: a DRAFT or the RELEASED one, never an OBSOLETE one. */
export function revisionRefusal(revision: { readonly revision: number; readonly status: string }): SampleRefusal | null {
  return revision.status === 'OBSOLETE' ? refusal('REVISION_OBSOLETE', `Revision ${revision.revision} is obsolete: a sample is made from the released revision or a draft.`) : null
}

/** A style without any revision yet: samples are made from one (pinned). */
export const noRevisionRefusal = (styleCode: string): SampleRefusal =>
  refusal('NO_REVISION', `Style ${styleCode} has no revision yet: start revision 1 (Products › Styles) before asking for samples.`)

/** A style a new round is asked for: not archived, not discontinued. */
export function styleRefusal(style: { readonly code: string; readonly status: string; readonly lifecycle: string }): SampleRefusal | null {
  if (style.status === 'ARCHIVED') return refusal('STYLE_CLOSED', `Style ${style.code} is archived: reactivate it before asking for samples.`)
  if (style.lifecycle === 'DISCONTINUED') return refusal('STYLE_CLOSED', `Style ${style.code} is discontinued: no new samples are made of it.`)
  return null
}

/** A charge goes to the round's customer: an internal round charges nobody. */
export function chargeRefusal(partyId: string | null, charged: boolean): SampleRefusal | null {
  return charged && partyId === null ? refusal('CHARGE_INTERNAL', 'An internal round charges nobody: name the customer, or leave the charge out.') : null
}

/** The sizes and zones sent to the notified body belong to a CE test sample (CERTIFICATION) only. */
export function testZonesRefusal(kind: SampleKind, testZones: string | null): SampleRefusal | null {
  return testZones !== null && kind !== 'CERTIFICATION' ? refusal('CERTIFICATION_ONLY', 'Test zones are written on a CE test sample (certification round) only.') : null
}

// ---- cells ---------------------------------------------------------------------------------------------------------------

export interface SampleCell {
  readonly colourwayId?: string | null | undefined
  readonly size: string
  readonly quantity: number
}

/** The cells as the database keeps them: `{colourwayId?, size, quantity}`, no key for "any colourway". */
export const storedCells = (cells: readonly SampleCell[]): { colourwayId?: string; size: string; quantity: number }[] =>
  cells.map((cell) => ({ ...(cell.colourwayId ? { colourwayId: cell.colourwayId } : {}), size: cell.size, quantity: cell.quantity }))

/** Reads the stored JSON back (rows the database already checked); anything else is dropped. */
export function cellsOf(value: unknown): { colourwayId: string | null; size: string; quantity: number }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((cell) => {
    if (!cell || typeof cell !== 'object') return []
    const { colourwayId, size, quantity } = cell as Record<string, unknown>
    if (typeof size !== 'string' || typeof quantity !== 'number') return []
    return [{ colourwayId: typeof colourwayId === 'string' ? colourwayId : null, size, quantity }]
  })
}

/**
 * What is wrong with a round's cells (empty: nothing), as the database checks them: 1 to 200 cells, each a size of the style's
 * range, a whole quantity from 1 to 1000, a colourway of the style when one is named, each colourway and size once.
 */
export function cellsProblems(cells: readonly SampleCell[], style: { readonly code: string; readonly sizes: readonly string[]; readonly colourwayIds: readonly string[] }, path: string): Issue[] {
  if (cells.length < 1 || cells.length > SAMPLE_LIMITS.cells) return [{ path, message: `Name 1 to ${SAMPLE_LIMITS.cells} cells (a colourway, a size and a quantity).` }]
  const problems: Issue[] = []
  const seen = new Set<string>()
  cells.forEach((cell, index) => {
    const at = `${path}/${index}`
    if (!style.sizes.includes(cell.size)) problems.push({ path: `${at}/size`, message: `Size ${cell.size} is not in style ${style.code}'s size range.` })
    if (!Number.isSafeInteger(cell.quantity) || cell.quantity < 1 || cell.quantity > SAMPLE_LIMITS.cellQuantity) problems.push({ path: `${at}/quantity`, message: `Expected whole pieces from 1 to ${SAMPLE_LIMITS.cellQuantity}.` })
    if (cell.colourwayId && !style.colourwayIds.includes(cell.colourwayId)) problems.push({ path: `${at}/colourwayId`, message: `Not a colourway of style ${style.code}.` })
    const key = `${cell.colourwayId ?? '-'}/${cell.size}`
    if (seen.has(key)) problems.push({ path: at, message: `Size ${cell.size} of this colourway is named twice.` })
    seen.add(key)
  })
  return problems
}

export const piecesOf = (cells: readonly { readonly quantity: number }[]): number => cells.reduce((sum, cell) => sum + cell.quantity, 0)

// ---- the sample work order (MES-018) --------------------------------------------------------------------------------------

export function workOrderRefusal(round: RoundFacts): SampleRefusal | null {
  return isOpenStage(round.stage) ? null : refusal('NO_WORK_ORDER', `${closedWords(round)}: no work order is made for it.`)
}

/** A round for a customer is made on that customer's order lines (the order that charges the samples). */
export function lineRefusal(round: { readonly partyId: string | null }, line: { readonly partyId: string; readonly orderNumber: string; readonly seq: number }): SampleRefusal | null {
  return round.partyId !== null && line.partyId !== round.partyId
    ? refusal('LINE_OF_ANOTHER_PARTY', `${line.orderNumber} line ${line.seq} is another customer's order: the round's samples are made on its own customer's order.`)
    : null
}

/** One order line the sample work order is made on, as the plan reads it. */
export interface LineForCells {
  readonly id: string
  readonly colourwayId: string
  readonly orderNumber: string
  readonly seq: number
}

/**
 * The round's cells per order line, as W1's work order takes them (`lines[].sizes`): each line takes the cells of its
 * colourway; the cells that name no colourway go to the line when exactly one line is named (else the caller names the
 * sizes of each line). `left`: round cells no line takes (made later, on another work order).
 */
export function cellsForLines(
  cells: readonly { readonly colourwayId: string | null; readonly size: string; readonly quantity: number }[],
  lines: readonly LineForCells[],
  path: string,
): { readonly lines: { salesOrderLineId: string; sizes: { size: string; quantity: number }[] }[]; readonly left: { colourwayId: string | null; size: string; quantity: number }[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const anyColour = cells.filter((cell) => cell.colourwayId === null)
  if (anyColour.length > 0 && lines.length > 1) {
    problems.push({ path, message: 'The round names sizes without a colourway: name the sizes of each order line.' })
  }
  const taken = new Set<number>()
  const planned = lines.map((line, index) => {
    const sizes: { size: string; quantity: number }[] = []
    cells.forEach((cell, cellIndex) => {
      const mine = cell.colourwayId === line.colourwayId || (cell.colourwayId === null && lines.length === 1)
      if (!mine) return
      // One size per line (W1's cell): a colourway's cell and an "any colourway" cell of the same size add up.
      const same = sizes.find((entry) => entry.size === cell.size)
      if (same) same.quantity += cell.quantity
      else sizes.push({ size: cell.size, quantity: cell.quantity })
      taken.add(cellIndex)
    })
    if (sizes.length === 0) problems.push({ path: `${path}/${index}`, message: `${line.orderNumber} line ${line.seq}: the round asks nothing in its colourway.` })
    return { salesOrderLineId: line.id, sizes }
  })
  return { lines: planned, left: cells.filter((_, index) => !taken.has(index)), problems }
}

// ---- the sample work order without an order line (B-W2b-284; W2b-5 wave 34's nullable cell) --------------------------------

/**
 * The kinds whose round may be made without an order line: a proto, fit or salesman sample that no order charges (the
 * factory's own development, or a brand's round it does not charge). A pre-production, CE test or brand sample belongs to the
 * order it is made for, and a charged round is made on the order that charges it.
 */
export const WITHOUT_LINE_KINDS = ['PROTO', 'FIT', 'SALESMAN'] as const satisfies readonly SampleKind[]

/** Why the round's samples cannot be made without an order line (null: they can). */
export function withoutLineRefusal(round: RoundFacts & { readonly kind: SampleKind; readonly charged: boolean }): SampleRefusal | null {
  if (!(WITHOUT_LINE_KINDS as readonly string[]).includes(round.kind)) {
    const what = round.kind === 'PRE_PRODUCTION' ? 'A pre-production sample' : round.kind === 'CERTIFICATION' ? 'A CE test sample' : 'A brand sample'
    return refusal('ORDER_LINE_NEEDED', `${what} is made on the order line it belongs to: pick an order line (only a proto, fit or salesman round that charges nobody is made without one).`)
  }
  if (round.charged) return refusal('ORDER_LINE_NEEDED', `Sample round ${round.number} is charged to its customer: its samples are made on the order that charges them (pick an order line).`)
  return null
}

/** A cell of a sample work order made without an order line: one colourway, one size, its pieces. */
export interface CellWithoutLine {
  readonly colourwayId: string
  readonly size: string
  readonly quantity: number
}

/**
 * The round's cells as a work order without an order line takes them: each keeps its colourway; a cell of no colourway
 * ("Any colourway") takes the colourway asked, else the style's only colourway; a colourway and size named twice add up
 * (one work order cell per colourway and size). `problems` at `path` say what is missing, in words.
 */
export function cellsWithoutLine(
  cells: readonly { readonly colourwayId: string | null; readonly size: string; readonly quantity: number }[],
  style: { readonly code: string; readonly sizes: readonly string[]; readonly colourwayIds: readonly string[] },
  colourwayId: string | null,
  path: string,
): { readonly cells: CellWithoutLine[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  if (colourwayId !== null && !style.colourwayIds.includes(colourwayId)) problems.push({ path: `${path}/colourwayId`, message: `Not a colourway of style ${style.code}.` })
  const anyColour = colourwayId ?? (style.colourwayIds.length === 1 ? style.colourwayIds[0]! : null)
  if (cells.length === 0) problems.push({ path, message: 'The round names no cells: write its colourways, sizes and pieces on its Request first.' })
  if (anyColour === null && cells.some((cell) => cell.colourwayId === null)) {
    problems.push({ path: `${path}/colourwayId`, message: `The round names sizes without a colourway: pick the colourway of style ${style.code} they are made in.` })
  }
  const made: CellWithoutLine[] = []
  for (const cell of cells) {
    const colour = cell.colourwayId ?? anyColour
    if (colour === null) continue
    if (!style.sizes.includes(cell.size)) problems.push({ path, message: `Size ${cell.size} is not in style ${style.code}'s size range.` })
    const same = made.find((entry) => entry.colourwayId === colour && entry.size === cell.size)
    if (same) made[made.indexOf(same)] = { ...same, quantity: same.quantity + cell.quantity }
    else made.push({ colourwayId: colour, size: cell.size, quantity: cell.quantity })
  }
  return { cells: made, problems }
}

// ---- shipments (SAL-316) --------------------------------------------------------------------------------------------------

export interface ShipmentFacts {
  readonly direction: ShipmentDirection
  readonly sentAt: Date | null
  readonly receivedAt: Date | null
}

export function shipmentAddRefusal(round: RoundFacts): SampleRefusal | null {
  return round.stage === 'CANCELLED' ? refusal('SHIPMENT_ROUND_CANCELLED', `Sample round ${round.number} is cancelled: nothing more is sent for it.`) : null
}

/** A shipment's sent and received, each set once, received only after sent (the instants as they would be after the change). */
export function shipmentDatesRefusal(shipment: ShipmentFacts, change: { readonly sentAt?: Date | null | undefined; readonly receivedAt?: Date | null | undefined }): SampleRefusal | null {
  if (change.sentAt !== undefined && shipment.sentAt !== null && (change.sentAt === null || change.sentAt.getTime() !== shipment.sentAt.getTime())) {
    return refusal('SENT_ONCE', 'The shipment was already sent: when it was sent stays as it was.')
  }
  if (change.receivedAt !== undefined && shipment.receivedAt !== null && (change.receivedAt === null || change.receivedAt.getTime() !== shipment.receivedAt.getTime())) {
    return refusal('RECEIVED_ONCE', 'The shipment was already received: when it arrived stays as it was.')
  }
  const sentAt = change.sentAt !== undefined ? change.sentAt : shipment.sentAt
  const receivedAt = change.receivedAt !== undefined ? change.receivedAt : shipment.receivedAt
  if (receivedAt && (!sentAt || receivedAt.getTime() < sentAt.getTime())) {
    return refusal('RECEIVED_BEFORE_SENT', sentAt ? 'A shipment arrives after it was sent: check both times.' : 'Say when the shipment was sent before when it arrived.')
  }
  return null
}

export function shipmentRemoveRefusal(shipment: ShipmentFacts): SampleRefusal | null {
  return shipment.sentAt ? refusal('SHIPMENT_SENT', 'The shipment was sent: it stays on the round (only a shipment not sent yet is removed).') : null
}

export function returnAddressRefusal(direction: ShipmentDirection, shipToAddressId: string | null | undefined): SampleRefusal | null {
  return direction === 'RETURN' && shipToAddressId ? refusal('RETURN_NO_ADDRESS', 'A return comes back to us: it names no address of the party.') : null
}

/** The stage an outbound shipment moves its round to when it is sent or received (null: it stays). Never backwards. */
export function stageAfterShipment(stage: SampleStage, direction: ShipmentDirection, what: 'SENT' | 'RECEIVED'): ManualStage | null {
  if (direction !== 'OUTBOUND') return null
  if (what === 'SENT' && (stage === 'REQUESTED' || stage === 'IN_MAKING')) return 'SENT'
  if (what === 'RECEIVED' && stage === 'SENT') return 'UNDER_REVIEW'
  return null
}

export const TRACKING_URL = /^https:\/\/\S+$/

// ---- the list's tiles (SCR-110 "Saved-filter tiles") ----------------------------------------------------------------------

/** Open: on the board, not decided; due this week; late (open, due before today); the customer's decision awaited (under review with a customer); rejected this month; all. */
export const ROUND_TILES = ['OPEN', 'DUE_THIS_WEEK', 'LATE', 'WAITING_DECISION', 'REJECTED_THIS_MONTH', 'ALL'] as const
export type RoundTile = (typeof ROUND_TILES)[number]

/** Days past due of an open round (null: not late, no due day, or closed). */
export function daysLate(stage: SampleStage, dueDate: string | null, today: string): number | null {
  if (!dueDate || !isOpenStage(stage) || dueDate >= today) return null
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000)
}

/** The next round number of a kind for a style: one more than the highest so far. */
export const nextRoundNo = (existing: readonly number[]): number => (existing.length === 0 ? 1 : Math.max(...existing) + 1)
