'use client'

/**
 * Shared campaign-type selector (Helium 10 "Guided" match). The multi-select SP / SB / SD
 * cards — "Select the campaign types you want to launch. You can add multiple campaign types."
 * Lives in _shared as the canonical, reusable building block for any builder that spans ad
 * formats (Guided today; recorded in the design system — see design-system/CHANGELOG.md +
 * studies/03-ads-campaigns.md). Each card carries a light ad-layout mock, a title, and Amazon's
 * format description, and toggles selection (checked = accent border + tick). `disabled` keys
 * render inert with a "Soon" pill (used while a format's full settings are still being built).
 */
import { Check } from 'lucide-react'
import './CampaignTypeSelect.css'

export type AdProduct = 'SP' | 'SB' | 'SD'

export const AD_PRODUCT_META: Array<{ key: AdProduct; title: string; desc: string }> = [
  { key: 'SP', title: 'Sponsored Products', desc: 'Promote products to shoppers actively searching with related keywords or viewing similar products on Amazon.' },
  { key: 'SB', title: 'Sponsored Brand', desc: 'Help shoppers discover your brand and products on Amazon with rich, engaging creatives.' },
  { key: 'SD', title: 'Sponsored Display', desc: 'Grow your business with increased visibility utilizing strategically placed ads on product detail pages.' },
]

/** A muted ad-layout mock per format (evokes the placement; not pixel-exact). */
function TypeMock({ kind }: { kind: AdProduct }) {
  return (
    <svg className="h10-cts-mock" viewBox="0 0 200 104" aria-hidden role="img">
      <rect x="0" y="0" width="200" height="104" rx="6" fill="#f4f6f8" />
      {kind === 'SP' && (
        <>
          {/* a search row of product tiles, one sponsored (accent) */}
          {[12, 60, 108, 156].map((x, i) => (
            <g key={x}>
              <rect x={x} y="22" width="34" height="40" rx="3" fill={i === 1 ? '#1f6fde' : '#dfe5ec'} />
              <rect x={x} y="66" width="34" height="5" rx="2.5" fill="#cdd5df" />
              <rect x={x} y="74" width="24" height="5" rx="2.5" fill="#dde3ea" />
            </g>
          ))}
        </>
      )}
      {kind === 'SB' && (
        <>
          {/* a brand banner (logo + headline) above a product strip */}
          <rect x="12" y="16" width="176" height="34" rx="4" fill="#1f6fde" opacity="0.92" />
          <circle cx="30" cy="33" r="9" fill="#fff" opacity="0.9" />
          <rect x="46" y="28" width="92" height="5" rx="2.5" fill="#fff" opacity="0.85" />
          <rect x="46" y="38" width="60" height="5" rx="2.5" fill="#fff" opacity="0.6" />
          {[12, 56, 100, 144].map((x) => <rect key={x} x={x} y="60" width="34" height="30" rx="3" fill="#dfe5ec" />)}
        </>
      )}
      {kind === 'SD' && (
        <>
          {/* a detail page with one strategically-placed display unit (accent) */}
          <rect x="12" y="16" width="74" height="72" rx="4" fill="#e4e9ef" />
          <rect x="96" y="16" width="50" height="6" rx="3" fill="#d3dae2" />
          <rect x="96" y="28" width="92" height="5" rx="2.5" fill="#dde3ea" />
          <rect x="96" y="37" width="80" height="5" rx="2.5" fill="#dde3ea" />
          <rect x="96" y="54" width="92" height="34" rx="4" fill="#1f6fde" opacity="0.92" />
        </>
      )}
    </svg>
  )
}

export function CampaignTypeSelect({ value, onChange, disabled = [] }: {
  value: AdProduct[]
  onChange: (v: AdProduct[]) => void
  disabled?: AdProduct[]
}) {
  const sel = new Set(value)
  const off = new Set(disabled)
  const toggle = (k: AdProduct) => {
    if (off.has(k)) return
    const next = new Set(sel)
    next.has(k) ? next.delete(k) : next.add(k)
    onChange(AD_PRODUCT_META.map((m) => m.key).filter((k2) => next.has(k2)))
  }
  return (
    <div className="h10-cts" role="group" aria-label="Campaign types">
      {AD_PRODUCT_META.map((m) => {
        const on = sel.has(m.key)
        const isOff = off.has(m.key)
        return (
          <button
            key={m.key}
            type="button"
            className={`h10-cts-card ${on ? 'on' : ''} ${isOff ? 'off' : ''}`}
            aria-pressed={on}
            aria-disabled={isOff || undefined}
            onClick={() => toggle(m.key)}
          >
            {on && <span className="h10-cts-tick"><Check size={13} strokeWidth={3} /></span>}
            {isOff && <span className="h10-cts-soon">Soon</span>}
            <TypeMock kind={m.key} />
            <span className="h10-cts-ttl">{m.title}</span>
            <span className="h10-cts-desc">{m.desc}</span>
          </button>
        )
      })}
    </div>
  )
}
