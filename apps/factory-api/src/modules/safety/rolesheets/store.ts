import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SAFETY_ROLESHEETS_MANAGE } from '@nexus/factory-domain/safety/rolesheets/permissions'
import type { ImpactLine, RoleSheetItemKind, RoleSheetStatus, SheetChanges } from '@nexus/factory-domain/safety/rolesheets/rules'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { dayOrNull, mayAt } from '../organisation/access'

/**
 * The role sheets as the screens read them (B-W2b-128; design plant.risk "Role sheets" index, the record's Role sheets tab,
 * the sheet's form card, "What this changes"): one read per table. Never a PPE item's cost or supplier (no money in these
 * sections), never a health value (whether the ROLE needs visits and how often; no person's visit).
 */

type Client = FactoryClient | CommandTx

export const RECORD_ROLE_SHEET = 'RoleSheet'

const PLACE_SELECT = { site: { select: { code: true, name: true, company: { select: { code: true, legalName: true } } } } } as const

export const SHEET_ROW_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  code: true,
  name: true,
  nameI18n: true,
  description: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  ...PLACE_SELECT,
  _count: {
    select: {
      kitLines: true,
      requirements: true,
      employees: { where: { status: 'ACTIVE' } },
    },
  },
  items: { select: { kind: true } },
  healthPlans: { where: { status: 'ACTIVE' }, select: { needed: true, frequencyMonths: true, endOfEmploymentVisit: true, setOn: true } },
} as const satisfies Prisma.RoleSheetSelect
export type SheetRow = Prisma.RoleSheetGetPayload<{ select: typeof SHEET_ROW_SELECT }>

export const readSheetRow = (client: Client, id: string): Promise<SheetRow | null> => client.roleSheet.findUnique({ where: { id }, select: SHEET_ROW_SELECT }) as Promise<SheetRow | null>

const placeOf = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })
const i18nOf = (value: Prisma.JsonValue | null): Record<string, string> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)

/** A sheet as the index lists it: role, site, people, risks, PPE items, courses, surveillance, last changed. */
export function sheetRowView(context: OfficeContext, row: SheetRow) {
  const plan = row.healthPlans[0] ?? null
  return {
    id: row.id,
    companyId: row.companyId,
    company: { code: row.site.company.code, name: row.site.company.legalName },
    siteId: row.siteId,
    site: { code: row.site.code, name: row.site.name },
    code: row.code,
    name: row.name,
    nameI18n: i18nOf(row.nameI18n),
    status: row.status as RoleSheetStatus,
    people: row._count.employees,
    risks: row.items.filter((item) => item.kind === 'RISK').length,
    surveillanceNeeds: row.items.filter((item) => item.kind === 'SURVEILLANCE').length,
    ppeItems: row._count.kitLines,
    courses: row._count.requirements,
    surveillance: { needed: plan ? plan.needed : null, frequencyMonths: plan?.frequencyMonths ?? null },
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
    canManage: mayAt(context, SAFETY_ROLESHEETS_MANAGE, placeOf(row)),
  }
}

const ITEM_REF = { code: true, name: true, nameI18n: true, category: true, standard: true, sizes: true, status: true } as const satisfies Prisma.PpeItemSelect
const COURSE_REF = { code: true, name: true, nameI18n: true, type: true, hours: true, refresherMonths: true, status: true } as const satisfies Prisma.SafetyCourseSelect

/** The whole sheet: its items, its kit, its courses, its health plan and the people in the role. */
export async function sheetView(client: Client, context: OfficeContext, row: SheetRow) {
  const items = await client.roleSheetItem.findMany({ where: { roleSheetId: row.id }, orderBy: [{ seq: 'asc' }], select: { id: true, seq: true, kind: true, title: true, note: true } })
  const kit = await client.ppeKitLine.findMany({ where: { roleSheetId: row.id }, orderBy: [{ seq: 'asc' }], select: { id: true, seq: true, ppeItemId: true, quantity: true, whenToWear: true, note: true, ppeItem: { select: ITEM_REF } } })
  const requirements = await client.trainingRequirement.findMany({
    where: { source: 'ROLE_SHEET', roleSheetId: row.id },
    orderBy: [{ course: { sortOrder: 'asc' } }, { course: { code: 'asc' } }, { id: 'asc' }],
    select: { id: true, courseId: true, withinDays: true, note: true, course: { select: COURSE_REF } },
  })
  const people = await client.employee.findMany({ where: { roleSheetId: row.id, status: 'ACTIVE' }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], take: 500, select: { id: true, firstName: true, lastName: true } })
  const plan = row.healthPlans[0] ?? null
  return {
    ...sheetRowView(context, row),
    description: row.description,
    createdAt: toUtcIso(row.createdAt),
    items: items.map((item) => ({ id: item.id, seq: item.seq, kind: item.kind as RoleSheetItemKind, title: item.title, note: item.note })),
    kit: kit.map((entry) => ({
      id: entry.id,
      seq: entry.seq,
      ppeItemId: entry.ppeItemId,
      item: { code: entry.ppeItem.code, name: entry.ppeItem.name, nameI18n: i18nOf(entry.ppeItem.nameI18n), category: entry.ppeItem.category, standard: entry.ppeItem.standard, sizes: entry.ppeItem.sizes, status: entry.ppeItem.status as RoleSheetStatus },
      quantity: entry.quantity,
      whenToWear: entry.whenToWear,
      note: entry.note,
    })),
    requirements: requirements.map((entry) => ({
      id: entry.id,
      courseId: entry.courseId,
      course: { code: entry.course.code, name: entry.course.name, nameI18n: i18nOf(entry.course.nameI18n), type: entry.course.type, hours: entry.course.hours.toString(), refresherMonths: entry.course.refresherMonths, status: entry.course.status as RoleSheetStatus },
      withinDays: entry.withinDays,
      note: entry.note,
    })),
    plan: { needed: plan ? plan.needed : null, frequencyMonths: plan?.frequencyMonths ?? null, endOfEmploymentVisit: plan?.endOfEmploymentVisit ?? false, setOn: plan ? dayOrNull(plan.setOn) : null },
    peopleInRole: people.map((person) => ({ employeeId: person.id, name: `${person.firstName} ${person.lastName}` })),
  }
}

/** The names of the courses and PPE items a preview names (the lines carry ids; the screen says them in words). */
export async function refsOf(client: Client, changes: SheetChanges, impact: readonly ImpactLine[]) {
  const courseIds = [...new Set([...changes.courses.added, ...changes.courses.removed, ...changes.courses.changed.map((change) => change.courseId), ...impact.map((entry) => entry.courseId).filter((value): value is string => value !== null)])]
  const itemIds = [...new Set([...changes.kit.added, ...changes.kit.removed, ...changes.kit.changed.map((change) => change.ppeItemId), ...impact.map((entry) => entry.ppeItemId).filter((value): value is string => value !== null)])]
  const courses = courseIds.length > 0 ? await client.safetyCourse.findMany({ where: { id: { in: courseIds } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, name: true, nameI18n: true, type: true } }) : []
  const items = itemIds.length > 0 ? await client.ppeItem.findMany({ where: { id: { in: itemIds } }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true, nameI18n: true, category: true } }) : []
  return {
    courses: courses.map((course) => ({ id: course.id, code: course.code, name: course.name, nameI18n: i18nOf(course.nameI18n), type: course.type })),
    ppeItems: items.map((item) => ({ id: item.id, code: item.code, name: item.name, nameI18n: i18nOf(item.nameI18n), category: item.category })),
  }
}

/** The lines of "What this changes" as an answer says them. */
export const impactView = (lines: readonly ImpactLine[]) =>
  lines.map((entry) => ({ ...entry, names: entry.names ? entry.names.map((person) => ({ ...person })) : null, withinDays: entry.withinDays ? { ...entry.withinDays } : null }))

/** The changes as an answer says them (the parts the Apply writes are the module's, not the screen's). */
export const changesView = (changes: SheetChanges, header: readonly string[]) => ({
  header: [...header],
  risks: { added: [...changes.risks.added], removed: [...changes.risks.removed] },
  surveillanceNeeds: { added: [...changes.surveillanceNeeds.added], removed: [...changes.surveillanceNeeds.removed] },
  kit: {
    added: [...changes.kit.added],
    removed: [...changes.kit.removed],
    changed: changes.kit.changed.map((change) => ({ ppeItemId: change.ppeItemId, quantity: change.quantity ? { ...change.quantity } : null, whenToWear: change.whenToWear ? { ...change.whenToWear } : null })),
  },
  courses: { added: [...changes.courses.added], removed: [...changes.courses.removed], changed: changes.courses.changed.map((change) => ({ courseId: change.courseId, withinDays: { ...change.withinDays } })) },
  surveillance: changes.surveillance ? { ...changes.surveillance } : null,
  nothing: header.length === 0 && !changes.itemsChanged && !changes.kitChanged && !changes.requirementsChanged && changes.surveillance === null,
})
