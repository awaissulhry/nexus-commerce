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

export function MarketSelect({
  markets, value, onChange, allowAll = false, disabled = false, brand,
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
}) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <div className="h10-hsel">
      <button
        type="button"
        className="h10-hbtn acct"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {brand}
        <span className="chip">{marketLabel(value)}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
          <div className="h10-menu" role="menu">
            {allowAll && (
              <button type="button" className={value === 'all' ? 'on' : ''} onClick={() => { onChange('all'); close() }}>
                All markets
              </button>
            )}
            {markets.map((m) => (
              <button
                type="button"
                key={m.code}
                role="menuitem"
                className={m.code === value ? 'on' : ''}
                disabled={!m.launchable}
                // A disabled row still explains itself — the operator should
                // never have to guess why a connected market cannot be picked.
                title={m.launchable ? m.label || m.code : `${m.code} is a ${m.mode} connection — campaigns cannot be launched there`}
                onClick={() => { if (m.launchable) { onChange(m.code); close() } }}
              >
                <span>{FLAG[m.code] ?? '🏳️'} {MARKET_NAME[m.code] ?? m.code}</span>
                <span className="sub">{m.launchable ? m.code : `${m.code} · ${m.mode}`}</span>
              </button>
            ))}
            {markets.length === 0 && <button type="button" disabled>No connected markets</button>}
          </div>
        </>
      )}
    </div>
  )
}
