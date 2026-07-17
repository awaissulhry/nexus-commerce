/**
 * FP1.2 — conversation list: state tabs, Mine/Unmatched filters, LIKE search,
 * cursor pagination, per-tab counts and the freshness timestamp in ONE call.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { buildListWhere } from "@/lib/inbox/list-where";
import { CriteriaSchema, defaultTabWhere, viewListWhere, type OverrideLite, type ViewLite } from "@/lib/inbox/views";

export const permission = PAGES.inbox;

const TAKE = 60;

export const GET = guarded(PAGES.inbox, async (req: NextRequest, { actor, resolved }) => {
  const p = req.nextUrl.searchParams;
  const state = (p.get("state") ?? "open").toUpperCase();
  const mine = p.get("mine") === "1";
  const unmatched = p.get("unmatched") === "1";
  const q = (p.get("q") ?? "").trim();
  const cursor = p.get("cursor");
  const viewParam = p.get("view");

  // EPI1.2 — ONE builder for rows + counts so the tabs can never disagree
  // with the active Mine/Unmatched/search filters (G8).
  const built = buildListWhere({ state, mine, unmatched, q, actorId: actor!.id });

  // EPI3.2 — views: membership composes ON TOP of the filters; the active
  // view (or the default-Inbox complement) scopes rows AND state counts, and
  // every header pill gets a filter-honest count of its own.
  const viewRows = await prisma.inboxView.findMany({ orderBy: { sortOrder: "asc" }, take: 50 }); // bounded: hand-authored config
  const views: ViewLite[] = [];
  const viewMeta: { id: string; name: string; emoji: string | null; color: string | null; exclusive: boolean; showElsewhere: boolean }[] = [];
  for (const v of viewRows) {
    const parsed = CriteriaSchema.safeParse(v.criteria);
    if (!parsed.success) continue;
    views.push({ id: v.id, exclusive: v.exclusive, showElsewhere: v.showElsewhere, criteria: parsed.data });
    viewMeta.push({ id: v.id, name: v.name, emoji: v.emoji, color: v.color, exclusive: v.exclusive, showElsewhere: v.showElsewhere });
  }
  const overrides: OverrideLite[] = views.length
    ? await prisma.inboxViewOverride.findMany({ take: 2000, select: { viewId: true, conversationId: true, mode: true } }) // bounded: manual pins/excludes
    : [];
  const activeView = viewParam ? views.find((v) => v.id === viewParam) ?? null : null;
  const membership = activeView
    ? viewListWhere(activeView, views, overrides)
    : views.length
      ? defaultTabWhere(views, overrides)
      : {};

  const compose = (w: Record<string, unknown>) => (Object.keys(membership).length ? { AND: [w, membership] } : w);
  const where = compose(built.where) as never;
  const base = compose(built.base) as never;

  // header pill counts: per-view membership under the SAME state+filters
  const stateFiltered = built.where as Record<string, unknown>;
  const viewCounts = await Promise.all(
    views.map((v) =>
      prisma.conversation.count({ where: { AND: [stateFiltered, viewListWhere(v, views, overrides)] } as never }),
    ),
  );
  const inboxCount = views.length
    ? await prisma.conversation.count({ where: { AND: [stateFiltered, defaultTabWhere(views, overrides)] } as never })
    : null;

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
      views: viewMeta.map((m, i) => ({ ...m, count: viewCounts[i] })),
      inboxCount,
    },
    resolved,
  );
});
