import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { definitionProblems, LAYOUT_STARTERS, parseDefinition, PAYROLL_TO_CONFIRM, STARTERS, storedDefinition, type LayoutDefinition, type PayrollFormat } from '@nexus/factory-domain/people/payroll/layouts'
import { PEOPLE_PAYROLL_MANAGE, PEOPLE_PAYROLL_VIEW } from '@nexus/factory-domain/people/payroll/permissions'
import type { Prisma } from '@nexus/factory-db'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import type { Client } from '../attendance/store'
import { companyFor, placeOf, reachesCompany } from '../close/store'
import { assertVersion, dateOf, officeOf, problemsError } from '../employees/access'
import { payGuarded } from '../piecerates/access'
import type { CreateLayoutBody, LayoutsQuery, PatchLayoutBody } from './contract'
import { confirmationOfRow, LAYOUT_SELECT, layoutState, refusePayroll, type LayoutRow } from './store'

/**
 * Payroll file layouts (B-W2b-54; MES-268, MES-270; GATE-PAYROLL; design people.payroll pop-up "CSV columns": column order, headers,
 * number and date formats, saved per consultant). A layout is the company's data. A starter fills one in; the consultant's
 * sample replaces the Zucchetti starter by a plain edit, and whoever checked it records that (`confirmation`: the columns
 * confirmedOn, confirmedByName (the name the consultant goes by, typed) and confirmedById (the office user who recorded it),
 * B-W2b-89). A layout is archived, never deleted. An export keeps the layout as it used it. The company's payroll code is
 * Company.payrollCode (People settings › Payroll and statements), never a layout's.
 */

function viewOf(row: LayoutRow) {
  const definition = storedDefinition(parseDefinition(row.definition))
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    format: row.format as PayrollFormat,
    provider: row.provider,
    definition: { ...definition, columns: [...definition.columns] },
    confirmation: confirmationOfRow(row),
    status: row.status,
    note: row.note,
    ...layoutState(row),
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
  }
}

const manageWords = 'Payroll layouts need people.payroll.manage over every site of the company.'

/** GET /people/payroll/layouts. */
export async function listLayouts(caller: CommandCaller, query: LayoutsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, [PEOPLE_PAYROLL_VIEW])
    const rows = await db.payrollExportLayout.findMany({ where: { companyId: place.company.id }, select: LAYOUT_SELECT, orderBy: [{ status: 'asc' }, { name: 'asc' }] })
    return { companyId: place.company.id, layouts: rows.map(viewOf), starters: LAYOUT_STARTERS.map((key) => ({ key, name: STARTERS[key].name, format: STARTERS[key].format, provider: STARTERS[key].provider, note: STARTERS[key].note })), toConfirm: [...PAYROLL_TO_CONFIRM] }
  })
}

function assertDefinition(format: PayrollFormat, definition: LayoutDefinition): void {
  const problems = definitionProblems(format, definition)
  if (problems.length > 0) throw problemsError(problems, 'This layout is not valid.')
}

async function placeFor(caller: CommandCaller, context: OfficeContext, companyId: string): Promise<void> {
  await caller.withClient(async (db) => {
    const place = await companyFor(db, context, companyId, [PEOPLE_PAYROLL_VIEW])
    if (!reachesCompany(context, place, [PEOPLE_PAYROLL_MANAGE])) throw new ForbiddenError(manageWords)
  })
}

async function nameFree(db: Client, companyId: string, name: string, other?: string): Promise<void> {
  const taken = await db.payrollExportLayout.findFirst({ where: { companyId, name, ...(other ? { id: { not: other } } : {}) }, select: { id: true } })
  if (taken) refusePayroll('NAME_TAKEN', `This company already has a layout called ${name}.`, 'name')
}

/** POST /people/payroll/layouts: from a starter, or the whole layout. */
export async function createLayout(caller: CommandCaller, body: CreateLayoutBody, key?: string) {
  const context = officeOf(caller)
  await placeFor(caller, context, body.companyId)
  const starter = body.starter ? STARTERS[body.starter] : null
  const name = body.name ?? starter?.name
  const format = body.format ?? starter?.format
  const given = (body.definition ?? starter?.definition) as LayoutDefinition | undefined
  const definition = given ? storedDefinition(given) : undefined
  if (!name || !format || !definition) throw new ValidationError('Name a starter, or give the layout its name, format and columns.', [{ path: 'body/starter', message: 'Name a starter, or give name, format and definition.' }])
  assertDefinition(format, definition)
  const provider = body.provider === undefined ? (starter?.provider ?? null) : body.provider
  const { result } = await command(caller, { name: 'people.createPayrollLayout', idempotencyKey: key, input: body }, async (tools) => {
    const { tx, now } = tools
    await nameFree(tx, body.companyId, name)
    const id = newId()
    const row = await payGuarded(() => tx.payrollExportLayout.create({ data: { id, companyId: body.companyId, name, format, provider, definition: definition as unknown as Prisma.InputJsonValue, note: body.note ?? starter?.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId }, select: LAYOUT_SELECT }))
    tools.audit({ recordType: 'PayrollExportLayout', recordId: id, companyId: body.companyId, after: { name, format, provider, columns: definition.columns.length } })
    tools.emit({ type: 'payroll_layout.changed', subject: id, companyId: body.companyId, payload: { layoutId: id, companyId: body.companyId, change: 'CREATED' } })
    return viewOf(row)
  })
  return result
}

async function readForChange(caller: CommandCaller, context: OfficeContext, layoutId: string): Promise<LayoutRow> {
  return caller.withClient(async (db) => {
    const row = await db.payrollExportLayout.findUnique({ where: { id: layoutId }, select: LAYOUT_SELECT })
    const place = row ? await placeOf(db, row.companyId) : null
    if (!row || !place || !reachesCompany(context, place, [PEOPLE_PAYROLL_VIEW])) throw new NotFoundError('Layout not found.')
    if (!reachesCompany(context, place, [PEOPLE_PAYROLL_MANAGE])) throw new ForbiddenError(manageWords)
    return row
  })
}

/**
 * PATCH /people/payroll/layouts/:layoutId. A changed record loses its confirmation unless the same edit gives it again; the
 * confirmation is the day, the consultant's name as typed, and the office user recording it.
 */
export async function patchLayout(caller: CommandCaller, layoutId: string, body: PatchLayoutBody, key?: string) {
  const context = officeOf(caller)
  const row = await readForChange(caller, context, layoutId)
  assertVersion('layout', row.version, body.version)
  const before = parseDefinition(row.definition)
  const definition: LayoutDefinition = storedDefinition(body.definition ?? before)
  assertDefinition(row.format as PayrollFormat, definition)
  const wasConfirmed = row.confirmedOn !== null
  const confirmation = body.confirmation
    ? { confirmedOn: dateOf(body.confirmation.on), confirmedByName: body.confirmation.by, confirmedById: context.actorId }
    : body.confirmation === null || body.definition
      ? { confirmedOn: null, confirmedByName: null, confirmedById: null }
      : {}
  const confirmed = body.confirmation ? true : body.confirmation === null || body.definition ? false : wasConfirmed
  const { result } = await command(caller, { name: 'people.editPayrollLayout', idempotencyKey: key, input: { layoutId, ...body }, record: { type: 'PayrollExportLayout', id: layoutId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    if (body.name) await nameFree(tx, row.companyId, body.name, row.id)
    const updated = await payGuarded(() =>
      tx.payrollExportLayout.update({ where: { id: layoutId }, data: { ...(body.name ? { name: body.name } : {}), ...(body.provider !== undefined ? { provider: body.provider } : {}), ...(body.note !== undefined ? { note: body.note } : {}), definition: definition as unknown as Prisma.InputJsonValue, ...confirmation, updatedAt: now }, select: LAYOUT_SELECT }),
    )
    tools.audit({ recordType: 'PayrollExportLayout', recordId: layoutId, companyId: row.companyId, before: { name: row.name, provider: row.provider, columns: before.columns.length, confirmed: wasConfirmed }, after: { name: updated.name, provider: updated.provider, columns: definition.columns.length, confirmed, ...(body.confirmation ? { confirmation: body.confirmation } : {}) } })
    tools.emit({ type: 'payroll_layout.changed', subject: layoutId, companyId: row.companyId, payload: { layoutId, companyId: row.companyId, change: 'EDITED' } })
    return viewOf(updated)
  })
  return result
}

/** POST /people/payroll/layouts/:layoutId/archive: no new export uses it; the exports that did keep their copy. */
export async function archiveLayout(caller: CommandCaller, layoutId: string, body: { readonly version: number }, key?: string) {
  const context = officeOf(caller)
  const row = await readForChange(caller, context, layoutId)
  assertVersion('layout', row.version, body.version)
  if (row.status !== 'ACTIVE') refusePayroll('LAYOUT_ARCHIVED', 'This layout is archived already.')
  const { result } = await command(caller, { name: 'people.archivePayrollLayout', idempotencyKey: key, input: { layoutId, ...body }, record: { type: 'PayrollExportLayout', id: layoutId, expectedVersion: body.version } }, async (tools) => {
    const updated = await tools.tx.payrollExportLayout.update({ where: { id: layoutId }, data: { status: 'ARCHIVED', updatedAt: tools.now }, select: LAYOUT_SELECT })
    tools.audit({ recordType: 'PayrollExportLayout', recordId: layoutId, companyId: row.companyId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'payroll_layout.changed', subject: layoutId, companyId: row.companyId, payload: { layoutId, companyId: row.companyId, change: 'ARCHIVED' } })
    return viewOf(updated)
  })
  return result
}
