import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_PPE_ISSUE } from '@nexus/factory-domain/safety/ppe/permissions'
import { gapLines, PPE_LAW, PPE_LIMITS, receiptsOf, standingIssues, type GapLine, type HeldRow, type PpeIssueKind } from '@nexus/factory-domain/safety/ppe/rules'
import { holdingKey } from '@nexus/factory-domain/safety/rolesheets/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { nameOf } from '../../people/employees/store'
import { asked, assertMayAt, mayAt, officeOf, siteScope, todayOf } from '../organisation/access'
import { holdingsOf, roleNeedsOf } from '../rolesheets/needs'
import { ISSUE_SELECT, RECEIPT_KIND, RECORD_ISSUE, receiptViews, type IssueRow } from './store'

/**
 * Who lacks what (B-W2b-134; QHS-260, QHS-261; design plant.ppe tiles "People missing kit items", "Receipts not signed", the
 * lenses "Gaps per person" and "Kits per role", the new tab "Person PPE card", people.employees › Safety "PPE issued"), office
 * only, safety.view:
 *
 *   GET /safety/ppe/counts              the tiles (people missing kit items, paper receipts without their scan; replacements due
 *                                       and items below minimum are the design's Later tiles: a figure, and null)
 *   GET /safety/ppe/gaps                each ACTIVE person against their role's kit (?companyId&siteId&roleSheetId&q; view
 *                                       missing (default): the people who miss a unit, the lines they miss; all: everyone,
 *                                       role or none, every kit line: the issue dialog's person picker)
 *   GET /safety/ppe/kits                roles × items with how many and when to wear (read here, edited in the role sheet)
 *   GET /safety/ppe/people/:employeeId  one person's PPE card: their kit against what they hold, every receipt, the leaver step
 *
 * The kit is the role sheet's (B-W2b-128 `roleNeedsOf`), what a person holds the shared read (`holdingsOf`: ISSUE rows no VOID
 * voids); the units due for replacement are this step's rule (factory-domain ppe `unitsDue`). No money in any of these.
 */

type Client = FactoryClient | CommandTx

const PERSON_SELECT = { id: true, firstName: true, lastName: true, employeeCode: true, companyId: true, siteId: true, roleSheetId: true, status: true, site: { select: { code: true, name: true } } } as const satisfies Prisma.EmployeeSelect
type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof PERSON_SELECT }>

const ITEM_REF_SELECT = { id: true, code: true, name: true, nameI18n: true, category: true, sizes: true, status: true, lifeMonths: true } as const satisfies Prisma.PpeItemSelect
type ItemRef = Prisma.PpeItemGetPayload<{ select: typeof ITEM_REF_SELECT }>

const i18nOf = (value: Prisma.JsonValue | null): Record<string, string> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)
const itemRefView = (item: ItemRef | undefined) =>
  item ? { code: item.code, name: item.name, nameI18n: i18nOf(item.nameI18n), category: item.category as string, sizes: item.sizes, status: item.status as string } : { code: '', name: '', nameI18n: null, category: '', sizes: [] as string[], status: 'ARCHIVED' }

export interface PersonGaps {
  readonly person: PersonRow
  readonly role: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly lines: readonly (GapLine & { readonly item: ReturnType<typeof itemRefView> })[]
  readonly missing: number
  readonly replace: number
  readonly lastIssueAt: Date | null
}

/** Each person against their role's kit: one read per table, whatever the number of people. */
export async function gapsOf(client: Client, people: readonly PersonRow[], today: BusinessDate): Promise<PersonGaps[]> {
  const roles = await roleNeedsOf(client, people.map((person) => person.roleSheetId).filter((id): id is string => id !== null))
  const itemIds = [...new Set([...roles.values()].flatMap((role) => role.content.kit.map((line) => line.ppeItemId)))]
  const items = itemIds.length > 0 ? new Map(((await client.ppeItem.findMany({ where: { id: { in: itemIds } }, select: ITEM_REF_SELECT })) as ItemRef[]).map((item) => [item.id, item])) : new Map<string, ItemRef>()
  const employeeIds = people.map((person) => person.id)
  const { held } = await holdingsOf(client, employeeIds, [], itemIds, today)
  const rows =
    employeeIds.length > 0
      ? await client.ppeIssue.findMany({ where: { employeeId: { in: employeeIds } }, select: { id: true, kind: true, employeeId: true, ppeItemId: true, quantity: true, issuedAt: true, voidsId: true } })
      : []
  const byPerson = new Map<string, (HeldRow & { employeeId: string })[]>()
  for (const row of rows) {
    const list = byPerson.get(row.employeeId) ?? []
    list.push({ ...row, kind: row.kind as PpeIssueKind })
    byPerson.set(row.employeeId, list)
  }
  return people.map((person) => {
    const role = person.roleSheetId ? (roles.get(person.roleSheetId) ?? null) : null
    const standing = standingIssues(byPerson.get(person.id) ?? [])
    const lines = role
      ? gapLines(
          role.content.kit,
          (itemId) => held.get(holdingKey(person.id, itemId)) ?? 0,
          standing,
          (itemId) => items.get(itemId)?.lifeMonths ?? null,
          today,
        ).map((line) => ({ ...line, item: itemRefView(items.get(line.ppeItemId)) }))
      : []
    return {
      person,
      role: role ? { id: role.roleSheetId, code: role.code, name: role.name } : null,
      lines,
      missing: lines.reduce((sum, line) => sum + line.missing, 0),
      replace: lines.reduce((sum, line) => sum + line.replace, 0),
      lastIssueAt: standing[0]?.issuedAt ?? null,
    }
  })
}

const lineView = (line: PersonGaps['lines'][number]) => ({
  ppeItemId: line.ppeItemId,
  item: { code: line.item.code, name: line.item.name, nameI18n: line.item.nameI18n, category: line.item.category, sizes: line.item.sizes, status: line.item.status },
  quantity: line.quantity,
  held: line.held,
  missing: line.missing,
  replace: line.replace,
  whenToWear: line.whenToWear,
})

interface PlaceQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
}

/** The ACTIVE people of the caller's reach (safety.view over their company and site), by last name. */
async function peopleInScope(client: Client, context: OfficeContext, query: PlaceQuery & { readonly roleSheetId?: string | undefined; readonly q?: string | undefined }): Promise<PersonRow[]> {
  const q = query.q?.trim()
  return (await client.employee.findMany({
    where: {
      AND: [
        siteScope(context, SAFETY_VIEW) as Prisma.EmployeeWhereInput,
        asked(query, 'strict') as Prisma.EmployeeWhereInput,
        { status: 'ACTIVE' },
        ...(query.roleSheetId ? [{ roleSheetId: query.roleSheetId }] : []),
        ...(q ? [{ OR: [{ firstName: { contains: q, mode: 'insensitive' as const } }, { lastName: { contains: q, mode: 'insensitive' as const } }, { employeeCode: { contains: q, mode: 'insensitive' as const } }] }] : []),
      ],
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    take: PPE_LIMITS.people + 1,
    select: PERSON_SELECT,
  })) as PersonRow[]
}

/** GET /safety/ppe/gaps. */
export async function listGaps(caller: CommandCaller, query: PlaceQuery & { readonly roleSheetId?: string | undefined; readonly view?: 'missing' | 'all' | undefined; readonly q?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const view = query.view ?? 'missing'
  return caller.withClient(async (client) => {
    const read = await peopleInScope(client, context, query)
    const people = read.slice(0, PPE_LIMITS.people)
    const gaps = await gapsOf(client, people, today)
    const shown = view === 'all' ? gaps : gaps.filter((entry) => entry.missing > 0)
    return {
      people: shown.slice(0, PPE_LIMITS.list).map((entry) => ({
        employee: { id: entry.person.id, name: nameOf(entry.person), employeeCode: entry.person.employeeCode },
        companyId: entry.person.companyId,
        siteId: entry.person.siteId,
        site: { code: entry.person.site.code, name: entry.person.site.name },
        role: entry.role,
        lines: (view === 'all' ? entry.lines : entry.lines.filter((line) => line.missing > 0)).map(lineView),
        missing: entry.missing,
        replace: entry.replace,
        lastIssueAt: entry.lastIssueAt ? toUtcIso(entry.lastIssueAt) : null,
        canIssue: mayAt(context, SAFETY_PPE_ISSUE, entry.person),
      })),
      complete: read.length <= PPE_LIMITS.people && shown.length <= PPE_LIMITS.list,
      withoutRole: gaps.filter((entry) => entry.role === null).length,
      today,
      law: PPE_LAW,
    }
  })
}

/** Paper receipts (not every line voided) whose signed scan is not on file, among these ISSUE rows. */
export async function unsignedPaper(client: Client, rows: readonly IssueRow[]): Promise<number> {
  const paper = rows.filter((row) => row.kind === 'ISSUE' && row.method === 'PAPER')
  if (paper.length === 0) return 0
  const receipts = receiptsOf(paper)
  const voided = new Set((await client.ppeIssue.findMany({ where: { kind: 'VOID', voidsId: { in: paper.map((row) => row.id) } }, select: { voidsId: true } })).map((row) => row.voidsId!))
  const open = receipts.filter((receipt) => receipt.rows.some((row) => !voided.has(row.id)))
  if (open.length === 0) return 0
  const ids = open.map((receipt) => receipt.receiptId)
  const kept = new Set((await client.generatedDocument.findMany({ where: { recordType: RECORD_ISSUE, recordId: { in: ids }, kind: RECEIPT_KIND }, select: { fileId: true } })).map((row) => row.fileId))
  const scanned = new Set((await client.storedFile.findMany({ where: { recordType: RECORD_ISSUE, recordId: { in: ids }, status: 'AVAILABLE' }, select: { id: true, recordId: true } })).filter((file) => !kept.has(file.id)).map((file) => file.recordId))
  return open.filter((receipt) => !scanned.has(receipt.receiptId)).length
}

/** GET /safety/ppe/counts. */
export async function ppeCounts(caller: CommandCaller, query: PlaceQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const read = await peopleInScope(client, context, query)
    const gaps = await gapsOf(client, read.slice(0, PPE_LIMITS.people), today)
    const paper = (await client.ppeIssue.findMany({
      where: { AND: [siteScope(context, SAFETY_VIEW) as Prisma.PpeIssueWhereInput, asked(query, 'strict') as Prisma.PpeIssueWhereInput, { kind: 'ISSUE', method: 'PAPER' }] },
      select: ISSUE_SELECT,
    })) as IssueRow[]
    return {
      peopleMissingKit: gaps.filter((entry) => entry.missing > 0).length,
      receiptsNotSigned: await unsignedPaper(client, paper),
      replacementsDue: gaps.filter((entry) => entry.replace > 0).length,
      itemsBelowMinimum: null,
      complete: read.length <= PPE_LIMITS.people,
      today,
    }
  })
}

/** GET /safety/ppe/kits: the ACTIVE roles of the caller's sites × the items of their kits. */
export async function listKits(caller: CommandCaller, query: PlaceQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const roles = await client.roleSheet.findMany({
      where: { AND: [siteScope(context, SAFETY_VIEW) as Prisma.RoleSheetWhereInput, asked(query, 'strict') as Prisma.RoleSheetWhereInput, { status: 'ACTIVE' }] },
      orderBy: [{ site: { code: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
      take: PPE_LIMITS.list + 1,
      select: { id: true, code: true, name: true, companyId: true, siteId: true, site: { select: { code: true, name: true } }, _count: { select: { employees: { where: { status: 'ACTIVE' } } } } },
    })
    const shown = roles.slice(0, PPE_LIMITS.list)
    const lines = shown.length > 0 ? await client.ppeKitLine.findMany({ where: { roleSheetId: { in: shown.map((role) => role.id) } }, orderBy: [{ roleSheetId: 'asc' }, { seq: 'asc' }], select: { roleSheetId: true, ppeItemId: true, quantity: true, whenToWear: true } }) : []
    const itemIds = [...new Set(lines.map((line) => line.ppeItemId))]
    const items = itemIds.length > 0 ? await client.ppeItem.findMany({ where: { id: { in: itemIds } }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true, nameI18n: true, category: true, status: true } }) : []
    return {
      roles: shown.map((role) => ({ id: role.id, code: role.code, name: role.name, companyId: role.companyId, siteId: role.siteId, site: { code: role.site.code, name: role.site.name }, people: role._count.employees })),
      items: items.map((item) => ({ id: item.id, code: item.code, name: item.name, nameI18n: i18nOf(item.nameI18n), category: item.category as string, status: item.status as string })),
      cells: lines.map((line) => ({ roleSheetId: line.roleSheetId, ppeItemId: line.ppeItemId, quantity: line.quantity, whenToWear: line.whenToWear })),
      complete: roles.length <= PPE_LIMITS.list,
    }
  })
}

/** GET /safety/ppe/people/:employeeId: one person's PPE card (any status: a leaver's card stays readable). */
export async function personCard(caller: CommandCaller, employeeId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const person = isUuid(employeeId) ? ((await client.employee.findUnique({ where: { id: employeeId }, select: PERSON_SELECT })) as PersonRow | null) : null
    if (!person) throw new NotFoundError('Person not found.')
    assertMayAt(context, SAFETY_VIEW, person, 'Person')
    const [gaps] = await gapsOf(client, [person], today)
    // Receipts at a site the caller reads (a person who moved keeps their earlier site's receipts there).
    const rows = ((await client.ppeIssue.findMany({ where: { employeeId: person.id, kind: 'ISSUE' }, select: ISSUE_SELECT })) as IssueRow[]).filter((row) => mayAt(context, SAFETY_VIEW, row))
    const leaving = await client.leaverCase.findFirst({
      where: { employeeId: person.id, status: { in: ['OPEN', 'DONE'] } },
      orderBy: [{ startedAt: 'desc' }],
      select: { id: true, steps: { where: { kind: 'PPE_RETURNED' }, select: { status: true, doneAt: true, recordType: true, recordId: true } } },
    })
    const step = leaving?.steps[0] ?? null
    return {
      employee: { id: person.id, name: nameOf(person), employeeCode: person.employeeCode, status: person.status as string, companyId: person.companyId, siteId: person.siteId, site: { code: person.site.code, name: person.site.name } },
      role: gaps!.role,
      kit: gaps!.lines.map(lineView),
      receipts: await receiptViews(client, context, rows),
      returned: leaving && step ? { caseId: leaving.id, status: step.status as string, doneAt: step.doneAt ? toUtcIso(step.doneAt) : null, issueId: step.recordType === RECORD_ISSUE ? step.recordId : null } : null,
      canIssue: mayAt(context, SAFETY_PPE_ISSUE, person),
      today,
      law: PPE_LAW,
    }
  })
}
