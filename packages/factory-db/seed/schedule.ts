import {
  ItemKind,
  ItemSourcing,
  ItemTracking,
  LocationKind,
  PlanVersionKind,
  ReplacementKind,
  ReplacementStatus,
  ReworkStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The W2a production and schedule seed (schema wave 5/7), per tenant of seed/_core.ts, written in the tenant's office
 * scope, as the app does:
 *
 *   finished goods  A1-FG, plant A1's finished-goods location (FINISHED_GOODS), empty; the FINISHED item of SKU
 *                   SEED-JKT-02-BLK-52 (the production seed's style, colourway BLK, size 52), counted in pieces.
 *   plans           plant A1's v1, PUBLISHED (16-20 Nov, the floor works to it from 06:00 on the 16th): WO-0001's four
 *                   operations on its lanes (cutting and final inspection and packing at their work centres, sewing on
 *                   line L1), the standard minutes each books (SAM × 7 garments); and A1's shared WORKING plan, moved on
 *                   since: the same slots with sewing an hour later, and the DRAFT WO-0002's sewing added on L1 (the
 *                   floor sees none of it until the next Publish, Owner answer P3).
 *   rework          one OPEN rework of WO-0001: 1 garment of cell BLK 52 (in its sleeves bundle) found at final
 *                   inspection with its panels not aligned (REWORK reason ALIGNMENT), back to sewing.
 *   replacement     one OPEN RECUT of WO-0001: the sleeves of 1 garment of BLK 52, for the set stained at sewing (the
 *                   operator's correction request of the production seed).
 *
 * Nothing moves in the stock ledger and no work order changes: the golden flow's stock and plan at A1 are the same. The
 * generated isolation tests copy the FIRST row of each table by id and insert the copy: so v1 (a published version, a
 * copy of which is a new published version) and one working slot (a copy of which is another working slot) get ids that
 * start with eight zeros, and the finished-goods item and location ids that start with eight f's (a copy of the item
 * would name its SKU twice). Every name, number and time is invented. Idempotent: the location and item are upserted
 * (nothing of a finished-goods item's SKU changes), the plans, rework and replacement are written once and skipped when
 * they exist (a published version is frozen).
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-11-15T08:00:00.000Z'),
  planned: new Date('2026-11-15T14:00:00.000Z'),
  published: new Date('2026-11-15T16:00:00.000Z'),
  moved: new Date('2026-11-16T07:00:00.000Z'),
  inspected: new Date('2026-11-18T09:00:00.000Z'),
} as const
const DAY = { from: new Date('2026-11-16T00:00:00.000Z'), to: new Date('2026-11-20T00:00:00.000Z') } as const
/** 06:00 at the plant (Europe/Rome, CET) on the first day the floor works to v1. */
const FLOOR_START = new Date('2026-11-16T05:00:00.000Z')
const at = (day: number, hour: number): Date => new Date(Date.UTC(2026, 10, day, hour, 0, 0))

export interface ScheduleSeed {
  readonly production: ProductionSeed
  readonly finishedLocationId: string
  readonly finishedItemId: string
  readonly publishedPlanId: string
  readonly workingPlanId: string
  readonly reworkOrderId: string
  readonly replacementRequestId: string
}

export async function seed(context: SeedContext): Promise<ScheduleSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the work orders, their operations and bundles come from the production seed.
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const lane = {
    line: id('site:A1:line:L1'),
    cut: id('site:A1:work-centre:CUT'),
    qc: id('site:A1:work-centre:QC'),
    pack: id('site:A1:work-centre:PACK'),
  }

  const finishedLocationId = lastId('schedule:location:A1-FG')
  const finishedItemId = lastId('schedule:item:SEED-JKT-02-BLK-52')
  const plan = { published: firstId('schedule:plan:A1:v1'), working: id('schedule:plan:A1:working') }
  const reworkOrderId = id('schedule:rework:WO-0001:1')
  const replacementRequestId = id('schedule:replacement:WO-0001:1')

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const place = { companyId: companyA, siteId: siteA, code: 'A1-FG', name: 'Seed finished goods (A1)', kind: LocationKind.FINISHED_GOODS, updatedAt: T.setup }
      await tx.location.upsert({ where: { id: finishedLocationId }, create: { id: finishedLocationId, ...place, createdAt: T.setup, createdById: actorId }, update: place, select: { id: true } })
      const garment = {
        code: 'SEED-JKT-02-BLK-52',
        name: 'Seed jacket 02, black, size 52 (finished)',
        kind: ItemKind.FINISHED,
        sourcing: ItemSourcing.MAKE,
        tracking: ItemTracking.NONE,
        baseUom: Uom.PCS,
        purchaseUom: Uom.PCS,
        consumptionUom: Uom.PCS,
        variantId: id('production:variant:JKT-02:BLK:52'),
        updatedAt: T.setup,
      }
      await tx.item.upsert({ where: { id: finishedItemId }, create: { id: finishedItemId, ...garment, createdAt: T.setup, createdById: actorId }, update: garment, select: { id: true } })
    }),
  )

  // --- the planning board: v1 as published to the floor, and the working plan since -------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.planVersion.findUnique({ where: { id: plan.published }, select: { id: true } })) return
      const operations = await tx.workOrderOperation.findMany({
        where: { workOrderId: { in: [production.workOrderId, production.draftWorkOrderId] } },
        select: { id: true, workOrderId: true, seq: true, standardMinutes: true },
      })
      const garments = { [production.workOrderId]: 7, [production.draftWorkOrderId]: 1 } as Record<string, number>
      const minutesOf = (operationId: string): string => {
        const operation = operations.find((entry) => entry.id === operationId)
        if (!operation) throw new Error(`schedule seed: operation ${operationId} is missing`)
        return (Number(operation.standardMinutes) * (garments[operation.workOrderId] ?? 0)).toFixed(3)
      }
      const draftSew = operations.find((entry) => entry.workOrderId === production.draftWorkOrderId && entry.seq === 20)
      if (!draftSew) throw new Error('schedule seed: WO-0002 has no sewing operation')
      const ops = production.operationIds
      type Slot = { key: string; workOrderId: string; operationId: string; lane: { lineId?: string; workCentreId?: string }; start: Date; end: Date }
      const v1: Slot[] = [
        { key: 'cut', workOrderId: production.workOrderId, operationId: ops.cut, lane: { workCentreId: lane.cut }, start: at(16, 8), end: at(16, 10) },
        { key: 'sew', workOrderId: production.workOrderId, operationId: ops.sew, lane: { lineId: lane.line }, start: at(17, 8), end: at(17, 16) },
        { key: 'qc', workOrderId: production.workOrderId, operationId: ops.qc, lane: { workCentreId: lane.qc }, start: at(18, 8), end: at(18, 10) },
        { key: 'pack', workOrderId: production.workOrderId, operationId: ops.pack, lane: { workCentreId: lane.pack }, start: at(18, 10), end: at(18, 11) },
      ]
      // The working plan: sewing an hour later than v1 says, and the draft WO-0002 placed on the line after it.
      const working: Slot[] = [
        ...v1.map((slot) => (slot.key === 'sew' ? { ...slot, start: at(17, 9), end: at(17, 17) } : slot)),
        { key: 'WO-0002:sew', workOrderId: production.draftWorkOrderId, operationId: draftSew.id, lane: { lineId: lane.line }, start: at(19, 8), end: at(19, 10) },
      ]
      const slotRows = (planId: string, kind: PlanVersionKind, slots: readonly Slot[], idOf: (key: string) => string, when: Date, who: string) =>
        slots.map((slot) => ({
          id: idOf(slot.key),
          siteId: siteA,
          planVersionId: planId,
          planKind: kind,
          workOrderId: slot.workOrderId,
          workOrderOperationId: slot.operationId,
          ...slot.lane,
          startAt: slot.start,
          endAt: slot.end,
          minutes: minutesOf(slot.operationId),
          createdAt: when,
          updatedAt: when,
          createdById: who,
          updatedById: who,
        }))

      // Publish (as the API does): the version without publishedAt, its slots, then publishedAt (frozen from then on).
      await tx.planVersion.create({
        data: {
          id: plan.published,
          companyId: companyA,
          siteId: siteA,
          kind: PlanVersionKind.PUBLISHED,
          number: 1,
          coversFrom: DAY.from,
          coversTo: DAY.to,
          effectiveFrom: FLOOR_START,
          note: 'First plan of the seed week.',
          createdAt: T.published,
          updatedAt: T.published,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.scheduleSlot.createMany({ data: slotRows(plan.published, PlanVersionKind.PUBLISHED, v1, (key) => id(`schedule:slot:A1:v1:${key}`), T.published, actorId) })
      await tx.planVersion.update({ where: { id: plan.published }, data: { publishedAt: T.published, publishedById: actorId, version: 2 }, select: { id: true } })

      await tx.planVersion.create({
        data: { id: plan.working, companyId: companyA, siteId: siteA, kind: PlanVersionKind.WORKING, createdAt: T.planned, updatedAt: T.moved, createdById: actorId },
        select: { id: true },
      })
      await tx.scheduleSlot.createMany({
        data: slotRows(plan.working, PlanVersionKind.WORKING, working, (key) => (key === 'cut' ? firstId(`schedule:slot:A1:working:${key}`) : id(`schedule:slot:A1:working:${key}`)), T.moved, actorId),
      })
    }),
  )

  // --- rework and replacement of WO-0001 ---------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.reworkOrder.findUnique({ where: { id: reworkOrderId }, select: { id: true } }))) {
        await tx.reworkOrder.create({
          data: {
            id: reworkOrderId,
            companyId: companyA,
            siteId: siteA,
            workOrderId: production.workOrderId,
            workOrderSizeId: production.cellIds['BLK-52'],
            bundleId: production.bundleIds[1],
            foundAtOperationId: production.operationIds.qc,
            reworkAtOperationId: production.operationIds.sew,
            quantity: 1,
            reasonCode: 'ALIGNMENT',
            description: 'Left sleeve panel set 3 mm off the shoulder seam: unpick and sew again.',
            status: ReworkStatus.OPEN,
            createdAt: T.inspected,
            updatedAt: T.inspected,
            createdById: actorId,
          },
          select: { id: true },
        })
      }
      if (!(await tx.replacementRequest.findUnique({ where: { id: replacementRequestId }, select: { id: true } }))) {
        await tx.replacementRequest.create({
          data: {
            id: replacementRequestId,
            companyId: companyA,
            siteId: siteA,
            workOrderId: production.workOrderId,
            workOrderSizeId: production.cellIds['BLK-52'],
            kind: ReplacementKind.RECUT,
            quantity: 1,
            part: 'sleeve',
            reason: 'One sleeve set stained at sewing (the correction the operator asked for).',
            status: ReplacementStatus.OPEN,
            createdAt: T.inspected,
            updatedAt: T.inspected,
            createdById: actorId,
          },
          select: { id: true },
        })
      }
    }),
  )

  return { production, finishedLocationId, finishedItemId, publishedPlanId: plan.published, workingPlanId: plan.working, reworkOrderId, replacementRequestId }
}
