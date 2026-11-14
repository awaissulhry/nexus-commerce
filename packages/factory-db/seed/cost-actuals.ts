import type { Prisma } from '../src/generated/prisma/client'
import {
  CostingMethod,
  LandedCostBasis,
  LandedCostStatus,
  PurchasePriceVarianceAt,
  WorkOrderCostKind,
  WorkOrderKind,
  WorkOrderStatus,
  WorkOrderVarianceCategory,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAccounting, type AccountingSeed } from './accounting'

/**
 * The actual-cost seed (W2b-6 schema wave 54/57, B-W2b-376), per tenant of seed/_core.ts, for company A, written in the
 * tenant's office scope as the app does. The CLI runs the seed files in name order and this one sorts before the seeds it
 * names (accounting, costing, production, shipping …): it runs the accounting seed itself, which runs every seed it
 * builds on (all idempotent).
 *
 *   settings      the tenant-wide row (a 5 % close tolerance, the variance at the receipt); company A's own row (5 %, the
 *                 purchase price variance at the invoice) with its figures for the accountant switched ON by the owner
 *                 (GATE-ACCOUNTANT: made-up figures for the tests and the screens; a company starts OFF, and company B has
 *                 no row: OFF).
 *   SEED-WO-0004  a work order made for this seed (2 × SEED-JKT-02 BLK 52 of SEED-SO-0002's black line, batch
 *                 SEED-BT-0004), released, made and COMPLETED; its ledger: the material and labour at actual in one
 *                 adjustment (120.00, made up) and the garments completed at standard (114.00).
 *     close 1     closed within the 5 % tolerance with its variance split (material usage of the leather 3.00), its
 *                 variance entry and closing entry (3.00 each); then undone after 20 seconds by the person who closed it
 *                 (the Undo: no reason), both entries reversed, the work order back to COMPLETED.
 *     close 2     closed again an hour later: the leather 7.8 % over plan (reason LEATHER_YIELD, two panels recut); its
 *                 split (material usage 4.00, labour efficiency 1.50), their variance entries, and the closing entry of
 *                 the 0.50 left; the work order CLOSED, its entries adding up to 0.
 *   PPV           P2's invoice 2026/0412 for SEED-GR-0001's leather: 105 ft² paid 4.30 against the 4.20 standard: 10.50.
 *   cost of sales SEED-SH-0001's BLK 50 (148.00); its RED 52 posted at 145.00, reversed (the lot's cost was corrected),
 *                 posted again at 146.50. Made-up layer costs (the seed's finished goods carry no valuation).
 *   landed cost   P2's 15.00 of freight: first by value onto lot SEED-LOT-LEA-01, posted, then reversed (the accountant
 *                 wants freight by quantity); a DRAFT by quantity onto the same lot, waiting to be posted.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a live close takes no second live close (so the first close is the undone one, written as history), a variance
 * goes onto a live close (the first variance is close 2's), a reversal is taken back once (the first purchase price
 * variance and cost of goods sold are plain postings), shares go onto a DRAFT landed cost (the first landed cost is the
 * DRAFT, its share the first share). So those rows get ids that start with eight zeros (still derived from the
 * namespace); the work order and its parts, and every other row, are plain (no other table's first row moves).
 *
 * Every name, number and amount is invented. Idempotent: each record is written once, in one transaction, and skipped
 * when it exists (variances, purchase price variances and cost of goods sold are append-only, an undone close changes no
 * more, a posted landed cost never changes).
 */

/** Fixed instants, so the seed never depends on the clock (all before the day it was written). */
const T = {
  switchedOn: new Date('2026-11-02T08:00:00.000Z'),
  planned: new Date('2026-11-03T08:00:00.000Z'),
  released: new Date('2026-11-04T07:00:00.000Z'),
  started: new Date('2026-11-04T07:30:00.000Z'),
  actuals: new Date('2026-11-05T17:00:00.000Z'),
  completed: new Date('2026-11-06T12:00:00.000Z'),
  firstClose: new Date('2026-11-06T15:00:00.000Z'),
  undone: new Date('2026-11-06T15:00:20.000Z'),
  secondClose: new Date('2026-11-06T16:00:00.000Z'),
  ppv: new Date('2026-11-13T10:00:00.000Z'),
  landedPosted: new Date('2026-11-13T11:00:00.000Z'),
  landedReversed: new Date('2026-11-13T11:30:00.000Z'),
  landedDraft: new Date('2026-11-13T11:45:00.000Z'),
  // seed/shipping.ts: SEED-SH-0001 was picked up then.
  shipped: new Date('2026-11-24T08:05:00.000Z'),
  revalued: new Date('2026-11-24T09:00:00.000Z'),
} as const

/** SEED-JKT-02's routing (seed/production.ts): step, code, name, standard minutes, work centre. */
const ROUTING = [
  { seq: 10, operation: 'CUT', code: 'SEED-CUT-LEA', name: 'Cut leather panels', minutes: '14.000', centre: 'CUT' },
  { seq: 20, operation: 'SEW', code: 'SEED-SEW-ASM', name: 'Sew and assemble the body', minutes: '96.500', centre: 'SEW' },
  { seq: 30, operation: 'QC', code: 'SEED-FIN-QC', name: 'Final inspection', minutes: '8.000', centre: 'QC' },
  { seq: 40, operation: 'PACK', code: 'SEED-PACK', name: 'Pack', minutes: '3.500', centre: 'PACK' },
] as const

/** SEED-WO-0004's ledger before its close, minor units: actual in, standard out, 6.00 left. */
const LEDGER = { actual: 12_000, completed: -11_400 } as const

export interface CostActualsSeed {
  readonly accounting: AccountingSeed
  readonly settingsIds: { readonly tenant: string; readonly companyA: string }
  readonly workOrderId: string
  /** Close 1 (undone, its entries reversed) and close 2 (live). */
  readonly closeIds: { readonly undone: string; readonly live: string }
  readonly varianceIds: { readonly undoneUsage: string; readonly usage: string; readonly labour: string }
  readonly costEntryIds: {
    readonly actual: string
    readonly completed: string
    readonly undoneVariance: string
    readonly undoneClose: string
    readonly undoneVarianceReversal: string
    readonly undoneCloseReversal: string
    readonly usage: string
    readonly labour: string
    readonly close: string
  }
  readonly ppvId: string
  readonly cogsIds: { readonly black: string; readonly red: string; readonly redReversal: string; readonly redAgain: string }
  readonly landedIds: { readonly reversed: string; readonly reversedShare: string; readonly draft: string; readonly draftShare: string }
}

export async function seed(context: SeedContext): Promise<CostActualsSeed> {
  const { db, namespace } = context
  const accounting = await seedAccounting(context)
  const shipping = accounting.money.shipping
  const production = shipping.quality.production
  const inventory = production.inventory
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const P1 = id('party:P1')
  const P2 = id('party:P2')
  const leather = id('product:item:leather')
  const office = { audience: 'office' as const, tenantId, actorId }
  const select = { id: true } as const

  const settingsIds = { tenant: tenantId, companyA }
  const workOrderId = id('cost-actuals:work-order:WO-0004')
  const cellId = id('cost-actuals:WO-0004:cell:BLK:52')
  const closeIds = { undone: firstId('cost-actuals:WO-0004:close:1'), live: id('cost-actuals:WO-0004:close:2') }
  const varianceIds = {
    undoneUsage: id('cost-actuals:WO-0004:close:1:variance:usage'),
    usage: firstId('cost-actuals:WO-0004:close:2:variance:usage'),
    labour: id('cost-actuals:WO-0004:close:2:variance:labour'),
  }
  const entry = (key: string): string => id(`cost-actuals:WO-0004:entry:${key}`)
  const costEntryIds = {
    actual: entry('actual'),
    completed: entry('completed'),
    undoneVariance: entry('close:1:variance'),
    undoneClose: entry('close:1:close'),
    undoneVarianceReversal: entry('close:1:variance:reversal'),
    undoneCloseReversal: entry('close:1:close:reversal'),
    usage: entry('close:2:variance:usage'),
    labour: entry('close:2:variance:labour'),
    close: entry('close:2:close'),
  }
  const ppvId = firstId('cost-actuals:ppv:P2:2026-0412:1')
  const [blackLine, redLine] = shipping.lineIds
  const cogsIds = {
    black: firstId('cost-actuals:cogs:SH-0001:BLK-50'),
    red: id('cost-actuals:cogs:SH-0001:RED-52'),
    redReversal: id('cost-actuals:cogs:SH-0001:RED-52:reversal'),
    redAgain: id('cost-actuals:cogs:SH-0001:RED-52:2'),
  }
  const landedIds = {
    reversed: id('cost-actuals:landed:P2:2026-0412:2:value'),
    reversedShare: id('cost-actuals:landed:P2:2026-0412:2:value:share'),
    draft: firstId('cost-actuals:landed:P2:2026-0412:2:quantity'),
    draftShare: firstId('cost-actuals:landed:P2:2026-0412:2:quantity:share'),
  }

  // --- the settings ------------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.actualCostSettings.findUnique({ where: { id: settingsIds.tenant }, select })) return
      await tx.actualCostSettings.createMany({
        data: [
          { id: settingsIds.tenant, companyId: null, closeTolerancePct: '5.0000', ppvAt: PurchasePriceVarianceAt.RECEIPT, createdAt: T.switchedOn, updatedAt: T.switchedOn, createdById: actorId },
          {
            id: settingsIds.companyA,
            companyId: companyA,
            closeTolerancePct: '5.0000',
            ppvAt: PurchasePriceVarianceAt.INVOICE,
            postingsOn: true,
            postingsOnAt: T.switchedOn,
            postingsOnById: actorId,
            createdAt: T.switchedOn,
            updatedAt: T.switchedOn,
            createdById: actorId,
          },
        ],
      })
    }),
  )

  // --- SEED-WO-0004: made, released, completed --------------------------------------------------------------------------
  const method = await db.withScope(office, async (client) => {
    const own = await client.costingSettings.findFirst({ where: { companyId: companyA }, select: { costingMethod: true } })
    const tenantWide = own ?? (await client.costingSettings.findFirst({ where: { companyId: null }, select: { costingMethod: true } }))
    return tenantWide?.costingMethod ?? CostingMethod.UNDECIDED
  })
  const centre = (code: string): string => id(`site:A1:work-centre:${code}`)
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrder.findUnique({ where: { id: workOrderId }, select })) return
      const stamp = { createdAt: T.planned, updatedAt: T.planned, createdById: actorId }
      await tx.workOrder.create({
        data: { id: workOrderId, companyId: companyA, siteId: siteA, number: 'SEED-WO-0004', kind: WorkOrderKind.SIZE_GRID, styleId: production.styleId, styleRevisionId: production.revisionId, ...stamp },
        select,
      })
      await tx.workOrderSize.create({
        data: {
          id: cellId,
          siteId: siteA,
          workOrderId,
          styleId: production.styleId,
          colourwayId: id('production:colourway:JKT-02:BLK'),
          size: '52',
          quantity: 2,
          salesOrderLineId: id('production:sales-order:SO-0002:10'),
          partyId: P1,
          ...stamp,
        },
        select,
      })
      await tx.workOrderOperation.createMany({
        data: ROUTING.map((step) => ({
          id: id(`cost-actuals:WO-0004:operation:${step.seq}`),
          siteId: siteA,
          workOrderId,
          styleRevisionId: production.revisionId,
          seq: step.seq,
          routingSeq: step.seq,
          code: step.code,
          name: step.name,
          standardMinutes: step.minutes,
          workCentreId: centre(step.centre),
          ...stamp,
        })),
      })
      await tx.workOrder.update({
        where: { id: workOrderId },
        data: { status: WorkOrderStatus.RELEASED, labelTemplateId: production.labelTemplateId, batchNumber: 'SEED-BT-0004', releasedAt: T.released, releasedById: actorId, updatedAt: T.released, version: { increment: 1 } },
        select,
      })
      await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.IN_PROGRESS, startedAt: T.started, updatedAt: T.started, version: { increment: 1 } }, select })
      await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.COMPLETED, completedAt: T.completed, updatedAt: T.completed, version: { increment: 1 } }, select })
    }),
  )

  const entryBase = { companyId: companyA, siteId: siteA, workOrderId, currency: 'EUR', costingMethod: method, createdById: actorId }
  // Its ledger before the close: the actual material and labour (one adjustment, made up), the garments at standard.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrderCostEntry.findUnique({ where: { id: costEntryIds.actual }, select })) return
      await tx.workOrderCostEntry.createMany({
        data: [
          {
            ...entryBase,
            id: costEntryIds.actual,
            kind: WorkOrderCostKind.ADJUSTMENT,
            occurredAt: T.actuals,
            amount: LEDGER.actual,
            reason: 'Material and labour at actual for the seed work order (made-up figures).',
            idempotencyKey: `seed:${workOrderId}:actual`,
            createdAt: T.actuals,
          },
          {
            ...entryBase,
            id: costEntryIds.completed,
            kind: WorkOrderCostKind.COMPLETION,
            occurredAt: T.completed,
            amount: LEDGER.completed,
            idempotencyKey: `seed:${workOrderId}:completed`,
            createdAt: T.completed,
          },
        ],
      })
    }),
  )

  /** A close of the two garments: planned 90.00 of material and 244 standard minutes. */
  const closeOf = (closeId: string, at: Date, actualMaterialCost: number, reason: { code: string; note: string } | null): Prisma.WorkOrderCloseCreateManyInput => ({
    id: closeId,
    companyId: companyA,
    siteId: siteA,
    workOrderId,
    plannedQuantity: 2,
    actualQuantity: 2,
    plannedMaterialCost: 9_000,
    actualMaterialCost,
    plannedMinutes: '244.0000',
    actualMinutes: '250.0000',
    currency: 'EUR',
    tolerancePct: '5.0000',
    reasonCode: reason?.code ?? null,
    reasonNote: reason?.note ?? null,
    closedAt: at,
    closedById: actorId,
    createdAt: at,
    updatedAt: at,
    createdById: actorId,
  })

  // --- close 1: closed, settled, undone at once (the Undo), its entries reversed --------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrderClose.findUnique({ where: { id: closeIds.undone }, select })) return
      await tx.workOrderClose.create({ data: closeOf(closeIds.undone, T.firstClose, 9_300, null), select })
      await tx.workOrderVariance.create({
        data: {
          id: varianceIds.undoneUsage,
          companyId: companyA,
          siteId: siteA,
          workOrderId,
          closeId: closeIds.undone,
          category: WorkOrderVarianceCategory.MATERIAL_USAGE,
          itemId: leather,
          standardQuantity: '93.6000',
          actualQuantity: '96.4000',
          standardUnitCost: '4.200000',
          actualUnitCost: '4.200000',
          amount: 300,
          createdAt: T.firstClose,
          createdById: actorId,
        },
        select,
      })
      const closeEntry = { ...entryBase, occurredAt: T.firstClose, createdAt: T.firstClose }
      await tx.workOrderCostEntry.create({
        data: { ...closeEntry, id: costEntryIds.undoneVariance, kind: WorkOrderCostKind.VARIANCE, itemId: leather, amount: -300, sourceType: 'WorkOrderVariance', sourceId: varianceIds.undoneUsage, idempotencyKey: `variance:${varianceIds.undoneUsage}` },
        select,
      })
      await tx.workOrderCostEntry.create({
        data: { ...closeEntry, id: costEntryIds.undoneClose, kind: WorkOrderCostKind.CLOSE, amount: -300, sourceType: 'WorkOrderClose', sourceId: closeIds.undone, idempotencyKey: `close:${closeIds.undone}` },
        select,
      })
      await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.CLOSED, closedAt: T.firstClose, updatedAt: T.firstClose, version: { increment: 1 } }, select })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const close = await tx.workOrderClose.findUnique({ where: { id: closeIds.undone }, select: { undoneAt: true } })
      if (!close || close.undoneAt) return
      await tx.workOrderClose.update({ where: { id: closeIds.undone }, data: { undoneAt: T.undone, undoneById: actorId, updatedAt: T.undone, version: { increment: 1 } }, select })
      const reversal = { ...entryBase, occurredAt: T.undone, createdAt: T.undone, reason: 'The close was undone (Undo).' }
      await tx.workOrderCostEntry.createMany({
        data: [
          { ...reversal, id: costEntryIds.undoneVarianceReversal, kind: WorkOrderCostKind.VARIANCE, itemId: leather, amount: 300, reversalOfId: costEntryIds.undoneVariance, idempotencyKey: `reversal:${costEntryIds.undoneVariance}` },
          { ...reversal, id: costEntryIds.undoneCloseReversal, kind: WorkOrderCostKind.CLOSE, amount: 300, reversalOfId: costEntryIds.undoneClose, idempotencyKey: `reversal:${costEntryIds.undoneClose}` },
        ],
      })
      await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.COMPLETED, closedAt: null, updatedAt: T.undone, version: { increment: 1 } }, select })
    }),
  )

  // --- close 2: beyond the tolerance with its reason, split, settled, CLOSED -----------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrderClose.findUnique({ where: { id: closeIds.live }, select })) return
      await tx.workOrderClose.create({
        data: closeOf(closeIds.live, T.secondClose, 9_700, { code: 'LEATHER_YIELD', note: 'Two panels recut: the hide had a scar (made up).' }),
        select,
      })
      const variance = { companyId: companyA, siteId: siteA, workOrderId, closeId: closeIds.live, createdAt: T.secondClose, createdById: actorId }
      await tx.workOrderVariance.createMany({
        data: [
          {
            ...variance,
            id: varianceIds.usage,
            category: WorkOrderVarianceCategory.MATERIAL_USAGE,
            itemId: leather,
            standardQuantity: '93.6000',
            actualQuantity: '97.1000',
            standardUnitCost: '4.200000',
            actualUnitCost: '4.200000',
            amount: 400,
            note: 'Two panels recut.',
          },
          { ...variance, id: varianceIds.labour, category: WorkOrderVarianceCategory.LABOUR_EFFICIENCY, standardQuantity: '244.0000', actualQuantity: '250.0000', standardUnitCost: '0.250000', actualUnitCost: '0.250000', amount: 150 },
        ],
      })
      const closeEntry = { ...entryBase, occurredAt: T.secondClose, createdAt: T.secondClose }
      await tx.workOrderCostEntry.createMany({
        data: [
          { ...closeEntry, id: costEntryIds.usage, kind: WorkOrderCostKind.VARIANCE, itemId: leather, amount: -400, sourceType: 'WorkOrderVariance', sourceId: varianceIds.usage, idempotencyKey: `variance:${varianceIds.usage}` },
          { ...closeEntry, id: costEntryIds.labour, kind: WorkOrderCostKind.VARIANCE, amount: -150, sourceType: 'WorkOrderVariance', sourceId: varianceIds.labour, idempotencyKey: `variance:${varianceIds.labour}` },
        ],
      })
      // What is left after the variances: 600 − 400 − 150 = 50.
      await tx.workOrderCostEntry.create({
        data: { ...closeEntry, id: costEntryIds.close, kind: WorkOrderCostKind.CLOSE, amount: -50, sourceType: 'WorkOrderClose', sourceId: closeIds.live, idempotencyKey: `close:${closeIds.live}` },
        select,
      })
      await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.CLOSED, closedAt: T.secondClose, updatedAt: T.secondClose, version: { increment: 1 } }, select })
    }),
  )

  // --- the purchase price variance at P2's invoice -------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.purchasePriceVariance.findUnique({ where: { id: ppvId }, select })) return
      await tx.purchasePriceVariance.create({
        data: {
          id: ppvId,
          companyId: companyA,
          partyId: P2,
          at: PurchasePriceVarianceAt.INVOICE,
          supplierInvoiceLineId: accounting.supplierLineIds.leather,
          itemId: leather,
          quantity: '105.0000',
          standardUnitCost: '4.200000',
          standardCostId: accounting.standardCostIds.leather,
          paidUnitCost: '4.300000',
          differenceAmount: 1_050,
          currency: 'EUR',
          postedAt: T.ppv,
          idempotencyKey: `ppv:invoice-line:${accounting.supplierLineIds.leather}`,
          createdAt: T.ppv,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  // --- cost of goods sold of SEED-SH-0001 ----------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.costOfSalesEntry.findUnique({ where: { id: cogsIds.black }, select })) return
      const base = { companyId: companyA, partyId: P1, siteId: siteA, quantity: '1.0000', currency: 'EUR', createdById: actorId }
      await tx.costOfSalesEntry.create({
        data: { ...base, id: cogsIds.black, shipmentLineId: blackLine, materialAmount: 9_800, labourAmount: 4_300, overheadAmount: 700, amount: 14_800, postedAt: T.shipped, idempotencyKey: `cogs:shipment-line:${blackLine}`, createdAt: T.shipped },
        select,
      })
      await tx.costOfSalesEntry.create({
        data: { ...base, id: cogsIds.red, shipmentLineId: redLine, materialAmount: 9_600, labourAmount: 4_200, overheadAmount: 700, amount: 14_500, postedAt: T.shipped, idempotencyKey: `cogs:shipment-line:${redLine}`, createdAt: T.shipped },
        select,
      })
      await tx.costOfSalesEntry.create({
        data: {
          ...base,
          id: cogsIds.redReversal,
          shipmentLineId: redLine,
          quantity: '-1.0000',
          materialAmount: -9_600,
          labourAmount: -4_200,
          overheadAmount: -700,
          amount: -14_500,
          postedAt: T.revalued,
          reversalOfId: cogsIds.red,
          reason: "Valued at the red leather lot's old cost; the lot's cost was corrected (made up).",
          idempotencyKey: `cogs:reversal:${cogsIds.red}`,
          createdAt: T.revalued,
        },
        select,
      })
      await tx.costOfSalesEntry.create({
        data: { ...base, id: cogsIds.redAgain, shipmentLineId: redLine, materialAmount: 9_750, labourAmount: 4_200, overheadAmount: 700, amount: 14_650, postedAt: T.revalued, idempotencyKey: `cogs:shipment-line:${redLine}:2`, createdAt: T.revalued },
        select,
      })
    }),
  )

  // --- P2's freight landed on the leather lot ------------------------------------------------------------------------------
  const lotKey = { siteId: siteA, itemId: leather, lotId: inventory.leatherLotId }
  const freight = accounting.supplierLineIds.freight
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.landedCostAllocation.findUnique({ where: { id: landedIds.reversed }, select })) return
      const allocation = { companyId: companyA, partyId: P2, supplierInvoiceLineId: freight, amount: 1_500, currency: 'EUR', createdById: actorId }
      await tx.landedCostAllocation.create({
        data: { ...allocation, id: landedIds.reversed, basis: LandedCostBasis.VALUE, createdAt: T.landedPosted, updatedAt: T.landedPosted },
        select,
      })
      await tx.landedCostShare.create({
        data: { ...lotKey, id: landedIds.reversedShare, allocationId: landedIds.reversed, key: `share:${landedIds.reversed}:${inventory.leatherLotId}`, basisAmount: '44100.0000', amount: 1_500, createdAt: T.landedPosted, updatedAt: T.landedPosted, createdById: actorId },
        select,
      })
      await tx.landedCostAllocation.update({
        where: { id: landedIds.reversed },
        data: { status: LandedCostStatus.POSTED, postedAt: T.landedPosted, postedById: actorId, updatedAt: T.landedPosted, version: { increment: 1 } },
        select,
      })
      await tx.landedCostAllocation.update({
        where: { id: landedIds.reversed },
        data: {
          status: LandedCostStatus.REVERSED,
          reversedAt: T.landedReversed,
          reversedById: actorId,
          reverseReason: 'Freight goes onto the lots by quantity, as the accountant asked (made up).',
          updatedAt: T.landedReversed,
          version: { increment: 1 },
        },
        select,
      })
      await tx.landedCostAllocation.create({
        data: { ...allocation, id: landedIds.draft, basis: LandedCostBasis.QUANTITY, note: 'By quantity: 105 ft² on one lot.', createdAt: T.landedDraft, updatedAt: T.landedDraft },
        select,
      })
      await tx.landedCostShare.create({
        data: { ...lotKey, id: landedIds.draftShare, allocationId: landedIds.draft, key: `share:${landedIds.draft}:${inventory.leatherLotId}`, basisAmount: '105.0000', amount: 1_500, createdAt: T.landedDraft, updatedAt: T.landedDraft, createdById: actorId },
        select,
      })
    }),
  )

  return { accounting, settingsIds, workOrderId, closeIds, varianceIds, costEntryIds, ppvId, cogsIds, landedIds }
}
