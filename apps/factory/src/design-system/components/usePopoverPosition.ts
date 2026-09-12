'use client'

import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

export interface PopoverPositionOptions {
  /**
   * `'anchor'` makes the trigger's width the panel's FLOOR — right for a select-like control. The
   * panel then grows to its longest label and is capped by `--nds-popover-max-w` (D18), so it is
   * `clamp(anchor, content, 320px)`, not a fixed copy of the trigger.
   * `'auto'` leaves width alone so the panel sizes to its content and its own CSS `min-width`;
   * right for a menu, whose trigger may be a 28px icon button.
   */
  width?: 'anchor' | 'auto'
  /** `'end'` aligns the panel's RIGHT edge to the anchor's, for a right-aligned menu */
  align?: 'start' | 'end'
  /** gap between anchor and panel */
  offset?: number
}

/**
 * Fixed-position coordinates for a panel portaled to `<body>`.
 *
 * WHY PORTAL AT ALL: an absolutely-positioned panel is clipped by any ancestor that scrolls or
 * hides overflow. Measured 2026-08-25 — `.nds-modal` is `overflow: hidden` and `.nds-modal-b` is
 * `overflow-y: auto`, so every DS dropdown opened inside a DS Modal was cut off at the dialog
 * edge, and the same happened inside every grid. `HoverCard` already portals for exactly this
 * reason; this puts the other four on the same footing instead of a fifth bespoke fix.
 *
 * Flips above the anchor only when there is no room below AND genuine room above — never into a
 * worse position. Horizontally it stays tied to its anchor: left-aligned by default, right-aligned
 * to the anchor when left-aligning would overflow, and clamped to the viewport only when neither
 * fits (D18). Re-measures on scroll (capturing, so inner scroll containers count) and on resize.
 */
export function usePopoverPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  options: PopoverPositionOptions = {},
) {
  const { width = 'anchor', align = 'start', offset = 4 } = options
  const popRef = useRef<HTMLDivElement>(null)
  // Off-screen until measured, so the panel never paints at the wrong place for one frame.
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: -9999, left: -9999 })

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect()
      if (!a) return
      const p = popRef.current?.getBoundingClientRect()
      const ph = p?.height ?? 0
      // 🔴 The clamp must use the width the panel will RENDER at. That was the 2026-09-01 bug: the
      // hook set `width: a.width` AFTER measuring, so `place()` clamped on the natural width and
      // then painted a narrower panel — measured 76.3px adrift on the studio's locale Listbox, and
      // only ever near the right edge, because that is the only place the clamp fires.
      // D18 — the panel is sized by CSS now, not by this hook: `'anchor'` mode emits `min-width`
      // (below) and the stylesheet caps it with `--nds-popover-max-w`, so the rendered width is
      // `clamp(anchor, content, 320)` and the browser computes it. That makes `p.width` the width
      // the panel will ACTUALLY have at the moment we measure it — which is exactly what the
      // earlier `width: a.width` broke, and why this clamp had to be told the anchor's width
      // instead. `Math.max` still guards the first frame, when the panel has no `min-width` yet
      // and may measure narrower than its anchor.
      const pw = width === 'anchor' ? Math.max(a.width, p?.width ?? 0) : (p?.width ?? a.width)
      const vw = window.innerWidth
      const vh = window.innerHeight
      const m = 8

      let top = a.bottom + offset
      // flip up only if there is genuinely more room there — otherwise stay put and let it scroll
      if (top + ph > vh - m && a.top - ph - offset > m) top = a.top - ph - offset

      // 🔴 HORIZONTAL PLACEMENT IS ANCHOR-PINNED, NOT WIDTH-DERIVED. A right-aligned panel used to
      // be placed as `left = a.right - pw`, which is only correct while `pw` equals the width the
      // panel finally renders at. D18 made the width content-driven (`min-width` + a CSS cap), so
      // `pw` became an ESTIMATE — and UX.1 measured the consequence within the hour: the locale
      // panel rendered 200px where the estimate said 210, its left edge unchanged and its right
      // edge 10px short of its trigger at all three widths. A width-only check passes that; only
      // the anchoring assertion catches it.
      // Pinning `right` to the anchor's right edge removes the dependency entirely: whatever the
      // panel ends up measuring, that edge is where it was asked to be. `pw` now only DECIDES the
      // branch, where being a few px out changes which alignment is chosen, never how well it
      // lands.
      const horizontal: CSSProperties =
        align === 'end'
          ? { right: Math.max(m, vw - a.right) }
          : a.left + pw <= vw - m
            ? { left: Math.max(m, a.left) }
            : a.right - pw >= m
              ? { right: Math.max(m, vw - a.right) }
              : { right: m }

      setStyle({
        position: 'fixed',
        top,
        ...horizontal,
        // 🔴 `minWidth`, never `width`. D18: the panel must be at least as wide as its trigger and
        // as wide as its longest label needs, capped by `--nds-popover-max-w`. A fixed `width`
        // made the panel ignore its own content — the Owner's "too long in a single cell" is the
        // same defect seen from the other end, a label clipped inside a box sized for something
        // else. `min-width` states the floor and lets the content and the cap do the rest.
        ...(width === 'anchor' ? { minWidth: a.width } : {}),
      })
    }
    place()
    // capture phase: a scroll inside a grid or a modal body does not bubble to window
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, width, align, offset])

  return { popRef, style }
}
