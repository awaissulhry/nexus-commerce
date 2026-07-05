/**
 * F1 — field-level financial stripping (S2 pattern with the documented Nexus
 * gaps closed at birth, F0-FINDINGS §8). The schema's naming discipline makes
 * name-based stripping sufficient: *Cents / *Pct suffixes plus a small
 * explicit map. "Absent data, not a hidden column" — keys are DELETED.
 * Called by the route guard on JSON responses AND explicitly by every
 * exporter / PDF / email renderer (they bypass response serialization).
 */
import { FIELDS } from "./permissions";
import type { Resolved } from "./rbac";

const MAX_DEPTH = 12;

// distinctive-name → required grain
const EXPLICIT: Record<string, string> = {
  paymentTerms: FIELDS.suppliersView,
  depositDefaultPct: FIELDS.pricesView,
  depositPct: FIELDS.pricesView,
  adjustmentReason: FIELDS.pricesView,
  lostReason: FIELDS.pricesView,
};

function grainFor(key: string): string | null {
  if (EXPLICIT[key]) return EXPLICIT[key];
  if (/margin(Cents|Pct)$/i.test(key) || /^margin/i.test(key)) return FIELDS.marginsView;
  if (/costs?(Cents|Delta|DeltaMode)$/i.test(key) || /^cost(Cents|Delta)/i.test(key) || /CostCents$/.test(key))
    return FIELDS.costsView;
  if (/priceDelta(Mode)?$/i.test(key)) return FIELDS.pricesView;
  // Deny-by-default for money: ANY *Cents key not classified above is a price.
  // The schema's naming discipline (*Cents suffix) makes this catch-all
  // sufficient — an unclassified money field can never leak.
  if (/Cents$/.test(key)) return FIELDS.pricesView;
  return null;
}

/** Deep-strips financial keys the caller has no grain for. Mutates a copy. */
export function stripFinancials<T>(payload: T, resolved: Resolved | null): T {
  const allowed = (grain: string) =>
    !!resolved && (resolved.isOwner || resolved.permissions.has(grain));
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const grain = grainFor(key);
      if (grain && !allowed(grain)) continue; // deleted, not nulled
      out[key] = walk(value, depth + 1);
    }
    return out;
  };
  return walk(payload, 0) as T;
}
