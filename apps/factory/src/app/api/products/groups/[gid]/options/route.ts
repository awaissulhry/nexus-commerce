/** FP2.2 — create an option in a group. Deltas: cents (ABSOLUTE) or bp (PERCENT). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.productsManage;

const Body = z.object({
  name: z.string().trim().min(1).max(160),
  costDeltaMode: z.enum(["ABSOLUTE", "PERCENT"]).default("ABSOLUTE"),
  costDelta: z.number().int().default(0),
  priceDeltaMode: z.enum(["ABSOLUTE", "PERCENT"]).default("ABSOLUTE"),
  priceDelta: z.number().int().default(0),
});

export const POST = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { gid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const last = await prisma.option.findFirst({ where: { groupId: gid }, orderBy: { sort: "desc" }, select: { sort: true } });
  const option = await prisma.option.create({ data: { groupId: gid, sort: (last?.sort ?? -1) + 1, ...parsed.data } });
  void audit({ actorId: actor!.id, entityType: "group", entityId: gid, action: "option.created", after: { optionId: option.id, name: option.name } });
  return NextResponse.json({ option }, { status: 201 });
});
