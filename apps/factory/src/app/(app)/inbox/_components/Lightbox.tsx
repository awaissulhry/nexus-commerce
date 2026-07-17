/**
 * EPI2.2 — the attachment lightbox (BEAT verdict: Front has none). One fixed
 * overlay for every file in the conversation: images with zoom/pan/fit,
 * PDFs in the browser's native viewer via the ?inline=1 route, everything
 * else as a metadata card. Esc resets zoom BEFORE closing and never
 * navigates the app (Linear's lesson); ←/→ walk the whole conversation's
 * files; focus is trapped and restored to the trigger on close.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, File as FileIcon, HardDriveUpload, Minus, Plus, X } from "lucide-react";
import { useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { previewKind } from "@/lib/inbox/preview";

export type LightboxItem = {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webViewLink: string | null;
};

const kb = (n: number | null) => (n == null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function Lightbox({
  items,
  activeId,
  conversationId,
  onNavigate,
  onClose,
}: {
  items: LightboxItem[];
  activeId: string;
  conversationId: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const idx = Math.max(0, items.findIndex((i) => i.id === activeId));
  const item = items[idx];
  const kind = previewKind(item?.mimeType);
  const inlineUrl = item ? `/api/inbox/${conversationId}/attachments/${item.id}?inline=1` : "";
  const downloadUrl = item ? `/api/inbox/${conversationId}/attachments/${item.id}` : "";

  // zoom state resets per item
  useEffect(() => {
    setFit(true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [activeId]);

  // focus trap in, restore out
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    setFit(false);
    setZoom((z) => {
      const i = ZOOM_STEPS.findIndex((s) => s >= z - 0.001);
      const next = ZOOM_STEPS[Math.min(Math.max((i < 0 ? 3 : i) + dir, 0), ZOOM_STEPS.length - 1)];
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const nav = useCallback(
    (dir: 1 | -1) => {
      if (items.length < 2) return;
      onNavigate(items[(idx + dir + items.length) % items.length].id);
    },
    [items, idx, onNavigate],
  );

  const saveToDrive = async () => {
    if (!item || item.webViewLink) return;
    setSaving(true);
    try {
      await apiJson(`/api/inbox/${conversationId}/attachments/${item.id}/save-to-drive`, { method: "POST" });
      toast("Saved to Drive", "success");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Linear's lesson: Esc un-zooms first, closes second, never navigates.
      if (kind === "image" && !fit) {
        setFit(true);
        setZoom(1);
        setPan({ x: 0, y: 0 });
      } else onClose();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      nav(e.key === "ArrowRight" ? 1 : -1);
    } else if (kind === "image" && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      e.stopPropagation();
      step(1);
    } else if (kind === "image" && e.key === "-") {
      e.preventDefault();
      e.stopPropagation();
      step(-1);
    } else if (kind === "image" && e.key === "0") {
      e.preventDefault();
      e.stopPropagation();
      setFit(true);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else if (kind === "image" && e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      setFit((f) => {
        if (f) setZoom(1);
        else {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
        return !f;
      });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(downloadUrl);
    } else if (e.key === "Tab") {
      // minimal trap: keep focus inside the dialog
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>("button, a[href]");
      if (!focusables?.length) return;
      const list = [...focusables];
      const active = document.activeElement as HTMLElement;
      const i = list.indexOf(active);
      if (e.shiftKey && (i <= 0 || active === dialogRef.current)) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && i === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    } else {
      // swallow everything else so the workspace grammar (j/k/e/s…) is inert
      e.stopPropagation();
    }
  };

  if (!item) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={item.filename}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(12, 16, 22, 0.88)", display: "grid", gridTemplateRows: "auto 1fr auto", outline: "none" }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", color: "#fff" }}>
        <b style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{item.filename}</b>
        <span style={{ fontSize: 11.5, opacity: 0.75, flexShrink: 0 }}>
          {idx + 1} of {items.length} · {kb(item.sizeBytes)}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          {item.webViewLink ? (
            <a href={item.webViewLink} target="_blank" rel="noopener noreferrer" style={{ color: "#9ec5ff", fontSize: 11.5, display: "inline-flex", gap: 4, alignItems: "center" }}>
              <HardDriveUpload size={13} /> in Drive
            </a>
          ) : (
            <Button onClick={() => void saveToDrive()} disabled={saving}>
              <HardDriveUpload size={13} /> {saving ? "Saving…" : "Drive"}
            </Button>
          )}
          <a href={downloadUrl} title="Download (⌘S)" style={{ color: "#fff", display: "inline-flex", padding: 6 }}>
            <Download size={15} />
          </a>
          <a href={inlineUrl || downloadUrl} target="_blank" rel="noopener noreferrer" title="Open in new tab" style={{ color: "#fff", display: "inline-flex", padding: 6 }}>
            <ExternalLink size={15} />
          </a>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", padding: 6, display: "inline-flex" }}>
            <X size={16} />
          </button>
        </span>
      </div>

      <div
        style={{ position: "relative", display: "grid", placeItems: "center", overflow: "hidden", minHeight: 0 }}
        onPointerDown={(e) => {
          if (kind !== "image" || fit) return;
          drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {items.length > 1 && (
          <button type="button" aria-label="Previous" onClick={() => nav(-1)} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", background: "rgba(255,255,255,0.12)", border: "none", borderRadius: 999, color: "#fff", cursor: "pointer", padding: 8, display: "inline-flex" }}>
            <ChevronLeft size={18} />
          </button>
        )}
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={inlineUrl}
            alt={item.filename}
            onClick={() => {
              setFit((f) => !f);
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            style={{
              maxWidth: fit ? "92%" : "none",
              maxHeight: fit ? "92%" : "none",
              transform: fit ? undefined : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              cursor: fit ? "zoom-in" : drag.current ? "grabbing" : "grab",
              userSelect: "none",
              borderRadius: 4,
            }}
            draggable={false}
          />
        ) : kind === "pdf" ? (
          <iframe title={item.filename} src={inlineUrl} style={{ width: "88%", height: "94%", border: "none", borderRadius: 8, background: "#fff" }} />
        ) : (
          <div style={{ background: "var(--h10-surface)", borderRadius: 12, padding: "22px 28px", display: "grid", gap: 10, justifyItems: "center", maxWidth: 420 }}>
            <FileIcon size={28} style={{ color: "var(--h10-text-3)" }} />
            <b style={{ fontSize: 13, wordBreak: "break-all", textAlign: "center" }}>{item.filename}</b>
            <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>
              {item.mimeType ?? "unknown type"} · {kb(item.sizeBytes)} — no in-app preview for this type
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              <Button variant="primary" onClick={() => window.location.assign(downloadUrl)}>
                <Download size={13} /> Download
              </Button>
              {!item.webViewLink && (
                <Button onClick={() => void saveToDrive()} disabled={saving}>
                  <HardDriveUpload size={13} /> {saving ? "Saving…" : "Save to Drive"}
                </Button>
              )}
            </span>
          </div>
        )}
        {items.length > 1 && (
          <button type="button" aria-label="Next" onClick={() => nav(1)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "rgba(255,255,255,0.12)", border: "none", borderRadius: 999, color: "#fff", cursor: "pointer", padding: 8, display: "inline-flex" }}>
            <ChevronRight size={18} />
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", padding: "10px 16px", color: "#fff", minHeight: 40 }}>
        {kind === "image" && (
          <>
            <button type="button" aria-label="Zoom out" onClick={() => step(-1)} style={{ background: "rgba(255,255,255,0.12)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: 5, display: "inline-flex" }}>
              <Minus size={13} />
            </button>
            <span style={{ fontSize: 11.5, minWidth: 44, textAlign: "center" }}>{fit ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
            <button type="button" aria-label="Zoom in" onClick={() => step(1)} style={{ background: "rgba(255,255,255,0.12)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: 5, display: "inline-flex" }}>
              <Plus size={13} />
            </button>
            <span style={{ fontSize: 11.5, opacity: 0.6, marginLeft: 10 }}>click or space: fit ↔ 100% · 0 fit · Esc {fit ? "close" : "un-zoom"} · ←→ files</span>
          </>
        )}
      </div>
    </div>
  );
}
