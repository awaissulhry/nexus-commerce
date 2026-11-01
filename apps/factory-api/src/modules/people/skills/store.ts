import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { authorisationStateOf, traineeStateOf, type SkillKind, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import type { CommandTx } from '../../../core/command'
import { dayOf, dayOrNull } from '../employees/access'
import { userNames } from '../employees/employees'

/**
 * The skills' rows and their views (B-W2b-39), shared by the catalogue, levels, authorisations and matrix routes. Office
 * reads only (the floor reads through check.ts, with its own columns). Each takes the client it is given (a scoped
 * client, or a command's transaction).
 */

export type Client = FactoryClient | CommandTx

export const SKILL_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  kind: true,
  operationId: true,
  machineClassId: true,
  sortOrder: true,
  status: true,
  version: true,
  operation: { select: { id: true, code: true, name: true } },
  machineClass: { select: { id: true, code: true, labelEn: true, labelIt: true } },
} as const satisfies Prisma.SkillSelect
export type SkillRow = Prisma.SkillGetPayload<{ select: typeof SKILL_SELECT }>

export const readSkill = (client: Client, id: string): Promise<SkillRow | null> => client.skill.findUnique({ where: { id }, select: SKILL_SELECT })

const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export function skillView(row: SkillRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    nameI18n: wordsOf(row.nameI18n),
    kind: row.kind as SkillKind,
    operation: row.operation,
    machineClass: row.machineClass ? { id: row.machineClass.id, code: row.machineClass.code, labelEn: row.machineClass.labelEn, labelIt: row.machineClass.labelIt } : null,
    sortOrder: row.sortOrder,
    status: row.status as 'ACTIVE' | 'ARCHIVED',
    version: row.version,
  }
}

export const LEVEL_SELECT = {
  id: true,
  siteId: true,
  employeeId: true,
  skillId: true,
  level: true,
  since: true,
  assessedAt: true,
  assessedById: true,
  traineeUntil: true,
  signedOffOn: true,
  signedOffById: true,
  trainerEmployeeId: true,
  removedAt: true,
  removedById: true,
  removeReason: true,
  version: true,
  skill: { select: { id: true, code: true, name: true, kind: true, companyId: true, status: true } },
  employee: { select: { companyId: true, siteId: true, status: true, userId: true, firstName: true, lastName: true } },
  trainer: { select: { id: true, firstName: true, lastName: true } },
} as const satisfies Prisma.EmployeeSkillSelect
export type LevelRow = Prisma.EmployeeSkillGetPayload<{ select: typeof LEVEL_SELECT }>

export const readLevel = (client: Client, id: string): Promise<LevelRow | null> => client.employeeSkill.findUnique({ where: { id }, select: LEVEL_SELECT })

/** The levels' views, with who assessed, signed off and removed them by name (office). */
export async function levelViews(client: Client, rows: readonly LevelRow[], today: BusinessDate) {
  const names = await userNames(client, rows.flatMap((row) => [row.assessedById, row.signedOffById, row.removedById]))
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    skill: { id: row.skill.id, code: row.skill.code, name: row.skill.name, kind: row.skill.kind as SkillKind, status: row.skill.status as 'ACTIVE' | 'ARCHIVED' },
    level: row.level as SkillLevel,
    since: dayOf(row.since),
    assessedAt: row.assessedAt.toISOString(),
    assessedBy: nameOf(row.assessedById),
    traineeUntil: dayOrNull(row.traineeUntil),
    trainee: traineeStateOf({ traineeUntil: dayOrNull(row.traineeUntil), signedOffOn: dayOrNull(row.signedOffOn) }, today),
    signedOffOn: dayOrNull(row.signedOffOn),
    signedOffBy: nameOf(row.signedOffById),
    trainer: row.trainer ? { employeeId: row.trainer.id, name: `${row.trainer.firstName} ${row.trainer.lastName}` } : null,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
    removedBy: nameOf(row.removedById),
    removeReason: row.removeReason,
    version: row.version,
  }))
}

export const AUTHORISATION_SELECT = {
  id: true,
  siteId: true,
  employeeId: true,
  machineClassId: true,
  authorisedOn: true,
  validUntil: true,
  authorisedById: true,
  revokedAt: true,
  revokedById: true,
  revokeReason: true,
  version: true,
  machineClass: { select: { id: true, code: true, labelEn: true, labelIt: true, active: true } },
  employee: { select: { companyId: true, siteId: true, status: true, userId: true, firstName: true, lastName: true } },
} as const satisfies Prisma.MachineAuthorisationSelect
export type AuthorisationRow = Prisma.MachineAuthorisationGetPayload<{ select: typeof AUTHORISATION_SELECT }>

export const readAuthorisation = (client: Client, id: string): Promise<AuthorisationRow | null> => client.machineAuthorisation.findUnique({ where: { id }, select: AUTHORISATION_SELECT })

/** The authorisations' views, with who authorised and revoked them by name (office). */
export async function authorisationViews(client: Client, rows: readonly AuthorisationRow[], today: BusinessDate) {
  const names = await userNames(client, rows.flatMap((row) => [row.authorisedById, row.revokedById]))
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    machineClass: { id: row.machineClass.id, code: row.machineClass.code, labelEn: row.machineClass.labelEn, labelIt: row.machineClass.labelIt },
    authorisedOn: dayOf(row.authorisedOn),
    validUntil: dayOrNull(row.validUntil),
    state: authorisationStateOf({ authorisedOn: dayOf(row.authorisedOn), validUntil: dayOrNull(row.validUntil), revoked: row.revokedAt !== null }, today),
    authorisedBy: nameOf(row.authorisedById),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedBy: nameOf(row.revokedById),
    revokeReason: row.revokeReason,
    version: row.version,
  }))
}

/** The person's record row locked for the rest of the command (FOR UPDATE): two decisions about one person queue. */
export async function lockPerson(tx: CommandTx, employeeId: string): Promise<{ id: string; companyId: string; siteId: string; status: string; userId: string | null }> {
  await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR UPDATE`
  return (await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true, status: true, userId: true } }))!
}
