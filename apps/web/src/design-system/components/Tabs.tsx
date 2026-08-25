import type { ReactNode } from 'react'

export interface TabItem {
  id: string
  label: ReactNode
  /** SG.1 — optional count pill after the label (H10's tab-count treatment). `null` renders
   *  nothing (unknown ≠ zero); `0` renders a pill reading 0, which is a real answer. */
  count?: number | null
  /** SG.1 — optional small promo/context badge between label and count (H10's "New" pill). */
  badge?: string
  /** SG.1 — optional leading icon (H10 marks its A.I. tab). Sized by the caller (≤16px). */
  icon?: ReactNode
  /** 9.3 — a tab that cannot be entered yet. Carries `disabled` + `aria-disabled` so the
   *  reason is reachable; never the only signal (the label should say why). */
  disabled?: boolean
}

export interface TabsProps {
  /**
   * Accessible name for the `tablist`. Same shape as `SegmentedControl`: a tablist with no name
   * is announced unlabelled, so the reader hears the tabs but not what they belong to.
   */
  ariaLabel?: string
  tabs: TabItem[]
  active: string
  onChange: (id: string) => void
  className?: string
  /**
   * SG.1 — 'lg' is the PAGE-level tab bar (H10's Suggestions/Analytics tabs: larger bolder
   * labels, 3px indicator, count pills at full weight). Default 'md' is byte-identical to the
   * original underline bar, so the existing consumers are untouched.
   */
  size?: 'md' | 'lg'
}

/** Underline tab bar (active = primary text + primary indicator). Controlled. */
export function Tabs({ ariaLabel, tabs, active, onChange, className, size = 'md' }: TabsProps) {
  return (
    <div className={['nds-tabs', size === 'lg' ? 'lg' : '', className ?? ''].filter(Boolean).join(' ')} role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={['nds-tab', t.id === active ? 'on' : ''].filter(Boolean).join(' ')}
          disabled={t.disabled}
          aria-disabled={t.disabled || undefined}
          onClick={() => { if (!t.disabled) onChange(t.id) }}
        >
          {t.icon ? <span className="nds-tab-ic" aria-hidden>{t.icon}</span> : null}
          {t.label}
          {t.badge ? <span className="nds-tab-badge">{t.badge}</span> : null}
          {t.count != null ? <span className="nds-tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  )
}
