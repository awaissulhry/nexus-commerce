/**
 * FP2.3 — the Materials registry (catalog-only; lots/ledger/POs stay FP7).
 * Editing a cost surfaces the reprice ripple (how many templates it touches —
 * the Craftybase verdict). Grain-gated cost column.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Card, DataGrid, Listbox, Modal, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { EuroInput } from "./money";
import type { MaterialRow } from "./types";

const UNITS = [
  { value: "SQM", label: "m² (leather)" },
  { value: "HIDE", label: "hide" },
  { value: "PIECE", label: "piece" },
  { value: "M", label: "metre" },
];

export function MaterialsTab() {
  const { toast } = useToast();
  const canManage = usePermission("materials.manage");
  const canCost = usePermission("financials.costs.view");
  const [rows, setRows] = useState<MaterialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("SQM");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await apiJson<{ materials: MaterialRow[] }>("/api/materials")).materials);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      await apiJson("/api/materials", { method: "POST", body: JSON.stringify({ name: name.trim(), unit }) });
      setCreating(false); setName("");
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const editCost = async (m: MaterialRow, costCents: number) => {
    try {
      const res = await apiJson<{ ripple: { templates: number } | null }>(`/api/materials/${m.id}`, { method: "PATCH", body: JSON.stringify({ costCents }) });
      if (res.ripple && res.ripple.templates > 0) {
        toast(`Cost updated — ${res.ripple.templates} template${res.ripple.templates > 1 ? "s" : ""} reprice now; sent quotes are snapshots and never move.`, "info");
      }
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  const remove = async (m: MaterialRow) => {
    try {
      const res = await apiJson<{ archived: boolean; reason?: string }>(`/api/materials/${m.id}`, { method: "DELETE" });
      toast(res.archived ? res.reason ?? "Archived" : "Deleted", res.archived ? "info" : "success");
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  return (
    <Card padded>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Materials</div>
        {canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={13} /> New material</Button>}
      </div>
      <div style={{ fontSize: 12, color: "var(--h10-text-3)", marginBottom: 10 }}>
        Catalog only — leather by hide/m², linings, armor, thread. Lots, the movement ledger, purchase
        orders and stock levels arrive on the full Materials page (FP7). CSV import lands in FP2.5.
      </div>
      {loading ? (
        <div style={{ fontSize: 13, color: "var(--h10-text-3)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: "var(--h10-text-3)" }}>No materials yet.</div>
      ) : (
        <DataGrid
          columns={[
            { key: "name", label: "Material", render: (m: MaterialRow) => <b>{m.name}</b> },
            { key: "unit", label: "Unit", render: (m: MaterialRow) => m.unit },
            ...(canCost ? [{ key: "cost", label: "Cost / unit", render: (m: MaterialRow) => (canManage ? <EuroInput cents={m.costCents} onCommit={(c) => void editCost(m, c)} ariaLabel={`${m.name} cost`} width={78} /> : eur(m.costCents)) }] : []),
            { key: "used", label: "Used by", align: "right" as const, render: (m: MaterialRow) => (m.usedByTemplates > 0 ? <Pill tone="info">{m.usedByTemplates} template{m.usedByTemplates > 1 ? "s" : ""}</Pill> : <span style={{ color: "var(--h10-text-3)" }}>—</span>) },
            { key: "reorder", label: "Reorder at", render: (m: MaterialRow) => (m.reorderLevel != null ? `${m.reorderLevel} ${m.unit}` : "—") },
            ...(canManage ? [{ key: "act", label: "", render: (m: MaterialRow) => <button type="button" onClick={() => void remove(m)} style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", fontSize: 12 }}>Delete</button> }] : []),
          ]}
          rows={rows}
          rowKey={(m: MaterialRow) => m.id}
        />
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New material" size="sm" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!name.trim() || busy}>Create</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <Input placeholder="Name (e.g. Cowhide leather)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Listbox ariaLabel="Unit" options={UNITS} value={unit} onChange={setUnit} />
        </div>
      </Modal>
    </Card>
  );
}
