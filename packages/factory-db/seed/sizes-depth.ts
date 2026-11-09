import type { Prisma } from '../src/generated/prisma/client'
import {
  BodyZone,
  GradeIncrementFormat,
  ItemKind,
  ItemSourcing,
  ItemTracking,
  MasterStatus,
  MeasurementRuleKind,
  MeasurementRuleSeverity,
  MeasurementSpecStatus,
  MeasurementValueSource,
  PointOfMeasureKind,
  PpeCategory,
  ProductType,
  ProtectorPocket,
  StyleRevisionStatus,
  StyleStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedProduct } from './product'

/**
 * The sizes, measurements and made-to-measure rules seed (W2b-4 schema wave 27/33, B-W2b-210), per tenant of
 * seed/_core.ts, written in the tenant's office scope, as the app does. The CLI runs this file after seed/shipping.ts (name
 * order); it runs the product seed anyway (idempotent: the jacket SEED-JKT-01 with its DRAFT revision 1, the EU jacket
 * scale, the JACKET template and the shoulder protector) and the files seed (the store the picture is in).
 *
 *   fits         SEED-EU-TRS: a scale of two dimensions (size and fit): 50R, 50L, 52R, 52L.
 *   library      points of measure, all tenant-wide: garment chest width (it names the body chest), back length (with a
 *                how-to picture), sleeve length, waist width and inseam; body chest, waist, sleeve, outseam and inseam.
 *   templates    the JACKET template's points take the body points, with an inspection tolerance and alteration limits, and
 *                a base size rule (chest, the larger size on a tie); two rules (waist to chest between 0.60 and 1.15, a
 *                warning; chest 88-116 cm, a block). A TROUSERS template (outseam, inseam, waist) with the rule "the inseam
 *                is not longer than the outseam" (a block). Both templates' rules are OFF (rulesOn false: built off).
 *   grading      SEED-GR-JKT (EU jacket scale, base 52, relative): back length +1.00 from 50 to 52 and from 52 to 54, chest
 *                width +2.00 and sleeve length +0.50 every step. SEED-GR-TRS (the trousers scale, base 52R, absolute):
 *                inseam +4.00 to 52L, waist width −1.00 to 50R and 50L.
 *   specs        SEED-JKT-01 revision 1 (DRAFT): an ARCHIVED spec (base 50, no value) and the live DRAFT spec, base 52,
 *                graded by SEED-GR-JKT: chest width, back length and sleeve length for 50, 52, 54 (the sleeve of 54 typed
 *                over its graded value). SEED-TRS-01 (a made-up trousers style on the fit scale) revision 1: an APPROVED
 *                spec of waist width and inseam for its four sizes, then the revision RELEASED (frozen with its spec).
 *   prepacks     SEED-PP-JKT-7 (SEED-JKT-01: 50 ×2, 52 ×3, 54 ×2), SEED-PP-JKT-COL (52 black ×2, 52 red ×1), SEED-PP-EU-9 (the
 *                whole EU jacket scale: 1-2-3-2-1 from 48 to 56) and SEED-PP-JKT-OLD (archived after its lines).
 *   protectors   SEED-JKT-01 revision 1: shoulder SEED-PRO-300 (EN 1621-1, level 2) for 50 and 52, a back protector
 *                SEED-PRO-320 (EN 1621-2, level 1) in every size, an elbow protector SEED-PRO-330 (EN 1621-1, level 1).
 *                SEED-TRS-01 revision 1: knee SEED-PRO-330 in every size.
 *   BOM          SEED-JKT-01 revision 1's leather follows the rider's chest (factor 1), its lining the chest by 0.8.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a spec's or protector's copy only on a DRAFT revision, a spec value's only on a DRAFT spec, one live spec per
 * revision, one standard increment per rule and point, one line per size without a colourway, a prepack line only on an
 * ACTIVE prepack, and a base size rule names its own template's points. So the garment chest width, the ARCHIVED spec,
 * the DRAFT spec's back length of 52, SEED-GR-JKT's back length step from 52 to 54, SEED-PP-JKT-7 and its line of 50, the
 * shoulder placement of 50 and 52, the TROUSERS template and its rule get ids that start with eight zeros; the picture's
 * file gets eight f's. Every name, number and value is invented. Idempotent: written once, skipped when the first point
 * of measure exists.
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  library: new Date('2026-11-21T08:00:00.000Z'),
  spec: new Date('2026-11-21T09:00:00.000Z'),
  approved: new Date('2026-11-21T10:00:00.000Z'),
  released: new Date('2026-11-21T11:00:00.000Z'),
}

export interface SizesDepthSeed {
  /** SEED-EU-TRS (two dimensions) and its sizes by code. */
  readonly fitScaleId: string
  readonly fitSizeIds: Readonly<Record<'50R' | '50L' | '52R' | '52L', string>>
  /** The product seed's EU jacket scale (one dimension). */
  readonly jacketScaleId: string
  readonly pointIds: {
    readonly chestW: string
    readonly backLen: string
    readonly sleeveLen: string
    readonly waistW: string
    readonly inseamG: string
    readonly chest: string
    readonly waist: string
    readonly sleeve: string
    readonly outseam: string
    readonly inseam: string
  }
  readonly pictureFileId: string
  /** The product seed's JACKET template and its points; the TROUSERS template and its points. */
  readonly templateIds: { readonly jacket: string; readonly trousers: string }
  readonly templatePointIds: {
    readonly chest: string
    readonly waist: string
    readonly sleeve: string
    readonly outseam: string
    readonly inseam: string
    readonly trousersWaist: string
  }
  readonly ruleIds: { readonly inseam: string; readonly waistToChest: string; readonly chestRange: string }
  readonly gradeRuleIds: { readonly jacket: string; readonly trousers: string }
  readonly gradeStepIds: { readonly back52to54: string; readonly back50to52: string; readonly chestStandard: string; readonly sleeveStandard: string }
  /** SEED-JKT-01 (DRAFT revision 1) and SEED-TRS-01 (RELEASED revision 1). */
  readonly jacket: { readonly styleId: string; readonly revisionId: string; readonly archivedSpecId: string; readonly specId: string; readonly colourwayIds: readonly string[] }
  readonly trousers: { readonly styleId: string; readonly revisionId: string; readonly specId: string }
  readonly specValueIds: { readonly back52: string; readonly sleeve54: string; readonly released: string }
  readonly prepackIds: { readonly jacket: string; readonly colours: string; readonly scale: string; readonly archived: string }
  readonly prepackLineIds: { readonly jacket50: string; readonly colourBlk: string; readonly archived50: string }
  readonly placementIds: { readonly shoulder: string; readonly back: string; readonly elbow: string; readonly knee: string }
  readonly protectorIds: { readonly shoulder: string; readonly back: string; readonly limb: string }
  readonly bomLineIds: { readonly leather: string; readonly lining: string }
}

export async function seed(context: SeedContext): Promise<SizesDepthSeed> {
  const { db, namespace } = context
  const product = await seedProduct(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const store = id('files:account:r2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const result: SizesDepthSeed = {
    fitScaleId: id('sizes:scale:EU-TRS'),
    fitSizeIds: { '50R': id('sizes:size:EU-TRS:50R'), '50L': id('sizes:size:EU-TRS:50L'), '52R': id('sizes:size:EU-TRS:52R'), '52L': id('sizes:size:EU-TRS:52L') },
    jacketScaleId: id('product:size-scale:EU-JKT'),
    pointIds: {
      chestW: firstId('sizes:pom:CHEST_W'),
      backLen: id('sizes:pom:BACK_LEN'),
      sleeveLen: id('sizes:pom:SLEEVE_LEN'),
      waistW: id('sizes:pom:WAIST_W'),
      inseamG: id('sizes:pom:INSEAM_G'),
      chest: id('sizes:pom:chest'),
      waist: id('sizes:pom:waist'),
      sleeve: id('sizes:pom:sleeve'),
      outseam: id('sizes:pom:outseam'),
      inseam: id('sizes:pom:inseam'),
    },
    pictureFileId: lastId('sizes:file:back-length'),
    templateIds: { jacket: id('product:measurement-template:JACKET'), trousers: firstId('sizes:template:TROUSERS') },
    templatePointIds: {
      chest: id('product:measurement-point:JACKET:chest'),
      waist: id('product:measurement-point:JACKET:waist'),
      sleeve: id('product:measurement-point:JACKET:sleeve'),
      outseam: id('sizes:template-point:TROUSERS:outseam'),
      inseam: id('sizes:template-point:TROUSERS:inseam'),
      trousersWaist: id('sizes:template-point:TROUSERS:waist'),
    },
    ruleIds: { inseam: firstId('sizes:rule:TROUSERS:INSEAM_LE_OUTSEAM'), waistToChest: id('sizes:rule:JACKET:WAIST_TO_CHEST'), chestRange: id('sizes:rule:JACKET:CHEST_RANGE') },
    gradeRuleIds: { jacket: firstId('sizes:grade-rule:JKT'), trousers: id('sizes:grade-rule:TRS') },
    gradeStepIds: {
      back52to54: firstId('sizes:grade-step:JKT:BACK_LEN:52:54'),
      back50to52: id('sizes:grade-step:JKT:BACK_LEN:50:52'),
      chestStandard: id('sizes:grade-step:JKT:CHEST_W'),
      sleeveStandard: id('sizes:grade-step:JKT:SLEEVE_LEN'),
    },
    jacket: {
      styleId: product.styleId,
      revisionId: product.revisionId,
      archivedSpecId: firstId('sizes:spec:JKT-01:1:archived'),
      specId: id('sizes:spec:JKT-01:1'),
      colourwayIds: product.colourwayIds,
    },
    trousers: { styleId: id('sizes:style:TRS-01'), revisionId: id('sizes:revision:TRS-01:1'), specId: id('sizes:spec:TRS-01:1') },
    specValueIds: { back52: firstId('sizes:spec-value:JKT-01:1:BACK_LEN:52'), sleeve54: id('sizes:spec-value:JKT-01:1:SLEEVE_LEN:54'), released: id('sizes:spec-value:TRS-01:1:INSEAM_G:52R') },
    prepackIds: { jacket: firstId('sizes:prepack:JKT-7'), colours: id('sizes:prepack:JKT-COL'), scale: id('sizes:prepack:EU-9'), archived: id('sizes:prepack:JKT-OLD') },
    prepackLineIds: { jacket50: firstId('sizes:prepack-line:JKT-7:50'), colourBlk: id('sizes:prepack-line:JKT-COL:52:BLK'), archived50: id('sizes:prepack-line:JKT-OLD:50') },
    placementIds: {
      shoulder: firstId('sizes:placement:JKT-01:1:1'),
      back: id('sizes:placement:JKT-01:1:3'),
      elbow: id('sizes:placement:JKT-01:1:2'),
      knee: id('sizes:placement:TRS-01:1:1'),
    },
    protectorIds: { shoulder: product.protectorId, back: id('sizes:item:protector:back'), limb: id('sizes:item:protector:limb') },
    bomLineIds: { leather: id('product:bom:JKT-01:1:10'), lining: id('product:bom:JKT-01:1:20') },
  }

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.pointOfMeasure.findUnique({ where: { id: result.pointIds.chestW }, select: { id: true } })) return

      // --- a scale of two dimensions (PRD-049) --------------------------------------------------------------------------
      await tx.sizeScale.create({ data: { id: result.fitScaleId, code: 'SEED-EU-TRS', name: 'Seed EU trousers 50-52, regular and long', dimensions: 2, ...stamp(T.library) }, select: { id: true } })
      const fits = [
        { code: '50R', fit: 'R', seq: 1, waist: ['84', '88'], inseam: ['78', '82'] },
        { code: '50L', fit: 'L', seq: 2, waist: ['84', '88'], inseam: ['82', '86'] },
        { code: '52R', fit: 'R', seq: 3, waist: ['88', '92'], inseam: ['79', '83'] },
        { code: '52L', fit: 'L', seq: 4, waist: ['88', '92'], inseam: ['83', '87'] },
      ] as const
      await tx.size.createMany({
        data: fits.map((size) => ({
          id: result.fitSizeIds[size.code],
          scaleId: result.fitScaleId,
          code: size.code,
          label: `${size.code.slice(0, 2)} ${size.fit === 'R' ? 'Regular' : 'Long'}`,
          seq: size.seq,
          fitCode: size.fit,
          bodyMeasures: { waist: { min: size.waist[0], max: size.waist[1], unit: 'cm' }, inseam: { min: size.inseam[0], max: size.inseam[1], unit: 'cm' } },
          ...stamp(T.library),
        })),
      })

      // --- the library of points of measure (PRD-062, PRD-069) ----------------------------------------------------------
      const words = (it: string, en: string) => ({ it, en })
      const body = (rowId: string, code: string, name: Record<string, string>, zone: BodyZone, howTo: string): Prisma.PointOfMeasureCreateManyInput => ({
        id: rowId,
        code,
        name: name.en as string,
        nameI18n: name,
        howTo,
        kind: PointOfMeasureKind.BODY,
        bodyZone: zone,
        ...stamp(T.library),
      })
      await tx.pointOfMeasure.createMany({
        data: [
          body(result.pointIds.chest, 'chest', words('Torace', 'Chest'), BodyZone.UPPER, 'Around the fullest part of the chest, under the arms.'),
          body(result.pointIds.waist, 'waist', words('Vita', 'Waist'), BodyZone.UPPER, 'Around the natural waist.'),
          body(result.pointIds.sleeve, 'sleeve', words('Manica', 'Sleeve'), BodyZone.ARMS, 'Shoulder point to wrist, arm bent forward.'),
          body(result.pointIds.outseam, 'outseam', words('Lunghezza esterna', 'Outseam'), BodyZone.LEGS, 'Waist to the floor, along the outside of the leg.'),
          body(result.pointIds.inseam, 'inseam', words('Interno gamba', 'Inseam'), BodyZone.LEGS, 'Crotch to the floor, along the inside of the leg.'),
        ],
      })
      const garment = (rowId: string, code: string, name: Record<string, string>, zone: BodyZone, tolerance: string, extra: Partial<Prisma.PointOfMeasureCreateManyInput> = {}): Prisma.PointOfMeasureCreateManyInput => ({
        id: rowId,
        code,
        name: name.en as string,
        nameI18n: name,
        kind: PointOfMeasureKind.GARMENT,
        bodyZone: zone,
        defaultTolerance: tolerance,
        ...extra,
        ...stamp(T.library),
      })
      await tx.pointOfMeasure.createMany({
        data: [
          garment(result.pointIds.chestW, 'CHEST_W', words('Larghezza torace', 'Chest width'), BodyZone.UPPER, '1.00', {
            description: 'Half the chest, laid flat.',
            howTo: 'Lay the garment flat, closed; measure straight across 2 cm below the armholes.',
            howToI18n: words('Capo steso e chiuso: misurare in orizzontale 2 cm sotto gli scalfi.', 'Lay the garment flat, closed; measure straight across 2 cm below the armholes.'),
            bodyPointId: result.pointIds.chest,
          }),
          garment(result.pointIds.backLen, 'BACK_LEN', words('Lunghezza dietro', 'Back length'), BodyZone.UPPER, '1.00', { howTo: 'From the collar seam at the centre back down to the hem.' }),
          garment(result.pointIds.sleeveLen, 'SLEEVE_LEN', words('Lunghezza manica', 'Sleeve length'), BodyZone.ARMS, '1.00', { howTo: 'From the shoulder seam to the cuff, along the top of the sleeve.', bodyPointId: result.pointIds.sleeve }),
          garment(result.pointIds.waistW, 'WAIST_W', words('Larghezza vita', 'Waist width'), BodyZone.LEGS, '0.50', { bodyPointId: result.pointIds.waist }),
          garment(result.pointIds.inseamG, 'INSEAM_G', words('Interno gamba capo', 'Garment inseam'), BodyZone.LEGS, '1.00', { bodyPointId: result.pointIds.inseam }),
        ],
      })
      // The back length's how-to picture: a photo of the point (a row only: the object is not in the store).
      await tx.storedFile.create({
        data: {
          id: result.pictureFileId,
          recordType: 'PointOfMeasure',
          recordId: result.pointIds.backLen,
          kind: 'PHOTO',
          originalName: 'Seed back length.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
          sha256: seedUuid(namespace, 'sizes:sha:back-length').replace(/-/g, '').padEnd(64, '0'),
          storageKey: `t/${tenantId}/tenant/2026/${id('sizes:key:back-length')}`,
          storeAccountId: store,
          status: 'AVAILABLE',
          availableAt: T.library,
          ...stamp(T.library),
        },
        select: { id: true },
      })
      await tx.pointOfMeasure.update({ where: { id: result.pointIds.backLen }, data: { pictureFileId: result.pictureFileId }, select: { id: true } })

      // --- made-to-measure templates: library points, limits, base size rule, plausibility rules (built OFF) ------------
      const limits: Record<'chest' | 'waist' | 'sleeve', { point: string; minus: string; plus: string }> = {
        chest: { point: result.pointIds.chest, minus: '4.00', plus: '6.00' },
        waist: { point: result.pointIds.waist, minus: '4.00', plus: '8.00' },
        sleeve: { point: result.pointIds.sleeve, minus: '3.00', plus: '3.00' },
      }
      for (const [code, limit] of Object.entries(limits) as ['chest' | 'waist' | 'sleeve', (typeof limits)['chest']][]) {
        await tx.measurementPoint.update({
          where: { id: result.templatePointIds[code] },
          data: { pointOfMeasureId: limit.point, tolerance: '1.00', alterationMinus: limit.minus, alterationPlus: limit.plus },
          select: { id: true },
        })
      }
      await tx.measurementTemplate.update({ where: { id: result.templateIds.jacket }, data: { baseSizeRule: { points: ['chest'], tie: 'LARGER' } }, select: { id: true } })
      await tx.measurementTemplate.create({
        data: { id: result.templateIds.trousers, code: 'TROUSERS', name: 'Seed trousers measures', nameI18n: words('Misure pantaloni seed', 'Seed trousers measures'), productType: ProductType.TROUSERS, instructions: 'Measure barefoot, standing straight.', ...stamp(T.library) },
        select: { id: true },
      })
      await tx.measurementPoint.createMany({
        data: [
          { id: result.templatePointIds.trousersWaist, templateId: result.templateIds.trousers, code: 'waist', name: 'Waist', seq: 1, minValue: '60.00', maxValue: '140.00', pointOfMeasureId: result.pointIds.waist, tolerance: '1.00', ...stamp(T.library) },
          { id: result.templatePointIds.outseam, templateId: result.templateIds.trousers, code: 'outseam', name: 'Outseam', seq: 2, minValue: '80.00', maxValue: '130.00', pointOfMeasureId: result.pointIds.outseam, tolerance: '1.00', alterationMinus: '4.00', alterationPlus: '4.00', ...stamp(T.library) },
          { id: result.templatePointIds.inseam, templateId: result.templateIds.trousers, code: 'inseam', name: 'Inseam', seq: 3, minValue: '60.00', maxValue: '100.00', pointOfMeasureId: result.pointIds.inseam, tolerance: '1.00', alterationMinus: '4.00', alterationPlus: '4.00', ...stamp(T.library) },
        ],
      })
      await tx.measurementRule.createMany({
        data: [
          {
            id: result.ruleIds.inseam,
            templateId: result.templateIds.trousers,
            code: 'INSEAM_LE_OUTSEAM',
            kind: MeasurementRuleKind.ORDER,
            pointId: result.templatePointIds.inseam,
            otherPointId: result.templatePointIds.outseam,
            severity: MeasurementRuleSeverity.BLOCK,
            messageI18n: words("L'interno gamba non può superare la lunghezza esterna: misurare di nuovo.", 'The inseam cannot be longer than the outseam: measure again.'),
            ...stamp(T.library),
          },
          {
            id: result.ruleIds.waistToChest,
            templateId: result.templateIds.jacket,
            code: 'WAIST_TO_CHEST',
            kind: MeasurementRuleKind.RATIO,
            pointId: result.templatePointIds.waist,
            otherPointId: result.templatePointIds.chest,
            minFactor: '0.6000',
            maxFactor: '1.1500',
            severity: MeasurementRuleSeverity.WARN,
            messageI18n: words('Vita e torace sono insoliti insieme: controllare le due misure.', 'Waist and chest are unusual together: check both measures.'),
            ...stamp(T.library),
          },
          {
            id: result.ruleIds.chestRange,
            templateId: result.templateIds.jacket,
            code: 'CHEST_RANGE',
            kind: MeasurementRuleKind.RANGE,
            pointId: result.templatePointIds.chest,
            minValue: '88.00',
            maxValue: '116.00',
            severity: MeasurementRuleSeverity.BLOCK,
            messageI18n: words('Torace fuori dalla gamma del modello certificato: decide il modellista.', 'Chest outside the certified range of the type: a pattern maker decides.'),
            ...stamp(T.library),
          },
        ],
      })

      // --- grade rules (PRD-051) ------------------------------------------------------------------------------------------
      await tx.gradeRule.createMany({
        data: [
          { id: result.gradeRuleIds.jacket, code: 'SEED-GR-JKT', name: 'Seed jacket grading', sizeScaleId: result.jacketScaleId, baseSize: '52', format: GradeIncrementFormat.RELATIVE, ...stamp(T.library) },
          { id: result.gradeRuleIds.trousers, code: 'SEED-GR-TRS', name: 'Seed trousers grading by fit', sizeScaleId: result.fitScaleId, baseSize: '52R', format: GradeIncrementFormat.ABSOLUTE, ...stamp(T.library) },
        ],
      })
      await tx.gradeRuleStep.createMany({
        data: [
          { id: result.gradeStepIds.back52to54, ruleId: result.gradeRuleIds.jacket, pointOfMeasureId: result.pointIds.backLen, fromSize: '52', toSize: '54', increment: '1.00', ...stamp(T.library) },
          { id: result.gradeStepIds.back50to52, ruleId: result.gradeRuleIds.jacket, pointOfMeasureId: result.pointIds.backLen, fromSize: '50', toSize: '52', increment: '1.00', ...stamp(T.library) },
          { id: result.gradeStepIds.chestStandard, ruleId: result.gradeRuleIds.jacket, pointOfMeasureId: result.pointIds.chestW, increment: '2.00', ...stamp(T.library) },
          { id: result.gradeStepIds.sleeveStandard, ruleId: result.gradeRuleIds.jacket, pointOfMeasureId: result.pointIds.sleeveLen, increment: '0.50', ...stamp(T.library) },
          { id: id('sizes:grade-step:TRS:INSEAM_G:52R:52L'), ruleId: result.gradeRuleIds.trousers, pointOfMeasureId: result.pointIds.inseamG, fromSize: '52R', toSize: '52L', increment: '4.00', ...stamp(T.library) },
          { id: id('sizes:grade-step:TRS:WAIST_W:52R:50R'), ruleId: result.gradeRuleIds.trousers, pointOfMeasureId: result.pointIds.waistW, fromSize: '52R', toSize: '50R', increment: '-1.00', ...stamp(T.library) },
          { id: id('sizes:grade-step:TRS:WAIST_W:52R:50L'), ruleId: result.gradeRuleIds.trousers, pointOfMeasureId: result.pointIds.waistW, fromSize: '52R', toSize: '50L', increment: '-1.00', ...stamp(T.library) },
        ],
      })

      // --- protectors the placements name ---------------------------------------------------------------------------------
      const protector = (rowId: string, code: string, name: string): Prisma.ItemCreateManyInput => ({
        id: rowId,
        code,
        name,
        kind: ItemKind.PROTECTOR,
        sourcing: ItemSourcing.BUY,
        tracking: ItemTracking.LOT,
        baseUom: Uom.PCS,
        purchaseUom: Uom.PCS,
        consumptionUom: Uom.PCS,
        isPpeComponent: true,
        ...stamp(T.library),
      })
      await tx.item.createMany({
        data: [protector(result.protectorIds.back, 'SEED-PRO-320', 'Seed back protector level 1'), protector(result.protectorIds.limb, 'SEED-PRO-330', 'Seed limb protector level 1')],
      })

      // --- SEED-JKT-01 revision 1 (DRAFT): specs, placement, the BOM lines that follow a measure --------------------------
      const jacketDraft = await tx.styleRevision.findUnique({ where: { id: result.jacket.revisionId }, select: { status: true } })
      if (jacketDraft?.status === StyleRevisionStatus.DRAFT) {
        const { styleId, revisionId } = result.jacket
        await tx.measurementSpec.create({ data: { id: result.jacket.archivedSpecId, styleId, revisionId, baseSize: '50', status: MeasurementSpecStatus.ARCHIVED, ...stamp(T.library) }, select: { id: true } })
        await tx.measurementSpec.create({ data: { id: result.jacket.specId, styleId, revisionId, baseSize: '52', gradeRuleId: result.gradeRuleIds.jacket, ...stamp(T.spec) }, select: { id: true } })
        const cells: { point: string; seq: number; key: string; values: Record<'50' | '52' | '54', string> }[] = [
          { point: result.pointIds.chestW, seq: 1, key: 'CHEST_W', values: { '50': '56.00', '52': '58.00', '54': '60.00' } },
          { point: result.pointIds.backLen, seq: 2, key: 'BACK_LEN', values: { '50': '72.00', '52': '73.00', '54': '74.00' } },
          { point: result.pointIds.sleeveLen, seq: 3, key: 'SLEEVE_LEN', values: { '50': '63.50', '52': '64.00', '54': '65.00' } },
        ]
        await tx.measurementSpecValue.createMany({
          data: cells.flatMap((cell) =>
            (['50', '52', '54'] as const).map((size) => {
              const rowId = cell.key === 'BACK_LEN' && size === '52' ? result.specValueIds.back52 : cell.key === 'SLEEVE_LEN' && size === '54' ? result.specValueIds.sleeve54 : id(`sizes:spec-value:JKT-01:1:${cell.key}:${size}`)
              // The base size is typed; the others graded, but the sleeve of 54 typed over its graded 64.50.
              const source = size === '52' || rowId === result.specValueIds.sleeve54 ? MeasurementValueSource.TYPED : MeasurementValueSource.GRADED
              return { id: rowId, revisionId, specId: result.jacket.specId, pointOfMeasureId: cell.point, size, seq: cell.seq, nominal: cell.values[size], toleranceMinus: '1.00', tolerancePlus: '1.00', source, ...stamp(T.spec) }
            }),
          ),
        })
        await tx.protectorPlacement.createMany({
          data: [
            { id: result.placementIds.shoulder, styleId, revisionId, seq: 1, pocket: ProtectorPocket.SHOULDER, protectorItemId: result.protectorIds.shoulder, standard: 'EN 1621-1:2012', level: '2', sizes: ['50', '52'], positionNote: 'Left and right, centred on the shoulder seam.', ...stamp(T.spec) },
            { id: result.placementIds.elbow, styleId, revisionId, seq: 2, pocket: ProtectorPocket.ELBOW, protectorItemId: result.protectorIds.limb, standard: 'EN 1621-1:2012', level: '1', positionNote: 'Left and right, 2 cm above the elbow seam.', ...stamp(T.spec) },
            { id: result.placementIds.back, styleId, revisionId, seq: 3, pocket: ProtectorPocket.BACK, protectorItemId: result.protectorIds.back, standard: 'EN 1621-2:2014', level: '1', ...stamp(T.spec) },
          ],
        })
        await tx.bomLine.update({ where: { id: result.bomLineIds.leather }, data: { mtmScalePointId: result.templatePointIds.chest, mtmScaleFactor: '1.0000' }, select: { id: true } })
        await tx.bomLine.update({ where: { id: result.bomLineIds.lining }, data: { mtmScalePointId: result.templatePointIds.chest, mtmScaleFactor: '0.8000' }, select: { id: true } })
      }

      // --- SEED-TRS-01: a trousers style on the fit scale, revision 1 released with its approved spec ---------------------
      const { styleId: trousersId, revisionId: trousersRevision, specId: trousersSpec } = result.trousers
      await tx.style.create({
        data: {
          id: trousersId,
          code: 'SEED-TRS-01',
          name: 'Seed leather trousers',
          nameI18n: words('Pantaloni in pelle seed', 'Seed leather trousers'),
          productType: ProductType.TROUSERS,
          season: 'FW27',
          sizeScaleId: result.fitScaleId,
          sizes: ['50R', '50L', '52R', '52L'],
          baseSize: '52R',
          ppeCategory: PpeCategory.CATEGORY_II,
          ppeStandard: 'EN 17092-4:2020',
          ppeClass: 'A',
          status: StyleStatus.ACTIVE,
          ...stamp(T.library),
        },
        select: { id: true },
      })
      await tx.styleRevision.create({ data: { id: trousersRevision, styleId: trousersId, revision: 1, status: StyleRevisionStatus.DRAFT, changeNote: 'First revision.', ...stamp(T.spec) }, select: { id: true } })
      await tx.measurementSpec.create({ data: { id: trousersSpec, styleId: trousersId, revisionId: trousersRevision, baseSize: '52R', gradeRuleId: result.gradeRuleIds.trousers, ...stamp(T.spec) }, select: { id: true } })
      const trousersCells: { point: string; seq: number; key: string; values: Record<'50R' | '50L' | '52R' | '52L', string> }[] = [
        { point: result.pointIds.waistW, seq: 1, key: 'WAIST_W', values: { '50R': '42.00', '50L': '42.00', '52R': '43.00', '52L': '43.00' } },
        { point: result.pointIds.inseamG, seq: 2, key: 'INSEAM_G', values: { '50R': '80.00', '50L': '84.00', '52R': '81.00', '52L': '85.00' } },
      ]
      await tx.measurementSpecValue.createMany({
        data: trousersCells.flatMap((cell) =>
          (['50R', '50L', '52R', '52L'] as const).map((size) => ({
            id: cell.key === 'INSEAM_G' && size === '52R' ? result.specValueIds.released : id(`sizes:spec-value:TRS-01:1:${cell.key}:${size}`),
            revisionId: trousersRevision,
            specId: trousersSpec,
            pointOfMeasureId: cell.point,
            size,
            seq: cell.seq,
            nominal: cell.values[size],
            toleranceMinus: cell.key === 'WAIST_W' ? '0.50' : '1.00',
            tolerancePlus: cell.key === 'WAIST_W' ? '0.50' : '1.00',
            source: size === '52R' ? MeasurementValueSource.TYPED : MeasurementValueSource.GRADED,
            ...stamp(T.spec),
          })),
        ),
      })
      await tx.protectorPlacement.create({
        data: { id: result.placementIds.knee, styleId: trousersId, revisionId: trousersRevision, seq: 1, pocket: ProtectorPocket.KNEE, protectorItemId: result.protectorIds.limb, standard: 'EN 1621-1:2012', level: '1', positionNote: 'Left and right, adjustable in two heights.', ...stamp(T.spec) },
        select: { id: true },
      })
      await tx.measurementSpec.update({ where: { id: trousersSpec }, data: { status: MeasurementSpecStatus.APPROVED, approvedAt: T.approved, approvedById: actorId, updatedAt: T.approved }, select: { id: true } })
      await tx.styleRevision.update({ where: { id: trousersRevision }, data: { status: StyleRevisionStatus.RELEASED, releasedAt: T.released, releasedById: actorId, updatedAt: T.released }, select: { id: true } })

      // --- prepacks (PRD-055) ---------------------------------------------------------------------------------------------
      await tx.prepack.createMany({
        data: [
          { id: result.prepackIds.jacket, sizeScaleId: result.jacketScaleId, styleId: result.jacket.styleId, code: 'SEED-PP-JKT-7', name: 'Seed jacket pack of 7 (2-3-2)', ...stamp(T.library) },
          { id: result.prepackIds.colours, sizeScaleId: result.jacketScaleId, styleId: result.jacket.styleId, code: 'SEED-PP-JKT-COL', name: 'Seed jacket pack of 3, size 52 (2 black, 1 red)', ...stamp(T.library) },
          { id: result.prepackIds.scale, sizeScaleId: result.jacketScaleId, code: 'SEED-PP-EU-9', name: 'Seed EU pack of 9 (1-2-3-2-1)', ...stamp(T.library) },
          { id: result.prepackIds.archived, sizeScaleId: result.jacketScaleId, styleId: result.jacket.styleId, code: 'SEED-PP-JKT-OLD', name: 'Seed jacket pack of 2 (old)', ...stamp(T.library) },
        ],
      })
      const [blk, red] = result.jacket.colourwayIds as [string, string]
      await tx.prepackLine.createMany({
        data: [
          { id: result.prepackLineIds.jacket50, prepackId: result.prepackIds.jacket, size: '50', quantity: 2, ...stamp(T.library) },
          { id: id('sizes:prepack-line:JKT-7:52'), prepackId: result.prepackIds.jacket, size: '52', quantity: 3, ...stamp(T.library) },
          { id: id('sizes:prepack-line:JKT-7:54'), prepackId: result.prepackIds.jacket, size: '54', quantity: 2, ...stamp(T.library) },
          { id: result.prepackLineIds.colourBlk, prepackId: result.prepackIds.colours, size: '52', styleId: result.jacket.styleId, colourwayId: blk, quantity: 2, ...stamp(T.library) },
          { id: id('sizes:prepack-line:JKT-COL:52:RED'), prepackId: result.prepackIds.colours, size: '52', styleId: result.jacket.styleId, colourwayId: red, quantity: 1, ...stamp(T.library) },
          ...(['48', '50', '52', '54', '56'] as const).map((size, index) => ({ id: id(`sizes:prepack-line:EU-9:${size}`), prepackId: result.prepackIds.scale, size, quantity: [1, 2, 3, 2, 1][index] as number, ...stamp(T.library) })),
          { id: result.prepackLineIds.archived50, prepackId: result.prepackIds.archived, size: '50', quantity: 1, ...stamp(T.library) },
          { id: id('sizes:prepack-line:JKT-OLD:52'), prepackId: result.prepackIds.archived, size: '52', quantity: 1, ...stamp(T.library) },
        ],
      })
      await tx.prepack.update({ where: { id: result.prepackIds.archived }, data: { status: MasterStatus.ARCHIVED }, select: { id: true } })
    }),
  )
  return result
}
