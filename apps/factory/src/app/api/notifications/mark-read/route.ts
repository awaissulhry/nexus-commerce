/** F1 — mark my notifications read ({ids: string[] | "all"}). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";

export const permission = PAGES.production;

const Body = z.object({ ids: z.union([z.literal("all"), z.array(z.string())]) });

export const POST = guarded(PAGES.production, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const where =
    parsed.data.ids === "all"
      ? { userId: actor!.id, readAt: null }
      : { userId: actor!.id, id: { in: parsed.data.ids }, readAt: null };
  const res = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  return NextResponse.json({ ok: true, marked: res.count });
});
