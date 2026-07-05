/**
 * FP2.4 — preview-as-configurator: pick a party's list, toggle options, and
 * watch the 4-line waterfall (Cost → List → Adjustment → Net), live margin,
 * composed materials, constraint messages, per-line price source ('why this
 * price') and two-way goal-seek — all server-composed through the FP2.1 engine
 * and grain-stripped. FP3's dress rehearsal.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/design-system/components";
import { Listbox } from "@/design-system/components";
import { Pill, RadioCard, Checkbox } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import type { TemplateDetail } from "./types";

type Line = { kind: "base" | "option"; label: string; optionId?: string; priceCents?: number; costCents?: number; source: string; priceMode?: string; priceRawDelta?: number };
type PreviewResult = {
  resolvedBaseCents?: number;
  listPriceCents?: number;
  costCents?: number;
  adjustmentCents?: number;
  appliedAdjustmentCents?: number;
  netPriceCents?: number;
  marginCents?: number;
  marginPct?: number;
  marginNegative?: boolean;
  lines: Line[];
  materials: { materialId: string; qty: number; unit: string; name: string }[];
  violations: { kind: string; severity: string; message: string }[];
  hasBlockingViolation?: boolean;
};

const SOURCE_LABEL: Record<string, string> = {
  "template-base": "template base",
  "list-base": "price-list base override",
  option: "option default",
  "list-option": "price-list option override",
};

export function PreviewPanel({ template }: { template: TemplateDetail }) {
  const [lists, setLists] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [listId, setListId] = useState<string>(""); // "" = Listino base (null)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [goalNet, setGoalNet] = useState("");
  const [goalMargin, setGoalMargin] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiJson<{ lists: { id: string; name: string; kind: string }[] }>("/api/pricelists").then((d) => setLists(d.lists)).catch(() => {});
  }, []);

  const compose = useCallback(
    async (goalSeek?: { by: "net" | "margin"; value: number }) => {
      try {
        const r = await apiJson<PreviewResult>("/api/products/preview", {
          method: "POST",
          body: JSON.stringify({ templateId: template.id, selectedOptionIds: [...selected], priceListId: listId || null, goalSeek: goalSeek ?? null }),
        });
        setResult(r);
      } catch {
        setResult(null);
      }
    },
    [template.id, selected, listId],
  );

  // recompose (debounced) on any selection/list change, clearing goal-seek
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void compose(), 150);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [compose]);

  const toggle = (groupMaxOne: boolean, groupOptionIds: string[], id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (groupMaxOne) {
        for (const oid of groupOptionIds) next.delete(oid);
        if (!prev.has(id)) next.add(id);
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      return next;
    });
    setGoalNet(""); setGoalMargin("");
  };

  const hasCost = result?.costCents != null;
  const hasMargin = result?.marginCents != null;
  const sourceById = useMemo(() => Object.fromEntries((result?.lines ?? []).filter((l) => l.optionId).map((l) => [l.optionId!, l.source])), [result]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16 }}>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--h10-text-2)" }}>Price list:</span>
          <Listbox
            ariaLabel="Price list"
            options={[{ value: "", label: "Listino base (default)" }, ...lists.filter((l) => l.kind !== "DEFAULT").map((l) => ({ value: l.id, label: l.name }))]}
            value={listId}
            onChange={setListId}
          />
        </div>
        {template.optionGroups.length === 0 && <div style={{ fontSize: 13, color: "var(--h10-text-3)" }}>Add option groups first.</div>}
        {template.optionGroups.map((g) => {
          const maxOne = g.maxSelect === 1;
          const ids = g.options.map((o) => o.id);
          return (
            <div key={g.id}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>
                {g.name} <span style={{ fontWeight: 400, color: "var(--h10-text-3)" }}>· pick {g.minSelect}–{g.maxSelect}</span>
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {g.options.map((o) =>
                  maxOne ? (
                    <RadioCard key={o.id} name={g.id} checked={selected.has(o.id)} selected={selected.has(o.id)} onChange={() => toggle(true, ids, o.id)} title={<OptLabel name={o.name} source={sourceById[o.id]} />} />
                  ) : (
                    <label key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, cursor: "pointer" }}>
                      <Checkbox checked={selected.has(o.id)} onChange={() => toggle(false, ids, o.id)} aria-label={o.name} />
                      <OptLabel name={o.name} source={sourceById[o.id]} />
                    </label>
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
        {result?.violations?.filter((v) => v.severity === "BLOCK").map((v, i) => (
          <Banner key={i} tone="danger" title="Can't be quoted">{v.message}</Banner>
        ))}
        {result?.violations?.filter((v) => v.severity === "WARN").map((v, i) => (
          <Banner key={`w${i}`} tone="warning" title="Heads up">{v.message}</Banner>
        ))}

        <div style={{ border: "1px solid var(--h10-border)", borderRadius: 12, background: "var(--h10-surface)", padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--h10-text-3)", marginBottom: 8 }}>Price waterfall</div>
          {hasCost && <WaterRow label="Cost" value={eur(result!.costCents!)} muted />}
          <WaterRow label="List price" value={result ? eur(result.listPriceCents!) : "—"} />
          <WaterRow label="Adjustment" value={result ? eur(result.appliedAdjustmentCents ?? result.adjustmentCents ?? 0) : "—"} muted />
          <div style={{ borderTop: "1px solid var(--h10-border-subtle)", margin: "6px 0" }} />
          <WaterRow label="Net price" value={result ? eur(result.netPriceCents!) : "—"} strong />
          {hasMargin && (
            <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--h10-text-2)" }}>Margin</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: result!.marginNegative ? "var(--h10-danger)" : "var(--h10-success, #15a34a)" }}>
                {eur(result!.marginCents!)} · {result!.marginPct!.toFixed(1)}%
              </span>
            </div>
          )}
        </div>

        {hasMargin && (
          <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)" }}>Goal-seek</div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              Target net €
              <input type="number" step="0.01" value={goalNet} placeholder="—" onChange={(e) => { setGoalNet(e.target.value); setGoalMargin(""); }} onBlur={(e) => e.target.value && void compose({ by: "net", value: Math.round(parseFloat(e.target.value) * 100) })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} style={gsInput} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              Target margin %
              <input type="number" step="0.1" value={goalMargin} placeholder="—" onChange={(e) => { setGoalMargin(e.target.value); setGoalNet(""); }} onBlur={(e) => e.target.value && void compose({ by: "margin", value: parseFloat(e.target.value) })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} style={gsInput} />
            </label>
            <span style={{ fontSize: 10.5, color: "var(--h10-text-3)" }}>Sets the quote adjustment to hit your target; the waterfall updates.</span>
          </div>
        )}

        {result && result.materials.length > 0 && (
          <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)", marginBottom: 6 }}>Materials consumed</div>
            {result.materials.map((m) => (
              <div key={`${m.materialId}:${m.unit}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                <span>{m.name}</span>
                <span style={{ color: "var(--h10-text-2)", fontFamily: "var(--font-mono)" }}>{m.qty} {m.unit}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OptLabel({ name, source }: { name: string; source?: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {name}
      {source && <Pill tone={source.startsWith("list") ? "info" : "neutral"} >{SOURCE_LABEL[source] ?? source}</Pill>}
    </span>
  );
}

function WaterRow({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "2px 0" }}>
      <span style={{ fontSize: 12, color: muted ? "var(--h10-text-3)" : "var(--h10-text-2)" }}>{label}</span>
      <span style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 800 : 600, fontFamily: "var(--font-mono)", color: "var(--h10-text)" }}>{value}</span>
    </div>
  );
}

const gsInput: React.CSSProperties = { marginLeft: "auto", width: 90, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "4px 6px", font: "12.5px var(--font-mono), monospace", textAlign: "right", background: "var(--h10-surface)", color: "var(--h10-text)" };
