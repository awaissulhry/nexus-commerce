'use client'

/**
 * W9.6c — Mobile-card alternative to the 13-column desktop table.
 *
 * Extracted from ReplenishmentWorkspace.tsx (R.5 origin). Renders
 * below the `lg:` breakpoint. Shows the most important fields
 * stacked, with the row's actions accessible via tap.
 *
 * No behavior change vs the inline version. Adds dark-mode classes
 * across the chrome (the inline version was bright-only on the
 * checkbox area, divider, and the SKU/name lines).
 */

import Link from 'next/link'
import { Factory, ShoppingCart, X, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { URGENCY_TONE } from './UrgencyTiles'
import type { Suggestion } from './types'

export function MobileSuggestionCard({
  s,
  selected,
  focused,
  onToggleSelect,
  onOpenDrawer,
  onDraftPo,
  onDismiss,
}: {
  s: Suggestion
  selected: boolean
  /** Keyboard-focused row. Renders a left-edge indicator. */
  focused: boolean
  onToggleSelect: () => void
  onOpenDrawer: () => void
  onDraftPo: () => void
  /** W2.2 — request to dismiss this rec. Parent opens the
   *  DismissReasonModal, captures the reason, and dispatches. */
  onDismiss: () => void
}) {
  const tone = URGENCY_TONE[s.urgency] ?? URGENCY_TONE.LOW
  return (
    <div
      data-suggestion-id={s.productId}
      className={cn(
        'border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-3 space-y-2',
        focused && 'ring-1 ring-blue-300 dark:ring-blue-800 bg-blue-50/40 dark:bg-blue-950/30',
      )}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-0.5"
          aria-label={`Select ${s.sku}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* W2.5 — tap-through to product edit page (desktop parity). */}
            <Link
              href={`/products/${s.productId}/edit`}
              className="font-mono text-sm text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
            >
              {s.sku}
            </Link>
            {s.isManufactured && (
              <Factory
                size={11}
                className="text-violet-600 dark:text-violet-400"
                aria-label="Manufactured"
              />
            )}
            <span
              className={cn(
                'text-xs uppercase tracking-wider px-1.5 py-0.5 rounded border',
                tone,
              )}
            >
              {s.urgency}
            </span>
            {/* R.14 — channel badge on mobile too */}
            {s.urgencySource === 'CHANNEL' && s.worstChannelKey && (
              <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-mono">
                · {s.worstChannelKey.replace(':', '·')}
              </span>
            )}
            {/* R.13 — event-driven urgency badge (mobile parity). */}
            {s.urgencySource === 'EVENT' && s.prepEvent && (
              <span className="text-xs uppercase tracking-wider text-violet-600 dark:text-violet-400 font-mono">
                · {s.prepEvent.name.toUpperCase().slice(0, 12)}
              </span>
            )}
          </div>
          <Link
            href={`/products/${s.productId}/edit`}
            className="block text-base text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 truncate mt-0.5"
          >
            {s.name}
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Stock
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {s.effectiveStock}
            {s.inboundWithinLeadTime > 0 && (
              <span className="ml-1 text-xs font-normal text-emerald-700 dark:text-emerald-400">
                +{s.inboundWithinLeadTime}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Days left
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {s.daysOfStockLeft == null ? '—' : `${s.daysOfStockLeft}d`}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Reorder
          </div>
          <div className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {s.reorderQuantity}
          </div>
        </div>
      </div>

      {/* W2.5 — velocity + lead-time row (desktop parity). */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Velocity
          </div>
          <div className="tabular-nums text-slate-700 dark:text-slate-300">
            {s.velocity}/d
            {s.forecastSource === 'TRAILING_VELOCITY' && (
              <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                trailing
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400 font-semibold">
            Lead time
          </div>
          <div
            className="tabular-nums text-slate-700 dark:text-slate-300"
            title={`source: ${s.leadTimeSource.toLowerCase().replace(/_/g, ' ')}`}
          >
            {s.leadTimeDays}d
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
        <button
          onClick={onDraftPo}
          className="flex-1 h-8 text-sm bg-slate-900 dark:bg-slate-700 text-white rounded hover:bg-slate-800 dark:hover:bg-slate-600 inline-flex items-center justify-center gap-1"
        >
          {s.isManufactured ? (
            <>
              <Factory size={11} /> WO
            </>
          ) : (
            <>
              <ShoppingCart size={11} /> PO
            </>
          )}
        </button>
        <button
          onClick={() => onDismiss()}
          className="h-8 px-2 text-sm border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1"
          title="Dismiss this recommendation"
        >
          <X size={11} />
        </button>
        <button
          onClick={onOpenDrawer}
          className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
        >
          Details <ChevronRight size={11} />
        </button>
      </div>
    </div>
  )
}
