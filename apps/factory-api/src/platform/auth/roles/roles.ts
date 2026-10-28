import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { GRAIN_DESCRIPTIONS, GRAINS, isGrain, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import {
  ADMIN_PERMISSION,
  contentChange,
  customKey,
  customKeyProblems,
  normalizeContent,
  roleProblems,
  templateAdds,
} from '@nexus/factory-domain/auth/roles/roles'
import { ROLE_TEMPLATES, templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../../core/command'
import { requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import type { OfficeAuth } from '../sessions/office-auth'
import { activeAdmins, heldRoles, liveAssignment } from './access'
import { assertKeepsAnAdmin, assertWithinAssignerScope, assignmentAudit, assignmentViewOf, ASSIGNMENT_SELECT, createAssignment, findAssignment, listAssignments } from './assignments'
import type { AssignBody, CreateRoleBody, EditRoleBody, EndAssignmentBody } from './contract'
import { syncRolesInCommand } from './sync'
import { isOutdated, systemRoleChanges } from './system-roles'

/**
 * Roles and assignments (plan A1 §3.11; features PLT-029, PLT-030, PLT-032). Every change is ONE command with its
 * audit rows, needs a step-up (A1 §3.10: user and role changes), and:
 *   - a system role is never edited (copy it into a custom role); a custom role's edit says what it adds and removes;
 *   - a person gives and ends roles only within their own roles.assign scope (companies, sites, parties);
 *   - nobody gives themselves a role, ends their own, or edits a role they hold (separation of duties): another
 *     administrator does it;
 *   - the tenant keeps an administrator (a person with roles.assign over every company): the last one's assignment is
 *     not ended, and roles.assign is not taken away from the role that makes the last one.
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

const ROLE_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  system: true,
  basedOn: true,
  requireMfa: true,
  permissions: true,
  grains: true,
  version: true,
} as const

type RoleRow = { id: string; key: string; name: string; description: string | null; system: boolean; basedOn: string | null; requireMfa: boolean; permissions: string[]; grains: string[]; version: number }

const mutable = (adds: { readonly permissionsAdded: readonly string[]; readonly grainsAdded: readonly Grain[] }) => ({
  permissionsAdded: [...adds.permissionsAdded],
  grainsAdded: [...adds.grainsAdded],
})

function roleViewOf(row: RoleRow, holders: number) {
  const grains = row.grains.filter(isGrain)
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    system: row.system,
    basedOn: row.basedOn,
    audience: 'office' as const,
    requireMfa: row.requireMfa,
    permissions: row.permissions,
    grains,
    version: row.version,
    holders,
    outdated: row.system && isOutdated(row),
    templateAdds: row.system ? { permissionsAdded: [], grainsAdded: [] } : mutable(templateAdds({ basedOn: row.basedOn, permissions: row.permissions as Permission[], grains })),
  }
}

async function roleWithHolders(client: FactoryClient | CommandTx, roleId: string, now: Date) {
  const row = await client.role.findUnique({ where: { id: roleId }, select: { ...ROLE_SELECT, _count: { select: { assignments: { where: liveAssignment(now) } } } } })
  if (!row) throw new NotFoundError('Role not found.')
  return roleViewOf(row, row._count.assignments)
}

export function listTemplates() {
  return {
    templates: ROLE_TEMPLATES.map((template) => ({
      key: template.key,
      audience: template.audience,
      name: template.name,
      description: template.description,
      requireMfa: template.requireMfa,
      permissions: [...template.permissions],
      grains: [...template.grains],
    })),
    permissions: FACTORY_PERMISSIONS.assignable.map(({ name, area, description, risk }) => ({ name, area, description, risk })),
    grains: GRAINS.map((grain) => ({ grain, description: GRAIN_DESCRIPTIONS[grain] })),
  }
}

export async function listRoles(auth: OfficeAuth, request: FastifyRequest) {
  const now = auth.clock.now()
  const rows = await request.withClient((client) =>
    client.role.findMany({
      orderBy: [{ system: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { ...ROLE_SELECT, _count: { select: { assignments: { where: liveAssignment(now) } } } },
    }),
  )
  return { roles: rows.map((row) => roleViewOf(row, row._count.assignments)) }
}

/** The content a create or an edit asks for, checked (400 with the paths of the problems). */
function checkedContent(content: { name: string; requireMfa: boolean; permissions: readonly string[]; grains: readonly string[] }) {
  const issues = roleProblems({ ...content, permissions: content.permissions as Permission[], grains: content.grains as Grain[] })
  if (issues.length > 0) throw new ValidationError('The role is not valid.', issues)
  return normalizeContent({ ...content, permissions: [...content.permissions] as Permission[], grains: content.grains.filter(isGrain) })
}

export async function createRole(auth: OfficeAuth, request: FastifyRequest, body: CreateRoleBody) {
  const context = officeContextOf(request)
  requireStepUp(auth, request)
  const keyIssues = customKeyProblems(body.key)
  if (keyIssues.length > 0) throw new ValidationError('The key is not valid.', keyIssues)
  const source = body.basedOn === undefined ? undefined : templateOf(body.basedOn)
  if (body.basedOn !== undefined && !source) throw new ValidationError('No template has this key.', [{ path: 'basedOn', message: 'Expected a template key.' }])
  const content = checkedContent({
    name: body.name,
    requireMfa: body.requireMfa ?? source?.requireMfa ?? false,
    permissions: body.permissions ?? source?.permissions ?? [],
    grains: body.grains ?? source?.grains ?? [],
  })
  const id = newId()
  const key = customKey(body.key)
  try {
    const { result } = await auth.command(context, { name: 'roles.create', input: body }, async ({ tx, now, audit }) => {
      await tx.role.create({
        data: { id, key, name: content.name, description: body.description ?? null, basedOn: source?.key ?? null, requireMfa: content.requireMfa, permissions: content.permissions, grains: content.grains, createdAt: now, createdById: context.actorId },
      })
      audit({ recordType: 'Role', recordId: id, after: { key, name: content.name, basedOn: source?.key ?? null, requireMfa: content.requireMfa, permissions: content.permissions, grains: content.grains } })
      return roleWithHolders(tx, id, now)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('A role with this key exists already.')
    throw error
  }
}

export async function editRole(auth: OfficeAuth, request: FastifyRequest, roleId: string, body: EditRoleBody) {
  const context = officeContextOf(request)
  requireStepUp(auth, request)
  const { result } = await auth.command(
    context,
    { name: 'roles.edit', input: body, record: { type: 'Role', id: roleId, expectedVersion: body.version } },
    async ({ tx, now, audit }) => {
      const before = await tx.role.findUniqueOrThrow({ where: { id: roleId }, select: ROLE_SELECT })
      if (before.system) throw new InvalidStateError('A system role follows its template and cannot be edited; copy it into a custom role.')
      const held = await heldRoles(tx, context.actorId, now)
      if (held.some((entry) => entry.roleId === roleId)) throw new ForbiddenError('You hold this role: ask another administrator to edit it.')
      const after = checkedContent({
        name: body.name ?? before.name,
        requireMfa: body.requireMfa ?? before.requireMfa,
        permissions: body.permissions ?? before.permissions,
        grains: body.grains ?? before.grains,
      })
      const description = body.description === undefined ? before.description : body.description
      if (before.permissions.includes(ADMIN_PERMISSION) && !after.permissions.includes(ADMIN_PERMISSION)) {
        const others = await activeAdmins(tx, now, { roleId })
        const through = await activeAdmins(tx, now)
        if (through.size > 0 && others.size === 0) throw new InvalidStateError(`This role makes the last administrators of the tenant; it keeps ${ADMIN_PERMISSION}.`)
      }
      await tx.role.update({ where: { id: roleId }, data: { name: after.name, description, requireMfa: after.requireMfa, permissions: after.permissions, grains: after.grains } })
      const change = contentChange({ permissions: before.permissions as Permission[], grains: before.grains.filter(isGrain) }, after)
      audit({
        recordType: 'Role',
        recordId: roleId,
        before: { name: before.name, description: before.description, requireMfa: before.requireMfa, permissions: before.permissions, grains: before.grains },
        after: { name: after.name, description, requireMfa: after.requireMfa, permissions: after.permissions, grains: after.grains, ...change },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return roleWithHolders(tx, roleId, now)
    },
  )
  return result
}

export async function syncTemplates(auth: OfficeAuth, request: FastifyRequest) {
  const context = officeContextOf(request)
  requireStepUp(auth, request)
  const pending = await request.withClient((client) => systemRoleChanges(client))
  if (pending.length === 0) return { created: 0, updated: 0 }
  const { result } = await auth.command(context, { name: 'roles.syncTemplates', input: null }, syncRolesInCommand)
  return result
}

export async function userAssignments(auth: OfficeAuth, request: FastifyRequest, userId: string) {
  const assignments = await request.withClient(async (client) => {
    const user = await client.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) throw new NotFoundError('User not found.')
    return listAssignments(client, userId, auth.clock.now())
  })
  return { assignments }
}

export async function assignRole(auth: OfficeAuth, request: FastifyRequest, userId: string, body: AssignBody) {
  const context = officeContextOf(request)
  requireStepUp(auth, request)
  if (userId === context.actorId) throw new ForbiddenError('You cannot give yourself a role: ask another administrator.')
  const { reason, ...input } = body
  const { result } = await auth.command(context, { name: 'roles.assign', input: body }, async ({ tx, now, audit }) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } })
    if (!user) throw new NotFoundError('User not found.')
    if (user.status === 'DEACTIVATED') throw new InvalidStateError('A deactivated user holds no roles; invite them again.')
    const view = await createAssignment(tx, input, { userId, now, grantedById: context.actorId, assignerGrants: context.grants })
    audit({ recordType: 'RoleAssignment', recordId: view.id, after: assignmentAudit(view), ...(reason ? { reason } : {}) })
    return view
  })
  return result
}

export async function endAssignment(auth: OfficeAuth, request: FastifyRequest, assignmentId: string, body: EndAssignmentBody) {
  const context = officeContextOf(request)
  requireStepUp(auth, request)
  const { result } = await auth.command(
    context,
    { name: 'roles.unassign', input: body, record: { type: 'RoleAssignment', id: assignmentId, expectedVersion: body.version } },
    async ({ tx, now, audit }) => {
      const row = await findAssignment(tx, assignmentId)
      if (row.userId === context.actorId) throw new ForbiddenError('You cannot end your own role: ask another administrator.')
      if (row.endedAt !== null) throw new InvalidStateError('This role assignment has ended already.')
      await assertWithinAssignerScope(tx, row, context.grants)
      await assertKeepsAnAdmin(tx, row, now)
      const ended = await tx.roleAssignment.update({ where: { id: assignmentId }, data: { endedAt: now, endedById: context.actorId }, select: ASSIGNMENT_SELECT })
      const view = assignmentViewOf(ended, now)
      audit({ recordType: 'RoleAssignment', recordId: assignmentId, before: assignmentAudit(assignmentViewOf(row, now)), after: { endedAt: view.endedAt }, ...(body.reason ? { reason: body.reason } : {}) })
      return view
    },
  )
  return result
}
