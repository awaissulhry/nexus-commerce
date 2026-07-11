/**
 * F1 — notification service: single write path, publishes on the bus so the
 * bell updates live. Closes the Nexus gap (F0-FINDINGS §7: mentions stored
 * but never delivered) — every mention/assignment lands here.
 */
import { prisma } from "@/lib/db";
import { publishEventDurable } from "@/lib/events";

export async function notify(input: {
  userId: string;
  kind: "MENTION" | "ASSIGNMENT" | "STATE_CHANGE" | "REMINDER" | "SYSTEM";
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  href?: string;
}): Promise<void> {
  await prisma.notification.create({ data: input });
  // durable: notify() is called from the WORKER too (sync path, reminders) —
  // the outbox is the only road to web SSE clients from there (FP1.1).
  // FS2 — scoped: only the target user's connections are woken (was: every
  // client's bell refetched on any user's notification — S-11).
  await publishEventDurable("notification.created", { userId: input.userId }, { userId: input.userId });
}
