/**
 * FP10.4 — personal saved views (the SavedView model): a named filter the Owner
 * saves for a page and re-applies with a click. Per-user and page-scoped — you
 * only ever see or delete your own. Rides pages.analytics (the only page that
 * saves views today).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";

export const permission = PAGES.analytics;

export const GET = guarded(PAGES.analytics, async (req, { actor }) => {
  const page = new URL(req.url).searchParams.get("page") ?? "analytics";
  const views = await prisma.savedView.findMany({ where: { page, userId: actor!.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, config: true } }); // bounded: per-user saved views
  return NextResponse.json({ views });
});

const Body = z.object({ page: z.string().min(1), name: z.string().trim().min(1).max(60), config: z.record(z.string(), z.unknown()) });

export const POST = guarded(PAGES.analytics, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name and config required" }, { status: 400 });
  const view = await prisma.savedView.create({
    data: { page: parsed.data.page, name: parsed.data.name, config: parsed.data.config as Prisma.InputJsonValue, userId: actor!.id },
    select: { id: true, name: true, config: true },
  });
  return NextResponse.json({ view }, { status: 201 });
});

export const DELETE = guarded(PAGES.analytics, async (req, { actor }) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.savedView.deleteMany({ where: { id, userId: actor!.id } }); // scoped: only your own
  return NextResponse.json({ ok: true });
});
