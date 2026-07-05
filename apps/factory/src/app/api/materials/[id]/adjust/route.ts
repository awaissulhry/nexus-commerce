/**
 * FP7 — manual stock adjustment: a signed ADJUST movement with a REQUIRED reason
 * (the platform rule — corrections are compensating entries, never edits). Behind
 * materials.adjust. Uses the ledger's validated append.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { appendMovement } from "@/lib/ledger";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.materialsAdjust;

const Body = z.object({ qty: z.number().refine((n) => n !== 0, "A non-zero quantity is required"), reason: z.string().trim().min(1, "A reason is required").max(300) });

export const POST = guarded(FEATURES.materialsAdjust, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid adjustment" }, { status: 400 });
  const material = await prisma.material.findUnique({ where: { id }, select: { id: true } });
  if (!material) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await appendMovement({ materialId: id, type: "ADJUST", qty: parsed.data.qty, reason: parsed.data.reason, refType: "Adjust", actorId: actor!.id });
  await publishEventDurable("workorder.updated", { materialId: id, adjusted: true });
  return NextResponse.json({ ok: true });
});
