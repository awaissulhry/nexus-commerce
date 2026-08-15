'use client'

/**
 * APS.2a — the console's market selector, extracted from AdsPageHeader so the
 * campaign builders reuse the exact control the rest of the console already
 * uses instead of growing a second copy of the flag table and menu markup.
 *
 * Two modes, because a filter and a launch target are different things:
 *
 *   allowAll        analytics pages — "All markets" is a legitimate view.
 *   launchable-only builders — every option is somewhere a campaign can
 *                   really land. Sandbox connections still RENDER (so
 *                   "where is Poland?" has a visible answer) but are
 *                   disabled and labelled, never silently dropped.
 *
 * Styling reuses the existing .h10-hsel / .h10-hbtn / .h10-menu chrome. The
 * ads tree is the deliberate Helium-10 pixel-match world and is allowlisted
 * out of the DS ratchet (scripts/ds-conformance-guard.mjs); APS.4 is where
 * this moves to the design system along with the rest of the picker.
 */

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AdsMarket } from './MarketplaceContext'

export const FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱',
  SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸',
}
export const MARKET_NAME: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom',
  NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States',
}

export function marketLabel(code: string): string {
  if (code === 'all') return 'All markets'
  if (!code) return 'No market'
  return `${FLAG[code] ?? '🏳️'} ${MARKET_NAME[code] ?? code}`
}

/** The label for a multi-selection: one code reads as itself, several as a count. */
function multiLabel(codes: string[]): string {
  if (codes.length === 0) return 'All markets'
  if (codes.length === 1) return marketLabel(codes[0])
  if (codes.length <= 3) return codes.map((c) => FLAG[c] ?? c).join(' ') + ` · ${codes.length} markets`
  return `${codes.length} markets`
}

/**
 * 🔴 HV.10 — optional MULTI-select, additive.
 *
 * `values` / `onValuesChange` are absent for every existing consumer, and when they are absent this
 * component behaves exactly as it did: one `value`, one `onChange`, a radio-style menu. Pass them
 * and the market rows become checkboxes with an explicit Apply, so a page can express "IT and DE"
 * — a scope that previously had to be rounded to one market or to all of them.
 *
 * Deliberately NOT auto-applying on each tick: a market change refetches the page, and toggling
 * three markets would fire three reads and show two states the operator never asked for.
 */
export function MarketSelect({
  markets, value, onChange, allowAll = false, disabled = false, brand, values, onValuesChange,
}: {
  /** Full connection list; non-launchable entries render disabled. */
  markets: AdsMarket[]
  value: string
  onChange: (code: string) => void
  /** Analytics pages only. Builders must never offer "All markets". */
  allowAll?: boolean
  disabled?: boolean
  /** Left-hand brand mark (the header passes its amazon/eBay wordmark). */
  brand?: React.ReactNode
  /** HV.10 — present ⇒ multi-select. `[]` means "all markets". */
  values?: string[]
  onValuesChange?: (codes: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const multi = Array.isArray(values) && typeof onValuesChange === 'function'
  // The draft only exists while the menu is open; Apply commits it, Cancel drops it.
  const [draft, setDraft] = useState<string[]>(values ?? [])
  const openMenu = () => { setDraft(values ?? []); setOpen(true) }
  const toggle = (code: string) => setDraft((d) => (d.includes(code) ? d.filter((c) => c !== code) : [...d, code]))
  const apply = () => { onValuesChange?.(draft); close() }

  return (
    <div className="h10-hsel">
      <button
        type="button"
        className="h10-hbtn acct"
        onClick={() => (open ? close() : (multi ? openMenu() : setOpen(true)))}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {brand}
        <span className="chip">{multi ? multiLabel(values ?? []) : marketLabel(value)}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
          <div className="h10-menu" role="menu">
            {allowAll && (
              <button
                type="button"
                className={(multi ? (draft.length === 0) : value === 'all') ? 'on' : ''}
                onClick={() => { if (multi) { onValuesChange?.([]); close() } else { onChange('all'); close() } }}
              >
                All markets
              </button>
            )}
            {markets.map((m) => (
              <button
                type="button"
                key={m.code}
                role={multi ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={multi ? draft.includes(m.code) : undefined}
                className={(multi ? draft.includes(m.code) : m.code === value) ? 'on' : ''}
                disabled={!m.launchable}
                // A disabled row still explains itself — the operator should
                // never have to guess why a connected market cannot be picked.
                title={m.launchable ? m.label || m.code : `${m.code} is a ${m.mode} connection — campaigns cannot be launched there`}
                onClick={() => { if (!m.launchable) return; if (multi) toggle(m.code); else { onChange(m.code); close() } }}
              >
                <span>{multi && <span className="mk-box" aria-hidden>{draft.includes(m.code) ? '☑' : '☐'}</span>} {FLAG[m.code] ?? '🏳️'} {MARKET_NAME[m.code] ?? m.code}</span>
                <span className="sub">{m.launchable ? m.code : `${m.code} · ${m.mode}`}</span>
              </button>
            ))}
            {markets.length === 0 && <button type="button" disabled>No connected markets</button>}
            {multi && (
              // An explicit commit, because each change refetches the page. "None selected" is not
              // an empty result — it is every market, and the button says so rather than leaving
              // the operator to infer it from a blank grid.
              <div className="h10-menu-foot">
                <button type="button" className="mk-cancel" onClick={close}>Cancel</button>
                <button type="button" className="mk-apply" onClick={apply}>
                  {draft.length === 0 ? 'Show all markets' : `Show ${draft.length} market${draft.length === 1 ? '' : 's'}`}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
