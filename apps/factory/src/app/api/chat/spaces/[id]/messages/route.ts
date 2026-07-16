/**
 * FC1 — GET: windowed message history (?before=<messageId>&take=100,
 * newest-first — FS3 WindowedList consumes this in FC2), membership-checked;
 * POST: post a message (chat.post). Money never rides in body text — the
 * service enforces it; moneyCents is grain-stripped by jsonStripped for
 * cost-blind callers, so Workers never see it by construction.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { postMessage } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";
import { parseWindow } from "@/lib/chat/pure";

export const permission = { GET: PAGES.chat, POST: FEATURES.chatPost };

export const GET = guarded(PAGES.chat, async (req: NextRequest, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const member = await prisma.chatMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: actor!.id } },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Not a member of this space", code: "not_member" }, { status: 403 });

  const { before, take } = parseWindow({
    before: req.nextUrl.searchParams.get("before"),
    take: req.nextUrl.searchParams.get("take"),
  });

  let anchor: { createdAt: Date } | null = null;
  if (before) {
    anchor = await prisma.chatMessage.findUnique({ where: { id: before }, select: { createdAt: true, spaceId: true } });
    if (!anchor || (anchor as { spaceId?: string }).spaceId !== spaceId) {
      return NextResponse.json({ error: "before anchor not in this space" }, { status: 400 });
    }
  }

  const rows = await prisma.chatMessage.findMany({
    where: {
      spaceId,
      // compound cursor: strictly older than the anchor, id as same-ms tiebreak
      ...(anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: before! } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take, // bounded: parseWindow clamps to ≤100
    select: {
      id: true,
      authorId: true,
      author: { select: { id: true, displayName: true } },
      kind: true,
      body: true,
      threadRootId: true,
      moneyCents: true,
      moneyLabel: true,
      meta: true,
      editedAt: true,
      deletedAt: true,
      createdAt: true,
      reactions: { select: { userId: true, emoji: true } },
    },
  });

  // soft-deleted rows keep their slot but never their words (audit keeps truth)
  const items = rows.map((m) => (m.deletedAt ? { ...m, body: "", moneyCents: null, moneyLabel: null, meta: null } : m));
  return jsonStripped({ items, window: { before, take } }, resolved);
});

const PostBody = z.object({
  body: z.string().min(1).max(5000),
  threadRootId: z.string().min(1).optional(),
  moneyCents: z.number().int().nonnegative().optional(),
  moneyLabel: z.string().max(60).optional(),
});

export const POST = guarded(FEATURES.chatPost, async (req, { params, actor, resolved }) => {
  const { id: spaceId } = await params;
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const message = await postMessage({
      spaceId,
      author: { id: actor!.id, displayName: actor!.displayName },
      body: parsed.data.body,
      threadRootId: parsed.data.threadRootId ?? null,
      moneyCents: parsed.data.moneyCents ?? null,
      moneyLabel: parsed.data.moneyLabel ?? null,
    });
    return jsonStripped({ message }, resolved, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
