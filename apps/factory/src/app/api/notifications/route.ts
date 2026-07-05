/** F1 — my notifications: list + unread count. Every role receives its own. */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";

export const permission = PAGES.production; // lowest common page (see events route note)

export const GET = guarded(PAGES.production, async (req: NextRequest, { actor }) => {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 30), 100);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: actor!.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { userId: actor!.id, readAt: null } }),
  ]);
  return NextResponse.json({ items, unread });
});
