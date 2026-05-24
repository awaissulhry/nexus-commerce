'use client'

// AC.3 — Cockpit market chip strip.
//
// Horizontal scroll-on-overflow row of clickable market chips with:
//   * Status dot (●/○/⚠) computed from hasListing + listingStatus.
//   * Active outline for the currently-selected market.
//   * Per-market dirty badge (small amber pill) when dirtyCount>0.
//   * Hover-warm callback (manifest prefetch hook fires onMouseEnter
//     after a tiny intent delay).
//   * Alt+N hint shown for the first 9 chips when shortcutsHint=true.
//
// The component is intentionally generic — Amazon, eBay, and Shopify
// cockpits will mount the same strip with different MarketChip[].

import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { classifyStatus, marketFlag, type MarketChip } from './types'

interface Props {
  markets: MarketChip[]
  /** Currently selected market code. */
  active: string
  /** Called when the operator clicks a chip. Switch logic (dirty-flush,
   *  URL sync, prefetch) lives in useMarketSwitch — this component just
   *  reports the click. */
  onSelect: (code: string) => void
  /** Optional hover-warm hook. Fires after ~120 ms of stable hover so
   *  flick-throughs don't burn manifest fetches. */
  onHoverWarm?: (code: string) => void
  /** When true, append "Alt+N" to the chip tooltip for the first 9
   *  chips. The actual key handler lives in useMarketSwitch — this is
   *  just affordance. */
  shortcutsHint?: boolean
  className?: string
}

const STATUS_DOT: Record<
  ReturnType<typeof classifyStatus>,
  { glyph: string; tone: string; title: string }
> = {
  published:  { glyph: '●', tone: 'text-emerald-500',  title: 'Published'  },
  draft:      { glyph: '○', tone: 'text-slate-400',    title: 'Not listed' },
  suppressed: { glyph: '⚠', tone: 'text-rose-500',     title: 'Suppressed' },
  unknown:    { glyph: '○', tone: 'text-slate-400',    title: 'Unknown'    },
}

export default function MarketChipStrip({
  markets,
  active,
  onSelect,
  onHoverWarm,
  shortcutsHint = true,
  className,
}: Props) {
  // Track per-chip hover-warm intent timers so we don't fire prefetch
  // on a fast pointer pass. Keyed by market code; cleared on leave.
  const warmTimers = useRef<Record<string, ReturnType<typeof setTimeout> | null>>(
    {},
  )

  function handleEnter(code: string) {
    if (!onHoverWarm || code === active) return
    if (warmTimers.current[code]) return
    warmTimers.current[code] = setTimeout(() => {
      onHoverWarm(code)
      warmTimers.current[code] = null
    }, 120)
  }
  function handleLeave(code: string) {
    const t = warmTimers.current[code]
    if (t) {
      clearTimeout(t)
      warmTimers.current[code] = null
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Marketplaces"
      className={cn(
        'flex items-center gap-1 overflow-x-auto no-scrollbar',
        className,
      )}
    >
      {markets.map((m, i) => {
        const isActive = m.code === active
        const cls = classifyStatus(m.hasListing, m.listingStatus)
        const dot = STATUS_DOT[cls]
        const altHint =
          shortcutsHint && i < 9 ? ` · Alt+${i + 1}` : ''
        const tooltip = `${m.name} (${dot.title})${altHint}`
        const dirty = m.dirtyCount ?? 0
        return (
          <button
            key={m.code}
            role="tab"
            aria-selected={isActive}
            type="button"
            onClick={() => onSelect(m.code)}
            onMouseEnter={() => handleEnter(m.code)}
            onMouseLeave={() => handleLeave(m.code)}
            onFocus={() => handleEnter(m.code)}
            onBlur={() => handleLeave(m.code)}
            title={tooltip}
            className={cn(
              'group inline-flex items-center gap-1 h-7 px-2 rounded border text-[11.5px] font-medium transition-colors whitespace-nowrap',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              isActive
                ? 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-200'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
            )}
          >
            <span aria-hidden className={cn('leading-none', dot.tone)}>
              {dot.glyph}
            </span>
            <span className="font-mono tracking-tight">{m.code}</span>
            <span className="text-[10.5px]">{m.flag ?? marketFlag(m.code)}</span>
            {dirty > 0 && (
              <span
                className="ml-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 rounded-full bg-amber-500 text-white text-[9.5px] font-bold leading-none"
                title={`${dirty} unsaved field${dirty === 1 ? '' : 's'}`}
              >
                {dirty > 9 ? '9+' : dirty}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
