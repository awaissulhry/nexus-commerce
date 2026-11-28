import { standingKey, type ScanFact } from '../scans/rules'
import { scannedSteps, type RouteOperation } from './route'

/**
 * Where a basket is (owb- order workflow, S5 fl1; build/briefs/owb-fl2.md step 1 is the spec; LF _owb-fl-common.md § 1 "the
 * place of a basket = its scans + BasketMove rows"). Pure; the other of the pair with ./route.ts: `route` is the basket's own
 * route (basketRoute), `standing` its standing reports (scans/rules standingScans), `moves` its hand moves (BasketMove rows,
 * oldest first).
 *
 *   no move that counts   EXACTLY today: the first scanned step of the route with no standing report (scans/rules
 *                         operationFor with no station); every step reported → null (Ready to ship). `how: 'SCANS'`
 *   a move counts         M = the newest move that counts (an UNDO and the move it undoes count for nothing). Its step
 *                         (`toOperationId`; null = Ready to ship) is the anchor. The place is the first scanned step of the
 *                         route from the anchor on (in route order) with no standing report NEWER than M; none → null
 *                         (Ready to ship). `how: 'MOVE'`
 *
 * So a report older than the move is work done before the basket came back (a BACK from Quality to Stitching: Stitching is
 * done again); a report after the move moves it on (a hand move Cutting → Stitching, then a Stitching report: Quality; Cutting
 * stays unreported, by design). A second Done at a step whose report is older than the move writes a FORWARD move (fl2): the
 * basket goes on without a second scan.
 */

/** One hand move of the basket, as the readers read BasketMove. */
export interface MoveFact {
  readonly id: string
  readonly kind: 'FORWARD' | 'BACK' | 'TAKEN_HERE' | 'UNDO'
  readonly fromOperationId: string | null
  readonly toOperationId: string | null
  /** UNDO: the move it undoes. */
  readonly undoesId: string | null
  readonly serverTime: Date
}

export interface BasketPlace {
  /** The step the basket is at; null: Ready to ship. */
  readonly operationId: string | null
  /** SCANS: from the scans alone, as today; MOVE: from a hand move. */
  readonly how: 'SCANS' | 'MOVE'
}

/** The moves that count: every move but the UNDO rows and the moves they undo, oldest first. */
export function effectiveMoves<Move extends MoveFact>(moves: readonly Move[]): Move[] {
  const undone = new Set(moves.flatMap((move) => (move.kind === 'UNDO' && move.undoesId ? [move.undoesId] : [])))
  return moves.filter((move) => move.kind !== 'UNDO' && !undone.has(move.id)).sort((a, b) => a.serverTime.getTime() - b.serverTime.getTime())
}

/** The newest move that counts, or null. */
export function lastMove<Move extends MoveFact>(moves: readonly Move[]): Move | null {
  return effectiveMoves(moves).at(-1) ?? null
}

/** Where the basket is (see the file's head). */
export function basketPlace(route: readonly RouteOperation[], standing: ReadonlyMap<string, Pick<ScanFact, 'serverTime'>>, bundleId: string, moves: readonly MoveFact[]): BasketPlace {
  const scanned = scannedSteps(route)
  const move = lastMove(moves)
  if (!move) {
    const open = scanned.find((operation) => !standing.has(standingKey(bundleId, operation.id)))
    return { operationId: open?.id ?? null, how: 'SCANS' }
  }
  if (move.toOperationId === null) return { operationId: null, how: 'MOVE' }
  const anchor = route.find((operation) => operation.id === move.toOperationId)
  // The anchor is a step of the work order; skipped for this basket since, the walk starts at the next scanned step after it.
  const from = anchor ? scanned.findIndex((operation) => operation.seq >= anchor.seq) : 0
  const after = move.serverTime.getTime()
  const open = (from < 0 ? [] : scanned.slice(from)).find((operation) => {
    const report = standing.get(standingKey(bundleId, operation.id))
    return !report || report.serverTime.getTime() <= after
  })
  return { operationId: open?.id ?? null, how: 'MOVE' }
}
