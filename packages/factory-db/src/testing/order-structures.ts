import { seedFile } from '../seed-files'
import { seedUuid, type SeedContext } from '../seeding'

/**
 * owb-ssw (order workflow build, S3 schema wave "structures + units"; the guards of …_order_structures_guards): rows of the
 * wave's new tables that no CLI seed writes, for the tests. The generated isolation test (isolation.pg.vitest.test.ts) writes
 * them with this fixture in each tenant, as testing/order-workflow.ts does for the base's wave. Per tenant of seed/_core.ts,
 * on P1's SEED-SO-0002 (its BLK line), A1's team L1-A (company A) and the auth seed's office member:
 *
 *   StoredFile              "Seed design page.pdf", a PDF of SEED-SO-0002 (office only, company A): the design page a scan
 *                           code is placed on
 *   OrderStructure          "Seed jackets" of company A: team L1-A, the office member, open (the first row)
 *   OrderStructureRule      rule 1: customer P1, kind JACKET → "Seed jackets", open and active (the first row)
 *   OrderStructureOverride  SEED-SO-0002 takes "Seed jackets" by hand, open (the first row)
 *   OrderLineStructureKept  SEED-SO-0002's BLK line kept "Seed jackets" by hand on the ORDER at its first print (the first row)
 *   ScanCodePlacement       the scan code on page 1 of the design page for the BLK line, 12 mm from the left and the top,
 *                           25 mm wide (the first row)
 *
 * Written as the app does, in the office scope by the seed's actor (the owner, an active office person). The first row of each
 * table (an id that starts with eight zeros) is the plain one a generated copy may repeat (the isolation test's adjustCopy moves
 * what a partial unique or a guard keeps once: a rule's kind, an order's open structure by hand, a line's kept structure); the
 * file starts with eight f's. Every word is made up. Idempotent: rows are inserted once (skipped when they exist). Needs the
 * people, production and files seeds of the same namespace first (the isolation test runs them earlier).
 */

/** A fixed instant, before the day the wave was built (history: it never moves). */
const AT = new Date('2026-11-27T10:00:00.000Z')

export interface OrderStructuresFixture {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  /** SEED-SO-0002 and its BLK and RED lines. */
  readonly orderId: string
  readonly orderLineIds: readonly [string, string]
  /** A1's team L1-A (company A). */
  readonly teamId: string
  /** The auth seed's owner (the actor) and member, both active office people. */
  readonly ownerId: string
  readonly memberId: string
  readonly ids: {
    readonly file: string
    readonly structure: string
    readonly rule: string
    readonly override: string
    readonly kept: string
    readonly placement: string
  }
}

export async function seedOrderStructures(context: SeedContext): Promise<OrderStructuresFixture> {
  const { db, namespace } = context
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => seedUuid(namespace, `order-structures:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const made: OrderStructuresFixture = {
    tenantId: base('tenant'),
    companyId: base('company:A'),
    partyId: base('party:P1'),
    orderId: base('production:sales-order:SO-0002'),
    orderLineIds: [base('production:sales-order:SO-0002:10'), base('production:sales-order:SO-0002:20')],
    teamId: base('people:team:A1:L1-A'),
    ownerId: base('actor'),
    memberId: base('user:member'),
    ids: {
      file: lateId('file:SO-0002:design'),
      structure: firstId('structure:jackets'),
      rule: firstId('rule:P1:JACKET'),
      override: firstId('override:SO-0002'),
      kept: firstId('kept:SO-0002:10'),
      placement: firstId('placement:SO-0002:10:page-1'),
    },
  }
  const office = { audience: 'office', tenantId: made.tenantId, actorId: made.ownerId } as const
  const ofOrder = { companyId: made.companyId, partyId: made.partyId, salesOrderId: made.orderId } as const
  const stamp = { createdAt: AT, updatedAt: AT, createdById: made.ownerId } as const

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({ where: { id: made.orderId }, select: { id: true } })
      const team = await tx.team.findUnique({ where: { id: made.teamId }, select: { id: true } })
      if (!order || !team) throw new Error('order-structures fixture: needs SEED-SO-0002 (seed/production.ts) and team L1-A (seed/people.ts) of the same namespace')
      await tx.storedFile.createMany({
        data: [
          seedFile(made.tenantId, {
            id: made.ids.file,
            companyId: made.companyId,
            recordType: 'SalesOrder',
            recordId: made.orderId,
            kind: 'DOCUMENT',
            originalName: 'Seed design page.pdf',
            contentType: 'application/pdf',
            sizeBytes: 2048,
            storageKey: `t/${made.tenantId}/c/${made.companyId}/2026/${id('file:key')}`,
            visibility: ['OFFICE'],
            status: 'AVAILABLE',
            availableAt: AT,
            storeAccountId: base('files:account:r2'),
            ...stamp,
          }),
        ],
        skipDuplicates: true,
      })
      await tx.orderStructure.createMany({
        data: [{ id: made.ids.structure, companyId: made.companyId, name: 'Seed jackets', teamIds: [made.teamId], peopleUserIds: [made.memberId], note: 'Seed: the jackets of the line 1 team.', ...stamp }],
        skipDuplicates: true,
      })
      await tx.orderStructureRule.createMany({
        data: [{ id: made.ids.rule, companyId: made.companyId, sortOrder: 1, partyId: made.partyId, category: 'JACKET', structureId: made.ids.structure, ...stamp }],
        skipDuplicates: true,
      })
      await tx.orderStructureOverride.createMany({
        data: [{ id: made.ids.override, ...ofOrder, structureId: made.ids.structure, why: 'Seed: the customer asked for the line 1 team.', createdAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.orderLineStructureKept.createMany({
        data: [
          {
            id: made.ids.kept,
            ...ofOrder,
            salesOrderLineId: made.orderLineIds[0],
            structureId: made.ids.structure,
            keptFrom: 'ORDER',
            snapshot: { steps: [], teams: [{ id: made.teamId, name: 'Line 1 team' }], people: [{ id: made.memberId, name: 'Seed Office Member' }] },
            keptAt: AT,
            keptById: made.ownerId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.scanCodePlacement.createMany({
        data: [{ id: made.ids.placement, ...ofOrder, salesOrderLineId: made.orderLineIds[0], fileId: made.ids.file, page: 1, xMm: '12.00', yMm: '12.00', sizeMm: '25.00', placedAt: AT, placedById: made.ownerId }],
        skipDuplicates: true,
      })
    }),
  )
  return made
}
