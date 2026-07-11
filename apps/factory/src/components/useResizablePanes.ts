/**
 * FS3 — useResizablePanes: the state half of the InboxClient resize pattern,
 * generalized to N sized panes (per-pane min/max/default + optional invert
 * for handles on a pane's leading edge), persisted under a caller-chosen
 * localStorage key, double-click reset via `reset`. Pure math lives in
 * src/lib/virtual/panes.ts (unit-tested); this hook only wires it to React
 * state + storage. Pair each sized pane with a <PaneHandle /> whose callbacks
 * come from `handleProps(i)`.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyPaneDelta,
  defaultWidths,
  loadPaneWidths,
  serializePaneWidths,
  type PaneDef,
} from "@/lib/virtual/panes";

export type { PaneDef } from "@/lib/virtual/panes";

export interface ResizablePanes {
  /** current width (px) per pane, in the order of `panes` */
  widths: number[];
  /** apply a pointer delta to pane `index` (clamped; invert-aware) */
  resize: (index: number, deltaX: number) => void;
  /** persist the current widths (call on drag end) */
  commit: () => void;
  /** restore every pane's default and persist */
  reset: () => void;
  /** the three PaneHandle callbacks for the handle that resizes pane `index` */
  handleProps: (index: number) => { onDelta: (deltaX: number) => void; onCommit: () => void; onReset: () => void };
}

export function useResizablePanes(storageKey: string, panes: PaneDef[]): ResizablePanes {
  const [widths, setWidths] = useState<number[]>(() => defaultWidths(panes));
  const widthsRef = useRef(widths);
  const panesRef = useRef(panes);
  panesRef.current = panes;

  // hydrate from storage after mount (SSR-safe, mirrors the InboxClient pattern)
  useEffect(() => {
    try {
      const loaded = loadPaneWidths(localStorage.getItem(storageKey), panesRef.current);
      widthsRef.current = loaded;
      setWidths(loaded);
    } catch {
      /* defaults stand */
    }
  }, [storageKey]);

  const commit = useCallback(() => {
    try {
      localStorage.setItem(storageKey, serializePaneWidths(widthsRef.current));
    } catch {
      /* private mode etc. — resizing still works for the session */
    }
  }, [storageKey]);

  const resize = useCallback((index: number, deltaX: number) => {
    widthsRef.current = applyPaneDelta(widthsRef.current, index, deltaX, panesRef.current);
    setWidths(widthsRef.current);
  }, []);

  const reset = useCallback(() => {
    widthsRef.current = defaultWidths(panesRef.current);
    setWidths(widthsRef.current);
    commit();
  }, [commit]);

  const handleProps = useCallback(
    (index: number) => ({
      onDelta: (deltaX: number) => resize(index, deltaX),
      onCommit: commit,
      onReset: reset,
    }),
    [resize, commit, reset],
  );

  return { widths, resize, commit, reset, handleProps };
}
