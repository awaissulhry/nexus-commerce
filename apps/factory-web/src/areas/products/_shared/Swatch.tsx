'use client'

import './swatch.css'

/**
 * Swatch — the products area's colour chip (design part "Swatch": "a colour chip with name and code, a 3:1 border in both
 * themes and a text fallback; display only — ColorSwatchPicker stays the picker"; used by products.colours, .materials,
 * .styles). The DS has no Swatch yet (named in B-W2b-207's notes): composed here, in the area's `_shared` (plan §2: one-area
 * parts live in that area's _shared). Only a plain `#RRGGBB` is drawn (the colour library's own value, inline); anything
 * else, or none, is a striped chip with `noHex` said to assistive technology. Nothing here fetches.
 */

const HEX = /^#[0-9A-Fa-f]{6}$/

export interface SwatchProps {
  hex: string | null | undefined
  /** The colour's name: what assistive technology says, and the text beside the chip with `withText`. */
  name: string
  /** Our code ("NX-BLK"), shown before the name with `withText`. */
  code?: string
  size?: 'sm' | 'md' | 'lg'
  /** The code and name beside the chip (a list cell, a legend). */
  withText?: boolean
  /** Said for a chip without a colour to draw ("no hex"), in the page's language. */
  noHex: string
}

export function Swatch({ hex, name, code, size = 'md', withText = false, noHex }: SwatchProps) {
  const drawn = typeof hex === 'string' && HEX.test(hex)
  const chip = drawn ? (
    <span className={`fw-swatch fw-swatch-${size}`} style={{ background: hex }} role="img" aria-label={withText ? undefined : name} aria-hidden={withText ? true : undefined} />
  ) : (
    <span className={`fw-swatch fw-swatch-${size} is-empty`} role="img" aria-label={withText ? undefined : `${name} (${noHex})`} aria-hidden={withText ? true : undefined} />
  )
  if (!withText) return chip
  return (
    <span className="fw-swatch-text">
      {chip}
      <span className="fw-swatch-words">
        {code && <b>{code}</b>} <span>{name}</span>
        {!drawn && <span className="fw-swatch-nohex"> ({noHex})</span>}
      </span>
    </span>
  )
}

/** Up to `max` swatches in a row, then "+N" (a branding set's brand colours, a style's colourways). */
export function SwatchRow({ colours, max = 5, noHex, more }: { colours: ReadonlyArray<{ id: string; code: string; name: string; hex: string | null }>; max?: number; noHex: string; more: (count: number) => string }) {
  const shown = colours.slice(0, max)
  const rest = colours.length - shown.length
  return (
    <span className="fw-swatch-row">
      {shown.map((colour) => (
        <Swatch key={colour.id} hex={colour.hex} name={`${colour.code} · ${colour.name}`} size="sm" noHex={noHex} />
      ))}
      {rest > 0 && <span className="fw-swatch-more">{more(rest)}</span>}
    </span>
  )
}
