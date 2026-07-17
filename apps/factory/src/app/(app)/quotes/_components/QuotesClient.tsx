/**
 * FP3 — the Quotes RFQ pipeline: three live counters, state tabs, search, grid.
 * Clicking a quote (or New quote) opens the QuoteEditor. Deep-linkable via ?q=.
 * EPQ.1 — Expired tab (the worker sweep finally populates the state) + row
 * selection with bulk Mark lost (one reason, applied per quote via the
 * lifecycle-guarded PATCH; SENT rows transition to REJECTED, EXPIRED rows just
 * take the reason — EXPIRED→REJECTED is not a legal edge).
 * EPQ.2 — ?focus= accepted as an alias of ?q= (the ⌘K deep link finally
 * lands); "Needs follow-up" queue card on top; the Overdue counter became
 * "Expiring soon" and clicking it filters the grid; the Valid-until column
 * became the compact "viewed" cell; Export CSV hidden without exports.run.
 * EPQ.3 — FS3 adoption (program registry): the pipeline grid is a height-bound
 * VirtualDataGrid (windowed rows, bounded DOM at scale) and the New-quote
 * party picker is an AsyncCombobox over /api/parties-lite?q= (server-paged
 * search instead of the whole-table pull).
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { BulkActionBar, PageHeader } from "@/design-system/patterns";
import { Card, Modal, useToast } from "@/design-system/components";
import { Button, Checkbox, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { AsyncCombobox, type SearchLoader } from "@/components/AsyncCombobox"; // FS3
import { VirtualDataGrid } from "@/components/VirtualDataGrid"; // FS3 — windowed rows, DS-grid parity
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { formatViewed } from "@/lib/quotes/followup";
import { FollowUpQueue } from "./FollowUpQueue";
import { QuoteEditor } from "./QuoteEditor";
import { STATE_TONE, type PipelineResponse, type QuoteRow } from "./types";

const TABS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "sent", label: "Sent" },
  { id: "accepted", label: "Accepted" },
  { id: "rejected", label: "Rejected" },
  { id: "expired", label: "Expired" }, // EPQ.1
];

/** EPQ.1 — bulk Mark lost applies only where a loss makes sense. */
const canMarkLost = (r: QuoteRow) => r.state === "SENT" || r.state === "EXPIRED";

/** EPQ.3 (FS3) — party picker searches the server; the whole-table pull is gone. */
const partyLoader: SearchLoader = async (q, cursor) => {
  const usp = new URLSearchParams({ q });
  if (cursor) usp.set("cursor", cursor);
  const d = await apiJson<{ parties: { id: string; name: string; kind: string }[]; nextCursor?: string | null }>(`/api/parties-lite?${usp}`);
  return { options: d.parties.map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` })), nextCursor: d.nextCursor ?? null };
};

function Counter({ label, value, tone, onClick, active }: { label: string; value: number; tone: string; onClick?: () => void; active?: boolean }) {
  const box: React.CSSProperties = {
    border: `1px solid ${active ? "var(--h10-primary)" : "var(--h10-border-subtle)"}`,
    borderRadius: 10, padding: "8px 14px", minWidth: 120,
    background: active ? "var(--h10-wash-primary)" : "transparent",
    textAlign: "left",
  };
  const body = (
    <>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>{label}</div>
    </>
  );
  // EPQ.2 — a counter with an onClick is a real filter affordance, not a tile
  if (onClick) {
    return <button type="button" onClick={onClick} aria-pressed={active} style={{ ...box, cursor: "pointer", font: "inherit" }}>{body}</button>;
  }
  return <div style={box}>{body}</div>;
}

function PipelineInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canCreate = usePermission("quotes.create");
  const canMargin = usePermission("financials.margins.view");
  const canSend = usePermission("quotes.send"); // EPQ.2 — follow-up queue actions
  const canExport = usePermission("exports.run"); // EPQ.2 — gap 4
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [state, setState] = useState("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [partyId, setPartyId] = useState("");
  const [partyLabel, setPartyLabel] = useState(""); // EPQ.3 — AsyncCombobox shows the picked label
  const [busy, setBusy] = useState(false);
  // EPQ.1 — bulk mark-lost selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [markingLost, setMarkingLost] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // EPQ.2 — ?focus= is an alias of ?q= (⌘K search emits focus, gap 1)
  const openId = params.get("q") ?? params.get("focus");

  const load = useCallback(async () => {
    try {
      const usp = new URLSearchParams({ state });
      if (q.trim()) usp.set("q", q.trim());
      const d = await apiJson<PipelineResponse>(`/api/quotes?${usp}`);
      setData(d);
      // EPQ.1 — keep the selection honest: only visible, still-markable rows
      setSelected((prev) => new Set(d.quotes.filter((r) => prev.has(r.id) && canMarkLost(r)).map((r) => r.id)));
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [state, q, toast]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);

  const openEditor = (id: string) => { window.history.replaceState(null, "", `/quotes?q=${id}`); window.dispatchEvent(new PopStateEvent("popstate")); };
  const closeEditor = () => { window.history.replaceState(null, "", "/quotes"); window.dispatchEvent(new PopStateEvent("popstate")); void load(); };

  // EPQ.3 (FS3) — no whole-list prefetch: the AsyncCombobox searches on open
  const startCreate = () => setCreating(true);
  const create = async () => {
    if (!partyId) return;
    setBusy(true);
    try {
      const d = await apiJson<{ quote: { id: string } }>("/api/quotes", { method: "POST", body: JSON.stringify({ partyId }) });
      setCreating(false); setPartyId(""); setPartyLabel("");
      openEditor(d.quote.id);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  // EPQ.1 — bulk Mark lost: one reason, applied per quote through the
  // lifecycle-guarded PATCH (SENT → REJECTED + reason; EXPIRED keeps its state,
  // takes the reason — the machine has no EXPIRED→REJECTED edge).
  const markLost = async () => {
    if (!data) return;
    setBulkBusy(true);
    let done = 0, failed = 0;
    for (const id of selected) {
      const row = data.quotes.find((r) => r.id === id);
      if (!row || !canMarkLost(row)) continue;
      const body = row.state === "SENT" ? { state: "REJECTED", lostReason: lostReason.trim() || null } : { lostReason: lostReason.trim() || null };
      try { await apiJson(`/api/quotes/${id}`, { method: "PATCH", body: JSON.stringify(body) }); done += 1; }
      catch { failed += 1; }
    }
    setBulkBusy(false);
    setMarkingLost(false);
    setLostReason("");
    setSelected(new Set());
    toast(failed ? `${done} marked lost · ${failed} failed` : `${done} marked lost`, failed ? "danger" : "success");
    void load();
  };

  const toggleSelected = (id: string) => setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  if (openId) return <QuoteEditor quoteId={openId} onBack={closeEditor} />;

  return (
    <div className="factory-page factory-grid-grow-2">
      <PageHeader eyebrow="Factory OS" title="Quotes" subtitle="The RFQ pipeline: configure, price with margin, send into the thread, track to won or lost." />
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <Counter label="Drafts" value={data?.counters.drafts ?? 0} tone="var(--h10-text)" />
        <Counter label="Awaiting approval" value={data?.counters.awaiting ?? 0} tone="var(--h10-primary)" />
        {/* EPQ.2 — clickable: filters the grid to SENT quotes expiring within the pre-expiry window (gap 15) */}
        <Counter
          label="Expiring soon"
          value={data?.counters.expiringSoon ?? 0}
          tone={data && data.counters.expiringSoon > 0 ? "var(--h10-danger)" : "var(--h10-text-3)"}
          onClick={() => setState((s) => (s === "expiring" ? "all" : "expiring"))}
          active={state === "expiring"}
        />
        <div style={{ marginLeft: "auto", alignSelf: "center", display: "flex", gap: 12, alignItems: "center" }}>
          {canExport && <a href="/api/exports/quotes" style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export CSV</a>}
          {canCreate && <Button variant="primary" onClick={startCreate}><Plus size={13} /> New quote</Button>}
        </div>
      </div>
      {/* EPQ.2 — the Owner's follow-up task queue (worker-flagged SENT quotes) */}
      <FollowUpQueue
        rows={data?.followups ?? []}
        config={data?.followupConfig ?? { unviewedDays: 3, viewedDays: 7, preExpiryDays: 3 }}
        canSend={canSend}
        onOpen={openEditor}
        onChanged={() => void load()}
      />
      <Card padded>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setState(t.id)} style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, background: state === t.id ? "var(--h10-primary)" : "transparent", color: state === t.id ? "#fff" : "var(--h10-text-2)" }}>
                {t.label}{t.id !== "all" && data?.counts[t.id.toUpperCase()] ? <span style={{ marginLeft: 5, fontSize: 10.5, opacity: 0.85 }}>{data.counts[t.id.toUpperCase()]}</span> : null}
              </button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or party…" style={{ marginLeft: "auto", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 9px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)", minWidth: 220 }} />
        </div>
        {/* EPQ.3 (FS3) — height-bound windowed grid; take-200 today, bounded DOM at any scale */}
        <VirtualDataGrid
          height="calc(100dvh - 380px)"
          columns={[
            // EPQ.1 — selection for bulk Mark lost (only states where a loss makes sense)
            { key: "select", label: "", render: (r: QuoteRow) => canMarkLost(r) ? <Checkbox checked={selected.has(r.id)} onChange={() => toggleSelected(r.id)} aria-label={`Select ${r.number}`} /> : null },
            { key: "number", label: "Quote", render: (r: QuoteRow) => <button type="button" onClick={() => openEditor(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
            { key: "party", label: "Party", render: (r: QuoteRow) => r.party.name },
            { key: "state", label: "State", render: (r: QuoteRow) => <span style={{ display: "inline-flex", gap: 5 }}><Pill tone={STATE_TONE[r.state]}>{r.state}</Pill>{r.convertedOrderId && <Pill tone="success">order</Pill>}</span> },
            { key: "net", label: "Net", align: "right" as const, render: (r: QuoteRow) => (r.lineCount ? eur(r.netCents) : "—") },
            ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: QuoteRow) => (r.lineCount ? <Pill tone={r.marginCents < 0 ? "danger" : "success"}>{r.marginPct.toFixed(0)}%</Pill> : "—") }] : []),
            // EPQ.2 — the compact viewed cell replaced Valid-until (validity lives in the editor rail; expiry pressure lives in the Expiring-soon counter)
            {
              key: "viewed", label: "Viewed",
              render: (r: QuoteRow) => (
                <span title={r.viewCount ? `First ${r.firstViewedAt ? new Date(r.firstViewedAt).toLocaleString() : "—"} · last ${r.lastViewedAt ? new Date(r.lastViewedAt).toLocaleString() : "—"}` : "Not viewed yet"}>
                  {formatViewed(r.viewCount, r.lastViewedAt, new Date())}
                </span>
              ),
            },
            { key: "updated", label: "Updated", render: (r: QuoteRow) => new Date(r.updatedAt).toLocaleDateString() },
          ]}
          rows={data?.quotes ?? []}
          rowKey={(r: QuoteRow) => r.id}
          emptyState="No quotes yet — start one from an Inbox thread or with New quote."
        />
        {/* EPQ.1 — bulk actions for the selection */}
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Button variant="primary" onClick={() => setMarkingLost(true)} disabled={bulkBusy}>Mark lost</Button>
        </BulkActionBar>
      </Card>

      {/* EPQ.1 — one reason for the whole selection */}
      <Modal open={markingLost} onClose={() => !bulkBusy && setMarkingLost(false)} title={`Mark ${selected.size} quote${selected.size === 1 ? "" : "s"} lost`} size="sm" footer={<><Button onClick={() => setMarkingLost(false)} disabled={bulkBusy}>Cancel</Button><Button variant="primary" onClick={markLost} disabled={bulkBusy}>{bulkBusy ? "Marking…" : "Mark lost"}</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Sent quotes become <b>Rejected</b>; expired quotes keep their state — all take this reason (it feeds win/loss).</div>
          <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Why was it lost? (optional)" aria-label="Lost reason" />
        </div>
      </Modal>

      <Modal open={creating} onClose={() => setCreating(false)} title="New quote" size="sm" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!partyId || busy}>Create</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Who is this quote for?</div>
          {/* EPQ.3 (FS3) — server-paged typeahead over /api/parties-lite?q= */}
          <AsyncCombobox
            ariaLabel="Party"
            loader={partyLoader}
            value={partyId}
            valueLabel={partyLabel}
            placeholder="Choose a contact…"
            emptyText="No contacts yet — create one from an Inbox thread first."
            onChange={(v, o) => { setPartyId(v); setPartyLabel(o.label); }}
          />
        </div>
      </Modal>
    </div>
  );
}

export function QuotesClient() {
  return <Suspense fallback={null}><PipelineInner /></Suspense>;
}
