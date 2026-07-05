/**
 * FP3 — the Quotes RFQ pipeline: three live counters, state tabs, search, grid.
 * Clicking a quote (or New quote) opens the QuoteEditor. Deep-linkable via ?q=.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/design-system/patterns";
import { Card, DataGrid, Modal, useToast } from "@/design-system/components";
import { Listbox } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { QuoteEditor } from "./QuoteEditor";
import { STATE_TONE, type PipelineResponse, type QuoteRow } from "./types";

const TABS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "sent", label: "Sent" },
  { id: "accepted", label: "Accepted" },
  { id: "rejected", label: "Rejected" },
];

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: "8px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>{label}</div>
    </div>
  );
}

function PipelineInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canCreate = usePermission("quotes.create");
  const canMargin = usePermission("financials.margins.view");
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [state, setState] = useState("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [parties, setParties] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [partyId, setPartyId] = useState("");
  const [busy, setBusy] = useState(false);

  const openId = params.get("q");

  const load = useCallback(async () => {
    try {
      const usp = new URLSearchParams({ state });
      if (q.trim()) usp.set("q", q.trim());
      setData(await apiJson<PipelineResponse>(`/api/quotes?${usp}`));
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [state, q, toast]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);

  const openEditor = (id: string) => { window.history.replaceState(null, "", `/quotes?q=${id}`); window.dispatchEvent(new PopStateEvent("popstate")); };
  const closeEditor = () => { window.history.replaceState(null, "", "/quotes"); window.dispatchEvent(new PopStateEvent("popstate")); void load(); };

  const startCreate = async () => {
    setCreating(true);
    try {
      setParties((await apiJson<{ parties: { id: string; name: string; kind: string }[] }>("/api/parties-lite")).parties);
    } catch { /* ignore */ }
  };
  const create = async () => {
    if (!partyId) return;
    setBusy(true);
    try {
      const d = await apiJson<{ quote: { id: string } }>("/api/quotes", { method: "POST", body: JSON.stringify({ partyId }) });
      setCreating(false); setPartyId("");
      openEditor(d.quote.id);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  if (openId) return <QuoteEditor quoteId={openId} onBack={closeEditor} />;

  return (
    <div className="factory-page factory-grid-grow-2">
      <PageHeader eyebrow="Factory OS" title="Quotes" subtitle="The RFQ pipeline: configure, price with margin, send into the thread, track to won or lost." />
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <Counter label="Drafts" value={data?.counters.drafts ?? 0} tone="var(--h10-text)" />
        <Counter label="Awaiting approval" value={data?.counters.awaiting ?? 0} tone="var(--h10-primary)" />
        <Counter label="Overdue" value={data?.counters.overdue ?? 0} tone={data && data.counters.overdue > 0 ? "var(--h10-danger)" : "var(--h10-text-3)"} />
        <div style={{ marginLeft: "auto", alignSelf: "center", display: "flex", gap: 12, alignItems: "center" }}>
          <a href="/api/exports/quotes" style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export CSV</a>
          {canCreate && <Button variant="primary" onClick={startCreate}><Plus size={13} /> New quote</Button>}
        </div>
      </div>
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
        <DataGrid
          columns={[
            { key: "number", label: "Quote", render: (r: QuoteRow) => <button type="button" onClick={() => openEditor(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
            { key: "party", label: "Party", render: (r: QuoteRow) => r.party.name },
            { key: "state", label: "State", render: (r: QuoteRow) => <span style={{ display: "inline-flex", gap: 5 }}><Pill tone={STATE_TONE[r.state]}>{r.state}</Pill>{r.convertedOrderId && <Pill tone="success">order</Pill>}</span> },
            { key: "net", label: "Net", align: "right" as const, render: (r: QuoteRow) => (r.lineCount ? eur(r.netCents) : "—") },
            ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: QuoteRow) => (r.lineCount ? <Pill tone={r.marginCents < 0 ? "danger" : "success"}>{r.marginPct.toFixed(0)}%</Pill> : "—") }] : []),
            { key: "valid", label: "Valid until", render: (r: QuoteRow) => (r.validUntilAt ? new Date(r.validUntilAt).toLocaleDateString() : "—") },
            { key: "updated", label: "Updated", render: (r: QuoteRow) => new Date(r.updatedAt).toLocaleDateString() },
          ]}
          rows={data?.quotes ?? []}
          rowKey={(r: QuoteRow) => r.id}
          emptyState="No quotes yet — start one from an Inbox thread or with New quote."
        />
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title="New quote" size="sm" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!partyId || busy}>Create</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Who is this quote for?</div>
          <Listbox ariaLabel="Party" options={[{ value: "", label: "Choose a contact…" }, ...parties.map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` }))]} value={partyId} onChange={setPartyId} />
          {parties.length === 0 && <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>No contacts yet — create one from an Inbox thread first.</div>}
        </div>
      </Modal>
    </div>
  );
}

export function QuotesClient() {
  return <Suspense fallback={null}><PipelineInner /></Suspense>;
}
