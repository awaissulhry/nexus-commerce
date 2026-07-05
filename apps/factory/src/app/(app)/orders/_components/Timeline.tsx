/**
 * FP4 — the ONE-TIMELINE render: the job's whole life top-to-bottom. Each row
 * deep-links to its source. Money shows only when the payload carried it
 * (grain-gated upstream). Presentational; no fetching.
 */
"use client";

import Link from "next/link";
import { Mail, FileText, Send, CheckCircle2, ClipboardCheck, Euro, Hammer, ArrowRight, Truck, Star, type LucideIcon } from "lucide-react";
import { eur } from "@/design-system/lib/format";
import type { TimelineEvent } from "./types";

const ICON: Record<TimelineEvent["kind"], LucideIcon> = {
  email: Mail,
  quote: FileText,
  "quote-sent": Send,
  "quote-accepted": CheckCircle2,
  order: ClipboardCheck,
  payment: Euro,
  workorder: Hammer,
  transition: ArrowRight,
  shipment: Truck,
  review: Star,
};

const TONE: Partial<Record<TimelineEvent["kind"], string>> = {
  order: "var(--h10-primary)",
  payment: "var(--h10-success)",
  "quote-accepted": "var(--h10-success)",
  workorder: "var(--h10-warning)",
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return <div style={{ fontSize: 13, color: "var(--h10-text-3)" }}>No activity yet.</div>;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: 13, top: 6, bottom: 6, width: 2, background: "var(--h10-border-subtle)" }} />
      <div style={{ display: "grid", gap: 2 }}>
        {events.map((e, i) => {
          const Icon = ICON[e.kind] ?? ClipboardCheck;
          const color = TONE[e.kind] ?? "var(--h10-text-3)";
          const body = (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "8px 0", position: "relative" }}>
              <div style={{ width: 28, height: 28, borderRadius: 999, background: "var(--h10-surface)", border: "1px solid var(--h10-border-subtle)", display: "grid", placeItems: "center", color, flex: "0 0 auto", zIndex: 1 }}>
                <Icon size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--h10-text)" }}>
                  {e.label}
                  {e.amountCents != null && <span style={{ marginLeft: 8, fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{eur(e.amountCents)}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginTop: 1 }}>{new Date(e.at).toLocaleString()}</div>
              </div>
            </div>
          );
          return e.href ? (
            <Link key={i} href={e.href} style={{ textDecoration: "none", color: "inherit", borderRadius: 8 }} className="factory-timeline-row">{body}</Link>
          ) : (
            <div key={i}>{body}</div>
          );
        })}
      </div>
    </div>
  );
}
