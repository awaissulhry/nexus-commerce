import type { Prisma } from '../src/generated/prisma/client'
import { W1_SCAN_REASONS } from '@nexus/factory-domain/production/scans/reasons'
import { unknownBundleRefusal } from '@nexus/factory-domain/production/scans/rules'
import {
  DefectKind,
  HideState,
  LabelTemplateStatus,
  MonitoringBasis,
  PartyTaxMode,
  PpeCategory,
  ProductType,
  SalesLineKind,
  SalesOrderStatus,
  ScanCorrectionStatus,
  ScanKind,
  ScanRefusalAction,
  ScanSubject,
  StockMoveReason,
  StockValuationMethod,
  StyleRevisionStatus,
  StyleStatus,
  Uom,
  WorkCentreKind,
  WorkOrderKind,
  WorkOrderStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFloorAuth } from './floor-auth'
import { seed as seedInventory, type InventorySeed } from './inventory'
import { seedWorkerNotice } from './privacy'

/**
 * The production seed, per tenant of seed/_core.ts: the golden flow's stages 10-work-order, 11a-issue, 11b-cut and
 * 12-scans on plant A1, written as the app does: the office's rows in the tenant's office scope, the floor's in A1's
 * floor scope with the operator signed in on the cutting tablet (seed/floor-auth.ts).
 *
 *   floor rules  A1 names workers (an agreement on record); B1 records the station only (Q16 (b)).
 *   style        SEED-JKT-02, a second made-up jacket made only for production: colourways BLK and RED, sizes 50-54,
 *                its own ACTIVE label template, and revision 1 RELEASED with the product seed's leather (ft² per size,
 *                a colour per colourway), lining and protectors and the product seed's routing (cutting, sewing, final
 *                inspection, packing). The product seed's SEED-JKT-01 revision stays DRAFT (a released revision is
 *                frozen, and the generated isolation tests copy its parts).
 *   order        SEED-SO-0002 for the brand P1, typed by the office: BLK 1/2/1 and RED 1/1/1 of sizes 50/52/54.
 *   WO-0001      2 colours x 3 sizes, released with the revision, its label template and batch SEED-BT-0001, its four
 *                operations at A1's work centres and its 18 planned materials (BOM line x cell); IN_PROGRESS after the
 *                first cut.
 *   issue        hide SEED-HIDE-0001 (the inventory seed's), whole, issued to the released WO-0001 and valued at the
 *                lot's cost (a move to a work order needs it RELEASED or IN_PROGRESS: …_inventory_issue_work_order_guards).
 *   WO-0002      a DRAFT work order of one cell (BLK 52), with its operations and planned materials.
 *   floor        the operator's acknowledgement of the worker notice 2026-10 in force (both made by seed/privacy.ts
 *                seedWorkerNotice, run first); one cut of the issued hide
 *                (20 ft² for sleeves of BLK 50 and 52, so the hide stays PARTLY_CUT); two bundles of sleeves from it;
 *                three scans at sewing: a report of the first bundle undone at once (a mis-scan) and a report of the
 *                second; the operator's correction request of that report (one of its two sleeve sets stained: 1 good,
 *                1 scrapped, its line STAIN 1), still PENDING; a scan the cutting tablet's queue sent that was refused
 *                (an unknown ticket), kept open (B-W1-42).
 *   reasons      the tenant's scrap and rework reasons: W1's list (factory-domain production/scans/reasons), it/en.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: the parts of a released work order are frozen, a second standing report of a bundle at an operation is refused,
 * a cut never takes more than the hide has at the work order, and a released revision's parts never change (nor does a
 * style have two released revisions). So WO-0002's rows and the undone first scan get ids that start with eight zeros,
 * the released revision and its parts ids that start with eight f's (both still derived from the namespace), and the cut
 * leaves most of the hide.
 *
 * Every name, number and value is invented. Idempotent: each step runs once and is skipped when its rows exist (the
 * floor's ledgers are append-only, a released work order and a released revision are frozen).
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-11-10T08:00:00.000Z'),
  released: new Date('2026-11-10T09:00:00.000Z'),
  ordered: new Date('2026-11-12T08:00:00.000Z'),
  planned: new Date('2026-11-15T08:00:00.000Z'),
  woReleased: new Date('2026-11-15T10:00:00.000Z'),
  issued: new Date('2026-11-16T07:30:00.000Z'),
  cut: new Date('2026-11-16T09:00:00.000Z'),
  bundled: new Date('2026-11-16T10:00:00.000Z'),
  scanned: new Date('2026-11-17T08:00:00.000Z'),
  undone: new Date('2026-11-17T08:00:20.000Z'),
  rescanned: new Date('2026-11-17T09:30:00.000Z'),
  asked: new Date('2026-11-17T10:00:00.000Z'),
  refused: new Date('2026-11-17T10:30:00.000Z'),
} as const
const DAY = { orderDate: new Date('2026-11-12T00:00:00.000Z'), due: new Date('2026-12-04T00:00:00.000Z') } as const

/** The style's sizes and the leather (ft²) one jacket of each takes, before wastage. */
const SIZES = [
  { code: '50', leatherFt2: '43.0000' },
  { code: '52', leatherFt2: '45.0000' },
  { code: '54', leatherFt2: '47.5000' },
] as const
/** SEED-SO-0002's grid: pieces per colourway and size. */
const GRID = { BLK: { '50': 1, '52': 2, '54': 1 }, RED: { '50': 1, '52': 1, '54': 1 } } as const
type Colourway = keyof typeof GRID
type Size = (typeof SIZES)[number]['code']
const WASTAGE = { leather: 12, lining: 5 } as const

/** a × b × (1 + wastage %), with four decimals (seed arithmetic on small made-up numbers). */
const planned = (perGarment: string, garments: number, wastagePct = 0): string => ((Number(perGarment) * garments * (100 + wastagePct)) / 100).toFixed(4)

export interface ProductionSeed {
  readonly inventory: InventorySeed
  readonly styleId: string
  readonly revisionId: string
  readonly labelTemplateId: string
  readonly salesOrderId: string
  /** WO-0001: released, in progress. */
  readonly workOrderId: string
  readonly cellIds: Readonly<Record<`${Colourway}-${Size}`, string>>
  readonly operationIds: { readonly cut: string; readonly sew: string; readonly qc: string; readonly pack: string }
  /** WO-0002: draft. */
  readonly draftWorkOrderId: string
  /** Hide SEED-HIDE-0001, whole, issued to WO-0001 (stage 11a-issue). */
  readonly issueMoveId: string
  readonly cutLogId: string
  readonly bundleIds: readonly [string, string]
  /** The undone report, its undo, the standing report. */
  readonly scanIds: readonly [string, string, string]
  readonly ackId: string
  /** Company A's worker notice in force (2026-10, seed/privacy.ts), which the operator acknowledged. */
  readonly workerNoticeId: string
  /** Plant A1's operator (acknowledged the notice) and team leader (has not), and the cutting tablet. */
  readonly operatorId: string
  readonly leadId: string
  readonly deviceId: string
  /** The operator's PENDING correction request of the standing report (scanIds[2]) and the cutting tablet's refused scan. */
  readonly correctionRequestId: string
  readonly refusalId: string
}

export async function seed(context: SeedContext): Promise<ProductionSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order: the hide this seed cuts comes from the inventory seed, the workers and the
  // tablet from the floor sign-in seed, the worker notice in force and the operator's acknowledgement of it from the
  // privacy seed (a floor record names a worker only then: …_privacy_guards); run them first (all idempotent).
  const inventory = await seedInventory(context)
  await seedFloorAuth(context)
  const notice = await seedWorkerNotice(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const brandId = id('party:P1')
  const operatorId = id('worker:A1:operator')
  const leadId = id('worker:A1:lead')
  const deviceId = id('device:A1:cutting')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const itemColour = { BLK: id('product:item-colour:leather:BLK'), RED: id('product:item-colour:leather:RED'), lining: id('product:item-colour:lining:GRY') }
  const operation = { cut: id('product:operation:CUT'), sew: id('product:operation:SEW'), qc: id('product:operation:QC'), pack: id('product:operation:PACK') }
  const centre = (code: string): string => id(`site:A1:work-centre:${code}`)

  const styleId = id('production:style:JKT-02')
  const colourway: Record<Colourway, string> = { BLK: id('production:colourway:JKT-02:BLK'), RED: id('production:colourway:JKT-02:RED') }
  const labelTemplateId = id('production:label:JKT-02:1')
  const revisionId = lastId('production:revision:JKT-02:1')
  const line = { leather: lastId('production:bom:JKT-02:1:10'), lining: lastId('production:bom:JKT-02:1:20'), protector: lastId('production:bom:JKT-02:1:30') }
  const ROUTING = [
    { seq: 10, operationId: operation.cut, code: 'SEED-CUT-LEA', name: 'Cut leather panels', kind: WorkCentreKind.CUTTING, minutes: '14.000', centre: 'CUT' },
    { seq: 20, operationId: operation.sew, code: 'SEED-SEW-ASM', name: 'Sew and assemble the body', kind: WorkCentreKind.SEWING, minutes: '96.500', centre: 'SEW' },
    { seq: 30, operationId: operation.qc, code: 'SEED-FIN-QC', name: 'Final inspection', kind: WorkCentreKind.INSPECTION, minutes: '8.000', centre: 'QC' },
    { seq: 40, operationId: operation.pack, code: 'SEED-PACK', name: 'Pack', kind: WorkCentreKind.PACKING, minutes: '3.500', centre: 'PACK' },
  ] as const

  // --- the floor rules ------------------------------------------------------------------------------------------------
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const rules: (Prisma.ProductionSettingsCreateManyInput & { id: string })[] = [
        {
          id: siteA,
          companyId: companyA,
          siteId: siteA,
          scanSubject: ScanSubject.WORKER,
          monitoringBasis: MonitoringBasis.UNION_AGREEMENT,
          monitoringReference: 'SEED-RSU-AGREEMENT-2026-01',
          monitoringRecordedAt: T.setup,
          monitoringRecordedById: actorId,
          ...stamp(T.setup),
        },
        { id: siteB, companyId: id('company:B'), siteId: siteB, scanSubject: ScanSubject.STATION, ...stamp(T.setup) },
      ]
      for (const { id: rowId, ...data } of rules) await tx.productionSettings.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })
    }),
  )

  // --- the style made for production, released ------------------------------------------------------------------------
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const style = {
        code: 'SEED-JKT-02',
        name: 'Seed production jacket',
        nameI18n: { it: 'Giacca produzione seed', en: 'Seed production jacket' },
        description: 'A made-up jacket the production seed releases and makes.',
        productType: ProductType.JACKET,
        season: 'FW27',
        brandPartyId: brandId,
        sizeScaleId: id('product:size-scale:EU-JKT'),
        sizes: SIZES.map((size) => size.code),
        baseSize: '52',
        ppeCategory: PpeCategory.CATEGORY_II,
        ppeStandard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        status: StyleStatus.ACTIVE,
        ...stamp(T.setup),
      }
      await tx.style.upsert({ where: { id: styleId }, create: { id: styleId, ...style }, update: style, select: { id: true } })
      for (const code of ['BLK', 'RED'] as const) {
        const data = { styleId, code, name: code === 'BLK' ? 'Black' : 'Red', colourId: id(`product:colour:${code}`), ...stamp(T.setup) }
        await tx.colourway.upsert({ where: { id: colourway[code] }, create: { id: colourway[code], ...data }, update: data, select: { id: true } })
        for (const { code: size } of SIZES) {
          const variantId = id(`production:variant:JKT-02:${code}:${size}`)
          const variant = { styleId, colourwayId: colourway[code], size, sku: `SEED-JKT-02-${code}-${size}`, ...stamp(T.setup) }
          await tx.variant.upsert({ where: { id: variantId }, create: { id: variantId, ...variant }, update: variant, select: { id: true } })
        }
      }
      const label = {
        code: 'SEED-LBL-JKT-02',
        revision: 1,
        name: 'Seed production jacket garment label',
        styleId,
        status: LabelTemplateStatus.ACTIVE,
        languages: ['it', 'en'],
        makerPartyId: brandId,
        makerName: 'Seed Customer One S.r.l.',
        makerAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy',
        composition: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }],
        animalOriginPhrase: true,
        care: [{ symbol: 'wash-not' }, { symbol: 'iron-not' }],
        layout: { fields: ['ceMark', 'maker', 'model', 'batchOrSerial', 'size', 'bodyMeasures', 'pictogram', 'class', 'standard', 'composition', 'care'] },
        widthMm: '50.00',
        heightMm: '80.00',
        ...stamp(T.setup),
      }
      await tx.labelTemplate.upsert({ where: { id: labelTemplateId }, create: { id: labelTemplateId, ...label }, update: label, select: { id: true } })

      // A released revision and its parts are frozen for every login: build it once, as a draft, then release it.
      if (await tx.styleRevision.findUnique({ where: { id: revisionId }, select: { id: true } })) return
      await tx.styleRevision.create({
        data: { id: revisionId, styleId, revision: 1, status: StyleRevisionStatus.DRAFT, changeNote: 'First revision.', plannedHideYieldPct: '75.0000', labelTemplateId, ...stamp(T.setup) },
        select: { id: true },
      })
      await tx.bomLine.createMany({
        data: [
          { id: line.leather, styleId, revisionId, seq: 10, itemId: item.leather, placement: 'Outer shell', qty: '45.0000', uom: Uom.FT2, wastagePct: '12.0000', sizeDependent: true, colourDependent: true, ...stamp(T.setup) },
          { id: line.lining, styleId, revisionId, seq: 20, itemId: item.lining, placement: 'Body lining', qty: '1.8000', uom: Uom.M, wastagePct: '5.0000', itemColourId: itemColour.lining, ...stamp(T.setup) },
          { id: line.protector, styleId, revisionId, seq: 30, itemId: item.protector, placement: 'Shoulder pockets', qty: '2.0000', uom: Uom.PCS, ...stamp(T.setup) },
        ],
      })
      await tx.bomLineSize.createMany({
        data: SIZES.map((size) => ({ id: lastId(`production:bom-size:JKT-02:1:10:${size.code}`), revisionId, bomLineId: line.leather, size: size.code, qty: size.leatherFt2, ...stamp(T.setup) })),
      })
      await tx.bomLineColour.createMany({
        data: (['BLK', 'RED'] as const).map((code) => ({
          id: lastId(`production:bom-colour:JKT-02:1:10:${code}`),
          styleId,
          revisionId,
          bomLineId: line.leather,
          itemId: item.leather,
          colourwayId: colourway[code],
          itemColourId: itemColour[code],
          ...stamp(T.setup),
        })),
      })
      await tx.routingOperation.createMany({
        data: ROUTING.map((step) => ({
          id: lastId(`production:routing:JKT-02:1:${step.code}`),
          styleId,
          revisionId,
          seq: step.seq,
          operationId: step.operationId,
          code: step.code,
          name: step.name,
          workCentreKind: step.kind,
          standardMinutes: step.minutes,
          ...stamp(T.setup),
        })),
      })
      await tx.styleRevision.update({ where: { id: revisionId }, data: { status: StyleRevisionStatus.RELEASED, releasedAt: T.released, releasedById: actorId, updatedAt: T.released }, select: { id: true } })
    }),
  )

  // --- the sales order it makes ---------------------------------------------------------------------------------------
  const salesOrderId = id('production:sales-order:SO-0002')
  const orderLine: Record<Colourway, string> = { BLK: id('production:sales-order:SO-0002:10'), RED: id('production:sales-order:SO-0002:20') }
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.salesOrder.findUnique({ where: { id: salesOrderId }, select: { id: true } })) return
      const pieces = (code: Colourway): number => Object.values(GRID[code]).reduce((sum, quantity) => sum + quantity, 0)
      const net = (code: Colourway): number => pieces(code) * 40_000
      const vat = (code: Colourway): number => (net(code) * 22) / 100
      const totalNet = net('BLK') + net('RED')
      const totalVat = vat('BLK') + vat('RED')
      await tx.salesOrder.create({
        data: {
          id: salesOrderId,
          companyId: companyA,
          partyId: brandId,
          number: 'SEED-SO-0002',
          customerRef: 'SEED-PO-78',
          status: SalesOrderStatus.CONFIRMED,
          orderDate: DAY.orderDate,
          taxMode: PartyTaxMode.IT_B2B,
          billTo: { legalName: 'Seed Customer One S.r.l.', kind: 'ORGANISATION', country: 'IT', taxMode: 'IT_B2B', address: { line1: 'Via Esempio 10', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' } },
          shipTo: { name: 'Seed Racing workshop', line1: 'Via Esempio 12', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
          promiseDate: DAY.due,
          originalPromiseDate: DAY.due,
          netAmount: totalNet,
          vatAmount: totalVat,
          grossAmount: totalNet + totalVat,
          ...stamp(T.ordered),
        },
        select: { id: true },
      })
      for (const [index, code] of (['BLK', 'RED'] as const).entries()) {
        await tx.salesOrderLine.create({
          data: {
            id: orderLine[code],
            companyId: companyA,
            orderId: salesOrderId,
            partyId: brandId,
            seq: (index + 1) * 10,
            kind: SalesLineKind.SIZE_GRID,
            styleId,
            styleRevisionId: revisionId,
            colourwayId: colourway[code],
            description: `SEED-JKT-02 ${code}`,
            quantity: pieces(code),
            unitPrice: '400.000000',
            netAmount: net(code),
            vatRatePct: '22.00',
            vatAmount: vat(code),
            siteId: siteA,
            ...stamp(T.ordered),
          },
          select: { id: true },
        })
        await tx.salesOrderLineSize.createMany({
          data: Object.entries(GRID[code]).map(([size, quantity]) => ({ id: id(`production:sales-order:SO-0002:${code}:${size}`), lineId: orderLine[code], partyId: brandId, size, quantity, ...stamp(T.ordered) })),
        })
      }
    }),
  )

  // --- the work orders --------------------------------------------------------------------------------------------------
  const workOrderId = id('production:work-order:WO-0001')
  const draftWorkOrderId = firstId('production:work-order:WO-0002')
  const cellIds = Object.fromEntries(
    (['BLK', 'RED'] as const).flatMap((code) => SIZES.map(({ code: size }) => [`${code}-${size}`, id(`production:WO-0001:cell:${code}:${size}`)])),
  ) as Record<`${Colourway}-${Size}`, string>
  const key = (name: string): string => id(`production:WO-0001:${name}`)
  const operationIds = { cut: key('operation:10'), sew: key('operation:20'), qc: key('operation:30'), pack: key('operation:40') }

  /** The parts of a work order: its cells from the order lines, its routing at A1's work centres, BOM line x cell. */
  const parts = (keyOf: (name: string) => string, orderId: string, cells: readonly { colourway: Colourway; size: Size; quantity: number; cellId: string }[]) => {
    const leatherOf = (size: Size): string => SIZES.find((entry) => entry.code === size)!.leatherFt2
    const sizes: Prisma.WorkOrderSizeCreateManyInput[] = cells.map((cell) => ({
      id: cell.cellId,
      siteId: siteA,
      workOrderId: orderId,
      styleId,
      colourwayId: colourway[cell.colourway],
      size: cell.size,
      quantity: cell.quantity,
      salesOrderLineId: orderLine[cell.colourway],
      partyId: brandId,
      ...stamp(T.planned),
    }))
    const operations: Prisma.WorkOrderOperationCreateManyInput[] = ROUTING.map((step) => ({
      id: keyOf(`operation:${step.seq}`),
      siteId: siteA,
      workOrderId: orderId,
      styleRevisionId: revisionId,
      seq: step.seq,
      routingSeq: step.seq,
      code: step.code,
      name: step.name,
      standardMinutes: step.minutes,
      workCentreId: centre(step.centre),
      ...stamp(T.planned),
    }))
    const materials: Prisma.WorkOrderMaterialCreateManyInput[] = cells.flatMap((cell) => {
      const row = (lineKey: keyof typeof line, extra: Pick<Prisma.WorkOrderMaterialCreateManyInput, 'itemId' | 'itemColourId' | 'quantity' | 'uom' | 'baseQuantity'>) => ({
        id: keyOf(`material:${lineKey}:${cell.colourway}:${cell.size}`),
        siteId: siteA,
        workOrderId: orderId,
        styleRevisionId: revisionId,
        bomLineId: line[lineKey],
        workOrderSizeId: cell.cellId,
        ...extra,
        ...stamp(T.planned),
      })
      const leather = planned(leatherOf(cell.size), cell.quantity, WASTAGE.leather)
      const lining = planned('1.8000', cell.quantity, WASTAGE.lining)
      const protectors = planned('2.0000', cell.quantity)
      return [
        row('leather', { itemId: item.leather, itemColourId: itemColour[cell.colourway], quantity: leather, uom: Uom.FT2, baseQuantity: leather }),
        row('lining', { itemId: item.lining, itemColourId: itemColour.lining, quantity: lining, uom: Uom.M, baseQuantity: lining }),
        row('protector', { itemId: item.protector, quantity: protectors, uom: Uom.PCS, baseQuantity: protectors }),
      ]
    })
    return { sizes, operations, materials }
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true } })) return
      await tx.workOrder.create({
        data: { id: workOrderId, companyId: companyA, siteId: siteA, number: 'SEED-WO-0001', kind: WorkOrderKind.SIZE_GRID, styleId, styleRevisionId: revisionId, dueDate: DAY.due, ...stamp(T.planned) },
        select: { id: true },
      })
      const cells = (['BLK', 'RED'] as const).flatMap((code) =>
        SIZES.map(({ code: size }) => ({ colourway: code, size, quantity: GRID[code][size], cellId: cellIds[`${code}-${size}`] })),
      )
      const { sizes, operations, materials } = parts(key, workOrderId, cells)
      await tx.workOrderSize.createMany({ data: sizes })
      await tx.workOrderOperation.createMany({ data: operations })
      await tx.workOrderMaterial.createMany({ data: materials })
      // The release: the frozen spec (revision, its label template), the batch number (MES-076).
      await tx.workOrder.update({
        where: { id: workOrderId },
        data: { status: WorkOrderStatus.RELEASED, labelTemplateId, batchNumber: 'SEED-BT-0001', releasedAt: T.woReleased, releasedById: actorId, updatedAt: T.woReleased },
        select: { id: true },
      })
    }),
  )
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrder.findUnique({ where: { id: draftWorkOrderId }, select: { id: true } })) return
      await tx.workOrder.create({
        data: { id: draftWorkOrderId, companyId: companyA, siteId: siteA, number: 'SEED-WO-0002', kind: WorkOrderKind.SIZE_GRID, styleId, styleRevisionId: revisionId, dueDate: DAY.due, ...stamp(T.planned) },
        select: { id: true },
      })
      const { sizes, operations, materials } = parts((name) => firstId(`production:WO-0002:${name}`), draftWorkOrderId, [
        { colourway: 'BLK', size: '52', quantity: 1, cellId: firstId('production:WO-0002:cell:BLK:52') },
      ])
      await tx.workOrderSize.createMany({ data: sizes })
      await tx.workOrderOperation.createMany({ data: operations })
      await tx.workOrderMaterial.createMany({ data: materials })
    }),
  )

  // --- 11a-issue: the first hide, whole, issued to the released WO-0001 and valued at the lot's cost (once) ----------------
  // (Here, not in the inventory seed: a stock move to a work order names a RELEASED or IN_PROGRESS one of its site.)
  const issue = { move: id('inventory:move:issue:H1'), value: id('inventory:value:issue:H1') }
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.stockMove.findUnique({ where: { id: issue.move }, select: { id: true } })) return
      await tx.stockMove.create({
        data: {
          id: issue.move,
          companyId: companyA,
          siteId: siteA,
          reason: StockMoveReason.ISSUE,
          itemId: item.leather,
          itemColourId: itemColour.BLK,
          lotId: inventory.leatherLotId,
          hideId: inventory.hideIds[0],
          fromLocationId: inventory.locations.bin,
          quantity: '53.2000',
          uom: Uom.FT2,
          baseQuantity: '53.2000',
          workOrderId,
          reference: 'SEED-WO-0001',
          idempotencyKey: 'seed-issue-H1',
          occurredAt: T.issued,
          createdAt: T.issued,
          createdById: actorId,
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
          lotId: inventory.leatherLotId,
          quantity: '-53.2000',
          unitCost: '4.200000',
          valueAmount: -22_344,
          method: StockValuationMethod.LOT_COST,
          idempotencyKey: `move:${issue.move}`,
          createdAt: T.issued,
          createdById: actorId,
        },
        select: { id: true },
      })
    }),
  )

  // --- the floor: the cut, the bundles, the scans (the notice: seedWorkerNotice, above) ---------------------------------
  const ackId = notice.operatorAckId
  const cutLogId = id('production:cut:H1:1')
  const [hide1] = inventory.hideIds
  const bundleIds = [id('production:bundle:WO-0001:1'), id('production:bundle:WO-0001:2')] as const
  const scanIds = [firstId('production:scan:WO-0001:1'), id('production:scan:WO-0001:2'), id('production:scan:WO-0001:3')] as const
  const signedIn = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const onDevice = { workerId: operatorId, deviceId }

  await db.withScope(signedIn, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.cutLog.findUnique({ where: { id: cutLogId }, select: { id: true } })) return
      await tx.cutLog.create({
        data: {
          id: cutLogId,
          siteId: siteA,
          workOrderId,
          lotId: inventory.leatherLotId,
          hideId: hide1,
          uom: Uom.FT2,
          areaUsed: '20.0000',
          baseAreaUsed: '20.0000',
          note: 'Sleeves first; the rest of the hide stays at the table.',
          ...onDevice,
          clientEventId: 'seed-cut-H1-1',
          deviceTime: T.cut,
          serverTime: T.cut,
          createdById: operatorId,
        },
        select: { id: true },
      })
      await tx.cutLogPiece.createMany({
        data: [
          { id: id('production:cut:H1:1:BLK-50'), siteId: siteA, workOrderId, cutLogId, workOrderSizeId: cellIds['BLK-50'], part: 'sleeve', pieces: 2, serverTime: T.cut, createdById: operatorId },
          { id: id('production:cut:H1:1:BLK-52'), siteId: siteA, workOrderId, cutLogId, workOrderSizeId: cellIds['BLK-52'], part: 'sleeve', pieces: 4, serverTime: T.cut, createdById: operatorId },
        ],
      })
      await tx.hide.update({ where: { id: hide1 }, data: { state: HideState.PARTLY_CUT, updatedAt: T.cut }, select: { id: true } })
      for (const [index, cell] of (['BLK-50', 'BLK-52'] as const).entries()) {
        await tx.bundle.create({
          data: {
            id: bundleIds[index]!,
            siteId: siteA,
            workOrderId,
            workOrderSizeId: cellIds[cell],
            code: `SEED-BN-000${index + 1}`,
            quantity: cell === 'BLK-50' ? 1 : 2,
            part: 'SLEEVES',
            cutLogIds: [cutLogId],
            deviceId,
            ...stamp(T.bundled),
            createdById: operatorId,
          },
          select: { id: true },
        })
      }
    }),
  )
  await db.withScope(signedIn, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.operationScan.findUnique({ where: { id: scanIds[0] }, select: { id: true } })) return
      const at = { siteId: siteA, workOrderId, workOrderOperationId: operationIds.sew, ...onDevice, createdById: operatorId }
      await tx.operationScan.create({
        data: { id: scanIds[0], ...at, bundleId: bundleIds[0], kind: ScanKind.REPORT, goodQuantity: 1, clientScanId: 'seed-scan-1', deviceTime: T.scanned, serverTime: T.scanned },
        select: { id: true },
      })
      await tx.operationScan.create({
        data: { id: scanIds[1], ...at, bundleId: bundleIds[0], kind: ScanKind.UNDO, correctsId: scanIds[0], reason: 'Scanned the wrong bundle.', clientScanId: 'seed-scan-2', deviceTime: T.undone, serverTime: T.undone },
        select: { id: true },
      })
      await tx.operationScan.create({
        data: { id: scanIds[2], ...at, bundleId: bundleIds[1], kind: ScanKind.REPORT, goodQuantity: 2, clientScanId: 'seed-scan-3', deviceTime: T.rescanned, serverTime: T.rescanned },
        select: { id: true },
      })
    }),
  )
  // B-W1-42's records: the tenant's reasons (the office keeps them), then on the floor an ask of a correction of the
  // standing report with its line, and a refused scan of the cutting tablet's queue.
  const correctionRequestId = id('production:scan-correction:WO-0001:1')
  const refusalId = id('production:scan-refusal:A1:1')
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const reason of W1_SCAN_REASONS) {
        const reasonId = id(`production:scrap-reason:${reason.kind}:${reason.code}`)
        const data = { labelIt: reason.label.it, labelEn: reason.label.en, sortOrder: reason.sortOrder, active: reason.active }
        await tx.scrapReason.upsert({
          where: { id: reasonId },
          create: { id: reasonId, kind: reason.kind === 'SCRAP' ? DefectKind.SCRAP : DefectKind.REWORK, code: reason.code, ...data, ...stamp(T.setup) },
          update: data,
          select: { id: true },
        })
      }
    }),
  )
  await db.withScope(signedIn, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.scanCorrectionRequest.findUnique({ where: { id: correctionRequestId }, select: { id: true } })) return
      await tx.scanCorrectionRequest.create({
        data: {
          id: correctionRequestId,
          siteId: siteA,
          workOrderId,
          bundleId: bundleIds[1],
          workOrderOperationId: operationIds.sew,
          scanId: scanIds[2],
          goodQuantity: 1,
          scrapQuantity: 1,
          reason: 'One sleeve set has a stain that does not clean off.',
          status: ScanCorrectionStatus.PENDING,
          askedById: operatorId,
          stationId: id('site:A1:station:CUT-01'),
          deviceId,
          clientRequestId: 'seed-ask-1',
          deviceTime: T.asked,
          serverTime: T.asked,
          createdById: operatorId,
          createdAt: T.asked,
          updatedAt: T.asked,
        },
        select: { id: true },
      })
      await tx.operationScanDefect.create({
        data: { id: id('production:scan-line:WO-0001:ask-1'), siteId: siteA, correctionRequestId, kind: DefectKind.SCRAP, reasonCode: 'STAIN', quantity: 1, serverTime: T.asked, createdById: operatorId },
        select: { id: true },
      })
    }),
  )
  await db.withScope(signedIn, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.floorScanRefusal.findUnique({ where: { id: refusalId }, select: { id: true } })) return
      const refusal = unknownBundleRefusal()
      await tx.floorScanRefusal.create({
        data: {
          id: refusalId,
          siteId: siteA,
          deviceId,
          clientScanId: 'seed-scan-refused-1',
          action: ScanRefusalAction.REPORT,
          code: refusal.code,
          message: refusal.message,
          fix: refusal.fix,
          final: refusal.final,
          scanned: 'SEED-BN-9999',
          goodQuantity: 1,
          workerId: operatorId,
          stationId: id('site:A1:station:CUT-01'),
          deviceTime: T.refused,
          serverTime: T.refused,
          createdById: operatorId,
          createdAt: T.refused,
          updatedAt: T.refused,
        },
        select: { id: true },
      })
    }),
  )
  // The first floor work moves the work order on (the office, or the worker's handler after the floor's event).
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.workOrder.updateMany({ where: { id: workOrderId, status: WorkOrderStatus.RELEASED }, data: { status: WorkOrderStatus.IN_PROGRESS, startedAt: T.cut, updatedAt: T.cut } }),
  )

  return {
    inventory,
    styleId,
    revisionId,
    labelTemplateId,
    salesOrderId,
    workOrderId,
    cellIds,
    operationIds,
    draftWorkOrderId,
    issueMoveId: issue.move,
    cutLogId,
    bundleIds,
    scanIds,
    ackId,
    workerNoticeId: notice.workerNoticeId,
    operatorId,
    leadId,
    deviceId,
    correctionRequestId,
    refusalId,
  }
}
