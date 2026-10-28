import type { Prisma } from '../src/generated/prisma/client'
import {
  ItemKind,
  ItemSourcing,
  ItemTracking,
  PpeCategory,
  ProductType,
  StyleRevisionStatus,
  StyleStatus,
  Tannage,
  Uom,
  WorkCentreKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedParties } from './parties'

/**
 * The product seed, per tenant of seed/_core.ts: one made-up leather jacket style with everything the golden flow's
 * stage 02-style needs, written in the tenant's office scope, as the app does.
 *
 *   materials   leather (bought by the hide, counted and costed in ft², Cr VI tested, black and red), a mesh lining
 *               (rolls of metres, grey) and a shoulder protector, each with a made-up standard cost; the leather and
 *               protector come from the parties seed's supplier P2
 *   sizes       an EU jacket scale 48-56 with body measures; the style uses 50, 52, 54 (base 52)
 *   style       SEED-JKT-01, Category II PPE to EN 17092-3 class AA, for the brand P1, made-to-measure allowed (the
 *               JACKET measurement template, whose points match the parties seed's rider profiles)
 *   colourways  BLK and RED, so 2 x 3 = 6 SKUs
 *   revision 1  DRAFT: the leather in ft² per size with hide wastage and a colour per colourway, the lining in one
 *               colour, two protectors; a routing of cutting, sewing, final inspection and packing with standard minutes
 *
 * Every name and code is invented. Idempotent: rows are upserted with fixed times. The revision is left DRAFT (a
 * released revision's parts can never be written again, and the generated isolation tests copy a seeded part); when
 * another step has released it, its parts are left as they are.
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T08:00:00.000Z')

export interface ProductSeed {
  readonly styleId: string
  readonly revisionId: string
  readonly colourwayIds: readonly string[]
  readonly leatherId: string
  readonly protectorId: string
}

/** The style's size range and the leather (ft²) one jacket of each size takes, before wastage. */
const SIZES = [
  { code: '48', seq: 1, chest: ['92', '96'], height: ['164', '170'] },
  { code: '50', seq: 2, chest: ['96', '100'], height: ['170', '176'], leatherFt2: '43.0000' },
  { code: '52', seq: 3, chest: ['100', '104'], height: ['176', '182'], leatherFt2: '45.0000' },
  { code: '54', seq: 4, chest: ['104', '108'], height: ['182', '188'], leatherFt2: '47.5000' },
  { code: '56', seq: 5, chest: ['108', '112'], height: ['182', '188'] },
] as const

export async function seed(context: SeedContext): Promise<ProductSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the style's brand and the materials' supplier come from the parties seed.
  await seedParties(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const brandId = id('party:P1')
  const supplierId = id('party:P2')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }

  const colour = { BLK: id('product:colour:BLK'), RED: id('product:colour:RED'), GRY: id('product:colour:GRY') }
  const colours: (Prisma.ColourCreateManyInput & { id: string })[] = [
    { id: colour.BLK, code: 'SEED-BLK', name: 'Seed black', nameI18n: { it: 'Nero seed', en: 'Seed black' }, hex: '#1A1A1A', ...stamp },
    { id: colour.RED, code: 'SEED-RED', name: 'Seed red', nameI18n: { it: 'Rosso seed', en: 'Seed red' }, hex: '#B3122E', ...stamp },
    { id: colour.GRY, code: 'SEED-GRY', name: 'Seed grey', nameI18n: { it: 'Grigio seed', en: 'Seed grey' }, hex: '#8C8C8C', ...stamp },
  ]

  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const items: (Prisma.ItemCreateManyInput & { id: string })[] = [
    {
      id: item.leather,
      code: 'SEED-LEA-100',
      name: 'Seed cowhide 1.2 mm',
      nameI18n: { it: 'Pelle bovina seed 1,2 mm', en: 'Seed cowhide 1.2 mm' },
      kind: ItemKind.LEATHER,
      sourcing: ItemSourcing.BUY,
      tracking: ItemTracking.HIDE,
      baseUom: Uom.FT2,
      // Delivered by the hide: a hide of this made-up article measures 52.5 ft² on average.
      purchaseUom: Uom.HIDE,
      purchaseFactor: '52.50000000',
      consumptionUom: Uom.FT2,
      consumptionFactor: '1',
      defaultSupplierId: supplierId,
      supplierArticleCode: 'SEED-ART-100',
      standardCost: '4.200000',
      animalSpecies: 'bovine',
      tannage: Tannage.CHROME,
      grade: 'A',
      finish: 'full grain',
      thicknessMinMm: '1.10',
      thicknessMaxMm: '1.30',
      animalOrigin: true,
      requiresCrViTest: true,
      crViLimitMgKg: '3.000',
      ...stamp,
    },
    {
      id: item.lining,
      code: 'SEED-LIN-200',
      name: 'Seed mesh lining',
      kind: ItemKind.LINING,
      sourcing: ItemSourcing.BUY,
      tracking: ItemTracking.LOT,
      baseUom: Uom.M,
      purchaseUom: Uom.ROLL,
      purchaseFactor: '50.00000000',
      consumptionUom: Uom.M,
      consumptionFactor: '1',
      standardCost: '3.100000',
      composition: [{ fibre: 'polyester', percent: '100' }],
      ...stamp,
    },
    {
      id: item.protector,
      code: 'SEED-PRO-300',
      name: 'Seed shoulder protector level 2',
      kind: ItemKind.PROTECTOR,
      sourcing: ItemSourcing.BUY,
      tracking: ItemTracking.LOT,
      baseUom: Uom.PCS,
      purchaseUom: Uom.PCS,
      consumptionUom: Uom.PCS,
      defaultSupplierId: supplierId,
      supplierArticleCode: 'SEED-ART-300',
      standardCost: '6.500000',
      isPpeComponent: true,
      ...stamp,
    },
  ]

  const itemColour = { leatherBLK: id('product:item-colour:leather:BLK'), leatherRED: id('product:item-colour:leather:RED'), liningGRY: id('product:item-colour:lining:GRY') }
  const itemColours: (Prisma.ItemColourCreateManyInput & { id: string })[] = [
    { id: itemColour.leatherBLK, itemId: item.leather, code: 'BLK', name: 'Black', colourId: colour.BLK, supplierColourCode: 'S-001', ...stamp },
    { id: itemColour.leatherRED, itemId: item.leather, code: 'RED', name: 'Red', colourId: colour.RED, supplierColourCode: 'S-002', ...stamp },
    { id: itemColour.liningGRY, itemId: item.lining, code: 'GRY', name: 'Grey', colourId: colour.GRY, supplierColourCode: 'M-07', ...stamp },
  ]

  const scaleId = id('product:size-scale:EU-JKT')
  const scale: Prisma.SizeScaleCreateManyInput & { id: string } = { id: scaleId, code: 'SEED-EU-JKT', name: 'Seed EU jacket 48-56', ...stamp }
  const sizes: (Prisma.SizeCreateManyInput & { id: string })[] = SIZES.map((size) => ({
    id: id(`product:size:EU-JKT:${size.code}`),
    scaleId,
    code: size.code,
    seq: size.seq,
    bodyMeasures: {
      chest: { min: size.chest[0], max: size.chest[1], unit: 'cm' },
      height: { min: size.height[0], max: size.height[1], unit: 'cm' },
    },
    ...stamp,
  }))

  const templateId = id('product:measurement-template:JACKET')
  const template: Prisma.MeasurementTemplateCreateManyInput & { id: string } = {
    id: templateId,
    code: 'JACKET',
    name: 'Seed jacket measures',
    productType: ProductType.JACKET,
    instructions: 'Measure over a thin base layer, arms relaxed.',
    ...stamp,
  }
  const points: (Prisma.MeasurementPointCreateManyInput & { id: string })[] = [
    { id: id('product:measurement-point:JACKET:chest'), templateId, code: 'chest', name: 'Chest', seq: 1, minValue: '70.00', maxValue: '150.00', howTo: 'Around the fullest part of the chest.', ...stamp },
    { id: id('product:measurement-point:JACKET:waist'), templateId, code: 'waist', name: 'Waist', seq: 2, minValue: '60.00', maxValue: '140.00', howTo: 'Around the natural waist.', ...stamp },
    { id: id('product:measurement-point:JACKET:sleeve'), templateId, code: 'sleeve', name: 'Sleeve', seq: 3, minValue: '50.00', maxValue: '80.00', howTo: 'Shoulder point to wrist, arm bent forward.', ...stamp },
  ]

  const operation = { cut: id('product:operation:CUT'), sew: id('product:operation:SEW'), qc: id('product:operation:QC'), pack: id('product:operation:PACK') }
  const operations: (Prisma.OperationCreateManyInput & { id: string })[] = [
    { id: operation.cut, code: 'SEED-CUT-LEA', name: 'Cut leather panels', nameI18n: { it: 'Taglio pelle', en: 'Cut leather panels' }, workCentreKind: WorkCentreKind.CUTTING, machineType: 'cutting table', skill: 'cutter', standardMinutes: '14.000', ...stamp },
    { id: operation.sew, code: 'SEED-SEW-ASM', name: 'Sew and assemble the body', nameI18n: { it: 'Cucitura e montaggio', en: 'Sew and assemble the body' }, workCentreKind: WorkCentreKind.SEWING, machineType: 'post-bed', skill: 'machinist', standardMinutes: '96.500', ...stamp },
    { id: operation.qc, code: 'SEED-FIN-QC', name: 'Final inspection', workCentreKind: WorkCentreKind.INSPECTION, standardMinutes: '8.000', ...stamp },
    { id: operation.pack, code: 'SEED-PACK', name: 'Pack', workCentreKind: WorkCentreKind.PACKING, standardMinutes: '3.500', ...stamp },
  ]

  const styleId = id('product:style:JKT-01')
  const range = ['50', '52', '54']
  const style: Prisma.StyleCreateManyInput & { id: string } = {
    id: styleId,
    code: 'SEED-JKT-01',
    name: 'Seed leather jacket',
    nameI18n: { it: 'Giacca in pelle seed', en: 'Seed leather jacket' },
    description: 'A made-up touring jacket for the seed.',
    productType: ProductType.JACKET,
    season: 'FW27',
    brandPartyId: brandId,
    sizeScaleId: scaleId,
    sizes: range,
    baseSize: '52',
    ppeCategory: PpeCategory.CATEGORY_II,
    ppeStandard: 'EN 17092-3:2020',
    ppeClass: 'AA',
    mtmAllowed: true,
    measurementTemplateId: templateId,
    status: StyleStatus.DRAFT,
    ...stamp,
  }
  const colourway = { BLK: id('product:colourway:JKT-01:BLK'), RED: id('product:colourway:JKT-01:RED') }
  const colourways: (Prisma.ColourwayCreateManyInput & { id: string })[] = [
    { id: colourway.BLK, styleId, code: 'BLK', name: 'Black', colourId: colour.BLK, description: 'Black leather, grey lining.', ...stamp },
    { id: colourway.RED, styleId, code: 'RED', name: 'Red', colourId: colour.RED, description: 'Red leather, grey lining, black stitching.', ...stamp },
  ]
  const variants: (Prisma.VariantCreateManyInput & { id: string })[] = (['BLK', 'RED'] as const).flatMap((code) =>
    range.map((size) => ({ id: id(`product:variant:JKT-01:${code}:${size}`), styleId, colourwayId: colourway[code], size, sku: `SEED-JKT-01-${code}-${size}`, ...stamp })),
  )

  const revisionId = id('product:revision:JKT-01:1')
  // Created DRAFT; its status is never written again here (the product module releases it).
  const revision = { styleId, revision: 1, changeNote: 'First revision.', plannedHideYieldPct: '75.0000', ...stamp }
  const line = { leather: id('product:bom:JKT-01:1:10'), lining: id('product:bom:JKT-01:1:20'), protector: id('product:bom:JKT-01:1:30') }
  const bomLines: (Prisma.BomLineCreateManyInput & { id: string })[] = [
    {
      id: line.leather,
      styleId,
      revisionId,
      seq: 10,
      itemId: item.leather,
      placement: 'Outer shell',
      qty: '45.0000',
      uom: Uom.FT2,
      wastagePct: '12.0000',
      sizeDependent: true,
      colourDependent: true,
      ...stamp,
    },
    { id: line.lining, styleId, revisionId, seq: 20, itemId: item.lining, placement: 'Body lining', qty: '1.8000', uom: Uom.M, wastagePct: '5.0000', itemColourId: itemColour.liningGRY, ...stamp },
    { id: line.protector, styleId, revisionId, seq: 30, itemId: item.protector, placement: 'Shoulder pockets', qty: '2.0000', uom: Uom.PCS, ...stamp },
  ]
  const bomSizes: (Prisma.BomLineSizeCreateManyInput & { id: string })[] = SIZES.filter((size) => 'leatherFt2' in size).map((size) => ({
    id: id(`product:bom-size:JKT-01:1:10:${size.code}`),
    revisionId,
    bomLineId: line.leather,
    size: size.code,
    qty: 'leatherFt2' in size ? size.leatherFt2 : '0',
    ...stamp,
  }))
  const bomColours: (Prisma.BomLineColourCreateManyInput & { id: string })[] = [
    { id: id('product:bom-colour:JKT-01:1:10:BLK'), styleId, revisionId, bomLineId: line.leather, itemId: item.leather, colourwayId: colourway.BLK, itemColourId: itemColour.leatherBLK, ...stamp },
    { id: id('product:bom-colour:JKT-01:1:10:RED'), styleId, revisionId, bomLineId: line.leather, itemId: item.leather, colourwayId: colourway.RED, itemColourId: itemColour.leatherRED, ...stamp },
  ]
  const routing: (Prisma.RoutingOperationCreateManyInput & { id: string })[] = operations.map((op, index) => ({
    id: id(`product:routing:JKT-01:1:${op.code}`),
    styleId,
    revisionId,
    seq: (index + 1) * 10,
    operationId: op.id,
    code: op.code,
    name: op.name,
    nameI18n: op.nameI18n,
    workCentreKind: op.workCentreKind,
    standardMinutes: op.standardMinutes,
    ...stamp,
  }))

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: rowId, ...data } of colours) await tx.colour.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of items) await tx.item.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of itemColours) await tx.itemColour.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      {
        const { id: rowId, ...data } = scale
        await tx.sizeScale.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      }
      for (const { id: rowId, ...data } of sizes) await tx.size.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      {
        const { id: rowId, ...data } = template
        await tx.measurementTemplate.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      }
      for (const { id: rowId, ...data } of points) await tx.measurementPoint.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of operations) await tx.operation.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      {
        const { id: rowId, ...data } = style
        await tx.style.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      }
      for (const { id: rowId, ...data } of colourways) await tx.colourway.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of variants) await tx.variant.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })

      // A released revision's parts are frozen for every login: write them only while the revision is a draft.
      const existing = await tx.styleRevision.findUnique({ where: { id: revisionId }, select: { status: true } })
      if (existing && existing.status !== StyleRevisionStatus.DRAFT) return
      if (existing) await tx.styleRevision.update({ where: { id: revisionId }, data: revision, select: { id: true } })
      else await tx.styleRevision.create({ data: { id: revisionId, status: StyleRevisionStatus.DRAFT, ...revision }, select: { id: true } })
      for (const { id: rowId, ...data } of bomLines) await tx.bomLine.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of bomSizes) await tx.bomLineSize.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of bomColours) await tx.bomLineColour.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of routing) await tx.routingOperation.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
    }),
  )
  return { styleId, revisionId, colourwayIds: [colourway.BLK, colourway.RED], leatherId: item.leather, protectorId: item.protector }
}
