/**
 * FP2.3 — materials catalog (name, unit, current cost, reorder level). The
 * minimal registry BOMs point at; the full Materials page (lots, ledger UI,
 * POs, four-column stock) stays FP7. `materials.manage`, not `materials.adjust`.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { allMaterialUsage } from "@/lib/products/material-usage";

export const permission = { GET: PAGES.products, POST: FEATURES.materialsManage };

const UNITS = ["HIDE", "SQM", "PIECE", "M"] as const;

export const GET = guarded(PAGES.products, async (req: NextRequest, { resolved }) => {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  const [materials, usage] = await Promise.all([
    prisma.material.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { name: "asc" } }), // bounded: materials catalog is config-sized (hundreds)
    allMaterialUsage(),
  ]);
  const rows = materials.map((m) => ({ ...m, usedByTemplates: usage.get(m.id)?.size ?? 0 }));
  return jsonStripped({ materials: rows }, resolved);
});

const Create = z.object({
  name: z.string().trim().min(1).max(160),
  unit: z.enum(UNITS),
  costCents: z.number().int().min(0).default(0),
  reorderLevel: z.number().min(0).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const POST = guarded(FEATURES.materialsManage, async (req, { actor, resolved }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name and a valid unit (HIDE|SQM|PIECE|M) are required" }, { status: 400 });
  const m = await prisma.material.create({ data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "material", entityId: m.id, action: "created", after: { name: m.name, unit: m.unit } });
  return jsonStripped({ material: m }, resolved, { status: 201 });
});
