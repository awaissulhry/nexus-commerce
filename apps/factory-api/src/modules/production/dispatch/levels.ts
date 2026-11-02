import { isTrainee, SKILL_LEVELS, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import { dayOf, type Reader } from './store'

/**
 * The skill level beside a name on the board (B-W2b-49; design production.dispatch "the assigned operator's name + skill
 * level for that operation"): a training record, never output, speed or a rank. One read for the whole board (the check,
 * people/skills/check.ts, decides at the assign and the picker: it reads one person at a time). Office only.
 */

export interface HeldLevel {
  readonly level: SkillLevel
  readonly trainee: boolean
}

const rankOf = (level: SkillLevel): number => SKILL_LEVELS.indexOf(level)

export type LevelsOf = (employeeId: string | null, workOrderOperationId: string) => HeldLevel | null

export async function levelsOfBoard(db: Reader, employeeIds: readonly (string | null)[], workOrderOperationIds: readonly string[]): Promise<LevelsOf> {
  const people = [...new Set(employeeIds.filter((id): id is string => id !== null))]
  const steps = [...new Set(workOrderOperationIds)]
  if (people.length === 0 || steps.length === 0) return () => null
  const operations = await db.workOrderOperation.findMany({ where: { id: { in: steps } }, select: { id: true, routingOperation: { select: { operationId: true } } } })
  const libraryOf = new Map(operations.map((row) => [row.id, row.routingOperation.operationId]))
  const skills = await db.skill.findMany({ where: { kind: 'OPERATION', status: 'ACTIVE', operationId: { in: [...new Set(libraryOf.values())] } }, select: { id: true, operationId: true } })
  const skillsOf = new Map<string, string[]>()
  for (const skill of skills) if (skill.operationId) skillsOf.set(skill.operationId, [...(skillsOf.get(skill.operationId) ?? []), skill.id])
  const rows = skills.length === 0 ? [] : await db.employeeSkill.findMany({ where: { employeeId: { in: people }, skillId: { in: skills.map((skill) => skill.id) }, removedAt: null }, select: { employeeId: true, skillId: true, level: true, traineeUntil: true, signedOffOn: true } })
  return (employeeId, workOrderOperationId) => {
    const library = libraryOf.get(workOrderOperationId)
    const wanted = library ? (skillsOf.get(library) ?? []) : []
    const held = rows.filter((row) => row.employeeId === employeeId && wanted.includes(row.skillId)).sort((a, b) => rankOf(b.level as SkillLevel) - rankOf(a.level as SkillLevel))[0]
    if (!held) return null
    return { level: held.level as SkillLevel, trainee: isTrainee({ traineeUntil: held.traineeUntil ? dayOf(held.traineeUntil) : null, signedOffOn: held.signedOffOn ? dayOf(held.signedOffOn) : null }) }
  }
}
