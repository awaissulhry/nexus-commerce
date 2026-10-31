import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { ADMIN_PERMISSION } from '@nexus/factory-domain/auth/roles/roles'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  affectedHolders,
  strandsAdmins,
  TWO_FACTOR_ACTION,
  TWO_FACTOR_REFUSALS,
  twoFactorLockOf,
  twoFactorRefusal,
  type AdminSubject,
  type TwoFactorRefusal,
  type TwoFactorHolder,
  type TwoFactorRole,
} from '@nexus/factory-domain/ops/two-factor'
import type { CommandTx } from '../../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../../auth/office/account'
import { liveAssignment } from '../../auth/roles/access'
import type { OfficeAuth } from '../../auth/sessions/office-auth'
import type { TwoFactorChangeBody, TwoFactorRoleView } from './contract'

/**
 * Two-factor per role (B-W2a-36; PLT-045; design admin.security "Sign-in rules", admin.roles Role › Scope rules ›
 * Two-factor). The rules are factory-domain ops/two-factor; here they meet the rows:
 *
 *   GET  /admin/security/two-factor           every office role, whether it asks, why it cannot stop asking, its holders
 *                                             (names with users.view) and whether each has two-factor set up
 *   POST /admin/security/two-factor/preview   who a change affects, how many open sessions keep the role until they end,
 *                                             and what it would refuse — before anything is saved
 *   POST /admin/security/two-factor           ONE command for one or many roles (any refusal refuses all): step-up first
 *                                             (roles.manage), versions read, the separation of duties, the lock-out rule
 *                                             on the committed state, one audit row per role (action TWO_FACTOR_ACTION:
 *                                             platform/auth/sessions reads it for "from the next sign-in"), one
 *                                             security.two_factor_changed event per role.
 * A ready-made role takes the change too (a raise the template sync keeps: auth/roles system-roles.ts `contentFor`).
 */

type Client = FactoryClient | CommandTx

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

const ROLE_SELECT = { id: true, key: true, name: true, system: true, audience: true, requireMfa: true, requireMfaSince: true, grains: true, permissions: true, version: true } as const
type RoleRow = { id: string; key: string; name: string; system: boolean; audience: 'OFFICE' | 'FLOOR'; requireMfa: boolean; requireMfaSince: Date | null; grains: string[]; permissions: string[]; version: number }

const asRole = (row: RoleRow): TwoFactorRole => ({ id: row.id, key: row.key, system: row.system, audience: row.audience === 'FLOOR' ? 'floor' : 'office', requireMfa: row.requireMfa, grains: row.grains })

/** The live holders of these roles: people not suspended or gone, with their two-factor. */
async function holdersOf(client: Client, roleIds: readonly string[], now: Date): Promise<Map<string, TwoFactorHolder[]>> {
  const rows = await client.roleAssignment.findMany({
    where: { roleId: { in: [...roleIds] }, ...liveAssignment(now), user: { status: { in: ['ACTIVE', 'INVITED'] } } },
    select: { roleId: true, user: { select: { id: true, displayName: true, totpConfirmedAt: true } } },
  })
  const byRole = new Map<string, TwoFactorHolder[]>()
  for (const row of rows) {
    const list = byRole.get(row.roleId) ?? []
    if (!list.some((holder) => holder.userId === row.user.id)) list.push({ userId: row.user.id, name: row.user.displayName, twoFactor: row.user.totpConfirmedAt !== null })
    byRole.set(row.roleId, list)
  }
  return byRole
}

/** The roles the person holds now (any audience: office assignments). */
async function rolesHeldBy(client: Client, userId: string, now: Date): Promise<Set<string>> {
  const rows = await client.roleAssignment.findMany({ where: { userId, ...liveAssignment(now) }, select: { roleId: true } })
  return new Set(rows.map((row) => row.roleId))
}

function viewOf(row: RoleRow, holders: readonly TwoFactorHolder[], options: { names: boolean; mine: ReadonlySet<string> }): TwoFactorRoleView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    system: row.system,
    requireMfa: row.requireMfa,
    // B-W2b-24: since when it asks (the database keeps it on every write path; null: not asking, or from before W2b).
    requireMfaSince: row.requireMfaSince ? toUtcIso(row.requireMfaSince) : null,
    lock: twoFactorLockOf(asRole(row)),
    templateAsks: row.system && templateOf(row.key)?.requireMfa === true,
    version: row.version,
    holders: [...holders].sort((a, b) => a.name.localeCompare(b.name)).map((holder) => ({ userId: holder.userId, name: options.names ? holder.name : null, twoFactor: holder.twoFactor })),
    heldByMe: options.mine.has(row.id),
  }
}

export async function listTwoFactor(auth: OfficeAuth, request: FastifyRequest) {
  const context = officeContextOf(request)
  const actor = actorOf(context)
  const now = auth.clock.now()
  return request.withClient(async (client) => {
    const rows = (await client.role.findMany({ where: { audience: 'OFFICE' }, orderBy: [{ system: 'desc' }, { name: 'asc' }, { id: 'asc' }], take: 500, select: ROLE_SELECT })) as RoleRow[]
    const holders = await holdersOf(client, rows.map((row) => row.id), now)
    const mine = await rolesHeldBy(client, context.actorId, now)
    const names = holds(actor, 'users.view')
    return { roles: rows.map((row) => viewOf(row, holders.get(row.id) ?? [], { names, mine })), canChange: holds(actor, 'roles.manage') }
  })
}

/** The active administrators (roles.assign over every company) with their two-factor and their administrator roles. */
async function adminSubjects(client: Client, now: Date): Promise<AdminSubject[]> {
  const rows = await client.roleAssignment.findMany({
    where: { ...liveAssignment(now), allCompanies: true, user: { status: 'ACTIVE' }, role: { audience: 'OFFICE', permissions: { has: ADMIN_PERMISSION } } },
    select: { roleId: true, user: { select: { id: true, requireMfa: true, totpConfirmedAt: true } } },
  })
  const byUser = new Map<string, { twoFactor: boolean; requireMfa: boolean; roles: Set<string> }>()
  for (const row of rows) {
    const entry = byUser.get(row.user.id) ?? { twoFactor: row.user.totpConfirmedAt !== null, requireMfa: row.user.requireMfa, roles: new Set<string>() }
    entry.roles.add(row.roleId)
    byUser.set(row.user.id, entry)
  }
  return [...byUser].map(([userId, entry]) => ({ userId, twoFactor: entry.twoFactor, requireMfa: entry.requireMfa, adminRoleIds: [...entry.roles] }))
}

/** One refusal of a change: where (its change, or `changes` for the whole), its code and its words. */
type Refusal = { readonly path: string; readonly code: TwoFactorRefusal; readonly message: string }
const refusal = (path: string, code: TwoFactorRefusal): Refusal => ({ path, code, message: TWO_FACTOR_REFUSALS[code] })

interface Weighed {
  readonly rows: RoleRow[]
  readonly refusals: Refusal[]
  readonly holders: Map<string, TwoFactorHolder[]>
}

/** Reads the roles of a change and weighs it: every refusal, with its change's path (B-W2b-24: PATCH /auth/roles weighs a requireMfa change here too). */
export async function weigh(client: Client, body: Pick<TwoFactorChangeBody, 'changes'>, actorId: string, now: Date): Promise<Weighed> {
  const ids = body.changes.map((change) => change.roleId)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A role is named twice.', [{ path: 'body/changes', message: 'Name each role once.' }])
  const rows = (await client.role.findMany({ where: { id: { in: ids } }, select: ROLE_SELECT })) as RoleRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const mine = await rolesHeldBy(client, actorId, now)
  const refusals: Refusal[] = []
  body.changes.forEach((change, index) => {
    const row = byId.get(change.roleId)
    if (!row) throw new NotFoundError('Role not found.')
    const own = row.version !== change.version ? 'stale' : mine.has(row.id) ? 'held' : twoFactorRefusal(asRole(row), change.requireMfa)
    if (own) refusals.push(refusal(`changes/${index}`, own))
  })
  const after = new Map(body.changes.map((change) => [change.roleId, change.requireMfa]))
  const current = new Map((await client.role.findMany({ where: { audience: 'OFFICE', permissions: { has: ADMIN_PERMISSION } }, select: { id: true, requireMfa: true } })).map((row) => [row.id, row.requireMfa]))
  const admins = await adminSubjects(client, now)
  if (strandsAdmins(admins, (roleId) => current.get(roleId) ?? false, (roleId) => after.get(roleId) ?? current.get(roleId) ?? false)) refusals.push(refusal('changes', 'lockOut'))
  return { rows: body.changes.map((change) => byId.get(change.roleId)!), refusals, holders: await holdersOf(client, ids, now) }
}

export async function previewTwoFactor(auth: OfficeAuth, request: FastifyRequest, body: Pick<TwoFactorChangeBody, 'changes'>) {
  const context = officeContextOf(request)
  const actor = actorOf(context)
  const now = auth.clock.now()
  return request.withClient(async (client) => {
    const weighed = await weigh(client, body, context.actorId, now)
    const names = holds(actor, 'users.view')
    // Asking reaches the holders without two-factor (at their next sign-in); no longer asking reaches every holder.
    const affected = affectedHolders(body.changes.flatMap((change) => affectedHolders(weighed.holders.get(change.roleId) ?? [], change.requireMfa)), false)
    const raised = new Set(body.changes.filter((change) => change.requireMfa).flatMap((change) => (weighed.holders.get(change.roleId) ?? []).filter((holder) => !holder.twoFactor).map((holder) => holder.userId)))
    const openSessions = raised.size === 0 ? 0 : await client.session.count({ where: { userId: { in: [...raised] }, revokedAt: null, mfaAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } } })
    return {
      affected: affected.map((holder) => ({ userId: holder.userId, name: names ? holder.name : null, twoFactor: holder.twoFactor })),
      openSessions,
      refusals: weighed.refusals,
    }
  })
}

export async function changeTwoFactor(auth: OfficeAuth, request: FastifyRequest, body: TwoFactorChangeBody) {
  const context = officeContextOf(request)
  requireStepUp(auth, request)
  const actor = actorOf(context)
  const { result } = await auth.command(context, { name: TWO_FACTOR_ACTION, input: body }, async ({ tx, now, audit, emit }) => {
    const weighed = await weigh(tx, body, context.actorId, now)
    if (weighed.refusals.length > 0) {
      const lockOut = weighed.refusals.find((issue) => issue.path === 'changes')
      throw new DomainError('conflict', lockOut?.message ?? weighed.refusals[0]!.message, weighed.refusals.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
    }
    for (const [index, change] of body.changes.entries()) {
      const row = weighed.rows[index]!
      const { count } = await tx.role.updateMany({ where: { id: row.id, version: row.version }, data: { requireMfa: change.requireMfa, requireMfaSince: change.requireMfa ? (row.requireMfa ? row.requireMfaSince : now) : null, version: { increment: 1 } } })
      if (count !== 1) throw new DomainError('conflict', 'This role changed meanwhile: read it again.', [{ path: `body/changes/${index}`, message: 'Read the role again.' }])
      audit({ recordType: 'Role', recordId: row.id, before: { requireMfa: row.requireMfa }, after: { requireMfa: change.requireMfa }, ...(body.reason ? { reason: body.reason } : {}) })
      emit({ type: 'security.two_factor_changed', subject: row.id, payload: { roleId: row.id, requireMfa: change.requireMfa } })
    }
    const rows = (await tx.role.findMany({ where: { id: { in: body.changes.map((change) => change.roleId) } }, select: ROLE_SELECT })) as RoleRow[]
    const holders = await holdersOf(tx, rows.map((row) => row.id), now)
    const mine = await rolesHeldBy(tx, context.actorId, now)
    return { roles: rows.map((row) => viewOf(row, holders.get(row.id) ?? [], { names: holds(actor, 'users.view'), mine })) }
  })
  return result
}
