import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * Today's actions seed (B-W1-52 actions): the seeded order SEED-SO-0001's "late against its promise" row of Today, which
 * the owner assigned to the member and took back (one action, its two history rows), and the owner's arrangement of
 * Today (the flow strip first, a lens). Made-up data only. It runs after seed/auth.ts (seeds run in name order; the
 * people are its users); the order is named by id only (the row's record needs no reference).
 *
 * Written in the tenant's office scope as the API writes them (the action first, then its history, in one transaction:
 * the …_insights_attention_actions_guards triggers check each assignment is in the history at commit). A second run
 * inserts nothing (rows found by id first; the history is append-only). The action ends with nothing set, so the
 * generated isolation tests can copy it.
 */

const ASSIGNED_AT = new Date('2026-10-28T10:00:00.000Z')
const TAKEN_BACK_AT = new Date('2026-10-28T10:05:00.000Z')
const REQUEST = 'seed-insights'

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const memberId = id('user:member')
  const orderId = id('sales:SO1')
  const actionId = id('insights:action:SO1')
  const identity = { rowKey: `ORDER_PROMISE:${orderId}`, kind: 'ORDER_PROMISE', recordType: 'SalesOrder', recordId: orderId, companyId: id('company:A'), siteId: null, partyId: id('party:P1') }
  const condition = '5eed0000000000000000000000000001'

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.attentionAction.findUnique({ where: { id: actionId }, select: { id: true } }))) {
        await tx.attentionAction.create({
          data: { id: actionId, ...identity, subKey: null, assignedToId: memberId, assignedById: ownerId, assignedAt: ASSIGNED_AT, createdAt: ASSIGNED_AT, updatedAt: ASSIGNED_AT, createdById: ownerId },
          select: { id: true },
        })
        const log = { actionId, ...identity, recordLabel: 'SEED-SO-0001', condition, actorId: ownerId, assigneeId: memberId, requestId: REQUEST }
        await tx.attentionActionLog.create({ data: { id: id('insights:action:SO1:log:1'), ...log, verb: 'ASSIGNED', at: ASSIGNED_AT, createdAt: ASSIGNED_AT }, select: { id: true } })
        await tx.attentionAction.update({ where: { id: actionId }, data: { assignedToId: null, assignedById: null, assignedAt: null, version: 2, updatedAt: TAKEN_BACK_AT }, select: { id: true } })
        await tx.attentionActionLog.create({ data: { id: id('insights:action:SO1:log:2'), ...log, verb: 'UNASSIGNED', at: TAKEN_BACK_AT, createdAt: TAKEN_BACK_AT }, select: { id: true } })
      }
      // One per person: its id is the person's user id.
      const layoutId = ownerId
      if (!(await tx.todayLayout.findUnique({ where: { id: layoutId }, select: { id: true } }))) {
        await tx.todayLayout.create({
          data: {
            id: layoutId,
            userId: ownerId,
            sections: [
              { id: 'flow', hidden: false },
              { id: 'focus-strip', hidden: false },
              { id: 'needs-me', hidden: false },
              { id: 'role-panels', hidden: false },
            ],
            panels: [{ id: 'lateOrders', hidden: false, width: 'TWO_THIRDS' }],
            mainLens: 'ORDERS',
            createdAt: ASSIGNED_AT,
            updatedAt: ASSIGNED_AT,
            createdById: ownerId,
          },
          select: { id: true },
        })
      }
    }),
  )
}
