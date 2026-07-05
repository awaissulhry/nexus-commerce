/**
 * FP3 — the configurator that WRITES a quote. Same live-margin feel as the FP2
 * preview, but every change PATCHes the line so the server (the only price
 * authority) re-persists the composed money. Left: lines + option toggles;
 * right rail: waterfall, margin, goal-seek, deposit/dates, versions, actions.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileDown, Plus, Send, Trash2 } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Banner, Card, DateField, Listbox, useToast } from "@/design-system/components";
import { Button, Checkbox, Pill, RadioCard } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { EuroInput } from "@/app/(app)/products/_components/money";
import type { TemplateDetail } from "@/app/(app)/products/_components/types";
import { SendModal } from "./SendModal";
import { ConvertBar } from "./ConvertBar";
import { STATE_TONE, type ComposeResult, type QuoteDetail } from "./types";

const isoDate = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export function QuoteEditor({ quoteId, onBack }: { quoteId: string; onBack: () => void }) {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const canCost = usePermission("financials.costs.view");
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [totals, setTotals] = useState<{ netCents: number; costCents: number; marginCents: number; marginPct: number } | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [tplCache, setTplCache] = useState<Record<string, TemplateDetail>>({});
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [sending, setSending] = useState(false);
  const [floorPct, setFloorPct] = useState(20);
  const [similar, setSimilar] = useState<{ id: string; number: string; partyName: string; state: string; netCents: number; marginPct: number }[]>([]);

  const load = useCallback(async () => {
    const [d, t, s] = await Promise.all([
      apiJson<{ quote: QuoteDetail; totals: typeof totals }>(`/api/quotes/${quoteId}`),
      apiJson<{ templates: { id: string; name: string }[] }>("/api/products/templates"),
      apiJson<{ marginFloorPct: number }>("/api/settings/pricing-defaults").catch(() => ({ marginFloorPct: 20 })),
    ]);
    setQuote(d.quote);
    setTotals(d.totals);
    setTemplates(t.templates);
    setFloorPct(s.marginFloorPct ?? 20);
    setActiveLineId((prev) => prev ?? d.quote.lines[0]?.id ?? null);
  }, [quoteId]);
  useEffect(() => { void load(); }, [load]);

  const fetchTemplate = useCallback(async (tid: string) => {
    if (tplCache[tid]) return tplCache[tid];
    const d = await apiJson<{ template: TemplateDetail }>(`/api/products/templates/${tid}`);
    setTplCache((c) => ({ ...c, [tid]: d.template }));
    return d.template;
  }, [tplCache]);

  const activeLine = quote?.lines.find((l) => l.id === activeLineId) ?? null;
  const isDraft = quote?.state === "DRAFT";

  useEffect(() => {
    if (!quote) return;
    const tid = quote.lines.find((l) => l.templateId)?.templateId;
    const usp = new URLSearchParams({ partyId: quote.party.id, excludeId: quote.id });
    if (tid) usp.set("templateId", tid);
    apiJson<{ quotes: typeof similar }>(`/api/quotes/similar?${usp}`).then((d) => setSimilar(d.quotes)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, quote?.lines.length]);

  // compose the active line for the rail (read-only preview so it works on sent quotes too)
  const refreshRail = useCallback(async (templateId: string | null, selections: string[], adjustmentCents: number) => {
    if (!templateId || !quote) { setResult(null); return; }
    try {
      const r = await apiJson<ComposeResult>("/api/products/preview", { method: "POST", body: JSON.stringify({ templateId, selectedOptionIds: selections, priceListId: quote.party.priceListId, adjustmentCents }) });
      setResult(r);
    } catch { setResult(null); }
  }, [quote]);

  useEffect(() => {
    if (activeLine?.templateId) { void fetchTemplate(activeLine.templateId); void refreshRail(activeLine.templateId, activeLine.selections ?? [], activeLine.adjustmentCents); }
    else setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLineId, activeLine?.templateId]);

  const patchLine = async (data: Record<string, unknown>) => {
    if (!activeLine) return;
    try {
      const res = await apiJson<{ result: ComposeResult | null }>(`/api/quotes/lines/${activeLine.id}`, { method: "PATCH", body: JSON.stringify(data) });
      if (res.result) setResult(res.result);
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  const patchQuote = async (data: Record<string, unknown>) => {
    try { await apiJson(`/api/quotes/${quoteId}`, { method: "PATCH", body: JSON.stringify(data) }); await load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };

  const addLine = async () => {
    try { const d = await apiJson<{ line: { id: string } }>(`/api/quotes/${quoteId}/lines`, { method: "POST", body: JSON.stringify({}) }); await load(); setActiveLineId(d.line.id); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const deleteLine = async (lid: string) => {
    try { await apiFetch(`/api/quotes/lines/${lid}`, { method: "DELETE" }); setActiveLineId(null); await load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };

  const tpl = activeLine?.templateId ? tplCache[activeLine.templateId] : null;
  const selected = useMemo(() => new Set(activeLine?.selections ?? []), [activeLine?.selections]);

  const toggleOption = (maxOne: boolean, groupIds: string[], id: string) => {
    const next = new Set(selected);
    if (maxOne) { for (const g of groupIds) next.delete(g); if (!selected.has(id)) next.add(id); }
    else { next.has(id) ? next.delete(id) : next.add(id); }
    void patchLine({ selections: [...next] });
  };

  if (!quote) return <Card padded><Button onClick={onBack}><ArrowLeft size={13} /> Back</Button></Card>;

  const blocked = quote.lines.some((l) => l.templateId && !l.netPriceCents && (l.selections?.length ?? 0) === 0) || (result?.hasBlockingViolation ?? false);
  const belowFloor = canMargin && totals != null && totals.netCents > 0 && totals.marginPct < floorPct;

  return (
    <div className="factory-page--centered">
      <DetailHeader
        backLabel="All quotes"
        onBack={onBack}
        title={<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>{quote.number}<Pill tone={STATE_TONE[quote.state]}>{quote.state}</Pill>{quote.convertedOrderId && <Pill tone="success">converted</Pill>}</span>}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a href={`/api/quotes/${quoteId}/pdf`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}><FileDown size={13} /> PDF</a>
            {quote.state === "SENT" && <Button onClick={() => patchQuote({ state: "DRAFT" })}>Revise</Button>}
            {(quote.state === "DRAFT" || quote.state === "SENT") && <Button variant="primary" onClick={() => setSending(true)} disabled={quote.lines.length === 0}><Send size={13} /> Send</Button>}
          </div>
        }
      />
      <div style={{ fontSize: 12, color: "var(--h10-text-3)", marginBottom: 10 }}>
        {quote.party.name}{quote.conversation ? ` · from thread “${quote.conversation.subject ?? ""}”` : ""}{quote.party.priceList ? ` · list: ${quote.party.priceList.name}` : " · Listino base"}
      </div>

      <ConvertBar quote={quote} onChanged={load} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 16 }}>
        <Card padded>
          {/* line tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            {quote.lines.map((l, i) => (
              <button key={l.id} type="button" onClick={() => setActiveLineId(l.id)} style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", background: l.id === activeLineId ? "var(--h10-wash-primary)" : "var(--h10-surface)", color: l.id === activeLineId ? "var(--h10-primary)" : "var(--h10-text-2)" }}>
                {l.template?.name ?? `Line ${i + 1}`}
              </button>
            ))}
            {isDraft && <Button onClick={addLine}><Plus size={12} /> line</Button>}
          </div>

          {!activeLine ? (
            <div style={{ fontSize: 13, color: "var(--h10-text-3)" }}>{quote.lines.length === 0 ? "Add a line to start configuring." : "Select a line."}</div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--h10-text-2)" }}>Product:</span>
                <Listbox ariaLabel="Template" options={[{ value: "", label: "Choose a product…" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} value={activeLine.templateId ?? ""} onChange={(v) => { void patchLine({ templateId: v || null, selections: [] }); }} disabled={!isDraft} />
                {isDraft && quote.lines.length > 1 && <button type="button" onClick={() => deleteLine(activeLine.id)} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "var(--h10-danger)", display: "inline-flex", padding: 2 }}><Trash2 size={14} /></button>}
              </div>

              {result?.violations?.filter((v) => v.severity === "BLOCK").map((v, i) => <Banner key={i} tone="danger" title="Can't be quoted">{v.message}</Banner>)}
              {result?.violations?.filter((v) => v.severity === "WARN").map((v, i) => <Banner key={`w${i}`} tone="warning" title="Heads up">{v.message}</Banner>)}

              {tpl?.optionGroups.map((g) => {
                const maxOne = g.maxSelect === 1;
                const ids = g.options.map((o) => o.id);
                return (
                  <div key={g.id}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>{g.name} <span style={{ fontWeight: 400, color: "var(--h10-text-3)" }}>· pick {g.minSelect}–{g.maxSelect}</span></div>
                    <div style={{ display: "grid", gap: 6 }}>
                      {g.options.map((o) => maxOne ? (
                        <RadioCard key={o.id} name={g.id} checked={selected.has(o.id)} selected={selected.has(o.id)} onChange={() => toggleOption(true, ids, o.id)} title={o.name} disabled={!isDraft} />
                      ) : (
                        <label key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, cursor: isDraft ? "pointer" : "default" }}>
                          <Checkbox checked={selected.has(o.id)} onChange={() => toggleOption(false, ids, o.id)} aria-label={o.name} disabled={!isDraft} />{o.name}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}

              {activeLine.templateId && (
                <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--h10-border-subtle)", paddingTop: 10 }}>
                  <label style={{ fontSize: 12, color: "var(--h10-text-2)", display: "inline-flex", gap: 6, alignItems: "center" }}>Qty
                    <input type="number" min={1} defaultValue={activeLine.qty} key={activeLine.qty} onBlur={(e) => Number(e.target.value) !== activeLine.qty && patchLine({ qty: Math.max(1, Number(e.target.value)) })} disabled={!isDraft} style={{ width: 54, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "3px 6px", font: "12.5px var(--font-mono)", textAlign: "center", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
                  </label>
                  <label style={{ fontSize: 12, color: "var(--h10-text-2)", display: "inline-flex", gap: 6, alignItems: "center" }}>Adjustment
                    <EuroInput cents={activeLine.adjustmentCents} onCommit={(c) => patchLine({ adjustmentCents: c })} ariaLabel="Adjustment" width={78} />
                  </label>
                  {activeLine.adjustmentCents !== 0 && (
                    <input defaultValue={activeLine.adjustmentReason ?? ""} key={activeLine.adjustmentReason ?? ""} placeholder="reason for the adjustment" onBlur={(e) => e.target.value !== (activeLine.adjustmentReason ?? "") && patchLine({ adjustmentReason: e.target.value || null })} disabled={!isDraft} style={{ flex: 1, minWidth: 160, border: "1px solid var(--h10-border-subtle)", borderRadius: 7, padding: "4px 8px", fontSize: 12, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* rail */}
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <div style={{ border: "1px solid var(--h10-border)", borderRadius: 12, background: "var(--h10-surface)", padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--h10-text-3)", marginBottom: 8 }}>Quote total</div>
            {canCost && totals && <Row label="Cost" value={eur(totals.costCents)} muted />}
            <Row label="Net total" value={totals ? eur(totals.netCents) : "—"} strong />
            {canMargin && totals && (
              <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--h10-text-2)" }}>Margin</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: totals.marginCents < 0 ? "var(--h10-danger)" : "var(--h10-success, #15a34a)" }}>{eur(totals.marginCents)} · {totals.marginPct.toFixed(1)}%</span>
              </div>
            )}
            {belowFloor && <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--h10-danger)" }}>Below your {floorPct}% margin floor.</div>}
          </div>

          {activeLine?.templateId && result && canCost && (
            <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)", marginBottom: 6 }}>This line</div>
              <Row label="Cost" value={eur(result.costCents ?? 0)} muted />
              <Row label="List" value={eur(result.listPriceCents ?? 0)} muted />
              <Row label="Net" value={eur(result.netPriceCents ?? 0)} />
            </div>
          )}

          <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
            <label style={{ fontSize: 11.5, color: "var(--h10-text-2)", display: "grid", gap: 3 }}>Deposit %
              <input type="number" min={0} max={100} defaultValue={quote.depositPct ?? 0} key={quote.depositPct ?? 0} onBlur={(e) => Number(e.target.value) !== (quote.depositPct ?? 0) && patchQuote({ depositPct: Number(e.target.value) || null })} disabled={!isDraft} style={{ width: 70, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "4px 6px", font: "12.5px var(--font-mono)", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
            </label>
            <label style={{ fontSize: 11.5, color: "var(--h10-text-2)", display: "grid", gap: 3 }}>Valid until
              <DateField ariaLabel="Valid until" value={isoDate(quote.validUntilAt)} onChange={(v) => patchQuote({ validUntilAt: v ? new Date(`${v}T23:59:00`).toISOString() : null })} disabled={!isDraft} />
            </label>
            <label style={{ fontSize: 11.5, color: "var(--h10-text-2)", display: "grid", gap: 3 }}>Promise date <span style={{ fontSize: 10, color: "var(--h10-text-3)" }}>(estimate; real lead time in FP6)</span>
              <DateField ariaLabel="Promise date" value={isoDate(quote.promiseDateAt)} onChange={(v) => patchQuote({ promiseDateAt: v ? new Date(`${v}T12:00:00`).toISOString() : null })} disabled={!isDraft} />
            </label>
          </div>

          {quote.versions.length > 0 && (
            <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)", marginBottom: 6 }}>Sent versions (frozen)</div>
              {quote.versions.map((v) => (
                <div key={v.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span>v{v.version}</span>
                  <span style={{ color: "var(--h10-text-3)" }}>{new Date(v.sentAt).toLocaleDateString()}{v.pdfRef ? <a href={`/api/quotes/${quoteId}/pdf?version=${v.version}`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 6, color: "var(--h10-text-link)" }}>PDF</a> : null}</span>
                </div>
              ))}
            </div>
          )}

          {similar.length > 0 && (
            <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)", marginBottom: 6 }}>Similar past quotes</div>
              {similar.map((s) => (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12, padding: "2px 0" }}>
                  <span style={{ display: "inline-flex", gap: 5, alignItems: "baseline" }}>{s.number}<Pill tone={s.state === "ACCEPTED" ? "success" : "danger"}>{s.state === "ACCEPTED" ? "won" : "lost"}</Pill></span>
                  <span style={{ color: "var(--h10-text-2)", fontFamily: "var(--font-mono)" }}>{eur(s.netCents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {sending && <SendModal quote={quote} totals={totals} floorPct={floorPct} belowFloor={belowFloor} onClose={() => setSending(false)} onSent={() => { setSending(false); void load(); }} />}
    </div>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "2px 0" }}>
      <span style={{ fontSize: 12, color: muted ? "var(--h10-text-3)" : "var(--h10-text-2)" }}>{label}</span>
      <span style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 800 : 600, fontFamily: "var(--font-mono)", color: "var(--h10-text)" }}>{value}</span>
    </div>
  );
}
