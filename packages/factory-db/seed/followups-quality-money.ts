import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  CertificateRenewalStatus,
  PayablesBillingBasis,
  PayablesSdiApproval,
  SdiInboxProblem,
  SdiInboxStatus,
  SupplierInvoiceKind,
  SupplierInvoiceMatchStatus,
  SupplierInvoiceSource,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAccounting } from './accounting'
import { seed as seedCompliance } from './compliance'
import { seed as seedIntegration } from './integration'

/**
 * The W2b follow-ups seed for quality, planning and money (W2b schema wave 2/7, B-W2b-02), per tenant of seed/_core.ts,
 * written in the tenant's office scope as the app does:
 *
 *   interest rate   the reference rate of the half-year from 1 July 2026 for statutory late-payment interest: a
 *                   PLACEHOLDER (2.1500 % + the 8 points of D.Lgs. 231/2002 art. 5), never the published rate: finance
 *                   types the Ministry's figure with its source.
 *   purchasing      company A's purchasing settings: automatic PO confirmation reminders OFF (the Owner's switch).
 *   payables        company A's payables settings: 2 % on quantity and price, 1.00 EUR for rounding, matched on what was
 *                   received, an SDI invoice approved by anyone allowed but not the buyer, and whoever accepted a
 *                   difference does not approve it.
 *   renewal         SEED-CERT-0002 (the protector's certificate, valid to 2030-05-31): its renewal STARTED early, in the
 *                   window 2029-05-31 → 2029-11-30, no task made yet.
 *   lotto           P2's file IT00000002022_00415.xml through SDI with two invoices (2026/0415 and 2026/0416, received
 *                   2026-11-20): the file, its XML and its two invoices, RECEIVED and not matched yet.
 *   SDI inbox       a delivery from a VAT number that is no supplier of company A, OPEN after three pickups; and the lotto
 *                   above, which waited in W2a (a file of several invoices could not be recorded) and is RECORDED now.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a renewal starts STARTED, an inbox item OPEN, a file of several invoices with a new IdentificativoSdI. So the
 * rate, the renewal, the file and the open inbox item get ids that start with eight zeros (still derived from the
 * namespace); the rows this seed adds to other modules' tables (the two invoices, the XML file) start with eight f's, so
 * they never become those tables' first rows. The settings rows are keyed by the company's id.
 *
 * Every name, number, rate and amount is invented. Idempotent: each record is written once, in one transaction, and
 * skipped when it exists.
 */

const T = {
  settings: new Date('2026-11-02T08:00:00.000Z'),
  rate: new Date('2026-11-02T08:30:00.000Z'),
  renewal: new Date('2026-11-03T09:00:00.000Z'),
  lottoDelivered: new Date('2026-11-20T06:40:00.000Z'),
  lottoRecorded: new Date('2026-11-20T06:45:00.000Z'),
  strangerDelivered: new Date('2026-11-18T05:10:00.000Z'),
  strangerLastTried: new Date('2026-11-18T05:40:00.000Z'),
} as const
const DAY = {
  halfYear: new Date('2026-07-01T00:00:00.000Z'),
  windowOpens: new Date('2029-05-31T00:00:00.000Z'),
  windowCloses: new Date('2029-11-30T00:00:00.000Z'),
  lottoIssued: new Date('2026-11-18T00:00:00.000Z'),
  lottoReceived: new Date('2026-11-20T00:00:00.000Z'),
  lottoDue: new Date('2026-12-31T00:00:00.000Z'),
} as const
const YEAR = '2026'
const TEN_YEARS = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear() + 10, at.getUTCMonth(), at.getUTCDate()))
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
/** The two invoices of the lotto: freight and a small accessory order, net and VAT at 22 %, minor units. */
const LOTTO = [
  { number: '2026/0415', net: 4500, vat: 990 },
  { number: '2026/0416', net: 12000, vat: 2640 },
] as const

export interface FollowupsQualityMoneySeed {
  readonly interestRateId: string
  /** Company A's purchasing and payables settings (keyed by the company's id). */
  readonly purchasingSettingsId: string
  readonly payablesSettingsId: string
  /** SEED-CERT-0002's renewal (STARTED). */
  readonly renewalId: string
  /** P2's file of two invoices, its invoices (bodies 1 and 2) and its XML. */
  readonly supplierInvoiceFileId: string
  readonly lottoInvoiceIds: readonly [string, string]
  /** The OPEN delivery from an unknown supplier, and the RECORDED one (the lotto). */
  readonly openInboxItemId: string
  readonly recordedInboxItemId: string
}

export async function seed(context: SeedContext): Promise<FollowupsQualityMoneySeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order: run what this builds on (the money, payables and accounting seeds through
  // seed/accounting.ts; the certificates; the SDI account). All idempotent.
  await seedAccounting(context)
  await seedCompliance(context)
  await seedIntegration(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const P2 = id('party:P2')
  const sdiAccount = id('integration:account:sdi')
  const store = id('files:account:r2')
  const certificateId = id('compliance:certificate:PRO-300')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const

  const ids = {
    interestRateId: firstId('followups:interest:2026-07'),
    purchasingSettingsId: companyA,
    payablesSettingsId: companyA,
    renewalId: firstId('followups:renewal:SEED-CERT-0002'),
    supplierInvoiceFileId: firstId('followups:sdi-file:P2:00415'),
    lottoInvoiceIds: [lastId('followups:supplier-invoice:P2:2026-0415'), lastId('followups:supplier-invoice:P2:2026-0416')] as const,
    openInboxItemId: firstId('followups:sdi-inbox:stranger'),
    recordedInboxItemId: id('followups:sdi-inbox:lotto'),
  }
  const lottoXml: Prisma.StoredFileCreateManyInput = {
    id: lastId('followups:file:sdi-file:P2:00415:xml'),
    companyId: companyA,
    recordType: 'SupplierInvoiceFile',
    recordId: ids.supplierInvoiceFileId,
    kind: 'FISCAL_ARCHIVE',
    originalName: 'IT00000002022_00415.xml',
    contentType: 'application/xml',
    sizeBytes: 4096,
    sha256: sha256(`seed followups ${namespace} lotto xml`),
    storeAccountId: store,
    storageKey: `legal/t/${tenantId}/c/${companyA}/${YEAR}/${id('followups:file:key:lotto-xml')}`,
    status: 'AVAILABLE',
    availableAt: T.lottoRecorded,
    visibility: ['OFFICE'],
    retainUntil: TEN_YEARS(T.lottoRecorded),
    ...stamp(T.lottoRecorded),
  }

  // --- the half-year's reference rate (a placeholder), the purchasing and payables settings -------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.interestReferenceRate.createMany({
        data: [
          {
            id: ids.interestRateId,
            halfYearStart: DAY.halfYear,
            referenceRatePct: '2.1500',
            addedPointsPct: '8.0000',
            source: 'Seed placeholder: type the rate the Ministry published for this half-year (D.Lgs. 231/2002 art. 5)',
            note: 'Made-up figure for the seed; never the published rate.',
            ...stamp(T.rate),
          },
        ],
        skipDuplicates: true,
      })
      await tx.purchasingSettings.createMany({
        data: [{ id: ids.purchasingSettingsId, companyId: companyA, confirmationRemindersEnabled: false, ...stamp(T.settings) }],
        skipDuplicates: true,
      })
      await tx.payablesSettings.createMany({
        data: [
          {
            id: ids.payablesSettingsId,
            companyId: companyA,
            quantityTolerancePct: '2.0000',
            priceTolerancePct: '2.0000',
            differenceToleranceAmount: 100,
            billingBasis: PayablesBillingBasis.RECEIVED,
            sdiApproval: PayablesSdiApproval.NOT_THE_BUYER,
            sdiApproverIds: [],
            accepterMayNotApprove: true,
            ...stamp(T.settings),
          },
        ],
        skipDuplicates: true,
      })
    }),
  )

  // --- SEED-CERT-0002's renewal, started early ---------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.certificateRenewal.findUnique({ where: { id: ids.renewalId }, select })) return
      await tx.certificateRenewal.create({
        data: {
          id: ids.renewalId,
          certificateId,
          status: CertificateRenewalStatus.STARTED,
          windowOpensOn: DAY.windowOpens,
          windowClosesOn: DAY.windowCloses,
          language: 'it',
          startedAt: T.renewal,
          startedById: actorId,
          note: 'Seed: started early to ask the notified body for its list of documents.',
          ...stamp(T.renewal),
        },
        select,
      })
    }),
  )

  // --- P2's file of two invoices through SDI, and the SDI inbox --------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.supplierInvoiceFile.findUnique({ where: { id: ids.supplierInvoiceFileId }, select })) return
      await tx.supplierInvoiceFile.create({
        data: {
          id: ids.supplierInvoiceFileId,
          companyId: companyA,
          partyId: P2,
          sdiIdentifier: 'SEED-SDI-IN-0000002',
          sdiFileName: 'IT00000002022_00415.xml',
          receivedOn: DAY.lottoReceived,
          invoiceCount: LOTTO.length,
          ...stamp(T.lottoRecorded),
        },
        select,
      })
      await tx.storedFile.createMany({ data: [lottoXml], skipDuplicates: true })
      await tx.supplierInvoiceFile.update({ where: { id: ids.supplierInvoiceFileId }, data: { xmlFileId: lottoXml.id as string, version: 2 }, select })
      for (const [index, invoice] of LOTTO.entries()) {
        await tx.supplierInvoice.create({
          data: {
            id: ids.lottoInvoiceIds[index] as string,
            companyId: companyA,
            partyId: P2,
            source: SupplierInvoiceSource.SDI,
            kind: SupplierInvoiceKind.INVOICE,
            docType: 'TD01',
            number: invoice.number,
            issueDate: DAY.lottoIssued,
            receivedOn: DAY.lottoReceived,
            sdiIdentifier: 'SEED-SDI-IN-0000002',
            sdiFileName: 'IT00000002022_00415.xml',
            sdiFileId: ids.supplierInvoiceFileId,
            sdiBodyIndex: index + 1,
            netTotal: invoice.net,
            vatTotal: invoice.vat,
            grossTotal: invoice.net + invoice.vat,
            vatSummary: [{ rate: '22.00', nature: null, taxable: invoice.net, vat: invoice.vat }],
            dueDate: DAY.lottoDue,
            xmlFileId: lottoXml.id as string,
            matchStatus: SupplierInvoiceMatchStatus.PENDING,
            ...stamp(T.lottoRecorded),
          },
          select,
        })
      }
      await tx.sdiInboxItem.createMany({
        data: [
          {
            id: ids.recordedInboxItemId,
            companyId: companyA,
            accountId: sdiAccount,
            providerRef: 'seed-fake-in-0002',
            sdiIdentifier: 'SEED-SDI-IN-0000002',
            fileName: 'IT00000002022_00415.xml',
            receivedAt: T.lottoDelivered,
            problem: SdiInboxProblem.OTHER,
            problemText: 'The file holds a batch of 2 invoices (a "lotto"): it waited until files of several invoices are recorded.',
            attempts: 1,
            firstSeenAt: T.lottoDelivered,
            lastTriedAt: T.lottoDelivered,
            ...stamp(T.lottoDelivered),
          },
        ],
        skipDuplicates: true,
      })
      // The next pickup recorded it (an inbox item starts OPEN).
      await tx.sdiInboxItem.update({
        where: { id: ids.recordedInboxItemId },
        data: { status: SdiInboxStatus.RECORDED, recordedAt: T.lottoRecorded, supplierInvoiceFileId: ids.supplierInvoiceFileId, attempts: 2, lastTriedAt: T.lottoRecorded, version: 2, updatedAt: T.lottoRecorded },
        select,
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.sdiInboxItem.createMany({
      data: [
        {
          id: ids.openInboxItemId,
          companyId: companyA,
          accountId: sdiAccount,
          providerRef: 'seed-fake-in-0003',
          sdiIdentifier: 'SEED-SDI-IN-0000003',
          fileName: 'IT09999999999_00007.xml',
          receivedAt: T.strangerDelivered,
          problem: SdiInboxProblem.SUPPLIER_UNKNOWN,
          problemText: 'The XML names VAT number 09999999999, which is none of the company’s suppliers: add the supplier, then pick up again.',
          attempts: 3,
          firstSeenAt: T.strangerDelivered,
          lastTriedAt: T.strangerLastTried,
          ...stamp(T.strangerDelivered),
        },
      ],
      skipDuplicates: true,
    }),
  )

  return ids
}
