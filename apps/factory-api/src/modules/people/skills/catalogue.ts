import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_SKILLS_MANAGE, PEOPLE_SKILLS_VIEW } from '@nexus/factory-domain/people/skills/permissions'
import { cleanSkillCode, skillProblems, type SkillKind } from '@nexus/factory-domain/people/skills/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertVersion, officeOf, problemsError, refuse } from '../employees/access'
import { readSkill, SKILL_SELECT, skillView, type SkillRow } from './store'

/**
 * The skills (B-W2b-39; MES-241; design people.skills "Matrix" columns: Operations, Machines; people.employees › Skills &
 * training): an operation of the library, a class of machine, or a general skill, of the group (tenant-wide) or of one
 * company. Office only, people.skills.view to read, people.skills.manage to write; a skill of the group is written only
 * by a grant over every company.
 *
 *   GET  /people/skills                      the skills (active by default), in the matrix's order
 *   POST /people/skills                      add a skill (its code never changes)
 *   PATCH /people/skills/:skillId            its name, its words per language, its place in the matrix
 *   POST /people/skills/:skillId/archive     out of the matrix and the check (levels stay on record)
 *   POST /people/skills/:skillId/restore     back again
 */

const MANAGE_WORDS = 'Skills are kept by a role that keeps the skills matrix (people.skills.manage).'

/** A skill the caller may read: the group's, or of a company the permission reaches. */
const mayRead = (context: OfficeContext, row: { companyId: string | null }) => can(actorOf(context), PEOPLE_SKILLS_VIEW, row.companyId ? { companyId: row.companyId } : {})

/** Writing a skill: of a company the permission reaches, or of the group with a grant over every company. */
function mayWrite(context: OfficeContext, companyId: string | null): boolean {
  if (companyId) return can(actorOf(context), PEOPLE_SKILLS_MANAGE, { companyId })
  return grantsFor(actorOf(context), PEOPLE_SKILLS_MANAGE).some((grant) => grant.companies === 'all')
}

export interface ListSkillsQuery {
  readonly kind?: SkillKind | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined
  readonly companyId?: string | undefined
}

/** GET /people/skills. */
export async function listSkills(caller: CommandCaller, query: ListSkillsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const where: Prisma.SkillWhereInput = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status === 'ALL' ? {} : { status: query.status ?? 'ACTIVE' }),
      ...(query.companyId ? { OR: [{ companyId: null }, { companyId: query.companyId }] } : {}),
    }
    const rows = await client.skill.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: SKILL_SELECT, take: 1000 })
    return { skills: rows.filter((row) => mayRead(context, row)).map(skillView), canManage: mayWrite(context, null) || rows.some((row) => row.companyId !== null && mayWrite(context, row.companyId)) }
  })
}

export interface CreateSkillBody {
  readonly companyId?: string | null | undefined
  readonly code: string
  readonly name: string
  readonly nameI18n?: Record<string, string> | undefined
  readonly kind: SkillKind
  readonly operationId?: string | null | undefined
  readonly machineClassId?: string | null | undefined
  readonly sortOrder?: number | undefined
}

/** POST /people/skills. */
export async function createSkill(caller: CommandCaller, body: CreateSkillBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(context, companyId)) throw new ForbiddenError(companyId ? MANAGE_WORDS : 'A skill of the whole group is added by a role over every company; add it to one company instead.')
  const problems = skillProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The skill is not valid.')
  const id = newId()
  const code = cleanSkillCode(body.code)
  const { result, replayed } = await command(caller, { name: 'people.addSkill', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (await tx.skill.findUnique({ where: { tenantId_code: { tenantId: (tools.context as { tenantId: string }).tenantId, code } }, select: { id: true } })) refuse('CODE_TAKEN', `Skill code ${code} is used already.`, 'code')
    if (body.kind === 'OPERATION') {
      const operation = await tx.operation.findUnique({ where: { id: body.operationId! }, select: { companyId: true, status: true, code: true } })
      if (!operation) throw new NotFoundError('Operation not found.')
      if (operation.companyId !== null && operation.companyId !== companyId) refuse('OPERATION_OTHER_COMPANY', `Operation ${operation.code} belongs to another company: a skill is about an operation of its own company or of the whole group.`, 'operationId')
    }
    if (body.kind === 'MACHINE') {
      const machineClass = await tx.machineClass.findUnique({ where: { id: body.machineClassId! }, select: { active: true, code: true } })
      if (!machineClass) throw new NotFoundError('Machine class not found.')
      if (!machineClass.active) refuse('CLASS_INACTIVE', `The class ${machineClass.code} is archived.`, 'machineClassId')
    }
    await tx.skill.create({
      data: {
        id,
        companyId,
        code,
        name: body.name.trim(),
        nameI18n: Object.fromEntries(Object.entries(body.nameI18n ?? {}).map(([locale, words]) => [locale, words.trim()])),
        kind: body.kind,
        operationId: body.kind === 'OPERATION' ? body.operationId! : null,
        machineClassId: body.kind === 'MACHINE' ? body.machineClassId! : null,
        sortOrder: body.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    const row = (await readSkill(tx, id))!
    tools.audit({ action: 'people.addSkill', recordType: 'Skill', recordId: id, companyId, after: auditedSkill(row) })
    tools.emit({ type: 'skill.changed', subject: id, companyId, payload: { skillId: id, code, kind: body.kind, change: 'CREATED' } })
    return { skill: skillView(row) }
  })
  return { ...result, replayed }
}

const auditedSkill = (row: SkillRow) => ({ code: row.code, name: row.name, nameI18n: row.nameI18n, kind: row.kind, operationId: row.operationId, machineClassId: row.machineClassId, sortOrder: row.sortOrder, status: row.status })

async function writableSkill(caller: CommandCaller, skillId: string): Promise<SkillRow> {
  const context = officeOf(caller)
  const row = isUuid(skillId) ? await caller.withClient((client) => readSkill(client, skillId)) : null
  if (!row || !mayRead(context, row)) throw new NotFoundError('Skill not found.')
  if (!mayWrite(context, row.companyId)) throw new ForbiddenError(row.companyId ? MANAGE_WORDS : 'A skill of the whole group is changed by a role over every company.')
  return row
}

export interface UpdateSkillBody {
  readonly version: number
  readonly name?: string | undefined
  readonly nameI18n?: Record<string, string> | undefined
  readonly sortOrder?: number | undefined
}

/** PATCH /people/skills/:skillId: the code, company, kind and what it is about never change. */
export async function updateSkill(caller: CommandCaller, skillId: string, body: UpdateSkillBody, idempotencyKey?: string) {
  const before = await writableSkill(caller, skillId)
  const problems = skillProblems({ name: body.name, nameI18n: body.nameI18n, sortOrder: body.sortOrder })
  if (problems.length > 0) throw problemsError(problems, 'The skill is not valid.')
  const data = {
    ...(body.name !== undefined && body.name.trim() !== before.name ? { name: body.name.trim() } : {}),
    ...(body.nameI18n !== undefined ? { nameI18n: Object.fromEntries(Object.entries(body.nameI18n).map(([locale, words]) => [locale, words.trim()])) } : {}),
    ...(body.sortOrder !== undefined && body.sortOrder !== before.sortOrder ? { sortOrder: body.sortOrder } : {}),
  }
  assertVersion('skill', before.version, body.version)
  if (Object.keys(data).length === 0) return { skill: skillView(before), changed: false }
  const { result } = await command(caller, { name: 'people.changeSkill', idempotencyKey, input: { skillId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "Skill" WHERE "id" = ${skillId}::uuid FOR UPDATE`
    const current = (await readSkill(tx, skillId))!
    assertVersion('skill', current.version, body.version)
    await tx.skill.update({ where: { id: skillId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const row = (await readSkill(tx, skillId))!
    tools.audit({ action: 'people.changeSkill', recordType: 'Skill', recordId: skillId, companyId: row.companyId, before: auditedSkill(current), after: auditedSkill(row) })
    tools.emit({ type: 'skill.changed', subject: skillId, companyId: row.companyId, payload: { skillId, code: row.code, kind: row.kind as SkillKind, change: 'EDITED' } })
    return { skill: skillView(row), changed: true }
  })
  return result
}

/** POST /people/skills/:skillId/archive | restore: out of (or back into) the matrix and the check; levels stay on record. */
export async function setSkillStatus(caller: CommandCaller, skillId: string, status: 'ACTIVE' | 'ARCHIVED', body: { readonly version: number }, idempotencyKey?: string) {
  const before = await writableSkill(caller, skillId)
  assertVersion('skill', before.version, body.version)
  if (before.status === status) return { skill: skillView(before), changed: false }
  const action = status === 'ARCHIVED' ? 'people.archiveSkill' : 'people.restoreSkill'
  const { result } = await command(caller, { name: action, idempotencyKey, input: { skillId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "Skill" WHERE "id" = ${skillId}::uuid FOR UPDATE`
    const current = (await readSkill(tx, skillId))!
    assertVersion('skill', current.version, body.version)
    await tx.skill.update({ where: { id: skillId }, data: { status, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const row = (await readSkill(tx, skillId))!
    tools.audit({ action, recordType: 'Skill', recordId: skillId, companyId: row.companyId, before: { status: current.status }, after: { status } })
    tools.emit({ type: 'skill.changed', subject: skillId, companyId: row.companyId, payload: { skillId, code: row.code, kind: row.kind as SkillKind, change: status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED' } })
    return { skill: skillView(row), changed: true }
  })
  return result
}
