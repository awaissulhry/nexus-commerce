/**
 * EPQ.4 — cost-model config + guards around the structured cost engine input.
 * The global rates live INSIDE AppSetting "pricing.defaults" (lazy — the row
 * is seeded; the keys appear only when the Owner enters them, all optional):
 *   { laborRateCentsPerHour?, overheadPct?, leatherCostCentsPerSqm?,
 *     capacityPerWeek?, procurementLeadDays? }
 * Absent keys keep every consumer dormant (cost parity, promise = base lead).
 * Also here: dropCostRows — the kind:"cost" waterfall rows carry money in
 * their LABELS ("Labor (6h × €20.00)"), which name-based stripping cannot
 * see, so routes returning compose results remove them wholesale for callers
 * without the costs grain — and the actual-vs-est display math.
 */
import { prisma } from "@/lib/db";
import type { CostRates } from "@/lib/pricing";
import { FIELDS } from "@/lib/auth/permissions";
import type { Resolved } from "@/lib/auth/rbac";

/** EPQ.4 — CTP-lite promise config (same pricing.defaults row, both optional). */
export type PromiseConfig = { capacityPerWeek: number | null; procurementLeadDays: number | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** Pure: read the EPQ.4 keys out of whatever pricing.defaults holds (junk-tolerant). */
export function readCostKeys(value: unknown): { rates: CostRates; promise: PromiseConfig } {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    rates: {
      laborRateCentsPerHour: num(v.laborRateCentsPerHour),
      overheadPct: num(v.overheadPct),
      leatherCostCentsPerSqm: num(v.leatherCostCentsPerSqm),
    },
    promise: {
      capacityPerWeek: num(v.capacityPerWeek),
      procurementLeadDays: num(v.procurementLeadDays),
    },
  };
}

async function loadPricingDefaultsValue(): Promise<unknown> {
  const row = await prisma.appSetting.findUnique({ where: { key: "pricing.defaults" } });
  return row?.value ?? null;
}

/** The engine's cost rates (all null until the Owner enters them). */
export async function loadCostRates(): Promise<CostRates> {
  return readCostKeys(await loadPricingDefaultsValue()).rates;
}

/** The promise-formula config (all null until the Owner enters them). */
export async function loadPromiseConfig(): Promise<PromiseConfig> {
  return readCostKeys(await loadPricingDefaultsValue()).promise;
}

/** Does this caller hold the costs grain (Owner or explicit)? */
export const canSeeCosts = (resolved: Resolved | null): boolean =>
  !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.costsView));

/**
 * Remove the kind:"cost" waterfall rows for callers without the costs grain —
 * their labels embed euro amounts that name-based stripping cannot reach.
 * Pure; a null/lineless result passes through untouched.
 */
export function dropCostRows<T extends { lines?: { kind: string }[] } | null>(result: T, showCosts: boolean): T {
  if (!result || showCosts || !Array.isArray(result.lines)) return result;
  return { ...result, lines: result.lines.filter((l) => l.kind !== "cost") } as T;
}

/** EPQ.4 — actual-vs-estimate display math for the quote-vs-actual cards. */
export function actualVsEst(actualCents: number, estCents: number): { deltaCents: number; deltaPct: number | null } {
  const deltaCents = actualCents - estCents;
  return { deltaCents, deltaPct: estCents === 0 ? null : (deltaCents / estCents) * 100 };
}
