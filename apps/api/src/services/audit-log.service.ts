/**
 * NN.4 — append-only audit log writer.
 *
 * One row per PATCH/PUT/DELETE/submit/replicate against a tracked
 * entity. Required for SOC 2 + GDPR compliance: every write must be
 * attributable to a user with before/after diff.
 *
 * Best practices for callers:
 *  - Pass slim before/after — diff to changed fields only, not full
 *    row dumps. The table balloons fast under bulk traffic
 *    otherwise.
 *  - Use `metadata` for cross-entity context (bulkOperationId,
 *    idempotencyKey, marketplaceContext).
 *  - Never throw from a writer failure — auditing is fail-open. Log
 *    + continue. We don't want a Redis blip to roll back a paying
 *    customer's PATCH.
 */

import prisma from '../db.js'

export interface AuditWriteInput {
  userId?: string | null
  ip?: string | null
  entityType: string
  entityId: string
  action: string
  before?: unknown
  after?: unknown
  metadata?: unknown
}

export class AuditLogService {
  async write(input: AuditWriteInput): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: input.userId ?? null,
          ip: input.ip ?? null,
          entityType: input.entityType,
          entityId: input.entityId,
          action: input.action,
          before:
            input.before === undefined ? null : (input.before as any),
          after:
            input.after === undefined ? null : (input.after as any),
          metadata:
            input.metadata === undefined ? null : (input.metadata as any),
        },
      })
    } catch (err) {
      // NEVER throw — auditing is fail-open. A logging blip must not
      // poison the underlying write.
      console.warn(
        '[AuditLog] write failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Bulk write for hot paths where one operation produced many
   *  per-row audit rows. createMany is one round trip vs. N. */
  async writeMany(rows: AuditWriteInput[]): Promise<void> {
    if (rows.length === 0) return
    try {
      await prisma.auditLog.createMany({
        data: rows.map((r) => ({
          userId: r.userId ?? null,
          ip: r.ip ?? null,
          entityType: r.entityType,
          entityId: r.entityId,
          action: r.action,
          before: r.before === undefined ? null : (r.before as any),
          after: r.after === undefined ? null : (r.after as any),
          metadata: r.metadata === undefined ? null : (r.metadata as any),
        })),
      })
    } catch (err) {
      console.warn(
        '[AuditLog] writeMany failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

export const auditLogService = new AuditLogService()
