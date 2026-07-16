/**
 * FS3 — PaneHandle: the drag-to-resize separator extracted (verbatim
 * behavior) from the InboxClient 2026-07-10 resize fix, generalized so any
 * multi-pane workspace can use it with useResizablePanes. Pointer-capture
 * drag, double-click to reset, 6px hit zone with a 1px (3px while dragging)
 * h10-token rule. InboxClient itself still owns its local copy — the EPI
 * session swaps it over (registry).
 */
"use client";

import { useRef, useState } from "react";

export interface PaneHandleProps {
  /** horizontal pointer delta since the last event (px) */
  onDelta: (deltaX: number) => void;
  /** drag finished — persist the widths */
  onCommit: () => void;
  /** double-click — restore defaults */
  onReset: () => void;
  /** accessible name, e.g. "Resize conversation list" */
  label: string;
  /** EPI1.4 (additive) — Enter on the focused handle collapses/expands its pane */
  onToggle?: () => void;
}

/** EPI1.4 — keyboard step per APG window-splitter arrow press (px) */
const KEY_STEP = 24;
/** a delta the pane clamp turns into "all the way" (Home/End) */
const KEY_JUMP = 10000;

export function PaneHandle({ onDelta, onCommit, onReset, label, onToggle }: PaneHandleProps) {
  const drag = useRef<{ pointerId: number; lastX: number } | null>(null);
  const [active, setActive] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="fs3-pane-handle"
      tabIndex={0}
      onKeyDown={(e) => {
        // APG window-splitter grammar (additive, EPI1.4): ←/→ resize,
        // Home/End jump to min/max (the pane math clamps), Enter toggles.
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onDelta(e.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP);
          onCommit();
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          onDelta(e.key === "Home" ? -KEY_JUMP : KEY_JUMP);
          onCommit();
        } else if (e.key === "Enter" && onToggle) {
          e.preventDefault();
          onToggle();
        }
      }}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointerId: e.pointerId, lastX: e.clientX };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        const delta = e.clientX - drag.current.lastX;
        if (delta !== 0) {
          drag.current.lastX = e.clientX;
          onDelta(delta);
        }
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        drag.current = null;
        setActive(false);
        onCommit();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
        onCommit();
      }}
      onDoubleClick={onReset}
      style={{
        cursor: "col-resize",
        touchAction: "none",
        display: "flex",
        justifyContent: "center",
        background: "transparent",
      }}
    >
      <div
        style={{
          width: active ? 3 : 1,
          height: "100%",
          borderRadius: 2,
          background: active ? "var(--h10-primary)" : "var(--h10-border-subtle)",
          transition: "background 120ms",
        }}
      />
    </div>
  );
}
