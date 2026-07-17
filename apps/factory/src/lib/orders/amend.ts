/**
 * EPO.5 — the amendment fold, pure. "Nothing confirmed is silently editable"
 * (ERPNext docstatus verdict): an amendment computes the field-level diff and
 * the net delta from before/after line sets; the caller freezes the before
 * snapshot in an OrderRevision. No Prisma, no dates — unit-provable.
 */

export type AmendableLine = {
  id: string;
  description: string;
  qty: number;
  netPriceCents: number;
  sizeRun?: unknown;
};

export type LineEdit = {
  lineId: string;
  qty?: number;
  netPriceCents?: number;
  description?: string;
  sizeRun?: Record<string, number> | null;
};

export type AmendChange = { lineId: string; description: string; field: string; from: unknown; to: unknown };

export type AmendResult = {
  changes: AmendChange[];
  /** Σ(net×qty) after − before */
  netDeltaCents: number;
  /** the lines with edits applied (for the caller's update writes) */
  nextLines: AmendableLine[];
};

const lineNet = (l: AmendableLine) => l.netPriceCents * l.qty;
const runTotal = (r: Record<string, number>) => Object.values(r).reduce((s, n) => s + Math.max(0, n), 0);

/** Apply edits to the line set; unknown lineIds are ignored (caller validates existence). */
export function applyAmendment(lines: AmendableLine[], edits: LineEdit[]): AmendResult {
  const changes: AmendChange[] = [];
  const byId = new Map(edits.map((e) => [e.lineId, e]));
  const nextLines = lines.map((l) => {
    const e = byId.get(l.id);
    if (!e) return l;
    const next = { ...l };
    if (e.description !== undefined && e.description !== l.description) {
      changes.push({ lineId: l.id, description: l.description, field: "description", from: l.description, to: e.description });
      next.description = e.description;
    }
    if (e.netPriceCents !== undefined && e.netPriceCents !== l.netPriceCents) {
      changes.push({ lineId: l.id, description: l.description, field: "netPriceCents", from: l.netPriceCents, to: e.netPriceCents });
      next.netPriceCents = e.netPriceCents;
    }
    if (e.sizeRun !== undefined) {
      const cleaned = e.sizeRun && Object.keys(e.sizeRun).length > 0 ? e.sizeRun : null;
      changes.push({ lineId: l.id, description: l.description, field: "sizeRun", from: l.sizeRun ?? null, to: cleaned });
      next.sizeRun = cleaned;
      // a size-run edit implies its qty (matrix total wins over a bare qty edit)
      const total = cleaned ? runTotal(cleaned) : (e.qty ?? l.qty);
      if (total > 0 && total !== l.qty) {
        changes.push({ lineId: l.id, description: l.description, field: "qty", from: l.qty, to: total });
        next.qty = total;
      }
    } else if (e.qty !== undefined && e.qty !== l.qty) {
      changes.push({ lineId: l.id, description: l.description, field: "qty", from: l.qty, to: e.qty });
      next.qty = e.qty;
    }
    return next;
  });
  const before = lines.reduce((s, l) => s + lineNet(l), 0);
  const after = nextLines.reduce((s, l) => s + lineNet(l), 0);
  return { changes, netDeltaCents: after - before, nextLines };
}
