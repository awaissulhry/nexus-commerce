'use client'

/**
 * SearchTrigger — a field-shaped control that OPENS a search surface rather than being one.
 *
 * Filed from the TB top-bar gap. The bar needs something that reads as a search box but delegates
 * to the command palette, and the DS had no expression for "looks like a field, behaves like a
 * button".
 *
 * ── 🔴 Two details that are the whole reason this is a component ─────────────────────────────
 *
 * 1. `onMouseDown` + preventDefault, never `onClick`/`onFocus`. A palette typically focuses its
 *    own input on open; a plain click opens it, the palette takes focus, and then the click's own
 *    default focus lands back here and steals it. Measured during TB: the palette was open with
 *    its input rendered and UNFOCUSED, so every keystroke went nowhere. It looked correct.
 * 2. The placeholder is held to BODY-TEXT contrast, not the DS's `--nds-text-disabled`. Here the
 *    placeholder IS the control's only visible text — its label — and the hint role measured
 *    2.04:1 in the bar, making the most prominent affordance the least readable.
 *
 * Keyboard reachable: Tab to it, Enter or Space opens, and the palette's own focus move then wins
 * because no pointer event is competing.
 */

import type { ReactNode } from 'react'

export interface SearchTriggerProps {
  /** Visible text. Doubles as the accessible name via `aria-label` when none is given. */
  placeholder: string
  /** Leading icon (a magnifier, usually). */
  icon?: ReactNode
  /** Trailing adornment — a `Kbd` shortcut hint, typically. */
  adornment?: ReactNode
  /** Opens the search surface. */
  onOpen: () => void
  ariaLabel?: string
  className?: string
}

export function SearchTrigger({
  placeholder,
  icon,
  adornment,
  onOpen,
  ariaLabel,
  className,
}: SearchTriggerProps) {
  return (
    <span className={`nds-field nds-searchtrigger${className ? ` ${className}` : ''}`}>
      {icon && (
        <span className="lead" aria-hidden="true">
          {icon}
        </span>
      )}
      <input
        type="text"
        readOnly
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onMouseDown={(e) => {
          e.preventDefault()
          onOpen()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
      />
      {adornment && <span className="nds-searchtrigger-ad">{adornment}</span>}
    </span>
  )
}
