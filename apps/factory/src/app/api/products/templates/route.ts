/**
 * FP2.2 — product templates: list (with option/group/cert counts) + create.
 * Templates are option sheets, not SKU ceremonies (BEAT verdict on SAP's
 * item-master-before-quote). Money fields ride the grain strip.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.products, POST: FEATURES.productsManage };

export const GET = guarded(PAGES.products, async (req: NextRequest, { resolved }) => {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  const templates = await prisma.productTemplate.findMany({ // bounded: template catalog is config-sized
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { name: "asc" },
    include: {
      _count: { select: { optionGroups: true, constraints: true, bomLines: true } },
      optionGroups: { select: { _count: { select: { options: true } } } },
      certCoverage: {
        select: { certificate: { select: { class: true, expiresAt: true, standard: true } } },
      },
    },
  });

  const now = Date.now();
  const rows = templates.map((t) => {
    const optionCount = t.optionGroups.reduce((n, g) => n + g._count.options, 0);
    // worst cert status across coverage: missing (none) | expired | expiring (<60d) | ok
    let certStatus: "none" | "ok" | "expiring" | "expired" = t.certCoverage.length ? "ok" : "none";
    for (const c of t.certCoverage) {
      const exp = c.certificate.expiresAt ? new Date(c.certificate.expiresAt).getTime() : null;
      if (exp == null) continue;
      if (exp < now) certStatus = "expired";
      else if (exp - now < 60 * 86400000 && certStatus !== "expired") certStatus = "expiring";
    }
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      baseCostCents: t.baseCostCents,
      basePriceCents: t.basePriceCents,
      archivedAt: t.archivedAt,
      groupCount: t._count.optionGroups,
      optionCount,
      constraintCount: t._count.constraints,
      bomCount: t._count.bomLines,
      certStatus,
      certClasses: [...new Set(t.certCoverage.map((c) => c.certificate.class))],
      updatedAt: t.updatedAt,
    };
  });
  return jsonStripped({ templates: rows }, resolved);
});

const Create = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  baseCostCents: z.number().int().min(0).default(0),
  basePriceCents: z.number().int().min(0).default(0),
});

export const POST = guarded(FEATURES.productsManage, async (req, { actor, resolved }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const t = await prisma.productTemplate.create({ data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "template", entityId: t.id, action: "created", after: { name: t.name } });
  return jsonStripped({ template: t }, resolved, { status: 201 });
});
