/**
 * F1 — append-only audit writer. Every write path stamps it; it never throws
 * (an audit failure must not break the mutation, but it is logged loudly).
 */
import { prisma } from "@/lib/db";

export async function audit(entry: {
  actorId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        before: entry.before === undefined ? undefined : (entry.before as object),
        after: entry.after === undefined ? undefined : (entry.after as object),
      },
    });
  } catch (err) {
    console.error("[audit] WRITE FAILED", entry.entityType, entry.entityId, entry.action, err);
  }
}
