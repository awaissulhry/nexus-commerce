/**
 * EPQ.2 — the one Owner broadcast for quote events (extracted from public.ts
 * so manual actions, the worker tick, and the public routes share it). Every
 * active OWNER gets the bell — minus the actor who performed the action (a
 * user doesn't need to be told about their own click).
 */
import { prisma } from "@/lib/db";
import { notify } from "@/lib/notifications";

export async function notifyOwners(input: {
  title: string;
  body?: string;
  entityId: string;
  href: string;
  kind?: "STATE_CHANGE" | "REMINDER";
  excludeUserId?: string | null;
  /** EPO.3 — orders reuse the one broadcast (anti-duplication); defaults to "quote" */
  entityType?: string;
}) {
  const owners = await prisma.user.findMany({
    where: { status: "active", roleAssignments: { some: { role: { key: "OWNER" } } } },
    select: { id: true },
  });
  for (const o of owners) {
    if (input.excludeUserId && o.id === input.excludeUserId) continue;
    await notify({
      userId: o.id,
      kind: input.kind ?? "STATE_CHANGE",
      title: input.title,
      body: input.body,
      entityType: input.entityType ?? "quote",
      entityId: input.entityId,
      href: input.href,
    });
  }
}
