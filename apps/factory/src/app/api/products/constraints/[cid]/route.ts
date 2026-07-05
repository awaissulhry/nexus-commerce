/** FP2.2 — patch / delete a constraint. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = { PATCH: FEATURES.productsManage, DELETE: FEATURES.productsManage };

const Patch = z.object({
  type: z.enum(["REQUIRES", "EXCLUDES"]).optional(),
  severity: z.enum(["BLOCK", "WARN"]).optional(),
  message: z.string().trim().min(1).max(300).optional(),
});

export const PATCH = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { cid } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const constraint = await prisma.optionConstraint.update({ where: { id: cid }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "constraint", entityId: cid, action: "updated", after: parsed.data });
  return NextResponse.json({ constraint });
});

export const DELETE = guarded(FEATURES.productsManage, async (_req, { params, actor }) => {
  const { cid } = await params;
  await prisma.optionConstraint.delete({ where: { id: cid } });
  void audit({ actorId: actor!.id, entityType: "constraint", entityId: cid, action: "deleted" });
  return NextResponse.json({ ok: true });
});
