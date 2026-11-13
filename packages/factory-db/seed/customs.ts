import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  CustomsDeclarationStatus,
  GeneratedDocumentKind,
  PartyKind,
  PartyRole,
  PartyStatus,
  ReturnLabelStatus,
  TrackingExceptionKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedReturns } from './returns'

/**
 * The delivery, returns and customs seed (W2b-6, schema wave 51/57, B-W2b-372), per tenant of seed/_core.ts, written in the
 * tenant's office scope as apps/factory-api's modules/shipping and modules/sales will write it (B-W2b-398, -409). It runs the
 * files and returns seeds first (which run shipping and money; all idempotent).
 *
 *   EORI        company A's made-up EORI (IT and its made-up VAT number); company B has none yet.
 *   switches    the customer notice and the broker pack stay OFF on every site (the Owner's rule of 11-13).
 *   tracking    SH-0001: a day without carrier news (NO_SCAN), resolved the same afternoon; then a delay (DELAYED), open, worked
 *               in a task of the shipment.
 *   labels      SEED-RMA-0001 (AUTHORISED): a label booked at once for its first parcel (its booking reference and PDF, a
 *               file of the RMA), already used; a RETURN_LABEL link offered for the rest, not used yet (the carrier is booked
 *               only when the customer uses it).
 *   customs     SH-0002 (being packed): its pack sent to the carrier, which files the declaration (no broker); SH-0001: a
 *               made-up customs broker filed its declaration (a made-up MRN), against the shipment's TD24 draft; the proof of
 *               exit is not in yet. The DB never reads the destination: the stories are made up, the shipments' addresses
 *               stay Italian.
 *   documents   SH-0001's commercial invoice, version 1 (in English, with the shipment's number), a file of the shipment.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: a resolved
 * tracking problem (one open per shipment and kind), the label offered by link (its link and the RMA stay right for a copy),
 * a declaration whose pack is merely sent (a declaration starts PACK_SENT). The rows this seed adds to other modules' tables
 * (the broker, the task, the link, files, the document) start with eight f's, so they never become those tables' first rows.
 * Every name, code, number and value is invented (no real EORI, MRN or tracking number); every time is before the day the
 * wave was built (the guards refuse a time in the future). Idempotent: written once, skipped when its first row exists.
 */

const T = {
  setup: new Date('2026-11-10T08:00:00.000Z'),
  noScan: new Date('2026-11-11T07:00:00.000Z'),
  noScanResolved: new Date('2026-11-11T15:30:00.000Z'),
  delayed: new Date('2026-11-12T09:00:00.000Z'),
  labelBooked: new Date('2026-11-12T10:00:00.000Z'),
  labelUsed: new Date('2026-11-12T16:00:00.000Z'),
  linkOffered: new Date('2026-11-12T10:30:00.000Z'),
  packSent: new Date('2026-11-12T11:00:00.000Z'),
  filed: new Date('2026-11-12T14:00:00.000Z'),
  commercialInvoice: new Date('2026-11-12T08:30:00.000Z'),
} as const
const LINK_EXPIRES = new Date('2027-01-15T08:00:00.000Z')
/** Company A's made-up EORI: IT and the made-up VAT number of seed/parties.ts. */
export const SEED_EORI_A = 'IT00000003038'
/** A made-up MRN: two digits of the year, IT, then SEED and digits (never a real declaration's). */
export const SEED_MRN = '26ITSEED0000000001'

export interface CustomsSeed {
  readonly brokerPartyId: string
  readonly trackingIds: { readonly resolved: string; readonly open: string }
  readonly taskId: string
  readonly labelIds: { readonly offered: string; readonly used: string }
  readonly linkId: string
  readonly labelFileId: string
  readonly declarationIds: { readonly packSent: string; readonly filed: string }
  readonly commercialInvoiceFileId: string
  readonly commercialInvoiceDocumentId: string
  /** The rows it builds on: SH-0001 (SHIPPED), SH-0002 (DRAFT), SEED-RMA-0001 (AUTHORISED), the TD24 draft, FT-2026-00001. */
  readonly shippedShipmentId: string
  readonly draftShipmentId: string
  readonly returnId: string
  readonly draftInvoiceId: string
  readonly issuedInvoiceId: string
}

export async function seed(context: SeedContext): Promise<CustomsSeed> {
  const { db, namespace } = context
  await seedFiles(context)
  const returns = await seedReturns(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const partyP1 = id('party:P1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date, by: string | null = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const select = { id: true } as const
  const sha = (text: string): string => createHash('sha256').update(`seed customs ${namespace} ${text}`).digest('hex')

  const result: CustomsSeed = {
    brokerPartyId: lateId('customs:party:broker'),
    trackingIds: { resolved: firstId('customs:tracking:SH-0001:no-scan'), open: id('customs:tracking:SH-0001:delayed') },
    taskId: lateId('customs:task:SH-0001:delayed'),
    labelIds: { offered: firstId('customs:label:RMA-0001:offered'), used: id('customs:label:RMA-0001:used') },
    linkId: lateId('customs:link:RMA-0001:return-label'),
    labelFileId: lateId('customs:label:RMA-0001:used:file'),
    declarationIds: { packSent: firstId('customs:declaration:SH-0002:pack'), filed: id('customs:declaration:SH-0001:filed') },
    commercialInvoiceFileId: lateId('customs:document:SH-0001:commercial-invoice:file'),
    commercialInvoiceDocumentId: lateId('customs:document:SH-0001:commercial-invoice'),
    shippedShipmentId: returns.money.shipping.shipmentId,
    draftShipmentId: returns.money.shipping.draftShipmentId,
    returnId: returns.waitingReturnId,
    draftInvoiceId: returns.money.draftInvoiceId,
    issuedInvoiceId: returns.money.sampleInvoiceId,
  }
  const { trackingIds: X, labelIds: L, declarationIds: D } = result

  if (await db.withScope(office, (client) => client.trackingException.findUnique({ where: { id: X.resolved }, select }))) return result

  const file = (fileId: string, recordType: string, recordId: string, name: string, at: Date, key: string): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    sha256: sha(key),
    storeAccountId: id('files:account:r2'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`${key}:key`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    visibility: ['OFFICE'],
    ...stamp(at),
  })

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- the company's EORI (LOG-095) ---------------------------------------------------------------------------------------
      await tx.company.updateMany({ where: { id: companyA, eori: null }, data: { eori: SEED_EORI_A, updatedAt: T.setup } })

      // --- tracking problems (LOG-063) ----------------------------------------------------------------------------------------
      await tx.task.create({
        data: {
          id: result.taskId,
          companyId: companyA,
          siteId: siteA,
          title: 'Parcel delayed: ask the carrier for a new delivery day (test)',
          recordType: 'Shipment',
          recordId: result.shippedShipmentId,
          recordLabel: 'SEED-SH-0001',
          ...stamp(T.delayed, null),
        },
        select,
      })
      await tx.trackingException.createMany({
        data: [
          // A day without carrier news, found by the daily check and resolved once the carrier scanned the parcels again.
          { id: X.resolved, siteId: siteA, partyId: partyP1, shipmentId: result.shippedShipmentId, kind: TrackingExceptionKind.NO_SCAN, raisedAt: T.noScan, resolvedAt: T.noScanResolved, ...stamp(T.noScan, null) },
          { id: X.open, siteId: siteA, partyId: partyP1, shipmentId: result.shippedShipmentId, kind: TrackingExceptionKind.DELAYED, raisedAt: T.delayed, taskId: result.taskId, ...stamp(T.delayed, null) },
        ],
      })

      // --- return labels (LOG-112) --------------------------------------------------------------------------------------------
      await tx.storedFile.create({ data: file(result.labelFileId, 'ReturnAuthorisation', result.returnId, 'Seed return label SEED-RMA-0001.pdf', T.labelBooked, 'label:RMA-0001'), select })
      await tx.oneOffLink.create({
        data: {
          id: result.linkId,
          companyId: companyA,
          partyId: partyP1,
          purpose: 'RETURN_LABEL',
          recordType: 'ReturnAuthorisation',
          recordId: result.returnId,
          // Not a token: SHA-256 of a text no token matches, so the seeded link opens nothing.
          tokenHash: sha(`link ${result.linkId}: no token opens it`),
          email: 'buyer.p1@example.com',
          note: 'Seed return label link for the rest of SEED-RMA-0001',
          expiresAt: LINK_EXPIRES,
          maxUses: 1,
          createdAt: T.linkOffered,
          updatedAt: T.linkOffered,
          createdById: actorId,
        },
        select,
      })
      await tx.returnLabel.createMany({
        data: [
          { id: L.offered, companyId: companyA, siteId: siteA, partyId: partyP1, returnId: result.returnId, carrierCode: 'seed-express', status: ReturnLabelStatus.OFFERED, linkId: result.linkId, ...stamp(T.linkOffered) },
          {
            id: L.used, companyId: companyA, siteId: siteA, partyId: partyP1, returnId: result.returnId, carrierCode: 'seed-express', status: ReturnLabelStatus.BOOKED,
            bookingReference: 'SEED-RL-0001', labelFileId: result.labelFileId, ...stamp(T.labelBooked),
          },
        ],
      })
      await tx.returnLabel.update({ where: { id: L.used }, data: { status: ReturnLabelStatus.USED, usedAt: T.labelUsed, version: 2, updatedAt: T.labelUsed }, select })

      // --- customs (LOG-088, LOG-089, LOG-086) --------------------------------------------------------------------------------
      await tx.party.create({
        data: {
          id: result.brokerPartyId,
          companyId: companyA,
          code: 'SEED-BROKER',
          kind: PartyKind.ORGANISATION,
          legalName: 'Seed Customs Broker S.r.l.',
          roles: [PartyRole.CARRIER],
          status: PartyStatus.ACTIVE,
          country: 'IT',
          currency: 'EUR',
          language: 'it',
          ...stamp(T.setup),
        },
        select,
      })
      await tx.customsDeclaration.createMany({
        data: [
          // SH-0002's papers went to the carrier, which files its declaration (paperless trade).
          { id: D.packSent, companyId: companyA, siteId: siteA, partyId: partyP1, shipmentId: result.draftShipmentId, ...stamp(T.packSent) },
          { id: D.filed, companyId: companyA, siteId: siteA, partyId: partyP1, shipmentId: result.shippedShipmentId, brokerPartyId: result.brokerPartyId, invoiceId: result.draftInvoiceId, alertAfterDays: 45, ...stamp(T.packSent) },
        ],
      })
      await tx.customsDeclaration.update({ where: { id: D.filed }, data: { status: CustomsDeclarationStatus.FILED, mrn: SEED_MRN, version: 2, updatedAt: T.filed }, select })
      await tx.storedFile.create({
        data: file(result.commercialInvoiceFileId, 'Shipment', result.shippedShipmentId, 'Seed commercial invoice SEED-SH-0001.pdf', T.commercialInvoice, 'commercial-invoice:SH-0001'),
        select,
      })
      await tx.generatedDocument.create({
        data: {
          id: result.commercialInvoiceDocumentId,
          companyId: companyA,
          siteId: siteA,
          recordType: 'Shipment',
          recordId: result.shippedShipmentId,
          kind: GeneratedDocumentKind.COMMERCIAL_INVOICE,
          version: 1,
          fingerprint: sha('commercial-invoice:SH-0001'),
          language: 'en',
          number: 'SEED-SH-0001',
          fileId: result.commercialInvoiceFileId,
          createdAt: T.commercialInvoice,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  return result
}
