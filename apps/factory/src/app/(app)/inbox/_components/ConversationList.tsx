/**
 * FP1.3 — conversation list: state tabs with live counts, Mine/Unmatched
 * filters, search, bulk bar, freshness line. Rows carry the party chip (or
 * "unmatched"), assignee, snooze/follow-up hints — status-words-as-UI.
 */
"use client";

import { AlarmClock, BellRing, CircleUserRound, Search } from "lucide-react";
import { BulkActionBar } from "@/design-system/patterns";
import { Button, Checkbox, Pill, Skeleton } from "@/design-system/primitives";
import { ago, type ListItem, type ListResponse } from "./types";

const TABS: { key: string; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "snoozed", label: "Snoozed" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

export function ConversationList({
  data,
  loading,
  state,
  setState,
  mine,
  setMine,
  unmatched,
  setUnmatched,
  q,
  setQ,
  focusId,
  cursorId,
  onOpen,
  selected,
  setSelected,
  onBulk,
  onLoadMore,
  busyBulk,
}: {
  data: ListResponse | null;
  loading: boolean;
  state: string;
  setState: (s: string) => void;
  mine: boolean;
  setMine: (v: boolean) => void;
  unmatched: boolean;
  setUnmatched: (v: boolean) => void;
  q: string;
  setQ: (v: string) => void;
  focusId: string | null;
  cursorId: string | null;
  onOpen: (id: string) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onBulk: (action: "close" | "open") => void;
  onLoadMore: () => void;
  busyBulk: boolean;
}) {
  const counts = data?.counts ?? {};
  const items = data?.items ?? [];
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div style={{ padding: "10px 12px 8px", display: "grid", gap: 8, borderBottom: "1px solid var(--h10-border-subtle)" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {TABS.map((t) => {
            const active = state === t.key;
            const count = t.key === "all" ? undefined : counts[t.key.toUpperCase()];
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setState(t.key)}
                style={{
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: "5px 10px",
                  borderRadius: 8,
                  background: active ? "var(--h10-primary)" : "transparent",
                  color: active ? "#fff" : "var(--h10-text-2)",
                }}
              >
                {t.label}
                {count != null && count > 0 && (
                  <span style={{ marginLeft: 5, fontSize: 10.5, opacity: 0.85 }}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flex: 1,
              border: "1px solid var(--h10-border)",
              borderRadius: 8,
              padding: "5px 8px",
              background: "var(--h10-surface)",
            }}
          >
            <Search size={13} style={{ color: "var(--h10-text-3)" }} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search sender, subject, contact…"
              style={{ border: "none", outline: "none", flex: 1, font: "12.5px var(--font-sans), sans-serif", background: "transparent", color: "var(--h10-text)" }}
            />
          </span>
          <button
            type="button"
            onClick={() => setMine(!mine)}
            title="Assigned to me"
            style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "4px 8px", fontSize: 11.5, cursor: "pointer", background: mine ? "var(--h10-primary-soft, var(--h10-wash-primary))" : "var(--h10-surface)", color: mine ? "var(--h10-primary)" : "var(--h10-text-2)" }}
          >
            Mine
          </button>
          <button
            type="button"
            onClick={() => setUnmatched(!unmatched)}
            title="Threads without a matched contact"
            style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "4px 8px", fontSize: 11.5, cursor: "pointer", background: unmatched ? "var(--h10-primary-soft, var(--h10-wash-primary))" : "var(--h10-surface)", color: unmatched ? "var(--h10-primary)" : "var(--h10-text-2)" }}
          >
            Unmatched
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && !items.length ? (
          <div style={{ padding: 12, display: "grid", gap: 10 }}>
            <Skeleton /> <Skeleton /> <Skeleton /> <Skeleton />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 24, fontSize: 12.5, color: "var(--h10-text-3)", textAlign: "center" }}>
            {q || mine || unmatched ? "Nothing matches these filters." : "Synced and quiet — new mail lands here within ~10s."}
          </div>
        ) : (
          items.map((item: ListItem) => {
            const last = item.messages[0];
            const isFocus = item.id === focusId;
            const isCursor = item.id === cursorId;
            return (
              <div
                key={item.id}
                onClick={() => onOpen(item.id)}
                data-row={item.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 8,
                  padding: "9px 12px",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--h10-border-subtle)",
                  background: isFocus ? "var(--h10-wash-primary)" : isCursor ? "var(--h10-surface-hover)" : "transparent",
                  boxShadow: isCursor ? "inset 2px 0 0 var(--h10-primary)" : undefined,
                }}
              >
                <span onClick={(e) => e.stopPropagation()} style={{ paddingTop: 2 }}>
                  <Checkbox checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label="Select conversation" />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <b style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {item.subject ?? "(no subject)"}
                    </b>
                    <span style={{ fontSize: 10.5, color: "var(--h10-text-3)", flexShrink: 0 }}>{ago(item.lastMessageAt)}</span>
                  </span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--h10-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {last?.direction === "OUTBOUND" ? "You: " : ""}
                    {last?.snippet ?? last?.fromAddress ?? ""}
                  </span>
                  <span style={{ display: "flex", gap: 5, marginTop: 3, alignItems: "center", flexWrap: "wrap" }}>
                    {item.party ? (
                      <Pill tone="info">{item.party.name}</Pill>
                    ) : (
                      <Pill tone="neutral">unmatched</Pill>
                    )}
                    {item.assignee && (
                      <span style={{ fontSize: 10.5, color: "var(--h10-text-3)", display: "inline-flex", gap: 3, alignItems: "center" }}>
                        <CircleUserRound size={11} /> {item.assignee.displayName}
                      </span>
                    )}
                    {item.snoozeUntil && (
                      <span style={{ fontSize: 10.5, color: "var(--h10-warning, #b87503)", display: "inline-flex", gap: 3, alignItems: "center" }}>
                        <AlarmClock size={11} /> {new Date(item.snoozeUntil).toLocaleDateString()}
                      </span>
                    )}
                    {item.followUpAt && (
                      <span style={{ fontSize: 10.5, color: "var(--h10-text-3)", display: "inline-flex", gap: 3, alignItems: "center" }}>
                        <BellRing size={11} /> follow-up {new Date(item.followUpAt).toLocaleDateString()}
                      </span>
                    )}
                  </span>
                </span>
              </div>
            );
          })
        )}
        {data?.nextCursor && (
          <div style={{ padding: 10, textAlign: "center" }}>
            <Button onClick={onLoadMore}>Load more</Button>
          </div>
        )}
      </div>

      <div style={{ padding: "6px 12px", borderTop: "1px solid var(--h10-border-subtle)", fontSize: 11, color: "var(--h10-text-3)" }}>
        {data?.sync?.status === "connected"
          ? `Mail synced ${ago(data.sync.lastSyncAt)} ago · label ${data.sync.labelName ?? "—"}`
          : "Gmail not connected — Settings › Integrations"}
      </div>

      {selected.size > 0 && (
        <BulkActionBar count={selected.size} noun="conversation" onClear={() => setSelected(new Set())}>
          <Button onClick={() => onBulk("close")} disabled={busyBulk}>
            Close
          </Button>
          <Button onClick={() => onBulk("open")} disabled={busyBulk}>
            Reopen
          </Button>
        </BulkActionBar>
      )}
    </div>
  );
}
