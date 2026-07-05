/** FP7 — materials workspace shapes (cost optional: grain-stripped; stock counts are not financial). */
export type MaterialRow = {
  id: string;
  name: string;
  unit: string;
  costCents?: number;
  reorderLevel: number | null;
  inStock: number;
  committed: number;
  expected: number;
  available: number;
  low: boolean;
  short: boolean;
  archivedAt: string | null;
};

export type MaterialsResponse = { materials: MaterialRow[] };

export type Movement = { id: string; type: "IN" | "OUT" | "ADJUST" | "RESERVE" | "RELEASE"; qty: number; reason: string | null; refType: string | null; refId: string | null; lot: string | null; actor: string | null; at: string };
export type Lot = { id: string; lotCode: string; supplier: string | null; receivedAt: string | null; onHand: number };

export type MaterialDetail = {
  material: { id: string; name: string; unit: string; costCents?: number; reorderLevel: number | null; notes: string | null; archivedAt: string | null };
  stock: { inStock: number; committed: number; expected: number; available: number; low: boolean; short: boolean };
  movements: Movement[];
  lots: Lot[];
  usedByTemplates: number;
};

export const MOVE_TONE: Record<Movement["type"], "success" | "danger" | "warning" | "info" | "neutral"> = { IN: "success", OUT: "danger", ADJUST: "warning", RESERVE: "info", RELEASE: "neutral" };
