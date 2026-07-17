/**
 * EPI3.3 — the views header row (§5.1): pills between the page header and the
 * panes. One active view scopes the list; counts are filter-honest (computed
 * server-side under the same state/mine/unmatched/q). Tab order = claim
 * priority; the active custom pill exposes a ▾ manage menu (edit / move /
 * delete). PointerMenu is the DS-gap context menu, composed on tokens.
 */
"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Plus, Settings2 } from "lucide-react";
import { Menu } from "@/design-system/components";
import type { InboxViewMeta } from "./types";

export function ViewsBar({
  views,
  inboxCount,
  activeViewId,
  onSelect,
  canManage,
  onNewView,
  onEditView,
  onMoveView,
  onDeleteView,
  onOpenRules,
}: {
  views: InboxViewMeta[];
  inboxCount: number | null;
  activeViewId: string | null;
  onSelect: (id: string | null) => void;
  canManage: boolean;
  onNewView: () => void;
  onEditView: (id: string) => void;
  onMoveView: (id: string, dir: -1 | 1) => void;
  onDeleteView: (id: string) => void;
  onOpenRules: () => void;
}) {
  if (views.length === 0 && !canManage) return null;

  const pill = (active: boolean, color?: string | null) =>
    ({
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      border: "1px solid " + (active ? "var(--h10-primary)" : "var(--h10-border)"),
      borderRadius: 999,
      padding: "4px 12px",
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer",
      background: active ? "var(--h10-primary)" : "var(--h10-surface)",
      color: active ? "#fff" : (color ?? "var(--h10-text-2)"),
      whiteSpace: "nowrap",
    }) as const;

  const count = (n: number, active: boolean) => (
    <span style={{ fontSize: 11.5, opacity: active ? 0.9 : 0.75 }}>{n}</span>
  );

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "0 2px 8px", overflowX: "auto" }}>
      <button type="button" onClick={() => onSelect(null)} style={pill(activeViewId === null)}>
        Inbox {inboxCount != null && count(inboxCount, activeViewId === null)}
      </button>
      {views.map((v, i) => {
        const active = v.id === activeViewId;
        return (
          <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              title={v.exclusive ? "Exclusive — claims its matches out of Inbox" : "Also shown in Inbox"}
              style={pill(active, v.color)}
            >
              {v.emoji ? `${v.emoji} ` : ""}
              {v.name} {count(v.count, active)}
            </button>
            {active && canManage && (
              <Menu
                label="▾"
                align="left"
                items={[
                  { id: "edit", label: "Edit view…", onSelect: () => onEditView(v.id) },
                  ...(i > 0 ? [{ id: "left", label: "Move left (claims earlier)", onSelect: () => onMoveView(v.id, -1) }] : []),
                  ...(i < views.length - 1 ? [{ id: "right", label: "Move right", onSelect: () => onMoveView(v.id, 1) }] : []),
                  { id: "delete", label: "Delete view…", onSelect: () => onDeleteView(v.id) },
                ]}
                triggerProps={{ "aria-label": `Manage view ${v.name}`, style: { padding: "2px 6px", fontSize: 11.5 } }}
              />
            )}
          </span>
        );
      })}
      {canManage && (
        <>
          <button type="button" onClick={onNewView} title="New view" aria-label="New view" style={{ ...pill(false), padding: "4px 8px" }}>
            <Plus size={13} />
          </button>
          <button type="button" onClick={onOpenRules} title="Rules" aria-label="Rules" style={{ ...pill(false), padding: "4px 8px", marginLeft: "auto" }}>
            <Settings2 size={13} /> Rules
          </button>
        </>
      )}
    </div>
  );
}

/** EPI3.3 — pointer-anchored context menu (DS gap: Menu is trigger-anchored). */
export function PointerMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: Math.min(x, typeof window !== "undefined" ? window.innerWidth - 240 : x),
        top: Math.min(y, typeof window !== "undefined" ? window.innerHeight - 200 : y),
        zIndex: 900,
        minWidth: 200,
        background: "var(--h10-surface)",
        border: "1px solid var(--h10-border)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(16,22,30,0.16)",
        padding: 4,
        display: "grid",
      }}
    >
      {children}
    </div>
  );
}

export function PointerMenuItem({ onSelect, children, danger }: { onSelect: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        textAlign: "left",
        background: "none",
        border: "none",
        cursor: "pointer",
        borderRadius: 7,
        padding: "7px 10px",
        fontSize: 12.5,
        color: danger ? "var(--h10-danger, #c4320a)" : "var(--h10-text)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--h10-surface-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
    >
      {children}
    </button>
  );
}
