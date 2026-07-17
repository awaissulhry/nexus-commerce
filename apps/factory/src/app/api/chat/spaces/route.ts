/**
 * FC1 — GET: the caller's spaces + unread counts (bounded aggregates over the
 * read cursor); POST: create a CUSTOM space (chat.spaces.create — Owner-only
 * by default, substrate Q4).
 * FC2 — the rail consumes this: each space also carries its latest message
 * (snippet + activity sort; body only — money never rides the rail) and its
 * member count, both via nested take-1/_count selects on the same bounded
 * query. Activity ordering is real because posting bumps the space row
 * (chat-service).
 * FC3 — the payload also carries `threads`: the caller's followed threads
 * with UNREAD activity (someone else replied after their read cursor),
 * newest first, bounded 20 — the rail's Home-ish Threads section.
 * FC4 — each space carries `onlineOthers` (how many other members hold a
 * live SSE connection — the rail's presence dot), computed against the
 * in-memory hub set, never a DB heartbeat.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { createCustomSpace } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";
import { parseFollowedThreads, unreadMessageWhere } from "@/lib/chat/pure";
import { connectedUserIds } from "@/lib/events";

/** FC3 — hard cap on followed-thread roots examined per rail refresh */
const FOLLOWED_SCAN_MAX = 300;
/** FC3 — the Threads section is bounded (Google-Home-ish, compact) */
const THREADS_TAKE = 20;

export const permission = { GET: PAGES.chat, POST: FEATURES.chatSpacesCreate };

export const GET = guarded(PAGES.chat, async (_req: NextRequest, { actor, resolved }) => {
  const memberships = await prisma.chatMember.findMany({
    where: { userId: actor!.id, space: { archivedAt: null } },
    orderBy: { space: { updatedAt: "desc" } },
    take: 100, // bounded: member's spaces page
    select: {
      role: true,
      notifyLevel: true,
      lastReadMessageId: true,
      followedThreads: true,
      space: {
        select: {
          id: true,
          kind: true,
          name: true,
          entityType: true,
          entityId: true,
          updatedAt: true,
          // FC2 — rail anatomy: latest message for the snippet + member count
          _count: { select: { members: true } },
          // FC4 — member ids for the rail's presence dot (intersected with the
          // SSE hub's online set server-side; ids never ship to the client)
          members: { select: { userId: true } },
          messages: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              id: true,
              kind: true,
              body: true,
              deletedAt: true,
              createdAt: true,
              author: { select: { displayName: true } },
            },
          },
        },
      },
    },
  });

  // resolve read cursors to timestamps in ONE query (≤100 ids by the take above)
  const cursorIds = memberships.map((m) => m.lastReadMessageId).filter((id): id is string => !!id);
  const cursorRows = cursorIds.length
    ? await prisma.chatMessage.findMany({
        where: { id: { in: cursorIds } },
        take: 100, // bounded: one cursor message per space
        select: { id: true, createdAt: true },
      })
    : [];
  const cursorAt = new Map(cursorRows.map((r) => [r.id, r.createdAt]));

  const unreads = await Promise.all(
    memberships.map((m) =>
      prisma.chatMessage.count({
        where: unreadMessageWhere(m.space.id, actor!.id, (m.lastReadMessageId && cursorAt.get(m.lastReadMessageId)) || null),
      }),
    ),
  );

  // FC4 — presence: how many OTHER members of each space are online right now
  // (green dot on the rail row). The hub set is in-memory; no DB cost.
  const online = new Set(connectedUserIds());

  const items = memberships.map((m, i) => {
    const { _count, messages, members, ...space } = m.space;
    const last = messages[0] ?? null;
    return {
      ...space,
      role: m.role,
      notifyLevel: m.notifyLevel,
      lastReadMessageId: m.lastReadMessageId,
      unread: unreads[i],
      onlineOthers: members.reduce((n, x) => (x.userId !== actor!.id && online.has(x.userId) ? n + 1 : n), 0),
      // FC2 — rail fields: a tombstoned latest message keeps its slot, never its words
      memberCount: _count.members,
      lastMessage: last
        ? {
            id: last.id,
            kind: last.kind,
            body: last.deletedAt ? "" : last.body,
            authorName: last.author?.displayName ?? null,
            deletedAt: last.deletedAt,
            createdAt: last.createdAt,
          }
        : null,
    };
  });

  // ── FC3 — followed threads with unread activity (the rail's Threads section)
  const followed: { rootId: string; spaceName: string; cursorAt: Date | null }[] = [];
  for (const m of memberships) {
    const cursor = (m.lastReadMessageId && cursorAt.get(m.lastReadMessageId)) || null;
    for (const rootId of parseFollowedThreads(m.followedThreads)) {
      if (followed.length >= FOLLOWED_SCAN_MAX) break;
      followed.push({ rootId, spaceName: m.space.name, cursorAt: cursor });
    }
  }
  let threads: {
    rootId: string;
    spaceId: string;
    spaceName: string;
    snippet: string;
    rootAuthorName: string | null;
    lastReplyAt: Date;
    replyCount: number;
  }[] = [];
  if (followed.length) {
    const rootIds = followed.map((f) => f.rootId);
    const [rootRows, replyAgg, otherAgg] = await Promise.all([
      prisma.chatMessage.findMany({
        where: { id: { in: rootIds } },
        take: FOLLOWED_SCAN_MAX, // bounded: capped followed-roots scan
        select: {
          id: true,
          spaceId: true,
          body: true,
          deletedAt: true,
          author: { select: { displayName: true } },
        },
      }),
      // all live replies → count + last activity
      prisma.chatMessage.groupBy({
        by: ["threadRootId"],
        where: { threadRootId: { in: rootIds }, deletedAt: null },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      // OTHERS' replies → unread decision (own replies never make a thread unread)
      prisma.chatMessage.groupBy({
        by: ["threadRootId"],
        where: { threadRootId: { in: rootIds }, deletedAt: null, authorId: { not: actor!.id } },
        _max: { createdAt: true },
      }),
    ]);
    const rootOf = new Map(rootRows.map((r) => [r.id, r]));
    const aggOf = new Map(replyAgg.map((a) => [a.threadRootId as string, a]));
    const otherMaxOf = new Map(otherAgg.map((a) => [a.threadRootId as string, a._max.createdAt]));
    for (const f of followed) {
      const root = rootOf.get(f.rootId);
      const agg = aggOf.get(f.rootId);
      const otherMax = otherMaxOf.get(f.rootId) ?? null;
      if (!root || !agg?._max.createdAt || !otherMax) continue;
      const unread = f.cursorAt == null || otherMax > f.cursorAt;
      if (!unread) continue;
      threads.push({
        rootId: f.rootId,
        spaceId: root.spaceId,
        spaceName: f.spaceName,
        snippet: root.deletedAt ? "Message deleted" : root.body.replace(/\s+/g, " ").trim().slice(0, 120),
        rootAuthorName: root.author?.displayName ?? null,
        lastReplyAt: agg._max.createdAt,
        replyCount: agg._count._all,
      });
    }
    threads = threads.sort((a, b) => b.lastReplyAt.getTime() - a.lastReplyAt.getTime()).slice(0, THREADS_TAKE);
  }

  return jsonStripped({ items, threads }, resolved);
});

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  memberIds: z.array(z.string().min(1)).max(50).optional(),
});

export const POST = guarded(FEATURES.chatSpacesCreate, async (req, { actor, resolved }) => {
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const space = await createCustomSpace({
      name: parsed.data.name,
      createdBy: { id: actor!.id, isOwner: resolved?.isOwner ?? false },
      memberIds: parsed.data.memberIds,
    });
    return jsonStripped({ space }, resolved, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err) ?? Promise.reject(err);
  }
});
