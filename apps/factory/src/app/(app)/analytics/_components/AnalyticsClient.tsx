/**
 * FP10.1 — the analytics shell: three LIVE counters for "what needs me now"
 * (SSE-fresh via use-factory-events), each drilling to its source page. The
 * charts (throughput / lead-time / on-time / margin / win-loss) land in FP10.2–4.
 * pages.analytics gates the whole page, so a worker never reaches it.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Inbox, FileText, Clock, AlertTriangle } from "lucide-react";
import { useToast } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { Panel, ThroughputChart, LeadTimeChart } from "./charts";
import { type AnalyticsResponse, type Counters } from "./types";

export function AnalyticsClient() {
  const { toast } = useToast();
  const [counters, setCounters] = useState<Counters | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);

  const loadCounters = useCallback(async () => {
    try { setCounters(await apiJson<Counters>("/api/analytics/counters")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  const loadData = useCallback(async () => {
    try { setData(await apiJson<AnalyticsResponse>("/api/analytics")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void loadCounters(); void loadData(); }, [loadCounters, loadData]);
  // live: refresh when a thread, quote or order moves
  useFactoryEvents(["conversation.updated", "conversation.synced", "order.updated", "pricing.updated", "payment.recorded"], loadCounters);

  return (
    <div className="factory-page">
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><BarChart3 size={18} /> Analytics</h1>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>The factory&apos;s rhythm — every number a decision, every panel a link to its source.</div>
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
      </div>
    </div>
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
