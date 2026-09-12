'use client'

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

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

/**
 * Ids for the `tab` ↔ `tabpanel` pairing, so a caller can label its panel with the same base.
 *
 * ARIA wants the relationship stated from BOTH ends: the tab points at its panel with
 * `aria-controls`, and the panel points back with `aria-labelledby`. A tablist with neither — which
 * is what this component emitted until now — announces the tabs but never tells a screen-reader
 * user which region they govern.
 */
export function tabIds(base: string, tabId: string) {
  return { tab: `${base}-tab-${tabId}`, panel: `${base}-panel-${tabId}` }
}

/**
 * Spread onto the element rendering the active tab's content:
 * `<div {...tabPanelProps(base, active)}>`.
 */
export function tabPanelProps(base: string, activeTabId: string) {
  const { tab, panel } = tabIds(base, activeTabId)
  return { id: panel, role: 'tabpanel' as const, 'aria-labelledby': tab, tabIndex: 0 }
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
   *
   * CT.1 — 'sm' is a tab strip INSIDE a bar beside 28px controls (the studio's 40px scope row, the
   * record drawer's pane strip): the bar's type (sm-plus, 600), tabs stretched to the strip so the
   * indicator meets its edge, and no hairline of its own because the host draws one.
   */
  size?: 'sm' | 'md' | 'lg'
  /** Keep long labels within a narrow container; the active tab scrolls into view. */
  overflow?: 'scroll'
  /**
   * Shared id base for the `tab`/`tabpanel` pairing. Pass the same value to `tabPanelProps()` on
   * the element that renders the active tab's content.
   *
   * Optional so the ~dozen existing consumers are untouched: without it the bar emits no
   * `aria-controls`, exactly as before.
   */
  idBase?: string
}

/** Underline tab bar (active = primary text + primary indicator). Controlled. */
export function Tabs({ ariaLabel, tabs, active, onChange, className, size = 'md', idBase, overflow }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const autoBase = useId()
  const base = idBase ?? autoBase
  useEffect(() => {
    if (overflow !== 'scroll') return
    const tab = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, overflow])

  /**
   * Arrow-key selection, the ARIA tablist pattern.
   *
   * With a roving tabindex the whole bar is ONE tab stop and ←/→/Home/End move within it — which is
   * what a keyboard user expects of a tablist, and what this component did not do. Disabled tabs are
   * skipped rather than trapping focus on a control that cannot act.
   */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
      const usable = tabs.filter((t) => !t.disabled)
      if (usable.length < 2) return
      e.preventDefault()
      const at = usable.findIndex((t) => t.id === active)
      const next =
        e.key === 'Home' ? 0
        : e.key === 'End' ? usable.length - 1
        : e.key === 'ArrowRight' ? (at + 1 + usable.length) % usable.length
        : (at - 1 + usable.length) % usable.length
      const target = usable[next]
      if (!target) return
      onChange(target.id)
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus()
    },
    [tabs, active, onChange],
  )

  return (
    <div
      className={['nds-tabs', size === 'md' ? '' : size, overflow === 'scroll' ? 'scrollable' : '', className ?? ''].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={ariaLabel}
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-tab-id={t.id}
          id={idBase ? tabIds(base, t.id).tab : undefined}
          aria-controls={idBase ? tabIds(base, t.id).panel : undefined}
          aria-selected={t.id === active}
          // Roving tabindex: one stop for the bar, arrows move inside it.
          tabIndex={t.id === active && !t.disabled ? 0 : -1}
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
