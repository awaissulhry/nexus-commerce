/**
 * EPI3.2 — live builder preview: the form IS the search (Gmail's law).
 * Raw criteria matches only — exclusivity/overrides don't apply to a
 * definition being edited. Read-only; any inbox user may preview.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { CriteriaSchema, criteriaWhere } from "@/lib/inbox/views";

export const permission = PAGES.inbox;

const Body = z.object({ criteria: CriteriaSchema });

export const POST = guarded(PAGES.inbox, async (req: NextRequest, { resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { criteria } = parsed.data;
  if (criteria.all.length === 0 && criteria.any.length === 0) {
    return NextResponse.json({ count: 0, sample: [] });
  }
  const where = criteriaWhere(criteria) as never;
  const [count, sample] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: 5,
      select: {
        id: true,
        subject: true,
        lastMessageAt: true,
        party: { select: { name: true } },
        messages: { orderBy: { sentAt: "desc" }, take: 1, select: { fromAddress: true } },
      },
    }),
  ]);
  return jsonStripped({ count, sample }, resolved);
});
