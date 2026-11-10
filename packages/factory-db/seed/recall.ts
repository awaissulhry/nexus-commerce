import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  AuthorityChannel,
  AuthorityNoticeDecision,
  AuthorityNoticeStatus,
  AuthorityRequestStatus,
  ClaimUseKind,
  ComplianceGate,
  ComplianceRequirementKind,
  DistributorNoticeChannel,
  DistributorNoticeStatus,
  FileCategory,
  PpeRegisterKind,
  PpeRegisterRisk,
  RecallKind,
  RecallStatus,
  SustainabilityClaimKind,
  SustainabilityClaimScope,
  SustainabilityClaimStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedComplianceRules } from './compliance-rules'
import { seed as seedFiles } from './files'
import { seed as seedProduct } from './product'
import { seed as seedShipping } from './shipping'

/**
 * The recall, authority and claims seed (W2b-4, schema wave 33/33, B-W2b-222), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the app does. The CLI runs the seed files in name order; this one runs the shipping seed (the
 * style SEED-JKT-01, WO-0001 of batch SEED-BT-0001 and SH-0001, which left for the brand P1), the compliance rules seed (the
 * markets IT and DE), the product seed (the leather) and the files seed (the file store) first, all idempotent.
 *
 *   register     three entries of company A about SEED-JKT-01, all OPEN: SEED-REG-2026-901, a RECALL (the risk YES) of batch
 *                SEED-BT-0001 (WO-0001, SH-0001); SEED-REG-2026-902, a WITHDRAWAL (the risk NO) of the same batch;
 *                SEED-REG-2026-903, an AUTHORITY_REQUEST entry opened from SEED-AR-0002 (its source). W1's register screens
 *                and routes keep to the W1 kinds until B-W2b-260 (apps/factory-api's register store filters them), so the
 *                two new kinds stay out of them.
 *   notices      to the authorities about the recall entry: Italy, a DRAFT (the first row); Germany, SENT through the Safety
 *                Business Gateway by a person, with the authority's reference and the copy sent; and a CANCELLED Italian
 *                draft of the withdrawal entry (the risk was found to be NO).
 *   recalls      SEED-RCL-0001, the withdrawal, a DRAFT of batch SEED-BT-0001 (the first row); SEED-RCL-0002, the recall,
 *                ACTIVE over the batch, WO-0001 and SH-0001, its public notice in Italian and English published;
 *                SEED-RCL-0003, a withdrawal set up by mistake and CANCELLED.
 *   progress     P1 for the DRAFT withdrawal, as a whole (two garments, the first row); P1's SH-0001 for the recall: two sent,
 *                one returned, one still out.
 *   distributors for the recall: P1 by e-mail, a DRAFT (the first row); P1 by e-mail, SENT and ANSWERED; P3 by phone, SENT and
 *                FAILED; for the withdrawal: P1 in the portal, CANCELLED.
 *   requests     SEED-AR-0001 from an Italian market surveillance office, OPEN, about the batch, due 2026-11-18 (the first
 *                row); SEED-AR-0002 from a German one, ANSWERED with an evidence pack named by record type + id (B-W2b-218's
 *                EvidencePack; the id is made up), kept by SEED-REG-2026-903; SEED-AR-0003, logged twice, CANCELLED.
 *   claims       SEED-CL-01, leather from a tannery rated by LWG, a DRAFT with its certificate (the first row); SEED-CL-02,
 *                recycled content of SEED-JKT-01, APPROVED with its test report and no end; SEED-CL-03, PFAS-free, approved,
 *                then WITHDRAWN when its test report expired; SEED-CL-04, its DRAFT replacement with a new report.
 *   uses         SEED-CL-02 on SEED-JKT-01 (the first row), on its label template, and in a catalogue (ended).
 *   switch       the requirement CLAIM-EVIDENCE (compliance-rules.prisma; tenant-wide): the claims register's gate at label
 *                print, switched OFF with the reason (Owner answer 11-09, question Q23: green claims are built switched off
 *                until a style or a market needs them).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: DRAFT
 * notices, recall and claim of OPEN entries, an OPEN request, a progress row of a DRAFT recall without a shipment, a use of an
 * APPROVED claim whose evidence never expires.
 *
 * Every company, authority contact, reference, date, count and answer is made up. Idempotent: each part is written once and
 * skipped when its first row exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (every one before the day the wave was built). */
const T = {
  claimDrafted: new Date('2026-10-01T08:00:00.000Z'),
  claimApproved: new Date('2026-10-02T09:00:00.000Z'),
  reportedRecall: new Date('2026-11-02T09:00:00.000Z'),
  claimWithdrawn: new Date('2026-11-02T10:00:00.000Z'),
  reportedWithdrawal: new Date('2026-11-03T09:00:00.000Z'),
  received: new Date('2026-11-04T08:00:00.000Z'),
  reportedRequest: new Date('2026-11-04T08:30:00.000Z'),
  drafted: new Date('2026-11-05T08:00:00.000Z'),
  sent: new Date('2026-11-05T10:00:00.000Z'),
  started: new Date('2026-11-05T11:00:00.000Z'),
  cancelled: new Date('2026-11-05T12:00:00.000Z'),
  published: new Date('2026-11-06T08:00:00.000Z'),
  told: new Date('2026-11-06T09:00:00.000Z'),
  failed: new Date('2026-11-06T09:30:00.000Z'),
  answered: new Date('2026-11-07T10:00:00.000Z'),
  requestAnswered: new Date('2026-11-08T15:00:00.000Z'),
  useEnded: new Date('2026-11-08T16:00:00.000Z'),
} as const
const DAY = {
  dueItaly: new Date('2026-11-18T00:00:00.000Z'),
  dueGermany: new Date('2026-11-13T00:00:00.000Z'),
  lwgValid: new Date('2027-06-30T00:00:00.000Z'),
  pfasValid: new Date('2026-10-31T00:00:00.000Z'),
  pfasNewValid: new Date('2027-11-30T00:00:00.000Z'),
} as const

export interface RecallSeed {
  readonly styleId: string
  readonly workOrderId: string
  readonly shipmentId: string
  readonly entryIds: { readonly recall: string; readonly withdrawal: string; readonly request: string }
  readonly noticeIds: { readonly draft: string; readonly sent: string; readonly cancelled: string }
  readonly actionIds: { readonly draft: string; readonly active: string; readonly cancelled: string }
  readonly progressIds: { readonly draft: string; readonly active: string }
  readonly distributorNoticeIds: { readonly draft: string; readonly answered: string; readonly failed: string; readonly cancelled: string }
  readonly requestIds: { readonly open: string; readonly answered: string; readonly cancelled: string }
  readonly claimIds: { readonly draft: string; readonly approved: string; readonly withdrawn: string; readonly replacement: string }
  readonly useIds: { readonly style: string; readonly label: string; readonly ended: string }
  readonly fileIds: { readonly lwg: string; readonly recycled: string; readonly pfas: string; readonly pfasNew: string; readonly noticeCopy: string }
  readonly claimRequirementId: string
}

export async function seed(context: SeedContext): Promise<RecallSeed> {
  const { db, namespace } = context
  const shipping = await seedShipping(context)
  await seedComplianceRules(context)
  const product = await seedProduct(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const P3 = id('party:P3')
  const store = id('files:account:r2')
  const office = { audience: 'office', tenantId, actorId } as const
  const select = { id: true } as const
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const production = shipping.quality.production
  const styleId = production.styleId
  const workOrderId = production.workOrderId
  const shipmentId = shipping.shipmentId
  const result: RecallSeed = {
    styleId,
    workOrderId,
    shipmentId,
    entryIds: { recall: id('recall:entry:901'), withdrawal: id('recall:entry:902'), request: id('recall:entry:903') },
    noticeIds: { draft: firstId('recall:notice:IT'), sent: id('recall:notice:DE'), cancelled: id('recall:notice:IT-withdrawal') },
    actionIds: { draft: firstId('recall:action:RCL-0001'), active: id('recall:action:RCL-0002'), cancelled: id('recall:action:RCL-0003') },
    progressIds: { draft: firstId('recall:progress:RCL-0001:P1'), active: id('recall:progress:RCL-0002:P1:SH-0001') },
    distributorNoticeIds: {
      draft: firstId('recall:distributor:P1:draft'),
      answered: id('recall:distributor:P1:answered'),
      failed: id('recall:distributor:P3:failed'),
      cancelled: id('recall:distributor:P1:cancelled'),
    },
    requestIds: { open: firstId('recall:request:AR-0001'), answered: id('recall:request:AR-0002'), cancelled: id('recall:request:AR-0003') },
    claimIds: { draft: firstId('recall:claim:CL-01'), approved: id('recall:claim:CL-02'), withdrawn: id('recall:claim:CL-03'), replacement: id('recall:claim:CL-04') },
    useIds: { style: firstId('recall:use:CL-02:style'), label: id('recall:use:CL-02:label'), ended: id('recall:use:CL-02:catalogue') },
    fileIds: {
      lwg: id('recall:file:lwg'),
      recycled: id('recall:file:recycled'),
      pfas: id('recall:file:pfas'),
      pfasNew: id('recall:file:pfas-new'),
      noticeCopy: id('recall:file:notice-DE'),
    },
    claimRequirementId: id('recall:requirement:CLAIM-EVIDENCE'),
  }
  const { entryIds: E, noticeIds: N, actionIds: A, progressIds: RP, distributorNoticeIds: D, requestIds: R, claimIds: C, useIds: U, fileIds: F } = result

  /** A file of a record (rows only: no object in any store). */
  const file = (fileId: string, recordType: string, recordId: string, name: string, kind: 'CERTIFICATE' | 'DOCUMENT', category: FileCategory, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind,
    category,
    visibility: ['OFFICE'],
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    sha256: createHash('sha256').update(`seed file ${namespace} recall ${fileId}`).digest('hex'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`recall:key:${fileId}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    storeAccountId: store,
    createdAt: at,
    updatedAt: at,
    createdById: actorId,
  })

  // --- The register entries, the authorities told and asking --------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.authorityNotice.findUnique({ where: { id: N.draft }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const entry = (rowId: string, reference: string, kind: PpeRegisterKind, at: Date, data: Partial<Prisma.PpeRegisterEntryCreateManyInput>): Prisma.PpeRegisterEntryCreateManyInput => ({
          id: rowId,
          companyId: companyA,
          reference,
          kind,
          styleId,
          batchNumbers: ['SEED-BT-0001'],
          reportedAt: at,
          description: '',
          ...data,
          ...stamp(at),
        })
        await tx.ppeRegisterEntry.createMany({
          data: [
            entry(E.recall, 'SEED-REG-2026-901', PpeRegisterKind.RECALL, T.reportedRecall, {
              workOrderIds: [workOrderId],
              shipmentIds: [shipmentId],
              description: 'The shoulder protector pocket opens under load: the protector can move out of place in a fall (made-up).',
              investigation: 'The pocket seam of batch SEED-BT-0001 was sewn with the wrong stitch length (made-up).',
              risk: PpeRegisterRisk.YES,
              actionTaken: 'Recall of batch SEED-BT-0001: the pocket seam is sewn again (made-up).',
            }),
            entry(E.withdrawal, 'SEED-REG-2026-902', PpeRegisterKind.WITHDRAWAL, T.reportedWithdrawal, {
              description: 'The hang tag of batch SEED-BT-0001 names the wrong standard class: stopped in the distribution chain (made-up).',
              risk: PpeRegisterRisk.NO,
            }),
            entry(E.request, 'SEED-REG-2026-903', PpeRegisterKind.AUTHORITY_REQUEST, T.reportedRequest, {
              description: 'A German market surveillance office asks for the technical documentation of SEED-JKT-01 (made-up).',
              sourceType: 'AuthorityRequest',
              sourceId: R.answered,
            }),
          ],
        })
        await tx.storedFile.createMany({
          data: [file(F.noticeCopy, 'AuthorityNotice', N.sent, 'Seed notice to the German authority.pdf', 'DOCUMENT', FileCategory.OTHER, T.sent)],
          skipDuplicates: true,
        })
        const words = (it: string, en: string) => ({ it, en })
        await tx.authorityNotice.createMany({
          data: [
            {
              id: N.draft,
              companyId: companyA,
              registerEntryId: E.recall,
              marketCode: 'IT',
              authorityName: 'Seed market surveillance office, Italy (made-up)',
              channel: AuthorityChannel.PEC,
              decision: AuthorityNoticeDecision.RISK,
              words: words(
                'SEED-JKT-01, lotto SEED-BT-0001: la tasca della protezione spalla si apre sotto carico. Azione: richiamo del lotto (inventato).',
                'SEED-JKT-01, batch SEED-BT-0001: the shoulder protector pocket opens under load. Action: recall of the batch (made-up).',
              ),
              ...stamp(T.drafted),
            },
            {
              id: N.sent,
              companyId: companyA,
              registerEntryId: E.recall,
              marketCode: 'DE',
              authorityName: 'Seed market surveillance office, Germany (made-up)',
              channel: AuthorityChannel.SAFETY_BUSINESS_GATEWAY,
              decision: AuthorityNoticeDecision.RISK,
              words: { en: 'SEED-JKT-01, batch SEED-BT-0001: the shoulder protector pocket opens under load. Action: recall of the batch (made-up).' },
              ...stamp(T.drafted),
            },
            {
              id: N.cancelled,
              companyId: companyA,
              registerEntryId: E.withdrawal,
              marketCode: 'IT',
              authorityName: 'Seed market surveillance office, Italy (made-up)',
              channel: AuthorityChannel.PEC,
              decision: AuthorityNoticeDecision.NOT_CONFORMING,
              words: words('Cartellino con la classe sbagliata (inventato).', 'Hang tag with the wrong class (made-up).'),
              ...stamp(T.drafted),
            },
          ],
        })
        await tx.authorityNotice.update({
          where: { id: N.sent },
          data: { status: AuthorityNoticeStatus.SENT, sentAt: T.sent, sentById: memberId, reference: 'SEED-SBG-2026-0042', fileId: F.noticeCopy, version: 2, updatedAt: T.sent },
          select,
        })
        await tx.authorityNotice.update({
          where: { id: N.cancelled },
          data: { status: AuthorityNoticeStatus.CANCELLED, cancelledAt: T.cancelled, cancelReason: 'The risk was assessed NO: no notice is due (made-up).', version: 2, updatedAt: T.cancelled },
          select,
        })

        // The requests: SEED-AR-0002 is kept by SEED-REG-2026-903 (which names it as its source).
        const request = (rowId: string, number: string, marketCode: string, authorityName: string, dueOn: Date, data: Partial<Prisma.AuthorityRequestCreateManyInput>): Prisma.AuthorityRequestCreateManyInput => ({
          id: rowId,
          companyId: companyA,
          number,
          authorityName,
          marketCode,
          channel: AuthorityChannel.PEC,
          receivedAt: T.received,
          styleId,
          request: '',
          dueOn,
          ...data,
          ...stamp(T.received),
        })
        await tx.authorityRequest.createMany({
          data: [
            request(R.open, 'SEED-AR-0001', 'IT', 'Seed market surveillance office, Italy (made-up)', DAY.dueItaly, {
              authorityReference: 'SEED-IT-2026-117',
              batchNumbers: ['SEED-BT-0001'],
              request: 'Send the EU declaration of conformity and the test reports of batch SEED-BT-0001 (made-up).',
            }),
            request(R.answered, 'SEED-AR-0002', 'DE', 'Seed market surveillance office, Germany (made-up)', DAY.dueGermany, {
              authorityReference: 'SEED-DE-2026-0815',
              channel: AuthorityChannel.EMAIL,
              request: 'Send the technical documentation of SEED-JKT-01 in English or German (made-up).',
              registerEntryId: E.request,
            }),
            request(R.cancelled, 'SEED-AR-0003', 'IT', 'Seed market surveillance office, Italy (made-up)', DAY.dueItaly, {
              request: 'The same request as SEED-AR-0001, logged twice (made-up).',
            }),
          ],
        })
        await tx.authorityRequest.update({
          where: { id: R.answered },
          data: {
            status: AuthorityRequestStatus.ANSWERED,
            answeredAt: T.requestAnswered,
            answeredById: memberId,
            answerSummary: 'The technical documentation in English, through a time-limited link (made-up).',
            evidenceType: 'EvidencePack',
            evidenceId: id('recall:evidence-pack:AR-0002'),
            version: 2,
            updatedAt: T.requestAnswered,
          },
          select,
        })
        await tx.authorityRequest.update({
          where: { id: R.cancelled },
          data: { status: AuthorityRequestStatus.CANCELLED, cancelledAt: T.cancelled, cancelReason: 'Logged twice: SEED-AR-0001 is the one (made-up).', version: 2, updatedAt: T.cancelled },
          select,
        })
      }),
    )
  }

  // --- Recalls and withdrawals, their progress, the distributors told ---------------------------------------------------
  if (!(await db.withScope(office, (client) => client.recallAction.findUnique({ where: { id: A.draft }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const action = (rowId: string, number: string, registerEntryId: string, kind: RecallKind, data: Partial<Prisma.RecallActionCreateManyInput>): Prisma.RecallActionCreateManyInput => ({
          id: rowId,
          companyId: companyA,
          registerEntryId,
          number,
          kind,
          styleId,
          batchNumbers: ['SEED-BT-0001'],
          ...data,
          ...stamp(T.drafted),
        })
        await tx.recallAction.createMany({
          data: [
            action(A.draft, 'SEED-RCL-0001', E.withdrawal, RecallKind.WITHDRAWAL, { note: 'Waiting for the new hang tags (made-up).' }),
            action(A.active, 'SEED-RCL-0002', E.recall, RecallKind.RECALL, {
              workOrderIds: [workOrderId],
              shipmentIds: [shipmentId],
              publicNotice: {
                it: {
                  title: 'Richiamo: giacca SEED-JKT-01, lotto SEED-BT-0001',
                  problem: 'La tasca della protezione spalla può aprirsi in caso di caduta (inventato).',
                  action: 'Smetta di usare la giacca e la riporti al rivenditore: la cuciamo di nuovo gratuitamente.',
                  contact: 'Seed Service, +39 000 0000000, service@example.com',
                },
                en: {
                  title: 'Recall: jacket SEED-JKT-01, batch SEED-BT-0001',
                  problem: 'The shoulder protector pocket can open in a fall (made-up).',
                  action: 'Stop using the jacket and bring it back to your dealer: we sew it again free of charge.',
                  contact: 'Seed Service, +39 000 0000000, service@example.com',
                },
              },
            }),
            action(A.cancelled, 'SEED-RCL-0003', E.withdrawal, RecallKind.WITHDRAWAL, { batchNumbers: ['SEED-BT-0003'] }),
          ],
        })
        await tx.recallAction.update({
          where: { id: A.active },
          data: { status: RecallStatus.ACTIVE, startedAt: T.started, startedById: memberId, version: 2, updatedAt: T.started },
          select,
        })
        await tx.recallAction.update({
          where: { id: A.active },
          data: { noticePublishedAt: T.published, noticePublishedById: memberId, version: 3, updatedAt: T.published },
          select,
        })
        await tx.recallAction.update({
          where: { id: A.cancelled },
          data: { status: RecallStatus.CANCELLED, cancelledAt: T.cancelled, cancelReason: 'Set up on the wrong batch (made-up).', version: 2, updatedAt: T.cancelled },
          select,
        })
        await tx.recallProgress.createMany({
          data: [
            { id: RP.draft, recallActionId: A.draft, partyId: P1, unitsSent: 2, unitsStillOut: 2, ...stamp(T.drafted) },
            { id: RP.active, recallActionId: A.active, partyId: P1, shipmentId, unitsSent: 2, unitsReturned: 1, unitsStillOut: 1, note: 'One jacket came back (made-up).', ...stamp(T.answered) },
          ],
        })

        const notice = (rowId: string, registerEntryId: string, recallActionId: string | null, partyId: string, channel: DistributorNoticeChannel, data: Partial<Prisma.DistributorNoticeCreateManyInput>): Prisma.DistributorNoticeCreateManyInput => ({
          id: rowId,
          companyId: companyA,
          registerEntryId,
          recallActionId,
          partyId,
          channel,
          language: 'it',
          message: '',
          ...data,
          ...stamp(T.drafted),
        })
        const recallWords = 'Gentile cliente, richiamiamo la giacca SEED-JKT-01 del lotto SEED-BT-0001: la preghiamo di non venderla e di avvisare chi l\'ha acquistata (inventato).'
        await tx.distributorNotice.createMany({
          data: [
            notice(D.draft, E.recall, A.active, P1, DistributorNoticeChannel.EMAIL, { contactName: 'Seed Buyer One', contact: 'buyer.p1@example.com', subject: 'Richiamo SEED-JKT-01, lotto SEED-BT-0001', message: recallWords }),
            notice(D.answered, E.recall, A.active, P1, DistributorNoticeChannel.EMAIL, { contactName: 'Seed Accounts One', contact: 'accounts.p1@example.com', subject: 'Richiamo SEED-JKT-01, lotto SEED-BT-0001', message: recallWords }),
            notice(D.failed, E.recall, A.active, P3, DistributorNoticeChannel.PHONE, { contactName: 'Seed Buyer Three', contact: '+39 000 0000003', language: 'de', message: 'Rückruf der Jacke SEED-JKT-01, Charge SEED-BT-0001 (erfunden).' }),
            notice(D.cancelled, E.withdrawal, null, P1, DistributorNoticeChannel.PORTAL, { message: 'Cartellino sbagliato sul lotto SEED-BT-0001: non vendere fino al nuovo cartellino (inventato).' }),
          ],
        })
        await tx.distributorNotice.update({ where: { id: D.answered }, data: { status: DistributorNoticeStatus.SENT, sentAt: T.told, sentById: memberId, version: 2, updatedAt: T.told }, select })
        await tx.distributorNotice.update({
          where: { id: D.answered },
          data: { status: DistributorNoticeStatus.ANSWERED, answeredAt: T.answered, answer: 'Received: one jacket sent back, the other customer is told (made-up).', answeredByName: 'Seed Buyer One', version: 3, updatedAt: T.answered },
          select,
        })
        await tx.distributorNotice.update({ where: { id: D.failed }, data: { status: DistributorNoticeStatus.SENT, sentAt: T.told, sentById: memberId, version: 2, updatedAt: T.told }, select })
        await tx.distributorNotice.update({
          where: { id: D.failed },
          data: { status: DistributorNoticeStatus.FAILED, failedAt: T.failed, failureReason: 'The number is not in service (made-up).', version: 3, updatedAt: T.failed },
          select,
        })
        await tx.distributorNotice.update({
          where: { id: D.cancelled },
          data: { status: DistributorNoticeStatus.CANCELLED, cancelledAt: T.cancelled, cancelReason: 'The withdrawal waits for the new hang tags (made-up).', version: 2, updatedAt: T.cancelled },
          select,
        })
      }),
    )
  }

  // --- Sustainability claims, where they are used, the switch -------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.sustainabilityClaim.findUnique({ where: { id: C.draft }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.storedFile.createMany({
          data: [
            file(F.lwg, 'SustainabilityClaim', C.draft, 'Seed tannery LWG audit certificate.pdf', 'CERTIFICATE', FileCategory.SUPPLIER_CERTIFICATE, T.claimDrafted),
            file(F.recycled, 'SustainabilityClaim', C.approved, 'Seed recycled content test report.pdf', 'CERTIFICATE', FileCategory.TEST_REPORT, T.claimDrafted),
            file(F.pfas, 'SustainabilityClaim', C.withdrawn, 'Seed PFAS test report 2025.pdf', 'CERTIFICATE', FileCategory.TEST_REPORT, T.claimDrafted),
            file(F.pfasNew, 'SustainabilityClaim', C.replacement, 'Seed PFAS test report 2026.pdf', 'CERTIFICATE', FileCategory.TEST_REPORT, T.claimWithdrawn),
          ],
          skipDuplicates: true,
        })
        const claim = (rowId: string, code: string, kind: SustainabilityClaimKind, scope: SustainabilityClaimScope, wording: Record<string, string>, at: Date, data: Partial<Prisma.SustainabilityClaimCreateManyInput>): Prisma.SustainabilityClaimCreateManyInput => ({
          id: rowId,
          companyId: companyA,
          code,
          kind,
          scope,
          wording,
          ...data,
          ...stamp(at),
        })
        await tx.sustainabilityClaim.createMany({
          data: [
            claim(C.draft, 'SEED-CL-01', SustainabilityClaimKind.RESPONSIBLE_SOURCING, SustainabilityClaimScope.MATERIAL, { it: 'Pelle da una conceria valutata LWG', en: 'Leather from a tannery rated by LWG' }, T.claimDrafted, {
              itemId: product.leatherId,
              evidenceFileIds: [F.lwg],
              validUntil: DAY.lwgValid,
            }),
            claim(C.approved, 'SEED-CL-02', SustainabilityClaimKind.RECYCLED_CONTENT, SustainabilityClaimScope.STYLE, { it: 'Fodera in poliestere riciclato al 50 %', en: 'Lining made with 50 % recycled polyester' }, T.claimDrafted, {
              styleId,
              scopeNote: 'The lining only (made-up).',
              evidenceFileIds: [F.recycled],
            }),
            claim(C.withdrawn, 'SEED-CL-03', SustainabilityClaimKind.SUBSTANCE_FREE, SustainabilityClaimScope.COMPANY, { it: 'Realizzato senza PFAS', en: 'Made without PFAS' }, T.claimDrafted, {
              evidenceFileIds: [F.pfas],
              validUntil: DAY.pfasValid,
            }),
          ],
        })
        await tx.sustainabilityClaim.update({ where: { id: C.approved }, data: { status: SustainabilityClaimStatus.APPROVED, approvedAt: T.claimApproved, approvedById: memberId, version: 2, updatedAt: T.claimApproved }, select })
        await tx.sustainabilityClaim.update({ where: { id: C.withdrawn }, data: { status: SustainabilityClaimStatus.APPROVED, approvedAt: T.claimApproved, approvedById: memberId, version: 2, updatedAt: T.claimApproved }, select })
        await tx.sustainabilityClaim.update({
          where: { id: C.withdrawn },
          data: { status: SustainabilityClaimStatus.WITHDRAWN, withdrawnAt: T.claimWithdrawn, withdrawnById: memberId, withdrawReason: 'Its test report expired on 31 October (made-up).', version: 3, updatedAt: T.claimWithdrawn },
          select,
        })
        await tx.sustainabilityClaim.create({
          data: claim(C.replacement, 'SEED-CL-04', SustainabilityClaimKind.SUBSTANCE_FREE, SustainabilityClaimScope.COMPANY, { it: 'Realizzato senza PFAS', en: 'Made without PFAS' }, T.claimWithdrawn, {
            evidenceFileIds: [F.pfasNew],
            validUntil: DAY.pfasNewValid,
            supersedesId: C.withdrawn,
          }),
          select,
        })
        await tx.claimUse.createMany({
          data: [
            { id: U.style, claimId: C.approved, kind: ClaimUseKind.STYLE, recordType: 'Style', recordId: styleId, label: 'Style texts of SEED-JKT-01', ...stamp(T.claimApproved) },
            { id: U.label, claimId: C.approved, kind: ClaimUseKind.LABEL, recordType: 'LabelTemplate', recordId: production.labelTemplateId, label: 'Care label of SEED-JKT-01', ...stamp(T.claimApproved) },
            { id: U.ended, claimId: C.approved, kind: ClaimUseKind.CATALOGUE, recordType: 'ExportJob', recordId: id('recall:catalogue:autumn'), label: 'Autumn catalogue 2026 (made-up)', ...stamp(T.claimApproved) },
          ],
        })
        await tx.claimUse.update({ where: { id: U.ended }, data: { endedAt: T.useEnded, endedById: memberId, version: 2, updatedAt: T.useEnded }, select })

        // The switch of the claims register: OFF until a style or a market needs green claims (Owner answer 11-09, Q23).
        if (!(await tx.complianceRequirement.findUnique({ where: { tenantId_code: { tenantId, code: 'CLAIM-EVIDENCE' } }, select }))) {
          await tx.complianceRequirement.create({
            data: {
              id: result.claimRequirementId,
              code: 'CLAIM-EVIDENCE',
              name: 'Every sustainability claim on a label is approved, with evidence that still holds',
              kind: ComplianceRequirementKind.CLAIM_EVIDENCE,
              checkKey: 'claims.evidence',
              blocks: [ComplianceGate.LABEL_PRINT],
              legalReference: 'Dir. (EU) 2024/825 (environmental claims, from 27 September 2026)',
              seq: 95,
              switchedOn: false,
              offReason: 'Owner question Q23: green claims are built switched off until a style or a market needs them (answer 11-09).',
              switchedAt: T.claimDrafted,
              switchedById: actorId,
              ...stamp(T.claimDrafted),
            },
            select,
          })
        }
      }),
    )
  }

  return result
}
