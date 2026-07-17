/**
 * FP3 — the configurator that WRITES a quote. Same live-margin feel as the FP2
 * preview, but every change PATCHes the line so the server (the only price
 * authority) re-persists the composed money. Left: lines + option toggles;
 * right rail: waterfall, margin, goal-seek, deposit/dates, versions, actions.
 * EPQ.3 — pricing discipline: goal-seek pair under Quote total (target net ⇄
 * margin solves the ACTIVE LINE's adjustment, then the reason field takes
 * focus), discount reason-code Listbox, quantity-tier/MOQ/size-surcharge rows
 * in the line waterfall, duplicate-open-quote banner, size-run matrix editor
 * (BRAND parties), and clickable similar quotes with a "repeat" chip.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileDown, Plus, Send, Trash2 } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Banner, Card, DateField, Listbox, Modal, useToast } from "@/design-system/components";
import { Button, Checkbox, Pill, RadioCard } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { ADJUSTMENT_REASON_CODES, REASON_CODE_LABEL, type AdjustmentReasonCode } from "@/lib/quotes/reason-codes";
import { formatSizeRun, readSelections, sizeRunTotal, type SizeRun } from "@/lib/quotes/selections";
import { EuroInput, euroStrToCents } from "@/app/(app)/products/_components/money";
import type { TemplateDetail } from "@/app/(app)/products/_components/types";
import { SendModal } from "./SendModal";
import { ConvertBar } from "./ConvertBar";
import { STATE_TONE, type ComposeResult, type GoalSeekResponse, type QuoteDetail, type SimilarQuote } from "./types";

const isoDate = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** EPQ.3 — a group models sizes when its name says so (mirrors the engine's parse hook). */
const SIZE_GROUP_RE = /^\s*(size|sizes|sizing|taglia|taglie)\b/i;

/** EPQ.3 — in-editor navigation to another quote (?q= — same trick as the pipeline). */
const goToQuote = (id: string) => {
  window.history.replaceState(null, "", `/quotes?q=${id}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export function QuoteEditor({ quoteId, onBack }: { quoteId: string; onBack: () => void }) {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const canCost = usePermission("financials.costs.view");
  const canCreate = usePermission("quotes.create"); // EPQ.3 — gates goal-seek (it writes an adjustment)
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [totals, setTotals] = useState<{ netCents: number; costCents: number; marginCents: number; marginPct: number } | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; number: string } | null>(null); // EPQ.3
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [tplCache, setTplCache] = useState<Record<string, TemplateDetail>>({});
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [sending, setSending] = useState(false);
  const [floorPct, setFloorPct] = useState(20);
  const [similar, setSimilar] = useState<SimilarQuote[]>([]);
  const [sizeRunOpen, setSizeRunOpen] = useState(false); // EPQ.3 — matrix editor modal
  // EPQ.3 — goal-seek discipline: after applying a solved adjustment, the
  // reason field takes focus (an adjustment without a story is not allowed to
  // feel finished).
  const [focusReason, setFocusReason] = useState(false);
  const reasonRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const [d, t, s] = await Promise.all([
      apiJson<{ quote: QuoteDetail; totals: typeof totals; duplicate: { id: string; number: string } | null }>(`/api/quotes/${quoteId}`),
      apiJson<{ templates: { id: string; name: string }[] }>("/api/products/templates"),
      apiJson<{ marginFloorPct: number }>("/api/settings/pricing-defaults").catch(() => ({ marginFloorPct: 20 })),
    ]);
    setQuote(d.quote);
    setTotals(d.totals);
    setDuplicate(d.duplicate ?? null);
    setTemplates(t.templates);
    setFloorPct(s.marginFloorPct ?? 20);
    // EPQ.3 — navigating editor→editor (similar/duplicate links) keeps the
    // component mounted: only keep the active line if it belongs to THIS quote
    setActiveLineId((prev) => (prev && d.quote.lines.some((l) => l.id === prev) ? prev : d.quote.lines[0]?.id ?? null));
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
  const activeSelections = useMemo(() => readSelections(activeLine?.selections), [activeLine?.selections]);
  const activeSizeRun = activeSelections.sizeRun;

  useEffect(() => {
    if (!quote) return;
    const tid = quote.lines.find((l) => l.templateId)?.templateId;
    const usp = new URLSearchParams({ partyId: quote.party.id, excludeId: quote.id });
    if (tid) usp.set("templateId", tid);
    apiJson<{ quotes: SimilarQuote[] }>(`/api/quotes/similar?${usp}`).then((d) => setSimilar(d.quotes)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, quote?.lines.length]);

  // EPQ.3 — the rail composes the STORED line server-side (qty-aware: tier/MOQ/
  // size-surcharge rows included), replacing the old qty-blind products preview
  const refreshRail = useCallback(async (lineId: string | null) => {
    if (!lineId) { setResult(null); return; }
    try {
      const r = await apiJson<{ result: ComposeResult | null }>(`/api/quotes/lines/${lineId}/compose`);
      setResult(r.result);
    } catch { setResult(null); }
  }, []);

  useEffect(() => {
    if (activeLine?.templateId) { void fetchTemplate(activeLine.templateId); void refreshRail(activeLine.id); }
    else setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLineId, activeLine?.templateId]);

  const patchLine = async (data: Record<string, unknown>) => {
    if (!activeLine) return;
    try {
      const res = await apiJson<{ result: ComposeResult | null }>(`/api/quotes/lines/${activeLine.id}`, { method: "PATCH", body: JSON.stringify(data) });
      if (res.result) setResult(res.result);
      await load();
      return true;
    } catch (e) {
      toast((e as Error).message, "danger");
      return false;
    }
  };

  // FS4 — every quote PATCH carries the row stamp; a 409 ("changed elsewhere")
  // toasts and reloads so the editor is looking at the winning version.
  const patchQuote = async (data: Record<string, unknown>) => {
    try {
      await apiJson(`/api/quotes/${quoteId}`, { method: "PATCH", body: JSON.stringify({ ...data, ...(quote?.updatedAt ? { expectedUpdatedAt: quote.updatedAt } : {}) }) });
      await load();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      toast(msg, "danger");
      if (msg.includes("changed elsewhere")) await load();
      return false;
    }
  };

  // EPQ.2 — Revise gets a success toast (gap 6: silent successes)
  const revise = async () => {
    if (await patchQuote({ state: "DRAFT" })) toast("Quote revised — back to draft", "success");
  };

  // EPQ.3 — goal-seek: solve the active line's adjustment for a target quote
  // net (cents) or margin (%), persist via the NORMAL patch, then hand focus
  // to the reason field — goal-seek still needs a reason.
  const goalSeek = async (by: "net" | "margin", value: number) => {
    if (!activeLine) return;
    try {
      const gs = await apiJson<GoalSeekResponse>(`/api/quotes/lines/${activeLine.id}/goal-seek`, { method: "POST", body: JSON.stringify({ by, value }) });
      const ok = await patchLine({ adjustmentCents: gs.adjustmentCents });
      if (!ok) return;
      if (gs.adjustmentCents !== 0) {
        setFocusReason(true);
        toast(`Adjustment set to ${signedEur(gs.adjustmentCents)} — add the reason`, "success");
      } else {
        toast("Target met with no adjustment", "success");
      }
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  useEffect(() => {
    if (focusReason && reasonRef.current) { reasonRef.current.focus(); setFocusReason(false); }
  }, [focusReason, quote]);

  const addLine = async () => {
    try { const d = await apiJson<{ line: { id: string } }>(`/api/quotes/${quoteId}/lines`, { method: "POST", body: JSON.stringify({}) }); await load(); setActiveLineId(d.line.id); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const deleteLine = async (lid: string) => {
    try { await apiFetch(`/api/quotes/lines/${lid}`, { method: "DELETE" }); setActiveLineId(null); await load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };

  const tpl = activeLine?.templateId ? tplCache[activeLine.templateId] : null;
  const selected = useMemo(() => new Set(activeSelections.optionIds), [activeSelections]);
  // EPQ.3 — size names prefill the matrix from the template's size option group (when one exists)
  const sizeGroupNames = useMemo(
    () => tpl?.optionGroups.find((g) => SIZE_GROUP_RE.test(g.name))?.options.map((o) => o.name) ?? [],
    [tpl],
  );

  const toggleOption = (maxOne: boolean, groupIds: string[], id: string) => {
    const next = new Set(selected);
    if (maxOne) { for (const g of groupIds) next.delete(g); if (!selected.has(id)) next.add(id); }
    else { next.has(id) ? next.delete(id) : next.add(id); }
    void patchLine({ selections: [...next] });
  };

  if (!quote) return <Card padded><Button onClick={onBack}><ArrowLeft size={13} /> Back</Button></Card>;

  const belowFloor = canMargin && totals != null && totals.netCents > 0 && totals.marginPct < floorPct;

  // EPQ.3 — discipline rows (tier/MOQ/size) render as their own waterfall steps;
  // "List" shows the pre-discipline subtotal so the steps visibly sum to Net
  const surchargeRows = (result?.lines ?? []).filter((l) => l.kind === "surcharge");
  const preDisciplineListCents = (result?.listPriceCents ?? 0) - surchargeRows.reduce((s, l) => s + (l.priceCents ?? 0), 0);

  return (
    <div className="factory-page--centered">
      <DetailHeader
        backLabel="All quotes"
        onBack={onBack}
        title={
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            {quote.number}<Pill tone={STATE_TONE[quote.state]}>{quote.state}</Pill>
            {/* EPQ.2 — the converted pill links to the order (gap 3: quote→order was a dead end) */}
            {quote.convertedOrderId && (
              <a href={`/orders?o=${quote.convertedOrderId}`} style={{ textDecoration: "none" }} title="Open the order">
                <Pill tone="success">converted ↗</Pill>
              </a>
            )}
          </span>
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a href={`/api/quotes/${quoteId}/pdf`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}><FileDown size={13} /> PDF</a>
            {/* EPQ.1 — EXPIRED is reversible by Revise (the only edge out of it) */}
            {(quote.state === "SENT" || quote.state === "EXPIRED") && <Button onClick={revise}>Revise</Button>}
            {(quote.state === "DRAFT" || quote.state === "SENT") && <Button variant="primary" onClick={() => setSending(true)} disabled={quote.lines.length === 0}><Send size={13} /> Send</Button>}
          </div>
        }
      />
      <div style={{ fontSize: 12, color: "var(--h10-text-3)", marginBottom: 10 }}>
        {quote.party.name}{quote.conversation ? ` · from thread “${quote.conversation.subject ?? ""}”` : ""}{quote.party.priceList ? ` · list: ${quote.party.priceList.name}` : " · Listino base"}
      </div>

      {/* EPQ.3 — duplicate-open-quote warning (same party, same template set, both open) */}
      {duplicate && (
        <div style={{ marginBottom: 10 }}>
          <Banner tone="warning" title="Possible duplicate">
            {duplicate.number} is already open for this party with a similar configuration.{" "}
            <button type="button" onClick={() => goToQuote(duplicate.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 600, color: "var(--h10-text-link)" }}>
              Open {duplicate.number} ↗
            </button>
          </Banner>
        </div>
      )}

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
                <Listbox ariaLabel="Template" options={[{ value: "", label: "Choose a product…" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} value={activeLine.templateId ?? ""} onChange={(v) => { void patchLine({ templateId: v || null, selections: [], sizeRun: null }); }} disabled={!isDraft} />
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
                <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--h10-border-subtle)", paddingTop: 10 }}>
                  <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ fontSize: 12, color: "var(--h10-text-2)", display: "inline-flex", gap: 6, alignItems: "center" }}>Qty
                      <input type="number" min={1} defaultValue={activeLine.qty} key={`${activeLine.qty}:${activeSizeRun ? "run" : "free"}`} onBlur={(e) => Number(e.target.value) !== activeLine.qty && patchLine({ qty: Math.max(1, Number(e.target.value)) })} disabled={!isDraft || activeSizeRun != null} title={activeSizeRun ? "Derived from the size run" : undefined} style={{ width: 54, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "3px 6px", font: "12.5px var(--font-mono)", textAlign: "center", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
                    </label>
                    {/* EPQ.3 — size-run matrix (B2B): sizes × qty as ONE line; qty = Σ */}
                    {quote.party.kind === "BRAND" && (isDraft || activeSizeRun) && (
                      <button type="button" onClick={() => isDraft && setSizeRunOpen(true)} style={{ background: "none", border: "none", padding: 0, cursor: isDraft ? "pointer" : "default", fontSize: 11.5, color: "var(--h10-text-link)", whiteSpace: "nowrap" }}>
                        {activeSizeRun ? "Edit size run" : "+ Size run"}
                      </button>
                    )}
                    <label style={{ fontSize: 12, color: "var(--h10-text-2)", display: "inline-flex", gap: 6, alignItems: "center" }}>Adjustment
                      <EuroInput cents={activeLine.adjustmentCents} onCommit={(c) => patchLine({ adjustmentCents: c })} ariaLabel="Adjustment" width={78} disabled={!isDraft} />
                    </label>
                  </div>
                  {activeSizeRun && (
                    <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Size run: {formatSizeRun(activeSizeRun)} · Σ {sizeRunTotal(activeSizeRun)}</div>
                  )}
                  {activeLine.adjustmentCents !== 0 && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {/* EPQ.3 — coded WHY beside the free-text story */}
                      <Listbox
                        ariaLabel="Adjustment reason code"
                        options={[{ value: "", label: "Reason code…" }, ...ADJUSTMENT_REASON_CODES.map((c) => ({ value: c, label: REASON_CODE_LABEL[c] }))]}
                        value={activeLine.adjustmentReasonCode ?? ""}
                        onChange={(v) => { void patchLine({ adjustmentReasonCode: (v || null) as AdjustmentReasonCode | null }); }}
                        disabled={!isDraft}
                      />
                      <input ref={reasonRef} defaultValue={activeLine.adjustmentReason ?? ""} key={activeLine.adjustmentReason ?? ""} placeholder="reason for the adjustment" onBlur={(e) => e.target.value !== (activeLine.adjustmentReason ?? "") && patchLine({ adjustmentReason: e.target.value || null })} disabled={!isDraft} style={{ flex: 1, minWidth: 160, border: "1px solid var(--h10-border-subtle)", borderRadius: 7, padding: "4px 8px", fontSize: 12, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
                    </div>
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

            {/* EPQ.3 — goal-seek (S7): type where the quote should land; the
                active line's adjustment is solved by the engine and persisted
                through the normal patch; the reason field takes focus after. */}
            {isDraft && canCreate && activeLine?.templateId && totals && (
              <div style={{ marginTop: 10, borderTop: "1px solid var(--h10-border-subtle)", paddingTop: 8, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--h10-text-3)" }}>Goal-seek · adjusts “{activeLine.template?.name ?? "this line"}”</div>
                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--h10-text-2)" }}>Target net
                  <TargetNetInput key={`tn:${totals.netCents}`} currentCents={totals.netCents} onSeek={(cents) => void goalSeek("net", cents)} />
                </label>
                {canMargin && (
                  <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--h10-text-2)" }}>Target margin %
                    <input
                      type="number"
                      step="0.1"
                      defaultValue={totals.marginPct.toFixed(1)}
                      key={`tm:${totals.marginPct.toFixed(1)}`}
                      aria-label="Target margin %"
                      onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && Math.abs(v - totals.marginPct) > 0.05) void goalSeek("margin", v); }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      style={{ width: 78, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "4px 6px", font: "12.5px var(--font-mono)", textAlign: "right", background: "var(--h10-surface)", color: "var(--h10-text)" }}
                    />
                  </label>
                )}
              </div>
            )}
          </div>

          {activeLine?.templateId && result && canCost && (
            <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)", marginBottom: 6 }}>This line</div>
              {/* EPQ.1 — four-row waterfall (spec parity): the adjustment is a visible signed step, not folded into Net */}
              <Row label="Cost" value={eur(result.costCents ?? 0)} muted />
              <Row label="List" value={eur(preDisciplineListCents)} muted />
              {/* EPQ.3 — discipline rows: quantity tier / below-MOQ / size surcharge, each a labeled signed step */}
              {surchargeRows.map((l, i) => (
                <Row key={`s${i}`} label={l.label} value={signedEur(l.priceCents ?? 0)} muted />
              ))}
              <Row label="Adjustment" value={signedEur(activeLine.adjustmentCents)} muted={activeLine.adjustmentCents === 0} />
              {activeLine.adjustmentCents !== 0 && (activeLine.adjustmentReason || activeLine.adjustmentReasonCode) ? (
                <div style={{ fontSize: 11, color: "var(--h10-text-3)", margin: "-1px 0 3px", textAlign: "right" }}>
                  {activeLine.adjustmentReasonCode ? REASON_CODE_LABEL[activeLine.adjustmentReasonCode as AdjustmentReasonCode] ?? activeLine.adjustmentReasonCode : null}
                  {activeLine.adjustmentReasonCode && activeLine.adjustmentReason ? " — " : null}
                  {activeLine.adjustmentReason ? `“${activeLine.adjustmentReason}”` : null}
                </div>
              ) : null}
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

          {/* EPQ.2 — customer views: the public page records every open */}
          {quote.sentAt && (
            <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--h10-text-3)", marginBottom: 6 }}>Customer views</div>
              {quote.viewCount > 0 ? (
                <>
                  <Row label="Views" value={`${quote.viewCount}×`} />
                  <Row label="First" value={quote.firstViewedAt ? new Date(quote.firstViewedAt).toLocaleString() : "—"} muted />
                  <Row label="Last" value={quote.lastViewedAt ? new Date(quote.lastViewedAt).toLocaleString() : "—"} muted />
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>Not viewed yet — the link in the email records every open.</div>
              )}
              {quote.lastNudgeAt && (
                <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 4 }}>Last follow-up sent {new Date(quote.lastNudgeAt).toLocaleDateString()}.</div>
              )}
            </div>
          )}

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
                // EPQ.3 — rows OPEN the quote (inventory gap 7: they were inert); "repeat" = it was produced
                <button key={s.id} type="button" onClick={() => goToQuote(s.id)} title={`Open ${s.number}`} style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "baseline", fontSize: 12, padding: "2px 0", background: "none", border: "none", cursor: "pointer", font: "inherit", textAlign: "left" }}>
                  <span style={{ display: "inline-flex", gap: 5, alignItems: "baseline" }}>
                    <span style={{ color: "var(--h10-text-link)", fontWeight: 600 }}>{s.number}</span>
                    <Pill tone={s.state === "ACCEPTED" ? "success" : "danger"}>{s.state === "ACCEPTED" ? "won" : "lost"}</Pill>
                    {s.wasProduced && <Pill tone="info">repeat</Pill>}
                  </span>
                  <span style={{ color: "var(--h10-text-2)", fontFamily: "var(--font-mono)" }}>{eur(s.netCents)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {sending && <SendModal quote={quote} totals={totals} floorPct={floorPct} belowFloor={belowFloor} onClose={() => setSending(false)} onSent={() => { setSending(false); void load(); }} />}

      {/* EPQ.3 — size-run matrix editor (mirrors the FP4 OrderItems editor; qty = Σ sizes) */}
      {sizeRunOpen && activeLine && (
        <SizeRunModal
          initial={activeSizeRun}
          suggestedSizes={sizeGroupNames}
          onClose={() => setSizeRunOpen(false)}
          onSave={async (run) => {
            const ok = await patchLine({ sizeRun: run });
            if (ok) { setSizeRunOpen(false); toast(run ? "Size run saved — qty follows the matrix" : "Size run cleared", "success"); }
          }}
        />
      )}
    </div>
  );
}

/** EPQ.3 — target-net input: EuroInput look, commit-on-blur, only fires when changed. */
function TargetNetInput({ currentCents, onSeek }: { currentCents: number; onSeek: (cents: number) => void }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--h10-border)", borderRadius: 7, overflow: "hidden", background: "var(--h10-surface)" }}>
      <span style={{ padding: "4px 6px", fontSize: 12, color: "var(--h10-text-3)", background: "var(--h10-surface-sunken)" }}>€</span>
      <input
        type="number"
        step="0.01"
        defaultValue={(currentCents / 100).toFixed(2)}
        aria-label="Target net"
        onBlur={(e) => { const cents = euroStrToCents(e.target.value); if (cents !== currentCents) onSeek(cents); }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        style={{ width: 90, border: "none", outline: "none", font: "12.5px var(--font-mono), monospace", padding: "4px 6px", background: "transparent", color: "var(--h10-text)", textAlign: "right" }}
      />
    </span>
  );
}

/** EPQ.3 — sizes × qty grid stored on the line ({sizeRun} in selections; qty = Σ). */
function SizeRunModal({ initial, suggestedSizes, onClose, onSave }: {
  initial: SizeRun | null;
  suggestedSizes: string[];
  onClose: () => void;
  onSave: (run: SizeRun | null) => Promise<void> | void;
}) {
  const [rows, setRows] = useState<{ size: string; qty: string }[]>(() => {
    if (initial) return Object.entries(initial).map(([size, qty]) => ({ size, qty: String(qty) }));
    if (suggestedSizes.length > 0) return suggestedSizes.map((s) => ({ size: s, qty: "" }));
    return [{ size: "", qty: "" }];
  });
  const [busy, setBusy] = useState(false);
  const total = rows.reduce((s, r) => s + (Number(r.qty) > 0 ? Number(r.qty) : 0), 0);

  const commit = async (clear: boolean) => {
    setBusy(true);
    try {
      const obj = clear ? null : Object.fromEntries(rows.filter((r) => r.size.trim() && Number(r.qty) > 0).map((r) => [r.size.trim(), Number(r.qty)]));
      await onSave(obj && Object.keys(obj).length ? obj : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Size run"
      size="sm"
      footer={
        <>
          {initial && <Button onClick={() => commit(true)} disabled={busy}>Clear</Button>}
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => commit(false)} disabled={busy || total === 0}>{busy ? "Saving…" : `Save (Σ ${total})`}</Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: 12, color: "var(--h10-text-2)" }}>One line, one matrix: quantity per size. The line qty becomes the sum; production explodes per size at Start production.</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={r.size} onChange={(e) => setRows((prev) => prev.map((p, j) => (j === i ? { ...p, size: e.target.value } : p)))} placeholder="Size (e.g. 48)" aria-label={`Size ${i + 1}`} style={{ width: 110, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "4px 8px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
            <input type="number" min={0} value={r.qty} onChange={(e) => setRows((prev) => prev.map((p, j) => (j === i ? { ...p, qty: e.target.value } : p)))} placeholder="Qty" aria-label={`Qty for size ${i + 1}`} style={{ width: 70, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "4px 8px", font: "12.5px var(--font-mono)", textAlign: "center", outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
            <button type="button" onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove size row ${i + 1}`} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--h10-text-3)", padding: 2 }}>×</button>
          </div>
        ))}
        <div>
          <Button onClick={() => setRows((prev) => [...prev, { size: "", qty: "" }])}><Plus size={12} /> size</Button>
        </div>
      </div>
    </Modal>
  );
}

/** EPQ.1 — signed money for the waterfall's Adjustment step. */
const signedEur = (cents: number) => (cents > 0 ? `+ ${eur(cents)}` : cents < 0 ? `− ${eur(Math.abs(cents))}` : eur(0));

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "2px 0" }}>
      <span style={{ fontSize: 12, color: muted ? "var(--h10-text-3)" : "var(--h10-text-2)" }}>{label}</span>
      <span style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 800 : 600, fontFamily: "var(--font-mono)", color: "var(--h10-text)" }}>{value}</span>
    </div>
  );
}
