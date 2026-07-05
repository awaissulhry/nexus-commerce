/**
 * FP2.3 — Bill of materials: the base BOM (materials every unit needs) as a
 * replace-set, plus per-option draws (kangaroo consumes different hides than
 * cowhide — the Genius spec-artifact→BOM verdict). These lines are exactly what
 * the engine merges into the composed material list, and later what a Work
 * Order reserves.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { Listbox } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import type { MaterialRow, Option, TemplateDetail } from "./types";

type BaseLine = { materialId: string; qty: number };

export function BomEditor({ template, onChanged }: { template: TemplateDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [base, setBase] = useState<BaseLine[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<{ materials: MaterialRow[] }>("/api/materials").then((d) => setMaterials(d.materials)).catch(() => {});
  }, []);
  useEffect(() => {
    setBase(template.bomLines.filter((l) => !l.perOption).map((l) => ({ materialId: l.materialId, qty: l.qty })));
  }, [template.bomLines]);

  const unitOf = useCallback((id: string) => materials.find((m) => m.id === id)?.unit ?? "", [materials]);
  const options = template.optionGroups.flatMap((g) => g.options.map((o) => ({ group: g.name, o })));

  const saveBase = async (lines: BaseLine[]) => {
    setBusy(true);
    try {
      const valid = lines.filter((l) => l.materialId && l.qty > 0).map((l) => ({ materialId: l.materialId, qty: l.qty, unit: unitOf(l.materialId) }));
      await apiJson(`/api/products/templates/${template.id}/bom`, { method: "PUT", body: JSON.stringify({ lines: valid }) });
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const saveDraws = async (opt: Option, draws: { materialId: string; qty: number; unit: string }[]) => {
    setBusy(true);
    try {
      await apiJson(`/api/products/options/${opt.id}`, { method: "PATCH", body: JSON.stringify({ materialDraws: draws.length ? draws : null }) });
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  if (materials.length === 0) {
    return <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>Add materials in the <b>Materials</b> tab first — BOM lines point at them.</div>;
  }
  const matOptions = [{ value: "", label: "Choose material…" }, ...materials.map((m) => ({ value: m.id, label: `${m.name} (${m.unit})` }))];

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>Base BOM</div>
        <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 8 }}>Materials every unit needs, whatever options are chosen.</div>
        <div style={{ display: "grid", gap: 6 }}>
          {base.map((line, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Listbox ariaLabel="Material" options={matOptions} value={line.materialId} onChange={(v) => setBase((b) => b.map((x, j) => (j === i ? { ...x, materialId: v } : x)))} />
              <input type="number" step="0.01" min="0" value={line.qty} onChange={(e) => setBase((b) => b.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} style={numStyle} aria-label="Quantity" />
              <span style={{ fontSize: 12, color: "var(--h10-text-3)", width: 40 }}>{unitOf(line.materialId)}</span>
              <button type="button" onClick={() => setBase((b) => b.filter((_, j) => j !== i))} style={delBtn}><Trash2 size={13} /></button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => setBase((b) => [...b, { materialId: "", qty: 1 }])}><Plus size={12} /> line</Button>
            <Button variant="primary" onClick={() => void saveBase(base)} disabled={busy}>Save base BOM</Button>
          </div>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>Per-option draws</div>
        <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 8 }}>Extra materials a specific option consumes (e.g. Kangaroo → kangaroo hide). Saved per option.</div>
        <div style={{ display: "grid", gap: 8 }}>
          {options.map(({ group, o }) => (
            <OptionDraws key={o.id} label={`${group}: ${o.name}`} option={o} matOptions={matOptions} unitOf={unitOf} onSave={(draws) => saveDraws(o, draws)} busy={busy} />
          ))}
        </div>
      </section>
    </div>
  );
}

function OptionDraws({ label, option, matOptions, unitOf, onSave, busy }: {
  label: string;
  option: Option;
  matOptions: { value: string; label: string }[];
  unitOf: (id: string) => string;
  onSave: (draws: { materialId: string; qty: number; unit: string }[]) => void;
  busy: boolean;
}) {
  const [draws, setDraws] = useState<{ materialId: string; qty: number }[]>(option.materialDraws?.map((d) => ({ materialId: d.materialId, qty: d.qty })) ?? []);
  const dirty = JSON.stringify(draws) !== JSON.stringify(option.materialDraws?.map((d) => ({ materialId: d.materialId, qty: d.qty })) ?? []);

  return (
    <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: draws.length ? 6 : 0 }}>
        <b style={{ fontSize: 12.5, flex: 1 }}>{label}</b>
        {draws.length === 0 && <button type="button" onClick={() => setDraws([{ materialId: "", qty: 1 }])} style={addSmall}><Plus size={11} /> draw</button>}
      </div>
      {draws.map((d, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
          <Listbox ariaLabel="Material" options={matOptions} value={d.materialId} onChange={(v) => setDraws((x) => x.map((y, j) => (j === i ? { ...y, materialId: v } : y)))} />
          <input type="number" step="0.01" min="0" value={d.qty} onChange={(e) => setDraws((x) => x.map((y, j) => (j === i ? { ...y, qty: Number(e.target.value) } : y)))} style={numStyle} aria-label="Quantity" />
          <span style={{ fontSize: 12, color: "var(--h10-text-3)", width: 40 }}>{unitOf(d.materialId)}</span>
          <button type="button" onClick={() => setDraws((x) => x.filter((_, j) => j !== i))} style={delBtn}><Trash2 size={12} /></button>
        </div>
      ))}
      {draws.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button type="button" onClick={() => setDraws((x) => [...x, { materialId: "", qty: 1 }])} style={addSmall}><Plus size={11} /> draw</button>
          {dirty && <Button size="sm" variant="primary" onClick={() => onSave(draws.filter((d) => d.materialId && d.qty > 0).map((d) => ({ ...d, unit: unitOf(d.materialId) })))} disabled={busy}>Save</Button>}
        </div>
      )}
    </div>
  );
}

const numStyle: React.CSSProperties = { width: 70, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "4px 6px", font: "12.5px var(--font-mono), monospace", textAlign: "right", background: "var(--h10-surface)", color: "var(--h10-text)" };
const delBtn: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", color: "var(--h10-danger)", display: "inline-flex", padding: 2 };
const addSmall: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, border: "1px dashed var(--h10-border)", borderRadius: 6, background: "none", cursor: "pointer", fontSize: 11, padding: "2px 7px", color: "var(--h10-text-2)" };
