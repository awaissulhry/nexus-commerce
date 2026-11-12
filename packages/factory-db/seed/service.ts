import {
  AccidentOutcome,
  ProductSafetyReportStatus,
  ProductSafetySource,
  RepairEstimateAnswerVia,
  RepairEstimateLineKind,
  RepairEstimateStatus,
  ReturnFeeKind,
  ReturnFreightPayer,
  ReturnPolicyChannel,
  ServiceCaseChannel,
  ServiceCaseKind,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseWish,
  ServiceCover,
  ServiceCoverDecision,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedReturns, type ReturnsSeed } from './returns'

/**
 * The returns, repairs, service and product safety seed (W2b-5, schema wave 43/44, B-W2b-291), per tenant of seed/_core.ts,
 * written in the tenant's office scope as apps/factory-api's W2b-5 modules will write it. It runs the auth seed (the owner and
 * the member) and the returns seed (SEED-RMA-0001/0002, SEED-REP-0001, and through it the money, shipping, quality and
 * production seeds: SEED-JKT-02 with its batch SEED-BT-0001, SEED-JKT-03 with its serials SEED-SN-0001..0003 of batch
 * SEED-BT-0003, the register entry SEED-REG-2026-001) first, all idempotent.
 *
 *   policies    company A: the business customers' policy of last season, retired (the first row); the live one for business
 *               customers (30 days to ask, 15 for the goods, freight by cause); the live one for consumers at a distance
 *               (14 days, the withdrawal words a placeholder for the lawyer). SEED-RMA-0001 is checked against the live
 *               business policy.
 *   fee rules   company A: "Change of mind" 10 % of the credit on every channel (the first row); "Wrong size ordered" 15.00
 *               EUR for business customers; an old flat fee switched off.
 *   RMAs        SEED-RMA-0002 gets its scan code, and its line the lot of ours it is (SEED-BT-0001). The split, the credit
 *               without the goods, the size exchange and the fee are written by the PG test, not here: a seeded line would
 *               take back pieces the isolation copy of SEED-RMA-0001's line needs.
 *   estimates   SEED-REP-0001's revision 1 (a zip and 45 minutes of work) sent and declined by link ("too dear"); revision 2,
 *               a DRAFT with a cheaper zip and 30 minutes (the first estimate and its zip line the first lines).
 *   cases       SVC-SEED-0001: a NEW warranty case about serial SEED-SN-0002 (batch SEED-BT-0003) from P1's buyer, the
 *               factory's guarantee to 2028 (the first row, linked to SEED-RMA-0001: the first link); SVC-SEED-0002: the
 *               SAFETY case of the mailed safety report, OPEN; SVC-SEED-0003: a repair case covered by the factory's
 *               guarantee, resolved and closed, linked to SEED-RMA-0002 and SEED-REP-0001.
 *   reports     PSR-SEED-0001 by phone about SEED-JKT-02, batch SEED-BT-0001, NEW, nobody hurt (the first report and the first
 *               injury); PSR-SEED-0002 by mail, a fall on a track day, seen and ASSESSING, its SAFETY case and the register
 *               entry SEED-REG-2026-001, an injury in words with the consent, and its accident log: revision 1 recorded,
 *               revision 2 when the authority was told (the first log row); PSR-SEED-0003 from P1's portal, CLOSED, its
 *               reporter's data and injury words erased on request.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: a
 * retired policy (one live policy per company and channel), a fee rule, a DRAFT estimate and its line, a NEW case and its
 * link, a NEW report and its injury (the key only starts with injury:<report>), the accident log's revision 2 with its
 * reason (a copy's revision is higher still). Every name, number, word and amount is made up; every time is before the
 * day the wave was built (the guards refuse a time in the future). Idempotent: written once, skipped when its first row
 * exists.
 */

const T = {
  oldPolicy: new Date('2026-01-10T08:00:00.000Z'),
  retired: new Date('2026-10-01T07:00:00.000Z'),
  policies: new Date('2026-10-01T08:00:00.000Z'),
  rules: new Date('2026-10-01T09:00:00.000Z'),
  case3: new Date('2026-10-20T08:00:00.000Z'),
  case3Cover: new Date('2026-10-22T10:00:00.000Z'),
  case3Resolved: new Date('2026-10-28T15:00:00.000Z'),
  case3Closed: new Date('2026-10-30T09:00:00.000Z'),
  report3: new Date('2026-10-15T09:30:00.000Z'),
  report3Seen: new Date('2026-10-15T10:00:00.000Z'),
  report3Closed: new Date('2026-10-25T11:00:00.000Z'),
  report3Erased: new Date('2026-10-27T08:00:00.000Z'),
  report2: new Date('2026-11-02T07:30:00.000Z'),
  report2Seen: new Date('2026-11-02T08:00:00.000Z'),
  case2: new Date('2026-11-02T08:10:00.000Z'),
  accident1: new Date('2026-11-02T09:00:00.000Z'),
  authorityTold: new Date('2026-11-03T10:00:00.000Z'),
  accident2: new Date('2026-11-03T10:05:00.000Z'),
  estimate1: new Date('2026-11-03T09:00:00.000Z'),
  estimate1Sent: new Date('2026-11-03T11:00:00.000Z'),
  estimate1Declined: new Date('2026-11-04T10:00:00.000Z'),
  estimate2: new Date('2026-11-05T09:00:00.000Z'),
  case1: new Date('2026-11-06T08:00:00.000Z'),
  report1: new Date('2026-11-07T09:00:00.000Z'),
} as const
const DAY = {
  oldPolicyFrom: new Date('2025-01-01T00:00:00.000Z'),
  policyFrom: new Date('2026-10-01T00:00:00.000Z'),
  delivered: new Date('2026-10-05T00:00:00.000Z'),
  factoryGuaranteeEnds: new Date('2028-10-05T00:00:00.000Z'),
  case3Delivered: new Date('2026-06-12T00:00:00.000Z'),
  case3FactoryEnds: new Date('2028-06-12T00:00:00.000Z'),
  estimate2Until: new Date('2026-12-05T00:00:00.000Z'),
  accident: new Date('2026-11-01T00:00:00.000Z'),
  report1Happened: new Date('2026-11-05T00:00:00.000Z'),
  report3Happened: new Date('2026-10-12T00:00:00.000Z'),
} as const

export interface ServiceSeed {
  readonly returns: ReturnsSeed
  readonly companyA: string
  readonly ownerId: string
  readonly memberId: string
  readonly policyIds: { readonly retired: string; readonly b2b: string; readonly consumer: string }
  readonly feeRuleIds: { readonly changeOfMind: string; readonly wrongSize: string; readonly off: string }
  readonly estimateIds: { readonly draft: string; readonly declined: string }
  readonly estimateLineIds: { readonly draftZip: string; readonly draftLabour: string; readonly declinedZip: string; readonly declinedLabour: string }
  readonly caseIds: { readonly warranty: string; readonly safety: string; readonly closed: string }
  readonly linkIds: { readonly warranty: string; readonly closedRma: string; readonly closedRepair: string }
  readonly reportIds: { readonly phoned: string; readonly mailed: string; readonly portal: string }
  readonly injuryIds: { readonly phoned: string; readonly mailed: string; readonly portal: string }
  readonly accidentIds: { readonly recorded: string; readonly told: string }
}

export async function seed(context: SeedContext): Promise<ServiceSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const returns = await seedReturns(context)
  const quality = returns.money.shipping.quality
  const production = quality.production
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const siteA1 = id('site:A1')
  const P1 = id('party:P1')
  const buyer = id('party-contact:P1:buyer')
  const rider = id('party-contact:P1:rider')
  const office = { audience: 'office', tenantId, actorId: ownerId } as const
  const select = { id: true } as const

  const result: ServiceSeed = {
    returns,
    companyA,
    ownerId,
    memberId,
    policyIds: { retired: firstId('service:policy:B2B:2025'), b2b: id('service:policy:B2B'), consumer: id('service:policy:CONSUMER') },
    feeRuleIds: { changeOfMind: firstId('service:fee:CHANGE_OF_MIND'), wrongSize: id('service:fee:WRONG_SIZE'), off: id('service:fee:OLD_FLAT') },
    estimateIds: { draft: firstId('service:estimate:REP-0001:2'), declined: id('service:estimate:REP-0001:1') },
    estimateLineIds: {
      draftZip: firstId('service:estimate:REP-0001:2:10'),
      draftLabour: id('service:estimate:REP-0001:2:20'),
      declinedZip: id('service:estimate:REP-0001:1:10'),
      declinedLabour: id('service:estimate:REP-0001:1:20'),
    },
    caseIds: { warranty: firstId('service:case:SVC-0001'), safety: id('service:case:SVC-0002'), closed: id('service:case:SVC-0003') },
    linkIds: { warranty: firstId('service:case:SVC-0001:link:RMA-0001'), closedRma: id('service:case:SVC-0003:link:RMA-0002'), closedRepair: id('service:case:SVC-0003:link:REP-0001') },
    reportIds: { phoned: firstId('service:report:PSR-0001'), mailed: id('service:report:PSR-0002'), portal: id('service:report:PSR-0003') },
    injuryIds: { phoned: firstId('service:injury:PSR-0001'), mailed: id('service:injury:PSR-0002'), portal: id('service:injury:PSR-0003') },
    accidentIds: { recorded: id('service:accident:PSR-0002:1'), told: firstId('service:accident:PSR-0002:2') },
  }
  const { policyIds: P, feeRuleIds: F, estimateIds: E, estimateLineIds: L, caseIds: C, linkIds: K, reportIds: R, injuryIds: I, accidentIds: A } = result

  if (await db.withScope(office, (client) => client.returnPolicy.findUnique({ where: { id: P.retired }, select }))) return result

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- return policies and fee rules (SAL-338, SAL-343) ------------------------------------------------------------
      const policy = { companyId: companyA, freightPaidBy: ReturnFreightPayer.BY_CAUSE, createdById: ownerId }
      await tx.returnPolicy.create({
        data: {
          id: P.retired, ...policy, channel: ReturnPolicyChannel.B2B, name: 'Brands and dealers 2025', windowDays: 30, goodsDueDays: 20,
          conditions: 'Seed: goods unworn, in their bag, with the RMA sheet.', effectiveFrom: DAY.oldPolicyFrom,
          retiredAt: T.retired, retiredById: ownerId, createdAt: T.oldPolicy, updatedAt: T.retired,
        },
        select,
      })
      await tx.returnPolicy.create({
        data: {
          id: P.b2b, ...policy, channel: ReturnPolicyChannel.B2B, name: 'Brands and dealers', windowDays: 30, goodsDueDays: 15,
          conditions: 'Seed: goods unworn, labels on, in their bag, with the RMA sheet in the box.', effectiveFrom: DAY.policyFrom,
          createdAt: T.policies, updatedAt: T.policies,
        },
        select,
      })
      await tx.returnPolicy.create({
        data: {
          id: P.consumer, ...policy, channel: ReturnPolicyChannel.CONSUMER_DISTANCE, name: 'Web shop', windowDays: 14, goodsDueDays: 14,
          freightPaidBy: ReturnFreightPayer.CUSTOMER, conditions: 'Seed: send the garment back as you received it.',
          withdrawalWords: 'Seed placeholder: the words of the right of withdrawal (Codice del Consumo art. 52), to be confirmed by the lawyer.',
          effectiveFrom: DAY.policyFrom, createdAt: T.policies, updatedAt: T.policies,
        },
        select,
      })
      const rule = { companyId: companyA, createdById: ownerId, createdAt: T.rules, updatedAt: T.rules }
      await tx.returnFeeRule.create({ data: { id: F.changeOfMind, ...rule, name: 'Change of mind', reasonCodes: ['OTHER'], kind: ReturnFeeKind.PERCENT, percent: '10', sequence: 10 }, select })
      await tx.returnFeeRule.create({
        data: { id: F.wrongSize, ...rule, channel: ReturnPolicyChannel.B2B, name: 'Wrong size ordered', reasonCodes: ['WRONG_SIZE'], kind: ReturnFeeKind.AMOUNT, amount: 1500, currency: 'EUR', sequence: 20 },
        select,
      })
      await tx.returnFeeRule.create({ data: { id: F.off, ...rule, name: 'Old flat fee', kind: ReturnFeeKind.AMOUNT, amount: 1000, currency: 'EUR', active: false }, select })

      // --- the W2a RMAs: the policy, the scan code, the lot of ours (SAL-336, SAL-338, SAL-346) -------------------------
      await tx.returnAuthorisation.update({ where: { id: returns.waitingReturnId }, data: { policyId: P.b2b }, select })
      await tx.returnAuthorisation.update({ where: { id: returns.inspectedReturnId }, data: { scanCode: `RMA-SEED-0002-${namespace.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12)}` }, select })
      await tx.returnLine.update({ where: { id: returns.inspectedLineId }, data: { garmentBatch: 'SEED-BT-0001' }, select })

      // --- repair estimates of SEED-REP-0001 (SAL-387) -------------------------------------------------------------------
      const estimate = { companyId: companyA, siteId: siteA1, partyId: P1, repairId: returns.repairId, createdById: ownerId }
      await tx.repairEstimate.create({
        data: { id: E.declined, ...estimate, revision: 1, validUntil: new Date('2026-11-20T00:00:00.000Z'), customerNote: 'Seed: we replace the front zip and re-stitch the seam.', createdAt: T.estimate1, updatedAt: T.estimate1 },
        select,
      })
      const line = { partyId: P1, createdById: ownerId }
      await tx.repairEstimateLine.createMany({
        data: [
          { id: L.declinedZip, ...line, estimateId: E.declined, seq: 10, kind: RepairEstimateLineKind.PART, description: 'Front zip, 60 cm, black', quantity: '1', unitPrice: '28', amount: 2800, unitCost: '9.5', costAmount: 950, createdAt: T.estimate1, updatedAt: T.estimate1 },
          { id: L.declinedLabour, ...line, estimateId: E.declined, seq: 20, kind: RepairEstimateLineKind.LABOUR, description: 'Replace the zip and re-stitch the seam', quantity: '1', minutes: 45, unitPrice: '40', amount: 4000, unitCost: '24', costAmount: 2400, createdAt: T.estimate1, updatedAt: T.estimate1 },
        ],
      })
      await tx.repairEstimate.update({ where: { id: E.declined }, data: { status: RepairEstimateStatus.SENT, sentAt: T.estimate1Sent, sentById: memberId, version: 2, updatedAt: T.estimate1Sent }, select })
      await tx.repairEstimate.update({
        where: { id: E.declined },
        data: { status: RepairEstimateStatus.DECLINED, answeredAt: T.estimate1Declined, answeredVia: RepairEstimateAnswerVia.LINK, answeredByName: 'Seed buyer of P1', declineReason: 'Seed: too dear for a two-year-old jacket.', version: 3, updatedAt: T.estimate1Declined },
        select,
      })
      await tx.repairEstimate.create({
        data: { id: E.draft, ...estimate, revision: 2, validUntil: DAY.estimate2Until, customerNote: 'Seed: a standard zip and the seam only.', internalNote: 'Seed: offered after the first was declined.', createdAt: T.estimate2, updatedAt: T.estimate2 },
        select,
      })
      await tx.repairEstimateLine.createMany({
        data: [
          { id: L.draftZip, ...line, estimateId: E.draft, seq: 10, kind: RepairEstimateLineKind.PART, description: 'Standard zip, 60 cm, black', quantity: '1', unitPrice: '18', amount: 1800, unitCost: '6', costAmount: 600, createdAt: T.estimate2, updatedAt: T.estimate2 },
          { id: L.draftLabour, ...line, estimateId: E.draft, seq: 20, kind: RepairEstimateLineKind.LABOUR, description: 'Replace the zip and re-stitch the seam', quantity: '1', minutes: 30, unitPrice: '30', amount: 3000, unitCost: '16', costAmount: 1600, createdAt: T.estimate2, updatedAt: T.estimate2 },
        ],
      })

      // --- service cases (SAL-368, SAL-436) ------------------------------------------------------------------------------
      const serviceCase = { companyId: companyA, createdById: ownerId }
      await tx.serviceCase.create({
        data: {
          id: C.closed, ...serviceCase, number: 'SVC-SEED-0003', kind: ServiceCaseKind.REPAIR, channel: ServiceCaseChannel.MAIL, status: ServiceCaseStatus.OPEN,
          partyId: P1, contactId: buyer, styleId: production.styleId, batchNumber: 'SEED-BT-0001', garmentBatch: 'SEED-BT-0001', size: '50',
          problem: 'Seed: a seam of the left sleeve opened after two rides.', customerWants: ServiceCaseWish.REPAIR, ownerId: memberId,
          deliveredOn: DAY.case3Delivered, factoryGuaranteeEndsOn: DAY.case3FactoryEnds, createdAt: T.case3, updatedAt: T.case3,
        },
        select,
      })
      // Its links, added while it was open (a closed case's links never change).
      await tx.serviceCaseLink.createMany({
        data: [
          { id: K.closedRma, caseId: C.closed, recordType: 'ReturnAuthorisation', recordId: returns.inspectedReturnId, note: 'Seed: the jacket came back on this return.', createdById: memberId, createdAt: T.case3 },
          { id: K.closedRepair, caseId: C.closed, recordType: 'RepairOrder', recordId: returns.repairId, createdById: memberId, createdAt: T.case3 },
        ],
      })
      await tx.serviceCase.update({
        where: { id: C.closed },
        data: { cover: ServiceCover.FACTORY_GUARANTEE, coverDecision: ServiceCoverDecision.COVERED, coverNote: 'Seed: a seam that opens is a making defect, inside the factory guarantee.', coverDecidedAt: T.case3Cover, coverDecidedById: memberId, version: 2, updatedAt: T.case3Cover },
        select,
      })
      await tx.serviceCase.update({ where: { id: C.closed }, data: { status: ServiceCaseStatus.RESOLVED, resolvedAt: T.case3Resolved, resolution: 'Seed: repaired under the factory guarantee (SEED-REP-0001).', version: 3, updatedAt: T.case3Resolved }, select })
      await tx.serviceCase.update({ where: { id: C.closed }, data: { status: ServiceCaseStatus.CLOSED, closedAt: T.case3Closed, closedById: memberId, version: 4, updatedAt: T.case3Closed }, select })
      await tx.serviceCase.create({
        data: {
          id: C.safety, ...serviceCase, number: 'SVC-SEED-0002', kind: ServiceCaseKind.SAFETY, channel: ServiceCaseChannel.MAIL, status: ServiceCaseStatus.OPEN,
          styleId: production.styleId, batchNumber: 'SEED-BT-0001', garmentBatch: 'SEED-BT-0001', priority: ServiceCasePriority.URGENT,
          problem: 'Seed: a rider fell on a track day; the jacket is with quality (safety report PSR-SEED-0002).', ownerId: memberId,
          createdAt: T.case2, updatedAt: T.case2,
        },
        select,
      })
      await tx.serviceCase.create({
        data: {
          id: C.warranty, ...serviceCase, number: 'SVC-SEED-0001', kind: ServiceCaseKind.WARRANTY, channel: ServiceCaseChannel.PHONE,
          partyId: P1, contactId: buyer, serial: 'SEED-SN-0002', garmentSerial: 'SEED-SN-0002', garmentBatch: 'SEED-BT-0003', styleId: quality.serialStyleId, size: '52',
          problem: 'Seed: the zip pull of the collar came off.', customerWants: ServiceCaseWish.REPLACE,
          deliveredOn: DAY.delivered, factoryGuaranteeEndsOn: DAY.factoryGuaranteeEnds, createdAt: T.case1, updatedAt: T.case1,
        },
        select,
      })
      await tx.serviceCaseLink.create({ data: { id: K.warranty, caseId: C.warranty, recordType: 'ReturnAuthorisation', recordId: returns.waitingReturnId, note: 'Seed: the jacket is coming back on this return.', createdById: ownerId, createdAt: T.case1 }, select })

      // --- product-safety reports, the injuries kept apart, the accident log (SAL-414, SAL-415, SAL-423) -----------------
      const report = { companyId: companyA, styleId: production.styleId, createdById: ownerId }
      await tx.productSafetyReport.create({
        data: {
          id: R.portal, ...report, number: 'PSR-SEED-0003', source: ProductSafetySource.PORTAL, receivedAt: T.report3, partyId: P1, contactId: rider,
          reporterName: 'Seed rider of P1', reporterEmail: `rider.${namespace}@example.com`, occurredOn: DAY.report3Happened,
          whatHappened: 'Seed: the elbow protector moved out of its pocket in a slide at low speed.', wornAsIntended: true,
          createdAt: T.report3, updatedAt: T.report3,
        },
        select,
      })
      await tx.productSafetyInjury.create({
        data: { id: I.portal, companyId: companyA, reportId: R.portal, key: `injury:${R.portal}`, injured: true, consentAt: T.report3, injuryWords: 'Seed: a bruise on the left elbow.', createdById: ownerId, createdAt: T.report3, updatedAt: T.report3 },
        select,
      })
      await tx.productSafetyReport.update({ where: { id: R.portal }, data: { status: ProductSafetyReportStatus.ASSESSING, seenAt: T.report3Seen, seenById: memberId, version: 2, updatedAt: T.report3Seen }, select })
      await tx.productSafetyReport.update({
        where: { id: R.portal },
        data: { status: ProductSafetyReportStatus.CLOSED, closedAt: T.report3Closed, closedById: memberId, closeNote: 'Seed: the pocket closure was not done up; the garment protects as certified.', version: 3, updatedAt: T.report3Closed },
        select,
      })
      // Erased on the rider's request (GDPR art. 17): the reporter's data and the injury's words.
      await tx.productSafetyReport.update({ where: { id: R.portal }, data: { reporterName: null, reporterEmail: null, version: 4, updatedAt: T.report3Erased }, select })
      await tx.productSafetyInjury.update({ where: { id: I.portal }, data: { injuryWords: null, erasedAt: T.report3Erased, erasedById: ownerId, version: 2, updatedAt: T.report3Erased }, select })

      await tx.productSafetyReport.create({
        data: {
          id: R.mailed, ...report, number: 'PSR-SEED-0002', source: ProductSafetySource.MAIL, receivedAt: T.report2, reporterName: 'Seed track-day rider',
          reporterEmail: `trackday.${namespace}@example.com`, batchNumber: 'SEED-BT-0001', garmentBatch: 'SEED-BT-0001', occurredOn: DAY.accident,
          whatHappened: 'Seed: a fall at 80 km/h on a track day; the shoulder seam opened on the asphalt.', wornAsIntended: true,
          serviceCaseId: C.safety, registerEntryId: quality.registerEntryId, ownerId: memberId, createdAt: T.report2, updatedAt: T.report2,
        },
        select,
      })
      await tx.productSafetyReport.update({ where: { id: R.mailed }, data: { status: ProductSafetyReportStatus.ASSESSING, seenAt: T.report2Seen, seenById: memberId, version: 2, updatedAt: T.report2Seen }, select })
      await tx.productSafetyInjury.create({
        data: { id: I.mailed, companyId: companyA, reportId: R.mailed, key: `injury:${R.mailed}`, injured: true, consentAt: T.report2, injuryWords: 'Seed: an abrasion on the right shoulder, treated at the circuit.', createdById: ownerId, createdAt: T.report2, updatedAt: T.report2 },
        select,
      })
      await tx.accidentLogEntry.create({
        data: { id: A.recorded, companyId: companyA, reportId: R.mailed, revision: 1, occurredOn: DAY.accident, place: 'Seed: track day, a circuit in Tuscany', styleId: production.styleId, batchNumber: 'SEED-BT-0001', outcome: AccidentOutcome.MINOR_HARM, createdById: memberId, createdAt: T.accident1 },
        select,
      })
      await tx.accidentLogEntry.create({
        data: {
          id: A.told, companyId: companyA, reportId: R.mailed, revision: 2, occurredOn: DAY.accident, place: 'Seed: track day, a circuit in Tuscany', styleId: production.styleId, batchNumber: 'SEED-BT-0001',
          outcome: AccidentOutcome.MINOR_HARM, authorityToldAt: T.authorityTold, authorityToldById: ownerId, authorityReference: 'SEED-SBG-2026-0107',
          note: 'Seed: the authority was told through the Safety Business Gateway.', createdById: memberId, createdAt: T.accident2,
        },
        select,
      })

      await tx.productSafetyReport.create({
        data: {
          id: R.phoned, ...report, number: 'PSR-SEED-0001', source: ProductSafetySource.OFFICE, receivedAt: T.report1, reporterName: 'Seed caller',
          reporterPhone: '+39 055 000 0000', batchNumber: 'SEED-BT-0001', garmentBatch: 'SEED-BT-0001', occurredOn: DAY.report1Happened,
          whatHappened: 'Seed: the reflective print of the back panel peeled off after a wash.', createdAt: T.report1, updatedAt: T.report1,
        },
        select,
      })
      await tx.productSafetyInjury.create({ data: { id: I.phoned, companyId: companyA, reportId: R.phoned, key: `injury:${R.phoned}`, injured: false, createdById: ownerId, createdAt: T.report1, updatedAt: T.report1 }, select })
    }),
  )

  return result
}
