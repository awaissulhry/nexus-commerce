// Hand-rolled CODE128B barcode renderer. Self-contained — no library
// dependency. Used for warehouse identification of RMAs and other
// short alphanumeric ids; CODE128B is the right standard for printed
// labels containing ASCII (32–126).
//
// The encoding tables below are public CODE128 specification (no
// IP). Each value 0–105 maps to a 6-width "stripe" pattern (3 bars,
// 3 spaces) summing to 11 modules; STOP (106) is 13 modules with an
// extra trailing bar. We multiply by `moduleWidthPx` to get the SVG
// pixel widths.
//
// Usage:
//   <Barcode128 value="RMA-260508-AB12" />
//
// The text label is rendered below the bars by default; pass
// `showText={false}` to drop it.

import React from 'react'

// CODE128 pattern table. Each string is 6 digits (3 bar widths + 3
// space widths, alternating starting with bar) — except STOP (last)
// which is 7 digits because CODE128 STOP has a trailing bar.
const PATTERNS: readonly string[] = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112',
  '421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412',
  '211214','211232','2331112',
]

const START_B = 104
const STOP    = 106

interface Barcode128Props {
  value: string
  /** Pixel width per CODE128 module. Default 1.5 — fits a 90mm-wide
   *  printed label at typical 203 dpi without losing scannability. */
  moduleWidthPx?: number
  /** Pixel height of the bars (text adds ~14px below). */
  height?: number
  /** Show the human-readable text label under the bars. Default true. */
  showText?: boolean
  className?: string
}

export function Barcode128({
  value,
  moduleWidthPx = 1.5,
  height = 56,
  showText = true,
  className,
}: Barcode128Props) {
  // Filter to ASCII 32–126 so we never index past the table. Anything
  // outside that range is a programming bug; collapse it to '?' so a
  // bad row doesn't crash the drawer.
  const safe = String(value ?? '').replace(/[^\x20-\x7E]/g, '?')
  const codes: number[] = []
  for (const ch of safe) {
    const v = ch.charCodeAt(0) - 32
    codes.push(v >= 0 && v <= 95 ? v : '?'.charCodeAt(0) - 32)
  }
  const checksum =
    (START_B + codes.reduce((acc, c, i) => acc + c * (i + 1), 0)) % 103
  const sequence = [START_B, ...codes, checksum, STOP]

  type Bar = { x: number; width: number }
  const bars: Bar[] = []
  let cursor = 0
  for (const symbol of sequence) {
    const pattern = PATTERNS[symbol]
    if (!pattern) continue
    let isBar = true
    for (const ch of pattern) {
      const w = parseInt(ch, 10) * moduleWidthPx
      if (isBar) bars.push({ x: cursor, width: w })
      cursor += w
      isBar = !isBar
    }
  }
  const totalWidth = cursor

  return (
    <div className={className} aria-label={`Barcode for ${safe}`}>
      <svg
        viewBox={`0 0 ${totalWidth} ${height}`}
        width={totalWidth}
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-hidden="true"
      >
        <rect x={0} y={0} width={totalWidth} height={height} fill="white" />
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={b.width} height={height} fill="black" />
        ))}
      </svg>
      {showText && (
        <div className="text-center font-mono text-sm tracking-wider mt-1 text-slate-700">
          {safe}
        </div>
      )}
    </div>
  )
}

export default Barcode128
