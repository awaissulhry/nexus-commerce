/**
 * EPQ.3 — QuoteLine.selections normalizer. Two stored shapes exist:
 *   · legacy (every pre-EPQ.3 line): a plain array of option ids
 *   · size-run lines: { options: string[], sizeRun: { "48": 5, ... } }
 * Everything that touches selections reads/writes through THIS module so both
 * shapes stay valid forever. Pure (client + server + tests share it). The
 * sizeRun object mirrors the OrderLine.sizeRun convention (FP4) — on convert
 * it is copied INTO OrderLine.sizeRun so production explosion keeps working.
 */

export type SizeRun = Record<string, number>;

export type LineSelections = { optionIds: string[]; sizeRun: SizeRun | null };

/** Keep only entries with a non-blank size and a positive integer qty. */
export function cleanSizeRun(run: unknown): SizeRun | null {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const out: SizeRun = {};
  for (const [size, qty] of Object.entries(run as Record<string, unknown>)) {
    const n = Number(qty);
    if (size.trim() && Number.isFinite(n) && Number.isInteger(n) && n > 0) out[size.trim()] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Line qty for a size-run = the sum of per-size quantities. */
export function sizeRunTotal(run: SizeRun): number {
  return Object.values(run).reduce((s, n) => s + n, 0);
}

/** Read either stored shape into a normal form. Unknown junk reads as empty. */
export function readSelections(json: unknown): LineSelections {
  if (Array.isArray(json)) return { optionIds: json.filter((x): x is string => typeof x === "string"), sizeRun: null };
  if (json && typeof json === "object") {
    const o = json as { options?: unknown; sizeRun?: unknown };
    const optionIds = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === "string") : [];
    return { optionIds, sizeRun: cleanSizeRun(o.sizeRun) };
  }
  return { optionIds: [], sizeRun: null };
}

/**
 * Write the storable shape: WITHOUT a size-run the legacy plain array is kept
 * (zero-delta for every existing line and consumer); with one, the object.
 */
export function writeSelections(optionIds: string[], sizeRun: SizeRun | null): unknown {
  const run = sizeRun ? cleanSizeRun(sizeRun) : null;
  return run ? { options: optionIds, sizeRun: run } : optionIds;
}

/** "48×5 · 50×3" — the human form (snapshot rows, size-run summaries). */
export function formatSizeRun(run: SizeRun): string {
  return Object.entries(run).map(([size, qty]) => `${size}×${qty}`).join(" · ");
}
