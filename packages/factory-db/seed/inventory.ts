import type { Prisma } from '../src/generated/prisma/client'
import {
  CrViEvidence,
  CrViStatus,
  GoodsReceiptStatus,
  LocationKind,
  LotQualityStatus,
  PurchaseOrderStatus,
  StockMoveReason,
  StockValuationMethod,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedSupply, type SupplySeed } from './supply'

/**
 * The inventory seed, per tenant of seed/_core.ts: the golden flow's stages 09a-receive, 09b-cr6 and 11a-issue for the
 * supply seed's PO1, written in the tenant's office scope, as the app does (the CLI runs this file before
 * seed/supply.ts, so it runs that seed first).
 *
 *   locations  site A1: goods-in dock, quarantine shelf, the store with its bin A1-STORE-01, the cutting room's rack;
 *              site B1: its store.
 *   opening    lot SEED-LOT-LIN-01 of grey lining (no test, RELEASED): 120 m of opening stock in A1-STORE-01, valued at
 *              the standard cost.
 *   R1         goods receipt SEED-GR-0001 against PO1's leather line: lot SEED-LOT-LEA-01 (one dye batch) in QUARANTINE
 *              with hides SEED-HIDE-0001 (53.2 ft²) and SEED-HIDE-0002 (51.8 ft²) into A1-STORE-01, POSTED and valued at
 *              the order's price; PO1 becomes PARTLY_RECEIVED.
 *   Cr VI      the lot's lab report: 1.2 mg/kg, below the 3 mg/kg limit: PASS, and the lot is RELEASED.
 *   issue      hide SEED-HIDE-0001, whole, issued to the made-up work order SEED-WO-0001 (the production schema brings
 *              work orders), valued at the lot's cost.
 *   R2         goods receipt SEED-GR-0002, OPEN: PO1's 24 protectors at the dock, not posted yet.
 *
 * The generated isolation tests copy the FIRST row of each table by id and insert the copy: an OPEN receipt's line can
 * be copied, a posted one's cannot; a copied OPENING move only adds stock, a copied ISSUE could take a location below
 * zero. So R2's rows and the opening move get ids that start with eight zeros (still derived from the namespace).
 *
 * Every name, number and value is invented. Idempotent: each step runs in one transaction and is skipped once done
 * (moves and valuations are append-only, a posted receipt never changes, a released lot is not released again).
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-10-01T07:00:00.000Z'),
  opening: new Date('2026-10-01T08:00:00.000Z'),
  received: new Date('2026-11-12T09:00:00.000Z'),
  posted: new Date('2026-11-12T10:00:00.000Z'),
  released: new Date('2026-11-14T15:00:00.000Z'),
  issued: new Date('2026-11-16T07:30:00.000Z'),
  docked: new Date('2026-11-17T09:00:00.000Z'),
} as const
const DAY = { ddt: new Date('2026-11-11T00:00:00.000Z'), tested: new Date('2026-11-13T00:00:00.000Z'), ddt2: new Date('2026-11-16T00:00:00.000Z') } as const

/** The hides of R1: tag, the tannery's number, measured area in ft² (the base unit), grade and thickness. */
const HIDES = [
  { key: 'H1', code: 'SEED-HIDE-0001', supplierCode: 'T-58101', area: '53.2000', grade: 'A', thicknessMm: '1.20', defects: null },
  { key: 'H2', code: 'SEED-HIDE-0002', supplierCode: 'T-58102', area: '51.8000', grade: 'B', thicknessMm: '1.25', defects: 'Small scar near the neck edge.' },
] as const

export interface InventorySeed {
  readonly supply: SupplySeed
  readonly locations: { readonly dock: string; readonly quarantine: string; readonly store: string; readonly bin: string; readonly cutting: string }
  /** The opening-stock lining lot and its move. */
  readonly liningLotId: string
  readonly openingMoveId: string
  /** R1: the posted receipt, its leather line and lot, and the hides. */
  readonly receiptId: string
  readonly receiptLineId: string
  readonly leatherLotId: string
  readonly hideIds: readonly [string, string]
  /** The issue of the first hide. */
  readonly issueMoveId: string
  /** R2: the open receipt and its line. */
  readonly openReceiptId: string
  readonly openReceiptLineId: string
}

export async function seed(context: SeedContext): Promise<InventorySeed> {
  const { db, namespace } = context
  const supply = await seedSupply(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const colour = { leatherBLK: id('product:item-colour:leather:BLK'), liningGRY: id('product:item-colour:lining:GRY') }
  const stamp = (at: Date) => ({ createdAt: at, createdById: actorId })

  const location = {
    dock: id('inventory:location:A1-RCV'),
    quarantine: id('inventory:location:A1-QUA'),
    store: id('inventory:location:A1-STORE'),
    bin: id('inventory:location:A1-STORE-01'),
    cutting: id('inventory:location:A1-CUT'),
    storeB: id('inventory:location:B1-STORE'),
  }
  const locations: (Prisma.LocationUncheckedCreateInput & { id: string })[] = [
    { id: location.dock, companyId: companyA, siteId: siteA, code: 'A1-RCV', name: 'Goods-in dock', kind: LocationKind.RECEIVING },
    { id: location.quarantine, companyId: companyA, siteId: siteA, code: 'A1-QUA', name: 'Quality hold shelf', kind: LocationKind.QUARANTINE },
    { id: location.store, companyId: companyA, siteId: siteA, code: 'A1-STORE', name: 'Materials store', kind: LocationKind.WAREHOUSE },
    { id: location.bin, companyId: companyA, siteId: siteA, parentId: location.store, code: 'A1-STORE-01', name: 'Leather rack 1', kind: LocationKind.BIN },
    { id: location.cutting, companyId: companyA, siteId: siteA, code: 'A1-CUT', name: 'Cutting room rack', kind: LocationKind.PRODUCTION },
    { id: location.storeB, companyId: companyB, siteId: siteB, code: 'B1-STORE', name: 'Materials store', kind: LocationKind.WAREHOUSE },
  ].map((row) => ({ ...row, ...stamp(T.setup), updatedAt: T.setup }))

  const opening = { lot: id('inventory:lot:LIN-01'), move: firstId('inventory:move:opening:LIN-01'), value: id('inventory:value:opening:LIN-01') }
  const r1 = {
    receipt: id('inventory:receipt:R1'),
    line: id('inventory:receipt:R1:10'),
    lot: id('inventory:lot:LEA-01'),
    hides: [id('inventory:hide:H1'), id('inventory:hide:H2')] as const,
    moves: [id('inventory:move:R1:H1'), id('inventory:move:R1:H2')] as const,
    values: [id('inventory:value:R1:H1'), id('inventory:value:R1:H2')] as const,
  }
  const issue = { move: id('inventory:move:issue:H1'), value: id('inventory:value:issue:H1'), workOrderId: id('production:work-order:WO-0001') }
  const r2 = { receipt: firstId('inventory:receipt:R2'), line: firstId('inventory:receipt:R2:10') }
  const office = { audience: 'office' as const, tenantId, actorId }

  // Locations: upserted (the parent first).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: rowId, ...data } of locations) await tx.location.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })
    }),
  )

  // Opening stock: the lining lot, its move and value (once).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.lot.findUnique({ where: { id: opening.lot }, select: { id: true } })) return
      await tx.lot.create({
        data: {
          id: opening.lot,
          companyId: companyA,
          siteId: siteA,
          itemId: item.lining,
          itemColourId: colour.liningGRY,
          code: 'SEED-LOT-LIN-01',
          supplierLotRef: 'M-ROLLS-0925',
          receivedAt: T.opening,
          qualityStatus: LotQualityStatus.RELEASED,
          qualityNote: 'Opening stock, counted on the first day.',
          qualityDecidedAt: T.opening,
          qualityDecidedById: actorId,
          ...stamp(T.opening),
          updatedAt: T.opening,
        },
        select: { id: true },
      })
      await tx.stockMove.create({
        data: {
          id: opening.move,
          companyId: companyA,
          siteId: siteA,
          reason: StockMoveReason.OPENING,
          itemId: item.lining,
          itemColourId: colour.liningGRY,
          lotId: opening.lot,
          toLocationId: location.bin,
          quantity: '120.0000',
          uom: Uom.M,
          baseQuantity: '120.0000',
          reference: 'Opening count',
          idempotencyKey: 'seed-opening-LIN-01',
          occurredAt: T.opening,
          ...stamp(T.opening),
        },
        select: { id: true },
      })
      await tx.stockValuation.create({
        data: {
          id: opening.value,
          companyId: companyA,
          siteId: siteA,
          moveId: opening.move,
          itemId: item.lining,
          lotId: opening.lot,
          quantity: '120.0000',
          unitCost: '3.100000',
          valueAmount: 37_200,
          method: StockValuationMethod.STANDARD_COST,
          idempotencyKey: `move:${opening.move}`,
          ...stamp(T.opening),
        },
        select: { id: true },
      })
    }),
  )

  // R1: received into quarantine, posted and valued, in one go (once).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.goodsReceipt.findUnique({ where: { id: r1.receipt }, select: { id: true } })) return
      await tx.goodsReceipt.create({
        data: {
          id: r1.receipt,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-GR-0001',
          supplierId: supply.supplierId,
          purchaseOrderId: supply.purchaseOrderId,
          supplierDdtNumber: 'SEED-DDT-77',
          supplierDdtDate: DAY.ddt,
          receivedAt: T.received,
          note: 'First part of the leather: two hides.',
          ...stamp(T.received),
          updatedAt: T.received,
        },
        select: { id: true },
      })
      await tx.goodsReceiptLine.create({
        data: {
          id: r1.line,
          siteId: siteA,
          receiptId: r1.receipt,
          seq: 10,
          purchaseOrderLineId: supply.leatherLineId,
          itemId: item.leather,
          itemColourId: colour.leatherBLK,
          quantity: '105.0000',
          uom: Uom.FT2,
          baseQuantity: '105.0000',
          hideCount: 2,
          ...stamp(T.received),
          updatedAt: T.received,
        },
        select: { id: true },
      })
      await tx.lot.create({
        data: {
          id: r1.lot,
          companyId: companyA,
          siteId: siteA,
          itemId: item.leather,
          itemColourId: colour.leatherBLK,
          code: 'SEED-LOT-LEA-01',
          supplierId: supply.supplierId,
          supplierLotRef: 'SEED-TAN-0001',
          dyeBatch: 'SEED-DB-01',
          shade: 'Black 01',
          receiptLineId: r1.line,
          receivedAt: T.received,
          requiresCrViTest: true,
          crViLimitMgKg: '3.000',
          crViStatus: CrViStatus.PENDING,
          ...stamp(T.received),
          updatedAt: T.received,
        },
        select: { id: true },
      })
      await tx.hide.createMany({
        data: HIDES.map((hide, index) => ({
          id: r1.hides[index] as string,
          siteId: siteA,
          lotId: r1.lot,
          itemId: item.leather,
          code: hide.code,
          supplierCode: hide.supplierCode,
          area: hide.area,
          areaUom: Uom.FT2,
          baseArea: hide.area,
          grade: hide.grade,
          shade: 'Black 01',
          thicknessMm: hide.thicknessMm,
          defects: hide.defects,
          ...stamp(T.received),
          updatedAt: T.received,
        })),
      })
      await tx.stockMove.createMany({
        data: HIDES.map((hide, index) => ({
          id: r1.moves[index] as string,
          companyId: companyA,
          siteId: siteA,
          reason: StockMoveReason.RECEIPT,
          itemId: item.leather,
          itemColourId: colour.leatherBLK,
          lotId: r1.lot,
          hideId: r1.hides[index] as string,
          toLocationId: location.bin,
          quantity: hide.area,
          uom: Uom.FT2,
          baseQuantity: hide.area,
          receiptLineId: r1.line,
          reference: 'SEED-DDT-77',
          idempotencyKey: `seed-receipt-R1-${hide.key}`,
          occurredAt: T.received,
          ...stamp(T.received),
        })),
      })
      // Valued at PO1's price, 4.20 a ft²: 53.2 ft² = 223.44, 51.8 ft² = 217.56.
      await tx.stockValuation.createMany({
        data: HIDES.map((hide, index) => ({
          id: r1.values[index] as string,
          companyId: companyA,
          siteId: siteA,
          moveId: r1.moves[index] as string,
          itemId: item.leather,
          lotId: r1.lot,
          quantity: hide.area,
          unitCost: '4.200000',
          valueAmount: index === 0 ? 22_344 : 21_756,
          method: StockValuationMethod.PURCHASE_PRICE,
          idempotencyKey: `move:${r1.moves[index] as string}`,
          ...stamp(T.posted),
        })),
      })
      await tx.goodsReceipt.update({
        where: { id: r1.receipt },
        data: { status: GoodsReceiptStatus.POSTED, postedAt: T.posted, postedById: actorId, updatedAt: T.posted, version: 2 },
        select: { id: true },
      })
      const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: supply.purchaseOrderId }, select: { status: true, version: true } })
      if (order.status === PurchaseOrderStatus.CONFIRMED) {
        await tx.purchaseOrder.update({
          where: { id: supply.purchaseOrderId },
          data: { status: PurchaseOrderStatus.PARTLY_RECEIVED, version: order.version + 1, updatedAt: T.posted },
          select: { id: true },
        })
      }
    }),
  )

  // Cr VI: the lab report passes and the lot is released (once).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const lot = await tx.lot.findUniqueOrThrow({ where: { id: r1.lot }, select: { qualityStatus: true, version: true } })
      if (lot.qualityStatus !== LotQualityStatus.QUARANTINE) return
      await tx.lot.update({
        where: { id: r1.lot },
        data: {
          crViStatus: CrViStatus.PASS,
          crViMgKg: '1.200',
          crViEvidence: CrViEvidence.LOT_REPORT,
          crViTestedAt: DAY.tested,
          qualityStatus: LotQualityStatus.RELEASED,
          qualityNote: 'Cr VI 1.2 mg/kg on the lab report of this lot, below the 3 mg/kg limit.',
          qualityDecidedAt: T.released,
          qualityDecidedById: actorId,
          version: lot.version + 1,
          updatedAt: T.released,
        },
        select: { id: true },
      })
    }),
  )

  // The first hide, whole, issued to a work order and valued at the lot's cost (once).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.stockMove.findUnique({ where: { id: issue.move }, select: { id: true } })) return
      await tx.stockMove.create({
        data: {
          id: issue.move,
          companyId: companyA,
          siteId: siteA,
          reason: StockMoveReason.ISSUE,
          itemId: item.leather,
          itemColourId: colour.leatherBLK,
          lotId: r1.lot,
          hideId: r1.hides[0],
          fromLocationId: location.bin,
          quantity: HIDES[0].area,
          uom: Uom.FT2,
          baseQuantity: HIDES[0].area,
          workOrderId: issue.workOrderId,
          reference: 'SEED-WO-0001',
          idempotencyKey: 'seed-issue-H1',
          occurredAt: T.issued,
          ...stamp(T.issued),
        },
        select: { id: true },
      })
      await tx.stockValuation.create({
        data: {
          id: issue.value,
          companyId: companyA,
          siteId: siteA,
          moveId: issue.move,
          itemId: item.leather,
          lotId: r1.lot,
          quantity: `-${HIDES[0].area}`,
          unitCost: '4.200000',
          valueAmount: -22_344,
          method: StockValuationMethod.LOT_COST,
          idempotencyKey: `move:${issue.move}`,
          ...stamp(T.issued),
        },
        select: { id: true },
      })
    }),
  )

  // R2: the protectors at the dock, still OPEN (once).
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.goodsReceipt.findUnique({ where: { id: r2.receipt }, select: { id: true } })) return
      await tx.goodsReceipt.create({
        data: {
          id: r2.receipt,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-GR-0002',
          supplierId: supply.supplierId,
          purchaseOrderId: supply.purchaseOrderId,
          supplierDdtNumber: 'SEED-DDT-81',
          supplierDdtDate: DAY.ddt2,
          receivedAt: T.docked,
          note: 'Protectors at the dock; batch label to check.',
          ...stamp(T.docked),
          updatedAt: T.docked,
        },
        select: { id: true },
      })
      await tx.goodsReceiptLine.create({
        data: {
          id: r2.line,
          siteId: siteA,
          receiptId: r2.receipt,
          seq: 10,
          purchaseOrderLineId: supply.protectorLineId,
          itemId: item.protector,
          quantity: '24.0000',
          uom: Uom.PCS,
          baseQuantity: '24.0000',
          ...stamp(T.docked),
          updatedAt: T.docked,
        },
        select: { id: true },
      })
    }),
  )

  return {
    supply,
    locations: { dock: location.dock, quarantine: location.quarantine, store: location.store, bin: location.bin, cutting: location.cutting },
    liningLotId: opening.lot,
    openingMoveId: opening.move,
    receiptId: r1.receipt,
    receiptLineId: r1.line,
    leatherLotId: r1.lot,
    hideIds: r1.hides,
    issueMoveId: issue.move,
    openReceiptId: r2.receipt,
    openReceiptLineId: r2.line,
  }
}
