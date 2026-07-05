/** FP2.4 — one price list: read (entries + parties), rename, delete (not the default). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.products, PATCH: FEATURES.pricelistsManage, DELETE: FEATURES.pricelistsManage };

export const GET = guarded(PAGES.products, async (_req, { params, resolved }) => {
  const { id } = await params;
  const list = await prisma.priceList.findUnique({
    where: { id },
    include: {
      entries: true,
      parties: { select: { id: true, name: true, kind: true } },
    },
  });
  if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return jsonStripped({ list }, resolved);
});

const Patch = z.object({ name: z.string().trim().min(1).max(160).optional(), notes: z.string().trim().max(1000).nullable().optional() });

export const PATCH = guarded(FEATURES.pricelistsManage, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const list = await prisma.priceList.update({ where: { id }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "pricelist", entityId: id, action: "updated", after: parsed.data });
  return jsonStripped({ list }, resolved);
});

export const DELETE = guarded(FEATURES.pricelistsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const list = await prisma.priceList.findUnique({ where: { id }, select: { kind: true } });
  if (list?.kind === "DEFAULT") return NextResponse.json({ error: "The default list (Listino base) cannot be deleted" }, { status: 400 });
  await prisma.priceList.delete({ where: { id } }); // entries cascade; parties fall back to no list
  void audit({ actorId: actor!.id, entityType: "pricelist", entityId: id, action: "deleted" });
  return NextResponse.json({ ok: true });
});
