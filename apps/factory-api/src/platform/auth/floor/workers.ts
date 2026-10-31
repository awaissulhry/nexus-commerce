import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { badgeCodeHash, badgeHint, newBadgeCode, printedBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { hashPin, isPinLocked, randomPin } from '@nexus/factory-domain/auth/floor/pin'
import { badgeStatus, workerStatus } from '@nexus/factory-domain/auth/floor/status'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { idempotencyKeyFrom, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import type { OfficeAuth } from '../sessions/office-auth'
import type { CreateWorkerBody, EditWorkerBody, RevokeBadgeBody, WorkerStatusBody, WorkerView } from './contract'
import { activeSite, assertReaches, officeContextOf } from './registry'
import { endSessions } from './store'

/**
 * The Office's floor workers (plan A1 §2.3, §3.10; features PLT-018, PLT-019, PLT-058; GDPR art. 5(1)(c), Statuto dei
 * Lavoratori art. 4). A worker is what the work needs and nothing more: a name, a language, an optional employee number,
 * a site, a status, a badge, a PIN hash, optionally the office user they also are. Every route is scoped by record (the
 * worker's company and site); every write is one office command with its audit row (never a secret in it).
 *
 *   workers      add (no PIN yet: a PIN reset gives the first), edit name, language, employee number, office link
 *                (version); deactivate (every sign-in ends) and reactivate.
 *   floor roles  the set of FLOOR roles a worker holds (WorkerRole): removed ones end, new ones start.
 *   badges       a new badge (128-bit code, shown once for printing) revokes the worker's older ones and ends the
 *                sign-ins made with them; a lost or revoked badge ends its sign-ins at once.
 *   PIN reset    a random policy-valid PIN, shown once; the worker must choose their own at the next sign-in (they hold
 *                nothing until then), the lock is cleared, their sign-ins end.
 * Separation of duties: nobody links a worker to themselves, or manages the roles, badges or PIN of the worker linked
 * to themselves; another administrator does it. Floor roles (workers.roles, also at creation) and credentials
 * (workers.credentials) are access changes: they need a fresh step-up (A1 §3.10), checked after the record and its
 * scope, before the command.
 */

const WORKERS_VIEW: Permission = 'workers.view'
const WORKERS_MANAGE: Permission = 'workers.manage'
const WORKERS_ROLES: Permission = 'workers.roles'
const WORKERS_CREDENTIALS: Permission = 'workers.credentials'

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const duplicateCode = () => new ConflictError('Another worker of the tenant has this employee number.')

const WORKER_VIEW_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  displayName: true,
  locale: true,
  employeeCode: true,
  userId: true,
  status: true,
  pinHash: true,
  pinMustChange: true,
  pinLockedUntil: true,
  version: true,
  badges: { where: { status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' }, take: 1, select: { id: true, hint: true, issuedAt: true } },
  roles: { where: { endedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, roleId: true, role: { select: { key: true, name: true } } } },
} as const satisfies Prisma.WorkerSelect

type WorkerRow = Prisma.WorkerGetPayload<{ select: typeof WORKER_VIEW_SELECT }>

function workerViewOf(row: WorkerRow, now: Date): WorkerView {
  const badge = row.badges[0]
  return {
    id: row.id,
    siteId: row.siteId,
    displayName: row.displayName,
    locale: row.locale,
    employeeCode: row.employeeCode,
    userId: row.userId,
    status: row.status,
    hasPin: row.pinHash !== null,
    pinMustChange: row.pinMustChange,
    locked: isPinLocked(row, now),
    badge: badge ? { id: badge.id, hint: badge.hint, issuedAt: toUtcIso(badge.issuedAt) } : null,
    roles: row.roles.map((entry) => ({ workerRoleId: entry.id, roleId: entry.roleId, key: entry.role.key, name: entry.role.name })),
    version: row.version,
  }
}

async function workerRow(client: FactoryClient | CommandTx, workerId: string): Promise<WorkerRow> {
  const row = await client.worker.findUnique({ where: { id: workerId }, select: WORKER_VIEW_SELECT })
  if (!row) throw new NotFoundError('Worker not found.')
  return row
}

/** The worker, if the office person may do `permission` on them (404 / 403 otherwise). */
async function reachableWorker(request: FastifyRequest, workerId: string, permission: Permission): Promise<WorkerRow> {
  const row = await request.withClient((client) => workerRow(client, workerId))
  assertReaches(officeContextOf(request), permission, row)
  return row
}

function notSelf(context: OfficeContext, worker: { readonly userId: string | null }): void {
  if (worker.userId !== null && worker.userId === context.actorId) {
    throw new ForbiddenError('This worker is you: ask another administrator to manage your floor roles, badge or PIN.')
  }
}

/** The floor roles of these ids, checked: FLOOR roles of the tenant, not retired (400 otherwise). */
async function floorRoles(tx: CommandTx, roleIds: readonly string[]) {
  const unique = [...new Set(roleIds)]
  const roles = await tx.role.findMany({ where: { id: { in: unique } }, select: { id: true, key: true, system: true, audience: true } })
  const problems = unique.flatMap((roleId, index) => {
    const role = roles.find((entry) => entry.id === roleId)
    if (!role) return [{ path: `roleIds/${index}`, message: 'No role of the tenant has this id.' }]
    if (role.audience !== 'FLOOR') return [{ path: `roleIds/${index}`, message: 'An office role is given to people (Office → Users), not to floor workers.' }]
    if (role.system && templateOf(role.key)?.audience !== 'floor') return [{ path: `roleIds/${index}`, message: 'This floor role was retired; it gives nothing.' }]
    return []
  })
  if (problems.length > 0) throw new ValidationError('The floor roles are not valid.', problems)
  return roles
}

async function checkUser(client: FactoryClient | CommandTx, context: OfficeContext, userId: string): Promise<void> {
  if (userId === context.actorId) throw new ForbiddenError('You cannot link a floor worker to yourself: ask another administrator.')
  const user = await client.user.findUnique({ where: { id: userId }, select: { status: true } })
  if (!user || user.status === 'DEACTIVATED') throw new ValidationError('No current user of the tenant has this id.', [{ path: 'userId', message: 'Expected a user of the tenant.' }])
}

/** B-W2b-26: the account a linked worker names agrees with its employee record's (when the record names one). */
async function checkEmployeeAccount(tx: CommandTx, workerId: string, userId: string): Promise<void> {
  const worker = await tx.worker.findUnique({ where: { id: workerId }, select: { employee: { select: { userId: true } } } })
  const recordAccount = worker?.employee?.userId ?? null
  if (recordAccount !== null && recordAccount !== userId) {
    throw new ConflictError("This worker's employee record names another office account: one person has one account (change it on the employee record in People first).")
  }
}

export async function listWorkers(auth: OfficeAuth, request: FastifyRequest, query: { siteId?: string | undefined }) {
  const context = officeContextOf(request)
  const scope = scopeWhere(actorOf(context), WORKERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkerWhereInput
  const rows = await request.withClient((client) =>
    client.worker.findMany({
      where: { AND: [scope, query.siteId ? { siteId: query.siteId } : {}] },
      orderBy: [{ siteId: 'asc' }, { displayName: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: WORKER_VIEW_SELECT,
    }),
  )
  const now = auth.clock.now()
  return { workers: rows.map((row) => workerViewOf(row, now)) }
}

export async function createWorker(auth: OfficeAuth, request: FastifyRequest, body: CreateWorkerBody) {
  const context = officeContextOf(request)
  const site = await request.withClient((client) => activeSite(client, body.siteId))
  assertReaches(context, WORKERS_MANAGE, { companyId: site.companyId, siteId: site.id })
  if ((body.roleIds ?? []).length > 0) {
    assertReaches(context, WORKERS_ROLES, { companyId: site.companyId, siteId: site.id })
    requireStepUp(auth, request)
  }
  const workerId = newId()
  const data = { displayName: body.displayName, locale: body.locale ?? 'it', employeeCode: body.employeeCode ?? null, userId: body.userId ?? null }
  try {
    const { result } = await auth.command(context, { name: 'workers.create', input: body }, async ({ tx, now, audit }) => {
      if (data.userId) await checkUser(tx, context, data.userId)
      const roles = await floorRoles(tx, body.roleIds ?? [])
      await tx.worker.create({ data: { id: workerId, companyId: site.companyId, siteId: site.id, ...data, createdAt: now, createdById: context.actorId }, select: { id: true } })
      for (const role of roles) {
        await tx.workerRole.create({ data: { id: newId(), siteId: site.id, workerId, roleId: role.id, grantedById: context.actorId, createdAt: now }, select: { id: true } })
      }
      audit({ recordType: 'Worker', recordId: workerId, companyId: site.companyId, siteId: site.id, after: { ...data, roles: roles.map((role) => role.key).sort() } })
      return workerViewOf(await workerRow(tx, workerId), now)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateCode()
    throw error
  }
}

export async function editWorker(auth: OfficeAuth, request: FastifyRequest, workerId: string, body: EditWorkerBody) {
  const context = officeContextOf(request)
  const before = await reachableWorker(request, workerId, WORKERS_MANAGE)
  const changes = {
    ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    ...(body.locale !== undefined ? { locale: body.locale } : {}),
    ...(body.employeeCode !== undefined ? { employeeCode: body.employeeCode } : {}),
    ...(body.userId !== undefined ? { userId: body.userId } : {}),
  }
  try {
    const { result } = await auth.command(context, { name: 'workers.edit', input: body, record: { type: 'Worker', id: workerId, expectedVersion: body.version } }, async ({ tx, now, audit }) => {
      if (changes.userId) await checkUser(tx, context, changes.userId)
      // B-W2b-26: a worker linked to an employee record names that record's office account (one person, one account);
      // answered here in words, before the database refuses it at the commit.
      if (changes.userId) await checkEmployeeAccount(tx, workerId, changes.userId)
      await tx.worker.updateMany({ where: { id: workerId }, data: changes })
      const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, before[key as keyof typeof changes]]))
      audit({ recordType: 'Worker', recordId: workerId, companyId: before.companyId, siteId: before.siteId, before: previous, after: changes })
      return workerViewOf(await workerRow(tx, workerId), now)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateCode()
    throw error
  }
}

export async function setWorkerStatus(auth: OfficeAuth, request: FastifyRequest, workerId: string, to: 'ACTIVE' | 'INACTIVE', body: WorkerStatusBody) {
  const context = officeContextOf(request)
  const before = await reachableWorker(request, workerId, WORKERS_MANAGE)
  const name = to === 'INACTIVE' ? 'workers.deactivate' : 'workers.reactivate'
  const { result } = await auth.command(
    context,
    { name, input: body, record: { type: 'Worker', id: workerId, ...(body.version ? { expectedVersion: body.version } : {}), transition: { machine: workerStatus, to } } },
    async ({ tx, now, audit }) => {
      const ended = to === 'INACTIVE' ? await endSessions(tx, { workerId }, 'WORKER_DEACTIVATED', now) : []
      audit({
        recordType: 'Worker',
        recordId: workerId,
        companyId: before.companyId,
        siteId: before.siteId,
        before: { status: before.status },
        after: { status: to, sessionsEnded: ended.length },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return workerViewOf(await workerRow(tx, workerId), now)
    },
  )
  return result
}

export async function setWorkerRoles(auth: OfficeAuth, request: FastifyRequest, workerId: string, roleIds: readonly string[]) {
  const context = officeContextOf(request)
  const before = await reachableWorker(request, workerId, WORKERS_ROLES)
  notSelf(context, before)
  requireStepUp(auth, request)
  const { result } = await auth.command(context, { name: 'workers.setRoles', input: { roleIds: [...new Set(roleIds)].sort() }, record: { type: 'Worker', id: workerId } }, async ({ tx, now, audit }) => {
    const wanted = await floorRoles(tx, roleIds)
    const live = await tx.workerRole.findMany({ where: { workerId, endedAt: null }, select: { id: true, roleId: true, role: { select: { key: true } } } })
    const ending = live.filter((entry) => !wanted.some((role) => role.id === entry.roleId))
    const adding = wanted.filter((role) => !live.some((entry) => entry.roleId === role.id))
    if (ending.length > 0) await tx.workerRole.updateMany({ where: { id: { in: ending.map((entry) => entry.id) }, endedAt: null }, data: { endedAt: now, endedById: context.actorId } })
    for (const role of adding) {
      await tx.workerRole.create({ data: { id: newId(), siteId: before.siteId, workerId, roleId: role.id, grantedById: context.actorId, createdAt: now }, select: { id: true } })
    }
    audit({
      recordType: 'Worker',
      recordId: workerId,
      companyId: before.companyId,
      siteId: before.siteId,
      before: { roles: live.map((entry) => entry.role.key).sort() },
      after: { roles: wanted.map((role) => role.key).sort(), added: adding.map((role) => role.key).sort(), ended: ending.map((entry) => entry.role.key).sort() },
    })
    return workerViewOf(await workerRow(tx, workerId), now)
  })
  return result
}

export async function issueBadge(auth: OfficeAuth, request: FastifyRequest, workerId: string) {
  const context = officeContextOf(request)
  const before = await reachableWorker(request, workerId, WORKERS_CREDENTIALS)
  notSelf(context, before)
  if (before.status !== 'ACTIVE') throw new InvalidStateError('An inactive worker gets no badge; reactivate them first.')
  requireStepUp(auth, request)
  // Minted before the command: only its hash and hint enter it, never its result or its audit row.
  const code = newBadgeCode()
  const badgeId = newId()
  const spec = { name: 'workers.issueBadge' as const, idempotencyKey: idempotencyKeyFrom(request), input: null, record: { type: 'Worker' as const, id: workerId } }
  const { result, replayed } = await auth.command(context, spec, async ({ tx, now, audit }) => {
    const older = await tx.badge.findMany({ where: { workerId, status: 'ACTIVE' }, select: { id: true } })
    const olderIds = older.map((badge) => badge.id)
    const ended = olderIds.length > 0 ? await endSessions(tx, { badgeId: { in: olderIds } }, 'BADGE_REVOKED', now) : []
    if (olderIds.length > 0) {
      await tx.badge.updateMany({ where: { id: { in: olderIds }, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now, revokedById: context.actorId, version: { increment: 1 } } })
    }
    const hint = badgeHint(code)
    await tx.badge.create({ data: { id: badgeId, siteId: before.siteId, workerId, codeHash: badgeCodeHash(code), hint, issuedAt: now, issuedById: context.actorId, createdAt: now }, select: { id: true } })
    audit({ recordType: 'Badge', recordId: badgeId, companyId: before.companyId, siteId: before.siteId, after: { workerId, hint, revokedBadges: olderIds, sessionsEnded: ended.length } })
    return { id: badgeId, hint, issuedAt: toUtcIso(now) }
  })
  // A repeat answers from its receipt: the first badge, and no code (it was never stored; issue a new badge).
  return { badge: result, code: replayed ? null : code, printed: replayed ? null : printedBadgeCode(code) }
}

export async function revokeBadge(auth: OfficeAuth, request: FastifyRequest, badgeId: string, body: RevokeBadgeBody) {
  const context = officeContextOf(request)
  const badge = await request.withClient((client) =>
    client.badge.findUnique({ where: { id: badgeId }, select: { id: true, workerId: true, status: true, worker: { select: { companyId: true, siteId: true, userId: true } } } }),
  )
  if (!badge) throw new NotFoundError('Badge not found.')
  assertReaches(context, WORKERS_CREDENTIALS, badge.worker)
  notSelf(context, badge.worker)
  requireStepUp(auth, request)
  const to = body.status ?? 'REVOKED'
  const { result } = await auth.command(
    context,
    { name: 'workers.revokeBadge', input: { status: to }, record: { type: 'Badge', id: badgeId, transition: { machine: badgeStatus, to } } },
    async ({ tx, now, audit }) => {
      const ended = await endSessions(tx, { badgeId }, 'BADGE_REVOKED', now)
      await tx.badge.updateMany({ where: { id: badgeId }, data: { revokedAt: now, revokedById: context.actorId } })
      audit({ recordType: 'Badge', recordId: badgeId, companyId: badge.worker.companyId, siteId: badge.worker.siteId, before: { status: badge.status }, after: { status: to, sessionsEnded: ended.length } })
      return { id: badgeId, workerId: badge.workerId, status: to, revokedAt: toUtcIso(now) }
    },
  )
  return result
}

export async function resetPin(auth: OfficeAuth, request: FastifyRequest, workerId: string) {
  const context = officeContextOf(request)
  const before = await reachableWorker(request, workerId, WORKERS_CREDENTIALS)
  notSelf(context, before)
  requireStepUp(auth, request)
  // Minted (and hashed) before the command: only the hash enters it, never its result or its audit row.
  const pin = randomPin({ employeeCode: before.employeeCode })
  const pinHash = await hashPin(pin, auth.pins)
  const spec = { name: 'workers.resetPin' as const, idempotencyKey: idempotencyKeyFrom(request), input: null, record: { type: 'Worker' as const, id: workerId } }
  const { replayed } = await auth.command(context, spec, async ({ tx, now, audit }) => {
    const ended = await endSessions(tx, { workerId }, 'PIN_RESET', now)
    await tx.worker.updateMany({ where: { id: workerId }, data: { pinHash, pinMustChange: true, pinChangedAt: now, failedPinAttempts: 0, pinLockedUntil: null } })
    audit({ recordType: 'Worker', recordId: workerId, companyId: before.companyId, siteId: before.siteId, after: { pinReset: true, pinMustChange: true, sessionsEnded: ended.length } })
    return null
  })
  // A repeat answers from its receipt: the first reset stands, its PIN is not shown again (reset again for a new one).
  return { pin: replayed ? null : pin, pinMustChange: true as const }
}
