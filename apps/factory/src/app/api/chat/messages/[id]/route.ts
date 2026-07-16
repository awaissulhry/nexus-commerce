/**
 * FC1 — PATCH: edit own message; DELETE: soft-delete own message. Author-only
 * is the service's guardrail (audit keeps before/after body per the
 * append-only law); routes stay thin.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { editMessage, deleteMessage } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";

export const permission = FEATURES.chatPost;

const PatchBody = z.object({ body: z.string().min(1).max(5000) });

export const PATCH = guarded(FEATURES.chatPost, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    await editMessage(id, actor!.id, parsed.data.body);
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});

export const DELETE = guarded(FEATURES.chatPost, async (_req, { params, actor, resolved }) => {
  const { id } = await params;
  try {
    await deleteMessage(id, actor!.id);
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
