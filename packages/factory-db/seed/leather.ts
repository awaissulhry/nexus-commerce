import { CrViEvidence, CrViStatus, FabricRollState, HideMarkKind, HideState, ItemKind, ItemSourcing, ItemTracking, LotQualityStatus, StockMoveReason, StockValuationMethod, Tannage, Uom } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedHolds } from './holds'
import { seed as seedInspectionPlans } from './inspection-plans'
import { seed as seedQuality } from './quality'

/**
 * The leather and roll stock seed (W2b schema wave 12/16, B-W2b-80), per tenant of seed/_core.ts. The grades, rules and shade
 * groups are written in the tenant's office scope, what happens on plant A1 in A1's floor scope where the floor does it, as
 * the app does. The CLI runs this file after seed/inspection-plans.ts (name order); it runs that seed anyway (idempotent): it
 * brings the inventory, production and quality seeds, and the defect library.
 *
 *   grades      A, B, C, D (usable 85, 72, 60, 45 %).
 *   rules       the cowhide SEED-LEA-100: A 88 %, B 74 %, C 58 % for lower panels only; an older rule for D, retired.
 *   shades      the black cowhide's groups 1, 2, 3 and Out of shade against the master swatch; a group of its own for lot
 *               SEED-LOT-LEA-01; the lining's group 1, in any colour.
 *   hides       SEED-HIDE-0002 (grade B) in group 2, the record beside W1's text; SEED-HIDE-0001 keeps its text alone, as a
 *               W1 hide does.
 *   marks       SEED-HIDE-0002: a scar on the neck edge (a DEFECT, made in SEED-IIN-0001) in a quality zone B (a ZONE); a wrong
 *               mark withdrawn.
 *   measures    SEED-HIDE-0001 and -0002 in SEED-IIN-0001 by the floor inspector, short of the tannery's area; SEED-HIDE-0002
 *               measured again in the office.
 *   remnants    an article of its own, SEED-LEA-110 (a leather the product rules take: animal, tannage, grade, thickness, Cr VI
 *               tested), so no stock of the jacket's leather moves: lot SEED-LOT-LEA-09 (its Cr VI PASS on the lot's report) with hide
 *               SEED-HIDE-0009, whose offcut of 14 ft² came back from WO-0001 (a REMNANT move, to the cutting rack, valued at the
 *               lot's cost as every move that changes the site's stock is: the month close counts an unvalued move): SEED-RM-0001
 *               (5 ft²) and SEED-RM-0002 (3 ft²).
 *   rolls       lot SEED-LOT-LIN-01: SEED-RL-0001 (60 m, untouched) in the store, SEED-RL-0002 (60 m, 44.5 left), in shade group 1.
 *   protectors  lot SEED-LOT-PRO-01 of the shoulder protector (no stock: a lot record): held by batch WO-0001 and by WO-0003's
 *               first serial; a wrong row withdrawn.
 *   pack        thread SEED-THR-400: 5,000 m on a cone. Its minimum and maximum would be an ItemPlanning row (MIN_MAX), left
 *               out so the seeded plans do not change.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * an active rule is one per article and grade, a new mark or protector row is not withdrawn, and the live pieces of one move
 * never add up to more than the move. So the retired rule, the first mark, measure, roll and protector row and the 5 ft²
 * remnant get ids that start with eight zeros. Every name, number and value is invented. Idempotent: written once, skipped when
 * the first grade exists.
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  written: new Date('2026-11-18T08:00:00.000Z'),
  measured: new Date('2026-11-18T10:30:00.000Z'),
  remeasured: new Date('2026-11-19T09:00:00.000Z'),
  cut: new Date('2026-11-19T11:00:00.000Z'),
  withdrawn: new Date('2026-11-19T12:00:00.000Z'),
}

export interface LeatherSeed {
  readonly gradeIds: { readonly A: string; readonly B: string; readonly C: string; readonly D: string }
  /** The rule of grade A of the cowhide, and the retired rule of grade D. */
  readonly ruleIds: { readonly active: string; readonly retired: string }
  /** The black cowhide's groups, the lot's own group, and the lining's. */
  readonly shadeGroupIds: { readonly one: string; readonly two: string; readonly three: string; readonly outOfShade: string; readonly lot: string; readonly lining: string }
  readonly leatherItemId: string
  readonly leatherLotId: string
  readonly hideIds: readonly [string, string]
  /** The scar, the zone, the withdrawn mark. */
  readonly markIds: { readonly defect: string; readonly zone: string; readonly withdrawn: string }
  readonly measureIds: readonly [string, string, string]
  /** The offcut article, its lot and hide, and the REMNANT move. */
  readonly offcut: { readonly itemId: string; readonly lotId: string; readonly hideId: string; readonly moveId: string; readonly valuationId: string }
  readonly remnantIds: readonly [string, string]
  readonly rollLotId: string
  readonly rollItemId: string
  readonly rollIds: { readonly full: string; readonly partial: string }
  readonly protector: { readonly itemId: string; readonly lotId: string; readonly batchRowId: string; readonly serialRowId: string; readonly withdrawnRowId: string }
  readonly threadItemId: string
  readonly workOrderId: string
  readonly draftWorkOrderId: string
  readonly serialWorkOrderId: string
  readonly serialId: string
  readonly openIncomingId: string
  readonly locations: { readonly store: string; readonly bin: string; readonly cutting: string }
  readonly workerId: string
  readonly deviceId: string
}

export async function seed(context: SeedContext): Promise<LeatherSeed> {
  const { db, namespace } = context
  const holds = await seedHolds(context)
  const plans = await seedInspectionPlans(context)
  const quality = await seedQuality(context)
  const { production } = quality
  const { inventory } = production
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const inspector = plans.inspectorId
  const atBench = { audience: 'floor' as const, tenantId, actorId: inspector, siteId: siteA }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const leatherItemId = id('product:item:leather')
  const liningItemId = id('product:item:lining')
  const protectorItemId = id('product:item:protector')
  const leatherBlack = id('product:item-colour:leather:BLK')
  const [hide1, hide2] = inventory.hideIds

  const gradeIds = { A: id('leather:grade:A'), B: id('leather:grade:B'), C: id('leather:grade:C'), D: id('leather:grade:D') }
  const ruleIds = { active: id('leather:rule:LEA-100:A'), retired: firstId('leather:rule:LEA-100:D') }
  const shadeGroupIds = {
    one: id('leather:shade:LEA-100:BLK:1'),
    two: id('leather:shade:LEA-100:BLK:2'),
    three: id('leather:shade:LEA-100:BLK:3'),
    outOfShade: id('leather:shade:LEA-100:BLK:out'),
    lot: id('leather:shade:lot:LEA-01'),
    lining: id('leather:shade:LIN-200:1'),
  }
  const markIds = { defect: firstId('leather:mark:H2:scar'), zone: id('leather:mark:H2:zone'), withdrawn: id('leather:mark:H2:wrong') }
  const measureIds = [firstId('leather:measure:H1:bench'), id('leather:measure:H2:bench'), id('leather:measure:H2:office')] as const
  const offcut = { itemId: id('leather:item:LEA-110'), lotId: id('leather:lot:LEA-09'), hideId: id('leather:hide:0009'), moveId: id('leather:move:remnant:0009'), valuationId: id('leather:value:remnant:0009') }
  const remnantIds = [firstId('leather:remnant:1'), id('leather:remnant:2')] as const
  const rollIds = { full: firstId('leather:roll:1'), partial: id('leather:roll:2') }
  const protectorLotId = id('leather:lot:PRO-01')
  const protectorRows = { batchRowId: firstId('leather:protector:batch'), serialRowId: id('leather:protector:serial'), withdrawnRowId: id('leather:protector:wrong') }
  const threadItemId = id('leather:item:THR-400')

  const result: LeatherSeed = {
    gradeIds,
    ruleIds,
    shadeGroupIds,
    leatherItemId,
    leatherLotId: inventory.leatherLotId,
    hideIds: [hide1, hide2],
    markIds,
    measureIds,
    offcut,
    remnantIds,
    rollLotId: inventory.liningLotId,
    rollItemId: liningItemId,
    rollIds,
    protector: { itemId: protectorItemId, lotId: protectorLotId, ...protectorRows },
    threadItemId,
    workOrderId: production.workOrderId,
    draftWorkOrderId: production.draftWorkOrderId,
    serialWorkOrderId: quality.serialWorkOrderId,
    serialId: quality.serialIds[0],
    openIncomingId: plans.openIncomingId,
    locations: { store: inventory.locations.store, bin: inventory.locations.bin, cutting: inventory.locations.cutting },
    workerId: inspector,
    deviceId: plans.deviceId,
  }

  const done = await db.withScope(office, (client) => client.leatherGrade.findUnique({ where: { id: gradeIds.A }, select: { id: true } }))
  if (done) return result

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.leatherGrade.createMany({
        data: [
          { id: gradeIds.A, code: 'A', labelIt: 'Prima scelta', labelEn: 'First choice', labelI18n: { ro: 'Calitatea întâi' }, usableShare: '85.00', sortOrder: 1, ...stamp(T.written) },
          { id: gradeIds.B, code: 'B', labelIt: 'Seconda scelta', labelEn: 'Second choice', usableShare: '72.00', sortOrder: 2, ...stamp(T.written) },
          { id: gradeIds.C, code: 'C', labelIt: 'Terza scelta', labelEn: 'Third choice', usableShare: '60.00', sortOrder: 3, ...stamp(T.written) },
          { id: gradeIds.D, code: 'D', labelIt: 'Quarta scelta', labelEn: 'Fourth choice', usableShare: '45.00', sortOrder: 4, ...stamp(T.written) },
        ],
      })
      await tx.itemGradeRule.createMany({
        data: [
          { id: ruleIds.retired, itemId: leatherItemId, gradeId: gradeIds.D, usableShare: '40.00', active: false, ...stamp(T.written) },
          { id: ruleIds.active, itemId: leatherItemId, gradeId: gradeIds.A, usableShare: '88.00', ...stamp(T.written) },
          { id: id('leather:rule:LEA-100:B'), itemId: leatherItemId, gradeId: gradeIds.B, usableShare: '74.00', ...stamp(T.written) },
          { id: id('leather:rule:LEA-100:C'), itemId: leatherItemId, gradeId: gradeIds.C, usableShare: '58.00', panels: ['under collar', 'pocket bag'], ...stamp(T.written) },
        ],
      })
      await tx.shadeGroup.createMany({
        data: [
          { id: shadeGroupIds.one, itemId: leatherItemId, itemColourId: leatherBlack, label: '1', swatchRef: 'Swatch BLK-1, shelf 3', sortOrder: 1, ...stamp(T.written) },
          { id: shadeGroupIds.two, itemId: leatherItemId, itemColourId: leatherBlack, label: '2', swatchRef: 'Swatch BLK-2, shelf 3', sortOrder: 2, ...stamp(T.written) },
          { id: shadeGroupIds.three, itemId: leatherItemId, itemColourId: leatherBlack, label: '3', sortOrder: 3, ...stamp(T.written) },
          { id: shadeGroupIds.outOfShade, itemId: leatherItemId, itemColourId: leatherBlack, label: 'Out of shade', outOfShade: true, sortOrder: 9, ...stamp(T.written) },
          { id: shadeGroupIds.lot, itemId: leatherItemId, itemColourId: leatherBlack, lotSiteId: siteA, lotId: inventory.leatherLotId, label: 'L1', sortOrder: 10, ...stamp(T.written) },
          { id: shadeGroupIds.lining, itemId: liningItemId, label: '1', sortOrder: 1, ...stamp(T.written) },
        ],
      })
      // Beside W1's text, which says the same (the Hide_grade_shade_check trigger).
      await tx.hide.update({ where: { id: hide2 }, data: { gradeId: gradeIds.B, shade: '2', shadeGroupId: shadeGroupIds.two, updatedAt: T.written }, select: { id: true } })

      // Thread by the cone, and the article of its own that the offcut below is of (no stock of the jacket's leather moves).
      await tx.item.createMany({
        data: [
          {
            id: threadItemId,
            code: 'SEED-THR-400',
            name: 'Seed bonded thread',
            kind: ItemKind.THREAD,
            sourcing: ItemSourcing.BUY,
            tracking: ItemTracking.NONE,
            baseUom: Uom.M,
            purchaseUom: Uom.CONE,
            purchaseFactor: '5000.00000000',
            consumptionUom: Uom.M,
            packSize: '5000.0000',
            packUom: Uom.CONE,
            ...stamp(T.written),
          },
          {
            id: offcut.itemId,
            code: 'SEED-LEA-110',
            name: 'Seed goatskin offcuts',
            kind: ItemKind.LEATHER,
            sourcing: ItemSourcing.BUY,
            tracking: ItemTracking.HIDE,
            baseUom: Uom.FT2,
            purchaseUom: Uom.FT2,
            consumptionUom: Uom.FT2,
            // Leather names its animal, tannage, grade and thickness range, and its lots need Cr VI evidence (the product rules,
            // product/materials/rules.ts; REACH Annex XVII entry 47), as the jacket's leather does.
            animalSpecies: 'goat',
            tannage: Tannage.CHROME,
            grade: 'B',
            finish: 'aniline',
            thicknessMinMm: '0.80',
            thicknessMaxMm: '1.00',
            animalOrigin: true,
            requiresCrViTest: true,
            crViLimitMgKg: '3.000',
            ...stamp(T.written),
          },
        ],
      })
      await tx.lot.create({
        data: {
          id: offcut.lotId,
          companyId: companyA,
          siteId: siteA,
          itemId: offcut.itemId,
          code: 'SEED-LOT-LEA-09',
          requiresCrViTest: true,
          crViLimitMgKg: '3.000',
          crViStatus: CrViStatus.PASS,
          crViMgKg: '0.800',
          crViEvidence: CrViEvidence.LOT_REPORT,
          crViTestedAt: new Date('2026-11-17T00:00:00.000Z'),
          qualityStatus: LotQualityStatus.RELEASED,
          qualityNote: 'Cr VI 0.8 mg/kg on the lab report of this lot, below the 3 mg/kg limit.',
          qualityDecidedAt: T.written,
          qualityDecidedById: actorId,
          ...stamp(T.written),
        },
        select: { id: true },
      })
      await tx.hide.create({
        data: {
          id: offcut.hideId,
          siteId: siteA,
          lotId: offcut.lotId,
          itemId: offcut.itemId,
          code: 'SEED-HIDE-0009',
          area: '40.0000',
          areaUom: Uom.FT2,
          baseArea: '40.0000',
          grade: 'A',
          gradeId: gradeIds.A,
          state: HideState.REMNANT,
          ...stamp(T.written),
        },
        select: { id: true },
      })
      await tx.stockMove.create({
        data: {
          id: offcut.moveId,
          companyId: companyA,
          siteId: siteA,
          reason: StockMoveReason.REMNANT,
          itemId: offcut.itemId,
          lotId: offcut.lotId,
          hideId: offcut.hideId,
          toLocationId: inventory.locations.cutting,
          quantity: '14.0000',
          uom: Uom.FT2,
          baseQuantity: '14.0000',
          workOrderId: production.workOrderId,
          reference: 'SEED-WO-0001',
          idempotencyKey: 'seed-remnant-0009',
          occurredAt: T.cut,
          createdAt: T.cut,
          createdById: actorId,
        },
        select: { id: true },
      })
      // Stock back into the site has its value (A1 §2.6), as the W1 seeds value their moves: 14 ft² at the lot's 3.80 a ft².
      await tx.stockValuation.create({
        data: {
          id: offcut.valuationId,
          companyId: companyA,
          siteId: siteA,
          moveId: offcut.moveId,
          itemId: offcut.itemId,
          lotId: offcut.lotId,
          quantity: '14.0000',
          unitCost: '3.800000',
          valueAmount: 5_320,
          method: StockValuationMethod.LOT_COST,
          idempotencyKey: `move:${offcut.moveId}`,
          createdAt: T.cut,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.remnant.createMany({
        data: [
          { id: remnantIds[0], companyId: companyA, siteId: siteA, lotId: offcut.lotId, hideId: offcut.hideId, code: 'SEED-RM-0001', area: '5.0000', areaUom: Uom.FT2, baseArea: '5.0000', gradeId: gradeIds.A, locationId: inventory.locations.cutting, moveId: offcut.moveId, ...stamp(T.cut) },
          { id: remnantIds[1], companyId: companyA, siteId: siteA, lotId: offcut.lotId, hideId: offcut.hideId, code: 'SEED-RM-0002', area: '3.0000', areaUom: Uom.FT2, baseArea: '3.0000', gradeId: gradeIds.B, locationId: inventory.locations.cutting, moveId: offcut.moveId, ...stamp(T.cut) },
        ],
      })

      // A lot record of the shoulder protector (it holds no stock here: goods stay at the dock in seed/inventory.ts).
      await tx.lot.create({
        data: { id: protectorLotId, companyId: companyA, siteId: siteA, itemId: protectorItemId, code: 'SEED-LOT-PRO-01', supplierLotRef: 'PL-2026-07', qualityStatus: LotQualityStatus.RELEASED, qualityDecidedAt: T.written, qualityDecidedById: actorId, ...stamp(T.written) },
        select: { id: true },
      })
    }),
  )

  // What the bench does on plant A1, in its floor scope.
  const byWorker = { measuredByWorkerId: inspector, deviceId: plans.deviceId, createdById: inspector }
  await db.withScope(atBench, (client) =>
    client.$transaction(async (tx) => {
      await tx.hideMeasure.createMany({
        data: [
          { id: measureIds[0], siteId: siteA, lotId: inventory.leatherLotId, hideId: hide1, declaredArea: '53.2000', measuredArea: '52.6000', areaUom: Uom.FT2, incomingInspectionId: plans.openIncomingId, measuredAt: T.measured, createdAt: T.measured, ...byWorker },
          { id: measureIds[1], siteId: siteA, lotId: inventory.leatherLotId, hideId: hide2, declaredArea: '51.8000', measuredArea: '51.1000', areaUom: Uom.FT2, incomingInspectionId: plans.openIncomingId, measuredAt: T.measured, createdAt: T.measured, ...byWorker },
        ],
      })
      const mark = { siteId: siteA, lotId: inventory.leatherLotId, hideId: hide2, createdAt: T.measured, updatedAt: T.measured, createdById: inspector }
      await tx.hideMark.createMany({
        data: [
          { id: markIds.defect, ...mark, kind: HideMarkKind.DEFECT, x: '0.42000', y: '0.11000', defectCodeId: holds.defectCodeIds['HIDE-SCAR'] as string, zoneGradeId: gradeIds.B, incomingInspectionId: plans.openIncomingId, note: 'Small scar near the neck edge.' },
          {
            id: markIds.zone,
            ...mark,
            kind: HideMarkKind.ZONE,
            x: '0.45000',
            y: '0.15000',
            zoneGradeId: gradeIds.B,
            outline: [{ x: 0.3, y: 0.05 }, { x: 0.6, y: 0.05 }, { x: 0.6, y: 0.25 }, { x: 0.3, y: 0.25 }],
            incomingInspectionId: plans.openIncomingId,
          },
          { id: markIds.withdrawn, ...mark, kind: HideMarkKind.DEFECT, x: '0.80000', y: '0.70000', defectCodeId: holds.defectCodeIds['GRAIN-CRACK'] as string },
        ],
      })
      await tx.hideMark.update({ where: { id: markIds.withdrawn }, data: { voidedAt: T.withdrawn, voidedById: inspector, voidReason: 'A fold in the hide, not a crack.', updatedAt: T.withdrawn }, select: { id: true } })
      await tx.fabricRoll.createMany({
        data: [
          { id: rollIds.full, companyId: companyA, siteId: siteA, itemId: liningItemId, lotId: inventory.liningLotId, code: 'SEED-RL-0001', supplierRollRef: 'M-8841', length: '60.0000', uom: Uom.M, lengthLeft: '60.0000', widthCm: '145.00', locationId: inventory.locations.bin, createdAt: T.measured, updatedAt: T.measured, createdById: inspector },
          {
            id: rollIds.partial,
            companyId: companyA,
            siteId: siteA,
            itemId: liningItemId,
            lotId: inventory.liningLotId,
            code: 'SEED-RL-0002',
            supplierRollRef: 'M-8842',
            length: '60.0000',
            uom: Uom.M,
            lengthLeft: '44.5000',
            widthCm: '144.50',
            shade: '1',
            shadeGroupId: shadeGroupIds.lining,
            shrinkageLengthPercent: '1.50',
            shrinkageWidthPercent: '0.80',
            shrinkageGroup: 'S1',
            state: FabricRollState.PARTIAL,
            locationId: inventory.locations.cutting,
            createdAt: T.measured,
            updatedAt: T.measured,
            createdById: inspector,
          },
        ],
      })
      await tx.garmentProtectorLot.createMany({
        data: [
          { id: protectorRows.batchRowId, siteId: siteA, workOrderId: production.workOrderId, itemId: protectorItemId, lotId: protectorLotId, placement: 'shoulder', createdAt: T.cut, updatedAt: T.cut, createdById: inspector },
          { id: protectorRows.serialRowId, siteId: siteA, workOrderId: quality.serialWorkOrderId, garmentSerialId: quality.serialIds[0], itemId: protectorItemId, lotId: protectorLotId, placement: 'shoulder', createdAt: T.cut, updatedAt: T.cut, createdById: inspector },
          { id: protectorRows.withdrawnRowId, siteId: siteA, workOrderId: production.workOrderId, itemId: protectorItemId, lotId: protectorLotId, placement: 'elbow', createdAt: T.cut, updatedAt: T.cut, createdById: inspector },
        ],
      })
    }),
  )

  // What the office does.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.hideMeasure.create({
        data: { id: measureIds[2], siteId: siteA, lotId: inventory.leatherLotId, hideId: hide2, declaredArea: '51.8000', measuredArea: '51.3000', areaUom: Uom.FT2, measuredById: actorId, measuredAt: T.remeasured, note: 'Measured again on the office table.', createdAt: T.remeasured, createdById: actorId },
        select: { id: true },
      })
      await tx.garmentProtectorLot.update({ where: { id: protectorRows.withdrawnRowId }, data: { voidedAt: T.withdrawn, voidedById: actorId, voidReason: 'This batch has no elbow protectors.', updatedAt: T.withdrawn }, select: { id: true } })
    }),
  )
  return result
}
