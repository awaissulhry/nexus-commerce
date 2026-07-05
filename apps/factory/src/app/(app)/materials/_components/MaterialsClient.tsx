/**
 * FP7 — the materials workspace: every material with the four-column stock math
 * (In stock / Committed / Expected / Available), reorder + short chips, and a
 * detail drawer (movement paper-trail + lots) with a manual Adjust. Purchase
 * Orders + "+ Buy" land in FP7.2. Stock counts show to everyone; cost is
 * grain-gated.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/design-system/patterns";
import { Card, DataGrid, Drawer, Modal, useToast, Listbox } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { PurchaseOrders } from "./PurchaseOrders";
import { MOVE_TONE, type MaterialDetail, type MaterialRow, type MaterialsResponse } from "./types";

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function MaterialsClient() {
  const { toast } = useToast();
  const canAdjust = usePermission("materials.adjust");
  const canManage = usePermission("materials.manage");
  const canCost = usePermission("financials.suppliers.view");
  const [data, setData] = useState<MaterialsResponse | null>(null);
  const [view, setView] = useState<"materials" | "po">("materials");
  const [buyPrefill, setBuyPrefill] = useState<{ materialId: string; qty: number } | null>(null);
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [tab, setTab] = useState<"movements" | "lots">("movements");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", unit: "SQM", costCents: "", reorderLevel: "" });
  const [adjust, setAdjust] = useState<MaterialRow | null>(null);
  const [adjQty, setAdjQty] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await apiJson<MaterialsResponse>("/api/materials/stock")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => { try { setDetail(await apiJson<MaterialDetail>(`/api/materials/${id}`)); } catch (e) { toast((e as Error).message, "danger"); } }, [toast]);
  const open = (id: string) => { setOpenId(id); setDetail(null); setTab("movements"); void loadDetail(id); };

  const create = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      await apiJson("/api/materials", { method: "POST", body: JSON.stringify({ name: form.name.trim(), unit: form.unit, costCents: form.costCents ? Math.round(parseFloat(form.costCents) * 100) : 0, reorderLevel: form.reorderLevel ? parseFloat(form.reorderLevel) : null }) });
      setCreating(false); setForm({ name: "", unit: "SQM", costCents: "", reorderLevel: "" }); void load();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const submitAdjust = async () => {
    if (!adjust || !adjReason.trim()) return;
    const qty = parseFloat(adjQty);
    if (!Number.isFinite(qty) || qty === 0) { toast("Enter a non-zero quantity (use − to reduce)", "danger"); return; }
    setBusy(true);
    try {
      await apiJson(`/api/materials/${adjust.id}/adjust`, { method: "POST", body: JSON.stringify({ qty, reason: adjReason.trim() }) });
      setAdjust(null); setAdjQty(""); setAdjReason(""); void load(); if (openId === adjust.id) void loadDetail(adjust.id);
      toast("Stock adjusted", "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  let rows = data?.materials ?? [];
  if (q.trim()) rows = rows.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()));
  if (lowOnly) rows = rows.filter((m) => m.low || m.short);

  return (
    <div className="factory-page factory-grid-grow-1">
      <PageHeader eyebrow="Factory OS" title="Materials" subtitle="The ledger's face: In stock · Committed · Expected · Available — every number a derived truth with a paper trail." />
      <Card padded>
        <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid var(--h10-border-subtle)" }}>
          {(["materials", "po"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "8px 12px", color: view === v ? "var(--h10-primary)" : "var(--h10-text-2)", borderBottom: view === v ? "2px solid var(--h10-primary)" : "2px solid transparent", marginBottom: -1 }}>{v === "materials" ? "Materials" : "Purchase orders"}</button>
          ))}
        </div>
        {view === "po" ? (
          <PurchaseOrders materials={(data?.materials ?? []).map((m) => ({ id: m.id, name: m.name, unit: m.unit }))} prefill={buyPrefill} onConsumed={() => { setBuyPrefill(null); void load(); }} />
        ) : (
        <>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setLowOnly((v) => !v)} style={{ display: "inline-flex", gap: 5, alignItems: "center", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", background: lowOnly ? "var(--h10-primary)" : "var(--h10-surface)", color: lowOnly ? "#fff" : "var(--h10-text-2)" }}><SlidersHorizontal size={12} /> Low / short</button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <a href="/api/exports/ledger" style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export ledger</a>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search material…" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 9px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)", minWidth: 200 }} />
            {canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={13} /> New material</Button>}
          </div>
        </div>
        <DataGrid
          columns={[
            { key: "name", label: "Material", render: (m: MaterialRow) => <button type="button" onClick={() => open(m.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{m.name}</button> },
            { key: "unit", label: "Unit", render: (m: MaterialRow) => <span style={{ color: "var(--h10-text-3)" }}>{m.unit.toLowerCase()}</span> },
            { key: "inStock", label: "In stock", align: "right" as const, render: (m: MaterialRow) => num(m.inStock) },
            { key: "committed", label: "Committed", align: "right" as const, render: (m: MaterialRow) => (m.committed ? num(m.committed) : "—") },
            { key: "expected", label: "Expected", align: "right" as const, render: (m: MaterialRow) => (m.expected ? <span style={{ color: "var(--h10-text-2)" }}>+{num(m.expected)}</span> : "—") },
            { key: "available", label: "Available", align: "right" as const, render: (m: MaterialRow) => <b style={{ color: m.short ? "var(--h10-danger)" : m.low ? "var(--h10-warning, #9a6700)" : "var(--h10-text)" }}>{num(m.available)}</b> },
            { key: "reorder", label: "Reorder", render: (m: MaterialRow) => (m.short ? <Pill tone="danger">short</Pill> : m.low ? <Pill tone="warning">low</Pill> : m.reorderLevel != null ? <span style={{ color: "var(--h10-text-3)" }}>@{num(m.reorderLevel)}</span> : "—") },
            ...(canCost ? [{ key: "cost", label: "Cost", align: "right" as const, render: (m: MaterialRow) => (m.costCents != null ? `${eur(m.costCents)}/${m.unit.toLowerCase()}` : "—") }] : []),
          ]}
          rows={rows}
          rowKey={(m: MaterialRow) => m.id}
          emptyState="No materials yet — add one, or import opening stock."
        />
        </>
        )}
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title="New material" size="sm" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim() || busy}>Create</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <div><div style={lbl}>Name</div><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Kangaroo hide" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><div style={lbl}>Unit</div><Listbox ariaLabel="Unit" options={["HIDE", "SQM", "PIECE", "M"].map((u) => ({ value: u, label: u }))} value={form.unit} onChange={(v) => setForm((f) => ({ ...f, unit: v }))} /></div>
            <div><div style={lbl}>Reorder level</div><Input value={form.reorderLevel} onChange={(e) => setForm((f) => ({ ...f, reorderLevel: e.target.value }))} placeholder="optional" /></div>
          </div>
          {canCost && <div><div style={lbl}>Cost per unit (€)</div><Input value={form.costCents} onChange={(e) => setForm((f) => ({ ...f, costCents: e.target.value }))} placeholder="0.00" /></div>}
        </div>
      </Modal>

      <Modal open={!!adjust} onClose={() => setAdjust(null)} title={`Adjust ${adjust?.name ?? ""}`} size="sm" footer={<><Button onClick={() => setAdjust(null)}>Cancel</Button><Button variant="primary" onClick={submitAdjust} disabled={!adjReason.trim() || busy}>Record adjustment</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>A signed adjustment (use − to reduce) with a reason — appended to the ledger, never an edit.</div>
          <div><div style={lbl}>Quantity {adjust ? `(${adjust.unit.toLowerCase()})` : ""}</div><input type="number" step="0.01" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} placeholder="e.g. -2 or 5" style={inp} /></div>
          <div><div style={lbl}>Reason</div><input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} placeholder="stock count correction" style={inp} /></div>
        </div>
      </Modal>

      <Drawer open={!!openId} onClose={() => setOpenId(null)} title={detail?.material.name ?? "Material"}>
        {detail && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
              {([["In stock", detail.stock.inStock], ["Committed", detail.stock.committed], ["Expected", detail.stock.expected], ["Available", detail.stock.available]] as const).map(([k, v]) => (
                <div key={k} style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: k === "Available" && detail.stock.short ? "var(--h10-danger)" : undefined }}>{num(v)}</div>
                  <div style={{ fontSize: 10.5, color: "var(--h10-text-3)" }}>{k}</div>
                </div>
              ))}
            </div>
            {canAdjust && <Button onClick={() => { setAdjust({ id: detail.material.id, name: detail.material.name, unit: detail.material.unit } as MaterialRow); setAdjQty(""); setAdjReason(""); }}>Adjust stock</Button>}
            <div style={{ display: "flex", gap: 4 }}>
              {(["movements", "lots"] as const).map((t) => <button key={t} type="button" onClick={() => setTab(t)} style={{ border: "none", background: tab === t ? "var(--h10-primary)" : "transparent", color: tab === t ? "#fff" : "var(--h10-text-2)", borderRadius: 8, padding: "5px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{t === "movements" ? "Movements" : `Lots (${detail.lots.length})`}</button>)}
            </div>
            {tab === "movements" ? (
              <div style={{ display: "grid", gap: 4 }}>
                {detail.movements.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No movements yet.</div>}
                {detail.movements.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 }}>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Pill tone={MOVE_TONE[m.type]}>{m.type}</Pill><span style={{ color: "var(--h10-text-3)" }}>{m.reason ?? m.refType ?? ""}</span></span>
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{m.type === "OUT" ? "−" : m.type === "IN" ? "+" : ""}{num(Math.abs(m.qty))}</span><span style={{ color: "var(--h10-text-3)", fontSize: 11 }}>{new Date(m.at).toLocaleDateString()}</span></span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {detail.lots.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No lots — received stock lands here as batches.</div>}
                {detail.lots.map((l) => (
                  <div key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 }}>
                    <span><b>{l.lotCode}</b>{l.supplier ? <span style={{ color: "var(--h10-text-3)" }}> · {l.supplier}</span> : ""}</span>
                    <span style={{ fontFamily: "ui-monospace, monospace" }}>{num(l.onHand)} on hand</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

const lbl: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };
const inp: React.CSSProperties = { width: "100%", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" };
