import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { codeProblems, mergedWords, PLANT_LIMITS, plantWordsProblems } from '@nexus/factory-domain/plant/rules'
import { missingStarter } from '@nexus/factory-domain/plant/starter'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertManageLists, assertVersion, bodyIssue, contextOf, mayManageLists, officeOf, problemsError } from '../access'
import { wordsOf } from '../store'

/**
 * The machine classes and the symptoms a station reports (B-W2a-35; QHS-162, QHS-178; design plant.machines "Type",
 * floor.machine "What is wrong?", plant.settings "Symptoms on the floor", SCR-241): one list each for the whole group
 * (tenant-wide; audit rows with companyId null). Reads need plant.view; every write plant.machines.manage over every
 * company, each one command() with the version read and one `plant.lists_changed`. A code, a symptom's class and the
 * creation never change; retired (active false), never deleted (the …_quality_plant_w2a_guards say the same).
 *
 *   GET   /plant/classes                 the classes in order, how many machines each, the starter codes missing
 *   POST  /plant/classes                 a class (code, words, icon, order)
 *   PATCH /plant/classes/:classId        words, icon, order, retire / make active again
 *   GET   /plant/symptoms[?classId=]     the symptoms (of a class: its own and every class's), how many requests each
 *   POST  /plant/symptoms                a symptom for a class or every class (unsafe: it marks the machine unsafe at once)
 *   PATCH /plant/symptoms/:symptomId     words, icon, colour, unsafe, note asked, order, retire / make active again
 *   POST  /plant/starter                 the starter set's missing classes and symptoms (factory-domain plant/starter)
 */

const CLASS_COLUMNS = { id: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, sortOrder: true, active: true, version: true, updatedAt: true } as const satisfies Prisma.MachineClassSelect
const SYMPTOM_COLUMNS = {
  id: true,
  code: true,
  classId: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  icon: true,
  colour: true,
  unsafe: true,
  needsDetail: true,
  sortOrder: true,
  active: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.MachineSymptomSelect
type ClassRow = Prisma.MachineClassGetPayload<{ select: typeof CLASS_COLUMNS }>
type SymptomRow = Prisma.MachineSymptomGetPayload<{ select: typeof SYMPTOM_COLUMNS }>
type Reader = Pick<CommandTx, 'machineClass' | 'machineSymptom' | 'machine' | 'maintenanceRequest'>

const classView = (row: ClassRow, machines: number) => ({
  id: row.id,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  sortOrder: row.sortOrder,
  active: row.active,
  machines,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

const symptomView = (row: SymptomRow, requests: number) => ({
  id: row.id,
  code: row.code,
  classId: row.classId,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  unsafe: row.unsafe,
  needsDetail: row.needsDetail,
  sortOrder: row.sortOrder,
  active: row.active,
  requests,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

const byOrder = (a: { sortOrder: number; code: string }, b: { sortOrder: number; code: string }) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

async function machinesPerClass(db: Reader): Promise<Map<string, number>> {
  return new Map((await db.machine.groupBy({ by: ['classId'], _count: { _all: true } })).map((row) => [row.classId, row._count._all]))
}

async function requestsPerSymptom(db: Reader): Promise<Map<string, number>> {
  const used = new Map<string, number>()
  for (const row of await db.maintenanceRequest.groupBy({ by: ['symptomId'], where: { symptomId: { not: null } }, _count: { _all: true } })) if (row.symptomId) used.set(row.symptomId, row._count._all)
  return used
}

function changed(tools: Pick<CommandTools, 'emit'>, list: 'CLASS' | 'SYMPTOM' | 'STARTER', change: 'ADDED' | 'CHANGED' | 'RETIRED', codes: readonly string[]): void {
  if (codes.length > 0) tools.emit({ type: 'plant.lists_changed', subject: 'plant-lists', companyId: null, siteId: null, payload: { list, change, codes: [...codes] } })
}

const tenantWide = { companyId: null, siteId: null } as const

// ---- reads ----------------------------------------------------------------------------------------------------------

export async function listClasses(caller: CommandCaller, query: { readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = (await client.machineClass.findMany({ select: CLASS_COLUMNS })).sort(byOrder)
    const machines = await machinesPerClass(client)
    const symptomCodes = new Set((await client.machineSymptom.findMany({ select: { code: true } })).map((row) => row.code))
    const missing = missingStarter(new Set(rows.map((row) => row.code)), symptomCodes)
    return {
      classes: rows.filter((row) => query.active === undefined || row.active === (query.active === 'true')).map((row) => classView(row, machines.get(row.id) ?? 0)),
      starterMissing: [...missing.classes.map((entry) => entry.code), ...missing.symptoms.map((entry) => entry.code)],
      canManage: mayManageLists(context),
    }
  })
}

export async function listSymptoms(caller: CommandCaller, query: { readonly classId?: string | undefined; readonly active?: 'true' | 'false' | undefined }) {
  const context = contextOf(caller)
  return caller.withClient(async (client) => {
    const where: Prisma.MachineSymptomWhereInput = {
      ...(query.classId ? { OR: [{ classId: query.classId }, { classId: null }] } : {}),
      ...(query.active !== undefined ? { active: query.active === 'true' } : {}),
    }
    const rows = (await client.machineSymptom.findMany({ where, select: SYMPTOM_COLUMNS })).sort(byOrder)
    const used = await requestsPerSymptom(client)
    return { symptoms: rows.map((row) => symptomView(row, used.get(row.id) ?? 0)), canManage: context.audience === 'office' && mayManageLists(context) }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

const nextOrder = async (db: Pick<CommandTx, 'machineClass' | 'machineSymptom'>, list: 'class' | 'symptom'): Promise<number> => {
  const last = list === 'class' ? await db.machineClass.aggregate({ _max: { sortOrder: true } }) : await db.machineSymptom.aggregate({ _max: { sortOrder: true } })
  return (last._max.sortOrder ?? -1) + 1
}

export interface ClassBody {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly icon?: string | null | undefined
  readonly sortOrder?: number | undefined
}

/** POST /plant/classes. */
export async function createClass(caller: CommandCaller, body: ClassBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManageLists(context)
  const code = body.code.trim().toUpperCase()
  const problems = [...codeProblems(code), ...plantWordsProblems(body, 'machine class')]
  if (problems.length > 0) throw problemsError(problems, 'The class is not valid.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.createClass', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if ((await tx.machineClass.count()) >= PLANT_LIMITS.classes) throw new ConflictError(`At most ${PLANT_LIMITS.classes} machine classes: retire some first.`)
    const taken = await tx.machineClass.findFirst({ where: { code }, select: { active: true } })
    if (taken) throw new ConflictError(`Class ${code} is taken${taken.active ? '' : ' by a retired class'}.`)
    const row = await tx.machineClass.create({
      data: { id, code, labelIt: body.labelIt.trim(), labelEn: body.labelEn.trim(), labelI18n: mergedWords({}, body.labelI18n), icon: body.icon ?? null, sortOrder: body.sortOrder ?? (await nextOrder(tx, 'class')), createdAt: now, updatedAt: now, createdById: context.actorId },
      select: CLASS_COLUMNS,
    })
    tools.audit({ action: 'plant.createClass', recordType: 'MachineClass', recordId: id, ...tenantWide, after: { code, labelIt: row.labelIt, labelEn: row.labelEn, icon: row.icon, sortOrder: row.sortOrder } })
    changed(tools, 'CLASS', 'ADDED', [code])
    return { class: classView(row, 0) }
  })
  return { ...result, replayed }
}

export interface ClassChange extends Omit<Partial<ClassBody>, 'code'> {
  readonly version: number
  readonly active?: boolean | undefined
}

/** PATCH /plant/classes/:classId. */
export async function updateClass(caller: CommandCaller, classId: string, body: ClassChange, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManageLists(context)
  const problems = plantWordsProblems(body, 'machine class')
  if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
  const { result } = await command(caller, { name: 'plant.updateClass', idempotencyKey, input: { classId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const [locked] = isUuid(classId) ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MachineClass" WHERE "id" = ${classId}::uuid FOR UPDATE` : []
    if (!locked) throw new NotFoundError('Machine class not found.')
    const before = (await tx.machineClass.findUnique({ where: { id: classId }, select: CLASS_COLUMNS }))!
    assertVersion('class', before.version, body.version)
    const data: Prisma.MachineClassUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
    if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
    if (body.labelI18n !== undefined) data.labelI18n = mergedWords(wordsOf(before.labelI18n), body.labelI18n)
    if (body.icon !== undefined) data.icon = body.icon
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (body.active !== undefined) data.active = body.active
    const row = await tx.machineClass.update({ where: { id: classId }, data, select: CLASS_COLUMNS })
    tools.audit({
      action: 'plant.updateClass',
      recordType: 'MachineClass',
      recordId: classId,
      ...tenantWide,
      before: { labelIt: before.labelIt, labelEn: before.labelEn, labelI18n: wordsOf(before.labelI18n), icon: before.icon, sortOrder: before.sortOrder, active: before.active },
      after: { labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: wordsOf(row.labelI18n), icon: row.icon, sortOrder: row.sortOrder, active: row.active },
    })
    changed(tools, 'CLASS', body.active === false && before.active ? 'RETIRED' : 'CHANGED', [row.code])
    const machines = await tx.machine.count({ where: { classId } })
    return { class: classView(row, machines) }
  })
  return result
}

export interface SymptomBody {
  readonly code: string
  readonly classId?: string | null | undefined
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly icon?: string | null | undefined
  readonly colour?: string | null | undefined
  readonly unsafe?: boolean | undefined
  readonly needsDetail?: boolean | undefined
  readonly sortOrder?: number | undefined
}

/** POST /plant/symptoms. */
export async function createSymptom(caller: CommandCaller, body: SymptomBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManageLists(context)
  const code = body.code.trim().toUpperCase()
  const problems = [...codeProblems(code), ...plantWordsProblems(body, 'symptom')]
  if (problems.length > 0) throw problemsError(problems, 'The symptom is not valid.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.createSymptom', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if ((await tx.machineSymptom.count()) >= PLANT_LIMITS.symptoms) throw new ConflictError(`At most ${PLANT_LIMITS.symptoms} symptoms: retire some first.`)
    const taken = await tx.machineSymptom.findFirst({ where: { code }, select: { active: true } })
    if (taken) throw new ConflictError(`Symptom ${code} is taken${taken.active ? '' : ' by a retired symptom'}.`)
    if (body.classId) {
      const machineClass = await tx.machineClass.findUnique({ where: { id: body.classId }, select: { active: true } })
      if (!machineClass) throw bodyIssue('classId', 'Not a machine class of the group.')
      if (!machineClass.active) throw bodyIssue('classId', 'This class is retired: make it active again first.')
    }
    const row = await tx.machineSymptom.create({
      data: {
        id,
        classId: body.classId ?? null,
        code,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedWords({}, body.labelI18n),
        icon: body.icon ?? null,
        colour: body.colour?.toLowerCase() ?? null,
        unsafe: body.unsafe ?? false,
        needsDetail: body.needsDetail ?? false,
        sortOrder: body.sortOrder ?? (await nextOrder(tx, 'symptom')),
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: SYMPTOM_COLUMNS,
    })
    tools.audit({ action: 'plant.createSymptom', recordType: 'MachineSymptom', recordId: id, ...tenantWide, after: { code, classId: row.classId, labelIt: row.labelIt, labelEn: row.labelEn, icon: row.icon, colour: row.colour, unsafe: row.unsafe, needsDetail: row.needsDetail, sortOrder: row.sortOrder } })
    changed(tools, 'SYMPTOM', 'ADDED', [code])
    return { symptom: symptomView(row, 0) }
  })
  return { ...result, replayed }
}

export interface SymptomChange extends Omit<Partial<SymptomBody>, 'code' | 'classId'> {
  readonly version: number
  readonly active?: boolean | undefined
}

/** PATCH /plant/symptoms/:symptomId. */
export async function updateSymptom(caller: CommandCaller, symptomId: string, body: SymptomChange, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManageLists(context)
  const problems = plantWordsProblems(body, 'symptom')
  if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
  const { result } = await command(caller, { name: 'plant.updateSymptom', idempotencyKey, input: { symptomId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const [locked] = isUuid(symptomId) ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MachineSymptom" WHERE "id" = ${symptomId}::uuid FOR UPDATE` : []
    if (!locked) throw new NotFoundError('Symptom not found.')
    const before = (await tx.machineSymptom.findUnique({ where: { id: symptomId }, select: SYMPTOM_COLUMNS }))!
    assertVersion('symptom', before.version, body.version)
    const data: Prisma.MachineSymptomUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
    if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
    if (body.labelI18n !== undefined) data.labelI18n = mergedWords(wordsOf(before.labelI18n), body.labelI18n)
    if (body.icon !== undefined) data.icon = body.icon
    if (body.colour !== undefined) data.colour = body.colour?.toLowerCase() ?? null
    if (body.unsafe !== undefined) data.unsafe = body.unsafe
    if (body.needsDetail !== undefined) data.needsDetail = body.needsDetail
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (body.active !== undefined) data.active = body.active
    const row = await tx.machineSymptom.update({ where: { id: symptomId }, data, select: SYMPTOM_COLUMNS })
    const audited = (entry: SymptomRow) => ({ labelIt: entry.labelIt, labelEn: entry.labelEn, labelI18n: wordsOf(entry.labelI18n), icon: entry.icon, colour: entry.colour, unsafe: entry.unsafe, needsDetail: entry.needsDetail, sortOrder: entry.sortOrder, active: entry.active })
    tools.audit({ action: 'plant.updateSymptom', recordType: 'MachineSymptom', recordId: symptomId, ...tenantWide, before: audited(before), after: audited(row) })
    changed(tools, 'SYMPTOM', body.active === false && before.active ? 'RETIRED' : 'CHANGED', [row.code])
    const requests = await tx.maintenanceRequest.count({ where: { symptomId } })
    return { symptom: symptomView(row, requests) }
  })
  return result
}

/** POST /plant/starter: the starter set's missing classes and symptoms, in one command (a repeat adds nothing). */
export async function addStarter(caller: CommandCaller, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManageLists(context)
  const { result } = await command(caller, { name: 'plant.addStarter', idempotencyKey, input: {} }, async (tools) => {
    const { tx, now } = tools
    // Two starters of a tenant at once add once (the second waits, then finds the codes).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.plant-starter', current_setting('factory.tenant_id', true)), 0))`
    const classes = await tx.machineClass.findMany({ select: { id: true, code: true } })
    const symptoms = await tx.machineSymptom.findMany({ select: { code: true } })
    const missing = missingStarter(new Set(classes.map((row) => row.code)), new Set(symptoms.map((row) => row.code)))
    const classIds = new Map(classes.map((row) => [row.code, row.id]))
    let order = await nextOrder(tx, 'class')
    for (const entry of missing.classes) {
      const id = newId()
      await tx.machineClass.create({ data: { id, code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, icon: entry.icon, sortOrder: order++, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      classIds.set(entry.code, id)
      tools.audit({ action: 'plant.addStarter', recordType: 'MachineClass', recordId: id, ...tenantWide, after: { code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, icon: entry.icon } })
    }
    let symptomOrder = await nextOrder(tx, 'symptom')
    const added: string[] = []
    for (const entry of missing.symptoms) {
      // A class-bound starter symptom whose class the tenant has not (and the starter did not add): skipped.
      const classId = entry.classCode ? (classIds.get(entry.classCode) ?? undefined) : null
      if (classId === undefined) continue
      const id = newId()
      await tx.machineSymptom.create({
        data: { id, classId, code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, icon: entry.icon, colour: entry.colour, unsafe: entry.unsafe, needsDetail: entry.needsDetail, sortOrder: symptomOrder++, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: { id: true },
      })
      added.push(entry.code)
      tools.audit({ action: 'plant.addStarter', recordType: 'MachineSymptom', recordId: id, ...tenantWide, after: { code: entry.code, classId, unsafe: entry.unsafe } })
    }
    const answer = { classes: missing.classes.map((entry) => entry.code), symptoms: added }
    if (answer.classes.length === 0 && answer.symptoms.length === 0) tools.audit({ action: 'plant.addStarter', recordType: 'MachineClass', recordId: classes[0]?.id ?? newId(), ...tenantWide, after: { added: 0 } })
    changed(tools, 'STARTER', 'ADDED', [...answer.classes, ...answer.symptoms])
    return { added: answer }
  })
  return result
}

