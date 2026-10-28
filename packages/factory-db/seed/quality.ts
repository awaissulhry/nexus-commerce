import { createHash } from 'node:crypto'
import {
  CertificateStatus,
  DefectClass,
  GarmentSerialStatus,
  GarmentTracking,
  InspectionStatus,
  LabelTemplateStatus,
  PartyTaxMode,
  PpeCategory,
  PpeRegisterKind,
  ProductType,
  SalesLineKind,
  SalesOrderStatus,
  StyleRevisionStatus,
  StyleStatus,
  WorkCentreKind,
  WorkOrderKind,
  WorkOrderStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The quality seed, per tenant of seed/_core.ts: the golden flow's stages 13a-labels and 13b-release on plant A1, written
 * as the app does: the floor inspector's rows in A1's floor scope (signed in as the plant's team leader, who made none of
 * the garments), the serials of the final operation in A1's floor scope (the operator), the office's rows in the tenant's
 * office scope.
 *
 *   certificate   an EN 17092-3 class A certificate held by the brand P1 (VALID), covering the production seed's
 *                 SEED-JKT-02 and this seed's SEED-JKT-03 in every colourway and size.
 *   serial style  SEED-JKT-03 (Q31 (b): garmentTracking SERIAL), colourway BLK, its ACTIVE label template and revision 1
 *                 RELEASED with one routing step (final inspection); order SEED-SO-0003 for P1 (3 x BLK 52); work order
 *                 WO-0003 of one cell, released with batch SEED-BT-0003; two serials of the final operation.
 *   WO-0001       (the production seed's, BATCH-tracked): an OPEN inspection (sample begun, one defect) and a PASSED one
 *                 (lot of 5, one minor defect within the plan); releases from it of BLK 50 x1, BLK 52 x2, RED 52 x1.
 *   WO-0003       a PASSED inspection (lot of 2) and a release of one garment, which names the second serial.
 *   register      one OPEN complaint in the PPE register about SEED-JKT-02, batch SEED-BT-0001, from P1.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a decided inspection never changes and takes no defect, a cell never gets more releases than pieces nor an
 * inspection more than its lot, a cell never gets more live serials than pieces, a serial starts MADE, a register entry
 * starts OPEN. So the OPEN inspection, its defect, the release of WO-0003 (1 of the cell's 3, 1 of the lot's 2), the
 * MADE serial (2 of the cell's 3) and the register entry get ids that start with eight zeros, and the rows this seed
 * adds to other modules' tables (style, revision, label, certificate, order, work order …) ids that start with eight
 * f's (all still derived from the namespace), so those tables' first rows stay the ones their seeds chose.
 *
 * Every name, number and value is invented. Idempotent: each step runs once and is skipped when its rows exist (a
 * released revision or work order is frozen, a decided inspection and a release never change).
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-11-08T08:00:00.000Z'),
  revisionReleased: new Date('2026-11-08T09:00:00.000Z'),
  ordered: new Date('2026-11-12T09:00:00.000Z'),
  planned: new Date('2026-11-15T09:00:00.000Z'),
  woReleased: new Date('2026-11-15T11:00:00.000Z'),
  serialled: new Date('2026-11-19T15:00:00.000Z'),
  inspected: new Date('2026-11-20T08:00:00.000Z'),
  decided: new Date('2026-11-20T09:30:00.000Z'),
  released: new Date('2026-11-20T11:00:00.000Z'),
  reported: new Date('2026-11-21T10:00:00.000Z'),
} as const
const DAY = { orderDate: new Date('2026-11-12T00:00:00.000Z'), due: new Date('2026-12-11T00:00:00.000Z') } as const

/** The garment and label checklist as a floor inspector checks it (QHS-050). */
const CHECKLIST = ['EN17092_CLASS_LABEL', 'SIZE_LABEL', 'CE_MARK', 'CARE_LABEL', 'FIBRE_COMPOSITION', 'ANIMAL_ORIGIN_PHRASE', 'ARMOUR_FITTED', 'ZIPS', 'USER_INFORMATION', 'PACKAGING']

export interface QualitySeed {
  readonly production: ProductionSeed
  /** The certificate that covers SEED-JKT-02 and SEED-JKT-03. */
  readonly certificateId: string
  /** The serial-tracked style, its order and order line, its work order (WO-0003) and that one cell. */
  readonly serialStyleId: string
  readonly serialRevisionId: string
  readonly serialSalesOrderId: string
  readonly serialSalesOrderLineId: string
  readonly serialWorkOrderId: string
  readonly serialCellId: string
  /** WO-0001's OPEN inspection with its defect, and its PASSED one; WO-0003's PASSED one. */
  readonly openInspectionId: string
  readonly openDefectId: string
  readonly passedInspectionId: string
  readonly serialInspectionId: string
  /** WO-0001's releases by cell, and WO-0003's release. */
  readonly releaseIds: { readonly 'BLK-50': string; readonly 'BLK-52': string; readonly 'RED-52': string }
  readonly serialReleaseId: string
  /** WO-0003's serials: MADE, and RELEASED by its release. */
  readonly serialIds: readonly [string, string]
  readonly registerEntryId: string
  /** Plant A1's team leader, the floor inspector here (made none of WO-0001's garments). */
  readonly inspectorId: string
}

export async function seed(context: SeedContext): Promise<QualitySeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the work orders this seed inspects come from the production seed (which
  // runs the seeds before it), so run it first (idempotent).
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const brandId = id('party:P1')
  const operatorId = id('worker:A1:operator')
  const inspectorId = id('worker:A1:lead')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const maker = { makerPartyId: brandId, makerName: 'Seed Customer One S.r.l.', makerAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy' }

  const certificateId = lastId('quality:certificate:JKT-02')
  const serialStyleId = lastId('quality:style:JKT-03')
  const serialColourwayId = lastId('quality:colourway:JKT-03:BLK')
  const serialLabelId = lastId('quality:label:JKT-03:1')
  const serialRevisionId = lastId('quality:revision:JKT-03:1')
  const serialRoutingId = lastId('quality:routing:JKT-03:1:10')
  const serialSalesOrderId = lastId('quality:sales-order:SO-0003')
  const serialSalesOrderLineId = lastId('quality:sales-order:SO-0003:10')
  const serialWorkOrderId = lastId('quality:work-order:WO-0003')
  const serialCellId = lastId('quality:WO-0003:cell:BLK:52')
  const serialOperationId = lastId('quality:WO-0003:operation:10')

  // --- the serial-tracked style, its label and released revision ------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const style = {
        code: 'SEED-JKT-03',
        name: 'Seed serial jacket',
        nameI18n: { it: 'Giacca seriale seed', en: 'Seed serial jacket' },
        description: 'A made-up jacket whose garments each get a serial (Q31 (b)).',
        productType: ProductType.JACKET,
        season: 'FW27',
        brandPartyId: brandId,
        sizeScaleId: id('product:size-scale:EU-JKT'),
        sizes: ['50', '52', '54'],
        baseSize: '52',
        ppeCategory: PpeCategory.CATEGORY_II,
        ppeStandard: 'EN 17092-3:2020',
        ppeClass: 'A',
        garmentTracking: GarmentTracking.SERIAL,
        status: StyleStatus.ACTIVE,
        ...stamp(T.setup),
      }
      await tx.style.upsert({ where: { id: serialStyleId }, create: { id: serialStyleId, ...style }, update: style, select: { id: true } })
      const colourway = { styleId: serialStyleId, code: 'BLK', name: 'Black', colourId: id('product:colour:BLK'), ...stamp(T.setup) }
      await tx.colourway.upsert({ where: { id: serialColourwayId }, create: { id: serialColourwayId, ...colourway }, update: colourway, select: { id: true } })
      const label = {
        code: 'SEED-LBL-JKT-03',
        revision: 1,
        name: 'Seed serial jacket garment label',
        styleId: serialStyleId,
        status: LabelTemplateStatus.ACTIVE,
        languages: ['it', 'en'],
        ...maker,
        composition: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }],
        animalOriginPhrase: true,
        care: [{ symbol: 'wash-not' }, { symbol: 'iron-not' }],
        layout: { fields: ['ceMark', 'maker', 'model', 'batchOrSerial', 'size', 'bodyMeasures', 'pictogram', 'class', 'standard', 'composition', 'care'] },
        widthMm: '50.00',
        heightMm: '80.00',
        ...stamp(T.setup),
      }
      await tx.labelTemplate.upsert({ where: { id: serialLabelId }, create: { id: serialLabelId, ...label }, update: label, select: { id: true } })

      // A released revision and its parts are frozen for every login: build it once, as a draft, then release it.
      if (await tx.styleRevision.findUnique({ where: { id: serialRevisionId }, select: { id: true } })) return
      await tx.styleRevision.create({
        data: { id: serialRevisionId, styleId: serialStyleId, revision: 1, status: StyleRevisionStatus.DRAFT, changeNote: 'First revision.', labelTemplateId: serialLabelId, ...stamp(T.setup) },
        select: { id: true },
      })
      await tx.routingOperation.create({
        data: {
          id: serialRoutingId,
          styleId: serialStyleId,
          revisionId: serialRevisionId,
          seq: 10,
          operationId: id('product:operation:QC'),
          code: 'SEED-FIN-QC',
          name: 'Final inspection',
          workCentreKind: WorkCentreKind.INSPECTION,
          standardMinutes: '8.000',
          ...stamp(T.setup),
        },
        select: { id: true },
      })
      await tx.styleRevision.update({
        where: { id: serialRevisionId },
        data: { status: StyleRevisionStatus.RELEASED, releasedAt: T.revisionReleased, releasedById: actorId, updatedAt: T.revisionReleased },
        select: { id: true },
      })
    }),
  )

  // --- the certificate that covers both jackets -----------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const certificate = {
        holderPartyId: brandId,
        standard: 'EN 17092-3:2020',
        ppeClass: 'A',
        number: 'SEED-CERT-0003',
        notifiedBodyName: 'Seed Notified Body',
        notifiedBodyNumber: '0000',
        modelReference: 'SEED-JKT-02, SEED-JKT-03',
        validFrom: new Date('2026-01-15T00:00:00.000Z'),
        validTo: new Date('2031-01-14T00:00:00.000Z'),
        status: CertificateStatus.VALID,
        statusChangedAt: T.setup,
        ...stamp(T.setup),
      }
      await tx.certificate.upsert({ where: { id: certificateId }, create: { id: certificateId, ...certificate }, update: certificate, select: { id: true } })
      for (const [key, styleId] of [
        ['JKT-02', production.styleId],
        ['JKT-03', serialStyleId],
      ] as const) {
        const coverageId = lastId(`quality:coverage:${key}`)
        const coverage = { certificateId, styleId, ...stamp(T.setup) }
        await tx.certificateCoverage.upsert({ where: { id: coverageId }, create: { id: coverageId, ...coverage }, update: coverage, select: { id: true } })
      }
    }),
  )

  // --- the order and the work order of the serial-tracked jacket -------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.salesOrder.findUnique({ where: { id: serialSalesOrderId }, select: { id: true } })) return
      const net = 3 * 42_000
      const vat = (net * 22) / 100
      await tx.salesOrder.create({
        data: {
          id: serialSalesOrderId,
          companyId: companyA,
          partyId: brandId,
          number: 'SEED-SO-0003',
          customerRef: 'SEED-PO-91',
          status: SalesOrderStatus.CONFIRMED,
          orderDate: DAY.orderDate,
          taxMode: PartyTaxMode.IT_B2B,
          billTo: { legalName: 'Seed Customer One S.r.l.', kind: 'ORGANISATION', country: 'IT', taxMode: 'IT_B2B', address: { line1: 'Via Esempio 10', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' } },
          shipTo: { name: 'Seed Racing workshop', line1: 'Via Esempio 12', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
          promiseDate: DAY.due,
          originalPromiseDate: DAY.due,
          netAmount: net,
          vatAmount: vat,
          grossAmount: net + vat,
          ...stamp(T.ordered),
        },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: {
          id: serialSalesOrderLineId,
          companyId: companyA,
          orderId: serialSalesOrderId,
          partyId: brandId,
          seq: 10,
          kind: SalesLineKind.SIZE_GRID,
          styleId: serialStyleId,
          styleRevisionId: serialRevisionId,
          colourwayId: serialColourwayId,
          description: 'SEED-JKT-03 BLK',
          quantity: 3,
          unitPrice: '420.000000',
          netAmount: net,
          vatRatePct: '22.00',
          vatAmount: vat,
          siteId: siteA,
          ...stamp(T.ordered),
        },
        select: { id: true },
      })
      await tx.salesOrderLineSize.create({
        data: { id: lastId('quality:sales-order:SO-0003:BLK:52'), lineId: serialSalesOrderLineId, partyId: brandId, size: '52', quantity: 3, ...stamp(T.ordered) },
        select: { id: true },
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrder.findUnique({ where: { id: serialWorkOrderId }, select: { id: true } })) return
      await tx.workOrder.create({
        data: { id: serialWorkOrderId, companyId: companyA, siteId: siteA, number: 'SEED-WO-0003', kind: WorkOrderKind.SIZE_GRID, styleId: serialStyleId, styleRevisionId: serialRevisionId, dueDate: DAY.due, ...stamp(T.planned) },
        select: { id: true },
      })
      await tx.workOrderSize.create({
        data: {
          id: serialCellId,
          siteId: siteA,
          workOrderId: serialWorkOrderId,
          styleId: serialStyleId,
          colourwayId: serialColourwayId,
          size: '52',
          quantity: 3,
          salesOrderLineId: serialSalesOrderLineId,
          partyId: brandId,
          ...stamp(T.planned),
        },
        select: { id: true },
      })
      await tx.workOrderOperation.create({
        data: {
          id: serialOperationId,
          siteId: siteA,
          workOrderId: serialWorkOrderId,
          styleRevisionId: serialRevisionId,
          seq: 10,
          routingSeq: 10,
          code: 'SEED-FIN-QC',
          name: 'Final inspection',
          standardMinutes: '8.000',
          workCentreId: id('site:A1:work-centre:QC'),
          ...stamp(T.planned),
        },
        select: { id: true },
      })
      await tx.workOrder.update({
        where: { id: serialWorkOrderId },
        data: { status: WorkOrderStatus.RELEASED, labelTemplateId: serialLabelId, batchNumber: 'SEED-BT-0003', releasedAt: T.woReleased, releasedById: actorId, updatedAt: T.woReleased },
        select: { id: true },
      })
    }),
  )

  // --- the serials of the final operation (the floor) -----------------------------------------------------------------
  const serialIds = [firstId('quality:serial:WO-0003:1'), id('quality:serial:WO-0003:2')] as const
  await db.withScope({ audience: 'floor', tenantId, actorId: operatorId, siteId: siteA }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.garmentSerial.findUnique({ where: { id: serialIds[0] }, select: { id: true } })) return
      await tx.garmentSerial.createMany({
        data: serialIds.map((serialId, index) => ({
          id: serialId,
          siteId: siteA,
          workOrderId: serialWorkOrderId,
          workOrderSizeId: serialCellId,
          serial: `SEED-SN-000${index + 1}`,
          ...stamp(T.serialled, operatorId),
        })),
      })
    }),
  )

  // --- the inspections (the floor inspector) --------------------------------------------------------------------------
  const openInspectionId = firstId('quality:inspection:WO-0001:1')
  const openDefectId = firstId('quality:inspection:WO-0001:1:MINOR:THREAD-END')
  const passedInspectionId = id('quality:inspection:WO-0001:2')
  const serialInspectionId = id('quality:inspection:WO-0003:1')
  const cell = production.cellIds
  const inspector = { audience: 'floor' as const, tenantId, actorId: inspectorId, siteId: siteA }
  const plan = { inspectionLevel: 'II', aqlMajor: '2.500', aqlMinor: '4.000' }
  const checked = CHECKLIST.map((code) => ({ code, ok: true, note: null }))
  /** The SHA-256 of a made-up signed decision. */
  const signature = (key: string): string => createHash('sha256').update(`seed signed decision ${key} (${namespace})`).digest('hex')

  await db.withScope(inspector, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.inspection.findUnique({ where: { id: openInspectionId }, select: { id: true } })) return
      await tx.inspection.create({
        data: {
          id: openInspectionId,
          companyId: companyA,
          siteId: siteA,
          workOrderId: production.workOrderId,
          lotSize: 2,
          sampleSize: 2,
          ...plan,
          acceptMajor: 0,
          acceptMinor: 0,
          checklist: checked.slice(0, 3),
          inspectorWorkerId: inspectorId,
          note: 'The last two garments, sample begun.',
          ...stamp(T.inspected, inspectorId),
        },
        select: { id: true },
      })
      await tx.inspectionDefect.create({
        data: {
          id: openDefectId,
          siteId: siteA,
          workOrderId: production.workOrderId,
          inspectionId: openInspectionId,
          defectClass: DefectClass.MINOR,
          code: 'THREAD-END',
          description: 'A thread end left at the collar.',
          quantity: 1,
          workOrderSizeId: cell['BLK-54'],
          ...stamp(T.inspected, inspectorId),
        },
        select: { id: true },
      })
    }),
  )
  await db.withScope(inspector, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.inspection.findUnique({ where: { id: passedInspectionId }, select: { id: true } })) return
      await tx.inspection.create({
        data: {
          id: passedInspectionId,
          companyId: companyA,
          siteId: siteA,
          workOrderId: production.workOrderId,
          lotSize: 5,
          sampleSize: 3,
          ...plan,
          acceptMajor: 0,
          acceptMinor: 1,
          inspectorWorkerId: inspectorId,
          ...stamp(T.inspected, inspectorId),
        },
        select: { id: true },
      })
      await tx.inspectionDefect.create({
        data: {
          id: id('quality:inspection:WO-0001:2:MINOR:LOOSE-THREAD'),
          siteId: siteA,
          workOrderId: production.workOrderId,
          inspectionId: passedInspectionId,
          defectClass: DefectClass.MINOR,
          code: 'LOOSE-THREAD',
          description: 'A loose thread on a sleeve seam.',
          quantity: 1,
          workOrderSizeId: cell['BLK-52'],
          ...stamp(T.inspected, inspectorId),
        },
        select: { id: true },
      })
      await tx.inspection.update({
        where: { id: passedInspectionId },
        data: { checklist: checked, status: InspectionStatus.PASSED, decidedAt: T.decided, signatureSha256: signature('WO-0001:2'), updatedAt: T.decided },
        select: { id: true },
      })
    }),
  )
  await db.withScope(inspector, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.inspection.findUnique({ where: { id: serialInspectionId }, select: { id: true } })) return
      await tx.inspection.create({
        data: {
          id: serialInspectionId,
          companyId: companyA,
          siteId: siteA,
          workOrderId: serialWorkOrderId,
          lotSize: 2,
          sampleSize: 2,
          ...plan,
          acceptMajor: 0,
          acceptMinor: 0,
          inspectorWorkerId: inspectorId,
          ...stamp(T.inspected, inspectorId),
        },
        select: { id: true },
      })
      await tx.inspection.update({
        where: { id: serialInspectionId },
        data: { checklist: checked, status: InspectionStatus.PASSED, decidedAt: T.decided, signatureSha256: signature('WO-0003:1'), updatedAt: T.decided },
        select: { id: true },
      })
    }),
  )

  // --- the releases (the office) --------------------------------------------------------------------------------------
  const releaseIds = { 'BLK-50': id('quality:release:WO-0001:BLK-50'), 'BLK-52': id('quality:release:WO-0001:BLK-52'), 'RED-52': id('quality:release:WO-0001:RED-52') } as const
  const serialReleaseId = firstId('quality:release:WO-0003:1')
  const signed = (key: string) => ({ releasedById: actorId, releasedAt: T.released, signatureSha256: signature(`release ${key}`), createdAt: T.released, createdById: actorId })
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.qualityRelease.findUnique({ where: { id: serialReleaseId }, select: { id: true } })) return
      await tx.qualityRelease.create({
        data: {
          id: serialReleaseId,
          companyId: companyA,
          siteId: siteA,
          workOrderId: serialWorkOrderId,
          workOrderSizeId: serialCellId,
          inspectionId: serialInspectionId,
          quantity: 1,
          certificateIds: [certificateId],
          ...signed('WO-0003:1'),
        },
        select: { id: true },
      })
      await tx.garmentSerial.update({
        where: { id: serialIds[1] },
        data: { status: GarmentSerialStatus.RELEASED, releaseId: serialReleaseId, updatedAt: T.released },
        select: { id: true },
      })
      await tx.qualityRelease.createMany({
        data: (
          [
            ['BLK-50', 1],
            ['BLK-52', 2],
            ['RED-52', 1],
          ] as const
        ).map(([key, quantity]) => ({
          id: releaseIds[key],
          companyId: companyA,
          siteId: siteA,
          workOrderId: production.workOrderId,
          workOrderSizeId: cell[key],
          inspectionId: passedInspectionId,
          quantity,
          certificateIds: [certificateId],
          ...signed(`WO-0001:${key}`),
        })),
      })
    }),
  )

  // --- the PPE register (the office) ----------------------------------------------------------------------------------
  const registerEntryId = firstId('quality:register:REG-2026-001')
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.ppeRegisterEntry.findUnique({ where: { id: registerEntryId }, select: { id: true } })) return
      await tx.ppeRegisterEntry.create({
        data: {
          id: registerEntryId,
          companyId: companyA,
          reference: 'SEED-REG-2026-001',
          kind: PpeRegisterKind.COMPLAINT,
          styleId: production.styleId,
          batchNumbers: ['SEED-BT-0001'],
          partyId: brandId,
          reportedAt: T.reported,
          description: 'A rider reports that a sleeve zip pull came off after a week.',
          investigation: 'Zip lot under review with the supplier.',
          ...stamp(T.reported),
        },
        select: { id: true },
      })
    }),
  )

  return {
    production,
    certificateId,
    serialStyleId,
    serialRevisionId,
    serialSalesOrderId,
    serialSalesOrderLineId,
    serialWorkOrderId,
    serialCellId,
    openInspectionId,
    openDefectId,
    passedInspectionId,
    serialInspectionId,
    releaseIds,
    serialReleaseId,
    serialIds,
    registerEntryId,
    inspectorId,
  }
}
