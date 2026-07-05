/** FP2.4 — brands & customers for price-list assignment + preview scoping. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";

export const permission = PAGES.products;

export const GET = guarded(PAGES.products, async () => {
  const parties = await prisma.party.findMany({
    where: { archivedAt: null, kind: { in: ["BRAND", "CUSTOMER"] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, kind: true, priceListId: true },
  });
  return NextResponse.json({ parties });
});
