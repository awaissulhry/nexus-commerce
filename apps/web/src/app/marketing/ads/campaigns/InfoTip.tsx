'use client'

import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

// Adaptive, portal-rendered info tooltip. Rendered into document.body so it
// escapes the ads shell's left-rail stacking context and `.h10-main`'s overflow
// clip — it always layers ABOVE the sidebar and never hides behind it. Position
// is measured at runtime and clamped into the viewport (flips above/below by
// available room; the arrow tracks the icon even when the bubble is shifted).
export function InfoTip({ tip, size = 12 }: { tip: string; size?: number }) {
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
      className="info"
      tabIndex={0}
      aria-label={tip}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <Info size={size} />
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
