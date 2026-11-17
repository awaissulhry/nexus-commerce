import { PpeCategory, ProductType, SalesLineKind, StyleRevisionStatus, StyleStatus, UserAudience, UserStatus, WorkCentreKind, WorkOrderKind, WorkOrderStatus } from '../src/generated/prisma/enums'
import { seedAt } from '../src/seed-calendar' // B-W2b-F53: the seeds' future follows the calendar
import { seedUuid, type SeedContext } from '../src/seeding'
import { seedSecondBrand, type SecondBrand } from '../src/testing/second-brand'
import { seed as seedAuth } from './auth'
import { seed as seedFiles } from './files'
import { seed as seedProduction } from './production'
import { seed as seedRoles } from './roles'

/**
 * B-PR-39 (production plan slice 1, the brand wall walk; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."):
 * a SECOND customer in production, per tenant of seed/_core.ts, so a walk (and the golden flows) meet two brands in one
 * factory. It EXTENDS the threads plan's second brand (src/testing/second-brand.ts, B-TH-001: party SEED-C2B "Seed Brand Two",
 * its portal buyer, CONFIRMED order SEED-SO-B001, thread, file, notice) — written here once, as that fixture writes it — and
 * adds, in tenant A's office scope as the app does:
 *
 *   style        SEED-JKT-B2 "Seed Brand Two jacket", Seed Brand Two's own private label (sizes 50-54, BLK), revision 1
 *                RELEASED with the production seed's four steps (cut, sew, final inspection, pack at A1's work centres) and
 *                no bill of materials and no label template (it adds no material to anyone's plan);
 *   order line   SEED-SO-B001 line 10: BLK 2/3/1 of sizes 50/52/54;
 *   work orders  SEED-WO-B001 (50 and 52) released with batch SEED-BT-B001 and IN_PROGRESS — in production — and SEED-WO-B002
 *                (54) a DRAFT, each with its four operations: both of Seed Brand Two only (B-PR-01), together the whole line;
 *   office       "Seed Brand Two Office" (ACTIVE, no password): production manager over every company and site, LIMITED to
 *                Seed Brand Two (RoleAssignment.partyIds) — the person the wall walk signs in as;
 *   portal       Seed Brand Two's people: the fixture's buyer gets the Buyer role, plus a Viewer and a Designer (ACTIVE, e-mail
 *                code only); its portal settings with the portal OFF (every customer ships OFF: Owner answer C1; the walk
 *                switches it on) and the three roles allowed.
 *   B-PR-15      (production plan, schema wave 3/5; the seeds B-PR-14 left) a fourth person of Seed Brand Two with the customer
 *                Production role (customer-production: its orders in production, no prices), that role allowed too, and
 *                its share level PROGRESS (production progress shared: progressShared in step). P1 keeps STATUS: the portal
 *                golden flow and the portal-orders tests read its progress as not shared, and its people fill its seats.
 *
 * Local and test databases only: the seed CLI refuses any other (src/cli.ts assertTestDatabaseUrl). Runs the auth, roles,
 * files and production seeds first (each idempotent). Every name, address and number is invented (`example.com`). Ids start
 * with `ffffffff`, so no generated test takes one as "the first row" it copies. Idempotent: each part is written once and
 * skipped when it exists (a released revision and a released work order are frozen); people, roles and settings are upserted.
 */

/** Fixed instants, so the seed never depends on the clock (every one before the day the step was built). */
const T = {
  setup: new Date('2026-11-03T08:00:00.000Z'),
  released: new Date('2026-11-04T09:00:00.000Z'),
  line: new Date('2026-11-05T08:00:00.000Z'),
  planned: new Date('2026-11-06T08:00:00.000Z'),
  woReleased: new Date('2026-11-09T07:30:00.000Z'),
  started: new Date('2026-11-10T07:00:00.000Z'),
} as const
const DUE = seedAt('2026-12-18T00:00:00.000Z')
const SIZES = ['50', '52', '54'] as const
const GRID: Readonly<Record<(typeof SIZES)[number], number>> = { '50': 2, '52': 3, '54': 1 }
/** The production seed's routing (seed/production.ts ROUTING): the operation library's step, its work centre at A1. */
const ROUTING = [
  { seq: 10, operation: 'CUT', code: 'SEED-CUT-LEA', name: 'Cut leather panels', kind: WorkCentreKind.CUTTING, minutes: '14.000', centre: 'CUT' },
  { seq: 20, operation: 'SEW', code: 'SEED-SEW-ASM', name: 'Sew and assemble the body', kind: WorkCentreKind.SEWING, minutes: '96.500', centre: 'SEW' },
  { seq: 30, operation: 'QC', code: 'SEED-FIN-QC', name: 'Final inspection', kind: WorkCentreKind.INSPECTION, minutes: '8.000', centre: 'QC' },
  { seq: 40, operation: 'PACK', code: 'SEED-PACK', name: 'Pack', kind: WorkCentreKind.PACKING, minutes: '3.500', centre: 'PACK' },
] as const

export interface TwoBrandsSeed {
  readonly second: SecondBrand
  readonly styleId: string
  readonly salesOrderLineId: string
  readonly workOrderIds: { readonly inProduction: string; readonly draft: string }
  readonly officeUserId: string
  readonly portalUserIds: { readonly buyer: string; readonly viewer: string; readonly designer: string; readonly production: string } // B-PR-15: + production
}

export async function seed(context: SeedContext): Promise<TwoBrandsSeed> {
  const { db, namespace } = context
  await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  await seedFiles(context)
  await seedProduction(context)
  const second = await seedSecondBrand(context)

  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => `ffffffff${seedUuid(namespace, `two-brands:${key}`).slice(8)}`
  const tenantId = base('tenant')
  const actorId = base('actor')
  const companyA = base('company:A')
  const siteA = base('site:A1')
  const partyId = second.partyId
  const styleId = id('style:JKT-B2')
  const blk = id('colourway:JKT-B2:BLK')
  const revisionId = id('revision:JKT-B2:1')
  const lineId = id('order:SO-B001:10')
  const made: TwoBrandsSeed = {
    second,
    styleId,
    salesOrderLineId: lineId,
    workOrderIds: { inProduction: id('work-order:WO-B001'), draft: id('work-order:WO-B002') },
    officeUserId: id('user:office'),
    portalUserIds: { buyer: second.userId, viewer: id('user:viewer'), designer: id('user:designer'), production: id('user:production') /* B-PR-15 */ },
  }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const
  const office = { audience: 'office' as const, tenantId, actorId }

  // --- Seed Brand Two's own jacket, released ------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.styleRevision.findUnique({ where: { id: revisionId }, select })) return
      await tx.style.create({
        data: {
          id: styleId,
          code: 'SEED-JKT-B2',
          name: 'Seed Brand Two jacket',
          nameI18n: { it: 'Giacca Seed Brand Two', en: 'Seed Brand Two jacket' },
          description: 'A made-up jacket of the second brand’s own label (the brand wall walk).',
          productType: ProductType.JACKET,
          season: 'FW27',
          brandPartyId: partyId,
          sizeScaleId: base('product:size-scale:EU-JKT'),
          sizes: [...SIZES],
          baseSize: '52',
          ppeCategory: PpeCategory.CATEGORY_II,
          ppeStandard: 'EN 17092-3:2020',
          ppeClass: 'AA',
          status: StyleStatus.ACTIVE,
          ...stamp(T.setup),
        },
        select,
      })
      await tx.colourway.create({ data: { id: blk, styleId, code: 'BLK', name: 'Black', colourId: base('product:colour:BLK'), ...stamp(T.setup) }, select })
      await tx.styleRevision.create({ data: { id: revisionId, styleId, revision: 1, status: StyleRevisionStatus.DRAFT, changeNote: 'First revision (made up).', ...stamp(T.setup) }, select })
      await tx.routingOperation.createMany({
        data: ROUTING.map((step) => ({ id: id(`routing:JKT-B2:1:${step.code}`), styleId, revisionId, seq: step.seq, operationId: base(`product:operation:${step.operation}`), code: step.code, name: step.name, workCentreKind: step.kind, standardMinutes: step.minutes, ...stamp(T.setup) })),
      })
      await tx.styleRevision.update({ where: { id: revisionId }, data: { status: StyleRevisionStatus.RELEASED, releasedAt: T.released, releasedById: actorId, updatedAt: T.released }, select })
    }),
  )

  // --- its line on the threads' SEED-SO-B001, and its two work orders -----------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.salesOrderLine.findUnique({ where: { id: lineId }, select })) return
      const pieces = SIZES.reduce((sum, size) => sum + GRID[size], 0)
      await tx.salesOrderLine.create({
        data: { id: lineId, companyId: companyA, orderId: second.salesOrderId, partyId, seq: 10, kind: SalesLineKind.SIZE_GRID, styleId, styleRevisionId: revisionId, colourwayId: blk, quantity: pieces, unitPrice: '380.000000', netAmount: pieces * 38_000, vatRatePct: '22.00', vatAmount: (pieces * 38_000 * 22) / 100, ...stamp(T.line) },
        select,
      })
      await tx.salesOrderLineSize.createMany({ data: SIZES.map((size) => ({ id: id(`order:SO-B001:10:${size}`), lineId, partyId, size, quantity: GRID[size] })) })
    }),
  )
  // Each a DRAFT with its cells and its operations (one per routing step, at A1's work centre of the step), written once.
  const workOrder = (workOrderId: string, number: string, sizes: readonly (typeof SIZES)[number][]) =>
    db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        if (!(await tx.workOrder.findUnique({ where: { id: workOrderId }, select }))) {
          await tx.workOrder.create({ data: { id: workOrderId, companyId: companyA, siteId: siteA, number, kind: WorkOrderKind.SIZE_GRID, partyId, styleId, styleRevisionId: revisionId, dueDate: DUE, ...stamp(T.planned) }, select })
          await tx.workOrderSize.createMany({
            data: sizes.map((size) => ({ id: id(`${number}:cell:BLK:${size}`), siteId: siteA, workOrderId, styleId, colourwayId: blk, size, quantity: GRID[size], salesOrderLineId: lineId, partyId, ...stamp(T.planned) })),
          })
        }
        if ((await tx.workOrderOperation.count({ where: { workOrderId } })) > 0) return
        await tx.workOrderOperation.createMany({
          data: ROUTING.map((step) => ({ id: id(`${number}:operation:${step.seq}`), siteId: siteA, workOrderId, styleRevisionId: revisionId, seq: step.seq, routingSeq: step.seq, code: step.code, name: step.name, standardMinutes: step.minutes, workCentreId: base(`site:A1:work-centre:${step.centre}`), ...stamp(T.planned) })),
        })
      }),
    )
  await workOrder(made.workOrderIds.inProduction, 'SEED-WO-B001', ['50', '52'])
  await workOrder(made.workOrderIds.draft, 'SEED-WO-B002', ['54'])
  // SEED-WO-B001 released with its revision (no label template on it) and its batch, then started: in production. Once.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if ((await tx.workOrder.findUnique({ where: { id: made.workOrderIds.inProduction }, select: { status: true } }))?.status !== WorkOrderStatus.DRAFT) return
      await tx.workOrder.update({ where: { id: made.workOrderIds.inProduction }, data: { status: WorkOrderStatus.RELEASED, batchNumber: 'SEED-BT-B001', releasedAt: T.woReleased, releasedById: actorId, updatedAt: T.woReleased }, select })
      await tx.workOrder.update({ where: { id: made.workOrderIds.inProduction }, data: { status: WorkOrderStatus.IN_PROGRESS, startedAt: T.started, updatedAt: T.started }, select })
    }),
  )

  // --- the office person limited to it, and its portal people ---------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const people = [
        { id: made.officeUserId, email: `brand-two.office.${namespace}@example.com`, displayName: 'Seed Brand Two Office', status: UserStatus.ACTIVE, requireMfa: false },
        { id: made.portalUserIds.viewer, email: `viewer.second-brand.${namespace}@example.com`, displayName: 'Seed Second Brand Viewer', status: UserStatus.ACTIVE, audience: UserAudience.PARTNER, partyId, partnerKind: 'CUSTOMER' as const, locale: 'en' },
        { id: made.portalUserIds.designer, email: `designer.second-brand.${namespace}@example.com`, displayName: 'Seed Second Brand Designer', status: UserStatus.ACTIVE, audience: UserAudience.PARTNER, partyId, partnerKind: 'CUSTOMER' as const, locale: 'it' },
        // B-PR-15: the customer's Production person.
        { id: made.portalUserIds.production, email: `production.second-brand.${namespace}@example.com`, displayName: 'Seed Second Brand Production', status: UserStatus.ACTIVE, audience: UserAudience.PARTNER, partyId, partnerKind: 'CUSTOMER' as const, locale: 'it' },
      ]
      for (const { id: userId, ...data } of people) {
        await tx.user.upsert({ where: { id: userId }, create: { id: userId, ...data, createdAt: T.setup, createdById: actorId }, update: data, select })
      }
      const assignments = [
        // Every company and site, but only Seed Brand Two's records: the wall in production (B-PR-03) and wherever a grant names parties.
        { key: 'office', userId: made.officeUserId, role: 'production_manager' },
        { key: 'buyer', userId: made.portalUserIds.buyer, role: 'customer-buyer' },
        { key: 'viewer', userId: made.portalUserIds.viewer, role: 'customer-viewer' },
        { key: 'designer', userId: made.portalUserIds.designer, role: 'customer-designer' },
        { key: 'production', userId: made.portalUserIds.production, role: 'customer-production' }, // B-PR-15
      ]
      for (const { key, role, userId } of assignments) {
        const assignmentId = id(`assignment:${key}`)
        const row = { userId, roleId: roleIds[role]!, allCompanies: true, companyIds: [], siteIds: [], partyIds: [partyId], validFrom: T.setup, grantedById: actorId }
        await tx.roleAssignment.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...row, createdAt: T.setup }, update: row, select })
      }
      // B-PR-15: + the Production role; its share level PROGRESS, so progressShared on (the database keeps the two in step).
      const settings = { partyId, portalOn: false, progressShared: true, productionLevel: 'PROGRESS' as const, maxUsers: 5, allowedRoleKeys: ['customer-buyer', 'customer-viewer', 'customer-designer', 'customer-production'] }
      // ---- th3b fix: ONE row per party, its id the party's (the PortalSettings convention, B-W2b-152; the party's id starts with
      // ffffffff too). A second row of the party under another id made "switch the portal on" fail (the office's settings read by
      // the party, then updated by the party's id) and the portal's on/off read either row (order-news T06 red with this seed).
      await tx.portalSettings.upsert({ where: { id: partyId }, create: { id: partyId, ...settings, createdAt: T.setup, createdById: actorId }, update: settings, select })
      // ---- end th3b fix
    }),
  )
  return made
}
