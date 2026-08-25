'use client'

import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

export interface PopoverPositionOptions {
  /**
   * `'anchor'` sizes the panel to its trigger — right for a select-like control.
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
 * Flips above the anchor when there is no room below, and clamps horizontally to the viewport.
 * Re-measures on scroll (capturing, so inner scroll containers count) and on resize.
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
      const pw = width === 'anchor' ? Math.max(a.width, p?.width ?? 0) : (p?.width ?? a.width)
      const vw = window.innerWidth
      const vh = window.innerHeight
      const m = 8

      let top = a.bottom + offset
      // flip up only if there is genuinely more room there — otherwise stay put and let it scroll
      if (top + ph > vh - m && a.top - ph - offset > m) top = a.top - ph - offset

      let left = align === 'end' ? a.right - pw : a.left
      if (left + pw > vw - m) left = vw - m - pw
      if (left < m) left = m

      setStyle({
        position: 'fixed',
        top,
        left,
        // `width` (not `min-width`) so the panel tracks its trigger; the panel's own CSS
        // `min-width` still clamps it, which is how a narrow trigger keeps a usable panel.
        ...(width === 'anchor' ? { width: a.width } : {}),
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
