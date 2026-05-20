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
  top: number
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

      // Anchor one edge of the panel to the matching edge of the
      // trigger; then clamp into the content bounds so the OPPOSITE
      // edge can't cross sidebar / right-of-viewport.
      let left = align === 'right' ? btn.right - targetW : btn.left
      left = Math.max(bounds.left + edgePad, Math.min(left, bounds.right - targetW - edgePad))

      const maxWidth = targetW < natW ? targetW : undefined

      // Vertical: open below; flip above when more room exists there.
      // maxHeight is derived from available viewport space (never from
      // the panel's own measured height) — same no-feedback principle.
      const spaceBelow = vpH - btn.bottom - offsetY - edgePad
      const spaceAbove = btn.top - offsetY - edgePad
      let top: number
      let maxHeight: number
      if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
        top = btn.bottom + offsetY
        maxHeight = Math.max(160, spaceBelow)
      } else {
        top = Math.max(edgePad, btn.top - offsetY - spaceAbove)
        maxHeight = Math.max(160, spaceAbove)
      }

      setCoords({ top, left, maxWidth, maxHeight })
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
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
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
