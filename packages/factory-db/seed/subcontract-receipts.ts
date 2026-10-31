import { createHash } from 'node:crypto'
import { GeneratedDocumentKind, SubcontractOrderStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedSubcontract, type SubcontractSeed } from './subcontract'

/**
 * The W2b subcontract seed (schema wave 1/7, B-W2b-01): what went out to a workshop and what came back, as rows
 * (SubcontractBundle, SubcontractReceipt, SubcontractReceiptLine) and a job sheet version (GeneratedDocument), per tenant
 * of seed/_core.ts, written in the tenant's office scope, as the app does:
 *
 *   SEED-SC-0002  company A to the workshop P2 (the W2a subcontract seed's) for WO-0001's packing of the 2 sleeve sets of
 *                 the production seed's bundle SEED-BN-0002 (BLK 52) at 2.00 a piece: issued, the bundle out with the
 *                 kit (no kit line: nothing moves in the stock ledger), one receipt back (the workshop's DDT 77/2026)
 *                 with one line, 1 good: PARTLY_RECEIVED.
 *   job sheet     its version 1 (GeneratedDocument JOB_SHEET) with the PDF's row (a file of the order: no object in any
 *                 store, it lists but does not download).
 *
 * Its own file, apart from seed/subcontract.ts: the W2a seed's tests count that file's orders (no order at a workshop),
 * and the W2a golden day sends WO-0001's sewing out (this order is of its packing, so it holds none of those pieces). The
 * generated isolation tests copy the FIRST row of each table by id and insert the copy: the order and its operation
 * (not insertable as they are) get ids that start with eight f's; the bundle, receipt, line and job sheet (insertable
 * copies: the bundle holds 2 garments, 1 came back) ids that start with eight zeros. Every name, number and fee is
 * invented. Idempotent: written once, skipped when the order exists.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  drafted: new Date('2026-11-16T11:00:00.000Z'),
  issued: new Date('2026-11-17T12:00:00.000Z'),
  sent: new Date('2026-11-17T14:00:00.000Z'),
  back: new Date('2026-11-19T09:30:00.000Z'),
} as const
const DAY = { ordered: new Date('2026-11-16T00:00:00.000Z'), back: new Date('2026-11-26T00:00:00.000Z'), workshopDdt: new Date('2026-11-19T00:00:00.000Z') } as const

export interface SubcontractReceiptsSeed {
  readonly subcontract: SubcontractSeed
  /** SEED-SC-0002 (PARTLY_RECEIVED), its operation, the bundle out, its receipt and line, its job sheet and its file. */
  readonly orderId: string
  readonly operationId: string
  readonly bundleId: string
  readonly subcontractBundleId: string
  readonly receiptId: string
  readonly receiptLineId: string
  readonly jobSheetId: string
  readonly jobSheetFileId: string
}

export async function seed(context: SeedContext): Promise<SubcontractReceiptsSeed> {
  const { db, namespace } = context
  // The workshop, its location, WO-0001 and its bundles come from the W2a subcontract seed (and the production seed it
  // runs); the file store from the files seed. Both are idempotent.
  const subcontract = await seedSubcontract(context)
  await seedFiles(context)
  const production = subcontract.production
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const workshopId = id('party:P2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const row = {
    order: lastId('subcontract:SC-0002'),
    operation: lastId('subcontract:SC-0002:op:10'),
    bundle: firstId('subcontract:SC-0002:bundle:BN-0002'),
    receipt: firstId('subcontract:SC-0002:receipt:1'),
    line: firstId('subcontract:SC-0002:receipt:1:line:10'),
    jobSheet: firstId('subcontract:SC-0002:job-sheet:1'),
    jobSheetFile: lastId('subcontract:SC-0002:job-sheet:1:file'),
  }
  const bundleId = production.bundleIds[1]
  const jobSheetSha = createHash('sha256').update(`seed job sheet ${namespace} SC-0002 1`).digest('hex')
  const select = { id: true } as const

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.subcontractOrder.findUnique({ where: { id: row.order }, select })) return
      await tx.subcontractOrder.create({
        data: {
          id: row.order,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-SC-0002',
          partyId: workshopId,
          locationId: subcontract.locationId,
          workOrderId: production.workOrderId,
          status: SubcontractOrderStatus.DRAFT,
          orderDate: DAY.ordered,
          expectedBackDate: DAY.back,
          currency: 'EUR',
          netAmount: 400,
          note: 'Finish and pack the sleeve sets of bundle SEED-BN-0002.',
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select,
      })
      await tx.subcontractOperation.create({
        data: {
          id: row.operation,
          siteId: siteA,
          workOrderId: production.workOrderId,
          subcontractOrderId: row.order,
          seq: 10,
          workOrderOperationId: production.operationIds.pack,
          pieces: 2,
          pricePerPiece: '2.000000',
          netAmount: 400,
          expectedBackDate: DAY.back,
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select,
      })
      await tx.subcontractOrder.update({ where: { id: row.order }, data: { status: SubcontractOrderStatus.ISSUED, issuedAt: T.issued, issuedById: actorId, updatedAt: T.issued }, select })
      // The kit out: the bundle travels (its 2 sleeve sets), the order is at the workshop.
      await tx.subcontractOperation.update({ where: { id: row.operation }, data: { piecesSent: 2, version: 2, updatedAt: T.sent }, select })
      await tx.subcontractOrder.update({ where: { id: row.order }, data: { status: SubcontractOrderStatus.AT_WORKSHOP, updatedAt: T.sent }, select })
      await tx.subcontractBundle.create({
        data: { id: row.bundle, siteId: siteA, workOrderId: production.workOrderId, subcontractOrderId: row.order, bundleId, quantity: 2, sentAt: T.sent, createdAt: T.sent, createdById: actorId },
        select,
      })
      // One receipt back: 1 good of the 2.
      await tx.subcontractReceipt.create({
        data: {
          id: row.receipt,
          siteId: siteA,
          workOrderId: production.workOrderId,
          subcontractOrderId: row.order,
          seq: 1,
          receivedAt: T.back,
          workshopDdtNumber: '77/2026',
          workshopDdtDate: DAY.workshopDdt,
          note: 'One sleeve set back; the other follows.',
          createdAt: T.back,
          createdById: actorId,
        },
        select,
      })
      await tx.subcontractReceiptLine.create({
        data: { id: row.line, siteId: siteA, workOrderId: production.workOrderId, receiptId: row.receipt, seq: 10, subcontractOperationId: row.operation, bundleId, goodQuantity: 1, createdAt: T.back, createdById: actorId },
        select,
      })
      await tx.subcontractOperation.update({ where: { id: row.operation }, data: { piecesBackGood: 1, version: 3, updatedAt: T.back }, select })
      await tx.subcontractOrder.update({ where: { id: row.order }, data: { status: SubcontractOrderStatus.PARTLY_RECEIVED, updatedAt: T.back }, select })
      // Its job sheet, version 1: the PDF's row (no object in any store) and the generated document.
      await tx.storedFile.create({
        data: {
          id: row.jobSheetFile,
          companyId: companyA,
          recordType: 'SubcontractOrder',
          recordId: row.order,
          kind: 'DOCUMENT',
          originalName: 'SEED-SC-0002 job sheet.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          sha256: jobSheetSha,
          storeAccountId: id('files:account:r2'),
          storageKey: `t/${tenantId}/c/${companyA}/2026/${id('subcontract:SC-0002:job-sheet:1:key')}`,
          status: 'AVAILABLE',
          availableAt: T.issued,
          visibility: ['OFFICE'],
          createdAt: T.issued,
          updatedAt: T.issued,
          createdById: actorId,
        },
        select,
      })
      await tx.generatedDocument.create({
        data: {
          id: row.jobSheet,
          companyId: companyA,
          siteId: siteA,
          recordType: 'SubcontractOrder',
          recordId: row.order,
          kind: GeneratedDocumentKind.JOB_SHEET,
          version: 1,
          fingerprint: jobSheetSha,
          language: 'it',
          number: 'SEED-SC-0002',
          fileId: row.jobSheetFile,
          createdAt: T.issued,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  return {
    subcontract,
    orderId: row.order,
    operationId: row.operation,
    bundleId,
    subcontractBundleId: row.bundle,
    receiptId: row.receipt,
    receiptLineId: row.line,
    jobSheetId: row.jobSheet,
    jobSheetFileId: row.jobSheetFile,
  }
}
