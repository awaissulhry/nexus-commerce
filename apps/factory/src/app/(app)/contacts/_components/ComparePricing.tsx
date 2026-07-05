/**
 * FP5.4 — side-by-side price comparison (the Owner's must-have). Pick a template,
 * configure options once, and see what every customer would pay + their discount
 * vs the base list. Config toggles mirror the FP2 configurator; the numbers come
 * from /api/contacts/compare (pure engine per party, grain-gated).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Card, DataGrid, Listbox, useToast } from "@/design-system/components";
import { Button, Checkbox, Pill, RadioCard } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";

type TemplateDetail = { id: string; name: string; optionGroups: { id: string; name: string; minSelect: number; maxSelect: number; options: { id: string; name: string }[] }[] };
type CompareRow = { partyId: string; name: string; priceListName: string; netCents?: number; costCents?: number; marginCents?: number; marginPct?: number; discountPct?: number };
type CompareResult = { baseNetCents?: number; rows: CompareRow[]; blocked: boolean };

export function ComparePricing({ onBack }: { onBack: () => void }) {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [selections, setSelections] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CompareResult | null>(null);

  useEffect(() => { apiJson<{ templates: { id: string; name: string }[] }>("/api/products/templates").then((d) => setTemplates(d.templates)).catch(() => {}); }, []);

  const pickTemplate = async (tid: string) => {
    setTemplateId(tid); setResult(null); setDetail(null); setSelections(new Set());
    if (!tid) return;
    try {
      const d = (await apiJson<{ template: TemplateDetail }>(`/api/products/templates/${tid}`)).template;
      setDetail(d);
      // sensible default: first option of each exactly-one group
      const init = new Set<string>();
      for (const g of d.optionGroups) if (g.minSelect === 1 && g.maxSelect === 1 && g.options[0]) init.add(g.options[0].id);
      setSelections(init);
    } catch (e) { toast((e as Error).message, "danger"); }
  };

  const toggle = (group: TemplateDetail["optionGroups"][number], optionId: string) => {
    setSelections((prev) => {
      const next = new Set(prev);
      if (group.maxSelect === 1) { group.options.forEach((o) => next.delete(o.id)); next.add(optionId); }
      else { next.has(optionId) ? next.delete(optionId) : next.add(optionId); }
      return next;
    });
  };

  const compare = useCallback(async () => {
    if (!templateId) return;
    try { setResult(await apiJson<CompareResult>("/api/contacts/compare", { method: "POST", body: JSON.stringify({ templateId, selections: [...selections] }) })); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [templateId, selections, toast]);
  useEffect(() => { if (templateId) void compare(); }, [compare, templateId]);

  const rowsSorted = (result?.rows ?? []).slice().sort((a, b) => (a.netCents ?? 0) - (b.netCents ?? 0));

  return (
    <div className="factory-page--centered">
      <DetailHeader backLabel="All contacts" onBack={onBack} title="Compare pricing" />
      <div style={{ fontSize: 12.5, color: "var(--h10-text-3)", marginBottom: 12 }}>Pick a product, configure it once, and see what each customer would pay — and their discount vs the base list.</div>

      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <Card padded>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Product</div>
          <Listbox ariaLabel="Template" options={[{ value: "", label: "Choose a product…" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} value={templateId} onChange={(v) => void pickTemplate(v)} />
          {detail && (
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {detail.optionGroups.map((g) => (
                <div key={g.id}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>{g.name} <span style={{ fontWeight: 400, color: "var(--h10-text-3)" }}>· pick {g.minSelect}–{g.maxSelect}</span></div>
                  <div style={{ display: "grid", gap: 5 }}>
                    {g.options.map((o) => g.maxSelect === 1 ? (
                      <RadioCard key={o.id} name={g.id} checked={selections.has(o.id)} selected={selections.has(o.id)} onChange={() => toggle(g, o.id)} title={o.name} />
                    ) : (
                      <label key={o.id} style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12.5, cursor: "pointer" }}><Checkbox checked={selections.has(o.id)} onChange={() => toggle(g, o.id)} aria-label={o.name} />{o.name}</label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card padded>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>What each customer pays</div>
            {result?.baseNetCents != null && <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>Listino base: <b style={{ fontFamily: "ui-monospace, monospace", color: "var(--h10-text)" }}>{eur(result.baseNetCents)}</b></div>}
          </div>
          {!templateId ? (
            <div style={{ fontSize: 12.5, color: "var(--h10-text-3)", padding: "16px 2px" }}>Choose a product to compare.</div>
          ) : result?.blocked ? (
            <div style={{ fontSize: 12.5, color: "var(--h10-warning, #9a6700)", padding: 10, background: "var(--h10-wash-warning, #fdf3d3)", borderRadius: 8 }}>This configuration has an unmet requirement — adjust the options.</div>
          ) : rowsSorted.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--h10-text-3)", padding: "16px 2px" }}>No customers yet — add a customer contact to compare.</div>
          ) : (
            <DataGrid
              columns={[
                { key: "name", label: "Customer", render: (r: CompareRow) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
                { key: "list", label: "Price list", render: (r: CompareRow) => r.priceListName },
                { key: "net", label: "Net", align: "right" as const, render: (r: CompareRow) => (r.netCents != null ? <b style={{ fontFamily: "ui-monospace, monospace" }}>{eur(r.netCents)}</b> : "—") },
                { key: "disc", label: "vs base", align: "right" as const, render: (r: CompareRow) => (r.discountPct == null ? "—" : Math.abs(r.discountPct) < 0.05 ? <span style={{ color: "var(--h10-text-3)" }}>—</span> : <Pill tone={r.discountPct > 0 ? "success" : "danger"}>{r.discountPct > 0 ? "-" : "+"}{Math.abs(r.discountPct).toFixed(1)}%</Pill>) },
                ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: CompareRow) => (r.marginCents != null ? <Pill tone={r.marginCents < 0 ? "danger" : "success"}>{(r.marginPct ?? 0).toFixed(0)}%</Pill> : "—") }] : []),
              ]}
              rows={rowsSorted}
              rowKey={(r: CompareRow) => r.partyId}
              emptyState="No customers to compare."
            />
          )}
        </Card>
      </div>
      <div style={{ marginTop: 14 }}><Button onClick={onBack}><ArrowLeft size={13} /> Back to contacts</Button></div>
    </div>
  );
}
