'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  /** engaged — emits `aria-pressed`, which is also what drives the visual */
  pressed?: boolean
  /** trailing count, e.g. how many rows this facet matches */
  count?: ReactNode
  /** small trailing badge for an exceptional state, e.g. "3 failed" */
  badge?: ReactNode
  children: ReactNode
}

/**
 * A chip that TOGGLES a filter. Two surfaces hand-rolled it (`.h10-cl-sum .chip`, `.hl-fchip`)
 * because `Pill` and `Tag` are static spans and `Button active` is a rectangular radius-lg fill,
 * not a tinted capsule.
 *
 * NOT `.esm-chip`, which an earlier version of this comment wrongly claimed — a session caught
 * it. That is a two-action token (the label applies a preset, a separate button deletes it), and
 * this component IS a `<button>`, so a remove control inside it would be a button nested in a
 * button. Use `TokenChip`.
 *
 * The two measurable ones agree on the shape — white fill, hairline border, `--nds-radius-full`
 * — so the capsule here is unanimous, not a pick. They disagree on the engaged TEXT, and one of
 * them is wrong: `.hl-fchip.on` is blue-600 on blue-50, **4.36:1, under AA**. This uses blue-900
 * at 7.41:1, which is what `.h10-cl-sum .chip.on` already does and what the DS pill palette
 * already encodes.
 *
 * The failure badge rises too: #a3211a on #fbdedb (5.94:1) → the DS note-error pair at 9.23:1.
 */
export function FilterChip({ pressed, count, badge, children, className, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      className={['nds-fchip', className].filter(Boolean).join(' ')}
      aria-pressed={pressed}
      {...rest}
    >
      <span className="t">{children}</span>
      {count != null && <span className="c">{count}</span>}
      {badge != null && <span className="b">{badge}</span>}
    </button>
  )
}
