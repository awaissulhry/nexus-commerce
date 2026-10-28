/**
 * The QR code reads back: the matrix `qrMatrix` builds and the path `qrPath` draws are rasterised and decoded with ZXing
 * (`@zxing/library`, the decoder the web's scan input uses, from the repo's own install). The component is rendered to
 * markup in Node: the drawing is lazy, so the server markup is the loading plate plus the text form.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library'
import { describe, expect, it } from 'vitest'
import { QrCode } from './QrCode'
import { isDark, qrBox, qrMatrix, qrPath, QR_QUIET_ZONE, type QrMatrix } from './qrCodeModel'

/** Paint the PATH (not the matrix) into a luminance bitmap, `scale` px per module, and decode it. */
function decodePath(m: QrMatrix, scale = 4): string {
  const box = qrBox(m)
  const w = box * scale
  const lum = new Uint8ClampedArray(w * w).fill(255)
  for (const [, x, y, h] of qrPath(m).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let dy = 0; dy < scale; dy++)
      for (let dx = 0; dx < Number(h) * scale; dx++) lum[(Number(y) * scale + dy) * w + Number(x) * scale + dx] = 0
  }
  return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, w)))).getText()
}

describe('qrMatrix + qrPath', () => {
  it('encodes an enrolment code that decodes back to the same text', () => {
    const value = 'NXF-ENROL-7K4Q-29XD'
    expect(decodePath(qrMatrix(value))).toBe(value)
  })
  it('encodes a long enrolment address (a larger version) at every error-correction level', () => {
    const value = 'https://factory.example.com/enrol?code=7K4Q29XD&station=cutting-2&mode=operator'
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      const m = qrMatrix(value, level)
      expect(m.level).toBe(level)
      expect(decodePath(m), level).toBe(value)
    }
  })
  it('the matrix is 17 + 4 × version modules a side, with the three finder patterns in their corners', () => {
    const m = qrMatrix('A1')
    expect(m.version).toBe(1)
    expect(m.size).toBe(21)
    expect(m.dark).toHaveLength(21 * 21)
    const big = qrMatrix('x'.repeat(200))
    expect(big.size).toBe(17 + 4 * big.version)
    // A finder pattern: a dark 7 × 7 ring around a light ring around a dark 3 × 3 core.
    for (const [r0, c0] of [[0, 0], [0, m.size - 7], [m.size - 7, 0]]) {
      expect(isDark(m, r0, c0) && isDark(m, r0 + 6, c0 + 6) && isDark(m, r0 + 3, c0 + 3)).toBe(true)
      expect(isDark(m, r0 + 1, c0 + 1)).toBe(false)
    }
  })
  it('the path covers exactly the dark modules, offset by the four-module quiet zone', () => {
    const m = qrMatrix('quiet zone')
    const painted = new Set<string>()
    for (const [, x, y, h] of qrPath(m).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(h); i++) painted.add(`${Number(y) - QR_QUIET_ZONE}:${Number(x) - QR_QUIET_ZONE + i}`)
    }
    const dark = new Set<string>()
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (isDark(m, r, c)) dark.add(`${r}:${c}`)
    expect(painted).toEqual(dark)
    expect(qrBox(m)).toBe(m.size + 8)
  })
  it('a value longer than any QR version can hold throws (the component says so in words)', () => {
    expect(() => qrMatrix('x'.repeat(8000))).toThrow()
  })
})

describe('QrCode markup', () => {
  const html = renderToStaticMarkup(createElement(QrCode, { value: 'https://factory.example.com/enrol?code=7K4Q', code: '7K4Q-29XD', label: 'Enrolment code for Cutting station 2', size: 180 }))
  it('holds the plate at its size and says the code is being drawn (the encoder loads on the client)', () => {
    expect(html).toContain('<div class="nds-qr-plate" style="width:180px;height:180px">')
    expect(html).toContain('role="status" aria-label="Enrolment code for Cutting station 2: Drawing the code"')
  })
  it('always shows the text form with a Copy button named by what it copies', () => {
    expect(html).toContain('<code class="nds-qr-code">7K4Q-29XD</code>')
    expect(html).toMatch(/<button[^>]*aria-label="Copy: 7K4Q-29XD"[^>]*>/)
    expect(html).toContain('aria-live="polite"')
  })
  it('the text form is the value itself when no code is given', () => {
    const plain = renderToStaticMarkup(createElement(QrCode, { value: 'NXF-ENROL-7K4Q', label: 'Enrolment code' }))
    expect(plain).toContain('<code class="nds-qr-code">NXF-ENROL-7K4Q</code>')
  })
})
