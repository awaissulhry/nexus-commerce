/**
 * DS.3 — Server-side QR code renderer for the datasheet header.
 *
 * Uses the existing `qrcode` dep (already pulled in by the API
 * workspace for TOTP QR codes; hoisted to root node_modules under
 * npm workspaces). Renders an SVG so the QR scales cleanly at any
 * print resolution without bitmap blur.
 *
 * Error-correction level "M" (~15 %) is the right balance for a
 * printed datasheet: high enough to survive ink smearing on a real
 * printer, low enough to keep the code small (~100 modules wide
 * for a typical Amazon listing URL).
 */
import QRCode from 'qrcode'

interface DatasheetQRProps {
  url: string
  /** Px width of the rendered SVG. The library scales the matrix
   *  to fit. Default 96 lands at ~24 mm at 96 dpi (printable). */
  size?: number
}

export default async function DatasheetQR({
  url,
  size = 96,
}: DatasheetQRProps) {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: size,
    color: { dark: '#0f172a', light: '#ffffff' },
  })

  return (
    <div
      className="flex-shrink-0"
      style={{ width: size, height: size }}
      aria-label={`QR code linking to ${url}`}
      // QRCode.toString returns a complete <svg> root we can drop
      // directly into the DOM. Safe because we control the input
      // (URL we constructed) and the library escapes everything.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
