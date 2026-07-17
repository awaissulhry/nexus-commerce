/**
 * FC4 — POST: "I'm typing" — EPHEMERAL by design: a membership-checked local
 * dispatch (publishEphemeral → chat.typing), NO DB write, no outbox row, no
 * body to parse. The composer throttles to ≤1 call per 2s and readers fade
 * the indicator after 4s (chat/ui.ts owns both constants). Broadcast +
 * client-side spaceId filtering — the FC1 chat-event convention.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { publishEphemeral } from "@/lib/events";

export const permission = FEATURES.chatPost;

export const POST = guarded(FEATURES.chatPost, async (_req, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const member = await prisma.chatMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: actor!.id } },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Not a member of this space", code: "not_member" }, { status: 403 });

  publishEphemeral("chat.typing", { spaceId, userId: actor!.id, name: actor!.displayName });
  return jsonStripped({ ok: true }, resolved);
});
