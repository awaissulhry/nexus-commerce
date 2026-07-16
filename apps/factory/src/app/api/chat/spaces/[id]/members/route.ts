/**
 * FC1 — POST: add a member ({userId, role?}); DELETE: remove (?userId=).
 * Route permission is chat.spaces.manage; the service ADDITIONALLY requires
 * the actor to be a space MANAGER or the Owner (the real boundary while RBAC
 * runs in shadow mode).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { addMember, removeMember } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";

export const permission = FEATURES.chatSpacesManage;

const Body = z.object({
  userId: z.string().min(1),
  role: z.enum(["MEMBER", "MANAGER"]).optional(),
});

export const POST = guarded(FEATURES.chatSpacesManage, async (req, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    await addMember(spaceId, { id: actor!.id, isOwner: resolved?.isOwner ?? false }, parsed.data.userId, parsed.data.role ?? "MEMBER");
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});

export const DELETE = guarded(FEATURES.chatSpacesManage, async (req: NextRequest, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  try {
    await removeMember(spaceId, { id: actor!.id, isOwner: resolved?.isOwner ?? false }, userId);
    return jsonStripped({ ok: true }, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
