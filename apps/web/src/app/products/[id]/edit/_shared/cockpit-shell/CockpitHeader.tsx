'use client'

// UC.1.2 — Shared cockpit header primitive.
//
// Pure presentational chrome that hosts BOTH channels without imposing
// channel logic. Everything channel-specific arrives via slots:
//   • chipStrip       — the market-switch strip (MarketChipStrip)
//   • actions         — primary actions (Pull / AI / Publish)
//   • secondaryActions— All-fields / Edit-in-bulk / Linking / History /
//                       Apply-to-siblings (whatever the channel needs)
//   • extraPills      — additional status/info pills
//
// The identity row (channel · marketplace · status · fulfilment · id ·
// live dot) and the Classic toggle are common, so they live here. The
// status string is folded to a tone via tokens.statusTone, which covers
// Amazon / eBay / Shopify / feed-lifecycle vocabularies.

import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  COCKPIT_HEADER_STICKY,
  PILL_BASE,
  STATUS_DOT,
  STATUS_PILL,
  statusTone,
} from './tokens'

export interface CockpitHeaderProps {
  /** "Amazon" / "eBay". Rendered bold as the leading label. */
  channelLabel: string
  /** "Amazon Italy" / "eBay Italy". */
  marketplaceLabel?: string
  /** Raw channel status string (ACTIVE / DRAFT / SUPPRESSED / ENDED…). */
  status?: string | null
  /** Display label for the status pill; falls back to a title-cased status. */
  statusLabel?: string
  /** "FBA" / "FBM" / "Buy-It-Now" — neutral pill, optional. */
  fulfilmentLabel?: string
  /** "ASIN B0F7…" / item id — neutral pill, optional. */
  identifier?: string
  /** Steady green dot = live push connected. */
  live?: boolean
  /** Pulsing dot = eBay heartbeat. When set, overrides `live` styling. */
  heartbeat?: boolean
  /** Extra channel pills appended after the standard ones. */
  extraPills?: ReactNode
  /** Market chip strip (second row, left). */
  chipStrip?: ReactNode
  /** Primary action buttons (Pull / AI / Publish). */
  actions?: ReactNode
  /** Secondary entry points (All fields / Edit in bulk / Linking / …). */
  secondaryActions?: ReactNode
  /** Classic toggle. Omit `onToggleClassic` to hide the toggle. */
  classicLabel?: string
  onToggleClassic?: () => void
  /** aria-label for the <header> landmark. */
  ariaLabel?: string
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function CockpitHeader({
  channelLabel,
  marketplaceLabel,
  status,
  statusLabel,
  fulfilmentLabel,
  identifier,
  live,
  heartbeat,
  extraPills,
  chipStrip,
  actions,
  secondaryActions,
  classicLabel = 'Classic',
  onToggleClassic,
  ariaLabel,
}: CockpitHeaderProps) {
  const tone = statusTone(status)
  const showStatus = Boolean(status || statusLabel)

  return (
    <header
      aria-label={ariaLabel ?? `${channelLabel} cockpit header`}
      className={cn(
        COCKPIT_HEADER_STICKY,
        'min-w-0 max-w-full rounded-lg border border-slate-200 bg-white/95 backdrop-blur',
        'dark:border-slate-800 dark:bg-slate-900/95',
      )}
    >
      {/* ── Identity row ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {channelLabel}
        </span>
        {marketplaceLabel && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span className="text-sm text-slate-600 dark:text-slate-300">
              {marketplaceLabel}
            </span>
          </>
        )}

        {showStatus && (
          <span className={cn(PILL_BASE, STATUS_PILL[tone])}>
            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[tone])} />
            {statusLabel ?? titleCase(status ?? '')}
          </span>
        )}
        {fulfilmentLabel && (
          <span className={cn(PILL_BASE, STATUS_PILL.slate)}>{fulfilmentLabel}</span>
        )}
        {identifier && (
          <span className={cn(PILL_BASE, STATUS_PILL.slate, 'font-mono')}>
            {identifier}
          </span>
        )}
        {(live || heartbeat) && (
          <span
            aria-hidden
            title={heartbeat ? 'Live (heartbeat)' : 'Live'}
            className={cn(
              'h-2 w-2 rounded-full bg-emerald-500',
              heartbeat && 'animate-pulse',
            )}
          />
        )}
        {extraPills}

        {/* spacer pushes the Classic toggle to the right */}
        <span className="ml-auto" />
        {onToggleClassic && (
          <button
            type="button"
            onClick={onToggleClassic}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <ChevronDown className="h-3 w-3" />
            {classicLabel}
          </button>
        )}
      </div>

      {/* ── Action row: chips left, actions right ────────────────── */}
      {(chipStrip || actions || secondaryActions) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
          {chipStrip && <div className="min-w-0 flex-1">{chipStrip}</div>}
          <div className="flex flex-wrap items-center gap-2">
            {secondaryActions}
            {actions}
          </div>
        </div>
      )}
    </header>
  )
}
