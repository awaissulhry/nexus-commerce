/**
 * FP2.3 — replace the template's BASE bill of materials (perOption=false lines
 * — the materials every unit needs regardless of options). Per-option draws
 * are edited on the option itself (materialDraws). Replace-set semantics:
 * the whole base BOM is sent each save.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.productsManage;

const Body = z.object({
  lines: z.array(z.object({ materialId: z.string().min(1), qty: z.number().positive(), unit: z.string().min(1) })),
});

export const PUT = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "lines[] with positive qty required" }, { status: 400 });

  if (parsed.data.lines.length) {
    const ids = [...new Set(parsed.data.lines.map((l) => l.materialId))];
    const found = await prisma.material.count({ where: { id: { in: ids } } });
    if (found !== ids.length) return NextResponse.json({ error: "Some materials no longer exist" }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.bomLine.deleteMany({ where: { templateId: id, perOption: false } }),
    ...parsed.data.lines.map((l) => prisma.bomLine.create({ data: { templateId: id, perOption: false, ...l } })),
  ]);
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "bom.replaced", after: { lines: parsed.data.lines.length } });
  await publishEventDurable("pricing.updated", { templateId: id });
  return NextResponse.json({ ok: true, lines: parsed.data.lines.length });
});
