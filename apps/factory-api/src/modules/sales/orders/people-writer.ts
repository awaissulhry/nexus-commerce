import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { addedReason, type FollowReason } from '@nexus/factory-domain/threads/followers'
import { followInCommand, type FollowTools } from '../../../platform/threads/followers'
import { ORDER_RECORD } from './on-the-order'

/**
 * owb-of1a (order workflow, plan.md § 5 D; S3 ss6 "Confirm gives the office people", S2's own People): puts office people ON a
 * sales order inside the caller's command — a RecordFollower row through the threads' own `followInCommand` (its audit row
 * `threads.follow` and its `thread.followers_changed` event), so they see the order (on-the-order.ts) and its news. No route, no
 * permission check: the calling command decided who may be put on it.
 *
 *   - A person already on it (any follow row, muted too) is kept as it is, never doubled (`followInCommand` adds only when no row).
 *   - The reason is ADDED, naming who put them on (`byUserId`). The database wants an ADDED row's adder to be someone else
 *     (RecordFollower guard), so the person putting themselves on is CHOSE (threads' `addedReason`), and a put by the system
 *     (`byUserId` null) is ASSIGNEE.
 *   - Only ACTIVE office users are put on; any other id is skipped (a portal user follows only a project of its own party).
 * Answers how many people are new on the order.
 */
export async function putPeopleOnOrder(tools: FollowTools, input: { salesOrderId: string; userIds: readonly string[]; byUserId: string | null }): Promise<number> {
  const order = isUuid(input.salesOrderId) ? await tools.tx.salesOrder.findUnique({ where: { id: input.salesOrderId }, select: { id: true, companyId: true } }) : null
  if (!order) throw new NotFoundError('Sales order not found.')
  const asked = [...new Set(input.userIds.filter((userId) => isUuid(userId)))]
  if (asked.length === 0) return 0
  const people = await tools.tx.user.findMany({ where: { id: { in: asked }, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
  const office = new Set(people.map((person) => person.id))
  // The live message's customer is read by the threads from the order itself (records.ts), never passed in.
  const record = { type: ORDER_RECORD, id: order.id, companyId: order.companyId, siteId: null }
  let added = 0
  for (const userId of asked) {
    if (!office.has(userId)) continue
    const reason: FollowReason = input.byUserId === null ? 'ASSIGNEE' : addedReason(userId, input.byUserId)
    if (await followInCommand(tools, record, userId, reason, input.byUserId)) added += 1
  }
  return added
}
