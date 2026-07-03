/**
 * Phase S4 — Team & Access API.
 *
 * The endpoints behind the Settings › Team & Access console. All gated by
 * the RBAC manifest (/api/team/users → users.manage, /api/team/roles →
 * roles.manage). Mutations delegate to team-access.service, which enforces
 * the Owner-supremacy guardrails; GuardrailError surfaces as 409 so the UI
 * can show the reason. The actor (req.authUser, set by the RBAC gate) drives
 * owner-only checks + audit.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { OWNER_ROLE_KEY, permissionCatalog, isValidPermission } from '@nexus/shared/permissions'
import { GuardrailError } from '../lib/auth/team-guardrails.js'
import { writeAuthAudit } from '../lib/auth/audit.js'
import { truncateIp } from '../lib/auth/session.js'
import { verifyCsrf } from '../lib/auth/csrf.js'
import {
  assignRole,
  removeRole,
  deactivateUser,
  reactivateUser,
  forceSignOut,
  createRole,
  updateRole,
  deleteRole,
} from '../services/team-access.service.js'

const teamRoutes: FastifyPluginAsync = async (fastify) => {
  // Defense-in-depth CSRF on every mutating team route (the cookie's
  // SameSite/Partitioned already blocks cross-site POST; this matches the
  // S1 auth routes). The fetch wrapper adds x-nexus-csrf, so the console is
  // unaffected.
  fastify.addHook('preHandler', async (req, reply) => {
    const m = req.method.toUpperCase()
    if ((m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') && !verifyCsrf(req)) {
      return reply.code(403).send({ error: 'Invalid or missing CSRF token', code: 'csrf_failed' })
    }
  })

  const actorIsOwner = (req: any): boolean => !!req.authUser?.roleKeys?.includes(OWNER_ROLE_KEY)
  const audit = (req: any, action: string, entityType: any, entityId: string, meta?: any) =>
    writeAuthAudit({
      actorUserId: req.authUser?.id ?? null,
      ip: truncateIp(req.ip),
      userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 256) ?? null,
      entityType, entityId, action, metadata: meta,
    })
  // Map a guardrail error to a 409 with its code; rethrow anything else.
  const guard = async (reply: any, fn: () => Promise<any>) => {
    try {
      return await fn()
    } catch (e: any) {
      if (e instanceof GuardrailError) {
        reply.code(409).send({ error: e.message, code: e.code })
        return undefined
      }
      throw e
    }
  }

  // ── Users ──────────────────────────────────────────────────────
  fastify.get('/api/team/users', async (_req, reply) => {
    const rows = await (prisma as any).userProfile.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, email: true, displayName: true, avatarUrl: true, status: true,
        lastLoginAt: true, twoFactorEnabledAt: true, createdAt: true,
        roleAssignments: { select: { channelScope: true, role: { select: { key: true, name: true } } } },
      },
    })
    return reply.send({
      users: rows.map((u: any) => ({
        id: u.id, email: u.email, displayName: u.displayName, avatarUrl: u.avatarUrl,
        status: u.status, lastLoginAt: u.lastLoginAt, mfaEnabled: !!u.twoFactorEnabledAt,
        createdAt: u.createdAt,
        roles: u.roleAssignments.map((a: any) => ({ key: a.role.key, name: a.role.name, channelScope: a.channelScope })),
      })),
    })
  })

  fastify.get<{ Params: { id: string } }>('/api/team/users/:id/sessions', async (req, reply) => {
    const rows = await (prisma as any).userSession.findMany({
      where: { userId: req.params.id },
      orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }],
      take: 50,
      select: { id: true, userAgent: true, ipAddress: true, ipCity: true, ipCountry: true, createdAt: true, lastSeenAt: true, revokedAt: true },
    })
    return reply.send({ sessions: rows })
  })

  fastify.post<{ Params: { id: string } }>('/api/team/users/:id/deactivate', async (req, reply) => {
    const done = await guard(reply, () => deactivateUser(req.params.id))
    if (done === undefined && reply.sent) return
    await audit(req, 'user.deactivate', 'User', req.params.id)
    return reply.send({ ok: true })
  })

  fastify.post<{ Params: { id: string } }>('/api/team/users/:id/reactivate', async (req, reply) => {
    await reactivateUser(req.params.id)
    await audit(req, 'user.reactivate', 'User', req.params.id)
    return reply.send({ ok: true })
  })

  fastify.post<{ Params: { id: string } }>('/api/team/users/:id/force-signout', async (req, reply) => {
    const n = await forceSignOut(req.params.id)
    await audit(req, 'user.force_signout', 'Session', req.params.id, { revoked: n })
    return reply.send({ ok: true, revoked: n })
  })

  // Admin reset of a user's 2FA (e.g. lost device). Clears the secret +
  // recovery codes so they can re-enrol; audited (S5).
  fastify.post<{ Params: { id: string } }>('/api/team/users/:id/reset-mfa', async (req, reply) => {
    await prisma.$transaction(async (tx: any) => {
      await tx.userProfile.update({ where: { id: req.params.id }, data: { twoFactorSecret: null, twoFactorEnabledAt: null } })
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: req.params.id } })
    })
    await audit(req, 'user.reset_mfa', 'User', req.params.id)
    return reply.send({ ok: true })
  })

  fastify.post<{ Params: { id: string }; Body: { roleKey?: string; channelScope?: unknown } }>(
    '/api/team/users/:id/roles',
    async (req, reply) => {
      const roleKey = (req.body?.roleKey ?? '').trim()
      if (!roleKey) return reply.code(400).send({ error: 'roleKey required', code: 'bad_request' })
      const done = await guard(reply, () =>
        assignRole({
          actorIsOwner: actorIsOwner(req), actorUserId: req.authUser!.id,
          targetUserId: req.params.id, roleKey, channelScope: req.body?.channelScope,
        }),
      )
      if (done === undefined && reply.sent) return
      await audit(req, 'user.role.assign', 'User', req.params.id, { roleKey })
      return reply.send({ ok: true })
    },
  )

  fastify.delete<{ Params: { id: string; roleKey: string } }>(
    '/api/team/users/:id/roles/:roleKey',
    async (req, reply) => {
      const done = await guard(reply, () => removeRole({ targetUserId: req.params.id, roleKey: req.params.roleKey }))
      if (done === undefined && reply.sent) return
      await audit(req, 'user.role.remove', 'User', req.params.id, { roleKey: req.params.roleKey })
      return reply.send({ ok: true })
    },
  )

  // ── Roles ──────────────────────────────────────────────────────
  fastify.get('/api/team/roles', async (_req, reply) => {
    const rows = await (prisma as any).role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: {
        id: true, key: true, name: true, description: true, permissions: true,
        isSystem: true, requireMfa: true,
        _count: { select: { assignments: true } },
      },
    })
    return reply.send({
      roles: rows.map((r: any) => ({
        id: r.id, key: r.key, name: r.name, description: r.description,
        permissions: r.permissions, isSystem: r.isSystem, requireMfa: r.requireMfa,
        isOwner: r.key === OWNER_ROLE_KEY, memberCount: r._count.assignments,
      })),
    })
  })

  // Permission registry for the matrix editor.
  fastify.get('/api/team/roles/catalog', async (_req, reply) => {
    return reply.send({ groups: permissionCatalog() })
  })

  fastify.post<{ Body: { key?: string; name?: string; description?: string; permissions?: string[] } }>(
    '/api/team/roles',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim()
      const key = (req.body?.key ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).trim()
      const permissions = (req.body?.permissions ?? []).filter(isValidPermission)
      if (!name || !key) return reply.code(400).send({ error: 'name required', code: 'bad_request' })
      const done = await guard(reply, () => createRole({ key, name, description: req.body?.description, permissions }))
      if (done === undefined && reply.sent) return
      await audit(req, 'role.create', 'Role', done as string, { key, name })
      return reply.send({ ok: true, id: done })
    },
  )

  fastify.patch<{ Params: { id: string }; Body: { name?: string; description?: string; permissions?: string[]; requireMfa?: boolean } }>(
    '/api/team/roles/:id',
    async (req, reply) => {
      const done = await guard(reply, () =>
        updateRole(req.params.id, {
          name: req.body?.name, description: req.body?.description,
          permissions: req.body?.permissions?.filter(isValidPermission), requireMfa: req.body?.requireMfa,
        }),
      )
      if (done === undefined && reply.sent) return
      await audit(req, 'role.update', 'Role', req.params.id)
      return reply.send({ ok: true })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/api/team/roles/:id', async (req, reply) => {
    const done = await guard(reply, () => deleteRole(req.params.id))
    if (done === undefined && reply.sent) return
    await audit(req, 'role.delete', 'Role', req.params.id)
    return reply.send({ ok: true })
  })

  // Duplicate a role into a new custom one.
  fastify.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/team/roles/:id/duplicate',
    async (req, reply) => {
      const src = await (prisma as any).role.findUnique({ where: { id: req.params.id }, select: { name: true, description: true, permissions: true } })
      if (!src) return reply.code(404).send({ error: 'Role not found', code: 'not_found' })
      const name = (req.body?.name ?? `${src.name} (copy)`).trim()
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36)
      const done = await guard(reply, () => createRole({ key, name, description: src.description, permissions: src.permissions }))
      if (done === undefined && reply.sent) return
      await audit(req, 'role.duplicate', 'Role', done as string, { from: req.params.id })
      return reply.send({ ok: true, id: done })
    },
  )
}

export default teamRoutes
