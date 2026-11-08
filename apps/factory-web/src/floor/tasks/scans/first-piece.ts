import type { BundleCard } from './model'

/**
 * B-W2b-105 (QHS-039; design floor.operation "Waiting first-piece approval (W2b, held)", live "First-piece approved → the hold
 * lifts with a success flash"; B-W2b-99's API): the first-piece flag and hold on the operation screen, without React or the
 * network, so the tests hold them. The bundle card (`GET /production/scans/card`) carries `firstPiece`: which operations of the
 * work order wait for an approved first piece, whether this bundle IS the first piece (it goes through), the newest first piece.
 * The API refuses a Start, a Resume, Pieces so far and a report of a held run (409 `refusal/FIRST_PIECE`); the screen says it
 * first and holds Finish and Start, since a report always goes through the queue (a refusal there would come late). Stopping
 * work (Pause, Hand back, Undo, a correction) is never held, as the database's trigger.
 */

export interface FirstPieceFlag {
  /** Operations of the work order waiting for a first piece (for any bundle but a first piece's own). */
  readonly heldOperationIds: readonly string[]
  /** This bundle is a first piece's own: it is worked to be checked. */
  readonly firstBundle: boolean
  /** The newest first piece of the work order not cancelled. */
  readonly check: { readonly id: string; readonly status: 'OPEN' | 'DECIDED' | 'CANCELLED'; readonly outcome: string | null; readonly workOrderOperationId: string | null } | null
  readonly message: string | null
  readonly fix: string | null
}

/**
 * What the card says about the first piece at this operation:
 *   held        the run waits for an approved first piece here (Finish, Start and Resume held)
 *   rejected    it waits, and the first piece shown was rejected (a new one is asked)
 *   firstBundle this bundle is the open first piece's own: it is worked, then the inspector checks it
 *   null        nothing to say (none asked, approved long ago, another operation's)
 */
export type FirstPieceState = 'held' | 'rejected' | 'firstBundle' | null

const atOperation = (flag: FirstPieceFlag, operationId: string) => flag.check !== null && (flag.check.workOrderOperationId === null || flag.check.workOrderOperationId === operationId)

export function firstPieceAt(card: Pick<BundleCard, 'firstPiece'>, operationId: string | null): FirstPieceState {
  const flag = card.firstPiece
  if (!flag || operationId === null) return null
  if (flag.heldOperationIds.includes(operationId)) return flag.check?.outcome === 'REJECTED' ? 'rejected' : 'held'
  if (flag.firstBundle && flag.check?.status === 'OPEN' && atOperation(flag, operationId)) return 'firstBundle'
  return null
}

/** The run waits here: Finish and Start are held (the API would refuse them). */
export const firstPieceHolds = (card: Pick<BundleCard, 'firstPiece'>, operationId: string | null): boolean => {
  const state = firstPieceAt(card, operationId)
  return state === 'held' || state === 'rejected'
}

/** The card with a newer read of its first piece (the live re-read, B-W2b-99's GET /quality/inprocess/first-piece). */
export const withFirstPiece = <C extends BundleCard>(card: C, flag: FirstPieceFlag | null): C => ({ ...card, firstPiece: flag })

/** The hold at this operation went away between two reads: the success flash (design floor.operation live). */
export function firstPieceLifted(before: Pick<BundleCard, 'firstPiece'>, after: Pick<BundleCard, 'firstPiece'>, operationId: string | null): boolean {
  return firstPieceHolds(before, operationId) && !firstPieceHolds(after, operationId)
}

/** A live message that may change this card's first piece (`in_process_check.first_piece`, floor.work: every tablet of the site). */
export function firstPieceMessageFor(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, card: Pick<BundleCard, 'workOrder'>): boolean {
  return change.type === 'in_process_check.first_piece' && (change.fields.workOrderId === undefined || change.fields.workOrderId === card.workOrder.id)
}
