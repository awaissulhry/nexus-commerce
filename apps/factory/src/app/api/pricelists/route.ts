/**
 * FP2.4 — price lists (FD7): list + create. A new PARTY_TIER list starts EMPTY
 * — it IS the Listino base until you override the exact lines you negotiated.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.products, POST: FEATURES.pricelistsManage };

export const GET = guarded(PAGES.products, async () => {
  const lists = await prisma.priceList.findMany({ // bounded: price lists are config-sized
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    include: { _count: { select: { entries: true, parties: true } } },
  });
  return NextResponse.json({
    lists: lists.map((l) => ({ id: l.id, kind: l.kind, name: l.name, notes: l.notes, entryCount: l._count.entries, partyCount: l._count.parties })),
  });
});

const Create = z.object({ name: z.string().trim().min(1).max(160), notes: z.string().trim().max(1000).optional() });

export const POST = guarded(FEATURES.pricelistsManage, async (req, { actor }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const list = await prisma.priceList.create({ data: { kind: "PARTY_TIER", ...parsed.data } });
  void audit({ actorId: actor!.id, entityType: "pricelist", entityId: list.id, action: "created", after: { name: list.name } });
  return NextResponse.json({ list }, { status: 201 });
});
