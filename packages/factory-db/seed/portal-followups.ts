import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { FileCategory, PartyAddressApproval, PartyAddressKind, PartyChangeRequestStatus, SupplierDocumentUploadStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedPortalAuth } from './portal-auth'

/**
 * The portal follow-ups seed (W2b schema wave 23, B-W2b-F12), per tenant of seed/_core.ts: what a supplier sent from its
 * portal that waits for a person of ours, in the two new tables. The supplier's own acts are written in the partner scope of
 * party P2 (the parties seed's supplier of company A) as its order desk, the portal user of seed/portal-auth.ts; the office's
 * decisions in the tenant's office scope, as the app does. The CLI runs the seed files in name order and this one sorts
 * before portal-frame.ts, so it runs the files and portal-auth seeds first (each idempotent). Every name, number and code is
 * made up; no object is in any store (rows only).
 *
 *   documents   P2's LWG certificate, uploaded in the portal, arrived and ACCEPTED by the office (the file tagged and shared
 *               with P2's portal, in force until the end of 2027); P2's REACH declaration, announced (its upload not confirmed
 *               yet), WAITING for a person.
 *   changes     P2 asked to add a contact for its orders, REFUSED (the phone belongs to another company); then asked to add
 *               a second pickup address (OPEN).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first upload is the WAITING one, still at version 1, and the first change request the OPEN one (ids that
 * start with eight zeros). They read and write as party P1: with `partnerScope` (that test only) the seed also gives P1 rows of its own: a
 * delivery address P1's buyer added that WAITS for the office's check (the first address of the tenant: a partner session
 * inserts only such an address), an upload of P1 that waits and an open change request of P1. Without it nothing of P1 is
 * written, so the API tests read the same addresses. P1's upload and request ids start with eight f's.
 *
 * The columns of the earlier models this wave adds (a portal confirmation, a return's channel, a DVR signature by link, a
 * task's assignee, the carrier's ETA and tracking page, the cancel fee, a website) are left to the API steps that write them:
 * their PostgreSQL test (src/portal-followups-w2b.pg.vitest.test.ts) writes each one.
 *
 * Idempotent: each part is written once and skipped when its first row exists.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  certificate: new Date('2026-11-03T08:20:00.000Z'),
  certificateArrived: new Date('2026-11-03T08:21:00.000Z'),
  certificateAccepted: new Date('2026-11-03T14:00:00.000Z'),
  declaration: new Date('2026-11-06T10:05:00.000Z'),
  contactAsked: new Date('2026-11-02T09:30:00.000Z'),
  contactRefused: new Date('2026-11-02T16:00:00.000Z'),
  pickupAsked: new Date('2026-11-06T11:00:00.000Z'),
  addressAsked: new Date('2026-11-06T12:00:00.000Z'),
} as const
const DAY = {
  certificateIssued: new Date('2026-01-15T00:00:00.000Z'),
  certificateExpires: new Date('2027-12-31T00:00:00.000Z'),
  declarationIssued: new Date('2026-10-30T00:00:00.000Z'),
} as const

export interface PortalFollowupsSeedOptions {
  /** The generated isolation tests: party P1 gets rows of its own in every partner table (see above). */
  readonly partnerScope?: boolean
}

export interface PortalFollowupsSeed {
  readonly uploads: { readonly accepted: string; readonly waiting: string }
  readonly files: { readonly certificate: string; readonly declaration: string }
  readonly changeRequests: { readonly refused: string; readonly open: string }
  /** With partnerScope: P1's waiting delivery address, upload and change request. */
  readonly partner: { readonly addressId: string; readonly uploadId: string; readonly changeRequestId: string; readonly fileId: string }
  readonly supplierUserId: string
  readonly buyerUserId: string
  readonly partyP1: string
  readonly partyP2: string
  readonly companyId: string
  readonly tenantId: string
}

export async function seed(context: SeedContext, options: PortalFollowupsSeedOptions = {}): Promise<PortalFollowupsSeed> {
  const { db, namespace } = context
  await seedFiles(context)
  const portal = await seedPortalAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const partyP1 = id('party:P1')
  const partyP2 = id('party:P2')
  const store = id('files:account:r2')
  const office = { audience: 'office', tenantId, actorId } as const
  // A portal session runs in its party's scope; its actor is the partner user.
  const asSupplier = { audience: 'partner', tenantId, actorId: portal.userIds.p2Orders, partyId: partyP2 } as const
  const asCustomer = { audience: 'partner', tenantId, actorId: portal.userIds.p1Buyer, partyId: partyP1 } as const
  const select = { id: true } as const

  const result: PortalFollowupsSeed = {
    uploads: { accepted: id('portal-followups:upload:P2:certificate'), waiting: firstId('portal-followups:upload:P2:declaration') },
    files: { certificate: id('portal-followups:file:P2:certificate'), declaration: id('portal-followups:file:P2:declaration') },
    changeRequests: { refused: id('portal-followups:change:P2:contact'), open: firstId('portal-followups:change:P2:pickup') },
    partner: {
      addressId: firstId('portal-followups:address:P1:waiting'),
      uploadId: lateId('portal-followups:upload:P1:test-report'),
      changeRequestId: lateId('portal-followups:change:P1:contact'),
      fileId: id('portal-followups:file:P1:test-report'),
    },
    supplierUserId: portal.userIds.p2Orders,
    buyerUserId: portal.userIds.p1Buyer,
    partyP1,
    partyP2,
    companyId: companyA,
    tenantId,
  }
  const { uploads, files, changeRequests, partner } = result

  /** A file a supplier uploaded in its portal: of its own party record, a PDF (rows only: no object in any store). */
  const supplierFile = (fileId: string, partyId: string, name: string, at: Date, accepted: { readonly category: FileCategory; readonly expiresOn: Date } | null): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType: 'Party',
    recordId: partyId,
    kind: 'CERTIFICATE',
    // OFFICE only and untagged until accepted (B-W2b-189): then tagged and shared with the party's portal.
    category: accepted?.category ?? null,
    expiresOn: accepted?.expiresOn ?? null,
    visibility: accepted ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
    // A file names its party exactly when it is shared with the party's portal (the files guard).
    partyId: accepted ? partyId : null,
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 5120,
    sha256: createHash('sha256').update(`seed file ${namespace} portal-followups ${fileId}`).digest('hex'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`portal-followups:key:${fileId}`)}`,
    // An accepted upload arrived (AVAILABLE); a waiting one is still announced (its upload not confirmed).
    status: accepted ? 'AVAILABLE' : 'PENDING_UPLOAD',
    availableAt: accepted ? at : null,
    storeAccountId: store,
    createdAt: at,
    updatedAt: at,
    createdById: actorId,
  })
  const upload = (rowId: string, fileId: string, partyId: string, category: FileCategory, at: Date, said: Partial<Prisma.SupplierDocumentUploadUncheckedCreateInput>, userId: string, userName: string) => ({
    id: rowId,
    companyId: companyA,
    partyId,
    fileId,
    recordType: 'Party',
    recordId: partyId,
    recordLabel: partyId === partyP2 ? 'Seed Tannery Two' : 'Seed Customer One',
    category,
    ...said,
    uploadedById: userId,
    uploadedByName: userName,
    createdAt: at,
    updatedAt: at,
  })
  const change = (rowId: string, partyId: string, at: Date, changes: Prisma.InputJsonValue, summary: string, userId: string, userName: string, note: string | null = null) => ({
    id: rowId,
    companyId: companyA,
    partyId,
    requestedById: userId,
    requestedByName: userName,
    changes,
    summary,
    note,
    createdAt: at,
    updatedAt: at,
  })
  const pickup = { name: 'Seed tannery, second warehouse', line1: 'Via Esempio 22', line2: null, postalCode: '56029', city: 'Seedtown', province: 'PI', country: 'IT', contactName: 'Seed Warehouse', phone: '+39 0000 000222', deliveryNotes: 'Dock 2, mornings only.' }

  // --- P2's documents --------------------------------------------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.supplierDocumentUpload.findUnique({ where: { id: uploads.accepted }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.storedFile.createMany({
          data: [
            supplierFile(files.certificate, partyP2, 'Seed tannery LWG certificate 2026.pdf', T.certificateArrived, { category: FileCategory.SUPPLIER_CERTIFICATE, expiresOn: DAY.certificateExpires }),
            supplierFile(files.declaration, partyP2, 'Seed tannery REACH declaration.pdf', T.declaration, null),
          ],
          skipDuplicates: true,
        })
      }),
    )
    // The supplier records what it uploaded (WAITING); the office marks it arrived and decides.
    await db.withScope(asSupplier, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierDocumentUpload.create({
          data: upload(uploads.accepted, files.certificate, partyP2, FileCategory.SUPPLIER_CERTIFICATE, T.certificate, { issuer: 'Seed Audit Body', documentNumber: 'LWG-SEED-0042', issuedOn: DAY.certificateIssued, expiresOn: DAY.certificateExpires, articleCodes: ['SEED-NAPPA-BLK'], note: 'Gold rating, renewed this year.' }, portal.userIds.p2Orders, 'Seed Portal Order Desk'),
          select,
        })
        await tx.supplierDocumentUpload.create({
          data: upload(uploads.waiting, files.declaration, partyP2, FileCategory.DECLARATION, T.declaration, { issuer: 'Seed Tannery Two', documentNumber: 'REACH-2026-07', issuedOn: DAY.declarationIssued, lotCodes: ['2231', '2232'] }, portal.userIds.p2Orders, 'Seed Portal Order Desk'),
          select,
        })
      }),
    )
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierDocumentUpload.update({ where: { id: uploads.accepted }, data: { receivedAt: T.certificateArrived, version: 2, updatedAt: T.certificateArrived }, select })
        await tx.supplierDocumentUpload.update({
          where: { id: uploads.accepted },
          data: {
            status: SupplierDocumentUploadStatus.ACCEPTED,
            decidedAt: T.certificateAccepted,
            decidedById: actorId,
            decidedByName: 'Seed Buyer',
            acceptedCategory: FileCategory.SUPPLIER_CERTIFICATE,
            acceptedExpiresOn: DAY.certificateExpires,
            documentFileId: files.certificate,
            version: 3,
            updatedAt: T.certificateAccepted,
          },
          select,
        })
      }),
    )
  }

  // --- P2's profile changes -----------------------------------------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.partyChangeRequest.findUnique({ where: { id: changeRequests.refused }, select })))) {
    await db.withScope(asSupplier, (client) =>
      client.partyChangeRequest.create({
        data: change(
          changeRequests.refused,
          partyP2,
          T.contactAsked,
          [{ target: 'CONTACT', op: 'ADD', id: null, version: null, before: null, after: { name: 'Seed Shipping Desk', email: `shipping.desk.${namespace}@example.com`, phone: '+39 0000 000111', roles: ['ORDERS'] }, changed: ['name', 'email', 'phone', 'roles'] }],
          'Add the contact Seed Shipping Desk (orders).',
          portal.userIds.p2Orders,
          'Seed Portal Order Desk',
        ),
        select,
      }),
    )
    await db.withScope(office, (client) =>
      client.partyChangeRequest.update({
        where: { id: changeRequests.refused },
        data: { status: PartyChangeRequestStatus.REFUSED, decidedAt: T.contactRefused, decidedById: actorId, decidedByName: 'Seed Buyer', refuseReason: "That phone number belongs to another company; send the desk's own.", version: 2, updatedAt: T.contactRefused },
        select,
      }),
    )
    await db.withScope(asSupplier, (client) =>
      client.partyChangeRequest.create({
        data: change(
          changeRequests.open,
          partyP2,
          T.pickupAsked,
          [{ target: 'ADDRESS', op: 'ADD', id: null, version: null, before: null, after: { ...pickup, kinds: [PartyAddressKind.PICKUP] }, changed: ['name', 'line1', 'postalCode', 'city', 'province', 'country', 'contactName', 'phone', 'deliveryNotes', 'kinds'] }],
          'Add the pickup address Seed tannery, second warehouse (Seedtown).',
          portal.userIds.p2Orders,
          'Seed Portal Order Desk',
          'From December our goods also leave from here.',
        ),
        select,
      }),
    )
  }

  // --- P1's own rows, for the generated isolation tests only --------------------------------------------------------------
  if (options.partnerScope && !(await db.withScope(office, (client) => client.partyAddress.findUnique({ where: { id: partner.addressId }, select })))) {
    await db.withScope(office, (client) =>
      client.storedFile.createMany({ data: [supplierFile(partner.fileId, partyP1, 'Seed customer test report.pdf', T.addressAsked, null)], skipDuplicates: true }),
    )
    await db.withScope(asCustomer, (client) =>
      client.$transaction(async (tx) => {
        await tx.partyAddress.create({
          data: {
            id: partner.addressId,
            partyId: partyP1,
            kinds: [PartyAddressKind.SHIP_TO],
            name: 'Seed customer, new shop',
            line1: 'Via Esempio 7',
            postalCode: '20100',
            city: 'Seedcity',
            province: 'MI',
            country: 'IT',
            contactName: 'Seed Shop Desk',
            approvalStatus: PartyAddressApproval.WAITING,
            requestedAt: T.addressAsked,
            requestedByUserId: portal.userIds.p1Buyer,
            createdAt: T.addressAsked,
            updatedAt: T.addressAsked,
          },
          select,
        })
        await tx.supplierDocumentUpload.create({
          data: upload(partner.uploadId, partner.fileId, partyP1, FileCategory.TEST_REPORT, T.addressAsked, { issuer: 'Seed Lab', documentNumber: 'LAB-SEED-7' }, portal.userIds.p1Buyer, 'Seed Portal Buyer'),
          select,
        })
        await tx.partyChangeRequest.create({
          data: change(
            partner.changeRequestId,
            partyP1,
            T.addressAsked,
            [{ target: 'CONTACT', op: 'ADD', id: null, version: null, before: null, after: { name: 'Seed Shop Desk', email: `shop.desk.${namespace}@example.com`, phone: null, roles: ['ORDERS'] }, changed: ['name', 'email', 'roles'] }],
            'Add the contact Seed Shop Desk (orders).',
            portal.userIds.p1Buyer,
            'Seed Portal Buyer',
          ),
          select,
        })
      }),
    )
  }

  return result
}
