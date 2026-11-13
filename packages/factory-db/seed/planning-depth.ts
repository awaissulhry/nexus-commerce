import {
  ItemLotSizing,
  ItemPlanLevel,
  ItemPlanningMethod,
  MrpAction,
  MrpActionStatus,
  PlannedOrderKind,
  PlannedOrderStatus,
  ProductionStrategy,
  PromiseKind,
  ScheduleChangeKind,
  SubcontractCapacityUnit,
  Uom,
  WhatIfStatus,
  WorkCentreKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPlanning } from './planning'
import { seed as seedSchedule } from './schedule'
import { seed as seedSubcontract } from './subcontract'

/**
 * The planning depth seed (W2b-5, schema wave 41/44, B-W2b-286), per tenant of seed/_core.ts, written in the tenant's office
 * scope, as the app does. The CLI runs the seeds in name order and this file sorts before planning.ts, so it runs the
 * planning, schedule and subcontract seeds first (each idempotent; they bring the product, sales, supply, production and
 * inventory seeds).
 *
 *   planned      on run 1 of plant A1 (the supply seed's): SEED-JKT-01 RED 1/2/1 of sizes 50/52/54 to MAKE on line L1 for
 *                SEED-SO-0001's RED line, its due date protected by the planner (the first row: the one a copy may
 *                repeat); SEED-JKT-01 BLK 2/4/2 to SUBCONTRACT to the workshop P2 (its sewing, step 20; the kit leaves on
 *                27 Nov), made firm; and SEED-JKT-02 BLK 52 made real as the DRAFT work order SEED-WO-0002.
 *   messages     run 1's action messages: expedite PO1's leather line from 20 to 16 Nov (OPEN; the first row), take the
 *                protector line down from 48 to 24 (IGNORED, with a note), and the new subcontract order (OPEN).
 *   promises     SEED-SO-0001: the first promise of each line (18 Dec, told with the order confirmation), and a re-promise of
 *                the RED line's size 52 to 22 Dec because the red leather comes late, from A1's working plan, told the same
 *                day (the first row).
 *   board        A1's working plan: v1 published, the sewing bar of SEED-WO-0001 moved an hour later (the first row), the
 *                DRAFT SEED-WO-0002's sewing placed on L1, and WO-0001's packing bar pinned and unpinned again (no slot stays
 *                pinned: W2a's move route would meet the pin's refusal before B-W2b-312 gives it words).
 *   what-if      the planner's DRAFT what-if moving WO-0002's sewing a day later (the first row), and one DISCARDED.
 *   capacity     the workshop P2: 2400 sewing minutes a week from 1 Nov (the first row), 60 garments a week of any work
 *                from 1 Nov to 23 Dec.
 *   more         SEED-SC-0001 (DRAFT): its kit leaves on 17 Nov at 08:00; run 1's red leather (OPEN, firm) hard-pegged to
 *                SEED-SO-0001's RED line; the backlog ranked: SEED-SO-0002 first, SEED-SO-0001 second; the finished item
 *                SEED-JKT-02-BLK-52 at A1: made to stock, planned per style and colour, in fixed lots of 6 with 2 %
 *                scrap, a 98 % yield and 1 day of delay.
 *
 * WO-0001's operations stay in-house (the floor seeds scan them), and A1 keeps one grid per size run (the golden flows'
 * MRP). Every time is before the day the wave was built (the guards refuse a time in the future). Every name, number and
 * reason is invented. Idempotent: the new tables are written once and skipped when their first row exists; the columns of
 * earlier rows are written only while they are still empty.
 */

/** Fixed instants and days, so the seed never depends on the clock. */
const T = {
  published: new Date('2026-11-10T16:00:00.000Z'),
  moved: new Date('2026-11-10T17:00:00.000Z'),
  placed: new Date('2026-11-10T17:05:00.000Z'),
  pinned: new Date('2026-11-10T17:10:00.000Z'),
  unpinned: new Date('2026-11-10T17:20:00.000Z'),
  whatIf: new Date('2026-11-10T18:00:00.000Z'),
  discarded: new Date('2026-11-10T18:30:00.000Z'),
  planned: new Date('2026-11-10T09:00:00.000Z'),
  protectedAt: new Date('2026-11-10T09:30:00.000Z'),
  firmed: new Date('2026-11-10T09:45:00.000Z'),
  converted: new Date('2026-11-10T10:00:00.000Z'),
  ignored: new Date('2026-11-10T10:15:00.000Z'),
  ordered: new Date('2026-10-30T08:00:00.000Z'),
  repromised: new Date('2026-11-09T10:00:00.000Z'),
  told: new Date('2026-11-09T11:00:00.000Z'),
  setup: new Date('2026-11-05T08:00:00.000Z'),
  kit: new Date('2026-11-17T07:00:00.000Z'),
  kitPlanned: new Date('2026-11-27T07:00:00.000Z'),
} as const
const DAY = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`)
/** A slot's time in the seed week, as seed/schedule.ts writes it. */
const at = (day: number, hour: number): Date => new Date(Date.UTC(2026, 10, day, hour, 0, 0))

export interface PlanningDepthSeed {
  readonly plannedWorkOrderIds: { readonly make: string; readonly subcontract: string; readonly converted: string }
  readonly actionMessageIds: readonly [string, string, string]
  readonly promiseIds: { readonly firstBlk: string; readonly firstRed: string; readonly rePromise: string }
  readonly scheduleChangeIds: { readonly publish: string; readonly move: string; readonly place: string; readonly pin: string; readonly unpin: string }
  readonly whatIfIds: { readonly draft: string; readonly discarded: string }
  readonly capacityIds: readonly [string, string]
  readonly itemPlanningId: string
}

export async function seed(context: SeedContext): Promise<PlanningDepthSeed> {
  const { db, namespace } = context
  await seedPlanning(context)
  const schedule = await seedSchedule(context)
  const subcontract = await seedSubcontract(context)
  const production = schedule.production
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first: the rows the generated isolation tests copy. */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const lineL1 = id('site:A1:line:L1')
  const customerId = id('party:P1')
  const workshopId = id('party:P2')
  const runId = id('supply:run:1')
  const office = { audience: 'office' as const, tenantId, actorId }

  const jkt01 = { styleId: id('product:style:JKT-01'), BLK: id('product:colourway:JKT-01:BLK'), RED: id('product:colourway:JKT-01:RED') }
  const so1 = { order: id('sales:SO1'), BLK: id('sales:SO1:line:10'), RED: id('sales:SO1:line:20') }
  const so2 = { order: production.salesOrderId, BLK: id('production:sales-order:SO-0002:10') }
  const slot = { sew: id('schedule:slot:A1:working:sew'), pack: id('schedule:slot:A1:working:pack'), draftSew: id('schedule:slot:A1:working:WO-0002:sew') }
  const result: PlanningDepthSeed = {
    plannedWorkOrderIds: { make: firstId('planning-depth:planned:A1:JKT-01:RED'), subcontract: id('planning-depth:planned:A1:JKT-01:BLK'), converted: id('planning-depth:planned:A1:JKT-02:BLK:52') },
    actionMessageIds: [firstId('planning-depth:message:run-1:1'), id('planning-depth:message:run-1:2'), id('planning-depth:message:run-1:3')],
    promiseIds: { firstBlk: id('planning-depth:promise:SO1:10:first'), firstRed: id('planning-depth:promise:SO1:20:first'), rePromise: firstId('planning-depth:promise:SO1:20:52:re') },
    scheduleChangeIds: {
      publish: id('planning-depth:change:A1:publish:v1'),
      move: firstId('planning-depth:change:A1:move:sew'),
      place: id('planning-depth:change:A1:place:WO-0002:sew'),
      pin: id('planning-depth:change:A1:pin:pack'),
      unpin: id('planning-depth:change:A1:unpin:pack'),
    },
    whatIfIds: { draft: firstId('planning-depth:what-if:A1:1'), discarded: id('planning-depth:what-if:A1:2') },
    capacityIds: [firstId('planning-depth:capacity:P2:SEWING'), id('planning-depth:capacity:P2:ANY')],
    itemPlanningId: id('planning-depth:item-planning:A1:SEED-JKT-02-BLK-52'),
  }
  const select = { id: true } as const

  // --- the new columns of earlier rows, each written once while still empty ----------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const order = await tx.subcontractOrder.findUnique({ where: { id: subcontract.orderId }, select: { status: true, kitDueAt: true, version: true } })
      if (order && order.status === 'DRAFT' && order.kitDueAt === null) {
        await tx.subcontractOrder.update({ where: { id: subcontract.orderId }, data: { kitDueAt: T.kit, version: order.version + 1 }, select })
      }
      for (const [orderId, rank] of [[so2.order, 1], [so1.order, 2]] as const) {
        const row = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { backlogRank: true, version: true } })
        if (row && row.backlogRank === null) await tx.salesOrder.update({ where: { id: orderId }, data: { backlogRank: rank, version: row.version + 1 }, select })
      }
      const red = await tx.materialRequirement.findUnique({ where: { id: id('supply:run:1:2') }, select: { decision: true, orderSpecific: true, version: true } })
      if (red && red.decision === 'OPEN' && !red.orderSpecific) {
        await tx.materialRequirement.update({
          where: { id: id('supply:run:1:2') },
          data: { orderSpecific: true, reservedForLineId: so1.RED, reservedForPartyId: customerId, version: red.version + 1 },
          select,
        })
      }
      const finished = {
        companyId: companyA,
        siteId: siteA,
        itemId: schedule.finishedItemId,
        method: ItemPlanningMethod.ORDERS,
        lotSizing: ItemLotSizing.FIXED,
        fixedLotQty: '6.0000',
        planLevel: ItemPlanLevel.STYLE_COLOUR,
        strategy: ProductionStrategy.MAKE_TO_STOCK,
        scrapPct: '2.00',
        yieldPct: '98.00',
        delayDays: 1,
        note: 'Seed: the black 52 is kept in stock for reorders (made-up).',
        updatedAt: T.setup,
      }
      await tx.itemPlanning.upsert({ where: { id: result.itemPlanningId }, create: { id: result.itemPlanningId, ...finished, createdAt: T.setup, createdById: actorId }, update: finished, select })
    }),
  )

  // --- planned work orders and run 1's action messages --------------------------------------------------------------------
  const P = result.plannedWorkOrderIds
  const M = result.actionMessageIds
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.plannedWorkOrder.findUnique({ where: { id: P.make }, select })) return
      const stamp = { companyId: companyA, siteId: siteA, runId, createdAt: T.planned, createdById: actorId }
      await tx.plannedWorkOrder.createMany({
        data: [
          {
            id: P.make,
            ...stamp,
            kind: PlannedOrderKind.MAKE,
            styleId: jkt01.styleId,
            colourwayId: jkt01.RED,
            sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }, { size: '54', quantity: 1 }],
            quantity: 4,
            startDate: DAY('2026-11-30'),
            dueDate: DAY('2026-12-11'),
            demand: [
              { orderId: so1.order, orderLineId: so1.RED, size: '50', pieces: 1 },
              { orderId: so1.order, orderLineId: so1.RED, size: '52', pieces: 2 },
              { orderId: so1.order, orderLineId: so1.RED, size: '54', pieces: 1 },
            ],
            lineId: lineL1,
            protectedFields: ['dueDate'],
            protectedAt: T.protectedAt,
            protectedById: actorId,
            note: 'The planner keeps 11 Dec: the brand collects with the black ones (made-up).',
            updatedAt: T.protectedAt,
          },
          {
            id: P.subcontract,
            ...stamp,
            kind: PlannedOrderKind.SUBCONTRACT,
            styleId: jkt01.styleId,
            colourwayId: jkt01.BLK,
            sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }, { size: '54', quantity: 2 }],
            quantity: 8,
            startDate: DAY('2026-11-30'),
            dueDate: DAY('2026-12-11'),
            demand: [
              { orderId: so1.order, orderLineId: so1.BLK, size: '50', pieces: 2 },
              { orderId: so1.order, orderLineId: so1.BLK, size: '52', pieces: 4 },
              { orderId: so1.order, orderLineId: so1.BLK, size: '54', pieces: 2 },
            ],
            partyId: workshopId,
            operationSeqs: [20],
            kitDueAt: T.kitPlanned,
            firm: true,
            firmedAt: T.firmed,
            firmedById: actorId,
            updatedAt: T.firmed,
          },
          {
            id: P.converted,
            ...stamp,
            kind: PlannedOrderKind.MAKE,
            styleId: production.styleId,
            styleRevisionId: production.revisionId,
            colourwayId: id('production:colourway:JKT-02:BLK'),
            sizes: [{ size: '52', quantity: 1 }],
            quantity: 1,
            startDate: DAY('2026-11-19'),
            dueDate: DAY('2026-11-20'),
            demand: [{ orderId: so2.order, orderLineId: so2.BLK, size: '52', pieces: 1 }],
            lineId: lineL1,
            updatedAt: T.planned,
          },
        ],
      })
      // Made real as the DRAFT work order SEED-WO-0002 (one cell, BLK 52).
      await tx.plannedWorkOrder.update({
        where: { id: P.converted },
        data: { status: PlannedOrderStatus.CONVERTED, workOrderId: production.draftWorkOrderId, convertedAt: T.converted, convertedById: actorId, version: 2, updatedAt: T.converted },
        select,
      })
      const message = { siteId: siteA, runId, createdAt: T.planned, updatedAt: T.planned, createdById: actorId }
      await tx.mrpActionMessage.createMany({
        data: [
          {
            id: M[0],
            ...message,
            seq: 1,
            recordType: 'PurchaseOrderLine',
            recordId: id('supply:PO1:10'),
            action: MrpAction.EXPEDITE,
            fromDate: DAY('2026-11-20'),
            toDate: DAY('2026-11-16'),
            message: 'Expedite the leather of PO1 line 10 from 20 Nov to 16 Nov: SEED-SO-0001 needs it on 16 Nov (made-up).',
            facts: { needDate: '2026-11-16', orderNumber: 'SEED-SO-0001' },
          },
          {
            id: M[1],
            ...message,
            seq: 2,
            recordType: 'PurchaseOrderLine',
            recordId: id('supply:PO1:20'),
            action: MrpAction.DECREASE,
            fromQuantity: '48.0000',
            toQuantity: '24.0000',
            uom: Uom.PCS,
            message: 'Take the protectors of PO1 line 20 down from 48 to 24: the orders need 24 (made-up).',
            facts: { needed: '24.0000' },
          },
          {
            id: M[2],
            ...message,
            seq: 3,
            recordType: 'PlannedWorkOrder',
            recordId: P.subcontract,
            action: MrpAction.NEW,
            toDate: DAY('2026-11-30'),
            toQuantity: '8.0000',
            uom: Uom.PCS,
            message: 'Give the sewing of 8 black SEED-JKT-01 to the workshop P2 by 30 Nov (made-up).',
            facts: { pieces: '8.0000' },
          },
        ],
      })
      await tx.mrpActionMessage.update({
        where: { id: M[1] },
        data: { status: MrpActionStatus.IGNORED, decidedAt: T.ignored, decidedById: actorId, decisionNote: 'The supplier sells them by 48 (made-up).', version: 2, updatedAt: T.ignored },
        select,
      })
    }),
  )

  // --- promises of SEED-SO-0001 -------------------------------------------------------------------------------------------
  const R = result.promiseIds
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.promiseRecord.findUnique({ where: { id: R.firstBlk }, select })) return
      const first = { partyId: customerId, promisedDate: DAY('2026-12-18'), kind: PromiseKind.FIRST, promisedById: actorId, promisedAt: T.ordered, customerToldAt: T.ordered, createdAt: T.ordered, createdById: actorId }
      await tx.promiseRecord.createMany({
        data: [
          { id: R.firstBlk, salesOrderLineId: so1.BLK, ...first },
          { id: R.firstRed, salesOrderLineId: so1.RED, ...first },
        ],
      })
      await tx.promiseRecord.create({
        data: {
          id: R.rePromise,
          salesOrderLineId: so1.RED,
          partyId: customerId,
          size: '52',
          promisedDate: DAY('2026-12-22'),
          kind: PromiseKind.RE_PROMISE,
          reasonCode: 'MATERIAL_LATE',
          reason: 'The red leather arrives a week later than asked (made-up).',
          promisedById: actorId,
          promisedAt: T.repromised,
          siteId: siteA,
          planVersionId: schedule.workingPlanId,
          customerToldAt: T.told,
          createdAt: T.repromised,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  // --- the board's changes, the what-ifs ------------------------------------------------------------------------------------
  const C = result.scheduleChangeIds
  const W = result.whatIfIds
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.scheduleChange.findUnique({ where: { id: C.move }, select })) return
      const draftSew = await tx.scheduleSlot.findUnique({ where: { id: slot.draftSew }, select: { workOrderOperationId: true } })
      const ops = production.operationIds
      const change = { siteId: siteA, planVersionId: schedule.workingPlanId, changedById: actorId, createdById: actorId }
      // B-W2b-F39: a change keeps a copy of the operation it names (its seq and name now; the database checks it).
      const named = new Map(
        (await tx.workOrderOperation.findMany({ where: { id: { in: [ops.sew, ops.pack, ...(draftSew?.workOrderOperationId ? [draftSew.workOrderOperationId] : [])] } }, select: { id: true, seq: true, name: true } })).map((op) => [op.id, op]),
      )
      const copyOf = (operationId: string | null) => ({ workOrderOperationId: operationId, operationSeq: operationId ? (named.get(operationId)?.seq ?? null) : null, operationName: operationId ? (named.get(operationId)?.name ?? null) : null })
      await tx.scheduleChange.createMany({
        data: [
          { id: C.publish, ...change, kind: ScheduleChangeKind.PUBLISH, publishedVersionId: schedule.publishedPlanId, changedAt: T.published, createdAt: T.published },
          {
            id: C.move,
            ...change,
            kind: ScheduleChangeKind.MOVE,
            slotId: slot.sew,
            workOrderId: production.workOrderId,
            ...copyOf(ops.sew), // B-W2b-F39
            fromLineId: lineL1,
            fromStartAt: at(17, 8),
            fromEndAt: at(17, 16),
            toLineId: lineL1,
            toStartAt: at(17, 9),
            toEndAt: at(17, 17),
            reason: 'The cutting of the second bundle runs an hour late (made-up).',
            changedAt: T.moved,
            createdAt: T.moved,
          },
          {
            id: C.place,
            ...change,
            kind: ScheduleChangeKind.PLACE,
            slotId: slot.draftSew,
            workOrderId: production.draftWorkOrderId,
            ...copyOf(draftSew?.workOrderOperationId ?? null), // B-W2b-F39
            toLineId: lineL1,
            toStartAt: at(19, 8),
            toEndAt: at(19, 10),
            changedAt: T.placed,
            createdAt: T.placed,
          },
          { id: C.pin, ...change, kind: ScheduleChangeKind.PIN, slotId: slot.pack, workOrderId: production.workOrderId, ...copyOf(ops.pack), changedAt: T.pinned, createdAt: T.pinned }, // B-W2b-F39: copyOf
          { id: C.unpin, ...change, kind: ScheduleChangeKind.UNPIN, slotId: slot.pack, workOrderId: production.workOrderId, ...copyOf(ops.pack), changedAt: T.unpinned, createdAt: T.unpinned },
        ],
      })
      const scenario = { companyId: companyA, siteId: siteA, ownerId: actorId, basePlanVersionId: schedule.workingPlanId, basedAt: T.whatIf, createdAt: T.whatIf, updatedAt: T.whatIf, createdById: actorId }
      await tx.whatIfScenario.createMany({
        data: [
          {
            id: W.draft,
            ...scenario,
            name: 'WO-0002 a day later',
            moves: [{ slotId: slot.draftSew, workOrderId: production.draftWorkOrderId, to: { lineId: lineL1, startAt: at(20, 8).toISOString(), endAt: at(20, 10).toISOString() } }],
          },
          { id: W.discarded, ...scenario, name: 'Packing first', moves: [{ slotId: slot.sew, workOrderId: production.workOrderId, to: { lineId: lineL1, startAt: at(18, 8).toISOString(), endAt: at(18, 16).toISOString() } }] },
        ],
      })
      await tx.whatIfScenario.update({ where: { id: W.discarded }, data: { status: WhatIfStatus.DISCARDED, discardedAt: T.discarded, discardedById: actorId, version: 2, updatedAt: T.discarded }, select })
    }),
  )

  // --- the workshop's capacity --------------------------------------------------------------------------------------------
  const K = result.capacityIds
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.subcontractorCapacity.findUnique({ where: { id: K[0] }, select })) return
      const stamp = { partyId: workshopId, createdAt: T.setup, updatedAt: T.setup, createdById: actorId }
      await tx.subcontractorCapacity.createMany({
        data: [
          { id: K[0], ...stamp, workCentreKind: WorkCentreKind.SEWING, unit: SubcontractCapacityUnit.MINUTES, perWeek: 2400, validFrom: DAY('2026-11-01') },
          { id: K[1], ...stamp, unit: SubcontractCapacityUnit.PIECES, perWeek: 60, validFrom: DAY('2026-11-01'), validTo: DAY('2026-12-23'), note: 'Closed for the holidays from 24 Dec (made-up).' },
        ],
      })
    }),
  )
  return result
}
