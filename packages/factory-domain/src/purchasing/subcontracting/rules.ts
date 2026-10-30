import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode, toMinorUnits, UNIT_PRICE, type CurrencyCode, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { decimalOf } from '../../product/units/units'

/**
 * Subcontracting (B-W2a-25; SCM-138 subcontract order, SCM-140 send the kit, SCM-141 stock at each subcontractor,
 * SCM-142 receive back; design purchasing.subcontracting, floor.kits; factory-db subcontract.prisma), pure: work of one
 * work order sent to an outside workshop (a terzista: CMT sewing, embroidery, armour pockets, finishing).
 *
 *   order       one work order (RELEASED or IN_PROGRESS: its operations are frozen), one workshop (a party with the
 *               SUBCONTRACTOR role, ACTIVE) and its stock location on the work order's site (kind SUBCONTRACTOR, owned
 *               by the workshop; one per workshop and site). DRAFT → ISSUED (the job goes to the workshop) → AT_WORKSHOP
 *               (the kit or the pieces went out) → PARTLY_RECEIVED → RECEIVED (every piece back) → CLOSED; ISSUED →
 *               DRAFT to change it; DRAFT or ISSUED → CANCELLED while nothing is out. The …_supply_w2a_guards trigger
 *               holds the same moves.
 *   operations  each one an operation of the work order (its routing step: the step's workshop, fee per piece and
 *               transit days are the defaults), how many pieces (per cell of the size grid, adding up), the fee per
 *               piece (a cost), when they are due back; amount = pieces × fee, rounded once to minor units; the order's
 *               amount is their sum. Changed only while DRAFT; afterwards only the counts sent and back move
 *               (back good + defective + scrapped ≤ sent ≤ pieces).
 *   kit         lines of our material to send (PLANNED, from the work order's planned materials or typed), each SENT
 *               with the TRANSFER move that put it into the workshop's location (it stays ours, in our books) and the
 *               DDT for work on our behalf it travelled with; a SENT line comes back PLANNED when it never left (its
 *               transfer reversed, its DDT cancelled first).
 *   back        what the workshop returns, per operation and per bundle: good, defective, scrapped there; the order
 *               is RECEIVED once every operation has all its pieces back, else PARTLY_RECEIVED.
 *   stock       our stock at a workshop is the ledger's balance at its location (SCM-141).
 *
 * Fees and amounts are costs (money.cost, office only). Nothing here reads or writes the database.
 */

export const SUBCONTRACT_ORDER_STATUSES = ['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
export type SubcontractOrderStatus = (typeof SUBCONTRACT_ORDER_STATUSES)[number]

export const KIT_LINE_STATUSES = ['PLANNED', 'SENT', 'CANCELLED'] as const
export type KitLineStatus = (typeof KIT_LINE_STATUSES)[number]

/** Where the kit stands, as the list shows it: nothing planned, to send, partly sent, all sent. */
export const KIT_STATES = ['NONE', 'TO_SEND', 'PARTLY_SENT', 'SENT'] as const
export type KitState = (typeof KIT_STATES)[number]

/** The orders whose goods are, or may go, out: the list's "open" ones. */
export const OPEN_STATUSES: readonly SubcontractOrderStatus[] = ['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED']
/** Something of the order is (or may be) at the workshop: the kit may go out and goods come back. */
export const OUT_STATUSES: readonly SubcontractOrderStatus[] = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED']
/** Due back: the order waits for goods (late when its date passed). */
export const DUE_STATUSES: readonly SubcontractOrderStatus[] = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED']
/** Goods come back only once something went out. */
export const RECEIVING_STATUSES: readonly SubcontractOrderStatus[] = ['AT_WORKSHOP', 'PARTLY_RECEIVED']

/** The work order states an order is made for (its operations are frozen; ON_HOLD, DRAFT and the ended ones are not). */
export const WORK_ORDER_STATES = ['RELEASED', 'IN_PROGRESS'] as const

export const SEQ_STEP = 10
export const MAX_OPERATIONS = 50
export const MAX_KIT_LINES = 200
/** At most this many lines per receipt or per send. */
export const MAX_LINES_PER_ACT = 200

const MOVES: Readonly<Record<SubcontractOrderStatus, readonly SubcontractOrderStatus[]>> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['DRAFT', 'AT_WORKSHOP', 'CANCELLED'],
  AT_WORKSHOP: ['ISSUED', 'PARTLY_RECEIVED', 'RECEIVED'],
  PARTLY_RECEIVED: ['AT_WORKSHOP', 'RECEIVED'],
  RECEIVED: ['PARTLY_RECEIVED', 'CLOSED'],
  CLOSED: [],
  CANCELLED: [],
}

/** The order may move from `from` to `to` (the trigger's list). */
export const canMove = (from: SubcontractOrderStatus, to: SubcontractOrderStatus): boolean => MOVES[from].includes(to)

const STATUS_WORDS: Readonly<Record<SubcontractOrderStatus, string>> = {
  DRAFT: 'a draft',
  ISSUED: 'issued to the workshop',
  AT_WORKSHOP: 'at the workshop',
  PARTLY_RECEIVED: 'partly back',
  RECEIVED: 'back',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
}
export const statusWords = (status: SubcontractOrderStatus): string => STATUS_WORDS[status]

// ---- money ----------------------------------------------------------------------------------------------------------

/** A fee per piece as stored: Decimal(18, 6), 0 or more. */
export const isFee = (value: string): boolean => fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale) && !decimalOf(value, 'pricePerPiece').isNegative()

/** An operation's amount: pieces × fee per piece, rounded once (half up) to the currency's minor units. */
export function operationAmount(pieces: number, pricePerPiece: string, currency: CurrencyCode): MinorUnits {
  return toMinorUnits(decimalOf(pricePerPiece, 'pricePerPiece').times(pieces), currency)
}

/** The order's amount: the sum of its operations' (the trigger checks it at the issue). */
export const orderAmount = (operations: readonly { readonly netAmount: MinorUnits }[]): MinorUnits => operations.reduce((sum, operation) => sum + operation.netAmount, 0)

/** The fee of pieces back good: what the workshop earned for them (a cost of the work order). */
export const earnedAmount = (piecesBackGood: number, pricePerPiece: string, currency: CurrencyCode): MinorUnits => operationAmount(piecesBackGood, pricePerPiece, currency)

// ---- pieces per size ----------------------------------------------------------------------------------------------------

/** The pieces of one cell of the work order's size grid (a colourway in a size). */
export interface SizePieces {
  readonly workOrderSizeId: string
  readonly pieces: number
}

/** A cell of the work order: its id and how many garments it makes. */
export interface Cell {
  readonly id: string
  readonly quantity: number
}

/** Every cell with all its garments: the default split of an operation. */
export const defaultSizes = (cells: readonly Cell[]): SizePieces[] => cells.map((cell) => ({ workOrderSizeId: cell.id, pieces: cell.quantity }))

/** The pieces the sizes add up to. */
export const piecesOf = (sizes: readonly SizePieces[]): number => sizes.reduce((sum, size) => sum + size.pieces, 0)

/**
 * The problems of an operation's pieces (paths `pieces`, `sizes/<i>/workOrderSizeId`, `sizes/<i>/pieces`): pieces above 0
 * and at most the work order's garments; each size a cell of the work order, once, from 1 up to the cell's garments; the
 * sizes adding up to the pieces.
 */
export function piecesProblems(pieces: number, sizes: readonly SizePieces[], cells: readonly Cell[]): Issue[] {
  const problems: Issue[] = []
  const garments = cells.reduce((sum, cell) => sum + cell.quantity, 0)
  if (!Number.isInteger(pieces) || pieces < 1) problems.push({ path: 'pieces', message: 'Expected whole pieces, at least 1.' })
  else if (pieces > garments) problems.push({ path: 'pieces', message: `The work order makes ${garments} garment(s); an operation sends out at most that many.` })
  const byId = new Map(cells.map((cell) => [cell.id, cell]))
  const seen = new Set<string>()
  sizes.forEach((size, index) => {
    const cell = byId.get(size.workOrderSizeId)
    if (!cell) problems.push({ path: `sizes/${index}/workOrderSizeId`, message: 'Not a cell of the work order’s size grid.' })
    else if (seen.has(cell.id)) problems.push({ path: `sizes/${index}/workOrderSizeId`, message: 'This cell is listed twice.' })
    else if (!Number.isInteger(size.pieces) || size.pieces < 1 || size.pieces > cell.quantity) problems.push({ path: `sizes/${index}/pieces`, message: `Expected 1 to ${cell.quantity} piece(s) for this cell.` })
    seen.add(size.workOrderSizeId)
  })
  if (sizes.length > 0 && problems.length === 0 && piecesOf(sizes) !== pieces) problems.push({ path: 'pieces', message: `The sizes add up to ${piecesOf(sizes)} piece(s), not ${pieces}.` })
  return problems
}

// ---- the order's acts -------------------------------------------------------------------------------------------------

/** What an act on the order looks at. */
export interface OrderFacts {
  readonly status: SubcontractOrderStatus
  readonly expectedBackDate: BusinessDate | null
  readonly orderDate: BusinessDate
  readonly currency: string
  readonly workshopActive: boolean
  readonly locationActive: boolean
  readonly workOrderStatus: string
  readonly operations: readonly { readonly seq: number; readonly code?: string | undefined; readonly pieces: number; readonly pricePerPiece: string; readonly piecesSent: number }[]
  readonly kitLines: readonly { readonly status: KitLineStatus }[]
}

/** Why the order cannot be issued now, in words (empty: it can). */
export function issueProblems(facts: OrderFacts): string[] {
  const problems: string[] = []
  if (facts.status !== 'DRAFT') problems.push(`The order is ${statusWords(facts.status)}; only a draft is issued.`)
  if (facts.operations.length === 0) problems.push('The order has no operation: pick what the workshop does from the work order’s routing.')
  for (const operation of facts.operations) {
    if (decimalOf(operation.pricePerPiece, 'pricePerPiece').isZero()) problems.push(`Line ${operation.seq}${operation.code ? ` (${operation.code})` : ''} has no fee per piece: type it before the order goes to the workshop.`)
  }
  if (facts.expectedBackDate === null) problems.push('The order has no return date: say when the goods are due back.')
  if (!isCurrencyCode(facts.currency)) problems.push('The order has no valid currency.')
  if (!facts.workshopActive) problems.push('The workshop is not active (blocked or archived): no work is sent to it.')
  if (!facts.locationActive) problems.push('The workshop’s stock location is archived: choose its active one.')
  if (!(WORK_ORDER_STATES as readonly string[]).includes(facts.workOrderStatus)) problems.push(`The work order is ${facts.workOrderStatus}; work is sent out only for a released or running one.`)
  return problems
}

const somethingOut = (facts: Pick<OrderFacts, 'operations' | 'kitLines'>): boolean => facts.kitLines.some((line) => line.status === 'SENT') || facts.operations.some((operation) => operation.piecesSent > 0)

/** Why an issued order cannot go back to draft now (empty: it can). */
export function reopenProblems(facts: Pick<OrderFacts, 'status' | 'operations' | 'kitLines'>): string[] {
  if (facts.status !== 'ISSUED') return [`The order is ${statusWords(facts.status)}; only an issued order goes back to draft.`]
  if (somethingOut(facts)) return ['Part of the kit or the pieces are out already; take them back first.']
  return []
}

/** Why the order cannot be cancelled now (empty: it can). */
export function cancelProblems(facts: Pick<OrderFacts, 'status' | 'operations' | 'kitLines'>): string[] {
  if (facts.status !== 'DRAFT' && facts.status !== 'ISSUED') return [`The order is ${statusWords(facts.status)}; only a draft or an issued order whose goods never left is cancelled.`]
  if (somethingOut(facts)) return ['Part of the kit or the pieces are out already; take them back first.']
  return []
}

/** Why the order cannot be closed now (empty: it can). */
export function closeProblems(facts: Pick<OrderFacts, 'status'>): string[] {
  return facts.status === 'RECEIVED' ? [] : [`The order is ${statusWords(facts.status)}; it is closed once every piece is back.`]
}

/** Why the kit or pieces cannot go out now (empty: they can). */
export function sendProblems(facts: Pick<OrderFacts, 'status' | 'workOrderStatus' | 'locationActive'>): string[] {
  const problems: string[] = []
  if (!OUT_STATUSES.includes(facts.status)) problems.push(`The order is ${statusWords(facts.status)}; the kit goes out once the order is issued, and until every piece is back.`)
  if (!(WORK_ORDER_STATES as readonly string[]).includes(facts.workOrderStatus)) problems.push(`The work order is ${facts.workOrderStatus}; nothing is sent out for it now.`)
  if (!facts.locationActive) problems.push('The workshop’s stock location is archived.')
  return problems
}

/** Why goods cannot be received back now (empty: they can). `piecesBack`: the receipt reports pieces, not only material. */
export function receiveProblems(facts: Pick<OrderFacts, 'status'>, piecesBack: boolean): string[] {
  if (piecesBack && !RECEIVING_STATUSES.includes(facts.status)) return [`The order is ${statusWords(facts.status)}; pieces come back only once something went out and until every piece is back.`]
  if (!piecesBack && !RECEIVING_STATUSES.includes(facts.status) && facts.status !== 'RECEIVED') return [`The order is ${statusWords(facts.status)}; material comes back only from an order whose kit went out.`]
  return []
}

/** The counts of one operation, sent and back. */
export interface OperationCounts {
  readonly pieces: number
  readonly piecesSent: number
  readonly piecesBackGood: number
  readonly piecesBackDefective: number
  readonly piecesScrapped: number
}

export const backOf = (counts: Pick<OperationCounts, 'piecesBackGood' | 'piecesBackDefective' | 'piecesScrapped'>): number => counts.piecesBackGood + counts.piecesBackDefective + counts.piecesScrapped

/** At the workshop now: sent less back. */
export const atWorkshopOf = (counts: OperationCounts): number => counts.piecesSent - backOf(counts)

/** What one receipt reports for one operation (or one bundle of it). */
export interface BackCounts {
  readonly good: number
  readonly defective: number
  readonly scrapped: number
}

/** The problems of pieces going out for an operation (path `pieces`): from 1 up to what is still to send. */
export function sentProblems(counts: OperationCounts, pieces: number): Issue[] {
  if (!Number.isInteger(pieces) || pieces < 1) return [{ path: 'pieces', message: 'Expected whole pieces, at least 1.' }]
  const left = counts.pieces - counts.piecesSent
  if (pieces > left) return [{ path: 'pieces', message: left === 0 ? 'Every piece of this operation went out already.' : `Only ${left} piece(s) of this operation are still to send.` }]
  return []
}

/** The problems of pieces coming back for an operation (path `good`): at least one, at most what is at the workshop. */
export function backProblems(counts: OperationCounts, back: BackCounts): Issue[] {
  const all = [back.good, back.defective, back.scrapped]
  if (all.some((value) => !Number.isInteger(value) || value < 0)) return [{ path: 'good', message: 'Expected whole pieces, 0 or more.' }]
  const total = back.good + back.defective + back.scrapped
  if (total < 1) return [{ path: 'good', message: 'Report at least one piece back (good, defective or scrapped).' }]
  const out = atWorkshopOf(counts)
  if (total > out) return [{ path: 'good', message: out === 0 ? 'No piece of this operation is at the workshop.' : `Only ${out} piece(s) of this operation are at the workshop.` }]
  return []
}

/** The order's status after a receipt: RECEIVED once every operation has all its pieces back, else PARTLY_RECEIVED. */
export function statusAfterReceipt(operations: readonly OperationCounts[]): 'PARTLY_RECEIVED' | 'RECEIVED' {
  return operations.length > 0 && operations.every((operation) => backOf(operation) >= operation.pieces) ? 'RECEIVED' : 'PARTLY_RECEIVED'
}

/** The order's status after a kit line came back unsent: ISSUED when nothing is out any more, else as it was. */
export function statusAfterReturn(status: SubcontractOrderStatus, facts: Pick<OrderFacts, 'operations' | 'kitLines'>): SubcontractOrderStatus {
  return status === 'AT_WORKSHOP' && !somethingOut(facts) ? 'ISSUED' : status
}

/** Where the kit stands. */
export function kitStateOf(lines: readonly { readonly status: KitLineStatus }[]): KitState {
  const live = lines.filter((line) => line.status !== 'CANCELLED')
  if (live.length === 0) return 'NONE'
  const sent = live.filter((line) => line.status === 'SENT').length
  return sent === 0 ? 'TO_SEND' : sent === live.length ? 'SENT' : 'PARTLY_SENT'
}

/** Late: the order waits for goods and its return date is before today. */
export const isLate = (status: SubcontractOrderStatus, expectedBackDate: BusinessDate | null, today: BusinessDate): boolean =>
  DUE_STATUSES.includes(status) && expectedBackDate !== null && expectedBackDate < today

// ---- a workshop's stock location (SCM-141) -------------------------------------------------------------------------------

/** The party a workshop location is for: its roles and status. */
export interface WorkshopParty {
  readonly roles: readonly string[]
  readonly status: string
  readonly companyId: string | null
}

/**
 * The problems of a location's workshop (path `partyId`): a SUBCONTRACTOR location names its workshop (a party with the
 * SUBCONTRACTOR role, not archived, of the site's company or every company); any other kind names none. The trigger
 * holds kind ⇔ party and that the party never changes.
 */
export function workshopLocationProblems(kind: string, partyId: string | null, party: WorkshopParty | null, siteCompanyId: string): Issue[] {
  if (kind !== 'SUBCONTRACTOR') return partyId === null ? [] : [{ path: 'partyId', message: 'Only a SUBCONTRACTOR location names a workshop.' }]
  if (partyId === null) return [{ path: 'partyId', message: 'A SUBCONTRACTOR location is the stock of one workshop: name it.' }]
  if (!party) return [{ path: 'partyId', message: 'Not a workshop of this company.' }]
  if (!party.roles.includes('SUBCONTRACTOR')) return [{ path: 'partyId', message: 'The party is no subcontractor: give it the SUBCONTRACTOR role first.' }]
  if (party.status === 'ARCHIVED') return [{ path: 'partyId', message: 'The workshop is archived.' }]
  if (party.companyId !== null && party.companyId !== siteCompanyId) return [{ path: 'partyId', message: 'The workshop belongs to another company.' }]
  return []
}

/** A location's kind may change only between kinds that name no workshop (the workshop is fixed: a new location instead). */
export const kindChangeProblems = (from: string, to: string): Issue[] =>
  from !== to && (from === 'SUBCONTRACTOR' || to === 'SUBCONTRACTOR')
    ? [{ path: 'kind', message: 'A workshop location stays one (its workshop never changes); make a new location instead.' }]
    : []
