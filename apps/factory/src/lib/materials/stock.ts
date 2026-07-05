/**
 * FP7 — the four-column stock math (Katana ADOPT), pure. In stock + Committed
 * come from the append-only ledger fold; Expected is what's ordered but not yet
 * received on open POs; Available is what's physically free right now
 * (In stock − Committed). Reused by the list, the detail, and (as the same fold)
 * the FP6 floor traffic-lights.
 */
import { foldMovements } from "@/lib/ledger";

export type FourColumn = { inStock: number; committed: number; expected: number; available: number };

export function materialStock(movements: { type: string; qty: number }[], expected: number): FourColumn {
  const { inStock, committed } = foldMovements(movements);
  return { inStock, committed, expected, available: inStock - committed };
}

/** Expected for a material = Σ over its open-PO lines of (ordered − received), floored at 0. */
export function expectedForMaterial(lines: { qty: number; received: number }[]): number {
  return lines.reduce((s, l) => s + Math.max(0, l.qty - l.received), 0);
}

/** Below reorder? (null reorder = never). */
export function isLow(available: number, reorderLevel: number | null | undefined): boolean {
  return reorderLevel != null && available < reorderLevel;
}

export type PoState = "DRAFT" | "SENT" | "PARTIAL" | "RECEIVED" | "CANCELLED";

/**
 * The state a SENT PO reaches after receipts: nothing received ⇒ SENT, some but
 * not all ⇒ PARTIAL, every line fully in ⇒ RECEIVED. Pure — the route persists it.
 */
export function poStateAfterReceive(lines: { qty: number }[], receivedByLine: number[]): PoState {
  if (lines.length === 0) return "RECEIVED";
  const anyReceived = receivedByLine.some((r) => r > 0);
  const allReceived = lines.every((l, i) => (receivedByLine[i] ?? 0) >= l.qty);
  return allReceived ? "RECEIVED" : anyReceived ? "PARTIAL" : "SENT";
}
