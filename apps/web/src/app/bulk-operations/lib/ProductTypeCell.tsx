// EE.2 — bulk-grid productType cell that dispatches to the shared
// ProductTypePicker (Amazon: list-once-filter, eBay: search-as-you-
// type). Falls back to read-only display when no marketplace tab is
// selected (the picker can't know which channel/marketplace scope to
// fetch under).

'use client'

import { useEffect, useRef, useState } from 'react'
import type { CellContext } from '@tanstack/react-table'
import { ChevronDown } from 'lucide-react'
import ProductTypePicker from '@/components/products/ProductTypePicker'
import { editCtxRef, primaryContextRef } from './refs'
import type { BulkProduct } from './types'

interface Props {
  ctx: CellContext<BulkProduct, unknown>
}

export function ProductTypeCell({ ctx }: Props) {
  const rowId = ctx.row.original.id
  const initialValue = (ctx.getValue() as string | null | undefined) ?? ''
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string>(initialValue)
  const containerRef = useRef<HTMLDivElement | null>(null)

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
      <span className="px-2 text-[12px] text-slate-700 truncate">
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
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-7 flex items-center justify-between gap-1 rounded-md border border-transparent hover:border-slate-200 hover:bg-white px-2 text-[12px] text-left"
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
      {open && (
        <div className="absolute left-0 top-full mt-1 w-[360px] z-50 bg-white border border-slate-200 rounded-md shadow-lg p-2">
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
