// EE.2 — bulk-grid productType cell that dispatches to the shared
// ProductTypePicker (Amazon: list-once-filter, eBay: search-as-you-
// type). Falls back to read-only display when no marketplace tab is
// selected (the picker can't know which channel/marketplace scope to
// fetch under).

'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CellContext } from '@tanstack/react-table'
import { ChevronDown } from 'lucide-react'
import ProductTypePicker from '@/components/products/ProductTypePicker'
import { editCtxRef, primaryContextRef } from './refs'
import type { BulkProduct } from './types'

// KK.2 — popover dimensions used for viewport-aware positioning so
// the picker doesn't overflow off-screen on rightmost or
// bottom-of-viewport cells.
const POPOVER_WIDTH = 360
const POPOVER_HEIGHT = 380
const POPOVER_GAP = 4

interface Props {
  ctx: CellContext<BulkProduct, unknown>
}

export function ProductTypeCell({ ctx }: Props) {
  const rowId = ctx.row.original.id
  const initialValue = (ctx.getValue() as string | null | undefined) ?? ''
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string>(initialValue)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // KK.2 — viewport-aware popover anchor. We render the popover with
  // position: fixed and explicit top/left so the picker can break out
  // of overflow:hidden ancestors AND we can clamp it inside the
  // viewport instead of relying on absolute left-0/top-full which
  // fails near the right + bottom edges of the screen.
  const [popoverPos, setPopoverPos] = useState<{
    top: number
    left: number
  } | null>(null)

  // Sync local draft when initialValue changes (e.g. after parent
  // updates products[] post-save).
  useEffect(() => {
    setDraft(initialValue)
  }, [initialValue])

  // Close on outside click while picker is open.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const c = containerRef.current
      if (c && e.target instanceof Node && !c.contains(e.target)) {
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // KK.2 — clamp popover inside the viewport whenever it opens or the
  // anchor moves (scroll/resize). useLayoutEffect so the position is
  // committed before paint to avoid a one-frame flicker.
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null)
      return
    }
    function reposition() {
      const btn = buttonRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Default: anchor below the button at its left edge.
      let top = r.bottom + POPOVER_GAP
      let left = r.left
      // Right overflow → align popover's right edge to button's right.
      if (left + POPOVER_WIDTH > vw - 8) {
        left = Math.max(8, r.right - POPOVER_WIDTH)
      }
      // Bottom overflow → flip above the button.
      if (top + POPOVER_HEIGHT > vh - 8) {
        const above = r.top - POPOVER_HEIGHT - POPOVER_GAP
        if (above >= 8) top = above
        else top = Math.max(8, vh - POPOVER_HEIGHT - 8)
      }
      setPopoverPos({ top, left })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const ctxScope = primaryContextRef.current
  const channel = ctxScope?.channel ?? 'AMAZON'
  const marketplace = ctxScope?.marketplace ?? null

  function commit(next: string) {
    setDraft(next)
    editCtxRef.current.onCommit(rowId, 'productType', next)
    setOpen(false)
  }

  // No marketplace tab selected: keep the cell read-only with a hint.
  if (!ctxScope) {
    return (
      <span className="px-2 text-base text-slate-700 truncate">
        {initialValue || (
          <span className="italic text-amber-600">
            Pick a marketplace tab to edit
          </span>
        )}
      </span>
    )
  }

  return (
    <div ref={containerRef} className="relative px-1.5 py-0.5">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-7 flex items-center justify-between gap-1 rounded-md border border-transparent hover:border-slate-200 hover:bg-white px-2 text-base text-left"
        title={`${channel}${marketplace ? ':' + marketplace : ''} category`}
      >
        <span className="truncate">
          {draft || (
            <span className="italic text-slate-400">
              {channel === 'EBAY' ? 'Pick eBay category…' : 'Pick productType…'}
            </span>
          )}
        </span>
        <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
      </button>
      {open && popoverPos && (
        <div
          style={{
            position: 'fixed',
            top: popoverPos.top,
            left: popoverPos.left,
            width: POPOVER_WIDTH,
            maxHeight: POPOVER_HEIGHT,
          }}
          className="z-50 bg-white border border-slate-200 rounded-md shadow-lg p-2 overflow-auto"
        >
          <ProductTypePicker
            channel={channel}
            marketplace={marketplace}
            value={draft}
            onChange={commit}
          />
        </div>
      )}
    </div>
  )
}
