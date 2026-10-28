/**
 * A QR code as data: the module matrix (from `qrcode`, the encoder the apps already use) and one SVG path for its dark
 * modules. `QrCode.tsx` loads this file lazily, so the encoder reaches a bundle only when a QR is on screen.
 */
import { create } from 'qrcode'

/** Error correction: L 7 %, M 15 %, Q 25 %, H 30 % of the code can be lost and still read. */
export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H'

/** The light border every reader needs around the code, in modules (ISO/IEC 18004: four). */
export const QR_QUIET_ZONE = 4

export interface QrMatrix {
  /** Modules per side: 17 + 4 × version (21 for version 1). */
  size: number
  /** 1–40. */
  version: number
  level: QrErrorLevel
  /** Row-major, true = dark. */
  dark: readonly boolean[]
}

/** The matrix that encodes `value`. Throws when the value is too long for any QR version at this level. */
export function qrMatrix(value: string, level: QrErrorLevel = 'M'): QrMatrix {
  const code = create(value, { errorCorrectionLevel: level })
  const size = code.modules.size
  const dark: boolean[] = []
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark.push(!!code.modules.get(r, c))
  return { size, version: code.version, level, dark }
}

/** Is the module at row `r`, column `c` dark? */
export const isDark = (m: QrMatrix, r: number, c: number): boolean => m.dark[r * m.size + c]

/**
 * The dark modules as one path in a `0 0 W W` box (W = size + 2 × quiet zone): one rectangle per run of dark modules in
 * a row, so a 33 × 33 code is about 300 rectangles, not 600 squares.
 */
export function qrPath(m: QrMatrix, quiet = QR_QUIET_ZONE): string {
  const parts: string[] = []
  for (let r = 0; r < m.size; r++) {
    let c = 0
    while (c < m.size) {
      if (!isDark(m, r, c)) {
        c++
        continue
      }
      const start = c
      while (c < m.size && isDark(m, r, c)) c++
      parts.push(`M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`)
    }
  }
  return parts.join('')
}

/** The side of the drawing box, quiet zone included. */
export const qrBox = (m: QrMatrix, quiet = QR_QUIET_ZONE): number => m.size + 2 * quiet
