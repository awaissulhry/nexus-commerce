/**
 * FP2.4 — replace a list's sparse overrides (FD7). A base override sets
 * {templateId, basePriceCents}; an option override sets {optionId, mode, delta}.
 * Only differences are stored — everything else inherits the template/option.
 * FS4 — honours `expectedUpdatedAt` against the PARENT list row (entry rows
 * carry no stamp), and the replace touches that row inside the transaction so
 * two Owners replacing entries collide on the guard instead of last-write-wins.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { stampMatches, staleMessage } from "@/lib/concurrency";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.pricelistsManage;

const Entry = z.object({
  templateId: z.string().nullable().optional(),
  optionId: z.string().nullable().optional(),
  basePriceCents: z.number().int().nullable().optional(),
  priceDeltaMode: z.enum(["ABSOLUTE", "PERCENT"]).nullable().optional(),
  priceDelta: z.number().int().nullable().optional(),
});
const Body = z.object({
  entries: z.array(Entry),
  expectedUpdatedAt: z.string().datetime().optional(), // FS4 — the list row's read stamp
});

export const PUT = guarded(FEATURES.pricelistsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "entries[] required" }, { status: 400 });

  const list = await prisma.priceList.findUnique({ where: { id }, select: { updatedAt: true } });
  if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // FS4 — stale guard against the parent list row
  if (parsed.data.expectedUpdatedAt && !stampMatches(list.updatedAt, parsed.data.expectedUpdatedAt)) {
    return NextResponse.json({ error: staleMessage("price list") }, { status: 409 });
  }

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
    // FS4 — bump the parent stamp so the NEXT stale check sees this replace
    prisma.priceList.update({ where: { id }, data: { updatedAt: new Date() } }),
  ]);
  void audit({ actorId: actor!.id, entityType: "pricelist", entityId: id, action: "entries.replaced", after: { count: clean.length } });
  await publishEventDurable("pricing.updated", { priceListId: id });
  return NextResponse.json({ ok: true, count: clean.length });
});
