import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { seg, taskProblemOf, type TaskOutcome, type TaskProblem } from '../../shared/task-api'

/**
 * Kit staging's calls on the floor (B-W2b-310; apps/factory-api modules/inventory/kits, B-W2b-15, opened to a floor device at its
 * own site for these two writes): the place a scanned label names (`GET /inventory/locations/scan`, inventory.locations.view), the
 * kit put there (`POST /inventory/kits/:workOrderId/stage`) and checked complete (`…/complete`), each with the version the walk
 * read and its own Idempotency-Key. Online only: a kit's place and its check are the office's record of the moment (offline the
 * buttons wait and say why). The answers carry no person and no money.
 */

const placeAnswer = z.object({ location: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), status: z.string() }) })
export type KitPlace = z.infer<typeof placeAnswer>['location']

const kitAnswer = z.object({ kit: z.object({ location: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), checkedAt: z.string().nullable(), version: z.number() }) })
export type KitAnswer = z.infer<typeof kitAnswer>['kit']

/**
 * The screen's problem for a failed kit call: a rule's `kit/<CODE>` (409, factory-domain KIT_HELD), a place a kit may not wait at
 * (400 `body/locationId`: NOT_A_KIT_PLACE), no place carrying the label (404: NOT_A_PLACE), else the floor's general problem.
 * Exported for the tests.
 */
export function kitProblemOf(error: unknown, scanning = false): TaskProblem {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const match = /^kit\/([A-Z][A-Z0-9_]*)$/.exec(issuePath(issue))
      if (match) return { kind: 'refused', code: match[1]!, message: issue.message ?? error.message, fix: null }
    }
    if (error.kind === 'invalid' && error.issues.some((issue) => issuePath(issue) === 'body/locationId')) return { kind: 'refused', code: 'NOT_A_KIT_PLACE', message: error.message, fix: null }
    if (scanning && error.kind === 'not_found') return { kind: 'refused', code: 'NOT_A_PLACE', message: error.message, fix: null }
  }
  return taskProblemOf(error)
}

export async function placeOfLabel(api: ApiClient, code: string): Promise<TaskOutcome<KitPlace>> {
  try {
    return { ok: true, value: (await api.get('/inventory/locations/scan', { query: { code: code.trim() }, schema: placeAnswer })).location }
  } catch (error) {
    return { ok: false, problem: kitProblemOf(error, true) }
  }
}

async function write(api: ApiClient, path: string, body: unknown, idempotencyKey: string): Promise<TaskOutcome<KitAnswer>> {
  try {
    await api.get('/auth/csrf')
    return { ok: true, value: (await api.request('POST', path, { body, schema: kitAnswer, idempotencyKey })).kit }
  } catch (error) {
    return { ok: false, problem: kitProblemOf(error) }
  }
}

/** The kit waits at this place of the site. */
export const stageKit = (api: ApiClient, workOrderId: string, body: { readonly version: number; readonly locationId: string }, idempotencyKey: string) => write(api, `/inventory/kits/${seg(workOrderId)}/stage`, body, idempotencyKey)

/** The kit is checked complete (held by the office while a line is short). */
export const completeKit = (api: ApiClient, workOrderId: string, body: { readonly version: number }, idempotencyKey: string) => write(api, `/inventory/kits/${seg(workOrderId)}/complete`, body, idempotencyKey)
