/**
 * FP2.2 — one template: full read (groups→options, constraints, BOM w/ material
 * names, certificates), patch (incl. archive toggle), and delete — which is
 * ARCHIVE when the template is referenced by a price list or a quote (docstatus
 * spirit: never orphan history), else a real delete (cascades groups/options).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.products, PATCH: FEATURES.productsManage, DELETE: FEATURES.productsManage };

export const GET = guarded(PAGES.products, async (_req, { params, resolved }) => {
  const { id } = await params;
  const t = await prisma.productTemplate.findUnique({
    where: { id },
    include: {
      optionGroups: { orderBy: { sort: "asc" }, include: { options: { orderBy: { sort: "asc" } } } },
      constraints: true,
      bomLines: { include: { material: { select: { name: true, unit: true } } } },
      certCoverage: { include: { certificate: true } },
    },
  });
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return jsonStripped({ template: t }, resolved);
});

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  baseCostCents: z.number().int().min(0).optional(),
  basePriceCents: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
});

export const PATCH = guarded(FEATURES.productsManage, async (req: NextRequest, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { archived, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (archived !== undefined) data.archivedAt = archived ? new Date() : null;
  const t = await prisma.productTemplate.update({ where: { id }, data });
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "updated", after: parsed.data });
  await publishEventDurable("pricing.updated", { templateId: id });
  return jsonStripped({ template: t }, resolved);
});

export const DELETE = guarded(FEATURES.productsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const [priceRefs, quoteRefs] = await Promise.all([
    prisma.priceListEntry.count({ where: { templateId: id } }),
    prisma.quoteLine.count({ where: { templateId: id } }),
  ]);
  if (priceRefs > 0 || quoteRefs > 0) {
    await prisma.productTemplate.update({ where: { id }, data: { archivedAt: new Date() } });
    void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "archived", after: { reason: "referenced", priceRefs, quoteRefs } });
    return NextResponse.json({ ok: true, archived: true, reason: `Referenced by ${priceRefs} price-list entr${priceRefs === 1 ? "y" : "ies"} and ${quoteRefs} quote line(s) — archived, not deleted.` });
  }
  await prisma.productTemplate.delete({ where: { id } });
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "deleted" });
  return NextResponse.json({ ok: true, archived: false });
});
