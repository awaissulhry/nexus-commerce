'use client'

/**
 * UFX P7 (item 1) — shared right-click context menu for the flat-file grids.
 *
 * Extracted from the Amazon flat file's page-local ContextMenu so both
 * consumers of the grid's `renderContextMenu` hook (Amazon + eBay) render the
 * same chrome with channel-appropriate actions. Generic items-based API: each
 * consumer builds its own action list (separators, shortcuts, danger tone),
 * so channel-specific flows (Amazon remove-from-market, eBay delete-confirm)
 * stay page-owned.
 *
 * Design tokens: borders use the semantic `border-default` / `border-subtle`
 * tokens (var-backed, dark-ready) per the token guard on new components.
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface FlatFileContextMenuItem {
  label?: string
  /** Keyboard hint rendered right-aligned (display only), e.g. '⌘C'. */
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  /** Render a divider instead of an action. */
  separator?: boolean
  /** Destructive tone (e.g. Delete rows). */
  danger?: boolean
}

export function FlatFileContextMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: FlatFileContextMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  // Clamp so the menu never overflows the viewport (matches the previous
  // Amazon-local implementation; height estimated from the item count).
  const menuW = 200
  const actionCount = items.filter((i) => !i.separator).length
  const sepCount = items.length - actionCount
  const menuH = actionCount * 27 + sepCount * 9 + 8
  const left = Math.min(x, window.innerWidth - menuW - 8)
  const top = Math.min(y, window.innerHeight - menuH - 8)

  return (
    <div
      ref={ref}
      className="fixed z-[9999] w-48 bg-white dark:bg-slate-900 border border-default rounded-lg shadow-2xl py-1 overflow-hidden"
      style={{ left, top }}
    >
      {items.map((item, i) => item.separator
        ? <div key={i} className="my-1 border-t border-subtle" />
        : (
          <button
            key={i}
            type="button"
            disabled={item.disabled}
            onClick={() => { if (!item.disabled) { item.onClick?.(); onClose() } }}
            className={cn(
              'w-full flex items-center justify-between gap-6 px-3 py-1.5 text-xs text-left transition-colors',
              item.disabled ? 'text-slate-300 dark:text-slate-600 cursor-default'
              : item.danger ? 'text-red-600 dark:text-red-400 hover:bg-red-500 hover:text-white'
              : 'text-slate-700 dark:text-slate-300 hover:bg-blue-500 hover:text-white',
            )}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="text-[10px] font-mono opacity-60">{item.shortcut}</span>}
          </button>
        ))}
    </div>
  )
}
