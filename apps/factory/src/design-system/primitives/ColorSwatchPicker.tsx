'use client'

import { Check } from 'lucide-react'

import { tagSwatches } from '../tokens/colors'

/**
 * ColorSwatchPicker — pick a colour from a FIXED palette, not from the whole spectrum.
 *
 * A free colour input looks more capable and is worse for this job. Operators pick colours that
 * collide with each other, that collide with the status tones the product already uses to mean
 * something, and that fail contrast on one of the two themes — and once picked, those colours
 * live in the database and spread to every surface that renders the thing. A closed palette is
 * the only version where "choose a colour" cannot produce an unreadable result.
 *
 * The values are the design system's own ramps, so a tag coloured here sits in the same visual
 * family as everything around it rather than next to it.
 *
 * These are IDENTIFIERS, not statuses: the palette is deliberately drawn from ramps that do not
 * carry meaning on their own. Where a colour must mean success or danger, use a tone, not this.
 */

export interface ColorSwatchPickerProps {
  /** Currently selected hex, or null for "no colour". */
  value: string | null
  onChange: (hex: string) => void
  /** Accessible name for the radio group. */
  ariaLabel?: string
  disabled?: boolean
  className?: string
}

/**
 * Eight, and eight is the point: enough that two tags in view rarely share one, few enough that
 * the whole set is visible without a scroll and a person can remember which is which.
 *
 * The values themselves live in `tokens/colors.ts` as `tagSwatches`, beside `accountIdentity`
 * which solves the identical problem. They are PERSISTED tag data rather than styling, so they
 * belong in the token tier where colour is defined once — and raw hex in a primitive is exactly
 * what the DS token-guard exists to reject.
 */
export const SWATCHES: ReadonlyArray<{ hex: string; name: string }> = tagSwatches

export function ColorSwatchPicker({
  value,
  onChange,
  ariaLabel = 'Colour',
  disabled,
  className,
}: ColorSwatchPickerProps) {
  return (
    // A radiogroup, not a row of buttons: this is one choice among several, and arrow keys
    // should move between the options the way they do in every other radio group.
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`nds-swatches${className ? ` ${className}` : ''}`}
    >
      {SWATCHES.map((s) => {
        const selected = value?.toLowerCase() === s.hex.toLowerCase()
        return (
          <button
            key={s.hex}
            type="button"
            role="radio"
            aria-checked={selected}
            // The colour is not the accessible name. A screen reader announcing a raw hex value
            // has told the listener nothing they can act on.
            aria-label={s.name}
            title={s.name}
            disabled={disabled}
            onClick={() => onChange(s.hex)}
            className={`nds-swatch${selected ? ' on' : ''}`}
            style={{ background: s.hex }}
          >
            {/* White tick on every swatch. MEASURED, and the first version of this comment was
                wrong: three of the eight are UNDER the 4.5:1 text floor (Green 3.30, Amber
                3.76, Red 3.91). That floor does not apply — a tick is a graphical object, so
                WCAG 1.4.11 asks 3:1, and the tightest of the eight (Green) clears it at
                3.30:1. It is also why these hexes are used as DOTS beside a label rather than
                as a background under text: at that ratio, text on them would fail. */}
            {selected && <Check size={12} strokeWidth={3} aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}
