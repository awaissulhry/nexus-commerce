/** FP2.4 — assign which parties use this price list (their configurator scope). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.pricelistsManage;

const Body = z.object({ partyIds: z.array(z.string()) });

export const PUT = guarded(FEATURES.pricelistsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "partyIds[] required" }, { status: 400 });
  await prisma.priceList.update({
    where: { id },
    data: { parties: { set: parsed.data.partyIds.map((pid) => ({ id: pid })) } },
  });
  void audit({ actorId: actor!.id, entityType: "pricelist", entityId: id, action: "parties.set", after: { count: parsed.data.partyIds.length } });
  return NextResponse.json({ ok: true });
});
