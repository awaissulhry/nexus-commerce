/**
 * FP6 — material coverage by priority (pure — the reallocation authority). Given
 * the physical stock per material and the board's Work Orders in PRIORITY ORDER,
 * greedily hand each WO its demand: higher-priority jobs take scarce hide first.
 * A WO is OK (fully covered), PARTIAL (some materials short), or SHORT (nothing).
 * Reordering priority + recomputing is how the traffic lights shift. Deducting
 * from a running pool means the same stock is never promised to two WOs.
 */
export type Demand = Record<string, number>; // materialId → qty needed
export type Coverage = "OK" | "PARTIAL" | "SHORT";
export type WoCoverage = { status: Coverage; short: string[] };

export function allocateByPriority(
  stock: Record<string, number>,
  wosByPriority: { id: string; demand: Demand }[],
): Record<string, WoCoverage> {
  const remaining: Record<string, number> = { ...stock };
  const out: Record<string, WoCoverage> = {};

  for (const wo of wosByPriority) {
    const materials = Object.entries(wo.demand);
    if (materials.length === 0) {
      out[wo.id] = { status: "OK", short: [] };
      continue;
    }
    let covered = 0;
    const short: string[] = [];
    for (const [mat, qty] of materials) {
      const have = remaining[mat] ?? 0;
      if (have >= qty) {
        remaining[mat] = have - qty;
        covered += 1;
      } else {
        remaining[mat] = 0; // consume what's left; the rest is short
        short.push(mat);
      }
    }
    out[wo.id] = { status: covered === materials.length ? "OK" : covered === 0 ? "SHORT" : "PARTIAL", short };
  }
  return out;
}

/** Merge a list of {materialId, qty} draws into a Demand map (summing by material). */
export function toDemand(draws: { materialId: string; qty: number }[]): Demand {
  const d: Demand = {};
  for (const { materialId, qty } of draws) d[materialId] = (d[materialId] ?? 0) + qty;
  return d;
}
