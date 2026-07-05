/**
 * FP2.2 — create a constraint (REQUIRES/EXCLUDES × BLOCK/WARN). ONE table, one
 * engine (BEAT verdict on Salesforce's two overlapping rule engines). Both
 * option ids must belong to this template.
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
  type: z.enum(["REQUIRES", "EXCLUDES"]),
  severity: z.enum(["BLOCK", "WARN"]).default("BLOCK"),
  ifOptionId: z.string().min(1),
  thenOptionId: z.string().min(1),
  message: z.string().trim().min(1).max(300),
});

export const POST = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "type, both options and a message are required" }, { status: 400 });
  if (parsed.data.ifOptionId === parsed.data.thenOptionId) {
    return NextResponse.json({ error: "A constraint needs two different options" }, { status: 400 });
  }
  const valid = await prisma.option.count({
    where: { id: { in: [parsed.data.ifOptionId, parsed.data.thenOptionId] }, group: { templateId: id } },
  });
  if (valid !== 2) return NextResponse.json({ error: "Both options must belong to this template" }, { status: 400 });

  const constraint = await prisma.optionConstraint.create({ data: { templateId: id, ...parsed.data } });
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "constraint.created", after: { constraintId: constraint.id, type: constraint.type } });
  await publishEventDurable("pricing.updated", { templateId: id });
  return NextResponse.json({ constraint }, { status: 201 });
});
