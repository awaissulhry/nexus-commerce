/**
 * FP7 — purchase orders: the list, a detail drawer (Send / Receive / Cancel with
 * per-line received progress), a new-PO builder, and a receive form (per line →
 * lot → IN). Totals are grain-gated. Receiving lifts stock and turns a floor
 * short-light green.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Drawer, Modal, useToast, Listbox } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { VirtualDataGrid } from "@/components/VirtualDataGrid"; // FS3 — windowed rows, DS-grid parity
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { PO_TONE, type PODetail, type PORow, type POResponse } from "./types";

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const inp: React.CSSProperties = { width: "100%", border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" };

type NewLine = { materialId: string; qty: string; unitCostCents: string };

export function PurchaseOrders({ materials, prefill, onConsumed }: { materials: { id: string; name: string; unit: string }[]; prefill: { materialId: string; qty: number } | null; onConsumed: () => void }) {
  const { toast } = useToast();
  const canManage = usePermission("materials.manage");
  const canReceive = usePermission("materials.receive");
  const canCost = usePermission("financials.suppliers.view");
  const [data, setData] = useState<POResponse | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PODetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [lines, setLines] = useState<NewLine[]>([{ materialId: "", qty: "", unitCostCents: "" }]);
  const [receiving, setReceiving] = useState(false);
  const [recVals, setRecVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { try { setData(await apiJson<POResponse>("/api/purchase-orders")); } catch (e) { toast((e as Error).message, "danger"); } }, [toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { apiJson<{ contacts: { id: string; name: string }[] }>("/api/contacts?kind=supplier").then((d) => setSuppliers(d.contacts)).catch(() => {}); }, []);

  const loadDetail = useCallback(async (id: string) => { try { setDetail(await apiJson<PODetail>(`/api/purchase-orders/${id}`)); } catch (e) { toast((e as Error).message, "danger"); } }, [toast]);
  const open = (id: string) => { setOpenId(id); setDetail(null); void loadDetail(id); };

  const openNew = useCallback(() => { setSupplierId(""); setLines(prefill ? [{ materialId: prefill.materialId, qty: String(prefill.qty), unitCostCents: "" }] : [{ materialId: "", qty: "", unitCostCents: "" }]); setCreating(true); }, [prefill]);
  useEffect(() => { if (prefill) openNew(); }, [prefill, openNew]);

  const create = async () => {
    const valid = lines.filter((l) => l.materialId && Number(l.qty) > 0);
    if (!supplierId || valid.length === 0) { toast("Pick a supplier and at least one line", "danger"); return; }
    setBusy(true);
    try {
      const d = await apiJson<{ purchaseOrder: { id: string } }>("/api/purchase-orders", { method: "POST", body: JSON.stringify({ supplierId, lines: valid.map((l) => ({ materialId: l.materialId, qty: Number(l.qty), unit: materials.find((m) => m.id === l.materialId)?.unit ?? "PIECE", unitCostCents: l.unitCostCents ? Math.round(parseFloat(l.unitCostCents) * 100) : 0 })) }) });
      setCreating(false); onConsumed(); void load(); open(d.purchaseOrder.id);
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const setState = async (action: "send" | "cancel") => {
    if (!detail) return;
    try { setDetail(await apiJson<PODetail>(`/api/purchase-orders/${detail.purchaseOrder.id}`, { method: "PATCH", body: JSON.stringify({ action }) })); void load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const openReceive = () => { if (!detail) return; setRecVals(Object.fromEntries(detail.purchaseOrder.lines.map((l) => [l.materialId, String(Math.max(0, l.qty - l.received))]))); setReceiving(true); };
  const submitReceive = async () => {
    if (!detail) return;
    const receipts = Object.entries(recVals).map(([materialId, v]) => ({ materialId, qty: Number(v) })).filter((r) => r.qty > 0);
    if (receipts.length === 0) { toast("Enter a quantity to receive", "danger"); return; }
    setBusy(true);
    try { const r = await apiJson<{ state: string }>(`/api/purchase-orders/${detail.purchaseOrder.id}/receive`, { method: "POST", body: JSON.stringify({ receipts }) }); setReceiving(false); await loadDetail(detail.purchaseOrder.id); void load(); onConsumed(); toast(`Received — PO ${r.state.toLowerCase()}`, "success"); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const po = detail?.purchaseOrder;

  return (
    <>
      <div style={{ display: "flex", marginBottom: 10 }}>
        {canManage && <div style={{ marginLeft: "auto" }}><Button variant="primary" onClick={openNew}><Plus size={13} /> New PO</Button></div>}
      </div>
      <VirtualDataGrid
        height="calc(100dvh - 320px)"
        columns={[
          { key: "number", label: "PO", render: (r: PORow) => <button type="button" onClick={() => open(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
          { key: "supplier", label: "Supplier", render: (r: PORow) => r.supplier },
          { key: "state", label: "State", render: (r: PORow) => <Pill tone={PO_TONE[r.state]}>{r.state.toLowerCase()}</Pill> },
          { key: "lines", label: "Lines", align: "right" as const, render: (r: PORow) => r.lineCount },
          ...(canCost ? [{ key: "total", label: "Total", align: "right" as const, render: (r: PORow) => (r.totalCents != null ? eur(r.totalCents) : "—") }] : []),
          { key: "expected", label: "Expected", render: (r: PORow) => (r.expectedAt ? new Date(r.expectedAt).toLocaleDateString() : "—") },
        ]}
        rows={data?.purchaseOrders ?? []}
        rowKey={(r: PORow) => r.id}
        emptyState="No purchase orders yet — create one, or use “+ Buy” from a short material."
      />

      <Modal open={creating} onClose={() => setCreating(false)} title="New purchase order" size="md" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={busy}>Create draft</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <div><div style={lblStyle}>Supplier</div><Listbox ariaLabel="Supplier" options={[{ value: "", label: "Choose a supplier…" }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]} value={supplierId} onChange={setSupplierId} />{suppliers.length === 0 && <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 3 }}>Add a Supplier contact first.</div>}</div>
          <div>
            <div style={lblStyle}>Lines</div>
            <div style={{ display: "grid", gap: 6 }}>
              {lines.map((l, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 90px 28px", gap: 6, alignItems: "center" }}>
                  <Listbox ariaLabel="Material" options={[{ value: "", label: "material…" }, ...materials.map((m) => ({ value: m.id, label: m.name }))]} value={l.materialId} onChange={(v) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, materialId: v } : x)))} />
                  <input type="number" min="0" value={l.qty} onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="qty" style={inp} />
                  {canCost && <input type="number" step="0.01" value={l.unitCostCents} onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, unitCostCents: e.target.value } : x)))} placeholder="€/unit" style={inp} />}
                  <button type="button" onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))} style={{ border: "1px solid var(--h10-border)", borderRadius: 7, background: "var(--h10-surface)", cursor: "pointer", height: 30, display: "grid", placeItems: "center", color: "var(--h10-text-3)" }}><X size={13} /></button>
                </div>
              ))}
              <button type="button" onClick={() => setLines((xs) => [...xs, { materialId: "", qty: "", unitCostCents: "" }])} style={{ justifySelf: "start", background: "none", border: "none", padding: "2px 0", cursor: "pointer", fontSize: 12, color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}><Plus size={12} /> Add line</button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={receiving} onClose={() => setReceiving(false)} title={`Receive ${po?.number ?? ""}`} size="sm" footer={<><Button onClick={() => setReceiving(false)}>Cancel</Button><Button variant="primary" onClick={submitReceive} disabled={busy}>Receive into stock</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Each receipt becomes a lot + an IN movement. Stock rises immediately.</div>
          {po?.lines.map((l) => (
            <div key={l.materialId} style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12.5 }}>{l.materialName} <span style={{ color: "var(--h10-text-3)" }}>· {l.received}/{l.qty} in</span></span>
              <input type="number" min="0" step="0.01" value={recVals[l.materialId] ?? ""} onChange={(e) => setRecVals((v) => ({ ...v, [l.materialId]: e.target.value }))} style={inp} />
            </div>
          ))}
        </div>
      </Modal>

      <Drawer open={!!openId} onClose={() => setOpenId(null)} title={po?.number ?? "Purchase order"} footer={po && po.state !== "CANCELLED" && po.state !== "RECEIVED" ? (
        <div style={{ display: "flex", gap: 8 }}>
          {po.state === "DRAFT" && canManage && <Button variant="primary" onClick={() => void setState("send")}>Send</Button>}
          {(po.state === "SENT" || po.state === "PARTIAL") && canReceive && <Button variant="primary" onClick={openReceive}>Receive</Button>}
          {canManage && <Button onClick={() => void setState("cancel")} style={{ marginLeft: "auto", color: "var(--h10-danger)", borderColor: "var(--h10-danger)" }}>Cancel PO</Button>}
        </div>
      ) : undefined}>
        {po && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}><Pill tone={PO_TONE[po.state]}>{po.state.toLowerCase()}</Pill><span style={{ color: "var(--h10-text-2)" }}>{po.supplier.name}</span></div>
            <div style={{ display: "grid", gap: 6 }}>
              {po.lines.map((l) => (
                <div key={l.materialId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 }}>
                  <span><b>{l.materialName}</b><span style={{ color: "var(--h10-text-3)" }}> · {num(l.qty)} {l.unit.toLowerCase()}</span></span>
                  <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                    {l.received >= l.qty ? <Pill tone="success">received</Pill> : l.received > 0 ? <Pill tone="warning">{num(l.received)}/{num(l.qty)}</Pill> : <span style={{ color: "var(--h10-text-3)" }}>—</span>}
                    {canCost && l.lineTotalCents != null && <span style={{ fontFamily: "ui-monospace, monospace" }}>{eur(l.lineTotalCents)}</span>}
                  </span>
                </div>
              ))}
            </div>
            {canCost && po.totalCents != null && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}><span>Total</span><span style={{ fontFamily: "ui-monospace, monospace" }}>{eur(po.totalCents)}</span></div>}
          </div>
        )}
      </Drawer>
    </>
  );
}

const lblStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };
