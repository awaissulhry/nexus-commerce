/** FP2.2 — create an option group under a template (appended at the end). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.productsManage;

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
});

export const POST = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const last = await prisma.optionGroup.findFirst({ where: { templateId: id }, orderBy: { sort: "desc" }, select: { sort: true } });
  const group = await prisma.optionGroup.create({
    data: { templateId: id, sort: (last?.sort ?? -1) + 1, ...parsed.data },
  });
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "group.created", after: { groupId: group.id, name: group.name } });
  return NextResponse.json({ group }, { status: 201 });
});
