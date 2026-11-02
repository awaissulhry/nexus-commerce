import { ConflictError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { CODE_MEANINGS, codeOrder, fixedCodes, mappingKey, PAYROLL_CODE_KINDS, type PayrollCodeKind } from '@nexus/factory-domain/people/payroll/codes'
import { PEOPLE_PAYROLL_MANAGE, PEOPLE_PAYROLL_VIEW } from '@nexus/factory-domain/people/payroll/permissions'
import { command, type CommandCaller } from '../../../core/command'
import type { Client } from '../attendance/store'
import { companyFor } from '../close/store'
import { officeOf } from '../employees/access'
import type { CodesQuery, PutCodeBody } from './contract'
import { mayDo, refusePayroll } from './store'

/**
 * The code mapping (B-W2b-54; MES-271; design people.payroll "3 · Code mapping": our hour types, absence codes and earning types
 * → the provider's codes, per company; inline edit with autosave, unmapped rows first). A code with no row yet reads as not
 * mapped; the first save writes its row. A mapping is never deleted.
 */

const SELECT = { id: true, kind: true, ourCode: true, meaning: true, providerCode: true, updatedAt: true, version: true } as const

interface CodeRow {
  readonly id: string | null
  readonly kind: PayrollCodeKind
  readonly ourCode: string
  readonly meaning: string
  readonly providerCode: string | null
  readonly inUse: boolean
  readonly updatedAt: string | null
  readonly version: number | null
}

async function absenceCodes(db: Client, companyId: string) {
  const rows = await db.absenceCode.findMany({ where: { status: 'ACTIVE', OR: [{ companyId }, { companyId: null }] }, select: { code: true, labelI18n: true } })
  return new Map(rows.map((row) => [row.code, (row.labelI18n as { en?: string; it?: string } | null)?.en ?? (row.labelI18n as { it?: string } | null)?.it ?? row.code]))
}

/** Every code the company can use, and every row it holds. */
async function codeRows(db: Client, companyId: string): Promise<CodeRow[]> {
  const absences = await absenceCodes(db, companyId)
  const rows = await db.payrollCodeMapping.findMany({ where: { companyId, status: 'ACTIVE' }, select: SELECT })
  const known = new Map<string, Omit<CodeRow, 'id' | 'providerCode' | 'updatedAt' | 'version'>>()
  for (const kind of PAYROLL_CODE_KINDS) for (const code of fixedCodes(kind)) known.set(mappingKey(kind, code), { kind, ourCode: code, meaning: CODE_MEANINGS[code].en, inUse: true })
  for (const [code, meaning] of absences) known.set(mappingKey('ABSENCE', code), { kind: 'ABSENCE', ourCode: code, meaning, inUse: true })
  const held = new Map(rows.map((row) => [mappingKey(row.kind as PayrollCodeKind, row.ourCode), row]))
  const out: CodeRow[] = []
  for (const [key, code] of known) {
    const row = held.get(key)
    out.push({ ...code, meaning: row?.meaning ?? code.meaning, id: row?.id ?? null, providerCode: row?.providerCode ?? null, updatedAt: row ? toUtcIso(row.updatedAt) : null, version: row?.version ?? null })
  }
  for (const [key, row] of held) if (!known.has(key)) out.push({ id: row.id, kind: row.kind as PayrollCodeKind, ourCode: row.ourCode, meaning: row.meaning, providerCode: row.providerCode, inUse: false, updatedAt: toUtcIso(row.updatedAt), version: row.version })
  return out
}

const unmappedFirst = (a: CodeRow, b: CodeRow): number => Number(a.providerCode !== null) - Number(b.providerCode !== null) || codeOrder({ kind: a.kind, code: a.ourCode }, { kind: b.kind, code: b.ourCode })

/** GET /people/payroll/codes: unmapped rows first. */
export async function listCodes(caller: CommandCaller, query: CodesQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, [PEOPLE_PAYROLL_VIEW])
    const codes = (await codeRows(db, place.company.id)).sort(unmappedFirst)
    return { companyId: place.company.id, codes, unmapped: codes.filter((row) => row.inUse && row.providerCode === null).length }
  })
}

/** PUT /people/payroll/codes: one code's provider code (null: not mapped again). */
export async function putCode(caller: CommandCaller, body: PutCodeBody, key?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient(async (db) => {
    const place = await companyFor(db, context, body.companyId, [PEOPLE_PAYROLL_VIEW])
    if (!mayDo(context, place, PEOPLE_PAYROLL_MANAGE)) throw new ForbiddenError('The code mapping needs people.payroll.manage over every site of the company.')
    return (await codeRows(db, place.company.id)).find((row) => row.kind === body.kind && row.ourCode === body.ourCode)
  })
  const code = known ?? refusePayroll('NOT_OUR_CODE', `${body.ourCode} is not one of our ${body.kind.toLowerCase()} codes.`, 'ourCode')
  if (code.id !== null && body.version === undefined) throw new ValidationError('A code already mapped is changed with the version read.', [{ path: 'body/version', message: 'Send the version read.' }])
  const meaning = body.meaning ?? code.meaning
  const { result } = await command(caller, { name: 'people.mapPayrollCode', idempotencyKey: key, input: body }, async (tools) => {
    const { tx, now } = tools
    const before = { providerCode: code.providerCode, meaning: code.meaning }
    if (code.id === null) {
      // Two people mapping one new code: the second hits the unique key and is told to read again.
      await tx.payrollCodeMapping.create({ data: { id: newId(), companyId: body.companyId, kind: body.kind, ourCode: body.ourCode, meaning, providerCode: body.providerCode, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    } else {
      const { count } = await tx.payrollCodeMapping.updateMany({ where: { id: code.id, version: body.version! }, data: { providerCode: body.providerCode, meaning, updatedAt: now, version: { increment: 1 } } })
      if (count !== 1) throw new ConflictError('This code changed since you read it: read it again.')
    }
    const row = await tx.payrollCodeMapping.findFirstOrThrow({ where: { companyId: body.companyId, kind: body.kind, ourCode: body.ourCode }, select: SELECT })
    tools.audit({ recordType: 'PayrollCodeMapping', recordId: row.id, companyId: body.companyId, before, after: { kind: body.kind, ourCode: body.ourCode, providerCode: body.providerCode, meaning } })
    tools.emit({ type: 'payroll_code.changed', subject: row.id, companyId: body.companyId, payload: { companyId: body.companyId, kind: body.kind, ourCode: body.ourCode } })
    return { id: row.id, kind: body.kind, ourCode: row.ourCode, meaning: row.meaning, providerCode: row.providerCode, inUse: code.inUse, updatedAt: toUtcIso(row.updatedAt), version: row.version }
  })
  return result
}
