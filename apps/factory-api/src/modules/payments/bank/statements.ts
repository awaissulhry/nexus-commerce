import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import type { CsvEncoding } from '@nexus/factory-domain/imports/job'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { readCamt053 } from '@nexus/factory-domain/payments/bank-formats/camt053'
import { readOfx } from '@nexus/factory-domain/payments/bank-formats/ofx'
import { readStatementSheet } from '@nexus/factory-domain/payments/bank-formats/sheet'
import { MAX_STATEMENT_LINES, StatementReadError, type BankFormat, type ParsedStatement } from '@nexus/factory-domain/payments/bank-formats/statement'
import { accountFor, formatOfName, importRefusal, IMPORT_REFUSAL_WORDS, planImport, problemView, STATEMENT_FILES, STATEMENT_RETENTION_YEARS, type AccountFacts, type ImportPlan, type ImportRefusal } from '@nexus/factory-domain/payments/bank/import'
import { PAYMENTS_BANK_IMPORT } from '@nexus/factory-domain/payments/bank/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { requestUpload, storeCall } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { readSheet, SheetError } from '../../../platform/imports/sheet'
import { isUniqueViolation } from '../payments'
import { refreshSuggestions } from '../matching/suggest'
import type { Reader } from '../store'
import { bankAccess } from './store'

/**
 * Importing a bank statement (B-W2b-393; FIN-130; design finance.bank pop:import "ImportFlow: file (CAMT.053, CSV, XLSX,
 * OFX) → column mapping → dry run (new, duplicate refused) → Apply"; Owner 11-13: the files the company downloads from its
 * bank, no paid feed):
 *
 *   POST /payments/bank/statements/uploads    the file announced (payments.bank.import, and files.upload): a StoredFile of
 *                                             record BankStatement (its record id = the statement it becomes), kind and
 *                                             type by format, kept ten years; the presigned PUT; then the usual
 *                                             POST /files/:fileId/complete
 *   POST /payments/bank/statements/dry-run    reads the file (the format by its name unless told; a CSV or Excel sheet
 *                                             with the column mapping, the account chosen) and answers every line NEW,
 *                                             DUPLICATE or ERROR with the account, the period and the totals; nothing is
 *                                             written
 *   POST /payments/bank/statements            the same, then ONE command: the BankStatement and its NEW lines (an
 *                                             `expect` of the dry run's count refuses an import that changed since; lines
 *                                             that cannot be read only with skipErrors), the audit row, the event, and
 *                                             the new lines' suggestions
 *
 * Refusals: 409 (400 for a file that cannot be read) with the issue `import/<CODE>` (factory-domain bank/import) or
 * `file/<CODE>` (bank-formats/statement), in words. One advisory lock per account ('factory.bank-import') orders two
 * imports of the same account; the database's unique key (account, fingerprint) is the last word on a duplicate.
 */

export interface StatementUploadBody {
  readonly companyId: string
  readonly originalName: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly format?: BankFormat | undefined
}

const refused = (code: ImportRefusal, status: 'conflict' | 'bad_request' = 'conflict', extra?: string): DomainError =>
  new DomainError(status, extra ? `${IMPORT_REFUSAL_WORDS[code]} ${extra}` : IMPORT_REFUSAL_WORDS[code], [{ path: `import/${code}`, message: IMPORT_REFUSAL_WORDS[code] }])

const addYears = (at: Date, years: number): Date => {
  const next = new Date(at.getTime())
  next.setUTCFullYear(next.getUTCFullYear() + years)
  return next
}

/** POST /payments/bank/statements/uploads: the statement file announced, and where to PUT its bytes. */
export async function announceStatement(caller: CommandCaller, body: StatementUploadBody, idempotencyKey?: string) {
  bankAccess(caller, body.companyId, PAYMENTS_BANK_IMPORT)
  const format = body.format ?? formatOfName(body.originalName)
  if (!format) throw refused('FORMAT_UNKNOWN', 'bad_request')
  const file = STATEMENT_FILES[format]
  const statementId = newId()
  const announced = await requestUpload(
    processFiles(),
    caller,
    {
      companyId: body.companyId,
      recordType: 'BankStatement',
      recordId: statementId,
      kind: file.kind,
      originalName: body.originalName,
      contentType: file.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      // A fiscal archive file is kept ten years by itself; the others are given the same date (an accounting record).
      retainUntil: file.kind === 'FISCAL_ARCHIVE' ? null : addYears(serverClock.now(), STATEMENT_RETENTION_YEARS).toISOString(),
    },
    idempotencyKey,
  )
  return { statementId, format, file: announced.file, upload: announced.upload }
}

export interface StatementReadBody {
  readonly fileId: string
  readonly format?: BankFormat | undefined
  /** The company's account it is for: needed for a CSV or Excel sheet (they name none), checked against a file that names one. */
  readonly bankAccountId?: string | null | undefined
  /** A CSV or Excel sheet: header → column (bookedOn, valueOn, amount, moneyIn, moneyOut, currency, bankReference, referenceText, counterpartyName, counterpartyIban), or null to leave it out. */
  readonly mapping?: Readonly<Record<string, string | null>> | undefined
  readonly numberFormat?: NumberFormat | undefined
  readonly sheetName?: string | null | undefined
  readonly encoding?: CsvEncoding | null | undefined
}

export interface StatementImportBody extends StatementReadBody {
  /** Import without the lines that cannot be read (the dry run lists them). */
  readonly skipErrors?: boolean | undefined
  /** The dry run's count of new lines: a different count now refuses the import (another import took some). */
  readonly expectNew?: number | undefined
}

interface ReadStatement {
  readonly companyId: string
  readonly statementId: string
  readonly file: { readonly id: string; readonly originalName: string }
  readonly format: BankFormat
  /** Null while a sheet's mapping is incomplete (`mapping.issues`). */
  readonly statement: ParsedStatement | null
  readonly account: AccountFacts
  readonly mapping: { readonly headers: readonly string[]; readonly columns: readonly { index: number; header: string; column: string }[]; readonly ignored: readonly { index: number; header: string; reason: string }[]; readonly issues: readonly { path: string; message: string }[] } | null
  readonly sheet: { readonly name: string | null; readonly names: readonly string[]; readonly encoding: string | null; readonly delimiter: string | null } | null
}

const MAX_FILE_BYTES = 10 * 1_048_576

/** The statement file, read and parsed for its account (outside any transaction): every refusal in words. */
async function readStatement(caller: CommandCaller, body: StatementReadBody, today: BusinessDate): Promise<ReadStatement> {
  const row = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, companyId: true, recordType: true, recordId: true, status: true, originalName: true, contentType: true, sizeBytes: true, storeAccountId: true, storageKey: true } }))
  if (!row || row.companyId === null) throw new NotFoundError('File not found.')
  bankAccess(caller, row.companyId, PAYMENTS_BANK_IMPORT)
  if (row.recordType !== 'BankStatement') throw refused('NOT_A_STATEMENT_FILE')
  if (row.status !== 'AVAILABLE') throw refused('FILE_NOT_READY')
  const companyId = row.companyId
  const used = await caller.withClient((client) => client.bankStatement.findFirst({ where: { OR: [{ fileId: row.id }, { id: row.recordId }] }, select: { id: true } }))
  if (used) throw refused('FILE_USED')
  const format = body.format ?? formatOfName(row.originalName)
  if (!format) throw refused('FORMAT_UNKNOWN', 'bad_request')
  const accounts: AccountFacts[] = await caller.withClient((client) => client.bankAccount.findMany({ where: { companyId }, select: { id: true, iban: true, currency: true, active: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  if (row.sizeBytes > MAX_FILE_BYTES) throw new DomainError('bad_request', 'The file is larger than 10 MiB; download a shorter period.', [{ path: 'file/TOO_MANY_LINES', message: 'Too large.' }])
  const bytes = await storeCall(() => processFiles().storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes))
  if (!bytes) throw refused('FILE_NOT_READY')

  let statement: ParsedStatement | null
  let mapping: ReadStatement['mapping'] = null
  let sheet: ReadStatement['sheet'] = null
  let account: AccountFacts
  try {
    if (format === 'CSV' || format === 'XLSX') {
      // A sheet names no account: the person's choice gives the currency its rows are read in.
      const chosen = accountFor({ iban: null, currency: null }, accounts, body.bankAccountId ?? null)
      if ('refusal' in chosen) throw refused(chosen.refusal)
      account = chosen.account
      let read: Awaited<ReturnType<typeof readSheet>>
      try {
        read = await readSheet(bytes, { contentType: STATEMENT_FILES[format].contentType, sheetName: body.sheetName ?? null, encoding: body.encoding ?? null, maxRows: MAX_STATEMENT_LINES })
      } catch (error) {
        if (error instanceof SheetError) throw new DomainError('bad_request', `We could not read this sheet: ${error.message}`, error.issues.map((issue) => ({ path: `file/${issue.path}`, message: issue.message })))
        throw error
      }
      const sheetRead = readStatementSheet({ format, headers: read.headers, rows: read.rows }, { overrides: body.mapping ?? {}, numberFormat: body.numberFormat ?? 'it', accountCurrency: account.currency, today })
      statement = sheetRead.statement
      mapping = { headers: read.headers, columns: sheetRead.mapping.columns, ignored: sheetRead.mapping.ignored, issues: sheetRead.mapping.issues }
      sheet = { name: read.sheet, names: read.sheets, encoding: read.encoding, delimiter: read.delimiter }
    } else {
      const text = bytes.toString('utf8')
      statement = format === 'CAMT053' ? readCamt053(text, today) : readOfx(text, today)
      const chosen = accountFor(statement, accounts, body.bankAccountId ?? null)
      if ('refusal' in chosen) throw refused(chosen.refusal)
      account = chosen.account
    }
  } catch (error) {
    if (error instanceof StatementReadError) throw new DomainError('bad_request', error.message, [{ path: `file/${error.code}`, message: error.message }])
    throw error
  }
  return { companyId, statementId: row.recordId, file: { id: row.id, originalName: row.originalName }, format, statement, account, mapping, sheet }
}

/** The fingerprints the account has among these. */
async function knownPrints(db: Reader, bankAccountId: string, prints: readonly string[]): Promise<Set<string>> {
  if (prints.length === 0) return new Set()
  const rows = await db.bankLine.findMany({ where: { bankAccountId, fingerprint: { in: [...prints] } }, select: { fingerprint: true } })
  return new Set(rows.map((row) => row.fingerprint))
}

const NO_PLAN: ImportPlan = { lines: [], counts: { NEW: 0, DUPLICATE: 0, ERROR: 0 }, totals: { moneyIn: 0, moneyOut: 0 }, period: null }

/** The answer of a dry run (and of an import, for what it wrote). */
function planView(read: ReadStatement, plan: ImportPlan) {
  return {
    fileId: read.file.id,
    statementId: read.statementId,
    companyId: read.companyId,
    format: read.format,
    account: { id: read.account.id, iban: read.account.iban, currency: read.account.currency },
    fileIban: read.statement?.iban ?? null,
    /** False while the sheet's mapping is incomplete (map the columns `mapping.issues` names, then run it again). */
    ready: read.statement !== null,
    period: plan.period,
    counts: { new: plan.counts.NEW, duplicate: plan.counts.DUPLICATE, error: plan.counts.ERROR },
    totals: { moneyIn: asMoney('price', plan.totals.moneyIn), moneyOut: asMoney('price', plan.totals.moneyOut) },
    mapping: read.mapping ? { headers: [...read.mapping.headers], columns: read.mapping.columns.map((entry) => ({ ...entry })), ignored: read.mapping.ignored.map((entry) => ({ ...entry })), issues: read.mapping.issues.map((entry) => ({ ...entry })) } : null,
    sheet: read.sheet ? { ...read.sheet, names: [...read.sheet.names] } : null,
    lines: plan.lines.map((line) => ({
      row: line.row,
      verdict: line.verdict,
      bookedOn: line.bookedOn,
      valueOn: line.valueOn,
      amount: asMoney('price', line.amount),
      currency: line.currency,
      bankReference: line.bankReference,
      referenceText: line.referenceText,
      counterpartyName: line.counterpartyName,
      counterpartyIban: line.counterpartyIban,
      problems: line.problems.map(problemView),
    })),
  }
}

/** POST /payments/bank/statements/dry-run: what an import of this file would do; nothing is written. */
export async function dryRunStatement(caller: CommandCaller, body: StatementReadBody) {
  const today = businessDate(serverClock.now())
  const read = await readStatement(caller, body, today)
  if (!read.statement) return planView(read, NO_PLAN)
  const statement = read.statement
  const prints = planImport(statement, read.account.id, new Set(), today).lines.map((line) => line.fingerprint)
  const plan = planImport(statement, read.account.id, await caller.withClient((client) => knownPrints(client, read.account.id, prints)), today)
  return planView(read, plan)
}

/** POST /payments/bank/statements: imports the file's new lines as one statement, in one command. */
export async function importStatement(caller: CommandCaller, body: StatementImportBody, idempotencyKey?: string) {
  const today = businessDate(serverClock.now())
  const read = await readStatement(caller, body, today)
  if (!read.statement) throw refused('MAPPING_INCOMPLETE')
  const statement = read.statement
  const actorId = bankAccess(caller, read.companyId, PAYMENTS_BANK_IMPORT).actorId
  const prints = planImport(statement, read.account.id, new Set(), today).lines.map((line) => line.fingerprint)
  try {
    const { result } = await command(caller, { name: 'payments.bank.import', idempotencyKey, input: body }, async (tools) => {
      const { tx, context } = tools
      if (context.audience === 'platform') throw new NotFoundError('Company not found.')
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bank-import'::text, ${context.tenantId}::uuid, ${read.account.id}::uuid), 0))`
      const plan = planImport(statement, read.account.id, await knownPrints(tx, read.account.id, prints), today)
      const refusal = importRefusal(plan, { skipErrors: body.skipErrors === true })
      if (refusal) throw refused(refusal)
      if (body.expectNew !== undefined && body.expectNew !== plan.counts.NEW) throw refused('CHANGED_SINCE_DRY_RUN', 'conflict', `The dry run found ${body.expectNew} new lines; now ${plan.counts.NEW}.`)
      const period = plan.period!
      await tx.bankStatement.create({
        data: { id: read.statementId, companyId: read.companyId, bankAccountId: read.account.id, fileId: read.file.id, format: read.format, periodStart: new Date(`${period.start}T00:00:00.000Z`), periodEnd: new Date(`${period.end}T00:00:00.000Z`), importedById: actorId, importedAt: tools.now },
        select: { id: true },
      })
      const fresh = plan.lines.filter((line) => line.verdict === 'NEW')
      const lineIds = fresh.map(() => newId())
      await tx.bankLine.createMany({
        data: fresh.map((line, index) => ({
          id: lineIds[index]!,
          companyId: read.companyId,
          bankAccountId: read.account.id,
          statementId: read.statementId,
          bookedOn: new Date(`${line.bookedOn}T00:00:00.000Z`),
          valueOn: line.valueOn ? new Date(`${line.valueOn}T00:00:00.000Z`) : null,
          amount: line.amount!,
          currency: read.account.currency,
          bankReference: line.bankReference,
          referenceText: line.referenceText,
          counterpartyName: line.counterpartyName,
          counterpartyIban: line.counterpartyIban,
          fingerprint: line.fingerprint,
          createdAt: tools.now,
          createdById: actorId,
        })),
      })
      tools.audit({
        action: 'payments.bank.import',
        recordType: 'BankStatement',
        recordId: read.statementId,
        companyId: read.companyId,
        after: { bankAccountId: read.account.id, fileId: read.file.id, format: read.format, periodStart: period.start, periodEnd: period.end, lines: fresh.length, duplicates: plan.counts.DUPLICATE, skipped: plan.counts.ERROR, moneyIn: markMoney('price', plan.totals.moneyIn), moneyOut: markMoney('price', plan.totals.moneyOut) },
      })
      tools.emit({ type: 'bank_statement.imported', subject: read.statementId, companyId: read.companyId, payload: { statementId: read.statementId, bankAccountId: read.account.id, format: read.format, lines: fresh.length, duplicates: plan.counts.DUPLICATE, skipped: plan.counts.ERROR } })
      const suggested = await refreshSuggestions(tools, read.companyId, lineIds)
      return { ...planView(read, plan), lineIds, suggested: suggested.length }
    })
    return result
  } catch (error) {
    // The same line imported meanwhile by another import (the unique key), or the statement id taken: in words.
    if (isUniqueViolation(error)) throw refused('CHANGED_SINCE_DRY_RUN')
    throw error
  }
}
