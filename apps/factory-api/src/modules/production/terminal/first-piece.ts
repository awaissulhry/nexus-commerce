import { firstPieceHold, firstPieceRefusal, heldOperations, OUTCOME_WORDS, type FirstPieceRefusal, type InProcessStatus } from '@nexus/factory-domain/quality/inprocess/rules'
import type { CommandTx } from '../../../core/command'
import { firstPieceRows } from '../../quality/inprocess/store'

/**
 * The first-piece hold on the operation screen (B-W2b-99; QHS-039; design floor.operation "Waiting first-piece approval
 * (held)", floor.inline "First piece approved → the operation screens of that run lift their hold"; B-W2b-69's note: a flag in
 * BundleFacts, a hold in workHold). The database's OperationScan_awaits_first_piece is the last word; these say it first, in
 * words, so a scan or a start is refused as a 409 (`refusal/FIRST_PIECE` with its one fix), never a 500 from the trigger.
 *
 *   firstPieceRefusalAt   the hook of every write of work (the scans' report, the terminal's start, resume and pieces so
 *                         far, an outside operation's report): null, or the refusal. Stopping and mending work (pause,
 *                         hand back, undo, correction) never asks it, as the trigger.
 *   firstPieceCardOf      the bundle card's flag (GET /production/scans/card): which operations of the work order wait,
 *                         whether this bundle is a first piece's own (it goes through), the newest first piece and the words.
 *
 * Read in the caller's scope (a floor device at its own site, the office): the work order's in-process checks.
 */

type Reader = Pick<CommandTx, 'inProcessCheck' | 'workOrder' | 'bundle'>

/** Does this bundle's run wait for its first piece at this operation? The refusal in words, or null. */
export async function firstPieceRefusalAt(db: Reader, scan: { readonly workOrderId: string; readonly bundleId: string; readonly workOrderOperationId: string }): Promise<FirstPieceRefusal | null> {
  const rows = await firstPieceRows(db, scan.workOrderId)
  if (rows.length === 0) return null
  const hold = firstPieceHold(rows, scan)
  if (!hold.held) return null
  const workOrder = await db.workOrder.findUnique({ where: { id: scan.workOrderId }, select: { number: true } })
  const first = hold.check?.bundleId ? await db.bundle.findUnique({ where: { id: hold.check.bundleId }, select: { code: true } }) : null
  return firstPieceRefusal({ workOrderNumber: workOrder?.number ?? '', firstBundleCode: first?.code ?? null, rejected: hold.check?.outcome === 'REJECTED' })
}

export interface FirstPieceCard {
  /** Operations of the work order waiting for a first piece (for any bundle but a first piece's own). */
  readonly heldOperationIds: string[]
  /** This bundle is a first piece's own: it is worked to be checked. */
  readonly firstBundle: boolean
  /** The newest first piece of the work order not cancelled. */
  readonly check: { readonly id: string; readonly status: InProcessStatus; readonly outcome: string | null; readonly outcomeWords: { readonly it: string; readonly en: string } | null; readonly workOrderOperationId: string | null } | null
  /** The hold in words, when an operation of this bundle waits. */
  readonly message: string | null
  readonly fix: string | null
}

/** The bundle card's first-piece flag, or null when nobody asked a first piece of the work order. */
export async function firstPieceCardOf(db: Reader, bundle: { readonly id: string; readonly workOrderId: string; readonly code: string }, operationIds: readonly string[], workOrderNumber: string): Promise<FirstPieceCard | null> {
  const rows = await firstPieceRows(db, bundle.workOrderId)
  const standing = rows.filter((row) => row.status !== 'CANCELLED')
  if (standing.length === 0) return null
  const firstBundle = standing.some((row) => row.bundleId === bundle.id)
  const held = firstBundle ? [] : heldOperations(rows, operationIds)
  // The first piece the screen shows: the newest that holds one of this bundle's operations, else the newest of all.
  const holding = standing.filter((row) => row.outcome !== 'APPROVED' && (row.workOrderOperationId === null ? held.length > 0 : held.includes(row.workOrderOperationId)))
  const newest = [...(holding.length > 0 ? holding : standing)].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!
  const first = newest.bundleId && newest.bundleId !== bundle.id ? await db.bundle.findUnique({ where: { id: newest.bundleId }, select: { code: true } }) : null
  const words = held.length > 0 ? firstPieceRefusal({ workOrderNumber, firstBundleCode: first?.code ?? (newest.bundleId === bundle.id ? bundle.code : null), rejected: newest.outcome === 'REJECTED' }) : null
  return {
    heldOperationIds: held,
    firstBundle,
    check: { id: newest.id, status: newest.status, outcome: newest.outcome, outcomeWords: newest.outcome ? OUTCOME_WORDS[newest.outcome] : null, workOrderOperationId: newest.workOrderOperationId },
    message: words?.message ?? null,
    fix: words?.fix ?? null,
  }
}
