import type { Prisma } from '@nexus/factory-db'
import { monthLabel } from '@nexus/factory-domain/accounting/periods'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { storedChecks } from '@nexus/factory-domain/people/payroll/checks'
import { PEOPLE_PAYROLL_MANAGE, PEOPLE_PAYROLL_RECORDS, PEOPLE_PAYROLL_VIEW } from '@nexus/factory-domain/people/payroll/permissions'
import { carriesPay, changeCounts, parseValues, valueChanges, valuesText } from '@nexus/factory-domain/people/payroll/values'
import { COMMAND_SETTINGS, command, runCommand, type CommandCaller, type CommandSettings, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { downloadFile, putGeneratedFile, recordGeneratedFile, systemCallerOf, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import type { FastifyRequest } from 'fastify'
import { companyFor, placeOf, reachesCompany, type Place } from '../close/store'
import { assertVersion, bodyIssue, dateOf, officeOf } from '../employees/access'
import { settleCase } from '../leavers/automatic'
import { payGuarded, seesPay } from '../piecerates/access'
import type { CancelBody, CreateExportBody, ExportsQuery } from './contract'
import { lineDaysOf, monthChecks, monthPeople } from './facts'
import { renderFiles, retentionFrom, type PlannedFile } from './files'
import { valuesView } from './month'
import { companyPayrollCode, EXPORT_SELECT, exportsOfMonth, latestExported, layoutAsUsed, layoutOf, lockMonthExports, monthOfRow, periodDaysOf, refusePayroll, requireMonthGates, type ExportRow, type LayoutRow } from './store'
import { exportById, exportRecordOf, exportRows } from './views'

/**
 * Payroll exports (B-W2b-54; MES-267, MES-273; design people.payroll "5 · Export and send", "Exports", "Make correction export").
 * Nexus does not run payroll: it makes a file for the labour consultant. Making one is three steps, so the files are stored
 * before the export is numbered, and a number is never given to an export without its files (the database refuses it):
 *
 *   1. ONE command under the month's lock: the month read again, the checks (a blocking one refuses), the values as they stand
 *      and the layout as it is, kept on a DRAFT; an older draft of the month is cancelled;
 *   2. the data file and the summary rendered and put in the file store, outside any transaction;
 *   3. ONE command on the draft (its version: a cancel in between wins): the values read again and compared (a correction that
 *      landed meanwhile refuses, in words), the files recorded, the number from the company's PAYROLL_EXPORT series, EXPORTED.
 *      A correction also withdraws the live links of the file it replaces, and a leaver on the file has their payroll step
 *      ticked (MES-214).
 *
 * A correction names the month's latest file; its values are the whole month as it stands now, so it replaces that file for
 * the consultant, and the earlier one is kept. It is refused when nothing differs. A repeat with the same Idempotency-Key
 * finishes the same export. A failure after step 1 leaves the draft; the next export of the month replaces it.
 */

const LONG_COMMAND_MS = 120_000
const LONG: CommandSettings = { ...COMMAND_SETTINGS, timeoutMs: LONG_COMMAND_MS }
const FILES_RECORD = 'PayrollExport'

const notFound = (): NotFoundError => new NotFoundError('Payroll export not found.')

/** An export with its company, if the caller reaches every site of it (else 404). */
export async function visibleExport(caller: CommandCaller, exportId: string, permission: Permission = PEOPLE_PAYROLL_VIEW): Promise<{ context: OfficeContext; row: ExportRow; place: Place }> {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const row = await exportById(db, exportId)
    const place = row ? await placeOf(db, row.companyId) : null
    if (!row || !place || !reachesCompany(context, place, [PEOPLE_PAYROLL_VIEW])) throw notFound()
    if (!reachesCompany(context, place, [permission])) throw new ForbiddenError(permission === PEOPLE_PAYROLL_MANAGE ? 'This needs people.payroll.manage over every site of the company.' : "A file's figures open only with people.payroll.records over every site of the company.")
    return { context, row, place }
  })
}

/** GET /people/payroll/exports: newest month first. */
export async function listExports(caller: CommandCaller, query: ExportsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, [PEOPLE_PAYROLL_VIEW])
    const where: Prisma.PayrollExportWhereInput = { companyId: place.company.id, ...(query.year ? { periodStart: { gte: dateOf(`${query.year}-01-01`), lte: dateOf(`${query.year}-12-31`) } } : {}) }
    const rows = await db.payrollExport.findMany({ where, select: EXPORT_SELECT, orderBy: [{ periodStart: 'desc' }, { revision: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) })
    const page = rows.slice(0, query.limit)
    return { rows: await exportRows(db, page), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /people/payroll/exports/:exportId. */
export async function getExport(caller: CommandCaller, exportId: string) {
  const { context, row, place } = await visibleExport(caller, exportId)
  return caller.withClient((db) => exportRecordOf(db, context, place, row))
}

interface Made {
  readonly place: Place
  readonly lineDaysOpen: number
  readonly layout: LayoutRow
}

/** Step 1's reading outside the command: who may, and the layout (a correction's default: the layout of the file it replaces). */
async function readyToMake(caller: CommandCaller, context: OfficeContext, body: CreateExportBody): Promise<Made> {
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, body.companyId, [PEOPLE_PAYROLL_VIEW])
    if (!reachesCompany(context, place, [PEOPLE_PAYROLL_MANAGE])) throw new ForbiddenError('Making a payroll export needs people.payroll.manage over every site of the company.')
    await requireMonthGates(db, place, body.month)
    const earlier = body.correctionOfId ? (await exportsOfMonth(db, place.company.id, body.month)).find((row) => row.id === body.correctionOfId) : undefined
    const layoutId = body.layoutId ?? earlier?.layoutId
    if (!layoutId) throw bodyIssue('layoutId', 'Choose a layout for the file.')
    const layout = await layoutOf(db, place.company.id, layoutId)
    if (layout.status !== 'ACTIVE') refusePayroll('LAYOUT_ARCHIVED', 'This layout is archived: choose another.', 'layoutId')
    return { place, lineDaysOpen: await lineDaysOf(db, place, body.month), layout }
  })
}

/** Step 1: the DRAFT, or the refusal in words. */
async function draftOf(tools: CommandTools, context: OfficeContext, made: Made, body: CreateExportBody): Promise<{ exportId: string }> {
  const { tx, now } = tools
  const { place, layout, lineDaysOpen } = made
  const companyId = place.company.id
  const label = monthLabel(body.month)
  await lockMonthExports(tx, companyId, body.month)
  await requireMonthGates(tx, place, body.month)
  const rows = await exportsOfMonth(tx, companyId, body.month)
  const latest = latestExported(rows)
  if (latest && !body.correctionOfId) refusePayroll('ALREADY_EXPORTED', `${label} is exported already (${latest.number}): make a correction.`)
  if (body.correctionOfId && !latest) refusePayroll('NOTHING_EXPORTED', `${label} has no export yet: make its first one.`)
  if (body.correctionOfId && latest?.id !== body.correctionOfId) refusePayroll('NOT_LATEST', `A correction replaces the month's latest file, ${latest?.number}.`)
  const read = await monthChecks(tx, place, body.month, { layout, lineDaysOpen, now, revision: (latest?.revision ?? 0) + 1 })
  if (read.blocking.length > 0) refusePayroll('CHECKS_OPEN', `${label} cannot be exported: ${read.blocking.map((check) => check.words).join(' ')}`, undefined, read.blocking.map((check) => ({ path: `check/${check.code}`, message: check.words })))
  if (read.carriesPay && !seesPay(context)) throw new ForbiddenError('This file carries amounts: making it asks the pay grain.')
  if (latest && valueChanges(parseValues(latest.values), read.people.values).length === 0 && latest.layoutId === layout.id) refusePayroll('NOTHING_CHANGED', `Nothing changed in ${label} since ${latest.number}.`)
  for (const draft of rows.filter((row) => row.status === 'DRAFT')) {
    const reason = `Replaced by a new export of ${label}.`
    await tx.payrollExport.update({ where: { id: draft.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.cancelPayrollExport', recordType: 'PayrollExport', recordId: draft.id, companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason })
    tools.emit({ type: 'payroll_export.cancelled', subject: draft.id, companyId, payload: { exportId: draft.id, companyId, month: body.month } })
  }
  const days = periodDaysOf(body.month)
  const exportId = newId()
  // The layout as used: its columns, the company's payroll code and the confirmation, frozen with the export.
  const snapshot = layoutAsUsed(layout, await companyPayrollCode(tx, companyId))
  await payGuarded(() =>
    tx.payrollExport.create({
      data: {
        id: exportId,
        companyId,
        periodStart: dateOf(days.from),
        periodEnd: dateOf(days.to),
        payPeriodId: read.people.piecePayOn ? (read.people.period?.id ?? null) : null,
        layoutId: layout.id,
        layoutSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        revision: (latest?.revision ?? 0) + 1,
        correctionOfId: latest?.id ?? null,
        checks: storedChecks(read.checks) as unknown as Prisma.InputJsonValue,
        correctionsCarried: [...read.people.corrections],
        values: read.people.values as unknown as Prisma.InputJsonValue,
        note: body.note ?? null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    }),
  )
  tools.audit({ recordType: 'PayrollExport', recordId: exportId, companyId, after: { status: 'DRAFT', month: body.month, layoutId: layout.id, revision: (latest?.revision ?? 0) + 1, correctionOfId: latest?.id ?? null, people: read.people.rows.length, rows: read.people.values.length, warnings: read.checks.filter((check) => !check.blocking && !check.passed).map((check) => check.code) } })
  return { exportId }
}

interface Stored {
  readonly planned: PlannedFile
  readonly prepared: PreparedGeneratedFile
}

/** The leavers on this file have their payroll step ticked, naming the export: the system's, no person's (MES-214). */
async function flagLeavers(tools: CommandTools, exportId: string, employeeIds: readonly string[]): Promise<void> {
  if (employeeIds.length === 0) return
  const { tx, now } = tools
  const steps = await tx.leaverStep.findMany({ where: { kind: 'PAYROLL_FLAGGED', status: 'OPEN', leaverCase: { status: 'OPEN', employeeId: { in: [...employeeIds] } } }, select: { id: true, caseId: true, leaverCase: { select: { employeeId: true, employee: { select: { companyId: true, siteId: true } } } } } })
  for (const step of steps) {
    const { employeeId, employee } = step.leaverCase
    await tx.leaverStep.update({ where: { id: step.id }, data: { status: 'DONE', doneAt: now, doneById: null, recordType: FILES_RECORD, recordId: exportId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.leaverStepTicked', recordType: 'Employee', recordId: employeeId, companyId: employee.companyId, siteId: employee.siteId, before: { caseId: step.caseId, step: 'PAYROLL_FLAGGED', status: 'OPEN' }, after: { caseId: step.caseId, step: 'PAYROLL_FLAGGED', status: 'DONE', automatic: true, exportId } })
    tools.emit({ type: 'leaver.step_done', subject: step.caseId, companyId: employee.companyId, siteId: employee.siteId, payload: { caseId: step.caseId, employeeId, stepId: step.id, kind: 'PAYROLL_FLAGGED', status: 'DONE', by: 'SYSTEM' } })
    await settleCase(tools, step.caseId)
  }
}

/** A replaced file stops travelling: its live links are withdrawn. */
async function withdrawLinksOf(tools: CommandTools, exportId: string, companyId: string, actorId: string): Promise<void> {
  const { tx, now } = tools
  const links = await tx.oneOffLink.findMany({ where: { recordType: FILES_RECORD, recordId: exportId, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } })
  for (const link of links) {
    await tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now, revokedById: actorId } })
    tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId, after: { revokedAt: toUtcIso(now) }, reason: 'A correction replaced this file.' })
    tools.emit({ type: 'payroll_export.link_withdrawn', subject: exportId, companyId, payload: { exportId, companyId, linkId: link.id } })
  }
}

/** Step 3. */
async function finish(tools: CommandTools, context: OfficeContext, place: Place, row: ExportRow, stored: readonly Stored[]): Promise<{ exportId: string }> {
  const { tx, now } = tools
  const exportId = row.id
  const companyId = row.companyId
  const month = monthOfRow(row)
  const current = await tx.payrollExport.findUniqueOrThrow({ where: { id: exportId }, select: { status: true } })
  if (current.status !== 'DRAFT') refusePayroll('NOT_DRAFT', `This export is ${current.status}: only a draft is exported.`)
  const people = await monthPeople(tx, place, month, now)
  if (valuesText(parseValues(row.values)) !== valuesText(people.values)) refusePayroll('CHANGED_WHILE_MAKING', `The figures of ${monthLabel(month)} changed while the file was being made: export it again.`)
  const files: { id: string; seq: number; kind: 'DATA' | 'SUMMARY'; fileId: string; format: string; rowCount: number }[] = []
  let seq = 0
  for (const { planned, prepared } of stored) {
    const view = await recordGeneratedFile(tools, prepared, { action: 'people.payrollFile', details: { month, kind: planned.kind, format: planned.format, rows: planned.rowCount } })
    files.push({ id: newId(), seq: ++seq, kind: planned.kind, fileId: view.id, format: planned.format, rowCount: planned.rowCount })
  }
  await tx.payrollExportFile.createMany({ data: files.map((file) => ({ ...file, exportId, createdAt: now, createdById: context.actorId })) })
  const number = await allocateNumber(tools, { companyId, kind: 'PAYROLL_EXPORT' }, { type: FILES_RECORD, id: exportId })
  await payGuarded(() => tx.payrollExport.update({ where: { id: exportId }, data: { status: 'EXPORTED', number: number.formatted, numberSeriesId: number.seriesId, exportedAt: now, exportedById: context.actorId, updatedAt: now }, select: { id: true } }))
  if (row.correctionOfId) await withdrawLinksOf(tools, row.correctionOfId, companyId, context.actorId)
  await flagLeavers(tools, exportId, people.leavers)
  const changed = row.correctionOf ? changeCounts(valueChanges(parseValues(row.correctionOf.values), people.values)) : null
  tools.audit({ recordType: FILES_RECORD, recordId: exportId, companyId, before: { status: 'DRAFT' }, after: { status: 'EXPORTED', number: number.formatted, month, revision: row.revision, files: files.map((file) => ({ seq: file.seq, kind: file.kind, format: file.format, rows: file.rowCount })), changed } })
  tools.emit({ type: 'payroll_export.exported', subject: exportId, companyId, payload: { exportId, companyId, month, number: number.formatted, revision: row.revision, correctionOfId: row.correctionOfId, people: people.rows.length, rows: people.values.length } })
  return { exportId }
}

/** POST /people/payroll/exports: a month's first file, or a correction of its latest one. */
export async function createExport(caller: CommandCaller, body: CreateExportBody, key?: string) {
  const context = officeOf(caller)
  const made = await readyToMake(caller, context, body)
  const { result } = await runCommand(caller, { name: 'people.preparePayrollExport', idempotencyKey: key, input: body }, (tools) => draftOf(tools, context, made, body), LONG)
  const exportId = result.exportId
  const row = await caller.withClient((db) => exportById(db, exportId))
  if (!row) throw notFound()
  if (row.status === 'CANCELLED') refusePayroll('NOT_DRAFT', 'This export was cancelled before it finished: look at the month again.')
  if (row.status === 'DRAFT') {
    const runtime = processFiles()
    const at = serverClock.now()
    const stored: Stored[] = []
    for (const planned of await renderFiles(made.place, row)) {
      const prepared = await putGeneratedFile(runtime, caller, { companyId: row.companyId, recordType: FILES_RECORD, recordId: row.id, kind: planned.fileKind, originalName: planned.name, contentType: planned.contentType, body: planned.body, retainUntil: retentionFrom(at) })
      stored.push({ planned, prepared })
    }
    await runCommand(caller, { name: 'people.exportPayroll', idempotencyKey: key ? `${key.slice(0, 120)}:export` : undefined, input: { exportId }, record: { type: FILES_RECORD, id: exportId, expectedVersion: row.version } }, (tools) => finish(tools, context, made.place, row, stored), LONG)
  }
  return getExport(caller, exportId)
}

/** POST /people/payroll/exports/:exportId/cancel: a draft abandoned, with why. */
export async function cancelExport(caller: CommandCaller, exportId: string, body: CancelBody, key?: string) {
  const { row } = await visibleExport(caller, exportId, PEOPLE_PAYROLL_MANAGE)
  if (row.status !== 'DRAFT') refusePayroll('NOT_DRAFT', `This export is ${row.status}: only a draft is cancelled. An exported file is put right by a correction.`)
  assertVersion('export', row.version, body.version)
  await command(caller, { name: 'people.cancelPayrollExport', idempotencyKey: key, input: { exportId, ...body }, record: { type: FILES_RECORD, id: exportId, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.payrollExport.update({ where: { id: exportId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: FILES_RECORD, recordId: exportId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason: body.reason })
    tools.emit({ type: 'payroll_export.cancelled', subject: exportId, companyId: row.companyId, payload: { exportId, companyId: row.companyId, month: monthOfRow(row) } })
    return { exportId }
  })
  return getExport(caller, exportId)
}

/** POST /people/payroll/exports/:exportId/values: what a file sent, per employee code. The right, recorded. */
export async function exportValues(caller: CommandCaller, exportId: string, key?: string) {
  const { context, row, place } = await visibleExport(caller, exportId, PEOPLE_PAYROLL_RECORDS)
  const month = monthOfRow(row)
  await caller.withClient((db) => requireMonthGates(db, place, month))
  await command(caller, { name: 'people.openPayrollValues', idempotencyKey: key, input: { exportId } }, async (tools) => {
    tools.audit({ recordType: FILES_RECORD, recordId: exportId, companyId: row.companyId, after: { month, revision: row.revision } })
    return { exportId }
  })
  const values = parseValues(row.values)
  const codes = [...new Set(values.map((value) => value.employeeCode))]
  const rows = codes.map((employeeCode) => {
    const own = values.filter((value) => value.employeeCode === employeeCode)
    return { employeeId: null, employeeCode, lastDay: own.find((value) => value.lastDay !== null)?.lastDay ?? null, values: own }
  })
  return valuesView(month, rows, values, row.correctionOf ? parseValues(row.correctionOf.values) : null, seesPay(context))
}

/** POST /people/payroll/exports/:exportId/files/:fileId/open: a file, as a 60-second link. Every opening is recorded. */
export async function openExportFile(request: FastifyRequest, exportId: string, fileId: string, key?: string) {
  const { context, row, place } = await visibleExport(request, exportId, PEOPLE_PAYROLL_RECORDS)
  const file = row.files.find((entry) => entry.fileId === fileId)
  if (!file) throw new NotFoundError('This export has no such file.')
  if (carriesPay(parseValues(row.values)) && !seesPay(context)) throw new ForbiddenError('This file carries amounts: opening it asks the pay grain.')
  const month = monthOfRow(row)
  await request.withClient((db) => requireMonthGates(db, place, month))
  await command(request, { name: 'people.openPayrollFile', idempotencyKey: key, input: { exportId, fileId } }, async (tools) => {
    tools.audit({ recordType: FILES_RECORD, recordId: exportId, companyId: row.companyId, after: { month, fileId, kind: file.kind, format: file.format } })
    return { fileId }
  })
  const download = await downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, fileId, { viaModule: true })
  return { fileId, fileName: file.file.originalName, sha256: file.file.sha256, download }
}

