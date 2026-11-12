import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { APPROVALS_DECIDE, APPROVALS_VIEW } from '@nexus/factory-domain/approvals/permissions'
import { askersOf, isOwnRequest, type ApprovalField } from '@nexus/factory-domain/approvals/rules'
import { GRAINS, grainPermission, isGrain, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can, holds, scopeWhere, type Actor, type Permission, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { heldRoles, liveAssignment } from '../auth/roles/access'
import { kindOf, registeredKinds } from './kinds'

/**
 * The approval engine's reads (B-W2b-282): who sees which request, who may decide it, the names the screens show. A request
 * is seen by the person who asked (or wrote) it, by its approver (the person named, or the holders of the role named over
 * its company and site), and by whoever may see its subject (its kind's view permission over its company and site); always
 * behind approvals.view. It is decided only by its approver who also holds approvals.decide there, and never by whoever
 * asked or wrote it, nor the office account of the floor worker who asked (Owner answer Q3 = A, the Owner included).
 */

export type Reader = FactoryClient | CommandTx

export const TASK_SCOPE: ScopeColumns = { company: 'companyId', site: { field: 'siteId', nullable: true } }
export const RULE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** A live office role assignment of a person, as the approver rule reads it. */
export interface HeldApproverRole {
  readonly roleId: string
  readonly allCompanies: boolean
  readonly companyIds: readonly string[]
  readonly siteIds: readonly string[]
}

export async function approverRolesOf(db: Reader, userId: string, now: Date): Promise<HeldApproverRole[]> {
  return (await heldRoles(db, userId, now)).map((held) => ({ roleId: held.roleId, allCompanies: held.scope.allCompanies, companyIds: held.scope.companyIds, siteIds: held.scope.siteIds }))
}

/** Whether a held role reaches a request's company and site. */
export const roleReaches = (held: HeldApproverRole, place: { readonly companyId: string; readonly siteId: string | null }): boolean =>
  (held.allCompanies || held.companyIds.includes(place.companyId)) && (held.siteIds.length === 0 || place.siteId === null || held.siteIds.includes(place.siteId))

function roleClauses(roles: readonly HeldApproverRole[]): Prisma.ApprovalTaskWhereInput[] {
  return roles.map((held) => ({
    AND: [
      { approverRoleId: held.roleId },
      held.allCompanies ? {} : { companyId: { in: [...held.companyIds] } },
      held.siteIds.length === 0 ? {} : { OR: [{ siteId: null }, { siteId: { in: [...held.siteIds] } }] },
    ],
  }))
}

/** The requests addressed to the person: by name, or to a role they hold over the request's company and site. */
export function addressedTo(userId: string, roles: readonly HeldApproverRole[]): Prisma.ApprovalTaskWhereInput {
  return { OR: [{ approverUserId: userId }, ...roleClauses(roles)] }
}

/** The requests the person asked or wrote. */
export const askedBy = (userId: string): Prisma.ApprovalTaskWhereInput => ({ OR: [{ requestedById: userId }, { createdById: userId }] })

/** Every request the reader may see (approvals.view held; the route checked it). */
export function visibleTasks(actor: Actor, userId: string, roles: readonly HeldApproverRole[]): Prisma.ApprovalTaskWhereInput {
  if (!holds(actor, APPROVALS_VIEW)) return { id: { in: [] } }
  const kinds = registeredKinds().filter((kind) => holds(actor, kind.view))
  return {
    AND: [
      scopeWhere(actor, APPROVALS_VIEW, TASK_SCOPE) as Prisma.ApprovalTaskWhereInput,
      { OR: [askedBy(userId), addressedTo(userId, roles), ...kinds.map((kind) => ({ AND: [{ kind: kind.kind }, scopeWhere(actor, kind.view, TASK_SCOPE) as Prisma.ApprovalTaskWhereInput] }))] },
    ],
  }
}

/** The requests that wait for the reader's yes: pending, addressed to them, not their own, and theirs to decide there. */
export function waitingFor(actor: Actor, userId: string, roles: readonly HeldApproverRole[]): Prisma.ApprovalTaskWhereInput {
  if (!holds(actor, APPROVALS_DECIDE)) return { id: { in: [] } }
  return {
    AND: [
      { status: 'PENDING' },
      addressedTo(userId, roles),
      { NOT: askedBy(userId) },
      scopeWhere(actor, APPROVALS_DECIDE, TASK_SCOPE) as Prisma.ApprovalTaskWhereInput,
    ],
  }
}

export const TASK_COLUMNS = {
  id: true,
  kind: true,
  recordType: true,
  recordId: true,
  companyId: true,
  siteId: true,
  ruleIds: true,
  summary: true,
  preview: true,
  fingerprint: true,
  requestedById: true,
  requestedByWorkerId: true,
  requestedAt: true,
  approverRoleId: true,
  approverUserId: true,
  signatureMeaning: true,
  requireStepUp: true,
  dueAt: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  comment: true,
  rejectReasonCode: true,
  rejectReason: true,
  stepUpAt: true,
  withdrawnAt: true,
  withdrawnById: true,
  staleAt: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ApprovalTaskSelect
export type TaskRow = Prisma.ApprovalTaskGetPayload<{ select: typeof TASK_COLUMNS }>

/** The office account of the floor worker who asked, if any. */
export async function workerUserOf(db: Reader, task: Pick<TaskRow, 'requestedByWorkerId'>): Promise<string | null> {
  if (!task.requestedByWorkerId) return null
  return (await db.worker.findUnique({ where: { id: task.requestedByWorkerId }, select: { userId: true } }))?.userId ?? null
}

/** The people a request names as having asked it (who never decide it). */
export async function askersOfTask(db: Reader, task: Pick<TaskRow, 'requestedById' | 'createdById' | 'requestedByWorkerId'>): Promise<string[]> {
  return askersOf(task, await workerUserOf(db, task))
}

/** Whether the reader is the request's approver: the person named, or a holder of the role named over its place. */
export const isApprover = (task: Pick<TaskRow, 'approverUserId' | 'approverRoleId' | 'companyId' | 'siteId'>, userId: string, roles: readonly HeldApproverRole[]): boolean =>
  task.approverUserId !== null ? task.approverUserId === userId : roles.some((held) => held.roleId === task.approverRoleId && roleReaches(held, task))

export type DecideCheck = { readonly allowed: true } | { readonly allowed: false; readonly code: 'NOT_PENDING' | 'OWN_REQUEST' | 'NOT_APPROVER' }

/** Whether the reader may decide the request now (the database holds the same rule for every login). */
export function decideCheck(context: OfficeContext, task: Pick<TaskRow, 'status' | 'approverUserId' | 'approverRoleId' | 'companyId' | 'siteId'>, askers: readonly string[], roles: readonly HeldApproverRole[]): DecideCheck {
  if (task.status !== 'PENDING') return { allowed: false, code: 'NOT_PENDING' }
  if (isOwnRequest(askers, context.actorId)) return { allowed: false, code: 'OWN_REQUEST' }
  if (!isApprover(task, context.actorId, roles) || !can(actorOf(context), APPROVALS_DECIDE, { companyId: task.companyId, siteId: task.siteId })) return { allowed: false, code: 'NOT_APPROVER' }
  return { allowed: true }
}

/** Whether a person (their live office roles, two-factor taken as proved) holds the permission over a place. */
export async function personMay(db: Reader, tenantId: string, userId: string, permission: Permission, place: { readonly companyId: string | null; readonly siteId?: string | null }, now: Date): Promise<boolean> {
  const actor: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) }
  if (place.companyId === null) return actor.grants.some((grant) => grant.companies === 'all' && grant.permissions.includes(permission))
  return can(actor, permission, { companyId: place.companyId, siteId: place.siteId ?? null })
}

const MAX_DECIDERS = 50

/**
 * Who may decide a request (design "Why is this mine?": "who else can decide"; the held Approve's "Lucia or Marco can
 * approve it"): the person named, or the active office holders of the role named whose assignment reaches the place, who
 * hold approvals.decide there, never one who asked it. At most 50, by name.
 */
export async function decidersOf(
  db: Reader,
  tenantId: string,
  approver: { readonly approverRoleId: string | null; readonly approverUserId: string | null },
  place: { readonly companyId: string; readonly siteId: string | null },
  askers: readonly string[],
  now: Date,
): Promise<Array<{ id: string; name: string }>> {
  let candidates: string[]
  if (approver.approverUserId) candidates = [approver.approverUserId]
  else if (approver.approverRoleId) {
    const rows = await db.roleAssignment.findMany({
      where: { roleId: approver.approverRoleId, ...liveAssignment(now), role: { audience: 'OFFICE' }, user: { status: 'ACTIVE', audience: 'OFFICE' } },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { userId: true, allCompanies: true, companyIds: true, siteIds: true },
    })
    candidates = [...new Set(rows.filter((row) => roleReaches({ roleId: approver.approverRoleId!, ...row }, place)).map((row) => row.userId))]
  } else candidates = []
  const people: string[] = []
  for (const userId of candidates.filter((id) => !askers.includes(id))) {
    if (people.length >= MAX_DECIDERS) break
    if (await personMay(db, tenantId, userId, APPROVALS_DECIDE, place, now)) people.push(userId)
  }
  const users = people.length ? await db.user.findMany({ where: { id: { in: people }, status: 'ACTIVE' }, select: { id: true, displayName: true } }) : []
  return users.map((user) => ({ id: user.id, name: user.displayName })).sort((a, b) => a.name.localeCompare(b.name, 'it') || (a.id < b.id ? -1 : 1))
}

/** Display names of office users by id. */
export async function peopleNames(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

export async function roleNames(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.role.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })).map((role) => [role.id, role.name]))
}

/** The grains the reader holds. */
export const grainsOf = (actor: Actor): ReadonlySet<Grain> => new Set(GRAINS.filter((grain) => holds(actor, grainPermission(grain))))

/** A money fact's grain the reader lacks (its value, and a rule's threshold on it, stay hidden). */
export const heldGrain = (grain: unknown, grains: ReadonlySet<Grain>): boolean => isGrain(grain) && !grains.has(grain)

/** The facts of a kind whose values the reader may not see. */
export function hiddenFieldsOf(fields: readonly ApprovalField[], grains: ReadonlySet<Grain>): Set<string> {
  return new Set(fields.filter((field) => heldGrain(field.grain, grains)).map((field) => field.id))
}

/** A kind's fields, or none for a kind nobody registered. */
export const fieldsOfKind = (kind: string): readonly ApprovalField[] => kindOf(kind)?.fields ?? []
