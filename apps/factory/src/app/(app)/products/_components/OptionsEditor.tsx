/**
 * FP2.2 — the Options tab: option groups (min/max), each holding options with
 * cost + price deltas (€ or %). CPQ bundle→features→options, made native and
 * margin-live. Reorder via ↑/↓ (persisted through /api/products/reorder —
 * deterministic and keyboard-accessible; drag flourish deferred, see report).
 * Cost fields are grain-gated so a future non-cost role never sees them.
 */
"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, Upload } from "lucide-react";
import { useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { DeltaInput } from "./money";
import { CsvImportModal } from "./CsvImportModal";
import type { Group, Option, TemplateDetail } from "./types";

function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const copy = [...arr];
  const [m] = copy.splice(from, 1);
  copy.splice(to, 0, m);
  return copy;
}

export function OptionsEditor({ template, baseCostCents, basePriceCents, onChanged }: { template: TemplateDetail; baseCostCents: number; basePriceCents: number; onChanged: () => void }) {
  const { toast } = useToast();
  const canCost = usePermission("financials.costs.view");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const groups = template.optionGroups;

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const addGroup = () =>
    call(() => apiJson(`/api/products/templates/${template.id}/groups`, { method: "POST", body: JSON.stringify({ name: "New group", minSelect: 0, maxSelect: 1 }) }));
  const patchGroup = (gid: string, data: Partial<Group>) =>
    call(() => apiJson(`/api/products/groups/${gid}`, { method: "PATCH", body: JSON.stringify(data) }));
  const deleteGroup = (gid: string) =>
    call(() => apiFetch(`/api/products/groups/${gid}`, { method: "DELETE" }));
  const addOption = (gid: string) =>
    call(() => apiJson(`/api/products/groups/${gid}/options`, { method: "POST", body: JSON.stringify({ name: "New option" }) }));
  const patchOption = (oid: string, data: Partial<Option>) =>
    call(() => apiJson(`/api/products/options/${oid}`, { method: "PATCH", body: JSON.stringify(data) }));
  const deleteOption = (oid: string) =>
    call(() => apiFetch(`/api/products/options/${oid}`, { method: "DELETE" }));
  const persistOrder = (kind: "group" | "option", ids: string[]) =>
    call(() => apiJson("/api/products/reorder", { method: "POST", body: JSON.stringify({ kind, ids }) }));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {groups.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--h10-text-3)", padding: "8px 0" }}>
          No option groups yet. A group is a decision the customer makes (Leather type, Lining, Armor…).
        </div>
      )}
      {groups.map((g, gi) => (
        <div key={g.id} style={{ border: "1px solid var(--h10-border)", borderRadius: 10, background: "var(--h10-surface)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--h10-border-subtle)", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", flexDirection: "column" }}>
              <button type="button" disabled={busy || gi === 0} title="Move group up" onClick={() => persistOrder("group", reorder(groups, gi, gi - 1).map((x) => x.id))} style={arrowBtn}>
                <ChevronUp size={12} />
              </button>
              <button type="button" disabled={busy || gi === groups.length - 1} title="Move group down" onClick={() => persistOrder("group", reorder(groups, gi, gi + 1).map((x) => x.id))} style={arrowBtn}>
                <ChevronDown size={12} />
              </button>
            </span>
            <input
              defaultValue={g.name}
              key={g.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== g.name && patchGroup(g.id, { name: e.target.value.trim() })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              style={{ fontSize: 13.5, fontWeight: 700, border: "none", outline: "none", background: "transparent", color: "var(--h10-text)", minWidth: 140, flex: 1 }}
            />
            <label style={miniLabel}>
              min
              <input type="number" min={0} defaultValue={g.minSelect} key={`min${g.minSelect}`} onBlur={(e) => Number(e.target.value) !== g.minSelect && patchGroup(g.id, { minSelect: Math.max(0, Number(e.target.value)) })} style={miniNum} />
            </label>
            <label style={miniLabel}>
              max
              <input type="number" min={1} defaultValue={g.maxSelect} key={`max${g.maxSelect}`} onBlur={(e) => Number(e.target.value) !== g.maxSelect && patchGroup(g.id, { maxSelect: Math.max(1, Number(e.target.value)) })} style={miniNum} />
            </label>
            <button type="button" disabled={busy} title="Delete group" onClick={() => deleteGroup(g.id)} style={{ ...iconBtn, color: "var(--h10-danger)" }}>
              <Trash2 size={13} />
            </button>
          </div>

          <div style={{ padding: "6px 12px", display: "grid", gap: 4 }}>
            {g.options.length === 0 && <div style={{ fontSize: 12, color: "var(--h10-text-3)", padding: "4px 0" }}>No options yet.</div>}
            {g.options.map((o, oi) => (
              <div key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "3px 0" }}>
                <span style={{ display: "inline-flex", flexDirection: "column" }}>
                  <button type="button" disabled={busy || oi === 0} title="Move up" onClick={() => persistOrder("option", reorder(g.options, oi, oi - 1).map((x) => x.id))} style={arrowBtn}><ChevronUp size={11} /></button>
                  <button type="button" disabled={busy || oi === g.options.length - 1} title="Move down" onClick={() => persistOrder("option", reorder(g.options, oi, oi + 1).map((x) => x.id))} style={arrowBtn}><ChevronDown size={11} /></button>
                </span>
                <input
                  defaultValue={o.name}
                  key={o.name}
                  onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && patchOption(o.id, { name: e.target.value.trim() })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  style={{ fontSize: 12.5, border: "1px solid var(--h10-border-subtle)", borderRadius: 7, padding: "3px 7px", outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)", minWidth: 150, flex: 1 }}
                />
                <span style={{ fontSize: 10.5, color: "var(--h10-text-3)", width: 30, textAlign: "right" }}>price</span>
                <DeltaInput
                  mode={o.priceDeltaMode}
                  value={o.priceDelta}
                  baseCents={basePriceCents}
                  ariaLabel={`${o.name} price delta`}
                  onChange={(next) => patchOption(o.id, { priceDeltaMode: next.mode, priceDelta: next.value })}
                />
                {canCost && (
                  <>
                    <span style={{ fontSize: 10.5, color: "var(--h10-text-3)", width: 24, textAlign: "right" }}>cost</span>
                    <DeltaInput
                      mode={o.costDeltaMode}
                      value={o.costDelta}
                      baseCents={baseCostCents}
                      ariaLabel={`${o.name} cost delta`}
                      onChange={(next) => patchOption(o.id, { costDeltaMode: next.mode, costDelta: next.value })}
                    />
                  </>
                )}
                {(o.materialDraws?.length ?? 0) > 0 && <Pill tone="info">{o.materialDraws!.length} draw{o.materialDraws!.length > 1 ? "s" : ""}</Pill>}
                <button type="button" disabled={busy} title="Delete option" onClick={() => deleteOption(o.id)} style={{ ...iconBtn, color: "var(--h10-danger)" }}><Trash2 size={12} /></button>
              </div>
            ))}
            <div>
              <button type="button" disabled={busy} onClick={() => addOption(g.id)} style={addBtn}><Plus size={12} /> option</button>
            </div>
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={addGroup} disabled={busy}><Plus size={13} /> Add group</Button>
        <Button onClick={() => setImporting(true)} disabled={busy}><Upload size={13} /> Import options CSV</Button>
      </div>
      <CsvImportModal
        open={importing}
        onClose={() => setImporting(false)}
        title={`Import options into ${template.name}`}
        endpoint="/api/imports/options"
        templateUrl="/api/imports/options/template"
        columnsHelp="group, min, max, option, price_delta, price_mode (ABSOLUTE|PERCENT), cost_delta, cost_mode"
        extraBody={{ templateId: template.id }}
        onApplied={onChanged}
      />
    </div>
  );
}

const arrowBtn: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", color: "var(--h10-text-3)", padding: 0, lineHeight: 0.7, display: "block" };
const iconBtn: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", padding: 3, display: "inline-flex" };
const addBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, border: "1px dashed var(--h10-border)", borderRadius: 7, background: "none", cursor: "pointer", fontSize: 11.5, padding: "3px 9px", color: "var(--h10-text-2)" };
const miniLabel: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--h10-text-3)" };
const miniNum: React.CSSProperties = { width: 40, border: "1px solid var(--h10-border-subtle)", borderRadius: 6, padding: "2px 4px", font: "12px var(--font-mono), monospace", textAlign: "center", background: "var(--h10-surface)", color: "var(--h10-text)" };
