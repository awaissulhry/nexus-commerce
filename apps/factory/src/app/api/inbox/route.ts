/**
 * FP1.2 — conversation list: state tabs, Mine/Unmatched filters, LIKE search,
 * cursor pagination, per-tab counts and the freshness timestamp in ONE call.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { buildListWhere } from "@/lib/inbox/list-where";

export const permission = PAGES.inbox;

const TAKE = 60;

export const GET = guarded(PAGES.inbox, async (req: NextRequest, { actor, resolved }) => {
  const p = req.nextUrl.searchParams;
  const state = (p.get("state") ?? "open").toUpperCase();
  const mine = p.get("mine") === "1";
  const unmatched = p.get("unmatched") === "1";
  const q = (p.get("q") ?? "").trim();
  const cursor = p.get("cursor");

  // EPI1.2 — ONE builder for rows + counts so the tabs can never disagree
  // with the active Mine/Unmatched/search filters (G8).
  const { base, where } = buildListWhere({ state, mine, unmatched, q, actorId: actor!.id }) as {
    base: never;
    where: never;
  };

  const [items, counts, connection] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: TAKE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        subject: true,
        state: true,
        snoozeUntil: true,
        followUpAt: true,
        lastMessageAt: true,
        party: { select: { id: true, name: true, kind: true } },
        assignee: { select: { id: true, displayName: true } },
        messages: {
          orderBy: { sentAt: "desc" },
          take: 1,
          select: { snippet: true, direction: true, fromAddress: true },
        },
      },
    }),
    prisma.conversation.groupBy({ by: ["state"], _count: { _all: true }, where: base }),
    prisma.googleConnection.findFirst({ select: { lastSyncAt: true, labelName: true, status: true } }),
  ]);

  const hasMore = items.length > TAKE;
  const page = hasMore ? items.slice(0, TAKE) : items;
  const tabCounts = Object.fromEntries(counts.map((c) => [c.state, c._count._all]));

  return jsonStripped(
    {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
      counts: tabCounts,
      sync: connection,
    },
    resolved,
  );
});
