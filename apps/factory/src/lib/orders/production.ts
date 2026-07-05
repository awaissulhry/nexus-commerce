/**
 * FP4 — Start production planning (pure): turn an order's lines into the work
 * orders that will be created, applying the deposit gate (FD13) and exploding
 * B2B size-runs into per-size WOs. Kept pure so it is unit-tested without a DB.
 */
export const DEFAULT_STAGES = ["CUTTING", "STITCHING", "ASSEMBLY", "QC", "PACKING"];

export type PlanLine = { lineId: string; description: string; qty: number; costCents: number; sizeRun?: unknown };
export type PlannedWO = { number: string; orderLineId: string; label: string | null; estCostCents: number; state: "READY" | "BLOCKED"; blockedReason: string | null };

/** A size-run is a `{ [size]: qty }` object with ≥1 positive entry. */
export function parseSizeRun(sizeRun: unknown): { size: string; qty: number }[] {
  if (!sizeRun || typeof sizeRun !== "object" || Array.isArray(sizeRun)) return [];
  return Object.entries(sizeRun as Record<string, unknown>)
    .map(([size, qty]) => ({ size, qty: Number(qty) }))
    .filter((r) => Number.isFinite(r.qty) && r.qty > 0);
}

/**
 * Plan the work orders for `orderNumber` from its lines. One WO per line; a line
 * carrying a size-run explodes into one WO per size (labelled). Deposit unmet ⇒
 * every WO is BLOCKED "awaiting deposit"; otherwise READY.
 */
export function planWorkOrders(orderNumber: string, lines: PlanLine[], depositMet: boolean): PlannedWO[] {
  const wos: PlannedWO[] = [];
  const gate = (): Pick<PlannedWO, "state" | "blockedReason"> => (depositMet ? { state: "READY", blockedReason: null } : { state: "BLOCKED", blockedReason: "awaiting deposit" });
  let k = 0;
  for (const line of lines) {
    const sizes = parseSizeRun(line.sizeRun);
    if (sizes.length > 0) {
      for (const s of sizes) {
        k += 1;
        wos.push({ number: `${orderNumber}/${k}`, orderLineId: line.lineId, label: `${line.description} · Size ${s.size} · ×${s.qty}`, estCostCents: (line.costCents ?? 0) * s.qty, ...gate() });
      }
    } else {
      k += 1;
      wos.push({ number: `${orderNumber}/${k}`, orderLineId: line.lineId, label: line.qty > 1 ? `${line.description} · ×${line.qty}` : line.description, estCostCents: (line.costCents ?? 0) * (line.qty ?? 1), ...gate() });
    }
  }
  return wos;
}
