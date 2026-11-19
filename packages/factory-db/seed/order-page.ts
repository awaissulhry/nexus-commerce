import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  DdtFreight,
  DdtReason,
  InspectionStatus,
  InvoiceDocType,
  InvoiceLineKind,
  InvoicePriceBasis,
  InvoiceStatus,
  PaymentMethod,
  SalesLineKind,
  SalesOrderStatus,
  ShipmentStatus,
  TransportBy,
  TransportMode,
  WorkOrderStatus,
} from '../src/generated/prisma/enums'
import { seedAt, seedDay } from '../src/seed-calendar'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedMoney } from './money' // B-OP-046 (P16): the INVOICE series past the money seed's numbers
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
 * B-OP-046 (P16; order page plan N3, B-OP-022): the MONTHLY INVOICE OF TWO ORDERS — one issued TD24 of P1 that bills the shipped
 * goods of two of its orders, partly paid, so the order page's Money tab shows on each order its own share, the invoice's whole
 * and "also bills" the other order. Self-contained too: its own orders, garments, shipments and DDTs.
 *
 *   SEED-SO-0101  P1's order (the customer's SEED-PO-101), typed by the office: SEED-JKT-02 BLK 52 × 1 at 400.00 + VAT 22 %;
 *   SEED-SO-0102  P1's order (SEED-PO-102): SEED-JKT-02 BLK 52 × 2 at 400.00. Both SHIPPED once their goods left.
 *   SEED-WO-0103  / SEED-WO-0104 make them (1 and 2 garments; as SEED-WO-0101), SEED-INS-0103 / 0104 PASSED, SEED-REL-0103 / 0104.
 *   SEED-SH-0101  / SEED-SH-0102, one per order: packed on the floor (one parcel, weighed), our own van (SENDER), each with a DDT
 *                 of company A's series (the next numbers, taken as allocateNumber takes them; dated 30 October like the
 *                 shipping seed's DDT 144, so the series stays in date order), then SHIPPED.
 *   TD24          FT-2026-<next> (after the money seed's FT-2026-00003: the number allocateNumber would give), dated 31 October
 *                 (history: the INVOICE series lets every later day's invoice follow it), ISSUED, not sent: its two lines bill
 *                 the two DDTs' goods (400.00 of SEED-SO-0101, 800.00 of SEED-SO-0102): net 1,200.00, VAT 264.00, gross 1,464.00,
 *                 no freight; no order of its own (it bills two). Partly paid: one bank transfer (SEED-TRN-0000101, 600.00)
 *                 placed on it whole, so SEED-SO-0101's share is 488.00 with 200.00 paid, SEED-SO-0102's 976.00 with 400.00.
 *
 * It runs after the shipping seed (which it runs itself, idempotent) and, for the TD24, after the money seed. Only a database seeded
 * with EVERY seed file (the CLI, and the suites that seed all files) gains it; a suite that imports seed/shipping alone keeps its
 * counts. What moves for the suites that seed every file: four more work orders (COMPLETED), inspections (PASSED) and releases; a
 * DRAFT shipment of two lines; SEED-SO-0002 and SEED-SO-0003 each gain one garment in work orders and released (on that DRAFT
 * shipment); two more orders of P1 (SHIPPED), two SHIPPED shipments with their parcels, two DDTs (the DDT series moves on by two),
 * one ISSUED invoice of two lines (the INVOICE series moves on by one), one payment and its allocation.
 *
 * Every name, number and value is invented. Idempotent: each record is written once and skipped when it exists (releases, DDTs,
 * issued invoices and allocations never change after that). Its ids sort last ("ffffffff…"): the generated isolation tests copy
 * the FIRST row of each table, and a copy of these rows would pass their cells' pieces and releases.
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

// ── B-OP-046 (P16): the monthly invoice's story ───────────────────────────────────────────────────────────────────────────────
/** Its orders were typed in the seeds' week (history); their goods left in the story's days to come, as SH-0001's did. */
const MONTHLY_T = {
  ordered: new Date('2026-11-12T09:00:00.000Z'),
  shipment: seedAt('2026-11-26T09:00:00.000Z'),
  packed: seedAt('2026-11-26T10:00:00.000Z'),
  ddt: seedAt('2026-11-26T10:30:00.000Z'),
  start: seedAt('2026-11-26T11:00:00.000Z'),
  left: seedAt('2026-11-26T11:05:00.000Z'),
  // The invoice and its payment are history (the INVOICE series and the bank's days only grow older).
  issued: new Date('2026-10-31T10:00:00.000Z'),
  paid: new Date('2026-11-12T09:00:00.000Z'),
} as const
const MONTHLY_DAY = {
  orderDate: new Date('2026-11-12T00:00:00.000Z'),
  promise: seedAt('2026-12-04T00:00:00.000Z'),
  // B-W2b-30: the DDTs' date is the shipping seed's (30 October), before the invoice of them; the times above stay in the story.
  ddt: new Date('2026-10-30T00:00:00.000Z'),
  invoice: new Date('2026-10-31T00:00:00.000Z'),
  paid: new Date('2026-11-12T00:00:00.000Z'),
} as const
const MONTHLY_YEAR = '2026'
/** Its two orders: number, the customer's own reference, the BLK 52 garments, its work order. */
const MONTHLY_ORDERS = [
  { number: '0101', customerRef: 'SEED-PO-101', pieces: 1, workOrder: '0103' },
  { number: '0102', customerRef: 'SEED-PO-102', pieces: 2, workOrder: '0104' },
] as const
/** 400.00 a jacket, VAT 22 % (minor units). */
const MONTHLY_PRICE = { unit: 40_000, vat: 8_800 } as const

export interface MonthlyInvoiceSeed {
  /** SEED-SO-0101 (1 garment) and SEED-SO-0102 (2), SHIPPED; their one line each. */
  readonly salesOrderIds: readonly [string, string]
  readonly salesOrderLineIds: readonly [string, string]
  /** SEED-WO-0103 / 0104 and their one cell each, their releases. */
  readonly workOrderIds: readonly [string, string]
  readonly cellIds: readonly [string, string]
  readonly releaseIds: readonly [string, string]
  /** SEED-SH-0101 / 0102 (SHIPPED), their line, parcel and DDT. */
  readonly shipmentIds: readonly [string, string]
  readonly shipmentLineIds: readonly [string, string]
  readonly parcelIds: readonly [string, string]
  readonly ddtIds: readonly [string, string]
  /** The ISSUED TD24 and its two lines (first SEED-SO-0101's), the payment placed on it and its allocation. */
  readonly invoiceId: string
  readonly invoiceLineIds: readonly [string, string]
  readonly paymentId: string
  readonly allocationId: string
}
// ── end B-OP-046 (P16)

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
  /** B-OP-046 (P16): the monthly invoice of two orders. */
  readonly monthly: MonthlyInvoiceSeed
}

/** One of the seed's own work orders: one cell of `quantity` garments, the specification of a seeded one, inspected and released. */
interface MadeHere {
  readonly number: string
  readonly workOrderId: string
  readonly cellId: string
  readonly inspectionId: string
  readonly releaseId: string
  readonly sourceWorkOrderId: string
  readonly sourceCellId: string
  readonly quantity: number
  /** B-OP-046 (P16): the order line it makes, when not the seeded cell's. */
  readonly salesOrderLineId?: string
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

  const sharedIds = {
    sharedShipmentId: lateId('order-page:shipment:SH-0004'),
    lineIds: [lateId('order-page:SH-0004:line:WO-0101'), lateId('order-page:SH-0004:line:WO-0102')],
    salesOrderIds: [production.salesOrderId, quality.serialSalesOrderId],
    workOrderIds: [lateId('order-page:work-order:WO-0101'), lateId('order-page:work-order:WO-0102')],
    cellIds: [lateId('order-page:WO-0101:cell'), lateId('order-page:WO-0102:cell')],
    releaseIds: [lateId('order-page:release:WO-0101'), lateId('order-page:release:WO-0102')],
  } as const
  /** Each of the seed's work orders for SEED-SH-0004: its number, the work order it copies the specification of, the seeded cell it mirrors. */
  const plans: readonly MadeHere[] = [
    { number: '0101', workOrderId: sharedIds.workOrderIds[0], cellId: sharedIds.cellIds[0], inspectionId: lateId('order-page:inspection:WO-0101'), releaseId: sharedIds.releaseIds[0], sourceWorkOrderId: production.workOrderId, sourceCellId: production.cellIds['BLK-52'], quantity: 1 },
    { number: '0102', workOrderId: sharedIds.workOrderIds[1], cellId: sharedIds.cellIds[1], inspectionId: lateId('order-page:inspection:WO-0102'), releaseId: sharedIds.releaseIds[1], sourceWorkOrderId: quality.serialWorkOrderId, sourceCellId: quality.serialCellId, quantity: 1 },
  ]

  // --- the work orders: one cell each, the specification of the seeded one, released then completed (the office) -------------
  // B-OP-046 (P16): one helper each for the work order, its inspection and the releases, so the monthly invoice's garments are made
  // the same way.
  const makeWorkOrder = async (plan: MadeHere): Promise<void> =>
    db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const workOrderId = plan.workOrderId
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
          data: { id: plan.cellId, siteId: siteA, workOrderId, styleId: cell.styleId, colourwayId: cell.colourwayId, size: cell.size, quantity: plan.quantity, salesOrderLineId: plan.salesOrderLineId ?? cell.salesOrderLineId, partyId: brandId, ...stamp },
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

  // --- the inspections: a lot of the cell's garments, PASSED (A1's floor inspector, as the quality seed's) ----------------------
  const inspect = async (plan: MadeHere): Promise<void> =>
    db.withScope(inspector, (client) =>
      client.$transaction(async (tx) => {
        const inspectionId = plan.inspectionId
        if (await tx.inspection.findUnique({ where: { id: inspectionId }, select })) return
        const model = await tx.inspection.findUniqueOrThrow({ where: { id: quality.passedInspectionId }, select: { inspectionLevel: true, aqlMajor: true, aqlMinor: true, checklist: true } })
        await tx.inspection.create({
          data: {
            id: inspectionId,
            companyId: companyA,
            siteId: siteA,
            workOrderId: plan.workOrderId,
            number: `SEED-INS-${plan.number}`,
            lotSize: plan.quantity,
            sampleSize: plan.quantity,
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

  // --- the releases: the cell's garments, under the style's certificate (the office: not the inspector, four eyes) --------------
  const release = async (made: readonly MadeHere[]): Promise<void> =>
    db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        for (const plan of made) {
          if (await tx.qualityRelease.findUnique({ where: { id: plan.releaseId }, select })) continue
          await tx.qualityRelease.create({
            data: {
              id: plan.releaseId,
              number: `SEED-REL-${plan.number}`,
              companyId: companyA,
              siteId: siteA,
              workOrderId: plan.workOrderId,
              workOrderSizeId: plan.cellId,
              inspectionId: plan.inspectionId,
              quantity: plan.quantity,
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

  for (const plan of plans) await makeWorkOrder(plan)
  for (const plan of plans) await inspect(plan)
  await release(plans)

  // --- SEED-SH-0004: the DRAFT of SEED-SO-0002 that carries both garments (the office) ------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.shipment.findUnique({ where: { id: sharedIds.sharedShipmentId }, select })) return
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: production.salesOrderId }, select: { shipTo: true } })
      const stamp = { createdAt: T.shipment, updatedAt: T.shipment, createdById: actorId }
      await tx.shipment.create({
        data: {
          id: sharedIds.sharedShipmentId,
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
      for (const [index, plan] of plans.entries()) {
        const cell = await tx.workOrderSize.findUniqueOrThrow({ where: { id: plan.cellId }, select: { salesOrderLineId: true, size: true } })
        await tx.shipmentLine.create({
          data: { id: sharedIds.lineIds[index]!, siteId: siteA, partyId: brandId, shipmentId: sharedIds.sharedShipmentId, workOrderId: plan.workOrderId, workOrderSizeId: plan.cellId, salesOrderLineId: cell.salesOrderLineId!, size: cell.size, quantity: 1, ...stamp },
          select,
        })
      }
    }),
  )

  // ── B-OP-046 (P16): the monthly invoice of two orders ────────────────────────────────────────────────────────────────────────────
  // Run what it builds on (idempotent): the money seed, so the INVOICE series is past its FT-2026-00003 and the seller and buyer
  // as issued are its.
  const money = await seedMoney(context)
  const packer = { audience: 'floor' as const, tenantId, actorId: production.operatorId, siteId: siteA }
  const pair = <V>(make: (order: (typeof MONTHLY_ORDERS)[number]) => V): readonly [V, V] => [make(MONTHLY_ORDERS[0]), make(MONTHLY_ORDERS[1])]
  const monthly: MonthlyInvoiceSeed = {
    salesOrderIds: pair((order) => lateId(`order-page:monthly:sales-order:SO-${order.number}`)),
    salesOrderLineIds: pair((order) => lateId(`order-page:monthly:sales-order:SO-${order.number}:10`)),
    workOrderIds: pair((order) => lateId(`order-page:monthly:work-order:WO-${order.workOrder}`)),
    cellIds: pair((order) => lateId(`order-page:monthly:WO-${order.workOrder}:cell`)),
    releaseIds: pair((order) => lateId(`order-page:monthly:release:WO-${order.workOrder}`)),
    shipmentIds: pair((order) => lateId(`order-page:monthly:shipment:SH-${order.number}`)),
    shipmentLineIds: pair((order) => lateId(`order-page:monthly:SH-${order.number}:line`)),
    parcelIds: pair((order) => lateId(`order-page:monthly:SH-${order.number}:parcel:1`)),
    ddtIds: pair((order) => lateId(`order-page:monthly:SH-${order.number}:ddt`)),
    invoiceId: lateId('order-page:monthly:invoice:TD24'),
    invoiceLineIds: pair((order) => lateId(`order-page:monthly:invoice:TD24:line:SO-${order.number}`)),
    paymentId: lateId('order-page:monthly:payment:SEED-TRN-0000101'),
    allocationId: lateId('order-page:monthly:allocation:SEED-TRN-0000101'),
  }
  const monthlyStamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const jacket = (pieces: number) => ({ net: pieces * MONTHLY_PRICE.unit, vat: pieces * MONTHLY_PRICE.vat })

  // --- SEED-SO-0101 and SEED-SO-0102: P1's orders, typed by the office, of SEED-SO-0002's black jacket (CONFIRMED) ----------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const model = await tx.salesOrder.findUniqueOrThrow({ where: { id: production.salesOrderId }, select: { taxMode: true, billTo: true, shipTo: true } })
      const modelLine = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: id('production:sales-order:SO-0002:10') }, select: { styleId: true, styleRevisionId: true, colourwayId: true, siteId: true } })
      for (const [index, order] of MONTHLY_ORDERS.entries()) {
        const orderId = monthly.salesOrderIds[index]!
        if (await tx.salesOrder.findUnique({ where: { id: orderId }, select })) continue
        const { net, vat } = jacket(order.pieces)
        await tx.salesOrder.create({
          data: {
            id: orderId,
            companyId: companyA,
            partyId: brandId,
            number: `SEED-SO-${order.number}`,
            customerRef: order.customerRef,
            status: SalesOrderStatus.CONFIRMED,
            orderDate: MONTHLY_DAY.orderDate,
            taxMode: model.taxMode,
            billTo: model.billTo as Prisma.InputJsonValue,
            shipTo: model.shipTo as Prisma.InputJsonValue,
            promiseDate: MONTHLY_DAY.promise,
            originalPromiseDate: MONTHLY_DAY.promise,
            netAmount: net,
            vatAmount: vat,
            grossAmount: net + vat,
            ...monthlyStamp(MONTHLY_T.ordered),
          },
          select,
        })
        await tx.salesOrderLine.create({
          data: {
            id: monthly.salesOrderLineIds[index]!,
            companyId: companyA,
            orderId,
            partyId: brandId,
            seq: 10,
            kind: SalesLineKind.SIZE_GRID,
            styleId: modelLine.styleId,
            styleRevisionId: modelLine.styleRevisionId,
            colourwayId: modelLine.colourwayId,
            description: 'SEED-JKT-02 BLK',
            quantity: order.pieces,
            unitPrice: '400.000000',
            netAmount: net,
            vatRatePct: '22.00',
            vatAmount: vat,
            siteId: modelLine.siteId,
            ...monthlyStamp(MONTHLY_T.ordered),
          },
          select,
        })
        await tx.salesOrderLineSize.create({
          data: { id: lateId(`order-page:monthly:sales-order:SO-${order.number}:10:52`), lineId: monthly.salesOrderLineIds[index]!, partyId: brandId, size: '52', quantity: order.pieces, ...monthlyStamp(MONTHLY_T.ordered) },
          select,
        })
      }
    }),
  )

  // --- SEED-WO-0103 / 0104: their garments, made, inspected and released as SEED-WO-0101's -------------------------------------
  const monthlyPlans: readonly MadeHere[] = MONTHLY_ORDERS.map((order, index) => ({
    number: order.workOrder,
    workOrderId: monthly.workOrderIds[index]!,
    cellId: monthly.cellIds[index]!,
    inspectionId: lateId(`order-page:monthly:inspection:WO-${order.workOrder}`),
    releaseId: monthly.releaseIds[index]!,
    sourceWorkOrderId: production.workOrderId,
    sourceCellId: production.cellIds['BLK-52'],
    quantity: order.pieces,
    salesOrderLineId: monthly.salesOrderLineIds[index]!,
  }))
  for (const plan of monthlyPlans) await makeWorkOrder(plan)
  for (const plan of monthlyPlans) await inspect(plan)
  await release(monthlyPlans)

  // --- SEED-SH-0101 / 0102: one per order, planned by the office, packed on the floor, its DDT, then it leaves ------------------
  const ddtSeriesId = shipping.ddtSeriesId
  const sender = { name: 'Seed Factory A S.r.l.', vatNumber: 'IT00000000000', address: { line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT' } }
  const recipient = { name: 'Seed Customer One S.r.l.', vatNumber: 'IT00000000001', address: { line1: 'Via Esempio 10', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' } }
  for (const [index, order] of MONTHLY_ORDERS.entries()) {
    const shipmentId = monthly.shipmentIds[index]!
    const parcelId = monthly.parcelIds[index]!
    const ddtId = monthly.ddtIds[index]!
    const orderLineId = monthly.salesOrderLineIds[index]!
    const shipTo = await db.withScope(office, async (client) => {
      const { shipTo: to } = await client.salesOrder.findUniqueOrThrow({ where: { id: monthly.salesOrderIds[index]! }, select: { shipTo: true } })
      if (!(await client.shipment.findUnique({ where: { id: shipmentId }, select }))) {
        await client.shipment.create({
          data: { id: shipmentId, companyId: companyA, siteId: siteA, partyId: brandId, salesOrderId: monthly.salesOrderIds[index]!, number: `SEED-SH-${order.number}`, shipTo: to as Prisma.InputJsonValue, transportBy: TransportBy.SENDER, ...monthlyStamp(MONTHLY_T.shipment) },
          select,
        })
      }
      return to
    })
    await db.withScope(packer, (client) =>
      client.$transaction(async (tx) => {
        if (await tx.parcel.findUnique({ where: { id: parcelId }, select })) return
        await tx.parcel.create({
          data: { id: parcelId, siteId: siteA, partyId: brandId, shipmentId, seq: 1, grossWeightKg: order.pieces === 1 ? '3.0000' : '5.8000', lengthCm: '60.00', widthCm: '40.00', heightCm: '15.00', ...monthlyStamp(MONTHLY_T.packed, production.operatorId) },
          select,
        })
        await tx.shipmentLine.create({
          data: { id: monthly.shipmentLineIds[index]!, siteId: siteA, partyId: brandId, shipmentId, parcelId, workOrderId: monthly.workOrderIds[index]!, workOrderSizeId: monthly.cellIds[index]!, salesOrderLineId: orderLineId, size: '52', quantity: order.pieces, ...monthlyStamp(MONTHLY_T.packed, production.operatorId) },
          select,
        })
        await tx.shipment.update({ where: { id: shipmentId }, data: { status: ShipmentStatus.PACKED, packedAt: MONTHLY_T.packed, updatedAt: MONTHLY_T.packed }, select })
      }),
    )
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        if (await tx.ddt.findUnique({ where: { id: ddtId }, select })) return
        // As allocateNumber does (and the holds seed's DDT): lock the series row, take its next number, record it, move the counter.
        const [series] = await tx.$queryRaw<{ nextValue: number }[]>`SELECT "nextValue" FROM "NumberSeries" WHERE "id" = ${ddtSeriesId}::uuid FOR UPDATE`
        const value = series!.nextValue
        await tx.ddt.create({
          data: {
            id: ddtId,
            companyId: companyA,
            siteId: siteA,
            partyId: brandId,
            shipmentId,
            numberSeriesId: ddtSeriesId,
            number: `${value}/${MONTHLY_YEAR}`,
            documentDate: MONTHLY_DAY.ddt,
            reason: DdtReason.SALE,
            transportBy: TransportBy.SENDER,
            language: 'it',
            transportMode: TransportMode.ROAD,
            startAt: MONTHLY_T.start,
            appearance: 'Una scatola di cartone',
            packages: 1,
            grossWeightKg: order.pieces === 1 ? '3.0000' : '5.8000',
            netWeightKg: order.pieces === 1 ? '2.4000' : '4.8000',
            freight: DdtFreight.FREE,
            sender,
            recipient,
            destination: shipTo as Prisma.InputJsonValue,
            lines: [{ seq: 1, description: 'Giacca moto in pelle SEED-JKT-02, nero, taglia 52 (DPI cat. II, EN 17092-3 classe AA)', quantity: String(order.pieces), uom: 'PCS', salesOrderLineId: orderLineId, size: '52', batchNumber: `SEED-BT-${order.workOrder}`, serials: [] }],
            documentRefs: [{ kind: 'CUSTOMER_ORDER', number: order.customerRef, date: '2026-11-12' }],
            issuedAt: MONTHLY_T.ddt,
            createdById: actorId,
          },
          select,
        })
        await tx.numberAllocation.create({
          data: {
            id: lateId(`order-page:monthly:allocation:DDT:SH-${order.number}`),
            companyId: companyA,
            seriesId: ddtSeriesId,
            kind: 'DDT',
            value,
            formatted: `${value}/${MONTHLY_YEAR}`,
            documentDate: MONTHLY_DAY.ddt,
            recordType: 'Ddt',
            recordId: ddtId,
            allocatedAt: MONTHLY_T.ddt,
            allocatedById: actorId,
            requestId: `seed-order-page-${namespace}-ddt-SH-${order.number}`,
          },
          select,
        })
        await tx.numberSeries.update({ where: { id: ddtSeriesId }, data: { nextValue: value + 1, lastIssuedDate: MONTHLY_DAY.ddt, updatedAt: MONTHLY_T.ddt }, select })
      }),
    )
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const leaving = await tx.shipment.updateMany({
          where: { id: shipmentId, status: ShipmentStatus.PACKED },
          data: { status: ShipmentStatus.SHIPPED, shippedAt: MONTHLY_T.left, updatedAt: MONTHLY_T.left, transportMode: TransportMode.ROAD },
        })
        if (leaving.count === 0) return
        // Its order's goods all left with it: the order is SHIPPED.
        await tx.salesOrder.updateMany({ where: { id: monthly.salesOrderIds[index]!, status: SalesOrderStatus.CONFIRMED }, data: { status: SalesOrderStatus.SHIPPED, updatedAt: MONTHLY_T.left, version: { increment: 1 } } })
      }),
    )
  }

  // --- the TD24: both DDTs' goods on one deferred invoice, numbered as allocateNumber numbers it, ISSUED (not sent) -------------
  const goods = MONTHLY_ORDERS.map((order) => jacket(order.pieces))
  const netTotal = goods.reduce((sum, line) => sum + line.net, 0)
  const vatTotal = goods.reduce((sum, line) => sum + line.vat, 0)
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.invoice.findUnique({ where: { id: monthly.invoiceId }, select })) return
      // The seller and buyer as the money seed issued them (its deposit invoice).
      const asIssued = await tx.invoice.findUniqueOrThrow({ where: { id: money.depositInvoiceId }, select: { seller: true, billTo: true } })
      await tx.invoice.create({
        data: {
          id: monthly.invoiceId,
          companyId: companyA,
          buyerPartyId: brandId,
          docType: InvoiceDocType.TD24,
          priceBasis: InvoicePriceBasis.NET,
          billTo: asIssued.billTo as Prisma.InputJsonValue,
          netTotal,
          vatTotal,
          grossTotal: netTotal + vatTotal,
          vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: netTotal, vat: vatTotal, rounding: 0 }],
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: netTotal + vatTotal, dueDate: seedDay('2026-11-30') }] },
          causale: 'Fattura differita (art. 21 c.4 lett. a DPR 633/1972)',
          documentRefs: MONTHLY_ORDERS.map((order) => ({ kind: 'PURCHASE_ORDER', number: order.customerRef })),
          ...monthlyStamp(MONTHLY_T.issued),
        },
        select,
      })
      await tx.invoiceLine.createMany({
        data: MONTHLY_ORDERS.map((order, index) => ({
          id: monthly.invoiceLineIds[index]!,
          invoiceId: monthly.invoiceId,
          buyerPartyId: brandId,
          seq: index + 1,
          kind: InvoiceLineKind.GOODS,
          description: `Seed jacket JKT-02 BLK, size 52 (order SEED-SO-${order.number})`,
          itemCode: 'SEED-JKT-02-BLK-52',
          quantity: `${order.pieces}.0000`,
          uom: 'PZ',
          unitPrice: '400.000000',
          netAmount: goods[index]!.net,
          vatRatePct: '22.00',
          salesOrderLineId: monthly.salesOrderLineIds[index]!,
          size: '52',
          ddtId: monthly.ddtIds[index]!,
          ...monthlyStamp(MONTHLY_T.issued),
        })),
      })
      // The number, as allocateNumber gives it: the series' next value, its NumberAllocation row, the series moved on.
      const [series] = await tx.$queryRaw<{ nextValue: number }[]>`SELECT "nextValue" FROM "NumberSeries" WHERE "id" = ${money.invoiceSeriesId}::uuid FOR UPDATE`
      const value = series!.nextValue
      const number = `FT-${MONTHLY_YEAR}-${String(value).padStart(5, '0')}`
      await tx.numberAllocation.create({
        data: {
          id: lateId('order-page:monthly:allocation:TD24'),
          companyId: companyA,
          seriesId: money.invoiceSeriesId,
          kind: 'INVOICE',
          value,
          formatted: number,
          documentDate: MONTHLY_DAY.invoice,
          recordType: 'Invoice',
          recordId: monthly.invoiceId,
          allocatedAt: MONTHLY_T.issued,
          allocatedById: actorId,
          requestId: `seed-order-page-${namespace}-TD24`,
        },
        select,
      })
      await tx.numberSeries.update({ where: { id: money.invoiceSeriesId }, data: { nextValue: value + 1, lastIssuedDate: MONTHLY_DAY.invoice, updatedAt: MONTHLY_T.issued }, select })
      await tx.invoice.update({
        where: { id: monthly.invoiceId },
        data: {
          status: InvoiceStatus.ISSUED,
          numberSeriesId: money.invoiceSeriesId,
          number,
          year: Number(MONTHLY_YEAR),
          issueDate: MONTHLY_DAY.invoice,
          issuedAt: MONTHLY_T.issued,
          issuedById: actorId,
          partyId: brandId,
          seller: asIssued.seller as Prisma.InputJsonValue,
          version: 2,
          updatedAt: MONTHLY_T.issued,
        },
        select,
      })
    }),
  )

  // --- partly paid: one bank transfer of 600.00, placed on the TD24 whole -------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.payment.findUnique({ where: { id: monthly.paymentId }, select })) return
      await tx.payment.create({
        data: { id: monthly.paymentId, companyId: companyA, partyId: brandId, method: PaymentMethod.BANK_TRANSFER, amount: 60_000, currency: 'EUR', receivedOn: MONTHLY_DAY.paid, externalRef: 'SEED-TRN-0000101', ...monthlyStamp(MONTHLY_T.paid) },
        select,
      })
      await tx.paymentAllocation.createMany({
        data: [{ id: monthly.allocationId, companyId: companyA, partyId: brandId, paymentId: monthly.paymentId, invoiceId: monthly.invoiceId, amount: 60_000, createdAt: MONTHLY_T.paid, createdById: actorId }],
        skipDuplicates: true,
      })
    }),
  )
  // ── end B-OP-046 (P16)

  return { ...sharedIds, monthly }
}
