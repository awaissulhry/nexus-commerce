'use client'

/**
 * Anchored popover primitive.
 *
 * Renders its children in a portal to document.body with `position:
 * fixed` so the panel always layers above any sidebar, sticky header,
 * or ancestor stacking context. The anchor button's bounding rect is
 * measured on open + on resize + on any (capture-phase) scroll so the
 * panel tracks the trigger when ancestors scroll.
 *
 * Use this instead of the older `<div className="relative">…<div
 * className="absolute right-0 top-full mt-1 z-X">` pattern — that
 * pattern is vulnerable to any ancestor that creates a stacking
 * context (sticky sidebar, transform, isolate, etc.) trapping the
 * panel below sibling chrome.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface AnchoredPopoverProps {
  /** Ref to the trigger element. Used to compute panel position. */
  anchorRef: RefObject<HTMLElement | null>
  /** Called when the user clicks outside or presses Escape. */
  onClose: () => void
  /** Which side of the anchor the panel right-edge aligns to. */
  align?: 'right' | 'left'
  /** Vertical pixel offset from the bottom of the anchor (default 4). */
  offsetY?: number
  /** Stacking layer above all app chrome. Default z-[1000]. */
  zClass?: string
  /** Optional ARIA role on the panel wrapper (default "dialog"). */
  role?: string
  /** Optional ARIA label on the panel wrapper. */
  ariaLabel?: string
  className?: string
  children: ReactNode
}

export function AnchoredPopover({
  anchorRef,
  onClose,
  align = 'right',
  offsetY = 4,
  zClass = 'z-[1000]',
  role = 'dialog',
  ariaLabel,
  className,
  children,
}: AnchoredPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left?: number; right?: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (align === 'right') {
        setCoords({ top: r.bottom + offsetY, right: window.innerWidth - r.right })
      } else {
        setCoords({ top: r.bottom + offsetY, left: r.left })
      }
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchorRef, align, offsetY])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: coords?.top ?? -9999,
        left: coords?.left,
        right: coords?.right,
        opacity: coords ? 1 : 0,
      }}
      className={[zClass, className ?? ''].filter(Boolean).join(' ')}
    >
      {children}
    </div>,
    document.body,
  )
}
