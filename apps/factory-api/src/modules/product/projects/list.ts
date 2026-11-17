import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PROJECT_LIMITS, STATUS_WORDS, targetStateOf, targetWords, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { linkedViewsOf } from './links'
import { peopleOf } from './members'
import { dayOf, mayRead, officeOf, PROJECT_COLUMNS, readableProject, readableWhere, type ProjectRow, type Reader } from './store'
import { projectViewsOf } from './views'

/**
 * The projects list and page reads (threads plan TH-5, B-TH-070; PROJ-G10, PROJ-G11; design PROJ.list, PROJ.record, PROJ.home-F06).
 * Office only; threads.read over each project's company and outside company (a person limited to brand A lists only brand A's
 * and office-only projects: W30).
 *
 *   GET /projects                  the list frame (Products › Development › Projects): Number, Name, Outside company (none:
 *                                  office only), Lead, Status, Target date (with its state in words), Last message, New for me
 *                                  (the reader's OWN unread notifications of it; muted: no count, a muted mark), Linked (count).
 *                                  Views: MINE (I am in it: the default), ACTIVE, ON_HOLD, CLOSED, ALL; filters: outside company,
 *                                  company, lead, season, target (OVERDUE, THIS_MONTH), q (number or name); sort TARGET (nearest
 *                                  first), PARTY (grouped by outside company), RECENT (last message); paged by 50 (cursor), at
 *                                  most 1,000 rows read. The export source `products.projects` reads the same.
 *   GET /projects/:projectId       the page: the project, its people, its linked records, its tasks (open, overdue) and files
 *                                  (count) — the thread itself is GET /threads/Project/<id>, its tasks GET /tasks?scope=RECORD,
 *                                  its files GET /files (the record frame's own reads)
 *   GET /projects/counts           ?partyId: "Projects (n)" on a customer's or supplier's band (its open projects the reader
 *                                  reads; 0: the band shows no count)
 *
 * No money anywhere; no count of messages per person (art. 4): only my own unread marks, for me.
 */

export const PROJECT_VIEWS = ['MINE', 'ACTIVE', 'ON_HOLD', 'CLOSED', 'ALL'] as const
export type ProjectListView = (typeof PROJECT_VIEWS)[number]
export const PROJECT_SORTS = ['TARGET', 'PARTY', 'RECENT'] as const
export type ProjectSort = (typeof PROJECT_SORTS)[number]
export const PROJECT_TARGETS = ['OVERDUE', 'THIS_MONTH'] as const

export interface ProjectListQuery {
  readonly view?: ProjectListView | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  /** `none`: office-only projects. */
  readonly outside?: 'none' | undefined
  readonly leadId?: string | undefined
  readonly seasonCode?: string | undefined
  readonly target?: (typeof PROJECT_TARGETS)[number] | undefined
  readonly q?: string | undefined
  readonly sort?: ProjectSort | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const today = (): string => businessDate(serverClock.now())

function monthEnd(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/** The list's own filter (beside the reader's scope). */
function filterOf(query: ProjectListQuery, now: string): Prisma.ProjectWhereInput {
  const view = query.view ?? 'MINE'
  const clauses: Prisma.ProjectWhereInput[] = []
  if (view === 'ACTIVE' || view === 'ON_HOLD' || view === 'CLOSED') clauses.push({ status: view })
  if (view === 'MINE') clauses.push({ status: { not: 'CLOSED' } })
  if (query.companyId && isUuid(query.companyId)) clauses.push({ companyId: query.companyId })
  if (query.outside === 'none') clauses.push({ partyId: null })
  else if (query.partyId && isUuid(query.partyId)) clauses.push({ partyId: query.partyId })
  if (query.leadId && isUuid(query.leadId)) clauses.push({ leadId: query.leadId })
  if (query.seasonCode) clauses.push({ seasonCode: query.seasonCode })
  if (query.target === 'OVERDUE') clauses.push({ status: { not: 'CLOSED' }, targetDate: { lt: new Date(`${now}T00:00:00.000Z`) } })
  if (query.target === 'THIS_MONTH') clauses.push({ targetDate: { gte: new Date(`${now.slice(0, 8)}01T00:00:00.000Z`), lte: new Date(`${monthEnd(now)}T00:00:00.000Z`) } })
  const q = query.q?.trim()
  if (q) clauses.push({ OR: [{ number: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] })
  return clauses.length === 0 ? {} : { AND: clauses }
}

const STATUS_ORDER: Readonly<Record<string, number>> = { ACTIVE: 0, ON_HOLD: 1, CLOSED: 2 }

export interface ProjectListRow {
  readonly id: string
  readonly number: string
  readonly name: string
  readonly companyId: string
  readonly party: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly lead: { readonly id: string; readonly name: string }
  readonly status: ProjectStatus
  readonly statusWords: { readonly it: string; readonly en: string }
  readonly targetDate: string
  readonly target: { readonly state: string; readonly days: number; readonly words: { readonly it: string; readonly en: string } | null }
  readonly seasonCode: string | null
  readonly lastMessageAt: string | null
  readonly newForMe: number
  readonly muted: boolean
  readonly mine: boolean
  readonly linked: number
  readonly version: number
}

/** The rows of these projects for this reader (one read per kind). */
export async function listRowsOf(db: Reader, meId: string, rows: readonly ProjectRow[], now: string): Promise<ProjectListRow[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const names = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.leadId))] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const partyIds = [...new Set(rows.flatMap((row) => (row.partyId ? [row.partyId] : [])))]
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
  const threads = new Map((await db.thread.findMany({ where: { recordType: 'Project', recordId: { in: ids } }, select: { recordId: true, lastMessageAt: true } })).map((row) => [row.recordId, row.lastMessageAt]))
  const follows = new Map((await db.recordFollower.findMany({ where: { recordType: 'Project', recordId: { in: ids }, userId: meId }, select: { recordId: true, muted: true } })).map((row) => [row.recordId, row.muted]))
  const unread = new Map((await db.notification.groupBy({ by: ['recordId'], where: { userId: meId, recordType: 'Project', recordId: { in: ids }, readAt: null, doneAt: null }, _count: { _all: true } })).map((row) => [row.recordId, row._count._all]))
  const linked = new Map((await db.projectLink.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: { _all: true } })).map((row) => [row.projectId, row._count._all]))
  return rows.map((row) => {
    const status = row.status as ProjectStatus
    const targetDate = dayOf(row.targetDate)
    const target = targetStateOf(status, targetDate, now)
    const muted = follows.get(row.id) ?? false
    const last = threads.get(row.id) ?? null
    return {
      id: row.id,
      number: row.number,
      name: row.name,
      companyId: row.companyId,
      party: row.partyId ? (parties.get(row.partyId) ?? { id: row.partyId, code: '', name: '' }) : null,
      lead: { id: row.leadId, name: names.get(row.leadId) ?? '' },
      status,
      statusWords: STATUS_WORDS[status],
      targetDate,
      target: { state: target.state, days: target.days, words: targetWords(target.state, target.days) },
      seasonCode: row.seasonCode,
      lastMessageAt: last ? toUtcIso(last) : null,
      newForMe: muted ? 0 : (unread.get(row.id) ?? 0),
      muted,
      mine: follows.has(row.id),
      linked: linked.get(row.id) ?? 0,
      version: row.version,
    }
  })
}

/** GET /projects */
export async function listProjects(caller: CommandCaller, query: ProjectListQuery): Promise<{ rows: ProjectListRow[]; total: number; next: string | null; complete: boolean }> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = today()
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const offset = query.cursor && /^\d{1,4}$/.test(query.cursor) ? Number(query.cursor) : 0
  return caller.withClient(async (db) => {
    const scope = readableWhere(actor)
    const own = filterOf(query, now)
    // MINE: the projects I am in (any reason; muted ones too: the row says so).
    const mineIds = (query.view ?? 'MINE') === 'MINE' ? (await db.recordFollower.findMany({ where: { recordType: 'Project', userId: context.actorId }, select: { recordId: true }, take: PROJECT_LIMITS.list })).map((row) => row.recordId) : null
    const where: Prisma.ProjectWhereInput = { AND: [scope, own, ...(mineIds ? [{ id: { in: mineIds } }] : [])] }
    const read = await db.project.findMany({ where, orderBy: [{ targetDate: 'asc' }, { id: 'asc' }], take: PROJECT_LIMITS.list + 1, select: PROJECT_COLUMNS })
    const complete = read.length <= PROJECT_LIMITS.list
    const visible = read.slice(0, PROJECT_LIMITS.list).filter((row) => mayRead(actor, row))
    let ordered = visible
    if ((query.sort ?? 'TARGET') === 'TARGET') ordered = [...visible].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.targetDate.getTime() - b.targetDate.getTime() || a.id.localeCompare(b.id))
    let rows: ProjectListRow[]
    if (query.sort === 'PARTY' || query.sort === 'RECENT') {
      // Sorted by what only the rows know (the outside company's name, the thread's last message): every row read, then paged.
      const all = await listRowsOf(db, context.actorId, ordered, now)
      const sorted =
        query.sort === 'PARTY'
          ? all.sort((a, b) => (a.party?.name ?? '\uffff').localeCompare(b.party?.name ?? '\uffff') || a.targetDate.localeCompare(b.targetDate) || a.id.localeCompare(b.id))
          : all.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.id.localeCompare(b.id))
      rows = sorted.slice(offset, offset + limit)
    } else {
      rows = await listRowsOf(db, context.actorId, ordered.slice(offset, offset + limit), now)
    }
    const next = offset + limit < ordered.length ? String(offset + limit) : null
    return { rows, total: ordered.length, next, complete }
  })
}

/** GET /projects/:projectId: the page's reads in one answer. */
export async function projectPage(caller: CommandCaller, projectId: string) {
  const { context, actor, row } = await readableProject(caller, projectId)
  const now = new Date()
  return caller.withClient(async (db) => {
    const [project] = await projectViewsOf(db, actor, [row], today())
    const people = await peopleOf(db, row, context.actorId, now)
    const links = await linkedViewsOf(db, actor, row.id)
    const taskWhere = { recordType: 'Project', recordId: row.id }
    const open = await db.task.count({ where: { ...taskWhere, status: 'OPEN' } })
    const overdue = await db.task.count({ where: { ...taskWhere, status: 'OPEN', dueDate: { lt: new Date(`${today()}T00:00:00.000Z`) } } })
    const files = await db.storedFile.count({ where: { recordType: 'Project', recordId: row.id, status: 'AVAILABLE' } })
    const mine = await db.recordFollower.findFirst({ where: { recordType: 'Project', recordId: row.id, userId: context.actorId }, select: { muted: true, reason: true } })
    return { project: project!, people, links, tasks: { open, overdue }, files: { count: files }, me: { following: mine !== null, muted: mine?.muted ?? false, reason: mine?.reason ?? null } }
  })
}

/** GET /projects/counts?partyId: a company band's "Projects (n)": its open projects the reader reads. */
export async function projectCounts(caller: CommandCaller, query: { readonly partyId: string }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!isUuid(query.partyId)) return { open: 0, all: 0 }
  return caller.withClient(async (db) => {
    const rows = await db.project.findMany({ where: { AND: [readableWhere(actor), { partyId: query.partyId }] }, take: PROJECT_LIMITS.list, select: { companyId: true, partyId: true, status: true } })
    const visible = rows.filter((row) => mayRead(actor, row))
    return { open: visible.filter((row) => row.status !== 'CLOSED').length, all: visible.length }
  })
}
