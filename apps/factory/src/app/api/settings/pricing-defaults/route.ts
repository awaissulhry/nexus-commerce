/** FP3 — read pricing defaults (margin floor, deposit default) for the quote editor. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";

export const permission = PAGES.quotes;

export const GET = guarded(PAGES.quotes, async () => {
  const row = await prisma.appSetting.findUnique({ where: { key: "pricing.defaults" } });
  const v = (row?.value as { marginFloorPct?: number; depositDefaultPct?: number }) ?? {};
  return NextResponse.json({ marginFloorPct: v.marginFloorPct ?? 20, depositDefaultPct: v.depositDefaultPct ?? 30 });
});
