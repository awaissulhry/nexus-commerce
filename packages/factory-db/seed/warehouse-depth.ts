import type { Prisma } from '../src/generated/prisma/client'
import {
  CountAbcClass,
  DdtReason,
  DefaultLocationPurpose,
  GoodsReceiptKind,
  ItemKind,
  ItemSourcing,
  ItemTracking,
  LocationBlockReason,
  LocationKind,
  LotQualityStatus,
  MaterialSubstitutionStatus,
  StockCountKind,
  StockCountLineOrigin,
  StockCountPass,
  StockCountStatus,
  StockMoveReason,
  StockValuationMethod,
  TransferStatus,
  TransportBy,
  Uom,
  WarehouseTaskKind,
  WarehouseTaskStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedLeather } from './leather'
import { seed as seedNumbering } from './numbering'
import { seed as seedPlanning } from './planning'
import { seed as seedProduction } from './production'

/**
 * The warehouse in depth seed (W2b-5, schema wave 36/44, B-W2b-277), per tenant of seed/_core.ts, written in the tenant's
 * office scope as the app does. The CLI runs the seed files in name order (this one is last); it runs the production,
 * planning, leather, numbering and auth seeds first (the sites, locations, workers and tablet, the work orders and their lining,
 * the DDT series), all idempotent. No stock of the golden flows' materials moves: the warehouse has a lining of its own.
 *
 *   places       at plant A1: the transit place to B1 (TRANSIT), a pick face and a bulk rack with their bin labels, the count
 *                bay, the holding place for goods without a PO, a damaged rack (blocked), a customer's stock at P1 (CUSTOMER).
 *   material     a lining of its own, SEED-LIN-W36 (by lot, in metres), lot SEED-LOT-W36-01 with its attributes (width,
 *                weight, origin), released, 100 m into the bulk rack and 10 m into the count bay (opening stock, valued at its
 *                standard cost), and a child lot SEED-LOT-W36-01A split from it (no stock); a second lot of the jacket's grey
 *                lining, SEED-LOT-LIN-W36 (released, no stock), the substitute below.
 *   defaults     A1: an old receiving default for linings (inactive: the first row), receiving and return for every kind,
 *                quality, issue of leather to the cutting room, put-away of linings into the bulk rack; B1: receiving.
 *   transfers    A1 → B1 (company A to company B): SEED-TRF-0001 DRAFT, 20 m (the first row and line); SEED-TRF-0002 SHIPPED,
 *                30 m on the transit place with its DDT (company A's DDT series, a made-up number); SEED-TRF-0003 CANCELLED.
 *   schedules    leather rack monthly, class A trims weekly, a retired one.
 *   count        SEED-CNT-W36-01 of the count bay, COUNTING and freezing moves: the lot's 10 m frozen and not counted yet (a
 *                roll of 5 m scanned), and the child lot's 2 m found where nothing was expected (an ADDED line: the first row;
 *                its COUNT scan on the cutting tablet by the operator: the first scan).
 *   settings     the tenant's warehouse rules (7 days back, both separations on, low-stock alerts on) and company A's (3 days,
 *                adjustments above 500.00 € wait for a yes).
 *   tasks        A1: a put-away OPEN for the warehouse workers (the first row), a move TAKEN by the operator, a count DONE, a
 *                pick CANCELLED.
 *   substitutes  on WO-0001's grey lining, another lot (SEED-LOT-LIN-W36): asked on the floor, WAITING (the first row); asked
 *                in the office and APPROVED by another person; asked on the floor and REFUSED.
 *   no PO        SEED-GR-W36-01, goods nobody ordered from P2, OPEN in the holding place, with its line and the buyer's task.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat; the count's
 * ADDED line starts with twelve zeros, before W2a's snapshot line of SEED-CNT-0001 (a floor session adds only ADDED lines).
 *
 * Every place, number, quantity, date and price is made up. Idempotent: written once, skipped when the first transfer exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (every one before the day the wave was built). */
const T = {
  setup: new Date('2026-11-03T08:00:00.000Z'),
  opened: new Date('2026-11-03T09:00:00.000Z'),
  drafted: new Date('2026-11-04T08:00:00.000Z'),
  shipped: new Date('2026-11-04T10:00:00.000Z'),
  arrived: new Date('2026-11-05T07:30:00.000Z'),
  countStarted: new Date('2026-11-05T08:00:00.000Z'),
  scanned: new Date('2026-11-05T08:20:00.000Z'),
  taken: new Date('2026-11-05T09:00:00.000Z'),
  done: new Date('2026-11-05T09:30:00.000Z'),
  asked: new Date('2026-11-06T08:00:00.000Z'),
  decided: new Date('2026-11-06T09:00:00.000Z'),
  blocked: new Date('2026-11-06T10:00:00.000Z'),
} as const
const DAY = {
  ship: new Date('2026-11-04T00:00:00.000Z'),
  expected: new Date('2026-11-06T00:00:00.000Z'),
  later: new Date('2026-11-12T00:00:00.000Z'),
  dueMonthly: new Date('2026-12-01T00:00:00.000Z'),
  dueWeekly: new Date('2026-11-16T00:00:00.000Z'),
  lastWeekly: new Date('2026-11-09T00:00:00.000Z'),
  taskDue: new Date('2026-11-12T16:00:00.000Z'),
} as const

export interface WarehouseDepthSeed {
  readonly itemId: string
  readonly lotId: string
  readonly childLotId: string
  readonly substituteLotId: string
  readonly locations: {
    readonly transit: string
    readonly pickFace: string
    readonly bulk: string
    readonly countBay: string
    readonly holding: string
    readonly damaged: string
    readonly customer: string
  }
  readonly transferIds: { readonly draft: string; readonly shipped: string; readonly cancelled: string }
  readonly transferLineIds: { readonly draft: string; readonly shipped: string; readonly cancelled: string }
  readonly shipMoveId: string
  readonly countId: string
  readonly countLineIds: { readonly added: string; readonly frozen: string }
  readonly scanIds: readonly [string, string]
  readonly settingsIds: { readonly tenant: string; readonly companyA: string }
  readonly defaultIds: { readonly old: string; readonly receiving: string; readonly putAway: string }
  readonly scheduleIds: { readonly monthly: string; readonly weekly: string; readonly retired: string }
  readonly taskIds: { readonly open: string; readonly taken: string; readonly done: string; readonly cancelled: string }
  readonly substitutionIds: { readonly waiting: string; readonly approved: string; readonly refused: string }
  readonly unplannedReceiptId: string
  readonly buyerTaskId: string
  readonly workOrderId: string
  readonly workerId: string
  readonly deviceId: string
}

export async function seed(context: SeedContext): Promise<WarehouseDepthSeed> {
  const { db, namespace } = context
  const production = await seedProduction(context)
  await seedPlanning(context)
  await seedLeather(context)
  await seedNumbering(context)
  // The office user who decides a substitute and owns the buyer's task.
  await seedAuth(context)
  const inventory = production.inventory
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  /** Before W2a's first count line (eight zeros too): twelve zeros. */
  const veryFirstId = (key: string): string => `00000000-0000${id(key).slice(13)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const P1 = id('party:P1')
  const P2 = id('party:P2')
  const liningItem = id('product:item:lining')
  const liningGrey = id('product:item-colour:lining:GRY')
  const office = { audience: 'office', tenantId, actorId } as const
  const select = { id: true } as const
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const operator = production.operatorId
  const tablet = production.deviceId

  const result: WarehouseDepthSeed = {
    itemId: id('warehouse:item:LIN-W36'),
    lotId: id('warehouse:lot:W36-01'),
    childLotId: id('warehouse:lot:W36-01A'),
    substituteLotId: id('warehouse:lot:LIN-W36'),
    locations: {
      transit: id('warehouse:location:A1-TRANSIT-B1'),
      pickFace: id('warehouse:location:A1-PF-01'),
      bulk: id('warehouse:location:A1-BULK-01'),
      countBay: id('warehouse:location:A1-CNT-01'),
      holding: id('warehouse:location:A1-HOLD'),
      damaged: id('warehouse:location:A1-DMG-01'),
      customer: id('warehouse:location:A1-CUST-P1'),
    },
    transferIds: { draft: firstId('warehouse:transfer:0001'), shipped: id('warehouse:transfer:0002'), cancelled: id('warehouse:transfer:0003') },
    transferLineIds: { draft: firstId('warehouse:transfer:0001:10'), shipped: id('warehouse:transfer:0002:10'), cancelled: id('warehouse:transfer:0003:10') },
    shipMoveId: id('warehouse:move:ship:0002'),
    countId: id('warehouse:count:W36-01'),
    countLineIds: { added: veryFirstId('warehouse:count:W36-01:30'), frozen: id('warehouse:count:W36-01:10') },
    scanIds: [firstId('warehouse:scan:W36-01:30:1'), id('warehouse:scan:W36-01:10:1')],
    settingsIds: { tenant: tenantId, companyA },
    defaultIds: { old: firstId('warehouse:default:A1:RECEIVING:LINING:old'), receiving: id('warehouse:default:A1:RECEIVING'), putAway: id('warehouse:default:A1:PUT_AWAY:LINING') },
    scheduleIds: { monthly: firstId('warehouse:schedule:A1:leather'), weekly: id('warehouse:schedule:A1:trims'), retired: id('warehouse:schedule:A1:retired') },
    taskIds: { open: firstId('warehouse:task:A1:put-away'), taken: id('warehouse:task:A1:move'), done: id('warehouse:task:A1:count'), cancelled: id('warehouse:task:A1:pick') },
    substitutionIds: { waiting: firstId('warehouse:substitution:WO-0001:1'), approved: id('warehouse:substitution:WO-0001:2'), refused: id('warehouse:substitution:WO-0001:3') },
    unplannedReceiptId: id('warehouse:receipt:W36-01'),
    buyerTaskId: id('warehouse:task:buyer:W36-01'),
    workOrderId: production.workOrderId,
    workerId: operator,
    deviceId: tablet,
  }
  const L = result.locations

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.transferOrder.findUnique({ where: { id: result.transferIds.draft }, select })) return
      const ddtSeries = await tx.numberSeries.findFirst({ where: { companyId: companyA, kind: 'DDT' }, orderBy: { scopeKey: 'desc' }, select })
      if (!ddtSeries) throw new Error('warehouse seed: company A has no DDT series (seed/numbering.ts)')
      const liningLine = await tx.bomLine.findFirst({ where: { revisionId: production.revisionId, itemId: liningItem }, select })
      if (!liningLine) throw new Error('warehouse seed: WO-0001 has no grey lining line (seed/product.ts)')
      const floorRole = await tx.role.findFirst({ where: { audience: 'FLOOR' }, orderBy: { key: 'asc' }, select })

      // --- places ----------------------------------------------------------------------------------------------------------
      const place = (key: keyof typeof L, code: string, name: string, kind: LocationKind, more: Partial<Prisma.LocationCreateManyInput> = {}): Prisma.LocationCreateManyInput => ({
        id: L[key],
        companyId: companyA,
        siteId: siteA,
        code,
        name,
        kind,
        ...stamp(T.setup),
        ...more,
      })
      await tx.location.createMany({
        data: [
          place('transit', 'A1-TRANSIT-B1', 'In transit to plant B1', LocationKind.TRANSIT),
          place('pickFace', 'A1-PF-01', 'Pick face, linings', LocationKind.PICK_FACE, { parentId: inventory.locations.store, labelCode: 'BIN-A1-PF-01' }),
          place('bulk', 'A1-BULK-01', 'Bulk rack, linings', LocationKind.BULK, { parentId: inventory.locations.store, labelCode: 'BIN-A1-BULK-01' }),
          place('countBay', 'A1-CNT-01', 'Count bay', LocationKind.BIN, { parentId: inventory.locations.store, labelCode: 'BIN-A1-CNT-01' }),
          // A bin, not a second goods-in dock (W1's receipt routes take the site's one RECEIVING place when none is named).
          place('holding', 'A1-HOLD', 'Goods without a PO', LocationKind.BIN, { labelCode: 'BIN-A1-HOLD' }),
          place('damaged', 'A1-DMG-01', 'Rack 4 (damaged)', LocationKind.BIN, { parentId: inventory.locations.store, labelCode: 'BIN-A1-DMG-01' }),
          place('customer', 'A1-CUST-P1', 'Fitting stock at P1', LocationKind.CUSTOMER, { partyId: P1 }),
        ],
      })
      // A damaged rack: blocked until the shelf is replaced.
      await tx.location.update({
        where: { id: L.damaged },
        data: { blockedAt: T.blocked, blockedById: actorId, blockReason: LocationBlockReason.DAMAGE, blockNote: 'Upright bent by a pallet truck (test).', blockedUntil: DAY.later, updatedAt: T.blocked },
        select,
      })

      // --- the material of its own, its lots and opening stock --------------------------------------------------------------
      await tx.item.create({
        data: {
          id: result.itemId,
          code: 'SEED-LIN-W36',
          name: 'Seed warehouse lining',
          kind: ItemKind.LINING,
          sourcing: ItemSourcing.BUY,
          tracking: ItemTracking.LOT,
          baseUom: Uom.M,
          purchaseUom: Uom.M,
          consumptionUom: Uom.M,
          ...stamp(T.setup),
        },
        select,
      })
      const released = { qualityStatus: LotQualityStatus.RELEASED, qualityDecidedAt: T.setup, qualityDecidedById: actorId }
      await tx.lot.create({
        data: { id: result.lotId, companyId: companyA, siteId: siteA, itemId: result.itemId, code: 'SEED-LOT-W36-01', supplierId: P2, supplierLotRef: 'W36-2026-11', ...released, attributes: { widthCm: '140', weightGsm: '85', origin: 'IT' }, ...stamp(T.setup) },
        select,
      })
      await tx.lot.create({
        data: { id: result.childLotId, companyId: companyA, siteId: siteA, itemId: result.itemId, code: 'SEED-LOT-W36-01A', supplierId: P2, parentLotId: result.lotId, ...released, attributes: { widthCm: '140' }, ...stamp(T.setup) },
        select,
      })
      await tx.lot.create({
        data: { id: result.substituteLotId, companyId: companyA, siteId: siteA, itemId: liningItem, itemColourId: liningGrey, code: 'SEED-LOT-LIN-W36', supplierId: P2, ...released, ...stamp(T.setup) },
        select,
      })
      const opening = [
        { key: 'bulk', location: L.bulk, quantity: '100.0000', value: 21_000 },
        { key: 'count-bay', location: L.countBay, quantity: '10.0000', value: 2_100 },
      ] as const
      for (const move of opening) {
        const moveId = id(`warehouse:move:opening:${move.key}`)
        await tx.stockMove.create({
          data: { id: moveId, companyId: companyA, siteId: siteA, reason: StockMoveReason.OPENING, itemId: result.itemId, lotId: result.lotId, toLocationId: move.location, quantity: move.quantity, uom: Uom.M, baseQuantity: move.quantity, reference: 'Opening stock (warehouse seed)', idempotencyKey: `seed-warehouse-opening-${move.key}`, occurredAt: T.opened, createdAt: T.opened, createdById: actorId },
          select,
        })
        // Stock into the site has its value (A1 §2.6): 2.10 € a metre, the standard cost.
        await tx.stockValuation.create({
          data: { id: id(`warehouse:valuation:opening:${move.key}`), companyId: companyA, siteId: siteA, moveId, itemId: result.itemId, lotId: result.lotId, quantity: move.quantity, unitCost: '2.100000', valueAmount: move.value, method: StockValuationMethod.STANDARD_COST, idempotencyKey: `move:${moveId}`, createdAt: T.opened, createdById: actorId },
          select,
        })
      }

      // --- defaults ----------------------------------------------------------------------------------------------------------
      const fallback = { companyId: companyA, siteId: siteA, ...stamp(T.setup) }
      await tx.defaultLocation.createMany({
        data: [
          { id: result.defaultIds.old, ...fallback, itemKind: ItemKind.LINING, purpose: DefaultLocationPurpose.RECEIVING, locationId: inventory.locations.dock, active: false },
          { id: result.defaultIds.receiving, ...fallback, purpose: DefaultLocationPurpose.RECEIVING, locationId: inventory.locations.dock },
          { id: id('warehouse:default:A1:QUALITY'), ...fallback, purpose: DefaultLocationPurpose.QUALITY, locationId: inventory.locations.quarantine },
          { id: id('warehouse:default:A1:ISSUE:LEATHER'), ...fallback, itemKind: ItemKind.LEATHER, purpose: DefaultLocationPurpose.ISSUE, locationId: inventory.locations.cutting },
          { id: id('warehouse:default:A1:RETURN'), ...fallback, purpose: DefaultLocationPurpose.RETURN, locationId: inventory.locations.bin },
          { id: result.defaultIds.putAway, ...fallback, itemKind: ItemKind.LINING, purpose: DefaultLocationPurpose.PUT_AWAY, locationId: L.bulk },
          { id: id('warehouse:default:B1:RECEIVING'), companyId: companyB, siteId: siteB, purpose: DefaultLocationPurpose.RECEIVING, locationId: id('inventory:location:B1-STORE'), ...stamp(T.setup) },
        ],
      })

      // --- transfers A1 → B1 ---------------------------------------------------------------------------------------------------
      const route = { companyId: companyA, fromSiteId: siteA, toCompanyId: companyB, toSiteId: siteB, transitLocationId: L.transit, fromLocationId: L.bulk, toLocationId: id('inventory:location:B1-STORE') }
      const lineOf = (transferId: string, lineId: string, quantity: string) => ({
        id: lineId,
        transferId,
        fromSiteId: siteA,
        toSiteId: siteB,
        seq: 10,
        itemId: result.itemId,
        lotId: result.lotId,
        quantity,
        uom: Uom.M,
        baseQuantity: quantity,
        ...stamp(T.drafted),
      })
      await tx.transferOrder.createMany({
        data: [
          { id: result.transferIds.draft, number: 'SEED-TRF-0001', ...route, shipOn: DAY.later, note: 'Lining for the second plant (test).', ...stamp(T.drafted) },
          { id: result.transferIds.shipped, number: 'SEED-TRF-0002', ...route, shipOn: DAY.ship, expectedOn: DAY.expected, ...stamp(T.drafted) },
          { id: result.transferIds.cancelled, number: 'SEED-TRF-0003', ...route, ...stamp(T.drafted) },
        ],
      })
      await tx.transferLine.createMany({
        data: [
          lineOf(result.transferIds.draft, result.transferLineIds.draft, '20.0000'),
          lineOf(result.transferIds.shipped, result.transferLineIds.shipped, '30.0000'),
          lineOf(result.transferIds.cancelled, result.transferLineIds.cancelled, '5.0000'),
        ],
      })
      // The ship of SEED-TRF-0002, in the order the command takes: the move onto the transit place, the line, the header.
      await tx.stockMove.create({
        data: { id: result.shipMoveId, companyId: companyA, siteId: siteA, reason: StockMoveReason.TRANSFER, itemId: result.itemId, lotId: result.lotId, fromLocationId: L.bulk, toLocationId: L.transit, quantity: '30.0000', uom: Uom.M, baseQuantity: '30.0000', transferLineId: result.transferLineIds.shipped, reference: 'SEED-TRF-0002', idempotencyKey: 'seed-warehouse-ship-0002', occurredAt: T.shipped, createdAt: T.shipped, createdById: actorId },
        select,
      })
      await tx.transferLine.update({ where: { id: result.transferLineIds.shipped }, data: { shippedQuantity: '30.0000', updatedAt: T.shipped }, select })
      await tx.transferOrder.update({
        where: { id: result.transferIds.shipped },
        data: {
          status: TransferStatus.SHIPPED,
          shippedAt: T.shipped,
          shippedById: actorId,
          ddtNumberSeriesId: ddtSeries.id,
          ddtNumber: 'SEED-DDT-TRF-0002',
          ddtDate: DAY.ship,
          ddtReason: DdtReason.TRANSFER,
          transportBy: TransportBy.CARRIER,
          carrier: { name: 'Seed Carrier (test)', vatNumber: 'IT00000000000' },
          packages: 2,
          grossWeightKg: '18.5000',
          appearance: 'Rolls in film',
          trackingRef: 'SEED-TRK-0002',
          trackingUrl: 'https://tracking.example.com/SEED-TRK-0002',
          updatedAt: T.shipped,
        },
        select,
      })
      await tx.transferOrder.update({ where: { id: result.transferIds.cancelled }, data: { status: TransferStatus.CANCELLED, cancelledAt: T.shipped, cancelReason: 'Made twice by mistake (test).', updatedAt: T.shipped }, select })

      // --- count schedules -------------------------------------------------------------------------------------------------------
      await tx.countSchedule.createMany({
        data: [
          { id: result.scheduleIds.monthly, companyId: companyA, siteId: siteA, name: 'Leather rack 1, monthly', locationId: inventory.locations.bin, everyDays: 30, nextDueOn: DAY.dueMonthly, ...stamp(T.setup) },
          { id: result.scheduleIds.weekly, companyId: companyA, siteId: siteA, name: 'Class A trims, weekly', abcClass: CountAbcClass.A, itemKind: ItemKind.TRIM, everyDays: 7, nextDueOn: DAY.dueWeekly, lastCountedOn: DAY.lastWeekly, ...stamp(T.setup) },
          { id: result.scheduleIds.retired, companyId: companyA, siteId: siteA, name: 'Old quarterly count', locationId: inventory.locations.store, everyDays: 91, nextDueOn: DAY.dueMonthly, active: false, note: 'Replaced by the monthly rack count (test).', ...stamp(T.setup) },
        ],
      })

      // --- a count of the count bay that freezes moves -----------------------------------------------------------------------------
      await tx.stockCount.create({
        data: { id: result.countId, companyId: companyA, siteId: siteA, number: 'SEED-CNT-W36-01', kind: StockCountKind.CYCLE, locationId: L.countBay, countTeam: 'Warehouse team A1', freezeMoves: true, status: StockCountStatus.COUNTING, startedAt: T.countStarted, snapshotAt: T.countStarted, note: 'Count bay, by scanning every roll (test).', ...stamp(T.countStarted) },
        select,
      })
      const countLine = { siteId: siteA, countId: result.countId, locationId: L.countBay, itemId: result.itemId, frozenAt: T.countStarted, createdAt: T.countStarted, createdById: actorId }
      await tx.stockCountLine.createMany({
        data: [
          { id: result.countLineIds.frozen, ...countLine, seq: 10, lotId: result.lotId, origin: StockCountLineOrigin.SNAPSHOT, expectedQuantity: '10.0000', updatedAt: T.countStarted },
          { id: result.countLineIds.added, ...countLine, seq: 30, lotId: result.childLotId, origin: StockCountLineOrigin.ADDED, expectedQuantity: '0.0000', countedQuantity: '2.0000', countedAt: T.scanned, updatedAt: T.scanned },
        ],
      })
      const byOperator = { siteId: siteA, countId: result.countId, pass: StockCountPass.COUNT, scannedAt: T.scanned, scannedByWorkerId: operator, deviceId: tablet, createdAt: T.scanned, createdById: operator }
      await tx.stockCountScan.createMany({
        data: [
          { id: result.scanIds[0], ...byOperator, lineId: result.countLineIds.added, code: 'SEED-LOT-W36-01A', quantity: '2.0000' },
          { id: result.scanIds[1], ...byOperator, lineId: result.countLineIds.frozen, code: 'SEED-LOT-W36-01', quantity: '5.0000' },
        ],
      })

      // --- the warehouse rules -------------------------------------------------------------------------------------------------------
      await tx.inventorySettings.createMany({
        data: [
          { id: result.settingsIds.tenant, backDatingDays: 7, receiverNotMatcher: true, counterNotApprover: true, lowStockAlerts: true, ...stamp(T.setup), updatedById: actorId },
          { id: result.settingsIds.companyA, companyId: companyA, backDatingDays: 3, adjustmentApprovalAmount: 50_000, ...stamp(T.setup), updatedById: actorId },
        ],
      })

      // --- the task inbox at A1 ----------------------------------------------------------------------------------------------------------
      const task = { companyId: companyA, siteId: siteA, itemId: result.itemId, lotId: result.lotId, quantity: '10.0000', uom: Uom.M, ...stamp(T.arrived) }
      await tx.warehouseTask.createMany({
        data: [
          { id: result.taskIds.open, ...task, kind: WarehouseTaskKind.PUT_AWAY, sourceType: 'GoodsReceipt', sourceId: inventory.receiptId, fromLocationId: inventory.locations.dock, toLocationId: L.bulk, assignedRoleId: floorRole?.id ?? null, dueAt: DAY.taskDue },
          { id: result.taskIds.taken, ...task, kind: WarehouseTaskKind.MOVE, fromLocationId: L.bulk, toLocationId: L.pickFace, assignedWorkerId: operator },
          { id: result.taskIds.done, ...task, kind: WarehouseTaskKind.COUNT, sourceType: 'StockCount', sourceId: result.countId, toLocationId: L.countBay },
          { id: result.taskIds.cancelled, ...task, kind: WarehouseTaskKind.PICK, fromLocationId: L.pickFace },
        ],
      })
      // Made OPEN, then taken, done or cancelled (the task's guard).
      const takenBy = { status: WarehouseTaskStatus.TAKEN, takenAt: T.taken, takenByWorkerId: operator, updatedAt: T.taken }
      await tx.warehouseTask.update({ where: { id: result.taskIds.taken }, data: takenBy, select })
      await tx.warehouseTask.update({ where: { id: result.taskIds.done }, data: takenBy, select })
      await tx.warehouseTask.update({ where: { id: result.taskIds.done }, data: { status: WarehouseTaskStatus.DONE, doneAt: T.done, doneByWorkerId: operator, updatedAt: T.done }, select })
      await tx.warehouseTask.update({ where: { id: result.taskIds.cancelled }, data: { status: WarehouseTaskStatus.CANCELLED, cancelledAt: T.done, cancelledById: actorId, cancelReason: 'The work order took the lining from the bulk rack (test).', updatedAt: T.done }, select })

      // --- substitutes on WO-0001's grey lining ----------------------------------------------------------------------------------------
      const substitute = {
        siteId: siteA,
        workOrderId: production.workOrderId,
        styleRevisionId: production.revisionId,
        bomLineId: liningLine.id,
        fromItemId: liningItem,
        toItemId: liningItem,
        toItemColourId: liningGrey,
        toLotId: result.substituteLotId,
        quantity: '4.0000',
        uom: Uom.M,
        baseQuantity: '4.0000',
        reasonCode: 'SHORT',
        reason: 'The lot on the pick list is short by 4 m (test).',
        ruleAnswer: { may: true, held: ['NEEDS_APPROVAL'], message: 'Another lot of the same lining: a person decides (test).' },
      }
      await tx.materialSubstitution.createMany({
        data: [
          { id: result.substitutionIds.waiting, ...substitute, requestedByWorkerId: operator, approvalTaskId: id('warehouse:approval-task:1'), ...stamp(T.asked), createdById: operator },
          { id: result.substitutionIds.approved, ...substitute, requestedById: actorId, approvalTaskId: id('warehouse:approval-task:2'), ...stamp(T.asked) },
          { id: result.substitutionIds.refused, ...substitute, requestedByWorkerId: operator, ...stamp(T.asked), createdById: operator },
        ],
      })
      // Asked (WAITING), then decided by another person than the one who asked.
      await tx.materialSubstitution.update({ where: { id: result.substitutionIds.approved }, data: { status: MaterialSubstitutionStatus.APPROVED, decidedAt: T.decided, decidedById: memberId, updatedAt: T.decided }, select })
      await tx.materialSubstitution.update({
        where: { id: result.substitutionIds.refused },
        data: { status: MaterialSubstitutionStatus.REFUSED, decidedAt: T.decided, decidedById: memberId, refuseReason: 'The shade differs too much from the cut panels (test).', updatedAt: T.decided },
        select,
      })

      // --- goods nobody ordered, waiting in the holding place for a buyer ------------------------------------------------------------------
      await tx.goodsReceipt.create({
        data: { id: result.unplannedReceiptId, companyId: companyA, siteId: siteA, number: 'SEED-GR-W36-01', supplierId: P2, kind: GoodsReceiptKind.UNPLANNED, holdingLocationId: L.holding, supplierDdtNumber: 'SEED-DDT-77', supplierDdtDate: DAY.expected, receivedAt: T.arrived, note: 'Arrived without a purchase order (test).', ...stamp(T.arrived) },
        select,
      })
      await tx.goodsReceiptLine.create({
        data: { id: id('warehouse:receipt:W36-01:10'), siteId: siteA, receiptId: result.unplannedReceiptId, seq: 10, itemId: result.itemId, quantity: '15.0000', uom: Uom.M, baseQuantity: '15.0000', ...stamp(T.arrived) },
        select,
      })
      await tx.task.create({
        data: {
          id: result.buyerTaskId,
          companyId: companyA,
          siteId: siteA,
          title: 'Goods without a PO: find the purchase order or send them back (test)',
          recordType: 'GoodsReceipt',
          recordId: result.unplannedReceiptId,
          recordLabel: 'SEED-GR-W36-01',
          assigneeId: memberId,
          assignedById: actorId,
          assignedAt: T.arrived,
          dueDate: DAY.later,
          ...stamp(T.arrived),
        },
        select,
      })
      await tx.goodsReceipt.update({ where: { id: result.unplannedReceiptId }, data: { buyerTaskId: result.buyerTaskId, updatedAt: T.arrived }, select })
    }),
  )
  return result
}
