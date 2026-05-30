'use client'

/**
 * useColumnResize — drag-to-resize + localStorage-persisted column widths for
 * plain <table> elements.
 *
 * Mirrors the UX of the shared VirtualizedGrid (grid-lens) column resizing —
 * a thin draggable handle on the right edge of each <th>, live drag, min-width
 * guard, widths persisted per surface under a distinct storageKey — but is
 * self-contained so it can be dropped onto any `<table>` (e.g. the Amazon Ads
 * cockpit tables) without the grid-lens div-grid machinery.
 *
 * Usage:
 *   const { thProps, ResizeHandle } = useColumnResize('ads:campaign:targeting', ['target', 'match', 'bid'])
 *   <th {...thProps('target')} className="text-left px-3 py-2">Target<ResizeHandle col="target" /></th>
 *
 * - `thProps(key)` returns `style` (width + minWidth + position:relative) so the
 *   <th> sizes to the stored/fallback width and can host the absolute handle.
 * - `<ResizeHandle col={key} />` renders the draggable border grip. It lives
 *   inside the <th>, on the right edge — it never overlaps the <td> cells, so
 *   inline bid <input>s and pause/enable <button>s in the body stay clickable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const MIN_WIDTH = 60
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 120

export interface UseColumnResize {
  /** Current widths keyed by column key (px). */
  widths: Record<string, number>
  /** Spread onto each <th>: applies the width + makes it a positioning context. */
  thProps: (key: string) => {
    style: React.CSSProperties
    'data-col': string
  }
  /** Begin a drag programmatically (used internally by ResizeHandle). */
  startResize: (key: string, e: React.MouseEvent) => void
  /** The right-edge drag grip. Render inside the matching <th>. */
  ResizeHandle: (props: { col: string; ariaLabel?: string }) => React.ReactElement
}

export function useColumnResize(
  storageKey: string,
  columnKeys: string[],
  fallbackWidths?: Record<string, number>,
): UseColumnResize {
  const lsKey = `${storageKey}.columnWidths`

  const [widths, setWidths] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(lsKey)
      const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {}
      // only keep keys this surface knows about
      const filtered: Record<string, number> = {}
      for (const k of columnKeys) {
        const v = parsed[k]
        if (typeof v === 'number' && Number.isFinite(v)) {
          filtered[k] = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, v))
        }
      }
      return filtered
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(lsKey, JSON.stringify(widths))
    } catch {
      /* ignore quota errors */
    }
  }, [widths, lsKey])

  // Live drag updates a ref + the DOM directly to avoid a React re-render per
  // pixel; we only commit to state on mouse-up.
  const dragRef = useRef<{
    key: string
    startX: number
    startW: number
    ths: HTMLElement[]
  } | null>(null)

  const fallbackFor = useCallback(
    (key: string) => fallbackWidths?.[key] ?? DEFAULT_WIDTH,
    [fallbackWidths],
  )

  const startResize = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const handle = e.currentTarget as HTMLElement
      const th = handle.closest('[data-col]') as HTMLElement | null
      if (!th) return
      // every <th>/<td> for this column in the same table shares data-col;
      // mutate them all live so the drag feel is instant.
      const table = th.closest('table')
      const cells = table
        ? (Array.from(
            table.querySelectorAll(`[data-col="${CSS.escape(key)}"]`),
          ) as HTMLElement[])
        : [th]
      const startW = th.getBoundingClientRect().width
      dragRef.current = { key, startX: e.clientX, startW, ths: cells }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        const ctx = dragRef.current
        if (!ctx) return
        const delta = ev.clientX - ctx.startX
        const next = Math.max(
          MIN_WIDTH,
          Math.min(MAX_WIDTH, ctx.startW + delta),
        )
        for (const cell of ctx.ths) {
          cell.style.width = `${next}px`
          cell.style.minWidth = `${next}px`
          cell.style.maxWidth = `${next}px`
        }
      }
      const onUp = () => {
        const ctx = dragRef.current
        dragRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (!ctx) return
        const finalW = ctx.ths[0]?.getBoundingClientRect().width
        if (finalW && Number.isFinite(finalW)) {
          setWidths((prev) => ({
            ...prev,
            [ctx.key]: Math.round(
              Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, finalW)),
            ),
          }))
        }
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [],
  )

  const thProps = useCallback(
    (key: string) => {
      const w = widths[key] ?? fallbackFor(key)
      return {
        style: {
          width: w,
          minWidth: w,
          maxWidth: w,
          position: 'relative' as const,
        },
        'data-col': key,
      }
    },
    [widths, fallbackFor],
  )

  const ResizeHandle = useCallback(
    ({ col, ariaLabel }: { col: string; ariaLabel?: string }) => (
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={ariaLabel ?? `Resize ${col} column`}
        title="Drag to resize"
        onMouseDown={(e) => startResize(col, e)}
        onClick={(e) => e.stopPropagation()}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none hover:bg-blue-400/70 active:bg-blue-500 transition-colors"
      />
    ),
    [startResize],
  )

  return useMemo(
    () => ({ widths, thProps, startResize, ResizeHandle }),
    [widths, thProps, startResize, ResizeHandle],
  )
}
