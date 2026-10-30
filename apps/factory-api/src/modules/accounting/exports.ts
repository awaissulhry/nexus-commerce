import type { Prisma } from '@nexus/factory-db'
import { CHECK_TITLES, explanationProblems, parseStoredChecks, storedChecks, type CheckResult } from '@nexus/factory-domain/accounting/checks'
import type { CancelExportBody, CreateExportBody, ExportRecordView, ExportRowView, ExportsQuery } from '@nexus/factory-domain/accounting/contracts'
import { canonicalJson, differenceOf, heldDocuments, parseManifest, type Difference, type ManifestEntry } from '@nexus/factory-domain/accounting/manifest'
import { DEFAULT_LAYOUT, LAYOUT_WORDS, PACKAGE_RULES, packageProblems, sortPackages, type AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import { ACCOUNTING_EXPORT, ACCOUNTING_LOCK, ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/permissions'
import { isYearEndPeriod, monthLabel, periodOfDays, periodOfMonth, type Period } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { downloadFile, prepareFileCopy, putGeneratedFile, recordGeneratedFile, systemCallerOf, type PreparedGeneratedFile } from '../../platform/files/files'
import { addYears, FISCAL_RETENTION_YEARS } from '../../platform/files/rules'
import { processFiles } from '../../platform/files/service'
import { allocateNumber } from '../../platform/numbering/allocate'
import type { FastifyRequest } from 'fastify'
import { checksOf, documentsOf, readPeriodFacts, type PeriodFacts } from './facts'
import { planFiles, type PlannedFile } from './files'
import {
  accountingClock,
  accountingCommand,
  companyFor,
  companyRef,
  dateOf,
  dayOf,
  EXPORT_SELECT,
  exportedInOrder,
  grainsOf,
  liveLocksOver,
  lockPeriodExports,
  officeOf,
  peopleNames,
  periodExports,
  type CompanyRow,
  type ExportRow,
  type Reader,
} from './store'

/**
 * Numbered accounting exports (B-W2a-39; FIN-046, LOG-098, LOG-100; design finance.accounting "Exports", "5 · Export
 * and lock"). Making one is three steps, so the files are stored before the batch is numbered and a number is never
 * given to a batch without its files (the database refuses an EXPORTED batch without one):
 *
 *   1. read the month as the caller (facts.ts), check the packages, the grains, the explanations of the failing checks
 *      and what changed since the batches before (a first export of the month; or a re-export naming the latest batch,
 *      carrying only the changes, refused when nothing changed); then ONE command makes the DRAFT (its checks and its
 *      manifest: the documents it carries) under the period's advisory lock, cancelling an older draft of the month;
 *   2. the files are rendered and put in the tenant's file store (CSV in the DEFAULT layout; the year-end pack's
 *      signed-off valued lists copied), outside any transaction;
 *   3. ONE command on the draft (its version: a cancel in between wins) reads the month again and refuses when anything
 *      it carries changed meanwhile, records the files (StoredFiles of the export: PDFs FISCAL_ARCHIVE, CSV and XLSX
 *      DOCUMENT, each kept ten years, c.c. art. 2220) and their AccountingExportFile rows, takes the number from the
 *      company's ACCOUNTING_EXPORT series (allocateNumber) and moves the batch to EXPORTED.
 *
 * A failure after step 1 leaves the DRAFT in the history (the next export of the month replaces it, or a person
 * cancels it); a repeat with the same Idempotency-Key finishes it. Nothing is sent to the accountant or any authority.
 */

const TEN_YEARS = FISCAL_RETENTION_YEARS

export class AccountingRefusedError extends InvalidStateError {
  override name = 'AccountingRefusedError'
  override readonly issues: readonly Issue[]
  constructor(message: string, problems: readonly { readonly code: string; readonly message: string }[]) {
    super(`${message} ${problems.map((problem) => problem.message).join(' ')}`.trim())
    this.issues = problems.map((problem) => ({ path: `problem/${problem.code}`, message: problem.message }))
  }
}
export const refuse = (message: string, code: string, detail: string): AccountingRefusedError => new AccountingRefusedError(message, [{ code, message: detail }])

export const periodView = (period: Period) => ({ month: period.month, start: period.start, end: period.end, label: monthLabel(period.month, 'en'), labelIt: monthLabel(period.month, 'it') })
const periodOfRow = (row: { readonly periodStart: Date; readonly periodEnd: Date }): Period => periodOfDays(dayOf(row.periodStart), dayOf(row.periodEnd)) ?? { month: dayOf(row.periodStart).slice(0, 7), start: dayOf(row.periodStart), end: dayOf(row.periodEnd) }
const exportRef = (row: { readonly id: string; readonly number: string | null; readonly status: string }) => ({ id: row.id, number: row.number, status: row.status as 'DRAFT' | 'EXPORTED' | 'CANCELLED' })

/** The manifest of an export read back (the seeds' older entries name no package: an invoice is the sales journal's). */
const manifestOf = (row: Pick<ExportRow, 'manifest' | 'packages'>): ManifestEntry[] => parseManifest(row.manifest, row.packages.includes('SALES_JOURNAL') ? 'SALES_JOURNAL' : null)

/** What the accountant holds of the period now, and what the month's documents are against it. */
export interface PeriodState {
  readonly rows: readonly ExportRow[]
  readonly exported: readonly ExportRow[]
  readonly latest: ExportRow | null
  readonly held: ReadonlyMap<string, ManifestEntry>
}

export function periodState(rows: readonly ExportRow[]): PeriodState {
  const exported = exportedInOrder(rows)
  return { rows, exported, latest: exported.at(-1) ?? null, held: heldDocuments(exported.map(manifestOf)) }
}

/** The documents changed since the period's latest batch, for the packages its batches carried. */
async function changedSince(db: Reader, company: CompanyRow, period: Period, state: PeriodState): Promise<Difference | null> {
  if (!state.latest) return null
  const packages = sortPackages([...new Set(state.exported.flatMap((row) => row.packages as AccountingPackage[]))].filter((pkg) => PACKAGE_RULES[pkg].wave === 'W2a'))
  if (packages.length === 0) return null
  const facts = await readPeriodFacts(db, company, period, packages)
  return differenceOf(state.held, documentsOf(facts, company, packages).documents, packages)
}

// ---- views ---------------------------------------------------------------------------------------------------------------

function rowView(row: ExportRow, names: ReadonlyMap<string, string>, extra: { readonly supersedes: ExportRow | null; readonly supersededBy: ExportRow | null; readonly changed: Difference | null }): ExportRowView {
  const manifest = manifestOf(row)
  const contents = (row.packages as AccountingPackage[]).map((pkg) => {
    const mine = manifest.filter((entry) => entry.package === pkg)
    return { package: pkg, new: mine.filter((entry) => entry.change === 'NEW').length, changed: mine.filter((entry) => entry.change === 'CHANGED').length, removed: mine.filter((entry) => entry.change === 'REMOVED').length }
  })
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null)
  return {
    id: row.id,
    number: row.number,
    company: companyRef(row.company),
    period: periodView(periodOfRow(row)),
    packages: row.packages as AccountingPackage[],
    status: row.status,
    layout: row.layout,
    supersedes: extra.supersedes ? exportRef(extra.supersedes) : null,
    supersededBy: extra.supersededBy ? exportRef(extra.supersededBy) : null,
    files: row.files.map((file) => ({
      id: file.id,
      seq: file.seq,
      package: file.package,
      format: file.format,
      rowCount: file.rowCount,
      file: { id: file.file.id, name: file.file.originalName, contentType: file.file.contentType, sizeBytes: file.file.sizeBytes, sha256: file.file.sha256 },
    })),
    contents,
    madeBy: person(row.createdById),
    createdAt: toUtcIso(row.createdAt),
    exportedAt: row.exportedAt ? toUtcIso(row.exportedAt) : null,
    exportedBy: person(row.exportedById),
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    note: row.note,
    changedSince: extra.changed ? { count: extra.changed.changes, packages: [...extra.changed.packages] } : null,
    version: row.version,
  }
}

async function viewsOf(db: Reader, rows: readonly ExportRow[]): Promise<ExportRowView[]> {
  const names = await peopleNames(db, rows.flatMap((row) => [row.createdById, row.exportedById]))
  const periods = new Map<string, { company: CompanyRow; period: Period }>()
  for (const row of rows) periods.set(`${row.companyId}|${dayOf(row.periodStart)}`, { company: row.company, period: periodOfRow(row) })
  const states = new Map<string, { state: PeriodState; changed: Difference | null }>()
  for (const [key, { company, period }] of periods) {
    const state = periodState(await periodExports(db, company.id, period))
    states.set(key, { state, changed: await changedSince(db, company, period, state) })
  }
  return rows.map((row) => {
    const { state, changed } = states.get(`${row.companyId}|${dayOf(row.periodStart)}`)!
    const supersedes = row.supersedesId ? (state.rows.find((other) => other.id === row.supersedesId) ?? null) : null
    const supersededBy = state.rows.find((other) => other.supersedesId === row.id && other.status === 'EXPORTED') ?? null
    return rowView(row, names, { supersedes, supersededBy, changed: row.status === 'EXPORTED' && state.latest?.id === row.id ? changed : null })
  })
}

/** GET /accounting/exports: the batches of the companies the caller may see, newest period first. */
export async function listExports(caller: CommandCaller, query: ExportsQuery) {
  const context = officeOf(caller)
  const where: Prisma.AccountingExportWhereInput = {
    AND: [
      scopeWhere(actorOf(context), ACCOUNTING_VIEW, { company: 'companyId' }) as Prisma.AccountingExportWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.status ? { status: query.status } : {},
      query.year ? { periodStart: { gte: dateOf(`${query.year}-01-01`), lte: dateOf(`${query.year}-12-31`) } } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.accountingExport.findMany({
      where,
      select: EXPORT_SELECT,
      orderBy: [{ periodStart: 'desc' }, { exportedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, query.limit)
    return { rows: await viewsOf(db, page), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

async function visibleExport(caller: CommandCaller, exportId: string): Promise<ExportRow> {
  const context = officeOf(caller)
  if (!isUuid(exportId)) throw new NotFoundError('Accounting export not found.')
  const row = await caller.withClient((db) => db.accountingExport.findUnique({ where: { id: exportId }, select: EXPORT_SELECT }))
  if (!row || !can(actorOf(context), ACCOUNTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Accounting export not found.')
  return row
}

const held = (allowed: boolean, reason: string | null) => ({ allowed, reason: allowed ? null : reason })

/** GET /accounting/exports/:id: one batch with its checks, manifest, files, lock and what the caller may do. */
export async function exportRecord(caller: CommandCaller, exportId: string): Promise<ExportRecordView> {
  const context = officeOf(caller)
  const row = await visibleExport(caller, exportId)
  const actor = actorOf(context)
  const grains = grainsOf(context)
  return caller.withClient(async (db) => {
    const [view] = await viewsOf(db, [row])
    const period = periodOfRow(row)
    const locks = await liveLocksOver(db, row.companyId, period)
    const lock = locks.find((entry) => entry.exportId === row.id) ?? locks[0] ?? null
    const lacking = (row.packages as AccountingPackage[]).filter((pkg) => !grains.has(PACKAGE_RULES[pkg].grain))
    const mayExport = can(actor, ACCOUNTING_EXPORT, { companyId: row.companyId })
    const latest = view!.supersededBy === null && row.status === 'EXPORTED'
    const checks = parseStoredChecks(row.checks).map((check) => ({
      code: check.code,
      title: CHECK_TITLES[check.code].en,
      passed: check.passed,
      count: check.count,
      words: check.passed ? 'Passed when the batch was made.' : `Failed when the batch was made (${check.count}); explained in words.`,
      fixes: [],
      explanation: check.explanation ?? null,
    }))
    return {
      ...view!,
      checks,
      manifest: manifestOf(row).map((entry) => ({ package: entry.package, recordType: entry.recordType, recordId: entry.recordId, number: entry.number, version: entry.version, change: entry.change })),
      lock: lock ? { id: lock.id, level: lock.level, status: lock.status } : null,
      actions: {
        reExport: held(mayExport && latest && (view!.changedSince?.count ?? 0) > 0, !mayExport ? 'Re-exporting needs accounting.export.' : !latest ? 'Only the latest exported batch of the month is re-exported.' : 'Nothing changed since this batch.'),
        cancel: held(mayExport && row.status === 'DRAFT', !mayExport ? 'Cancelling needs accounting.export.' : `This batch is ${row.status}: only a draft is cancelled.`),
        lock: held(can(actor, ACCOUNTING_LOCK, { companyId: row.companyId }) && row.status === 'EXPORTED' && !locks.some((entry) => entry.level === 'HARD'), row.status !== 'EXPORTED' ? 'Lock the month once its batch is exported.' : locks.some((entry) => entry.level === 'HARD') ? 'The month is closed for good (a hard lock).' : 'Locking needs accounting.lock.'),
        download: held(lacking.length === 0 && row.files.length > 0, lacking.length > 0 ? `Its files carry amounts of a grain you do not hold (${lacking.map((pkg) => PACKAGE_RULES[pkg].words.en).join(', ')}).` : 'This batch has no file yet.'),
      },
      words: `${row.layout === DEFAULT_LAYOUT ? LAYOUT_WORDS : `Layout ${row.layout}.`}${row.status === 'DRAFT' ? ' A draft: its export did not finish; the next export of the month replaces it, or cancel it.' : ''}`,
    }
  })
}

// ---- making a batch ------------------------------------------------------------------------------------------------------

interface Prepared {
  readonly company: CompanyRow
  readonly period: Period
  readonly packages: readonly AccountingPackage[]
  readonly facts: PeriodFacts
  readonly checks: readonly CheckResult[]
  readonly manifest: readonly ManifestEntry[]
  readonly files: readonly PlannedFile[]
  readonly supersedes: ExportRow | null
}

function packagesProblemsOrThrow(context: OfficeContext, company: CompanyRow, period: Period, packages: readonly AccountingPackage[]): void {
  const problems = packageProblems(packages, { yearEndPeriod: isYearEndPeriod(period, company.fiscalYearStartMonth), grains: grainsOf(context) })
  const grain = problems.filter((problem) => problem.code === 'PACKAGE_GRAIN')
  if (grain.length > 0) throw new ForbiddenError(grain.map((problem) => problem.message).join(' '))
  if (problems.length > 0) throw new AccountingRefusedError(`${monthLabel(period.month)} cannot be exported with these contents.`, problems)
}

/** Step 1's reading and checks: what the batch carries, or why it cannot be made. */
async function prepare(caller: CommandCaller, body: CreateExportBody): Promise<Prepared> {
  const context = officeOf(caller)
  const company = await companyFor(caller, body.companyId, ACCOUNTING_EXPORT)
  const period = periodOfMonth(body.month)
  const asked = sortPackages(body.packages)
  packagesProblemsOrThrow(context, company, period, body.packages)
  const today = businessDate(accountingClock().now())
  return caller.withClient(async (db) => {
    const state = periodState(await periodExports(db, company.id, period))
    const latest = state.latest
    if (latest && !body.supersedesId) {
      throw refuse(`${monthLabel(period.month)} is exported already.`, 'ALREADY_EXPORTED', `Batch ${latest.number} carries it: re-export it (only the changes go).`)
    }
    if (body.supersedesId && (!latest || latest.id !== body.supersedesId)) {
      throw refuse(
        `This re-export of ${monthLabel(period.month)} names another batch.`,
        latest ? 'NOT_LATEST' : 'NOTHING_EXPORTED',
        latest ? `A re-export amends the month's latest batch, ${latest.number}.` : 'The month has no exported batch: make its first export.',
      )
    }
    const facts = await readPeriodFacts(db, company, period, asked)
    const checks = checksOf(facts, asked, today)
    const missing = explanationProblems(checks, body.explanations)
    if (missing.length > 0) throw new ValidationError(`${missing.length} failing check(s) of ${monthLabel(period.month)} are not explained.`, missing)
    const documents = documentsOf(facts, company, asked)
    const difference = differenceOf(state.held, documents.documents, asked)
    const earlier = state.exported.map((row) => row.number!).filter(Boolean)
    const plan = planFiles({ company, period, packages: asked, facts, documents, reExport: latest ? { entries: difference.entries, packages: difference.packages, earlier } : null, language: body.language })
    if (latest && (difference.changes === 0 || plan.packages.length === 0)) {
      throw refuse(`Nothing changed in ${monthLabel(period.month)} since ${earlier.join(', ')}.`, 'NOTHING_CHANGED', 'A re-export carries only what changed: there is nothing to send.')
    }
    const carried = new Set(plan.packages)
    return {
      company,
      period,
      packages: plan.packages,
      facts,
      checks,
      manifest: difference.entries.filter((entry) => carried.has(entry.package)),
      files: plan.files,
      supersedes: latest,
    }
  })
}

const manifestJson = (entries: readonly ManifestEntry[]) =>
  entries.map((entry) => ({ package: entry.package, recordType: entry.recordType, recordId: entry.recordId, number: entry.number, version: entry.version, hash: entry.hash, change: entry.change }))

/** POST /accounting/exports: a numbered batch of a month (or a re-export of what changed since its latest batch). */
export async function createExport(caller: CommandCaller, body: CreateExportBody, idempotencyKey?: string): Promise<ExportRecordView> {
  const context = officeOf(caller)
  const spec = { name: 'accounting.prepareExport' as const, idempotencyKey, input: body }
  let prepared: Prepared
  try {
    prepared = await prepare(caller, body)
  } catch (error) {
    // A repeated request answers from its receipt once its batch is made (the month reads "exported already" now).
    if (!idempotencyKey || !(error instanceof AccountingRefusedError)) throw error
    const { result } = await accountingCommand<{ exportId: string }>(caller, spec, async () => {
      throw error
    })
    const made = await caller.withClient((db) => db.accountingExport.findUnique({ where: { id: result.exportId }, select: { status: true } }))
    if (made?.status !== 'EXPORTED') throw error
    return exportRecord(caller, result.exportId)
  }
  const { company, period } = prepared

  // 1. The draft, under the period's lock: a newer state of the month (another export made meanwhile) is refused.
  const draftId = newId()
  const { result } = await accountingCommand(caller, spec, async (tools) => {
    await lockPeriodExports(tools.tx, company.id, period)
    const now = periodState(await periodExports(tools.tx, company.id, period))
    if ((now.latest?.id ?? null) !== (prepared.supersedes?.id ?? null)) {
      throw refuse(`${monthLabel(period.month)} was exported meanwhile.`, 'EXPORTED_MEANWHILE', `Batch ${now.latest?.number ?? ''} was made while this one was being prepared: look at the month again.`)
    }
    for (const draft of now.rows.filter((row) => row.status === 'DRAFT')) {
      const reason = `Replaced by a new export of ${monthLabel(period.month)}.`
      await tools.tx.accountingExport.update({ where: { id: draft.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'accounting.cancelExport', recordType: 'AccountingExport', recordId: draft.id, companyId: company.id, before: { status: 'DRAFT' }, after: { status: 'CANCELLED', cancelReason: reason }, reason })
      tools.emit({ type: 'accounting_export.cancelled', subject: draft.id, companyId: company.id, payload: { exportId: draft.id, periodStart: period.start, periodEnd: period.end, replacedById: draftId } })
    }
    const checks = storedChecks(prepared.checks, body.explanations)
    await tools.tx.accountingExport.create({
      data: {
        id: draftId,
        companyId: company.id,
        periodStart: dateOf(period.start),
        periodEnd: dateOf(period.end),
        packages: [...prepared.packages],
        layout: DEFAULT_LAYOUT,
        supersedesId: prepared.supersedes?.id ?? null,
        checks: checks as unknown as Prisma.InputJsonValue,
        manifest: manifestJson(prepared.manifest) as unknown as Prisma.InputJsonValue,
        note: body.note ?? null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: 'AccountingExport',
      recordId: draftId,
      companyId: company.id,
      after: { status: 'DRAFT', periodStart: period.start, periodEnd: period.end, packages: [...prepared.packages], layout: DEFAULT_LAYOUT, supersedesId: prepared.supersedes?.id ?? null, documents: prepared.manifest.length, failedChecks: checks.filter((check) => !check.passed).map((check) => check.code) },
    })
    return { exportId: draftId }
  })
  const exportId = result.exportId

  const current = await caller.withClient((db) => db.accountingExport.findUnique({ where: { id: exportId }, select: { status: true, version: true } }))
  if (current?.status === 'EXPORTED') return exportRecord(caller, exportId)
  if (!current || current.status !== 'DRAFT') throw refuse('This export was cancelled before it finished.', 'CANCELLED', 'A newer export of the month replaced it, or a person cancelled it: look at the month again.')

  // 2. The files, outside any transaction.
  const runtime = processFiles()
  const at = accountingClock().now()
  const stored: { planned: PlannedFile; prepared: PreparedGeneratedFile }[] = []
  for (const planned of prepared.files) {
    const kind = planned.format === 'PDF' ? 'FISCAL_ARCHIVE' : 'DOCUMENT'
    const retainUntil = addYears(at, TEN_YEARS)
    const target = { companyId: company.id, recordType: 'AccountingExport', recordId: exportId, kind, originalName: planned.name, retainUntil } as const
    const file = planned.copyOf ? await prepareFileCopy(runtime, caller, planned.copyOf, target) : await putGeneratedFile(runtime, caller, { ...target, contentType: planned.contentType, body: planned.body! })
    stored.push({ planned, prepared: file })
  }

  // 3. The batch: the month read again, the files recorded, the number, EXPORTED.
  await accountingCommand(
    caller,
    { name: 'accounting.export', idempotencyKey: idempotencyKey ? `${idempotencyKey.slice(0, 120)}:export` : undefined, input: { exportId }, record: { type: 'AccountingExport', id: exportId, expectedVersion: current.version } },
    async (tools) => finishExport(tools, prepared, exportId, stored),
    true,
  )
  return exportRecord(caller, exportId)
}

async function finishExport(tools: CommandTools, prepared: Prepared, exportId: string, stored: readonly { planned: PlannedFile; prepared: PreparedGeneratedFile }[]) {
  const { company, period } = prepared
  const row = await tools.tx.accountingExport.findUniqueOrThrow({ where: { id: exportId }, select: { status: true, manifest: true, packages: true } })
  if (row.status !== 'DRAFT') throw refuse(`This export is ${row.status}.`, row.status, 'Only a draft is exported.')
  // Nothing it carries changed since step 1 (else its files would not be its manifest).
  const state = periodState(await periodExports(tools.tx, company.id, period))
  const facts = await readPeriodFacts(tools.tx, company, period, prepared.packages)
  const again = differenceOf(state.held, documentsOf(facts, company, prepared.packages).documents, prepared.packages).entries
  if (canonicalJson(manifestJson(again)) !== canonicalJson(row.manifest)) {
    throw new ConflictError(`Documents of ${monthLabel(period.month)} changed while the export was being made: export it again.`)
  }
  const files: { id: string; seq: number; package: AccountingPackage; fileId: string; format: string; rowCount: number }[] = []
  let seq = 0
  for (const { planned, prepared: file } of stored) {
    const view = await recordGeneratedFile(tools, file, { action: 'accounting.exportFile', details: { package: planned.package, format: planned.format, rows: planned.rowCount } })
    files.push({ id: newId(), seq: ++seq, package: planned.package, fileId: view.id, format: planned.format, rowCount: planned.rowCount })
  }
  await tools.tx.accountingExportFile.createMany({ data: files.map((file) => ({ ...file, exportId, createdAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null })) })
  const number = await allocateNumber(tools, { companyId: company.id, kind: 'ACCOUNTING_EXPORT' }, { type: 'AccountingExport', id: exportId })
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  await tools.tx.accountingExport.update({
    where: { id: exportId },
    data: { status: 'EXPORTED', number: number.formatted, numberSeriesId: number.seriesId, exportedAt: tools.now, exportedById: actorId, updatedAt: tools.now },
    select: { id: true },
  })
  tools.audit({
    recordType: 'AccountingExport',
    recordId: exportId,
    companyId: company.id,
    before: { status: 'DRAFT' },
    after: { status: 'EXPORTED', number: number.formatted, files: files.map((file) => ({ seq: file.seq, package: file.package, format: file.format, rows: file.rowCount })) },
  })
  tools.emit({
    type: 'accounting_export.exported',
    subject: exportId,
    companyId: company.id,
    payload: { exportId, number: number.formatted, periodStart: period.start, periodEnd: period.end, packages: [...prepared.packages], files: files.length, supersedesId: prepared.supersedes?.id ?? null },
  })
  return { exportId, number: number.formatted }
}

/** POST /accounting/exports/:id/cancel: a draft abandoned, with the reason. */
export async function cancelExport(caller: CommandCaller, exportId: string, body: CancelExportBody, idempotencyKey?: string): Promise<ExportRecordView> {
  const context = officeOf(caller)
  const row = await visibleExport(caller, exportId)
  if (!can(actorOf(context), ACCOUNTING_EXPORT, { companyId: row.companyId })) throw new ForbiddenError()
  if (row.status !== 'DRAFT') throw refuse(`Batch ${row.number ?? row.id} is ${row.status}.`, 'NOT_DRAFT', 'Only a draft is cancelled: an exported batch is amended by a re-export.')
  if (row.version !== body.version) throw new StaleVersionError('AccountingExport', exportId, row.version, body.version)
  const period = periodOfRow(row)
  await accountingCommand(caller, { name: 'accounting.cancelExport', idempotencyKey, input: { exportId, ...body }, record: { type: 'AccountingExport', id: exportId, expectedVersion: body.version } }, async (tools) => {
    const locked = await tools.tx.accountingExport.findUniqueOrThrow({ where: { id: exportId }, select: { status: true } })
    if (locked.status !== 'DRAFT') throw refuse(`This export is ${locked.status}.`, 'NOT_DRAFT', 'Only a draft is cancelled.')
    await tools.tx.accountingExport.update({ where: { id: exportId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'AccountingExport', recordId: exportId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED', cancelReason: body.reason }, reason: body.reason })
    tools.emit({ type: 'accounting_export.cancelled', subject: exportId, companyId: row.companyId, payload: { exportId, periodStart: period.start, periodEnd: period.end, replacedById: null } })
    return { exportId }
  })
  return exportRecord(caller, exportId)
}

/** GET /accounting/exports/:id/files/:fileId/download: a file of a batch (its package's grain), as a 60-second link. */
export async function downloadExportFile(request: FastifyRequest, exportId: string, fileId: string) {
  const context = officeOf(request)
  const row = await visibleExport(request, exportId)
  const file = row.files.find((entry) => entry.id === fileId || entry.file.id === fileId)
  if (!file) throw new NotFoundError('This batch has no such file.')
  const rule = PACKAGE_RULES[file.package as AccountingPackage]
  if (!grainsOf(context).has(rule.grain)) throw new ForbiddenError(`${rule.words.en} carries ${rule.grain === 'cost' ? 'costs' : 'prices'}: downloading it needs the ${rule.grain} grain.`)
  return { download: await downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, file.file.id) }
}

export { periodOfRow }
