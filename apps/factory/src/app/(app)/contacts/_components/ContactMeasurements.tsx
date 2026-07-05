/**
 * FP5.2 — versioned measurement profiles (Tailornova ADOPT). Per garment type,
 * the current profile shows its fields + fit notes; **Edit creates a new version
 * that supersedes it** (the prior stays, viewable as a history chip). Fields are
 * a free-form name→value matrix. Photo attachments are deferred (flagged).
 */
"use client";

import { useState } from "react";
import { Plus, X, History } from "lucide-react";
import { Card, Modal, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { organizeProfiles } from "@/lib/contacts/measurements";
import type { MeasurementProfile } from "./types";

const inp: React.CSSProperties = { border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)", width: "100%" };

type Row = { key: string; value: string };
const toRows = (fields: Record<string, unknown> | null | undefined): Row[] => Object.entries(fields ?? {}).map(([key, value]) => ({ key, value: String(value) }));

export function ContactMeasurements({ contactId, measurements, canManage, onChanged }: { contactId: string; measurements: MeasurementProfile[]; canManage: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ supersedesId?: string; name: string; garmentType: string; fitNotes: string } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = organizeProfiles(measurements);

  const openNew = () => { setEditing({ name: "", garmentType: "", fitNotes: "" }); setRows([{ key: "", value: "" }]); };
  const openEdit = (p: MeasurementProfile) => { setEditing({ supersedesId: p.id, name: p.name, garmentType: p.garmentType, fitNotes: p.fitNotes ?? "" }); setRows(toRows(p.fields).length ? toRows(p.fields) : [{ key: "", value: "" }]); };

  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.garmentType.trim()) { toast("Name and garment type are required", "danger"); return; }
    setBusy(true);
    try {
      const fields = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), Number(r.value) || r.value]));
      await apiJson(`/api/contacts/${contactId}/measurements`, { method: "POST", body: JSON.stringify({ name: editing.name.trim(), garmentType: editing.garmentType.trim(), fields, fitNotes: editing.fitNotes.trim() || undefined, supersedesId: editing.supersedesId }) });
      setEditing(null); onChanged(); toast(editing.supersedesId ? "New version saved" : "Profile created", "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const del = async (mid: string) => {
    setBusy(true);
    try { await apiJson(`/api/contacts/${contactId}/measurements/${mid}`, { method: "DELETE" }); onChanged(); toast("Deleted", "info"); }
    catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  return (
    <Card padded>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800 }}>Measurements</div>
        {canManage && <Button onClick={openNew}><Plus size={13} /> New profile</Button>}
      </div>

      {groups.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No measurement profiles yet. Add one per garment type — editing it later keeps every prior version.</div>}

      <div style={{ display: "grid", gap: 12 }}>
        {groups.map((g) => {
          const p = g.current;
          const entries = toRows(p.fields);
          return (
            <div key={p.id} style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{g.garmentType}</span>
                  <span style={{ fontSize: 12, color: "var(--h10-text-2)" }}>{p.name}</span>
                  <Pill tone="info">v{p.version}</Pill>
                  {g.history.length > 0 && <button type="button" onClick={() => setHistoryOf(historyOf === p.id ? null : p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-3)", fontSize: 11.5, display: "inline-flex", gap: 3, alignItems: "center" }}><History size={12} /> {g.history.length} older</button>}
                </div>
                {canManage && (
                  <div style={{ display: "inline-flex", gap: 8 }}>
                    <button type="button" onClick={() => openEdit(p)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-link)", fontSize: 12 }}>Edit → new version</button>
                    <button type="button" onClick={() => void del(p.id)} disabled={busy} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-3)" }}><X size={13} /></button>
                  </div>
                )}
              </div>
              {entries.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "4px 14px", fontSize: 12.5 }}>
                  {entries.map((e) => (<div key={e.key} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px dotted var(--h10-border-subtle)", padding: "2px 0" }}><span style={{ color: "var(--h10-text-3)" }}>{e.key}</span><span style={{ fontWeight: 600, fontFamily: "ui-monospace, monospace" }}>{e.value}</span></div>))}
                </div>
              )}
              {p.fitNotes && <div style={{ fontSize: 12, color: "var(--h10-text-2)", marginTop: 6, fontStyle: "italic" }}>{p.fitNotes}</div>}
              {historyOf === p.id && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--h10-border-subtle)", display: "grid", gap: 4 }}>
                  {g.history.map((h) => (
                    <div key={h.id} style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>v{h.version} · {new Date(h.createdAt).toLocaleDateString()} · {toRows(h.fields).map((e) => `${e.key} ${e.value}`).join(", ") || "—"}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.supersedesId ? "Edit → new version" : "New measurement profile"} size="md"
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{editing?.supersedesId ? "Save new version" : "Create"}</Button></>}>
        {editing && (
          <div style={{ display: "grid", gap: 10 }}>
            {editing.supersedesId && <div style={{ fontSize: 12, color: "var(--h10-text-2)", padding: 8, background: "var(--h10-bg-subtle, rgba(20,28,38,0.03))", borderRadius: 8 }}>This saves a <b>new version</b> — the current one is kept as history, never overwritten.</div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Garment type</div><Input value={editing.garmentType} onChange={(e) => setEditing((s) => s && { ...s, garmentType: e.target.value })} placeholder="Jacket, Trousers…" /></div>
              <div><div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Profile name</div><Input value={editing.name} onChange={(e) => setEditing((s) => s && { ...s, name: e.target.value })} placeholder="Race fit 2026" /></div>
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 4 }}>Measurements</div>
              <div style={{ display: "grid", gap: 6 }}>
                {rows.map((r, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 110px 28px", gap: 6, alignItems: "center" }}>
                    <input value={r.key} onChange={(e) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="Chest, Waist, Sleeve…" style={inp} />
                    <input value={r.value} onChange={(e) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="cm" style={{ ...inp, fontFamily: "ui-monospace, monospace" }} />
                    <button type="button" onClick={() => setRows((xs) => xs.filter((_, j) => j !== i))} style={{ border: "1px solid var(--h10-border)", borderRadius: 7, background: "var(--h10-surface)", cursor: "pointer", height: 30, display: "grid", placeItems: "center", color: "var(--h10-text-3)" }}><X size={13} /></button>
                  </div>
                ))}
                <button type="button" onClick={() => setRows((xs) => [...xs, { key: "", value: "" }])} style={{ justifySelf: "start", background: "none", border: "none", padding: "2px 0", cursor: "pointer", fontSize: 12, color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}><Plus size={12} /> Add measurement</button>
              </div>
            </div>
            <div><div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Fit notes</div><textarea value={editing.fitNotes} onChange={(e) => setEditing((s) => s && { ...s, fitNotes: e.target.value })} rows={2} style={{ ...inp, fontFamily: "inherit" }} placeholder="Prefers a snug chest, longer sleeve…" /></div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
