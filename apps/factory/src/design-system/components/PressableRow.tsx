'use client'

/**
 * PressableRow — a row whose whole surface activates, that can still contain its own controls.
 *
 * 🔴 WHY THIS IS NOT `<div role="button">`, which is what seven pages hand-rolled (hub #648).
 * The `button` role is **children-presentational**: assistive technology flattens everything inside
 * it, so a `<div role="button">` wrapping a `<button>` or `<input>` erases that control for a screen
 * reader exactly as nesting a button inside a button does. Measured before building: **5 of the 7
 * hand-rolled rows contain interactive children** (`<button>` ×2, `<input>` ×3). A descendant click
 * guard — the shape originally proposed — would have fixed the mouse and left the screen reader
 * broken, which is the worse half.
 *
 * 🔴 WHY `MetricStrip` IS STILL A REAL BUTTON. A tile has no interactive children; a row usually
 * does. That is the whole difference between the two cases, and it is why this component exists
 * rather than MetricStrip growing a prop.
 *
 * HOW IT WORKS. The primary action is a real `<button>` whose content is the label — so the label
 * *is* the accessible name, with no `aria-label` to drift from what is on screen. Its `::after`
 * stretches over the row (`position: absolute; inset: 0`), so a click anywhere on the row hits the
 * button. `actions` render in a region that sits **above** that overlay, so a click on a nested
 * control can never reach the row **by construction** — there is no event guard to get wrong.
 * Tab order follows the DOM: the row's button first, then each nested control.
 *
 * ⚠ THE COST, stated because it is real: text under the overlay is **not selectable**. The row is a
 * control, and it reads as one. Do not use it for content the operator needs to copy.
 *
 * 🔴 THE STATE PROPS ARE MUTUALLY EXCLUSIVE AND THE SURFACE IS NARROW ON PURPOSE (hub #657). A row
 * is a toggle (`active`), a disclosure (`expanded`) or a selection (`current`) — never two at once,
 * because each maps to a different ARIA property and a button claiming two states describes
 * something that does not exist. Supplying more than one throws in dev. There is no `aria-*`
 * pass-through and no escape hatch: the way to add a state is to add it here, once, with a test.
 *
 * Requires `styles/components.css`.
 */
import { useId, type ReactNode } from 'react'

export interface PressableRowProps {
  /**
   * The row's primary action, rendered as the button's content — and therefore its accessible name.
   * Keep it the thing the operator would say out loud to mean "this row".
   */
  label: ReactNode
  /** Decorative leading content, such as a thumbnail. Keep interactive controls in `actions`. */
  leading?: ReactNode
  onClick: () => void
  /**
   * Toggle state. Emits `aria-pressed` **only when supplied** — an action row that opens a drawer
   * is not a toggle, and claiming `aria-pressed="false"` on one tells a screen-reader user there is
   * a state to toggle when there is not.
   */
  active?: boolean
  /** Disclosure state — emits `aria-expanded`. For a row that opens a section beneath it. */
  expanded?: boolean
  /**
   * Selection state — emits `aria-current`. `true` for "the current one of this set"; `'page'` and
   * `'step'` when the set is navigation or a wizard. `false` is meaningful and is emitted: it says
   * currency applies here and this row is not it.
   */
  current?: boolean | 'true' | 'page' | 'step'
  disabled?: boolean
  /**
   * A sentence the operator needs beyond the label — "inherited value; activate to pin an override".
   * Rendered visually hidden and wired with `aria-describedby`, so it reaches a screen reader as a
   * DESCRIPTION while the accessible NAME stays the visible label. Deliberately not folded into
   * `label`: that would put a sentence on screen where a name belongs, and deliberately not an
   * `aria-label`, which would replace the name with text nobody can see.
   */
  description?: string
  /** Non-interactive content, laid out after the label and sitting UNDER the overlay. */
  children?: ReactNode
  /** Interactive controls. Rendered above the overlay; their clicks never reach the row. */
  actions?: ReactNode
  className?: string
}

export function PressableRow({
  label, leading, onClick, active, expanded, current, disabled = false, description, children, actions, className,
}: PressableRowProps) {
  const descId = useId()

  if (process.env.NODE_ENV !== 'production') {
    const supplied = (['active', 'expanded', 'current'] as const).filter(
      (k) => ({ active, expanded, current })[k] !== undefined,
    )
    if (supplied.length > 1) {
      throw new Error(
        `PressableRow: ${supplied.join(' and ')} were both supplied. A row is a toggle (active), a ` +
          `disclosure (expanded) or a selection (current) — never two at once; each maps to a ` +
          `different ARIA property and a button claiming two states describes nothing real.`,
      )
    }
  }

  return (
    <div
      className={['nds-prow', active ? 'is-active' : '', current ? 'is-current' : '',
        disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ')}
    >
      {leading != null && <div className="nds-prow-leading" aria-hidden>{leading}</div>}
      <button
        type="button"
        className="nds-prow-action"
        onClick={onClick}
        disabled={disabled}
        // undefined, not `false`, for each of these — see the prop docs. An omitted attribute says
        // "this state does not apply"; `="false"` says "it applies and is off".
        aria-pressed={active === undefined ? undefined : active}
        aria-expanded={expanded === undefined ? undefined : expanded}
        aria-current={current === undefined ? undefined : current}
        aria-describedby={description ? descId : undefined}
      >
        {label}
      </button>
      {description && (
        <span id={descId} className="nds-vh">
          {description}
        </span>
      )}
      {children != null && <div className="nds-prow-body">{children}</div>}
      {actions != null && (
        // The stacking context that puts these above the overlay. Without it a click here would
        // land on the row's button instead of the control the operator aimed at.
        <div className="nds-prow-actions">{actions}</div>
      )}
    </div>
  )
}
