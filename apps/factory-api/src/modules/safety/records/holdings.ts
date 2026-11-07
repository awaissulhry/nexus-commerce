import type { Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { holdingKey } from '@nexus/factory-domain/safety/rolesheets/rules'
import { latestOf, type RecordFacts, type RecordResult } from '@nexus/factory-domain/safety/records/rules'
import type { CommandTx } from '../../../core/command'
import { dayOf, dayOrNull } from '../organisation/access'

/**
 * The reads of what people hold of the safety courses (B-W2b-139), for this module and for the qualification check
 * (modules/people/skills/check.ts, in the office's or the floor's own scope: every column read here is one the floor role may
 * read). Records are append-only: a record stands while no correction names it (a correction replaces it, a VOID one removes
 * it); the newest standing PASSED record decides, valid until null or not past (factory-domain safety/records `latestOf`, the
 * same rule as the role sheets' `coursesMet`).
 *
 *   recordFactsOf(db, employeeIds, courseIds?)   every record of the people (of those courses), corrections included
 *   classCoursesOf(db, classIds)                 the courses each type of machine asks, with their code and name
 *   courseHoldingsOf(db, employeeId, courseIds)  per course: held today, the newest PASSED valid until, ever passed
 */

export const RECORD_FACTS_SELECT = {
  id: true,
  employeeId: true,
  courseId: true,
  completedOn: true,
  result: true,
  validUntil: true,
  languageChecked: true,
  correctsId: true,
  createdAt: true,
} as const satisfies Prisma.TrainingRecordSelect

export const factsOf = (row: Prisma.TrainingRecordGetPayload<{ select: typeof RECORD_FACTS_SELECT }>): RecordFacts => ({
  id: row.id,
  employeeId: row.employeeId,
  courseId: row.courseId,
  completedOn: dayOf(row.completedOn),
  result: row.result as RecordResult,
  validUntil: dayOrNull(row.validUntil),
  languageChecked: row.languageChecked,
  correctsId: row.correctsId,
  createdAt: row.createdAt.toISOString(),
})

/** Every record of these people (optionally of these courses only), corrections included: one read. */
export async function recordFactsOf(db: Pick<CommandTx, 'trainingRecord'>, employeeIds: readonly string[], courseIds?: readonly string[]): Promise<RecordFacts[]> {
  const people = [...new Set(employeeIds)]
  if (people.length === 0 || (courseIds && courseIds.length === 0)) return []
  const rows = await db.trainingRecord.findMany({
    where: { employeeId: { in: people }, ...(courseIds ? { courseId: { in: [...new Set(courseIds)] } } : {}) },
    orderBy: [{ completedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: RECORD_FACTS_SELECT,
  })
  return rows.map(factsOf)
}

export interface ClassCourse {
  readonly courseId: string
  readonly code: string
  readonly name: string
  readonly withinDays: number | null
}

/** The courses each type of machine asks of who is authorised on it (TrainingRequirement MACHINE_CLASS), in the catalogue's order. */
export async function classCoursesOf(db: Pick<CommandTx, 'trainingRequirement'>, classIds: readonly string[]): Promise<Map<string, ClassCourse[]>> {
  const ids = [...new Set(classIds)]
  const answer = new Map<string, ClassCourse[]>()
  if (ids.length === 0) return answer
  const rows = await db.trainingRequirement.findMany({
    where: { source: 'MACHINE_CLASS', machineClassId: { in: ids } },
    orderBy: [{ course: { sortOrder: 'asc' } }, { course: { code: 'asc' } }, { id: 'asc' }],
    select: { machineClassId: true, withinDays: true, course: { select: { id: true, code: true, name: true } } },
  })
  for (const row of rows) answer.set(row.machineClassId!, [...(answer.get(row.machineClassId!) ?? []), { courseId: row.course.id, code: row.course.code, name: row.course.name, withinDays: row.withinDays }])
  return answer
}

export interface CourseHolding {
  readonly met: boolean
  readonly validUntil: BusinessDate | null
  readonly everPassed: boolean
}

/** What one person holds of these courses today. */
export async function courseHoldingsOf(db: Pick<CommandTx, 'trainingRecord'>, employeeId: string, courseIds: readonly string[], today: BusinessDate): Promise<Map<string, CourseHolding>> {
  const latest = latestOf(await recordFactsOf(db, [employeeId], courseIds))
  const answer = new Map<string, CourseHolding>()
  for (const courseId of new Set(courseIds)) {
    const passed = latest.get(holdingKey(employeeId, courseId))?.passed ?? null
    answer.set(courseId, { met: passed !== null && (passed.validUntil === null || passed.validUntil >= today), validUntil: passed?.validUntil ?? null, everPassed: passed !== null })
  }
  return answer
}
