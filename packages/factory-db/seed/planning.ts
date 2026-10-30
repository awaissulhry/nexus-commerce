import type { Prisma } from '../src/generated/prisma/client'
import {
  ItemPlanningMethod,
  ItemPlanningSource,
  PeggingDemandKind,
  PeggingSupplyKind,
  PlanningExceptionKind,
  PlanningExceptionStatus,
  ReservationKind,
  StockCountKind,
  StockCountLineOrigin,
  StockCountStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduction } from './production'

/**
 * The W2a stock and planning seed (schema wave 4/7), per tenant of seed/_core.ts, written in the tenant's office scope,
 * as the app does (the CLI runs this file before seed/production.ts, so it runs that seed first: it brings the
 * inventory, supply and sales seeds).
 *
 *   settings     plant A1 plans 26 weeks ahead (days for 2 weeks, weeks to week 13, months after), lines without their
 *                own capacity at 85 %, and runs every night at 02:00.
 *   items        A1's parameters for the seed materials: the leather (any colour) planned from the orders, bought from
 *                P2 with 2 safety days; the grey lining by min/max (50 to 300 m, in steps of 50 m); the protectors by a
 *                reorder point (24, a lot of 48, 12 kept as safety stock, in steps of 12).
 *   capacity     line L1 of A1 at 85 % with 8 people and of B1 at 80 % with 6; A1's work centres: cutting 2 tables at
 *                90 %, sewing 8 machines at 85 %, final inspection and packing 1 bench each at 100 %.
 *   reservation  48 ft² of the black leather lot SEED-LOT-LEA-01 (an AREA: the hides are chosen at cutting) for the
 *                DRAFT work order SEED-WO-0002 (BLK 52).
 *   count        SEED-CNT-0001, a cycle count of A1's materials store (A1-STORE and its bin), COUNTING since 20 Nov:
 *                the grey lining lot (120 m expected, 118.5 m counted: a count error) and the black hide SEED-HIDE-0002
 *                (51.8 ft² expected, not counted yet).
 *   pegging      the supply seed's run 1: each requirement pegged to SEED-SO-0001's lines and sizes, and what covers
 *                them: PO1's leather and protector lines, the lining stock, the red leather's planned order.
 *   firm         run 1's red leather (OPEN) made a firm planned order: 4 hides (210 ft²) from P2 by 16 Nov.
 *   exceptions   from run 1: the red leather is SHORT for SEED-SO-0001 (NEW), the protectors are below their safety
 *                stock (ACKNOWLEDGED).
 *
 * The generated isolation tests copy the FIRST row of each table by id and insert the copy, so the rows they copy get ids
 * that start with eight zeros (still derived from the namespace) and can be copied as they stand: an ACTIVE AREA
 * reservation (a hide is held once), a COUNTING count and a line of it, a NEW exception (one open per condition).
 * Every name, number and figure is invented. Idempotent: settings, parameters and capacity are upserted; the
 * reservation, the count, the pegging (append-only), the firm order and the exceptions are written once and skipped.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-10-29T08:00:00.000Z'),
  planFinished: new Date('2026-10-30T09:01:00.000Z'),
  firmed: new Date('2026-10-30T12:00:00.000Z'),
  acknowledged: new Date('2026-10-30T14:00:00.000Z'),
  reserved: new Date('2026-11-15T11:00:00.000Z'),
  countStarted: new Date('2026-11-20T07:00:00.000Z'),
  counted: new Date('2026-11-20T08:15:00.000Z'),
} as const
const DAY = { need: new Date('2026-11-16T00:00:00.000Z'), confirmed: new Date('2026-11-13T00:00:00.000Z'), woNeed: new Date('2026-11-30T00:00:00.000Z') } as const

export interface PlanningSeed {
  readonly reservationId: string
  readonly countId: string
  readonly countLineIds: readonly [string, string]
  readonly exceptionIds: readonly [string, string]
}

export async function seed(context: SeedContext): Promise<PlanningSeed> {
  const { db, namespace } = context
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const supplierId = id('party:P2')
  const customerId = id('party:P1')
  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const colour = { leatherBLK: id('product:item-colour:leather:BLK'), leatherRED: id('product:item-colour:leather:RED'), liningGRY: id('product:item-colour:lining:GRY') }
  const orderLine = { BLK: id('sales:SO1:line:10'), RED: id('sales:SO1:line:20') }
  const runId = id('supply:run:1')
  const requirement = { leatherBLK: id('supply:run:1:1'), leatherRED: id('supply:run:1:2'), lining: id('supply:run:1:3'), protector: id('supply:run:1:4') }
  const poLine = { leather: id('supply:PO1:10'), protector: id('supply:PO1:20') }
  const location = { store: id('inventory:location:A1-STORE'), bin: id('inventory:location:A1-STORE-01') }
  const lot = { lining: id('inventory:lot:LIN-01'), leather: id('inventory:lot:LEA-01') }
  const hideH2 = id('inventory:hide:H2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const reservationId = firstId('planning:reservation:WO-0002:leather')
  const countId = firstId('planning:count:CNT-0001')
  const countLineIds = [firstId('planning:count:CNT-0001:10'), id('planning:count:CNT-0001:20')] as const
  const exceptionIds = [firstId('planning:exception:short:leather:RED'), id('planning:exception:safety:protector')] as const

  // --- settings, item parameters, capacity: upserted ----------------------------------------------------------------
  const settings: Prisma.PlanningSettingsUncheckedCreateInput = {
    id: siteA,
    companyId: companyA,
    siteId: siteA,
    horizonWeeks: 26,
    dayBucketWeeks: 2,
    weekBucketWeeks: 13,
    defaultEfficiencyPct: '85.00',
    scheduledRunTime: '02:00',
    ...stamp(T.setup),
  }
  const items: Prisma.ItemPlanningUncheckedCreateInput[] = [
    {
      id: firstId('planning:item:A1:lining:GRY'),
      companyId: companyA,
      siteId: siteA,
      itemId: item.lining,
      itemColourId: colour.liningGRY,
      method: ItemPlanningMethod.MIN_MAX,
      source: ItemPlanningSource.BUY,
      buyLeadTimeDays: 10,
      minStock: '50.0000',
      maxStock: '300.0000',
      minOrderQty: '50.0000',
      orderMultiple: '50.0000',
      note: 'Lining for every jacket: kept between 50 and 300 m.',
      ...stamp(T.setup),
    },
    {
      id: id('planning:item:A1:leather'),
      companyId: companyA,
      siteId: siteA,
      itemId: item.leather,
      method: ItemPlanningMethod.ORDERS,
      source: ItemPlanningSource.BUY,
      supplierId,
      safetyLeadTimeDays: 2,
      ...stamp(T.setup),
    },
    {
      id: id('planning:item:A1:protector'),
      companyId: companyA,
      siteId: siteA,
      itemId: item.protector,
      method: ItemPlanningMethod.REORDER_POINT,
      source: ItemPlanningSource.BUY,
      buyLeadTimeDays: 7,
      safetyStock: '12.0000',
      reorderPoint: '24.0000',
      lotSize: '48.0000',
      orderMultiple: '12.0000',
      ...stamp(T.setup),
    },
  ]
  const lines: Prisma.LineCapacityUncheckedCreateInput[] = [
    { id: id('site:A1:line:L1'), companyId: companyA, siteId: siteA, lineId: id('site:A1:line:L1'), plannedEfficiencyPct: '85.00', operators: 8, ...stamp(T.setup) },
    { id: id('site:B1:line:L1'), companyId: companyB, siteId: siteB, lineId: id('site:B1:line:L1'), plannedEfficiencyPct: '80.00', operators: 6, ...stamp(T.setup) },
  ]
  const centres: Prisma.WorkCentreCapacityUncheckedCreateInput[] = (
    [
      ['CUT', 2, '90.00'],
      ['SEW', 8, '85.00'],
      ['QC', 1, '100.00'],
      ['PACK', 1, '100.00'],
    ] as const
  ).map(([code, units, pct]) => {
    const workCentreId = id(`site:A1:work-centre:${code}`)
    return { id: workCentreId, companyId: companyA, siteId: siteA, workCentreId, units, plannedEfficiencyPct: pct, ...stamp(T.setup) }
  })

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const { id: settingsId, ...settingsData } = settings
      await tx.planningSettings.upsert({ where: { id: settingsId as string }, create: settings, update: settingsData, select: { id: true } })
      for (const row of items) {
        const { id: rowId, ...data } = row
        await tx.itemPlanning.upsert({ where: { id: rowId as string }, create: row, update: data, select: { id: true } })
      }
      for (const row of lines) {
        const { id: rowId, ...data } = row
        await tx.lineCapacity.upsert({ where: { id: rowId as string }, create: row, update: data, select: { id: true } })
      }
      for (const row of centres) {
        const { id: rowId, ...data } = row
        await tx.workCentreCapacity.upsert({ where: { id: rowId as string }, create: row, update: data, select: { id: true } })
      }
    }),
  )

  // --- the reservation and the count: written once ------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.reservation.findUnique({ where: { id: reservationId }, select: { id: true } }))) {
        await tx.reservation.create({
          data: {
            id: reservationId,
            companyId: companyA,
            siteId: siteA,
            kind: ReservationKind.AREA,
            itemId: item.leather,
            itemColourId: colour.leatherBLK,
            lotId: lot.leather,
            // One BLK 52 jacket: 45 ft² with 12% hide wastage, rounded up.
            quantity: '48.0000',
            workOrderId: production.draftWorkOrderId,
            needDate: DAY.woNeed,
            note: 'Black leather for the second work order, from the same dye batch.',
            ...stamp(T.reserved),
          },
          select: { id: true },
        })
      }
      if (await tx.stockCount.findUnique({ where: { id: countId }, select: { id: true } })) return
      await tx.stockCount.create({
        data: {
          id: countId,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-CNT-0001',
          kind: StockCountKind.CYCLE,
          locationId: location.store,
          countTeam: 'Warehouse team A1',
          status: StockCountStatus.COUNTING,
          startedAt: T.countStarted,
          snapshotAt: T.countStarted,
          note: 'Monthly cycle count of the materials store.',
          ...stamp(T.countStarted),
        },
        select: { id: true },
      })
      await tx.stockCountLine.createMany({
        data: [
          {
            id: countLineIds[0],
            siteId: siteA,
            countId,
            seq: 10,
            locationId: location.bin,
            itemId: item.lining,
            itemColourId: colour.liningGRY,
            lotId: lot.lining,
            origin: StockCountLineOrigin.SNAPSHOT,
            expectedQuantity: '120.0000',
            countedQuantity: '118.5000',
            countedAt: T.counted,
            countedById: actorId,
            reasonCode: 'COUNT_ERROR',
            reasonNote: 'The opening roll was measured short.',
            createdAt: T.countStarted,
            updatedAt: T.counted,
            createdById: actorId,
          },
          {
            id: countLineIds[1],
            siteId: siteA,
            countId,
            seq: 20,
            locationId: location.bin,
            itemId: item.leather,
            itemColourId: colour.leatherBLK,
            lotId: lot.leather,
            hideId: hideH2,
            origin: StockCountLineOrigin.SNAPSHOT,
            expectedQuantity: '51.8000',
            ...stamp(T.countStarted),
          },
        ],
      })
    }),
  )

  // --- run 1: pegging (append-only), the firm planned order, the exceptions: written once -----------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const peg = (key: string, row: Omit<Prisma.RequirementPeggingCreateManyInput, 'id' | 'siteId' | 'runId' | 'createdAt' | 'createdById'>): Prisma.RequirementPeggingCreateManyInput => ({
        id: id(`planning:pegging:${key}`),
        siteId: siteA,
        runId,
        createdAt: T.planFinished,
        createdById: actorId,
        ...row,
      })
      const orderLineDemand = (code: 'BLK' | 'RED', size: string | null) => ({
        demandKind: PeggingDemandKind.ORDER_LINE,
        salesOrderLineId: orderLine[code],
        partyId: customerId,
        size,
        demandDate: DAY.need,
      })
      await tx.requirementPegging.createMany({
        skipDuplicates: true,
        data: [
          // Black leather: each size of line 10, covered by PO1's leather line (confirmed for 13 Nov).
          ...(
            [
              ['50', '96.3200'],
              ['52', '201.6000'],
              ['54', '106.4000'],
            ] as const
          ).map(([size, quantity], index) =>
            peg(`leather:BLK:${size}`, {
              requirementId: requirement.leatherBLK,
              seq: index + 1,
              ...orderLineDemand('BLK', size),
              quantity,
              supplyKind: PeggingSupplyKind.PURCHASE_ORDER,
              purchaseOrderLineId: poLine.leather,
              supplyDate: DAY.confirmed,
            }),
          ),
          // Red leather: each size of line 20, covered by the requirement's planned order (made firm below).
          ...(
            [
              ['50', '48.1600'],
              ['52', '100.8000'],
              ['54', '53.2000'],
            ] as const
          ).map(([size, quantity], index) =>
            peg(`leather:RED:${size}`, {
              requirementId: requirement.leatherRED,
              seq: index + 1,
              ...orderLineDemand('RED', size),
              quantity,
              supplyKind: PeggingSupplyKind.PLANNED,
              supplyDate: DAY.need,
            }),
          ),
          // Grey lining: both lines (every size), covered by the opening stock.
          peg('lining:10', { requirementId: requirement.lining, seq: 1, ...orderLineDemand('BLK', null), quantity: '15.1200', supplyKind: PeggingSupplyKind.STOCK }),
          peg('lining:20', { requirementId: requirement.lining, seq: 2, ...orderLineDemand('RED', null), quantity: '7.5600', supplyKind: PeggingSupplyKind.STOCK }),
          // Protectors: both lines, covered by PO1's protector line.
          peg('protector:10', {
            requirementId: requirement.protector,
            seq: 1,
            ...orderLineDemand('BLK', null),
            quantity: '16.0000',
            supplyKind: PeggingSupplyKind.PURCHASE_ORDER,
            purchaseOrderLineId: poLine.protector,
            supplyDate: DAY.confirmed,
          }),
          peg('protector:20', {
            requirementId: requirement.protector,
            seq: 2,
            ...orderLineDemand('RED', null),
            quantity: '8.0000',
            supplyKind: PeggingSupplyKind.PURCHASE_ORDER,
            purchaseOrderLineId: poLine.protector,
            supplyDate: DAY.confirmed,
          }),
        ],
      })

      // The red leather's planned order, firmed by the planner: 4 hides of about 52.5 ft² from P2, for 16 Nov.
      const red = await tx.materialRequirement.findUnique({ where: { id: requirement.leatherRED }, select: { firmedAt: true, decision: true, version: true } })
      if (red && red.firmedAt === null && red.decision === 'OPEN') {
        await tx.materialRequirement.update({
          where: { id: requirement.leatherRED },
          data: {
            firmQuantity: '4.0000',
            firmBaseQuantity: '210.0000',
            firmDate: DAY.need,
            firmSupplierId: supplierId,
            firmedAt: T.firmed,
            firmedById: actorId,
            version: red.version + 1,
            updatedAt: T.firmed,
          },
          select: { id: true },
        })
      }

      if (await tx.planningException.findUnique({ where: { id: exceptionIds[0] }, select: { id: true } })) return
      const found = { companyId: companyA, siteId: siteA, firstRunId: runId, lastRunId: runId, firstSeenAt: T.planFinished, lastSeenAt: T.planFinished }
      await tx.planningException.createMany({
        data: [
          {
            id: exceptionIds[0],
            ...found,
            kind: PlanningExceptionKind.SHORT,
            dedupeKey: `SHORT:${colour.leatherRED}`,
            itemId: item.leather,
            itemColourId: colour.leatherRED,
            requirementId: requirement.leatherRED,
            recordType: 'SalesOrderLine',
            recordId: orderLine.RED,
            facts: { needDate: '2026-11-16', quantity: '202.1600', uom: Uom.FT2, orderNumber: 'SEED-SO-0001' },
            ordersAffected: 1,
            ...stamp(T.planFinished),
          },
          {
            id: exceptionIds[1],
            ...found,
            kind: PlanningExceptionKind.BELOW_SAFETY_STOCK,
            dedupeKey: `BELOW_SAFETY_STOCK:${item.protector}`,
            itemId: item.protector,
            facts: { safetyStock: '12.0000', projected: '0.0000', uom: Uom.PCS, date: '2026-11-13' },
            ...stamp(T.planFinished),
          },
        ],
      })
      await tx.planningException.update({
        where: { id: exceptionIds[1] },
        data: { status: PlanningExceptionStatus.ACKNOWLEDGED, acknowledgedAt: T.acknowledged, acknowledgedById: actorId, version: 2, updatedAt: T.acknowledged },
        select: { id: true },
      })
    }),
  )

  return { reservationId, countId, countLineIds, exceptionIds }
}
