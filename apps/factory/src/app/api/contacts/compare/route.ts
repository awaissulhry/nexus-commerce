/**
 * FP5.4 — the side-by-side price comparison (the Owner's must-have): for one
 * configured product, what each CUSTOMER would pay and their discount vs the
 * base list ("Listino base"). Pure FP2 engine — the template loads once, then
 * compose() runs per party's price list. Money is grain-stripped by name
 * (netCents / discountPct / marginCents), so a no-prices caller gets no numbers.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { compose } from "@/lib/pricing";
import { loadEngineTemplate, loadPriceListInput } from "@/lib/products/load-engine";

export const permission = PAGES.contacts;

const Body = z.object({ templateId: z.string().min(1), selections: z.array(z.string()).default([]) });

export const POST = guarded(PAGES.contacts, async (req, { resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "templateId required" }, { status: 400 });
  const { templateId, selections } = parsed.data;

  const template = await loadEngineTemplate(templateId);
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const base = compose({ template, selectedOptionIds: selections, priceList: await loadPriceListInput(null), adjustmentCents: 0 });

  const parties = await prisma.party.findMany({
    where: { kind: "CUSTOMER", archivedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, priceListId: true, priceList: { select: { name: true } } },
  });

  // cache price-list inputs so parties sharing a list only load once
  const cache = new Map<string, Awaited<ReturnType<typeof loadPriceListInput>>>();
  const rows = [];
  for (const party of parties) {
    const key = party.priceListId ?? "__base__";
    if (!cache.has(key)) cache.set(key, await loadPriceListInput(party.priceListId));
    const r = compose({ template, selectedOptionIds: selections, priceList: cache.get(key)!, adjustmentCents: 0 });
    rows.push({
      partyId: party.id,
      name: party.name,
      priceListName: party.priceList?.name ?? "Listino base",
      netCents: r.netPriceCents,
      costCents: r.costCents,
      marginCents: r.marginCents,
      marginPct: r.marginPct,
      discountPct: base.netPriceCents > 0 ? ((base.netPriceCents - r.netPriceCents) / base.netPriceCents) * 100 : 0,
    });
  }

  return jsonStripped({ baseNetCents: base.netPriceCents, rows, blocked: base.hasBlockingViolation }, resolved);
});
