/**
 * FC3 — the thread panel's API. GET: the root message + a windowed page of
 * its replies (?before=<messageId>&take=100, newest-first — same grammar as
 * the space stream) + reply count + whether the caller follows the thread.
 * POST: follow; DELETE: unfollow (both idempotent, service-guarded). All
 * membership-checked; moneyCents grain-strips via jsonStripped as everywhere.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { followThread, unfollowThread } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";
import { parseFollowedThreads, parseWindow } from "@/lib/chat/pure";

export const permission = PAGES.chat;

const MESSAGE_SELECT = {
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
} as const;

/** soft-deleted rows keep their slot but never their words (audit keeps truth) */
type Row = { deletedAt: Date | null } & Record<string, unknown>;
const tombstone = <T extends Row>(m: T): T =>
  m.deletedAt ? { ...m, body: "", moneyCents: null, moneyLabel: null, meta: null } : m;

export const GET = guarded(PAGES.chat, async (req: NextRequest, { params, actor, resolved }) => {
  const { id: spaceId, rootId } = await params;
  const member = await prisma.chatMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: actor!.id } },
    select: { followedThreads: true },
  });
  if (!member) return NextResponse.json({ error: "Not a member of this space", code: "not_member" }, { status: 403 });

  const root = await prisma.chatMessage.findUnique({
    where: { id: rootId },
    select: { ...MESSAGE_SELECT, spaceId: true },
  });
  if (!root || root.spaceId !== spaceId || root.threadRootId) {
    return NextResponse.json({ error: "Thread not found", code: "not_found" }, { status: 404 });
  }

  const { before, take } = parseWindow({
    before: req.nextUrl.searchParams.get("before"),
    take: req.nextUrl.searchParams.get("take"),
  });

  let anchor: { createdAt: Date } | null = null;
  if (before) {
    const row = await prisma.chatMessage.findUnique({
      where: { id: before },
      select: { createdAt: true, threadRootId: true },
    });
    if (!row || row.threadRootId !== rootId) {
      return NextResponse.json({ error: "before anchor not in this thread" }, { status: 400 });
    }
    anchor = row;
  }

  const rows = await prisma.chatMessage.findMany({
    where: {
      threadRootId: rootId,
      // compound cursor: strictly older than the anchor, id as same-ms tiebreak
      ...(anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: before! } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take, // bounded: parseWindow clamps to ≤100
    select: MESSAGE_SELECT,
  });

  const replyCount = await prisma.chatMessage.count({ where: { threadRootId: rootId, deletedAt: null } });
  const following = parseFollowedThreads(member.followedThreads).includes(rootId);

  const { spaceId: _sid, ...rootMessage } = root;
  return jsonStripped(
    {
      root: tombstone(rootMessage),
      items: rows.map(tombstone),
      window: { before, take },
      replyCount,
      following,
    },
    resolved,
  );
});

export const POST = guarded(PAGES.chat, async (_req, { params, actor, resolved }) => {
  const { id: spaceId, rootId } = await params;
  try {
    const out = await followThread(spaceId, actor!.id, rootId);
    return jsonStripped(out, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});

export const DELETE = guarded(PAGES.chat, async (_req, { params, actor, resolved }) => {
  const { id: spaceId, rootId } = await params;
  try {
    const out = await unfollowThread(spaceId, actor!.id, rootId);
    return jsonStripped(out, resolved);
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
