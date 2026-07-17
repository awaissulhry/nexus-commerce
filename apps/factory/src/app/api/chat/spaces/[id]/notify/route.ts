/**
 * FC4 — POST: set the caller's OWN notification level for this space
 * ({level: ALL | MENTIONS | OFF} → ChatMember.notifyLevel — the bell menu in
 * the space header). FC3's notify audience already honors the level; this
 * route is the missing dial. Guarded by pages.chat, NOT chat.post: read-only
 * roles can still be @mentioned, so they may mute too. Self-serve only — the
 * service pins the row to the actor's own membership.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { setNotifyLevel } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";

export const permission = PAGES.chat;

const Body = z.object({ level: z.enum(["ALL", "MENTIONS", "OFF"]) });

export const POST = guarded(PAGES.chat, async (req, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    await setNotifyLevel(spaceId, actor!.id, parsed.data.level);
    return jsonStripped({ ok: true, level: parsed.data.level }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
