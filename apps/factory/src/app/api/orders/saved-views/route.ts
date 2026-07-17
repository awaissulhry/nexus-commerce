/**
 * EPO.7b — personal saved views for the orders board (HubSpot pinned-tabs
 * verdict, adapt-simplified: personal only). Consumes the SHARED SavedView
 * model (FP10's); this page-scoped route is orders' own API surface (registry
 * rule 3 — the model is substrate, the surface belongs to the page), so the
 * FP10 route stays untouched at `pages.analytics`. Per-user: you only ever
 * see or delete your own.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";

export const permission = PAGES.orders;

const PAGE = "orders";

export const GET = guarded(PAGES.orders, async (_req, { actor }) => {
  const views = await prisma.savedView.findMany({ where: { page: PAGE, userId: actor!.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, config: true } }); // bounded: per-user saved views
  return NextResponse.json({ views });
});

const Config = z.object({
  state: z.string().max(30).optional(),
  q: z.string().max(120).optional(),
  partyId: z.string().max(60).optional(),
  partyLabel: z.string().max(120).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  view: z.enum(["grid", "kanban"]).optional(),
});
const Body = z.object({ name: z.string().trim().min(1).max(60), config: Config });

export const POST = guarded(PAGES.orders, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name and config required" }, { status: 400 });
  const view = await prisma.savedView.create({
    data: { page: PAGE, name: parsed.data.name, config: parsed.data.config as Prisma.InputJsonValue, userId: actor!.id },
    select: { id: true, name: true, config: true },
  });
  return NextResponse.json({ view }, { status: 201 });
});

export const DELETE = guarded(PAGES.orders, async (req, { actor }) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.savedView.deleteMany({ where: { id, page: PAGE, userId: actor!.id } }); // scoped: only your own
  return NextResponse.json({ ok: true });
});
