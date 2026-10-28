import { isAdminAssignment, isLive, scopeProblems } from '@nexus/factory-domain/auth/roles/roles'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { activeAdmins, liveAssignment } from './access'
import type { AssignmentInput, AssignmentView } from './contract'

/**
 * Giving and ending role assignments (features PLT-030, PLT-032), inside a command's transaction: the roles routes
 * and invitations use the same functions. An assignment names an office role of the tenant (row-level security hides
 * other tenants' roles; the foreign key includes tenantId) and a valid scope: every company or a list of the tenant's
 * active companies, sites of those companies, any parties. It is never deleted: ending it sets endedAt.
 */

export const ASSIGNMENT_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  allCompanies: true,
  companyIds: true,
  siteIds: true,
  partyIds: true,
  validFrom: true,
  validTo: true,
  endedAt: true,
  version: true,
  role: { select: { key: true, name: true, permissions: true } },
} as const

type AssignmentRow = {
  id: string
  userId: string
  roleId: string
  allCompanies: boolean
  companyIds: string[]
  siteIds: string[]
  partyIds: string[]
  validFrom: Date
  validTo: Date | null
  endedAt: Date | null
  version: number
  role: { key: string; name: string; permissions: string[] }
}

export function assignmentViewOf(row: AssignmentRow, now: Date): AssignmentView {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    roleKey: row.role.key,
    roleName: row.role.name,
    allCompanies: row.allCompanies,
    companyIds: row.companyIds,
    siteIds: row.siteIds,
    partyIds: row.partyIds,
    validFrom: toUtcIso(row.validFrom),
    validTo: row.validTo ? toUtcIso(row.validTo) : null,
    endedAt: row.endedAt ? toUtcIso(row.endedAt) : null,
    live: isLive(row, now),
    version: row.version,
  }
}

/** What an audit row records of an assignment. */
export const assignmentAudit = (view: AssignmentView) => ({
  userId: view.userId,
  role: view.roleKey,
  allCompanies: view.allCompanies,
  companyIds: view.companyIds,
  siteIds: view.siteIds,
  partyIds: view.partyIds,
  validFrom: view.validFrom,
  validTo: view.validTo,
})

const at = (prefix: string, issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ ...issue, path: `${prefix}${issue.path}` }))

/** Creates one assignment after checking the role and the scope. `path` prefixes the issue paths (`roles/0/`). */
export async function createAssignment(
  tx: CommandTx,
  input: AssignmentInput,
  options: { readonly userId: string; readonly now: Date; readonly grantedById: string; readonly path?: string },
): Promise<AssignmentView> {
  const path = options.path ?? ''
  const scope = { allCompanies: input.allCompanies, companyIds: input.companyIds, siteIds: input.siteIds, partyIds: input.partyIds }
  const problems = at(path, scopeProblems(scope))
  const role = await tx.role.findUnique({ where: { id: input.roleId }, select: { key: true, system: true } })
  if (!role) problems.push({ path: `${path}roleId`, message: 'No role of the tenant has this id.' })
  else if (role.system && !templateOf(role.key)) problems.push({ path: `${path}roleId`, message: 'This system role was retired; it gives nothing.' })
  if (!scope.allCompanies && scope.companyIds.length > 0) {
    const found = await tx.company.count({ where: { id: { in: [...scope.companyIds] }, status: 'ACTIVE' } })
    if (found !== new Set(scope.companyIds).size) problems.push({ path: `${path}companyIds`, message: 'Every company must be an active company of the tenant.' })
  }
  if (scope.siteIds.length > 0) {
    const sites = await tx.site.findMany({ where: { id: { in: [...scope.siteIds] } }, select: { companyId: true } })
    const outside = sites.some((site) => !scope.allCompanies && !scope.companyIds.includes(site.companyId))
    if (sites.length !== new Set(scope.siteIds).size || outside) problems.push({ path: `${path}siteIds`, message: 'Every site must be a site of the companies reached.' })
  }
  const validFrom = input.validFrom ? new Date(input.validFrom) : options.now
  const validTo = input.validTo ? new Date(input.validTo) : null
  if (validTo && validTo.getTime() <= validFrom.getTime()) problems.push({ path: `${path}validTo`, message: 'The end must come after the start.' })
  if (problems.length > 0) throw new ValidationError('The role assignment is not valid.', problems)

  const row = await tx.roleAssignment.create({
    data: { id: newId(), userId: options.userId, roleId: input.roleId, ...scope, companyIds: [...scope.companyIds], siteIds: [...scope.siteIds], partyIds: [...scope.partyIds], validFrom, validTo, grantedById: options.grantedById, createdAt: options.now },
    select: ASSIGNMENT_SELECT,
  })
  return assignmentViewOf(row, options.now)
}

/**
 * Ends the person's assignments that are live or still to start (a deactivation, a revoked or a new invitation), and
 * returns how many. No administrator check: the user-status machine guards the moves that remove one.
 */
export async function endAllAssignments(tx: CommandTx, userId: string, at: { now: Date; endedById: string }): Promise<number> {
  const { count } = await tx.roleAssignment.updateMany({
    where: { userId, endedAt: null, OR: [{ validTo: null }, { validTo: { gt: at.now } }] },
    data: { endedAt: at.now, endedById: at.endedById, version: { increment: 1 } },
  })
  return count
}

/** Refuses to end the last administrator's administrator assignment (the tenant would have nobody to fix access). */
export async function assertKeepsAnAdmin(tx: CommandTx, row: AssignmentRow & { user: { status: string } }, now: Date): Promise<void> {
  if (row.user.status !== 'ACTIVE' || !isLive(row, now) || !isAdminAssignment({ permissions: row.role.permissions as never }, row)) return
  if ((await activeAdmins(tx, now, { assignmentId: row.id })).size === 0) {
    throw new InvalidStateError('This is the last administrator of the tenant: give an administrator role to someone else first.')
  }
}

/** The person's assignments, newest first (live and ended). */
export async function listAssignments(tx: CommandTx, userId: string, now: Date): Promise<AssignmentView[]> {
  const rows = await tx.roleAssignment.findMany({ where: { userId }, orderBy: [{ validFrom: 'desc' }, { id: 'desc' }], take: 200, select: ASSIGNMENT_SELECT })
  return rows.map((row) => assignmentViewOf(row, now))
}

/** The live assignments of each user (the user list). */
export async function liveAssignmentsOf(tx: CommandTx, userIds: readonly string[], now: Date): Promise<Map<string, AssignmentView[]>> {
  const rows = await tx.roleAssignment.findMany({ where: { userId: { in: [...userIds] }, ...liveAssignment(now) }, orderBy: [{ validFrom: 'asc' }, { id: 'asc' }], select: ASSIGNMENT_SELECT })
  const byUser = new Map<string, AssignmentView[]>()
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), assignmentViewOf(row, now)])
  return byUser
}

/** The assignment, or a 404 (row-level security hides another tenant's). */
export async function findAssignment(tx: CommandTx, assignmentId: string) {
  const row = await tx.roleAssignment.findUnique({ where: { id: assignmentId }, select: { ...ASSIGNMENT_SELECT, user: { select: { status: true } } } })
  if (!row) throw new NotFoundError('Role assignment not found.')
  return row
}
