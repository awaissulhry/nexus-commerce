import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { dueListDocument } from '@nexus/factory-domain/safety/records/documents'
import { countDue, dueCellsOf, inView, RECORD_LIMITS, RECORDS_LAW, type DueCell, type DueView } from '@nexus/factory-domain/safety/records/rules'
import type { CommandCaller } from '../../../core/command'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { officeOf, siteScope, todayOf } from '../organisation/access'
import { trainingNeedsOf, trainingPeopleOf } from '../training/needs'
import { courseRefs } from '../training/store'
import { recordFactsOf } from './holdings'
import { recordRights } from './records'

/**
 * Due and overdue training (B-W2b-139; QHS-244 "Refresher due lists; expiry dates sit on the training records"; design
 * people.skills tiles "Training overdue (person × course)", "Due in 60 days", "Language not checked", the "Training due list
 * (PDF for the RSPP)"), office only, safety.view over each person's company and site:
 *
 *   GET /safety/training/due[?companyId&siteId&courseId&roleSheetId&view&q]   the due list: one row per person × course (a
 *        register: the person by name), its state (VALID, DUE_SOON, EXPIRED, NEEDED), due by or valid until, overdue, why it
 *        is needed (the role sheet, a type of machine), the language check; `view` due (default: overdue or due within the
 *        window) | overdue | soon | language | all (lapsed records nobody needs any more included); tiles count person ×
 *        course over everyone in reach (never a figure per person)
 *   GET /safety/training/due/pdf?…&language   the same list as a PDF for the RSPP or the provider (in memory, not stored)
 *
 * Built on B-W2b-133's needs (who needs which course: never typed per person) and the records' validity (factory-domain
 * safety/records `dueCellsOf`). Nothing holds a number of the law: valid until is the record's (its day + the course's
 * refresher period, or another day with its reason); the 60 days are the design's own window.
 */


export interface DueQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly courseId?: string | undefined
  readonly roleSheetId?: string | undefined
  readonly view?: DueView | undefined
  readonly q?: string | undefined
}

function whereOf(caller: CommandCaller, query: DueQuery): Prisma.EmployeeWhereInput {
  const context = officeOf(caller)
  const words = query.q?.trim()
  return {
    AND: [
      siteScope(context, SAFETY_VIEW) as Prisma.EmployeeWhereInput,
      ...(query.companyId ? [{ companyId: query.companyId }] : []),
      ...(query.siteId ? [{ siteId: query.siteId }] : []),
      ...(query.roleSheetId ? [{ roleSheetId: query.roleSheetId }] : []),
      ...(words ? [{ OR: [{ firstName: { contains: words, mode: 'insensitive' as const } }, { lastName: { contains: words, mode: 'insensitive' as const } }, { employeeCode: { contains: words, mode: 'insensitive' as const } }] }] : []),
    ],
  }
}

const whyOf = (cell: DueCell, sources: ReadonlyMap<string, readonly ('ROLE_SHEET' | 'MACHINE_CLASS')[]>): 'ROLE' | 'MACHINE' | 'NONE' => {
  const kinds = sources.get(`${cell.employeeId}|${cell.courseId}`) ?? []
  return kinds.includes('ROLE_SHEET') ? 'ROLE' : kinds.includes('MACHINE_CLASS') ? 'MACHINE' : 'NONE'
}

async function listOf(caller: CommandCaller, query: DueQuery, now: Date) {
  const today = todayOf(now)
  const view = query.view ?? 'due'
  return caller.withClient(async (client) => {
    const where = whereOf(caller, query)
    const people = await trainingPeopleOf(client, where)
    const { needs } = await trainingNeedsOf(client, people, today)
    const cells = dueCellsOf({ needs, records: await recordFactsOf(client, people.map((person) => person.employeeId)), today })
    const sources = new Map(needs.map((need) => [`${need.employeeId}|${need.courseId}`, need.sources.map((source) => source.kind)] as const))
    const byPerson = new Map(people.map((person) => [person.employeeId, person]))
    const shown = cells
      .filter((cell) => (!query.courseId || cell.courseId === query.courseId) && inView(cell, view))
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') || byPerson.get(a.employeeId)!.name.localeCompare(byPerson.get(b.employeeId)!.name))
    const courses = await courseRefs(client, cells.map((cell) => cell.courseId))
    const sites = await client.site.findMany({ where: { id: { in: [...new Set(people.map((person) => person.siteId))] } }, select: { id: true, code: true, name: true } })
    return { today, view, cells, shown, sources, byPerson, courses, sites }
  })
}

/** GET /safety/training/due. */
export async function dueList(caller: CommandCaller, query: DueQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  const { today, view, cells, shown, sources, byPerson, courses, sites } = await listOf(caller, query, now)
  const siteOf = new Map(sites.map((site) => [site.id, site]))
  return {
    rows: shown.slice(0, RECORD_LIMITS.list).map((cell) => {
      const person = byPerson.get(cell.employeeId)!
      return {
        employee: { id: person.employeeId, name: person.name, companyId: person.companyId, siteId: person.siteId, site: siteOf.get(person.siteId) ? { code: siteOf.get(person.siteId)!.code, name: siteOf.get(person.siteId)!.name } : null },
        courseId: cell.courseId,
        state: cell.state,
        needed: cell.needed,
        required: cell.required,
        why: whyOf(cell, sources),
        dueOn: cell.dueOn,
        neededBy: cell.neededBy,
        overdue: cell.overdue,
        soon: cell.soon,
        lastResult: cell.lastResult,
        record: cell.record,
        languageNotChecked: cell.languageNotChecked,
      }
    }),
    complete: shown.length <= RECORD_LIMITS.list,
    courses,
    tiles: countDue(cells),
    view,
    ...recordRights(context),
    law: RECORDS_LAW,
    today,
  }
}

/** GET /safety/training/due/pdf. */
export async function dueListPdf(caller: CommandCaller, query: DueQuery & { readonly language?: DocumentLanguage | undefined }, now: Date = new Date()): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeOf(caller)
  const language = query.language ?? 'it'
  const { today, view, shown, sources, byPerson, courses, sites } = await listOf(caller, query, now)
  const companyIds = [...new Set(shown.map((cell) => byPerson.get(cell.employeeId)!.companyId))]
  // The letterhead: the company asked, the screen's, or the only one in the list.
  const companyId = query.companyId ?? context.companyId ?? (companyIds.length === 1 ? companyIds[0]! : null)
  if (!companyId) throw new ValidationError('Pick the company whose letterhead the list is printed on.', [{ path: 'querystring/companyId', message: 'The list spans several companies (or none): name one.' }])
  const courseOf = new Map(courses.map((course) => [course.id, course]))
  const scope = [query.siteId ? sites.find((site) => site.id === query.siteId)?.name : null, query.courseId ? courseOf.get(query.courseId)?.name : null].filter(Boolean).join(' · ') || (language === 'it' ? 'Tutte le persone in vista' : 'Everyone in view')
  const composed = dueListDocument({
    language,
    company: await companyLegalOf(caller, companyId),
    on: today,
    view,
    scope,
    rows: shown.map((cell) => ({
      person: byPerson.get(cell.employeeId)!.name,
      course: courseOf.get(cell.courseId)?.name ?? cell.courseId,
      state: cell.state,
      overdue: cell.overdue,
      dueOn: cell.dueOn,
      why: whyOf(cell, sources),
      languageChecked: cell.record ? cell.record.languageChecked : null,
    })),
  })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}
