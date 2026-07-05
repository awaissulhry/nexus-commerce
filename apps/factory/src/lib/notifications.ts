/**
 * F1 — notification service: single write path, publishes on the bus so the
 * bell updates live. Closes the Nexus gap (F0-FINDINGS §7: mentions stored
 * but never delivered) — every mention/assignment lands here.
 */
import { prisma } from "@/lib/db";
import { publishEvent } from "@/lib/events";

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
  publishEvent("notification.created", { userId: input.userId });
}
