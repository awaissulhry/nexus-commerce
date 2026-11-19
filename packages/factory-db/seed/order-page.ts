import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { InspectionStatus, TransportBy, WorkOrderStatus } from '../src/generated/prisma/enums'
import { seedAt } from '../src/seed-calendar'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedShipping } from './shipping'

/**
 * B-OP-046 (order page plan N6, lines-derived; the Owner's D6 "from the garments"): one shipment that carries the garments of TWO
 * orders of one customer, as the order page shows it once several orders per shipment are switched on (B-OP-047). SELF-CONTAINED:
 * it makes its own released garments, so every garment the other seeds release stays exactly as shippable as before.
 *
 *   SEED-WO-0101  a work order of SEED-JKT-02 for P1: ONE garment, BLK 52 of SEED-SO-0002's black line (its revision, label
 *                 template and routing as SEED-WO-0001's), released to the floor, then completed; SEED-INS-0101 PASSED by
 *                 A1's floor inspector (a lot of 1, the checklist as SEED-INS-0001's); SEED-REL-0101 releases it (the office,
 *                 four eyes) under the style's certificate.
 *   SEED-WO-0102  the same for SEED-JKT-03 (serial-tracked) on SEED-SO-0003's line (as SEED-WO-0003): one garment, BLK 52;
 *                 SEED-INS-0102, SEED-REL-0102 (no serial given: it is packed only when the shipment is PACKED).
 *   SEED-SH-0004  a DRAFT shipment made for SEED-SO-0002 (its first order) at plant A1, to SEED-SO-0002's ship-to, carrying those
 *                 two garments: lines of two open orders of P1, of company A, in EUR and IT_B2B (the line guard's rule, schema
 *                 wave "order page 1/1"). No join row: a shipment's orders are the orders of its lines (Shipment.salesOrderId
 *                 stays the first). Each of its cells is then released 1 and on a shipment 1: none of it is ready to ship.
 *
 * It runs after the shipping seed (which it runs itself, idempotent). Only a database seeded with EVERY seed file (the CLI, and
 * the suites that seed all files) gains it; a suite that imports seed/shipping alone keeps its counts. What moves for the
 * suites that seed every file: two more work orders (COMPLETED), inspections (PASSED), releases and a DRAFT shipment of two
 * lines; SEED-SO-0002 and SEED-SO-0003 each gain one garment in work orders and released (on that DRAFT shipment).
 *
 * Not seeded here (B-OP-022's monthly invoice of two orders, an ISSUED TD24 partly paid): written WITH a run during the order
 * page's end check (lead decision 2026-11-19).
 *
 * Every name, number and value is invented. Idempotent: each record is written once and skipped when it exists (releases are
 * append-only). Its ids sort last ("ffffffff…"): the generated isolation tests copy the FIRST row of each table, and a copy of
 * these rows would pass their cells' pieces and releases.
 */

const T = {
  planned: seedAt('2026-11-25T12:00:00.000Z'),
  released: seedAt('2026-11-25T12:30:00.000Z'),
  started: seedAt('2026-11-25T13:00:00.000Z'),
  completed: seedAt('2026-11-25T16:00:00.000Z'),
  inspected: seedAt('2026-11-25T16:30:00.000Z'),
  decided: seedAt('2026-11-25T16:45:00.000Z'),
  qualityReleased: seedAt('2026-11-25T17:00:00.000Z'),
  shipment: seedAt('2026-11-26T08:00:00.000Z'),
} as const

export interface OrderPageSeed {
  /** SEED-SH-0004: a DRAFT of SEED-SO-0002 (first) carrying a garment of SEED-SO-0003 too. */
  readonly sharedShipmentId: string
  /** Its lines: SEED-SO-0002's BLK 52 (SEED-WO-0101), then SEED-SO-0003's jacket (SEED-WO-0102). */
  readonly lineIds: readonly [string, string]
  readonly salesOrderIds: readonly [string, string]
  /** The seed's own work orders and their one cell each (first SEED-SO-0002's, then SEED-SO-0003's). */
  readonly workOrderIds: readonly [string, string]
  readonly cellIds: readonly [string, string]
  readonly releaseIds: readonly [string, string]
}

export async function seed(context: SeedContext): Promise<OrderPageSeed> {
  const { db, namespace } = context
  const shipping = await seedShipping(context)
  const { quality } = shipping
  const { production } = quality
  const id = (key: string): string => seedUuid(namespace, key)
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const inspectorId = id('worker:A1:lead')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const brandId = id('party:P1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const inspector = { audience: 'floor' as const, tenantId, actorId: inspectorId, siteId: siteA }
  const select = { id: true } as const
  const signature = (key: string): string => createHash('sha256').update(`seed signed decision ${key} (${namespace})`).digest('hex')

  const result: OrderPageSeed = {
    sharedShipmentId: lateId('order-page:shipment:SH-0004'),
    lineIds: [lateId('order-page:SH-0004:line:WO-0101'), lateId('order-page:SH-0004:line:WO-0102')],
    salesOrderIds: [production.salesOrderId, quality.serialSalesOrderId],
    workOrderIds: [lateId('order-page:work-order:WO-0101'), lateId('order-page:work-order:WO-0102')],
    cellIds: [lateId('order-page:WO-0101:cell'), lateId('order-page:WO-0102:cell')],
    releaseIds: [lateId('order-page:release:WO-0101'), lateId('order-page:release:WO-0102')],
  }
  /** Each of the seed's work orders: its number, the work order it copies the specification of, the seeded cell it mirrors. */
  const plans = [
    { index: 0, number: '0101', sourceWorkOrderId: production.workOrderId, sourceCellId: production.cellIds['BLK-52'] },
    { index: 1, number: '0102', sourceWorkOrderId: quality.serialWorkOrderId, sourceCellId: quality.serialCellId },
  ] as const

  // --- the work orders: one garment each, the specification of the seeded one, released then completed (the office) ---------
  for (const plan of plans) {
    const workOrderId = result.workOrderIds[plan.index]
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        if (await tx.workOrder.findUnique({ where: { id: workOrderId }, select })) return
        const source = await tx.workOrder.findUniqueOrThrow({ where: { id: plan.sourceWorkOrderId }, select: { kind: true, styleId: true, styleRevisionId: true, labelTemplateId: true } })
        const cell = await tx.workOrderSize.findUniqueOrThrow({ where: { id: plan.sourceCellId }, select: { styleId: true, colourwayId: true, size: true, salesOrderLineId: true } })
        const operations = await tx.workOrderOperation.findMany({ where: { workOrderId: plan.sourceWorkOrderId }, select: { seq: true, routingSeq: true, code: true, name: true, standardMinutes: true, workCentreId: true, styleRevisionId: true }, orderBy: { seq: 'asc' } })
        const stamp = { createdAt: T.planned, updatedAt: T.planned, createdById: actorId }
        await tx.workOrder.create({
          data: { id: workOrderId, companyId: companyA, siteId: siteA, number: `SEED-WO-${plan.number}`, kind: source.kind, styleId: source.styleId, styleRevisionId: source.styleRevisionId, /* B-PR-01 */ partyId: brandId, ...stamp },
          select,
        })
        await tx.workOrderSize.create({
          data: { id: result.cellIds[plan.index], siteId: siteA, workOrderId, styleId: cell.styleId, colourwayId: cell.colourwayId, size: cell.size, quantity: 1, salesOrderLineId: cell.salesOrderLineId, partyId: brandId, ...stamp },
          select,
        })
        await tx.workOrderOperation.createMany({
          data: operations.map((step) => ({ id: lateId(`order-page:WO-${plan.number}:operation:${step.seq}`), siteId: siteA, workOrderId, ...step, ...stamp })),
        })
        await tx.workOrder.update({
          where: { id: workOrderId },
          data: { status: WorkOrderStatus.RELEASED, labelTemplateId: source.labelTemplateId, batchNumber: `SEED-BT-${plan.number}`, releasedAt: T.released, releasedById: actorId, updatedAt: T.released, version: { increment: 1 } },
          select,
        })
        await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.IN_PROGRESS, startedAt: T.started, updatedAt: T.started, version: { increment: 1 } }, select })
        await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.COMPLETED, completedAt: T.completed, updatedAt: T.completed, version: { increment: 1 } }, select })
      }),
    )
  }

  // --- the inspections: a lot of one garment each, PASSED (A1's floor inspector, as the quality seed's) ------------------------
  const inspectionIds = [lateId('order-page:inspection:WO-0101'), lateId('order-page:inspection:WO-0102')] as const
  for (const plan of plans) {
    const inspectionId = inspectionIds[plan.index]
    await db.withScope(inspector, (client) =>
      client.$transaction(async (tx) => {
        if (await tx.inspection.findUnique({ where: { id: inspectionId }, select })) return
        const model = await tx.inspection.findUniqueOrThrow({ where: { id: quality.passedInspectionId }, select: { inspectionLevel: true, aqlMajor: true, aqlMinor: true, checklist: true } })
        await tx.inspection.create({
          data: {
            id: inspectionId,
            companyId: companyA,
            siteId: siteA,
            workOrderId: result.workOrderIds[plan.index],
            number: `SEED-INS-${plan.number}`,
            lotSize: 1,
            sampleSize: 1,
            inspectionLevel: model.inspectionLevel,
            aqlMajor: model.aqlMajor,
            aqlMinor: model.aqlMinor,
            acceptMajor: 0,
            acceptMinor: 0,
            inspectorWorkerId: inspectorId,
            createdAt: T.inspected,
            updatedAt: T.inspected,
            createdById: inspectorId,
          },
          select,
        })
        await tx.inspection.update({
          where: { id: inspectionId },
          data: { checklist: (model.checklist ?? []) as Prisma.InputJsonValue, status: InspectionStatus.PASSED, decidedAt: T.decided, signatureSha256: signature(`order-page WO-${plan.number}`), updatedAt: T.decided },
          select,
        })
      }),
    )
  }

  // --- the releases: one garment each, under the style's certificate (the office: not the inspector, four eyes) ---------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      for (const plan of plans) {
        const releaseId = result.releaseIds[plan.index]
        if (await tx.qualityRelease.findUnique({ where: { id: releaseId }, select })) continue
        await tx.qualityRelease.create({
          data: {
            id: releaseId,
            number: `SEED-REL-${plan.number}`,
            companyId: companyA,
            siteId: siteA,
            workOrderId: result.workOrderIds[plan.index],
            workOrderSizeId: result.cellIds[plan.index],
            inspectionId: inspectionIds[plan.index],
            quantity: 1,
            certificateIds: [quality.certificateId],
            releasedById: actorId,
            releasedAt: T.qualityReleased,
            signatureSha256: signature(`release order-page WO-${plan.number}`),
            createdAt: T.qualityReleased,
            createdById: actorId,
          },
          select,
        })
      }
    }),
  )

  // --- SEED-SH-0004: the DRAFT of SEED-SO-0002 that carries both garments (the office) ------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.shipment.findUnique({ where: { id: result.sharedShipmentId }, select })) return
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: production.salesOrderId }, select: { shipTo: true } })
      const stamp = { createdAt: T.shipment, updatedAt: T.shipment, createdById: actorId }
      await tx.shipment.create({
        data: {
          id: result.sharedShipmentId,
          companyId: companyA,
          siteId: siteA,
          partyId: brandId,
          salesOrderId: production.salesOrderId,
          number: 'SEED-SH-0004',
          shipTo: (order.shipTo ?? {}) as Prisma.InputJsonValue,
          transportBy: TransportBy.CARRIER,
          carrierCode: 'seed-express',
          carrierName: 'Seed Express',
          serviceCode: 'seed-standard',
          ...stamp,
        },
        select,
      })
      for (const plan of plans) {
        const cell = await tx.workOrderSize.findUniqueOrThrow({ where: { id: result.cellIds[plan.index] }, select: { salesOrderLineId: true, size: true } })
        await tx.shipmentLine.create({
          data: { id: result.lineIds[plan.index], siteId: siteA, partyId: brandId, shipmentId: result.sharedShipmentId, workOrderId: result.workOrderIds[plan.index], workOrderSizeId: result.cellIds[plan.index], salesOrderLineId: cell.salesOrderLineId!, size: cell.size, quantity: 1, ...stamp },
          select,
        })
      }
    }),
  )
  return result
}
