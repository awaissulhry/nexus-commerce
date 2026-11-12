import type { ZodType } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { taskProblemOf, type TaskOutcome, type TaskProblem } from '../../shared/task-api'

/**
 * The warehouse screens' writes (B-W2b-308: Move & put away, My work at the warehouse) and how their refusals read. Beside the
 * floor's `refusal/<CODE>` (task-api), the moves answer three more shapes the screens word themselves:
 *
 *   409 warehouse/<CODE>        the database's warehouse rules (a blocked place, a count's frozen line, goods in transit;
 *                               factory-domain inventory/warehouse/refusals)
 *   400 refusal/<CODE>          a move's TOO_MUCH and WHOLE_ONLY (a validation, not a conflict)
 *   400 body/placeCode          the label of no place of this site (NOT_A_PLACE), or of a place that is no quarantine place
 *                               (NOT_A_QUARANTINE_PLACE, the quarantine move's done)
 *   400 …/toLocationId          a place that does not take this kind of goods (DOES_NOT_HOLD, B-W2b-289's kinds)
 *
 * The API's English is never drawn: the code picks the screen's words; the message only tells two 400s apart.
 */

const CODE_PATH = /^(?:refusal|warehouse)\/([A-Z][A-Z0-9_]*)$/
const NO_PLACE = /^No place of this site/

/** The screen's problem for a failed warehouse call. Exported for the tests. */
export function warehouseProblemOf(error: unknown): TaskProblem {
  if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')) {
    for (const issue of error.issues) {
      const match = CODE_PATH.exec(issuePath(issue))
      if (match) return { kind: 'refused', code: match[1]!, message: issue.message ?? error.message, fix: null }
    }
    if (error.kind === 'invalid') {
      const placed = error.issues.find((issue) => issuePath(issue) === 'body/placeCode')
      if (placed) return { kind: 'refused', code: NO_PLACE.test(placed.message ?? '') ? 'NOT_A_PLACE' : 'NOT_A_QUARANTINE_PLACE', message: placed.message ?? error.message, fix: null }
      const holds = error.issues.find((issue) => issuePath(issue).endsWith('toLocationId'))
      if (holds) return { kind: 'refused', code: 'DOES_NOT_HOLD', message: holds.message ?? error.message, fix: null }
    }
  }
  return taskProblemOf(error)
}

/** A warehouse write (CSRF cookie first, its Idempotency-Key always): its answer, or the problem in the screens' terms. */
export async function warehouseWrite<T>(api: ApiClient, path: string, options: { readonly body: unknown; readonly schema: ZodType<T>; readonly idempotencyKey: string }): Promise<TaskOutcome<T>> {
  try {
    await api.get('/auth/csrf')
    const value = await api.request('POST', path, { body: options.body, schema: options.schema, idempotencyKey: options.idempotencyKey })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, problem: warehouseProblemOf(error) }
  }
}
