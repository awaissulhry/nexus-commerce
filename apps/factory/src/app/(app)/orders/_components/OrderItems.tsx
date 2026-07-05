/**
 * FP4.4 — the order's line items, and (for B2B, before production) the size-run
 * matrix editor. A size-run explodes into per-size work orders at Start
 * production; the line qty tracks the matrix total. Editable only while
 * CONFIRMED (docstatus lock).
 */
"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Card, Modal, useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { parseSizeRun } from "@/lib/orders/production";
import type { OrderLineDetail } from "./types";

const inp: React.CSSProperties = { border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)", width: "100%" };

export function OrderItems({ orderId, state, lines, canEdit, onChanged }: { orderId: string; state: string; lines: OrderLineDetail[]; canEdit: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<OrderLineDetail | null>(null);
  const [rows, setRows] = useState<{ size: string; qty: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const editable = canEdit && state === "CONFIRMED";

  const open = (line: OrderLineDetail) => {
    const sr = parseSizeRun(line.sizeRun);
    setRows(sr.length ? sr.map((r) => ({ size: r.size, qty: String(r.qty) })) : [{ size: "", qty: "" }]);
    setEditing(line);
  };
  const total = rows.reduce((s, r) => s + (Number(r.qty) > 0 ? Number(r.qty) : 0), 0);
  const save = async (clear = false) => {
    if (!editing) return;
    setBusy(true);
    try {
      const obj = clear ? null : Object.fromEntries(rows.filter((r) => r.size.trim() && Number(r.qty) > 0).map((r) => [r.size.trim(), Number(r.qty)]));
      await apiJson(`/api/orders/${orderId}/lines/${editing.id}`, { method: "PATCH", body: JSON.stringify({ sizeRun: obj && Object.keys(obj).length ? obj : null }) });
      setEditing(null); onChanged(); toast(clear ? "Size run cleared" : "Size run saved", "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  return (
    <Card padded>
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Items</div>
      <div style={{ display: "grid", gap: 8 }}>
        {lines.map((l) => {
          const sr = parseSizeRun(l.sizeRun);
          return (
            <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--h10-border-subtle)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{l.description}{l.qty > 1 ? ` · ×${l.qty}` : ""}</div>
                {sr.length > 0 && <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginTop: 2 }}>{sr.map((r) => `${r.size}:${r.qty}`).join("  ·  ")}</div>}
              </div>
              {editable && <button type="button" onClick={() => open(l)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-link)", whiteSpace: "nowrap" }}>{sr.length ? "Edit size run" : "+ Size run"}</button>}
            </div>
          );
        })}
        {lines.length === 0 && <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>No lines.</div>}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Size run — ${editing?.description ?? ""}`} size="sm"
        footer={<>
          <Button onClick={() => void save(true)} disabled={busy}>Clear</Button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => void save(false)} disabled={busy || total === 0}>Save ({total})</Button></div>
        </>}>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: "var(--h10-text-2)", marginBottom: 2 }}>Enter a quantity per size. Each size becomes its own work order.</div>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 90px 28px", gap: 6, alignItems: "center" }}>
              <input value={r.size} onChange={(e) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} placeholder="Size (e.g. 50)" style={inp} />
              <input type="number" min="0" value={r.qty} onChange={(e) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty" style={{ ...inp, fontFamily: "ui-monospace, monospace" }} />
              <button type="button" onClick={() => setRows((xs) => xs.filter((_, j) => j !== i))} style={{ border: "1px solid var(--h10-border)", borderRadius: 7, background: "var(--h10-surface)", cursor: "pointer", height: 30, display: "grid", placeItems: "center", color: "var(--h10-text-3)" }}><X size={13} /></button>
            </div>
          ))}
          <button type="button" onClick={() => setRows((xs) => [...xs, { size: "", qty: "" }])} style={{ justifySelf: "start", background: "none", border: "none", padding: "2px 0", cursor: "pointer", fontSize: 12, color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}><Plus size={12} /> Add size</button>
        </div>
      </Modal>
    </Card>
  );
}
