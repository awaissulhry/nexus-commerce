import type { FloorSyncKind } from '@nexus/factory-domain/floor-sync/kinds'
import { newIdempotencyKey } from '../../lib/api/client'
import type { QueueItem } from './model'
import type { FloorQueue } from './queue'

/**
 * One floor action, online first (B-W2b-77; the gaps B-W2b-67 and -69 left). A screen that wants the office's answer at once
 * tries the route; only a network failure keeps the action on the tablet. But a network failure says nothing of the office:
 * the request may have arrived and only its answer died on the way back. So the try and the queued retry are ONE action under
 * ONE client id: the office answers the retry `duplicate` with the record it holds (one clock-in, one Start, no ALREADY_RUNNING
 * on the strip), and records it if the try never arrived. A refusal is an answer: it is shown, never queued.
 */

/** What a screen needs of the queue. */
export type KeepsActions = Pick<FloorQueue, 'enqueue'>

/** A try's answer: a value, or a problem of some kind (`offline`: the network failed, whatever became of the request). */
type Outcome = { readonly ok: true } | { readonly ok: false; readonly problem: { readonly kind: string } }

export type OnlineFirst<Answer> = { readonly kept: QueueItem; readonly answer: null } | { readonly kept: null; readonly answer: Answer }

export interface OnlineFirstAction<Answer> {
  readonly online: boolean
  /** How the action queues: the same action as the try. */
  readonly kind: FloorSyncKind
  readonly payload: Readonly<Record<string, unknown>>
  /** The try, under the action's client id. */
  readonly attempt: (clientEventId: string) => Promise<Answer>
}

/** The office's answer to the try, or the item kept on the tablet under the same id. */
export async function onlineFirst<Answer extends Outcome>(queue: KeepsActions, action: OnlineFirstAction<Answer>): Promise<OnlineFirst<Answer>> {
  const clientEventId = newIdempotencyKey()
  if (action.online) {
    const answer = await action.attempt(clientEventId)
    if (answer.ok || answer.problem.kind !== 'offline') return { kept: null, answer }
  }
  return { kept: await queue.enqueue(action.kind, action.payload, clientEventId), answer: null }
}
