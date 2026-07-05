/**
 * FP6 — QC: the checklist (items ticked, stamped with who + when) and the
 * operator's cert-check attestation. GET merges the default items with what's
 * stored and reports the LIVE cert status so the UI can warn before Finish is
 * even attempted (the hard block lives on stage finish — FD14).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { certGateForWorkOrder } from "@/lib/production/cert-gate";

export const permission = { GET: FEATURES.workordersAdvance, POST: FEATURES.workordersAdvance };

const DEFAULT_QC = ["Seams & stitching inspected", "Armor pockets present & aligned", "EN 17092 cert label attached", "Measurements verified", "Finish & hardware checked"];
type Item = { item: string; checked: boolean; by?: string | null; at?: string | null };

export const GET = guarded(FEATURES.workordersAdvance, async (_req, { params }) => {
  const { sid } = await params;
  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, select: { workOrderId: true, checklist: true, certCheckPassed: true } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const stored = (stage.checklist as Item[] | null) ?? [];
  const byItem = new Map(stored.map((i) => [i.item, i]));
  const checklist: Item[] = DEFAULT_QC.map((item) => byItem.get(item) ?? { item, checked: false });
  for (const s of stored) if (!DEFAULT_QC.includes(s.item)) checklist.push(s); // keep any custom items
  const cert = await certGateForWorkOrder(stage.workOrderId, Date.now());
  return NextResponse.json({ checklist, certCheckPassed: stage.certCheckPassed ?? false, cert });
});

const Body = z.object({
  checklist: z.array(z.object({ item: z.string(), checked: z.boolean() })),
  certCheckPassed: z.boolean().optional(),
});

export const POST = guarded(FEATURES.workordersAdvance, async (req, { params, actor }) => {
  const { sid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, select: { workOrderId: true, checklist: true } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const prior = new Map(((stage.checklist as Item[] | null) ?? []).map((i) => [i.item, i]));
  const now = new Date().toISOString();
  const checklist: Item[] = parsed.data.checklist.map((c) => {
    const was = prior.get(c.item);
    if (c.checked && (!was || !was.checked)) return { item: c.item, checked: true, by: actor!.id, at: now }; // newly ticked
    if (c.checked && was?.checked) return was; // keep the original stamp
    return { item: c.item, checked: false };
  });

  await prisma.workOrderStage.update({ where: { id: sid }, data: { checklist: checklist as unknown as Prisma.InputJsonValue, ...(parsed.data.certCheckPassed !== undefined ? { certCheckPassed: parsed.data.certCheckPassed } : {}) } });
  void audit({ actorId: actor!.id, entityType: "workorder", entityId: stage.workOrderId, action: "qc.updated", after: { checked: checklist.filter((c) => c.checked).length, certCheckPassed: parsed.data.certCheckPassed } });
  return NextResponse.json({ ok: true });
});
