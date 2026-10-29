import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  DepositRequestStatus,
  InvoiceDocType,
  InvoiceLineKind,
  InvoicePriceBasis,
  InvoiceStatus,
  PaymentMethod,
  SdiNotificationType,
  SdiSubmissionStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedIntegration } from './integration'
import { seed as seedSales, type SalesSeed } from './sales'
import { seed as seedShipping, type ShippingSeed } from './shipping'

/**
 * The money seed, per tenant of seed/_core.ts: the golden flow's stage 06b-deposit and the start of 15-invoice for
 * company A and the customer P1, written in the tenant's office scope, as the app does (each document goes DRAFT →
 * ISSUED → SENT → DELIVERED through the …_money_guards triggers).
 *
 *   FT-2026-00001  a TD01 of two sample jackets, issued on 2026-10-28 with the number the numbering seed gave the
 *                  made-up invoice `invoice:A:1`; its first send to the (FAKE) SDI provider FAILED (a timeout), the
 *                  second was delivered (RC).
 *   deposit        SEED-SO-0001's 30% deposit (the sales seed's request) paid by one bank transfer on 2026-10-29, the day
 *                  the quote was accepted (so a fresh seed issues today's invoices after it), allocated to the
 *                  request (now PAID), and its deposit invoice TD02 FT-2026-00003 (the series' next number; the
 *                  NumberAllocation row written and the series moved to 4, as allocateNumber does), delivered.
 *   on account     a second transfer of P1 (400.00 EUR) quoting FT-2026-00001: 200.00 is allocated to it, the other 200.00
 *                  stays on account until the customer says what it pays (FIN-122).
 *   TD24 draft     the deferred invoice of SH-0001 (SEED-SO-0002's BLK 50 and RED 52, shipped with DDT 144/2026): a DRAFT,
 *                  no number, its lines naming the DDT and the order lines.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: an invoice and its lines are written only while it is a DRAFT, a send starts without an outcome, and an
 * allocation must fit again in its payment and its invoice. So the DRAFT TD24, its first line, FT-2026-00001's FAILED
 * first send and the on-account allocation (200.00 of 400.00, on an invoice open for 610.00) get ids that start with eight
 * zeros (still derived from the namespace). Rows this seed adds to other modules' tables (files, the number allocation)
 * get ids that start with eight f's, so they never become those tables' first rows.
 *
 * Every name, number and amount is invented (the VAT numbers are the parties seed's fake ones). The XML files are rows
 * only: no object is in any store. Idempotent: each document is written once, in one transaction, and skipped when it
 * exists (issued invoices, sends, notifications and allocations never change after that).
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  sampleDraft: new Date('2026-10-28T09:00:00.000Z'),
  sampleIssued: new Date('2026-10-28T09:10:00.000Z'),
  sampleFailed: new Date('2026-10-28T09:11:00.000Z'),
  sampleSent: new Date('2026-10-28T09:30:00.000Z'),
  sampleDelivered: new Date('2026-10-28T10:05:00.000Z'),
  // Paid on the day the quote was accepted (seed/sales.ts T.accepted, 2026-10-29 15:00): a deposit invoice dated on
  // or before the day a fresh seed runs, so the INVOICE series lets today's invoices follow it (DPR 633/1972 art. 21).
  depositRecorded: new Date('2026-10-29T16:00:00.000Z'),
  depositIssued: new Date('2026-10-29T16:05:00.000Z'),
  depositSent: new Date('2026-10-29T16:06:00.000Z'),
  depositDelivered: new Date('2026-10-29T16:40:00.000Z'),
  onAccount: new Date('2026-11-10T09:00:00.000Z'),
  td24Draft: new Date('2026-11-25T09:00:00.000Z'),
} as const
const DAY = {
  sample: new Date('2026-10-28T00:00:00.000Z'),
  deposit: new Date('2026-10-29T00:00:00.000Z'),
  onAccount: new Date('2026-11-10T00:00:00.000Z'),
} as const
const TEN_YEARS = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear() + 10, at.getUTCMonth(), at.getUTCDate()))
const YEAR = '2026'
/** The parties seed's fake VAT numbers (FAKE_VAT): P1 and the company. */
const FAKE_VAT = { P1: '00000001016', company: '00000003038' } as const

export interface MoneySeed {
  readonly sales: SalesSeed
  readonly shipping: ShippingSeed
  /** FT-2026-00001 (TD01, DELIVERED after a failed first send), its XML and its two sends. */
  readonly sampleInvoiceId: string
  readonly sampleXmlFileId: string
  readonly sampleSubmissionIds: readonly [string, string]
  /** The deposit: its payment and allocation, TD02 FT-2026-00003 (DELIVERED) and its XML. */
  readonly depositPaymentId: string
  readonly depositAllocationId: string
  readonly depositInvoiceId: string
  readonly depositXmlFileId: string
  /** The on-account payment (400.00) and its allocation of 200.00 to FT-2026-00001. */
  readonly onAccountPaymentId: string
  readonly onAccountAllocationId: string
  /** The DRAFT TD24 of SH-0001 and its two lines. */
  readonly draftInvoiceId: string
  readonly draftLineIds: readonly [string, string]
  /** Company A's INVOICE series for the year. */
  readonly invoiceSeriesId: string
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
/** Minor units as a Decimal(18,6) string: 40000 → "400.000000". */
const price = (minor: number): string => `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}0000`

export async function seed(context: SeedContext): Promise<MoneySeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order and money comes before sales and shipping: run the seeds this one builds on
  // first (all idempotent). Shipping runs the quality, production, inventory, supply, sales, product, parties and
  // numbering seeds; files gives the store, integration the (FAKE) SDI account.
  const shipping = await seedShipping(context)
  const sales = await seedSales(context)
  await seedFiles(context)
  await seedIntegration(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const sdiAccount = id('integration:account:sdi')
  const store = id('files:account:r2')
  const invoiceSeriesId = id(`series:A:INVOICE:MAIN:${YEAR}`)
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const

  const seller = {
    vatNumber: FAKE_VAT.company,
    name: 'Seed Company A',
    taxRegime: 'RF01',
    address: { street: 'Via Esempio', streetNumber: '1', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
  }
  const billTo = {
    kind: 'IT_BUSINESS',
    vatNumber: FAKE_VAT.P1,
    fiscalCode: FAKE_VAT.P1,
    name: 'Seed Customer One S.r.l.',
    address: { street: 'Via Esempio', streetNumber: '10', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
    sdiCode: 'SEEDC01',
  }
  const vat22 = (taxable: number, vat: number) => [{ rate: '22.00', nature: null, legalRef: null, taxable, vat, rounding: 0 }]
  const xmlFile = (key: string, invoiceId: string, fileName: string, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: lastId(`money:file:${key}:xml`),
    companyId: companyA,
    recordType: 'Invoice',
    recordId: invoiceId,
    kind: 'FISCAL_ARCHIVE',
    originalName: fileName,
    contentType: 'application/xml',
    sizeBytes: 4096,
    sha256: sha256(`seed money ${namespace} ${key}`),
    storeAccountId: store,
    storageKey: `legal/t/${tenantId}/c/${companyA}/${YEAR}/${id(`money:file:key:${key}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    visibility: ['OFFICE'],
    retainUntil: TEN_YEARS(at),
    ...stamp(at),
  })
  const rc = (key: string, invoiceId: string, submissionId: string, fileName: string, sdiIdentifier: string, at: Date): Prisma.SdiNotificationCreateManyInput => ({
    id: id(`money:notification:${key}:RC`),
    partyId: P1,
    invoiceId,
    submissionId,
    type: SdiNotificationType.RC,
    sdiMessageId: `${sdiIdentifier}-RC`,
    receivedAt: at,
    recordedAt: at,
    payload: { IdentificativoSdI: sdiIdentifier, NomeFile: fileName, DataOraRicezione: at.toISOString(), DataOraConsegna: at.toISOString(), MessageId: `${sdiIdentifier}-RC` },
    createdById: actorId,
  })

  // --- FT-2026-00001: a TD01 of two sample jackets, delivered after a failed first send ---------------------------------
  const sampleInvoiceId = id('invoice:A:1')
  const sampleXml = xmlFile('FT-2026-00001', sampleInvoiceId, `IT${FAKE_VAT.company}_00001.xml`, T.sampleIssued)
  const sampleSubmissionIds = [firstId('money:submission:FT-2026-00001:1'), id('money:submission:FT-2026-00001:2')] as const
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.invoice.findUnique({ where: { id: sampleInvoiceId }, select })) return
      await tx.invoice.create({
        data: {
          id: sampleInvoiceId,
          companyId: companyA,
          buyerPartyId: P1,
          docType: InvoiceDocType.TD01,
          priceBasis: InvoicePriceBasis.NET,
          billTo,
          netTotal: 50000,
          vatTotal: 11000,
          grossTotal: 61000,
          vatSummary: vat22(50000, 11000),
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 61000, dueDate: '2026-11-27' }] },
          causale: 'Campioni',
          ...stamp(T.sampleDraft),
        },
        select,
      })
      await tx.invoiceLine.create({
        data: {
          id: id('money:line:FT-2026-00001:1'),
          invoiceId: sampleInvoiceId,
          buyerPartyId: P1,
          seq: 1,
          kind: InvoiceLineKind.GOODS,
          description: 'Seed sample jacket (sample, size 52)',
          quantity: '2.0000',
          uom: 'PZ',
          unitPrice: price(25000),
          netAmount: 50000,
          vatRatePct: '22.00',
          ...stamp(T.sampleDraft),
        },
        select,
      })
      await tx.storedFile.createMany({ data: [sampleXml], skipDuplicates: true })
      // Issued with the numbering seed's number for this record (its NumberAllocation row exists).
      await tx.invoice.update({
        where: { id: sampleInvoiceId },
        data: {
          status: InvoiceStatus.ISSUED,
          numberSeriesId: invoiceSeriesId,
          number: `FT-${YEAR}-00001`,
          year: Number(YEAR),
          issueDate: DAY.sample,
          issuedAt: T.sampleIssued,
          issuedById: actorId,
          partyId: P1,
          seller,
          xmlFileId: sampleXml.id,
          version: 2,
          updatedAt: T.sampleIssued,
        },
        select,
      })
      // The first send: the provider did not answer.
      await tx.sdiSubmission.create({
        data: {
          id: sampleSubmissionIds[0],
          partyId: P1,
          invoiceId: sampleInvoiceId,
          attempt: 1,
          integrationAccountId: sdiAccount,
          fileName: `IT${FAKE_VAT.company}_00001.xml`,
          xmlFileId: sampleXml.id,
          status: SdiSubmissionStatus.FAILED,
          failureReason: 'timeout',
          ...stamp(T.sampleFailed),
        },
        select,
      })
      await tx.invoice.update({ where: { id: sampleInvoiceId }, data: { status: InvoiceStatus.ERROR, version: 3, updatedAt: T.sampleFailed }, select })
      // The second: taken, then delivered.
      await tx.sdiSubmission.create({
        data: {
          id: sampleSubmissionIds[1],
          partyId: P1,
          invoiceId: sampleInvoiceId,
          attempt: 2,
          integrationAccountId: sdiAccount,
          fileName: `IT${FAKE_VAT.company}_00002.xml`,
          xmlFileId: sampleXml.id,
          status: SdiSubmissionStatus.SENT,
          providerRef: 'fake-send-00002',
          sentAt: T.sampleSent,
          ...stamp(T.sampleSent),
        },
        select,
      })
      await tx.invoice.update({ where: { id: sampleInvoiceId }, data: { status: InvoiceStatus.SENT, version: 4, updatedAt: T.sampleSent }, select })
      await tx.sdiNotification.createMany({
        data: [rc('FT-2026-00001', sampleInvoiceId, sampleSubmissionIds[1], `IT${FAKE_VAT.company}_00002.xml`, 'SEED-SDI-0000001', T.sampleDelivered)],
        skipDuplicates: true,
      })
      await tx.sdiSubmission.update({
        where: { id: sampleSubmissionIds[1] },
        data: { status: SdiSubmissionStatus.DELIVERED, sdiIdentifier: 'SEED-SDI-0000001', outcomeAt: T.sampleDelivered, version: 2, updatedAt: T.sampleDelivered },
        select,
      })
      await tx.invoice.update({ where: { id: sampleInvoiceId }, data: { status: InvoiceStatus.DELIVERED, version: 5, updatedAt: T.sampleDelivered }, select })
    }),
  )

  // --- the deposit of SEED-SO-0001: the transfer, its allocation, TD02 FT-2026-00003 ----------------------------------
  const depositPaymentId = id('money:payment:deposit:SO-0001')
  const depositAllocationId = id('money:allocation:deposit:SO-0001')
  const depositInvoiceId = id('money:invoice:TD02:SO-0001')
  const depositXml = xmlFile('FT-2026-00003', depositInvoiceId, `IT${FAKE_VAT.company}_00003.xml`, T.depositIssued)
  const depositSubmissionId = id('money:submission:FT-2026-00003:1')
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.invoice.findUnique({ where: { id: depositInvoiceId }, select })) return
      const request = await tx.depositRequest.findUniqueOrThrow({ where: { id: sales.depositRequestId }, select: { amount: true, currency: true, version: true } })
      const gross = request.amount
      const taxable = Math.round((gross * 100) / 122)
      const vat = gross - taxable

      await tx.payment.create({
        data: {
          id: depositPaymentId,
          companyId: companyA,
          partyId: P1,
          method: PaymentMethod.BANK_TRANSFER,
          amount: gross,
          currency: request.currency,
          receivedOn: DAY.deposit,
          externalRef: 'SEED-TRN-0000001',
          ...stamp(T.depositRecorded),
        },
        select,
      })
      await tx.paymentAllocation.createMany({
        data: [{ id: depositAllocationId, companyId: companyA, partyId: P1, paymentId: depositPaymentId, depositRequestId: sales.depositRequestId, amount: gross, createdAt: T.depositRecorded, createdById: actorId }],
        skipDuplicates: true,
      })
      await tx.depositRequest.update({
        where: { id: sales.depositRequestId },
        data: { status: DepositRequestStatus.PAID, paidAt: T.depositRecorded, version: request.version + 1, updatedAt: T.depositRecorded },
        select,
      })

      await tx.invoice.create({
        data: {
          id: depositInvoiceId,
          companyId: companyA,
          buyerPartyId: P1,
          docType: InvoiceDocType.TD02,
          priceBasis: InvoicePriceBasis.GROSS,
          currency: request.currency,
          billTo,
          netTotal: taxable,
          vatTotal: vat,
          grossTotal: gross,
          vatSummary: vat22(taxable, vat),
          causale: 'Acconto 30% ordine SEED-SO-0001',
          salesOrderId: sales.orderId,
          depositRequestId: sales.depositRequestId,
          ...stamp(T.depositIssued),
        },
        select,
      })
      await tx.invoiceLine.create({
        data: {
          id: id('money:line:FT-2026-00003:1'),
          invoiceId: depositInvoiceId,
          buyerPartyId: P1,
          seq: 1,
          kind: InvoiceLineKind.GOODS,
          description: 'Acconto 30% ordine SEED-SO-0001',
          quantity: '1.0000',
          unitPrice: price(gross),
          netAmount: taxable,
          grossAmount: gross,
          vatRatePct: '22.00',
          ...stamp(T.depositIssued),
        },
        select,
      })
      // The number, as allocateNumber gives it: the series' next value, its NumberAllocation row, the series moved on.
      await tx.numberAllocation.createMany({
        data: [
          {
            id: lastId('money:allocation:FT-2026-00003'),
            companyId: companyA,
            seriesId: invoiceSeriesId,
            kind: 'INVOICE',
            value: 3,
            formatted: `FT-${YEAR}-00003`,
            documentDate: DAY.deposit,
            recordType: 'Invoice',
            recordId: depositInvoiceId,
            allocatedAt: T.depositIssued,
            allocatedById: actorId,
            requestId: 'seed-money-FT-2026-00003',
          },
        ],
        skipDuplicates: true,
      })
      await tx.numberSeries.update({ where: { id: invoiceSeriesId }, data: { nextValue: 4, lastIssuedDate: DAY.deposit, updatedAt: T.depositIssued }, select })
      await tx.storedFile.createMany({ data: [depositXml], skipDuplicates: true })
      await tx.invoice.update({
        where: { id: depositInvoiceId },
        data: {
          status: InvoiceStatus.ISSUED,
          numberSeriesId: invoiceSeriesId,
          number: `FT-${YEAR}-00003`,
          year: Number(YEAR),
          issueDate: DAY.deposit,
          issuedAt: T.depositIssued,
          issuedById: actorId,
          partyId: P1,
          seller,
          xmlFileId: depositXml.id,
          version: 2,
          updatedAt: T.depositIssued,
        },
        select,
      })
      await tx.sdiSubmission.create({
        data: {
          id: depositSubmissionId,
          partyId: P1,
          invoiceId: depositInvoiceId,
          attempt: 1,
          integrationAccountId: sdiAccount,
          fileName: `IT${FAKE_VAT.company}_00003.xml`,
          xmlFileId: depositXml.id,
          status: SdiSubmissionStatus.SENT,
          providerRef: 'fake-send-00003',
          sentAt: T.depositSent,
          ...stamp(T.depositSent),
        },
        select,
      })
      await tx.invoice.update({ where: { id: depositInvoiceId }, data: { status: InvoiceStatus.SENT, version: 3, updatedAt: T.depositSent }, select })
      await tx.sdiNotification.createMany({
        data: [rc('FT-2026-00003', depositInvoiceId, depositSubmissionId, `IT${FAKE_VAT.company}_00003.xml`, 'SEED-SDI-0000003', T.depositDelivered)],
        skipDuplicates: true,
      })
      await tx.sdiSubmission.update({
        where: { id: depositSubmissionId },
        data: { status: SdiSubmissionStatus.DELIVERED, sdiIdentifier: 'SEED-SDI-0000003', outcomeAt: T.depositDelivered, version: 2, updatedAt: T.depositDelivered },
        select,
      })
      await tx.invoice.update({ where: { id: depositInvoiceId }, data: { status: InvoiceStatus.DELIVERED, version: 4, updatedAt: T.depositDelivered }, select })
    }),
  )

  // --- a transfer on account: 200.00 of 400.00 allocated to FT-2026-00001 ----------------------------------------------
  const onAccountPaymentId = id('money:payment:on-account:1')
  const onAccountAllocationId = firstId('money:allocation:on-account:1')
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.payment.findUnique({ where: { id: onAccountPaymentId }, select })) return
      await tx.payment.create({
        data: {
          id: onAccountPaymentId,
          companyId: companyA,
          partyId: P1,
          method: PaymentMethod.BANK_TRANSFER,
          amount: 40000,
          currency: 'EUR',
          receivedOn: DAY.onAccount,
          externalRef: 'SEED-TRN-0000002',
          internalNote: 'Quotes FT-2026-00001 and an older invoice; the rest waits for the customer.',
          ...stamp(T.onAccount),
        },
        select,
      })
      await tx.paymentAllocation.createMany({
        data: [{ id: onAccountAllocationId, companyId: companyA, partyId: P1, paymentId: onAccountPaymentId, invoiceId: sampleInvoiceId, amount: 20000, createdAt: T.onAccount, createdById: actorId }],
        skipDuplicates: true,
      })
    }),
  )

  // --- the DRAFT TD24 of SH-0001 (DDT 144/2026) ------------------------------------------------------------------------
  const draftInvoiceId = firstId('money:invoice:TD24:SH-0001')
  const draftLineIds = [firstId('money:line:TD24:SH-0001:1'), id('money:line:TD24:SH-0001:2')] as const
  const orderLine = { BLK: id('production:sales-order:SO-0002:10'), RED: id('production:sales-order:SO-0002:20') }
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.invoice.findUnique({ where: { id: draftInvoiceId }, select })) return
      await tx.invoice.create({
        data: {
          id: draftInvoiceId,
          companyId: companyA,
          buyerPartyId: P1,
          docType: InvoiceDocType.TD24,
          priceBasis: InvoicePriceBasis.NET,
          billTo,
          netTotal: 80000,
          vatTotal: 17600,
          grossTotal: 97600,
          vatSummary: vat22(80000, 17600),
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 97600, dueDate: '2026-12-31' }] },
          documentRefs: [{ kind: 'PURCHASE_ORDER', number: 'SEED-SO-0002' }],
          salesOrderId: id('production:sales-order:SO-0002'),
          ...stamp(T.td24Draft),
        },
        select,
      })
      const lines: Prisma.InvoiceLineCreateManyInput[] = [
        { id: draftLineIds[0], seq: 1, description: 'Seed jacket JKT-02 BLK, size 50', itemCode: 'SEED-JKT-02-BLK-50', salesOrderLineId: orderLine.BLK, size: '50' },
        { id: draftLineIds[1], seq: 2, description: 'Seed jacket JKT-02 RED, size 52', itemCode: 'SEED-JKT-02-RED-52', salesOrderLineId: orderLine.RED, size: '52' },
      ].map((line) => ({
        ...line,
        invoiceId: draftInvoiceId,
        buyerPartyId: P1,
        kind: InvoiceLineKind.GOODS,
        quantity: '1.0000',
        uom: 'PZ',
        unitPrice: price(40000),
        netAmount: 40000,
        vatRatePct: '22.00',
        ddtId: shipping.ddtId,
        ...stamp(T.td24Draft),
      }))
      await tx.invoiceLine.createMany({ data: lines })
    }),
  )

  return {
    sales,
    shipping,
    sampleInvoiceId,
    sampleXmlFileId: sampleXml.id as string,
    sampleSubmissionIds,
    depositPaymentId,
    depositAllocationId,
    depositInvoiceId,
    depositXmlFileId: depositXml.id as string,
    onAccountPaymentId,
    onAccountAllocationId,
    draftInvoiceId,
    draftLineIds,
    invoiceSeriesId,
  }
}
