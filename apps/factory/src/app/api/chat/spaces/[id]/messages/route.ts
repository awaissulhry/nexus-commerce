/**
 * FC1 — GET: windowed message history (?before=<messageId>&take=100,
 * newest-first — FS3 WindowedList consumes this in FC2), membership-checked;
 * POST: post a message (chat.post). Money never rides in body text — the
 * service enforces it; moneyCents is grain-stripped by jsonStripped for
 * cost-blind callers, so Workers never see it by construction.
 * FC3 — the window is the MAIN stream only (threadRootId null — replies live
 * in the thread panel, the Google model); each root carries its thread
 * summary (reply count · ≤3 participants · last-reply time) and the payload
 * carries the bounded member list the mention chips resolve against.
 * FC4 — members also carry per-member read cursors (id + resolved timestamp)
 * for the receipt-avatar rows; reactions ride in first-reaction order.
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
      threadRootId: null, // FC3 — main stream only; replies ride the thread panel
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
      // FC4 — first-reaction order so the earliest emoji keeps the leftmost pill
      reactions: { select: { userId: true, emoji: true }, orderBy: { createdAt: "asc" } },
    },
  });

  // FC3 — thread summaries for the windowed roots: reply count + last-reply
  // time (one groupBy) and a ≤3-participant facepile (distinct repliers).
  const rootIds = rows.map((r) => r.id);
  const [replyAgg, participantRows] = rootIds.length
    ? await Promise.all([
        prisma.chatMessage.groupBy({
          by: ["threadRootId"],
          where: { threadRootId: { in: rootIds }, deletedAt: null },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        prisma.chatMessage.findMany({
          where: { threadRootId: { in: rootIds }, deletedAt: null, authorId: { not: null } },
          distinct: ["threadRootId", "authorId"],
          take: 500, // bounded: ≤100 roots × distinct repliers (tiny team)
          select: { threadRootId: true, authorId: true },
        }),
      ])
    : [[], []];
  const replierIds = [...new Set(participantRows.map((p) => p.authorId).filter((id): id is string => !!id))];
  const replierNames = replierIds.length
    ? await prisma.user.findMany({
        where: { id: { in: replierIds } },
        take: 500, // bounded: distinct repliers across the window
        select: { id: true, displayName: true },
      })
    : [];
  const nameOf = new Map(replierNames.map((u) => [u.id, u.displayName]));
  const summaryOf = new Map(
    replyAgg
      .filter((a) => a.threadRootId && a._count._all > 0)
      .map((a) => [
        a.threadRootId as string,
        {
          replyCount: a._count._all,
          lastReplyAt: a._max.createdAt,
          participants: participantRows
            .filter((p) => p.threadRootId === a.threadRootId)
            .slice(0, 3)
            .map((p) => ({ id: p.authorId as string, name: nameOf.get(p.authorId as string) ?? "Someone" })),
        },
      ]),
  );

  // FC3 — the bounded member list the client's mention chips resolve against.
  // FC4 — each member also carries their read cursor (id + the cursor
  // message's timestamp) so the client can seat receipt avatars under the
  // last message each member has read — including when the cursor points at
  // a thread reply that never appears in the main stream.
  const memberRows = await prisma.chatMember.findMany({
    where: { spaceId },
    take: 500, // bounded: one space's membership (tiny team by construction)
    select: { lastReadMessageId: true, user: { select: { id: true, displayName: true, email: true } } },
  });
  const readCursorIds = [...new Set(memberRows.map((m) => m.lastReadMessageId).filter((id): id is string => !!id))];
  const readCursorRows = readCursorIds.length
    ? await prisma.chatMessage.findMany({
        where: { id: { in: readCursorIds } },
        take: 500, // bounded: ≤ one cursor message per member
        select: { id: true, createdAt: true },
      })
    : [];
  const readAtOf = new Map(readCursorRows.map((r) => [r.id, r.createdAt]));
  const members = memberRows.map((m) => ({
    ...m.user,
    lastReadMessageId: m.lastReadMessageId,
    lastReadAt: (m.lastReadMessageId && readAtOf.get(m.lastReadMessageId)) || null,
  }));

  // soft-deleted rows keep their slot but never their words (audit keeps truth)
  const items = rows.map((m) => ({
    ...(m.deletedAt ? { ...m, body: "", moneyCents: null, moneyLabel: null, meta: null } : m),
    thread: summaryOf.get(m.id) ?? null,
  }));
  return jsonStripped({ items, window: { before, take }, members }, resolved);
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
