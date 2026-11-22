import { seedUuid, type SeedContext } from '../seeding'

/**
 * B-OF-030 (order files tab, schema wave "order files 1/1"): rows of the wave's new table, for the tests. The wave changes no CLI
 * seed, so the generated isolation test (isolation.pg.vitest.test.ts) writes them with this fixture (as testing/order-money.ts does
 * for its wave). Per tenant of seed/_core.ts, on the production seed's SEED-SO-0002 (P1's, open) and its SEED-WO-0001 at plant A1:
 *
 *   FileAsk  an OPEN ask on the order itself to the seed's office member ("the signed order confirmation"; the first row, the plain
 *            one a generated copy may repeat), and an OPEN ask to plant A1's team L1-A for photos of step 20 of SEED-WO-0001 (a
 *            floor ask: on a work order, no prices, no body data, no worker named).
 *
 * Written as the app does, in the office scope, by the seed's actor (the owner, an active office person). The first row (an id that
 * starts with eight zeros) is the one a generated copy may repeat; the other starts with eight f's. Every word is made up.
 * Idempotent: rows are inserted once (skipped when they exist). Needs the auth, production and people seeds of the same namespace
 * first (the isolation test runs them earlier).
 */

/** A fixed instant, before the day the step was built (history: it never moves), and the asks' due day. */
const AT = new Date('2026-11-22T09:00:00.000Z')
const DUE = new Date('2026-11-27T00:00:00.000Z')

export interface OrderFilesFixture {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  /** SEED-SO-0002 and SEED-WO-0001 (plant A1), its step 20 and A1's team L1-A. */
  readonly orderId: string
  readonly workOrderId: string
  readonly stepId: string
  readonly teamId: string
  readonly askIds: { readonly order: string; readonly floor: string }
}

export async function seedOrderFiles(context: SeedContext): Promise<OrderFilesFixture> {
  const { db, namespace } = context
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => seedUuid(namespace, `order-files:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const actorId = base('actor')
  const office = { audience: 'office', tenantId: base('tenant'), actorId } as const
  const made: OrderFilesFixture = {
    tenantId: base('tenant'),
    companyId: base('company:A'),
    partyId: base('party:P1'),
    orderId: base('production:sales-order:SO-0002'),
    workOrderId: base('production:work-order:WO-0001'),
    stepId: base('production:WO-0001:operation:20'),
    teamId: base('people:team:A1:L1-A'),
    askIds: { order: firstId('ask:SO-0002:confirmation'), floor: lateId('ask:WO-0001:step-20') },
  }
  const siteId = base('site:A1')

  await db.withScope(office, async (client) => {
    // One after another: a scoped client is one transaction.
    const workOrder = await client.workOrder.findUnique({ where: { id: made.workOrderId }, select: { id: true } })
    const team = await client.team.findUnique({ where: { id: made.teamId }, select: { id: true } })
    if (!workOrder || !team) throw new Error('order-files fixture: needs SEED-WO-0001 (seed/production.ts) and team L1-A (seed/people.ts) of the same namespace')
    await client.fileAsk.createMany({
      data: [
        {
          id: made.askIds.order,
          companyId: made.companyId,
          partyId: made.partyId,
          salesOrderId: made.orderId,
          target: 'SALES_ORDER',
          words: 'Seed: the signed order confirmation.',
          fileKind: 'DOCUMENT',
          addressee: 'PERSON',
          addresseeUserId: base('user:member'),
          dueOn: DUE,
          askedById: actorId,
          createdAt: AT,
          updatedAt: AT,
        },
        {
          id: made.askIds.floor,
          companyId: made.companyId,
          partyId: made.partyId,
          siteId,
          salesOrderId: made.orderId,
          target: 'WORK_ORDER',
          workOrderId: made.workOrderId,
          workOrderOperationId: made.stepId,
          words: 'Seed: photos of step 20, the sewn body.',
          fileKind: 'PHOTO',
          addressee: 'FLOOR_TEAM',
          addresseeTeamId: made.teamId,
          dueOn: DUE,
          askedById: actorId,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      skipDuplicates: true,
    })
  })
  return made
}
