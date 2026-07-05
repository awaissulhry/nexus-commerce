/** FP1.2 — bulk close/open/assign with per-row results (the F1 idiom). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.inboxAssign;

const Body = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(["close", "open", "assign"]),
  assigneeId: z.string().nullable().optional(),
});

export const POST = guarded(FEATURES.inboxAssign, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { ids, action, assigneeId } = parsed.data;
  if (action === "assign" && assigneeId === undefined) {
    return NextResponse.json({ error: "assigneeId required for assign" }, { status: 400 });
  }

  const results: { id: string; ok: boolean; detail: string }[] = [];
  for (const id of ids) {
    try {
      const data =
        action === "close"
          ? { state: "CLOSED" as const, snoozeUntil: null }
          : action === "open"
            ? { state: "OPEN" as const, snoozeUntil: null }
            : { assigneeId };
      await prisma.conversation.update({ where: { id }, data });
      void audit({
        actorId: actor!.id, entityType: "conversation", entityId: id,
        action: action === "assign" ? "assigned" : "state.changed",
        after: data,
      });
      results.push({ id, ok: true, detail: action });
    } catch (err) {
      results.push({ id, ok: false, detail: (err as Error).message.slice(0, 120) });
    }
  }

  await publishEventDurable("conversation.updated", { bulk: true });
  return NextResponse.json({ results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});
