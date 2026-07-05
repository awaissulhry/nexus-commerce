/**
 * FP3.4 — public accept-link helpers. The token IS the auth (no session): a
 * constant-time-ish sha256 lookup finds the quote. Owners are notified on any
 * decision.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { notify } from "@/lib/notifications";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function notifyOwners(input: { title: string; body?: string; entityId: string; href: string }) {
  const owners = await prisma.user.findMany({
    where: { status: "active", roleAssignments: { some: { role: { key: "OWNER" } } } },
    select: { id: true },
  });
  for (const o of owners) {
    await notify({ userId: o.id, kind: "STATE_CHANGE", title: input.title, body: input.body, entityType: "quote", entityId: input.entityId, href: input.href });
  }
}
