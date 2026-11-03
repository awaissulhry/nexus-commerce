import {
  CutIssueStatus,
  CutOrderKind,
  CutOrderStatus,
  CutTicketKind,
  CutTicketStatus,
  LayStatus,
  PatternGrain,
  PlyRunStatus,
  SecondaryProcessKind,
  SecondaryProcessPlace,
  SecondaryProcessStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedLeather } from './leather'
import { seed as seedProduct } from './product'
import { seed as seedSchedule } from './schedule'

/**
 * The cutting room seed (W2b schema wave 13/16, B-W2b-85), per tenant of seed/_core.ts. What the office plans (cut orders,
 * lines, tickets, lays, the reconciliation, pattern pieces) is written in the tenant's office scope; what happens at plant A1's
 * tables (spreading, counting, ply stickers, fabric used, the trolley, secondary processes, a downgrade) in A1's floor scope, by
 * the operator, as the app does. The CLI runs this file early (name order); it runs the seeds it builds on first (idempotent):
 * leather and roll stock (rolls of the lining lot, grades), the schedule (WO-0001's rework and its open recut, the finished
 * jacket item) and the product (SEED-JKT-01's draft revision).
 *
 *   SEED-CO-0001  FABRIC, the grey lining SEED-LIN-200 for WO-0001, IN_PROGRESS, marker "MK-LIN-3S" (2.40 m): lay 1 CUT (roll
 *                 SEED-RL-0002, 6 plies counted 6 and 6, its ticket DONE, its ply stickers printed, its fabric used confirmed),
 *                 lay 2 SPREADING (the same roll, 2 plies so far; its ticket STARTED), lay 3 PLANNED (ticket OPEN).
 *   SEED-CO-0002  LEATHER, the black cowhide for WO-0001's black cells, CUT: its ticket DONE, its leather used, line 1 reconciled
 *                 (1 of 1 cut), line 2 not yet.
 *   SEED-CO-0003  LEATHER, PLANNED: one line, waiting to be released.
 *   recut         SEED-CT-0001, a RECUT ticket for one sleeve set of WO-0001 BLK-52 joining bundle 2, from the hide lot: the
 *                 schedule seed's open RECUT replacement names it.
 *   processes     bundle 2: fusing in house WAITING, embroidery outside WAITING (not yet sent), perforation in house DONE.
 *   trolleys      T-1 LOADING with bundle 1; T-2 RECEIVED at line L1 with bundle 2.
 *   pieces        SEED-JKT-01 revision 1 (DRAFT): front left and sleeve (leather, lowest grade B and C), body lining (any grade).
 *   second        WO-0001 BLK-52: one garment kept as the SKU SEED-JKT-02-BLK-52, one as the finished item; a wrong row withdrawn.
 *
 * Nothing here moves stock or cuts a hide (no cut log, no stock move, no bundle): the golden flows' numbers stay. The generated
 * isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy: a cut order and
 * a lay start PLANNED, a line is added to a PLANNED cut order, a roll to a lay that is spread, a ply run to a counted lay, a
 * consumption to a CUT lay, a reconciliation to a CUT cut order, a ticket starts OPEN (and one per lay: so the first is the
 * recut), a process starts WAITING, a trolley LOADING, a downgrade is not withdrawn, and a pattern piece belongs to a DRAFT
 * revision. So those rows get ids that start with eight zeros. Every name, number and value is invented. Idempotent: written
 * once, skipped when the first cut order exists.
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  planned: new Date('2026-11-20T07:30:00.000Z'),
  released: new Date('2026-11-20T08:00:00.000Z'),
  started: new Date('2026-11-20T08:30:00.000Z'),
  counted: new Date('2026-11-20T09:15:00.000Z'),
  cut: new Date('2026-11-20T09:45:00.000Z'),
  printed: new Date('2026-11-20T09:50:00.000Z'),
  confirmed: new Date('2026-11-20T10:00:00.000Z'),
  reconciled: new Date('2026-11-20T16:00:00.000Z'),
  sent: new Date('2026-11-20T11:00:00.000Z'),
  received: new Date('2026-11-20T11:20:00.000Z'),
  done: new Date('2026-11-20T13:00:00.000Z'),
  withdrawn: new Date('2026-11-20T14:00:00.000Z'),
}

export interface CuttingSeed {
  readonly cutOrderIds: { readonly fabric: string; readonly leather: string; readonly planned: string }
  readonly lineIds: { readonly fabric: readonly string[]; readonly leather: readonly [string, string]; readonly planned: string }
  readonly layIds: { readonly cut: string; readonly spreading: string; readonly planned: string }
  readonly ticketIds: { readonly layCut: string; readonly laySpreading: string; readonly layPlanned: string; readonly leather: string; readonly recut: string }
  readonly layRollIds: { readonly cut: string; readonly spreading: string }
  readonly plyRunId: string
  readonly consumptionIds: { readonly lay: string; readonly leather: string }
  readonly reconciliationId: string
  readonly processIds: { readonly fusing: string; readonly embroidery: string; readonly perforation: string }
  readonly issueIds: { readonly loading: string; readonly received: string }
  readonly issueLineIds: { readonly loading: string; readonly received: string }
  readonly patternPieceIds: { readonly front: string; readonly sleeve: string; readonly lining: string }
  readonly downgradeIds: { readonly sku: string; readonly item: string; readonly withdrawn: string }
  readonly workOrderId: string
  readonly replacementRequestId: string
  readonly rollId: string
  readonly operatorId: string
}

export async function seed(context: SeedContext): Promise<CuttingSeed> {
  const { db, namespace } = context
  const leather = await seedLeather(context)
  const schedule = await seedSchedule(context)
  const product = await seedProduct(context)
  const { production } = schedule
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const operatorId = production.operatorId
  const atTable = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })

  const workOrderId = production.workOrderId
  const cells = production.cellIds
  const [bundle1, bundle2] = production.bundleIds
  const liningItemId = id('product:item:lining')
  const liningGrey = id('product:item-colour:lining:GRY')
  const leatherItemId = id('product:item:leather')
  const leatherBlack = id('product:item-colour:leather:BLK')
  const cuttingTable = id('site:A1:station:CUT-01')
  const cuttingCentre = id('site:A1:work-centre:CUT')
  const lineL1 = id('site:A1:line:L1')
  const rollId = leather.rollIds.partial

  const cutOrderIds = { fabric: id('cutting:order:CO-1'), leather: id('cutting:order:CO-2'), planned: firstId('cutting:order:CO-3') }
  const fabricCells = ['BLK-50', 'BLK-52', 'BLK-54', 'RED-50', 'RED-52', 'RED-54'] as const
  const lineIds = {
    fabric: fabricCells.map((cell) => id(`cutting:line:CO-1:${cell}`)),
    leather: [id('cutting:line:CO-2:BLK-50'), id('cutting:line:CO-2:BLK-52')] as const,
    planned: firstId('cutting:line:CO-3:BLK-54'),
  }
  const layIds = { cut: id('cutting:lay:CO-1:1'), spreading: id('cutting:lay:CO-1:2'), planned: firstId('cutting:lay:CO-1:3') }
  const ticketIds = {
    layCut: id('cutting:ticket:CO-1:1'),
    laySpreading: id('cutting:ticket:CO-1:2'),
    layPlanned: id('cutting:ticket:CO-1:3'),
    leather: id('cutting:ticket:CO-2'),
    recut: firstId('cutting:ticket:recut:1'),
  }
  const layRollIds = { cut: id('cutting:lay-roll:CO-1:1:1'), spreading: firstId('cutting:lay-roll:CO-1:2:1') }
  const plyRunId = firstId('cutting:ply-run:CO-1:1:1')
  const consumptionIds = { lay: firstId('cutting:consumption:CO-1:1'), leather: id('cutting:consumption:CO-2') }
  const reconciliationId = firstId('cutting:reconciliation:CO-2:1')
  const processIds = { fusing: firstId('cutting:process:bundle-2:fusing'), embroidery: id('cutting:process:bundle-2:embroidery'), perforation: id('cutting:process:bundle-2:perforation') }
  const issueIds = { loading: firstId('cutting:issue:T-1'), received: id('cutting:issue:T-2') }
  const issueLineIds = { loading: firstId('cutting:issue-line:T-1:1'), received: id('cutting:issue-line:T-2:1') }
  const patternPieceIds = { front: firstId('cutting:piece:JKT-01:1:front'), sleeve: id('cutting:piece:JKT-01:1:sleeve'), lining: id('cutting:piece:JKT-01:1:lining') }
  const downgradeIds = { sku: firstId('cutting:downgrade:BLK-52:sku'), item: id('cutting:downgrade:BLK-52:item'), withdrawn: id('cutting:downgrade:BLK-52:wrong') }

  const result: CuttingSeed = {
    cutOrderIds,
    lineIds,
    layIds,
    ticketIds,
    layRollIds,
    plyRunId,
    consumptionIds,
    reconciliationId,
    processIds,
    issueIds,
    issueLineIds,
    patternPieceIds,
    downgradeIds,
    workOrderId,
    replacementRequestId: schedule.replacementRequestId,
    rollId,
    operatorId,
  }

  const done = await db.withScope(office, (client) => client.cutOrder.findUnique({ where: { id: cutOrderIds.planned }, select: { id: true } }))
  if (done) return result

  // --- the office plans: cut orders, lines, lays, tickets; the recut ticket; pattern pieces -----------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.cutOrder.createMany({
        data: [
          {
            id: cutOrderIds.fabric,
            companyId: companyA,
            siteId: siteA,
            number: 'SEED-CO-0001',
            kind: CutOrderKind.FABRIC,
            itemId: liningItemId,
            itemColourId: liningGrey,
            stationId: cuttingTable,
            markerName: 'MK-LIN-3S',
            markerLength: '2.4000',
            markerUom: Uom.M,
            markerWidthCm: '140.00',
            note: 'The lining of WO-0001, every cell in one marker.',
            ...stamp(T.planned),
          },
          { id: cutOrderIds.leather, companyId: companyA, siteId: siteA, number: 'SEED-CO-0002', kind: CutOrderKind.LEATHER, itemId: leatherItemId, itemColourId: leatherBlack, stationId: cuttingTable, ...stamp(T.planned) },
          { id: cutOrderIds.planned, companyId: companyA, siteId: siteA, number: 'SEED-CO-0003', kind: CutOrderKind.LEATHER, itemId: leatherItemId, itemColourId: leatherBlack, note: 'Waiting for its hides.', ...stamp(T.planned) },
        ],
      })
      await tx.cutOrderLine.createMany({
        data: [
          // Fabric: one ply of the marker gives one garment of each cell (ratio 1), the cell's garments in plies.
          ...fabricCells.map((cell, index) => {
            const garments = { 'BLK-50': 1, 'BLK-52': 2, 'BLK-54': 1, 'RED-50': 1, 'RED-52': 1, 'RED-54': 1 }[cell]
            return { id: lineIds.fabric[index]!, siteId: siteA, cutOrderId: cutOrderIds.fabric, seq: (index + 1) * 10, workOrderId, workOrderSizeId: cells[cell], quantity: garments, ratio: 1, plies: garments, ...stamp(T.planned) }
          }),
          { id: lineIds.leather[0], siteId: siteA, cutOrderId: cutOrderIds.leather, seq: 10, workOrderId, workOrderSizeId: cells['BLK-50'], quantity: 1, ...stamp(T.planned) },
          { id: lineIds.leather[1], siteId: siteA, cutOrderId: cutOrderIds.leather, seq: 20, workOrderId, workOrderSizeId: cells['BLK-52'], quantity: 2, ...stamp(T.planned) },
          { id: lineIds.planned, siteId: siteA, cutOrderId: cutOrderIds.planned, seq: 10, workOrderId, workOrderSizeId: cells['BLK-54'], quantity: 1, ...stamp(T.planned) },
        ],
      })
      await tx.lay.createMany({
        data: [
          { id: layIds.cut, siteId: siteA, cutOrderId: cutOrderIds.fabric, seq: 1, plies: 6, ...stamp(T.planned) },
          { id: layIds.spreading, siteId: siteA, cutOrderId: cutOrderIds.fabric, seq: 2, plies: 2, ...stamp(T.planned) },
          { id: layIds.planned, siteId: siteA, cutOrderId: cutOrderIds.fabric, seq: 3, plies: 1, note: 'A spare lay for a recut, if one is asked.', ...stamp(T.planned) },
        ],
      })
      // Released: tickets are printed (one per lay of the fabric order, one for the leather order).
      for (const cutOrderId of [cutOrderIds.fabric, cutOrderIds.leather]) {
        await tx.cutOrder.update({ where: { id: cutOrderId }, data: { status: CutOrderStatus.RELEASED, releasedAt: T.released, releasedById: actorId, updatedAt: T.released }, select: { id: true } })
      }
      const ticket = (ticketId: string, n: number, cutOrderId: string, layId: string | null) => ({
        id: ticketId,
        companyId: companyA,
        siteId: siteA,
        number: `SEED-CTA-2026-0000${n}`,
        scanCode: `SEED-CT-000${n}`,
        kind: CutTicketKind.CUT,
        cutOrderId,
        layId,
        printedAt: T.released,
        ...stamp(T.released),
      })
      await tx.cutTicket.createMany({
        data: [
          ticket(ticketIds.layCut, 2, cutOrderIds.fabric, layIds.cut),
          ticket(ticketIds.laySpreading, 3, cutOrderIds.fabric, layIds.spreading),
          ticket(ticketIds.layPlanned, 4, cutOrderIds.fabric, layIds.planned),
          ticket(ticketIds.leather, 5, cutOrderIds.leather, null),
          {
            id: ticketIds.recut,
            companyId: companyA,
            siteId: siteA,
            number: 'SEED-CTA-2026-00001',
            scanCode: 'SEED-CT-0001',
            kind: CutTicketKind.RECUT,
            workOrderId,
            workOrderSizeId: cells['BLK-52'],
            bundleId: bundle2,
            part: 'sleeve',
            quantity: 1,
            lotItemId: leatherItemId,
            lotId: leather.leatherLotId,
            printedAt: T.released,
            ...stamp(T.released),
          },
        ],
      })
      // The schedule seed's open recut of one sleeve set (BLK-52) is cut from this ticket.
      await tx.replacementRequest.update({ where: { id: schedule.replacementRequestId }, data: { recutTicketId: ticketIds.recut, updatedAt: T.released }, select: { id: true } })

      // SEED-JKT-01 revision 1 is a draft: its pattern pieces are written while it is one (they freeze with its release).
      await tx.patternPiece.createMany({
        data: [
          { id: patternPieceIds.front, styleId: product.styleId, revisionId: product.revisionId, seq: 10, name: 'Front left', quantity: 1, bomLineId: id('product:bom:JKT-01:1:10'), minGradeId: leather.gradeIds.B, grain: PatternGrain.ALONG, ...stamp(T.planned) },
          { id: patternPieceIds.sleeve, styleId: product.styleId, revisionId: product.revisionId, seq: 20, name: 'Sleeve', quantity: 2, bomLineId: id('product:bom:JKT-01:1:10'), minGradeId: leather.gradeIds.C, grain: PatternGrain.ALONG, sizes: ['52', '54'], note: 'Sizes 50 have the one-piece sleeve.', ...stamp(T.planned) },
          { id: patternPieceIds.lining, styleId: product.styleId, revisionId: product.revisionId, seq: 30, name: 'Body lining', quantity: 1, bomLineId: id('product:bom:JKT-01:1:20'), grain: PatternGrain.ANY, ...stamp(T.planned) },
        ],
      })
    }),
  )

  // --- at the table: the fabric order is spread, counted and cut lay by lay; the leather order is cut ---------------------
  await db.withScope(atTable, (client) =>
    client.$transaction(async (tx) => {
      for (const cutOrderId of [cutOrderIds.fabric, cutOrderIds.leather]) {
        await tx.cutOrder.update({ where: { id: cutOrderId }, data: { status: CutOrderStatus.IN_PROGRESS, updatedAt: T.started }, select: { id: true } })
      }
      // Lay 1: the ticket scanned, 6 plies from roll SEED-RL-0002, both ends counted 6, cut, the ticket scanned again.
      await tx.cutTicket.update({ where: { id: ticketIds.layCut }, data: { status: CutTicketStatus.STARTED, startedAt: T.started, updatedAt: T.started }, select: { id: true } })
      await tx.lay.update({ where: { id: layIds.cut }, data: { status: LayStatus.SPREADING, updatedAt: T.started }, select: { id: true } })
      await tx.layRoll.create({
        data: { id: layRollIds.cut, siteId: siteA, layId: layIds.cut, seq: 1, rollId, plies: 6, splices: 1, endLoss: '0.3000', endReturned: '0.0000', ...stamp(T.started, operatorId) },
        select: { id: true },
      })
      await tx.lay.update({
        where: { id: layIds.cut },
        data: { status: LayStatus.CHECKED, plyCountLeft: 6, plyCountRight: 6, checkedAt: T.counted, layLength: '2.4500', lengthUom: Uom.M, updatedAt: T.counted },
        select: { id: true },
      })
      await tx.cutTicket.update({ where: { id: ticketIds.layCut }, data: { status: CutTicketStatus.DONE, doneAt: T.cut, updatedAt: T.cut }, select: { id: true } })
      await tx.lay.update({ where: { id: layIds.cut }, data: { status: LayStatus.CUT, cutAt: T.cut, updatedAt: T.cut }, select: { id: true } })
      await tx.plyRun.create({
        data: { id: plyRunId, siteId: siteA, layId: layIds.cut, seq: 1, firstPly: 1, lastPly: 6, parts: ['body', 'sleeve'], labelCount: 12, status: PlyRunStatus.PRINTED, printedAt: T.printed, ...stamp(T.printed, operatorId) },
        select: { id: true },
      })
      await tx.cutConsumption.create({
        data: {
          id: consumptionIds.lay,
          siteId: siteA,
          cutOrderId: cutOrderIds.fabric,
          layId: layIds.cut,
          key: `consumption:${layIds.cut}`,
          uom: Uom.M,
          estimated: '14.4000',
          recorded: '15.0000',
          confirmed: '15.0000',
          confirmedAt: T.confirmed,
          note: 'One splice and the end of the roll.',
          ...stamp(T.confirmed, operatorId),
        },
        select: { id: true },
      })
      // Lay 2: the ticket scanned, 2 plies spread so far from the same roll (one shade group).
      await tx.cutTicket.update({ where: { id: ticketIds.laySpreading }, data: { status: CutTicketStatus.STARTED, startedAt: T.sent, updatedAt: T.sent }, select: { id: true } })
      await tx.lay.update({ where: { id: layIds.spreading }, data: { status: LayStatus.SPREADING, updatedAt: T.sent }, select: { id: true } })
      await tx.layRoll.create({
        data: { id: layRollIds.spreading, siteId: siteA, layId: layIds.spreading, seq: 1, rollId, plies: 2, ...stamp(T.sent, operatorId) },
        select: { id: true },
      })
      // The leather order: its ticket scanned at the start and the end, then cut; the leather used confirmed.
      await tx.cutTicket.update({ where: { id: ticketIds.leather }, data: { status: CutTicketStatus.STARTED, startedAt: T.started, updatedAt: T.started }, select: { id: true } })
      await tx.cutTicket.update({ where: { id: ticketIds.leather }, data: { status: CutTicketStatus.DONE, doneAt: T.cut, updatedAt: T.cut }, select: { id: true } })
      await tx.cutOrder.update({ where: { id: cutOrderIds.leather }, data: { status: CutOrderStatus.CUT, cutAt: T.cut, updatedAt: T.cut }, select: { id: true } })
      await tx.cutConsumption.create({
        data: {
          id: consumptionIds.leather,
          siteId: siteA,
          cutOrderId: cutOrderIds.leather,
          key: `consumption:${cutOrderIds.leather}`,
          uom: Uom.FT2,
          estimated: '150.0000',
          recorded: '145.5000',
          ...stamp(T.cut, operatorId),
        },
        select: { id: true },
      })
    }),
  )

  // --- the office reconciles the leather order's first line -----------------------------------------------------------
  await db.withScope(office, (client) =>
    client.cutReconciliation.create({
      data: {
        id: reconciliationId,
        siteId: siteA,
        cutOrderId: cutOrderIds.leather,
        cutOrderLineId: lineIds.leather[0],
        key: `reconciliation:${lineIds.leather[0]}`,
        orderedQuantity: 1,
        cutQuantity: 1,
        reconciledAt: T.reconciled,
        createdAt: T.reconciled,
        createdById: actorId,
      },
      select: { id: true },
    }),
  )

  // --- after cutting: secondary processes, the trolleys to sewing, second quality --------------------------------------
  await db.withScope(atTable, (client) =>
    client.$transaction(async (tx) => {
      await tx.secondaryProcess.createMany({
        data: [
          { id: processIds.fusing, siteId: siteA, workOrderId, bundleId: bundle2, seq: 10, kind: SecondaryProcessKind.FUSING, place: SecondaryProcessPlace.IN_HOUSE, workCentreId: cuttingCentre, quantity: 2, ...stamp(T.cut, operatorId) },
          { id: processIds.embroidery, siteId: siteA, workOrderId, bundleId: bundle2, seq: 20, kind: SecondaryProcessKind.EMBROIDERY, place: SecondaryProcessPlace.OUTSIDE, quantity: 2, note: 'The logo on the sleeve; the workshop is chosen when it is sent.', ...stamp(T.cut, operatorId) },
          { id: processIds.perforation, siteId: siteA, workOrderId, bundleId: bundle2, seq: 5, kind: SecondaryProcessKind.PERFORATION, place: SecondaryProcessPlace.IN_HOUSE, workCentreId: cuttingCentre, quantity: 2, ...stamp(T.cut, operatorId) },
        ],
      })
      await tx.secondaryProcess.update({ where: { id: processIds.perforation }, data: { status: SecondaryProcessStatus.IN_PROGRESS, startedAt: T.cut, updatedAt: T.cut }, select: { id: true } })
      await tx.secondaryProcess.update({ where: { id: processIds.perforation }, data: { status: SecondaryProcessStatus.DONE, doneAt: T.confirmed, updatedAt: T.confirmed }, select: { id: true } })

      await tx.cutIssue.createMany({
        data: [
          { id: issueIds.loading, companyId: companyA, siteId: siteA, trolleyCode: 'SEED-T-1', lineId: lineL1, ...stamp(T.done, operatorId) },
          { id: issueIds.received, companyId: companyA, siteId: siteA, trolleyCode: 'SEED-T-2', lineId: lineL1, ...stamp(T.sent, operatorId) },
        ],
      })
      await tx.cutIssueLine.createMany({
        data: [
          { id: issueLineIds.loading, siteId: siteA, cutIssueId: issueIds.loading, workOrderId, bundleId: bundle1, ...stamp(T.done, operatorId) },
          { id: issueLineIds.received, siteId: siteA, cutIssueId: issueIds.received, workOrderId, bundleId: bundle2, ...stamp(T.sent, operatorId) },
        ],
      })
      await tx.cutIssue.update({ where: { id: issueIds.received }, data: { status: CutIssueStatus.SENT, sentAt: T.sent, updatedAt: T.sent }, select: { id: true } })
      await tx.cutIssueLine.update({ where: { id: issueLineIds.received }, data: { receivedAt: T.received, updatedAt: T.received }, select: { id: true } })
      await tx.cutIssue.update({ where: { id: issueIds.received }, data: { status: CutIssueStatus.RECEIVED, receivedAt: T.received, updatedAt: T.received }, select: { id: true } })

      await tx.garmentDowngrade.createMany({
        data: [
          { id: downgradeIds.sku, companyId: companyA, siteId: siteA, workOrderId, workOrderSizeId: cells['BLK-52'], bundleId: bundle2, quantity: 1, reasonCode: 'LEATHER_FLAW', note: 'A healed scar on the back panel: sold as second quality.', variantId: id('production:variant:JKT-02:BLK:52'), ...stamp(T.done, operatorId) },
          { id: downgradeIds.withdrawn, companyId: companyA, siteId: siteA, workOrderId, workOrderSizeId: cells['BLK-52'], quantity: 1, reasonCode: 'STITCHING', variantId: id('production:variant:JKT-02:BLK:52'), ...stamp(T.done, operatorId) },
        ],
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.garmentDowngrade.create({
        data: { id: downgradeIds.item, companyId: companyA, siteId: siteA, workOrderId, workOrderSizeId: cells['BLK-52'], reworkOrderId: schedule.reworkOrderId, quantity: 1, reasonCode: 'ALIGNMENT', secondQualityItemId: schedule.finishedItemId, ...stamp(T.done) },
        select: { id: true },
      })
      await tx.garmentDowngrade.update({
        where: { id: downgradeIds.withdrawn },
        data: { voidedAt: T.withdrawn, voidedById: actorId, voidReason: 'Recorded twice: the garment was repaired.', updatedAt: T.withdrawn },
        select: { id: true },
      })
    }),
  )

  return result
}
