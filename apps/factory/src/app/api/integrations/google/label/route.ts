/**
 * F1 — set the factory label scope (FD3) and run the bounded initial
 * backfill; the worker's 10s incremental poll takes over from here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { backfillLabel } from "@/lib/google/gmail-sync";

export const permission = FEATURES.integrationsManage;

const Body = z.object({ labelId: z.string().min(1), labelName: z.string().min(1) });

export const POST = guarded(FEATURES.integrationsManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "labelId and labelName required" }, { status: 400 });
  const connection = await prisma.googleConnection.findFirst({ where: { status: "connected" } });
  if (!connection) return NextResponse.json({ error: "Google not connected" }, { status: 400 });

  await prisma.googleConnection.update({
    where: { id: connection.id },
    data: { labelId: parsed.data.labelId, labelName: parsed.data.labelName, historyId: null },
  });
  const result = await backfillLabel(parsed.data.labelId);
  void audit({
    actorId: actor!.id,
    entityType: "integration",
    entityId: "google",
    action: "label.scoped",
    after: { label: parsed.data.labelName, ...result },
  });
  return NextResponse.json({ ok: true, ...result });
});
