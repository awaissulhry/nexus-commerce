import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { absenceCodeProblems, missingStandardCodes, STANDARD_ABSENCE_CODES, type AbsenceCategory } from '@nexus/factory-domain/people/attendance/absences'
import { PEOPLE_ATTENDANCE_SETTINGS } from '@nexus/factory-domain/people/attendance/permissions'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertVersion, officeOf, refuse } from '../employees/access'
import type { CreateCodeBody, EditCodeBody } from './contract'
import type { Client } from './store'

/**
 * Absence codes (B-W2b-37; MES-228; design people.settings "Absence codes" and the pop-up "Absence code"), office only.
 * Settings, not a person's data: no legal gate. people.attendance.view reads (the attendance screens pick codes);
 * people.attendance.settings writes. A code is of one company or of the whole group (tenant-wide: written only by a role
 * over every company); its code and company never change; archived, never deleted (the days that use it keep it).
 *
 *   GET  /people/attendance/absence-codes                     the codes in reach, how many days use each, the standard
 *                                                             codes not added yet
 *   POST /people/attendance/absence-codes                     a new code
 *   PATCH /people/attendance/absence-codes/:codeId            its names, category, the consultant's LUL code, paid, document
 *   POST /people/attendance/absence-codes/:codeId/archive     no longer offered (the days that use it keep it)
 *   POST /people/attendance/absence-codes/:codeId/restore     offered again
 *   POST /people/attendance/absence-codes/standard            "Start from the standard list": the missing standard codes
 */

const CODE_SELECT = { id: true, companyId: true, code: true, labelI18n: true, category: true, lulCode: true, paid: true, documentRequired: true, status: true, version: true } as const satisfies Prisma.AbsenceCodeSelect
type CodeRow = Prisma.AbsenceCodeGetPayload<{ select: typeof CODE_SELECT }>

const SETTINGS_WORDS = 'Absence codes are kept by a role with people.attendance.settings.'

const mayRead = (context: OfficeContext, row: { companyId: string | null }) => can(actorOf(context), PEOPLE_ATTENDANCE_VIEW, row.companyId ? { companyId: row.companyId } : {}) || can(actorOf(context), PEOPLE_ATTENDANCE_SETTINGS, row.companyId ? { companyId: row.companyId } : {})

function mayWrite(context: OfficeContext, companyId: string | null): boolean {
  if (companyId) return can(actorOf(context), PEOPLE_ATTENDANCE_SETTINGS, { companyId })
  return grantsFor(actorOf(context), PEOPLE_ATTENDANCE_SETTINGS).some((grant) => grant.companies === 'all')
}

const GROUP_WORDS = 'An absence code of the whole group is kept by a role over every company; add it to one company instead.'

async function inUseOf(db: Client, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await db.absenceEntry.groupBy({ by: ['codeId'], where: { codeId: { in: [...ids] } }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.codeId, row._count._all]))
}

const view = (row: CodeRow, inUse: number) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  labelI18n: row.labelI18n as Record<string, string>,
  category: row.category as AbsenceCategory,
  lulCode: row.lulCode,
  paid: row.paid,
  documentRequired: row.documentRequired,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
  inUse,
  version: row.version,
})

function problemsOrThrow(problems: Issue[]): void {
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

const isUnique = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

export async function listCodes(caller: CommandCaller, query: { companyId?: string | undefined; status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const status = query.status ?? 'ACTIVE'
    const rows = await db.absenceCode.findMany({
      where: { ...(status === 'ALL' ? {} : { status }), ...(query.companyId ? { OR: [{ companyId: null }, { companyId: query.companyId }] } : {}) },
      select: CODE_SELECT,
      orderBy: [{ code: 'asc' }],
    })
    const visible = rows.filter((row) => mayRead(context, row))
    const all = await db.absenceCode.findMany({ select: { code: true } })
    const inUse = await inUseOf(db, visible.map((row) => row.id))
    return {
      codes: visible.map((row) => view(row, inUse.get(row.id) ?? 0)),
      standardMissing: missingStandardCodes(all.map((row) => row.code)).map((entry) => entry.code),
      words: ["A sickness or an injury is a code and, when needed, the certificate's protocol number: never a diagnosis (GDPR art. 9)."],
    }
  })
}

function emitCode(tools: CommandTools, row: { id: string | null; companyId: string | null }, change: 'CREATED' | 'EDITED' | 'ARCHIVED' | 'RESTORED' | 'STANDARD', codes = 1): void {
  const subject = row.id ?? row.companyId ?? ('tenantId' in tools.context ? tools.context.tenantId : 'tenant')
  tools.emit({ type: 'absence_code.changed', subject, companyId: row.companyId, payload: { absenceCodeId: row.id, companyId: row.companyId, change, codes } })
}

export async function createCode(caller: CommandCaller, body: CreateCodeBody, key?: string) {
  const context = officeOf(caller)
  problemsOrThrow(absenceCodeProblems(body, true))
  if (!mayWrite(context, body.companyId)) throw new ForbiddenError(body.companyId ? SETTINGS_WORDS : GROUP_WORDS)
  try {
    const { result, replayed } = await command(caller, { name: 'people.createAbsenceCode', idempotencyKey: key, input: body }, async (tools) => {
      if (body.companyId && !(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
      const id = newId()
      const row = await tools.tx.absenceCode.create({
        data: { id, companyId: body.companyId, code: body.code, labelI18n: body.labelI18n, category: body.category, lulCode: body.lulCode ?? null, paid: body.paid, documentRequired: body.documentRequired ?? false, createdById: context.actorId },
        select: CODE_SELECT,
      })
      tools.audit({ recordType: 'AbsenceCode', recordId: id, companyId: body.companyId, after: { code: row.code, category: row.category, lulCode: row.lulCode, paid: row.paid, documentRequired: row.documentRequired } })
      emitCode(tools, row, 'CREATED')
      return view(row, 0)
    })
    return { created: !replayed, answer: result }
  } catch (error) {
    if (isUnique(error)) refuse('CODE_TAKEN', `Absence code ${body.code} exists already: codes are unique across the group.`, 'code')
    throw error
  }
}

async function codeForWrite(db: Client, context: OfficeContext, codeId: string): Promise<CodeRow> {
  const row = isUuid(codeId) ? await db.absenceCode.findUnique({ where: { id: codeId }, select: CODE_SELECT }) : null
  if (!row || !mayRead(context, row)) throw new NotFoundError('Absence code not found.')
  if (!mayWrite(context, row.companyId)) throw new ForbiddenError(row.companyId ? SETTINGS_WORDS : GROUP_WORDS)
  return row
}

export async function editCode(caller: CommandCaller, codeId: string, body: EditCodeBody, key?: string) {
  const context = officeOf(caller)
  problemsOrThrow(absenceCodeProblems(body, false))
  await caller.withClient((db) => codeForWrite(db, context, codeId))
  const { result } = await command(caller, { name: 'people.editAbsenceCode', idempotencyKey: key, input: { codeId, ...body } }, async (tools) => {
    const before = await codeForWrite(tools.tx, context, codeId)
    assertVersion('absence code', before.version, body.version)
    const data = {
      ...(body.labelI18n !== undefined ? { labelI18n: body.labelI18n } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.lulCode !== undefined ? { lulCode: body.lulCode } : {}),
      ...(body.paid !== undefined ? { paid: body.paid } : {}),
      ...(body.documentRequired !== undefined ? { documentRequired: body.documentRequired } : {}),
    }
    const row = await tools.tx.absenceCode.update({ where: { id: codeId }, data: { ...data, version: { increment: 1 } }, select: CODE_SELECT })
    tools.audit({ recordType: 'AbsenceCode', recordId: codeId, companyId: row.companyId, before: { labelI18n: before.labelI18n, category: before.category, lulCode: before.lulCode, paid: before.paid, documentRequired: before.documentRequired }, after: data })
    emitCode(tools, row, 'EDITED')
    return view(row, (await inUseOf(tools.tx, [codeId])).get(codeId) ?? 0)
  })
  return result
}

export async function setCodeState(caller: CommandCaller, codeId: string, body: { version: number }, to: 'ACTIVE' | 'ARCHIVED', key?: string) {
  const context = officeOf(caller)
  await caller.withClient((db) => codeForWrite(db, context, codeId))
  const { result } = await command(caller, { name: to === 'ACTIVE' ? 'people.restoreAbsenceCode' : 'people.archiveAbsenceCode', idempotencyKey: key, input: { codeId, ...body } }, async (tools) => {
    const before = await codeForWrite(tools.tx, context, codeId)
    assertVersion('absence code', before.version, body.version)
    if (before.status === to) refuse(to === 'ACTIVE' ? 'ALREADY_ACTIVE' : 'ALREADY_ARCHIVED', to === 'ACTIVE' ? 'This absence code is in use already.' : 'This absence code is archived already.')
    const row = await tools.tx.absenceCode.update({ where: { id: codeId }, data: { status: to, version: { increment: 1 } }, select: CODE_SELECT })
    tools.audit({ recordType: 'AbsenceCode', recordId: codeId, companyId: row.companyId, before: { status: before.status }, after: { status: to } })
    emitCode(tools, row, to === 'ACTIVE' ? 'RESTORED' : 'ARCHIVED')
    return view(row, (await inUseOf(tools.tx, [codeId])).get(codeId) ?? 0)
  })
  return result
}

/** "Start from the standard list": the standard codes the tenant does not have yet, for a company or the whole group. */
export async function addStandardCodes(caller: CommandCaller, body: { companyId: string | null }, key?: string) {
  const context = officeOf(caller)
  if (!mayWrite(context, body.companyId)) throw new ForbiddenError(body.companyId ? SETTINGS_WORDS : GROUP_WORDS)
  const { result } = await command(caller, { name: 'people.addStandardAbsenceCodes', idempotencyKey: key, input: body }, async (tools) => {
    if (body.companyId && !(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const have = await tools.tx.absenceCode.findMany({ select: { code: true } })
    const missing = missingStandardCodes(have.map((row) => row.code))
    const added = []
    for (const entry of missing) {
      const id = newId()
      const row = await tools.tx.absenceCode.create({ data: { id, companyId: body.companyId, code: entry.code, labelI18n: { it: entry.it, en: entry.en }, category: entry.category, lulCode: null, paid: entry.paid, documentRequired: entry.documentRequired, createdById: context.actorId }, select: CODE_SELECT })
      tools.audit({ recordType: 'AbsenceCode', recordId: id, companyId: body.companyId, after: { code: entry.code, category: entry.category, standard: true } })
      added.push(view(row, 0))
    }
    if (added.length > 0) emitCode(tools, { id: null, companyId: body.companyId }, 'STANDARD', added.length)
    else tools.audit({ action: 'people.addStandardAbsenceCodes', recordType: 'Company', recordId: body.companyId ?? context.tenantId, after: { added: 0 } })
    return { added, skipped: STANDARD_ABSENCE_CODES.filter((entry) => !missing.includes(entry)).map((entry) => entry.code) }
  })
  return result
}
