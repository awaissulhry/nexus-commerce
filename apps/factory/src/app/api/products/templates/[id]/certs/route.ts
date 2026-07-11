/** FP2.3 — attach / detach a certificate's coverage of this template. */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = { POST: FEATURES.productsManage, DELETE: FEATURES.productsManage };

const Body = z.object({ certificateId: z.string().min(1), coveredSizes: z.array(z.string()).nullable().optional() });

export const POST = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "certificateId required" }, { status: 400 });
  const coverage = await prisma.certificateCoverage.upsert({
    where: { certificateId_templateId: { certificateId: parsed.data.certificateId, templateId: id } },
    create: { certificateId: parsed.data.certificateId, templateId: id, coveredSizes: parsed.data.coveredSizes ?? undefined },
    update: { coveredSizes: parsed.data.coveredSizes ?? undefined },
  });
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "cert.attached", after: { certificateId: parsed.data.certificateId } });
  await publishEventDurable("pricing.updated", { templateId: id }); // FS2 — no silent mutations
  return NextResponse.json({ coverage }, { status: 201 });
});

export const DELETE = guarded(FEATURES.productsManage, async (req: NextRequest, { params, actor }) => {
  const { id } = await params;
  const certificateId = req.nextUrl.searchParams.get("certificateId");
  if (!certificateId) return NextResponse.json({ error: "certificateId required" }, { status: 400 });
  await prisma.certificateCoverage.deleteMany({ where: { certificateId, templateId: id } });
  void audit({ actorId: actor!.id, entityType: "template", entityId: id, action: "cert.detached", after: { certificateId } });
  await publishEventDurable("pricing.updated", { templateId: id }); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
