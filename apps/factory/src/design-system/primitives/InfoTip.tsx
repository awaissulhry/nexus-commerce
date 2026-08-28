'use client'

/**
 * W6 (2026-08-20) — PROMOTED into the design system from
 * `app/marketing/ads/campaigns/InfoTip.tsx`, verbatim: 27 files across the ads console already
 * import it by relative path (the old path re-exports this one, so none of them changed), and it
 * is the only tooltip in the app that survives a scrolling container — the DS `Tooltip` and
 * `HoverCard` are CSS-positioned and clip at any `overflow: auto` pane edge.
 *
 * Styles: `.h10-tip` / `.h10-tipwrap` live in `design-system/styles/primitives.css` (moved from
 * `ads.css`, which now loads primitives.css tree-wide from the ads layout). Page-contextual icon
 * colouring stays where the context is — e.g. `.h10-am-fpanel .ffield > span .info` in ads.css.
 *
 * 🔴 House rules this component already embodies — keep them on any edit:
 *   · the cursor NEVER changes on hover ([[feedback_no_help_cursor]] — the question-mark cursor
 *     is banned repo-wide, ratcheted at zero);
 *   · portal to document.body, position: fixed, measured + viewport-clamped (flips top/bottom,
 *     arrow tracks the icon via --ax) — CSS positioning is what it exists to avoid;
 *   · with `children` it wraps an existing control and must NOT add a second tab stop or a
 *     second accessible name.
 */
import { useState, useRef, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

export function InfoTip({ tip, size = 12, children }: { tip: string; size?: number; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const iconRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'top' | 'bottom'; ax: number }>(
    { left: -9999, top: -9999, placement: 'top', ax: 0 },
  )

  useLayoutEffect(() => {
    if (!open || !iconRef.current || !tipRef.current) return
    const ir = iconRef.current.getBoundingClientRect()
    const tr = tipRef.current.getBoundingClientRect()
    const pad = 8, gap = 8
    const vw = window.innerWidth, vh = window.innerHeight
    const iconCx = ir.left + ir.width / 2
    let left = iconCx - tr.width / 2
    left = Math.max(pad, Math.min(left, vw - tr.width - pad))
    const fitsTop = ir.top - gap - tr.height >= pad
    const fitsBottom = ir.bottom + gap + tr.height <= vh - pad
    const placement: 'top' | 'bottom' = fitsTop || !fitsBottom ? 'top' : 'bottom'
    const top = placement === 'top' ? ir.top - gap - tr.height : ir.bottom + gap
    const ax = Math.max(10, Math.min(iconCx - left, tr.width - 10))
    setPos({ left, top, placement, ax })
  }, [open, tip])

  return (
    <span
      ref={iconRef}
      className={children ? 'h10-tipwrap' : 'info'}
      // A wrapped control is already focusable and already labelled; adding a
      // second tab stop and a second accessible name would double both.
      tabIndex={children ? undefined : 0}
      aria-label={children ? undefined : tip}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children ?? <Info size={size} />}
      {open && typeof document !== 'undefined' && createPortal(
        <span
          ref={tipRef}
          className={`h10-tip ${pos.placement}`}
          role="tooltip"
          style={{ left: pos.left, top: pos.top, '--ax': `${pos.ax}px` } as React.CSSProperties}
        >
          {tip}
        </span>,
        document.body,
      )}
    </span>
  )
}
