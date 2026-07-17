/**
 * FP11.3 — the factory's knobs: the stage pipeline new work orders read, the
 * pricing defaults (margin floor / deposit) the quote + order flows honour, and
 * the VAT display rate. GET reads them (with the shipped defaults as fallback)
 * plus the current RBAC mode; PATCH writes only these known settings.
 * FS4 — GET also returns `updatedAt` (the newest stamp across the three
 * AppSetting rows); a PATCH carrying `expectedUpdatedAt` is refused 409 when
 * the configuration moved since that read (two Owners on the Settings page).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { rbacMode } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { stampMatches, staleMessage } from "@/lib/concurrency";
import { DEFAULT_STAGES } from "@/lib/orders/production";

export const permission = FEATURES.settingsManage;

const CONFIG_KEYS = ["production.stages", "pricing.defaults", "financials.defaults"];

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return (row?.value as T) ?? fallback;
}

/** FS4 — the configuration's collective stamp: newest updatedAt across its keys (null = never written). */
async function configStamp(): Promise<Date | null> {
  const row = await prisma.appSetting.findFirst({
    where: { key: { in: CONFIG_KEYS } },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  return row?.updatedAt ?? null;
}

export const GET = guarded(FEATURES.settingsManage, async () => {
  const stages = (await readJson<{ stages?: string[] }>("production.stages", {})).stages ?? DEFAULT_STAGES;
  const pricing = await readJson<Record<string, unknown>>("pricing.defaults", {});
  const fin = await readJson<{ vatRatePct?: number }>("financials.defaults", {});
  return NextResponse.json({
    stages,
    marginFloorPct: (pricing.marginFloorPct as number | undefined) ?? 20,
    depositDefaultPct: (pricing.depositDefaultPct as number | undefined) ?? 30,
    vatRatePct: fin.vatRatePct ?? 22,
    // EPQ.4 — cost-truth + CTP-lite keys (null until the Owner enters them)
    laborRateCentsPerHour: (pricing.laborRateCentsPerHour as number | undefined) ?? null,
    overheadPct: (pricing.overheadPct as number | undefined) ?? null,
    leatherCostCentsPerSqm: (pricing.leatherCostCentsPerSqm as number | undefined) ?? null,
    capacityPerWeek: (pricing.capacityPerWeek as number | undefined) ?? null,
    procurementLeadDays: (pricing.procurementLeadDays as number | undefined) ?? null,
    rbacMode: rbacMode(),
    updatedAt: await configStamp(), // FS4 — echoed back as expectedUpdatedAt
  });
});

const Patch = z.object({
  stages: z.array(z.string().trim().min(1).max(24)).min(1).max(12).optional(),
  marginFloorPct: z.number().min(0).max(100).optional(),
  depositDefaultPct: z.number().min(0).max(100).optional(),
  vatRatePct: z.number().min(0).max(100).optional(),
  // EPQ.4 — cost-truth + CTP-lite keys (same pricing.defaults row; all
  // optional, null clears — the machinery stays dormant until entered).
  // Settings-page surface = EPT/EPD handoff; the API makes entry possible now.
  laborRateCentsPerHour: z.number().int().min(0).max(1_000_000).nullable().optional(),
  overheadPct: z.number().min(0).max(100).nullable().optional(),
  leatherCostCentsPerSqm: z.number().int().min(0).max(10_000_000).nullable().optional(),
  capacityPerWeek: z.number().min(0).max(10_000).nullable().optional(),
  procurementLeadDays: z.number().int().min(0).max(365).nullable().optional(),
  expectedUpdatedAt: z.string().datetime().nullable().optional(), // FS4 — null = "read before any config existed"
});

/** EPQ.4 — the pricing.defaults keys beyond the FP11 pair. */
const COST_KEYS = ["laborRateCentsPerHour", "overheadPct", "leatherCostCentsPerSqm", "capacityPerWeek", "procurementLeadDays"] as const;

export const PATCH = guarded(FEATURES.settingsManage, async (req, { actor }) => {
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });
  const d = parsed.data;

  // FS4 — stale guard (only when the caller sent its read stamp)
  if (d.expectedUpdatedAt !== undefined && !stampMatches(await configStamp(), d.expectedUpdatedAt)) {
    return NextResponse.json({ error: staleMessage("configuration") }, { status: 409 });
  }

  if (d.stages) {
    const stages = d.stages.map((s) => s.trim().toUpperCase()).filter((s, i, a) => s && a.indexOf(s) === i);
    await prisma.appSetting.upsert({ where: { key: "production.stages" }, create: { key: "production.stages", value: { stages } }, update: { value: { stages } } });
  }
  const touchesCostKeys = COST_KEYS.some((k) => d[k] !== undefined);
  if (d.marginFloorPct != null || d.depositDefaultPct != null || touchesCostKeys) {
    // EPQ.4 — MERGE over the stored value: this branch used to rebuild the row
    // as exactly {marginFloorPct, depositDefaultPct}, which would silently
    // wipe the cost-model/CTP keys every time the Owner saved a margin floor.
    const cur = (await prisma.appSetting.findUnique({ where: { key: "pricing.defaults" } }))?.value as Record<string, unknown> | null;
    const value: Record<string, unknown> = {
      ...(cur ?? {}),
      marginFloorPct: d.marginFloorPct ?? (cur?.marginFloorPct as number | undefined) ?? 20,
      depositDefaultPct: d.depositDefaultPct ?? (cur?.depositDefaultPct as number | undefined) ?? 30,
    };
    for (const k of COST_KEYS) {
      if (d[k] === undefined) continue;
      if (d[k] === null) delete value[k]; // null clears — the key disappears, the machinery goes dormant
      else value[k] = d[k];
    }
    await prisma.appSetting.upsert({ where: { key: "pricing.defaults" }, create: { key: "pricing.defaults", value: value as object }, update: { value: value as object } });
  }
  if (d.vatRatePct != null) {
    const cur = (await prisma.appSetting.findUnique({ where: { key: "financials.defaults" } }))?.value as Record<string, unknown> | null;
    const value = { ...(cur ?? {}), vatRatePct: d.vatRatePct };
    await prisma.appSetting.upsert({ where: { key: "financials.defaults" }, create: { key: "financials.defaults", value }, update: { value } });
  }
  const { expectedUpdatedAt: _stamp, ...changes } = d; // FS4 — the stamp is transport, not a change
  void audit({ actorId: actor!.id, entityType: "settings", entityId: "config", action: "config-updated", after: changes });
  await publishEventDurable("settings.updated"); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
