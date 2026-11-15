import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { waitingSchema, type WaitingAnswer, type WaitingItem } from './model'

/**
 * Waiting on others' calls (B-W2b-388): GET /home/waiting-on-others (what I asked for and still wait on, under the top bar's
 * company and site) and POST /home/waiting-on-others/:key/nudge (a reminder note on the record's thread to the people who may
 * decide, once a business day). Problems as `home-mywork` keys.
 */

export function fetchWaiting(api: ApiClient, scope: { readonly siteId?: string | null }, signal?: AbortSignal): Promise<WaitingAnswer> {
  return api.get('/home/waiting-on-others', { query: { siteId: scope.siteId ?? undefined }, schema: waitingSchema, signal })
}

export async function nudge(api: ApiClient, item: Pick<WaitingItem, 'key'>): Promise<number> {
  const answer = await api.post<{ told: number }>(`/home/waiting-on-others/${encodeURIComponent(item.key)}/nudge`, { idempotencyKey: newIdempotencyKey() })
  return answer.told
}

/** A failed read, as a message key. */
export function waitingProblem(error: unknown): string {
  if (!isApiError(error)) return 'waiting.problem.read'
  if (error.kind === 'forbidden') return 'waiting.problem.forbidden'
  if (error.kind === 'unavailable') return 'waiting.problem.offline'
  return 'waiting.problem.read'
}

/** A refused nudge, as a message key: its refusal code (once a day, nobody may decide, a party), or why it failed. */
export function nudgeProblem(error: unknown): string {
  if (!isApiError(error)) return 'waiting.nudge.failed'
  const code = error.issues.map(issuePath).find((path) => path.startsWith('nudge/'))?.slice('nudge/'.length)
  if (code === 'TODAY_ALREADY' || code === 'NOBODY' || code === 'OUTSIDE') return `waiting.nudge.refusal.${code}`
  if (error.kind === 'not_found') return 'waiting.nudge.gone'
  if (error.kind === 'unavailable') return 'waiting.problem.offline'
  return 'waiting.nudge.failed'
}
