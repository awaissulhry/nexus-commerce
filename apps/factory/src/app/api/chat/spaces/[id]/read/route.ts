/**
 * FC1 — POST: move the caller's read cursor to a message in this space.
 * Unread counts (GET /api/chat/spaces) derive from it; the publish is scoped
 * to the reader so only their own badges refetch (FS2 S-11 lesson).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { setReadCursor } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";

export const permission = PAGES.chat;

const Body = z.object({ messageId: z.string().min(1) });

export const POST = guarded(PAGES.chat, async (req, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    await setReadCursor(spaceId, actor!.id, parsed.data.messageId);
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
