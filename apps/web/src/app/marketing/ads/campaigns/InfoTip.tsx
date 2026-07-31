'use client'

import { useState, useRef, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

// Adaptive, portal-rendered info tooltip. Rendered into document.body so it
// escapes the ads shell's left-rail stacking context and `.h10-main`'s overflow
// clip — it always layers ABOVE the sidebar and never hides behind it. Position
// is measured at runtime and clamped into the viewport (flips above/below by
// available room; the arrow tracks the icon even when the bubble is shifted).
/**
 * `children` turns this into a tooltip for an EXISTING control (an icon button,
 * a chip) instead of an ⓘ icon of its own.
 *
 * That matters here specifically: the review tables scroll inside
 * `overflow: auto` panes, and a CSS-positioned tooltip — the DS `Tooltip` and
 * `HoverCard` are both CSS-positioned — gets clipped at the pane edge. This one
 * renders into `document.body`, so it is the only tooltip in the app that can be
 * trusted inside a scrolling container.
 */
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
