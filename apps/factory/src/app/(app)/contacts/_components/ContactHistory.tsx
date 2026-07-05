/**
 * FP5.3 — the contact's whole relationship in one place: conversations, quotes
 * (won/lost), orders, and reviews — aggregated from the linked records, each
 * row deep-linked to the owning page. Read-only. Money shows only when the
 * payload carried it (grain-gated upstream).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { Star } from "lucide-react";
import { Card } from "@/design-system/components";
import { Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import type { ContactHistoryData } from "./types";

type SubTab = "conversations" | "quotes" | "orders" | "reviews";

function Row({ href, left, right }: { href?: string; left: React.ReactNode; right: React.ReactNode }) {
  const body = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 8px", borderBottom: "1px solid var(--h10-border-subtle)", borderRadius: 6 }} className={href ? "factory-timeline-row" : undefined}>
      <div style={{ minWidth: 0 }}>{left}</div>
      <div style={{ flex: "0 0 auto", display: "inline-flex", gap: 8, alignItems: "center" }}>{right}</div>
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>{body}</Link> : body;
}

const Empty = ({ what }: { what: string }) => <div style={{ fontSize: 12.5, color: "var(--h10-text-3)", padding: "10px 2px" }}>No {what} yet.</div>;

export function ContactHistory({ history }: { history?: ContactHistoryData }) {
  const [sub, setSub] = useState<SubTab>("conversations");
  const h = history ?? { conversations: [], quotes: [], orders: [], reviews: [] };
  const tabs: { id: SubTab; label: string; n: number }[] = [
    { id: "conversations", label: "Conversations", n: h.conversations.length },
    { id: "quotes", label: "Quotes", n: h.quotes.length },
    { id: "orders", label: "Orders", n: h.orders.length },
    { id: "reviews", label: "Reviews", n: h.reviews.length },
  ];

  return (
    <Card padded>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setSub(t.id)} style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, background: sub === t.id ? "var(--h10-primary)" : "transparent", color: sub === t.id ? "#fff" : "var(--h10-text-2)" }}>
            {t.label}{t.n ? <span style={{ marginLeft: 5, fontSize: 10.5, opacity: 0.85 }}>{t.n}</span> : null}
          </button>
        ))}
      </div>

      {sub === "conversations" && (h.conversations.length ? h.conversations.map((c) => (
        <Row key={c.id} href={`/inbox?focus=${c.id}`}
          left={<span style={{ fontSize: 13, fontWeight: 600 }}>{c.subject || "(no subject)"}</span>}
          right={<><Pill tone={c.state === "OPEN" ? "info" : "neutral"}>{c.state.toLowerCase()}</Pill><span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>{new Date(c.updatedAt).toLocaleDateString()}</span></>} />
      )) : <Empty what="conversations" />)}

      {sub === "quotes" && (h.quotes.length ? h.quotes.map((q) => (
        <Row key={q.id} href={`/quotes?q=${q.id}`}
          left={<span style={{ fontSize: 13, fontWeight: 700, color: "var(--h10-text-link)" }}>{q.number}</span>}
          right={<>{q.netCents != null && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 600 }}>{eur(q.netCents)}</span>}<Pill tone={q.state === "ACCEPTED" ? "success" : q.state === "REJECTED" ? "danger" : q.state === "SENT" ? "info" : "neutral"}>{q.state.toLowerCase()}</Pill></>} />
      )) : <Empty what="quotes" />)}

      {sub === "orders" && (h.orders.length ? h.orders.map((o) => (
        <Row key={o.id} href={`/orders?o=${o.id}`}
          left={<span style={{ fontSize: 13, fontWeight: 700, color: "var(--h10-text-link)" }}>{o.number}</span>}
          right={<>{o.netCents != null && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 600 }}>{eur(o.netCents)}</span>}<Pill tone={o.state === "DELIVERED" || o.state === "CLOSED" ? "success" : o.state === "CANCELLED" ? "danger" : "info"}>{o.state.replace("_", " ").toLowerCase()}</Pill></>} />
      )) : <Empty what="orders" />)}

      {sub === "reviews" && (h.reviews.length ? h.reviews.map((r) => (
        <Row key={r.id} href={r.orderId ? `/orders?o=${r.orderId}` : undefined}
          left={<span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span style={{ display: "inline-flex" }}>{Array.from({ length: 5 }, (_, i) => <Star key={i} size={13} fill={i < r.rating ? "var(--h10-warning, #e9a100)" : "none"} color={i < r.rating ? "var(--h10-warning, #e9a100)" : "var(--h10-border)"} />)}</span>{r.notes && <span style={{ fontSize: 12.5, color: "var(--h10-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 }}>{r.notes}</span>}</span>}
          right={<span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>{new Date(r.createdAt).toLocaleDateString()}</span>} />
      )) : <Empty what="reviews" />)}
    </Card>
  );
}
