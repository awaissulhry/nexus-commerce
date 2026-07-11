/**
 * FS3 — pure core of useResizablePanes (generalized from the InboxClient
 * 2026-07-10 resize fix): N sized panes, each with min/max/default, an
 * optional `invert` flag (a handle sitting LEFT of its pane: dragging right
 * shrinks it), localStorage persistence and reset. All math lives here so
 * clamp/persist/reset are unit-testable without a DOM.
 */

export interface PaneDef {
  /** narrowest the pane may get (px) */
  min: number;
  /** widest the pane may get (px) */
  max: number;
  /** width used before any saved value, and restored on reset (px) */
  defaultSize: number;
  /** handle sits on the pane's LEADING edge: +deltaX shrinks instead of grows */
  invert?: boolean;
}

export const clampPane = (v: number, def: PaneDef): number => Math.min(Math.max(v, def.min), def.max);

export const defaultWidths = (panes: PaneDef[]): number[] => panes.map((p) => clampPane(p.defaultSize, p));

/**
 * Parse a persisted JSON payload (array of numbers) back into clamped widths.
 * Anything malformed — bad JSON, wrong length, non-numeric entries — falls
 * back to the defaults so a stale key can never wedge the layout.
 */
export function loadPaneWidths(raw: string | null | undefined, panes: PaneDef[]): number[] {
  if (!raw) return defaultWidths(panes);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== panes.length) return defaultWidths(panes);
    return panes.map((def, i) => {
      const v = parsed[i];
      return typeof v === "number" && Number.isFinite(v) ? clampPane(v, def) : clampPane(def.defaultSize, def);
    });
  } catch {
    return defaultWidths(panes);
  }
}

export const serializePaneWidths = (widths: number[]): string => JSON.stringify(widths.map((w) => Math.round(w)));

/** Apply a pointer delta to one pane (respecting `invert`), clamped; others untouched. */
export function applyPaneDelta(widths: number[], index: number, deltaX: number, panes: PaneDef[]): number[] {
  const def = panes[index];
  if (!def) return widths;
  const next = widths.slice();
  next[index] = clampPane(widths[index] + (def.invert ? -deltaX : deltaX), def);
  return next;
}
