/**
 * Phase S1 (auth core) — auth audit writer.
 *
 * Writes to the existing append-only AuditLog model (schema.prisma
 * :6270, hardened by 20260509_l6_0_audit_log_immutability). Unlike the
 * settings-audit helper — which hardcodes userId=null — this stamps the
 * REAL actor + IP + user-agent, closing S0 finding F6 (audit trail had
 * no actor). Every auth event and admin mutation flows through here.
 *
 * Never throws: an audit-write failure must not break the auth flow it
 * records (it logs to stderr and returns undefined).
 */

import prisma from '../../db.js'

export type AuthAuditEntity =
  | 'Auth' // login / logout / lockout
  | 'User' // create / deactivate / role change
  | 'Session' // revoke / revoke-all
  | 'Invitation' // create / accept / revoke
  | 'PasswordReset' // request / complete
  | 'Role' // create / edit / delete (S2)

export interface AuthAuditInput {
  actorUserId: string | null
  ip?: string | null
  userAgent?: string | null
  entityType: AuthAuditEntity
  entityId: string
  action: string // "login.success" | "login.failed" | "user.deactivate" | ...
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  metadata?: Record<string, unknown>
}

export async function writeAuthAudit(input: AuthAuditInput): Promise<string | undefined> {
  try {
    const row = await (prisma as any).auditLog.create({
      data: {
        userId: input.actorUserId,
        ip: input.ip ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        before: input.before ?? undefined,
        after: input.after ?? undefined,
        metadata: {
          source: 'auth',
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
          ...(input.metadata ?? {}),
        },
      },
    })
    return row.id as string
  } catch (err) {
    console.error('[auth-audit] write failed', {
      entityType: input.entityType,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
