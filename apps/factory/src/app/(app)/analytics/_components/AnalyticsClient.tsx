/**
 * FP10.1 — the analytics shell: three LIVE counters for "what needs me now"
 * (SSE-fresh via use-factory-events), each drilling to its source page. The
 * charts (throughput / lead-time / on-time / margin / win-loss) land in FP10.2–4.
 * pages.analytics gates the whole page, so a worker never reaches it.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Inbox, FileText, Clock, AlertTriangle, Bookmark, Trash2 } from "lucide-react";
import { DateField, Menu, Modal, useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { Panel, ThroughputChart, LeadTimeChart, MarginBars, WinLossPanel, OnTimePanel } from "./charts";
import { type AnalyticsResponse, type Counters, type SavedViewRow } from "./types";

export function AnalyticsClient() {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const [counters, setCounters] = useState<Counters | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [views, setViews] = useState<SavedViewRow[]>([]);
  const [savingOpen, setSavingOpen] = useState(false);

  const loadCounters = useCallback(async () => {
    try { setCounters(await apiJson<Counters>("/api/analytics/counters")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  const loadData = useCallback(async () => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) qs.set("to", new Date(`${to}T23:59:59`).toISOString());
    try { setData(await apiJson<AnalyticsResponse>(`/api/analytics${qs.toString() ? `?${qs}` : ""}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast, from, to]);
  const loadViews = useCallback(async () => {
    try { setViews((await apiJson<{ views: SavedViewRow[] }>("/api/saved-views?page=analytics")).views); }
    catch { /* views are a nicety; ignore */ }
  }, []);
  useEffect(() => { void loadCounters(); void loadViews(); }, [loadCounters, loadViews]);
  useEffect(() => { void loadData(); }, [loadData]);
  // live: refresh when a thread, quote or order moves
  useFactoryEvents(["conversation.updated", "conversation.synced", "order.updated", "pricing.updated", "payment.recorded"], loadCounters);

  const applyView = (v: SavedViewRow) => { setFrom(v.config.from ?? ""); setTo(v.config.to ?? ""); };
  const deleteView = async (id: string) => { try { await apiJson(`/api/saved-views?id=${id}`, { method: "DELETE" }); void loadViews(); } catch (e) { toast((e as Error).message, "danger"); } };
  const saveView = async (name: string) => {
    try { await apiJson("/api/saved-views", { method: "POST", body: JSON.stringify({ page: "analytics", name, config: { from, to } }) }); setSavingOpen(false); void loadViews(); toast("View saved", "success"); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const ranged = !!(from || to);

  return (
    <div className="factory-page">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><BarChart3 size={18} /> Analytics</h1>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>The factory&apos;s rhythm — every number a decision, every panel a link to its source.</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--h10-text-3)" }}>From</span>
          <DateField ariaLabel="From date" value={from} onChange={setFrom} max={to || undefined} />
          <span style={{ fontSize: 12, color: "var(--h10-text-3)" }}>to</span>
          <DateField ariaLabel="To date" value={to} onChange={setTo} min={from || undefined} />
          {ranged && <button type="button" onClick={() => { setFrom(""); setTo(""); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--h10-text-link)" }}>Clear</button>}
          {views.length > 0 && <Menu align="right" label="Saved views" items={views.map((v) => ({ id: v.id, label: v.name, onSelect: () => applyView(v) }))} triggerProps={{ className: "h10-ds-btn" }} />}
          <Button onClick={() => setSavingOpen(true)}><Bookmark size={13} /> Save view</Button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <Counter href="/inbox" icon={<Inbox size={16} />} label="Unanswered threads" value={counters?.unansweredThreads} tone="warning" />
        <Counter href="/quotes" icon={<FileText size={16} />} label="Quotes awaiting approval" value={counters?.quotesAwaiting} tone="info" />
        <Counter href="/orders" icon={<Clock size={16} />} label="Overdue promises" value={counters?.overduePromises} tone="danger" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12, marginTop: 18 }}>
        <Panel title="Throughput — work orders finished / week" href="/production">
          <ThroughputChart data={data?.throughput ?? []} />
        </Panel>
        <Panel title="Stage lead time (median)" href="/production">
          <LeadTimeChart data={data?.leadTimes ?? []} bottleneckStage={data?.bottleneckStage ?? null} />
          {data?.bottleneckStage && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "var(--h10-danger)" }}>
              <AlertTriangle size={13} /> Bottleneck: <b>{data.bottleneckStage.toLowerCase()}</b> — the slowest stage on the floor.
            </div>
          )}
        </Panel>
        <Panel title="Margin by customer (actual)" href="/financials">
          <MarginBars blind={!canMargin} data={(data?.marginByParty ?? []).map((p) => ({ label: p.partyName, cents: p.actualMarginCents }))} />
        </Panel>
        <Panel title="Margin by month (actual)" href="/financials">
          <MarginBars blind={!canMargin} data={(data?.marginByMonth ?? []).map((m) => ({ label: m.monthKey, cents: m.actualMarginCents }))} />
        </Panel>
        <Panel title="Margin by product (estimate)" href="/products">
          <MarginBars blind={!canMargin} data={(data?.marginByProduct ?? []).map((p) => ({ label: p.product, cents: p.estMarginCents }))} />
        </Panel>
        <Panel title="On-time vs promise" href="/orders">
          {data ? <OnTimePanel o={data.onTime} /> : null}
        </Panel>
        <Panel title="Quote win / loss" href="/quotes">
          {data ? <WinLossPanel w={data.winLoss} /> : null}
        </Panel>
      </div>

      <SaveViewModal open={savingOpen} views={views} onClose={() => setSavingOpen(false)} onSave={saveView} onDelete={deleteView} onApply={(v) => { applyView(v); setSavingOpen(false); }} />
    </div>
  );
}

function SaveViewModal({ open, views, onClose, onSave, onDelete, onApply }: { open: boolean; views: SavedViewRow[]; onClose: () => void; onSave: (name: string) => void; onDelete: (id: string) => void; onApply: (v: SavedViewRow) => void }) {
  const [name, setName] = useState("");
  useEffect(() => { if (open) setName(""); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Saved views" size="sm" footer={<Button onClick={onClose}>Close</Button>}>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 4 }}>Save the current date range</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="View name" style={{ flex: 1, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" }} />
            <Button variant="primary" onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>Save</Button>
          </div>
        </div>
        {views.length > 0 && (
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 6 }}>Your views</div>
            <div style={{ display: "grid", gap: 5 }}>
              {views.map((v) => (
                <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, fontSize: 12.5 }}>
                  <button type="button" onClick={() => onApply(v)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--h10-text-link)", fontWeight: 600, flex: 1, textAlign: "left" }}>{v.name}</button>
                  <span style={{ color: "var(--h10-text-3)", fontSize: 11 }}>{v.config.from || "…"} → {v.config.to || "…"}</span>
                  <button type="button" onClick={() => onDelete(v.id)} aria-label="Delete view" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-3)", display: "grid", placeItems: "center" }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Counter({ href, icon, label, value, tone }: { href: string; icon: React.ReactNode; label: string; value?: number; tone: "warning" | "info" | "danger" }) {
  const accent = tone === "danger" ? "var(--h10-danger)" : tone === "warning" ? "var(--h10-warning-text, var(--h10-text))" : "var(--h10-text-link)";
  const alert = (value ?? 0) > 0;
  return (
    <a href={href} className="h10-ds-card" style={{ display: "block", textDecoration: "none", padding: "16px 18px", color: "var(--h10-text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 8 }}>{icon}<span>{label}</span></div>
      <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: alert ? accent : "var(--h10-text)" }}>{value ?? "—"}</div>
      <div style={{ fontSize: 11.5, color: "var(--h10-text-link)", marginTop: 6 }}>{value == null ? "" : alert ? "Open →" : "All clear"}</div>
    </a>
  );
}
