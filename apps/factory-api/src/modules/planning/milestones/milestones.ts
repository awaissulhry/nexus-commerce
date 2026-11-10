import { actorOf } from '../../../core/context'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../access'
import { readWorld } from './world'

/**
 * GET /planning/milestones (B-W2b-263; design planning.milestones sec:gates "Waiting on a gate", sec:calendar "Milestones by
 * date; switch to a list or one row per order"; planning.view): the open sales orders the caller plans for — of the company
 * asked (the screen's), one order (`orderId`, whatever its status), or those whose number or customer reference matches `q` —
 * each with its gates (what may happen now, in words) and its milestones, and the tiles' counts of orders waiting on a gate.
 */
export async function readMilestones(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly orderId?: string | undefined; readonly q?: string | undefined }) {
  const context = officeContextOf(caller)
  const world = { actor: actorOf(context), actorId: context.actorId, now: serverClock.now() }
  return caller.withClient((db) => readWorld(db, world, { companyId: query.companyId ?? context.companyId, orderIds: query.orderId ? [query.orderId] : undefined, q: query.q }))
}
