import type { Prisma } from '@nexus/factory-db'
import {
  allocationsCheck,
  errorOutcome,
  exportedDocumentsCheck,
  INTEGRITY_CHECK_CODES,
  invoiceTotalsCheck,
  ledgerCheck,
  paymentsPlacedCheck,
  supplierTotalsCheck,
  windowStart,
  type IntegrityCheckCode,
  type IntegrityOutcome,
  type InvoicePaidFacts,
  type PaymentUseFacts,
} from '@nexus/factory-domain/accounting/integrity/checks'
import type { JournalEntry } from '@nexus/factory-domain/accounting/journals/entries'
import { parseManifest } from '@nexus/factory-domain/accounting/manifest'
import { sortPackages, type AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import { monthOfDay, periodOfMonth, type Period } from '@nexus/factory-domain/accounting/periods'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { databaseNow } from '../../../platform/audit/security-events/record'
import { overpaymentsWrittenOff, underpaymentsWrittenOff } from '../../payments/write-offs/sums'
import { documentsOf, readPeriodFacts } from '../facts'
import { journalEntriesOf, roundingOf } from '../journals/entries'
import { fingerprintNow } from '../journals/handed-over'
import { accountingCommand, dateOf, dayOf, type CompanyRow, type Reader } from '../store'

/**
 * One run of a company's named integrity checks (B-W2b-408; FIN-157): nightly through the clustered scheduler
 * (integrity/jobs.ts, the system's context) or now by a person (POST /accounting/integrity/run). The checks read the
 * documents of a window of months (factory-domain integrity/checks.ts: this month and the twelve before), each check on
 * its own so one that cannot run is an ERROR and the others still run; then ONE command keeps a run per check
 * (IntegrityCheckRun, append-only; ranAt = the database's now), flags the documents handed over in an export that
 * changed since (ExportedDocument changedAt + changedFingerprint, once: FIN-154), writes one audit row and the event
 * `integrity_checks.ran` (codes and counts). Nothing is sent anywhere; nothing is corrected by the run.
 */

const JOURNAL_PACKAGES: readonly AccountingPackage[] = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES']
const ISSUED_TYPES = ['TD01', 'TD02', 'TD04', 'TD24'] as const

/** The whole months from the window's first day to today's month. */
export function windowMonths(today: BusinessDate): Period[] {
  const out: Period[] = []
  let month = monthOfDay(windowStart(today))
  const last = monthOfDay(today)
  while (month <= last) {
    out.push(periodOfMonth(month))
    const [year, number] = month.split('-').map(Number) as [number, number]
    month = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`
  }
  return out
}

interface Flag {
  readonly id: string
  readonly recordType: string
  readonly recordId: string
  readonly fingerprint: string
}

interface Readings {
  readonly outcomes: IntegrityOutcome[]
  /** The documents to flag now (their latest handing-over changed since and is not flagged yet). */
  readonly flags: readonly Flag[]
}

const safely = async (code: IntegrityCheckCode, work: () => Promise<IntegrityOutcome> | IntegrityOutcome): Promise<IntegrityOutcome> => {
  try {
    return await work()
  } catch (error) {
    return errorOutcome(code, error instanceof Error ? error.message : String(error))
  }
}

/** Every check's outcome, read as the caller (outside any command). */
export async function readChecks(db: Reader, company: CompanyRow, today: BusinessDate): Promise<Readings> {
  const from = dateOf(windowStart(today))
  const to = dateOf(today)
  const months = windowMonths(today)

  const invoiceTotals = await safely('INVOICE_TOTALS_EQUAL_LINES', async () => {
    const invoices = await db.invoice.findMany({
      where: { companyId: company.id, issueDate: { gte: from, lte: to }, status: { notIn: ['DRAFT', 'REJECTED'] }, docType: { in: [...ISSUED_TYPES] } },
      select: { id: true, number: true, netTotal: true, vatTotal: true, grossTotal: true, stampDutyAmount: true, vatSummary: true },
    })
    const lines = invoices.length > 0 ? await db.invoiceLine.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoices.map((row) => row.id) } }, _sum: { netAmount: true } }) : []
    const sums = new Map(lines.map((row) => [row.invoiceId, row._sum.netAmount ?? 0]))
    return invoiceTotalsCheck(invoices.map((row) => ({ ...row, number: row.number ?? '', linesNet: sums.get(row.id) ?? 0, rounding: roundingOf(row.vatSummary) })))
  })

  const supplierTotals = await safely('SUPPLIER_INVOICE_TOTALS_EQUAL_LINES', async () => {
    const invoices = await db.supplierInvoice.findMany({
      where: { companyId: company.id, receivedOn: { gte: from, lte: to }, status: { not: 'VOIDED' } },
      select: { id: true, netTotal: true, vatTotal: true, grossTotal: true, stampDutyAmount: true, vatSummary: true },
    })
    const lines = invoices.length > 0 ? await db.supplierInvoiceLine.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoices.map((row) => row.id) } }, _sum: { netAmount: true } }) : []
    const sums = new Map(lines.map((row) => [row.invoiceId, row._sum.netAmount ?? 0]))
    return supplierTotalsCheck(invoices.map((row) => ({ ...row, linesNet: sums.has(row.id) ? sums.get(row.id)! : null })))
  })

  // What each payment of the window is used for (allocations net of reversals, live refunds, OVERPAYMENT write-offs).
  const paymentUses = async (): Promise<PaymentUseFacts[]> => {
    const payments = await db.payment.findMany({
      where: { companyId: company.id, receivedOn: { gte: from, lte: to }, status: 'RECEIVED' },
      select: { id: true, amount: true, allocations: { select: { amount: true } }, refunds: { where: { status: { in: ['DUE', 'PAID'] } }, select: { amount: true } } },
    })
    const writtenOff = await overpaymentsWrittenOff(
      db,
      payments.map((row) => row.id),
    )
    return payments.map((row) => ({
      id: row.id,
      amount: row.amount,
      placed: row.allocations.reduce((sum, allocation) => sum + allocation.amount, 0),
      refunded: row.refunds.reduce((sum, refund) => sum + refund.amount, 0),
      writtenOff: writtenOff.get(row.id) ?? 0,
    }))
  }
  let uses: PaymentUseFacts[] | null = null
  const allocations = await safely('ALLOCATIONS_WITHIN_PAYMENTS', async () => {
    uses = await paymentUses()
    const invoices = await db.invoice.findMany({
      where: { companyId: company.id, issueDate: { gte: from, lte: to }, status: { notIn: ['DRAFT', 'REJECTED'] }, docType: { in: ['TD01', 'TD24'] } },
      select: { id: true, grossTotal: true, credits: { where: { status: { notIn: ['DRAFT', 'REJECTED'] } }, select: { grossTotal: true } } },
    })
    const ids = invoices.map((row) => row.id)
    const allocated = ids.length > 0 ? await db.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: ids } }, _sum: { amount: true } }) : []
    const sums = new Map(allocated.map((row) => [row.invoiceId, row._sum.amount ?? 0]))
    const writtenOff = await underpaymentsWrittenOff(db, ids)
    const paid: InvoicePaidFacts[] = invoices.map((row) => ({
      id: row.id,
      payable: row.grossTotal - row.credits.reduce((sum, note) => sum + note.grossTotal, 0),
      allocated: sums.get(row.id) ?? 0,
      writtenOff: writtenOff.get(row.id) ?? 0,
    }))
    return allocationsCheck(uses, paid)
  })
  const placed = await safely('PAYMENTS_PLACED', async () => paymentsPlacedCheck(uses ?? (await paymentUses())))

  // The months' journal entries and, for the months with exported batches, what the packages write of each document now.
  const exports = await db.accountingExport.findMany({
    where: { companyId: company.id, status: 'EXPORTED', periodStart: { gte: from } },
    select: { id: true, periodStart: true, packages: true, manifest: true, exportedAt: true },
  })
  const entries: JournalEntry[] = []
  const hashes = new Map<string, string>()
  let monthsError: string | null = null
  try {
    for (const period of months) {
      const exportedPackages = exports.filter((row) => dayOf(row.periodStart) === period.start).flatMap((row) => row.packages as AccountingPackage[])
      const packages = sortPackages([...new Set([...JOURNAL_PACKAGES, ...exportedPackages])])
      const facts = await readPeriodFacts(db, company, period, packages, { entries: true })
      entries.push(...journalEntriesOf(facts, JOURNAL_PACKAGES))
      if (exportedPackages.length > 0) for (const document of documentsOf(facts, company, packages).documents) hashes.set(`${document.package}|${document.recordType}|${document.recordId}`, document.hash)
    }
  } catch (error) {
    monthsError = error instanceof Error ? error.message : String(error)
  }
  const ledger = monthsError ? errorOutcome('LEDGER_BALANCES', monthsError) : ledgerCheck(entries)

  let flags: Flag[] = []
  const documents = await safely('EXPORTED_DOCUMENTS_UNCHANGED', async () => {
    if (monthsError) throw new Error(monthsError)
    const exportIds = exports.map((row) => row.id)
    const rows = exportIds.length > 0 ? await db.exportedDocument.findMany({ where: { exportId: { in: exportIds } }, select: { id: true, exportId: true, recordType: true, recordId: true, fingerprint: true, changedAt: true } }) : []
    const exportOf = new Map(exports.map((row) => [row.id, row]))
    // Each document's latest handing-over (the batch exported last; the export's time, then its id, as exportedInOrder) is compared.
    const order = (exportId: string) => [exportOf.get(exportId)!.exportedAt?.getTime() ?? 0, exportId] as const
    const later = (a: string, b: string) => order(a)[0] - order(b)[0] || order(a)[1].localeCompare(order(b)[1])
    const latest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      const id = `${row.recordType}|${row.recordId}`
      const found = latest.get(id)
      if (!found || later(row.exportId, found.exportId) > 0) latest.set(id, row)
    }
    const changed: { recordType: string; recordId: string }[] = []
    for (const row of latest.values()) {
      const parts = [...new Set(parseManifest(exportOf.get(row.exportId)!.manifest).filter((entry) => entry.recordType === row.recordType && entry.recordId === row.recordId && entry.change !== 'REMOVED').map((entry) => entry.package))]
      const now = fingerprintNow(parts, hashes, row.recordType, row.recordId)
      if (now === row.fingerprint) continue
      changed.push({ recordType: row.recordType, recordId: row.recordId })
      if (row.changedAt === null) flags.push({ id: row.id, recordType: row.recordType, recordId: row.recordId, fingerprint: now })
    }
    return exportedDocumentsCheck(changed)
  })
  if (documents.result === 'ERROR') flags = []
  const outcomes = [invoiceTotals, supplierTotals, allocations, placed, ledger, documents]
  return { outcomes: INTEGRITY_CHECK_CODES.map((code) => outcomes.find((outcome) => outcome.code === code)!), flags }
}

export interface IntegrityRun {
  readonly ranAt: string
  readonly outcomes: readonly IntegrityOutcome[]
  readonly flagged: number
}

/** Runs the checks of one company and keeps the results (one command). `ranById` null: the nightly run. */
export async function runCompanyChecks(caller: CommandCaller, company: CompanyRow, ranById: string | null, idempotencyKey?: string): Promise<IntegrityRun> {
  const today = businessDate(await caller.withClient((db) => databaseNow(db)))
  const readings = await caller.withClient((db) => readChecks(db, company, today))
  const { result } = await accountingCommand(caller, { name: 'accounting.runIntegrityChecks', idempotencyKey, input: { companyId: company.id, today } }, async (tools) => {
    const ranAt = await databaseNow(tools.tx)
    await tools.tx.integrityCheckRun.createMany({
      data: readings.outcomes.map((outcome) => ({
        id: newId(),
        companyId: company.id,
        checkCode: outcome.code,
        ranAt,
        result: outcome.result,
        failureCount: outcome.failureCount,
        failures: outcome.failures.map((failure) => ({ recordType: failure.recordType, recordId: failure.recordId, code: failure.code })) as unknown as Prisma.InputJsonValue,
        errorWords: outcome.errorWords,
        createdAt: ranAt,
        createdById: ranById,
      })),
    })
    let flagged = 0
    for (const flag of readings.flags) {
      // Once: a row flagged meanwhile (another run) is left as it is.
      const { count } = await tools.tx.exportedDocument.updateMany({ where: { id: flag.id, changedAt: null }, data: { changedAt: ranAt, changedFingerprint: flag.fingerprint } })
      flagged += count
    }
    const failed = readings.outcomes.filter((outcome) => outcome.result !== 'PASSED').map((outcome) => outcome.code)
    tools.audit({
      action: 'accounting.runIntegrityChecks',
      recordType: 'Company',
      recordId: company.id,
      companyId: company.id,
      after: { ranAt: toUtcIso(ranAt), window: { from: windowStart(today), to: today }, results: Object.fromEntries(readings.outcomes.map((outcome) => [outcome.code, outcome.result])), flagged },
    })
    tools.emit({ type: 'integrity_checks.ran', subject: company.id, companyId: company.id, payload: { companyId: company.id, ranAt: toUtcIso(ranAt), checks: readings.outcomes.length, failed, flagged } })
    return { ranAt: toUtcIso(ranAt), flagged }
  })
  return { ranAt: result.ranAt, outcomes: readings.outcomes, flagged: result.flagged }
}
