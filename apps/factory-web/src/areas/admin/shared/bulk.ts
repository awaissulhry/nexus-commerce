import { problemKey } from './model'
import { isStepUpCancelled } from './step-up'

/**
 * A bulk action over the selected rows of an Admin list (Owner rule 2026-10-29: real multi-select with bulk actions).
 * The API acts on one row per call (`POST /auth/users/:id/suspend`, `POST /auth/floor/devices/:id/revoke`, …), so a
 * bulk action is the same call once per row, one after the other: each row is done or refused with its problem; a
 * closed step-up dialog stops the run (nothing more is asked). Pure but for the calls it is given.
 */

export interface BulkResult<T> {
  done: T[]
  refused: Array<{ item: T; problem: string }>
}

/**
 * Runs `work` for each item in order, one at a time. An error becomes the item's problem (`problemKey`: a message key
 * of `admin`) and the run goes on; a `StepUpCancelled` (the person closed the code dialog) is thrown at once.
 */
export async function runBulk<T>(items: readonly T[], work: (item: T) => Promise<unknown>): Promise<BulkResult<T>> {
  const done: T[] = []
  const refused: Array<{ item: T; problem: string }> = []
  for (const item of items) {
    try {
      await work(item)
      done.push(item)
    } catch (error) {
      if (isStepUpCancelled(error)) throw error
      refused.push({ item, problem: problemKey(error) })
    }
  }
  return { done, refused }
}
