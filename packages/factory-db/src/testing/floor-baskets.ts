import { seedUuid, type SeedContext } from '../seeding'

/**
 * owb-fl0 (order workflow build, schema wave "floor baskets 2"; the guards of …_production_floor_baskets_2_guards): rows of the
 * wave's two new tables that no CLI seed writes, for the tests. The generated isolation test (isolation.pg.vitest.test.ts) writes
 * them with this fixture in each tenant, as testing/order-workflow.ts does for the base's wave. Per tenant of seed/_core.ts, at
 * plant A1 of company A, on SEED-WO-0001 and its bundle 1 (seed/production.ts), by A1's team lead on the cutting tablet:
 *
 *   BasketFlag       bundle 1 marked "Do this first" (FIRST), open, set by the lead on the tablet (the first row)
 *   FloorSuggestion  an idea told at A1 without a name: no worker, no employee, no device, no voice note (the first row)
 *
 * Written as the app does, in the floor scope of A1 signed in as the lead (the floor sets marks and sends suggestions; the office
 * only reads both; the floor never reads a suggestion back, so it is written without RETURNING). The first row of each table (an
 * id that starts with eight zeros) is the plain one a generated copy may repeat (the isolation test's adjustCopy moves a copied
 * mark to bundle 2: one open mark per basket and kind). Every word is made up. Idempotent: rows are inserted once (skipped when
 * they exist). Needs the people and production seeds of the same namespace first.
 */

/** A fixed instant, before the day the wave was built (history: it never moves). */
const AT = new Date('2026-11-27T10:00:00.000Z')

export interface FloorBasketsFixture {
  readonly tenantId: string
  readonly companyId: string
  /** Plant A1. */
  readonly siteId: string
  /** SEED-WO-0001 (A1) and its two bundles. */
  readonly workOrderId: string
  readonly bundleIds: readonly [string, string]
  /** A1's team lead (a worker) and the cutting tablet. */
  readonly leadId: string
  readonly deviceId: string
  readonly ids: { readonly flag: string; readonly suggestion: string }
}

export async function seedFloorBaskets(context: SeedContext): Promise<FloorBasketsFixture> {
  const { db, namespace } = context
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => seedUuid(namespace, `floor-baskets:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const made: FloorBasketsFixture = {
    tenantId: base('tenant'),
    companyId: base('company:A'),
    siteId: base('site:A1'),
    workOrderId: base('production:work-order:WO-0001'),
    bundleIds: [base('production:bundle:WO-0001:1'), base('production:bundle:WO-0001:2')],
    leadId: base('worker:A1:lead'),
    deviceId: base('device:A1:cutting'),
    ids: { flag: firstId('basket-flag:WO-0001:1:first'), suggestion: firstId('suggestion:A1:idea') },
  }
  const floor = { audience: 'floor', tenantId: made.tenantId, actorId: made.leadId, siteId: made.siteId } as const

  await db.withScope(floor, async (client) => {
    const lead = await client.worker.findUnique({ where: { id: made.leadId }, select: { employeeId: true } })
    const bundle = await client.bundle.findUnique({ where: { id: made.bundleIds[0] }, select: { id: true } })
    if (!lead || !bundle) throw new Error('floor-baskets fixture: needs A1\'s team lead (seed/people.ts) and SEED-WO-0001\'s bundle 1 (seed/production.ts) of the same namespace')
    await client.basketFlag.createMany({
      data: [
        {
          id: made.ids.flag,
          companyId: made.companyId,
          siteId: made.siteId,
          workOrderId: made.workOrderId,
          bundleId: made.bundleIds[0],
          kind: 'FIRST',
          setAt: AT,
          setByWorkerId: made.leadId,
          employeeId: lead.employeeId,
          deviceId: made.deviceId,
          clientEventId: 'seed-floor-baskets-flag-1',
        },
      ],
      skipDuplicates: true,
    })
    // Without a name: no worker, no employee, no device (the guard). Insert only: createMany writes no RETURNING.
    await client.floorSuggestion.createMany({
      data: [
        {
          id: made.ids.suggestion,
          companyId: made.companyId,
          siteId: made.siteId,
          kind: 'IDEA',
          words: 'Seed: a second rack by the stitching tables would save a walk.',
          clientEventId: 'seed-floor-baskets-suggestion-1',
          createdAt: AT,
        },
      ],
      skipDuplicates: true,
    })
  })
  return made
}
