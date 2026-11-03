import type { CheckIntervalUnit as DbCheckIntervalUnit, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { mergedWords } from '@nexus/factory-domain/plant/rules'
import { PLANT_CHECKS_MANAGE } from '@nexus/factory-domain/plant/statutory/permissions'
import { CHECK_LIMITS, checkTypeProblems, LEAST_RETENTION_YEARS, tooManyTypes, typeTaken, type CheckIntervalUnit } from '@nexus/factory-domain/plant/statutory/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertVersion, bodyIssue, officeOf, problemsError } from '../access'
import { wordsOf } from '../store'
import { byOrder, refuse, type Reader, TYPE_COLUMNS, type TypeRow, typeView } from './store'

/**
 * The statutory check types (B-W2b-124; QHS-205; design plant.settings "Statutory check types": check type, legal basis,
 * default interval, outside body, retention at least 3 years; "List edited in a modal"): the whole group's list
 * (tenant-wide; audit rows with companyId null). Reads need plant.view; every write plant.checks.manage over every company,
 * each one command() with the version read and `machine_check_type.changed`. A code, its class and the creation never
 * change; retired (active false), never deleted (the …_plant_care_w2b_guards say the same). The law is the office's words:
 * no interval of a law is built in (the plan gives none).
 *
 *   GET   /plant/checks/types                 the types in order, with their ACTIVE plans and results
 *   POST  /plant/checks/types                 a type (code, words, law, class, default interval, outside body, retention)
 *   PATCH /plant/checks/types/:checkTypeId    words, law, default interval, outside body, retention, order, retire / restore
 */

const tenantWide = { companyId: null, siteId: null } as const

const mayManage = (context: OfficeContext): boolean => mayWrite(actorOf(context), PLANT_CHECKS_MANAGE, null)

function assertManage(context: OfficeContext): void {
  if (!mayManage(context)) throw new ForbiddenError("The statutory check types are the whole group's: they are kept with plant.checks.manage over every company.")
}

async function useOf(db: Pick<Reader, 'machineCheckPlan' | 'machineCheckResult'>, ids?: readonly string[]) {
  const where = ids ? { checkTypeId: { in: [...ids] } } : {}
  const plans = new Map((await db.machineCheckPlan.groupBy({ by: ['checkTypeId'], where: { ...where, status: 'ACTIVE' }, _count: { _all: true } })).map((row) => [row.checkTypeId, row._count._all]))
  const results = new Map((await db.machineCheckResult.groupBy({ by: ['checkTypeId'], where, _count: { _all: true } })).map((row) => [row.checkTypeId, row._count._all]))
  return (id: string) => ({ plans: plans.get(id) ?? 0, results: results.get(id) ?? 0 })
}

function changed(tools: Pick<CommandTools, 'emit'>, row: Pick<TypeRow, 'id' | 'code'>, change: 'ADDED' | 'CHANGED' | 'RETIRED' | 'RESTORED'): void {
  tools.emit({ type: 'machine_check_type.changed', subject: row.id, ...tenantWide, payload: { checkTypeId: row.id, code: row.code, change } })
}

const audited = (row: TypeRow) => ({
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  legalBasis: row.legalBasis,
  classId: row.classId,
  defaultInterval: row.defaultInterval,
  defaultIntervalUnit: row.defaultIntervalUnit,
  outsideBody: row.outsideBody,
  retentionYears: row.retentionYears,
  sortOrder: row.sortOrder,
  active: row.active,
})

/** GET /plant/checks/types. */
export async function listCheckTypes(caller: CommandCaller, query: { readonly active?: boolean | undefined; readonly classId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const where: Prisma.MachineCheckTypeWhereInput = {
      ...(query.active !== undefined ? { active: query.active } : {}),
      // A machine's class: the types for it and the types for any machine.
      ...(query.classId ? { OR: [{ classId: query.classId }, { classId: null }] } : {}),
    }
    const rows = (await client.machineCheckType.findMany({ where, select: TYPE_COLUMNS })).sort(byOrder)
    const use = await useOf(client)
    return { types: rows.map((row) => typeView(row, use(row.id))), canManage: mayManage(context), leastRetentionYears: LEAST_RETENTION_YEARS }
  })
}

export interface TypeBody {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly legalBasis: string
  readonly classId?: string | null | undefined
  readonly defaultInterval: number
  readonly defaultIntervalUnit: CheckIntervalUnit
  readonly outsideBody?: boolean | undefined
  readonly retentionYears?: number | undefined
  readonly sortOrder?: number | undefined
}

/** POST /plant/checks/types. */
export async function createCheckType(caller: CommandCaller, body: TypeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context)
  const code = body.code.trim().toUpperCase()
  const problems = checkTypeProblems({ ...body, code }, true)
  if (problems.length > 0) throw problemsError(problems, 'The check type is not valid.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.createCheckType', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if ((await tx.machineCheckType.count()) >= CHECK_LIMITS.types) refuse(tooManyTypes())
    const taken = await tx.machineCheckType.findFirst({ where: { code }, select: { active: true } })
    if (taken) refuse(typeTaken(code, taken.active))
    if (body.classId) {
      const machineClass = await tx.machineClass.findFirst({ where: { id: body.classId }, select: { active: true } })
      if (!machineClass || !machineClass.active) throw bodyIssue('classId', 'Not an active machine class of the group (or leave it out: any machine).')
    }
    const last = await tx.machineCheckType.aggregate({ _max: { sortOrder: true } })
    const row = await tx.machineCheckType.create({
      data: {
        id,
        code,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedWords({}, body.labelI18n),
        legalBasis: body.legalBasis.trim(),
        classId: body.classId ?? null,
        defaultInterval: body.defaultInterval,
        defaultIntervalUnit: body.defaultIntervalUnit as DbCheckIntervalUnit,
        outsideBody: body.outsideBody ?? false,
        retentionYears: body.retentionYears ?? LEAST_RETENTION_YEARS,
        sortOrder: body.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: TYPE_COLUMNS,
    })
    tools.audit({ action: 'plant.createCheckType', recordType: 'MachineCheckType', recordId: id, ...tenantWide, after: audited(row) })
    changed(tools, row, 'ADDED')
    return { type: typeView(row, { plans: 0, results: 0 }) }
  })
  return { ...result, replayed }
}

export interface TypeChange extends Omit<Partial<TypeBody>, 'code' | 'classId'> {
  readonly version: number
  readonly active?: boolean | undefined
}

/** PATCH /plant/checks/types/:checkTypeId. */
export async function updateCheckType(caller: CommandCaller, checkTypeId: string, body: TypeChange, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context)
  const { result, replayed } = await command(caller, { name: 'plant.updateCheckType', idempotencyKey, input: { checkTypeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const [locked] = isUuid(checkTypeId) ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MachineCheckType" WHERE "id" = ${checkTypeId}::uuid FOR UPDATE` : []
    if (!locked) throw new NotFoundError('Check type not found.')
    const before = (await tx.machineCheckType.findUnique({ where: { id: checkTypeId }, select: TYPE_COLUMNS }))!
    assertVersion('check type', before.version, body.version)
    // The interval is checked whole: a new number with the unit it keeps, or a new unit with the number it keeps.
    const intervalChanges = body.defaultInterval !== undefined || body.defaultIntervalUnit !== undefined
    const problems = checkTypeProblems(
      {
        ...body,
        ...(intervalChanges ? { defaultInterval: body.defaultInterval ?? before.defaultInterval, defaultIntervalUnit: body.defaultIntervalUnit ?? (before.defaultIntervalUnit as CheckIntervalUnit) } : {}),
      },
      false,
    )
    if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
    const data: Prisma.MachineCheckTypeUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
    if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
    if (body.labelI18n !== undefined) data.labelI18n = mergedWords(wordsOf(before.labelI18n), body.labelI18n)
    if (body.legalBasis !== undefined) data.legalBasis = body.legalBasis.trim()
    if (body.defaultInterval !== undefined) data.defaultInterval = body.defaultInterval
    if (body.defaultIntervalUnit !== undefined) data.defaultIntervalUnit = body.defaultIntervalUnit as DbCheckIntervalUnit
    if (body.outsideBody !== undefined) data.outsideBody = body.outsideBody
    if (body.retentionYears !== undefined) data.retentionYears = body.retentionYears
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (body.active !== undefined) data.active = body.active
    const row = await tx.machineCheckType.update({ where: { id: checkTypeId }, data, select: TYPE_COLUMNS })
    tools.audit({ action: 'plant.updateCheckType', recordType: 'MachineCheckType', recordId: checkTypeId, ...tenantWide, before: audited(before), after: audited(row) })
    changed(tools, row, body.active === false && before.active ? 'RETIRED' : body.active === true && !before.active ? 'RESTORED' : 'CHANGED')
    return { type: typeView(row, (await useOf(tx, [row.id]))(row.id)) }
  })
  return { ...result, replayed }
}
