/**
 * FP1.2 — active users for assignee pickers + @mention autocomplete.
 * FS3 — optional `?q=&cursor=` turns it into a paged search (take 30, ordered
 * by name) for AsyncCombobox/MentionTextarea; a bare request keeps the
 * historical whole-list shape until every consumer is swapped, then the
 * unpaged branch goes away.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { LITE_TAKE, pageSlice, parseLiteParams } from "@/lib/lite-search";

export const permission = FEATURES.commentsCreate;

export const GET = guarded(FEATURES.commentsCreate, async (req) => {
  const { q, cursor, paged } = parseLiteParams(new URL(req.url).searchParams);

  if (paged) {
    const rows = await prisma.user.findMany({
      where: {
        status: "active",
        ...(q ? { OR: [{ displayName: { contains: q } }, { email: { contains: q } }] } : {}),
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: LITE_TAKE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, displayName: true, email: true },
    });
    const { items, nextCursor } = pageSlice(rows, LITE_TAKE, (u) => u.id);
    return NextResponse.json({ users: items, nextCursor });
  }

  const users = await prisma.user.findMany({ // bounded: active users ≈ team size; legacy unpaged shape — remaining consumers (inbox ContextRail, EPI-owned) migrate to ?q= paging (FS3), then this branch is removed
    where: { status: "active" },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, email: true },
  });
  return NextResponse.json({ users });
});
