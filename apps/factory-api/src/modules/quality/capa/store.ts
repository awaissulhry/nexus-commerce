import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { isOverdue, type ActionKind, type ActionStatus, type CapaPriority, type CapaStatus, type CapaType, type TeamMember } from '@nexus/factory-domain/quality/capa/rules'
import { TASKS_MANAGE } from '@nexus/factory-domain/tasks/permissions'
import type { CommandTx } from '../../../core/command'
import { heldRoles } from '../../../platform/auth/roles/access'

/**
 * The CAPA module's rows (B-W2b-108): every read names its columns and runs one query after another on the client it is
 * given (a command's transaction or a scoped client: row-level security keeps the tenant, the API the company and the
 * customer). Office people by id; their names only in `people` (inside the record and the list of CAPAs, as the NCR list
 * names its owners). No money, no figure per person, no worker.
 */

export type Reader = FactoryClient | CommandTx

export const CAPA_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  type: true,
  title: true,
  ownerId: true,
  team: true,
  dueOn: true,
  priority: true,
  customerId: true,
  problemWhat: true,
  problemWhere: true,
  problemWhen: true,
  problemHowMany: true,
  status: true,
  closedAt: true,
  closedById: true,
  closeNote: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.CapaSelect
export type CapaRow = Prisma.CapaGetPayload<{ select: typeof CAPA_COLUMNS }>

export const SOURCE_COLUMNS = { id: true, capaId: true, recordType: true, recordId: true, note: true, createdAt: true, createdById: true } as const satisfies Prisma.CapaSourceSelect
export type SourceRow = Prisma.CapaSourceGetPayload<{ select: typeof SOURCE_COLUMNS }>

export const ACTION_COLUMNS = {
  id: true,
  capaId: true,
  seq: true,
  kind: true,
  description: true,
  ownerId: true,
  dueOn: true,
  status: true,
  remindersSent: true,
  lastRemindedAt: true,
  escalateToId: true,
  escalatedAt: true,
  doneAt: true,
  doneById: true,
  evidenceNote: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.CapaActionSelect
export type ActionRow = Prisma.CapaActionGetPayload<{ select: typeof ACTION_COLUMNS }>

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The team as the column keeps it (a list of { userId, role }; anything else is read as no one). */
export function teamOf(value: unknown): TeamMember[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => (entry && typeof entry === 'object' && typeof (entry as { userId?: unknown }).userId === 'string' && typeof (entry as { role?: unknown }).role === 'string' ? [{ userId: (entry as { userId: string }).userId, role: (entry as { role: string }).role }] : []))
}

/** The scope a CAPA is checked in: its company, and its customer when it is written for one. */
export const scopeOf = (row: Pick<CapaRow, 'companyId' | 'customerId'>): ScopedRecord => ({ companyId: row.companyId, ...(row.customerId ? { partyId: row.customerId } : {}) })

export const readCapa = (db: Reader, id: string): Promise<CapaRow | null> => (isUuid(id) ? db.capa.findUnique({ where: { id }, select: CAPA_COLUMNS }) : Promise.resolve(null))
export const readSources = (db: Reader, capaIds: readonly string[]): Promise<SourceRow[]> =>
  capaIds.length === 0 ? Promise.resolve([]) : db.capaSource.findMany({ where: { capaId: { in: [...capaIds] } }, select: SOURCE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
export const readActions = (db: Reader, capaIds: readonly string[]): Promise<ActionRow[]> =>
  capaIds.length === 0 ? Promise.resolve([]) : db.capaAction.findMany({ where: { capaId: { in: [...capaIds] } }, select: ACTION_COLUMNS, orderBy: [{ capaId: 'asc' }, { seq: 'asc' }] })

export const byCapa = <Row extends { capaId: string }>(rows: readonly Row[]): Map<string, Row[]> => {
  const map = new Map<string, Row[]>()
  for (const row of rows) map.set(row.capaId, [...(map.get(row.capaId) ?? []), row])
  return map
}

/** The names of office people, by id (people the reader may not see by name are left out: their id stays). */
export async function namesOf(db: Reader, ids: Iterable<string | null>): Promise<{ id: string; name: string }[]> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && isUuid(id)))]
  if (wanted.length === 0) return []
  return (await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })).map((user) => ({ id: user.id, name: user.displayName }))
}

/** The customers of many CAPAs, by id. */
export async function customersOf(db: Reader, rows: readonly Pick<CapaRow, 'customerId'>[]) {
  const ids = [...new Set(rows.flatMap((row) => (row.customerId ? [row.customerId] : [])))]
  if (ids.length === 0) return new Map<string, { id: string; code: string; name: string }>()
  const parties = await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(parties.map((party) => [party.id, { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }]))
}

/** Each source's number and where it stands (an NCR, a complaint), whoever reads it: the views decide what to show. */
export async function sourceFactsOf(db: Reader, sources: readonly SourceRow[]) {
  const of = (type: string) => [...new Set(sources.filter((source) => source.recordType === type).map((source) => source.recordId))]
  const ncrIds = of('Nonconformance')
  const complaintIds = of('Complaint')
  const ncrs = ncrIds.length === 0 ? [] : await db.nonconformance.findMany({ where: { id: { in: ncrIds } }, select: { id: true, companyId: true, siteId: true, number: true, title: true, stage: true, severity: true, capaId: true, causeCodeId: true } })
  const complaints = complaintIds.length === 0 ? [] : await db.complaint.findMany({ where: { id: { in: complaintIds } }, select: { id: true, companyId: true, partyId: true, number: true, status: true, category: true, customerRef: true } })
  return { ncrs: new Map(ncrs.map((row) => [row.id, row])), complaints: new Map(complaints.map((row) => [row.id, row])) }
}
export type SourceFacts = Awaited<ReturnType<typeof sourceFactsOf>>

/** One CAPA as the list and the board show it. */
export function capaSummary(row: CapaRow, facts: { readonly sources: readonly SourceRow[]; readonly actions: readonly ActionRow[]; readonly customer: { id: string; code: string; name: string } | null; readonly labels: ReadonlyMap<string, string> }, now: Date) {
  const today = businessDate(now)
  const open = facts.actions.filter((action) => action.status === 'OPEN')
  const overdue = open.filter((action) => isOverdue({ status: 'OPEN', dueOn: dayOf(action.dueOn) }, today))
  const nextDue = open.map((action) => dayOf(action.dueOn)).sort()[0] ?? null
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    type: row.type as CapaType,
    title: row.title,
    status: row.status as CapaStatus,
    priority: row.priority as CapaPriority,
    customer: facts.customer,
    ownerId: row.ownerId,
    team: teamOf(row.team),
    dueOn: dayOf(row.dueOn),
    /** The first due day of its open actions, else null (the design's "Next due"). */
    nextDue,
    overdue: row.status !== 'CLOSED' && row.status !== 'CANCELLED' && dayOf(row.dueOn) < today,
    sources: {
      count: facts.sources.length,
      items: facts.sources.slice(0, 5).map((source) => ({ id: source.id, recordType: source.recordType, recordId: source.recordId, label: facts.labels.get(source.recordId) ?? null })),
    },
    actions: { count: facts.actions.length, open: open.length, overdue: overdue.length, done: facts.actions.filter((action) => action.status === 'DONE').length },
    ageDays: Math.max(0, Math.floor((asDay(today).getTime() - asDay(businessDate(row.createdAt)).getTime()) / 86_400_000)),
    closedAt: iso(row.closedAt),
    cancelledAt: iso(row.cancelledAt),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}
export type CapaSummary = ReturnType<typeof capaSummary>

/** The labels of sources the reader may see (an NCR's number at a site they reach, a complaint's of a customer they reach). */
export function sourceLabels(facts: SourceFacts, mayNcr: (row: { companyId: string; siteId: string }) => boolean, mayComplaint: (row: { companyId: string; partyId: string }) => boolean): Map<string, string> {
  const labels = new Map<string, string>()
  for (const ncr of facts.ncrs.values()) if (mayNcr(ncr)) labels.set(ncr.id, ncr.number)
  for (const complaint of facts.complaints.values()) if (mayComplaint(complaint)) labels.set(complaint.id, complaint.number)
  return labels
}

/** One action as the Actions tab shows it (its evidence files counted). */
export async function actionViews(db: Reader, actions: readonly ActionRow[], now: Date) {
  const today = businessDate(now)
  const files = actions.length === 0 ? [] : await db.storedFile.groupBy({ by: ['recordId'], where: { recordType: 'CapaAction', recordId: { in: actions.map((action) => action.id) }, status: { not: 'DELETED' } }, _count: { _all: true } })
  const fileCount = new Map(files.map((row) => [row.recordId, row._count._all]))
  return actions.map((action) => ({
    id: action.id,
    seq: action.seq,
    kind: action.kind as ActionKind,
    description: action.description,
    ownerId: action.ownerId,
    dueOn: dayOf(action.dueOn),
    status: action.status as ActionStatus,
    overdue: isOverdue({ status: action.status as ActionStatus, dueOn: dayOf(action.dueOn) }, today),
    remindersSent: action.remindersSent,
    lastRemindedAt: iso(action.lastRemindedAt),
    escalateToId: action.escalateToId,
    escalatedAt: iso(action.escalatedAt),
    doneAt: iso(action.doneAt),
    doneById: action.doneById,
    evidenceNote: action.evidenceNote,
    files: fileCount.get(action.id) ?? 0,
    cancelReason: action.cancelReason,
    version: action.version,
    createdAt: toUtcIso(action.createdAt),
  }))
}
export type ActionView = Awaited<ReturnType<typeof actionViews>>[number]

// ---- people -----------------------------------------------------------------------------------------------------------

/** A person as their live office roles make them now (two-factor taken as proved: they prove it to sign in). */
export async function personActor(db: Reader, tenantId: string, userId: string, now: Date): Promise<Actor> {
  return { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db as FactoryClient | CommandTx, userId, now), true) }
}

/** Whether this person is an ACTIVE office user who sees the CAPA (quality.capa.view over its company and customer). */
export async function seesCapa(db: Reader, tenantId: string, userId: string, scope: ScopedRecord, now: Date): Promise<boolean> {
  if (!isUuid(userId)) return false
  const user = await db.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })
  if (!user) return false
  return can(await personActor(db, tenantId, userId, now), QUALITY_CAPA_VIEW, scope)
}

/** Whether a task on the CAPA may be given to this person (platform/tasks' rule: Home, tasks there, the record's thread). */
export function remindable(actor: Actor, scope: ScopedRecord): boolean {
  return holds(actor, HOME_VIEW) && can(actor, TASKS_MANAGE, scope) && can(actor, THREADS_READ, scope)
}

/** The CAPA row locked FOR UPDATE: the first lock of every write of a CAPA (its actions and sources hold it FOR SHARE). */
export async function lockCapa(tx: CommandTx, capaId: string): Promise<{ version: number; status: CapaStatus } | null> {
  const [row] = await tx.$queryRaw<{ version: number; status: CapaStatus }[]>`SELECT "version", "status"::text AS "status" FROM "Capa" WHERE "id" = ${capaId}::uuid FOR UPDATE`
  return row ?? null
}
