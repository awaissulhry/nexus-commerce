import { createHash } from 'node:crypto'
import {
  AqlInspectionLevel,
  DefectClass,
  IncomingComponentKind,
  IncomingInspectionStatus,
  IncomingUnitDecision,
  InProcessCheckKind,
  InProcessCheckStatus,
  InProcessOutcome,
  InspectionAmendmentKind,
  InspectionCheckOutcome,
  InspectionCheckType,
  InspectionFrequency,
  InspectionPlanStage,
  InspectionPlanVersionStatus,
  InspectionSamplingMethod,
  InspectionTriggerEvent,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedHolds } from './holds'
import { seed as seedProduction } from './production'

/**
 * The inspection plans and records seed (W2b schema wave 10/16, B-W2b-76), per tenant of seed/_core.ts. Plans, profiles
 * and rules are written in the tenant's office scope, the records on plant A1 in A1's floor scope (the plant's team
 * leader as the inspector), the amendment in the office scope, as the app does. The CLI runs this file after seed/holds.ts
 * (name order); it runs that seed anyway (idempotent): it brings the production, inventory and quality seeds and the
 * defect library.
 *
 *   profiles    AQL-STD (level II, major 2.5, minor 4.0, the company default) and AQL-EXM (level II, 1.5 and 2.5) for the
 *               brand P1; an older, inactive assignment of the jacket style to AQL-STD.
 *   plans       FIN-JACKET (final): v1 APPROVED, v2 a DRAFT; INC-LEATHER (incoming): v1 APPROVED; INL-FIRST (in-line): v1
 *               APPROVED. Written by the seed's office user, approved by another (the author never approves).
 *   rules       goods received → INC-LEATHER on every lot; bundle scanned → INL-FIRST, first piece; operation finished →
 *               INL-FIRST on 10 % of operations.
 *   final       an OPEN final inspection of SEED-WO-0001 on FIN-JACKET v1 (SEED-INS-0009, AQL-STD, code letter A), its CE
 *               result and a chest measurement.
 *   incoming    of P2's lot SEED-LOT-LEA-01: SEED-IIN-0001 OPEN (one hide, a roll and a protector check begun, the shade
 *               result, the thickness); SEED-IIN-0002 DECIDED, 1 hide accepted and 1 rejected, with an amendment of its
 *               note asked and countersigned.
 *   in-process  on line L1: a roving check GREEN; SEED-WO-0001's first piece at sewing APPROVED on INL-FIRST v1 (so the run
 *               is not held); an end-of-line FAIL with its defect, sent back to sewing. Per operation: no operator named.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a version starts DRAFT and only a DRAFT's checks change, an incoming inspection starts OPEN and only an OPEN
 * record takes results, an active assignment and a decided hide are one per subject, and a default profile one per
 * company. So the DRAFT version and its check, the OPEN incoming inspection and its rows, the inactive assignment and the
 * profile that is not the default get ids that start with eight zeros. Numbers are made-up SEED- numbers, not numbers of
 * the company's series, which stay for the app. Every name, number and value is invented. Idempotent: written once,
 * skipped when the first plan exists.
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  written: new Date('2026-11-18T08:00:00.000Z'),
  approved: new Date('2026-11-18T09:00:00.000Z'),
  inspected: new Date('2026-11-18T10:00:00.000Z'),
  decided: new Date('2026-11-18T11:00:00.000Z'),
  amended: new Date('2026-11-18T12:00:00.000Z'),
}

export interface InspectionPlansSeed {
  readonly profileIds: { readonly standard: string; readonly customer: string }
  readonly planIds: { readonly final: string; readonly incoming: string; readonly inLine: string }
  /** The APPROVED versions, and FIN-JACKET's DRAFT. */
  readonly versionIds: { readonly final: string; readonly finalDraft: string; readonly incoming: string; readonly inLine: string }
  readonly checkIds: {
    readonly ce: string
    readonly chest: string
    readonly shade: string
    readonly thickness: string
    readonly seam: string
    readonly draft: string
  }
  /** The OPEN final inspection on FIN-JACKET v1. */
  readonly inspectionId: string
  /** SEED-IIN-0001 (OPEN) and SEED-IIN-0002 (DECIDED). */
  readonly openIncomingId: string
  readonly decidedIncomingId: string
  readonly firstPieceId: string
  readonly rovingId: string
  /** The amendment asked of SEED-IIN-0002. */
  readonly amendmentId: string
  readonly lotId: string
  readonly itemId: string
  readonly hideIds: readonly [string, string]
  readonly workOrderId: string
  readonly bundleIds: readonly [string, string]
  readonly operationIds: { readonly cut: string; readonly sew: string; readonly qc: string; readonly pack: string }
  readonly sewingOperationId: string
  readonly lineId: string
  readonly inspectorId: string
  readonly operatorId: string
  readonly deviceId: string
  readonly approverId: string
}

export async function seed(context: SeedContext): Promise<InspectionPlansSeed> {
  const { db, namespace } = context
  const holds = await seedHolds(context)
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const lineId = id('site:A1:line:L1')
  const brandId = id('party:P1')
  const approverId = id('inspection-plans:user:quality-manager')
  const inspectorId = production.leadId
  const lotId = production.inventory.leatherLotId
  const itemId = id('product:item:leather')
  const [hide1, hide2] = production.inventory.hideIds
  const sewingOperationId = production.operationIds.sew
  const office = { audience: 'office' as const, tenantId, actorId }
  const inspector = { audience: 'floor' as const, tenantId, actorId: inspectorId, siteId: siteA }
  const stamp = (at: Date, by: string) => ({ createdAt: at, updatedAt: at, createdById: by })
  const sha = (key: string): string => createHash('sha256').update(`seed signed inspection ${key} (${namespace})`).digest('hex')

  const profileIds = { standard: id('inspection-plans:aql:STD'), customer: firstId('inspection-plans:aql:EXM') }
  const planIds = { final: firstId('inspection-plans:plan:FIN-JACKET'), incoming: id('inspection-plans:plan:INC-LEATHER'), inLine: id('inspection-plans:plan:INL-FIRST') }
  const versionIds = {
    final: id('inspection-plans:version:FIN-JACKET:1'),
    finalDraft: firstId('inspection-plans:version:FIN-JACKET:2'),
    incoming: id('inspection-plans:version:INC-LEATHER:1'),
    inLine: id('inspection-plans:version:INL-FIRST:1'),
  }
  const checkIds = {
    ce: id('inspection-plans:check:FIN-JACKET:1:CE_MARK'),
    chest: id('inspection-plans:check:FIN-JACKET:1:CHEST'),
    shade: id('inspection-plans:check:INC-LEATHER:1:SHADE'),
    thickness: id('inspection-plans:check:INC-LEATHER:1:THICKNESS'),
    seam: id('inspection-plans:check:INL-FIRST:1:SEAM'),
    draft: firstId('inspection-plans:check:FIN-JACKET:2:CE_MARK'),
  }
  const inspectionId = id('inspection-plans:inspection:WO-0001')
  const openIncomingId = firstId('inspection-plans:incoming:1')
  const decidedIncomingId = id('inspection-plans:incoming:2')
  const rovingId = firstId('inspection-plans:in-process:roving')
  const firstPieceId = id('inspection-plans:in-process:first-piece')
  const endOfLineId = id('inspection-plans:in-process:end-of-line')
  const amendmentId = firstId('inspection-plans:amendment:1')
  const result = {
    profileIds,
    planIds,
    versionIds,
    checkIds,
    inspectionId,
    openIncomingId,
    decidedIncomingId,
    firstPieceId,
    rovingId,
    amendmentId,
    lotId,
    itemId,
    hideIds: [hide1, hide2] as const,
    workOrderId: production.workOrderId,
    bundleIds: production.bundleIds,
    operationIds: production.operationIds,
    sewingOperationId,
    lineId,
    inspectorId,
    operatorId: production.operatorId,
    deviceId: production.deviceId,
    approverId,
  }

  const done = await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.inspectionPlan.findUnique({ where: { id: planIds.final }, select: { id: true } })) return true
      const by = stamp(T.written, actorId)
      await tx.aqlProfile.createMany({
        data: [
          { id: profileIds.customer, companyId: companyA, code: 'AQL-EXM', name: 'Brand P1', inspectionLevel: AqlInspectionLevel.II, aqlMajor: '1.500', aqlMinor: '2.500', ...by },
          { id: profileIds.standard, companyId: companyA, code: 'AQL-STD', name: 'Company standard', inspectionLevel: AqlInspectionLevel.II, aqlMajor: '2.500', aqlMinor: '4.000', isDefault: true, ...by },
        ],
      })
      await tx.aqlProfileAssignment.createMany({
        data: [
          { id: firstId('inspection-plans:aql-assignment:old'), companyId: companyA, profileId: profileIds.standard, styleId: production.styleId, active: false, ...by },
          { id: id('inspection-plans:aql-assignment:P1'), companyId: companyA, profileId: profileIds.customer, customerId: brandId, ...by },
        ],
      })
      await tx.inspectionPlan.createMany({
        data: [
          { id: planIds.final, companyId: companyA, code: 'FIN-JACKET', stage: InspectionPlanStage.FINAL, name: 'Final inspection, jackets', ownerId: actorId, appliesTo: [{ kind: 'CATEGORY', value: 'JACKET' }], ...by },
          { id: planIds.incoming, companyId: companyA, code: 'INC-LEATHER', stage: InspectionPlanStage.INCOMING, name: 'Leather, hide by hide', ownerId: actorId, ...by },
          { id: planIds.inLine, companyId: companyA, code: 'INL-FIRST', stage: InspectionPlanStage.IN_LINE, name: 'First piece, sewing', ownerId: actorId, ...by },
        ],
      })
      const version = (rowId: string, planId: string, number: number, extra: object = {}) => ({ id: rowId, companyId: companyA, planId, number, authorId: actorId, ...extra, ...by })
      await tx.inspectionPlanVersion.createMany({
        data: [
          version(versionIds.finalDraft, planIds.final, 2, { changeNote: 'Adds the reflective panels.' }),
          version(versionIds.final, planIds.final, 1, { stopAtReject: false }),
          version(versionIds.incoming, planIds.incoming, 1, { aqlProfileId: profileIds.standard, frequency: InspectionFrequency.EVERY_LOT }),
          version(versionIds.inLine, planIds.inLine, 1, { samplingMethod: InspectionSamplingMethod.FIXED, fixedSampleSize: 1, frequency: InspectionFrequency.FIRST_PIECE }),
        ],
      })
      const check = (rowId: string, planVersionId: string, sortOrder: number, code: string, labelIt: string, labelEn: string, type: InspectionCheckType, extra: object = {}) => ({
        id: rowId,
        planVersionId,
        sortOrder,
        code,
        labelIt,
        labelEn,
        type,
        ...extra,
        ...by,
      })
      await tx.inspectionPlanCheck.createMany({
        data: [
          check(checkIds.draft, versionIds.finalDraft, 10, 'CE_MARK', 'Marcatura CE', 'CE marking', InspectionCheckType.PASS_FAIL, { checkClass: DefectClass.CRITICAL }),
          check(checkIds.ce, versionIds.final, 10, 'CE_MARK', 'Marcatura CE', 'CE marking', InspectionCheckType.PASS_FAIL, { checkClass: DefectClass.CRITICAL }),
          check(checkIds.chest, versionIds.final, 20, 'CHEST', 'Mezzo torace', 'Chest half', InspectionCheckType.MEASUREMENT, { checkClass: DefectClass.MAJOR, nominal: '58.000', tolerance: '1.000', uom: Uom.CM }),
          check(id('inspection-plans:check:FIN-JACKET:1:READ'), versionIds.final, 30, 'READ', 'Leggere la scheda', 'Read the sheet', InspectionCheckType.INSTRUCTION, { mandatory: false }),
          check(checkIds.shade, versionIds.incoming, 10, 'SHADE', 'Tono contro il campione', 'Shade against the swatch', InspectionCheckType.CHOICE, { checkClass: DefectClass.MAJOR, choices: ['1', '2', '3'] }),
          check(checkIds.thickness, versionIds.incoming, 20, 'THICKNESS', 'Spessore', 'Thickness', InspectionCheckType.MEASUREMENT, { checkClass: DefectClass.MINOR, mandatory: false, nominal: '1.200', tolerance: '0.200', uom: Uom.MM }),
          check(checkIds.seam, versionIds.inLine, 10, 'SEAM', 'Cucitura di sicurezza', 'Safety seam', InspectionCheckType.PASS_FAIL, { checkClass: DefectClass.CRITICAL }),
        ],
      })
      for (const versionId of [versionIds.final, versionIds.incoming, versionIds.inLine]) {
        await tx.inspectionPlanVersion.update({
          where: { id: versionId },
          data: { status: InspectionPlanVersionStatus.APPROVED, approvedById: approverId, approvedAt: T.approved, approvalSha256: sha(`approval:${versionId}`), updatedAt: T.approved },
          select: { id: true },
        })
      }
      await tx.inspectionTrigger.createMany({
        data: [
          { id: firstId('inspection-plans:trigger:receipt'), companyId: companyA, sortOrder: 10, event: InspectionTriggerEvent.GOODS_RECEIPT, appliesTo: [{ kind: 'MATERIAL', value: itemId }], planId: planIds.incoming, frequency: InspectionFrequency.EVERY_LOT, ...by },
          { id: id('inspection-plans:trigger:bundle'), companyId: companyA, sortOrder: 20, event: InspectionTriggerEvent.BUNDLE_SCAN, planId: planIds.inLine, frequency: InspectionFrequency.FIRST_PIECE, ...by },
          { id: id('inspection-plans:trigger:operation'), companyId: companyA, sortOrder: 30, event: InspectionTriggerEvent.OPERATION_FINISHED, planId: planIds.inLine, frequency: InspectionFrequency.PERCENT_OF_OPERATIONS, frequencyValue: 10, ...by },
        ],
      })
      return false
    }),
  )
  if (done) return result

  await db.withScope(inspector, (client) =>
    client.$transaction(async (tx) => {
      const by = stamp(T.inspected, inspectorId)
      const recorded = { recordedByWorkerId: inspectorId, deviceId: production.deviceId, recordedAt: T.inspected }
      // The final inspection on its plan.
      await tx.inspection.create({
        data: {
          id: inspectionId,
          companyId: companyA,
          siteId: siteA,
          workOrderId: production.workOrderId,
          number: 'SEED-INS-0009',
          lotSize: 2,
          sampleSize: 2,
          inspectionLevel: 'II',
          aqlMajor: '2.500',
          aqlMinor: '4.000',
          acceptMajor: 0,
          acceptMinor: 0,
          inspectorWorkerId: inspectorId,
          planVersionId: versionIds.final,
          aqlProfileId: profileIds.standard,
          codeLetter: 'A',
          ...by,
        },
        select: { id: true },
      })
      await tx.inspectionCheckResult.create({ data: { id: id('inspection-plans:result:final:CE_MARK'), siteId: siteA, inspectionId, planCheckId: checkIds.ce, outcome: InspectionCheckOutcome.PASS, ...recorded, ...by }, select: { id: true } })
      await tx.inspectionMeasurement.create({
        data: { id: id('inspection-plans:measure:final:CHEST'), siteId: siteA, inspectionId, planCheckId: checkIds.chest, pointCode: 'CHEST', size: '52', nominal: '58.000', tolerance: '1.000', measured: '58.400', uom: Uom.CM, ...recorded, ...by },
        select: { id: true },
      })

      // SEED-IIN-0001, OPEN: a hide, a roll and a protector check begun.
      const sampling = { inspectionLevel: 'II', aqlMajor: '2.500', aqlMinor: '4.000', acceptMajor: 0, acceptMinor: 0 }
      const lot = { companyId: companyA, siteId: siteA, lotId, itemId, planVersionId: versionIds.incoming, aqlProfileId: profileIds.standard, codeLetter: 'A', lotSize: '2.0000', uom: Uom.HIDE, sampleSize: 2, ...sampling, inspectorWorkerId: inspectorId }
      await tx.incomingInspection.create({ data: { id: openIncomingId, number: 'SEED-IIN-0001', dueAt: T.decided, ...lot, ...by }, select: { id: true } })
      await tx.incomingHideResult.create({
        data: { id: firstId('inspection-plans:hide:1:H1'), siteId: siteA, incomingInspectionId: openIncomingId, lotId, hideId: hide1, seq: 1, declaredArea: '53.0000', measuredArea: '52.4000', areaUom: Uom.FT2, ...by },
        select: { id: true },
      })
      await tx.incomingRollResult.create({
        data: { id: firstId('inspection-plans:roll:1:R1'), siteId: siteA, incomingInspectionId: openIncomingId, rollRef: 'SEED-ROLL-01', onePoint: 3, twoPoint: 1, widthCm: '140.00', lengthM: '50.00', ...by },
        select: { id: true },
      })
      await tx.incomingComponentResult.create({
        data: { id: firstId('inspection-plans:component:1:P1'), siteId: siteA, incomingInspectionId: openIncomingId, seq: 1, kind: IncomingComponentKind.PROTECTOR, marking: 'EN 1621-1 L2', protectorType: 'A', size: 'M', checkedQuantity: 5, ...by },
        select: { id: true },
      })
      await tx.inspectionCheckResult.create({ data: { id: firstId('inspection-plans:result:1:SHADE'), siteId: siteA, incomingInspectionId: openIncomingId, planCheckId: checkIds.shade, outcome: InspectionCheckOutcome.PASS, value: '1', ...recorded, ...by }, select: { id: true } })
      await tx.inspectionMeasurement.create({
        data: { id: firstId('inspection-plans:measure:1:THICKNESS'), siteId: siteA, incomingInspectionId: openIncomingId, planCheckId: checkIds.thickness, pointCode: 'THICKNESS', nominal: '1.200', tolerance: '0.200', measured: '1.250', uom: Uom.MM, ...recorded, ...by },
        select: { id: true },
      })

      // SEED-IIN-0002, DECIDED: one hide accepted, one rejected.
      await tx.incomingInspection.create({ data: { id: decidedIncomingId, number: 'SEED-IIN-0002', ...lot, ...by }, select: { id: true } })
      await tx.incomingHideResult.createMany({
        data: [
          { id: id('inspection-plans:hide:2:H1'), siteId: siteA, incomingInspectionId: decidedIncomingId, lotId, hideId: hide1, seq: 1, declaredArea: '53.0000', measuredArea: '52.4000', areaUom: Uom.FT2, shadeGroup: '1', grade: 'A', decision: IncomingUnitDecision.ACCEPTED, ...by },
          {
            id: id('inspection-plans:hide:2:H2'),
            siteId: siteA,
            incomingInspectionId: decidedIncomingId,
            lotId,
            hideId: hide2,
            seq: 2,
            declaredArea: '52.0000',
            measuredArea: '51.8000',
            areaUom: Uom.FT2,
            shadeGroup: '2',
            grade: 'C',
            marks: [{ x: 0.42, y: 0.31, code: 'GRAIN-CRACK', zone: 'B' }],
            decision: IncomingUnitDecision.REJECTED,
            ...by,
          },
        ],
      })
      await tx.inspectionCheckResult.create({ data: { id: id('inspection-plans:result:2:SHADE'), siteId: siteA, incomingInspectionId: decidedIncomingId, planCheckId: checkIds.shade, outcome: InspectionCheckOutcome.PASS, value: '1', ...recorded, ...by }, select: { id: true } })
      await tx.incomingInspection.update({
        where: { id: decidedIncomingId },
        data: {
          status: IncomingInspectionStatus.DECIDED,
          foundMajor: 1,
          acceptMajor: 1,
          acceptedQuantity: '1.0000',
          rejectedQuantity: '1.0000',
          toSortQuantity: '0.0000',
          decidedAt: T.decided,
          signatureSha256: sha('incoming:2'),
          updatedAt: T.decided,
        },
        select: { id: true },
      })

      // In-process checks of line L1, per operation: no operator named.
      await tx.inProcessCheck.create({
        data: {
          id: rovingId,
          companyId: companyA,
          siteId: siteA,
          kind: InProcessCheckKind.ROVING,
          status: InProcessCheckStatus.DECIDED,
          outcome: InProcessOutcome.GREEN,
          lineId,
          workOrderId: production.workOrderId,
          workOrderOperationId: sewingOperationId,
          pieces: 5,
          inspectorWorkerId: inspectorId,
          decidedAt: T.inspected,
          ...by,
        },
        select: { id: true },
      })
      await tx.inProcessCheck.create({
        data: {
          id: firstPieceId,
          companyId: companyA,
          siteId: siteA,
          kind: InProcessCheckKind.FIRST_PIECE,
          lineId,
          workOrderId: production.workOrderId,
          bundleId: production.bundleIds[0],
          workOrderOperationId: sewingOperationId,
          planVersionId: versionIds.inLine,
          inspectorWorkerId: inspectorId,
          ...by,
        },
        select: { id: true },
      })
      await tx.inspectionCheckResult.create({ data: { id: id('inspection-plans:result:first-piece:SEAM'), siteId: siteA, inProcessCheckId: firstPieceId, planCheckId: checkIds.seam, outcome: InspectionCheckOutcome.PASS, ...recorded, ...by }, select: { id: true } })
      await tx.inProcessCheck.update({
        where: { id: firstPieceId },
        data: { status: InProcessCheckStatus.DECIDED, outcome: InProcessOutcome.APPROVED, pieces: 1, decidedAt: T.decided, signatureSha256: sha('first-piece'), updatedAt: T.decided },
        select: { id: true },
      })
      await tx.inProcessCheck.create({
        data: {
          id: endOfLineId,
          companyId: companyA,
          siteId: siteA,
          kind: InProcessCheckKind.END_OF_LINE,
          status: InProcessCheckStatus.DECIDED,
          outcome: InProcessOutcome.FAIL,
          lineId,
          workOrderId: production.workOrderId,
          bundleId: production.bundleIds[1],
          workOrderOperationId: sewingOperationId,
          pieces: 1,
          defectivePieces: 1,
          defects: 1,
          defectCodeId: holds.defectCodeIds['STITCH-SKIP'],
          inspectorWorkerId: inspectorId,
          decidedAt: T.decided,
          ...by,
        },
        select: { id: true },
      })
    }),
  )

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.inspectionAmendment.create({
        data: {
          id: amendmentId,
          siteId: siteA,
          incomingInspectionId: decidedIncomingId,
          kind: InspectionAmendmentKind.REQUEST,
          field: 'note',
          after: 'Hide 2 went back to the tannery.',
          reason: 'The note was left out at the bench.',
          signedById: actorId,
          signedAt: T.amended,
          signatureSha256: sha('amendment:ask'),
          createdAt: T.amended,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.inspectionAmendment.create({
        data: {
          id: id('inspection-plans:amendment:1:signed'),
          siteId: siteA,
          incomingInspectionId: decidedIncomingId,
          kind: InspectionAmendmentKind.SIGNED,
          requestId: amendmentId,
          signedById: approverId,
          signedAt: T.amended,
          signatureSha256: sha('amendment:sign'),
          createdAt: T.amended,
          createdById: approverId,
        },
        select: { id: true },
      })
    }),
  )
  return result
}
