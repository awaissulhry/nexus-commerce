/**
 * FC1 — GET: the caller's spaces + unread counts (bounded aggregates over the
 * read cursor); POST: create a CUSTOM space (chat.spaces.create — Owner-only
 * by default, substrate Q4).
 * FC2 — the rail consumes this: each space also carries its latest message
 * (snippet + activity sort; body only — money never rides the rail) and its
 * member count, both via nested take-1/_count selects on the same bounded
 * query. Activity ordering is real because posting bumps the space row
 * (chat-service).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { createCustomSpace } from "@/lib/chat/chat-service";
import { chatErrorResponse } from "@/lib/chat/http";
import { unreadMessageWhere } from "@/lib/chat/pure";

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

  const items = memberships.map((m, i) => {
    const { _count, messages, ...space } = m.space;
    const last = messages[0] ?? null;
    return {
      ...space,
      role: m.role,
      notifyLevel: m.notifyLevel,
      lastReadMessageId: m.lastReadMessageId,
      unread: unreads[i],
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
  return jsonStripped({ items }, resolved);
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
