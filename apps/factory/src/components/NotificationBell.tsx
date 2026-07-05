/**
 * F1 — notification bell (rail footer): unread count + drawer list, marked
 * read on open. SSE-refreshed via the events hook; polling fallback inside
 * the hook. Kinds: MENTION / ASSIGNMENT / STATE_CHANGE / REMINDER / SYSTEM.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Drawer } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";

type Item = {
  id: string;
  kind: string;
  title: string;
  body?: string | null;
  href?: string | null;
  readAt?: string | null;
  createdAt: string;
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ items: Item[]; unread: number }>("/api/notifications?limit=30");
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      /* notifications API unavailable — bell stays quiet */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useFactoryEvents(["notification.created"], load);

  const openDrawer = async () => {
    setOpen(true);
    await load();
    const unreadIds = items.filter((i) => !i.readAt).map((i) => i.id);
    if (unread > 0) {
      void apiJson("/api/notifications/mark-read", {
        method: "POST",
        body: JSON.stringify({ ids: unreadIds.length ? unreadIds : "all" }),
      })
        .then(load)
        .catch(() => {});
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openDrawer()}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        style={{
          position: "relative",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--h10-rail-icon)",
          display: "inline-flex",
          padding: 2,
        }}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -6,
              minWidth: 14,
              height: 14,
              borderRadius: 7,
              background: "var(--h10-danger)",
              color: "#fff",
              fontSize: 9,
              fontWeight: 800,
              display: "grid",
              placeItems: "center",
              padding: "0 3px",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Notifications">
        {items.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--h10-text-3)", padding: 8 }}>
            Nothing yet. Mentions, assignments and state changes land here.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {items.map((i) => (
              <a
                key={i.id}
                href={i.href ?? "#"}
                style={{
                  border: "1px solid var(--h10-border-subtle)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  background: i.readAt ? "var(--h10-surface)" : "var(--h10-wash-primary)",
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{i.title}</div>
                {i.body && <div style={{ fontSize: 12, color: "var(--h10-text-2)" }}>{i.body}</div>}
                <div style={{ fontSize: 10.5, color: "var(--h10-text-3)", marginTop: 2 }}>
                  {new Date(i.createdAt).toLocaleString()}
                </div>
              </a>
            ))}
          </div>
        )}
      </Drawer>
    </>
  );
}
