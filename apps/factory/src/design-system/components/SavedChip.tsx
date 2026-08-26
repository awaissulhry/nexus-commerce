'use client'

/**
 * GX.8 — a saved thing you can load, with actions hung off it.
 *
 * ── Why this is a component and not markup on two pages ───────────────────────
 *
 * The reporting page has two strips that do the same thing: saved report definitions (RPT.5) and
 * saved views (GX.8). Both are "a named thing you click to load, with a couple of small actions
 * beside the name". The second one was written by copying the first one's markup, which is how a
 * platform ends up with two controls that look almost the same and behave slightly differently —
 * the exact inconsistency the design system exists to prevent. So the chip is the DS's, and both
 * strips render it.
 *
 * ── The compound is the reason it needs to exist ─────────────────────────────
 *
 * `Button` cannot express this: it is one bordered pill containing several independently
 * clickable regions divided by hairlines, and nesting buttons is invalid HTML. What the DS gives
 * it that hand-rolled markup did not is the accessibility — every action carries a real
 * `aria-label` rather than an icon alone, `aria-pressed` where it toggles, and a disabled state
 * that is announced rather than merely faded.
 */
import type { ReactNode } from 'react'

export interface SavedChipAction {
  icon: ReactNode
  /** Spoken name. Required — an icon-only control with no label is unreachable. */
  label: string
  onClick: () => void
  /** Set for a toggle, so the control reports its state rather than only showing it. */
  pressed?: boolean
  disabled?: boolean
}

export interface SavedChipProps {
  label: string
  /** A short qualifier beside the name — a version, a market. Never the whole story. */
  meta?: string
  active?: boolean
  /** Hover text for the name itself. Use it for what will not fit: dates, counts. */
  title?: string
  onSelect: () => void
  actions?: SavedChipAction[]
  className?: string
}

export function SavedChip({
  label, meta, active = false, title, onSelect, actions = [], className,
}: SavedChipProps) {
  return (
    <span className={`nds-savedchip${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className="nds-savedchip-main" title={title} aria-current={active || undefined} onClick={onSelect}>
        {label}
        {meta != null && <span className="nds-savedchip-meta">{meta}</span>}
      </button>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          className="nds-savedchip-act"
          title={a.label}
          aria-label={a.label}
          aria-pressed={a.pressed}
          disabled={a.disabled}
          onClick={a.onClick}
        >
          {a.icon}
        </button>
      ))}
    </span>
  )
}
