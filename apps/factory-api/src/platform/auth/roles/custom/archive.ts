import type { FastifyRequest } from 'fastify'
import { CUSTOM_ROLE_REFUSALS, type CustomRoleRefusal } from '@nexus/factory-domain/auth/roles/custom'
import { ADMIN_PERMISSION } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../../core/command'
import { requireContext, type OfficeContext } from '../../../../core/context'
import { databaseNow } from '../../../audit/security-events/record'
import { requireStepUp } from '../../office/account'
import type { OfficeAuth } from '../../sessions/office-auth'
import { activeAdmins, heldRoles } from '../access'
import { ASSIGNMENT_SELECT, assertWithinAssignerScope } from '../assignments'
import { roleWithHolders } from '../roles'
import type { ArchiveRoleBody, RestoreRoleBody } from './contract'

/**
 * A custom role archived, never deleted (B-W2b-404; PLT-031; B-W2b-373's schema): ONE command each, with its audit rows
 * and the event `security.role_archive_changed`.
 *
 *   archive   a custom role only: never a ready-made one, never one the person holds (separation of duties), never the
 *             one that makes the tenant's last administrators; its live assignments (also those that start later) end in
 *             the same command, each within the person's own roles.assign scope (else 403), and then a fresh code is asked
 *             as for ending any assignment (an unheld role asks none); the role is archived in ONE update with nothing
 *             else (archivedAt, archivedById, version): the database refuses an archived role a change or a new holder
 *             (409 roles/ROLE_ARCHIVED on the routes)
 *   restore   both cleared, nothing else; the role can be given again
 * Not the command's record guard: the database lets an archived role change only by being restored, so the version is
 * compared and moved in the same single update. The time is the database's own (it refuses an archive in the future).
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

const refused = (status: 'conflict' | 'forbidden', code: CustomRoleRefusal) => new DomainError(status, CUSTOM_ROLE_REFUSALS[code], [{ path: `roles/${code}`, message: CUSTOM_ROLE_REFUSALS[code] }])

const ROLE_STATE = { id: true, key: true, system: true, audience: true, permissions: true, version: true, archivedAt: true } as const

async function customRoleOf(tx: CommandTx, roleId: string) {
  const role = await tx.role.findUnique({ where: { id: roleId }, select: ROLE_STATE })
  if (!role || (role.audience !== 'OFFICE' && role.audience !== 'FLOOR')) throw new NotFoundError('Role not found.')
  if (role.system) throw refused('conflict', 'system')
  return role
}

const stale = () => new ConflictError('The role changed meanwhile. Reload it, then try again.')

export async function archiveRole(auth: OfficeAuth, request: FastifyRequest, roleId: string, body: ArchiveRoleBody) {
  const context = officeContextOf(request)
  const { result } = await auth.command(context, { name: 'roles.archive', input: body }, async ({ tx, now, audit, emit }) => {
    const role = await customRoleOf(tx, roleId)
    if (role.archivedAt !== null) throw refused('conflict', 'alreadyArchived')
    if (role.version !== body.version) throw stale()
    if ((await heldRoles(tx, context.actorId, now)).some((entry) => entry.roleId === roleId)) throw refused('forbidden', 'held')
    if (role.permissions.includes(ADMIN_PERMISSION)) {
      const through = await activeAdmins(tx, now)
      const others = await activeAdmins(tx, now, { roleId })
      if (through.size > 0 && others.size === 0) throw refused('conflict', 'lastAdmin')
    }
    const at = await databaseNow(tx)
    // Every assignment the database counts as holding it: not ended, not past its end (also those that start later).
    const holding = await tx.roleAssignment.findMany({ where: { roleId, endedAt: null, OR: [{ validTo: null }, { validTo: { gt: at } }] }, orderBy: [{ id: 'asc' }], select: ASSIGNMENT_SELECT })
    for (const row of holding) await assertWithinAssignerScope(tx, row, context.grants)
    // Ending assignments is a role change (A1 §3.10): a fresh code, as POST /auth/role-assignments/:id/end asks.
    if (holding.length > 0) requireStepUp(auth, request)
    for (const row of holding) {
      await tx.roleAssignment.update({ where: { id: row.id }, data: { endedAt: now, endedById: context.actorId } })
      audit({ action: 'roles.unassign', recordType: 'RoleAssignment', recordId: row.id, companyId: null, before: { endedAt: null }, after: { endedAt: toUtcIso(now), because: 'roles.archive' }, reason: body.reason })
    }
    const { count } = await tx.role.updateMany({ where: { id: roleId, version: body.version, archivedAt: null }, data: { archivedAt: at, archivedById: context.actorId, version: body.version + 1 } })
    if (count !== 1) throw stale()
    audit({ recordType: 'Role', recordId: roleId, companyId: null, before: { archivedAt: null }, after: { archivedAt: toUtcIso(at), assignmentsEnded: holding.length }, reason: body.reason })
    emit({ type: 'security.role_archive_changed', subject: roleId, payload: { roleId, archived: true } })
    return roleWithHolders(tx, roleId, now)
  })
  return result
}

export async function restoreRole(auth: OfficeAuth, request: FastifyRequest, roleId: string, body: RestoreRoleBody) {
  const context = officeContextOf(request)
  const { result } = await auth.command(context, { name: 'roles.restore', input: body }, async ({ tx, now, audit, emit }) => {
    const role = await customRoleOf(tx, roleId)
    if (role.archivedAt === null) throw refused('conflict', 'notArchived')
    if (role.version !== body.version) throw stale()
    const { count } = await tx.role.updateMany({ where: { id: roleId, version: body.version, archivedAt: { not: null } }, data: { archivedAt: null, archivedById: null, version: body.version + 1 } })
    if (count !== 1) throw stale()
    audit({ recordType: 'Role', recordId: roleId, companyId: null, before: { archivedAt: toUtcIso(role.archivedAt) }, after: { archivedAt: null }, ...(body.reason ? { reason: body.reason } : {}) })
    emit({ type: 'security.role_archive_changed', subject: roleId, payload: { roleId, archived: false } })
    return roleWithHolders(tx, roleId, now)
  })
  return result
}
