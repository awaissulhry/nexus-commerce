import type { Prisma } from '@nexus/factory-db'
import { REGISTER_MANAGE } from '@nexus/factory-domain/compliance/register/permissions'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_SAFETY_MANAGE, SALES_SAFETY_VIEW } from '@nexus/factory-domain/sales/safety-reports/permissions'
import {
  closeProblems,
  eraseReasonProblems,
  moveHeld,
  NOTIFIABLE_OUTCOMES,
  registerDescriptionOf,
  SAFETY_LIMITS,
  SAFETY_REPORT_RECORD,
  type MoveTarget,
  type OfficeSource,
  type ReportStatus,
  type SavedView,
  type SafetySource,
} from '@nexus/factory-domain/sales/safety-reports/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { openRegisterEntryFor } from '../../compliance/register/hook'
import { blank, planGarment, refuse } from '../service/open'
import { held, mayOn, officeOf, officeReport } from './access'
import { intakeInCommand, safetyOwnerProblems, type IntakeBody } from './intake'
import { asDay, dayOrNull, lockReport, peopleOf, REPORT_COLUMNS, touchReport } from './store'
import { reportRecordOf, rowFacts, rowView, type ReportView } from './view'

/**
 * The office's product-safety reports (B-W2b-351; SAL-414): a report typed from a call, a visit or a mail (the public and portal
 * doors are ./outside.ts), the list and its tiles, and the record's steps — its facts and owner, seen by quality, assessed,
 * closed, filed in the PPE register, the reporter's personal data erased on request. Every write is ONE command with the report
 * FOR UPDATE at the screen's version, version + 1, an audit row that never holds the reporter's words or personal data, its
 * event. Whether someone was hurt: ./injury.ts. The accident log: ./accidents.ts. Photos: ./files.ts.
 */

// ---- record a report ------------------------------------------------------------------------------------------------------

export interface OfficeIntakeBody extends IntakeBody {
  readonly companyId: string
  readonly source: OfficeSource
  readonly partyId?: string | null | undefined
  readonly contactId?: string | null | undefined
  /** A mail: when it came (not in the future); default now. */
  readonly receivedAt?: string | null | undefined
  readonly ownerId?: string | null | undefined
}

/** POST /sales/safety-reports */
export async function recordReport(caller: CommandCaller, body: OfficeIntakeBody, idempotencyKey?: string): Promise<{ report: ReportView; serviceCase: { id: string; number: string }; warnings: Issue[] }> {
  const context = officeOf(caller)
  const partyId = blank(body.partyId)
  if (!mayOn(context, SALES_SAFETY_MANAGE, { companyId: body.companyId, partyId })) throw new NotFoundError('Company not found.')
  const { result } = await command(caller, { name: 'safetyReports.record', idempotencyKey, input: body }, async (tools) => {
    const receivedAt = body.receivedAt ? new Date(body.receivedAt) : tools.now
    if (receivedAt.getTime() > tools.now.getTime()) refuse([{ path: 'body/receivedAt', message: 'It reached us now or earlier.' }], 'The safety report cannot be recorded like this.')
    return intakeInCommand(tools, { source: body.source, companyId: body.companyId, partyId, contactId: blank(body.contactId), receivedAt, ownerId: blank(body.ownerId), actor: { kind: 'office', context } }, body)
  })
  return { report: await reportRecordOf(caller, result.reportId), serviceCase: { id: result.caseId, number: result.caseNumber }, warnings: result.warnings }
}

// ---- the list and its tiles -----------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly view?: SavedView | undefined
  readonly status?: ReportStatus | undefined
  readonly source?: SafetySource | undefined
  readonly companyId?: string | undefined
  readonly styleId?: string | undefined
  readonly serial?: string | undefined
  readonly batch?: string | undefined
  readonly owner?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const SCOPE = { company: 'companyId', party: { field: 'partyId', nullable: true } } as const
const scopeOfCaller = (caller: CommandCaller) => scopeWhere(actorOf(officeOf(caller)), SALES_SAFETY_VIEW, SCOPE) as Prisma.ProductSafetyReportWhereInput

function viewWhere(view: SavedView): Prisma.ProductSafetyReportWhereInput {
  switch (view) {
    case 'open':
      return { status: { in: ['NEW', 'ASSESSING'] } }
    case 'new':
      return { status: 'NEW' }
    case 'assessing':
      return { status: 'ASSESSING' }
    case 'closed':
      return { status: 'CLOSED' }
    case 'all':
      return {}
  }
}

function whereOf(caller: CommandCaller, query: ListQuery): Prisma.ProductSafetyReportWhereInput {
  const context = officeOf(caller)
  if (query.owner && query.owner !== 'me' && !isUuid(query.owner)) throw new ValidationError('Not an owner.', [{ path: 'querystring/owner', message: "A person's id, or me." }])
  const q = (query.q ?? '').trim()
  const serial = (query.serial ?? '').trim()
  const batch = (query.batch ?? '').trim()
  return {
    AND: [
      scopeOfCaller(caller),
      query.status ? { status: query.status } : viewWhere(query.view ?? 'open'),
      query.source ? { source: query.source } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.styleId ? { styleId: query.styleId } : {},
      serial ? { OR: [{ serial }, { garmentSerial: serial }] } : {},
      batch ? { OR: [{ batchNumber: batch }, { garmentBatch: batch }] } : {},
      query.owner ? { ownerId: query.owner === 'me' ? context.actorId : query.owner } : {},
      q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { serial: { contains: q, mode: 'insensitive' } }, { batchNumber: { contains: q, mode: 'insensitive' } }, { style: { code: { contains: q, mode: 'insensitive' } } }] } : {},
    ],
  }
}

const cursorOf = (row: { receivedAt: Date; id: string }): string => `${row.receivedAt.toISOString()}|${row.id}`
function afterCursor(cursor: string | undefined): Prisma.ProductSafetyReportWhereInput {
  if (!cursor) return {}
  const [at, id] = cursor.split('|')
  const when = at ? new Date(at) : null
  if (!when || Number.isNaN(when.getTime()) || !id || !isUuid(id)) throw new ValidationError('Not a cursor of this list.', [{ path: 'querystring/cursor', message: 'The nextCursor of the page before.' }])
  return { OR: [{ receivedAt: { lt: when } }, { receivedAt: when, id: { lt: id } }] }
}

/** GET /sales/safety-reports — newest first (received, then id); never the reporter, what happened or an injury. */
export async function listReports(caller: CommandCaller, query: ListQuery) {
  const now = serverClock.now()
  const limit = Math.min(query.limit ?? SAFETY_LIMITS.page, SAFETY_LIMITS.list)
  return caller.withClient(async (client) => {
    const rows = await client.productSafetyReport.findMany({ where: { AND: [whereOf(caller, query), afterCursor(query.cursor)] }, select: REPORT_COLUMNS, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const shown = rows.slice(0, limit)
    const facts = await rowFacts(client, shown)
    return {
      reports: shown.map((row) => rowView(row, facts)),
      nextCursor: rows.length > limit ? cursorOf(shown[shown.length - 1]!) : null,
      people: await peopleOf(client, shown.map((row) => row.ownerId)),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /sales/safety-reports/counts — the tiles: not seen yet, being assessed, accidents to tell the authority of. */
export async function reportCounts(caller: CommandCaller) {
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const scope = scopeOfCaller(caller)
    const count = (where: Prisma.ProductSafetyReportWhereInput) => client.productSafetyReport.count({ where: { AND: [scope, where] } })
    // The newest revision per report in scope: a death or serious harm not told yet.
    const logged = await client.accidentLogEntry.findMany({ where: { report: scope }, select: { reportId: true, revision: true, outcome: true, authorityToldAt: true }, orderBy: [{ reportId: 'asc' }, { revision: 'desc' }], take: SAFETY_LIMITS.logRead })
    const newest = new Map<string, { outcome: string; told: boolean }>()
    for (const entry of logged) if (!newest.has(entry.reportId)) newest.set(entry.reportId, { outcome: entry.outcome, told: entry.authorityToldAt !== null })
    const toTell = [...newest.values()].filter((entry) => !entry.told && (NOTIFIABLE_OUTCOMES as readonly string[]).includes(entry.outcome)).length
    return {
      tiles: { notSeen: await count({ status: 'NEW', seenAt: null }), assessing: await count({ status: 'ASSESSING' }), accidentsToTell: toTell },
      rows: { open: await count(viewWhere('open')), new: await count(viewWhere('new')), assessing: await count(viewWhere('assessing')), closed: await count(viewWhere('closed')), all: await count({}) },
      asOf: toUtcIso(now),
    }
  })
}

// ---- the record's steps ---------------------------------------------------------------------------------------------------

/** GET /sales/safety-reports/:reportId */
export async function getReport(caller: CommandCaller, reportId: string): Promise<{ report: ReportView }> {
  await officeReport(caller, reportId)
  return { report: await reportRecordOf(caller, reportId) }
}

export interface ChangeBody {
  readonly version: number
  readonly ownerId?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly occurredOn?: BusinessDate | null | undefined
  readonly wornAsIntended?: boolean | null | undefined
}

const CHANGE_FIELDS = ['ownerId', 'styleId', 'colourwayId', 'size', 'serial', 'batchNumber', 'occurredOn', 'wornAsIntended'] as const

/** PATCH /sales/safety-reports/:reportId — the garment (re-read against our serials and batches), the day, worn as intended, the owner. */
export async function changeReport(caller: CommandCaller, reportId: string, body: ChangeBody, idempotencyKey?: string): Promise<{ report: ReportView; warnings: Issue[] }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_MANAGE)
  const { result } = await command(caller, { name: 'safetyReports.change', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version)
    const problems: Issue[] = []
    const warnings: Issue[] = []
    const garmentTouched = ['styleId', 'colourwayId', 'size', 'serial', 'batchNumber'].some((field) => (body as unknown as Record<string, unknown>)[field] !== undefined)
    const asked = {
      serial: body.serial === undefined ? row.serial : blank(body.serial),
      batchNumber: body.batchNumber === undefined ? row.batchNumber : blank(body.batchNumber),
      styleId: body.styleId === undefined ? row.styleId : blank(body.styleId),
      colourwayId: body.colourwayId === undefined ? (body.styleId !== undefined ? null : row.colourwayId) : blank(body.colourwayId),
      size: body.size === undefined ? row.size : blank(body.size),
    }
    for (const field of ['serial', 'batchNumber'] as const) {
      const value = asked[field]
      if (value && (value.length > SAFETY_LIMITS.label || /[\r\n]/.test(value))) problems.push({ path: `body/${field}`, message: `One line of at most ${SAFETY_LIMITS.label} characters.` })
    }
    if (asked.size && asked.size.length > SAFETY_LIMITS.size) problems.push({ path: 'body/size', message: `At most ${SAFETY_LIMITS.size} characters.` })
    const garment = garmentTouched ? await planGarment(tools.tx, asked, { companyId: row.companyId, partyId: row.partyId }, problems, warnings) : null
    const occurredOn = body.occurredOn === undefined ? dayOrNull(row.occurredOn) : body.occurredOn
    if (occurredOn && occurredOn > businessDate(row.receivedAt)) problems.push({ path: 'body/occurredOn', message: 'It happened on or before the day the report reached us.' })
    if (body.ownerId !== undefined && body.ownerId !== null) problems.push(...(await safetyOwnerProblems(tools.tx, context, body.ownerId, row, tools.now)))
    if (problems.length > 0) refuse(problems, 'The safety report cannot be changed like this.')
    const data: Prisma.ProductSafetyReportUncheckedUpdateInput = {
      ...(garment ? { styleId: garment.styleId, colourwayId: garment.colourwayId, size: garment.size, serial: garment.serial, garmentSerial: garment.garmentSerial, batchNumber: garment.batchNumber, garmentBatch: garment.garmentBatch } : {}),
      ...(body.occurredOn !== undefined ? { occurredOn: body.occurredOn ? asDay(body.occurredOn) : null } : {}),
      ...(body.wornAsIntended !== undefined ? { wornAsIntended: body.wornAsIntended } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
    }
    const fields = CHANGE_FIELDS.filter((field) => body[field] !== undefined)
    if (fields.length === 0) return { warnings }
    const written = await touchReport(tools, row, data)
    tools.audit({
      action: 'safetyReports.change',
      recordType: SAFETY_REPORT_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { styleId: row.styleId, colourwayId: row.colourwayId, size: row.size, serial: row.serial, garmentSerial: row.garmentSerial, batchNumber: row.batchNumber, garmentBatch: row.garmentBatch, occurredOn: dayOrNull(row.occurredOn), wornAsIntended: row.wornAsIntended, ownerId: row.ownerId },
      after: { styleId: written.styleId, colourwayId: written.colourwayId, size: written.size, serial: written.serial, garmentSerial: written.garmentSerial, batchNumber: written.batchNumber, garmentBatch: written.garmentBatch, occurredOn: dayOrNull(written.occurredOn), wornAsIntended: written.wornAsIntended, ownerId: written.ownerId },
    })
    tools.emit({ type: 'safety_report.changed', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, fields: [...fields] } })
    return { warnings }
  })
  return { report: await reportRecordOf(caller, seen.id), warnings: result.warnings }
}

/** POST /sales/safety-reports/:reportId/seen — quality saw it (who and when, once). */
export async function markSeen(caller: CommandCaller, reportId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ report: ReportView }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_MANAGE)
  await command(caller, { name: 'safetyReports.seen', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version)
    if (row.seenAt) throw held('SEEN', row.number)
    await touchReport(tools, row, { seenAt: tools.now, seenById: context.actorId })
    tools.audit({ action: 'safetyReports.seen', recordType: SAFETY_REPORT_RECORD, recordId: row.id, companyId: row.companyId, before: { seenAt: null }, after: { seenAt: tools.now.toISOString(), seenById: context.actorId } })
    tools.emit({ type: 'safety_report.status_changed', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, from: row.status as ReportStatus, to: row.status as ReportStatus, seen: true } })
    return null
  })
  return { report: await reportRecordOf(caller, seen.id) }
}

/** POST /sales/safety-reports/:reportId/status {version, to, note?} — assessing (seen with it, when not yet), or closed with words. */
export async function moveReport(caller: CommandCaller, reportId: string, body: { readonly version: number; readonly to: MoveTarget; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ report: ReportView }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_MANAGE)
  await command(caller, { name: 'safetyReports.move', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version, { closedToo: true })
    const code = moveHeld(row.status as ReportStatus, body.to)
    if (code) throw held(code, row.number)
    if (body.to === 'CLOSED') {
      const problems = closeProblems(body.note)
      if (problems.length > 0) refuse(problems, 'The safety report cannot be closed like this.')
    }
    const seeing = row.seenAt === null
    const data: Prisma.ProductSafetyReportUncheckedUpdateInput = {
      status: body.to,
      ...(seeing ? { seenAt: tools.now, seenById: context.actorId } : {}),
      ...(body.to === 'CLOSED' ? { closedAt: tools.now, closedById: context.actorId, closeNote: body.note!.trim() } : {}),
    }
    await touchReport(tools, row, data)
    tools.audit({
      action: 'safetyReports.move',
      recordType: SAFETY_REPORT_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { status: row.status },
      after: { status: body.to, ...(seeing ? { seenById: context.actorId } : {}), ...(body.to === 'CLOSED' ? { closedById: context.actorId, closeNote: 'set' } : {}) },
    })
    tools.emit({ type: 'safety_report.status_changed', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, from: row.status as ReportStatus, to: body.to, seen: true } })
    return null
  })
  return { report: await reportRecordOf(caller, seen.id) }
}

/**
 * POST /sales/safety-reports/:reportId/register-entry {version, registerEntryId?} — filed in the PPE register, once: an entry of
 * the report's company (and style, when both name one), or a NEW COMPLAINT entry opened for it through W1's hook (source
 * ProductSafetyReport; the description names the report, never the reporter's words; opening needs compliance.register.manage
 * and a style on the report).
 */
export async function fileReport(caller: CommandCaller, reportId: string, body: { readonly version: number; readonly registerEntryId?: string | null | undefined }, idempotencyKey?: string): Promise<{ report: ReportView; registerEntry: { id: string; reference: string; opened: boolean } }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_MANAGE)
  const naming = blank(body.registerEntryId)
  if (!naming && !mayOn(context, REGISTER_MANAGE, { companyId: seen.companyId, partyId: null })) throw new ForbiddenError('Opening a PPE register entry needs the register (compliance.register.manage); name an existing entry, or ask quality.')
  const { result } = await command(caller, { name: 'safetyReports.file', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version)
    if (row.registerEntryId) throw held('FILED', row.number)
    let entry: { id: string; reference: string; opened: boolean }
    if (naming) {
      const found = isUuid(naming) ? await tools.tx.ppeRegisterEntry.findUnique({ where: { id: naming }, select: { id: true, reference: true, companyId: true, styleId: true } }) : null
      if (!found || found.companyId !== row.companyId) throw new NotFoundError('Register entry not found.')
      if (row.styleId && found.styleId !== row.styleId) refuse([{ path: 'body/registerEntryId', message: `Entry ${found.reference} is of another style.` }], 'The safety report cannot be filed there.')
      entry = { id: found.id, reference: found.reference, opened: false }
    } else {
      if (!row.styleId) throw held('NO_STYLE', row.number)
      const order = row.garmentBatch ? await tools.tx.workOrder.findFirst({ where: { batchNumber: row.garmentBatch, companyId: row.companyId, styleId: row.styleId }, select: { id: true } }) : null
      const opened = await openRegisterEntryFor(tools, {
        companyId: row.companyId,
        kind: 'COMPLAINT',
        styleId: row.styleId,
        workOrderIds: order ? [order.id] : [],
        serials: row.garmentSerial ? [row.garmentSerial] : [],
        batchNumbers: row.garmentBatch ? [row.garmentBatch] : row.batchNumber ? [row.batchNumber] : [],
        description: registerDescriptionOf({ number: row.number, source: row.source as SafetySource, receivedOn: businessDate(row.receivedAt), serial: row.garmentSerial ?? row.serial, batchNumber: row.garmentBatch ?? row.batchNumber }),
        reportedAt: row.receivedAt,
        source: { type: 'ProductSafetyReport', id: row.id },
        partyId: row.partyId,
      })
      entry = { id: opened.entryId, reference: opened.reference, opened: opened.opened }
    }
    await touchReport(tools, row, { registerEntryId: entry.id })
    tools.audit({ action: 'safetyReports.file', recordType: SAFETY_REPORT_RECORD, recordId: row.id, companyId: row.companyId, before: { registerEntryId: null }, after: { registerEntryId: entry.id, opened: entry.opened } })
    tools.emit({ type: 'safety_report.filed', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, registerEntryId: entry.id, opened: entry.opened } })
    return entry
  })
  return { report: await reportRecordOf(caller, seen.id), registerEntry: result }
}

/** POST /sales/safety-reports/:reportId/erase {version, what: REPORTER, reason} — the reporter's personal data blanked (also once closed). */
export async function eraseReporter(caller: CommandCaller, reportId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ report: ReportView }> {
  const { row: seen } = await officeReport(caller, reportId, SALES_SAFETY_MANAGE)
  const problems = eraseReasonProblems(body.reason)
  if (problems.length > 0) refuse(problems, 'The erasure needs its reason.')
  await command(caller, { name: 'safetyReports.eraseReporter', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version, { closedToo: true })
    if (row.reporterName === null && row.reporterEmail === null && row.reporterPhone === null) throw held('NOTHING_TO_ERASE', row.number)
    await touchReport(tools, row, { reporterName: null, reporterEmail: null, reporterPhone: null })
    tools.audit({
      action: 'safetyReports.eraseReporter',
      recordType: SAFETY_REPORT_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { reporterName: row.reporterName ? 'set' : null, reporterEmail: row.reporterEmail ? 'set' : null, reporterPhone: row.reporterPhone ? 'set' : null },
      after: { reporterName: null, reporterEmail: null, reporterPhone: null },
      reason: body.reason.trim(),
    })
    tools.emit({ type: 'safety_report.erased', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, what: 'REPORTER' } })
    return null
  })
  return { report: await reportRecordOf(caller, seen.id) }
}

