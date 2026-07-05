/**
 * FP11.3 — the factory's knobs: the stage pipeline new work orders read, the
 * pricing defaults (margin floor / deposit) the quote + order flows honour, and
 * the VAT display rate. GET reads them (with the shipped defaults as fallback)
 * plus the current RBAC mode; PATCH writes only these known settings.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { rbacMode } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DEFAULT_STAGES } from "@/lib/orders/production";

export const permission = FEATURES.settingsManage;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return (row?.value as T) ?? fallback;
}

export const GET = guarded(FEATURES.settingsManage, async () => {
  const stages = (await readJson<{ stages?: string[] }>("production.stages", {})).stages ?? DEFAULT_STAGES;
  const pricing = await readJson<{ marginFloorPct?: number; depositDefaultPct?: number }>("pricing.defaults", {});
  const fin = await readJson<{ vatRatePct?: number }>("financials.defaults", {});
  return NextResponse.json({
    stages,
    marginFloorPct: pricing.marginFloorPct ?? 20,
    depositDefaultPct: pricing.depositDefaultPct ?? 30,
    vatRatePct: fin.vatRatePct ?? 22,
    rbacMode: rbacMode(),
  });
});

const Patch = z.object({
  stages: z.array(z.string().trim().min(1).max(24)).min(1).max(12).optional(),
  marginFloorPct: z.number().min(0).max(100).optional(),
  depositDefaultPct: z.number().min(0).max(100).optional(),
  vatRatePct: z.number().min(0).max(100).optional(),
});

export const PATCH = guarded(FEATURES.settingsManage, async (req, { actor }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });
  const d = parsed.data;

  if (d.stages) {
    const stages = d.stages.map((s) => s.trim().toUpperCase()).filter((s, i, a) => s && a.indexOf(s) === i);
    await prisma.appSetting.upsert({ where: { key: "production.stages" }, create: { key: "production.stages", value: { stages } }, update: { value: { stages } } });
  }
  if (d.marginFloorPct != null || d.depositDefaultPct != null) {
    const cur = (await prisma.appSetting.findUnique({ where: { key: "pricing.defaults" } }))?.value as { marginFloorPct?: number; depositDefaultPct?: number } | null;
    const value = { marginFloorPct: d.marginFloorPct ?? cur?.marginFloorPct ?? 20, depositDefaultPct: d.depositDefaultPct ?? cur?.depositDefaultPct ?? 30 };
    await prisma.appSetting.upsert({ where: { key: "pricing.defaults" }, create: { key: "pricing.defaults", value }, update: { value } });
  }
  if (d.vatRatePct != null) {
    const cur = (await prisma.appSetting.findUnique({ where: { key: "financials.defaults" } }))?.value as Record<string, unknown> | null;
    const value = { ...(cur ?? {}), vatRatePct: d.vatRatePct };
    await prisma.appSetting.upsert({ where: { key: "financials.defaults" }, create: { key: "financials.defaults", value }, update: { value } });
  }
  void audit({ actorId: actor!.id, entityType: "settings", entityId: "config", action: "config-updated", after: d });
  return NextResponse.json({ ok: true });
});
