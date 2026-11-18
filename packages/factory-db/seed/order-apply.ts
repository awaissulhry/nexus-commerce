import { WorkOrderChangeKind, WorkOrderChangeStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedProduction } from './production'

/**
 * B-SA-005 (sales page plan, schema wave "sales page 1/1"; lead picks R1, R10): one work-order change per tenant of
 * seed/_core.ts, written in the tenant's office scope as the app does (B-SA-041's propose, inside the Accept of the change):
 *
 *   SEED-WO-0001 (P1, site A1, IN_PROGRESS) of SEED-SO-0002   LOWER_TO_ORDER, PROPOSED by the seed owner: the customer no longer
 *                                                             wants the RED 54 garment, and nothing of that cell is cut yet,
 *                                                             so the cell goes (1 → 0); no extra pieces. It waits for the
 *                                                             person who manages the work order (Home › Approvals, B-SA-044).
 *
 * The CLI runs the seeds in name order, so this one runs the seeds whose rows it names first (each idempotent): auth (the
 * proposer) and production (the order, the work order and its cells). The generated isolation tests
 * (src/isolation.pg.vitest.test.ts) copy the FIRST row of the table by id and insert the copy: the row is PROPOSED, so its copy
 * passes the …_order_apply_guards rules as it is. Every word is made up. Idempotent: the row is written once and left as it is.
 */

/** When the change was proposed: on or before SEED_DAY (history, never moved). */
const PROPOSED_AT = new Date('2026-11-15T12:00:00.000Z')

export interface OrderApplySeed {
  /** The PROPOSED change of SEED-WO-0001 (RED 54 goes). */
  readonly changeId: string
  readonly salesOrderId: string
  readonly workOrderId: string
  readonly cellId: string
}

export async function seed(context: SeedContext): Promise<OrderApplySeed> {
  const { db, namespace } = context
  const { ownerId } = await seedAuth(context)
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const changeId = id('order-apply:WO-0001:RED-54')
  const cellId = production.cellIds['RED-54']

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrderChange.findUnique({ where: { id: changeId }, select: { id: true } })) return
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: production.salesOrderId }, select: { companyId: true, partyId: true } })
      const workOrder = await tx.workOrder.findUniqueOrThrow({ where: { id: production.workOrderId }, select: { siteId: true } })
      const cell = await tx.workOrderSize.findUniqueOrThrow({ where: { id: cellId }, select: { salesOrderLineId: true, size: true, quantity: true } })
      await tx.workOrderChange.create({
        data: {
          id: changeId,
          companyId: order.companyId,
          partyId: order.partyId,
          salesOrderId: production.salesOrderId,
          siteId: workOrder.siteId,
          workOrderId: production.workOrderId,
          kind: WorkOrderChangeKind.LOWER_TO_ORDER,
          cells: [{ salesOrderLineId: cell.salesOrderLineId, size: cell.size, from: cell.quantity, to: 0, workOrderSizeId: cellId }],
          reason: 'Seed: the customer no longer wants the RED 54 garment; nothing of it is cut yet.',
          status: WorkOrderChangeStatus.PROPOSED,
          proposedById: ownerId,
          createdAt: PROPOSED_AT,
          updatedAt: PROPOSED_AT,
          createdById: ownerId,
        },
        select: { id: true },
      })
    }),
  )
  return { changeId, salesOrderId: production.salesOrderId, workOrderId: production.workOrderId, cellId }
}
