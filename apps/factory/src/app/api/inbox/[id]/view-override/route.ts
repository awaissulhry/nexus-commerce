/**
 * EPI3.2 — manual override: pin a conversation into a view, exclude it from
 * one, or clear. Overrides always beat criteria (§5.7 law); a pin sticks
 * even when nothing matches, an exclude returns the thread to the Inbox.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.inboxAssign;

const Body = z.object({ viewId: z.string().min(1), mode: z.enum(["pin", "exclude", "clear"]) });

export const POST = guarded(FEATURES.inboxAssign, async (req: NextRequest, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { viewId, mode } = parsed.data;

  const [conversation, view] = await Promise.all([
    prisma.conversation.findUnique({ where: { id }, select: { id: true } }),
    prisma.inboxView.findUnique({ where: { id: viewId }, select: { id: true, name: true } }),
  ]);
  if (!conversation || !view) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (mode === "clear") {
    await prisma.inboxViewOverride.deleteMany({ where: { viewId, conversationId: id } });
  } else {
    await prisma.inboxViewOverride.upsert({
      where: { viewId_conversationId: { viewId, conversationId: id } },
      create: { viewId, conversationId: id, mode },
      update: { mode },
    });
  }
  void audit({
    actorId: actor!.id,
    entityType: "conversation",
    entityId: id,
    action: mode === "clear" ? "view.override.cleared" : mode === "pin" ? "view.pinned" : "view.excluded",
    after: { view: view.name },
  });
  await publishEventDurable("conversation.updated", { id });
  return NextResponse.json({ ok: true });
});
