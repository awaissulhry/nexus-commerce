/**
 * FC1 — POST: react to a message ({emoji}); DELETE: remove own reaction
 * (?emoji=). Membership-checked in the service; both are idempotent (the
 * [messageId, userId, emoji] unique is the arbiter). Reactions UI is FC4.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { react, unreact } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";

export const permission = FEATURES.chatPost;

const Body = z.object({ emoji: z.string().min(1).max(16) });

export const POST = guarded(FEATURES.chatPost, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    await react(id, actor!.id, parsed.data.emoji);
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});

export const DELETE = guarded(FEATURES.chatPost, async (req: NextRequest, { params, actor, resolved }) => {
  const { id } = await params;
  const emoji = req.nextUrl.searchParams.get("emoji");
  if (!emoji) return NextResponse.json({ error: "emoji required" }, { status: 400 });
  try {
    await unreact(id, actor!.id, emoji);
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
