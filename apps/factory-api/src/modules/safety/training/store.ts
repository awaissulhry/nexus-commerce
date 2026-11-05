import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_TRAINING_MANAGE } from '@nexus/factory-domain/safety/training/permissions'
import type { CourseFields, CourseStatus, CourseType } from '@nexus/factory-domain/safety/training/rules'
import type { CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * The course catalogue and the machine types as the screens read them (B-W2b-133; design people.skills "Course catalogue",
 * "Who needs what", the pop-up "Course"): every read names its columns. A course of the whole group (companyId null) is read
 * by every safety reader and written by a grant over every company; a course of one company by the readers and keepers of
 * that company. No money in these sections; never a person's figure.
 */

type Client = FactoryClient | CommandTx

export const RECORD_COURSE = 'SafetyCourse'

export const COURSE_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  type: true,
  hours: true,
  refresherMonths: true,
  refresherHours: true,
  inPersonRequired: true,
  provider: true,
  legalBasis: true,
  sortOrder: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { code: true, legalName: true } },
} as const satisfies Prisma.SafetyCourseSelect
export type CourseRow = Prisma.SafetyCourseGetPayload<{ select: typeof COURSE_SELECT }>

export const readCourse = (client: Client, id: string): Promise<CourseRow | null> => client.safetyCourse.findUnique({ where: { id }, select: COURSE_SELECT }) as Promise<CourseRow | null>

export const i18nOf = (value: Prisma.JsonValue | null): Record<string, string> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)

/** The caller reads the course: one of the group, or of a company safety.view reaches (inside the screen's company). */
export const mayReadCourse = (context: OfficeContext, row: { readonly companyId: string | null }): boolean =>
  row.companyId === null ? can(actorOf(context), SAFETY_VIEW, {}) : (!context.companyId || context.companyId === row.companyId) && can(actorOf(context), SAFETY_VIEW, { companyId: row.companyId })

/** A grant over every company (a course of the whole group, the courses of a machine type: tenant-wide). */
export const overEveryCompany = (context: OfficeContext): boolean => grantsFor(actorOf(context), SAFETY_TRAINING_MANAGE).some((grant) => grant.companies === 'all')

/** Writing a course: of a company the permission reaches, or of the group with a grant over every company. */
export const mayWriteCourse = (context: OfficeContext, companyId: string | null): boolean =>
  companyId === null ? overEveryCompany(context) : (!context.companyId || context.companyId === companyId) && can(actorOf(context), SAFETY_TRAINING_MANAGE, { companyId })

/** The fields a course says, as the domain rules take them. */
export const fieldsOf = (row: CourseRow): CourseFields => ({
  name: row.name,
  nameI18n: i18nOf(row.nameI18n),
  hours: row.hours.toString(),
  refresherMonths: row.refresherMonths,
  refresherHours: row.refresherHours?.toString() ?? null,
  inPersonRequired: row.inPersonRequired,
  provider: row.provider,
  legalBasis: row.legalBasis,
  sortOrder: row.sortOrder,
})

/** What an audit row keeps of a course. */
export const auditedCourse = (row: CourseRow) => ({ code: row.code, companyId: row.companyId, type: row.type, status: row.status, ...fieldsOf(row) })

/** How many ACTIVE role sheets (the caller may read) and active machine types ask each course. */
export async function requiredByOf(client: Client, sheetReach: Record<string, unknown>, courseIds: readonly string[]): Promise<Map<string, { roleSheets: number; machineClasses: number }>> {
  const answer = new Map<string, { roleSheets: number; machineClasses: number }>()
  if (courseIds.length === 0) return answer
  const rows = await client.trainingRequirement.findMany({
    where: {
      courseId: { in: [...courseIds] },
      OR: [
        { source: 'ROLE_SHEET', roleSheet: { AND: [sheetReach as Prisma.RoleSheetWhereInput, { status: 'ACTIVE' }] } },
        { source: 'MACHINE_CLASS', machineClass: { active: true } },
      ],
    },
    select: { courseId: true, source: true },
  })
  for (const row of rows) {
    const entry = answer.get(row.courseId) ?? { roleSheets: 0, machineClasses: 0 }
    if (row.source === 'ROLE_SHEET') entry.roleSheets += 1
    else entry.machineClasses += 1
    answer.set(row.courseId, entry)
  }
  return answer
}

/** A course as the catalogue lists it: type, hours, refresher, in person, provider, the law, who asks it. */
export function courseView(context: OfficeContext, row: CourseRow, requiredBy: { roleSheets: number; machineClasses: number } | undefined) {
  return {
    id: row.id,
    companyId: row.companyId,
    company: row.company ? { code: row.company.code, name: row.company.legalName } : null,
    code: row.code,
    name: row.name,
    nameI18n: i18nOf(row.nameI18n),
    type: row.type as CourseType,
    hours: row.hours.toString(),
    refresherMonths: row.refresherMonths,
    refresherHours: row.refresherHours?.toString() ?? null,
    inPersonRequired: row.inPersonRequired,
    provider: row.provider,
    legalBasis: row.legalBasis,
    sortOrder: row.sortOrder,
    status: row.status as CourseStatus,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    requiredBy: requiredBy ?? { roleSheets: 0, machineClasses: 0 },
    canManage: mayWriteCourse(context, row.companyId),
  }
}

/** The courses an answer names (ids → words for the screen), in the catalogue's order. */
export async function courseRefs(client: Client, courseIds: Iterable<string>) {
  const ids = [...new Set(courseIds)]
  if (ids.length === 0) return []
  const rows = await client.safetyCourse.findMany({
    where: { id: { in: ids } },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true, nameI18n: true, type: true, hours: true, refresherMonths: true, status: true, companyId: true },
  })
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, nameI18n: i18nOf(row.nameI18n), type: row.type as CourseType, hours: row.hours.toString(), refresherMonths: row.refresherMonths, status: row.status as CourseStatus, companyId: row.companyId }))
}

export const CLASS_SELECT = { id: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, active: true, sortOrder: true } as const satisfies Prisma.MachineClassSelect
export type ClassRow = Prisma.MachineClassGetPayload<{ select: typeof CLASS_SELECT }>

/** A machine type as "Who needs what" names it (its words in our languages; never a machine's cost). */
export const classView = (row: ClassRow) => ({ id: row.id, code: row.code, label: { it: row.labelIt, en: row.labelEn, ...(i18nOf(row.labelI18n) ?? {}) }, icon: row.icon, active: row.active })
