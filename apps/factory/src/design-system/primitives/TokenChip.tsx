'use client'

import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface TokenChipProps {
  /** the token's content — a label, or a control such as a `<Listbox>` */
  children: ReactNode
  /** makes the content clickable (applying a preset, opening an editor) */
  onSelect?: () => void
  /** shows the remove button */
  onRemove?: () => void
  /**
   * Accessible name for the remove button. Required whenever `onRemove` is set — an icon-only
   * button with no name is announced as "button", which is useless next to five identical ones.
   */
  removeLabel?: string
  disabled?: boolean
  className?: string
}

/**
 * A bordered token with TWO actions: the content does one thing, a trailing × removes it.
 *
 * Distinct from `FilterChip`, which is a single toggle. `FilterChip` cannot express this and my
 * first docblock wrongly claimed it covered `.esm-chip` — a session caught that. The reason is
 * structural, not cosmetic: `FilterChip` is itself a `<button>`, and a remove control inside it
 * would be a button nested in a button, which is invalid HTML.
 *
 * Replaces `.esm-chip` (saved-preset token) and `.h10-spw-cs-token` (a token wrapping a select).
 * For the latter, pass the control as `children` — the token neutralises a nested `Listbox`'s
 * own border, which is what made that combination double-border before.
 *
 * The remove button is `--nds-text-muted` (5.01:1) resting, danger on hover. `.esm-chip` shipped
 * #94a3b8, which is **2.56:1 — under even the 3:1 non-text floor**.
 */
export function TokenChip({
  children,
  onSelect,
  onRemove,
  removeLabel,
  disabled,
  className,
}: TokenChipProps) {
  return (
    <span className={['nds-token', disabled ? 'disabled' : '', className].filter(Boolean).join(' ')}>
      {onSelect ? (
        <button type="button" className="t" onClick={onSelect} disabled={disabled}>
          {children}
        </button>
      ) : (
        <span className="t">{children}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="x"
          onClick={onRemove}
          disabled={disabled}
          aria-label={removeLabel}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </span>
  )
}
