import { problemKey } from '../shared/model'
import { isStepUpCancelled } from '../shared/step-up'

/**
 * A bulk action over the rows a person selected (Owner rule 2026-10-29: real multi-select with bulk actions where the API
 * acts per row). The API has no "many at once" call for these actions, so each row is one call, in order: what was done,
 * and what was refused with the problem in our words (a message key of `admin`). Part 1 has a twin in
 * `shared/bulk.ts`; the two are unified when the branches meet.
 */
export interface BulkResult<T> {
  done: T[]
  refused: Array<{ item: T; problem: string }>
}

/**
 * Runs `work` for each item, one after the other (never in parallel: each write takes the row's version, and a refusal
 * of one must not hide the others). An error becomes the row's problem (`problemKey`); the person closing the code
 * dialog (StepUpCancelled) stops the run at once and goes up: the rest is not tried.
 */
export async function runBulk<T>(items: readonly T[], work: (item: T) => Promise<unknown>): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { done: [], refused: [] }
  for (const item of items) {
    try {
      await work(item)
      result.done.push(item)
    } catch (error) {
      if (isStepUpCancelled(error)) throw error
      result.refused.push({ item, problem: problemKey(error) })
    }
  }
  return result
}
