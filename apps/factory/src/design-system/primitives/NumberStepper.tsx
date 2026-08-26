'use client'

import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import type { Size } from './size'

export interface NumberStepperProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'onChange' | 'value' | 'prefix'> {
  value: number | ''
  onChange: (next: number) => void
  min?: number
  max?: number
  step?: number
  /** trailing unit inside the track, e.g. `%` or `€` */
  suffix?: ReactNode
  size?: Extract<Size, 'sm' | 'md'>
  /** dims the value without disabling the control — a stepper whose value is not in effect yet */
  muted?: boolean
  decrementLabel?: string
  incrementLabel?: string
}

/**
 * A joined −/number/+ control: ONE bordered track with hairline dividers, not three boxes.
 *
 * Two surfaces hand-rolled it (`.az-bias-edit` in the placement cockpit, `.h10-hv-step` in
 * keyword harvest) because building it from `Button` + `Input` + `Button` gives three separate
 * borders and three radii — visibly not one control.
 *
 * The native spinners are suppressed in CSS, which is the point of the ± buttons: a `<input
 * type="number">` spinner is ~13px, appears on hover, and is unusable on touch.
 *
 * Clamping lives here rather than at the call site, so `min`/`max` cannot be bypassed by the
 * buttons — and a value typed past a bound is clamped on change, not silently kept.
 */
export const NumberStepper = forwardRef<HTMLInputElement, NumberStepperProps>(function NumberStepper(
  {
    value,
    onChange,
    min,
    max,
    step = 1,
    suffix,
    size = 'md',
    muted,
    disabled,
    decrementLabel = 'Decrease',
    incrementLabel = 'Increase',
    className,
    ...rest
  },
  ref,
) {
  const clamp = (n: number) => {
    if (min != null && n < min) return min
    if (max != null && n > max) return max
    return n
  }
  const current = value === '' ? 0 : value
  const atMin = min != null && current <= min
  const atMax = max != null && current >= max
  const cls = ['nds-nstep', size === 'md' ? '' : size, muted ? 'muted' : '', className]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={cls}>
      <button
        type="button"
        className="dec"
        aria-label={decrementLabel}
        disabled={disabled || atMin}
        onClick={() => onChange(clamp(current - step))}
      >
        −
      </button>
      <input
        ref={ref}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const n = e.target.valueAsNumber
          if (!Number.isNaN(n)) onChange(clamp(n))
        }}
        {...rest}
      />
      {suffix != null && <em className="suf">{suffix}</em>}
      <button
        type="button"
        className="inc"
        aria-label={incrementLabel}
        disabled={disabled || atMax}
        onClick={() => onChange(clamp(current + step))}
      >
        +
      </button>
    </span>
  )
})
