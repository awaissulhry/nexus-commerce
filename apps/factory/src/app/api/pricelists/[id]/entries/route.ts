/**
 * FP2.4 — replace a list's sparse overrides (FD7). A base override sets
 * {templateId, basePriceCents}; an option override sets {optionId, mode, delta}.
 * Only differences are stored — everything else inherits the template/option.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.pricelistsManage;

const Entry = z.object({
  templateId: z.string().nullable().optional(),
  optionId: z.string().nullable().optional(),
  basePriceCents: z.number().int().nullable().optional(),
  priceDeltaMode: z.enum(["ABSOLUTE", "PERCENT"]).nullable().optional(),
  priceDelta: z.number().int().nullable().optional(),
});
const Body = z.object({ entries: z.array(Entry) });

export const PUT = guarded(FEATURES.pricelistsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "entries[] required" }, { status: 400 });

  // keep only meaningful overrides (a base override, or an option delta override)
  const clean = parsed.data.entries.filter(
    (e) => (e.templateId && e.optionId == null && e.basePriceCents != null) || (e.optionId && e.priceDelta != null),
  );

  await prisma.$transaction([
    prisma.priceListEntry.deleteMany({ where: { priceListId: id } }),
    ...clean.map((e) =>
      prisma.priceListEntry.create({
        data: {
          priceListId: id,
          templateId: e.templateId ?? null,
          optionId: e.optionId ?? null,
          basePriceCents: e.basePriceCents ?? null,
          priceDeltaMode: e.priceDeltaMode ?? null,
          priceDelta: e.priceDelta ?? null,
        },
      }),
    ),
  ]);
  void audit({ actorId: actor!.id, entityType: "pricelist", entityId: id, action: "entries.replaced", after: { count: clean.length } });
  await publishEventDurable("pricing.updated", { priceListId: id });
  return NextResponse.json({ ok: true, count: clean.length });
});
