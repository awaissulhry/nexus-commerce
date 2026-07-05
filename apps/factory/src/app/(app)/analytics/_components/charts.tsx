/**
 * FP10 — the chart cards (recharts, already a dep). Each is a panel with a header
 * that drills to its source. Charts are mount-gated (recharts needs the DOM) and
 * degrade to a small note under too little data. Colours use theme tokens.
 */
"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { eur } from "@/design-system/lib/format";
import type { OnTime, StageLead, ThroughputPoint, WinLoss } from "./types";

const PRIMARY = "var(--h10-primary, #2f6fed)";
const DANGER = "var(--h10-danger, #d64545)";
const AXIS = "var(--h10-text-3, #8a94a6)";

function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

export function Panel({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  return (
    <div className="h10-ds-card" style={{ padding: 0, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 15px", borderBottom: "1px solid var(--h10-border-subtle)" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
        {href && <a href={href} style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-link)", display: "inline-flex", gap: 3, alignItems: "center", textDecoration: "none" }}>Open <ArrowUpRight size={12} /></a>}
      </div>
      <div style={{ padding: "14px 15px" }}>{children}</div>
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: "var(--h10-text-3)", padding: "20px 0", textAlign: "center" }}>{children}</div>;
}

const fmtMs = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);
const shortWeek = (k: string) => k.slice(5); // MM-DD
const eurShort = (cents: number) => { const v = cents / 100; return "€" + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)); };

export function ThroughputChart({ data }: { data: ThroughputPoint[] }) {
  const mounted = useMounted();
  if (data.length < 1) return <Note>No finished work yet — throughput appears as work orders complete.</Note>;
  if (!mounted) return <div style={{ height: 200 }} />;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
        <XAxis dataKey="weekKey" tickFormatter={shortWeek} tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: "var(--h10-border)" }} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--h10-surface-2)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--h10-border)" }} labelFormatter={(l) => `Week of ${l}`} />
        <Bar dataKey="count" name="Finished" fill={PRIMARY} radius={[4, 4, 0, 0]} maxBarSize={44} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LeadTimeChart({ data, bottleneckStage }: { data: StageLead[]; bottleneckStage: string | null }) {
  const mounted = useMounted();
  if (data.length < 1) return <Note>No completed stages yet.</Note>;
  if (!mounted) return <div style={{ height: Math.max(140, data.length * 42) }} />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 42)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
        <XAxis type="number" tickFormatter={fmtMs} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="stage" width={82} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--h10-surface-2)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--h10-border)" }} formatter={(v) => [fmtMs(Number(v)), "Median"]} />
        <Bar dataKey="medianMs" radius={[0, 4, 4, 0]} maxBarSize={26} label={{ position: "right", formatter: ((v: unknown) => fmtMs(Number(v))) as never, fontSize: 10.5, fill: "var(--h10-text-3)" }}>
          {data.map((d) => <Cell key={d.stage} fill={d.stage === bottleneckStage ? DANGER : PRIMARY} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal money bars (margin by customer / month / product). Cents in, € labels out. */
export function MarginBars({ data, blind }: { data: { label: string; cents?: number }[]; blind: boolean }) {
  const mounted = useMounted();
  if (blind) return <Note>Margin is hidden for your role.</Note>;
  const rows = data.filter((d) => d.cents != null).map((d) => ({ label: d.label, cents: d.cents as number })).slice(0, 8);
  if (rows.length < 1) return <Note>No margin yet.</Note>;
  if (!mounted) return <div style={{ height: Math.max(140, rows.length * 38) }} />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, rows.length * 38)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 0 }}>
        <XAxis type="number" tickFormatter={(v) => eurShort(Number(v))} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" width={104} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--h10-surface-2)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--h10-border)" }} formatter={(v) => [eur(Number(v)), "Margin"]} />
        <Bar dataKey="cents" fill={PRIMARY} radius={[0, 4, 4, 0]} maxBarSize={24} label={{ position: "right", formatter: ((v: unknown) => eurShort(Number(v))) as never, fontSize: 10, fill: "var(--h10-text-3)" }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function WinLossPanel({ w }: { w: WinLoss }) {
  const decided = w.won + w.lost;
  const maxReason = Math.max(1, ...w.byReason.map((r) => r.count));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: "var(--h10-primary, #2f6fed)" }}>{decided > 0 ? `${w.rate.toFixed(0)}%` : "—"}</div>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>won of decided</div>
      </div>
      <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
        <Tag tone="success">{w.won} won</Tag><Tag tone="danger">{w.lost} lost</Tag><Tag tone="neutral">{w.open} open</Tag>
      </div>
      {w.byReason.length > 0 && (
        <div>
          <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 6 }}>Why we lost</div>
          <div style={{ display: "grid", gap: 5 }}>
            {w.byReason.map((r) => (
              <div key={r.reason} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 96, color: "var(--h10-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.reason}</span>
                <span style={{ flex: 1, height: 8, background: "var(--h10-surface-2)", borderRadius: 6, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${(r.count / maxReason) * 100}%`, background: DANGER, borderRadius: 6 }} /></span>
                <span style={{ width: 20, textAlign: "right", color: "var(--h10-text-3)" }}>{r.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Tag({ tone, children }: { tone: "success" | "danger" | "neutral"; children: React.ReactNode }) {
  const c = tone === "success" ? "var(--h10-success-text, #1a7f37)" : tone === "danger" ? DANGER : "var(--h10-text-3)";
  return <span style={{ padding: "2px 9px", borderRadius: 20, border: `1px solid ${c}`, color: c, fontWeight: 600 }}>{children}</span>;
}

export function OnTimePanel({ o }: { o: OnTime }) {
  const settled = o.onTime + o.late;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: "var(--h10-primary, #2f6fed)" }}>{settled > 0 ? `${o.rate.toFixed(0)}%` : "—"}</div>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>shipped on time</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <Tag tone="success">{o.onTime} on time</Tag><Tag tone="danger">{o.late} late</Tag>{o.unknown > 0 && <Tag tone="neutral">{o.unknown} no promise date</Tag>}
      </div>
      {settled === 0 && <Note>No shipped orders with a promise date yet.</Note>}
    </div>
  );
}
