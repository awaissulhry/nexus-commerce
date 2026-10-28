/**
 * Code128 — a Code 128 barcode as SVG (gap G11), from `encodeCode128` (`code128Model.ts`): bars B/C with a 10-module quiet
 * zone each side, the value printed under it.
 *
 *   <Code128 value="B-000123-04" label="Codice a barre del fascio B-000123-04" />
 *
 * - Dark bars on a light ground in BOTH themes: a barcode is ink on paper, and a scanner reads a code off a screen only
 *   that way round (`labelPreview.css`, the theme-invariant pair the light tooltip uses).
 * - It fills its container's width; the bar height is `--nds-code128-h` (default 3 rem). One `<path>`, crisp edges.
 * - A value it cannot encode (an accented letter, a control character) draws no bars: a hatched box with
 *   `invalidLabel` (default the value) instead — never a barcode that scans as something else.
 * - One accessible image: `label` (default the value); the bars and the printed value are hidden from a screen reader.
 */
import type { CSSProperties } from 'react'

import { CODE128_QUIET_MODULES, code128Bars, encodeCode128 } from './code128Model'
import './labelPreview.css'

export interface Code128Props {
  value: string
  /** The barcode's name for a screen reader. Default: the value. */
  label?: string
  /** Print the value under the bars. Default true. */
  showText?: boolean
  /** Shown and read instead of bars when the value cannot be encoded. Default: the value. */
  invalidLabel?: string
  className?: string
  style?: CSSProperties
}

export function Code128({ value, label, showText = true, invalidLabel, className, style }: Code128Props) {
  const encoding = encodeCode128(value)
  const cls = ['nds-code128', encoding ? '' : 'is-invalid', className ?? ''].filter(Boolean).join(' ')
  if (!encoding) {
    return (
      <span className={cls} style={style} role="img" aria-label={invalidLabel ?? value}>
        <span className="nds-code128-invalid" aria-hidden>
          {invalidLabel ?? value}
        </span>
      </span>
    )
  }
  const total = encoding.modules + 2 * CODE128_QUIET_MODULES
  const d = code128Bars(encoding)
    .map(([x, w]) => `M${x} 0h${w}v1h-${w}z`)
    .join('')
  return (
    <span className={cls} style={style} role="img" aria-label={label ?? value}>
      <svg className="nds-code128-bars" viewBox={`0 0 ${total} 1`} preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden focusable="false">
        <path d={d} fill="currentColor" />
      </svg>
      {showText ? (
        <span className="nds-code128-text" aria-hidden>
          {value}
        </span>
      ) : null}
    </span>
  )
}
