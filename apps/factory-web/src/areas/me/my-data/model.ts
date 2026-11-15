import { isApiError } from '../../../lib/api/errors'
import type { MyData, MyRequest } from './api'

/**
 * Download my data, pure (B-W2b-414): each request's state in the person's words, why "Ask for my data" is held, and the
 * dialog's one view model.
 */

/** Where one of my requests stands: being collected, ready to download, handed over, failed, or waiting. */
export type MyState = 'collecting' | 'ready' | 'handed' | 'failed' | 'waiting' | 'closed'

export function myState(request: MyRequest): MyState {
  if (request.status === 'DONE') return 'handed'
  if (request.status === 'REFUSED' || request.status === 'WITHDRAWN') return 'closed'
  const state = request.collect?.state ?? 'NONE'
  if (state === 'RUNNING') return 'collecting'
  if (state === 'FAILED') return 'failed'
  return request.package ? 'ready' : 'waiting'
}

export const MY_STATE_PILL = { collecting: 'info', ready: 'success', handed: 'neutral', failed: 'danger', waiting: 'neutral', closed: 'neutral' } as const

/** Why "Ask for my data" is held (a key), or null. */
export function askHeld(data: MyData | null): string | null {
  if (!data) return 'dp.common.loading'
  if (data.mayAsk) return null
  return data.companyId ? 'dp.my.held.open' : 'dp.my.held.company'
}

/** A request is being collected: the dialog reads again until it is ready. */
export const anyCollecting = (data: MyData | null): boolean => (data?.requests ?? []).some((request) => myState(request) === 'collecting' || myState(request) === 'waiting')

export function myProblem(error: unknown): string {
  if (!isApiError(error)) return 'dp.problem.failed'
  if (error.kind === 'conflict') return 'dp.my.held.open'
  if (error.kind === 'unavailable') return 'dp.problem.unavailable'
  if (error.kind === 'rate_limited') return 'dp.problem.rateLimited'
  if (error.kind === 'not_found') return 'dp.problem.notFound'
  return 'dp.problem.failed'
}

export interface MyDataModel {
  open: boolean
  read: { value: MyData | null; problem: string | null }
  busy: boolean
  /** The request being downloaded now. */
  downloading: string | null
  problem: string | null
  /** What the last step did, a key. */
  done: string | null
  timeZone: string
}
