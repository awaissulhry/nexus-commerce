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
 * The panel's NATURAL size (set by the consumer via className, e.g.
 * `w-[480px]`) is measured exactly once on first mount and cached in
 * a ref. Subsequent measures (resize / scroll) reuse the cached size
 * to compute position + clamp into the page content area — so the
 * panel keeps its requested width as long as it fits, and scrolling
 * never re-shrinks it. When the natural width would overflow the
 * content bounds, the panel shifts position (preferred) or shrinks
 * via maxWidth (fallback).
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface AnchoredPopoverProps {
  /** Ref to the trigger element. Used to compute panel position. */
  anchorRef: RefObject<HTMLElement | null>
  /** Called when the user clicks outside or presses Escape. */
  onClose: () => void
  /** Which edge of the panel aligns to the anchor. */
  align?: 'right' | 'left'
  /** Vertical pixel offset from the bottom of the anchor (default 4). */
  offsetY?: number
  /** Min distance the panel keeps from the page content edges (default 8). */
  edgePad?: number
  /** Stacking layer above all app chrome. Default z-[1000]. */
  zClass?: string
  /** Optional ARIA role on the panel wrapper (default "dialog"). */
  role?: string
  /** Optional ARIA label on the panel wrapper. */
  ariaLabel?: string
  className?: string
  children: ReactNode
}

interface Coords {
  /** One of top / bottom is set (CSS vertical anchor). */
  top?: number
  bottom?: number
  left: number
  maxWidth?: number
  maxHeight: number
}

const MAIN_ID = 'main-content'

function getContentBounds(): { left: number; right: number; top: number; bottom: number } {
  const main = typeof document !== 'undefined' ? document.getElementById(MAIN_ID) : null
  if (main) {
    const r = main.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }
  return {
    left: 0,
    right: typeof window !== 'undefined' ? window.innerWidth : 0,
    top: 0,
    bottom: typeof window !== 'undefined' ? window.innerHeight : 0,
  }
}

export function AnchoredPopover({
  anchorRef,
  onClose,
  align = 'right',
  offsetY = 4,
  edgePad = 8,
  zClass = 'z-[1000]',
  role = 'dialog',
  ariaLabel,
  className,
  children,
}: AnchoredPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  /** Natural width set by the consumer (e.g. w-[480px]). Measured ONCE
   *  on first paint before any maxWidth is applied, then frozen so
   *  scroll-driven re-measures can never shrink it. */
  const naturalWidth = useRef<number | null>(null)
  const [coords, setCoords] = useState<Coords | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return

      // Capture the panel's natural width on the first measurement,
      // BEFORE we've applied any maxWidth via coords. From then on we
      // never re-read it — so resize/scroll-triggered measures don't
      // create a shrinking feedback loop.
      if (naturalWidth.current == null) {
        naturalWidth.current = panel.offsetWidth
      }
      const natW = naturalWidth.current

      const btn = anchor.getBoundingClientRect()
      const bounds = getContentBounds()
      const vpH = typeof window !== 'undefined' ? window.innerHeight : 0

      // Available horizontal space inside the page content area.
      const availW = Math.max(0, bounds.right - bounds.left - edgePad * 2)
      const targetW = Math.min(natW, availW)

      const minLeft = bounds.left + edgePad
      const maxLeft = bounds.right - targetW - edgePad

      // Compute both alignment options. Pick the one that keeps the
      // panel adjacent to the trigger AND inside content bounds. The
      // `align` prop is a hint, not a hard rule — if it would overflow
      // (trigger near the opposite edge of the page), we auto-flip so
      // the panel still sits next to the button instead of drifting
      // to a clamp position somewhere far away.
      const rightAlignLeft = btn.right - targetW  // panel right edge sits at trigger right edge
      const leftAlignLeft = btn.left              // panel left edge sits at trigger left edge

      let left: number
      if (align === 'right') {
        left = rightAlignLeft >= minLeft ? rightAlignLeft : leftAlignLeft
      } else {
        left = leftAlignLeft <= maxLeft ? leftAlignLeft : rightAlignLeft
      }
      // Final clamp (catches the rare case where neither alignment
      // fits perfectly — e.g. trigger wider than the content area).
      left = Math.max(minLeft, Math.min(left, maxLeft))

      const maxWidth = targetW < natW ? targetW : undefined

      // Vertical: open below; flip above only when below is genuinely
      // too tight AND above has more room. When flipping, anchor the
      // panel's BOTTOM (via CSS `bottom`) so it sits right above the
      // trigger — measuring scrollHeight would re-create the feedback
      // loop, but CSS `bottom` lets the browser place the panel by its
      // natural height for free.
      const spaceBelow = vpH - btn.bottom - offsetY - edgePad
      const spaceAbove = btn.top - offsetY - edgePad
      let top: number | undefined
      let bottom: number | undefined
      let maxHeight: number
      if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
        top = btn.bottom + offsetY
        maxHeight = Math.max(160, spaceBelow)
      } else {
        bottom = vpH - btn.top + offsetY
        maxHeight = Math.max(160, spaceAbove)
      }

      setCoords({ top, bottom, left, maxWidth, maxHeight })
    }

    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchorRef, align, offsetY, edgePad])

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
        top: coords?.top,
        bottom: coords?.bottom,
        left: coords?.left ?? -9999,
        // First paint: off-screen until coords are measured.
        ...(!coords && { top: -9999 }),
        maxWidth: coords?.maxWidth,
        maxHeight: coords?.maxHeight,
        opacity: coords ? 1 : 0,
        zIndex: 1000,
      }}
      className={[zClass, className ?? ''].filter(Boolean).join(' ')}
    >
      {children}
    </div>,
    document.body,
  )
}
