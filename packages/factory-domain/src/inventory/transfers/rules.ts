import type { BusinessDate } from '../../core/time'
import type { DdtReason } from '../../documents/model'
import { Dec, parseDecimal, ZERO, type Decimal } from '../../tax/decimal'

/**
 * Transfers between sites (B-W2b-326; SCM-219 a transfer order between two sites, or two companies of the tenant; SCM-220
 * goods in transit), pure: the states, the tiles, what each step needs and why it is held, what is in transit per line, the
 * difference of a line and how it is settled. apps/factory-api modules/inventory/transfers runs the commands; the database
 * (factory-db warehouse-depth guards, B-W2b-277) holds the same rules as the last word.
 *
 *   DRAFT            lines are added, changed and removed; it is shipped (its goods move onto the transit place of the
 *                    sending site with a TRANSFER each, the DDT number is taken) or cancelled
 *   SHIPPED          in transit: the goods are the SENDING site's stock on its transit place until they are received
 *   PARTLY_RECEIVED  part of it arrived (more may come)
 *   RECEIVED         every line arrived in full or says why not (its difference's reason); what is still on the transit
 *                    place stays visible there until the difference is settled: written off (ADJUSTMENT), claimed from
 *                    the carrier (written off too: the claim is money, not stock) or sent back (the ship of that line
 *                    reversed: only while nothing of it arrived)
 *   CANCELLED        a draft that never left
 *
 * Quantities are in the item's base unit (a line's `quantity` is its base quantity: the stock read by the picker is in
 * the base unit). A hide travels whole: its line sends what the hide holds at its place, and it arrives whole or not.
 */

export const TRANSFER_STATUSES = ['DRAFT', 'SHIPPED', 'PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]

/** The transfer's goods are on their way (the design's "In transit"). */
export const IN_TRANSIT_STATUSES: readonly TransferStatus[] = Object.freeze(['SHIPPED', 'PARTLY_RECEIVED'])
export const isInTransit = (status: TransferStatus): boolean => IN_TRANSIT_STATUSES.includes(status)
export const isOpenTransfer = (status: TransferStatus): boolean => status !== 'RECEIVED' && status !== 'CANCELLED'

/** The design's tiles (saved filters): In transit, Arriving today, With differences (a difference not settled yet). */
export const TRANSFER_TILES = ['IN_TRANSIT', 'ARRIVING_TODAY', 'WITH_DIFFERENCES'] as const
export type TransferTile = (typeof TRANSFER_TILES)[number]

/** How a line's difference is settled (factory-db TransferDifferenceResolution). */
export const TRANSFER_RESOLUTIONS = ['ADJUSTMENT', 'CARRIER_CLAIM', 'SENT_BACK'] as const
export type TransferResolution = (typeof TRANSFER_RESOLUTIONS)[number]

/**
 * The reasons a transfer's DDT may print: TRANSFER between sites (the default); between two companies of the tenant the
 * reason the accountant says (SALE, WORK_ON_ACCOUNT, or OTHER in words). factory-domain documents prints each in words.
 */
export const TRANSFER_DDT_REASONS = ['TRANSFER', 'SALE', 'WORK_ON_ACCOUNT', 'OTHER'] as const satisfies readonly DdtReason[]
export type TransferDdtReason = (typeof TRANSFER_DDT_REASONS)[number]

/** Who carries the goods (trasporto a cura del): our own van (SENDER), the receiving company (RECIPIENT), a carrier. */
export const TRANSFER_TRANSPORT = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type TransferTransport = (typeof TRANSFER_TRANSPORT)[number]

/** A difference's reason is a code of the DISCREPANCY reason list (Production › Settings › Reason codes). */
export const DIFFERENCE_REASON_LIST = 'DISCREPANCY' as const

export const TRANSFER_LIMITS = Object.freeze({
  lines: 200,
  note: 2000,
  lineNote: 1000,
  differenceNote: 1000,
  cancelReason: 500,
  reasonText: 200,
  appearance: 200,
  carrierName: 200,
  trackingRef: 100,
  trackingUrl: 500,
  packages: 9999,
  search: 100,
  list: 200,
})

// ---- refusals ---------------------------------------------------------------------------------------------------------

/** A step refused: a 409 whose issue is `refusal/<CODE>` (the screens say their own words from the code). */
export const TRANSFER_REFUSALS = [
  'SAME_SITE',
  'SITE_CLOSED',
  'NO_TRANSIT_PLACE',
  'NOT_A_TRANSIT_PLACE',
  'PLACE_NOT_USABLE',
  'NOT_DRAFT',
  'NOT_IN_TRANSIT',
  'NOT_SHIPPED',
  'NO_LINES',
  'TOO_MANY_LINES',
  'NO_PICK_PLACE',
  'NOT_ENOUGH_STOCK',
  'LOT_NOT_SENT',
  'LOT_REQUIRED',
  'HIDE_REQUIRED',
  'NOT_TRACKED',
  'HIDE_WHOLE',
  'HIDE_ON_ANOTHER_LINE',
  'MORE_THAN_IN_TRANSIT',
  'NO_PUT_PLACE',
  'REASON_UNKNOWN',
  'NOTHING_RECEIVED',
  'NOTHING_TO_SETTLE',
  'REASON_FIRST',
  'SETTLED',
  'SENT_BACK_PART',
  'NO_DDT_SERIES',
  'NO_TRANSFER_SERIES',
  'NO_LOT_SERIES',
  'DDT_NOT_PRINTABLE',
  'NO_DDT',
  'NO_RIGHT_FROM',
  'NO_RIGHT_TO',
] as const
export type TransferRefusal = (typeof TRANSFER_REFUSALS)[number]

export interface TransferProblem {
  readonly code: TransferRefusal
  readonly message: string
}

/** The API's words of each refusal (English; the screens say theirs from the code). */
export const TRANSFER_REFUSAL_WORDS: Readonly<Record<TransferRefusal, string>> = Object.freeze({
  SAME_SITE: 'A transfer goes to another site.',
  SITE_CLOSED: 'Both sites are active.',
  NO_TRANSIT_PLACE: 'The sending site has no transit place: make one under Warehouse › Locations (kind Transit).',
  NOT_A_TRANSIT_PLACE: 'The goods travel on a transit place of the sending site that is not archived.',
  PLACE_NOT_USABLE: 'A place to pick from or to put into is a place of its site, not archived and not a transit place.',
  NOT_DRAFT: 'Only a draft transfer changes its lines, ships or is cancelled.',
  NOT_IN_TRANSIT: 'Goods are received while the transfer is in transit (shipped or partly received).',
  NOT_SHIPPED: 'Nothing of this transfer left yet.',
  NO_LINES: 'A transfer ships once it has a line.',
  TOO_MANY_LINES: 'A transfer has at most 200 lines.',
  NO_PICK_PLACE: 'Every line names the place it is picked from (or the transfer does).',
  NOT_ENOUGH_STOCK: 'A line takes more than its place holds; stock never goes below zero.',
  LOT_NOT_SENT: 'A blocked or rejected lot does not travel.',
  LOT_REQUIRED: 'This material is tracked by lot: name the lot.',
  HIDE_REQUIRED: 'This material is tracked hide by hide: one line per hide.',
  NOT_TRACKED: 'This material has no lots: a line names none.',
  HIDE_WHOLE: 'A hide travels and arrives whole.',
  HIDE_ON_ANOTHER_LINE: 'This hide is on another line of a transfer that has not left.',
  MORE_THAN_IN_TRANSIT: 'More is received than is still in transit on the line.',
  NO_PUT_PLACE: 'Name the place at the receiving site where the goods are put (or the transfer does).',
  REASON_UNKNOWN: 'The reason is not an active code of the Discrepancy reason list.',
  NOTHING_RECEIVED: 'Say what arrived on at least one line, or why a line is short.',
  NOTHING_TO_SETTLE: 'This line has nothing in transit to settle.',
  REASON_FIRST: 'A difference is settled after its reason is said.',
  SETTLED: 'This difference is settled already.',
  SENT_BACK_PART: 'Part of this line arrived: write the rest off or claim it from the carrier.',
  NO_DDT_SERIES: 'The sending company has no single active DDT series: an administrator sets it up under numbering.',
  NO_TRANSFER_SERIES: 'The sending company has no transfer series: an administrator sets it up under numbering.',
  NO_LOT_SERIES: 'The receiving company has no lot series: an administrator sets it up under numbering.',
  DDT_NOT_PRINTABLE: 'The DDT cannot be printed as it stands (the companies’ legal data or addresses).',
  NO_DDT: 'This transfer has no DDT yet: it gets one when it is shipped.',
  NO_RIGHT_FROM: 'This needs inventory.transfers.manage at the sending site.',
  NO_RIGHT_TO: 'This needs inventory.transfers.manage at the receiving site.',
})

export const problem = (code: TransferRefusal, message: string = TRANSFER_REFUSAL_WORDS[code]): TransferProblem => ({ code, message })

// ---- quantities ---------------------------------------------------------------------------------------------------------

const dec = (value: string | number | null | undefined): Decimal => {
  if (value === null || value === undefined) return ZERO
  const parsed = parseDecimal(String(value))
  return parsed ?? ZERO
}

/** A quantity as the API writes it: at most 4 decimals, no trailing zeros. */
export const quantityOut = (value: Decimal): string => {
  const fixed = value.toFixed(4)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** A typed quantity: a decimal above 0 (or 0 when `zero`), at most 4 decimals; else null. */
export function typedQuantity(text: string | null | undefined, zero = false): Decimal | null {
  if (typeof text !== 'string' || !/^\d{1,14}(?:\.\d{1,4})?$/.test(text.trim())) return null
  const value = new Dec(text.trim())
  if (value.isNegative() || (!zero && value.isZero())) return null
  return value
}

/** A move that names a line, as the reads see it. */
export interface LineMove {
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  readonly baseQuantity: string
}

/** What of a line lies on the transit place now: Σ its moves into the place − Σ its moves out of it. */
export function inTransitOf(moves: readonly LineMove[], transitLocationId: string): Decimal {
  let total = ZERO
  for (const move of moves) {
    if (move.toLocationId === transitLocationId) total = total.plus(dec(move.baseQuantity))
    if (move.fromLocationId === transitLocationId) total = total.minus(dec(move.baseQuantity))
  }
  return total.isNegative() ? ZERO : total
}

/** A line's own figures. */
export interface LineFigures {
  /** What left with the ship (null while it is a draft). */
  readonly shippedQuantity: string | null
  readonly receivedQuantity: string
  /** What is still on the transit place. */
  readonly inTransit: string
  readonly differenceReasonCode: string | null
  readonly resolvedAt: string | null
}

/** Left − arrived (0 for a draft line). */
export const differenceOf = (line: Pick<LineFigures, 'shippedQuantity' | 'receivedQuantity'>): Decimal =>
  line.shippedQuantity === null ? ZERO : Dec.max(ZERO, dec(line.shippedQuantity).minus(dec(line.receivedQuantity)))

export const LINE_STATES = ['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'SHORT', 'SETTLED'] as const
export type LineState = (typeof LINE_STATES)[number]

/**
 * DRAFT before the ship; RECEIVED once it all arrived; SETTLED once its difference is settled; SHORT once a reason says
 * why it is short (it waits to be settled); IN_TRANSIT while some of it is still on its way.
 */
export function lineStateOf(line: LineFigures): LineState {
  if (line.shippedQuantity === null) return 'DRAFT'
  if (differenceOf(line).isZero()) return 'RECEIVED'
  if (line.resolvedAt !== null) return 'SETTLED'
  if (line.differenceReasonCode !== null) return 'SHORT'
  return 'IN_TRANSIT'
}

/** A line whose difference waits to be settled (the "With differences" tile). */
export const openDifference = (line: LineFigures): boolean => line.differenceReasonCode !== null && line.resolvedAt === null && !differenceOf(line).isZero()

// ---- the tiles ----------------------------------------------------------------------------------------------------------

export interface TileFacts {
  readonly status: TransferStatus
  readonly expectedOn: BusinessDate | null
  readonly openDifferences: number
}

export function tilesOf(row: TileFacts, today: BusinessDate): TransferTile[] {
  const tiles: TransferTile[] = []
  if (isInTransit(row.status)) tiles.push('IN_TRANSIT')
  if (isInTransit(row.status) && row.expectedOn === today) tiles.push('ARRIVING_TODAY')
  if (row.openDifferences > 0) tiles.push('WITH_DIFFERENCES')
  return tiles
}

/** In transit and expected before today. */
export const isLate = (row: Pick<TileFacts, 'status' | 'expectedOn'>, today: BusinessDate): boolean => isInTransit(row.status) && row.expectedOn !== null && row.expectedOn < today

// ---- the steps ------------------------------------------------------------------------------------------------------------

export interface DraftFacts {
  readonly fromSiteId: string
  readonly toSiteId: string
  readonly fromActive: boolean
  readonly toActive: boolean
  readonly shipOn?: BusinessDate | null
  readonly expectedOn?: BusinessDate | null
}

export interface FieldProblem {
  readonly path: string
  readonly message: string
}

/** A new transfer: another site, both active; expected not before it leaves. */
export function draftProblems(facts: DraftFacts): { refusals: TransferProblem[]; fields: FieldProblem[] } {
  const refusals: TransferProblem[] = []
  const fields: FieldProblem[] = []
  if (facts.fromSiteId === facts.toSiteId) refusals.push(problem('SAME_SITE'))
  if (!facts.fromActive || !facts.toActive) refusals.push(problem('SITE_CLOSED'))
  if (facts.shipOn && facts.expectedOn && facts.expectedOn < facts.shipOn) fields.push({ path: 'expectedOn', message: 'It is expected not before it leaves.' })
  return { refusals, fields }
}

export type ItemTracking = 'NONE' | 'LOT' | 'HIDE' | 'SERIAL'

export interface LineDraftFacts {
  readonly tracking: ItemTracking
  readonly lotId: string | null
  readonly hideId: string | null
  /** The lot's quality status when a lot is named. */
  readonly lotStatus: string | null
  /** The quantity asked, base unit. */
  readonly quantity: Decimal
  /** What the place holds of that stock key now (null: not read). */
  readonly available: Decimal | null
  /** A hide named on another line of a transfer that has not left. */
  readonly hideElsewhere: boolean
}

/** A line: the lot (and hide) the item's tracking asks; a hide whole; a lot that travels; no more than the place holds. */
export function lineProblems(facts: LineDraftFacts): TransferProblem[] {
  const problems: TransferProblem[] = []
  const lots = facts.tracking === 'LOT' || facts.tracking === 'HIDE'
  if (!lots && (facts.lotId || facts.hideId)) problems.push(problem('NOT_TRACKED'))
  if (lots && !facts.lotId) problems.push(problem(facts.tracking === 'HIDE' ? 'HIDE_REQUIRED' : 'LOT_REQUIRED'))
  if (facts.tracking === 'HIDE' && facts.lotId && !facts.hideId) problems.push(problem('HIDE_REQUIRED'))
  if (facts.lotStatus === 'BLOCKED' || facts.lotStatus === 'REJECTED') problems.push(problem('LOT_NOT_SENT'))
  if (facts.hideElsewhere) problems.push(problem('HIDE_ON_ANOTHER_LINE'))
  if (facts.available !== null) {
    if (facts.hideId && !facts.quantity.equals(facts.available)) problems.push(problem('HIDE_WHOLE', `A hide travels whole: this one holds ${quantityOut(facts.available)} at its place.`))
    else if (facts.quantity.greaterThan(facts.available)) problems.push(problem('NOT_ENOUGH_STOCK', `The place holds ${quantityOut(facts.available)}; the line asks ${quantityOut(facts.quantity)}. Stock never goes below zero.`))
  }
  return problems
}

/** One line as the ship reads it. */
export interface ShipLineFacts {
  readonly seq: number
  readonly pickPlaceId: string | null
  readonly quantity: Decimal
  readonly available: Decimal
  readonly hide: boolean
}

/** The ship: a draft with lines, each with a place and the stock it takes. */
export function shipProblems(status: TransferStatus, lines: readonly ShipLineFacts[]): TransferProblem[] {
  if (status !== 'DRAFT') return [problem('NOT_DRAFT')]
  if (lines.length === 0) return [problem('NO_LINES')]
  const problems: TransferProblem[] = []
  const unplaced = lines.filter((line) => line.pickPlaceId === null).map((line) => line.seq)
  if (unplaced.length > 0) problems.push(problem('NO_PICK_PLACE', `Lines ${unplaced.join(', ')} name no place to pick from (nor does the transfer).`))
  const short = lines.filter((line) => line.pickPlaceId !== null && line.quantity.greaterThan(line.available)).map((line) => line.seq)
  if (short.length > 0) problems.push(problem('NOT_ENOUGH_STOCK', `Lines ${short.join(', ')} take more than their place holds now; stock never goes below zero.`))
  return problems
}

/** One line of a receipt as the office types it. */
export interface ReceiveEntry {
  readonly lineId: string
  /** What arrives now, base unit (0: nothing of it now). */
  readonly quantity: Decimal
  readonly differenceReasonCode: string | null
}

/** A line as the receipt reads it. */
export interface ReceiveLineFacts {
  readonly id: string
  readonly seq: number
  readonly hide: boolean
  readonly shippedQuantity: Decimal
  readonly receivedQuantity: Decimal
  readonly inTransit: Decimal
  readonly differenceReasonCode: string | null
  readonly putPlaceId: string | null
}

export function receiveProblems(status: TransferStatus, lines: readonly ReceiveLineFacts[], entries: readonly ReceiveEntry[], knownReasons: ReadonlySet<string>): { refusals: TransferProblem[]; fields: FieldProblem[] } {
  const refusals: TransferProblem[] = []
  const fields: FieldProblem[] = []
  if (!isInTransit(status)) return { refusals: [problem('NOT_IN_TRANSIT')], fields }
  const byId = new Map(lines.map((line) => [line.id, line]))
  let something = false
  for (const [index, entry] of entries.entries()) {
    const line = byId.get(entry.lineId)
    if (!line) {
      fields.push({ path: `lines/${index}/lineId`, message: 'Not a line of this transfer.' })
      continue
    }
    if (entry.quantity.greaterThan(line.inTransit)) refusals.push(problem('MORE_THAN_IN_TRANSIT', `Line ${line.seq}: ${quantityOut(line.inTransit)} is still in transit; ${quantityOut(entry.quantity)} cannot arrive.`))
    if (line.hide && !entry.quantity.isZero() && !entry.quantity.equals(line.inTransit)) refusals.push(problem('HIDE_WHOLE', `Line ${line.seq}: a hide arrives whole.`))
    if (!entry.quantity.isZero() && line.putPlaceId === null) refusals.push(problem('NO_PUT_PLACE', `Line ${line.seq}: name the place it is put into (or the transfer does).`))
    if (entry.differenceReasonCode !== null && !knownReasons.has(entry.differenceReasonCode)) refusals.push(problem('REASON_UNKNOWN', `Line ${line.seq}: ${entry.differenceReasonCode} is not an active code of the Discrepancy list.`))
    if (!entry.quantity.isZero() || (entry.differenceReasonCode !== null && entry.differenceReasonCode !== line.differenceReasonCode)) something = true
  }
  if (!something && refusals.length === 0 && fields.length === 0) refusals.push(problem('NOTHING_RECEIVED'))
  return { refusals, fields }
}

/**
 * Where a transfer goes after a receipt, from its lines as they are now: RECEIVED once every line arrived in full or says
 * why not; else PARTLY_RECEIVED once something arrived; else it stays as it is.
 */
export function statusAfterReceipt(status: TransferStatus, lines: readonly Pick<LineFigures, 'shippedQuantity' | 'receivedQuantity' | 'differenceReasonCode'>[]): TransferStatus {
  const complete = lines.every((line) => differenceOf(line).isZero() || line.differenceReasonCode !== null)
  if (complete) return 'RECEIVED'
  if (lines.some((line) => !dec(line.receivedQuantity).isZero())) return 'PARTLY_RECEIVED'
  return status
}

/** Settling a line's difference. */
export interface SettleFacts {
  readonly status: TransferStatus
  readonly shipped: boolean
  readonly differenceReasonCode: string | null
  readonly resolvedAt: string | null
  readonly receivedQuantity: Decimal
  readonly inTransit: Decimal
}

export function settleProblems(facts: SettleFacts, resolution: TransferResolution): TransferProblem[] {
  if (!facts.shipped || facts.status === 'DRAFT' || facts.status === 'CANCELLED') return [problem('NOT_SHIPPED')]
  if (facts.resolvedAt !== null) return [problem('SETTLED')]
  if (facts.differenceReasonCode === null) return [problem('REASON_FIRST')]
  if (facts.inTransit.isZero()) return [problem('NOTHING_TO_SETTLE')]
  if (resolution === 'SENT_BACK' && !facts.receivedQuantity.isZero()) return [problem('SENT_BACK_PART')]
  return []
}

// ---- what the record offers ---------------------------------------------------------------------------------------------

export interface TransferAction {
  readonly allowed: boolean
  readonly refusal: TransferRefusal | null
}

export interface ActionFacts {
  readonly status: TransferStatus
  readonly lines: number
  /** Lines without a place to pick from (neither theirs nor the transfer's). */
  readonly unplacedLines: number
  readonly shortLines: number
  readonly openDifferences: number
  readonly hasDdt: boolean
  /** inventory.transfers.manage at the sending site / at the receiving site. */
  readonly manageFrom: boolean
  readonly manageTo: boolean
}

const allowed: TransferAction = Object.freeze({ allowed: true, refusal: null })
const held = (refusal: TransferRefusal): TransferAction => ({ allowed: false, refusal })

/** Each step of the record, allowed or held with its reason (the first that holds). */
export function transferActions(facts: ActionFacts) {
  const draft = facts.status === 'DRAFT'
  const from = (when: boolean, refusal: TransferRefusal) => (!facts.manageFrom ? held('NO_RIGHT_FROM') : when ? allowed : held(refusal))
  const to = (when: boolean, refusal: TransferRefusal) => (!facts.manageTo ? held('NO_RIGHT_TO') : when ? allowed : held(refusal))
  return {
    edit: from(draft, 'NOT_DRAFT'),
    lines: from(draft, 'NOT_DRAFT'),
    ship: !facts.manageFrom
      ? held('NO_RIGHT_FROM')
      : !draft
        ? held('NOT_DRAFT')
        : facts.lines === 0
          ? held('NO_LINES')
          : facts.unplacedLines > 0
            ? held('NO_PICK_PLACE')
            : facts.shortLines > 0
              ? held('NOT_ENOUGH_STOCK')
              : allowed,
    cancel: from(draft, 'NOT_DRAFT'),
    receive: to(isInTransit(facts.status), facts.status === 'DRAFT' ? 'NOT_SHIPPED' : 'NOT_IN_TRANSIT'),
    settle: to(facts.openDifferences > 0, 'NOTHING_TO_SETTLE'),
    /** After the ship: the tracking, the expected day and the receiving place (sender or receiver). */
    track: !facts.manageFrom && !facts.manageTo ? held('NO_RIGHT_FROM') : isOpenTransfer(facts.status) ? allowed : held('NOT_IN_TRANSIT'),
    printDdt: facts.hasDdt ? allowed : held('NO_DDT'),
  }
}
export type TransferActions = ReturnType<typeof transferActions>
