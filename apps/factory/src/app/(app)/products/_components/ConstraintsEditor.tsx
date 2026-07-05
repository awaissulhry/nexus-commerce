/**
 * FP2.2 — the Constraints tab: rules rendered as sentences ("Perforated panels
 * EXCLUDES Waterproof liner — blocks") with a builder. ONE table, one engine
 * (BEAT verdict on Salesforce's two overlapping rule engines).
 */
"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { Listbox } from "@/design-system/components";
import { apiFetch, apiJson } from "@/lib/api-client";
import { optionLabel, type TemplateDetail } from "./types";

export function ConstraintsEditor({ template, onChanged }: { template: TemplateDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<"REQUIRES" | "EXCLUDES">("EXCLUDES");
  const [severity, setSeverity] = useState<"BLOCK" | "WARN">("BLOCK");
  const [ifOpt, setIfOpt] = useState("");
  const [thenOpt, setThenOpt] = useState("");
  const [message, setMessage] = useState("");

  const allOptions = template.optionGroups.flatMap((g) => g.options.map((o) => ({ value: o.id, label: `${g.name}: ${o.name}` })));

  const call = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      after?.();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (!ifOpt || !thenOpt || !message.trim()) return;
    void call(
      () => apiJson(`/api/products/templates/${template.id}/constraints`, { method: "POST", body: JSON.stringify({ type, severity, ifOptionId: ifOpt, thenOptionId: thenOpt, message: message.trim() }) }),
      () => { setAdding(false); setIfOpt(""); setThenOpt(""); setMessage(""); },
    );
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 12, color: "var(--h10-text-2)" }}>
        Constraints keep impossible combinations from being quoted. <b>Blocks</b> stop a quote; <b>Warns</b> only flag.
      </div>
      {template.constraints.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No constraints yet.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {template.constraints.map((c) => (
          <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "7px 10px", fontSize: 12.5 }}>
            <b>{optionLabel(template.optionGroups, c.ifOptionId)}</b>
            <Pill tone={c.type === "EXCLUDES" ? "danger" : "info"}>{c.type}</Pill>
            <b>{optionLabel(template.optionGroups, c.thenOptionId)}</b>
            <Pill tone={c.severity === "BLOCK" ? "warning" : "neutral"}>{c.severity === "BLOCK" ? "blocks" : "warns"}</Pill>
            <span style={{ color: "var(--h10-text-2)", flex: 1 }}>“{c.message}”</span>
            <button type="button" disabled={busy} title="Delete" onClick={() => call(() => apiFetch(`/api/products/constraints/${c.id}`, { method: "DELETE" }))} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--h10-danger)", display: "inline-flex", padding: 2 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <div style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 12, display: "grid", gap: 8, background: "var(--h10-surface-raised)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Listbox ariaLabel="If option" options={[{ value: "", label: "If option…" }, ...allOptions]} value={ifOpt} onChange={setIfOpt} />
            <Listbox ariaLabel="Type" options={[{ value: "EXCLUDES", label: "excludes" }, { value: "REQUIRES", label: "requires" }]} value={type} onChange={(v) => setType(v as "REQUIRES" | "EXCLUDES")} />
            <Listbox ariaLabel="Then option" options={[{ value: "", label: "then option…" }, ...allOptions]} value={thenOpt} onChange={setThenOpt} />
            <Listbox ariaLabel="Severity" options={[{ value: "BLOCK", label: "blocks the quote" }, { value: "WARN", label: "warns only" }]} value={severity} onChange={(v) => setSeverity(v as "BLOCK" | "WARN")} />
          </div>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Explanation shown when this fires (e.g. 'Perforated panels can't take a waterproof liner')"
            style={{ border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 9px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" onClick={create} disabled={busy || !ifOpt || !thenOpt || !message.trim() || ifOpt === thenOpt}>Add constraint</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button onClick={() => setAdding(true)} disabled={allOptions.length < 2}>
            <Plus size={13} /> Add constraint
          </Button>
          {allOptions.length < 2 && <span style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginLeft: 8 }}>Add at least two options first.</span>}
        </div>
      )}
    </div>
  );
}
