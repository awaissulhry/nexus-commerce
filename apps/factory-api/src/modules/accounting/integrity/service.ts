import { INTEGRITY_CHECK_CODES, INTEGRITY_FAILURE_CODES, INTEGRITY_TITLES, integrityWords, windowStart, type IntegrityCheckCode, type IntegrityFailureCode, type IntegrityResult } from '@nexus/factory-domain/accounting/integrity/checks'
import type { IntegrityAnswer } from '@nexus/factory-domain/accounting/integrity/contracts'
import { ACCOUNTING_EXPORT, ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/permissions'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { databaseNow } from '../../../platform/audit/security-events/record'
import { companyFor, companyRef, officeOf, peopleNames, type CompanyRow, type Reader } from '../store'
import { runCompanyChecks } from './run'

/**
 * The integrity checks of a company on screen (B-W2b-408; FIN-157; design finance.accounting "2 · Checks", failures red):
 *
 *   GET  /accounting/integrity?companyId     each named check as its last run left it (result, the records that fail
 *                                            it with their numbers, who ran it: null = the nightly run) and the runs
 *                                            before; the month's export reads the same (periodWorkspace)
 *   POST /accounting/integrity/run           the checks run now (accounting.export), kept as the nightly run keeps them
 */

const HISTORY = 6

type RunRow = { id: string; checkCode: string; ranAt: Date; result: string; failureCount: number; failures: unknown; errorWords: string | null; createdById: string | null }

/** The latest runs of each check of a company (the newest first), at most `per` each. */
export async function latestRuns(db: Reader, companyId: string, per = 1): Promise<Map<IntegrityCheckCode, RunRow[]>> {
  const out = new Map<IntegrityCheckCode, RunRow[]>()
  for (const code of INTEGRITY_CHECK_CODES) {
    const rows = await db.integrityCheckRun.findMany({
      where: { companyId, checkCode: code },
      select: { id: true, checkCode: true, ranAt: true, result: true, failureCount: true, failures: true, errorWords: true, createdById: true },
      orderBy: [{ ranAt: 'desc' }, { id: 'desc' }],
      take: per,
    })
    if (rows.length > 0) out.set(code, rows)
  }
  return out
}

const failuresOf = (value: unknown): { recordType: string; recordId: string; code: IntegrityFailureCode | null }[] =>
  Array.isArray(value)
    ? value.flatMap((raw) => {
        if (raw === null || typeof raw !== 'object') return []
        const entry = raw as Record<string, unknown>
        if (typeof entry.recordType !== 'string' || typeof entry.recordId !== 'string') return []
        const code = typeof entry.code === 'string' && (INTEGRITY_FAILURE_CODES as readonly string[]).includes(entry.code) ? (entry.code as IntegrityFailureCode) : null
        return [{ recordType: entry.recordType, recordId: entry.recordId, code }]
      })
    : []

/** The numbers of the records the failures name (invoices, supplier invoices, payments, the cost bridge's figures). */
async function numbersOf(db: Reader, failures: readonly { recordType: string; recordId: string }[]): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(failures.filter((failure) => failure.recordType === type).map((failure) => failure.recordId))]
  const out = new Map<string, string>()
  const put = (type: string, rows: readonly { id: string; number: string | null }[]) => {
    for (const row of rows) if (row.number) out.set(`${type}|${row.id}`, row.number)
  }
  const invoices = ids('Invoice')
  if (invoices.length > 0) put('Invoice', await db.invoice.findMany({ where: { id: { in: invoices } }, select: { id: true, number: true } }))
  const supplier = ids('SupplierInvoice')
  if (supplier.length > 0) put('SupplierInvoice', await db.supplierInvoice.findMany({ where: { id: { in: supplier } }, select: { id: true, number: true } }))
  const payments = ids('Payment')
  if (payments.length > 0) put('Payment', (await db.payment.findMany({ where: { id: { in: payments } }, select: { id: true, externalRef: true } })).map((row) => ({ id: row.id, number: row.externalRef })))
  const refunds = ids('Refund')
  if (refunds.length > 0) put('Refund', (await db.refund.findMany({ where: { id: { in: refunds } }, select: { id: true, externalRef: true } })).map((row) => ({ id: row.id, number: row.externalRef })))
  return out
}

async function answerOf(db: Reader, caller: CommandCaller, company: CompanyRow): Promise<IntegrityAnswer> {
  const context = officeOf(caller)
  const runs = await latestRuns(db, company.id, HISTORY + 1)
  const today = businessDate(await databaseNow(db))
  const all = [...runs.values()].flatMap((rows) => failuresOf(rows[0]!.failures))
  const [numbers, names] = await Promise.all([numbersOf(db, all), peopleNames(db, [...runs.values()].map((rows) => rows[0]!.createdById))])
  const checks = INTEGRITY_CHECK_CODES.map((code) => {
    const rows = runs.get(code) ?? []
    const last = rows[0] ?? null
    const result = (last?.result ?? null) as IntegrityResult | null
    return {
      code,
      title: INTEGRITY_TITLES[code].en,
      result,
      ranAt: last ? toUtcIso(last.ranAt) : null,
      ranBy: last?.createdById ? { id: last.createdById, name: names.get(last.createdById) ?? null } : null,
      failureCount: last?.failureCount ?? 0,
      failures: last ? failuresOf(last.failures).map((failure) => ({ ...failure, number: numbers.get(`${failure.recordType}|${failure.recordId}`) ?? null })) : [],
      errorWords: last?.errorWords ?? null,
      words: last ? integrityWords({ code, result: result!, failureCount: last.failureCount, errorWords: last.errorWords }) : `${INTEGRITY_TITLES[code].en}: not run yet.`,
      history: rows.slice(1).map((row) => ({ ranAt: toUtcIso(row.ranAt), result: row.result as IntegrityResult, failureCount: row.failureCount })),
    }
  })
  const lastRun = checks.map((check) => check.ranAt).filter((at): at is string => at !== null).sort().at(-1) ?? null
  const failing = checks.filter((check) => check.result !== null && check.result !== 'PASSED').length
  return {
    company: companyRef(company),
    window: { from: windowStart(today), to: today },
    lastRunAt: lastRun,
    failing,
    checks,
    can: { run: can(actorOf(context), ACCOUNTING_EXPORT, { companyId: company.id }) },
    words: lastRun
      ? `${failing === 0 ? 'Every check passed' : `${failing} check(s) failed`} when they last ran (every night, and when a person runs them). They read the documents of this month and the twelve before.`
      : 'The checks have not run for this company yet: they run every night, or run them now.',
  }
}

/** GET /accounting/integrity: the company's checks as their last run left them. */
export async function integrityOf(caller: CommandCaller, companyId: string): Promise<IntegrityAnswer> {
  const company = await companyFor(caller, companyId, ACCOUNTING_VIEW)
  return caller.withClient((db) => answerOf(db, caller, company))
}

/** POST /accounting/integrity/run: the checks run now by the caller. */
export async function runIntegrityNow(caller: CommandCaller, companyId: string, idempotencyKey?: string): Promise<IntegrityAnswer> {
  const context = officeOf(caller)
  const company = await companyFor(caller, companyId, ACCOUNTING_EXPORT)
  await runCompanyChecks(caller, company, context.actorId, idempotencyKey)
  return caller.withClient((db) => answerOf(db, caller, company))
}
