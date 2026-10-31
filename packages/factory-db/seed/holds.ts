import type { Prisma } from '../src/generated/prisma/client'
import {
  ContainmentKind,
  ContainmentStatus,
  DdtFreight,
  DdtReason,
  DefectClass,
  DispositionFollowUp,
  DispositionOutcome,
  FreightRule,
  HoldQuarantine,
  NcrSource,
  NcrStage,
  QualityStage,
  RepairKind,
  RepairStage,
  StockMoveReason,
  TransportBy,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedReturns } from './returns'

/**
 * The W2a quality seed (schema wave 6/7), per tenant of seed/_core.ts: the defect library, the disposition codes, a
 * quality hold, two nonconformances, the freight rule of plant A1 and a DDT for another reason. The office's rows are
 * written in the tenant's office scope, the hold in A1's floor scope (the operator at the cutting table), as the app
 * does. The CLI runs this file before seed/returns.ts (name order), so it runs that seed first: it brings the money,
 * shipping, quality, production and inventory seeds.
 *
 *   defects       the tenant's starter library for leather rider garments: six categories (seams, leather, fittings,
 *                 protection, labels, finish) and their defects, with the default class, the usual zone, the stages
 *                 and a tile icon and colour; a critical defect (a missing armour pocket, a wrong or missing label) is
 *                 never accepted.
 *   dispositions  use as is, rework, repair, regrade, return to the supplier, quarantine and scrap: the stock move and
 *                 the follow-up record each makes, a decision above 500.00 (cost) or on a critical NCR needs approval.
 *   hold          the operator holds hide SEED-HIDE-0002 at the cutting table (a grain crack across the butt): ACTIVE,
 *                 the move to A1's quarantine shelf asked; the office decides it in SEED-NCR-0002.
 *   SEED-NCR-0001 OPEN: skipped stitches on a sleeve found at the final inspection of SEED-WO-0001 (one garment,
 *                 minor).
 *   SEED-NCR-0002 CONTAINED: the grain crack on SEED-HIDE-0002 (51.8 ft² of P2's lot SEED-LOT-LEA-01, major), found at
 *                 cutting; containment: the hide held (done, it names the hold) and the work in progress checked (done);
 *                 one decision: 12 ft² scrapped (decided, not carried out yet: 39.8 ft² left to decide); linked to the
 *                 lot.
 *   freight       plant A1 charges 12.00 per shipment, free from an order of 500.00 (the shipping settings).
 *   repair DDT    SEED-REP-0002, a customer's jacket sent in to have its sleeves shortened (an alteration, not a PPE
 *                 repair): received, altered and sent back with DDT 145/2026 of company A's series (reason REPAIR, no
 *                 shipment: its source is the repair), then SHIPPED.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a hold starts ACTIVE (and a floor session's names its worker), an NCR starts OPEN, its actions and decisions
 * are written while it is OPEN or CONTAINED and never pass its quantity. So the first category, the scrap code, the
 * hold, SEED-NCR-0001, SEED-NCR-0002's first action, decision and link get ids that start with eight zeros, and the rows
 * this seed adds to other modules' tables (the repair, its stage events, the DDT and its number) ids that start with
 * eight f's (all still derived from the namespace), so those tables' first rows stay the ones their seeds chose.
 *
 * Every name, number and value is invented. Idempotent: the library, the codes and the freight rule are upserted; the
 * hold, the NCRs and the repair with its DDT are written once and skipped when they exist (a DDT is append-only).
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-10-29T08:00:00.000Z'),
  held: new Date('2026-11-21T09:10:00.000Z'),
  raised: new Date('2026-11-21T10:00:00.000Z'),
  contained: new Date('2026-11-21T11:30:00.000Z'),
  decided: new Date('2026-11-22T08:30:00.000Z'),
  found: new Date('2026-11-23T15:00:00.000Z'),
  received: new Date('2026-11-25T09:00:00.000Z'),
  altering: new Date('2026-11-25T14:00:00.000Z'),
  altered: new Date('2026-11-26T16:00:00.000Z'),
  ddt: new Date('2026-11-27T08:00:00.000Z'),
  start: new Date('2026-11-27T09:00:00.000Z'),
  left: new Date('2026-11-27T09:30:00.000Z'),
} as const
// B-W2b-30: dated in the past like the shipping seed's DDTs 143 and 144 (the same day), so the DDT series' last issued
// date lets a fresh seed issue today's DDTs; the repair's other times stay in the November story above.
const DDT_DATE = new Date('2026-10-30T00:00:00.000Z')
const YEAR = '2026'

const BLUE = '#2563EB'
const AMBER = '#D97706'
const RED = '#DC2626'
const VIOLET = '#7C3AED'
const SLATE = '#475569'
const GREEN = '#16A34A'

type Defect = readonly [code: string, labelIt: string, labelEn: string, severity: DefectClass, zone: string | null, stages: readonly QualityStage[], icon: string | null]
/** The starter library (design quality.defects): categories and their defects. */
const LIBRARY: readonly { readonly code: string; readonly labelIt: string; readonly labelEn: string; readonly icon: string; readonly colour: string; readonly defects: readonly Defect[] }[] = [
  {
    code: 'SEAM',
    labelIt: 'Cuciture',
    labelEn: 'Seams',
    icon: 'scissors',
    colour: BLUE,
    defects: [
      ['SEAM-OPEN', 'Cucitura aperta', 'Open seam', DefectClass.MAJOR, null, [QualityStage.IN_LINE, QualityStage.FINAL, QualityStage.CUSTOMER], 'scissors'],
      ['STITCH-SKIP', 'Punto saltato', 'Skipped stitch', DefectClass.MINOR, null, [QualityStage.IN_LINE, QualityStage.FINAL], 'scissors'],
      ['PUCKERING', 'Arricciatura', 'Puckering', DefectClass.MINOR, null, [QualityStage.IN_LINE, QualityStage.FINAL], null],
      ['NEEDLE-HOLES', 'Fori di ago', 'Needle holes', DefectClass.MINOR, null, [QualityStage.IN_LINE, QualityStage.FINAL], null],
    ],
  },
  {
    code: 'LEATHER',
    labelIt: 'Pelle',
    labelEn: 'Leather',
    icon: 'layers',
    colour: AMBER,
    defects: [
      ['SHADE-DIFF', 'Differenza di tono', 'Shade difference', DefectClass.MAJOR, null, [QualityStage.INCOMING, QualityStage.CUTTING, QualityStage.FINAL], 'layers'],
      ['HIDE-SCAR', 'Cicatrice o marchio', 'Scar or brand on the hide', DefectClass.MAJOR, null, [QualityStage.INCOMING, QualityStage.CUTTING], 'layers'],
      ['GRAIN-CRACK', 'Crepa del fiore', 'Grain crack', DefectClass.MAJOR, null, [QualityStage.INCOMING, QualityStage.STOCK, QualityStage.CUTTING], 'layers'],
      ['LOOSE-GRAIN', 'Fiore staccato', 'Loose grain', DefectClass.MINOR, null, [QualityStage.INCOMING, QualityStage.CUTTING], null],
      ['COLOUR-RUB', 'Scolorimento', 'Colour rub-off', DefectClass.MINOR, null, [QualityStage.FINAL, QualityStage.CUSTOMER], null],
    ],
  },
  {
    code: 'FITTING',
    labelIt: 'Accessori',
    labelEn: 'Fittings',
    icon: 'link',
    colour: SLATE,
    defects: [['ZIP-MISALIGNED', 'Cerniera storta', 'Misaligned zip', DefectClass.MINOR, 'FRONT', [QualityStage.FINAL], 'link']],
  },
  {
    code: 'PROTECTION',
    labelIt: 'Protezioni',
    labelEn: 'Protection',
    icon: 'shield',
    colour: RED,
    defects: [['ARMOUR-POCKET-MISSING', 'Tasca protezione mancante', 'Missing armour pocket', DefectClass.CRITICAL, 'SHOULDER', [QualityStage.IN_LINE, QualityStage.FINAL], 'shield']],
  },
  {
    code: 'LABEL',
    labelIt: 'Etichette',
    labelEn: 'Labels',
    icon: 'tag',
    colour: VIOLET,
    defects: [['LABEL-WRONG', 'Etichetta errata o mancante', 'Wrong or missing label', DefectClass.CRITICAL, 'LABEL', [QualityStage.FINAL, QualityStage.PACKING], 'tag']],
  },
  {
    code: 'FINISH',
    labelIt: 'Finitura',
    labelEn: 'Finish',
    icon: 'sparkles',
    colour: GREEN,
    defects: [
      ['STAIN', 'Macchia', 'Stain', DefectClass.MINOR, null, [QualityStage.FINAL, QualityStage.CUSTOMER], null],
      ['THREAD-END', 'Filo non tagliato', 'Thread end left', DefectClass.MINOR, null, [QualityStage.FINAL], null],
      ['OTHER', 'Altro', 'Other', DefectClass.MINOR, null, [], null],
    ],
  },
]

export interface HoldsSeed {
  readonly defectCodeIds: Readonly<Record<string, string>>
  readonly dispositionCodeIds: Readonly<Record<string, string>>
  /** The hold of SEED-HIDE-0002 (ACTIVE). */
  readonly holdId: string
  /** SEED-NCR-0001 (OPEN); SEED-NCR-0002 (CONTAINED), its two actions, its decision and its link. */
  readonly openNcrId: string
  readonly ncrId: string
  readonly actionIds: readonly [string, string]
  readonly dispositionLineId: string
  readonly linkId: string
  /** SEED-REP-0002 (SHIPPED) and its DDT 145/2026. */
  readonly repairId: string
  readonly repairDdtId: string
}

export async function seed(context: SeedContext): Promise<HoldsSeed> {
  const { db, namespace } = context
  const returns = await seedReturns(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const brandId = id('party:P1')
  const supplierId = id('party:P2')
  const operatorId = id('worker:A1:operator')
  const leather = id('product:item:leather')
  const leatherLot = id('inventory:lot:LEA-01')
  const hideH2 = id('inventory:hide:H2')
  const quarantine = id('inventory:location:A1-QUA')
  const production = returns.money.shipping.quality.production
  const office = { audience: 'office' as const, tenantId, actorId }
  const cutting = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const select = { id: true } as const

  // --- the defect library and the disposition codes: upserted ---------------------------------------------------------
  const defectCodeIds: Record<string, string> = {}
  const defectRows: (Prisma.DefectCodeUncheckedCreateInput & { id: string })[] = []
  LIBRARY.forEach((category, index) => {
    const categoryId = index === 0 ? firstId(`holds:defect:${category.code}`) : id(`holds:defect:${category.code}`)
    defectCodeIds[category.code] = categoryId
    defectRows.push({ id: categoryId, code: category.code, labelIt: category.labelIt, labelEn: category.labelEn, icon: category.icon, colour: category.colour, sortOrder: index * 100, ...stamp(T.setup) })
    category.defects.forEach(([code, labelIt, labelEn, severity, zone, stages, icon], order) => {
      const defectId = id(`holds:defect:${code}`)
      defectCodeIds[code] = defectId
      defectRows.push({
        id: defectId,
        parentId: categoryId,
        code,
        labelIt,
        labelEn,
        icon,
        colour: category.colour,
        severity,
        zone,
        stages: [...stages],
        needsDetail: code === 'OTHER',
        sortOrder: index * 100 + order + 1,
        ...stamp(T.setup),
      })
    })
  })
  const dispositionCodeIds: Record<string, string> = {}
  const dispositions: (Prisma.DispositionCodeUncheckedCreateInput & { id: string })[] = (
    [
      ['SCRAP', 'Scarto', 'Scrap', DispositionOutcome.SCRAP, StockMoveReason.SCRAP, null, false, DefectClass.CRITICAL, 50000, 'trash', RED],
      ['USE_AS_IS', 'Usa così', 'Use as is', DispositionOutcome.USE_AS_IS, null, null, false, null, null, 'check', GREEN],
      ['REWORK', 'Rilavorazione', 'Rework', DispositionOutcome.REWORK, null, DispositionFollowUp.REWORK_ORDER, true, null, null, 'refresh', BLUE],
      ['REPAIR', 'Riparazione', 'Repair', DispositionOutcome.REPAIR, null, DispositionFollowUp.REPAIR_ORDER, true, null, null, 'wrench', BLUE],
      ['REGRADE', 'Seconda scelta', 'Regrade (second quality)', DispositionOutcome.REGRADE, StockMoveReason.TRANSFER, null, false, null, 50000, 'layers', AMBER],
      ['RETURN_TO_SUPPLIER', 'Reso al fornitore', 'Return to supplier', DispositionOutcome.RETURN_TO_SUPPLIER, null, DispositionFollowUp.SUPPLIER_CLAIM, false, null, null, 'truck', VIOLET],
      ['QUARANTINE', 'Quarantena', 'Quarantine', DispositionOutcome.QUARANTINE, StockMoveReason.TRANSFER, null, false, null, null, 'lock', SLATE],
    ] as const
  ).map(([code, labelIt, labelEn, outcome, stockMoveReason, followUp, reinspection, approvalSeverity, approvalAmount, icon, colour], index) => {
    const codeId = index === 0 ? firstId(`holds:disposition:${code}`) : id(`holds:disposition:${code}`)
    dispositionCodeIds[code] = codeId
    return { id: codeId, code, labelIt, labelEn, outcome, stockMoveReason, followUp, reinspection, approvalSeverity, approvalAmount, icon, colour, sortOrder: index, ...stamp(T.setup) }
  })
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: rowId, createdAt, createdById, ...data } of [...defectRows]) {
        await tx.defectCode.upsert({ where: { id: rowId }, create: { id: rowId, createdAt, createdById, ...data }, update: data, select })
      }
      for (const { id: rowId, createdAt, createdById, ...data } of dispositions) {
        await tx.dispositionCode.upsert({ where: { id: rowId }, create: { id: rowId, createdAt, createdById, ...data }, update: data, select })
      }
      // Plant A1 charges freight by its rule (B-W2a-48): 12.00 a shipment, free from 500.00 of goods.
      await tx.shippingSettings.update({ where: { id: siteA }, data: { freightRule: FreightRule.PER_SHIPMENT, freightAmount: 1200, freightFreeFrom: 50000 }, select })
    }),
  )

  // --- the hold: the operator holds SEED-HIDE-0002 at the cutting table ------------------------------------------------
  const holdId = firstId('holds:hold:HIDE-0002')
  await db.withScope(cutting, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.qualityHold.findUnique({ where: { id: holdId }, select })) return
      await tx.qualityHold.create({
        data: {
          id: holdId,
          companyId: companyA,
          siteId: siteA,
          subjectType: 'Hide',
          subjectIds: [hideH2],
          reasonCode: 'QUALITY_CHECK',
          reasonNote: 'A grain crack across the butt, seen when the hide was laid on the table.',
          placedAt: T.held,
          placedByWorkerId: operatorId,
          quarantine: HoldQuarantine.ASKED,
          quarantineLocationId: quarantine,
          ...stamp(T.held, operatorId),
        },
        select,
      })
    }),
  )

  // --- SEED-NCR-0001: OPEN, from the final inspection ------------------------------------------------------------------
  const openNcrId = firstId('holds:ncr:NCR-0001')
  const ncrId = id('holds:ncr:NCR-0002')
  const actionIds = [firstId('holds:ncr:NCR-0002:action:1'), id('holds:ncr:NCR-0002:action:2')] as const
  const dispositionLineId = firstId('holds:ncr:NCR-0002:decision:1')
  const linkId = firstId('holds:ncr:NCR-0002:link:lot')
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.nonconformance.findUnique({ where: { id: openNcrId }, select })) return
      await tx.nonconformance.create({
        data: {
          id: openNcrId,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-NCR-0001',
          title: 'Skipped stitches on the left sleeve',
          description: 'Three skipped stitches on the left sleeve seam of one garment of the final sample.',
          source: NcrSource.INSPECTION,
          sourceType: 'Inspection',
          sourceId: returns.money.shipping.quality.openInspectionId,
          foundAt: QualityStage.FINAL,
          foundOn: T.found,
          foundByWorkerId: id('worker:A1:lead'),
          quantityAffected: '1.0000',
          quantitySuspect: '1.0000',
          uom: Uom.PCS,
          defectCodeId: defectCodeIds['STITCH-SKIP'],
          severity: DefectClass.MINOR,
          zone: 'SLEEVE',
          styleId: production.styleId,
          workOrderId: production.workOrderId,
          ownerId: actorId,
          containmentDueAt: new Date('2026-11-24T15:00:00.000Z'),
          ...stamp(T.found),
        },
        select,
      })
    }),
  )

  // --- SEED-NCR-0002: the grain crack, CONTAINED -----------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.nonconformance.findUnique({ where: { id: ncrId }, select })) return
      await tx.nonconformance.create({
        data: {
          id: ncrId,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-NCR-0002',
          title: 'Grain crack on hide SEED-HIDE-0002',
          description: 'A grain crack across the butt of a hide of the supplier P2, seen at the cutting table before cutting.',
          source: NcrSource.SUPPLIER,
          sourceType: 'QualityHold',
          sourceId: holdId,
          foundAt: QualityStage.CUTTING,
          foundOn: T.held,
          foundByWorkerId: operatorId,
          quantityAffected: '51.8000',
          quantitySuspect: '0.0000',
          uom: Uom.FT2,
          defectCodeId: defectCodeIds['GRAIN-CRACK'],
          severity: DefectClass.MAJOR,
          itemId: leather,
          lotId: leatherLot,
          supplierId,
          ownerId: actorId,
          containmentDueAt: new Date('2026-11-21T17:00:00.000Z'),
          ...stamp(T.raised),
        },
        select,
      })
      // The office decides the held hide in this NCR, then records its containment.
      await tx.qualityHold.update({ where: { id: holdId }, data: { ncrId, ownerId: actorId, expectedReleaseOn: new Date('2026-11-28T00:00:00.000Z'), version: 2, updatedAt: T.raised }, select })
      await tx.ncrContainmentAction.createMany({
        data: [
          {
            id: actionIds[0],
            siteId: siteA,
            ncrId,
            seq: 1,
            kind: ContainmentKind.HOLD_STOCK,
            ownerId: actorId,
            dueAt: T.contained,
            status: ContainmentStatus.DONE,
            doneAt: T.raised,
            doneById: actorId,
            evidenceNote: 'The hide is on hold; its move to the quarantine shelf A1-QUA is asked.',
            recordType: 'QualityHold',
            recordId: holdId,
            ...stamp(T.raised),
          },
          {
            id: actionIds[1],
            siteId: siteA,
            ncrId,
            seq: 2,
            kind: ContainmentKind.CHECK_WIP,
            description: 'Check the other hide of the lot already cut for SEED-WO-0001.',
            ownerId: actorId,
            dueAt: T.contained,
            status: ContainmentStatus.DONE,
            doneAt: T.contained,
            doneById: actorId,
            evidenceNote: 'Hide SEED-HIDE-0001 checked at the work order: no crack on the parts cut from it.',
            ...stamp(T.raised),
          },
        ],
      })
      await tx.ncrLink.create({ data: { id: linkId, siteId: siteA, ncrId, recordType: 'Lot', recordId: leatherLot, note: 'The lot the hide is of.', createdAt: T.raised, createdById: actorId }, select })
      await tx.nonconformance.update({ where: { id: ncrId }, data: { stage: NcrStage.CONTAINED, containedAt: T.contained, version: 2, updatedAt: T.contained }, select })
      await tx.ncrDispositionLine.create({
        data: {
          id: dispositionLineId,
          siteId: siteA,
          ncrId,
          seq: 1,
          dispositionCodeId: dispositionCodeIds['SCRAP']!,
          quantity: '12.0000',
          note: 'The cracked area of the butt is cut out and scrapped; the rest of the hide waits for the decision.',
          decidedAt: T.decided,
          decidedById: actorId,
          ...stamp(T.decided),
        },
        select,
      })
    }),
  )

  // --- SEED-REP-0002: an alteration sent back with a DDT for another reason --------------------------------------------
  const repairId = lastId('holds:repair:REP-0002')
  const repairDdtId = lastId('holds:repair:REP-0002:ddt')
  const ddtSeriesId = returns.money.shipping.ddtSeriesId
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.repairOrder.findUnique({ where: { id: repairId }, select })) return
      const event = (n: number, fromStage: RepairStage | null, stage: RepairStage, at: Date) =>
        tx.repairStageEvent.create({
          data: { id: lastId(`holds:repair:REP-0002:event:${n}`), siteId: siteA, repairId, fromStage, stage, repairVersion: n, at, requestId: `seed-holds-${namespace}-repair-${n}`, createdAt: at, createdById: actorId },
          select,
        })
      await tx.repairOrder.create({
        data: {
          id: repairId,
          companyId: companyA,
          siteId: siteA,
          partyId: brandId,
          number: 'SEED-REP-0002',
          kind: RepairKind.ALTERATION,
          styleId: production.styleId,
          size: '52',
          problem: 'The rider asks for the sleeves shortened by 2 cm.',
          stage: RepairStage.RECEIVED,
          receivedAt: T.received,
          inboundDdtNumber: 'SEED-C1-R-9',
          inboundDdtDate: new Date('2026-11-24T00:00:00.000Z'),
          ownerId: actorId,
          ...stamp(T.received),
        },
        select,
      })
      await event(1, null, RepairStage.RECEIVED, T.received)
      await tx.repairOrder.update({ where: { id: repairId }, data: { stage: RepairStage.IN_REPAIR, version: 2, updatedAt: T.altering }, select })
      await event(2, RepairStage.RECEIVED, RepairStage.IN_REPAIR, T.altering)
      await tx.repairOrder.update({ where: { id: repairId }, data: { stage: RepairStage.REPAIRED, repairedAt: T.altered, version: 3, updatedAt: T.altered }, select })
      await event(3, RepairStage.IN_REPAIR, RepairStage.REPAIRED, T.altered)

      // The DDT: as allocateNumber does, the series row locked, its next number taken and recorded, the counter moved.
      const [series] = await tx.$queryRaw<{ nextValue: number }[]>`SELECT "nextValue" FROM "NumberSeries" WHERE "id" = ${ddtSeriesId}::uuid FOR UPDATE`
      const value = series!.nextValue
      await tx.ddt.create({
        data: {
          id: repairDdtId,
          companyId: companyA,
          siteId: siteA,
          partyId: brandId,
          sourceType: 'RepairOrder',
          sourceId: repairId,
          numberSeriesId: ddtSeriesId,
          number: `${value}/${YEAR}`,
          documentDate: DDT_DATE,
          reason: DdtReason.REPAIR,
          transportBy: TransportBy.SENDER,
          startAt: T.start,
          appearance: 'Una scatola di cartone',
          packages: 1,
          grossWeightKg: '2.4000',
          netWeightKg: '1.9000',
          freight: DdtFreight.FREE,
          sender: { name: 'Seed Factory A S.r.l.', vatNumber: 'IT00000000000', address: { line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT' } },
          recipient: { name: 'Seed Customer One S.r.l.', vatNumber: 'IT00000000001', address: { line1: 'Via Esempio 10', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' } },
          lines: [{ seq: 1, description: 'Giacca moto in pelle SEED-JKT-02, taglia 52, maniche accorciate (vostra riparazione SEED-REP-0002)', quantity: '1', uom: 'PCS', size: '52' }],
          documentRefs: [{ kind: 'CUSTOMER_DDT', number: 'SEED-C1-R-9', date: '2026-11-24' }],
          remarks: 'Reso dopo lavorazione: nessun addebito per la merce.',
          issuedAt: T.ddt,
          createdById: actorId,
        },
        select,
      })
      await tx.numberAllocation.create({
        data: {
          id: lastId(`holds:allocation:DDT:${value}`),
          companyId: companyA,
          seriesId: ddtSeriesId,
          kind: 'DDT',
          value,
          formatted: `${value}/${YEAR}`,
          documentDate: DDT_DATE,
          recordType: 'Ddt',
          recordId: repairDdtId,
          allocatedAt: T.ddt,
          allocatedById: actorId,
          requestId: `seed-holds-${namespace}-ddt`,
        },
        select,
      })
      await tx.numberSeries.update({ where: { id: ddtSeriesId }, data: { nextValue: value + 1, lastIssuedDate: DDT_DATE, updatedAt: T.ddt }, select })

      await tx.repairOrder.update({ where: { id: repairId }, data: { stage: RepairStage.SHIPPED, shippedAt: T.left, version: 4, updatedAt: T.left }, select })
      await event(4, RepairStage.REPAIRED, RepairStage.SHIPPED, T.left)
    }),
  )

  return { defectCodeIds, dispositionCodeIds, holdId, openNcrId, ncrId, actionIds, dispositionLineId, linkId, repairId, repairDdtId }
}
