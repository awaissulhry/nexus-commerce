'use client'

/**
 * SegmentedControl — a compact single-select toggle on a sunken track, the active
 * segment raised. The space-efficient alternative to a radio group or a row of tabs for
 * 2–4 mutually-exclusive view modes (e.g. List / Board, Live / Official). Accessible
 * `role="radiogroup"` with ArrowLeft/Right roving selection.
 *
 * 🔴 **It imports its own stylesheet.** The docblock used to say "requires
 * `styles/primitives.css`" and leave that to the caller — an instruction four routes silently
 * failed to follow. Measured on prod 2026-08-19: on `/marketing/ads/rules-automation/automations`
 * **0 of the 8,800 loaded CSS rules defined `.nds-seg`**, so the control rendered as
 * run-together plain text ("ActorsLedgerQueueLimits") with no padding and no track. An unstyled
 * component looks like a layout bug, not a missing import, which is why it survived.
 *
 * A component that cannot render correctly on its own is not a shared component. Next dedupes the
 * import, so this costs nothing and cannot regress.
 */
import '../styles/primitives.css'
import { useRef, type ReactNode, type KeyboardEvent } from 'react'
import type { Size } from './size'
import { rovingTabIndex } from '../lib/roving-tabindex'

export interface SegmentedOption {
  value: string
  label: ReactNode
  icon?: ReactNode
  /**
   * Disable this segment alone. The group-level `disabled` turns the whole control off; this is
   * for a mode that is unavailable in the current context while its neighbours are not.
   *
   * `move()` skips these. It did NOT before this prop existed — it stepped to the next index and
   * selected it — so adding per-option disable without that fix would have let an arrow key
   * select an option the user cannot select and then fail to focus it, losing focus from the
   * control entirely.
   */
  disabled?: boolean
  /**
   * Native tooltip for the whole segment.
   *
   * Without it a per-option explanation had to ride inside the `label` node, where it covers the
   * text rather than the segment — so hovering the words showed nothing.
   */
  title?: string
}
export interface SegmentedControlProps {
  /**
   * Accessible name for the `radiogroup`.
   *
   * A radiogroup with no name is announced as an unlabelled group — the reader hears the options
   * but never what they choose between. Optional only so this does not break the call sites that
   * predate it; pass it.
   */
  ariaLabel?: string
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  size?: Extract<Size, 'sm' | 'md'>
  disabled?: boolean
  className?: string
}

export function SegmentedControl({ options, value, onChange, size = 'md', disabled = false, ariaLabel, className }: SegmentedControlProps) {
  const ref = useRef<HTMLDivElement>(null)

  const move = (dir: 1 | -1) => {
    const idx = options.findIndex((o) => o.value === value)
    const n = options.length
    // Skip DISABLED options. Without this, an arrow key selects one the user cannot select and
    // then tries to focus a disabled button — which takes no focus, so focus is lost from the
    // control entirely. Bounded by n, so an all-disabled group simply does nothing.
    for (let step = 1; step <= n; step++) {
      const next = (((idx + dir * step) % n) + n) % n
      const opt = options[next]
      if (!opt || opt.disabled) continue
      onChange(opt.value)
      // shift focus to the newly-selected segment so keyboard nav stays on the active option
      requestAnimationFrame(() => {
        ref.current?.querySelectorAll<HTMLButtonElement>('.nds-seg-opt')[next]?.focus()
      })
      return
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  }

  const selectedIndex = options.findIndex((o) => o.value === value)
  const cls = ['nds-seg', size, disabled ? 'disabled' : '', className ?? ''].filter(Boolean).join(' ')

  return (
    <div ref={ref} className={cls} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((opt, i) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={rovingTabIndex(active, selectedIndex, i)}
            className={`nds-seg-opt ${active ? 'on' : ''}`}
            title={opt.title}
            disabled={disabled || opt.disabled}
            onClick={() => onChange(opt.value)}
          >
            {opt.icon && <span className="nds-seg-icon">{opt.icon}</span>}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
