import { seedDepartmentId } from '../../seed/product'
import { seedUuid, type SeedContext } from '../seeding'

/**
 * owb-pd2w (order workflow build, S4 schema wave "routes"; the guards of …_product_routes_guards): rows of the wave's new tables
 * that no CLI seed writes, for the tests. The generated isolation test (isolation.pg.vitest.test.ts) writes them with this
 * fixture in each tenant, as testing/order-structures.ts does for S3's wave (the ready-made routes come from seed/product.ts).
 * Per tenant of seed/_core.ts, on the product seed's SEED-JKT-01 (revision 1, a DRAFT: its parts may still be written) and the
 * sales seed's SEED-SO-0001 of P1 (its BLK line 10; no print yet, and its lines name no revision):
 *
 *   StyleRoute           "Seed double check", a MODEL route of SEED-JKT-01 revision 1 for any customer (the first row)
 *   StyleRouteStep       its steps: 2 Cutting, 4 Stitching, 5 Quality, 6 Packing, each its department's default operation
 *                        (DEPT-<n>) — the first step the first row
 *   SalesOrderLineRoute  SEED-SO-0001's line 10 goes "Only this order": Cutting → Stitching → Packing, with why (the first row;
 *                        no route picked: SEED-JKT-01 has no released revision yet)
 *
 * Written as the app does, in the office scope by the seed's actor (the owner). The first row of each table (an id that starts
 * with eight zeros) is the plain one a generated copy may repeat (the isolation test's adjustCopy moves what a unique key of ids
 * keeps once: a line's route goes to another line with none). Every word is made up. Idempotent: rows are inserted once (skipped
 * when they exist). Needs the product and sales seeds of the same namespace first (the isolation test runs them earlier).
 */

/** A fixed instant, before the day the wave was built (history: it never moves). */
const AT = new Date('2026-11-27T11:00:00.000Z')

export interface ProductRoutesFixture {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  /** SEED-JKT-01 and its revision 1 (DRAFT). */
  readonly styleId: string
  readonly revisionId: string
  /** SEED-SO-0001 and its lines 10 and 20. */
  readonly orderId: string
  readonly orderLineIds: readonly [string, string]
  readonly ids: {
    readonly route: string
    readonly steps: readonly string[]
    readonly lineRoute: string
  }
}

/** The library operation a seeded department's steps run: its default (seed/product.ts, ids of eight f's). */
const defaultOperationId = (namespace: string, number: number): string => `ffffffff${seedUuid(namespace, `product:operation:DEPT-${number}`).slice(8)}`

export async function seedProductRoutes(context: SeedContext): Promise<ProductRoutesFixture> {
  const { db, namespace } = context
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => seedUuid(namespace, `product-routes:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const ROUTE_DEPARTMENTS = [2, 4, 5, 6] as const
  const made: ProductRoutesFixture = {
    tenantId: base('tenant'),
    companyId: base('company:A'),
    partyId: base('party:P1'),
    styleId: base('product:style:JKT-01'),
    revisionId: base('product:revision:JKT-01:1'),
    orderId: base('sales:SO1'),
    orderLineIds: [base('sales:SO1:line:10'), base('sales:SO1:line:20')],
    ids: {
      route: firstId('route:double-check'),
      steps: ROUTE_DEPARTMENTS.map((_number, index) => (index === 0 ? firstId(`route:double-check:${index + 1}`) : id(`route:double-check:${index + 1}`))),
      lineRoute: firstId('line-route:SO-0001:10'),
    },
  }
  const ownerId = base('actor')
  const office = { audience: 'office', tenantId: made.tenantId, actorId: ownerId } as const
  const stamp = { createdAt: AT, updatedAt: AT, createdById: ownerId } as const

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const revision = await tx.styleRevision.findUnique({ where: { id: made.revisionId }, select: { status: true } })
      const order = await tx.salesOrder.findUnique({ where: { id: made.orderId }, select: { id: true } })
      if (!revision || !order) throw new Error('product-routes fixture: needs SEED-JKT-01 revision 1 (seed/product.ts) and SEED-SO-0001 (seed/sales.ts) of the same namespace')
      // A released revision's parts never change: its route is then left as it is (written once, while it was a draft).
      if (revision.status === 'DRAFT') {
        await tx.styleRoute.createMany({
          data: [{ id: made.ids.route, companyId: null, styleId: made.styleId, revisionId: made.revisionId, name: 'Seed double check', kind: 'MODEL', partyId: null, seq: 1, ...stamp }],
          skipDuplicates: true,
        })
        await tx.styleRouteStep.createMany({
          data: ROUTE_DEPARTMENTS.map((number, index) => ({
            id: made.ids.steps[index] as string,
            revisionId: made.revisionId,
            routeId: made.ids.route,
            seq: index + 1,
            departmentId: seedDepartmentId(namespace, number),
            operationId: defaultOperationId(namespace, number),
            minutes: index === 1 ? '40.000' : null,
            ...stamp,
          })),
          skipDuplicates: true,
        })
      }
      await tx.salesOrderLineRoute.createMany({
        data: [
          {
            id: made.ids.lineRoute,
            companyId: made.companyId,
            partyId: made.partyId,
            salesOrderId: made.orderId,
            salesOrderLineId: made.orderLineIds[0],
            exceptionSteps: [2, 4, 6].map((number) => ({ departmentId: seedDepartmentId(namespace, number), minutes: null })),
            exceptionReason: 'Seed: the customer sends the patches sewn on already.',
            exceptionAt: AT,
            exceptionById: ownerId,
            ...stamp,
          },
        ],
        skipDuplicates: true,
      })
    }),
  )
  return made
}
