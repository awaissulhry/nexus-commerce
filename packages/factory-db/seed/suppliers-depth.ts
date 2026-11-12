import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  ItemKind,
  PartyContactReceives,
  SubcontractAgreementStatus,
  SupplierBankAccountStatus,
  SupplierKind,
  SupplierQualificationStatus,
  SupplierStatus,
  Tannage,
  WorkCentreKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedPortalFollowups } from './portal-followups'
import { seed as seedProduct } from './product'

/**
 * The suppliers in depth seed (W2b-5, schema wave 42/44, B-W2b-287), per tenant of seed/_core.ts, written as the API will write
 * it: the office's acts in the tenant's office scope (the Owner and the member of seed/auth.ts), the supplier's own proposals in
 * the partner scope of party P2 (the parties seed's supplier and workshop of company A) as its order desk, the portal user of
 * seed/portal-auth.ts. It runs the auth, product (the parties and the operation library) and portal follow-ups seeds (the files
 * store, the portal users, P2's ACCEPTED LWG certificate) first, all idempotent. Every name, number and IBAN is made up: the
 * IBANs are test numbers whose check digits hold (bank and branch codes of zeros); no file is in any store (rows only).
 *
 *   P2          a TANNERY and SUBCONTRACTOR, APPROVED as a supplier by the Owner on 10-28; made in Italy (a made-up region), its
 *               raw hides from Italy and Spain, chrome-free and vegetable tannages; its order desk receives purchase orders,
 *               claims, quality mail and document requests (set by the office on 10-28, before any bank change).
 *   bank        P2's first account (proposed by the Owner, called back and checked by the member, ACTIVE), RETIRED on 10-29 when
 *               the account from the supplier's letter replaced it (proposed by the Owner, called back on the order desk's
 *               phone and checked by the member, ACTIVE: the one payments use); a change proposed in the portal on 10-30 and
 *               REFUSED after the call-back (the order desk had not asked for it); and a change proposed in the portal on
 *               11-03 that waits for its call-back (PROPOSED).
 *   qualify     company A's qualifications of P2: sewing armour pockets (PENDING), leather on its LWG certificate (APPROVED
 *               until the end of 2027), finishing on a visit report (CONDITIONAL, then SUSPENDED: its DURC expired),
 *               protectors (REFUSED: no EN 1621-1 certificate).
 *   agreements  company A's written terms with P2: revision 1 (signed in January, SUPERSEDED on 11-04), revision 2 (SIGNED on
 *               11-04 with its file: the one in force) and revision 3 (a DRAFT for 2027).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: the PROPOSED
 * account from the portal, the PENDING qualification, the DRAFT agreement. They read and write as party P1: with `partnerScope`
 * (that test only) the seed also gives P1 a PROPOSED account its buyer proposed in its portal (id starting with eight f's), the
 * row a partner session may insert. Without it nothing of P1 is written.
 *
 * Idempotent: each part is written once and skipped when its first row exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (the parties seed stamps its rows 2026-10-28 08:00). */
const T = {
  routing: new Date('2026-10-28T08:30:00.000Z'),
  approved: new Date('2026-10-28T08:45:00.000Z'),
  firstProposed: new Date('2026-10-28T09:00:00.000Z'),
  firstCalled: new Date('2026-10-28T09:30:00.000Z'),
  firstChecked: new Date('2026-10-28T09:35:00.000Z'),
  letterProposed: new Date('2026-10-29T08:00:00.000Z'),
  letterCalled: new Date('2026-10-29T10:00:00.000Z'),
  letterChecked: new Date('2026-10-29T10:05:00.000Z'),
  letterActive: new Date('2026-10-29T10:06:00.000Z'),
  portalProposed: new Date('2026-10-30T08:00:00.000Z'),
  portalCalled: new Date('2026-10-30T09:00:00.000Z'),
  portalRefused: new Date('2026-10-30T09:05:00.000Z'),
  pendingProposed: new Date('2026-11-03T08:00:00.000Z'),
  p1Proposed: new Date('2026-11-04T08:00:00.000Z'),
  finishingAsked: new Date('2026-10-30T09:00:00.000Z'),
  visitReport: new Date('2026-10-30T15:00:00.000Z'),
  finishingDecided: new Date('2026-10-30T16:00:00.000Z'),
  protectorsAsked: new Date('2026-11-02T09:00:00.000Z'),
  protectorsDecided: new Date('2026-11-02T11:00:00.000Z'),
  leatherAsked: new Date('2026-11-03T14:30:00.000Z'),
  leatherDecided: new Date('2026-11-03T15:00:00.000Z'),
  sewingAsked: new Date('2026-11-05T09:00:00.000Z'),
  finishingSuspended: new Date('2026-11-06T08:00:00.000Z'),
  terms1Written: new Date('2026-01-08T09:00:00.000Z'),
  terms1Signed: new Date('2026-01-10T10:00:00.000Z'),
  terms2Written: new Date('2026-11-02T09:00:00.000Z'),
  terms2Signed: new Date('2026-11-04T10:00:00.000Z'),
  terms3Written: new Date('2026-11-06T09:00:00.000Z'),
} as const
const DAY = {
  terms1From: new Date('2026-01-01T00:00:00.000Z'),
  terms1Until: new Date('2026-12-31T00:00:00.000Z'),
  terms2From: new Date('2026-11-04T00:00:00.000Z'),
  terms3From: new Date('2027-01-01T00:00:00.000Z'),
  leatherFrom: new Date('2026-11-03T00:00:00.000Z'),
  leatherUntil: new Date('2027-12-31T00:00:00.000Z'),
  finishingFrom: new Date('2026-10-30T00:00:00.000Z'),
} as const

/** Made-up test IBANs (bank and branch codes of zeros), their ISO 7064 check digits correct. */
const IBAN = {
  first: 'IT90X0000000000000000287001',
  letter: 'IT63X0000000000000000287002',
  refused: 'IT36X0000000000000000287003',
  pending: 'IT09X0000000000000000287004',
  p1: 'IT79X0000000000000000287005',
} as const

export interface SuppliersDepthSeedOptions {
  /** The generated isolation tests: party P1 gets a PROPOSED account of its own (see above). */
  readonly partnerScope?: boolean
}

export interface SuppliersDepthSeed {
  readonly bankAccountIds: { readonly retired: string; readonly active: string; readonly refused: string; readonly pending: string; readonly p1: string }
  readonly qualificationIds: { readonly pending: string; readonly approved: string; readonly suspended: string; readonly refused: string }
  readonly agreementIds: { readonly superseded: string; readonly signed: string; readonly draft: string }
  readonly fileIds: { readonly visitReport: string; readonly terms1: string; readonly terms2: string }
  readonly ownerId: string
  readonly memberId: string
  readonly supplierUserId: string
  readonly buyerUserId: string
  readonly orderDeskContactId: string
  readonly certificateUploadId: string
  readonly operationIds: { readonly sew: string }
  readonly companyA: string
  readonly partyP1: string
  readonly partyP2: string
  readonly tenantId: string
}

export async function seed(context: SeedContext, options: SuppliersDepthSeedOptions = {}): Promise<SuppliersDepthSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  await seedProduct(context)
  const followups = await seedPortalFollowups(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const partyP1 = id('party:P1')
  const partyP2 = id('party:P2')
  const orderDesk = id('party-contact:P2:orders')
  const store = id('files:account:r2')
  const select = { id: true } as const
  // The office acts as the Owner (the seeds' actor); the member is the second person.
  const office = { audience: 'office', tenantId, actorId: ownerId } as const
  const asSupplier = { audience: 'partner', tenantId, actorId: followups.supplierUserId, partyId: partyP2 } as const
  const asCustomer = { audience: 'partner', tenantId, actorId: followups.buyerUserId, partyId: partyP1 } as const

  const result: SuppliersDepthSeed = {
    bankAccountIds: {
      retired: id('suppliers:bank:P2:first'),
      active: id('suppliers:bank:P2:letter'),
      refused: id('suppliers:bank:P2:refused'),
      pending: firstId('suppliers:bank:P2:pending'),
      p1: lateId('suppliers:bank:P1:proposed'),
    },
    qualificationIds: {
      pending: firstId('suppliers:qualification:P2:sewing'),
      approved: id('suppliers:qualification:P2:leather'),
      suspended: id('suppliers:qualification:P2:finishing'),
      refused: id('suppliers:qualification:P2:protectors'),
    },
    agreementIds: { superseded: id('suppliers:agreement:P2:1'), signed: id('suppliers:agreement:P2:2'), draft: firstId('suppliers:agreement:P2:3') },
    fileIds: { visitReport: id('suppliers:file:P2:visit'), terms1: id('suppliers:file:P2:terms:1'), terms2: id('suppliers:file:P2:terms:2') },
    ownerId,
    memberId,
    supplierUserId: followups.supplierUserId,
    buyerUserId: followups.buyerUserId,
    orderDeskContactId: orderDesk,
    certificateUploadId: followups.uploads.accepted,
    operationIds: { sew: id('product:operation:SEW') },
    companyA,
    partyP1,
    partyP2,
    tenantId,
  }
  const { bankAccountIds: bank, qualificationIds: qualification, agreementIds: agreement, fileIds: files } = result

  /** A PDF the office keeps for a record of this wave (rows only: no object in any store). */
  const officeFile = (fileId: string, recordType: string, recordId: string, name: string, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    visibility: ['OFFICE'],
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    sha256: createHash('sha256').update(`seed file ${namespace} suppliers-depth ${fileId}`).digest('hex'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`suppliers:key:${fileId}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    storeAccountId: store,
    createdAt: at,
    updatedAt: at,
    createdById: ownerId,
  })

  // --- P2 as a supplier: kinds, status, origin; what its order desk receives ------------------------------------------
  const p2 = await db.withScope(office, (client) => client.party.findUniqueOrThrow({ where: { id: partyP2 }, select: { supplierStatus: true, version: true } }))
  if (p2.supplierStatus === null) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        // Before any bank change: the call-backs below go to a number that was on file, unchanged, before each proposal.
        await tx.partyContact.update({
          where: { id: orderDesk },
          data: { receives: [PartyContactReceives.PO, PartyContactReceives.CLAIM, PartyContactReceives.QUALITY, PartyContactReceives.DOCUMENT], version: { increment: 1 }, updatedAt: T.routing },
          select,
        })
        await tx.party.update({
          where: { id: partyP2 },
          data: {
            supplierKinds: [SupplierKind.TANNERY, SupplierKind.SUBCONTRACTOR],
            supplierStatus: SupplierStatus.APPROVED,
            supplierStatusReason: null,
            supplierStatusChangedAt: T.approved,
            supplierStatusChangedById: ownerId,
            originCountry: 'IT',
            originRegion: 'Seed leather district (made up)',
            originNote: 'Tannery and finishing in one made-up plant; hides bought through two made-up traders.',
            hideOriginCountries: ['IT', 'ES'],
            tannages: [Tannage.CHROME_FREE, Tannage.VEGETABLE],
            version: p2.version + 1,
            updatedAt: T.approved,
          },
          select,
        })
      }),
    )
  }

  // --- P2's bank accounts: never changed in place, each change a new account -------------------------------------------
  const account = (rowId: string, iban: string, holder: string, bankName: string, bic: string | null, proposedById: string, proposedAt: Date, replacesId: string | null) => ({
    id: rowId,
    partyId: partyP2,
    iban,
    holder,
    bankName,
    bic,
    currency: 'EUR',
    replacesId,
    proposedById,
    proposedAt,
    createdAt: proposedAt,
    updatedAt: proposedAt,
  })
  const callBack = (at: Date) => ({ callBackAt: at, callBackById: memberId, callBackContactId: orderDesk, callBackPhone: '+39 000 0000002', updatedAt: at })
  if (!(await db.withScope(office, (client) => client.supplierBankAccount.findUnique({ where: { id: bank.retired }, select })))) {
    // The first account: proposed by the Owner, called back and checked by the member, active.
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierBankAccount.create({ data: { ...account(bank.retired, IBAN.first, 'Seed Leather Supplier S.p.A.', 'Seed Bank One', null, ownerId, T.firstProposed, null), createdById: ownerId }, select })
        await tx.supplierBankAccount.update({ where: { id: bank.retired }, data: { ...callBack(T.firstCalled), version: 2 }, select })
        await tx.supplierBankAccount.update({
          where: { id: bank.retired },
          data: { status: SupplierBankAccountStatus.ACTIVE, verifiedAt: T.firstChecked, verifiedById: memberId, activatedAt: T.firstChecked, version: 3, updatedAt: T.firstChecked },
          select,
        })
      }),
    )
    // The supplier's letter: a new account the Owner typed in, called back on the order desk's phone and checked by the member;
    // the first one retired, then the new one active (one ACTIVE per party and currency).
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierBankAccount.create({
          data: { ...account(bank.active, IBAN.letter, 'Seed Leather Supplier S.p.A.', 'Seed Bank Two', 'SEEDITM1XXX', ownerId, T.letterProposed, bank.retired), createdById: ownerId },
          select,
        })
        await tx.supplierBankAccount.update({ where: { id: bank.active }, data: { ...callBack(T.letterCalled), version: 2 }, select })
        await tx.supplierBankAccount.update({
          where: { id: bank.active },
          data: { status: SupplierBankAccountStatus.VERIFIED, verifiedAt: T.letterChecked, verifiedById: memberId, version: 3, updatedAt: T.letterChecked },
          select,
        })
        await tx.supplierBankAccount.update({
          where: { id: bank.retired },
          data: { status: SupplierBankAccountStatus.RETIRED, retiredAt: T.letterActive, retireReason: 'Replaced by the account ending 7002 (the supplier letter of 29 October).', version: 4, updatedAt: T.letterActive },
          select,
        })
        await tx.supplierBankAccount.update({ where: { id: bank.active }, data: { status: SupplierBankAccountStatus.ACTIVE, activatedAt: T.letterActive, version: 4, updatedAt: T.letterActive }, select })
      }),
    )
    // Proposed in the portal: one refused after the call-back, one that waits for it (the first row).
    await db.withScope(asSupplier, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierBankAccount.create({ data: account(bank.refused, IBAN.refused, 'Seed Leather Supplier S.p.A.', 'Seed Bank Three', null, followups.supplierUserId, T.portalProposed, bank.active), select })
        await tx.supplierBankAccount.create({ data: account(bank.pending, IBAN.pending, 'Seed Leather Supplier S.p.A.', 'Seed Bank Four', 'SEEDITM2XXX', followups.supplierUserId, T.pendingProposed, bank.active), select })
      }),
    )
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.supplierBankAccount.update({ where: { id: bank.refused }, data: { ...callBack(T.portalCalled), version: 2 }, select })
        await tx.supplierBankAccount.update({
          where: { id: bank.refused },
          data: {
            status: SupplierBankAccountStatus.REFUSED,
            refusedAt: T.portalRefused,
            refusedById: memberId,
            refuseReason: 'Our call-back to the order desk on the number we had: they did not ask for this change. Payments stay on the account ending 7002.',
            version: 3,
            updatedAt: T.portalRefused,
          },
          select,
        })
      }),
    )
  }
  if (options.partnerScope && !(await db.withScope(office, (client) => client.supplierBankAccount.findUnique({ where: { id: bank.p1 }, select })))) {
    await db.withScope(asCustomer, (client) =>
      client.supplierBankAccount.create({
        data: { ...account(bank.p1, IBAN.p1, 'Seed Customer One S.r.l.', 'Seed Bank Five', null, followups.buyerUserId, T.p1Proposed, null), partyId: partyP1 },
        select,
      }),
    )
  }

  // --- Company A's qualifications of P2 -------------------------------------------------------------------------------------
  const qualify = (rowId: string, at: Date, scope: Partial<Prisma.SupplierQualificationUncheckedCreateInput>) => ({
    id: rowId,
    companyId: companyA,
    partyId: partyP2,
    ...scope,
    createdAt: at,
    updatedAt: at,
    createdById: ownerId,
  })
  if (!(await db.withScope(office, (client) => client.supplierQualification.findUnique({ where: { id: qualification.pending }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.storedFile.createMany({ data: [officeFile(files.visitReport, 'SupplierQualification', qualification.suspended, 'Seed visit report finishing.pdf', T.visitReport)], skipDuplicates: true })
        // Finishing: a visit, decided CONDITIONAL, then suspended when its DURC expired.
        await tx.supplierQualification.create({
          data: qualify(qualification.suspended, T.finishingAsked, { workCentreKinds: [WorkCentreKind.FINISHING], evidence: [{ recordType: 'StoredFile', recordId: files.visitReport }] }),
          select,
        })
        await tx.supplierQualification.update({
          where: { id: qualification.suspended },
          data: {
            status: SupplierQualificationStatus.CONDITIONAL,
            validFrom: DAY.finishingFrom,
            decidedAt: T.finishingDecided,
            decidedById: memberId,
            conditions: 'The first three jobs are inspected at receipt, every piece.',
            version: 2,
            updatedAt: T.finishingDecided,
          },
          select,
        })
        await tx.supplierQualification.update({
          where: { id: qualification.suspended },
          data: { status: SupplierQualificationStatus.SUSPENDED, suspendedAt: T.finishingSuspended, suspendReason: 'Its DURC expired on 5 November; waiting for the new one.', version: 3, updatedAt: T.finishingSuspended },
          select,
        })
        // Protectors: refused.
        await tx.supplierQualification.create({ data: qualify(qualification.refused, T.protectorsAsked, { materialKinds: [ItemKind.PROTECTOR] }), select })
        await tx.supplierQualification.update({
          where: { id: qualification.refused },
          data: { status: SupplierQualificationStatus.REFUSED, decidedAt: T.protectorsDecided, decidedById: memberId, refuseReason: 'No EN 1621-1 certificate for its protectors.', version: 2, updatedAt: T.protectorsDecided },
          select,
        })
        // Leather: on its accepted LWG certificate, until the end of 2027.
        await tx.supplierQualification.create({
          data: qualify(qualification.approved, T.leatherAsked, {
            materialKinds: [ItemKind.LEATHER],
            validFrom: DAY.leatherFrom,
            validUntil: DAY.leatherUntil,
            evidence: [{ recordType: 'SupplierDocumentUpload', recordId: followups.uploads.accepted }],
          }),
          select,
        })
        await tx.supplierQualification.update({
          where: { id: qualification.approved },
          data: { status: SupplierQualificationStatus.APPROVED, decidedAt: T.leatherDecided, decidedById: memberId, version: 2, updatedAt: T.leatherDecided },
          select,
        })
        // Sewing armour pockets: asked, waiting for the questionnaire (the first row).
        await tx.supplierQualification.create({ data: qualify(qualification.pending, T.sewingAsked, { workCentreKinds: [WorkCentreKind.SEWING], operationIds: [result.operationIds.sew] }), select })
      }),
    )
  }

  // --- Company A's written terms with P2 --------------------------------------------------------------------------------------
  const terms = (rowId: string, revision: number, title: string, at: Date, validFrom: Date, validUntil: Date | null, termsFileId: string | null) => ({
    id: rowId,
    companyId: companyA,
    partyId: partyP2,
    revision,
    title,
    termsFileId,
    validFrom,
    validUntil,
    createdAt: at,
    updatedAt: at,
    createdById: ownerId,
  })
  if (!(await db.withScope(office, (client) => client.subcontractAgreement.findUnique({ where: { id: agreement.superseded }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.storedFile.createMany({
          data: [
            officeFile(files.terms1, 'SubcontractAgreement', agreement.superseded, 'Seed subcontract terms 2026 signed.pdf', T.terms1Signed),
            officeFile(files.terms2, 'SubcontractAgreement', agreement.signed, 'Seed subcontract terms 2026-2027 signed.pdf', T.terms2Signed),
          ],
          skipDuplicates: true,
        })
        await tx.subcontractAgreement.create({ data: terms(agreement.superseded, 1, 'Seed subcontract terms 2026', T.terms1Written, DAY.terms1From, DAY.terms1Until, files.terms1), select })
        await tx.subcontractAgreement.update({ where: { id: agreement.superseded }, data: { status: SubcontractAgreementStatus.SIGNED, signedAt: T.terms1Signed, version: 2, updatedAt: T.terms1Signed }, select })
        await tx.subcontractAgreement.create({ data: terms(agreement.signed, 2, 'Seed subcontract terms 2026-2027', T.terms2Written, DAY.terms2From, null, files.terms2), select })
        // One SIGNED per company and workshop: the old revision is superseded first.
        await tx.subcontractAgreement.update({
          where: { id: agreement.superseded },
          data: { status: SubcontractAgreementStatus.SUPERSEDED, endedAt: T.terms2Signed, endReason: 'Replaced by revision 2: new piece prices and the armour-pocket operation.', version: 3, updatedAt: T.terms2Signed },
          select,
        })
        await tx.subcontractAgreement.update({ where: { id: agreement.signed }, data: { status: SubcontractAgreementStatus.SIGNED, signedAt: T.terms2Signed, version: 2, updatedAt: T.terms2Signed }, select })
        // The first row: a DRAFT for 2027.
        await tx.subcontractAgreement.create({ data: terms(agreement.draft, 3, 'Seed subcontract terms 2027 (draft)', T.terms3Written, DAY.terms3From, null, null), select })
      }),
    )
  }
  return result
}
