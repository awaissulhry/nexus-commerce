import type { FastifyRequest } from 'fastify'
import { isGrain, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { CUSTOM_ROLE_REFUSALS, customContentRefusals, reviewOf } from '@nexus/factory-domain/auth/roles/custom'
import { ROLE_REFUSAL_ISSUES } from '@nexus/factory-domain/auth/roles/refusals'
import { ADMIN_PERMISSION, normalizeContent, roleProblems } from '@nexus/factory-domain/auth/roles/roles'
import { NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { TWO_FACTOR_REFUSALS, twoFactorRefusal } from '@nexus/factory-domain/ops/two-factor'
import { requireContext, type OfficeContext } from '../../../../core/context'
import type { OfficeAuth } from '../../sessions/office-auth'
import { activeAdmins, heldRoles, liveAssignment } from '../access'
import { asksFreshCode } from '../roles'
import type { ReviewRoleBody } from './contract'

/**
 * The review of a change of a custom role before it is saved (B-W2b-404; PLT-031; design admin.roles "Change role 'Planner
 * (copy)'?": ReviewChangesModal "adds · removes · grains · '4 people get this at their next request'. Raising rights asks
 * for a fresh code"). No write: what PATCH /auth/roles/:roleId would add and remove, the grains, the two-factor rule, how
 * many people hold the role now (a count of the role's holders, never a figure about a person), whether saving asks for a
 * fresh code, and every reason it would be refused (codes in the paths): a ready-made or archived role, one the person
 * holds, the content's own problems, more than the person holds, the owner's every(), the last administrators, and the
 * two-factor content rule (the lock-out rule is weighed at the save itself, as Security & health does).
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

const ROLE_REVIEW_SELECT = { id: true, key: true, system: true, audience: true, name: true, requireMfa: true, permissions: true, grains: true, version: true, archivedAt: true } as const

export async function reviewRoleChange(auth: OfficeAuth, request: FastifyRequest, roleId: string, body: ReviewRoleBody) {
  const context = officeContextOf(request)
  const now = auth.clock.now()
  return request.withClient(async (client) => {
    const role = await client.role.findUnique({ where: { id: roleId }, select: { ...ROLE_REVIEW_SELECT, _count: { select: { assignments: { where: liveAssignment(now) } } } } })
    if (!role || (role.audience !== 'OFFICE' && role.audience !== 'FLOOR')) throw new NotFoundError('Role not found.')
    const before = { permissions: role.permissions as Permission[], grains: role.grains.filter(isGrain), requireMfa: role.requireMfa }
    const asked = { name: body.name ?? role.name, requireMfa: body.requireMfa ?? role.requireMfa, permissions: (body.permissions ?? role.permissions) as Permission[], grains: (body.grains ?? role.grains) as Grain[] }
    const refusals: Issue[] = []
    if (role.system) refusals.push({ path: 'roles/readyMade', message: CUSTOM_ROLE_REFUSALS.readyMade })
    if (role.archivedAt !== null) refusals.push({ path: ROLE_REFUSAL_ISSUES.archived, message: CUSTOM_ROLE_REFUSALS.archived })
    if ((await heldRoles(client, context.actorId, now)).some((entry) => entry.roleId === roleId)) refusals.push({ path: 'roles/held', message: CUSTOM_ROLE_REFUSALS.held })
    const problems = roleProblems(asked)
    refusals.push(...problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
    const after = normalizeContent({ ...asked, grains: asked.grains.filter(isGrain) })
    refusals.push(...customContentRefusals(before, after, context.grants))
    if (before.permissions.includes(ADMIN_PERMISSION) && !after.permissions.includes(ADMIN_PERMISSION)) {
      const others = await activeAdmins(client, now, { roleId })
      if ((await activeAdmins(client, now)).size > 0 && others.size === 0) refusals.push({ path: 'roles/lastAdmin', message: CUSTOM_ROLE_REFUSALS.lastAdmin })
    }
    if (after.requireMfa !== before.requireMfa) {
      const code = twoFactorRefusal({ id: role.id, key: role.key, system: role.system, audience: role.audience === 'FLOOR' ? 'floor' : 'office', requireMfa: role.requireMfa, grains: after.grains }, after.requireMfa)
      if (code) refusals.push({ path: `body/requireMfa/${code}`, message: TWO_FACTOR_REFUSALS[code] })
    }
    const review = reviewOf(before, after)
    return {
      version: role.version,
      permissionsAdded: [...review.permissionsAdded],
      permissionsRemoved: [...review.permissionsRemoved],
      grainsAdded: [...review.grainsAdded],
      grainsRemoved: [...review.grainsRemoved],
      requireMfa: review.requireMfa,
      raises: review.raises,
      asksFreshCode: asksFreshCode(before, after),
      holders: role._count.assignments,
      refusals,
    }
  })
}
