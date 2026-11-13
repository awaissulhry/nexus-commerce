import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAccounting } from './accounting'
import { seed as seedFiles } from './files'
import { seed as seedPricing } from './pricing'

/**
 * The invoicing, tax and currency seed (W2b schema wave 49/57, B-W2b-369), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the API writes them. The CLI runs the seed files in name order and this one sorts after
 * accounting, files and pricing, which it runs first (each idempotent; accounting runs money and the earlier seeds). Every
 * number, protocol, rate and amount is made up; nothing seeded can be sent anywhere. GATE-ACCOUNTANT: every tax switch
 * stays OFF, so no seeded invoice names a declaration of intent, carries a STAMP_DUTY line or is a self-invoice.
 *
 *   e-invoicing   company A in test mode, answers simulated as DELIVERED; company B live with the (FAKE) provider since
 *                 2026-11-09 (the seed's actor), answers REJECTED kept for when it goes back to test mode. Every switch off.
 *   tax codes     company A: "22" typed twice by mistake (ARCHIVED, the first row), "22" the ordinary rate (VERIFIED,
 *                 IT_DOMESTIC_SUPPLY), "10" ended on 2025-12-31 and its version from 2026-01-01, "N3.1" exports and
 *                 "N3.2" intra-EU goods (VERIFIED), "N3.5" declarations of intent and "N1-BOLLO" the stamp duty charged to
 *                 the customer (UNVERIFIED: the accountant's). Company B: "22".
 *   declarations  P1 to company A: one revoked (replaced; the first row) and the live one for 2026, checked on the tax
 *                 agency's site with its receipt (a made-up PDF row), nothing used yet.
 *   stamp duty    company A: the quarter from 1 October (1 invoice, 2.00, not paid; the first row) and the quarter from
 *                 1 July (3 invoices, 6.00), paid on 2026-11-10.
 *   self-invoices company A: P2's SDI invoice needs none after all (CANCELLED, the first row); P3's service invoice typed in
 *                 from its PDF (a made-up German invoice) waits for its TD17 by 2026-12-15.
 *   SDI copy      FT-2026-00001's delivered send, copied with its XML and SDI's receipt (a made-up receipt row), held then by
 *                 the FAKE provider.
 *   invoice runs  company A: November for P1, a PREVIEW (the first row); October for P1 and P2, ISSUED with no invoice left.
 *   deposit rules company A: an old rule (ARCHIVED, the first row); the customer cancels an acconto: paid back, a credit
 *                 note; a made-to-measure order: 30 % kept; a caparra: kept; we cancel a caparra: paid back double.
 *   payment terms "Ri.Ba. 60 gg f.m., escluso agosto" (from the end of the month, August skipped).
 *   currencies    company A: CHF switched off (the first row), EUR (the base), USD, GBP; company B: EUR.
 *   rates         the ECB's EUR→USD of 2026-11-11 (the first row) and 2026-11-12, EUR→GBP of 2026-11-12; a manual EUR→USD of
 *                 2026-11-12 typed by the actor.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight
 * zeros) and insert the copy as the office: so those first rows are the plain ones a copy may repeat. The rows this seed
 * adds to other modules' tables (files, a supplier invoice, payment terms) get ids that start with eight f's. Fixed
 * instants, so nothing depends on the clock. Idempotent: rows are written with skipDuplicates.
 */

const AT = new Date('2026-11-10T08:00:00.000Z')
const T = {
  bLive: new Date('2026-11-09T09:00:00.000Z'),
  revoked: new Date('2026-03-01T09:00:00.000Z'),
  checked: new Date('2026-03-03T10:00:00.000Z'),
  julyPaid: new Date('2026-11-10T11:00:00.000Z'),
  octoberRun: new Date('2026-11-02T08:00:00.000Z'),
  octoberIssued: new Date('2026-11-02T09:30:00.000Z'),
  cancelled: new Date('2026-11-13T07:30:00.000Z'),
  foreignTyped: new Date('2026-11-05T10:00:00.000Z'),
  copied: new Date('2026-10-28T10:10:00.000Z'),
} as const
const DAY = (text: string): Date => new Date(`${text}T00:00:00.000Z`)
const TEN_YEARS = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear() + 10, at.getUTCMonth(), at.getUTCDate()))

export interface TaxSeed {
  readonly companyA: string
  readonly companyB: string
  readonly tenantId: string
  readonly actorId: string
  readonly taxCodeIds: { readonly mistake: string; readonly ordinary: string; readonly reducedOld: string; readonly reduced: string; readonly exportCode: string; readonly intraEu: string; readonly declaration: string; readonly stampDuty: string; readonly companyB: string }
  readonly declarationIds: { readonly revoked: string; readonly live: string }
  readonly declarationReceiptFileId: string
  readonly stampDutyQuarterIds: { readonly october: string; readonly july: string }
  readonly selfInvoiceIds: { readonly cancelled: string; readonly pending: string }
  readonly foreignSupplierInvoiceId: string
  readonly archiveCopyId: string
  readonly receiptFileId: string
  readonly invoiceRunIds: { readonly november: string; readonly october: string }
  readonly depositRuleIds: { readonly old: string; readonly acconto: string; readonly madeToMeasure: string; readonly caparra: string; readonly caparraOurs: string }
  readonly paymentTermsId: string
  readonly currencyIds: { readonly chf: string; readonly eur: string; readonly usd: string; readonly gbp: string; readonly bEur: string }
  readonly rateIds: { readonly ecbUsd11: string; readonly ecbUsd12: string; readonly ecbGbp12: string; readonly manualUsd12: string }
}

export async function seed(context: SeedContext): Promise<TaxSeed> {
  const { db, namespace } = context
  const accounting = await seedAccounting(context)
  await seedFiles(context)
  await seedPricing(context)
  const money = accounting.money
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const sha256 = (text: string): string => createHash('sha256').update(`seed tax ${namespace} ${text}`).digest('hex')
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const P1 = id('party:P1')
  const P2 = id('party:P2')
  const P3 = id('party:P3')
  const store = id('files:account:r2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  // --- e-invoice settings ---------------------------------------------------------------------------------------------
  const settings: Prisma.CompanyEInvoiceSettingsCreateManyInput[] = [
    { id: companyA, companyId: companyA, testMode: true, simulateOutcome: 'DELIVERED', ...stamp(AT) },
    { id: companyB, companyId: companyB, testMode: false, liveSince: T.bLive, liveSetById: actorId, simulateOutcome: 'REJECTED', ...stamp(T.bLive) },
  ]

  // --- tax codes ------------------------------------------------------------------------------------------------------
  const taxCodeIds = {
    mistake: firstId('tax:code:A:22:mistake'),
    ordinary: id('tax:code:A:22:2026'),
    reducedOld: id('tax:code:A:10:2025'),
    reduced: id('tax:code:A:10:2026'),
    exportCode: id('tax:code:A:N3.1'),
    intraEu: id('tax:code:A:N3.2'),
    declaration: id('tax:code:A:N3.5'),
    stampDuty: id('tax:code:A:N1-BOLLO'),
    companyB: id('tax:code:B:22'),
  }
  const code = (
    rowId: string,
    companyId: string,
    values: Omit<Prisma.TaxCodeCreateManyInput, 'id' | 'companyId' | 'country' | 'createdAt' | 'updatedAt' | 'createdById'>,
  ): Prisma.TaxCodeCreateManyInput => ({ id: rowId, companyId, country: 'IT', ...values, ...stamp(AT) })
  const taxCodes = [
    code(taxCodeIds.mistake, companyA, { code: '22', label: 'Ordinary rate (typed twice by mistake)', ratePct: '22.00', validFrom: DAY('2026-01-01'), status: 'ARCHIVED' }),
    code(taxCodeIds.ordinary, companyA, { code: '22', label: 'Ordinary rate 22%', ratePct: '22.00', accountCodeKey: 'VAT_SALES_22', ruleId: 'IT_DOMESTIC_SUPPLY', verification: 'VERIFIED', validFrom: DAY('2026-01-01') }),
    code(taxCodeIds.reducedOld, companyA, { code: '10', label: 'Reduced rate 10%', ratePct: '10.00', accountCodeKey: 'VAT_SALES_10', verification: 'VERIFIED', validFrom: DAY('2025-01-01'), validTo: DAY('2025-12-31') }),
    code(taxCodeIds.reduced, companyA, { code: '10', label: 'Reduced rate 10%', ratePct: '10.00', accountCodeKey: 'VAT_SALES_10_2026', verification: 'VERIFIED', validFrom: DAY('2026-01-01') }),
    code(taxCodeIds.exportCode, companyA, { code: 'N3.1', label: 'Export, no Italian VAT', ratePct: '0.00', natura: 'N3.1', legalRef: 'Art. 8 c.1 lett. a) DPR 633/1972', accountCodeKey: 'SALES_EXPORT', ruleId: 'EXPORT_OF_GOODS', verification: 'VERIFIED', validFrom: DAY('2026-01-01') }),
    code(taxCodeIds.intraEu, companyA, { code: 'N3.2', label: 'Sale of goods to an EU business', ratePct: '0.00', natura: 'N3.2', legalRef: 'Art. 41 DL 331/1993', accountCodeKey: 'SALES_INTRA_EU', ruleId: 'INTRA_EU_SUPPLY_OF_GOODS', verification: 'VERIFIED', validFrom: DAY('2026-01-01') }),
    code(taxCodeIds.declaration, companyA, { code: 'N3.5', label: "Customer's declaration of intent", ratePct: '0.00', natura: 'N3.5', legalRef: 'Art. 8 c.1 lett. c) DPR 633/1972', accountCodeKey: 'SALES_DECLARATION', validFrom: DAY('2026-01-01') }),
    code(taxCodeIds.stampDuty, companyA, { code: 'N1-BOLLO', label: 'Stamp duty charged to the customer', ratePct: '0.00', natura: 'N1', legalRef: 'Art. 15 DPR 633/1972', accountCodeKey: 'STAMP_DUTY_RECHARGED', ruleId: 'STAMP_DUTY', validFrom: DAY('2026-01-01') }),
    code(taxCodeIds.companyB, companyB, { code: '22', label: 'Ordinary rate 22%', ratePct: '22.00', accountCodeKey: 'VAT_SALES_22', ruleId: 'IT_DOMESTIC_SUPPLY', verification: 'VERIFIED', validFrom: DAY('2026-01-01') }),
  ]

  // --- declarations of intent ------------------------------------------------------------------------------------------
  const declarationIds = { revoked: firstId('tax:doi:A:P1:2026:old'), live: id('tax:doi:A:P1:2026') }
  const declarationReceiptFileId = lastId('tax:file:doi:A:P1:2026:receipt')
  const receiptFile: Prisma.StoredFileCreateManyInput = {
    id: declarationReceiptFileId,
    companyId: companyA,
    recordType: 'DeclarationOfIntent',
    recordId: declarationIds.live,
    kind: 'DOCUMENT',
    originalName: 'declaration-check-receipt.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    sha256: sha256('declaration receipt'),
    storeAccountId: store,
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id('tax:file:doi:key')}`,
    status: 'AVAILABLE',
    availableAt: T.checked,
    visibility: ['OFFICE'],
    ...stamp(T.checked),
  }
  const declarations: Prisma.DeclarationOfIntentCreateManyInput[] = [
    { id: declarationIds.revoked, companyId: companyA, partyId: P1, protocolNumber: '26000000000000001-000001', protocolDate: DAY('2026-01-15'), year: 2026, amount: 1_000_000, revokedAt: T.revoked, revokeReason: "Replaced by the customer's new declaration", ...stamp(DAY('2026-01-15')) },
    { id: declarationIds.live, companyId: companyA, partyId: P1, protocolNumber: '26000000000000002-000001', protocolDate: DAY('2026-03-02'), year: 2026, amount: 5_000_000, usedAmount: 0, checkedAt: T.checked, checkedById: actorId, receiptFileId: declarationReceiptFileId, ...stamp(T.checked) },
  ]

  // --- stamp duty quarters ----------------------------------------------------------------------------------------------
  const stampDutyQuarterIds = { october: firstId('tax:stamp:A:2026-10'), july: id('tax:stamp:A:2026-07') }
  const quarters: Prisma.StampDutyQuarterCreateManyInput[] = [
    { id: stampDutyQuarterIds.october, companyId: companyA, quarterStart: DAY('2026-10-01'), invoiceCount: 1, total: 200, ...stamp(AT) },
    { id: stampDutyQuarterIds.july, companyId: companyA, quarterStart: DAY('2026-07-01'), invoiceCount: 3, total: 600, paidAt: T.julyPaid, paidById: actorId, ...stamp(T.julyPaid) },
  ]

  // --- a foreign supplier's invoice and the self-invoices ---------------------------------------------------------------
  const foreignSupplierInvoiceId = lastId('tax:supplier-invoice:P3:SEED-DE-117')
  const foreignInvoice: Prisma.SupplierInvoiceCreateManyInput = {
    id: foreignSupplierInvoiceId,
    companyId: companyA,
    partyId: P3,
    source: 'MANUAL',
    kind: 'INVOICE',
    number: 'SEED-DE-117',
    issueDate: DAY('2026-11-02'),
    receivedOn: DAY('2026-11-05'),
    currency: 'EUR',
    netTotal: 120_000,
    vatTotal: 0,
    grossTotal: 120_000,
    vatSummary: [],
    dueDate: DAY('2026-12-05'),
    ...stamp(T.foreignTyped),
  }
  const selfInvoiceIds = { cancelled: firstId('tax:self-invoice:A:P2:2026-0412'), pending: id('tax:self-invoice:A:P3:SEED-DE-117') }
  const selfInvoices: Prisma.SelfInvoiceCreateManyInput[] = [
    { id: selfInvoiceIds.cancelled, companyId: companyA, partyId: P2, supplierInvoiceId: accounting.supplierInvoiceId, kind: 'TD19', deadline: DAY('2026-12-15'), status: 'CANCELLED', cancelledAt: T.cancelled, cancelReason: 'The supplier is Italian: no self-invoice is needed', ...stamp(T.cancelled) },
    { id: selfInvoiceIds.pending, companyId: companyA, partyId: P3, supplierInvoiceId: foreignSupplierInvoiceId, kind: 'TD17', deadline: DAY('2026-12-15'), ...stamp(T.foreignTyped) },
  ]

  // --- our own copy of FT-2026-00001's delivered send ------------------------------------------------------------------
  const deliveredSend = money.sampleSubmissionIds[1]
  const receiptFileId = lastId('tax:file:FT-2026-00001:RC')
  const sdiReceipt: Prisma.StoredFileCreateManyInput = {
    id: receiptFileId,
    companyId: companyA,
    recordType: 'Invoice',
    recordId: money.sampleInvoiceId,
    kind: 'FISCAL_ARCHIVE',
    originalName: 'FT-2026-00001_RC.xml',
    contentType: 'application/xml',
    sizeBytes: 1024,
    sha256: sha256('FT-2026-00001 RC'),
    storeAccountId: store,
    storageKey: `legal/t/${tenantId}/c/${companyA}/2026/${id('tax:file:rc:key')}`,
    status: 'AVAILABLE',
    availableAt: T.copied,
    visibility: ['OFFICE'],
    retainUntil: TEN_YEARS(T.copied),
    ...stamp(T.copied),
  }
  const archiveCopyId = firstId('tax:sdi-copy:FT-2026-00001:2')
  const copies: Prisma.SdiArchiveCopyCreateManyInput[] = [
    { id: archiveCopyId, companyId: companyA, partyId: P1, invoiceId: money.sampleInvoiceId, submissionId: deliveredSend, key: `sdi:${deliveredSend}`, providerName: 'FAKE', xmlFileId: money.sampleXmlFileId, receiptFileIds: [receiptFileId], copiedAt: T.copied, ...stamp(T.copied) },
  ]

  // --- invoice runs -----------------------------------------------------------------------------------------------------
  const invoiceRunIds = { november: firstId('tax:run:A:2026-11'), october: id('tax:run:A:2026-10') }
  const runs: Prisma.InvoiceRunCreateManyInput[] = [
    { id: invoiceRunIds.november, companyId: companyA, month: DAY('2026-11-01'), partyIds: [P1], ...stamp(AT) },
    { id: invoiceRunIds.october, companyId: companyA, month: DAY('2026-10-01'), partyIds: [P1, P2], status: 'ISSUED', issuedAt: T.octoberIssued, issuedById: actorId, ...stamp(T.octoberRun) },
  ]

  // --- deposit rules on cancellation ------------------------------------------------------------------------------------
  const depositRuleIds = {
    old: firstId('tax:deposit-rule:A:old'),
    acconto: id('tax:deposit-rule:A:acconto:customer'),
    madeToMeasure: id('tax:deposit-rule:A:acconto:customer:mtm'),
    caparra: id('tax:deposit-rule:A:caparra:customer'),
    caparraOurs: id('tax:deposit-rule:A:caparra:company'),
  }
  const rule = (rowId: string, values: Omit<Prisma.DepositCancellationRuleCreateManyInput, 'id' | 'companyId' | 'createdAt' | 'updatedAt' | 'createdById'>): Prisma.DepositCancellationRuleCreateManyInput =>
    ({ id: rowId, companyId: companyA, ...values, ...stamp(AT) })
  const depositRules = [
    rule(depositRuleIds.old, { depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', keepPct: '10.0000', refundRule: 'KEEP_PERCENT', documentKind: 'CREDIT_NOTE', note: 'Old rule, replaced', status: 'ARCHIVED' }),
    rule(depositRuleIds.acconto, { depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: false, keepPct: '0.0000', refundRule: 'REFUND_ALL', documentKind: 'CREDIT_NOTE' }),
    rule(depositRuleIds.madeToMeasure, { depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: true, keepPct: '30.0000', refundRule: 'KEEP_PERCENT', documentKind: 'CREDIT_NOTE', note: 'Made to measure: work started, no withdrawal (D.Lgs. 206/2005 art. 59 lett. c)' }),
    rule(depositRuleIds.caparra, { depositKind: 'CAPARRA', cancelledBy: 'CUSTOMER', keepPct: '100.0000', refundRule: 'KEEP_PERCENT', documentKind: 'NONE' }),
    rule(depositRuleIds.caparraOurs, { depositKind: 'CAPARRA', cancelledBy: 'COMPANY', keepPct: '0.0000', refundRule: 'REFUND_DOUBLE', documentKind: 'NONE', note: 'c.c. art. 1385' }),
  ]

  // --- payment terms with the Italian due-date conventions ---------------------------------------------------------------
  const paymentTermsId = lastId('tax:terms:RIBA60FM-NOAUG')
  const terms: Prisma.PaymentTermsCreateManyInput = {
    id: paymentTermsId,
    code: 'RIBA60FM-NOAUG',
    name: 'Ri.Ba. 60 gg f.m., escluso agosto',
    nameI18n: { en: 'Bank receipt 60 days end of month, August skipped' },
    method: 'MP12',
    instalments: [{ sharePct: '100.0000', from: 'INVOICE', days: 60 }],
    fromEndOfMonth: true,
    skipMonths: [8],
    ...stamp(AT),
  }

  // --- currencies and rates ---------------------------------------------------------------------------------------------
  const currencyIds = { chf: firstId('currency:A:CHF'), eur: id('currency:A:EUR'), usd: id('currency:A:USD'), gbp: id('currency:A:GBP'), bEur: id('currency:B:EUR') }
  const currencies: Prisma.CurrencyCreateManyInput[] = [
    { id: currencyIds.chf, companyId: companyA, code: 'CHF', minorUnits: 2, active: false, ...stamp(AT) },
    { id: currencyIds.eur, companyId: companyA, code: 'EUR', minorUnits: 2, ...stamp(AT) },
    { id: currencyIds.usd, companyId: companyA, code: 'USD', minorUnits: 2, ...stamp(AT) },
    { id: currencyIds.gbp, companyId: companyA, code: 'GBP', minorUnits: 2, ...stamp(AT) },
    { id: currencyIds.bEur, companyId: companyB, code: 'EUR', minorUnits: 2, ...stamp(AT) },
  ]
  const rateIds = { ecbUsd11: firstId('rate:EUR:USD:2026-11-11:ECB'), ecbUsd12: id('rate:EUR:USD:2026-11-12:ECB'), ecbGbp12: id('rate:EUR:GBP:2026-11-12:ECB'), manualUsd12: id('rate:EUR:USD:2026-11-12:MANUAL') }
  const rate = (rowId: string, quote: string, day: string, value: string, source: 'ECB' | 'MANUAL'): Prisma.ExchangeRateCreateManyInput => ({
    id: rowId,
    base: 'EUR',
    quote,
    rateDate: DAY(day),
    rate: value,
    source,
    overriddenById: source === 'MANUAL' ? actorId : null,
    key: `EUR:${quote}:${day}:${source}`,
    ...stamp(new Date(`${day}T16:30:00.000Z`)),
  })
  const rates = [
    rate(rateIds.ecbUsd11, 'USD', '2026-11-11', '1.08470000', 'ECB'),
    rate(rateIds.ecbUsd12, 'USD', '2026-11-12', '1.08520000', 'ECB'),
    rate(rateIds.ecbGbp12, 'GBP', '2026-11-12', '0.86310000', 'ECB'),
    rate(rateIds.manualUsd12, 'USD', '2026-11-12', '1.09000000', 'MANUAL'),
  ]

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.companyEInvoiceSettings.createMany({ data: settings, skipDuplicates: true })
      await tx.taxCode.createMany({ data: taxCodes, skipDuplicates: true })
      await tx.storedFile.createMany({ data: [receiptFile, sdiReceipt], skipDuplicates: true })
      await tx.declarationOfIntent.createMany({ data: declarations, skipDuplicates: true })
      await tx.stampDutyQuarter.createMany({ data: quarters, skipDuplicates: true })
      await tx.supplierInvoice.createMany({ data: [foreignInvoice], skipDuplicates: true })
      await tx.selfInvoice.createMany({ data: selfInvoices, skipDuplicates: true })
      await tx.sdiArchiveCopy.createMany({ data: copies, skipDuplicates: true })
      await tx.invoiceRun.createMany({ data: runs, skipDuplicates: true })
      await tx.depositCancellationRule.createMany({ data: depositRules, skipDuplicates: true })
      await tx.paymentTerms.createMany({ data: [terms], skipDuplicates: true })
      await tx.currency.createMany({ data: currencies, skipDuplicates: true })
      await tx.exchangeRate.createMany({ data: rates, skipDuplicates: true })
    }),
  )

  return {
    companyA,
    companyB,
    tenantId,
    actorId,
    taxCodeIds,
    declarationIds,
    declarationReceiptFileId,
    stampDutyQuarterIds,
    selfInvoiceIds,
    foreignSupplierInvoiceId,
    archiveCopyId,
    receiptFileId,
    invoiceRunIds,
    depositRuleIds,
    paymentTermsId,
    currencyIds,
    rateIds,
  }
}
