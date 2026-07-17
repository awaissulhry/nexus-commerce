/**
 * F1 — ⌘K palette skeleton (Nexus CommandPalette pattern, factory registry):
 * nav commands filtered by permission + live entity search against
 * /api/search (FTS5-backed since FS5 — same response shape, so this client
 * needed no change). Chords upgrade in a later cycle.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { apiJson } from "@/lib/api-client";
import { useAuth } from "@/lib/auth/client";
import { FACTORY_PAGES } from "@/lib/nav";

type Hit = { label: string; sublabel?: string; href: string };
type Group = { label: string; items: Hit[] };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { has, status } = useAuth();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    else {
      setQ("");
      setGroups([]);
      setCursor(0);
    }
  }, [open]);

  const navGroup = useMemo<Group>(
    () => ({
      label: "Go to",
      items: FACTORY_PAGES.filter((p) => has(p.permission))
        .filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase()))
        .map((p) => ({ label: p.label, sublabel: p.fp === "F1" ? undefined : p.fp, href: p.href })),
    }),
    [q, has],
  );

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setGroups([]);
      return;
    }
    const t = setTimeout(() => {
      apiJson<{ groups: Group[] }>(`/api/search?q=${encodeURIComponent(q)}`)
        .then((d) => setGroups(d.groups))
        .catch(() => setGroups([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const flat = useMemo(() => {
    const all = [navGroup, ...groups].filter((g) => g.items.length);
    return { all, items: all.flatMap((g) => g.items) };
  }, [navGroup, groups]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  if (status !== "authed" || !open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,28,38,.42)",
        zIndex: 60,
        display: "grid",
        justifyItems: "center",
        alignItems: "start",
        paddingTop: "14vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
        style={{
          width: 560,
          maxWidth: "calc(100vw - 40px)",
          background: "var(--h10-surface)",
          borderRadius: "var(--h10-radius-3xl)",
          boxShadow: "var(--h10-shadow-modal)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--h10-border-subtle)",
          }}
        >
          <Search size={16} style={{ color: "var(--h10-text-3)" }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, flat.items.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (e.key === "Enter" && flat.items[cursor]) go(flat.items[cursor].href);
            }}
            placeholder="Search pages, contacts, orders, quotes, materials…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              font: "inherit",
              fontSize: 14,
              background: "transparent",
              color: "var(--h10-text)",
            }}
          />
          <kbd className="h10-ds-kbd">esc</kbd>
        </div>
        <div style={{ maxHeight: 380, overflowY: "auto", padding: 8 }}>
          {flat.all.map((group) => (
            <div key={group.label}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--h10-text-3)",
                  padding: "8px 10px 4px",
                }}
              >
                {group.label}
              </div>
              {group.items.map((item) => {
                const idx = flat.items.indexOf(item);
                return (
                  <button
                    key={`${group.label}:${item.href}:${item.label}`}
                    type="button"
                    onClick={() => go(item.href)}
                    onMouseEnter={() => setCursor(idx)}
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      border: "none",
                      textAlign: "left",
                      cursor: "pointer",
                      font: "inherit",
                      fontSize: 13,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: idx === cursor ? "var(--h10-wash-primary)" : "transparent",
                      color: idx === cursor ? "var(--h10-primary)" : "var(--h10-text)",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{item.label}</span>
                    {item.sublabel && (
                      <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>{item.sublabel}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {q.trim().length >= 2 && flat.items.length === 0 && (
            <div style={{ padding: 16, fontSize: 13, color: "var(--h10-text-3)" }}>
              Nothing found for “{q}”.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
