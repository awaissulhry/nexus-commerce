/**
 * FP10 — the chart cards (recharts, already a dep). Each is a panel with a header
 * that drills to its source. Charts are mount-gated (recharts needs the DOM) and
 * degrade to a small note under too little data. Colours use theme tokens.
 */
"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { StageLead, ThroughputPoint } from "./types";

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
