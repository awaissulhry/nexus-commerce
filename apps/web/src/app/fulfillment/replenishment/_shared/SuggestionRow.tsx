'use client'

/**
 * W9.6d — Desktop table row for the recommendation list.
 *
 * Extracted from ReplenishmentWorkspace.tsx (R.5 origin). Renders
 * one <tr> with the 13-column recommendation layout. Below `lg:`
 * the table is replaced by MobileSuggestionCard.
 *
 * Adds dark-mode classes throughout the chrome (the inline version
 * was bright-mode-only on the row hover, focused ring, stock-tone
 * thresholds, link colours, badges, button surfaces, and divider).
 *
 * No behavior change. Same callbacks, same column order, same
 * formatting helpers inline (forecastBand string + stockTone tone
 * map).
 */

import Link from 'next/link'
import { Factory, ShoppingCart, X, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { URGENCY_TONE } from './UrgencyTiles'
import type { Suggestion } from './types'

export function SuggestionRow({
  suggestion: s,
  selected,
  focused,
  onToggle,
  onOpenDrawer,
  onDraftPo,
  onDismiss,
}: {
  suggestion: Suggestion
  selected: boolean
  /** Keyboard-focused row. Renders a left-edge indicator. */
  focused: boolean
  onToggle: () => void
  onOpenDrawer: () => void
  onDraftPo: () => void
  /** W2.2 — request to dismiss this rec. Parent opens the
   *  DismissReasonModal, captures the reason, and dispatches. */
  onDismiss: () => void
}) {
  const stockTone =
    s.effectiveStock === 0
      ? 'text-rose-600 dark:text-rose-400'
      : s.effectiveStock <= s.reorderPoint
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-slate-900 dark:text-slate-100'
  const forecastBand =
    s.forecastSource === 'FORECAST' &&
    s.forecastedDemandLeadTime != null &&
    s.forecastedDemandLower80 != null &&
    s.forecastedDemandUpper80 != null
      ? `${Math.round(s.forecastedDemandLeadTime)} (${Math.round(
          s.forecastedDemandLower80,
        )}–${Math.round(s.forecastedDemandUpper80)})`
      : null
  return (
    <tr
      data-suggestion-id={s.productId}
      className={cn(
        'border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-950/50',
        focused &&
          'bg-blue-50/40 dark:bg-blue-950/30 ring-1 ring-inset ring-blue-300 dark:ring-blue-800',
      )}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${s.sku}`}
        />
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/products/${s.productId}/edit`}
          className="text-md text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 truncate block max-w-md"
        >
          {s.name}
        </Link>
        <div className="text-sm text-slate-500 dark:text-slate-400 font-mono inline-flex items-center gap-1.5">
          {s.sku}
          {s.isManufactured && (
            <Factory size={10} className="text-violet-600 dark:text-violet-400" />
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="inline-flex items-center gap-1 flex-wrap">
          <span
            className={cn(
              'inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
              URGENCY_TONE[s.urgency],
            )}
          >
            {s.urgency}
          </span>
          {/* R.14 — channel-driven urgency badge. Tooltip shows the
              specific channel and days-of-cover that promoted the
              headline above the global aggregate. */}
          {s.urgencySource === 'CHANNEL' && s.worstChannelKey && (
            <span
              className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-mono"
              title={`Promoted because of ${s.worstChannelKey} (${s.worstChannelDaysOfCover}d cover). Aggregate was ${s.globalUrgency ?? 'lower'}.`}
            >
              · {s.worstChannelKey.replace(':', '·')}
            </span>
          )}
          {/* R.13 — event-driven urgency badge. Tooltip shows the
              event name and prep deadline. Purple to distinguish from
              channel-driven (slate-grey) and global (no badge). */}
          {s.urgencySource === 'EVENT' && s.prepEvent && (
            <span
              className="text-xs uppercase tracking-wider text-violet-600 dark:text-violet-400 font-mono"
              title={`Promoted by ${s.prepEvent.name} prep deadline (${s.prepEvent.daysUntilDeadline}d to deadline, +${s.prepEvent.extraUnitsRecommended} extra units).`}
            >
              · {s.prepEvent.name.toUpperCase().slice(0, 12)}
            </span>
          )}
        </div>
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right tabular-nums font-semibold',
          stockTone,
        )}
        title="On-hand stock"
      >
        {s.currentStock}
      </td>
      <td
        className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300"
        title={
          s.totalOpenInbound > s.inboundWithinLeadTime
            ? `${s.inboundWithinLeadTime} arrives within lead time · ${s.totalOpenInbound - s.inboundWithinLeadTime} more after`
            : 'Inbound arriving within lead time'
        }
      >
        {s.inboundWithinLeadTime > 0 ? (
          <span className="text-emerald-700 dark:text-emerald-400">
            +{s.inboundWithinLeadTime}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-600">—</span>
        )}
      </td>
      <td
        className={cn('px-3 py-2 text-right tabular-nums font-medium', stockTone)}
        title="Available to promise = on-hand + inbound within lead time"
      >
        {s.effectiveStock}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
        {s.velocity}/d
        {s.forecastSource === 'TRAILING_VELOCITY' && (
          <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
            trailing
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
        {s.daysOfStockLeft != null ? `${s.daysOfStockLeft}d` : '∞'}
      </td>
      <td
        className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400"
        title={`source: ${s.leadTimeSource.toLowerCase().replace(/_/g, ' ')}`}
      >
        {s.leadTimeDays}d
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
        {forecastBand ?? <span className="text-slate-400 dark:text-slate-600">—</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
        {s.reorderQuantity}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          {s.needsReorder ? (
            <button
              onClick={onDraftPo}
              className="h-7 px-2 text-sm bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-950/60 inline-flex items-center gap-1"
              title={s.isManufactured ? 'Create work order' : 'Create draft PO'}
              aria-label={
                s.isManufactured
                  ? `Create work order for ${s.sku}`
                  : `Create draft purchase order for ${s.sku}`
              }
            >
              {s.isManufactured ? (
                <>
                  <Factory size={11} aria-hidden="true" /> WO
                </>
              ) : (
                <>
                  <ShoppingCart size={11} aria-hidden="true" /> PO
                </>
              )}
            </button>
          ) : (
            <span className="text-xs text-slate-400 dark:text-slate-600">OK</span>
          )}
          <button
            onClick={() => onDismiss()}
            className="h-7 w-7 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 border border-transparent hover:border-red-200 dark:hover:border-red-900 rounded"
            title="Dismiss this recommendation"
            aria-label="Dismiss recommendation"
          >
            <X size={12} />
          </button>
        </div>
      </td>
      <td className="px-3 py-2">
        <button
          onClick={onOpenDrawer}
          className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          aria-label={`Open detail for ${s.sku}`}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </td>
    </tr>
  )
}
