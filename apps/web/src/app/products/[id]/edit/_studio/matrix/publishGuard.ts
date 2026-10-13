/**
 * Publish on the Matrix (2026-10-13, one save line). Publish reviews only after every editor that registered with it has
 * saved (`workspaceSave.ts`). The Matrix registers its barrier here: before the review it waits for every write of the
 * page — the Matrix cells, verbs and reverts (`useMatrix`'s line), each market's Status (the publish actions' writes) and
 * the Base price (the master writer) — and it holds Publish while one is still in flight, a write got no answer (the
 * connection was lost; the Information page's rule), or a cell editor is open.
 * Without it a Status or a price set on the Matrix just before Publish could be missing from the review.
 */
import type { PublicationSaveBarrier } from '../workspaceSave'

export const MATRIX_PUBLISH_HELD = {
  editing: 'Apply or cancel the open cell before publishing.',
  saving: 'Wait for the Matrix to save before publishing.',
  /** A save that got no answer (connection lost): the Information page holds Publish the same way. */
  unanswered: 'A change on the Matrix got no answer from the server. Reload the Matrix to see whether it saved before publishing.',
} as const

/** Work in flight, counted: `pending()` while any of it runs, `settled()` once everything started so far has finished. */
export interface InFlight {
  track: <T>(work: Promise<T>) => Promise<T>
  pending: () => number
  settled: () => Promise<void>
}

export function createInFlight(): InFlight {
  let count = 0
  let all: Promise<unknown> = Promise.resolve()
  return {
    track(work) {
      count += 1
      const done = () => { count -= 1 }
      work.then(done, done)
      all = Promise.allSettled([all, work])
      return work
    },
    pending: () => count,
    settled: () => all.then(() => undefined),
  }
}

export interface MatrixPublishLines {
  /** The Matrix's one line: cell writes, verb runs, reverts. */
  matrix: { settled: () => Promise<void>; pending: () => number }
  /** Each market's Status writes. */
  status: { settled: () => Promise<void>; pending: () => number }
  /** The Base price: the master writer (it sends what is queued, then settles). */
  base: { flush: () => Promise<void>; readonly pending: number }
  /** A cell editor is open on the grid. */
  editing: () => boolean
  /** A write whose outcome is unknown (no answer: the connection was lost) — absent = none can be. */
  unanswered?: () => boolean
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** A drain that keeps finding new writes stops after this many rounds; the blocker then holds Publish. */
const MAX_ROUNDS = 5

export function matrixPublicationBarrier(lines: MatrixPublishLines): PublicationSaveBarrier {
  const busy = () => lines.matrix.pending() > 0 || lines.status.pending() > 0 || lines.base.pending > 0
  return {
    async flush() {
      /* A value committed just now reaches its line on the next turn (the grid reports its changes then, and the Status
         cells leave their fence then): wait for it, then for every line — and again while a settled write started another. */
      for (let round = 0; round < MAX_ROUNDS; round++) {
        await nextTurn()
        await Promise.all([lines.matrix.settled(), lines.status.settled(), lines.base.flush()])
        if (!busy()) return
      }
    },
    blocker() {
      if (lines.editing()) return MATRIX_PUBLISH_HELD.editing
      if (busy()) return MATRIX_PUBLISH_HELD.saving
      return lines.unanswered?.() ? MATRIX_PUBLISH_HELD.unanswered : null
    },
  }
}
