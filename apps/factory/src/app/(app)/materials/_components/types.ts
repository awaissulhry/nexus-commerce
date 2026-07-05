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
  whereUsed: { id: string; name: string }[];
};

export const MOVE_TONE: Record<Movement["type"], "success" | "danger" | "warning" | "info" | "neutral"> = { IN: "success", OUT: "danger", ADJUST: "warning", RESERVE: "info", RELEASE: "neutral" };

export type PoState = "DRAFT" | "SENT" | "PARTIAL" | "RECEIVED" | "CANCELLED";
export type PORow = { id: string; number: string; supplier: string; state: PoState; lineCount: number; totalCents?: number; expectedAt: string | null; createdAt: string };
export type POResponse = { purchaseOrders: PORow[]; counts: Record<string, number> };
export type POLine = { materialId: string; materialName: string; qty: number; unit: string; unitCostCents?: number; received: number; lineTotalCents?: number };
export type PODetail = { purchaseOrder: { id: string; number: string; state: PoState; supplier: { id: string; name: string }; expectedAt: string | null; lines: POLine[]; totalCents?: number } };
export const PO_TONE: Record<PoState, "neutral" | "info" | "warning" | "success" | "danger"> = { DRAFT: "neutral", SENT: "info", PARTIAL: "warning", RECEIVED: "success", CANCELLED: "danger" };
