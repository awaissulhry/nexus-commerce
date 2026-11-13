import { createHash } from 'node:crypto'
import {
  AccountMappingKind,
  BankMatchConfidence,
  BankMatchReason,
  BankStatementFormat,
  ExportedDocumentChange,
  IntegrityCheckResult,
  PaymentMethod,
  ReminderStopReason,
  WriteOffKind,
  WriteOffReason,
} from '../src/generated/prisma/enums'
import type { FactoryClient } from '../src/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAccounting } from './accounting'
import { seed as seedFiles } from './files'
import { seed as seedReceivables } from './receivables'
import { seed as seedSuppliersDepth } from './suppliers-depth'

/**
 * The bank, receivables, payables and accountant's bridge seed (W2b-6, schema wave 50/57, B-W2b-370), per tenant of
 * seed/_core.ts, written in the tenant's office scope as apps/factory-api's modules/payments, receivables, payables and
 * accounting will write it (B-W2b-393, -402, -403, -408). It runs the receivables (and so money), accounting, files and
 * suppliers-depth seeds first (all idempotent).
 *
 *   accounts    company A: its account from the Company bank columns (the migration's copy when the database was migrated
 *               after the companies were made, else made here the same way) and an earlier one, switched off; company B: a
 *               made-up account. Every IBAN here has the bank and branch code 00000 (not a real bank).
 *   statement   company A's camt.053 file of 2 to 13 November: a transfer nobody placed (125.00), P1's 410.00 quoting
 *               FT-2026-00001 (a HIGH suggestion), P1's 400.00 already typed by hand (SEED-TRN-0000002: accepted), P3's test
 *               transfer of 0.50 (recorded and accepted), and 569.13 out to P2 for its invoice 2026/0412 (a MEDIUM
 *               suggestion; the invoice stays as the accounting seed left it).
 *   write-off   0.25 of P3's test transfer kept (OVERPAYMENT) within the tenant-wide tolerance of 1.00, which this seed sets
 *               (the accountant's value is unknown: made up).
 *   Ri.Ba.      a DRAFT batch of company A's account for 16 to 30 November with FT-2026-00001's instalment (410.00 of
 *               610.00, due 27 November); the Ri.Ba. switch stays OFF, so nothing is issued.
 *   stops       FT-2026-00001: a promise to pay by 12 November (over) and a dispute lifted on 4 November: no stop holds, so
 *               its reminder flows as before.
 *   figures     P1's own figures as of 10 November.
 *   proposal    company A's DRAFT payment proposal of the week of 16 November: P2's 2026/0412 to P2's ACTIVE account.
 *   mapping     a made-up chart for company A (item group, tax code, cost category, payment method, party group from
 *               1 January 2026, and the leather group's next account from 1 January 2027); the bridge switch OFF.
 *   export      October's DRAFT export hands over FT-2026-00001 and FT-2026-00003 (NEW).
 *   checks      two passed runs and one failed run (P1's duplicate transfer is not placed).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: the
 * switched-off account (one live account per IBAN), the statement, the unplaced line (its fingerprint is a unique text),
 * the suggestion, a write-off with room left in its payment, a DRAFT batch and its item, the promise that is over, a DRAFT
 * proposal and its line, a mapping, a document of a draft export, a passed run. The rows this seed adds to other modules'
 * tables (the statement's file, P3's payment) start with eight f's, so they never become those tables' first rows. Every
 * name, code and amount is invented; every time is before the day the wave was built. Idempotent: written once, skipped
 * when its first row exists.
 */

const T = {
  oldAccount: new Date('2026-01-10T09:00:00.000Z'),
  accounts: new Date('2026-11-02T08:00:00.000Z'),
  disputeOpened: new Date('2026-11-02T10:00:00.000Z'),
  disputeLifted: new Date('2026-11-04T15:00:00.000Z'),
  promise: new Date('2026-11-05T11:00:00.000Z'),
  testTransfer: new Date('2026-11-09T14:00:00.000Z'),
  figures: new Date('2026-11-10T16:00:00.000Z'),
  checks: new Date('2026-11-12T02:00:00.000Z'),
  imported: new Date('2026-11-13T07:30:00.000Z'),
  matched: new Date('2026-11-13T07:31:00.000Z'),
  accepted: new Date('2026-11-13T08:00:00.000Z'),
  writtenOff: new Date('2026-11-13T08:05:00.000Z'),
  riba: new Date('2026-11-13T08:30:00.000Z'),
  proposal: new Date('2026-11-13T09:00:00.000Z'),
  mapping: new Date('2026-11-13T09:30:00.000Z'),
  exported: new Date('2026-11-13T10:00:00.000Z'),
} as const
const DAY = (text: string): Date => new Date(`${text}T00:00:00.000Z`)
/** Made-up IBANs: country IT, bank and branch code 00000 (no real bank), valid check digits. */
const IBAN = {
  oldA: 'IT81X0000000000000000370001',
  companyB: 'IT54X0000000000000000370002',
  payerP1: 'IT27X0000000000000000370003',
  payerP3: 'IT97X0000000000000000370004',
  payeeP2: 'IT97X0000000000000000370101',
} as const
const WRITE_OFF_TOLERANCE = 100

export interface BankSeed {
  readonly bankAccountIds: { readonly oldA: string; readonly companyA: string; readonly companyB: string }
  readonly statementId: string
  readonly statementFileId: string
  readonly lineIds: { readonly unplaced: string; readonly sample: string; readonly onAccount: string; readonly testTransfer: string; readonly toP2: string }
  readonly matchIds: { readonly sample: string; readonly onAccount: string; readonly testTransfer: string; readonly toP2: string }
  /** P3's test transfer (0.50) and the 0.25 of it written off. */
  readonly testPaymentId: string
  readonly writeOffId: string
  readonly ribaBatchId: string
  readonly ribaItemId: string
  readonly stopIds: { readonly promise: string; readonly dispute: string }
  readonly figuresId: string
  readonly proposalId: string
  readonly proposalLineId: string
  readonly mappingIds: { readonly leather: string; readonly vat22: string; readonly freight: string; readonly transfer: string; readonly customersIt: string; readonly leatherNext: string }
  readonly exportedDocumentIds: { readonly sample: string; readonly deposit: string }
  readonly checkRunIds: { readonly allocations: string; readonly totals: string; readonly placed: string }
  /** What it builds on (the other seeds' ids). */
  readonly sampleInvoiceId: string
  readonly depositInvoiceId: string
  readonly onAccountPaymentId: string
  readonly supplierInvoiceId: string
  readonly supplierBankAccountId: string
  readonly draftExportId: string
}

export async function seed(context: SeedContext): Promise<BankSeed> {
  const { db, namespace } = context
  const receivables = await seedReceivables(context)
  const accounting = await seedAccounting(context)
  const suppliers = await seedSuppliersDepth(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const sha = (text: string): string => createHash('sha256').update(`seed bank ${namespace} ${text}`).digest('hex')
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const P1 = id('party:P1')
  const P2 = id('party:P2')
  const P3 = id('party:P3')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const
  const money = receivables.money

  /** Company A's live account: the migration's copy of its Company bank columns when there is one, else the seed's. */
  const liveAccountOfA = (client: Pick<FactoryClient, 'bankAccount'>, iban: string) =>
    client.bankAccount.findFirst({ where: { companyId: companyA, iban, active: true }, orderBy: { createdAt: 'asc' }, select })
  const ibanOfA = (await db.withScope(office, (client) => client.company.findUniqueOrThrow({ where: { id: companyA }, select: { iban: true } }))).iban
  const copiedA = ibanOfA ? await db.withScope(office, (client) => liveAccountOfA(client, ibanOfA)) : null

  const result: BankSeed = {
    bankAccountIds: { oldA: firstId('bank:account:A:old'), companyA: copiedA?.id ?? id('bank:account:A:main'), companyB: id('bank:account:B:main') },
    statementId: firstId('bank:statement:A:2026-11-13'),
    statementFileId: lateId('bank:statement:A:2026-11-13:file'),
    lineIds: {
      unplaced: firstId('bank:line:unplaced'),
      sample: id('bank:line:FT-2026-00001'),
      onAccount: id('bank:line:SEED-TRN-0000002'),
      testTransfer: id('bank:line:P3:test'),
      toP2: id('bank:line:P2:2026-0412'),
    },
    matchIds: {
      sample: firstId('bank:match:FT-2026-00001'),
      onAccount: id('bank:match:SEED-TRN-0000002'),
      testTransfer: id('bank:match:P3:test'),
      toP2: id('bank:match:P2:2026-0412'),
    },
    testPaymentId: lateId('bank:payment:P3:test'),
    writeOffId: firstId('bank:write-off:P3:test'),
    ribaBatchId: firstId('bank:riba:A:2026-11'),
    ribaItemId: firstId('bank:riba:A:2026-11:FT-2026-00001'),
    stopIds: { promise: firstId('bank:stop:FT-2026-00001:promise'), dispute: id('bank:stop:FT-2026-00001:dispute') },
    figuresId: firstId('bank:figures:P1:2026-11-10'),
    proposalId: firstId('bank:proposal:A:2026-11-16'),
    proposalLineId: firstId('bank:proposal:A:2026-11-16:2026-0412'),
    mappingIds: {
      leather: firstId('bank:mapping:A:ITEM_GROUP:LEATHER:2026'),
      vat22: id('bank:mapping:A:TAX_CODE:22'),
      freight: id('bank:mapping:A:COST_CATEGORY:FREIGHT'),
      transfer: id('bank:mapping:A:PAYMENT_METHOD:BANK_TRANSFER'),
      customersIt: id('bank:mapping:A:PARTY_GROUP:CUSTOMERS_IT'),
      leatherNext: id('bank:mapping:A:ITEM_GROUP:LEATHER:2027'),
    },
    exportedDocumentIds: { sample: firstId('bank:exported:2026-10:FT-2026-00001'), deposit: id('bank:exported:2026-10:FT-2026-00003') },
    checkRunIds: { allocations: firstId('bank:check:A:ALLOCATIONS_WITHIN_PAYMENTS'), totals: id('bank:check:A:INVOICE_TOTALS_EQUAL_LINES'), placed: id('bank:check:A:PAYMENTS_PLACED') },
    sampleInvoiceId: money.sampleInvoiceId,
    depositInvoiceId: money.depositInvoiceId,
    onAccountPaymentId: money.onAccountPaymentId,
    supplierInvoiceId: accounting.supplierInvoiceId,
    supplierBankAccountId: suppliers.bankAccountIds.active,
    draftExportId: accounting.draftExportId,
  }
  const { bankAccountIds: A, lineIds: L, matchIds: M, stopIds: S, mappingIds: AM } = result

  if (await db.withScope(office, (client) => client.bankAccount.findUnique({ where: { id: A.oldA }, select }))) return result

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- the company's own bank accounts (FIN-130) ---------------------------------------------------------------------
      // Company A's first account is its Company bank columns (the migration copied them when the companies existed before
      // it; a fresh database made them after it, so the seed copies them here the same way).
      const bankOfA = await tx.company.findUniqueOrThrow({ where: { id: companyA }, select: { bankAccountHolder: true, iban: true, bic: true, bankName: true } })
      if (!bankOfA.iban || !bankOfA.bankAccountHolder) throw new Error('seed bank: company A has no bank columns (seed/_core.ts)')
      await tx.bankAccount.createMany({
        data: [
          { id: A.oldA, companyId: companyA, holder: 'Seed Company A', iban: IBAN.oldA, bankName: 'Seed example bank (closed)', active: false, ...stamp(T.oldAccount) },
          ...(copiedA ? [] : [{ id: A.companyA, companyId: companyA, holder: bankOfA.bankAccountHolder, iban: bankOfA.iban, bic: bankOfA.bic, bankName: bankOfA.bankName, ...stamp(T.accounts) }]),
          { id: A.companyB, companyId: companyB, holder: 'Seed Company B', iban: IBAN.companyB, bankName: 'Seed example bank', ...stamp(T.accounts) },
        ],
      })
      const accountA = A.companyA

      // --- the statement file and its lines (FIN-130) ----------------------------------------------------------------------
      await tx.storedFile.create({
        data: {
          id: result.statementFileId,
          companyId: companyA,
          recordType: 'BankStatement',
          recordId: result.statementId,
          kind: 'DOCUMENT',
          originalName: 'Seed statement 2026-11-02 to 2026-11-13.xml',
          contentType: 'application/xml',
          sizeBytes: 6144,
          sha256: sha('statement file'),
          storeAccountId: id('files:account:r2'),
          storageKey: `t/${tenantId}/c/${companyA}/2026/${id('bank:statement:A:2026-11-13:key')}`,
          status: 'AVAILABLE',
          availableAt: T.imported,
          visibility: ['OFFICE'],
          ...stamp(T.imported),
        },
        select,
      })
      await tx.bankStatement.create({
        data: { id: result.statementId, companyId: companyA, bankAccountId: accountA, fileId: result.statementFileId, format: BankStatementFormat.CAMT053, periodStart: DAY('2026-11-02'), periodEnd: DAY('2026-11-13'), importedById: actorId, importedAt: T.imported },
        select,
      })
      const line = (lineId: string, bookedOn: string, amount: number, bankReference: string, referenceText: string, counterpartyName: string, counterpartyIban: string | null) => ({
        id: lineId,
        companyId: companyA,
        bankAccountId: accountA,
        statementId: result.statementId,
        bookedOn: DAY(bookedOn),
        valueOn: DAY(bookedOn),
        amount,
        bankReference,
        referenceText,
        counterpartyName,
        counterpartyIban,
        fingerprint: `sha256:${sha(`line ${bankReference} ${bookedOn} ${amount}`)}`,
        createdAt: T.imported,
        createdById: actorId,
      })
      await tx.bankLine.createMany({
        data: [
          line(L.unplaced, '2026-11-03', 12500, 'SEED-BNK-0001', 'Seed: a transfer without a reference', 'Seed Unknown Payer', null),
          line(L.sample, '2026-11-06', 41000, 'SEED-BNK-0002', 'Saldo fattura FT-2026-00001', 'Seed Customer One S.r.l.', IBAN.payerP1),
          line(L.testTransfer, '2026-11-09', 50, 'SEED-BNK-0003', 'Seed: test transfer before the deposit', 'Seed Customer Three GmbH', IBAN.payerP3),
          line(L.onAccount, '2026-11-10', 40000, 'SEED-TRN-0000002', 'Acconto FT-2026-00001', 'Seed Customer One S.r.l.', IBAN.payerP1),
          line(L.toP2, '2026-11-13', -56913, 'SEED-BNK-0005', 'Pagamento fattura 2026/0412', 'Seed Leather Supplier S.p.A.', IBAN.payeeP2),
        ],
      })

      // --- P3's test transfer: recorded (by hand, from the line) and 0.25 of it kept (FIN-119) --------------------------
      await tx.payment.create({
        data: { id: result.testPaymentId, companyId: companyA, partyId: P3, method: PaymentMethod.BANK_TRANSFER, amount: 50, currency: 'EUR', receivedOn: DAY('2026-11-09'), externalRef: 'SEED-BNK-0003', ...stamp(T.testTransfer) },
        select,
      })

      // --- matches (FIN-132, FIN-117): suggestions, then what a person accepted ---------------------------------------------
      await tx.bankMatch.createMany({
        data: [
          { id: M.sample, companyId: companyA, bankLineId: L.sample, partyId: P1, invoiceIds: [money.sampleInvoiceId], confidence: BankMatchConfidence.HIGH, reasons: [BankMatchReason.AMOUNT_EQUAL, BankMatchReason.NUMBER_IN_REFERENCE, BankMatchReason.NAME_MATCHES], ...stamp(T.matched) },
          { id: M.onAccount, companyId: companyA, bankLineId: L.onAccount, partyId: P1, paymentId: money.onAccountPaymentId, confidence: BankMatchConfidence.HIGH, reasons: [BankMatchReason.AMOUNT_EQUAL, BankMatchReason.NAME_MATCHES], ...stamp(T.matched) },
          { id: M.toP2, companyId: companyA, bankLineId: L.toP2, partyId: P2, supplierInvoiceId: accounting.supplierInvoiceId, confidence: BankMatchConfidence.MEDIUM, reasons: [BankMatchReason.AMOUNT_EQUAL, BankMatchReason.NUMBER_IN_REFERENCE], ...stamp(T.matched) },
          // A person's own choice, accepted at once.
          { id: M.testTransfer, companyId: companyA, bankLineId: L.testTransfer, partyId: P3, paymentId: result.testPaymentId, confidence: BankMatchConfidence.LOW, reasons: [BankMatchReason.CHOSEN_BY_PERSON], acceptedAt: T.accepted, acceptedById: actorId, ...stamp(T.accepted) },
        ],
      })
      await tx.bankMatch.update({ where: { id: M.onAccount }, data: { acceptedAt: T.accepted, acceptedById: actorId, version: 2, updatedAt: T.accepted }, select })

      await tx.receivablesSettings.update({ where: { id: receivables.settingsId }, data: { writeOffToleranceAmount: WRITE_OFF_TOLERANCE, version: { increment: 1 }, updatedAt: T.accounts }, select })
      await tx.paymentWriteOff.create({
        data: {
          id: result.writeOffId,
          companyId: companyA,
          partyId: P3,
          paymentId: result.testPaymentId,
          kind: WriteOffKind.OVERPAYMENT,
          amount: 25,
          reason: WriteOffReason.OTHER,
          note: 'Seed: half of the test transfer kept; the other half waits for the deposit.',
          toleranceAmount: WRITE_OFF_TOLERANCE,
          writtenOffById: actorId,
          createdAt: T.writtenOff,
        },
        select,
      })

      // --- Ri.Ba. (FIN-126): a draft only, the switch stays off ------------------------------------------------------------
      await tx.ribaBatch.create({
        data: { id: result.ribaBatchId, companyId: companyA, bankAccountId: accountA, dueFrom: DAY('2026-11-16'), dueTo: DAY('2026-11-30'), note: 'Seed: the second half of November (the Ri.Ba. switch is off).', ...stamp(T.riba) },
        select,
      })
      await tx.ribaItem.create({
        data: { id: result.ribaItemId, companyId: companyA, batchId: result.ribaBatchId, partyId: P1, invoiceId: money.sampleInvoiceId, instalment: 1, dueDate: DAY('2026-11-27'), amount: 41000, ...stamp(T.riba) },
        select,
      })

      // --- reminder stops (FIN-112): none holds today ---------------------------------------------------------------------
      await tx.reminderStop.createMany({
        data: [
          { id: S.promise, companyId: companyA, partyId: P1, invoiceId: money.sampleInvoiceId, reason: ReminderStopReason.PROMISE_TO_PAY, until: DAY('2026-11-12'), note: 'Seed: the customer promised to pay by 12 November.', ...stamp(T.promise) },
          { id: S.dispute, companyId: companyA, partyId: P1, invoiceId: money.sampleInvoiceId, reason: ReminderStopReason.DISPUTE, note: 'Seed: the customer asked about the sample price.', ...stamp(T.disputeOpened) },
        ],
      })
      await tx.reminderStop.update({ where: { id: S.dispute }, data: { liftedAt: T.disputeLifted, liftedById: actorId, liftReason: 'Seed: the price was explained; no dispute.', version: 2, updatedAt: T.disputeLifted }, select })

      // --- the customer's own figures (FIN-135) ----------------------------------------------------------------------------
      await tx.customerStatementFigures.create({
        data: {
          id: result.figuresId,
          companyId: companyA,
          partyId: P1,
          asOf: DAY('2026-11-10'),
          figures: {
            orders: [{ reference: 'Seed order 1 (samples)', amount: 61000 }],
            payments: [{ reference: 'Seed transfer 10/11', date: '2026-11-10', amount: 40000 }],
            balance: 21000,
          },
          note: "Seed: typed from the customer's statement of 10 November.",
          ...stamp(T.figures),
        },
        select,
      })

      // --- the week's payment proposal (FIN-140): a draft --------------------------------------------------------------
      await tx.paymentProposal.create({
        data: { id: result.proposalId, companyId: companyA, weekStart: DAY('2026-11-16'), currency: 'EUR', note: 'Seed: week 47.', createdAt: T.proposal, updatedAt: T.proposal, createdById: actorId },
        select,
      })
      await tx.paymentProposalLine.create({
        data: { id: result.proposalLineId, companyId: companyA, proposalId: result.proposalId, partyId: P2, supplierInvoiceId: accounting.supplierInvoiceId, amount: 56913, supplierBankAccountId: suppliers.bankAccountIds.active, ...stamp(T.proposal) },
        select,
      })

      // --- the accountant's chart (FIN-152): made up; the bridge switch off -------------------------------------------------
      const mapping = (mappingId: string, kind: AccountMappingKind, key: string, accountCode: string, validFrom: string) => ({ id: mappingId, companyId: companyA, kind, key, accountCode, validFrom: DAY(validFrom), ...stamp(T.mapping) })
      await tx.accountMapping.createMany({
        data: [
          mapping(AM.leather, AccountMappingKind.ITEM_GROUP, 'LEATHER', '6101', '2026-01-01'),
          mapping(AM.vat22, AccountMappingKind.TAX_CODE, '22', '2601', '2026-01-01'),
          mapping(AM.freight, AccountMappingKind.COST_CATEGORY, 'FREIGHT', '6205', '2026-01-01'),
          mapping(AM.transfer, AccountMappingKind.PAYMENT_METHOD, 'BANK_TRANSFER', '1801', '2026-01-01'),
          mapping(AM.customersIt, AccountMappingKind.PARTY_GROUP, 'CUSTOMERS_IT', '1201', '2026-01-01'),
          { ...mapping(AM.leatherNext, AccountMappingKind.ITEM_GROUP, 'LEATHER', '6102', '2027-01-01'), note: 'Seed: the new leather account from next year.' },
        ],
      })
      await tx.accountingSettings.create({ data: { id: tenantId, journalsOn: false, ...stamp(T.mapping) }, select })

      // --- what October's draft export hands over (FIN-154) -------------------------------------------------------------
      await tx.exportedDocument.createMany({
        data: [
          { id: result.exportedDocumentIds.sample, companyId: companyA, exportId: accounting.draftExportId, recordType: 'Invoice', recordId: money.sampleInvoiceId, number: 'FT-2026-00001', fingerprint: `sha256:${sha('FT-2026-00001')}`, change: ExportedDocumentChange.NEW, createdAt: T.exported, createdById: actorId },
          { id: result.exportedDocumentIds.deposit, companyId: companyA, exportId: accounting.draftExportId, recordType: 'Invoice', recordId: money.depositInvoiceId, number: 'FT-2026-00003', fingerprint: `sha256:${sha('FT-2026-00003')}`, change: ExportedDocumentChange.NEW, createdAt: T.exported, createdById: actorId },
        ],
      })

      // --- integrity checks (FIN-157): last night's runs (the scheduler: no person) ----------------------------------------
      await tx.integrityCheckRun.createMany({
        data: [
          { id: result.checkRunIds.allocations, companyId: companyA, checkCode: 'ALLOCATIONS_WITHIN_PAYMENTS', ranAt: T.checks, result: IntegrityCheckResult.PASSED, createdAt: T.checks },
          { id: result.checkRunIds.totals, companyId: companyA, checkCode: 'INVOICE_TOTALS_EQUAL_LINES', ranAt: T.checks, result: IntegrityCheckResult.PASSED, createdAt: T.checks },
          {
            id: result.checkRunIds.placed,
            companyId: companyA,
            checkCode: 'PAYMENTS_PLACED',
            ranAt: T.checks,
            result: IntegrityCheckResult.FAILED,
            failureCount: 1,
            failures: [{ recordType: 'Payment', recordId: receivables.overpaymentId, code: 'NOT_PLACED' }],
            createdAt: T.checks,
          },
        ],
      })
    }),
  )

  return result
}
