/**
 * FP2.4 — brands & customers for price-list assignment + preview scoping.
 * FS3 — optional `?q=&cursor=` turns it into a paged search (take 30, ordered
 * by name) for AsyncCombobox party pickers; a bare request keeps the
 * historical whole-list shape until every consumer is swapped (quotes/orders
 * call sites are EPQ/EPO-owned), then the unpaged branch goes away.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { LITE_TAKE, pageSlice, parseLiteParams } from "@/lib/lite-search";

export const permission = PAGES.products;

export const GET = guarded(PAGES.products, async (req) => {
  const { q, cursor, paged } = parseLiteParams(new URL(req.url).searchParams);

  if (paged) {
    const rows = await prisma.party.findMany({
      where: {
        archivedAt: null,
        kind: { in: ["BRAND", "CUSTOMER"] },
        ...(q ? { name: { contains: q } } : {}),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: LITE_TAKE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, kind: true, priceListId: true },
    });
    const { items, nextCursor } = pageSlice(rows, LITE_TAKE, (p) => p.id);
    return NextResponse.json({ parties: items, nextCursor });
  }

  const parties = await prisma.party.findMany({ // bounded: name-list only; legacy unpaged shape — remaining consumers (quotes/orders pickers, EPQ/EPO-owned) migrate to ?q= paging (FS3), then this branch is removed
    where: { archivedAt: null, kind: { in: ["BRAND", "CUSTOMER"] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, kind: true, priceListId: true },
  });
  return NextResponse.json({ parties });
});
