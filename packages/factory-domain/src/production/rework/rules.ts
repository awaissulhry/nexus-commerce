import type { WorkOrderStatus } from '../work-orders/machine'

/**
 * The rework loop (B-W2a-13; MES-126; design production.scrap "Scrap & rework", floor.operation "Rework"), pure: garments
 * of one cell of a work order are sent back to an operation to be made again, and come back. The API (apps/factory-api
 * modules/production/rework) reads the facts inside its command and writes the ReworkOrder row; the …_production_w2a_guards
 * ReworkOrder trigger stays the last word for every login.
 *
 *   open      from a scan's rework count (the REPORT or CORRECTION that counted them, not voided: at most what it counted
 *             as rework less the rework already opened from it), or by hand with the reason (an inspection, a
 *             nonconformance's disposition: recordType + recordId). The work order is RELEASED, IN_PROGRESS or ON_HOLD
 *             (a held work order takes new rework, none moves on until the hold is lifted). The reason is an ACTIVE
 *             REWORK reason of the tenant's list; the operation it goes back to is at or before the one it was found at.
 *             The garments travel in a bundle of the cell: a part of a bundle is split off into a child bundle with its
 *             own ticket (bundles/split.ts), the whole bundle goes back as it is.
 *   start     OPEN → IN_PROGRESS (the work at the rework operation began).
 *   done      OPEN | IN_PROGRESS → DONE with the garments that came out good and those scrapped: together its quantity.
 *             The good ones count as passed at the operation the fault was found at (bundles/split.ts bundleFlow); the
 *             scrapped ones are replaced or the order lowered (../scrap: a replacement names the rework).
 *   cancel    OPEN | IN_PROGRESS → CANCELLED with the reason (sent back by mistake).
 *   moves     start and done need the work order RELEASED or IN_PROGRESS: ON_HOLD is answered with the hold's reason.
 *
 * A rework names no worker (Statuto dei Lavoratori art. 4; Owner answer F2): the floor's figures are per line, station
 * or work order.
 */

export const REWORK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const
export type ReworkStatus = (typeof REWORK_STATUSES)[number]

export const REWORK_MOVES = ['start', 'done', 'cancel'] as const
export type ReworkMove = (typeof REWORK_MOVES)[number]

/** Why a rework is not opened or moved: a stable code (the screens' words) and its sentence. */
export const REWORK_REFUSALS = [
  'WORK_ORDER_NOT_OPEN',
  'WORK_ORDER_ON_HOLD',
  'NOT_A_REWORK_SCAN',
  'MORE_THAN_COUNTED',
  'NOT_A_REWORK_REASON',
  'REWORK_AT_LATER',
  'BUNDLE_NOT_ACTIVE',
  'MORE_THAN_BUNDLE',
  'NOT_OF_CELL',
  'NEXT_REPORTED',
  'WRONG_STATE',
  'COUNTS_DO_NOT_ADD_UP',
] as const
export type ReworkRefusalCode = (typeof REWORK_REFUSALS)[number]

export interface ReworkRefusal {
  readonly code: ReworkRefusalCode
  readonly message: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const garments = (count: number) => plural(count, 'garment')

/** The statuses a work order takes new rework in. */
export const REWORK_OPEN_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS', 'ON_HOLD'])
/** The statuses a work order's rework moves on in. */
export const REWORK_MOVE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS'])

interface Order {
  readonly number: string
  readonly status: WorkOrderStatus
  readonly holdReason?: string | null | undefined
}

const notOpen = (workOrder: Order, what: string): ReworkRefusal => ({ code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${workOrder.number} is ${workOrder.status}; ${what}.` })
const onHold = (workOrder: Order): ReworkRefusal => ({
  code: 'WORK_ORDER_ON_HOLD',
  message: `Work order ${workOrder.number} is on hold${workOrder.holdReason ? ` (${workOrder.holdReason})` : ''}: its rework moves on once the hold is lifted.`,
})

export interface OpenFacts {
  readonly workOrder: Order
  readonly quantity: number
  /** The reason asked, with the tenant's REWORK reasons that are active. */
  readonly reasonCode: string
  readonly activeReasons: readonly string[]
  /** The operations named, with their sequence (foundAt null: found outside the routing). */
  readonly foundAt: { readonly seq: number } | null
  readonly reworkAt: { readonly seq: number }
  /** The scan whose rework count opens it, when there is one. */
  readonly source: {
    readonly kind: 'REPORT' | 'UNDO' | 'CORRECTION'
    readonly voided: boolean
    readonly reworkQuantity: number
    /** Garments of it already sent back by reworks that are not CANCELLED. */
    readonly opened: number
  } | null
  /** The bundle that carries them, when one is named: its status, its live garments, its cell. */
  readonly bundle: { readonly code: string; readonly status: 'ACTIVE' | 'VOID'; readonly live: number; readonly sameCell: boolean } | null
  /** By hand, with a bundle: the next scanned operation after the one it was found at already took the bundle. */
  readonly nextReported: { readonly seq: number } | null
}

/** Why the rework may not be opened, or null. */
export function openRefusal(facts: OpenFacts): ReworkRefusal | null {
  if (!REWORK_OPEN_STATUSES.includes(facts.workOrder.status)) return notOpen(facts.workOrder, 'rework is opened while it is RELEASED, IN_PROGRESS or ON_HOLD')
  if (!facts.activeReasons.includes(facts.reasonCode)) {
    return { code: 'NOT_A_REWORK_REASON', message: `${facts.reasonCode} is not an active rework reason: pick one of ${facts.activeReasons.join(', ') || 'the list (none is active)'}.` }
  }
  if (facts.source) {
    if (facts.source.kind === 'UNDO' || facts.source.voided || facts.source.reworkQuantity < 1) {
      return { code: 'NOT_A_REWORK_SCAN', message: 'That scan sends nothing back: it is undone or corrected, or it counted no rework.' }
    }
    const left = facts.source.reworkQuantity - facts.source.opened
    if (facts.quantity > left) {
      return {
        code: 'MORE_THAN_COUNTED',
        message: left <= 0 ? `Every garment that scan counted as rework (${facts.source.reworkQuantity}) is sent back already.` : `That scan counted ${garments(facts.source.reworkQuantity)} as rework; ${left} not yet sent back, ${facts.quantity} asked.`,
      }
    }
  }
  if (facts.foundAt && facts.reworkAt.seq > facts.foundAt.seq) {
    return { code: 'REWORK_AT_LATER', message: `Garments go back to an operation at or before the one the fault was found at (Op ${facts.foundAt.seq}), not to Op ${facts.reworkAt.seq}.` }
  }
  if (facts.bundle) {
    if (!facts.bundle.sameCell) return { code: 'NOT_OF_CELL', message: `Bundle ${facts.bundle.code} carries garments of another cell.` }
    if (facts.bundle.status !== 'ACTIVE') return { code: 'BUNDLE_NOT_ACTIVE', message: `Bundle ${facts.bundle.code} is voided: name the bundle that carries the garments.` }
    if (facts.quantity > facts.bundle.live) return { code: 'MORE_THAN_BUNDLE', message: `Bundle ${facts.bundle.code} carries ${garments(facts.bundle.live)}; ${facts.quantity} asked.` }
  }
  if (facts.nextReported) {
    return {
      code: 'NEXT_REPORTED',
      message: `Op ${facts.nextReported.seq} took bundle ${facts.bundle?.code ?? ''} already: send the garments back from the operation they are at now, or ask a correction first.`,
    }
  }
  return null
}

export interface MoveFacts {
  readonly workOrder: Order
  readonly rework: { readonly status: ReworkStatus; readonly quantity: number }
  readonly move: ReworkMove
  /** done: the garments that came out good and those scrapped. */
  readonly good?: number | undefined
  readonly scrap?: number | undefined
}

const FROM: Record<ReworkMove, readonly ReworkStatus[]> = { start: ['OPEN'], done: ['OPEN', 'IN_PROGRESS'], cancel: ['OPEN', 'IN_PROGRESS'] }
const TO: Record<ReworkMove, ReworkStatus> = { start: 'IN_PROGRESS', done: 'DONE', cancel: 'CANCELLED' }

/** The status a move leads to. */
export const statusAfter = (move: ReworkMove): ReworkStatus => TO[move]

/** Why the rework may not make the move, or null. */
export function moveRefusal(facts: MoveFacts): ReworkRefusal | null {
  if (!FROM[facts.move].includes(facts.rework.status)) {
    return { code: 'WRONG_STATE', message: `This rework is ${facts.rework.status}; it can be ${facts.move === 'start' ? 'started' : facts.move === 'done' ? 'finished' : 'cancelled'} only while ${FROM[facts.move].join(' or ')}.` }
  }
  if (facts.move !== 'cancel') {
    if (facts.workOrder.status === 'ON_HOLD') return onHold(facts.workOrder)
    if (!REWORK_MOVE_STATUSES.includes(facts.workOrder.status)) return notOpen(facts.workOrder, 'its rework moves on while it is RELEASED or IN_PROGRESS')
  }
  if (facts.move === 'done') {
    const good = facts.good ?? 0
    const scrap = facts.scrap ?? 0
    if (good < 0 || scrap < 0 || good + scrap !== facts.rework.quantity) {
      return { code: 'COUNTS_DO_NOT_ADD_UP', message: `This rework sent back ${garments(facts.rework.quantity)}: good and scrapped add up to them (${good} + ${scrap} given).` }
    }
  }
  return null
}

/** The garments a scan's rework count sent back already: the reworks opened from it that are not CANCELLED. */
export function openedFrom(reworks: readonly { readonly sourceScanId: string | null; readonly status: ReworkStatus; readonly quantity: number }[], scanId: string): number {
  return reworks.filter((rework) => rework.sourceScanId === scanId && rework.status !== 'CANCELLED').reduce((sum, rework) => sum + rework.quantity, 0)
}
